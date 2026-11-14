#!/usr/bin/env python3
"""SPHEREx blink pipeline (Fazari, NASA Space Apps 2026, "Planet X and SPHEREx").

Builds aligned, stacked, identically stretched blink frames of one sky patch at several
epochs and measures the target's motion.

Usage (from the fazari/ folder):
  uv run --no-project --with astropy --with reproject --with numpy --with scipy \
      --with matplotlib --with pillow python -I pipeline/blink.py barnard

Inputs (read only):
  pipeline/targets.json                  target catalog (Gaia ra/dec/pm, epoch)
  pipeline/targets_extra.json            parallax per target
  <data>/<target>/liste_{dr1,qr3}.csv    IRSA SIA listing (t_min, bandpass ...)
  <data>/<target>/{dr1,qr3}/*.fits       SPHEREx L2 cutouts (0.2 deg), from pipeline/download.py
  <data> = env FAZARI_DATA, else ../veri/real_spherex next to the repo if it exists, else <repo>/raw
Outputs (<out> = env FAZARI_OUT, else <repo>/site/data):
  <out>/<target>/frames/<YYYY-MM>_<lam>um.png, blink_<lam>um.gif, diff_<lam>um.png,
  images.csv (per exposure diagnostics), meta.json (read by the web site)

Re-running is safe: files that are still downloading (*.part) are ignored, newly arrived
cutouts are picked up, outputs are overwritten in place (nothing is deleted).
"""
import csv
import json
import math
import os
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from astropy.coordinates import get_body_barycentric
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS, FITSFixedWarning
from PIL import Image, ImageDraw, ImageFont
from reproject import reproject_interp
from scipy.optimize import least_squares
from scipy.special import erf

warnings.simplefilter("ignore", FITSFixedWarning)
warnings.simplefilter("ignore", RuntimeWarning)
import logging
logging.getLogger("astropy").setLevel(logging.WARNING)  # quiet the SIP INFO of the 'W' WCS

ROOT = Path(__file__).resolve().parent.parent              # fazari/
PIPE = Path(__file__).resolve().parent                     # fazari/pipeline/


def _data_dir():
    """env FAZARI_DATA, else ../veri/real_spherex next to the repo if present, else <repo>/raw."""
    env = os.environ.get("FAZARI_DATA")
    if env:
        return Path(env).expanduser().resolve()
    sibling = ROOT.parent / "veri" / "real_spherex"
    return sibling if sibling.is_dir() else ROOT / "raw"


DATA = _data_dir()
OUT = (Path(os.environ["FAZARI_OUT"]).expanduser().resolve() if os.environ.get("FAZARI_OUT")
       else ROOT / "site" / "data")
COLLECTIONS = ["dr1", "qr3"]

# ---- parameters (short reasons) -------------------------------------------------------
EPOCH_CENTER = 2026.0       # grid centre = target position at 2026.0 (fixed sky point)
PIX_ARCSEC = 3.0            # output grid ~half the native 6.15" -> sub-pixel shifts show up
FOV_DEG = 0.15              # 180 x 180 output pixels
UPSCALE = 4                 # nearest-neighbour enlargement for the PNG/GIF
EPOCH_GAP_DAYS = 30         # gap that separates observing seasons
# Wavelength bins: centres in micron, +-6 % tolerance. SPHEREx resolving power is ~40 at
# 0.75-2.4 um (one spectral element = 2.5 %), so +-6 % is ~5 spectral elements: wide enough
# to stack several exposures per season, narrow enough that the star's colour (and the
# PSF) is about the same in every epoch of a bin.
BIN_CENTERS = [1.0, 1.5, 2.0, 3.0, 4.0, 4.6]
BIN_TOL = 0.06
MIN_EPOCHS = 2              # a bin is published only if >= 2 epochs have frames in it
# Centroid of the (saturated) target. Tested on Barnard DR1 (2025-08 vs 2026-03):
#  - Gaussian on unflagged wing pixels: smallest scatter per exposure (~0.5")  <- default
#  - also using OVERFLOW/SUR_ERROR-flagged finite pixels: 2-3x larger scatter
#  - SPHEREx EPSF table fit: reduced chi2 ~60 (the ePSF is built from unsaturated stars and
#    does not describe a bloomed, saturated core), larger scatter -> kept only as option.
# All variants leave a ~0.5-1" bias fixed in DETECTOR axes. SPHEREx turns 180 deg between
# the August and March seasons, so that bias flips sign on the sky; comparing two seasons
# with the SAME orientation (Aug 2025 vs Aug 2026) cancels it (see "pairs" in meta.json).
FIT_USE_SAT_FLAGGED = False
CENTROID = "gauss"          # "gauss" (default) or "epsf"
EDGE_PX = 6                 # target must be this far (native px) from the cutout edge
PIX_NATIVE = 6.15           # SPHEREx native pixel (arcsec), only to report the bias in arcsec

# FLAGS bits (from MSKNnnnn header keywords, same in all files)
B = {n: 1 << b for n, b in dict(TRANSIENT=0, OVERFLOW=1, SUR_ERROR=2, NONFUNC=6, DICHROIC=7,
                                 MISSING_DATA=9, HOT=10, COLD=11, NONLINEAR=15, PERSIST=17,
                                 OUTLIER=19, STREAK=25, BLOOM=26, SNOWBALL=27).items()}
# Saturation: bright stars overflow; the pipeline sets the core to NaN and flags OVERFLOW /
# SUR_ERROR (/ NONLINEAR). Those pixels are *marked* (white in the PNG), not thrown away.
SAT_BITS = B["OVERFLOW"] | B["SUR_ERROR"] | B["NONLINEAR"]
# Bad pixels -> NaN (only where the pixel is not a saturated-star pixel, because bright
# star cores also carry TRANSIENT/OUTLIER). Median stacking removes what is left.
BAD_BITS = (B["TRANSIENT"] | B["NONFUNC"] | B["MISSING_DATA"] | B["HOT"] | B["COLD"]
            | B["PERSIST"] | B["OUTLIER"] | B["STREAK"] | B["SNOWBALL"])


# ---- astrometry helpers ---------------------------------------------------------------
def target_position(t, mjd, with_parallax=True):
    """Gaia position moved to time mjd: linear proper motion (+ annual parallax).
    Parallax factors use the Earth's barycentric position (SPHEREx is in low Earth orbit,
    7000 km is negligible). Aberration is not added: the SPHEREx WCS is fitted to Gaia
    stars in the same image, so it is already removed."""
    tt = Time(mjd, format="mjd")
    dt = tt.jyear - t["epoch"]
    cosd = math.cos(math.radians(t["dec"]))
    dra = t["pmra"] * dt                       # mas, along RA*cos(dec)
    ddec = t["pmdec"] * dt
    plx = t.get("plx", 0.0)
    if with_parallax and plx:
        e = get_body_barycentric("earth", tt).xyz.to_value("AU")
        a, d = math.radians(t["ra"]), math.radians(t["dec"])
        dra += plx * (e[0] * math.sin(a) - e[1] * math.cos(a))
        ddec += plx * (e[0] * math.cos(a) * math.sin(d) + e[1] * math.sin(a) * math.sin(d)
                       - e[2] * math.cos(d))
    return (t["ra"] + dra / 3.6e6 / cosd) % 360.0, t["dec"] + ddec / 3.6e6


def offset_arcsec(ra1, dec1, ra2, dec2):
    """Small-angle offset (east, north) in arcsec from point 1 to point 2, and PA (deg E of N)."""
    de = (ra2 - ra1) * math.cos(math.radians(0.5 * (dec1 + dec2))) * 3600
    dn = (dec2 - dec1) * 3600
    return de, dn, math.hypot(de, dn), math.degrees(math.atan2(de, dn)) % 360


def gauss_model(p, xx, yy):
    """Pixel-integrated circular Gaussian (the 6.15" pixels undersample the ~7" PSF)."""
    amp, x0, y0, s, bg = p
    r2 = math.sqrt(2) * s
    fx = 0.5 * (erf((xx + 0.5 - x0) / r2) - erf((xx - 0.5 - x0) / r2))
    fy = 0.5 * (erf((yy + 0.5 - y0) / r2) - erf((yy - 0.5 - y0) / r2))
    return amp * fx * fy + bg


def centroid_epsf(img, var, ok, x0, y0, psf, ovs=5, half=4):
    """Fit the SPHEREx empirical PSF (from the EPSF extension) to the unsaturated pixels.
    Better than a Gaussian here: the core of Barnard's Star is saturated (NaN), so the
    centre is set by the wings, and their real (asymmetric) shape matters."""
    from scipy.ndimage import map_coordinates
    c = (psf.shape[0] - 1) / 2
    ix, iy = int(round(x0)), int(round(y0))
    ys, xs = slice(iy - half, iy + half + 1), slice(ix - half, ix + half + 1)
    sub, sv, so = img[ys, xs], var[ys, xs], ok[ys, xs]
    yy, xx = np.mgrid[ys, xs]
    m = so & np.isfinite(sub) & np.isfinite(sv)
    if m.sum() < 20:
        return None
    d, xx, yy = sub[m], xx[m].astype(float), yy[m].astype(float)
    err = np.sqrt(np.clip(sv[m], 1e-6, None) + (0.05 * np.abs(d)) ** 2)

    def model(p):
        f, xc, yc, bg = p
        u = c + ovs * (xx - xc)
        v = c + ovs * (yy - yc)
        return f * map_coordinates(psf, [v, u], order=3, mode="constant", cval=0.0) + bg

    peak = psf.max()
    p0 = [max(np.nanmax(d), 1.0) / peak * 3, x0, y0, 0.0]
    lo, hi = [0, x0 - 2.5, y0 - 2.5, -np.inf], [np.inf, x0 + 2.5, y0 + 2.5, np.inf]
    best = None
    for dx in (-0.5, 0, 0.5):                    # a few starts: cubic PSF interpolation is bumpy
        for dy in (-0.5, 0, 0.5):
            q = list(p0); q[1] += dx; q[2] += dy
            try:
                r = least_squares(lambda p: (model(p) - d) / err, q, bounds=(lo, hi), x_scale="jac")
            except Exception:
                continue
            if r.success and (best is None or r.cost < best.cost):
                best = r
    if best is None or abs(best.x[1] - x0) > 2.4 or abs(best.x[2] - y0) > 2.4:
        return None
    return float(best.x[1]), float(best.x[2]), float(2 * best.cost / max(m.sum() - 4, 1)), int(m.sum())


def centroid(img, var, ok, x0, y0, half=5):
    """Fit the star in native pixels. The saturated core is NaN, so the fit uses the wings
    (a symmetric model still pins the centre). Returns (x, y, sigma, npix) or None."""
    ix, iy = int(round(x0)), int(round(y0))
    ys, xs = slice(iy - half, iy + half + 1), slice(ix - half, ix + half + 1)
    sub, sv, so = img[ys, xs], var[ys, xs], ok[ys, xs]
    yy, xx = np.mgrid[ys, xs]
    m = so & np.isfinite(sub) & np.isfinite(sv)
    if m.sum() < 25:
        return None
    d, xx, yy = sub[m], xx[m].astype(float), yy[m].astype(float)
    # noise: variance map + 5 % model error (Gaussian is only an approximation of the PSF)
    err = np.sqrt(np.clip(sv[m], 1e-6, None) + (0.05 * np.abs(d)) ** 2)
    nsat = int(np.sum(~np.isfinite(sub)))
    amp0 = max(np.nanmax(d), 1.0) * (6.0 if nsat else 2.0)
    p0 = [amp0, x0, y0, 0.6, float(np.median(d))]
    lo = [0, x0 - 2.5, y0 - 2.5, 0.25, -np.inf]
    hi = [np.inf, x0 + 2.5, y0 + 2.5, 3.0, np.inf]
    try:
        r = least_squares(lambda p: (gauss_model(p, xx, yy) - d) / err, p0,
                          bounds=(lo, hi), x_scale="jac")
    except Exception:
        return None
    if not r.success or np.any(np.isclose(r.x[1:3], lo[1:3])) or np.any(np.isclose(r.x[1:3], hi[1:3])):
        return None
    return float(r.x[1]), float(r.x[2]), float(r.x[3]), int(m.sum())


# ---- reading --------------------------------------------------------------------------
def load_target(name):
    cat = json.loads((PIPE / "targets.json").read_text())
    if name not in cat or name.startswith("_"):
        sys.exit(f"unknown target {name}; options: {[k for k in cat if not k.startswith('_')]}")
    t = dict(cat[name])
    # Parallax is not in targets.json (shared with the download step), so it comes from
    # pipeline/targets_extra.json. targets.json wins if it ever carries "plx".
    # Missing everywhere -> 0 (no parallax term) with a warning.
    extra_p = PIPE / "targets_extra.json"
    extra = json.loads(extra_p.read_text()).get(name, {}) if extra_p.exists() else {}
    for k, v in extra.items():
        t.setdefault(k, v)
    if "plx" not in t:
        print(f"WARNING: no parallax for {name}; Gaia prediction uses proper motion only")
        t["plx"] = 0.0
    return t


def listing(name):
    rows = {}
    for col in COLLECTIONS:
        p = DATA / name / f"liste_{col}.csv"
        if not p.exists():
            continue
        with open(p, newline="") as f:
            for r in csv.DictReader(f):
                url = r.get("access_url", "")
                if url.endswith(".fits"):
                    rows[url.rsplit("/", 1)[-1]] = dict(r, collection=col)
    return rows


def read_exposure(path, t):
    """Per exposure: header info, target pixel, wavelength at that pixel, cleaned image."""
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        img = h["IMAGE"].data.astype(np.float64)
        flg = h["FLAGS"].data.astype(np.int64)
        var = h["VARIANCE"].data.astype(np.float64)
        zodi = h["ZODI"].data.astype(np.float64)
        wcs = WCS(hd)
        # Spectral WCS exactly as in the IRSA tutorials: key 'W' lookup table, SIP off.
        # In cutouts CRPIX1W/2W are shifted by the cutout origin (same as CRPIX1A/2A), so
        # cutout pixel coordinates can be passed directly.
        swcs = WCS(hd, fobj=h, key="W")
        swcs.sip = None
        mjd = float(hd.get("MJD-AVG", hd["MJD-OBS"]))
        # sky angle of the detector x axis (deg): tells which seasons share an orientation
        orient = math.degrees(math.atan2(hd["PC2_1"], hd["PC1_1"])) % 360
        epsf_tab = h["EPSF"].data
        epsf_ovs = int(h["EPSF"].header.get("OVSMPX", 5))
        # cutout pixel -> full detector pixel (alternate WCS 'A' = 0-based active pixels)
        det_off = (1 - hd.get("CRPIX1A", 1.0), 1 - hd.get("CRPIX2A", 1.0))
        ra, dec = target_position(t, mjd)
        x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
        lam, bw = (float(v) for v in swcs.pixel_to_world_values(x, y))
    ny, nx = img.shape
    inside = EDGE_PX <= x <= nx - 1 - EDGE_PX and EDGE_PX <= y <= ny - 1 - EDGE_PX
    ix, iy = int(round(x)), int(round(y))
    f_at = int(flg[iy, ix]) if 0 <= ix < nx and 0 <= iy < ny else -1
    sat = (flg & SAT_BITS) != 0
    bad = ((flg & BAD_BITS) != 0) & ~sat
    clean = img - zodi                              # remove zodiacal light model
    clean[bad] = np.nan
    good = np.isfinite(clean) & ~sat
    clean -= np.nanmedian(clean[good])              # residual offset (crowded field: median)
    info = dict(file=path.name, mjd=mjd, date=Time(mjd, format="mjd").iso[:10],
                detector=f"D{int(hd['DETECTOR'])}", x=x, y=y, wavelength_um=lam,
                bandwidth_um=bw, inside=inside, flags_at_target=f_at,
                saturated=bool(f_at >= 0 and f_at & SAT_BITS), ra_pred=ra, dec_pred=dec,
                orient_deg=orient)
    # astrometry in native pixels (no interpolation)
    ok = ~bad if FIT_USE_SAT_FLAGGED else ~bad & ~sat
    c = None
    if inside and CENTROID == "epsf":
        k = np.argmin((epsf_tab["XCENTER"] - (x + det_off[0])) ** 2 + (epsf_tab["YCENTER"] - (y + det_off[1])) ** 2)
        c = centroid_epsf(clean, var, ok, x, y, np.asarray(epsf_tab["EPSF"][k], float), epsf_ovs)
        method = "epsf"
    elif inside:
        c = centroid(clean, var, ok, x, y)
        method = "gauss"
    if c:
        rr, dd = (float(v) for v in wcs.all_pix2world(c[0], c[1], 0))
        # local Jacobian d(east, north)/d(x, y) in arcsec per pixel: turns a detector-frame
        # centroid bias into a sky offset for this exposure (used by the joint fit)
        r1, d1 = (float(v) for v in wcs.all_pix2world(c[0] + 1, c[1], 0))
        r2, d2 = (float(v) for v in wcs.all_pix2world(c[0], c[1] + 1, 0))
        jx, jy = offset_arcsec(rr, dd, r1, d1)[:2], offset_arcsec(rr, dd, r2, d2)[:2]
        info.update(x_fit=c[0], y_fit=c[1], fit_quality=c[2], fit_npix=c[3], ra_fit=rr, dec_fit=dd,
                    fit_method=method, jac=[[jx[0], jy[0]], [jx[1], jy[1]]])
    nanmap = ~np.isfinite(clean)
    return info, clean, sat.astype(float), wcs, nanmap


# ---- grouping ---------------------------------------------------------------------------
def split_epochs(mjds):
    """Group sorted dates into seasons separated by > EPOCH_GAP_DAYS."""
    order = sorted(set(mjds))
    if not order:
        sys.exit("no cutout contains the target (all outside / too close to the edge); "
                 "check the target position or wait for the download")
    groups, cur = [], [order[0]]
    for m in order[1:]:
        if m - cur[-1] > EPOCH_GAP_DAYS:
            groups.append(cur)
            cur = []
        cur.append(m)
    groups.append(cur)
    out = {}
    for g in groups:
        label = Time(float(np.median(g)), format="mjd").datetime.strftime("%Y-%m")
        for m in g:
            out[m] = label
    return out


def which_bin(lam):
    best = min(BIN_CENTERS, key=lambda c: abs(lam / c - 1))
    return best if abs(lam / best - 1) <= BIN_TOL else None


# ---- images -----------------------------------------------------------------------------
def make_grid(ra, dec):
    n = int(round(FOV_DEG * 3600 / PIX_ARCSEC))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-PIX_ARCSEC / 3600, PIX_ARCSEC / 3600]
    return w, (n, n)


def stretch(a, lo, hi, soft):
    """asinh stretch to 0..1 with fixed limits (shared by all epochs of a bin)."""
    return np.clip(np.arcsinh((a - lo) / soft) / np.arcsinh((hi - lo) / soft), 0, 1)


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


LABEL_PAD, LABEL_LH, LABEL_LINES = 6, 19, 2
LABEL_H = LABEL_PAD * 2 + LABEL_LH * LABEL_LINES   # black strip ABOVE the image (hides no sky)


def to_png(rgb, label_lines, path):
    sky = Image.fromarray(rgb).resize((rgb.shape[1] * UPSCALE, rgb.shape[0] * UPSCALE), Image.NEAREST)
    im = Image.new("RGB", (sky.width, sky.height + LABEL_H), (0, 0, 0))
    im.paste(sky, (0, LABEL_H))
    d = ImageDraw.Draw(im)
    f = font(15)
    for i, s in enumerate(label_lines[:LABEL_LINES]):
        d.text((LABEL_PAD + 2, LABEL_PAD + i * LABEL_LH), s, fill=(255, 255, 255), font=f)
    im.save(path, optimize=True)
    return im


def clean_satmask(m, min_px=4):
    """Drop saturated blobs smaller than min_px output pixels: one native 6.15" pixel covers
    ~4 grid pixels, so 1-3 pixel 'blobs' are only edge effects of the bilinear resampling
    (they showed up as lone white dots on medium-bright stars)."""
    from scipy.ndimage import label
    lab, n = label(m)
    if n == 0:
        return m
    sizes = np.bincount(lab.ravel())
    keep = sizes >= min_px
    keep[0] = False
    return keep[lab]


def fill_nan(a, it=20):
    """Fill missing pixels for display only, from the mean of their valid neighbours
    (a bad pixel next to the star gets star-like brightness, not a black hole)."""
    from scipy.ndimage import uniform_filter
    a = a.copy()
    for _ in range(it):
        m = ~np.isfinite(a)
        if not m.any():
            break
        v = np.where(m, 0, a)
        w = uniform_filter((~m).astype(float), 3)
        s = uniform_filter(v, 3)
        a[m & (w > 0)] = (s / np.where(w > 0, w, 1))[m & (w > 0)]
    a[~np.isfinite(a)] = 0.0
    return a


def gray_rgb(s, satmask):
    """Stretched image -> RGB. Saturated core = white, other missing pixels filled."""
    s = s.copy()
    s[satmask] = 1.0
    s = fill_nan(s)
    g = (np.flipud(s) * 255).astype(np.uint8)          # flip: north up in the PNG
    return np.dstack([g, g, g])


def diverging_rgb(d, lim):
    import matplotlib
    cmap = matplotlib.colormaps["RdBu_r"]
    v = np.clip((d / lim + 1) / 2, 0, 1)
    rgba = cmap(np.nan_to_num(v, nan=0.5))
    rgba[~np.isfinite(d)] = (0.5, 0.5, 0.5, 1)
    return (np.flipud(rgba[..., :3]) * 255).astype(np.uint8)


# ---- astrometry ---------------------------------------------------------------------------
def joint_fit(t, s, ra_c, dec_c):
    """Joint linear fit over all exposures (east/north tangent offsets from the grid centre):
        meas_i = P0 + pm * (t_i - EPOCH_CENTER) + parallax_i(Gaia, fixed) + J_i @ b_det
    b_det = a centroid bias fixed in DETECTOR pixels, one per detector. It comes from the
    saturated core: only the (asymmetric) PSF wings are fitted. Tested: a symmetric pixel
    mask does not remove it, a bigger fit box makes it larger, so it is PSF shape, not
    masking. J_i (pixel -> arcsec) flips sign when SPHEREx turns 180 deg between the August
    and March seasons, which is what separates b_det from the sky position. A detector gets
    a bias term only if it saw the target in both orientations. The parallax is fixed to
    the catalogue value (3 seasons cannot also constrain it). The proper motion is FREE, so
    it is a measurement; but the March season is then used up calibrating b_det, i.e. pairs
    involving March agree with the model by construction. Independent test = the
    same-orientation pair (Aug 2025 -> Aug 2026), where b_det cancels."""
    cosc = math.cos(math.radians(dec_c))
    rows, ys, dets = [], [], []
    for i in s:
        E, N = offset_arcsec(ra_c, dec_c, i["ra_fit"], i["dec_fit"])[:2]
        pm_only = target_position(t, i["mjd"], with_parallax=False)
        full = target_position(t, i["mjd"])
        pE, pN = offset_arcsec(*pm_only, *full)[:2]
        i["_tyr"] = Time(i["mjd"], format="mjd").jyear - EPOCH_CENTER
        i["_y"] = (E - pE, N - pN)
    # detectors with both orientations
    by_det = {}
    for i in s:
        by_det.setdefault(i["detector"], []).append(i["orient_deg"])
    for d, o in sorted(by_det.items()):
        z = np.exp(1j * np.radians(o))
        if np.abs(np.mean(z)) < 0.7:          # orientations spread (0 and 180 deg present)
            dets.append(d)
    tyr = np.array([i["_tyr"] for i in s])
    if tyr.max() - tyr.min() < 0.1:
        return None, {}
    npar = 4 + 2 * len(dets)
    for i in s:
        J = np.array(i["jac"])
        for comp in (0, 1):
            r = np.zeros(npar)
            r[comp] = 1.0
            r[2 + comp] = i["_tyr"]
            if i["detector"] in dets:
                k = 4 + 2 * dets.index(i["detector"])
                r[k:k + 2] = J[comp]
            rows.append(r)
            ys.append(i["_y"][comp])
    A, y = np.array(rows), np.array(ys)
    use = np.ones(len(s), bool)
    for _ in range(4):                          # 3.5 sigma clipping on the residual length
        w = np.repeat(use, 2)
        p, *_ = np.linalg.lstsq(A[w], y[w], rcond=None)
        res = (y - A @ p).reshape(-1, 2)
        rr = np.hypot(res[:, 0], res[:, 1])
        sig = 1.4826 * np.median(rr[use]) / 1.1774      # median of a 2D Rayleigh = 1.1774 sigma
        new = rr < 3.5 * sig
        if (new == use).all():
            break
        use = new
    w = np.repeat(use, 2)
    dof = max(w.sum() - npar, 1)
    s2 = float(np.sum((y[w] - A[w] @ p) ** 2) / dof)
    cov = s2 * np.linalg.inv(A[w].T @ A[w])
    err = np.sqrt(np.diag(cov))
    bias = {d: [round(float(p[4 + 2 * k]) * PIX_NATIVE, 3), round(float(p[5 + 2 * k]) * PIX_NATIVE, 3)]
            for k, d in enumerate(dets)}
    corr = {}
    for i, u in zip(s, use):
        db = (0.0, 0.0)
        if i["detector"] in dets:
            k = 4 + 2 * dets.index(i["detector"])
            db = tuple(np.array(i["jac"]) @ p[k:k + 2])
        corr[i["file"]] = (db, bool(u))
    P0 = (float(p[0]), float(p[1]))
    fit = {
        "pmra_mas_yr": round(float(p[2]) * 1000, 1), "pmdec_mas_yr": round(float(p[3]) * 1000, 1),
        "pmra_err_mas_yr": round(float(err[2]) * 1000, 1), "pmdec_err_mas_yr": round(float(err[3]) * 1000, 1),
        "gaia_pmra_mas_yr": t["pmra"], "gaia_pmdec_mas_yr": t["pmdec"],
        "pos_2026_minus_gaia_east_arcsec": round(P0[0], 3), "pos_2026_minus_gaia_north_arcsec": round(P0[1], 3),
        "parallax_fixed_mas": t["plx"],
        "detector_bias_arcsec_xy": bias,
        "n_used": int(use.sum()), "n_clipped": int((~use).sum()),
        "rms_per_exposure_arcsec": round(math.sqrt(s2), 3),
        "note": ("Joint fit of all exposures: position + free proper motion + catalogue parallax "
                 "+ one detector-fixed centroid bias per detector (saturated core, wing-only fit). "
                 "The March season calibrates the bias, so only the same-orientation pair is an "
                 "independent check."),
    }
    if not dets:
        fit["note"] = "No detector saw the target in two orientations: no bias term fitted."
    return fit, corr


def astrometry(t, infos, epochs, ra_c, dec_c, grid_xy):
    """Per-season positions of the target, bias-corrected via joint_fit, and season pairs."""
    sel = []
    for e in epochs:
        s = [i for i in infos if i["epoch"] == e and "ra_fit" in i]
        if not s:
            continue
        # robust: drop fits > 3 MAD from the season's median position
        ra = np.array([i["ra_fit"] for i in s]); dec = np.array([i["dec_fit"] for i in s])
        de = (ra - np.median(ra)) * math.cos(math.radians(t["dec"])) * 3600
        dn = (dec - np.median(dec)) * 3600
        r = np.hypot(de, dn)
        keep = r <= max(3 * 1.4826 * np.median(r), 0.5)
        sel.append((e, [i for i, k in zip(s, keep) if k], int((~keep).sum())))
    allkept = [i for _, s, _ in sel for i in s]
    fit, corr = joint_fit(t, allkept, ra_c, dec_c) if allkept else (None, {})

    positions = []
    for e, s, nrej in sel:
        if corr:
            nrej += sum(1 for i in s if not corr[i["file"]][1])
            s = [i for i in s if corr[i["file"]][1]]
        ra = np.array([i["ra_fit"] for i in s]); dec = np.array([i["dec_fit"] for i in s])
        cosd = math.cos(math.radians(t["dec"]))
        if corr:
            db = np.array([corr[i["file"]][0] for i in s])
            rac, decc = ra - db[:, 0] / 3600 / cosd, dec - db[:, 1] / 3600
        else:
            rac, decc = ra, dec
        mjd = float(np.mean([i["mjd"] for i in s]))
        pr = np.array([target_position(t, i["mjd"]) for i in s])
        pr_pm = np.array([target_position(t, i["mjd"], with_parallax=False) for i in s])
        de = (rac - rac.mean()) * cosd * 3600
        dn = (decc - decc.mean()) * 3600
        sig_e = float(np.std(de) / math.sqrt(len(s)))
        sig_n = float(np.std(dn) / math.sqrt(len(s)))
        rm, dm = float(rac.mean()), float(decc.mean())
        rr0, dr0 = float(ra.mean()), float(dec.mean())
        rp, dp = float(pr[:, 0].mean()), float(pr[:, 1].mean())
        res = offset_arcsec(rp, dp, rm, dm)
        res0 = offset_arcsec(rp, dp, rr0, dr0)
        ori = float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians([i["orient_deg"] for i in s])))))) % 360
        positions.append({"epoch": e, "ra": rm, "dec": dm, "bias_corrected": bool(corr),
                          "ra_raw": rr0, "dec_raw": dr0,
                          "mjd": round(mjd, 4), "orient_deg": round(ori, 1),
                          "date": Time(mjd, format="mjd").iso[:10], "n_images": len(s), "n_rejected": nrej,
                          "err_east_arcsec": round(sig_e, 3), "err_north_arcsec": round(sig_n, 3),
                          "gaia_ra": rp, "gaia_dec": dp,
                          "gaia_ra_pm_only": float(pr_pm[:, 0].mean()), "gaia_dec_pm_only": float(pr_pm[:, 1].mean()),
                          "minus_gaia_east_arcsec": round(res[0], 3), "minus_gaia_north_arcsec": round(res[1], 3),
                          "raw_minus_gaia_east_arcsec": round(res0[0], 3), "raw_minus_gaia_north_arcsec": round(res0[1], 3),
                          "png_xy_measured": [round(v, 1) for v in grid_xy(rm, dm)],
                          "png_xy_gaia": [round(v, 1) for v in grid_xy(rp, dp)]})
        print(f"  {e}: N={len(s)} (-{nrej})  measured-Gaia = {res[0]:+.2f}\" E {res[1]:+.2f}\" N "
              f"(raw {res0[0]:+.2f}, {res0[1]:+.2f})  (+-{sig_e:.2f}, {sig_n:.2f})")

    measured = {"positions": positions}
    if fit:
        measured["fit"] = fit
        print(f"  joint fit: pm = {fit['pmra_mas_yr']:+.0f} +- {fit['pmra_err_mas_yr']:.0f}, "
              f"{fit['pmdec_mas_yr']:+.0f} +- {fit['pmdec_err_mas_yr']:.0f} mas/yr "
              f"(Gaia {t['pmra']:+.0f}, {t['pmdec']:+.0f}); bias {fit['detector_bias_arcsec_xy']}")
    pairs = []
    for ia in range(len(positions)):
        for iz in range(ia + 1, len(positions)):
            a, z = positions[ia], positions[iz]
            m = offset_arcsec(a["ra"], a["dec"], z["ra"], z["dec"])
            m0 = offset_arcsec(a["ra_raw"], a["dec_raw"], z["ra_raw"], z["dec_raw"])
            g = offset_arcsec(a["gaia_ra"], a["gaia_dec"], z["gaia_ra"], z["gaia_dec"])
            same = abs((a["orient_deg"] - z["orient_deg"] + 180) % 360 - 180) < 20
            pairs.append({"from": a["epoch"], "to": z["epoch"], "same_orientation": same,
                          "independent": same, "headline": False,
                          "dt_years": round((z["mjd"] - a["mjd"]) / 365.25, 4),
                          "shift_arcsec": round(m[2], 3), "pa_deg": round(m[3], 2),
                          "raw_shift_arcsec": round(m0[2], 3), "raw_pa_deg": round(m0[3], 2),
                          "gaia_predicted_arcsec": round(g[2], 3), "gaia_pa_deg": round(g[3], 2)})
            print(f"  pair {a['epoch']} -> {z['epoch']} (same orientation: {same}): "
                  f"{m[2]:.2f}\" PA {m[3]:.1f} (raw {m0[2]:.2f}\" PA {m0[3]:.1f}) | Gaia {g[2]:.2f}\" PA {g[3]:.1f}")
    measured["pairs"] = pairs
    if len(positions) >= 2:
        # headline: longest same-orientation pair (independent of the bias model), else first->last
        nimg = {p["epoch"]: p["n_images"] for p in positions}
        same = [p for p in pairs if p["same_orientation"]
                and min(nimg[p["from"]], nimg[p["to"]]) >= 10]     # need a well-sampled season
        best = max(same, key=lambda p: p["dt_years"]) if same else pairs[len(positions) - 2]
        best["headline"] = True
        a = next(p for p in positions if p["epoch"] == best["from"])
        z = next(p for p in positions if p["epoch"] == best["to"])
        m = offset_arcsec(a["ra"], a["dec"], z["ra"], z["dec"])
        m0 = offset_arcsec(a["ra_raw"], a["dec_raw"], z["ra_raw"], z["dec_raw"])
        g = offset_arcsec(a["gaia_ra"], a["gaia_dec"], z["gaia_ra"], z["gaia_dec"])
        gp = offset_arcsec(a["gaia_ra_pm_only"], a["gaia_dec_pm_only"], z["gaia_ra_pm_only"], z["gaia_dec_pm_only"])
        dt_yr = (z["mjd"] - a["mjd"]) / 365.25
        measured.update({
            "from_epoch": a["epoch"], "to_epoch": z["epoch"], "dt_years": round(dt_yr, 4),
            "same_orientation": best["same_orientation"],
            "shift_arcsec": round(m[2], 3), "pa_deg": round(m[3], 2),
            "shift_east_arcsec": round(m[0], 3), "shift_north_arcsec": round(m[1], 3),
            "raw_shift_arcsec": round(m0[2], 3), "raw_pa_deg": round(m0[3], 2),
            "gaia_predicted_arcsec": round(g[2], 3), "gaia_pa_deg": round(g[3], 2),
            "gaia_predicted_pm_only_arcsec": round(gp[2], 3), "gaia_pa_pm_only_deg": round(gp[3], 2),
            "measured_pm_mas_yr": round(m[2] / dt_yr * 1000, 1),
            "method": ("pixel-integrated 2D Gaussian fit to the unsaturated wings in native "
                       "6.15\" pixels (saturated core excluded), converted with each exposure's "
                       "SIP WCS; per-detector centroid bias removed by the joint fit (see 'fit'); "
                       "season position = mean of the exposures after clipping. "
                       "Gaia prediction = proper motion + annual parallax (Earth barycentric)."),
        })
        print(f"shift {a['epoch']} -> {z['epoch']}: measured {m[2]:.2f}\" PA {m[3]:.1f} (raw {m0[2]:.2f}\" "
              f"PA {m0[3]:.1f})  |  Gaia {g[2]:.2f}\" PA {g[3]:.1f}  (pm only {gp[2]:.2f}\" PA {gp[3]:.1f})")
    return measured



# ---- main -------------------------------------------------------------------------------
def main(name):
    t = load_target(name)
    out = OUT / name
    (out / "frames").mkdir(parents=True, exist_ok=True)
    lst = listing(name)
    files = sorted(p for c in COLLECTIONS for p in (DATA / name / c).glob("*.fits")
                   if (DATA / name / c).exists())
    print(f"{t['name']}: {len(files)} cutouts on disk ({len(lst)} in IRSA listings)")
    ra_c, dec_c = target_position(t, Time(EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    grid, shape = make_grid(ra_c, dec_c)

    infos, stacks_in = [], []
    for p in files:
        try:
            info, clean, sat, wcs, _ = read_exposure(p, t)
        except Exception as e:                       # e.g. a file still being written
            print("  skip", p.name, e)
            continue
        row = lst.get(p.name, {})
        info["collection"] = p.parent.name
        info["obs_id"] = row.get("obs_id", "")
        if row.get("t_min"):
            info["t_min"] = float(row["t_min"])
        info["bin_um"] = which_bin(info["wavelength_um"])
        infos.append(info)
        if not info["inside"] or info["bin_um"] is None:
            continue
        img_r, _ = reproject_interp((clean, wcs), grid, shape_out=shape, order="bilinear")
        sat_r, _ = reproject_interp((sat, wcs), grid, shape_out=shape, order="bilinear")
        stacks_in.append((info, img_r.astype(np.float32), sat_r > 0.5))

    # epochs from all usable exposures (date = t_min from the listing, else header MJD)
    for i in infos:
        i["mjd_t"] = i.get("t_min", i["mjd"])
    ep = split_epochs([i["mjd_t"] for i in infos if i["inside"]])
    for i in infos:
        i["epoch"] = ep.get(i["mjd_t"], "")
    epochs = sorted(set(ep.values()))
    print("epochs:", epochs)

    # per-exposure table
    cols = ["file", "collection", "obs_id", "date", "mjd", "epoch", "detector", "wavelength_um",
            "bandwidth_um", "bin_um", "orient_deg", "x", "y", "inside", "flags_at_target", "saturated",
            "ra_pred", "dec_pred", "x_fit", "y_fit", "ra_fit", "dec_fit", "fit_method", "fit_quality", "fit_npix"]
    with open(out / "images.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for i in sorted(infos, key=lambda r: r["mjd"]):
            w.writerow({k: (f"{v:.7f}" if isinstance(v, float) else v) for k, v in i.items()})

    # bins valid in >= MIN_EPOCHS epochs
    groups = {}
    for info, img, sat in stacks_in:
        groups.setdefault((info["bin_um"], info["epoch"]), []).append((info, img, sat))
    bins = [b for b in BIN_CENTERS if sum((b, e) in groups for e in epochs) >= MIN_EPOCHS]
    print("valid wavelength bins:", bins)

    # predicted pixel of the target in the output grid (for the site to draw markers)
    def grid_xy(ra, dec):
        x, y = grid.all_world2pix(ra, dec, 0)
        return (float(x) * UPSCALE + UPSCALE / 2,
                LABEL_H + (shape[0] - 1 - float(y)) * UPSCALE + UPSCALE / 2)

    wbins = []
    for b in bins:
        eps = [e for e in epochs if (b, e) in groups]
        med = {}
        for e in eps:
            g = groups[(b, e)]
            med[e] = (np.nanmedian(np.stack([x[1] for x in g]), axis=0),
                      clean_satmask(np.mean(np.stack([x[2] for x in g]), axis=0) > 0.5))
        # shared stretch limits from all epochs of this bin
        allv = np.concatenate([m[0][np.isfinite(m[0])] for m in med.values()])
        mad = 1.4826 * np.median(np.abs(allv - np.median(allv)))
        lo = np.median(allv) - 1.5 * mad
        hi = np.percentile(allv, 99.97)          # keep the bright target's wings graded
        soft = 3 * mad
        frames, gif, normed = [], [], {}
        for e in eps:
            g = groups[(b, e)]
            img, satm = med[e]
            s = stretch(img, lo, hi, soft)
            normed[e] = fill_nan(np.where(satm, 1.0, s))
            dets = sorted({x[0]["detector"] for x in g})
            lam = float(np.median([x[0]["wavelength_um"] for x in g]))
            dmed = Time(float(np.median([x[0]["mjd"] for x in g])), format="mjd")
            d0 = min(x[0]["date"] for x in g)
            d1 = max(x[0]["date"] for x in g)
            fn = f"frames/{e}_{b:.1f}um.png"
            lines = [f"{d0} .. {d1}" if d0 != d1 else d0,
                     f"SPHEREx {'+'.join(dets)}  {lam:.2f} um  N={len(g)}"]
            gif.append(to_png(gray_rgb(s, satm), lines, out / fn))
            frames.append({"file": fn, "date": dmed.iso[:10], "epoch": e, "n_images": len(g),
                           "detectors": dets, "wavelength_um": round(lam, 3),
                           "date_first": d0, "date_last": d1,
                           "files": sorted(x[0]["file"] for x in g)})
        gname = f"blink_{b:.1f}um.gif"
        gif[0].save(out / gname, save_all=True, append_images=gif[1:], duration=800, loop=0)
        dname = f"diff_{b:.1f}um.png"
        diff = normed[eps[-1]] - normed[eps[0]]
        to_png(diverging_rgb(diff, 0.6), [f"{eps[-1]} minus {eps[0]}  {b:.1f} um",
                                          "red = later, blue = earlier"], out / dname)
        wbins.append({"wavelength_um": b, "gif": gname, "diff": dname,
                      "stretch": {"type": "asinh", "lo": float(lo), "hi": float(hi), "soft": float(soft),
                                  "unit": "MJy/sr (zodi subtracted)"},
                      "frames": frames})
        print(f"  {b:.1f} um: " + ", ".join(f"{f['epoch']} N={f['n_images']} {f['wavelength_um']}um"
                                             for f in frames))

    # ---- astrometry (motion targets) / brightness targets ----
    if t.get("kind", "motion") == "motion":
        measured = astrometry(t, infos, epochs, ra_c, dec_c, grid_xy)
    else:
        measured = {"positions": [], "pairs": [],
                    "note": "brightness target: no motion measurement (compare the frames' brightness)"}

    meta = {
        "target": t["name"], "ra": ra_c, "dec": dec_c, "epoch_center": EPOCH_CENTER,
        "grid": {"projection": "TAN", "pixel_arcsec": PIX_ARCSEC, "size_px": list(shape),
                 "upscale": UPSCALE, "png_px": [shape[1] * UPSCALE, shape[0] * UPSCALE + LABEL_H],
                 "label_strip_px": LABEL_H,
                 "north_up_east_left": True},
        "epochs": epochs,
        "wavelength_bins": wbins,
        "gaia": {"source_id": t.get("gaia_dr3"),
                 "ra_deg": t["ra"], "dec_deg": t["dec"], "ref_epoch": t["epoch"],
                 "pmra_mas_yr": t["pmra"], "pmdec_mas_yr": t["pmdec"], "parallax_mas": t["plx"]},
        "measured": measured,
        "n_cutouts": len(infos),
        "data_source": "NASA/IPAC IRSA SPHEREx DR1 + QR3 spectral images",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    # outputs of earlier runs that this run no longer references (e.g. a season label that
    # moved by a month while files were still downloading). Reported, never deleted.
    used = {f["file"] for b in wbins for f in b["frames"]} | {b["gif"] for b in wbins} | {b["diff"] for b in wbins}
    stale = sorted(str(p.relative_to(out)) for p in list(out.glob("frames/*.png")) + list(out.glob("*_*um.*"))
                   if str(p.relative_to(out)) not in used)
    if stale:
        print("NOTE: old outputs not referenced by meta.json (left in place):", ", ".join(stale))
    print("wrote", out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "barnard")
