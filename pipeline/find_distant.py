"""Distant-body ("Planet X") search in full-row strips of SPHEREx Level 2 images (public S3, byte ranges only).

  python pipeline/find_distant.py plan                      field plan on the Brown & Batygin (2021) median orbit (static sky index)
  python pipeline/find_distant.py fetch [--fields F3-perihelion,...] [--cap-mb 840]
  python pipeline/find_distant.py search --field F4-nu-75 [--n-rand 2000] [--out cache/planetx/results]
  python pipeline/find_distant.py inject --field F4-nu-75 --dists 350,500 --mags 19,19.4,19.7,20,20.3 [--nbody 12] [--sed solar|flat]
  python pipeline/find_distant.py limits <dir> [<dir> ...]  50 % / 90 % magnitudes from the injection results

Why strips: the detector rows of SPHEREx run along ecliptic longitude within a few degrees, which is the direction of
the yearly parallax. A strip of 110 rows x all 2040 columns (0.19 x 3.5 deg) of EVERY exposure of a point therefore
holds the whole track of a body at 150-1500 AU, at 0.9 MB per exposure instead of 71 MB for the file. Only the IMAGE
layer is read: background = block median, noise = c0 + c1 * IMAGE (per detector, fitted on cutouts that have the
real VARIANCE layer), bad pixels = isolated spikes + comparison of the exposures of one visit (in the detector).
The search itself is pipeline/detect/distant.py (v3b) with a rectangular grid turned to the detector rows and the
template built from every other season. Method, numbers and limits: pipeline/PLANETX.md.

Environment: uv run --no-project --with astropy --with reproject --with numpy --with scipy --with pillow python pipeline/find_distant.py ...
(reproject is needed by `inject` only, through detect/inject.py -> blink.py)
Data: cache/planetx/ (plan_prereg.json, ledger.json = every byte read, strips/<field>/*_strip.fits, results/).
"""
import argparse
import glob
import http.client
import json
import math
import os
import sys
import threading
import time
import urllib.error
import warnings
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates, spline_filter

HERE = Path(__file__).resolve().parent
REPO = Path(os.environ.get("FAZARI_REPO") or HERE.parent)
sys.path.insert(0, str(REPO / "pipeline"))

PX = REPO / "cache" / "planetx"
PLAN = PX / "plan_prereg.json"
LEDGER = PX / "ledger.json"
EPSF_DIR = REPO / "cache" / "local" / "epsf"

# ----------------------------------------------------------------------------------------------- 1. field plan
OBLIQUITY = math.radians(23.4392911)
EPS = OBLIQUITY
# Brown & Batygin 2021 (AJ 162, 219), uniform prior, medians; e from q = 300 AU
A, E, INC, NODE, VARPI = 380.0, 1 - 300.0 / 380.0, 15.6, 96.9, 246.7
OM = (VARPI - NODE) % 360
MIN_SEASON, MIN_GOOD, NROWS = 20, 45, 110
PLAN_RULE = ("nu = 180 (aphelion), the point at RA = 45 deg (BB21: density peak), nu = 0 (perihelion), nu = -75, nu = +75; "
             "a point must have |b| >= 20 deg and >= 3 seasons with >= 45 D1-D3 exposures in the index; if not, nu moves away "
             "from perihelion in 5 deg steps until it does. Exposures: all D1-D3 images of the index covering the point "
             "(DR1 preferred over QR3 for the same obs), in seasons (gap > 30 d) with >= 20 such exposures.")


def orbit_point(nu_deg, a=A, e=E, inc=INC, node=NODE, om=OM):
    u = math.radians(om + nu_deg)
    i, O = math.radians(inc), math.radians(node)
    r = a * (1 - e * e) / (1 + e * math.cos(math.radians(nu_deg)))
    x = math.cos(O) * math.cos(u) - math.sin(O) * math.sin(u) * math.cos(i)
    y = math.sin(O) * math.cos(u) + math.cos(O) * math.sin(u) * math.cos(i)
    z = math.sin(u) * math.sin(i)
    lon, lat = math.degrees(math.atan2(y, x)) % 360, math.degrees(math.asin(z))
    xe, ye, ze = x, y * math.cos(EPS) - z * math.sin(EPS), y * math.sin(EPS) + z * math.cos(EPS)
    ra, dec = math.degrees(math.atan2(ye, xe)) % 360, math.degrees(math.asin(ze))
    return dict(nu=nu_deg, r_au=r, lon=lon, lat=lat, ra=ra, dec=dec)


def galactic(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    v = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
    R = np.array([[-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
                  [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
                  [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669]])
    g = R @ v
    return math.degrees(math.atan2(g[1], g[0])) % 360, math.degrees(math.asin(g[2]))


def index_rows(ra, dec):
    import sky_index as SI
    rows = SI.find_images(ra, dec)
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
    return rows


def usable(p):
    rows = [r for r in index_rows(p["ra"], p["dec"]) if r["detector"] <= 3]
    seas = {}
    for r in rows:
        seas.setdefault(r["season_i"], []).append(r)
    seas = [v for k, v in sorted(seas.items()) if len(v) >= MIN_SEASON]
    good = sum(1 for v in seas if len(v) >= MIN_GOOD)
    return seas, good


def nu_at_ra(ra_t):
    lo, hi = 150.0, 165.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if orbit_point(mid)["ra"] < ra_t:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)

def cmd_plan(a):
    """Field plan -> cache/planetx/plan_prereg.json (never overwritten: the plan is the pre-registration)."""
    import sky_index as SI
    wanted = [("F1-aphelion", 180.0, +5), ("F2-ra45", nu_at_ra(45.0), +5), ("F3-perihelion", 0.0, +5),
              ("F4-nu-75", -75.0, -5), ("F5-nu+75", 75.0, +5)]
    fields = []
    for name, nu, step in wanted:
        nu0 = nu
        while True:
            p = orbit_point(nu)
            l, b = galactic(p["ra"], p["dec"])
            seas, good = usable(p)
            if abs(b) >= 20 and good >= 3:
                break
            print(f"  {name}: nu {nu:.1f} rejected (|b| {abs(b):.1f}, seasons with >= {MIN_GOOD}: {good})")
            nu += step
        ex = []
        for si, v in enumerate(seas):
            for r in v:
                c, e, n = SI.tangent_basis(np.float64(r["ra_center"]), np.float64(r["dec_center"]))
                px, py, _ = SI.project(SI.unit(np.float64(p["ra"]), np.float64(p["dec"])), c, e, n)
                cx, cy = zip(*[SI.project(SI.unit(np.float64(aa), np.float64(dd)), c, e, n)[:2] for aa, dd in r["corners"]])
                uu, vv = SI.quad_uv(float(px), float(py), [float(q) for q in cx], [float(q) for q in cy])
                ex.append(dict(s3_key=r["s3_key"], obs_id=r["obs_id"], collection=r["collection"], detector=r["detector"],
                               mjd=r["mjd"], approx_lam_um=r["approx_lam_um"], season_i=si, x_det=round(uu * 2040, 1), y_det=round(vv * 2040, 1)))
        fields.append(dict(name=name, nu_deg=round(nu, 2), nu_first_choice=round(nu0, 2), r_au=round(p["r_au"], 1), ra=round(p["ra"], 5),
                           dec=round(p["dec"], 5), ecl_lon=round(p["lon"], 3), ecl_lat=round(p["lat"], 3), gal_l=round(l, 2), gal_b=round(b, 2),
                           n_rows=NROWS, seasons=[dict(mjd=[v[0]["mjd"], v[-1]["mjd"]], n=len(v)) for v in seas], exposures=ex))
        print(f"{name}: nu {nu:.2f} r {p['r_au']:.0f} AU RA {p['ra']:.4f} Dec {p['dec']:.4f} (ecl {p['lon']:.1f}, {p['lat']:.1f}; gal b {b:.1f}) "
              f"{len(ex)} exposures in {len(seas)} seasons {[len(v) for v in seas]}; est. {len(ex) * (NROWS * 8160 + 28800) / 1e6:.0f} MB")
    plan = dict(made=time.strftime("%Y-%m-%d %H:%M:%S %z"), source="Brown & Batygin 2021 (AJ 162, 219), uniform-prior medians",
                orbit=dict(a_au=A, e=round(E, 4), q_au=300.0, inc_deg=INC, node_deg=NODE, varpi_deg=VARPI), rule=PLAN_RULE, fields=fields,
                est_total_mb=round(sum(len(f["exposures"]) for f in fields) * (NROWS * 8160 + 28800) / 1e6, 1))
    out = Path(a.out) if a.out else PLAN
    if out.exists():
        sys.exit(f"{out} exists: not overwritten (the plan is the pre-registration; give --out for a new one)")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, indent=1))
    print("total exposures", sum(len(f["exposures"]) for f in fields), "est. MB", plan["est_total_mb"], "->", out)


# ----------------------------------------------------------------------------------------------- 2. strips from S3
FETCH_ORDER = ["F3-perihelion", "F4-nu-75", "F5-nu+75", "F1-aphelion", "F2-ra45"]
_lock = threading.Lock()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def ledger_load():
    if LEDGER.exists():
        return json.loads(LEDGER.read_text())
    return {"budget_bytes": 1_000_000_000, "total_bytes": 0, "requests": 0, "entries": []}


def ledger_add(field, key, what, nbytes, nreq):
    with _lock:
        L = ledger_load()
        L["entries"].append({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "field": field, "key": key, "what": what,
                             "bytes": int(nbytes), "requests": int(nreq)})
        L["total_bytes"] = int(sum(e["bytes"] for e in L["entries"]))
        L["requests"] = int(sum(e["requests"] for e in L["entries"]))
        tmp = LEDGER.with_suffix(".json.part")
        tmp.write_text(json.dumps(L, indent=0))
        os.replace(tmp, LEDGER)
        return L["total_bytes"]


def is_network_error(ex):
    if isinstance(ex, urllib.error.HTTPError):
        return ex.code not in (403, 404)
    if isinstance(ex, IOError) and any(k in str(ex) for k in ("no END card", "not a FITS file", "expected an extension header")):
        return False                       # the bytes arrived but are not what a Level 2 file holds
    return isinstance(ex, (urllib.error.URLError, TimeoutError, ConnectionError, OSError, http.client.HTTPException, IOError))


def strip_path(field, key):
    return PX / "strips" / field / (Path(key).name[:-5] + "_strip.fits")


def fetch_one(field, ex, n_rows):
    """One exposure -> strip file. Returns (status, bytes from the network)."""
    out = strip_path(field["name"], ex["s3_key"])
    if out.exists():
        return "cached", 0
    import fetch_region as FR
    st = FR.Stats()
    f = FR.S3File(ex["s3_key"], PX / "s3", st)
    wait = 30.0
    while True:
        try:
            f.read(0, FR.BLOCK + 25920)
            prim = FR.read_header(f, 0, FR.BLOCK, 0)
            img = FR.read_header(f, prim.next_off, FR.BLOCK + 25920 - prim.next_off, 1)
            if img.name != "IMAGE":
                ledger_add(field["name"], ex["s3_key"], "header (unexpected HDU)", st.bytes_net, st.requests)
                return f"unexpected HDU {img.name}", st.bytes_net
            hd = img.header
            wcs = FR.celestial_wcs(hd)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                x, y = (float(v) for v in wcs.all_world2pix(field["ra"], field["dec"], 0))
            nxp, nyp = int(hd["NAXIS1"]), int(hd["NAXIS2"])
            iy = int(round(y))
            if not (-0.5 <= x < nxp - 0.5 and 0 <= iy < nyp):
                ledger_add(field["name"], ex["s3_key"], "header (target outside image)", st.bytes_net, st.requests)
                return "target outside the image", st.bytes_net
            y1 = min(nyp - 1, max(0, iy - n_rows // 2) + n_rows - 1)
            y0 = max(0, y1 - n_rows + 1)
            raw = f.read(img.data_off + y0 * nxp * 4, img.data_off + (y1 + 1) * nxp * 4)
            arr = np.frombuffer(raw, ">f4").reshape(y1 - y0 + 1, nxp)
            break
        except Exception as e:                                    # noqa: BLE001
            if not is_network_error(e):
                ledger_add(field["name"], ex["s3_key"], f"failed: {type(e).__name__}", st.bytes_net, st.requests)
                return f"missing on S3 or unreadable ({type(e).__name__}: {str(e)[:80]})", st.bytes_net
            log(f"   network problem on {Path(ex['s3_key']).name[:40]} ({type(e).__name__}: {str(e)[:60]}); waiting {wait:.0f} s, will retry")
            time.sleep(wait)
            wait = min(wait * 1.5, 300.0)
    h_img = FR.shift_header(FR.image_header(img), 0, y0, nxp, y1 - y0 + 1)
    ph = prim.header.copy()
    ph["FZSRCKEY"] = (ex["s3_key"], "S3 key of the full image")
    ph["FZY0"] = (y0, "0-based full-image row of strip row 0")
    ph["FZXT"] = (round(x, 3), "target column (0-based, full image)")
    ph["FZYT"] = (round(y, 3), "target row (0-based, full image)")
    ph["FZRA"], ph["FZDEC"] = (field["ra"], "field centre RA [deg]"), (field["dec"], "field centre Dec [deg]")
    ph["FZLAM"] = (float(ex.get("approx_lam_um") or 0.0), "wavelength at the target from the sky index [um]")
    ph["FZSEAS"] = (int(ex["season_i"]), "season index in the plan")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".part")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fits.HDUList([fits.PrimaryHDU(header=ph), fits.ImageHDU(arr.astype(">f4"), h_img)]).writeto(tmp, overwrite=True)
    os.replace(tmp, out)
    ledger_add(field["name"], ex["s3_key"], "strip", st.bytes_net, st.requests)
    return "fetched", st.bytes_net

def cmd_fetch(a):
    """Read the strips of the plan (<= 4 requests in flight, every byte in the ledger, restartable)."""
    plan = json.loads(PLAN.read_text())
    byname = {f["name"]: f for f in plan["fields"]}
    cap = a.cap_mb * 1e6
    for name in a.fields.split(","):
        field = byname[name]
        n_rows = int(field["n_rows"])
        exs = sorted(field["exposures"], key=lambda e: e["mjd"])
        if a.limit:
            exs = exs[:a.limit]
        todo = [e for e in exs if not strip_path(name, e["s3_key"]).exists()]
        est = len(todo) * (n_rows * 8160 + 28800)
        tot = ledger_load()["total_bytes"]
        log(f"{name}: {len(exs)} exposures, {len(todo)} to read, est. {est / 1e6:.0f} MB; ledger {tot / 1e6:.1f} MB, cap {cap / 1e6:.0f} MB")
        if tot + est > cap:
            log(f"{name}: NOT started (would exceed the cap); stopping here")
            break
        t0 = time.time()
        res = {}
        with ThreadPoolExecutor(4) as pool:
            for e, (status, nb) in zip(todo, pool.map(lambda q: fetch_one(field, q, n_rows), todo)):
                res[e["s3_key"]] = status
        bad = {k: v for k, v in res.items() if v not in ("fetched", "cached")}
        nf = sum(1 for e in exs if strip_path(name, e["s3_key"]).exists())
        if todo:
            info = {"field": name, "n_plan": len(exs), "n_strips": nf, "not_read": bad, "seconds": round(time.time() - t0, 1),
                    "ledger_total_bytes": ledger_load()["total_bytes"], "finished": time.strftime("%Y-%m-%d %H:%M:%S")}
            (PX / "strips" / name).mkdir(parents=True, exist_ok=True)
            (PX / "strips" / name / "fetch.json").write_text(json.dumps(info, indent=1))
        log(f"{name}: DONE {nf}/{len(exs)} strips, {len(bad)} not read {sorted(set(bad.values()))}, ledger {ledger_load()['total_bytes'] / 1e6:.1f} MB")
    log("FETCH END")


# ----------------------------------------------------------------------------------------------- 3. strips -> exposures
SPIKE_Z = 12.0               # isolated spike: > SPIKE_Z sigma ...
SPIKE_WING = 0.2             # ... with no PSF wing in the four neighbours (max neighbour < SPIKE_WING x value - 3 sigma)
SAT_PROXY = 50.0             # MJy/sr above the background: bright cores, kept out like saturated pixels
STRIP_BG_BLOCK = 16          # native px: block-median background of a strip
GRID_W_MAX_DEG, GRID_H_DEG = 4.2, 0.21
EPOCH_GAP = 30.0
# variance model VARIANCE = c0 + c1 * IMAGE per detector (fitted on cutouts with the real VARIANCE layer; within 5-15 %)
VAR_MODEL = {1: {'c0': 4.094835886861824e-05, 'c1': 0.0012055206163680014}, 2: {'c0': 2.0128031861243547e-05, 'c1': 0.0011368558360223418}, 3: {'c0': 2.6807353171647098e-05, 'c1': 0.0011196843831202796}, 4: {'c0': 1.778059223082407e-05, 'c1': 0.0009420494306866476}, 5: {'c0': 0.0003031256604919474, 'c1': 0.0034613474238456296}, 6: {'c0': 0.00048729818036289204, 'c1': 0.004670250973008446}}
_epsf_cache = {}


def _strip_background(raw, b=STRIP_BG_BLOCK):
    ny, nx = raw.shape
    my, mx = int(math.ceil(ny / b)), int(math.ceil(nx / b))
    pad = np.full((my * b, mx * b), np.nan, np.float32)
    pad[:ny, :nx] = raw
    blk = pad.reshape(my, b, mx, b).transpose(0, 2, 1, 3).reshape(my, mx, b * b)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(blk, axis=2)
    if not np.isfinite(med).any():
        return np.zeros_like(raw)
    med = np.where(np.isfinite(med), med, np.nanmedian(med))
    Y, X = np.meshgrid((np.arange(ny) + 0.5) / b - 0.5, (np.arange(nx) + 0.5) / b - 0.5, indexing="ij")
    return map_coordinates(med.astype(np.float64), [Y, X], order=1, mode="nearest").astype(np.float32)


def _epsf(hd):
    cid = None
    for card in hd.get("HISTORY", []):
        s = str(card)
        if "[CALIB] epsf" in s:
            cid = s.split()[-1]
    det = int(hd["DETECTOR"])
    key = cid if cid and (EPSF_DIR / f"{cid}.fits").exists() else None
    if key is None:                       # unknown calibration id: any table of the same detector
        for p in sorted(EPSF_DIR.glob("*.fits")):
            if int(fits.getheader(p, "EPSF").get("DETECTOR", -1)) == det:
                key = p.stem
                break
    if key is None:
        return None
    if key not in _epsf_cache:
        with fits.open(EPSF_DIR / f"{key}.fits", memmap=False) as h:
            t = h["EPSF"].data
            ovs = int(h["EPSF"].header.get("OVSMPX", 5))
            _epsf_cache[key] = dict(x=np.asarray(t["XCENTER"], float), y=np.asarray(t["YCENTER"], float), ovs=ovs,
                                    psf=[spline_filter(np.asarray(q, float), order=3) for q in t["EPSF"]], exact=key == cid)
    return _epsf_cache[key]


def ecliptic_east_pa(ra, dec):
    """Position angle (east of north, deg) of the direction of increasing ecliptic longitude."""
    a, d = math.radians(ra), math.radians(dec)
    r = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
    k = np.array([0.0, -math.sin(OBLIQUITY), math.cos(OBLIQUITY)])
    v = np.cross(k, r)
    e = np.array([-math.sin(a), math.cos(a), 0.0])
    n = np.array([-math.sin(d) * math.cos(a), -math.sin(d) * math.sin(a), math.cos(d)])
    return math.degrees(math.atan2(v @ e, v @ n)) % 360


def read_strip(p, vm):
    with fits.open(p, memmap=False) as h:
        ph, hd = h[0].header, h[1].header
        raw = h[1].data.astype(np.float32)
    det = int(hd["DETECTOR"])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wcs = WCS(hd, relax=True)
    mjd = float(hd.get("MJD-AVG", hd["MJD-OBS"]))
    ny, nx = raw.shape
    y0 = int(ph["FZY0"])
    fin = np.isfinite(raw)
    if det == 3:                                       # filter seam of D3 (detector rows 140/141, 1-based)
        j0, j1 = 136 - y0, 144 - y0
        if j1 >= 0 and j0 < ny:
            fin[max(j0, 0):min(j1 + 1, ny)] = False
    bg = _strip_background(np.where(fin, raw, np.nan))
    clean = np.where(fin, raw - bg, np.nan).astype(np.float32)
    c = vm[det]
    var = (c["c0"] + c["c1"] * np.clip(np.where(fin, raw, 0.0), 0, None)).astype(np.float32)
    sig = float(np.sqrt(np.median(var[fin]))) if fin.any() else 1.0
    v = np.where(fin, clean, 0.0)
    nb = np.full(v.shape, -np.inf, np.float32)
    nb[1:] = np.maximum(nb[1:], v[:-1])
    nb[:-1] = np.maximum(nb[:-1], v[1:])
    nb[:, 1:] = np.maximum(nb[:, 1:], v[:, :-1])
    nb[:, :-1] = np.maximum(nb[:, :-1], v[:, 1:])
    spike = fin & (v > SPIKE_Z * sig) & (nb < SPIKE_WING * v - 3 * sig)
    neg = fin & (v < -SPIKE_Z * sig)
    bright = fin & (v > SAT_PROXY) & ~spike
    good = fin & ~spike & ~neg & ~bright
    if good.sum() < 0.3 * good.size:
        return None
    clean = clean - np.float32(np.nanmedian(clean[good]))
    pa_x = math.degrees(math.atan2(hd["PC1_1"] * hd.get("CDELT1", 1.0), hd["PC2_1"] * hd.get("CDELT2", 1.0))) % 360
    e = dict(file=p.name, path=p, mjd=mjd, mjd_t=mjd, jyear=float(Time(mjd, format="mjd").jyear), date=Time(mjd, format="mjd").iso[:10],
             detector=f"D{det}", det=det, orient_deg=math.degrees(math.atan2(hd["PC2_1"], hd["PC1_1"])) % 360, pa_x=pa_x,
             wavelength_um=float(ph["FZLAM"]), y0=y0, x_target=float(ph["FZXT"]), y_target=float(ph["FZYT"]) - y0, shape=(ny, nx),
             n_spike=int(spike.sum() + neg.sum()), n_bright=int(bright.sum()), noise=sig)
    e["_px"] = dict(clean=clean, var=np.where(good, var, np.inf).astype(np.float32), good=good, satnan=(~fin) | bright, wcs=wcs,
                    noflags=True)
    ep = _epsf(hd)
    if ep is not None:
        keep = np.abs(ep["y"] - (y0 + ny / 2)) < 170
        ii = np.nonzero(keep)[0]
        e["_px"]["ovs"] = ep["ovs"]
        e["_px"]["_inj_psf"] = (ep["x"][ii], ep["y"][ii] - y0, [ep["psf"][k] for k in ii])
        e["epsf_exact"] = ep["exact"]
    e["_gain_slope"] = float(c["c1"])
    return e


def load_strips(name, log=print):
    """(field, exposures, grid spec) of a strip field of the plan."""
    plan = json.loads(PLAN.read_text())
    f = next(q for q in plan["fields"] if q["name"] == name)
    vm = VAR_MODEL
    exps = []
    for p in sorted((PX / "strips" / name).glob("*_strip.fits")):
        e = read_strip(p, vm)
        if e is not None:
            exps.append(e)
    exps.sort(key=lambda e: (e["mjd"], e["det"]))
    # seasons: gap > 30 d, label YYYY-MM of the median date
    groups, cur = [], [exps[0]]
    for e in exps[1:]:
        if e["mjd"] - cur[-1]["mjd"] > EPOCH_GAP:
            groups.append(cur)
            cur = []
        cur.append(e)
    groups.append(cur)
    for gq in groups:
        lab = Time(float(np.median([e["mjd"] for e in gq])), format="mjd").datetime.strftime("%Y-%m")
        for e in gq:
            e["epoch"] = lab
    # grid along the mean direction of the detector rows (folded to the ecliptic-east side)
    pa0 = ecliptic_east_pa(f["ra"], f["dec"])
    d = np.array([((e["pa_x"] - pa0 + 90) % 180) - 90 for e in exps])
    pa = pa0 + float(np.mean(d))
    # coverage along the strip (arcsec from the target, + = along the grid's xi axis): every exposure covers
    # its 2040 columns; the grid is centred on the stretch where EVERY season keeps >= 40 % of its exposures
    xs = np.arange(-12600.0, 12601.0, 60.0)
    cov = {}
    for e in exps:
        sgn = 1.0 if math.cos(math.radians(e["pa_x"] - pa)) > 0 else -1.0
        lo, hi = sorted((sgn * (0 - e["x_target"]) * 6.15, sgn * (e["shape"][1] - 1 - e["x_target"]) * 6.15))
        cov.setdefault(e["epoch"], np.zeros(len(xs)))
        cov[e["epoch"]] += (xs >= lo) & (xs <= hi)
    rel = np.minimum.reduce([c / max(c.max(), 1) for c in cov.values()])
    ok = np.nonzero(rel >= 0.4)[0]
    x_lo, x_hi = float(xs[ok[0]]), float(xs[ok[-1]])
    xc = 0.5 * (x_lo + x_hi)
    width = min(max(x_hi - x_lo + 240.0, 3600.0), GRID_W_MAX_DEG * 3600)
    # new tangent point: xc arcsec along the strip from the target
    a0, d0 = math.radians(f["ra"]), math.radians(f["dec"])
    nv = np.array([math.cos(d0) * math.cos(a0), math.cos(d0) * math.sin(a0), math.sin(d0)])
    ev = np.array([-math.sin(a0), math.cos(a0), 0.0])
    nov = np.array([-math.sin(d0) * math.cos(a0), -math.sin(d0) * math.sin(a0), math.cos(d0)])
    along = math.sin(math.radians(pa)) * ev + math.cos(math.radians(pa)) * nov
    v = nv + along * (xc / 206264.806)
    v /= np.linalg.norm(v)
    ra_c, dec_c = math.degrees(math.atan2(v[1], v[0])) % 360, math.degrees(math.asin(v[2]))
    pa_c = pa + (ecliptic_east_pa(ra_c, dec_c) - pa0)
    spec = {"width_arcsec": width, "height_arcsec": GRID_H_DEG * 3600, "rot_deg": 90.0 - pa_c}
    field = SimpleNamespace(name=name, label=name, ra=ra_c, dec=dec_c, ra_target=float(f["ra"]), dec_target=float(f["dec"]),
                            centre_shift_arcsec=xc, plan=f, gaia_json=None, out_dir=None, target={})
    log(f"{name}: {len(exps)} strips, seasons {sorted({e['epoch'] for e in exps})}, row direction PA {pa:.2f} deg "
        f"(ecliptic east {pa0:.2f}; spread {d.min():+.2f}..{d.max():+.2f}), spikes/exposure {np.mean([e['n_spike'] for e in exps]):.0f}, "
        f"bright px/exposure {np.mean([e['n_bright'] for e in exps]):.0f}; grid {width / 3600:.2f} x {GRID_H_DEG} deg centred "
        f"{xc / 3600:+.2f} deg along the strip from the target (coverage >= 40 % from {x_lo / 3600:+.2f} to {x_hi / 3600:+.2f} deg)")
    return field, exps, spec


def make_ctx(field, exps, spec, opts=None, log=print):
    o = {"distant_grid": spec, "distant_threads": 3}
    o.update(opts or {})
    return SimpleNamespace(field=field, exps=exps, cal={}, log=log, info={}, shared={}, opts=o, images=None, gaia=None)

def _detector():
    from detect import distant as D
    return D


def _json(o):
    from detect import schema as SC
    return json.dumps(SC._clean(o), indent=1, default=str)


def cmd_search(a):
    """Plain search of one strip field -> <out>/plain_strip_<field>.json (info + candidate records)."""
    D = _detector()
    out = Path(a.out) if a.out else PX / "results"
    out.mkdir(parents=True, exist_ok=True)
    p = out / f"plain_strip_{a.field}.json"
    if p.exists():
        print(f"{p}: exists, skipped")
        return
    field, exps, spec = load_strips(a.field)
    ctx = make_ctx(field, exps, spec, {"no_sso": True, "distant_n_rand": a.n_rand, "distant_template": "all", "distant_threads": a.threads})
    t1 = time.time()
    recs = D.run(ctx)
    dt = time.time() - t1
    res = {"field": "strip:" + a.field, "seconds": round(dt, 1), "version": D.VERSION, "info": ctx.info.get("P"), "records": recs}
    p.write_text(_json(res))
    print(f"{a.field}: {len(recs)} candidates, {sum(r['confirmed'] for r in recs)} confirmed, {dt:.1f} s -> {p}")
    for r in recs:
        ev = r["nature"]["evidence"]
        print(f"   d = {r['distance_au']} +- {r['err_distance_au']} AU, false-link probability {r['confidence']['false_alarm_probability']}, "
              f"confirmed {r['confirmed']}, S/N per season {[q['snr'] for q in ev['positions']]}")


# ----------------------------------------------------------------------------------------------- 5. injection-recovery
# Sun, AB colour relative to V (Willmer 2018, ApJS 236, 47: V 4.80, r 4.65, i 4.53, z 4.50, y 4.50, J 4.54, H 4.66,
# Ks 5.08, W1 5.92, W2 6.59 AB): a grey reflector of visual magnitude V has AB = V + this at each wavelength
SOLAR = [(0.55, 0.00), (0.62, -0.15), (0.75, -0.27), (0.89, -0.30), (0.96, -0.30), (1.25, -0.26), (1.65, -0.14),
         (2.16, 0.28), (3.37, 1.12), (4.62, 1.79), (5.0, 1.95)]


def solar_factor(lam):
    x, y = zip(*SOLAR)
    return 10 ** (-0.4 * float(np.interp(lam, x, y)))


def apparent(r0, v, t0, t, obs):
    r = r0 + v * (t - t0)
    vec = r - obs
    ra = math.degrees(math.atan2(vec[1], vec[0])) % 360
    dec = math.degrees(math.asin(vec[2] / np.linalg.norm(vec)))
    return ra, dec


def _half(g):
    return np.array(g.half, float) if hasattr(g, "half") else np.array([g.n * g.pix / 2] * 2, float)


def _shape(g):
    return (g.ny, g.nx) if hasattr(g, "ny") else (g.n, g.n)


def make_bodies(D, exps, obs, g, d_au, nbody, rng, flux_ujy, margin=45.0, sep=90.0, tries=600, valid=None,
                orbits="iso"):
    """Bodies at distance d_au on random bound orbits, placed so that >= 3 season-mean positions are inside
    the grid (margin arcsec) and on valid pixels. Returns bodies and the acceptance of the draws."""
    seasons = sorted({e["epoch"] for e in exps})
    t0 = float(np.mean([e["jyear"] for e in exps]))
    half = _half(g) - margin
    ny, nx = _shape(g)
    bodies, ndraw, nacc = [], 0, 0
    for _ in range(tries):
        if len(bodies) >= nbody:
            break
        ndraw += 1
        vc = 2 * math.pi / math.sqrt(d_au)
        if orbits == "p9":
            ang = math.radians(rng.uniform(-25, 25))
            dirv = math.cos(ang) * g.ev + math.sin(ang) * g.nov + rng.uniform(-0.3, 0.3) * g.nv
            dirv /= np.linalg.norm(dirv)
            v = dirv * vc * rng.uniform(0.75, 1.2)
        else:
            dirv = rng.normal(size=3)
            dirv /= np.linalg.norm(dirv)
            v = dirv * vc * rng.uniform(0.3, 1.2)

        def track(xi0, eta0):
            u0 = g.nv + g.ev * xi0 / D.RAD + g.nov * eta0 / D.RAD
            u0 /= np.linalg.norm(u0)
            r0 = d_au * u0
            pos = {}
            for s in seasons:
                ii = [i for i, e in enumerate(exps) if e["epoch"] == s]
                P = []
                for i in ii[::max(1, len(ii) // 12)]:
                    ra, dec = apparent(r0, v, t0, exps[i]["jyear"], obs[i])
                    P.append(g.world_to_std(ra, dec))
                P = np.array(P, float)
                pos[s] = (float(P[:, 0].mean()), float(P[:, 1].mean()), float(np.max(np.hypot(*(P - P.mean(0)).T))))
            return r0, pos
        # place the track so that >= 3 seasons fit inside (conditioning on the geometric acceptance, which
        # is measured separately): random subset of 3 seasons (all if 3), random offset in the slack
        _, p0 = track(0.0, 0.0)
        sub = list(rng.choice(seasons, size=3, replace=False)) if len(seasons) > 3 else list(seasons)
        T = np.array([p0[s][:2] for s in sub])
        lo = -half - T.min(0)
        hi = half - T.max(0)
        if np.any(lo > hi):
            continue
        off = rng.uniform(lo, hi)
        r0, pos = track(float(off[0]), float(off[1]))
        inside = [s for s in seasons if abs(pos[s][0]) < half[0] and abs(pos[s][1]) < half[1]]
        if valid is not None:
            ok = []
            for s in inside:
                if s not in valid:
                    continue
                x, y = g.std_to_xy(pos[s][0], pos[s][1])
                ix, iy = int(round(float(x))), int(round(float(y)))
                if 0 <= ix < nx and 0 <= iy < ny and valid[s][iy, ix]:
                    ok.append(s)
            inside = ok
        if len(inside) < 3:
            continue
        nacc += 1
        if any(min(math.hypot(pos[s][0] - b["pos"][s][0], pos[s][1] - b["pos"][s][1]) for s in seasons) < sep
               for b in bodies):
            continue
        bodies.append(dict(d_au=d_au, r0=r0, v=v, t0=t0, flux_ujy=flux_ujy, pos=pos, inside=inside,
                           v_over_vcirc=float(np.linalg.norm(v) / vc)))
    return bodies, ndraw, nacc


def inject_images(D, exps, cal, obs, bodies, g, seed, sed="flat"):
    from detect import inject as INJ
    rng = np.random.default_rng(seed)
    images = {}
    cosd = math.cos(math.radians(g.dec0))
    for i, e in enumerate(exps):
        px = e["_px"]
        ny, nx = px["clean"].shape
        add = np.zeros((ny, nx))
        cE, cN = cal.get(e["file"], (0.0, 0.0))
        fac = solar_factor(e["wavelength_um"]) if sed == "solar" else 1.0
        for b in bodies:
            ra, dec = apparent(b["r0"], b["v"], b["t0"], e["jyear"], obs[i])
            x, y = (float(q) for q in px["wcs"].all_world2pix(ra + cE / 3600 / cosd, dec + cN / 3600, 0, quiet=True))
            if not (np.isfinite(x) and np.isfinite(y)) or not (-INJ.R_INJ <= x < nx + INJ.R_INJ and -INJ.R_INJ <= y < ny + INJ.R_INJ):
                continue
            f = b["flux_ujy"] * fac / D.PIXEL_UJY
            x0, y0, ker = INJ.stamp(e, x, y)
            ys, xs = slice(max(y0, 0), min(y0 + ker.shape[0], ny)), slice(max(x0, 0), min(x0 + ker.shape[1], nx))
            if ys.stop <= ys.start or xs.stop <= xs.start:
                continue
            add[ys, xs] += f * ker[ys.start - y0:ys.stop - y0, xs.start - x0:xs.stop - x0]
        if add.any():
            k = INJ.gain_slope(e)
            noise = rng.normal(0.0, 1.0, add.shape) * np.sqrt(k * np.clip(add, 0, None))
            images[e["file"]] = px["clean"].astype(np.float64) + add + noise
    return images


def match(bodies, recs, tol=10.0):
    out = []
    used = set()
    for b in bodies:
        best = None
        for k, r in enumerate(recs):
            ev = (r.get("nature") or {}).get("evidence") or {}
            nm = 0
            for p in ev.get("positions", []):
                q = b["pos"].get(p["season"])
                if q and math.hypot(p["xi_arcsec"] - q[0], p["eta_arcsec"] - q[1]) <= tol + 2 * p["err_arcsec"]:
                    nm += 1
            if nm >= 3 and (best is None or nm > best[0]):
                best = (nm, k)
        row = {"d_au": b["d_au"], "flux_ujy": b["flux_ujy"], "inside": b["inside"], "v_over_vcirc": round(b["v_over_vcirc"], 2),
               "xi_eta": {s: [round(v[0], 1), round(v[1], 1)] for s, v in b["pos"].items()},
               "trail_spread": {s: round(v[2], 1) for s, v in b["pos"].items()}, "recovered": best is not None}
        if best:
            r = recs[best[1]]
            used.add(best[1])
            row.update(d_fit=r["distance_au"], d_err=r["err_distance_au"], confirmed=r["confirmed"],
                       fap=r["confidence"]["false_alarm_probability"], n_matched=best[0],
                       snr=[p["snr"] for p in r["nature"]["evidence"]["positions"]],
                       refined=[bool(p.get("drift_refined")) for p in r["nature"]["evidence"]["positions"]],
                       failed=[c["name"][:40] for c in r["confirmation"]["checks"] if not c["pass"]], score=r["snr"],
                       rank=(r["nature"]["evidence"].get("chance_alignment") or {}).get("statistic", r["snr"]),
                       alternatives=r["nature"]["evidence"].get("alternative_links", []))
        out.append(row)
    false = [k for k in range(len(recs)) if k not in used]
    return out, false

def cmd_inject(a):
    """Bodies on exact 3-D tracks injected into the strips of one field (real EPSF, Poisson noise of the added signal),
    searched with the same code. One file per cell: <out>/inj_strip_<field>_d<AU>_m<mag>_s<seed>.json."""
    from detect import inject as INJ
    D = _detector()
    out = Path(a.out) if a.out else PX / "injections"
    out.mkdir(parents=True, exist_ok=True)
    field, exps, spec = load_strips(a.field)
    opts = {"no_sso": True, "distant_n_rand": 10, "distant_template": "all", "distant_threads": a.threads, "distant_keep": True}
    ctx = make_ctx(field, exps, spec, opts, log=lambda *x: None)
    obs = D.observer_xyz(exps)
    g = D.make_grid(exps, field.ra, field.dec, ctx.opts.get("distant_grid"))
    D.run(ctx)                                                   # coverage of the uninjected field
    valid = {q["label"]: q["valid"] for q in ctx.shared["P_seasons"]}
    area = {k: round(float(v.mean()), 3) for k, v in valid.items()}
    ctx.opts["distant_keep"] = hasattr(D, "TRACK_FRAC")       # v3b: the null of a cell applies the track rule, it needs the stacks
    name = "strip_" + a.field
    vp = out / f"valid_{name}.npz"
    if not vp.exists():
        np.savez_compressed(vp, **{f"valid_{k}": v for k, v in valid.items()}, grid=np.array([g.ra0, g.dec0, g.nx, g.ny, g.pix, g.rot_deg]))
    for d_au in [float(x) for x in a.dists.split(",")]:
        for mag in [float(x) for x in a.mags.split(",")]:
            p = out / f"inj_{name}_d{int(d_au)}_m{mag:g}_s{a.seed}.json"
            if p.exists():
                print(f"{p.name}: exists, skipped", flush=True)
                continue
            rng = np.random.default_rng(1000 * a.seed + int(d_au) + int(10 * mag))
            bodies, ndraw, nacc = make_bodies(D, exps, obs, g, d_au, a.nbody, rng, INJ.ab_to_ujy(mag), valid=valid, orbits=a.orbits)
            t1 = time.time()
            ctx.images = inject_images(D, exps, {}, obs, bodies, g, a.seed, sed=a.sed)
            ctx.info, ctx.shared = {}, {}
            # every link is reported here; its false-link probability comes from ONE null per cell: the randomised
            # orphan lists of this field WITHOUT the injected bodies' detections
            ctx.opts.update(distant_report_fap=1.0, distant_fap_refine=False, distant_n_rand=10)
            recs = D.run(ctx)
            rows, false = match(bodies, recs)
            S = ctx.shared["P_seasons"]

            def _bg(q):
                return [o for o in q["orphans"]
                        if all(math.hypot(o["xi"] - bb["pos"][q["label"]][0], o["eta"] - bb["pos"][q["label"]][1]) > 10.0 for bb in bodies)]
            S0 = [dict(q, orphans=_bg(q)) for q in S]
            br, nl0 = D.randomised(S0, a.n_rand, seed=3)
            n_false = 0
            for k in false:
                rk = recs[k]["nature"]["evidence"]["chance_alignment"]["statistic"]
                n_false += (1.0 + float(np.sum(br >= rk))) / (1.0 + a.n_rand) <= D.REPORT_FAP
            for row in rows:
                row["linked"] = bool(row["recovered"])
                if row["recovered"]:
                    fap1 = (1.0 + float(np.sum(br >= row["rank"]))) / (1.0 + a.n_rand)
                    row["fap"] = round(fap1, 5)
                    row["recovered"] = fap1 <= D.REPORT_FAP
                    rest = [f for f in row["failed"] if not f.startswith("false-link")]
                    row["confirmed_single_body"] = (not rest) and fap1 <= D.CONF_FAP and a.n_rand >= 1000
            res = {"field": "strip:" + a.field, "version": D.VERSION, "d_au": d_au, "mag_ab": mag, "flux_ujy": INJ.ab_to_ujy(mag), "seed": a.seed,
                   "orbits": a.orbits, "sed": a.sed, "n_bodies": len(bodies), "acceptance_draws": [ndraw, nacc],
                   "seconds": round(time.time() - t1, 1), "valid_area": area,
                   "n_linked": sum(r["linked"] for r in rows), "n_recovered": sum(r["recovered"] for r in rows),
                   "n_confirmed_single_body": sum(bool(r.get("confirmed_single_body")) for r in rows),
                   "null_without_injected_bodies": {"n_randomised": a.n_rand, "false_links_per_randomised_field": round(nl0 / max(a.n_rand, 1), 4)},
                   "bodies": rows, "n_false_records": int(n_false)}
            p.write_text(_json(res))
            print(f"d={d_au:.0f} AU m={mag}: linked {res['n_linked']}, recovered {res['n_recovered']}/{len(bodies)} "
                  f"(confirmed {res['n_confirmed_single_body']}), other candidates {n_false}, {res['seconds']} s", flush=True)
    ctx.images = None


# ----------------------------------------------------------------------------------------------- 6. limits
def crossing(mags, fracs, level):
    """Faintest magnitude where the recovered fraction (made non-increasing from the bright side) is still >= level,
    linearly interpolated to the next point; None if never reached."""
    pts = sorted(zip(mags, fracs))
    f_mono, cur = [], 1.0
    for m, f in pts:
        cur = min(cur, f)
        f_mono.append(cur)
    if not pts or f_mono[0] < level:
        return None
    for k in range(len(pts) - 1):
        if f_mono[k] >= level > f_mono[k + 1]:
            m0, m1, f0, f1 = pts[k][0], pts[k + 1][0], f_mono[k], f_mono[k + 1]
            return m0 + (f0 - level) / (f0 - f1) * (m1 - m0)
    return pts[-1][0] if f_mono[-1] >= level else None

def cmd_limits(a):
    """Recovered fraction per field x distance x magnitude and the 50 % / 90 % magnitudes (pooled row: ALL)."""
    by = defaultdict(dict)
    for d in a.dirs:
        for f in sorted(glob.glob(f"{d}/inj_*.json")):
            r = json.load(open(f))
            for key in ((r["field"].split(":")[-1], int(r["d_au"])), ("ALL", int(r["d_au"]))):
                c = by[key].setdefault(float(r["mag_ab"]), [0, 0])
                c[0] += sum(bool(b["recovered"]) for b in r["bodies"])
                c[1] += len(r["bodies"])
    print("| field | d (AU) | recovered / injected by magnitude | m50 | m90 |")
    print("|---|---|---|---|---|")
    for (fld, d), mm in sorted(by.items()):
        mags = sorted(mm)
        fr = [mm[m][0] / max(mm[m][1], 1) for m in mags]
        m50, m90 = crossing(mags, fr, 0.5), crossing(mags, fr, 0.9)
        print(f"| {fld} | {d} | " + " ".join(f"{m:g}: {mm[m][0]}/{mm[m][1]}" for m in mags)
              + f" | {m50 if m50 is None else round(m50, 2)} | {m90 if m90 is None else round(m90, 2)} |")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("plan")
    s.add_argument("--out", default="")
    s = sub.add_parser("fetch")
    s.add_argument("--fields", default=",".join(FETCH_ORDER))
    s.add_argument("--cap-mb", type=float, default=840.0, help="stop before the ledger total exceeds this")
    s.add_argument("--limit", type=int, default=0, help="only the first N exposures of each field (test)")
    s = sub.add_parser("search")
    s.add_argument("--field", required=True)
    s.add_argument("--n-rand", dest="n_rand", type=int, default=2000)
    s.add_argument("--out", default="")
    s.add_argument("--threads", type=int, default=3)
    s = sub.add_parser("inject")
    s.add_argument("--field", required=True)
    s.add_argument("--dists", default="350,500")
    s.add_argument("--mags", default="19,19.4,19.7,20,20.3")
    s.add_argument("--nbody", type=int, default=12)
    s.add_argument("--seed", type=int, default=1)
    s.add_argument("--n-rand", dest="n_rand", type=int, default=1000)
    s.add_argument("--orbits", default="p9", choices=["p9", "iso"])
    s.add_argument("--sed", default="solar", choices=["solar", "flat"])
    s.add_argument("--out", default="")
    s.add_argument("--threads", type=int, default=3)
    s = sub.add_parser("limits")
    s.add_argument("dirs", nargs="+")
    a = ap.parse_args()
    {"plan": cmd_plan, "fetch": cmd_fetch, "search": cmd_search, "inject": cmd_inject, "limits": cmd_limits}[a.cmd](a)


if __name__ == "__main__":
    main()
