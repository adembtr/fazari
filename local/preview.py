#!/usr/bin/env python3
"""Quick-look preview of one sky point: the local engine's fast lane (Fazari, NASA Space Apps 2026).

Started by local/serve.py for "mode": "preview" jobs, like job_worker.py:
  uv run --no-project --with astropy --with reproject --with numpy --with scipy \
      --with matplotlib --with pillow python -I local/preview.py --job <job dir>

Goal: a blink on screen within ~10-15 s of the click, also when nothing is cached.
  finding      sky index (pipeline/sky_index.py); for the 5 challenge targets only the images
               whose local IRSA cutout is on disk (no download at all then)
  selection    ONE wavelength: 2.0 um on detector D3 (else the next bin seen in >= 2 seasons),
               2-4 exposures per observing season (gap > 30 days; 12 in all for 3-6 seasons),
               the ones whose wavelength at the point (index approx_lam_um) is closest to the
               bin centre
  downloading  only a small region around the point: a 0.1 deg box, IMAGE + FLAGS rows (HTTP
               Range, pipeline/fetch_region.py; no VARIANCE, ZODI, EPSF or wavelength table),
               about 0.8 MB per image, 6 images and at most 6 requests in flight, in season
               round-robin order; byte cache in <cache>/s3 as for the full job
  processing   IMAGE minus its median (ZODI too for local cutouts), bad pixels masked, saturated
               core white, reprojected onto a north-up 0.1 deg grid of 3" pixels, median per
               season, one asinh stretch, blink GIF and difference image, drawn with the
               helpers of pipeline/blink.py
Products go to <cache>/jobs/<id>/ in blink.py's layout (meta.json with "preview": {...},
frames/, blink_<um>um.gif, diff_<um>um.png), so ornek.html?data=/jobs/<id>/ shows them.
Progressive: as soon as every season has FIRST_PER_SEASON regions, a first look is written to
<cache>/jobs/<id>/quick/ and announced in status.json as "partial": {"n_images", "url"}; the
complete preview follows in <cache>/jobs/<id>/ (no file is rewritten while a page may read it).

A preview is NOT a measurement: no Gaia field-star calibration, no error bars, no photometry.
For a target with a known proper motion it adds a preliminary first -> last season shift from
raw SPHEREx-WCS centroids (meta.measured.preliminary), labelled as such; the full job
(job_worker.py + blink.py) measures.
"""
import argparse
import json
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "pipeline"))
sys.path.insert(0, str(HERE))

import numpy as np                                            # noqa: E402
import job_worker as jw                                       # noqa: E402  Status, index_rows, seasons, BINS, CACHE

ORDER = [2.0, 1.5, 3.0, 1.0, 4.0, 4.6]   # preferred wavelength first (um); first bin with >= 2 seasons wins
TOTAL = 12                               # exposures in all ...
PER_SEASON = (2, 4)                      # ... but 2..4 per season
FIRST_PER_SEASON = 2                     # first look as soon as every season has this many
REGION_DEG = 0.10                        # box read around the point (detector axes)
FOV_DEG = 0.10                           # north-up output grid (120 x 120 pixels of 3")
PARALLEL = 6                             # images and HTTP requests in flight
LAYERS = ("IMAGE", "FLAGS")


def pick(rows, local_dir=None):
    """(bin_um, chosen rows with 'season', number of seasons, per-season count, season labels) or None."""
    best = {}
    for r in rows:                                     # one row per exposure and detector, DR1 first
        k = (r["obs_id"], r["detector"])
        if k not in best or (best[k]["collection"] != "dr1" and r["collection"] == "dr1"):
            best[k] = r
    rows = sorted(best.values(), key=lambda r: r["mjd"])
    if local_dir is not None:
        rows = [r for r in rows if (local_dir / r["collection"] / Path(r["s3_key"]).name).exists()]
    lab = jw.seasons([r["mjd"] for r in rows])
    mjds = {}
    for r in rows:
        mjds.setdefault(lab[r["mjd"]], []).append(r["mjd"])
    names = {s: time_label(float(np.median(m))) for s, m in mjds.items()}
    for c in ORDER:
        det = jw.BINS[c]
        per = {}
        for r in rows:
            lam = r.get("lam_um")
            if r["detector"] != det or (lam is not None and abs(lam / c - 1) > jw.SELECT_TOL):
                continue
            per.setdefault(lab[r["mjd"]], []).append(r)
        if len(per) < 2:
            continue
        k = max(PER_SEASON[0], min(PER_SEASON[1], TOTAL // len(per)))
        chosen = []
        for s, rs in sorted(per.items()):
            rs.sort(key=lambda r: (abs((r.get("lam_um") or c) / c - 1), r["mjd"]))
            chosen += [dict(r, season=s, epoch=names[s]) for r in rs[:k]]
        return c, chosen, len(per), k
    return None


def time_label(mjd):
    from astropy.time import Time
    return Time(mjd, format="mjd").datetime.strftime("%Y-%m")


def read_s3(row, ra, dec):
    import fetch_region as fr
    st = fr.Stats()
    r = fr.read_region(row["s3_key"], ra, dec, size_deg=REGION_DEG, layers=LAYERS, cache_dir=jw.CACHE / "s3",
                       wave=False, stats=st, parallel=False)      # serial inside one image: reuses this thread's connection
    if not r["ok"]:
        return None, st.bytes_net, r.get("reason", "no overlap")
    return {"img": r["arrays"]["IMAGE"], "flg": r["arrays"]["FLAGS"], "zodi": None,
            "header": r["headers"]["IMAGE"], "wcs": r["wcs"]}, st.bytes_net, ""


def read_local(path):
    from astropy.io import fits
    from astropy.wcs import WCS
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        return {"img": h["IMAGE"].data, "flg": h["FLAGS"].data, "zodi": h["ZODI"].data if "ZODI" in h else None,
                "header": hd, "wcs": WCS(hd)}, 0, ""


def prepare(ex, row, t, moving, grid, shape):
    """Clean one region and put it on the grid; centroid of a moving target (raw WCS)."""
    import blink
    from reproject import reproject_interp
    img = np.asarray(ex["img"], dtype=np.float64)
    flg = np.asarray(ex["flg"]).astype(np.int64)
    sat = (flg & blink.SAT_BITS) != 0
    bad = ((flg & blink.BAD_BITS) != 0) & ~sat
    clean = img - ex["zodi"] if ex["zodi"] is not None else img.copy()
    clean[bad] = np.nan
    good = np.isfinite(clean) & ~sat
    if good.sum() < 100:
        return None
    clean -= np.nanmedian(clean[good])
    hd, wcs = ex["header"], ex["wcs"]
    mjd = float(hd.get("MJD-AVG", hd.get("MJD-OBS", row["mjd"])))
    ra, dec = blink.target_position(t, mjd)
    x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
    ny, nx = clean.shape
    e = blink.EDGE_PX
    info = {"obs_id": row["obs_id"], "detector": f"D{row['detector']}", "collection": row["collection"],
            "mjd": mjd, "date": datetime.fromtimestamp((mjd - 40587) * 86400, timezone.utc).strftime("%Y-%m-%d"),
            "season": row["season"], "epoch": row["epoch"], "lam_um": row.get("lam_um"),
            "x": x, "y": y, "inside": bool(e <= x <= nx - 1 - e and e <= y <= ny - 1 - e), "ra_pred": ra, "dec_pred": dec}
    if moving and info["inside"]:
        sig = 1.4826 * float(np.nanmedian(np.abs(clean[good])))
        var = np.full(clean.shape, max(sig, 1e-3) ** 2)
        c = blink.centroid(clean, var, ~bad & ~sat, x, y)
        if c:
            rr, dd = (float(v) for v in wcs.all_pix2world(c[0], c[1], 0))
            info.update(x_fit=c[0], y_fit=c[1], ra_fit=rr, dec_fit=dd)
    img_r, _ = reproject_interp((clean, wcs), grid, shape_out=shape, order="bilinear")
    sat_r, _ = reproject_interp((sat.astype(float), wcs), grid, shape_out=shape, order="bilinear")
    return info, img_r.astype(np.float32), sat_r > 0.5


def preliminary_shift(t, infos, eps):
    """First -> last season shift of a moving target from raw WCS centroids (not calibrated)."""
    import blink
    pos = {}
    for e in eps:
        f = [i for i in infos if i["epoch"] == e and "ra_fit" in i]
        if f:
            pos[e] = (float(np.mean([i["ra_fit"] for i in f])), float(np.mean([i["dec_fit"] for i in f])),
                      float(np.mean([i["ra_pred"] for i in f])), float(np.mean([i["dec_pred"] for i in f])), len(f))
    have = [e for e in eps if e in pos]
    if len(have) < 2:
        return None
    a, z = pos[have[0]], pos[have[-1]]
    _, _, sh, pa = blink.offset_arcsec(a[0], a[1], z[0], z[1])
    _, _, gsh, gpa = blink.offset_arcsec(a[2], a[3], z[2], z[3])
    return {"from_epoch": have[0], "to_epoch": have[-1], "shift_arcsec": round(sh, 2), "pa_deg": round(pa, 1),
            "catalogue_shift_arcsec": round(gsh, 2), "catalogue_pa_deg": round(gpa, 1),
            "n_used": int(sum(p[4] for p in pos.values())),
            "method": "preliminary: raw SPHEREx-WCS centroids (Gaussian on the unsaturated pixels), season means; "
                      "no Gaia field-star calibration, no bias correction, no error bars"}


def render(out, groups, b, det, t, job_id, ra_c, dec_c, grid, shape, moving, local_dir, extra):
    """Stack, stretch and draw the seasons in `groups` ({epoch: [(info, img, sat)]}) into `out`;
    write out/meta.json last (atomic). Returns (meta, number of images used)."""
    import blink
    from astropy.time import Time
    eps = sorted(groups)
    (out / "frames").mkdir(parents=True, exist_ok=True)
    med = {e: (np.nanmedian(np.stack([g[1] for g in groups[e]]), axis=0),
               blink.clean_satmask(np.mean(np.stack([g[2] for g in groups[e]]), axis=0) > 0.5)) for e in eps}
    allv = np.concatenate([m[0][np.isfinite(m[0])] for m in med.values()])
    mad = 1.4826 * np.median(np.abs(allv - np.median(allv)))
    lo, hi, soft = np.median(allv) - 1.5 * mad, np.percentile(allv, 99.97), 3 * mad or 1e-3
    frames, gif, normed = [], [], {}
    for e in eps:
        g = groups[e]
        img, satm = med[e]
        s = blink.stretch(img, lo, hi, soft)
        normed[e] = blink.fill_nan(np.where(satm, 1.0, s))
        lams = [x[0]["lam_um"] for x in g if x[0]["lam_um"]]
        lam = float(np.median(lams)) if lams else b
        d0, d1 = min(x[0]["date"] for x in g), max(x[0]["date"] for x in g)
        dmed = Time(float(np.median([x[0]["mjd"] for x in g])), format="mjd")
        fn = f"frames/{e}_{b:.1f}um.png"
        lines = [f"{d0} .. {d1}" if d0 != d1 else d0, f"SPHEREx D{det}  ~{lam:.2f} um  N={len(g)}  PREVIEW"]
        gif.append(blink.to_png(blink.gray_rgb(s, satm), lines, out / fn))
        frames.append({"file": fn, "date": dmed.iso[:10], "epoch": e, "n_images": len(g), "detectors": [f"D{det}"],
                       "wavelength_um": round(lam, 3), "date_first": d0, "date_last": d1,
                       "files": sorted(f"{x[0]['obs_id']}D{det}" for x in g)})
    gname, dname = f"blink_{b:.1f}um.gif", f"diff_{b:.1f}um.png"
    gif[0].save(out / gname, save_all=True, append_images=gif[1:], duration=800, loop=0)
    blink.to_png(blink.diverging_rgb(normed[eps[-1]] - normed[eps[0]], 0.6),
                 [f"{eps[-1]} minus {eps[0]}  {b:.1f} um  PREVIEW", "red = later, blue = earlier"], out / dname)

    def grid_xy(ra, dec):
        x, y = grid.all_world2pix(ra, dec, 0)
        return (float(x) * blink.UPSCALE + blink.UPSCALE / 2,
                blink.LABEL_H + (shape[0] - 1 - float(y)) * blink.UPSCALE + blink.UPSCALE / 2)
    markers = []
    for e in eps:
        s_ = [x[0] for x in groups[e]]
        rp, dp = float(np.mean([i["ra_pred"] for i in s_])), float(np.mean([i["dec_pred"] for i in s_]))
        markers.append({"epoch": e, "ra": rp, "dec": dp, "png_xy": [round(v, 1) for v in grid_xy(rp, dp)]})
    used = sum(len(groups[e]) for e in eps)
    prelim = preliminary_shift(t, [x[0] for e in eps for x in groups[e]], eps) if moving else None
    msg = (f"Preview: {used} images at {b:.1f} µm in {len(eps)} seasons. A quick look, not a measurement; "
           "the full result (all wavelengths, Gaia-calibrated motion with error bars) follows.")
    meta = {
        "target": t.get("name", job_id), "ra": ra_c, "dec": dec_c, "epoch_center": blink.EPOCH_CENTER,
        "grid": {"projection": "TAN", "pixel_arcsec": blink.PIX_ARCSEC, "size_px": list(shape),
                 "upscale": blink.UPSCALE, "png_px": [shape[1] * blink.UPSCALE, shape[0] * blink.UPSCALE + blink.LABEL_H],
                 "label_strip_px": blink.LABEL_H, "north_up_east_left": True},
        "epochs": eps,
        "wavelength_bins": [{"wavelength_um": b, "gif": gname, "diff": dname,
                             "stretch": {"type": "asinh", "lo": float(lo), "hi": float(hi), "soft": float(soft),
                                         "unit": "MJy/sr (median subtracted" + (", zodi subtracted)" if local_dir else ")")},
                             "frames": frames}],
        "gaia": {"source_id": t.get("gaia_dr3"), "ra_deg": t["ra"], "dec_deg": t["dec"], "ref_epoch": t["epoch"],
                 "pmra_mas_yr": t["pmra"], "pmdec_mas_yr": t["pmdec"], "parallax_mas": t["plx"],
                 "label": "Gaia DR3" if t.get("gaia_dr3") else t.get("astrometry_label", "catalogue"),
                 "reference": t.get("notes", "")},
        "markers": markers,
        "measured": {"status": "preview", "message": msg, "positions": [], "pairs": [],
                     **({"preliminary": prelim} if prelim else {})},
        "preview": dict(extra, n_images=used, seasons=len(eps)),
        "n_cutouts": used,
        "data_source": "NASA/IPAC IRSA SPHEREx DR1 + QR3 spectral images (preview: one wavelength, small regions)",
        "ai_disclosure": blink.AI_DISCLOSURE,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    tmp = out / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, indent=1))
    tmp.replace(out / "meta.json")
    return meta, used, prelim


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, help="job folder with request.json")
    a = ap.parse_args()
    jd = Path(a.job).resolve()
    req = json.loads((jd / "request.json").read_text())
    job_id, t = req["id"], dict(req["target"])
    status = jw.Status(jd / "status.json")
    out = jw.CACHE / "jobs" / job_id
    tm = {}
    t_all = time.time()
    try:
        status.stage("finding", "looking up SPHEREx images of this point (preview)")
        import blink                                       # rendering helpers, target motion
        from astropy.time import Time
        for k, v in (("plx", 0.0), ("epoch", 2016.0), ("pmra", 0.0), ("pmdec", 0.0)):
            if t.get(k) is None:
                t[k] = v
        ra_c, dec_c = blink.target_position(t, Time(blink.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
        moving = bool(t.get("pmra") or t.get("pmdec"))
        local_dir = None
        if req.get("local_target") and req.get("local_data"):
            local_dir = Path(req["local_data"]) / req["local_target"]
        rows = jw.index_rows(ra_c, dec_c)
        sel = pick(rows, local_dir)
        if not sel:
            raise RuntimeError(f"SPHEREx has {len(rows)} images here, but no wavelength bin is covered "
                               "in two seasons yet, so there is nothing to blink.")
        b, chosen, nseason, k = sel
        det = jw.BINS[b]
        # season round-robin: the first FIRST_PER_SEASON of every season are asked for first
        rank = {}
        for r in chosen:
            r["_rank"] = rank[r["season"]] = rank.get(r["season"], -1) + 1
        chosen.sort(key=lambda r: (r["_rank"], r["season"]))
        source = "local IRSA cutouts" if local_dir else "SPHEREx S3 (HTTP Range)"
        status.set(images={"source": source, "found": len(rows), "selected": len(chosen), "bin_um": b,
                           "detector": f"D{det}", "seasons": nseason, "per_season": k})
        tm["finding"] = round(time.time() - t_all, 2)
        print(f"{len(rows)} images; preview {b} um D{det}: {len(chosen)} images, {nseason} seasons x <= {k}", flush=True)

        status.stage("downloading", f"reading {len(chosen)} small regions at {b:.1f} um"
                     + (" (local cutouts)" if local_dir else " from the SPHEREx S3 bucket"))
        status.set(progress={"done": 0, "total": len(chosen), "bytes": 0})
        import fetch_region as fr
        fr._HTTP_SLOTS = threading.BoundedSemaphore(PARALLEL)
        n = int(round(FOV_DEG * 3600 / blink.PIX_ARCSEC))
        grid = blink.WCS(naxis=2)
        grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        grid.wcs.crval = [ra_c, dec_c]
        grid.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
        grid.wcs.cdelt = [-blink.PIX_ARCSEC / 3600, blink.PIX_ARCSEC / 3600]
        shape = (n, n)
        extra = {"bin_um": b, "detector": f"D{det}", "per_season": k, "fov_deg": FOV_DEG, "region_deg": REGION_DEG,
                 "layers": list(LAYERS) + (["ZODI"] if local_dir else []), "source": source}
        t_dl = time.time()
        infos, groups, failed, nbytes, first = [], {}, [], 0, None

        def get(row):
            if local_dir is not None:
                return read_local(local_dir / row["collection"] / Path(row["s3_key"]).name)
            return read_s3(row, ra_c, dec_c)

        def first_ready():
            per = {}
            for r in chosen:
                per.setdefault(r["epoch"], 0)
            have = {e: len(groups.get(e, [])) for e in per}
            return len(per) >= 2 and all(v >= min(FIRST_PER_SEASON, sum(1 for r in chosen if r["epoch"] == e))
                                         for e, v in have.items())

        with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
            futs = {ex.submit(get, r): r for r in chosen}
            left = len(futs)
            for fu in as_completed(futs):
                r = futs[fu]
                left -= 1
                res, note = None, ""
                try:
                    data, nb, note = fu.result()
                except Exception as e:
                    data, nb, note = None, 0, f"error: {e}"
                nbytes += nb
                if data is not None:
                    try:
                        res = prepare(data, r, t, moving, grid, shape)
                    except Exception as e:
                        res, note = None, f"error: {e}"
                if res:
                    infos.append(res[0])
                    if res[0]["inside"]:
                        groups.setdefault(res[0]["epoch"], []).append(res)
                else:
                    failed.append({"key": r["s3_key"], "reason": note or "too few good pixels"})
                status.add(done=1, nbytes=nb, message=f"{len(infos)} of {len(chosen)} regions ready")
                if first is None and left > 0 and local_dir is None and first_ready():   # first look while the rest arrive
                    q = {e: list(v) for e, v in groups.items()}
                    _, n1, _ = render(out / "quick", q, b, det, t, job_id, ra_c, dec_c, grid, shape, moving, local_dir,
                                      dict(extra, stage="first look", bytes=nbytes,
                                           seconds={"total": round(time.time() - t_all, 2)}))
                    first = {"n_images": n1, "url": f"/jobs/{job_id}/quick/", "seconds": round(time.time() - t_all, 2),
                             "bytes": nbytes}
                    status.set(partial=first, message=f"first look ready ({n1} images); {left} more regions coming")
                    print(f"first look after {first['seconds']} s: {n1} images, {nbytes / 1e6:.1f} MB", flush=True)
        tm["downloading"] = round(time.time() - t_dl, 2)

        status.stage("processing", "stacking the seasons and drawing the blink")
        t_pr = time.time()
        if len(groups) < 2:
            raise RuntimeError(f"only {len(groups)} season(s) with a usable {b:.1f} um image at this point")
        tm["processing"] = round(time.time() - t_pr, 2)
        extra.update(stage="complete", bytes=nbytes, skipped=failed, first_look=first,
                     seconds=dict(tm, total=round(time.time() - t_all, 2)))
        meta, used, prelim = render(out, groups, b, det, t, job_id, ra_c, dec_c, grid, shape, moving, local_dir, extra)
        status.set(skipped=failed)
        status.stage("done", f"preview: {used} images at {b:.1f} um, {len(groups)} seasons")
        status.set(result={"epochs": meta["epochs"], "bins": [b], "status": "preview", "n_images": used,
                           "bytes": nbytes, **({"preliminary": prelim} if prelim else {})}, finished=time.time())
        print(f"preview done in {time.time() - t_all:.1f} s: {used} images, {nbytes / 1e6:.1f} MB, {tm}", flush=True)
    except Exception as e:
        traceback.print_exc()
        status.stage("error", f"{type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
