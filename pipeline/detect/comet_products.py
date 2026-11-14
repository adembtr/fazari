"""Comet showcase products from the cached boxes of comets.py: measurements, blink, co-moving stack,
coma test, spectrum, and the site files (site/data/comets/). CLI: pipeline/find_comets.py.

All numbers are computed from the SPHEREx pixels; the comet positions come from JPL Horizons.
"""
import argparse
import json
import math
import time
import warnings
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates

from . import comets as C
from . import comet_select as CS
from . import asteroids as A

S3 = C.S3
BL = C.BL
SI = C.SI
PIX = C.PIX
SNR_DET = 5.0             # aperture S/N for a detection
OFF_MAX = 30.0            # arcsec: a fit farther than this from the ephemeris is not the comet
GRID_AS = 3.0             # display grid pixel (arcsec)
UP = 3                    # PNG upscale

# display names and plain sentences (EN / TR); objects are added here once chosen from the data
INFO = {
    "2025 R2": dict(name="C/2025 R2 (SWAN)", folder="C2025_R2_SWAN", kind="comet",
                    en="A long-period comet found in September 2025 in images from the SWAN camera on the SOHO spacecraft; SPHEREx caught it a few weeks after its closest approach to the Sun, with a bright head and a tail.",
                    tr="Eylül 2025'te SOHO uydusunun SWAN kamerası görüntülerinde bulunan uzun dönemli bir kuyruklu yıldız; SPHEREx onu Güneş'e en yakın geçişinden birkaç hafta sonra, parlak başı ve kuyruğuyla görüntüledi."),
    "2025 N1": dict(name="3I/ATLAS (C/2025 N1)", folder="3I_ATLAS", kind="interstellar comet",
                    en="The third object known to come from outside our Solar System. It passes the Sun once on an open (hyperbolic) path and leaves again.",
                    tr="Güneş Sistemi dışından geldiği bilinen üçüncü cisim. Güneş'in yanından açık (hiperbolik) bir yörüngede bir kez geçip geri dönmemek üzere uzaklaşıyor."),
    "2025 A6": dict(name="C/2025 A6 (Lemmon)", folder="C2025_A6_Lemmon", kind="comet",
                    en="The comet that was visible to the naked eye in October 2025. SPHEREx saw it months later, on its way back out.",
                    tr="Ekim 2025'te çıplak gözle görülen kuyruklu yıldız. SPHEREx onu aylar sonra, dışarı doğru uzaklaşırken gördü."),
    "2023 A3": dict(name="C/2023 A3 (Tsuchinshan-ATLAS)", folder="C2023_A3_Tsuchinshan-ATLAS", kind="comet",
                    en="The bright comet of October 2024. A year later SPHEREx still sees it, far beyond the orbit of Mars and fading.",
                    tr="Ekim 2024'ün parlak kuyruklu yıldızı. Bir yıl sonra SPHEREx onu hâlâ görüyor; artık Mars'ın yörüngesinin çok ötesinde ve sönükleşiyor."),
    "2025 K1": dict(name="C/2025 K1 (ATLAS)", folder="C2025_K1_ATLAS", kind="comet",
                    en="A comet that passed close to the Sun in October 2025 and then broke into pieces.",
                    tr="Ekim 2025'te Güneş'e çok yaklaşan ve ardından parçalara ayrılan bir kuyruklu yıldız."),
    "24P": dict(name="24P/Schaumasse", folder="24P_Schaumasse", kind="periodic comet",
                en="A periodic comet that returns every 8.3 years; it passed the Sun in January 2026.",
                tr="Her 8,3 yılda bir geri gelen dönemli bir kuyruklu yıldız; Ocak 2026'da Güneş'e en yakın noktasından geçti."),
    "210P": dict(name="210P/Christensen", folder="210P_Christensen", kind="periodic comet",
                 en="A small periodic comet (5.7-year orbit) that passed close to the Sun in November 2025.",
                 tr="Güneş'e Kasım 2025'te çok yaklaşan küçük, dönemli (5,7 yıllık yörünge) bir kuyruklu yıldız."),
    "10P": dict(name="10P/Tempel 2", folder="10P_Tempel_2", kind="periodic comet",
                en="A periodic comet with a 5.4-year orbit, observed since 1873.",
                tr="1873'ten beri gözlenen, 5,4 yıllık yörüngeli dönemli bir kuyruklu yıldız."),
    "220P": dict(name="220P/McNaught", folder="220P_McNaught", kind="periodic comet",
                 en="A periodic comet with a 5.5-year orbit.", tr="5,5 yıllık yörüngeli dönemli bir kuyruklu yıldız."),
    "pluto": dict(name="Pluto", folder="Pluto", kind="dwarf planet",
                  en="Not a comet: the dwarf planet Pluto, a real distant world 35 times farther from the Sun than Earth, creeping across the stars.",
                  tr="Kuyruklu yıldız değil: cüce gezegen Plüton. Güneş'e Dünya'dan 35 kat daha uzak, yıldızların önünde ağır ağır ilerleyen gerçek bir uzak dünya."),
}


def log(*a):
    C.log(*a)


def jd(o):
    return A._jsonable(o)


# ------------------------------------------------------------------------------------------ load
def load_runs(pdes, remeasure=True):
    d = C.RUNS / C.safe(pdes)
    out = []
    for p in sorted(d.glob("*.json")):
        r = json.loads(p.read_text())
        if r.get("skip"):
            continue
        z = p.with_suffix(".npz")
        if not z.exists():
            continue
        if remeasure:
            exp = S3.exposure(r["key"])           # header from the on-disk cache
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                r["_D"] = C.measure(r, exp, np.load(z))
        r["_z"] = z
        out.append(r)
    out.sort(key=lambda r: r["mjd"])
    return out


def phot(r):
    """Best aperture photometry of one exposure: fit-centred when the fit is a clear detection."""
    ph = r.get("phot", {})
    f = ph.get("fit_r2")
    if f and r.get("fit") and r["fit"]["off"] <= OFF_MAX and (f.get("snr") or 0) >= SNR_DET:
        return f, "fit"
    return ph.get("ephemeris_r2"), "ephemeris"


def detected(r):
    f, how = phot(r)
    return how == "fit" and f is not None


def seasons(mjds, gap=30.0):
    s = []
    for t in sorted(mjds):
        if not s or t - s[-1][-1] > gap:
            s.append([t])
        else:
            s[-1].append(t)
    return s


def utc(mjd):
    from astropy.time import Time
    return Time(mjd, format="mjd").iso[:16]


# ------------------------------------------------------------------------------------------ motion
def motion(runs):
    """Measured vs ephemeris motion from pairs of detections 0.5-30 h apart (same season)."""
    det = [r for r in runs if detected(r)]
    meas, eph = [], []
    for i in range(len(det)):
        for j in range(i + 1, len(det)):
            a, b = det[i], det[j]
            dt = (b["mjd"] - a["mjd"]) * 24
            if not 0.5 <= dt <= 20 * 24:
                continue
            e1, n1 = C.offset_arcsec(b["fit"]["ra"], b["fit"]["dec"], a["fit"]["ra"], a["fit"]["dec"])
            e2, n2 = C.offset_arcsec(b["pred"]["ra"], b["pred"]["dec"], a["pred"]["ra"], a["pred"]["dec"])
            if math.hypot(e2, n2) < 10 * PIX or (dt > 30 and math.hypot(e2, n2) < 60 * PIX and False):
                continue                     # the move must be >= 10 px (61") so position noise does not dominate
            meas.append((e1 / dt, n1 / dt, dt))
            eph.append((e2 / dt, n2 / dt, dt))
    if not meas:
        return None
    m, e = np.array(meas), np.array(eph)
    sp_m, sp_e = np.hypot(m[:, 0], m[:, 1]), np.hypot(e[:, 0], e[:, 1])
    diff = sp_m / sp_e - 1
    pa_m = np.degrees(np.arctan2(m[:, 0], m[:, 1])) % 360
    pa_e = np.degrees(np.arctan2(e[:, 0], e[:, 1])) % 360
    dpa = (pa_m - pa_e + 180) % 360 - 180
    return dict(n_pairs=len(meas), speed_measured=float(np.median(sp_m)), speed_ephem=float(np.median(sp_e)),
                speed_diff_frac_median=float(np.median(diff)), pa_measured=float(np.median(pa_m)),
                pa_ephem=float(np.median(pa_e)), pa_diff_deg_median=float(np.median(dpa)),
                dt_h_range=[float(m[:, 2].min()), float(m[:, 2].max())])


# ------------------------------------------------------------------------------------------ grids
def tan_grid(ra0, dec0, n, pix_as):
    """Sky positions of an n x n north-up east-left grid centred on (ra0, dec0)."""
    c = (n - 1) / 2
    yy, xx = np.mgrid[0:n, 0:n]
    x = -(xx - c) * pix_as / 3600          # east to the left
    y = (yy - c) * pix_as / 3600
    ra, dec = SI.deproject(x.ravel(), y.ravel(), ra0, dec0)
    return np.array(ra), np.array(dec)


def onto(exp, box, origin, ra, dec, order=1):
    x, y = exp.world2pix(ra, dec)
    bx, by = x - origin[0], y - origin[1]
    bad = ~np.isfinite(box)
    out = map_coordinates(np.where(bad, 0, box), [by, bx], order=order, mode="constant", cval=np.nan)
    m = map_coordinates(bad.astype(float), [by, bx], order=1, mode="constant", cval=1.0)
    out[m > 0.3] = np.nan
    return out


def to_png(img, path, lo, hi, up=UP):
    from PIL import Image
    soft = (hi - lo) * 0.04
    a = np.clip(np.arcsinh((np.nan_to_num(img, nan=lo) - lo) / soft) / np.arcsinh((hi - lo) / soft), 0, 1)
    g = (a[::-1] * 255).astype(np.uint8)            # row 0 = north (grid y grows north)
    n = img.shape[0]
    Image.fromarray(g, "L").resize((img.shape[1] * up, n * up), Image.NEAREST).save(path, optimize=True)


def grid_xy(ra, dec, ra0, dec0, n, pix_as, up=UP):
    """Display (x, y) in upscaled PNG pixels of a sky position on the tan_grid."""
    e, nn = C.offset_arcsec(ra, dec, ra0, dec0)
    c = (n - 1) / 2
    gx = c - e / pix_as
    gy = c + nn / pix_as
    return [round(gx * up + up / 2, 1), round((n - 1 - gy) * up + up / 2, 1)]


# ------------------------------------------------------------------------------------------ blink
def pick_blink(runs, max_px=40.0, min_px=6.0, n_max=8):
    """Detected exposures (one detector each) over a short window where the comet moves min..max px:
    sub-exposures of one visit for fast comets, several visits for slow ones."""
    best = None
    for d in sorted(set(r["det"] for r in runs)):
        got = _pick_blink_det([r for r in runs if detected(r) and r["det"] == d], max_px, min_px, n_max)
        if got and (best is None or got[0] > best[0]):
            best = got
    return best[1] if best else []


def _pick_blink_det(vis, max_px, min_px, n_max):
    vis = sorted(vis, key=lambda r: r["mjd"])
    best = None
    for i in range(len(vis)):
        sel = [vis[i]]
        for j in range(i + 1, len(vis)):
            e, n = C.offset_arcsec(vis[j]["pred"]["ra"], vis[j]["pred"]["dec"], vis[i]["pred"]["ra"], vis[i]["pred"]["dec"])
            if math.hypot(e, n) / PIX > max_px or vis[j]["mjd"] - vis[i]["mjd"] > 10:
                break
            sel.append(vis[j])
        e, n = C.offset_arcsec(sel[-1]["pred"]["ra"], sel[-1]["pred"]["dec"], sel[0]["pred"]["ra"], sel[0]["pred"]["dec"])
        span = math.hypot(e, n) / PIX
        if len(sel) < 3 or span < min_px:
            continue
        if len(sel) > n_max:
            k = np.linspace(0, len(sel) - 1, n_max).round().astype(int)
            sel = [sel[q] for q in k]
        score = min(span, 25.0) + 0.8 * min(len(sel), 8)
        if best is None or score > best[0]:
            best = (score, sel)
    return best


def make_blink(pdes, runs, out_dir):
    sel = pick_blink(runs)
    if not sel:
        sel = pick_blink(runs, max_px=80, min_px=3)
    if not sel:
        return None
    ra = [r["pred"]["ra"] for r in sel]
    dec = [r["pred"]["dec"] for r in sel]
    ra0, dec0 = float(np.mean(ra)), float(np.mean(dec))
    ext = max(math.hypot(*C.offset_arcsec(a, b, ra0, dec0)) for a, b in zip(ra, dec))
    half_as = ext + 100.0
    n = int(2 * half_as / GRID_AS) | 1
    gr, gd = tan_grid(ra0, dec0, n, GRID_AS)
    frames = []
    for r in sel:
        exp = S3.exposure(r["key"])
        x, y = exp.world2pix(gr, gd)
        x0, y0 = int(math.floor(np.nanmin(x))) - 2, int(math.floor(np.nanmin(y))) - 2
        x1, y1 = int(math.ceil(np.nanmax(x))) + 2, int(math.ceil(np.nanmax(y))) + 2
        a = exp.box("IMAGE", x0, y0, x1, y1).astype(float)
        b, _ = A.robust_bg(a)
        img = onto(exp, a - b, (x0, y0), gr, gd).reshape(n, n)
        frames.append((r, img))
    C.ledger_flush(f"{pdes} blink")
    # each frame is at its own wavelength: stretch each one on its own percentiles (stars stay put)
    meta = dict(grid=dict(size_px=n, pixel_arcsec=GRID_AS, upscale=UP, ra=ra0, dec=dec0, north_up=True, east_left=True),
                frames=[])
    for i, (r, img) in enumerate(frames):
        fn = f"blink_{i:02d}.png"
        v = img[np.isfinite(img)]
        to_png(img, out_dir / fn, np.percentile(v, 2), np.percentile(v, 99.7))
        f, _ = phot(r)
        meta["frames"].append(dict(file=fn, utc=utc(r["mjd"]), mjd=r["mjd"], obs_id=r["obs_id"], detector=r["det"],
                                   lam_um=r.get("lam_um"), snr=f.get("snr"),
                                   ephemeris_xy=grid_xy(r["pred"]["ra"], r["pred"]["dec"], ra0, dec0, n, GRID_AS),
                                   measured_xy=grid_xy(r["fit"]["ra"], r["fit"]["dec"], ra0, dec0, n, GRID_AS)))
    e, nn = C.offset_arcsec(sel[-1]["pred"]["ra"], sel[-1]["pred"]["dec"], sel[0]["pred"]["ra"], sel[0]["pred"]["dec"])
    meta["moved_arcsec"] = math.hypot(e, nn)
    meta["span_h"] = (sel[-1]["mjd"] - sel[0]["mjd"]) * 24
    return meta


# ------------------------------------------------------------------------------------------ stack + coma
def make_stack(pdes, runs, out_dir, half_as=120.0):
    """Co-moving stack of the star-subtracted boxes: every frame resampled onto a north-up grid
    centred on the comet's ephemeris position at that frame's time, sigma-clipped mean."""
    use = [r for r in runs if np.isfinite(np.load(r["_z"])["R"]).any()]
    if len(use) < 3:
        use = runs
    n = int(2 * half_as / GRID_AS) | 1
    stack, raw = [], []
    for r in use:
        exp = S3.exposure(r["key"])
        z = np.load(r["_z"])
        gr, gd = tan_grid(r["pred"]["ra"], r["pred"]["dec"], n, GRID_AS)
        D = r["_D"]
        stack.append(onto(exp, D, z["origin"], gr, gd).reshape(n, n))
        raw.append(onto(exp, z["T"].astype(float), z["origin"], gr, gd).reshape(n, n))
    S = np.stack(stack)
    med = np.nanmedian(S, 0)
    mad = 1.4826 * np.nanmedian(np.abs(S - med), 0)
    clip = np.abs(S - med) > 4 * np.maximum(mad, 1e-6)
    S = np.where(clip, np.nan, S)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        mean = np.nanmean(S, 0)
        cnt = np.isfinite(S).sum(0)
        rawmed = np.nanmedian(np.stack(raw), 0)
    v = mean[np.isfinite(mean)]
    _, s = A.robust_bg(mean)
    lo, hi = -3 * s, max(np.percentile(v, 99.9), 20 * s)
    to_png(mean, out_dir / "stack.png", lo, hi)
    one = stack[int(np.argmax([phot(r)[0]["snr"] or 0 for r in use]))]
    to_png(one, out_dir / "single.png", lo, hi)
    # surface-brightness S/N of the stack: how far out the comet is above 3 sigma
    c = (n - 1) / 2
    yy, xx = np.mgrid[0:n, 0:n]
    rr = np.hypot(xx - c, yy - c) * GRID_AS
    prof = []
    for r0 in np.arange(0, half_as - 10, 6.0):
        m = (rr >= r0) & (rr < r0 + 6) & np.isfinite(mean)
        if m.sum() < 5:
            continue
        prof.append(dict(r_arcsec=r0 + 3, mean=float(np.mean(mean[m])), err=float(s / math.sqrt(m.sum() / ((6.15 / GRID_AS) ** 2)))))
    return dict(n_frames=len(use), size_px=n, pixel_arcsec=GRID_AS, upscale=UP, noise_mjy_sr=float(s),
                profile=prof, file="stack.png", single="single.png")


def coma_test(runs):
    """Encircled-flux ratio F(r<4 px) / F(r<1.5 px) of the comet (star-subtracted box, fitted centre)
    against the same ratio of bright isolated stars in the reference image of the same box."""
    from scipy.ndimage import maximum_filter
    rc, rs = [], []
    for r in runs:
        if not detected(r):
            continue
        z = np.load(r["_z"])
        D, R = r["_D"], z["R"].astype(float)
        if not np.isfinite(R).any():
            continue
        ox, oy = z["origin"]
        cx, cy = r["fit"]["x"] - ox, r["fit"]["y"] - oy
        f1, _ = C.aperture_sum(D, cx, cy, 1.5)
        f4, _ = C.aperture_sum(D, cx, cy, 4.0)
        if not (np.isfinite(f1) and np.isfinite(f4)) or f1 <= 0:
            continue
        rc.append(f4 / f1)
        _, s = A.robust_bg(R)
        Rf = np.nan_to_num(R)
        pk = (Rf == maximum_filter(Rf, size=9)) & (Rf > 40 * s)
        ys, xs = np.nonzero(pk)
        vals = []
        for x, y in zip(xs, ys):
            if x < 6 or y < 6 or x >= R.shape[1] - 6 or y >= R.shape[0] - 6 or math.hypot(x - cx, y - cy) < 10:
                continue
            # isolated: no other peak above 10 % within 6 px
            nb = (np.hypot(xs - x, ys - y) < 6) & (np.hypot(xs - x, ys - y) > 0)
            if nb.any():
                continue
            w = Rf[y - 1:y + 2, x - 1:x + 2]
            if w.sum() <= 0 or w.min() < -0.2 * w.max():
                continue
            gx = x + float((w.sum(0) * [-1, 0, 1]).sum() / w.sum())
            gy = y + float((w.sum(1) * [-1, 0, 1]).sum() / w.sum())
            s1, _ = C.aperture_sum(R, gx, gy, 1.5)
            s4, _ = C.aperture_sum(R, gx, gy, 4.0)
            if np.isfinite(s1) and np.isfinite(s4) and s1 > 0:
                vals.append(s4 / s1)
        if vals:
            rs.append(float(np.median(vals)))
    if len(rc) < 3 or len(rs) < 3:
        return None
    rc, rs = np.array(rc), np.array(rs)
    mc, ms = float(np.median(rc)), float(np.median(rs))
    # robust errors of the medians (1.4826 MAD, x 1.2533 for a median)
    ec = 1.2533 * 1.4826 * float(np.median(np.abs(rc - mc))) / math.sqrt(len(rc))
    es = 1.2533 * 1.4826 * float(np.median(np.abs(rs - ms))) / math.sqrt(len(rs))
    sig = (mc - ms) / math.hypot(ec, es) if math.hypot(ec, es) > 0 else 0.0
    return dict(ratio_comet=mc, ratio_comet_err=ec, ratio_stars=ms, ratio_stars_err=es, n_frames=int(len(rc)),
                n_frames_stars=int(len(rs)), excess=mc - ms, significance_sigma=sig, extended=bool(sig >= 5),
                definition="F(r<24.6\") / F(r<9.2\"), comet (star-subtracted) vs isolated stars of the same boxes")


# ------------------------------------------------------------------------------------------ spectrum
H, KB, CC = 6.62607015e-34, 1.380649e-23, 2.99792458e8


def bnu(lam_um, T):
    nu = CC / (np.asarray(lam_um) * 1e-6)
    return 2 * H * nu ** 3 / CC ** 2 / np.expm1(H * nu / (KB * T))


FEATURES = [("H2O gas (2.7 µm)", 2.58, 2.85), ("water ice (3.0 µm)", 2.90, 3.20), ("C-H organics (3.4 µm)", 3.30, 3.52),
            ("CO2 gas (4.26 µm)", 4.18, 4.34), ("CO gas (4.67 µm)", 4.56, 4.76)]
FEATURE_TR = {"H2O gas (2.7 µm)": "H2O gazı (2,7 µm)", "water ice (3.0 µm)": "su buzu (3,0 µm)",
              "C-H organics (3.4 µm)": "C-H organik (3,4 µm)", "CO2 gas (4.26 µm)": "CO2 gazı (4,26 µm)",
              "CO gas (4.67 µm)": "CO gazı (4,67 µm)", "CH4 ice (1.7–1.8 µm)": "CH4 buzu (1,7–1,8 µm)",
              "CH4 ice (2.1–2.4 µm)": "CH4 buzu (2,1–2,4 µm)"}
PLUTO_FEATURES = [("CH4 ice (1.7–1.8 µm)", 1.72, 1.81), ("CH4 ice (2.1–2.4 µm)", 2.08, 2.45)]
SYS_FRAC_POINT = 0.10      # Pluto: 10 % per point (rotational light curve, ~0.3 mag peak to peak at most)
SYS_FRAC = 0.05            # systematic per point (solar spectrum as a 5778 K blackbody, flat-field, aperture)


def spectrum(runs, features=None, thermal=True, point=False):
    """Reflectance-like spectrum: aperture flux / solar blackbody, normalised at 1.0-1.6 um, geometry
    normalised to the median r, delta of the season used (F x r^2 delta, fixed angular aperture)."""
    pts = []
    for r in runs:
        f, how = phot(r)
        if not f or r.get("lam_um") is None or not np.isfinite(f.get("flux_ujy", np.nan)) or not f.get("err_ujy"):
            continue
        if how != "fit":            # only clear detections (S/N >= 5, fitted within 30" of the prediction)
            continue
        pts.append(dict(mjd=r["mjd"], lam=r["lam_um"], flux=f["flux_ujy"], err=f["err_ujy"], r=r["pred"]["r"],
                        delta=r["pred"]["delta"], centre=how, det=r["det"]))
    if len(pts) < 6:
        return None
    S = seasons([p["mjd"] for p in pts])
    big = max(S, key=len)
    pts = [p for p in pts if big[0] <= p["mjd"] <= big[-1]]
    r0 = float(np.median([p["r"] for p in pts]))
    d0 = float(np.median([p["delta"] for p in pts]))
    lam = np.array([p["lam"] for p in pts])
    k = np.array([(p["r"] / r0) ** 2 * (p["delta"] / d0) ** (2 if point else 1) for p in pts])
    F = np.array([p["flux"] for p in pts]) * k
    E = np.array([p["err"] for p in pts]) * k
    sun = bnu(lam, 5778.0)
    refl = F / sun
    nm = (lam >= 1.0) & (lam <= 1.6)
    if nm.sum() < 2:
        nm = lam < 2.5
    if nm.sum() < 1:
        return None
    norm = float(np.median(refl[nm]))
    R = refl / norm
    sysf = SYS_FRAC_POINT if point else SYS_FRAC
    ER = np.hypot(E / sun / norm, sysf * np.abs(R))
    # continuum: linear reflectance (lam < 2.5 dominates) + thermal blackbody of the dust
    tdust = 1.1 * 278.0 / math.sqrt(r0)
    inwin = np.zeros(lam.size, bool)
    features = FEATURES if features is None else features
    for _, a, b in features:
        inwin |= (lam >= a) & (lam <= b)
    th = bnu(lam, tdust) / sun / norm
    X = np.stack([np.ones_like(lam), lam - 1.5, th], 1)
    w = 1 / ER
    refl_pts = ~inwin & np.isfinite(R) & (lam < 2.55)
    p = np.array([1.0, 0.0, 0.0])
    if refl_pts.sum() >= 3:
        q, *_ = np.linalg.lstsq(X[refl_pts, :2] * w[refl_pts, None], R[refl_pts] * w[refl_pts], rcond=None)
        p[:2] = q
    hot = ~inwin & np.isfinite(R) & (lam >= 3.0)
    if thermal and hot.sum() >= 2:
        rest = R[hot] - X[hot, :2] @ p[:2]
        p[2] = max(0.0, float(np.sum(rest * th[hot] * w[hot] ** 2) / np.sum(th[hot] ** 2 * w[hot] ** 2)))
    use = ~inwin & np.isfinite(R)
    model = X @ p
    # for the feature tests the 5 % systematic applies to the continuum level, not to the measured excess
    ER = np.hypot(E / sun / norm, sysf * np.abs(model))
    res = (R - model) / ER
    chi2r = float(np.sum(res[use] ** 2) / max(1, use.sum() - 3))
    # error scale from the scatter of the reflected-light points (lam < 2.55 um) around their straight
    # line: image-to-image scatter beyond the error bars (comet variability, aperture centring, calibration);
    # the misfit of the simple thermal model above 3 um is model error and is handled by the local continua
    rp = refl_pts & np.isfinite(res)
    chi2r_refl = float(np.sum(res[rp] ** 2) / max(1, rp.sum() - 2)) if rp.sum() >= 4 else chi2r
    scale = math.sqrt(max(1.0, chi2r_refl))
    if point:
        # Pluto's reflected light is full of methane bands, so the straight-line scatter is not noise:
        # keep the per-image errors (empty-aperture scatter + 10 % per point) unscaled
        scale = 1.0
    feats = []
    for name, a, b in features:
        m = (lam >= a) & (lam <= b)
        if m.sum() == 0:
            feats.append(dict(name=name, name_tr=FEATURE_TR.get(name), lo=a, hi=b, n=0, covered=False))
            continue
        # local continuum: straight line through the points just outside the window (0.5 um each side,
        # outside every window); the global dust model only when one side has no point
        left = ~inwin & (lam < a) & (lam >= a - 0.5) & np.isfinite(R)
        right = ~inwin & (lam > b) & (lam <= b + 0.5) & np.isfinite(R)
        if left.any() and right.any():
            fl = left | right
            A_ = np.stack([np.ones(fl.sum()), lam[fl] - (a + b) / 2], 1) / ER[fl, None]
            q, *_ = np.linalg.lstsq(A_, R[fl] / ER[fl], rcond=None)
            cov = np.linalg.pinv(A_.T @ A_)
            G = np.stack([np.ones(m.sum()), lam[m] - (a + b) / 2], 1)
            cont = G @ q
            var_cont = float(np.mean(G, 0) @ cov @ np.mean(G, 0))
            how = "local"
        else:
            cont = model[m]
            var_cont = 0.0
            how = "global"
        wi = 1 / ER[m] ** 2
        ex = float(np.sum((R[m] - cont) * wi) / np.sum(wi))
        ee = float(scale * math.sqrt(1 / np.sum(wi) + var_cont))
        sig = ex / ee
        feats.append(dict(name=name, name_tr=FEATURE_TR.get(name), lo=a, hi=b, n=int(m.sum()), covered=True,
                          excess=ex, err=ee, sigma=sig, continuum=how, ratio_to_continuum=float(np.mean(R[m] / cont)),
                          significant=bool(abs(sig) >= 5 and m.sum() >= 2 and how == "local")))
    order = np.argsort(lam)
    return dict(n=int(lam.size), season=[utc(big[0])[:10], utc(big[-1])[:10]], r_au=r0, delta_au=d0,
                t_dust_k=tdust, norm_ujy_over_bnu=norm, chi2r_continuum=chi2r, chi2r_reflected=chi2r_refl, slope_per_um=float(p[1] / p[0]) if p[0] else None,
                thermal_scale=float(p[2]),
                points=[dict(lam=float(lam[i]), refl=float(R[i]), err=float(ER[i]), flux_ujy=float(F[i]),
                             flux_err_ujy=float(E[i]), model=float(model[i]), det=pts[i]["det"],
                             sigma=float((R[i] - model[i]) / (ER[i] * scale))) for i in order],
                error_scale=scale, sys_frac=sysf,
                features=feats, note="flux in a 12.3\" radius aperture, star-subtracted; divided by a 5778 K "
                                     "blackbody for the Sun and normalised at 1.0-1.6 um; 5 % systematic per point")


# ------------------------------------------------------------------------------------------ one object
def products(pdes, site=False):
    runs = load_runs(pdes)
    info = INFO.get(pdes, dict(name=pdes, folder=C.safe(pdes), kind="comet", en="", tr=""))
    base = (C.OUT_SITE if site else C.CACHE / "products") / info["folder"]
    base.mkdir(parents=True, exist_ok=True)
    det = [r for r in runs if detected(r)]
    offs = np.array([r["fit"]["off"] for r in det]) if det else np.zeros(0)
    snrs = [phot(r)[0]["snr"] for r in runs if phot(r)[0]]
    S = seasons([r["mjd"] for r in runs])
    Sd = seasons([r["mjd"] for r in det]) if det else []
    T = [r["pred"]["T"] for r in runs if np.isfinite(r["pred"]["T"])]
    out = dict(pdes=pdes, name=info["name"], kind=info["kind"], sentence=info["en"], sentence_tr=info["tr"],
               generated=time.strftime("%Y-%m-%d %H:%M"),
               n_exposures=len(runs), n_detected=len(det), n_seasons=len(S), n_seasons_detected=len(Sd),
               seasons=[dict(start=utc(s[0])[:10], end=utc(s[-1])[:10], n=len(s)) for s in S],
               detectors=sorted(set(r["det"] for r in det)),
               lam_range_um=[min(r["lam_um"] for r in det), max(r["lam_um"] for r in det)] if det else None,
               T_mag_horizons=[float(min(T)), float(max(T))] if T else None,
               r_au=[float(min(r["pred"]["r"] for r in runs)), float(max(r["pred"]["r"] for r in runs))],
               delta_au=[float(min(r["pred"]["delta"] for r in runs)), float(max(r["pred"]["delta"] for r in runs))],
               snr_median=float(np.median([s for s in snrs if s is not None])) if snrs else None,
               snr_max=float(max(s for s in snrs if s is not None)) if snrs else None,
               offset_arcsec=dict(median=float(np.median(offs)), p90=float(np.percentile(offs, 90)), max=float(offs.max()),
                                  median_east=float(np.median([r["fit"]["off_e"] for r in det])),
                                  median_north=float(np.median([r["fit"]["off_n"] for r in det]))) if det else None,
               flux_ujy_median=float(np.median([phot(r)[0]["flux_ujy"] for r in det])) if det else None,
               rate_ephem_arcsec_h=float(np.median([math.hypot(r["pred"]["rate_ra"], r["pred"]["rate_dec"]) for r in runs])),
               motion=motion(runs))
    out["blink"] = make_blink(pdes, runs, base)
    out["stack"] = make_stack(pdes, runs, base)
    out["coma"] = coma_test(runs)
    out["spectrum"] = spectrum(runs, PLUTO_FEATURES, thermal=False, point=True) if pdes == "pluto" else spectrum(runs)
    out["measurements"] = [dict(utc=utc(r["mjd"]), mjd=r["mjd"], obs_id=r["obs_id"], det=r["det"], lam_um=r.get("lam_um"),
                                T=r["pred"]["T"], snr=(phot(r)[0] or {}).get("snr"), flux_ujy=(phot(r)[0] or {}).get("flux_ujy"),
                                flux_err_ujy=(phot(r)[0] or {}).get("err_ujy"), centre=phot(r)[1],
                                off_arcsec=r["fit"]["off"] if detected(r) else None, n_ref=r.get("n_ref"),
                                key=r["key"]) for r in runs]
    (base / "data.json").write_text(json.dumps(jd(out), indent=1))
    log(f"{pdes}: {len(runs)} exposures, {len(det)} detected, offsets median "
        f"{out['offset_arcsec']['median'] if det else float('nan'):.2f}\" -> {base}")
    return out


def reject_reason(pdes, v):
    """Why a candidate is not shown, from what was measured (EN, TR)."""
    d = C.RUNS / C.safe(pdes)
    tried = [json.loads(p.read_text()) for p in d.glob("*.json")] if d.exists() else []
    tried = [r for r in tried if not r.get("skip")]
    if tried:
        snr = []
        for r in tried:
            f, how = phot(r)
            snr.append((f or {}).get("snr") or 0.0 if how == "fit" else 0.0)
        k = sum(s >= SNR_DET for s in snr)
        med = float(np.median([((phot(r)[0] or {}).get("snr") or 0.0) for r in tried]))
        if k == 0:
            return (f"read {len(tried)} images: not detected (median S/N {med:.1f}); JPL magnitude too optimistic",
                    f"{len(tried)} görüntü okundu: görülmedi (ortanca S/N {med:.1f}); JPL kadiri fazla iyimser")
        return (f"read {len(tried)} images: {k} clear detections (median S/N {med:.0f}); weaker or less clear than the ones shown",
                f"{len(tried)} görüntü okundu: {k} açık tespit (ortanca S/N {med:.0f}); gösterilenlerden daha zayıf ya da daha az net")
    if (v.get("Tmin") or 99) > 16.0:
        return (f"JPL magnitude {v['Tmin']:.1f} or fainter in every image: too faint for a clear example",
                f"her görüntüde JPL kadiri {v['Tmin']:.1f} ya da daha sönük: açık bir örnek için çok sönük")
    return ("not read: ranked below the comets shown (JPL magnitude, number of images)",
            "okunmadı: gösterilen kuyruklu yıldızların gerisinde (JPL kadiri, görüntü sayısı)")


def summary(objs, site=False):
    L = C.ledger()
    sel = json.loads((C.CACHE / "precise_summary.json").read_text())
    base = C.OUT_SITE if site else C.CACHE / "products"
    out = dict(generated=time.strftime("%Y-%m-%d %H:%M"), objects=[], candidates=[],
               bytes=dict(s3=L["s3_bytes"], s3_requests=L["s3_requests"], horizons=L["horizons_bytes"]))
    for pdes in objs:
        p = base / INFO[pdes]["folder"] / "data.json"
        if p.exists():
            d = json.loads(p.read_text())
            out["objects"].append(dict(pdes=pdes, folder=INFO[pdes]["folder"], name=d["name"], kind=d["kind"]))
    for k, v in sorted(sel.items(), key=lambda kv: kv[1].get("Tmin") or 99):
        if "error" in v or k == "pluto":
            continue
        row = dict(pdes=k, name=v["name"], n_images=v["n"], T_min=v["Tmin"], n_seasons=len(v["seasons"]), chosen=k in objs)
        if not row["chosen"]:
            row["reason"], row["reason_tr"] = reject_reason(k, v)
        out["candidates"].append(row)
    (base / "summary.json").write_text(json.dumps(jd(out), indent=1))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--comet", required=True)
    r.add_argument("--n", type=int, default=60)
    r.add_argument("--tmax", type=float, default=None)
    r.add_argument("--from-mjd", type=float, default=None)
    r.add_argument("--to-mjd", type=float, default=None)
    p = sub.add_parser("products")
    p.add_argument("--comet", required=True, action="append")
    p.add_argument("--site", action="store_true")
    w = sub.add_parser("fill", help="add exposures whose wavelength falls in the feature windows")
    w.add_argument("--comet", required=True)
    w.add_argument("--from-mjd", type=float, required=True)
    w.add_argument("--to-mjd", type=float, required=True)
    w.add_argument("--n", type=int, default=4)
    w.add_argument("--pluto", action="store_true", help="use the CH4 windows")
    s = sub.add_parser("summary")
    s.add_argument("--comet", required=True, action="append")
    s.add_argument("--site", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "run":
        C.run(a.comet, n_max=a.n, t_max=a.tmax,
              only_mjd=(a.from_mjd, a.to_mjd) if a.from_mjd is not None else None)
    elif a.cmd == "products":
        for c in a.comet:
            products(c, site=a.site)
    elif a.cmd == "fill":
        feats = PLUTO_FEATURES if a.pluto else FEATURES
        wins = [(lo, hi) for _, lo, hi in feats]
        if a.pluto:                       # plus the continuum on both sides of the methane bands
            wins += [(1.20, 1.70), (1.81, 2.08), (2.45, 2.95)]
        C.fill_windows(a.comet, wins, (a.from_mjd, a.to_mjd), a.n)
    elif a.cmd == "summary":
        summary(a.comet, site=a.site)


def results_md(objs, site=True):
    """Markdown results table (for pipeline/COMETS.md) from the written data.json files."""
    base = C.OUT_SITE if site else C.CACHE / "products"
    L = C.ledger()
    rows = ["| object | exposures (detected) | dates | JPL T-mag | r / Δ (AU) | S/N median | offset median / p90 | rate JPL → measured | coma | spectral bands named (σ) |",
            "|---|---|---|---|---|---|---|---|---|---|"]
    for pdes in objs:
        p = base / INFO[pdes]["folder"] / "data.json"
        if not p.exists():
            continue
        d = json.loads(p.read_text())
        m, c, o = d.get("motion") or {}, d.get("coma") or {}, d.get("offset_arcsec") or {}
        sp = d.get("spectrum") or {}
        named = ", ".join(f"{f['name']} {f['sigma']:.0f}" for f in sp.get("features", []) if f.get("significant")) or "none"
        dates = "; ".join(f"{s['start']}–{s['end']} ({s['n']})" for s in d["seasons"])
        rows.append(f"| {d['name']} | {d['n_exposures']} ({d['n_detected']}) | {dates} | {d['T_mag_horizons'][0]:.1f}–{d['T_mag_horizons'][1]:.1f} | "
                    f"{d['r_au'][0]:.2f} / {d['delta_au'][0]:.2f} | {d['snr_median']:.0f} | {o.get('median', float('nan')):.2f}″ / {o.get('p90', float('nan')):.2f}″ | "
                    f"{m.get('speed_ephem', d['rate_ephem_arcsec_h']):.1f}″/h → {m.get('speed_measured', float('nan')):.1f}″/h ({100 * m.get('speed_diff_frac_median', float('nan')):+.3f} %) | "
                    f"{'yes' if c.get('extended') else 'no'} ({c.get('significance_sigma', float('nan')):.1f}σ) | {named} |")
    rows.append("")
    rows.append(f"S3 data read (byte ranges, payload): {L['s3_bytes'] / 1e6:.1f} MB in {L['s3_requests']} requests; "
                f"Horizons answers during the runs: {L['horizons_bytes'] / 1e6:.1f} MB.")
    return "\n".join(rows)
