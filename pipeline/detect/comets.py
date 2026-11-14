"""Known comets moving through real SPHEREx images (Fazari showcase; method: pipeline/COMETS.md).

Per comet (selection: comet_select.py, JPL Horizons positions):
  1. exposures that contain the comet at their own mid time (Horizons 2-h grid, interpolated,
     then moved from the geocentre to SPHEREx with the header X_SC/Y_SC/Z_SC);
  2. a small box around the predicted pixel (s3box: per-row Range requests, never full files),
     plus up to N_REF references: the same sky in the same detector on dates when the comet was
     far away, closest in wavelength; difference D = target - median(references);
  3. position: EPSF fit near the prediction in D -> offset from the ephemeris (arcsec);
  4. photometry: aperture flux in D at that exposure's own wavelength (WCS-WAVE), error from the
     scatter of empty apertures in the same difference box plus the pixel variance;
  5. products: sky-frame blink (stars fixed, comet moves), co-moving stack, coma test (comet
     profile vs. stars of the same frames), spectrum (reflectance relative to the Sun).

Network: at most MAX_INFLIGHT S3 requests at a time (the s3box row pool is replaced by a pool of
that size), byte ledger cache/comets/bytes_ledger.json, budget BUDGET_MB. Everything is cached and
restartable: cache/comets/runs/<comet>/<exposure>.npz is skipped when present.
"""
import json
import math
import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates, gaussian_filter

import blink as BL
import sky_index as SI

os.environ.setdefault("FAZARI_AST_CACHE", str(BL.ROOT / "cache" / "comets" / "s3cache"))
from . import s3box as S3            # noqa: E402  (cache folder chosen above)
from . import ssoephem as EPH        # noqa: E402
from . import asteroids as A         # noqa: E402
from . import comet_select as CS     # noqa: E402

MAX_INFLIGHT = 4
S3._pool = ThreadPoolExecutor(max_workers=MAX_INFLIGHT)
BUDGET_MB = 400.0
PIX = BL.PIX_NATIVE
HALF = 24                 # target box half size (native px): 49 x 49 = 5.0'
VHALF = 6                 # variance box half size
N_REF = 3
R_AP = 2.0                # photometry aperture radius (native px, 12.3")
R_AP2 = 4.0               # larger aperture (coma)
EDGE = HALF + 4
CACHE = CS.CACHE
RUNS = CACHE / "runs"
LEDGER = CACHE / "bytes_ledger.json"
OUT_SITE = BL.ROOT / "site" / "data" / "comets"

COMETS = {}               # pdes -> display info, filled by choose()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def safe(s):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in s)


# ------------------------------------------------------------------------------------------ ledger
def ledger():
    try:
        return json.loads(LEDGER.read_text())
    except (OSError, ValueError):
        return {"s3_bytes": 0, "s3_requests": 0, "horizons_bytes": 0, "sessions": []}


def ledger_flush(note):
    L = ledger()
    st = S3.stats()
    b = int(st.get("bytes_net", 0))
    n = int(st.get("requests", st.get("n_net", 0)) or 0)
    L["s3_bytes"] += b - ledger_flush.last[0]
    L["s3_requests"] += n - ledger_flush.last[1]
    L["horizons_bytes"] += CS.NET["bytes"] - ledger_flush.last[2]
    ledger_flush.last = [b, n, CS.NET["bytes"]]
    L["sessions"].append({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "note": note, "s3_total_mb": round(L["s3_bytes"] / 1e6, 2)})
    L["sessions"] = L["sessions"][-200:]
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(L, indent=1))
    if L["s3_bytes"] / 1e6 > BUDGET_MB:
        raise SystemExit(f"S3 budget {BUDGET_MB} MB exceeded: {L['s3_bytes'] / 1e6:.1f} MB")
    return L


ledger_flush.last = [0, 0, 0]


# ------------------------------------------------------------------------------------------ geometry
def comet_at(rows, mjd, sc_km):
    """Topocentric (SPHEREx) RA/Dec of the comet at UTC mjd, plus delta, T, r, rate."""
    E = CS.grid_at(rows, np.array([mjd]))
    u = E["u"][0]
    ra = math.degrees(math.atan2(u[1], u[0])) % 360
    dec = math.degrees(math.asin(u[2]))
    r, d = EPH.topocentric([ra], [dec], [float(E["delta"][0])], sc_km)
    return dict(ra=float(r[0]), dec=float(d[0]), ra_geo=ra, dec_geo=dec, delta=float(E["delta"][0]),
                T=float(E["T"][0]), r=float(E["r"][0]), rate_ra=float(E["dra_cosd_h"][0]),
                rate_dec=float(E["ddec_h"][0]))


def offset_arcsec(ra1, dec1, ra0, dec0):
    """(east, north) arcsec of (ra1, dec1) from (ra0, dec0)."""
    c, e, n = SI.tangent_basis(np.float64(ra0), np.float64(dec0))
    x, y, _ = SI.project(SI.unit(np.float64(ra1), np.float64(dec1)), c, e, n)
    return float(x) * 3600, float(y) * 3600


# ------------------------------------------------------------------------------------------ references
def pick_refs(ra, dec, det, mjd, lam, min_dt_days, n=N_REF):
    best = {}
    for r in SI.find_images(ra, dec, margin=0.0):
        if r["detector"] != det or abs(r["mjd"] - mjd) < min_dt_days:
            continue
        vid = r["obs_id"].rsplit("_", 1)[0]
        dl = abs(r["approx_lam_um"] - lam) if lam else 0.0
        if vid not in best or dl < best[vid][0]:
            best[vid] = (dl, r)
    return [r for _, r in sorted(best.values(), key=lambda t: t[0])[:n]]


# ------------------------------------------------------------------------------------------ one exposure
def aperture_sum(a, x, y, r, sub=5):
    """Sum of a over a circle (sub-pixel weights), and the area in pixels."""
    ny, nx = a.shape
    x0, x1 = max(0, int(x - r - 1)), min(nx, int(x + r + 2))
    y0, y1 = max(0, int(y - r - 1)), min(ny, int(y + r + 2))
    if not (np.isfinite(x) and np.isfinite(y)) or x0 >= x1 or y0 >= y1:
        return np.nan, 0.0
    yy, xx = np.mgrid[y0:y1, x0:x1]
    o = (np.arange(sub) + 0.5) / sub - 0.5
    w = np.zeros(xx.shape)
    for dy in o:
        for dx in o:
            w += ((xx + dx - x) ** 2 + (yy + dy - y) ** 2) <= r * r
    w /= sub * sub
    sl = a[y0:y1, x0:x1]
    good = np.isfinite(sl)
    if (w * ~good).sum() > 0.1 * w.sum():
        return np.nan, w.sum()
    return float((np.where(good, sl, 0) * w).sum() * w.sum() / max(1e-9, (w * good).sum())), float(w.sum())


def empty_aperture_scatter(D, xc, yc, r, rmin=10.0, n=40, seed=0):
    rng = np.random.default_rng(seed)
    ny, nx = D.shape
    sums = []
    tries = 0
    while len(sums) < n and tries < 400:
        tries += 1
        x, y = rng.uniform(r + 1, nx - r - 2), rng.uniform(r + 1, ny - r - 2)
        if math.hypot(x - xc, y - yc) < rmin:
            continue
        s, _ = aperture_sum(D, x, y, r)
        if np.isfinite(s):
            sums.append(s)
    if len(sums) < 8:
        return float("nan")
    s = np.array(sums)
    return float(1.4826 * np.median(np.abs(s - np.median(s))))


def process_exposure(pdes, rows, hit):
    """Box, references, difference, position and photometry of one exposure. Cached npz + dict."""
    out_dir = RUNS / safe(pdes)
    stem = safe(hit["obs_id"]) + f"_D{hit['det']}"
    p_json = out_dir / f"{stem}.json"
    if p_json.exists():
        return json.loads(p_json.read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    exp = S3.exposure(hit["key"])
    c = comet_at(rows, exp.mjd, exp.sc_km)
    x, y = exp.world2pix(c["ra"], c["dec"])
    x, y = float(x[0]), float(y[0])
    res = dict(key=hit["key"], obs_id=hit["obs_id"], det=hit["det"], mjd=exp.mjd, pred=c, x=x, y=y)
    if not (EDGE <= x <= S3.NPIX - 1 - EDGE and EDGE <= y <= S3.NPIX - 1 - EDGE):
        res["skip"] = "too close to the detector edge"
        p_json.write_text(json.dumps(res))
        return res
    lam = exp.wavelength(x, y)
    res["lam_um"] = None if lam is None else float(np.atleast_1d(lam)[0])
    xc, yc = int(round(x)), int(round(y))
    T, origin = A.target_box(exp, xc, yc, HALF)
    V = exp.box("VARIANCE", xc - VHALF, yc - VHALF, xc + VHALF, yc + VHALF).astype(float)
    # references: the comet must have moved at least the box diagonal + 2' away
    rate = math.hypot(c["rate_ra"], c["rate_dec"])          # arcsec/h
    need_as = 1.5 * HALF * PIX * 2 + 120
    min_dt = max(0.5, need_as / max(rate, 1e-3) / 24.0)
    refs = pick_refs(c["ra"], c["dec"], hit["det"], exp.mjd, res["lam_um"], min_dt)
    Rs, ref_keys = [], []
    bT, sT = A.robust_bg(T)
    T = T - bT
    for r in refs:
        try:
            a = A.resample_ref(S3.exposure(r["s3_key"]), exp, origin, T.shape)
        except Exception as ex:          # missing file etc.
            log("  ref failed", r["s3_key"], type(ex).__name__)
            continue
        if a is not None and np.isfinite(a).mean() > 0.7:
            b, _ = A.robust_bg(a)
            Rs.append(A.register(T, a - b, sT))
            ref_keys.append(r["s3_key"])
    res["ref_keys"] = ref_keys
    res["min_ref_dt_days"] = min_dt
    R = (np.nanmedian(np.stack(Rs), 0) if len(Rs) >= 3 else np.nanmean(np.stack(Rs), 0)) if Rs else None
    res["psf_fwhm_arcsec"] = exp.psf_fwhm_arcsec
    np.savez_compressed(out_dir / f"{stem}.npz", T=T.astype(np.float32),
                        R=(R if R is not None else np.full_like(T, np.nan)).astype(np.float32),
                        V=V.astype(np.float32), origin=np.array(origin), vorigin=np.array([xc - VHALF, yc - VHALF]))
    measure(res, exp, np.load(out_dir / f"{stem}.npz"))
    p_json.write_text(json.dumps(A._jsonable(res)))
    return res


def despike(D, T, px, py, s, r=6, k=6.0, ratio=6.0):
    """Single-pixel spikes (cosmic rays, hot pixels) within r px of the comet: a pixel more than k sigma
    above the median of its 8 neighbours and more than `ratio` x the mean of its 4 side neighbours (the SPHEREx PSF puts at
    most ~4 x the side-neighbour mean in the centre pixel of a perfectly centred point source) is replaced by that
    median. Returns (cleaned D, number replaced)."""
    D = D.copy()
    n = 0
    ny, nx = D.shape
    for y in range(max(1, int(py - r)), min(ny - 1, int(py + r) + 1)):
        for x in range(max(1, int(px - r)), min(nx - 1, int(px + r) + 1)):
            if (x - px) ** 2 + (y - py) ** 2 > r * r or not np.isfinite(D[y, x]):
                continue
            nb = np.concatenate([D[y - 1, x - 1:x + 2], D[y + 1, x - 1:x + 2], D[y, [x - 1, x + 1]]])
            nb = nb[np.isfinite(nb)]
            if nb.size < 6:
                continue
            side = np.array([D[y - 1, x], D[y + 1, x], D[y, x - 1], D[y, x + 1]])
            m = np.median(nb)
            if D[y, x] - m > k * s and D[y, x] > ratio * max(np.nanmean(side), s):
                D[y, x] = m
                n += 1
    return D, n


def deblob(D, px, py, s, r_in=1.5, r_out=6.0, k=8.0, ratio=3.0):
    """Compact non-stellar hits next to the comet (cosmic-ray tracks, hot-pixel pairs that survive the
    reference subtraction): pixels between r_in and r_out px from the comet more than `ratio` x the
    azimuthal median of D at their radius plus k sigma are replaced by that median. A coma or tail
    changes slowly with angle at a fixed radius and stays far below this threshold."""
    D = D.copy()
    yy, xx = np.mgrid[0:D.shape[0], 0:D.shape[1]]
    rr = np.hypot(xx - px, yy - py)
    n = 0
    for a in np.arange(r_in, r_out, 0.5):
        m = (rr >= a) & (rr < a + 0.5) & np.isfinite(D)
        if m.sum() < 6:
            continue
        med = float(np.median(D[m]))
        bad = m & (D > ratio * max(med, 0) + k * s)
        n += int(bad.sum())
        D[bad] = med
    return D, n


def measure(res, exp, z, search_px=2.5):
    """Position (EPSF fit near the prediction) and aperture photometry from the cached boxes."""
    T, R, V = z["T"].astype(float), z["R"].astype(float), z["V"].astype(float)
    origin, vorigin = z["origin"], z["vorigin"]
    have_ref = np.isfinite(R).any()
    D = T - R if have_ref else T.copy()
    yy, xx = np.mgrid[0:D.shape[0], 0:D.shape[1]]
    px, py = res["x"] - origin[0], res["y"] - origin[1]
    far = ((xx - px) ** 2 + (yy - py) ** 2 > 18 ** 2) & np.isfinite(D)
    bg = float(np.median(D[far])) if far.sum() > 50 else 0.0
    D = D - bg
    _, s = A.robust_bg(D)
    res["noise"], res["bg_far"], res["n_ref"] = s, bg, len(res.get("ref_keys", []))
    D, res["n_spikes"] = despike(D, T, px, py, s)
    D, res["n_blob_px"] = deblob(D, px, py, s)
    Sm = gaussian_filter(np.nan_to_num(D), 1.0)
    near = (xx - px) ** 2 + (yy - py) ** 2 <= search_px ** 2
    j = np.argmax(np.where(near, Sm, -np.inf))
    sx, sy = float(xx.flat[j]), float(yy.flat[j])
    psf = A.PSF(exp, res["x"], res["y"])
    var = s * s * np.ones_like(D)
    if have_ref:
        var = var + (A.MODEL_C * np.clip(np.nan_to_num(R), 0, None)) ** 2
    res.pop("fit", None)
    f = A.fit_psf(D, var, psf, sx, sy)
    c = res["pred"]
    if f is not None and not f["at_bound"] and f["flux"] > 0:
        rr, dd = exp.pix2world(origin[0] + f["x"], origin[1] + f["y"])
        e_, n_ = offset_arcsec(float(rr[0]), float(dd[0]), c["ra"], c["dec"])
        res["fit"] = dict(x=float(origin[0] + f["x"]), y=float(origin[1] + f["y"]), ra=float(rr[0]), dec=float(dd[0]),
                          snr_psf=f["snr"], ex=f["ex"], ey=f["ey"], chi2r=f["chi2r"], off_e=e_, off_n=n_,
                          off=math.hypot(e_, n_))
    ph = {}
    for centre in ("ephemeris", "fit"):
        if centre == "fit" and "fit" not in res:
            continue
        ax, ay = (px, py) if centre == "ephemeris" else (res["fit"]["x"] - origin[0], res["fit"]["y"] - origin[1])
        for rap in (R_AP, R_AP2):
            fl, area = aperture_sum(D, ax, ay, rap)
            sc = empty_aperture_scatter(D, ax, ay, rap)
            vs, _ = aperture_sum(V, origin[0] + ax - vorigin[0], origin[1] + ay - vorigin[1], rap)
            err = math.sqrt((sc if np.isfinite(sc) else 0) ** 2 + (max(vs, 0) if np.isfinite(vs) else 0))
            ph[f"{centre}_r{rap:g}"] = dict(flux_ujy=fl * BL.PIXEL_UJY, err_ujy=err * BL.PIXEL_UJY, area_px=area,
                                            snr=fl / err if err > 0 else None)
    res["phot"] = ph
    res["psf_kind"] = psf.kind
    return D


# ------------------------------------------------------------------------------------------ run
def hits_for(pdes):
    summ = json.loads((CACHE / "precise_summary.json").read_text())
    return summ[pdes]


def choose_hits(hits, n_max, t_max=None):
    """Up to n_max exposures: brightest predicted first, spread over the seasons/visits."""
    h = [x for x in hits if x.get("T") is None or t_max is None or x["T"] <= t_max]
    h.sort(key=lambda x: (x["T"] if x["T"] is not None else 99))
    if len(h) <= n_max:
        return sorted(h, key=lambda x: x["mjd"])
    # keep the brightest third, then every k-th of the rest in time order
    keep = h[:n_max // 2]
    rest = sorted(h[n_max // 2:], key=lambda x: x["mjd"])
    k = max(1, len(rest) // (n_max - len(keep)))
    keep += rest[::k][:n_max - len(keep)]
    return sorted(keep, key=lambda x: x["mjd"])


def run(pdes, n_max=60, t_max=None, only_mjd=None):
    info = hits_for(pdes)
    rows = CS.horizons_grid(pdes if pdes != "pluto" else "pluto")
    hits = info["hits"]
    if only_mjd:
        hits = [h for h in hits if only_mjd[0] <= h["mjd"] <= only_mjd[1]]
    sel = choose_hits(hits, n_max, t_max)
    log(f"{pdes}: {len(sel)} of {len(hits)} exposures")
    out = []
    for i, h in enumerate(sel):
        try:
            r = process_exposure(pdes, rows, h)
        except SystemExit:
            raise
        except Exception as ex:
            log(f"  {h['obs_id']} D{h['det']} failed: {type(ex).__name__}: {ex}")
            continue
        out.append(r)
        if (i + 1) % 5 == 0 or i == len(sel) - 1:
            L = ledger_flush(f"{pdes} {i + 1}/{len(sel)}")
            f = r.get("fit") or {}
            log(f"  {i + 1}/{len(sel)} {h['obs_id']} T={h.get('T')} snr={f.get('snr', float('nan')):.1f} "
                f"off={f.get('off', float('nan')):.1f}\" S3 total {L['s3_bytes'] / 1e6:.1f} MB")
    return out


def hit_lambda(h):
    """Approximate wavelength (um) of the comet position in a hit image, from the static sky index."""
    for r in SI.find_images(h["ra"], h["dec"], margin=0.0):
        if r["obs_id"] == h["obs_id"] and r["detector"] == h["det"]:
            return r["approx_lam_um"]
    return None


def fill_windows(pdes, windows, mjd_range, n_per_window=4):
    """Add exposures whose wavelength at the comet falls in the given windows (um), within mjd_range
    (the season of the spectrum), so that a feature is tested with more than one image."""
    rows = CS.horizons_grid(pdes)
    hits = [h for h in hits_for(pdes)["hits"] if mjd_range[0] <= h["mjd"] <= mjd_range[1]]
    done = {p.stem for p in (RUNS / safe(pdes)).glob("*.json")}
    out = []
    for lo, hi in windows:
        cand = []
        for h in hits:
            if safe(h["obs_id"]) + f"_D{h['det']}" in done:
                continue
            lam = hit_lambda(h)
            if lam is not None and lo <= lam <= hi:
                cand.append((h.get("T") or 99, h, lam))
        cand.sort(key=lambda c: c[0])
        log(f"{pdes}: window {lo}-{hi} um: {len(cand)} new exposures, reading {min(len(cand), n_per_window)}")
        for _, h, lam in cand[:n_per_window]:
            try:
                out.append(process_exposure(pdes, rows, h))
                done.add(safe(h["obs_id"]) + f"_D{h['det']}")
            except SystemExit:
                raise
            except Exception as ex:
                log(f"  {h['obs_id']} D{h['det']} failed: {type(ex).__name__}: {ex}")
        ledger_flush(f"{pdes} fill {lo}-{hi}")
    return out
