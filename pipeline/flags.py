"""Fazari flag layer: which pixels of each blink frame are saturated, masked or otherwise flagged
in the SPHEREx FLAGS extension, for the on/off overlay of the result viewer (site/js/flags_view.js).

Reads only cutouts that are already on disk (the site data folder ../veri/real_spherex/<target>/ or a
local-engine job's inputs); nothing is downloaded. Output (new files only):

    <result>/flags/flags.json             index: grid, groups, per frame the files read and the flagged share
    <result>/flags/flags_<bin>um.png      one RGB PNG per wavelength bin: the frames of the bin
                                          (meta.json order) stacked top to bottom, each 180 x 180 in PNG
                                          order (row 0 = north, column 0 = east); one channel per group,
                                          0 or 255 (R saturated, G masked, B other), so the browser's
                                          colour management cannot change the values

Bits (one pixel can carry several):
    1  saturated  OVERFLOW, SUR_ERROR, NONLINEAR (blink.py SAT_BITS): exactly the frame's white
                  saturation mask (most images saturated, small blobs dropped, as blink.py marks it)
    2  masked     pixels blink.py removes (BAD_BITS: TRANSIENT, NONFUNC, MISSING_DATA, HOT, COLD,
                  PERSIST, OUTLIER, STREAK, SNOWBALL, or no value) in most images of the frame, or no
                  image covers the pixel at all
    4  other      flags blink.py keeps (DICHROIC, PHANMISS, CROSSTALK, GHOST, GHOST_FPA, GHOST_EXT,
                  BLOOM, HALO) in most images of the frame: the value may be affected
SOURCE (pixel on a known source) and FULLSAMPLE are informational and not shown.

Each image's masks are resampled to the frame grid like the image itself (bilinear, > 0.5).

Run:  uv run --no-project --with astropy --with numpy --with scipy --with pillow python -I \
          pipeline/flags.py <target> [--out DIR] [--overwrite]      (site target; DIR default site/data)
      ... pipeline/flags.py --job cache/jobs/<id> [--inputs DIR]     (local-engine job)
Engine: post-step "flags" in local/job_worker.py (post_step).
"""
import argparse
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blink as BL                      # noqa: E402
import faint as FA                      # noqa: E402

B = dict(BL.B, PHANMISS=1 << 14, CROSSTALK=1 << 20, SOURCE=1 << 21, GHOST=1 << 22, GHOST_FPA=1 << 23,
         GHOST_EXT=1 << 24, HALO=1 << 28, FULLSAMPLE=1 << 12)
SAT_BITS = BL.SAT_BITS
BAD_BITS = BL.BAD_BITS
OTHER_BITS = (B["DICHROIC"] | B["PHANMISS"] | B["CROSSTALK"] | B["GHOST"] | B["GHOST_FPA"] | B["GHOST_EXT"]
              | B["BLOOM"] | B["HALO"])
GROUPS = [
    dict(bit=1, key="saturated", flags=["OVERFLOW", "SUR_ERROR", "NONLINEAR"],
         rule="saturated in most images of the frame (the frame's white saturation mask)"),
    dict(bit=2, key="masked", flags=["TRANSIENT", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "PERSIST", "OUTLIER",
                                     "STREAK", "SNOWBALL"],
         rule="removed (bad flag or no value) in most images of the frame, or not covered by any image"),
    dict(bit=4, key="other", flags=["DICHROIC", "PHANMISS", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "BLOOM",
                                    "HALO"],
         rule="kept but flagged (ghost, halo, bloom, crosstalk, ...) in most images of the frame"),
]


class Grid:
    """The frame grid of meta.json (blink.py make_grid: TAN, north up, east left, centred on (ra, dec))."""

    def __init__(self, ra, dec, n, pix):
        w = WCS(naxis=2)
        w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        w.wcs.crval = [ra, dec]
        w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
        w.wcs.cdelt = [-pix / 3600, pix / 3600]
        self.wcs, self.n = w, n
        yy, xx = np.mgrid[:n, :n]
        self.world = w.all_pix2world(xx.ravel(), yy.ravel(), 0)


def exposure_masks(path, grid):
    """(saturated, removed, other, covered) of one cutout on the grid (bool arrays, grid order)."""
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        img = h["IMAGE"].data
        flg = h["FLAGS"].data.astype(np.int64)
        wcs = WCS(hd)
    sat = (flg & SAT_BITS) != 0
    bad = (((flg & BAD_BITS) != 0) | ~np.isfinite(img)) & ~sat
    oth = ((flg & OTHER_BITS) != 0) & ~sat & ~bad
    x, y = wcs.all_world2pix(grid.world[0], grid.world[1], 0)
    n = grid.n
    xy = (x.reshape(n, n), y.reshape(n, n))
    cov = np.isfinite(FA.resample(np.ones(img.shape), xy))
    out = [np.nan_to_num(FA.resample(m.astype(np.float64), xy), nan=0.0) > 0.5 for m in (sat, bad, oth)]
    return out[0], out[1] & cov, out[2] & cov, cov


def frame_mask(masks):
    """Bit mask of one frame from its images' masks (grid order)."""
    sat = np.stack([m[0] for m in masks])
    bad = np.stack([m[1] for m in masks]).sum(0)
    oth = np.stack([m[2] for m in masks]).sum(0)
    cov = np.stack([m[3] for m in masks]).sum(0)
    out = np.zeros(sat.shape[1:], np.uint8)
    out[BL.clean_satmask(np.mean(sat, axis=0) > 0.5)] |= 1          # blink.py's rule for the white mask
    out[(cov == 0) | (2 * bad > cov)] |= 2
    out[(cov > 0) & (2 * oth > cov)] |= 4
    return out


def find_file(name, dirs):
    for d in dirs:
        p = Path(d) / name
        if p.exists():
            return p
    return None


def build(meta, center, data_dirs, out_dir, overwrite=False, log=print):
    """Write <out_dir>/flags.json and flags_<bin>um.png for the frames in meta.json."""
    from PIL import Image
    out_dir = Path(out_dir)
    if (out_dir / "flags.json").exists() and not overwrite:
        raise FileExistsError(f"{out_dir / 'flags.json'} exists (outputs are never overwritten; use --overwrite)")
    t0 = time.time()
    mg = meta.get("grid") or {}
    grid = Grid(center[0], center[1], int(mg.get("size_px", [180])[0]), float(mg.get("pixel_arcsec", BL.PIX_ARCSEC)))
    n = grid.n
    cache, missing, nread = {}, [], 0
    doc = {"schema": "fazari-flags/1", "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "target": meta.get("target"), "grid": meta.get("grid"), "ra": center[0], "dec": center[1],
           "groups": GROUPS, "png": "RGB, 0/255 per channel: R = bit 1 saturated, G = bit 2 masked, B = bit 4 other; "
                                    "frames of a bin stacked top to bottom in meta.json order, each size_px rows, "
                                    "PNG order (row 0 = north)",
           "source": "SPHEREx FLAGS extension of the cutouts already on disk (no download)",
           "bins": {}, "missing_files": []}
    pngs = {}
    for b in meta.get("wavelength_bins", []):
        key = f"{float(b['wavelength_um']):.1f}"
        rows, frames = [], []
        for fr in b.get("frames", []):
            masks, used = [], 0
            for name in fr.get("files", []):
                if name not in cache:
                    p = find_file(name, data_dirs)
                    try:
                        cache[name] = exposure_masks(p, grid) if p else None
                    except Exception as e:                      # unreadable file: reported, frame continues
                        log(f"  {name}: {type(e).__name__}: {e}")
                        cache[name] = None
                    nread += cache[name] is not None
                    if cache[name] is None:
                        missing.append(name)
                if cache[name] is not None:
                    masks.append(cache[name])
                    used += 1
            ent = {"epoch": fr.get("epoch"), "frame": fr.get("file"), "n_images": len(fr.get("files", [])),
                   "n_read": used, "available": used > 0}
            if used:
                m = np.flipud(frame_mask(masks))                     # PNG order: row 0 = north
                ent["share"] = {g["key"]: round(float(np.mean((m & g["bit"]) != 0)), 4) for g in GROUPS}
            else:
                m = np.zeros((n, n), np.uint8)
            rows.append(m)
            frames.append(ent)
        if not frames:
            continue
        fn = f"flags_{key}um.png"
        buf = io.BytesIO()
        m = np.vstack(rows).astype(np.uint8)
        rgb = np.stack([((m & g["bit"]) != 0) * np.uint8(255) for g in GROUPS], axis=-1).astype(np.uint8)
        Image.fromarray(rgb).save(buf, format="PNG", optimize=True)
        pngs[fn] = buf.getvalue()
        doc["bins"][key] = {"file": fn, "wavelength_um": b["wavelength_um"], "frames": frames}
    doc["missing_files"] = sorted(set(missing))
    doc["n_files_read"] = nread
    doc["available"] = nread > 0
    out_dir.mkdir(parents=True, exist_ok=True)
    for fn, data in pngs.items():
        FA.write_new(out_dir / fn, data, overwrite=overwrite)
    FA.write_new(out_dir / "flags.json", json.dumps(doc, indent=1), overwrite=overwrite)
    size = sum(len(v) for v in pngs.values()) + (out_dir / "flags.json").stat().st_size
    log(f"  flags: {nread} images read, {len(doc['missing_files'])} missing, {len(pngs)} PNGs, "
        f"{size / 1024:.0f} kB, {time.time() - t0:.1f} s -> {out_dir}")
    return doc


def site_target(name, out_root=None, overwrite=False, log=print):
    t = BL.load_target(name)
    center = BL.target_position(t, Time(BL.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    meta = json.loads((BL.ROOT / "site" / "data" / name / "meta.json").read_text())
    root = Path(out_root) if out_root else Path(os.environ.get("FAZARI_OUT") or BL.OUT)
    dirs = [BL.DATA / name / c for c in BL.COLLECTIONS]
    return build(meta, (float(center[0]), float(center[1])), dirs, root / name / "flags", overwrite, log)


def job(job_dir, inputs=None, overwrite=True, log=print):
    jd = Path(job_dir)
    inputs = Path(inputs) if inputs else jd.parent.parent / "local" / "inputs" / jd.name
    meta = json.loads((jd / "meta.json").read_text())
    dirs = [inputs / c for c in BL.COLLECTIONS] + [inputs]
    return build(meta, (float(meta["ra"]), float(meta["dec"])), dirs, jd / "flags", overwrite, log)


def post_step(ctx):
    """local/job_worker.py POST_STEPS entry: flag masks of a finished FULL job in <job>/flags/."""
    if ctx.get("status") is not None:
        ctx["status"].set(message="flag layer: saturated / masked / flagged pixels")
    meta = ctx.get("meta") or json.loads((Path(ctx["out"]) / "meta.json").read_text())
    inputs = Path(ctx["inputs"])
    dirs = [inputs / c for c in BL.COLLECTIONS] + [inputs]
    doc = build(meta, (float(meta["ra"]), float(meta["dec"])), dirs, Path(ctx["out"]) / "flags",
                overwrite=True, log=lambda *a: print(*a, flush=True))
    return {"file": "flags/flags.json", "available": doc["available"], "n_files_read": doc["n_files_read"],
            "n_missing": len(doc["missing_files"])}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fazari flag layer (SPHEREx FLAGS -> per-frame bit-mask PNGs)")
    ap.add_argument("target", nargs="?")
    ap.add_argument("--job", help="local-engine job folder (cache/jobs/<id>)")
    ap.add_argument("--inputs", help="cutout folder of the job (default cache/local/inputs/<id>)")
    ap.add_argument("--out", help="output root (<out>/<target>/flags); default FAZARI_OUT or site/data")
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args(argv)
    if a.job:
        job(a.job, a.inputs, overwrite=True)
    else:
        site_target(a.target or "barnard", a.out, a.overwrite)


if __name__ == "__main__":
    main()
