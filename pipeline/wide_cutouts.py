#!/usr/bin/env python3
"""Wide-cutout experiment: does a larger cutout (more Gaia DR3 reference stars) improve the field-star
calibration? Compares 0.2 deg (the pipeline default) with 0.4 and 0.6 deg on the SAME subset of exposures.

Data budget: only a subset is fetched (--per-cell exposures per season x detector, spread in time), only
at 0.6 deg; the 0.4 deg cutouts are cut from those (IRSA geometry rule, bit-identical to an IRSA cutout),
the 0.2 deg runs link the existing cutouts. Pixels come from the public S3 bucket with HTTP Range reads
(pipeline/fetch_region.py: IMAGE, FLAGS, VARIANCE, ZODI rows of the box); EPSF and WCS-WAVE are copied
from the existing 0.2 deg cutout of the same exposure (IRSA copies them unchanged). The IRSA cutout
service is ~45 % smaller per 0.6 deg exposure (5.9 vs ~10.5 MB) but delivered ~25 kB/s (4 min per file)
on 2026-11-14, so S3 is used. Nothing in ../veri/real_spherex or site/data is written.

Usage (from the fazari/ folder; steps are resumable, files already present are skipped):
  P="uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow python -I"
  $P pipeline/wide_cutouts.py select barnard eps_indi_b      # subset + size estimate, no download
  $P pipeline/wide_cutouts.py fetch barnard eps_indi_b       # S3 reads (asks for --yes above --max-gb)
  $P pipeline/wide_cutouts.py gaia barnard eps_indi_b        # Gaia DR3 within 0.45 deg (IRSA TAP)
  $P pipeline/wide_cutouts.py run barnard eps_indi_b         # blink.py per size into runs/<size>/out/
  $P pipeline/accuracy.py                                    # tables -> pipeline/ACCURACY.md

Layout (--root, default ../veri/wide_cutouts next to the repo):
  subset_<target>.json, manifest_<target>.json (bytes, timings, checks per exposure)
  0.6/<target>/{dr1,qr3}/*.fits, 0.4/<target>/..., 0.2/<target>/... (links to ../veri/real_spherex)
  <size>/<target>/liste_<coll>.csv (listing rows of the subset)
  gaia/<target>_r0.45.json (Gaia DR3, blink.py gaia_field.json format)
  runs/targets.json, runs/<size>/data/<target>_wide -> ../../../<size>/<target>, runs/<size>/out/<target>_wide/
The runs use the target id <target>_wide (FAZARI_TARGETS) so blink.py takes the wide Gaia catalogue from
runs/<size>/out/<target>_wide/gaia_field.json instead of site/data/<target>/gaia_field.json (0.15 deg).
"""
import argparse
import csv
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PIPE = Path(__file__).resolve().parent
ROOT = PIPE.parent
sys.path.insert(0, str(PIPE))

import numpy as np                                        # noqa: E402
from astropy.io import fits                               # noqa: E402

import download                                           # noqa: E402  (centre of the IRSA cutouts)
import fetch_region as fr                                 # noqa: E402

SIZES = (0.2, 0.4, 0.6)
FETCH_SIZE = 0.6
GAIA_RADIUS = 0.45          # deg: covers the 0.6 deg box (half diagonal 0.424 deg)
LAYERS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")
REAL = ROOT.parent / "veri" / "real_spherex"


def sz(s):
    return f"{s:.1f}"


def load(path):
    return json.loads(Path(path).read_text())


def target_entry(name):
    """targets.json + targets_extra.json, as blink.load_target merges them."""
    t = dict(load(PIPE / "targets.json")[name])
    for k, v in load(PIPE / "targets_extra.json").get(name, {}).items():
        t.setdefault(k, v)
    return t


def est_bytes(size=FETCH_SIZE, flags_row=6000):
    """Upper bound of the S3 bytes for one exposure: headers + full-width rows of 3 float layers +
    the RICE-compressed FLAGS rows (4-6 kB each, S3_LAYOUT.md)."""
    rows = fr.iround(size / (6.15 / 3600))
    return fr.FIRST_READ + fr.FLAGS_READ + 2 * fr.EXT_HLEN + rows * (3 * 2040 * 4 + flags_row)


# ---- select -----------------------------------------------------------------------------------
def select(name, root, per_cell):
    """per_cell exposures per season x detector, evenly spread in time, from the production table."""
    rows = list(csv.DictReader(open(ROOT / "site" / "data" / name / "images.csv")))
    cells = {}
    for r in rows:
        if r["inside"] == "True":
            cells.setdefault((r["epoch"], r["detector"]), []).append(r)
    chosen = []
    for k in sorted(cells):
        c = sorted(cells[k], key=lambda r: (float(r["mjd"]), r["file"]))
        n = min(per_cell, len(c))
        idx = sorted({int(round((j + 0.5) / n * len(c) - 0.5)) for j in range(n)})
        chosen += [c[i] for i in idx]
    sub = [{k: r[k] for k in ("file", "collection", "obs_id", "epoch", "detector", "mjd", "orient_deg")}
           for r in chosen]
    out = {"target": name, "per_cell": per_cell, "n": len(sub), "fetch_size_deg": FETCH_SIZE,
           "estimate_bytes_upper": est_bytes() * len(sub), "files": sub}
    (root / f"subset_{name}.json").write_text(json.dumps(out, indent=1))
    print(f"{name}: {len(sub)} exposures ({len(cells)} season x detector cells, <= {per_cell} each); "
          f"S3 estimate <= {out['estimate_bytes_upper'] / 1e6:.0f} MB ({est_bytes() / 1e6:.2f} MB per exposure "
          f"at {FETCH_SIZE} deg)")
    return out


def listing_lines(name, coll, files):
    """Header + the raw lines of the IRSA listing that belong to `files` (kept byte for byte)."""
    lines = (REAL / name / f"liste_{coll}.csv").read_text().splitlines(keepends=True)
    return [lines[0]] + [ln for ln in lines[1:] if any(f in ln for f in files)]


def write_listings(name, root, sub):
    for s in SIZES:
        d = root / sz(s) / name
        d.mkdir(parents=True, exist_ok=True)
        for coll in ("dr1", "qr3"):
            files = [r["file"] for r in sub["files"] if r["collection"] == coll]
            if files:
                (d / f"liste_{coll}.csv").write_text("".join(listing_lines(name, coll, files)))


# ---- fetch ------------------------------------------------------------------------------------
def s3_key(name, coll, fname):
    for ln in (REAL / name / f"liste_{coll}.csv").read_text().splitlines():
        if fname in ln:
            k = fr.key_from_url(ln)
            if k:
                return k
    raise KeyError(fname)


def write_fits(region, local, dest, size):
    """IRSA-like cutout: primary of the local IRSA cutout, the region layers, EPSF and WCS-WAVE of the
    local cutout (identical in every cutout of the exposure)."""
    with fits.open(local, memmap=False) as h:
        prim = fits.PrimaryHDU(header=h[0].header.copy())
        extra = [h["EPSF"].copy(), h["WCS-WAVE"].copy()]
    prim.header["FZSRC"] = ("S3 range read (pipeline/wide_cutouts.py)", "pixels")
    prim.header["FZSIZE"] = (size, "cutout size (deg), IRSA geometry rule")
    hdul = fits.HDUList([prim] + [fits.ImageHDU(data=region["arrays"][k], header=region["headers"][k])
                                  for k in LAYERS] + extra)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".fits.part")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        hdul.writeto(tmp, overwrite=True)
    tmp.replace(dest)


def check_against(region, local):
    """Region (0.2 deg, from S3) vs the existing IRSA 0.2 deg cutout: pixels and CRPIX keys."""
    out = {}
    with fits.open(local, memmap=False) as h:
        for k in LAYERS:
            a, b = np.asarray(region["arrays"][k]), np.asarray(h[k].data)
            same = a.shape == b.shape and bool(np.array_equal(a, b, equal_nan=a.dtype.kind == "f"))
            out[k] = same
        hc, rc = h["IMAGE"].header, region["headers"]["IMAGE"]
        out["crpix_max_diff"] = max(abs(float(hc[k]) - float(rc[k])) for k in
                                    ("CRPIX1", "CRPIX2", "CRPIX1A", "CRPIX2A", "CRPIX1W", "CRPIX2W"))
    out["identical"] = all(out[k] for k in LAYERS) and out["crpix_max_diff"] < 1e-6
    return out


def fetch_one(name, row, ra, dec, root):
    coll, fname = row["collection"], row["file"]
    dests = {s: root / sz(s) / name / coll / fname for s in (0.4, 0.6)}
    local = REAL / name / coll / fname
    if all(p.exists() for p in dests.values()):
        return {"file": fname, "status": "present"}
    key = s3_key(name, coll, fname)
    st = fr.Stats()
    tmpc = Path(tempfile.mkdtemp(prefix="fz_s3_"))
    t0 = time.monotonic()
    try:
        regions = {}
        for s in (0.6, 0.4, 0.2):              # 0.4 and 0.2 are served from the 0.6 rows in the cache
            r = fr.read_region(key, ra, dec, size_deg=s, layers=LAYERS, cache_dir=tmpc, wave=False, stats=st)
            if not r["ok"]:
                return {"file": fname, "status": "error", "reason": r.get("reason")}
            regions[s] = r
        net = st.as_dict()
        chk = check_against(regions[0.2], local)
        for s, p in dests.items():
            write_fits(regions[s], local, p, s)
    finally:
        shutil.rmtree(tmpc, ignore_errors=True)    # this exposure's own byte cache
    return {"file": fname, "key": key, "status": "fetched", "bytes_net": net["bytes_net"],
            "requests": net["requests"], "seconds": round(time.monotonic() - t0, 2),
            "shape": {sz(s): list(regions[s]["arrays"]["IMAGE"].shape) for s in regions},
            "clipped": {sz(s): bool(regions[s]["geometry"]["clipped"]) for s in regions},
            "check_0.2_vs_local": chk}


def fetch(name, root, max_gb, yes, workers=2):
    sub = load(root / f"subset_{name}.json")
    write_listings(name, root, sub)
    for r in sub["files"]:                             # 0.2 deg: links to the existing cutouts
        p = root / "0.2" / name / r["collection"] / r["file"]
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.exists():
            p.symlink_to(REAL / name / r["collection"] / r["file"])
    todo = [r for r in sub["files"]
            if not all((root / sz(s) / name / r["collection"] / r["file"]).exists() for s in (0.4, 0.6))]
    est = est_bytes() * len(todo)
    print(f"{name}: {len(todo)} of {sub['n']} exposures to fetch, estimate <= {est / 1e6:.0f} MB")
    if est > max_gb * 1e9 and not yes:
        sys.exit(f"estimate above --max-gb {max_gb}; rerun with --yes to confirm")
    ra, dec = download.center(load(PIPE / "targets.json")[name])
    man_p = root / f"manifest_{name}.json"
    man = load(man_p) if man_p.exists() else {"target": name, "centre": [ra, dec], "files": {}}
    total = 0
    with ThreadPoolExecutor(workers) as ex:            # 2 images x <= 4 requests (fetch_region cap: 4)
        for k, res in enumerate(ex.map(lambda r: fetch_one(name, r, ra, dec, root), todo), 1):
            man["files"][res["file"]] = res
            total += res.get("bytes_net", 0)
            chk = res.get("check_0.2_vs_local", {})
            print(f"  {k}/{len(todo)} {res['file']}: {res['status']} {res.get('bytes_net', 0) / 1e6:.2f} MB "
                  f"{res.get('seconds', 0):.1f} s  0.2-deg check {'OK' if chk.get('identical') else chk}"
                  f"  total {total / 1e6:.0f} MB", flush=True)
            man_p.write_text(json.dumps(man, indent=1))
    allb = sum(v.get("bytes_net", 0) for v in man["files"].values())
    print(f"{name}: downloaded {total / 1e6:.1f} MB now, {allb / 1e6:.1f} MB in all")


# ---- Gaia -------------------------------------------------------------------------------------
def gaia(name, root):
    dest = root / "gaia" / f"{name}_r{GAIA_RADIUS}.json"
    if dest.exists():
        print(f"{name}: {dest} present")
        return
    import blink                                       # same query and file format as blink.gaia_field
    t = target_entry(name)
    ra_c, dec_c = blink.target_position(t, blink.Time(blink.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    q = ("SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, ruwe "
         "FROM gaia_dr3_source WHERE CONTAINS(POINT('ICRS', ra, dec), "
         f"CIRCLE('ICRS', {ra_c:.6f}, {dec_c:.6f}, {GAIA_RADIUS}))=1 AND phot_g_mean_mag < {blink.GAIA_GMAX}")
    data = urllib.parse.urlencode({"QUERY": q, "FORMAT": "csv"}).encode()
    req = urllib.request.Request(blink.GAIA_TAP, data=data, headers={"User-Agent": "fazari-spaceapps/1.0"})
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=600) as r:
        raw = r.read()
    rows = list(csv.DictReader(io.StringIO(raw.decode())))

    def num(v):
        return round(float(v), 7) if v not in ("", None) else None
    stars = [[int(r["source_id"]), num(r["ra"]), num(r["dec"]), num(r["pmra"]), num(r["pmdec"]),
              num(r["parallax"]), num(r["phot_g_mean_mag"]), num(r["ruwe"])] for r in rows]
    old = load(ROOT / "site" / "data" / name / "gaia_field.json")
    ids = {s[0] for s in stars}
    missing = [s[0] for s in old["stars"] if s[0] not in ids]
    out = {"source": "Gaia DR3 (gaia_dr3_source at NASA/IPAC IRSA TAP)", "query": q, "ref_epoch": 2016.0,
           "columns": old["columns"], "retrieved": time.strftime("%Y-%m-%d"), "stars": stars,
           "bytes_downloaded": len(raw)}
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{name}: {len(stars)} Gaia DR3 stars within {GAIA_RADIUS} deg ({len(raw) / 1e6:.2f} MB, "
          f"{time.monotonic() - t0:.0f} s); 0.15 deg cache stars missing here: {len(missing)}")


# ---- runs -------------------------------------------------------------------------------------
def prepare(names, root):
    runs = root / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    tj = runs / "targets.json"
    cat = load(tj) if tj.exists() else {}
    for name in names:
        cat[f"{name}_wide"] = target_entry(name)
    tj.write_text(json.dumps(cat, indent=1))
    for s in SIZES:
        for name in names:
            alias = f"{name}_wide"
            link = runs / sz(s) / "data" / alias
            link.parent.mkdir(parents=True, exist_ok=True)
            if not link.exists():
                link.symlink_to(Path("..") / ".." / ".." / sz(s) / name)
            g = runs / sz(s) / "out" / alias / "gaia_field.json"
            g.parent.mkdir(parents=True, exist_ok=True)
            if not g.exists():
                shutil.copyfile(root / "gaia" / f"{name}_r{GAIA_RADIUS}.json", g)
    return runs


def run(names, root, workers=3, sizes=SIZES):
    runs = prepare(names, root)
    jobs = [(s, n) for n in names for s in sizes]

    def one(job):
        s, name = job
        alias = f"{name}_wide"
        out = runs / sz(s) / "out"
        env = dict(os.environ, FAZARI_TARGETS=str(runs / "targets.json"), FAZARI_DATA=str(runs / sz(s) / "data"),
                   FAZARI_OUT=str(out), FAZARI_FIELD_STARS="1", OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
        t0 = time.monotonic()
        with open(out / alias / "blink.log", "w") as log:
            rc = subprocess.call([sys.executable, "-I", str(PIPE / "blink.py"), alias], env=env, cwd=ROOT,
                                 stdout=log, stderr=subprocess.STDOUT)
        info = {"size_deg": s, "target": name, "returncode": rc, "seconds": round(time.monotonic() - t0, 1)}
        (out / alias / "run.json").write_text(json.dumps(info))
        print(f"  {name} {s} deg: rc {rc}, {info['seconds']:.0f} s", flush=True)
        return info

    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(one, jobs))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("action", choices=["select", "fetch", "gaia", "run"])
    ap.add_argument("targets", nargs="+")
    ap.add_argument("--root", default=str(ROOT.parent / "veri" / "wide_cutouts"))
    ap.add_argument("--per-cell", type=int, default=2, help="exposures per season x detector (select)")
    ap.add_argument("--max-gb", type=float, default=1.0, help="fetch stops above this estimate without --yes")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--workers", type=int, default=3, help="blink.py processes in parallel (run)")
    ap.add_argument("--sizes", default="0.2,0.4,0.6", help="sizes to run (run)")
    a = ap.parse_args()
    root = Path(a.root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    if a.action == "select":
        tot = sum(select(n, root, a.per_cell)["estimate_bytes_upper"] for n in a.targets)
        print(f"total S3 estimate <= {tot / 1e6:.0f} MB")
    elif a.action == "fetch":
        for n in a.targets:
            fetch(n, root, a.max_gb, a.yes)
    elif a.action == "gaia":
        for n in a.targets:
            gaia(n, root)
    else:
        run(a.targets, root, a.workers, [float(s) for s in a.sizes.split(",")])


if __name__ == "__main__":
    main()
