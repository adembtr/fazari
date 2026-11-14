#!/usr/bin/env python3
"""Fast-star validation sweep: proper motions of ~100 Gaia DR3 fast stars measured in SPHEREx images
and compared with Gaia DR3 (method, pre-registration and results: pipeline/FAST_SWEEP.md).

  uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib \
      --with pillow python -I -u pipeline/fast_sweep.py sample                 # print the pre-registered order
  ... fast_sweep.py boxtest                                                    # first 3 stars, box sizes
  ... fast_sweep.py run --box 0.09 --k 3 [--max 100]                           # sweep (restartable)
  ... fast_sweep.py report --box 0.09 --k 3                                    # stars.csv, summary.json, figure

Data: small boxes of the chosen exposures read from the public SPHEREx S3 bucket with HTTP Range
(PRIMARY+IMAGE header, FLAGS header, the FLAGS rows of the box, the IMAGE rows of the box, the WCS-WAVE
tail; EPSF tables once per calibration id). VARIANCE = box robust noise^2 and ZODI = box median are
synthetic (as local/quick.py). At most 4 requests in flight (fetch_region.http_get semaphore), backoff
on errors. Every network byte is counted (ledger in cache/fast_sweep/ledger.json).

Measurement: the tree's detector B path (detect.deep_astrom.field_measure -> astrometry.measure_seasons,
one position offset per detector, gaia_astrom.judge + astrometry.calibrate) on the target; registration
on the OTHER Gaia stars of the box (the target is excluded from the reference list).
"""
import argparse
import csv
import gzip
import hashlib
import json
import math
import os
import sys
import threading
import time
import traceback
import urllib.parse
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PIPE = ROOT / "pipeline"
sys.path.insert(0, str(PIPE))
import blink as BL                      # noqa: E402
import fetch_region as FR               # noqa: E402
import sky_index                        # noqa: E402

CACHE = ROOT / "cache" / "fast_sweep"
OUTD = Path(os.environ.get("FAST_SWEEP_OUT") or (ROOT / "site" / "data" / "fast_sweep"))
LIST = ROOT / "site" / "data" / "fast_stars.json.gz"
SEED = 20261114
CLASSES = [(0.5, 0.7), (0.7, 1.0), (1.0, 2.0), (2.0, 4.0), (4.0, 1e9)]
N_FAST, N_PER_CLASS = 50, 10
BOX_CANDIDATES = (0.05, 0.07, 0.09, 0.12)
PIX = 6.15
EPSF_KEEP_PX = 300
FETCH_WORKERS = 4                       # exposures in flight; each reads serially -> <= 4 requests in flight
PERTURB = 0.10                          # independence test: starting track wrong by +10 % of the Gaia motion
EPSF_SEED_DIR = ROOT / "cache" / "local" / "epsf"     # read-only seed
STATS = FR.Stats()
_epsf_lock = threading.Lock()
CODE_FILES = ["pipeline/detect/astrometry.py", "pipeline/detect/measure.py", "pipeline/detect/calib.py",
              "pipeline/detect/gaia_astrom.py", "pipeline/detect/deep_astrom.py", "pipeline/detect/data.py",
              "pipeline/detect/run.py", "pipeline/blink.py", "pipeline/fast_sweep.py"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def code_version():
    h = {}
    for f in CODE_FILES:
        h[f.rsplit("/", 1)[-1]] = hashlib.sha1((ROOT / f).read_bytes()).hexdigest()[:10]
    core = {k: v for k, v in h.items() if k != "fast_sweep.py"}     # the tag = the measuring code of the tree
    tag = hashlib.sha1(json.dumps(core, sort_keys=True).encode()).hexdigest()[:10]
    return tag, h


# ------------------------------------------------------------------------------------------ sample
def load_list():
    d = json.load(gzip.open(LIST))
    F = d["fields"]
    stars = [dict(zip(F, s)) for s in d["stars"]]
    for s in stars:
        s["pm"] = math.hypot(s["pmra"], s["pmdec"]) / 1000.0
        mj = s["seasons"][0::2]
        s["same_ori_proxy"] = any(abs(abs(b - a) - 365.25) <= 60 for i, a in enumerate(mj) for b in mj[i + 1:])
    return stars


def sample():
    U = [s for s in load_list() if s["same_ori_proxy"]]
    U.sort(key=lambda s: (-s["pm"], s["sid"]))
    F, rest = U[:N_FAST], U[N_FAST:]
    rng = np.random.default_rng(SEED)
    R = []
    for lo, hi in CLASSES:
        c = [s for s in rest if lo <= s["pm"] < hi]
        if len(c) <= N_PER_CLASS:
            R += c
        else:
            R += [c[i] for i in sorted(rng.choice(len(c), N_PER_CLASS, replace=False))]
    R = [R[i] for i in rng.permutation(len(R))]
    out = []
    for i in range(max(len(F), len(R))):
        if i < len(F):
            out.append(dict(F[i], set="F", set_rank=i + 1))
        if i < len(R):
            out.append(dict(R[i], set="R", set_rank=i + 1))
    for k, s in enumerate(out):
        s["order"] = k + 1
    return out, len(U)


def pos2026(s):
    dt = 10.0
    return (s["ra"] + s["pmra"] * dt / 3.6e6 / math.cos(math.radians(s["dec"])), s["dec"] + s["pmdec"] * dt / 3.6e6)


def speed_class(pm):
    for lo, hi in CLASSES:
        if lo <= pm < hi:
            return f"{lo:g}-{hi:g}" if hi < 1e8 else f">{lo:g}"
    return "?"


# ------------------------------------------------------------------------------------------ plan
def plan(s, K):
    ra, dec = pos2026(s)
    rows = sky_index.find_images(ra, dec)
    best = {}
    for r in rows:
        k = (r["obs_id"], r["detector"])
        if k not in best or (best[k]["collection"] != "dr1" and r["collection"] == "dr1"):
            best[k] = r
    rows = sorted(best.values(), key=lambda r: r["mjd"])
    k, last = -1, None
    for r in rows:
        if last is None or r["mjd"] - last > 30:
            k += 1
        r["season_i"] = k
        last = r["mjd"]
    chosen = []
    for si in range(k + 1):
        # the K exposures of each detector closest in time to the season's median time: a compact window
        # (evenly spaced picks left > 30 d gaps inside a season, which the pipeline then split into seasons)
        tmed = float(np.median([r["mjd"] for r in rows if r["season_i"] == si]))
        for det in range(1, 7):
            rs = [r for r in rows if r["season_i"] == si and r["detector"] == det]
            rs.sort(key=lambda r: (abs(r["mjd"] - tmed), r["mjd"]))
            chosen += rs[:K]
    chosen.sort(key=lambda r: r["mjd"])
    return ra, dec, rows, chosen


# ------------------------------------------------------------------------------------------ fetch
def _epsf_id(h):
    for card in h.get("HISTORY", []):
        s = str(card)
        if "[CALIB] epsf" in s:
            return s.split()[-1]
    return None


def epsf_table(img, fl, f):
    """EPSF BinTableHDU of this exposure's calibration id (seed cache, own cache, else S3 once)."""
    from astropy.io import fits
    cid = _epsf_id(img.header) or "nocalib_" + Path(f.key).stem
    with _epsf_lock:
        for d in (EPSF_SEED_DIR, CACHE / "epsf"):
            p = d / f"{cid}.fits"
            if p.exists():
                with fits.open(p, memmap=False) as h:
                    return h["EPSF"].copy()
        var_hdr = fl.next_off
        zodi_data = var_hdr + FR.EXT_HLEN + FR.pad2880(img.datasize) + FR.EXT_HLEN
        off = zodi_data + FR.pad2880(img.datasize)
        info = FR.read_header(f, off, 2 * FR.BLOCK, 5)
        if info.name != "EPSF":
            raise IOError(f"HDU 5 of {f.key} is {info.name}, not EPSF")
        raw = f.read(info.hdr_off, info.data_off + FR.pad2880(info.datasize))
        hdu = fits.BinTableHDU.fromstring(raw)
        p = CACHE / "epsf" / f"{cid}.fits"
        p.parent.mkdir(parents=True, exist_ok=True)
        fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(p.with_suffix(".part"), overwrite=True)
        os.replace(p.with_suffix(".part"), p)
        return hdu.copy()


def _row(url, a, nb):
    t0 = time.monotonic()
    body, status, _ = FR.http_get(url, f"bytes={a}-{a + nb - 1}")
    STATS.add_net(len(body), time.monotonic() - t0)
    if status == 200:
        body = body[a:a + nb]
    if len(body) != nb:
        raise IOError(f"short read {len(body)} != {nb}")
    return np.frombuffer(body, ">f4")


def fetch_box(row, ra, dec, box_deg, store):
    """Raw box (IMAGE, FLAGS, WCS-WAVE, EPSF rows near the box) of one exposure -> FITS, or (None, reason)."""
    from astropy.io import fits
    out = store / row["collection"] / Path(row["s3_key"]).name
    if out.exists():
        return out, "cached"
    f = FR.S3File(row["s3_key"], CACHE / "s3", STATS)
    f.read(0, FR.BLOCK + 25920)
    prim = FR.read_header(f, 0, FR.BLOCK, 0)
    img = FR.read_header(f, prim.next_off, FR.BLOCK + 25920 - prim.next_off, 1)
    if img.name != "IMAGE":
        return None, f"unexpected HDU {img.name}"
    hd = img.header
    wcs = FR.celestial_wcs(hd)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
    npix, nypix = int(hd["NAXIS1"]), int(hd["NAXIS2"])
    half = int(round(box_deg * 3600 / PIX / 2))
    ix, iy = int(round(x)), int(round(y))
    x0, x1, y0, y1 = max(0, ix - half), min(npix - 1, ix + half), max(0, iy - half), min(nypix - 1, iy + half)
    if not (0 <= ix < npix and 0 <= iy < nypix) or x1 - x0 < half or y1 - y0 < half:
        return None, "point at or beyond the image edge"
    fl = FR.read_header(f, img.next_off, 17280, 2)
    if fl.name != "FLAGS":
        return None, f"unexpected HDU {fl.name}"
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    flg = FR.read_compressed_rows(f, fl, y0, y1)[:, x0:x1 + 1].astype(np.int32)
    url = FR.S3_BASE + urllib.parse.quote(row["s3_key"])
    im = np.stack([_row(url, img.data_off + yy * npix * 4 + x0 * 4, nx * 4) for yy in range(y0, y1 + 1)]).astype(np.float32)
    wave = FR.read_wave_hdu(f)
    ep = epsf_table(img, fl, f)
    h_img = FR.shift_header(FR.image_header(img), x0, y0, nx, ny)
    h_flg = FR.shift_header(FR.image_header(fl), x0, y0, nx, ny)
    result = {"key": row["s3_key"], "primary_header": prim.header, "box": {"edge": "clip", "x0": x0, "y0": y0},
              "geometry": {"clipped": bool(nx < 2 * half + 1 or ny < 2 * half + 1)},
              "arrays": {"IMAGE": im, "FLAGS": flg}, "headers": {"IMAGE": h_img, "FLAGS": h_flg}, "wave_hdu": wave}
    part = out.with_name(out.name + ".part")
    FR.write_cutout(result, part, ra, dec, box_deg)
    tab = ep.data
    d = np.hypot(tab["XCENTER"] - (ix + 1), tab["YCENTER"] - (iy + 1))
    keep = np.nonzero(d < EPSF_KEEP_PX)[0]
    if not len(keep):
        keep = np.array([int(np.argmin(d))])
    with fits.open(part, mode="append") as hl:
        hl.append(fits.BinTableHDU(data=tab[keep], header=ep.header.copy()))
    os.replace(part, out)
    return out, "fetched"


def fetch_star(s, K, box_deg, logf=log):
    ra, dec, rows, chosen = plan(s, K)
    store = CACHE / "boxes" / s["sid"]
    store.mkdir(parents=True, exist_ok=True)
    b0 = STATS.bytes_net
    t0 = time.time()
    res = {}

    def one(r):
        try:
            return r, fetch_box(r, ra, dec, box_deg, store)
        except Exception as ex:
            return r, (None, f"fetch error {type(ex).__name__}: {ex}")
    with ThreadPoolExecutor(FETCH_WORKERS) as ex:
        for r, (p, why) in ex.map(one, chosen):
            res[r["s3_key"]] = (str(p) if p else None, why)
    for coll in ("dr1", "qr3"):
        with open(store / f"liste_{coll}.csv", "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["obs_id", "access_url", "t_min", "t_max", "energy_bandpassname"])
            for r in chosen:
                if r["collection"] == coll and res[r["s3_key"]][0]:
                    w.writerow([r["obs_id"], "https://irsa.ipac.caltech.edu/ibe/data/spherex/" + r["s3_key"],
                                f"{r['mjd']:.6f}", f"{r.get('mjd_end', r['mjd']):.6f}", f"SPHEREx-D{r['detector']}"])
    nb = STATS.bytes_net - b0
    info = {"ra2026": ra, "dec2026": dec, "n_index": len(rows), "n_chosen": len(chosen),
            "n_seasons_index": len({r["season_i"] for r in rows}),
            "n_fetched": sum(1 for v in res.values() if v[0]),
            "skipped": {k: v[1] for k, v in res.items() if not v[0]},
            "bytes_net": nb, "seconds": round(time.time() - t0, 1), "box_fetch_deg": box_deg}
    (store / "fetch.json").write_text(json.dumps(info, indent=1))
    logf(f"  fetched {s['sid']} {s['name'] or ''}: {info['n_fetched']}/{len(chosen)} boxes, {nb / 1e6:.2f} MB, "
         f"{info['seconds']} s")
    return info


# ------------------------------------------------------------------------------------------ fields
def make_field(s, box_deg, ra, dec, K=None):
    """IRSA-layout cutouts of side box_deg (cropped from the fetched boxes; synthetic VARIANCE / ZODI).
    K: only the exposures plan(s, K) chooses (a subset of a larger-K fetch)."""
    from astropy.io import fits
    src = CACHE / "boxes" / s["sid"]
    fd = CACHE / "fields" / (f"{s['sid']}_{box_deg:.2f}" + (f"_K{K}" if K else ""))
    keep = {Path(r["s3_key"]).name for r in plan(s, K)[3]} if K else None
    half = int(round(box_deg * 3600 / PIX / 2))
    n = 0
    for coll in ("dr1", "qr3"):
        lp = src / f"liste_{coll}.csv"
        if lp.exists():
            (fd / coll).mkdir(parents=True, exist_ok=True)
            (fd / f"liste_{coll}.csv").write_bytes(lp.read_bytes())
        for p in sorted((src / coll).glob("*.fits")) if (src / coll).is_dir() else []:
            if keep is not None and p.name not in keep:
                continue
            out = fd / coll / p.name
            if out.exists():
                n += 1
                continue
            with fits.open(p, memmap=False) as h:
                hi, hf = h["IMAGE"].header, h["FLAGS"].header
                im, fg = h["IMAGE"].data, h["FLAGS"].data
                wcs = FR.celestial_wcs(hi)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
                ny, nx = im.shape
                ix, iy = int(round(x)), int(round(y))
                x0, x1, y0, y1 = max(0, ix - half), min(nx - 1, ix + half), max(0, iy - half), min(ny - 1, iy + half)
                if x1 - x0 < half or y1 - y0 < half:
                    continue
                im = im[y0:y1 + 1, x0:x1 + 1].astype(np.float32)
                fg = fg[y0:y1 + 1, x0:x1 + 1].astype(np.int32)
                cw, chh = x1 - x0 + 1, y1 - y0 + 1
                sat = (fg & BL.SAT_BITS) != 0
                good = np.isfinite(im) & ~sat & ((fg & BL.BAD_BITS) == 0)
                med = float(np.nanmedian(im[good])) if good.any() else 0.0
                sig = 1.4826 * float(np.nanmedian(np.abs(im[good] - med))) if good.any() else 1.0
                h_img = FR.shift_header(hi, x0, y0, cw, chh)
                h_flg = FR.shift_header(hf, x0, y0, cw, chh)
                h_var, h_zod = h_img.copy(), h_img.copy()
                h_var["EXTNAME"], h_zod["EXTNAME"] = "VARIANCE", "ZODI"
                h_var["FZQVAR"] = ("box robust noise^2", "fast sweep: VARIANCE not read")
                h_zod["FZQZODI"] = ("box median", "fast sweep: ZODI not read")
                hl = fits.HDUList([fits.PrimaryHDU(header=h[0].header.copy()),
                                   fits.ImageHDU(im, h_img), fits.ImageHDU(fg, h_flg),
                                   fits.ImageHDU(np.full(im.shape, max(sig, 1e-6) ** 2, np.float32), h_var),
                                   fits.ImageHDU(np.full(im.shape, med, np.float32), h_zod),
                                   h["WCS-WAVE"].copy(), h["EPSF"].copy()])
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    hl.writeto(out.with_name(out.name + ".part.fits"), overwrite=True)
                os.replace(out.with_name(out.name + ".part.fits"), out)
                n += 1
    return fd, n


def gaia_json(s, ra, dec):
    from detect import data as Dt, run as RUN
    gd = CACHE / "gaia" / s["sid"]
    p = gd / "gaia_field.json"
    if not p.exists():
        f = Dt.Field(s["sid"], gd, ra, dec, out_dir=gd)
        RUN.fetch_gaia(f, log=lambda m: log(m))
    return p if p.exists() else None


# ------------------------------------------------------------------------------------------ measure
def _perturb(gt, j, frac):
    """Starting track of star j wrong by frac x its Gaia motion, same 2026.0 position."""
    dE, dN = gt.pmra[j] * frac, gt.pmdec[j] * frac
    dt = 2026.0 - gt.epoch
    gt.pmra[j] += dE
    gt.pmdec[j] += dN
    gt.ra[j] -= dE * dt / 3.6e6 / math.cos(math.radians(gt.dec[j]))
    gt.dec[j] -= dN * dt / 3.6e6
    return dE, dN


def measure_target(field, s, prepared, frac=0.0, n_perm=None):
    from detect import run as RUN, deep_astrom as DA, gaia_astrom as GA, astrometry as AS
    import copy
    exps, gt0, cal, summ = prepared
    gt = copy.deepcopy(gt0)
    j = int(np.nonzero(gt.sid == int(s["sid"]))[0][0])
    pert = _perturb(gt, j, frac) if frac else (0.0, 0.0)
    quiet = lambda m: None   # noqa: E731
    ctx = RUN.Ctx(field, exps, gt, cal, summ, log=quiet, opts={"no_sso": True})
    src, ng = DA.field_sources(ctx)
    A, T = DA.field_measure(ctx)
    cells = DA.field_cells(ctx)
    smax = DA.snr_max(T)
    ref = np.nonzero(gt.reference())[0]
    floor, nfl = AS.estimate_season_floor(T, ref)
    f = AS.fit_drift(T, j, floor=floor, min_n=GA.MIN_SEASON_N, cells=cells)
    if f is None:
        return {"ok": False, "why": "no drift fit (target S/N < 10 or < 3 exposures in < 2 seasons)",
                "floor": floor, "season_n": [int(v) for v in T["n"][:, j]],
                "season_snr": [None if not np.isfinite(v) else round(float(v), 1) for v in T["snr"][:, j]]}
    f = AS.calibrate(exps, A, T, ctx.seasons, j, f, floor, cells=cells, n_perm=n_perm or AS.N_PERM,
                     min_n=GA.MIN_SEASON_N)
    pmE = gt.pmra[j] + f["bE"] * 1000
    pmN = gt.pmdec[j] + f["bN"] * 1000
    eE, eN = f["ebE"] * 1000, f["ebN"] * 1000
    out = {"ok": True, "pmE": pmE, "pmN": pmN, "eE": eE, "eN": eN,            "saturated": bool(f.get("saturated")), "n_seasons": f["n_seasons"], "model": f.get("model"),
           "chi2": f["chi2"], "dof": f["dof"], "floor": floor, "n_floor": nfl,
           "error_inflation": f.get("error_inflation"), "perturb_mas_yr": pert}
    cb = f.get("cov_b")
    if cb:
        rho = cb[0][1] / math.sqrt(max(cb[0][0] * cb[1][1], 1e-30))
        out["rho_EN"] = float(rho)
    if frac:
        return out
    try:
        r = GA.judge(ctx, exps, A, T, cells, src, j, floor, smax, n_perm=8)
        out["judge_cls"] = r["cls"] if r else None
        out["judge_flags"] = r["flags"] if r else []
    except Exception as ex:
        out["judge_cls"], out["judge_flags"] = None, [f"judge error {ex}"]
    out["blend_gaia_arcsec"] = GA._brighter_neighbour(gt, j, 8.0)
    # seasons of the target
    seas = []
    for k, sname in enumerate(ctx.seasons):
        if T["n"][k, j] < 1 or not np.isfinite(T["E"][k, j]):
            continue
        t = float(T["t"][k, j])
        r_, d_ = src.at((t - 2000.0) * 365.25 + 51544.5, t)
        cosd = math.cos(math.radians(d_[j]))
        seas.append({"season": sname, "jyear": t, "n": int(T["n"][k, j]), "snr": float(T["snr"][k, j]),
                     "orient": float(ctx.season_info[sname]["orient_deg"]),
                     "ra": float(r_[j] + T["E"][k, j] / 3600 / cosd), "dec": float(d_[j] + T["N"][k, j] / 3600),
                     "eE": float(T["eE"][k, j]), "eN": float(T["eN"][k, j]), "sat": bool(T["sat"][k, j])})
    out["seasons"] = seas
    # same-orientation pair farthest apart in time
    from detect import data as Dt
    best = None
    for a in range(len(seas)):
        for b in range(a + 1, len(seas)):
            if Dt.same_orientation(seas[a]["orient"], seas[b]["orient"]) and seas[a]["n"] >= 3 and seas[b]["n"] >= 3:
                dt = seas[b]["jyear"] - seas[a]["jyear"]
                if dt > 0.5 and (best is None or dt > best[2]):
                    best = (a, b, dt)
    if best:
        a, b, dt = best
        sa, sb = seas[a], seas[b]
        dE = (sb["ra"] - sa["ra"]) * 3600 * math.cos(math.radians(0.5 * (sa["dec"] + sb["dec"])))
        dN = (sb["dec"] - sa["dec"]) * 3600
        err = math.sqrt(sa["eE"] ** 2 + sb["eE"] ** 2 + sa["eN"] ** 2 + sb["eN"] ** 2 + 4 * floor ** 2) / math.sqrt(2)
        out["pair"] = {"from": sa["season"], "to": sb["season"], "dt_yr": dt, "dE": dE, "dN": dN,
                       "arcsec": math.hypot(dE, dN), "err_arcsec": err,
                       "pa_deg": math.degrees(math.atan2(dE, dN)) % 360,
                       "speed": math.hypot(dE, dN) / dt, "speed_err": err / dt}
    else:
        out["pair"] = None
    # registration quality
    so = summ.get("source_of_offset", {})
    tot = max(1, sum(so.values()))
    out["reg"] = {"source_of_offset": so, "frac_own": (so.get("exposure", 0) + so.get("cell", 0)) / tot,
                  "mode": summ.get("mode")}
    from detect import calib as CAL, measure as M
    refidx = np.nonzero(gt.reference())[0]
    nin = []
    for e in exps:
        r_, d_ = gt.at(e["mjd"], refidx)
        nin.append(int(CAL.on_cutout(e, r_, d_, margin=M.R_STAMP + 1).sum()))
    out["n_ref_in_box_median"] = float(np.median(nin)) if nin else 0.0
    out["n_exposures_used"] = len(exps)
    out["n_seasons_data"] = len(ctx.seasons)
    return out


CAL_MIN_STARS = 3          # distinct reference stars per season x detector cell (pipeline default 5; small boxes)


def measure_star(s, box_deg, K, with_perturb=True):
    from detect import data as Dt, run as RUN, calib as CAL
    CAL.CAL_MIN_STARS = CAL_MIN_STARS
    ra, dec = pos2026(s)
    gj = gaia_json(s, ra, dec)
    fd, n = make_field(s, box_deg, ra, dec, K)
    rec = {"sid": s["sid"], "name": s["name"], "box_deg": box_deg, "K": K, "n_files": n}
    if n == 0:
        rec.update(ok=False, why="no data: no box could be read")
        return rec
    field = Dt.Field(s["sid"], fd, ra, dec, out_dir=None, gaia_json=gj, label=s["name"] or s["sid"],
                     target={"name": s["name"], "gaia_dr3": s["sid"]})
    t0 = time.time()
    exps = Dt.load_exposures(field, log=lambda m: None)
    seas = Dt.seasons(exps)
    rec["n_exposures_loaded"] = len(exps)
    rec["n_seasons_loaded"] = len(seas)
    per = {}
    for e in exps:
        per[e["epoch"]] = per.get(e["epoch"], 0) + 1
    if sum(1 for v in per.values() if v >= 3) < 2:
        rec.update(ok=False, why=f"no data: < 2 seasons with >= 3 box exposures ({per})")
        return rec
    if gj is None:
        rec.update(ok=False, why="Gaia field query failed")
        return rec
    prepared = RUN.prepare(field, log=lambda m: None, exps=exps)
    if prepared[1] is None or not (prepared[1].sid == int(s["sid"])).any():
        rec.update(ok=False, why="target not in the Gaia field list")
        return rec
    m = measure_target(field, s, prepared)
    rec["seconds_measure"] = round(time.time() - t0, 1)
    rec.update(m)
    if m["ok"] and with_perturb:
        t1 = time.time()
        mp = measure_target(field, s, prepared, frac=PERTURB, n_perm=50)
        if mp["ok"]:
            pE, pN = mp["perturb_mas_yr"]
            pp = math.hypot(pE, pN)
            # pull: fraction of the starting-track error that survives in the result (0 = independent)
            dE, dN = mp["pmE"] - m["pmE"], mp["pmN"] - m["pmN"]
            rec["perturb"] = {"delta_mas_yr": [pE, pN], "result_shift_mas_yr": [dE, dN],
                              "pull": (dE * pE + dN * pN) / pp ** 2, "shift_sigma": math.hypot(dE / m["eE"], dN / m["eN"])}
        else:
            rec["perturb"] = {"failed": mp.get("why")}
        rec["seconds_perturb"] = round(time.time() - t1, 1)
    return rec


def compare(rec, s):
    if not rec.get("ok"):
        return rec
    from detect import astrometry as AS
    gE, gN = s["pmra"], s["pmdec"]
    dE, dN = rec["pmE"] - gE, rec["pmN"] - gN
    rho = max(-0.99, min(0.99, rec.get("rho_EN") or 0.0))
    zE, zN = dE / rec["eE"], dN / rec["eN"]
    chi2 = (zE ** 2 - 2 * rho * zE * zN + zN ** 2) / (1 - rho ** 2)
    g = math.hypot(gE, gN)
    rec["gaia"] = {"pmra": gE, "pmdec": gN, "pm": g, "pa": math.degrees(math.atan2(gE, gN)) % 360}
    rec["meas"] = {"pm": math.hypot(rec["pmE"], rec["pmN"]),
                   "pm_err": math.hypot(rec["pmE"] * rec["eE"], rec["pmN"] * rec["eN"]) / max(1e-9, math.hypot(rec["pmE"], rec["pmN"])),
                   "pa": math.degrees(math.atan2(rec["pmE"], rec["pmN"])) % 360}
    rec["meas"]["pa_err"] = math.degrees(math.hypot(rec["pmN"] * rec["eE"], rec["pmE"] * rec["eN"])
                                         / max(1e-9, rec["pmE"] ** 2 + rec["pmN"] ** 2))
    rec["diff"] = {"dE": dE, "dN": dN, "abs_mas_yr": math.hypot(dE, dN), "pct": 100 * math.hypot(dE, dN) / g,
                   "chi2": chi2, "sigma": float(AS._sigma_from_chi2(chi2, 2)),
                   "speed_diff_mas_yr": rec["meas"]["pm"] - g, "speed_sigma": (rec["meas"]["pm"] - g) / rec["meas"]["pm_err"],
                   "within1": chi2 <= 2.30, "within2": chi2 <= 6.18, "pass3": chi2 <= 11.83}
    if rec.get("pair"):
        p = rec["pair"]
        rec["pair"]["gaia_pct"] = 100 * (p["speed"] - g / 1000) / (g / 1000)
        rec["pair"]["sigma"] = (p["speed"] - g / 1000) / p["speed_err"]
    return rec


# ------------------------------------------------------------------------------------------ ledger
def ledger_add(sid, nbytes, note):
    p = CACHE / "ledger.json"
    L = json.loads(p.read_text()) if p.exists() else {"entries": [], "total_bytes": 0}
    L["entries"].append({"time": time.strftime("%H:%M:%S"), "sid": sid, "bytes": int(nbytes), "note": note})
    L["total_bytes"] = int(sum(e["bytes"] for e in L["entries"]))
    tmp = p.with_name(f".ledger.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(L, indent=1))
    os.replace(tmp, p)
    return L["total_bytes"]


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


# ------------------------------------------------------------------------------------------ commands
def cmd_sample(a):
    S, nu = sample()
    print(f"universe {nu} stars; sample {len(S)}")
    for s in S[:a.max]:
        print(s["order"], s["set"], s["set_rank"], s["sid"], s["name"], f"{s['pm']:.3f}", s["vis"], s["why"], s["m_spx"])


def cmd_boxtest(a):
    S, _ = sample()
    tag, files = code_version()
    out = CACHE / "boxtest"
    out.mkdir(parents=True, exist_ok=True)
    for s in S[:3]:
        b0 = STATS.bytes_net
        info = fetch_star(s, a.k, max(BOX_CANDIDATES))
        tot = ledger_add(s["sid"], STATS.bytes_net - b0, f"boxtest fetch {max(BOX_CANDIDATES)} deg K={a.k}")
        log(f"  ledger total {tot / 1e6:.1f} MB")
        for B, K in [(B, a.k) for B in BOX_CANDIDATES] + [(B, a.k - 1) for B in BOX_CANDIDATES[1:]]:
            p = out / f"{s['sid']}_{B:.2f}_K{K}_v2.json"
            if p.exists():
                continue
            try:
                rec = compare(measure_star(s, B, K, with_perturb=False), s)
            except Exception as ex:
                traceback.print_exc()
                rec = {"ok": False, "why": f"error {type(ex).__name__}: {ex}"}
            rec["fetch"] = info
            rec["code_version"] = tag
            p.write_text(json.dumps(_clean(rec), indent=1))
            log(f"  {s['name'] or s['sid']} B={B} K={K}: ok={rec.get('ok')} {rec.get('why', '')} "
                f"refs/exp={rec.get('n_ref_in_box_median')} reg_own={rec.get('reg', {}).get('frac_own')} "
                f"err=({rec.get('eE')},{rec.get('eN')}) n_exp={rec.get('n_exposures_used')}")


def cmd_run(a):
    S, _ = sample()
    S = S[:a.max]
    tag, files = code_version()
    out = CACHE / "results" / f"B{a.box:.2f}_K{a.k}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "code_version.json").write_text(json.dumps({"tag": tag, "files": files}, indent=1))
    todo = [s for s in S if not (out / f"{s['sid']}.json").exists()
            or json.loads((out / f"{s['sid']}.json").read_text()).get("code_version") != tag]
    log(f"run B={a.box} K={a.k}: {len(todo)} of {len(S)} stars to do; code {tag}")
    fetched = {}
    lock = threading.Lock()

    def prefetch():
        for s in todo:
            if (CACHE / "STOP").exists():
                break
            if a.budget_mb and _ledger_total() > a.budget_mb * 1e6:
                log("  budget reached: no further fetches")
                break
            b0 = STATS.bytes_net
            try:
                info = fetch_star(s, a.k, a.box)
            except Exception as ex:
                info = {"error": f"{type(ex).__name__}: {ex}"}
            nb = STATS.bytes_net - b0
            ledger_add(s["sid"], nb, f"run fetch B={a.box} K={a.k}")
            with lock:
                fetched[s["sid"]] = info
    th = threading.Thread(target=prefetch, daemon=True)
    th.start()
    for s in todo:
        while True:
            with lock:
                if s["sid"] in fetched:
                    info = fetched[s["sid"]]
                    break
            if not th.is_alive():
                info = None
                break
            time.sleep(0.5)
        if info is None:
            log("  fetch thread stopped (budget or STOP); ending")
            break
        try:
            if "error" in info:
                rec = {"ok": False, "why": f"fetch error: {info['error']}"}
            else:
                rec = compare(measure_star(s, a.box, a.k), s)
        except Exception as ex:
            traceback.print_exc()
            rec = {"ok": False, "why": f"measurement error {type(ex).__name__}: {ex}"}
        rec.update(sid=s["sid"], name=s["name"], order=s["order"], set=s["set"], set_rank=s["set_rank"],
                   fetch=info, code_version=tag, finished=time.strftime("%Y-%m-%dT%H:%M:%S"))
        (out / f"{s['sid']}.json").write_text(json.dumps(_clean(rec), indent=1))
        d = rec.get("diff") or {}
        log(f"[{s['order']}] {s['name'] or s['sid']} pm {s['pm']:.3f}: ok={rec.get('ok')} {rec.get('why', '')}"
            f" meas {rec.get('meas', {}).get('pm', float('nan')) / 1000:.3f}+-{rec.get('meas', {}).get('pm_err', float('nan')) / 1000:.3f}"
            f" diff {d.get('pct', float('nan')):.2f}% {d.get('sigma', float('nan')):.1f}sig"
            f" sat={rec.get('saturated')} pull={rec.get('perturb', {}).get('pull')} ledger {_ledger_total() / 1e6:.0f} MB")


def _ledger_total():
    p = CACHE / "ledger.json"
    for _ in range(5):
        try:
            return json.loads(p.read_text())["total_bytes"] if p.exists() else 0
        except (OSError, ValueError):
            time.sleep(0.2)
    return 0


def ledger_disk():
    """Network bytes reconstructed from disk: every S3File range is cached in cache/fast_sweep/s3 and every
    IMAGE row read is in a box file (rows x width x 4 bytes). Exact except reads lost in killed runs."""
    from astropy.io import fits
    s3 = sum(p.stat().st_size for p in (CACHE / "s3").rglob("*.bin"))
    rows = 0
    for p in (CACHE / "boxes").rglob("*.fits"):
        with fits.open(p, memmap=False) as h:
            rows += int(np.prod(h["IMAGE"].data.shape)) * 4
    return {"s3_ranges_bytes": s3, "image_rows_bytes": rows, "total_bytes": s3 + rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["sample", "boxtest", "run", "report"])
    ap.add_argument("--box", type=float, default=0.09)
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--max", type=int, default=100)
    ap.add_argument("--budget-mb", type=float, default=1150)
    a = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    if a.cmd == "sample":
        cmd_sample(a)
    elif a.cmd == "boxtest":
        cmd_boxtest(a)
    elif a.cmd == "run":
        cmd_run(a)
    elif a.cmd == "report":
        import fast_sweep_report
        fast_sweep_report.report(a)


if __name__ == "__main__":
    main()
