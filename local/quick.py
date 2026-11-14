#!/usr/bin/env python3
"""Quick decision for a clicked point: does the object there move? (Fazari local engine, preview lane)

Started by local/serve.py right after the quick preview of a point ("mode": "quick"):
  uv run --no-project --with astropy --with reproject --with numpy --with scipy \
      --with matplotlib --with pillow python -I local/quick.py --job <job dir>

What it reads: a SMALL box (BOX_DEG, 0.05 deg = ~29 x 29 detector pixels) around the point from EVERY
SPHEREx exposure that covers it (all seasons, all six detectors / wavelengths), straight from the public
S3 bucket with HTTP Range, many requests in flight (an S3 test from the team's computer: no 429/5xx up to
128 concurrent requests). Per exposure:
  - PRIMARY + IMAGE header and the FLAGS header (two ranges, cached in cache/s3 like every other read);
  - IMAGE: one small Range request per box row, only the box columns (the idea of pipeline/detect/s3box.py);
  - FLAGS: the tile-compressed rows of the box (fetch_region.read_compressed_rows);
  - WCS-WAVE (file tail) and the EPSF calibration rows near the box (once per calibration id, cache/local/epsf).
Order: the 2.0 um (D3) and 4.6 um (D6) exposures of every season first, seasons interleaved, then the rest.
The five challenge targets are never downloaded: their saved IRSA cutouts are cropped instead.

Output (new folders of this job only):
  <cache>/local/quick/<id>/{dr1,qr3}/<file>.fits + liste_<coll>.csv
        the boxes as IRSA-layout cutouts (IMAGE FLAGS VARIANCE ZODI EPSF WCS-WAVE) = a detect.data.Field
        (see FIELD below): VARIANCE and ZODI are NOT read (each would cost as much as IMAGE): VARIANCE is the
        box's robust noise squared, ZODI the box median (the zodiacal light is smooth over 3 arcmin);
        header keys FZQVAR / FZQZODI say so. EPSF keeps only the table rows within 300 px of the box.
  <cache>/jobs/<id>/quick.json   the decision (verdict, measurement, timing, bytes)
  <cache>/jobs/<id>/             a small blink (blink.py layout, as the preview) of the band where the object
                                 is brightest (e.g. 4.6 um for WISE 0855), with flags/ (pipeline/flags.py)

The measurement: detect.run.quick_verdict(field, ra, dec) when the finder provides it (same records as
candidates.json, verdict.stage = "quick"); until then the FALLBACK below (raw SPHEREx WCS, no Gaia
calibration): per detector and season a median stack on a north-up grid, the source nearest the point,
season centroids (blink.centroid), first -> last season shift, error from the spread between detectors and
a 0.3" floor for the raw WCS. It is labelled "quick measurement"; the full result replaces it.
"""
import argparse
import csv
import json
import math
import os
import sys
import threading
import time
import traceback
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
sys.path.insert(0, str(ROOT / "local"))
import job_worker as jw                                     # noqa: E402  Status, index_rows, CACHE, epsf, irsa_row

BOX_DEG = 0.05                    # box side around the point (~29 detector pixels of 6.15")
GRID_FRAC = 0.8                   # stack grid: the inscribed part of the (rotated) boxes
EXPOSURE_WORKERS = 32             # exposures in flight
HTTP_SLOTS = 96                   # HTTP requests in flight (S3; IRSA is never asked here)
PRIORITY_DET = (3, 6)             # 2.0 um and 4.6 um first
SEARCH_ARCSEC = 18.0              # the clicked object: a peak this close to the point
REF_PX = 1.5                      # stack px (3"): peaks of the same object in different detectors
DETECT_SNR = 5.0
WCS_FLOOR_ARCSEC = 0.3            # raw SPHEREx WCS, per season pair (preview: Barnard 0.25", Luhman 0.2" off)
MOVE_MIN_ARCSEC = 1.0
EPSF_KEEP_PX = 300
BIN_OF_DET = {d: b for b, d in jw.BINS.items()}
QUICK_STORE = jw.LOCAL / "quick"

# FIELD: the structure handed to detect.run.quick_verdict (the finder's detect.data.Field):
#   Field(name=<job id>, data_dir=<cache>/local/quick/<id>  (dr1/ qr3/ *.fits + liste_<coll>.csv),
#         ra, dec = the point (2026.0 position of a catalogued mover), out_dir=<cache>/jobs/<id>,
#         gaia_json=None, label=<target name>, target=<request target dict: name, ra, dec, pmra, pmdec, epoch, plx>)
#   For the challenge targets data_dir is their saved 0.2 deg IRSA cutout folder (real VARIANCE/ZODI).


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------------------------------- fetch
_rows_pool = ThreadPoolExecutor(max_workers=HTTP_SLOTS, thread_name_prefix="row")
_epsf_lock = threading.Lock()
_bytes = {"n": 0, "lock": threading.Lock()}


def _add_bytes(n):
    with _bytes["lock"]:
        _bytes["n"] += n


def _row(url, a, nb):
    import fetch_region as fr
    body, status, _ = fr.http_get(url, f"bytes={a}-{a + nb - 1}")
    if status == 200:                                       # Range ignored (never seen on S3)
        body = body[a:a + nb]
    if len(body) != nb:
        raise IOError(f"short read {len(body)} != {nb}")
    _add_bytes(len(body))
    return np.frombuffer(body, ">f4")


def _trim_epsf(hdu, xc, yc, det_off):
    from astropy.io import fits
    tab = hdu.data
    d = np.hypot(tab["XCENTER"] - (xc + det_off[0]), tab["YCENTER"] - (yc + det_off[1]))
    keep = np.nonzero(d < EPSF_KEEP_PX)[0]
    if not len(keep):
        keep = np.array([int(np.argmin(d))])
    out = fits.BinTableHDU(data=tab[keep], header=hdu.header.copy())
    out.header["FZQTRIM"] = (f"rows within {EPSF_KEEP_PX} px of the box", "Fazari quick decision")
    return out


def fetch_box(row, ra, dec, store, local_data):
    """Box of one S3 exposure -> IRSA-layout cutout file; returns (path, arrays dict) or (None, reason)."""
    import fetch_region as fr
    from astropy.io import fits
    name = Path(row["s3_key"]).name
    out = store / row["collection"] / name
    if out.exists():                                        # this job's own earlier box (a rerun)
        return out, read_box(out)
    st = fr.Stats()
    f = fr.S3File(row["s3_key"], jw.CACHE / "s3", st)
    f.read(0, fr.FIRST_READ)
    f.read(*fr.FLAGS_GUESS)
    hdus = fr.locate_hdus(f, True)
    img_i, flg_i = hdus["IMAGE"], hdus["FLAGS"]
    hd = img_i.header
    wcs = fr.celestial_wcs(hd)
    x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
    npix = int(hd["NAXIS1"])
    half = int(round(BOX_DEG * 3600 / 6.15 / 2))
    ix, iy = int(round(x)), int(round(y))
    x0, x1, y0, y1 = max(0, ix - half), min(npix - 1, ix + half), max(0, iy - half), min(int(hd["NAXIS2"]) - 1, iy + half)
    if x1 - x0 < half or y1 - y0 < half:
        _add_bytes(st.bytes_net)
        return None, "point outside the image"
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    url = fr.S3_BASE + urllib.parse.quote(row["s3_key"])
    futs = [_rows_pool.submit(_row, url, img_i.data_off + yy * npix * 4 + x0 * 4, nx * 4) for yy in range(y0, y1 + 1)]
    flg = fr.read_compressed_rows(f, flg_i, y0, y1)[:, x0:x1 + 1].astype(np.int32)
    wave = fr.read_wave_hdu(f)
    img = np.stack([fu.result() for fu in futs]).astype(np.float32)
    var_hdr = flg_i.next_off                                # where EPSF starts (attach_epsf, later)
    zodi_hdr = var_hdr + fr.EXT_HLEN + fr.pad2880(img_i.datasize)
    layout = {"ZODI": {"data_off": zodi_hdr + fr.EXT_HLEN, "datasize": img_i.datasize}}
    _add_bytes(st.bytes_net)
    # synthetic VARIANCE / ZODI (not read: see the module doc)
    sat = (flg & jw_sat_bits()) != 0
    good = np.isfinite(img) & ~sat
    med = float(np.nanmedian(img[good])) if good.any() else 0.0
    sig = 1.4826 * float(np.nanmedian(np.abs(img[good] - med))) if good.any() else 1.0
    var = np.full(img.shape, max(sig, 1e-6) ** 2, np.float32)
    zodi = np.full(img.shape, med, np.float32)
    h_img = fr.shift_header(fr.image_header(img_i), x0, y0, nx, ny)
    h_flg = fr.shift_header(fr.image_header(flg_i), x0, y0, nx, ny)
    h_var, h_zod = h_img.copy(), h_img.copy()
    h_var["EXTNAME"], h_zod["EXTNAME"] = "VARIANCE", "ZODI"
    h_var["FZQVAR"] = ("box robust noise^2", "Fazari quick decision: VARIANCE not read")
    h_zod["FZQZODI"] = ("box median", "Fazari quick decision: ZODI not read")
    result = {"key": row["s3_key"], "primary_header": hdus["PRIMARY"].header,
              "box": {"edge": "clip", "x0": x0, "y0": y0}, "geometry": {"clipped": bool(nx < 2 * half + 1 or ny < 2 * half + 1)},
              "arrays": {"IMAGE": img, "FLAGS": flg, "VARIANCE": var, "ZODI": zodi},
              "headers": {"IMAGE": h_img, "FLAGS": h_flg, "VARIANCE": h_var, "ZODI": h_zod}, "wave_hdu": wave}
    part = out.with_name(out.name + ".part")
    fr.write_cutout(result, part, ra, dec, BOX_DEG)
    os.replace(part, out)
    _epsf_todo.append((out, hd, row["s3_key"], layout))
    return out, {"img": img, "flg": flg, "header": h_img}


_epsf_todo = []


def attach_epsf(local_data):
    """Append the EPSF rows near each box (IRSA layout for the finder's Field); one table per calibration
    id, from cache/local/epsf, a saved cutout or S3 (~3.9 MB once). Only when quick_verdict reads them.
    Boxes of an earlier run of the job (a rerun) are not in this list: the finder reads their EPSF
    table from cache/local/epsf itself (detect.data.cached_epsf)."""
    import fetch_region as fr
    from astropy.io import fits
    mem = {}
    for path, hd, key, layout in list(_epsf_todo):
        try:
            with fits.open(path, memmap=False) as h:
                if "EPSF" in h:
                    continue
                ih = h["IMAGE"].header
            cid = jw.epsf_id(hd)
            if cid not in mem:
                st = fr.Stats()
                mem[cid] = jw.epsf_hdu(hd, key, layout, None, st)
                _add_bytes(st.bytes_net)
            det_off = (1 - ih.get("CRPIX1A", 1.0), 1 - ih.get("CRPIX2A", 1.0))
            with fits.open(path, mode="append") as hl:
                hl.append(_trim_epsf(mem[cid], (ih["NAXIS1"] - 1) / 2, (ih["NAXIS2"] - 1) / 2, det_off))
        except Exception as e:
            print(f"  EPSF for {path.name}: {type(e).__name__}: {e}", flush=True)


def read_box(path, ra=None, dec=None):
    """IMAGE/FLAGS of a cutout on disk (cropped to the box around (ra, dec) when given: saved targets)."""
    from astropy.io import fits
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        img, flg = h["IMAGE"].data.astype(np.float32), h["FLAGS"].data.astype(np.int32)
    if ra is None:
        return {"img": img, "flg": flg, "header": hd}
    import fetch_region as fr
    wcs = fr.celestial_wcs(hd)
    x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
    half = int(round(BOX_DEG * 3600 / 6.15 / 2))
    ix, iy = int(round(x)), int(round(y))
    ny, nx = img.shape
    x0, x1, y0, y1 = max(0, ix - half), min(nx - 1, ix + half), max(0, iy - half), min(ny - 1, iy + half)
    if x1 - x0 < half or y1 - y0 < half:
        return None
    return {"img": img[y0:y1 + 1, x0:x1 + 1], "flg": flg[y0:y1 + 1, x0:x1 + 1],
            "header": fr.shift_header(hd, x0, y0, x1 - x0 + 1, y1 - y0 + 1)}


def jw_sat_bits():
    import blink
    return blink.SAT_BITS


# ---------------------------------------------------------------------------------------- measure (fallback)
def make_grid(ra_c, dec_c):
    import blink
    n = int(round(GRID_FRAC * BOX_DEG * 3600 / blink.PIX_ARCSEC))
    g = blink.WCS(naxis=2)
    g.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    g.wcs.crval = [ra_c, dec_c]
    g.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    g.wcs.cdelt = [-blink.PIX_ARCSEC / 3600, blink.PIX_ARCSEC / 3600]
    return g, (n, n)


def prepare(box, row, t, grid, shape):
    """Clean one box and put it on the stack grid (as local/preview.py prepare)."""
    import blink
    from reproject import reproject_interp
    img = np.asarray(box["img"], np.float64)
    flg = np.asarray(box["flg"]).astype(np.int64)
    sat = (flg & blink.SAT_BITS) != 0
    bad = ((flg & blink.BAD_BITS) != 0) & ~sat
    clean = img.copy()
    clean[bad] = np.nan
    good = np.isfinite(clean) & ~sat
    if good.sum() < 0.3 * good.size:
        return None
    clean -= np.nanmedian(clean[good])
    hd = box["header"]
    wcs = blink.WCS(hd)
    mjd = float(hd.get("MJD-AVG", hd.get("MJD-OBS", row["mjd"])))
    ra, dec = blink.target_position(t, mjd)
    img_r, _ = reproject_interp((clean, wcs), grid, shape_out=shape, order="bilinear")
    sat_r, _ = reproject_interp((sat.astype(float), wcs), grid, shape_out=shape, order="bilinear")
    from datetime import datetime, timezone
    info = {"obs_id": row["obs_id"], "detector": f"D{row['detector']}", "det": int(row["detector"]),
            "collection": row["collection"], "mjd": mjd, "epoch": row["epoch"], "lam_um": row.get("lam_um"),
            "date": datetime.fromtimestamp((mjd - 40587) * 86400, timezone.utc).strftime("%Y-%m-%d"),
            "ra_pred": ra, "dec_pred": dec}
    return info, img_r.astype(np.float32), sat_r > 0.5


def measure(preps, grid, shape, t):
    """Fallback quick measurement from the prepared boxes. Returns a dict (see quick.json).
    The clicked object: a catalogued mover is followed at its predicted position in each season; any
    other point takes, per detector, the local peak (S/N >= DETECT_SNR) nearest the point, and only the
    detectors whose peak agrees (within REF_PX) with the peak nearest the point overall are used, so a
    neighbour star bright at short wavelengths does not replace an object seen only at 4-5 um."""
    import blink
    from scipy.ndimage import maximum_filter
    by = {}
    for p in preps:
        by.setdefault(p[0]["det"], {}).setdefault(p[0]["epoch"], []).append(p)
    n = shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    cx, cy = (float(v) for v in grid.all_world2pix(grid.wcs.crval[0], grid.wcs.crval[1], 0))
    rpx = SEARCH_ARCSEC / blink.PIX_ARCSEC
    mover = bool(t.get("pmra") or t.get("pmdec"))
    dets, cand = {}, {}
    for det, eps in sorted(by.items()):
        if len(eps) < 2:
            continue
        stacks = {}
        for e, v in eps.items():
            stk = np.nanmedian(np.stack([g[1] for g in v]), axis=0)
            fin = np.isfinite(stk)
            if fin.sum() < 50:
                continue
            ns = 1.4826 * float(np.nanmedian(np.abs(stk[fin] - np.nanmedian(stk[fin])))) or 1e-6
            pr, pd = float(np.mean([g[0]["ra_pred"] for g in v])), float(np.mean([g[0]["dec_pred"] for g in v]))
            px, py = (float(q) for q in grid.all_world2pix(pr, pd, 0))
            stacks[e] = (stk, np.mean(np.stack([g[2] for g in v]), axis=0) > 0.5, ns, (px, py),
                         float(np.mean([g[0]["mjd"] for g in v])), len(v))
        if len(stacks) < 2:
            continue
        comb = np.nanmean(np.stack([s_[0] for s_ in stacks.values()]), axis=0)
        fin = np.isfinite(comb)
        noise = 1.4826 * float(np.nanmedian(np.abs(comb[fin] - np.nanmedian(comb[fin])))) or 1e-6
        c0 = np.where(fin, comb, -np.inf)
        peaks = (maximum_filter(c0, size=3) == c0) & fin & (comb >= DETECT_SNR * noise) & (np.hypot(xx - cx, yy - cy) <= rpx)
        if mover:                                         # the peak nearest any season's predicted position
            starts = [s_[3] for s_ in stacks.values()]
            dist = np.min([np.hypot(xx - a, yy - b) for a, b in starts], axis=0)
        else:
            dist = np.hypot(xx - cx, yy - cy)
        dets[det] = {"snr": 0.0, "n": sum(s_[5] for s_ in stacks.values())}
        if not peaks.any():
            continue
        k = int(np.argmin(np.where(peaks, dist, np.inf)))
        py_, px_ = divmod(k, n)
        if mover and dist[py_, px_] > REF_PX:             # nothing at the predicted place in this band
            continue
        dets[det]["snr"] = round(float(comb[py_, px_] / noise), 1)
        cand[det] = (px_, py_, float(dist[py_, px_]), stacks)
    if not mover and cand:                                # one object: the peak nearest the point, and its matches
        ref = min(cand.values(), key=lambda c: c[2])
        cand = {d: c for d, c in cand.items() if math.hypot(c[0] - ref[0], c[1] - ref[1]) <= REF_PX}
    per_det = {}
    for det, (px_, py_, _, stacks) in cand.items():
        pos = {}
        for e, (stk, satm, ns, start, mjd, nn) in stacks.items():
            x0, y0 = start if mover else (px_, py_)
            c = blink.centroid(stk, np.full(stk.shape, ns ** 2), np.isfinite(stk) & ~satm, x0, y0, half=4)
            if not c or math.hypot(c[0] - x0, c[1] - y0) > REF_PX * (1.0 if mover else 2.0):
                continue
            r, d = (float(q) for q in grid.all_pix2world(c[0], c[1], 0))
            pos[e] = (r, d, mjd, nn)
        if len(pos) >= 2:
            es = sorted(pos)
            a, z = pos[es[0]], pos[es[-1]]
            de, dn, sh, pa = blink.offset_arcsec(a[0], a[1], z[0], z[1])
            per_det[det] = {"from": es[0], "to": es[-1], "east": de, "north": dn, "shift": sh, "pa": pa,
                            "dt_yr": (z[2] - a[2]) / 365.25, "snr": dets[det]["snr"], "n": a[3] + z[3]}
    out = {"method": "fallback: raw SPHEREx WCS, per-detector season median stacks, blink.centroid; no Gaia "
                     "calibration (detect.run.quick_verdict replaces it when available)",
           "detectors": {f"D{d}": v for d, v in dets.items()}, "per_detector": {f"D{d}": v for d, v in per_det.items()}}
    if not per_det:
        out.update(detected=False, moving=None)
        return out
    v = list(per_det.values())
    w = np.array([max(p["snr"], 1.0) for p in v])
    e_ = float(np.sum(w * [p["east"] for p in v]) / w.sum())
    n_ = float(np.sum(w * [p["north"] for p in v]) / w.sum())
    dt = float(np.median([p["dt_yr"] for p in v]))
    sh = math.hypot(e_, n_)
    spread = float(np.std([math.hypot(p["east"] - e_, p["north"] - n_) for p in v], ddof=1) / math.sqrt(len(v))) \
        if len(v) >= 3 else 0.0
    err = math.hypot(spread, WCS_FLOOR_ARCSEC)
    moving = sh >= max(3 * err, MOVE_MIN_ARCSEC)
    best = max(per_det, key=lambda d: per_det[d]["snr"])
    out.update(detected=True, moving=bool(moving), shift_arcsec=round(sh, 2), err_arcsec=round(err, 2),
               pa_deg=round(math.degrees(math.atan2(e_, n_)) % 360, 1), dt_yr=round(dt, 3),
               per_year_arcsec=round(sh / dt, 2) if dt > 0.05 else None,
               from_epoch=per_det[best]["from"], to_epoch=per_det[best]["to"], best_detector=f"D{best}",
               detectors_used=sorted(f"D{d}" for d in per_det), n_detectors=len(v),
               n_exposures=int(sum(p["n"] for p in v)))
    return out


def sentence(m):
    """Plain English sentence of the fallback measurement (the page shows its own translation)."""
    if not m.get("detected"):
        return "We found no clear object at this spot to measure."
    if m.get("moving"):
        v = m.get("per_year_arcsec") or m["shift_arcsec"]
        return f"This object is moving: about {v:.1f}″ in one year."
    return "We saw nothing moving here."


# ---------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, help="job folder with request.json")
    a = ap.parse_args()
    jd = Path(a.job).resolve()
    req = json.loads((jd / "request.json").read_text())
    job_id, t = req["id"], dict(req["target"])
    status = jw.Status(jd / "status.json")
    out = jw.CACHE / "jobs" / job_id
    store = QUICK_STORE / job_id
    t_all = time.time()
    tm = {}
    try:
        status.stage("finding", "looking up every SPHEREx exposure of this point (quick decision)")
        import blink
        import fetch_region as fr
        from astropy.time import Time
        fr._HTTP_SLOTS = threading.BoundedSemaphore(HTTP_SLOTS)
        for k, v in (("plx", 0.0), ("epoch", 2016.0), ("pmra", 0.0), ("pmdec", 0.0)):
            if t.get(k) is None:
                t[k] = v
        ra_c, dec_c = blink.target_position(t, Time(blink.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
        local_dir = Path(req["local_data"]) / req["local_target"] if req.get("local_target") and req.get("local_data") else None
        local_data = Path(req["local_data"]) if req.get("local_data") else None
        rows = jw.index_rows(ra_c, dec_c)
        if local_dir is not None:                           # saved cutouts only (never downloaded)
            rows = [r for r in rows if (local_dir / r["collection"] / Path(r["s3_key"]).name).exists()]
        if not rows:
            raise RuntimeError("no SPHEREx exposure covers this point yet")
        ep = blink.split_epochs([r["mjd"] for r in rows])
        for r in rows:
            r["epoch"] = ep[r["mjd"]]
        # priority: D3 / D6 of every season first (seasons interleaved), then the rest
        rank = {}
        for r in sorted(rows, key=lambda r: r["mjd"]):
            g = (r["detector"] not in PRIORITY_DET, r["epoch"])
            r["_rank"] = rank[g] = rank.get(g, -1) + 1
        rows.sort(key=lambda r: (r["detector"] not in PRIORITY_DET, r["_rank"], r["epoch"]))
        n_pri = sum(1 for r in rows if r["detector"] in PRIORITY_DET)
        tm["finding"] = round(time.time() - t_all, 2)
        status.set(images={"source": "saved IRSA cutouts" if local_dir else "SPHEREx S3 (HTTP Range, small boxes)",
                           "found": len(rows), "selected": len(rows), "box_deg": BOX_DEG, "priority": n_pri})
        status.stage("downloading", f"reading a {BOX_DEG:g} deg box from {len(rows)} exposures")
        status.set(progress={"done": 0, "total": len(rows), "bytes": 0})
        grid, shape = make_grid(ra_c, dec_c)
        preps, failed, listing, paths = [], [], {}, {}
        lock = threading.Lock()

        def get(r):
            if local_dir is not None:
                p = local_dir / r["collection"] / Path(r["s3_key"]).name
                return p, read_box(p, ra_c, dec_c)
            return fetch_box(r, ra_c, dec_c, store, local_data)

        def decide(final):
            m = measure(preps, grid, shape, t)
            core = None
            try:
                from detect.run import quick_verdict           # the finder's measurement, when it exists
            except Exception:
                quick_verdict = None
            if quick_verdict is not None and final:
                try:
                    from detect.data import Field
                    if local_dir is None:                      # saved targets: their own cutout folder
                        attach_epsf(local_data)
                        for coll, rs in listing.items():
                            with open(store / f"liste_{coll}.csv", "w", newline="") as fh:
                                w = csv.DictWriter(fh, fieldnames=jw.CSV_COLS)
                                w.writeheader()
                                for rr in sorted(rs, key=lambda q: q["mjd"]):
                                    w.writerow(jw.irsa_row(rr))
                    field = Field(job_id, local_dir or store, ra_c, dec_c, out_dir=out, label=t.get("name"), target=t)
                    core = quick_verdict(field, ra=ra_c, dec=dec_c, log=lambda *x: print(*x, flush=True))
                except Exception as e:
                    traceback.print_exc()
                    core = {"error": f"{type(e).__name__}: {e}"}
            v = (core or {}).get("verdict") if isinstance(core, dict) else None
            if v and v.get("no_data"):                          # the finder could read no exposure: the rough answer
                v = None
            conf = None                                         # the finder's "how sure", of its best candidate
            if v and v.get("best") is not None:
                conf = next((c.get("confidence") for c in core.get("candidates") or [] if c.get("id") == v["best"]), None)
            doc = {"schema": "fazari-quick/1", "stage": "quick", "preliminary": True, "final": final,
                   "ra": ra_c, "dec": dec_c, "box_deg": BOX_DEG, "n_exposures": len(preps),
                   "verdict": v if v and v.get("text") else {"text": sentence(m), "stage": "quick", "source": "fallback"},
                   "measurement": m, "confidence": conf, "core": core, "bytes": _bytes["n"],
                   "seconds": round(time.time() - t_all, 1)}
            return doc

        t_dl = time.time()
        pri_done = None
        with ThreadPoolExecutor(max_workers=EXPOSURE_WORKERS) as ex:
            futs = {ex.submit(get, r): r for r in rows}
            left = len(futs)
            pri_left = n_pri
            for fu in as_completed(futs):
                r = futs[fu]
                left -= 1
                pri_left -= r["detector"] in PRIORITY_DET
                note = ""
                try:
                    path, box = fu.result()
                except Exception as e:
                    path, box, note = None, None, f"error: {type(e).__name__}: {e}"
                res = None
                if isinstance(box, dict):
                    try:
                        res = prepare(box, r, t, grid, shape)
                    except Exception as e:
                        note = f"error: {e}"
                elif isinstance(box, str):
                    note = box
                if res:
                    with lock:
                        preps.append(res)
                        listing.setdefault(r["collection"], []).append(r)
                        paths[f"{r['obs_id']}D{r['detector']}"] = path
                else:
                    failed.append({"key": r["s3_key"], "reason": note or "too few good pixels"})
                status.set(progress={"done": len(preps) + len(failed), "total": len(rows), "bytes": _bytes["n"]},
                           message=f"{len(preps)} of {len(rows)} boxes read")
                if pri_done is None and pri_left == 0 and left > 0:      # first decision from 2.0 + 4.6 um
                    doc = decide(False)
                    pri_done = round(time.time() - t_all, 1)
                    out.mkdir(parents=True, exist_ok=True)
                    (out / "quick.json").write_text(json.dumps(doc, indent=1, default=float))
                    status.set(partial={"verdict": doc["verdict"], "measurement": doc["measurement"], "confidence": doc["confidence"],
                                        "n_exposures": len(preps), "seconds": pri_done, "url": f"/jobs/{job_id}/quick.json"})
                    log(f"first decision after {pri_done} s from {len(preps)} boxes: {doc['verdict']['text']}")
        tm["downloading"] = round(time.time() - t_dl, 2)
        status.stage("processing", "measuring the motion of the clicked object")
        doc = decide(True)
        doc["first_decision_s"] = pri_done
        doc["skipped"] = failed[:50]
        doc["seconds"] = dict(tm, total=round(time.time() - t_all, 1))
        # a small blink of the band where the object is brightest (blink.py layout, as the preview)
        m = doc["measurement"]
        det = int(m["best_detector"][1:]) if m.get("best_detector") else max(
            (int(k[1:]) for k in m.get("detectors", {})), key=lambda d: m["detectors"][f"D{d}"]["snr"], default=3)
        groups = {}
        for p in preps:
            if p[0]["det"] == det:
                groups.setdefault(p[0]["epoch"], []).append(p)
        if len(groups) >= 2:
            try:
                import preview as pv
                extra = {"bin_um": BIN_OF_DET.get(det), "detector": f"D{det}", "fov_deg": round(GRID_FRAC * BOX_DEG, 3),
                         "region_deg": BOX_DEG, "layers": ["IMAGE", "FLAGS"], "source": "quick decision boxes",
                         "stage": "quick decision", "bytes": _bytes["n"]}
                pv.render(out, groups, BIN_OF_DET.get(det, 2.0), det, t, job_id, ra_c, dec_c, grid, shape,
                          bool(t.get("pmra") or t.get("pmdec")), local_dir, extra)
                write_flags(out, groups, store, paths, ra_c, dec_c)
            except Exception:
                traceback.print_exc()
        out.mkdir(parents=True, exist_ok=True)
        (out / "quick.json").write_text(json.dumps(doc, indent=1, default=float))
        status.set(skipped=failed[:50])
        status.stage("done", doc["verdict"]["text"])
        status.set(result={"verdict": doc["verdict"], "measurement": m, "confidence": doc["confidence"], "n_exposures": len(preps),
                           "first_decision_s": pri_done, "bytes": _bytes["n"], "status": "quick",
                           "blink": (out / "meta.json").exists()}, finished=time.time())
        log(f"quick decision done in {time.time() - t_all:.1f} s: {len(preps)} boxes, {_bytes['n'] / 1e6:.1f} MB, "
            f"{doc['verdict']['text']}")
    except Exception as e:
        traceback.print_exc()
        status.stage("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
    finally:
        _rows_pool.shutdown(wait=False, cancel_futures=True)


def write_flags(out, groups, store, paths, ra_c, dec_c):
    """flags/ of the small blink with pipeline/flags.py (its format), from the boxes' FLAGS."""
    import flags
    meta = json.loads((out / "meta.json").read_text())
    src = store / "flagsrc"                                 # the frame file names of meta.json -> the cutouts
    src.mkdir(parents=True, exist_ok=True)
    for g in groups.values():
        for info, _, _ in g:
            name = f"{info['obs_id']}{info['detector']}"
            if paths.get(name) and not (src / name).exists():
                os.symlink(paths[name], src / name)
    flags.build(meta, (ra_c, dec_c), [src], out / "flags", overwrite=True, log=lambda *x: print(*x, flush=True))


if __name__ == "__main__":
    main()
