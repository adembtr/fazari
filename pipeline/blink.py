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
  site/data/<target>/gaia_field.json     Gaia DR3 field stars (fetched from IRSA TAP once, then cached)
Outputs (<out> = env FAZARI_OUT, else <repo>/site/data):
  <out>/<target>/frames/<YYYY-MM>_<lam>um.png, blink_<lam>um.gif, diff_<lam>um.png,
  images.csv (per exposure diagnostics), meta.json (read by the web site)

Ad-hoc targets (any coordinate; default behaviour above is unchanged):
  FAZARI_TARGETS=/path/targets.json  python -I pipeline/blink.py <id>
      read <id> from that file instead of pipeline/targets.json (same schema; may carry
      "plx", "rv", "neighbors"; pipeline/targets_extra.json is still merged if it has <id>)
  python -I pipeline/blink.py <id> --target-json '{"name": "...", "ra": .., "dec": .., "epoch": 2016.0,
                                                  "pmra": 0, "pmdec": 0, "plx": 0, "kind": "motion"}'
      the target given inline (missing pmra/pmdec/plx = 0, epoch = 2016.0, kind = motion)
  Cutouts are read from FAZARI_DATA/<id>/{dr1,qr3}/ (+ liste_<coll>.csv), products go to
  FAZARI_OUT/<id>/. Gaia field stars come from site/data/<id>/gaia_field.json if it exists,
  else they are fetched once and cached in <out>/<id>/gaia_field.json.

Re-running is safe: files that are still downloading (*.part) are ignored, newly arrived
cutouts are picked up, outputs are overwritten in place (nothing is deleted).
"""
import csv
import json
import math
import os
import sys
import warnings
import zlib
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
# Every bin is tied to ONE detector (D1 0.75-1.09, D2 1.10-1.62, D3 1.63-2.41, D4 2.42-3.82,
# D5 3.83-4.41, D6 4.42-5.00 um): an exposure joins a bin only if it comes from that
# detector, so no frame mixes two detectors (different PSF, pixel response, orientation of
# the dispersion). Effective ranges: 4.0 um = D5 3.83-4.24, 4.6 um = D6 4.42-4.88.
BINS = [(1.0, "D1"), (1.5, "D2"), (2.0, "D3"), (3.0, "D4"), (4.0, "D5"), (4.6, "D6")]
BIN_CENTERS = [b for b, _ in BINS]
BIN_DET = dict(BINS)
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

# ---- detection check (run before any astrometric fit) ----------------------------------
# Forced photometry: the SPHEREx empirical PSF (EPSF extension of each file) is fitted at
# the PREDICTED target position (flux free, position fixed), together with known static
# neighbours (targets_extra.json "neighbors", fixed positions, free fluxes) and a constant
# background, in an 11 x 11 native-pixel stamp. Exposures are combined per season and
# detector (and per season and wavelength bin) by inverse-variance weighting.
# Noise is calibrated empirically: the same fit at random positions in the same exposures
# gives S/N values whose robust scatter should be 1; if it is larger (unmodelled sources,
# correlated noise) all errors in that cell are scaled up by it.
DETECT_SNR = 5.0            # a season x detector cell counts as a detection at >= 5 sigma
STAMP_R = 5                 # stamp half size (native px) for forced photometry
NB_MARGIN = 2               # neighbours up to this far outside the stamp are modelled
BLEND_PX = 0.5              # neighbour closer than this (native px, 3") cannot be separated
N_BLANK = 24                # random positions per exposure for the noise calibration
BRIGHT_SNR = 20.0           # median per-exposure S/N above this (or a saturated core):
                            # per-exposure centroids ("bright path"); else season ePSF fits
PIXEL_UJY = 1e12 * (PIX_NATIVE / 206264.806) ** 2   # 1 MJy/sr over one native pixel in uJy
# faint path: season position = minimum of the summed chi2 of the ePSF fit over a grid of
# trial offsets (arcsec) from the predicted position; errors from a bootstrap over the
# exposures and from the chi2 curvature (the larger one is kept)
FAINT_SEARCH = 10.0
FAINT_COARSE, FAINT_FINE, FAINT_FINE_HALF = 0.5, 0.1, 1.5
N_BOOT = 300
# relative photometry (brightness targets)
PHOT_COMPS = 5              # up to 5 comparison stars per bin
PHOT_MIN_COMPS = 2


# ---- astrometry helpers ---------------------------------------------------------------
def target_position(t, mjd, with_parallax=True):
    """Catalogue position moved to time mjd: proper motion (+ perspective acceleration if a
    radial velocity 'rv' in km/s is given) + annual parallax.
    Parallax factors use the Earth's barycentric position (SPHEREx is in low Earth orbit,
    7000 km is negligible). Aberration is not added: the SPHEREx WCS is fitted to Gaia
    stars in the same image, so it is already removed."""
    tt = Time(mjd, format="mjd")
    dt = tt.jyear - t["epoch"]
    cosd = math.cos(math.radians(t["dec"]))
    # perspective acceleration (exact for the tangent-plane offsets of linear space motion):
    # the radial motion mu_r = v_r * parallax changes the distance, so the angular offsets
    # are divided by (1 + mu_r dt). Barnard's Star (v_r = -110 km/s): +0.06" in 10 yr.
    mu_r = t.get("rv", 0.0) * t.get("plx", 0.0) / 4.740470446 / 206264806.247   # 1/yr
    dra = t["pmra"] * dt / (1 + mu_r * dt)     # mas, along RA*cos(dec)
    ddec = t["pmdec"] * dt / (1 + mu_r * dt)
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


def centroid(img, var, ok, x0, y0, half=5, nb=(), full=False):
    """Fit the star in native pixels. The saturated core is NaN, so the fit uses the wings
    (a symmetric model still pins the centre). Returns (x, y, sigma, npix) or None; with
    full=True a 5th element fit_errors() (position covariance, reduced chi2) is appended.
    nb: pixel positions of known field stars (Gaia DR3) near the box; each is fitted at its
    fixed position with the same width and a free flux, so that its light does not pull the
    wing fit (for Barnard's Star a G = 15 star 35" to the NE did exactly that)."""
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
    near = [(a, b) for a, b in nb if abs(a - ix) <= half + 2 and abs(b - iy) <= half + 2
            and math.hypot(a - x0, b - y0) > 1.0]
    p0 = [amp0, x0, y0, 0.6, float(np.median(d))] + [1.0] * len(near)
    lo = [0, x0 - 2.5, y0 - 2.5, 0.25, -np.inf] + [0.0] * len(near)
    hi = [np.inf, x0 + 2.5, y0 + 2.5, 3.0, np.inf] + [np.inf] * len(near)

    def model(p):
        f = gauss_model(p[:5], xx, yy)
        for k, (a, b) in enumerate(near):
            f = f + gauss_model([p[5 + k], a, b, p[3], 0.0], xx, yy)
        return f
    try:
        r = least_squares(lambda p: (model(p) - d) / err, p0,
                          bounds=(lo, hi), x_scale="jac")
    except Exception:
        return None
    if not r.success or np.any(np.isclose(r.x[1:3], lo[1:3])) or np.any(np.isclose(r.x[1:3], hi[1:3])):
        return None
    out = (float(r.x[1]), float(r.x[2]), float(r.x[3]), int(m.sum()))
    return (out + (fit_errors(r, len(d)),)) if full else out


# ---- forced ePSF photometry -------------------------------------------------------------
def prep_psf(psf):
    """Cubic-spline coefficients of the oversampled EPSF (so map_coordinates can skip the
    prefilter on every call). The EPSF table sums to 1 on its oversampled grid."""
    from scipy.ndimage import spline_filter
    return spline_filter(psf, order=3)


def epsf_kernels(px, dx, dy, R=STAMP_R):
    """EPSF on the (2R+1)^2 native-pixel stamp for sources at offsets (dx, dy) (native px,
    arrays allowed) from the stamp's centre pixel. Each row sums to ~1 (flux fraction per
    pixel; the EPSF covers +-3.3 native px, so far wings are not included)."""
    from scipy.ndimage import map_coordinates
    psf, ovs = px["psf"], px["ovs"]
    c = (psf.shape[0] - 1) / 2
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    dx = np.atleast_1d(np.asarray(dx, float))[:, None]
    dy = np.atleast_1d(np.asarray(dy, float))[:, None]
    u = c + ovs * (xx.ravel()[None, :] - dx)
    v = c + ovs * (yy.ravel()[None, :] - dy)
    k = map_coordinates(psf, [v.ravel(), u.ravel()], order=3, mode="constant", cval=0.0, prefilter=False)
    return k.reshape(len(dx), -1) * ovs * ovs


def stamp(px, x0, y0, R=STAMP_R):
    """Native-pixel stamp around (x0, y0): centre pixel, data, 1/sigma, good mask (flat)."""
    ix, iy = int(round(x0)), int(round(y0))
    ny, nx = px["clean"].shape
    if not (R <= ix < nx - R and R <= iy < ny - R):
        return None
    sl = (slice(iy - R, iy + R + 1), slice(ix - R, ix + R + 1))
    g = px["good"][sl].ravel()
    if g.sum() < 0.6 * g.size:
        return None
    d = px["clean"][sl].ravel().astype(float)
    w = 1.0 / np.sqrt(px["var"][sl].ravel().astype(float))
    return ix, iy, d, w, g


def neighbour_columns(px, ix, iy, x0, y0, nb_xy, R=STAMP_R):
    """EPSF columns of the catalogue neighbours near the stamp (+ a constant background).
    Returns (columns, blended): blended = a neighbour within BLEND_PX of (x0, y0)."""
    cols, blended = [], False
    for nx_, ny_ in nb_xy:
        if abs(nx_ - ix) > R + NB_MARGIN or abs(ny_ - iy) > R + NB_MARGIN:
            continue
        if math.hypot(nx_ - x0, ny_ - y0) < BLEND_PX:
            blended = True                         # degenerate with the target: not modelled
            continue
        cols.append(epsf_kernels(px, nx_ - ix, ny_ - iy, R)[0])
    cols.append(np.ones((2 * R + 1) ** 2))
    return cols, blended


def forced_phot(px, x0, y0, nb_xy=(), R=STAMP_R):
    """Linear ePSF fit at a FIXED position: returns dict(flux, err, chi2r, blended) with flux
    in MJy/sr summed over the PSF (x PIXEL_UJY = uJy), or None (edge, too many bad pixels)."""
    st = stamp(px, x0, y0, R)
    if st is None:
        return None
    ix, iy, d, w, g = st
    cols, blended = neighbour_columns(px, ix, iy, x0, y0, nb_xy, R)
    cols.insert(0, epsf_kernels(px, x0 - ix, y0 - iy, R)[0])
    A = np.stack(cols, 1)[g] * w[g, None]
    b = d[g] * w[g]
    try:
        p, *_ = np.linalg.lstsq(A, b, rcond=None)
        cov = np.linalg.pinv(A.T @ A)
    except np.linalg.LinAlgError:
        return None
    dof = max(len(b) - A.shape[1], 1)
    return dict(flux=float(p[0]), err=float(math.sqrt(max(cov[0, 0], 0))),
                chi2r=float(np.sum((b - A @ p) ** 2) / dof), blended=blended)


def neighbour_pixels(t, i):
    """Pixel positions, in exposure i, of the sources fitted together with the target:
    the target's catalogue neighbours (targets_extra.json "neighbors", static) and the Gaia
    DR3 field stars near the target (moved to the exposure epoch with their proper motion).
    Gaia stars within 2" of the target's predicted position (the target itself) or within
    1.5" of a catalogue neighbour (duplicates) are skipped."""
    nb = [(n[0], n[1]) for n in t.get("neighbors", {}).get("list", [])]
    dt = (i["mjd"] - 51544.5) / 365.25 + 2000.0 - 2016.0
    for g in t.get("_gaia_nb", []):
        cosd = math.cos(math.radians(g[1]))
        ra = g[0] + (g[2] or 0) * dt / 3.6e6 / cosd
        dec = g[1] + (g[3] or 0) * dt / 3.6e6
        if offset_arcsec(ra, dec, i["ra_pred"], i["dec_pred"])[2] < 2.0:
            continue
        if any(offset_arcsec(ra, dec, a, b)[2] < 1.5 for a, b in nb[:len(t.get("neighbors", {}).get("list", []))]):
            continue
        nb.append((ra, dec))
    if not nb:
        return []
    xy = i["_px"]["wcs"].all_world2pix(np.array([n[0] for n in nb]), np.array([n[1] for n in nb]), 0)
    return list(zip(map(float, xy[0]), map(float, xy[1])))


def wmean(f, e):
    """Inverse-variance mean, its error, and the reduced chi2 of the values about it."""
    f, e = np.asarray(f, float), np.asarray(e, float)
    w = 1 / e ** 2
    m = float(np.sum(w * f) / np.sum(w))
    chi = float(np.sum(w * (f - m) ** 2) / max(len(f) - 1, 1)) if len(f) > 1 else 1.0
    return m, float(1 / math.sqrt(np.sum(w))), chi


def robust_sigma(a):
    a = np.asarray(a, float)
    a = a[np.isfinite(a)]
    return float(1.4826 * np.median(np.abs(a - np.median(a)))) if len(a) else float("nan")


# ---- reading --------------------------------------------------------------------------
def load_target(name, inline=None):
    if inline is not None:                  # --target-json
        t = dict(inline)
        t.setdefault("name", name)
        for k, v in (("pmra", 0.0), ("pmdec", 0.0), ("plx", 0.0), ("epoch", 2016.0), ("kind", "motion")):
            t.setdefault(k, v)
        return t
    src = Path(os.environ["FAZARI_TARGETS"]).expanduser() if os.environ.get("FAZARI_TARGETS") else PIPE / "targets.json"
    cat = json.loads(src.read_text())
    if name not in cat or name.startswith("_"):
        sys.exit(f"unknown target {name} in {src}; options: {[k for k in cat if not k.startswith('_')]}")
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
        # local Jacobian d(east, north)/d(x, y) (arcsec per native px) at the predicted position
        r1, d1 = (float(v) for v in wcs.all_pix2world(x + 1, y, 0))
        r2, d2 = (float(v) for v in wcs.all_pix2world(x, y + 1, 0))
        jx, jy = offset_arcsec(ra, dec, r1, d1)[:2], offset_arcsec(ra, dec, r2, d2)[:2]
        jac_pred = [[jx[0], jy[0]], [jx[1], jy[1]]]
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
                orient_deg=orient, jac_pred=jac_pred)
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
    # kept for forced photometry / faint-source astrometry / relative photometry
    k = int(np.argmin((epsf_tab["XCENTER"] - (x + det_off[0])) ** 2 + (epsf_tab["YCENTER"] - (y + det_off[1])) ** 2))
    good_ph = ~bad & ~sat & np.isfinite(clean) & np.isfinite(var) & (var > 0)
    info["_px"] = dict(clean=clean.astype(np.float32), var=np.where(good_ph, var, np.inf).astype(np.float32),
                       good=good_ph, satnan=sat | ~np.isfinite(img), wcs=wcs, swcs=swcs, path=path, det_off=det_off,
                       psf=prep_psf(np.asarray(epsf_tab["EPSF"][k], float)), ovs=epsf_ovs)
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


def which_bin(lam, detector):
    """Bin of an exposure: same detector as the bin AND wavelength within +-BIN_TOL."""
    for c, d in BINS:
        if d == detector and abs(lam / c - 1) <= BIN_TOL:
            return c
    return None


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
    pairs_and_headline(measured, positions, min_n=10, method=(
        "pixel-integrated 2D Gaussian fit to the unsaturated wings in native "
        "6.15\" pixels (saturated core excluded), converted with each exposure's "
        "SIP WCS; per-detector centroid bias removed by the joint fit (see 'fit'); "
        "season position = mean of the exposures after clipping. "
        "Gaia prediction = proper motion + annual parallax (Earth barycentric)."))
    return measured


def pairs_and_headline(measured, positions, min_n, method):
    """All season pairs (measured vs predicted shift) and the headline pair: the longest
    pair seen with the same telescope orientation (detector-fixed biases cancel) whose
    seasons both have >= min_n images, else first -> last."""
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
                          "shift_err_arcsec": round(math.hypot(math.hypot(a["err_east_arcsec"], z["err_east_arcsec"]),
                                                               math.hypot(a["err_north_arcsec"], z["err_north_arcsec"])) / math.sqrt(2), 3),
                          "raw_shift_arcsec": round(m0[2], 3), "raw_pa_deg": round(m0[3], 2),
                          "gaia_predicted_arcsec": round(g[2], 3), "gaia_pa_deg": round(g[3], 2)})
            print(f"  pair {a['epoch']} -> {z['epoch']} (same orientation: {same}): "
                  f"{m[2]:.2f}\" PA {m[3]:.1f} (raw {m0[2]:.2f}\" PA {m0[3]:.1f}) | Gaia {g[2]:.2f}\" PA {g[3]:.1f}")
    measured["pairs"] = pairs
    if len(positions) >= 2:
        # headline: longest same-orientation pair (independent of the bias model), else first->last
        nimg = {p["epoch"]: p["n_images"] for p in positions}
        same = [p for p in pairs if p["same_orientation"]
                and min(nimg[p["from"]], nimg[p["to"]]) >= min_n]  # need a well-sampled season
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
            "shift_err_arcsec": best["shift_err_arcsec"],
            "method": method,
        })
        print(f"shift {a['epoch']} -> {z['epoch']}: measured {m[2]:.2f}\" PA {m[3]:.1f} (raw {m0[2]:.2f}\" "
              f"PA {m0[3]:.1f})  |  Gaia {g[2]:.2f}\" PA {g[3]:.1f}  (pm only {gp[2]:.2f}\" PA {gp[3]:.1f})")


# ---- Gaia DR3 field stars (relative astrometry) ---------------------------------------------
GAIA_RADIUS_DEG = 0.15      # covers the 0.2 deg cutouts; main() raises it for larger ones (footprint_radius)
GAIA_GMAX = 19.0
GAIA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"     # IRSA copy of the Gaia DR3 source table


def gaia_field(name, ra, dec):
    """Gaia DR3 stars around the target. Read from site/data/<target>/gaia_field.json (repo
    targets, committed so runs are reproducible offline), else from <out>/<target>/; if
    neither exists, fetched from IRSA TAP and cached in <out>/<target>/gaia_field.json.
    A cache whose query radius is smaller than GAIA_RADIUS_DEG (wider cutouts) is not used."""
    cache = ROOT / "site" / "data" / name / "gaia_field.json"
    if cache.exists() and gaia_cache_radius(cache) >= GAIA_RADIUS_DEG - 1e-9:
        return json.loads(cache.read_text())
    cache = OUT / name / "gaia_field.json"            # ad-hoc targets: next to their products
    if cache.exists() and gaia_cache_radius(cache) >= GAIA_RADIUS_DEG - 1e-9:
        return json.loads(cache.read_text())
    import urllib.parse
    import urllib.request
    q = ("SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, ruwe "
         "FROM gaia_dr3_source WHERE CONTAINS(POINT('ICRS', ra, dec), "
         f"CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {GAIA_RADIUS_DEG}))=1 AND phot_g_mean_mag < {GAIA_GMAX}")
    data = urllib.parse.urlencode({"QUERY": q, "FORMAT": "csv"}).encode()
    req = urllib.request.Request(GAIA_TAP, data=data, headers={"User-Agent": "fazari-spaceapps/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        rows = list(csv.DictReader(r.read().decode().splitlines()))

    def num(v):
        return round(float(v), 7) if v not in ("", None) else None
    stars = [[int(r["source_id"]), num(r["ra"]), num(r["dec"]), num(r["pmra"]), num(r["pmdec"]),
              num(r["parallax"]), num(r["phot_g_mean_mag"]), num(r["ruwe"])] for r in rows]
    out = {"source": "Gaia DR3 (gaia_dr3_source at NASA/IPAC IRSA TAP)", "query": q, "ref_epoch": 2016.0,
           "columns": ["source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag", "ruwe"],
           "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "radius_deg": GAIA_RADIUS_DEG,
           "stars": stars}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out, separators=(",", ":")))
    print(f"  cached {len(stars)} Gaia DR3 stars in {cache}")
    return out


def gaia_cache_radius(path):
    """Query radius (deg) of a gaia_field.json: 'radius_deg', else the CIRCLE of its query, else 0.15."""
    import re
    d = json.loads(Path(path).read_text())
    if d.get("radius_deg"):
        return float(d["radius_deg"])
    m = re.search(r"CIRCLE\('ICRS',\s*[-0-9.]+,\s*[-0-9.]+,\s*([0-9.]+)\)", d.get("query", ""))
    return float(m.group(1)) if m else 0.15


def footprint_radius(infos, ra_c, dec_c):
    """Largest distance (deg) from the grid centre to a cutout corner: the Gaia query must reach that
    far (0.2 deg cutouts: <= 0.148, so GAIA_RADIUS_DEG stays 0.15; 0.4 deg: ~0.29). Stars near the
    corner that could lack an isolation neighbour are < 7 px from the edge and not used anyway."""
    r = 0.0
    for i in infos:
        px = i.get("_px")
        if not px:
            continue
        ny, nx = px["clean"].shape
        try:
            ra, dec = px["wcs"].all_pix2world([-0.5, nx - 0.5, -0.5, nx - 0.5], [-0.5, -0.5, ny - 0.5, ny - 0.5], 0)
        except Exception:
            continue
        r = max(r, max(offset_arcsec(ra_c, dec_c, float(a), float(b))[2] for a, b in zip(ra, dec)) / 3600)
    return r


# Field-star selection / fit (documented in pipeline/ASTROMETRY.md; keep the two in sync)
CAL_GMIN, CAL_GMAX = 10.0, 17.5     # Gaia G range of reference stars
CAL_RUWE = 1.4                      # well-behaved single-star solutions only
CAL_ISOL_ARCSEC = 12.0              # no other Gaia star (G < 19) closer than this
CAL_TARGET_ARCSEC = 40.0            # keep away from the target
CAL_EDGE_PX = 7                     # star at least this far from the cutout edge
CAL_MIN_SNR = 20.0                  # forced-photometry S/N of the star in the exposure
CAL_MATCH_ARCSEC = 2.0              # |measured - Gaia| larger than this = mismatch
CAL_CLIP = 3.0                      # sigma clipping of the per-star residuals
CAL_MIN_STARS = 5                   # minimum number of DISTINCT reference stars in a cell
CAL_MIN_MEAS = 20                   # minimum number of star measurements in a cell
CAL_MAX_ERR = 0.08                  # cell offset error (arcsec) must be below this
CAL_ROT_STARS = 12                  # >= this many distinct stars around the target: + rotation/scale


def epsf_centroid(px, x0, y0, full=False):
    """Free-position EPSF fit (flux, x, y, background) of an unsaturated star. Returns (x, y);
    with full=True (x, y, None, npix, fit_errors()) like centroid(full=True)."""
    st = stamp(px, x0, y0)
    if st is None:
        return None
    ix, iy, d, w, g = st

    def res(p):
        return (p[0] * epsf_kernels(px, p[1] - ix, p[2] - iy)[0][g] + p[3] - d[g]) * w[g]
    p0 = [max(float(np.nansum(d[g])), 1e-3), x0, y0, 0.0]
    try:
        r = least_squares(res, p0, bounds=([0, x0 - 2, y0 - 2, -np.inf], [np.inf, x0 + 2, y0 + 2, np.inf]),
                          x_scale="jac")
    except Exception:
        return None
    if not r.success or abs(r.x[1] - x0) > 1.9 or abs(r.x[2] - y0) > 1.9:
        return None
    if full:
        return float(r.x[1]), float(r.x[2]), None, int(g.sum()), fit_errors(r, int(g.sum()))
    return float(r.x[1]), float(r.x[2])


def reference_stars(gaia, t, ra_c, dec_c):
    """Gaia DR3 reference stars that pass the catalogue cuts (isolation, RUWE, G, 5/6-p)."""
    allst = gaia["stars"]
    cosd = math.cos(math.radians(dec_c))
    xy = np.array([[(s[1] - ra_c) * cosd * 3600, (s[2] - dec_c) * 3600] for s in allst])
    refs = []
    for k, s in enumerate(allst):
        sid, ra, dec, pmra, pmdec, plx, G, ruwe = s
        if pmra is None or plx is None or G is None or not (CAL_GMIN <= G <= CAL_GMAX):
            continue
        if ruwe is None or ruwe > CAL_RUWE:
            continue
        if str(sid) == str(t.get("gaia_dr3")):
            continue
        dd = np.hypot(xy[:, 0] - xy[k, 0], xy[:, 1] - xy[k, 1])
        if np.sum(dd < CAL_ISOL_ARCSEC) > 1:
            continue
        refs.append(dict(source_id=sid, ra=ra, dec=dec, epoch=2016.0, pmra=pmra, pmdec=pmdec, plx=plx, G=G, ruwe=ruwe))
    return refs


def star_residuals(i, refs, path, log=None):
    """Measured - Gaia offsets (east, north, arcsec) of the reference stars in one exposure,
    with each star's lever arm (east, north offset from the target, degrees).
    log: optional list. One record per reference star that falls on the cutout is appended,
    used or not, with the reason when not (field_stars.csv). The returned rows are the same."""
    px = i["_px"]
    wcs = px["wcs"]
    ny, nx = px["clean"].shape
    rows = []
    for s in refs:
        r, d = target_position(s, i["mjd"])
        near = offset_arcsec(r, d, i["ra_pred"], i["dec_pred"])[2] < CAL_TARGET_ARCSEC
        if near and log is None:
            continue
        x, y = (float(v) for v in wcs.all_world2pix(r, d, 0))
        rec = {}                                     # filled only when logging
        if log is not None:
            if not (-0.5 <= x < nx - 0.5 and -0.5 <= y < ny - 0.5):
                continue                             # not on this cutout
            rec = dict(star=s, ra_gaia=r, dec_gaia=d, x_pred=x, y_pred=y, status="used",
                       lever=offset_arcsec(i["ra_pred"], i["dec_pred"], r, d)[:2])
            log.append(rec)
        if near:
            rec["status"] = "near_target"
            continue
        if not (CAL_EDGE_PX <= x < nx - CAL_EDGE_PX and CAL_EDGE_PX <= y < ny - CAL_EDGE_PX):
            rec["status"] = "edge"
            continue
        ix, iy = int(round(x)), int(round(y))
        if px["satnan"][iy - 2:iy + 3, ix - 2:ix + 3].any():
            rec["status"] = "saturated_or_missing"
            continue
        q = forced_phot(px, x, y)
        rec["phot"] = q
        if not q or q["err"] <= 0:
            rec["status"] = "no_photometry"
            continue
        if q["flux"] < CAL_MIN_SNR * q["err"]:
            rec["status"] = "low_snr"
            continue
        if path == "faint":
            c = epsf_centroid(px, x, y, full=log is not None)
        else:
            c = centroid(px["clean"].astype(float), px["var"].astype(float), px["good"], x, y, full=log is not None)
        if not c:
            rec["status"] = "centroid_failed"
            continue
        rm, dm = (float(v) for v in wcs.all_pix2world(c[0], c[1], 0))
        e, n = offset_arcsec(r, d, rm, dm)[:2]
        rec.update(fit=c, ra_meas=rm, dec_meas=dm, east=e, north=n)
        if math.hypot(e, n) > CAL_MATCH_ARCSEC:
            rec["status"] = "mismatch"
            continue
        xe, xn = offset_arcsec(i["ra_pred"], i["dec_pred"], r, d)[:2]   # star position rel. to the target
        rows.append((e, n, xe / 3600, xn / 3600, s["source_id"]))       # lever arm in degrees
    return rows


def fit_offsets(rows):
    """Clipped fit of measured - Gaia star offsets: shift, or shift + rotation + scale about the
    target when >= CAL_ROT_STARS stars. Returns dict(east, north, err_east, err_north, n,
    model, rms) for the offset AT THE TARGET, or None if < CAL_MIN_STARS stars."""
    ids = [r[4] for r in rows]
    if len(set(ids)) < CAL_MIN_STARS:
        return None
    a = np.array([r[:4] for r in rows], float)
    # rotation + scale only with enough distinct stars that SURROUND the target (the mean
    # lever arm small compared with its spread); otherwise the constant term (the offset at
    # the target) is an extrapolation and shift-only is used
    uniq = {}
    for r in rows:
        uniq[r[4]] = (r[2], r[3])
    lv = np.array(list(uniq.values()))
    surround = len(lv) >= CAL_ROT_STARS and np.hypot(*lv.mean(0)) < 0.3 * np.sqrt((lv.std(0) ** 2).sum())
    use = np.ones(len(a), bool)
    for _ in range(5):
        model = "shift+rotation+scale" if surround else "shift"
        if model == "shift":
            p = np.array([np.mean(a[use, 0]), np.mean(a[use, 1]), 0.0, 0.0])
        else:
            # dE = a + s*xE - r*xN ; dN = b + r*xE + s*xN  (r, s in arcsec per degree)
            A = np.zeros((2 * use.sum(), 4))
            A[0::2, 0] = 1; A[0::2, 2] = a[use, 2]; A[0::2, 3] = -a[use, 3]
            A[1::2, 1] = 1; A[1::2, 2] = a[use, 3]; A[1::2, 3] = a[use, 2]
            y = np.empty(2 * use.sum()); y[0::2] = a[use, 0]; y[1::2] = a[use, 1]
            p, *_ = np.linalg.lstsq(A, y, rcond=None)
        rE = a[:, 0] - (p[0] + p[2] * a[:, 2] - p[3] * a[:, 3])
        rN = a[:, 1] - (p[1] + p[3] * a[:, 2] + p[2] * a[:, 3])
        rr = np.hypot(rE, rN)
        sig = max(1.4826 * np.median(rr[use]) / 1.1774, 0.05)
        new = rr < CAL_CLIP * sig
        if new.sum() < CAL_MIN_STARS or (new == use).all():
            break
        use = new
    n = int(use.sum())
    nd = len(set(i for i, u in zip(ids, use) if u))
    sE = float(np.std(rE[use], ddof=1))
    sN = float(np.std(rN[use], ddof=1))
    # repeated measurements of the same star share its catalogue / blend error, so the
    # effective number of independent points is the number of DISTINCT stars
    neff = min(n, nd)
    return dict(east=float(p[0]), north=float(p[1]), err_east=sE / math.sqrt(neff), err_north=sN / math.sqrt(neff),
                n=n, n_stars=nd, model=model, rms=[round(sE, 3), round(sN, 3)],
                _use=use, _res=(rE, rN))         # per input row: kept by the clipping, residual (field_stars.csv)


NB_FIT_GMAX = 17.0          # Gaia neighbours fitted in the bright-target wing fit: G < 17 ...
NB_FIT_MINPX = 2.5          # ... and > 2.5 native px (15") from the target. Fainter or closer
                            # stars are left out: a free flux next to a saturated core soaks up
                            # wing light and biases the centroid differently in every season


def refit_with_neighbours(t, used):
    """Bright path: redo the target's wing centroid with the bright Gaia DR3 field stars near it
    fitted at their fixed positions (see centroid())."""
    n = 0
    for i in used:
        if "ra_fit" not in i or not t.get("_gaia_nb"):
            continue
        px = i["_px"]
        dt = (i["mjd"] - 51544.5) / 365.25 + 2000.0 - 2016.0
        nbs = [(g[0] + (g[2] or 0) * dt / 3.6e6 / math.cos(math.radians(g[1])), g[1] + (g[3] or 0) * dt / 3.6e6)
               for g in t["_gaia_nb"] if g[4] is not None and g[4] < NB_FIT_GMAX]
        nb = []
        if nbs:
            xy = px["wcs"].all_world2pix(np.array([a for a, _ in nbs]), np.array([b for _, b in nbs]), 0)
            nb = [(float(a), float(b)) for a, b in zip(*xy) if math.hypot(a - i["x"], b - i["y"]) > NB_FIT_MINPX]
        if not nb:
            continue
        c = centroid(px["clean"].astype(float), px["var"].astype(float), px["good"], i["x"], i["y"], nb=nb)
        if not c:
            continue
        wcs = px["wcs"]
        rr, dd = (float(v) for v in wcs.all_pix2world(c[0], c[1], 0))
        r1, d1 = (float(v) for v in wcs.all_pix2world(c[0] + 1, c[1], 0))
        r2, d2 = (float(v) for v in wcs.all_pix2world(c[0], c[1] + 1, 0))
        jx, jy = offset_arcsec(rr, dd, r1, d1)[:2], offset_arcsec(rr, dd, r2, d2)[:2]
        i.update(x_fit=c[0], y_fit=c[1], fit_quality=c[2], fit_npix=c[3], ra_fit=rr, dec_fit=dd,
                 jac=[[jx[0], jy[0]], [jx[1], jy[1]]], fit_method="gauss+neighbours")
        n += 1
    print(f"  target re-centroided with field-star neighbours in {n} exposures")
    return n


def field_calibration(t, name, used, path, ra_c, dec_c):
    """Tie the target measurements to Gaia DR3 with the field stars of the same exposures.
    Star residuals (measured - Gaia) are pooled per season x detector (same pointing pattern,
    same detector, same orientation) and fitted; the offset at the target is removed from the
    target measurement of every exposure of that cell. Pooling is used because single
    exposures have only ~5-25 usable stars (D5/D6 often < 5), and the per-exposure offsets
    scatter no more than their errors (see ASTROMETRY.md)."""
    if os.environ.get("FAZARI_NO_CALIB"):          # diagnostic switch: WCS positions only
        return {"applied": False, "note": "disabled by FAZARI_NO_CALIB"}
    try:
        gaia = gaia_field(name, ra_c, dec_c)
    except Exception as e:
        print("  WARNING: no Gaia field stars (", e, "): positions stay on the SPHEREx WCS")
        return {"applied": False, "note": f"Gaia field stars unavailable: {e}"}
    refs = reference_stars(gaia, t, ra_c, dec_c)
    export = field_stars_on()                      # per-star table field_stars.csv (no effect on the fit)
    pooled, per_exp, pooled_recs = {}, [], {}
    for i in used:
        log = [] if export else None
        rows = star_residuals(i, refs, path, log)
        i["calib_nstars"] = len(rows)
        pooled.setdefault((i["epoch"], i["detector"]), []).extend(rows)
        if export:
            i["_field_stars"] = log
            pooled_recs.setdefault((i["epoch"], i["detector"]), []).extend(r for r in log if r["status"] == "used")
        f = fit_offsets(rows)
        if f:
            per_exp.append(((i["epoch"], i["detector"]), f))
    cells = {k: fit_offsets(v) for k, v in pooled.items()}
    for k, recs in pooled_recs.items():            # clipping flag and residual of each star in its cell fit
        if cells.get(k):
            for rec, u, rE, rN in zip(recs, cells[k]["_use"], *cells[k]["_res"]):
                rec.update(kept=bool(u), cres=(float(rE), float(rN)))
    good = {k: c for k, c in cells.items() if c and c["n"] >= CAL_MIN_MEAS
            and max(c["err_east"], c["err_north"]) <= CAL_MAX_ERR}
    summ = []
    for (e, d) in sorted(pooled):
        c = cells.get((e, d))
        pe = [f for k, f in per_exp if k == (e, d)]
        # does a single exposure scatter more than its own error? (real per-exposure WCS jitter)
        chi = (float(np.mean([((f["east"] - c["east"]) / f["err_east"]) ** 2 + ((f["north"] - c["north"]) / f["err_north"]) ** 2
                              for f in pe]) / 2) if c and len(pe) >= 3 else None)
        row = {"epoch": e, "detector": d, "accepted": (e, d) in good, "n_star_measurements": len(pooled[(e, d)])}
        if c:
            row.update({"n_used": c["n"], "n_distinct_stars": c["n_stars"], "model": c["model"],
                        "east_arcsec": round(c["east"], 3), "north_arcsec": round(c["north"], 3),
                        "err_east_arcsec": round(c["err_east"], 3), "err_north_arcsec": round(c["err_north"], 3),
                        "star_rms_arcsec": c["rms"], "per_exposure_chi2r": round(chi, 2) if chi is not None else None})
        if (e, d) not in good:
            # fallback: the accepted cells of the same season (same pointings, all six detectors
            # observe simultaneously); their offsets agree to ~0.03" in the tested fields
            same = [g for (e2, _), g in good.items() if e2 == e]
            if same:
                row["used"] = "season median of the accepted detectors"
                good_fb = dict(east=float(np.median([g["east"] for g in same])),
                               north=float(np.median([g["north"] for g in same])), fallback=True)
                row.update(east_used=round(good_fb["east"], 3), north_used=round(good_fb["north"], 3))
                cells[(e, d)] = good_fb
            else:
                row["used"] = "none (no correction)"
                cells[(e, d)] = None
        summ.append(row)
        print(f"  field calibration {e} {d}: {len(pooled[(e, d)])} star measurements"
              + (f" of {c['n_stars']} stars ({c['model']}), WCS - Gaia {c['east']:+.3f} +- {c['err_east']:.3f}\" E "
                 f"{c['north']:+.3f} +- {c['err_north']:.3f}\" N" if c and "n_stars" in c else "")
              + (f"; per-exposure chi2r {chi:.2f}" if chi is not None else "")
              + ("" if row["accepted"] else f"  -> {row['used']}"))
    nnone = 0
    for i in used:
        c = cells.get((i["epoch"], i["detector"]))
        if not c:
            nnone += 1
            continue
        i["_cal"] = c
        i.update(calib_east_arcsec=round(c["east"], 4), calib_north_arcsec=round(c["north"], 4))
        if "ra_fit" in i:                       # bright path: correct the per-exposure centroid
            cosd = math.cos(math.radians(i["dec_fit"]))
            i["ra_fit_wcs"], i["dec_fit_wcs"] = i["ra_fit"], i["dec_fit"]
            i["ra_fit"] = i["ra_fit"] - c["east"] / 3600 / cosd
            i["dec_fit"] = i["dec_fit"] - c["north"] / 3600
    if export:
        write_field_stars(name, used, path)
    return {"applied": True, "n_reference_stars": len(refs), "pooling": "season x detector",
            "n_exposures_calibrated": len(used) - nnone, "n_uncorrected": nnone,
            "centroid": "gauss" if path == "bright" else "epsf", "cells": summ,
            "reference": "pipeline/ASTROMETRY.md", "gaia_cache": f"site/data/{name}/gaia_field.json"}


# ---- field_stars.csv: the field-star measurements, one row per reference star x exposure ----
# Every reference star that falls on a cutout, measured or not ("status" says why not). Only an
# export: nothing here feeds back into the calibration. Columns: pipeline/ASTROMETRY.md; the
# browser engine (site/js/calib.js fieldStarTable) uses the same names.
FIELD_STAR_COLUMNS = [
    "source_id", "gaia_g", "gaia_bp_rp", "gaia_ruwe", "gaia_pmra", "gaia_pmdec", "gaia_parallax",
    "file", "obs_id", "collection", "mjd", "season", "detector", "wavelength_um", "bin_um", "orient_deg",
    "ra_gaia", "dec_gaia", "x_pred", "y_pred", "lever_east_arcsec", "lever_north_arcsec",
    "x_meas", "y_meas", "ra_meas", "dec_meas", "east_arcsec", "north_arcsec", "east_err_arcsec", "north_err_arcsec",
    "centroid_method", "psf_sigma_px", "fit_npix", "fit_chi2r", "flux_ujy", "flux_err_ujy", "snr", "flux_method",
    "status", "cell_kept", "cell_resid_east_arcsec", "cell_resid_north_arcsec", "calib_east_arcsec", "calib_north_arcsec"]
FIELD_STAR_DECIMALS = {"ra_gaia": 8, "dec_gaia": 8, "ra_meas": 8, "dec_meas": 8, "mjd": 6, "wavelength_um": 5,
                       "bin_um": 1, "orient_deg": 3}          # all other floats: 4


def field_stars_on():
    """Env FAZARI_FIELD_STARS=1 / 0 forces the export on / off. Default: on when the products do
    not go to the repo's site/data (local engine jobs, runs with FAZARI_OUT), off for the site."""
    v = os.environ.get("FAZARI_FIELD_STARS", "").strip().lower()
    if v:
        return v not in ("0", "false", "no", "off")
    return OUT.resolve() != (ROOT / "site" / "data").resolve()


def fit_errors(r, n, idx=(1, 2)):
    """Covariance (px^2) of the position parameters idx of a scipy least_squares fit: formal
    errors from the Jacobian at the solution, scaled by the reduced chi2 (curve_fit's default).
    Returns dict(cov = 2x2 array or None if singular, chi2r)."""
    chi2r = 2.0 * float(r.cost) / max(n - len(r.x), 1)
    try:
        cov = np.linalg.inv(r.jac.T @ r.jac)[np.ix_(idx, idx)] * chi2r
    except (np.linalg.LinAlgError, ValueError):
        cov = None
    return {"cov": cov, "chi2r": chi2r}


def field_star_rows(i, path):
    """field_stars.csv rows of one exposure, from its star_residuals() log (i["_field_stars"])."""
    recs = i.get("_field_stars") or []
    if not recs:
        return []
    px = i["_px"]
    swcs = px.get("swcs")
    if swcs is None:                              # read_exposure() without it: open the file once
        try:
            with fits.open(px["path"], memmap=False) as h:
                swcs = WCS(h["IMAGE"].header, fobj=h, key="W")
                swcs.sip = None
        except Exception:
            swcs = None
    lam = [None] * len(recs)                      # wavelength at the star (the LVF changes across the cutout)
    if swcs is not None:
        try:
            lam = swcs.pixel_to_world_values(np.array([r["x_pred"] for r in recs]),
                                             np.array([r["y_pred"] for r in recs]))[0]
        except Exception:
            pass
    J = np.array(i["jac_pred"])                   # d(east, north)/d(x, y), arcsec per native px
    base = {"file": i["file"], "obs_id": i.get("obs_id", ""), "collection": i.get("collection", ""),
            "mjd": i["mjd"], "season": i.get("epoch", ""), "detector": i["detector"], "bin_um": i.get("bin_um"),
            "orient_deg": i.get("orient_deg"), "calib_east_arcsec": i.get("calib_east_arcsec"),
            "calib_north_arcsec": i.get("calib_north_arcsec"),
            "centroid_method": "epsf" if path == "faint" else "gauss", "flux_method": "epsf_forced"}
    out = []
    for k, rec in enumerate(recs):
        s = rec["star"]
        row = dict(base, source_id=s["source_id"], gaia_g=s["G"], gaia_bp_rp=s.get("bp_rp"), gaia_ruwe=s.get("ruwe"),
                   gaia_pmra=s["pmra"], gaia_pmdec=s["pmdec"], gaia_parallax=s["plx"], wavelength_um=lam[k],
                   ra_gaia=rec["ra_gaia"], dec_gaia=rec["dec_gaia"], x_pred=rec["x_pred"], y_pred=rec["y_pred"],
                   lever_east_arcsec=rec["lever"][0], lever_north_arcsec=rec["lever"][1], status=rec["status"])
        q = rec.get("phot")
        if q:
            row.update(flux_ujy=q["flux"] * PIXEL_UJY, flux_err_ujy=q["err"] * PIXEL_UJY,
                       snr=q["flux"] / q["err"] if q["err"] > 0 else None)
        c = rec.get("fit")
        if c:
            row.update(x_meas=c[0], y_meas=c[1], ra_meas=rec["ra_meas"], dec_meas=rec["dec_meas"],
                       east_arcsec=rec["east"], north_arcsec=rec["north"], psf_sigma_px=c[2], fit_npix=c[3],
                       fit_chi2r=c[4]["chi2r"])
            if c[4]["cov"] is not None:
                ce = J @ c[4]["cov"] @ J.T
                row.update(east_err_arcsec=math.sqrt(ce[0, 0]) if ce[0, 0] >= 0 else None,
                           north_err_arcsec=math.sqrt(ce[1, 1]) if ce[1, 1] >= 0 else None)
        if "kept" in rec:
            row.update(cell_kept=rec["kept"], cell_resid_east_arcsec=rec["cres"][0], cell_resid_north_arcsec=rec["cres"][1])
        out.append(row)
    return out


def write_field_stars(name, used, path):
    """<out>/<target>/field_stars.csv from the field-star logs of the exposures (then dropped)."""
    import time
    t0 = time.perf_counter()
    rows = []
    for i in sorted(used, key=lambda i: (i["mjd"], i["detector"])):
        rows.extend(field_star_rows(i, path))
        i.pop("_field_stars", None)

    def fmt(k, v):
        if v is None:
            return ""
        if isinstance(v, (bool, np.bool_)):
            return int(v)
        if isinstance(v, (float, np.floating)):
            return f"{v:.{FIELD_STAR_DECIMALS.get(k, 4)}f}" if np.isfinite(v) else ""
        return v
    dest = OUT / name / "field_stars.csv"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(FIELD_STAR_COLUMNS)
        for r in rows:
            w.writerow([fmt(k, r.get(k)) for k in FIELD_STAR_COLUMNS])
    print(f"  field_stars.csv: {len(rows)} rows ({sum(r['status'] == 'used' for r in rows)} used) of "
          f"{len({r['source_id'] for r in rows})} stars in {len(used)} exposures ({time.perf_counter() - t0:.1f} s)")


# ---- detection check ---------------------------------------------------------------------
def blank_snr(i):
    """S/N of the same forced fit at N_BLANK random positions of this exposure (>= 3 px from
    the target, no neighbours modelled): the empirical noise reference."""
    px = i["_px"]
    ny, nx = px["clean"].shape
    rng = np.random.default_rng(zlib.crc32(i["file"].encode()))
    out, tries = [], 0
    while len(out) < N_BLANK and tries < 4 * N_BLANK:
        tries += 1
        bx, by = rng.uniform(STAMP_R, nx - 1 - STAMP_R), rng.uniform(STAMP_R, ny - 1 - STAMP_R)
        if math.hypot(bx - i["x"], by - i["y"]) < 3:
            continue
        q = forced_phot(px, bx, by)
        if q and q["err"] > 0:
            out.append(q["flux"] / q["err"])
    return out


def combine_cell(sel):
    """Season x detector (or season x bin) combination of the per-exposure forced fluxes."""
    sat_only = [i for i in sel if i.get("phot_sat_only")]
    sel = [i for i in sel if "phot_flux_ujy" in i]
    if not sel:
        if not sat_only:
            return None
        lam = [i["wavelength_um"] for i in sat_only]
        return {"n": len(sat_only), "flux_ujy": None, "err_ujy": None, "snr": None, "noise_scale": None,
                "chi2r_between_exposures": None, "n_blended": 0, "saturated_frac": 1.0,
                "lam_min_um": round(min(lam), 3), "lam_max_um": round(max(lam), 3)}
    scale = robust_sigma([s for i in sel for s in i["_blank"]])
    scale = max(1.0, scale) if np.isfinite(scale) else 1.0
    m, e, chi = wmean([i["phot_flux_ujy"] for i in sel], [i["phot_err_ujy"] for i in sel])
    e *= scale
    lam = [i["wavelength_um"] for i in sel]
    return {"n": len(sel), "flux_ujy": round(m, 1), "err_ujy": round(e, 1), "snr": round(m / e, 1),
            "noise_scale": round(scale, 2), "chi2r_between_exposures": round(chi, 2),
            "n_blended": int(sum(bool(i.get("blended")) for i in sel)),
            "saturated_frac": round(float(np.mean([bool(i["saturated"]) for i in sel])), 2),
            "lam_min_um": round(min(lam), 3), "lam_max_um": round(max(lam), 3)}


def detection_check(t, infos, epochs):
    """S/N of the target at its PREDICTED position, per season x detector and per season x
    bin, before any astrometric fit. Returns (detection dict, set of detected cells)."""
    for i in infos:
        if not i["inside"] or not i.get("epoch"):
            continue
        px = i["_px"]
        i["_nb"] = neighbour_pixels(t, i)
        r = forced_phot(px, i["x"], i["y"], i["_nb"])
        if r is None or r["err"] <= 0:
            if i["saturated"]:
                i["phot_sat_only"] = True       # core too saturated for the fit: a bright source is there
            continue
        i.update(phot_flux_ujy=r["flux"] * PIXEL_UJY, phot_err_ujy=r["err"] * PIXEL_UJY,
                 phot_snr=r["flux"] / r["err"], blended=r["blended"])
        i["_blank"] = blank_snr(i)
    # a detector whose exposures all have a saturated core (no forced fit) stays in: its cells
    # count as detected (saturated_frac 1) and its exposures go to the wing-fit astrometry
    dets = sorted({i["detector"] for i in infos if "phot_snr" in i or i.get("phot_sat_only")})
    cells, detected = [], set()
    for e in epochs:
        for d in dets:
            c = combine_cell([i for i in infos if i.get("epoch") == e and i["detector"] == d])
            if c is None:
                continue
            c.update(epoch=e, detector=d)
            # a saturated core at the predicted position also counts (a bright source is there)
            c["detected"] = bool((c["snr"] or 0) >= DETECT_SNR or c["saturated_frac"] > 0.5)
            if c["detected"]:
                detected.add((e, d))
            cells.append(c)
    bins = []
    for b, d in BINS:
        for e in epochs:
            c = combine_cell([i for i in infos if i.get("epoch") == e and i.get("bin_um") == b])
            if c is None:
                continue
            c.update(epoch=e, wavelength_um=b, detector=d,
                     detected=bool((c["snr"] or 0) >= DETECT_SNR or c["saturated_frac"] > 0.5))
            bins.append(c)
    for c in cells:
        print(f"  S/N {c['epoch']} {c['detector']} ({c['lam_min_um']:.2f}-{c['lam_max_um']:.2f} um, N={c['n']}): "
              + (f"{c['flux_ujy']:+.0f} +- {c['err_ujy']:.0f} uJy  S/N {c['snr']:+.1f}" if c["snr"] is not None else "no fit")
              + f"{'  saturated' if c['saturated_frac'] > 0.5 else ''}{'  DETECTED' if c['detected'] else ''}")

    seasons = sorted({e for e, _ in detected})
    det_dets = sorted({d for _, d in detected})
    det_bins = [b for b, _ in BINS if any(c["detected"] and c["wavelength_um"] == b for c in bins)]
    if not detected:
        status = "not_detected"
    elif len(seasons) < 2:
        status = "detected_one_season"
    elif len(detected) == len(cells):
        status = "detected"
    else:
        status = "partial"
    thr = f"{DETECT_SNR:.0f}σ"
    best = max((c for c in cells if c["snr"] is not None), key=lambda c: c["snr"], default=None)
    if status == "not_detected":
        msg = (f"Not detected above {thr} in single-season stacks"
               + (f" (best S/N {best['snr']:.1f}, {best['detector']} {best['epoch']})." if best else "."))
    else:
        undet_bins = [b for b, _ in BINS if b not in det_bins and any(c["wavelength_um"] == b for c in bins)]
        where = (f"at {', '.join(f'{b:.1f}' for b in det_bins)} µm" if det_bins
                 else f"in {'+'.join(det_dets)}")
        if status == "detected" and not undet_bins:
            msg = f"Detected above {thr} in every season and wavelength bin."
        elif not undet_bins:
            msg = (f"Detected above {thr} in every wavelength bin; some season x detector stacks are "
                   f"below {thr} (fitted only where detected).")
        elif status == "detected_one_season":
            msg = f"Detected {where} (≥{thr}) in season {seasons[0]} only: no motion measurement."
        else:
            msg = (f"Detected {where} only (≥{thr} in single-season stacks, detectors {', '.join(det_dets)})"
                   + (f"; not detected at {', '.join(f'{b:.1f}' for b in undet_bins)} µm." if undet_bins else "."))
    # blends: distance of the predicted track from catalogue neighbours, per season
    blends = []
    nbl = t.get("neighbors", {}).get("list", [])
    for e in epochs:
        s = [i for i in infos if i.get("epoch") == e and i["inside"]]
        if not s or not nbl:
            continue
        rp, dp = float(np.mean([i["ra_pred"] for i in s])), float(np.mean([i["dec_pred"] for i in s]))
        dd = [(offset_arcsec(rp, dp, n[0], n[1])[2], n) for n in nbl]
        dmin, n = min(dd, key=lambda q: q[0])
        blends.append({"epoch": e, "nearest_arcsec": round(dmin, 1), "nearest": n[2],
                       "nearest_w2_mag": n[3] if len(n) > 3 else None})
    det = {"status": status, "message": msg, "threshold_snr": DETECT_SNR,
           "detected_detectors": det_dets, "detected_bins_um": det_bins, "detected_seasons": seasons,
           "cells": cells, "bins": bins, "blend_check": blends,
           "neighbour_catalogue": t.get("neighbors", {}).get("source"),
           "method": ("forced fit of the SPHEREx empirical PSF (EPSF extension) at the predicted position, "
                      "flux free, catalogue neighbours and Gaia DR3 field stars fitted at fixed positions, "
                      "constant background; "
                      "11x11 native-pixel stamp; inverse-variance mean per season; errors scaled by the "
                      "robust S/N scatter of the same fit at random positions (noise_scale)."),
           "flux_unit_note": "uJy within the EPSF footprint (+-3.3 px); far wings not included"}
    if not nbl:
        det["blend_note"] = (("Gaia DR3 field stars are fitted together with the target; sources not in Gaia "
                              "(e.g. very red objects) are not modelled.") if t.get("_gaia_nb") else
                             "No neighbour catalogue for this target: blends with background sources not checked.")
    print("detection:", status, "-", msg)
    return det, detected


# ---- faint-target astrometry --------------------------------------------------------------
def offset_chi2(i, oE, oN):
    """chi2 of the ePSF + neighbours + background fit in exposure i for trial target offsets
    (oE, oN arcsec, arrays) from the predicted position. Target flux is free but >= 0."""
    px = i["_px"]
    st = stamp(px, i["x"], i["y"])
    if st is None:
        return None, None
    ix, iy, d, w, g = st
    cols, _ = neighbour_columns(px, ix, iy, i["x"], i["y"], i["_nb"])
    Bm = np.stack(cols, 1)[g] * w[g, None]
    U, sv, _ = np.linalg.svd(Bm, full_matrices=False)
    Q = U[:, sv > 1e-9 * sv.max()]
    r = d[g] * w[g]
    rp = r - Q @ (Q.T @ r)
    Jinv = np.linalg.inv(np.array(i["jac_pred"]))
    # the field-star calibration says the WCS puts Gaia stars at (true + cal): a source at
    # true offset o from the prediction sits at WCS offset o + cal
    cE, cN = (i["_cal"]["east"], i["_cal"]["north"]) if "_cal" in i else (0.0, 0.0)
    dx = Jinv[0, 0] * (oE + cE) + Jinv[0, 1] * (oN + cN)
    dy = Jinv[1, 0] * (oE + cE) + Jinv[1, 1] * (oN + cN)
    K = epsf_kernels(px, i["x"] - ix + dx, i["y"] - iy + dy)[:, g] * w[g]
    Kp = K - (K @ Q) @ Q.T
    a = Kp @ rp
    b = np.sum(Kp ** 2, 1)
    imp = np.where((a > 0) & (b > 0), a * a / np.maximum(b, 1e-300), 0.0)
    return float(rp @ rp) - imp, float(rp @ rp)


def grid_min(tot, gE, gN):
    """Minimum of a chi2 map on a regular grid, refined by a parabola along each axis."""
    n = len(gE)
    T = tot.reshape(n, n)                       # rows = N, cols = E
    k = int(np.argmin(T))
    jn, je = divmod(k, n)
    step = gE[1] - gE[0]

    def para(a, b, c):
        den = a - 2 * b + c
        return 0.0 if den <= 0 else float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))
    oE = gE[je] + (para(T[jn, je - 1], T[jn, je], T[jn, je + 1]) * step if 0 < je < n - 1 else 0.0)
    oN = gN[jn] + (para(T[jn - 1, je], T[jn, je], T[jn + 1, je]) * step if 0 < jn < n - 1 else 0.0)
    edge = je in (0, n - 1) or jn in (0, n - 1)
    return oE, oN, float(T[jn, je]), edge


def faint_astrometry(t, used, epochs, ra_c, dec_c, grid_xy):
    """Season positions of a faint (unsaturated) target: the ePSF position common to all
    exposures of the season (detected detectors only) that minimises the summed chi2, with
    catalogue neighbours modelled; then a linear proper-motion fit across seasons."""
    positions, rejected = [], []
    cg = np.arange(-FAINT_SEARCH, FAINT_SEARCH + 1e-9, FAINT_COARSE)
    for e in epochs:
        s = [i for i in used if i["epoch"] == e and "_nb" in i]
        CE, CN = np.meshgrid(cg, cg)
        maps, keep, nulls = [], [], []
        for i in s:
            m, n0 = offset_chi2(i, CE.ravel(), CN.ravel())
            if m is not None:
                maps.append(m); keep.append(i); nulls.append(n0)
        if len(keep) < 2:
            continue
        oE0, oN0, _, _ = grid_min(np.sum(maps, 0), cg, cg)
        fE = np.arange(-FAINT_FINE_HALF, FAINT_FINE_HALF + 1e-9, FAINT_FINE) + round(oE0, 1)
        fN = np.arange(-FAINT_FINE_HALF, FAINT_FINE_HALF + 1e-9, FAINT_FINE) + round(oN0, 1)
        FE, FN = np.meshgrid(fE, fN)
        fm = np.array([offset_chi2(i, FE.ravel(), FN.ravel())[0] for i in keep])
        tot = fm.sum(0)
        oE, oN, cmin, edge = grid_min(tot, fE, fN)
        if edge or abs(oE0) >= FAINT_SEARCH - FAINT_COARSE or abs(oN0) >= FAINT_SEARCH - FAINT_COARSE:
            print(f"  {e}: chi2 minimum at the edge of the search grid ({oE0:+.1f}, {oN0:+.1f}\"): season not used")
            rejected.append({"epoch": e, "reason": "chi2 minimum at the edge of the search grid",
                             "offset_arcsec": [round(oE0, 1), round(oN0, 1)]})
            continue
        src_snr = math.sqrt(max(sum(nulls) - cmin, 0))       # sqrt(delta chi2): S/N at the fitted position
        scale = robust_sigma([v for i in keep for v in i["_blank"]])
        scale = max(1.0, scale) if np.isfinite(scale) else 1.0
        # errors 1: chi2 curvature (quadratic fit where delta chi2 < 6), scaled by the noise
        sel = tot - cmin < 6
        cov = None
        if sel.sum() >= 8:
            X, Y = FE.ravel()[sel] - oE, FN.ravel()[sel] - oN
            A = np.stack([np.ones_like(X), X, Y, X * X, X * Y, Y * Y], 1)
            c, *_ = np.linalg.lstsq(A, tot[sel], rcond=None)
            H = np.array([[2 * c[3], c[4]], [c[4], 2 * c[5]]])
            if np.all(np.linalg.eigvalsh(H) > 0):
                cov = 2 * np.linalg.inv(H) * scale ** 2
        curv = (math.sqrt(cov[0, 0]), math.sqrt(cov[1, 1])) if cov is not None else (float("nan"),) * 2
        # errors 2: bootstrap over the exposures
        rng = np.random.default_rng(zlib.crc32(e.encode()))
        bs = np.array([grid_min(fm[rng.integers(0, len(keep), len(keep))].sum(0), fE, fN)[:2]
                       for _ in range(N_BOOT)])
        boot = (float(np.std(bs[:, 0])), float(np.std(bs[:, 1])))
        errE = float(np.nanmax([curv[0], boot[0]]))
        errN = float(np.nanmax([curv[1], boot[1]]))
        rp = float(np.mean([i["ra_pred"] for i in keep])); dp = float(np.mean([i["dec_pred"] for i in keep]))
        cosd = math.cos(math.radians(dp))
        rm, dm = rp + oE / 3600 / cosd, dp + oN / 3600
        pr_pm = np.array([target_position(t, i["mjd"], with_parallax=False) for i in keep])
        mjd = float(np.mean([i["mjd"] for i in keep]))
        ori = float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians([i["orient_deg"] for i in keep])))))) % 360
        flags = []
        if edge:
            flags.append("chi2 minimum at the edge of the search grid")
        for nb in t.get("neighbors", {}).get("list", []):
            dn = offset_arcsec(rm, dm, nb[0], nb[1])[2]
            if dn < 3.0:
                flags.append(f"fitted position {dn:.1f}\" from catalogue source {nb[2]}")
        positions.append({"epoch": e, "ra": rm, "dec": dm, "bias_corrected": False, "ra_raw": rm, "dec_raw": dm,
                          "mjd": round(mjd, 4), "orient_deg": round(ori, 1), "date": Time(mjd, format="mjd").iso[:10],
                          "n_images": len(keep), "n_rejected": len(s) - len(keep),
                          "detectors": sorted({i["detector"] for i in keep}),
                          "err_east_arcsec": round(errE, 3), "err_north_arcsec": round(errN, 3),
                          "err_curvature_arcsec": [round(v, 3) for v in curv], "err_bootstrap_arcsec": [round(v, 3) for v in boot],
                          "source_snr": round(src_snr, 1), "noise_scale": round(scale, 2), "flags": flags,
                          "gaia_ra": rp, "gaia_dec": dp,
                          "gaia_ra_pm_only": float(pr_pm[:, 0].mean()), "gaia_dec_pm_only": float(pr_pm[:, 1].mean()),
                          "minus_gaia_east_arcsec": round(oE, 3), "minus_gaia_north_arcsec": round(oN, 3),
                          "raw_minus_gaia_east_arcsec": round(oE, 3), "raw_minus_gaia_north_arcsec": round(oN, 3),
                          "png_xy_measured": [round(v, 1) for v in grid_xy(rm, dm)],
                          "png_xy_gaia": [round(v, 1) for v in grid_xy(rp, dp)]})
        print(f"  {e}: N={len(keep)} {'+'.join(sorted({i['detector'] for i in keep}))}  measured-predicted = "
              f"{oE:+.2f}\" E {oN:+.2f}\" N  (+-{errE:.2f}, {errN:.2f}; curvature {curv[0]:.2f}, {curv[1]:.2f}; "
              f"bootstrap {boot[0]:.2f}, {boot[1]:.2f})  S/N {src_snr:.1f} {flags or ''}")

    measured = {"positions": positions, "astrometry_path": "faint", "rejected_seasons": rejected}
    if len(positions) >= 2:
        ys, ws, rows = [], [], []
        for p in positions:
            E, N = offset_arcsec(ra_c, dec_c, p["ra"], p["dec"])[:2]
            pE, pN = offset_arcsec(p["gaia_ra_pm_only"], p["gaia_dec_pm_only"], p["gaia_ra"], p["gaia_dec"])[:2]
            ty = Time(p["mjd"], format="mjd").jyear - EPOCH_CENTER
            for comp, (val, err) in enumerate(((E - pE, p["err_east_arcsec"]), (N - pN, p["err_north_arcsec"]))):
                r = np.zeros(4); r[comp] = 1; r[2 + comp] = ty
                rows.append(r); ys.append(val); ws.append(1 / max(err, 1e-3))
        A = np.array(rows) * np.array(ws)[:, None]
        y = np.array(ys) * np.array(ws)
        p, *_ = np.linalg.lstsq(A, y, rcond=None)
        cov = np.linalg.pinv(A.T @ A)
        dof = len(y) - 4
        chi2 = float(np.sum((y - A @ p) ** 2))
        sc = math.sqrt(chi2 / dof) if dof > 0 and chi2 > dof else 1.0
        err = np.sqrt(np.diag(cov)) * sc
        measured["fit"] = {
            "pmra_mas_yr": round(float(p[2]) * 1000, 1), "pmdec_mas_yr": round(float(p[3]) * 1000, 1),
            "pmra_err_mas_yr": round(float(err[2]) * 1000, 1), "pmdec_err_mas_yr": round(float(err[3]) * 1000, 1),
            "gaia_pmra_mas_yr": t["pmra"], "gaia_pmdec_mas_yr": t["pmdec"],
            "pos_2026_minus_gaia_east_arcsec": round(float(p[0]), 3), "pos_2026_minus_gaia_north_arcsec": round(float(p[1]), 3),
            "parallax_fixed_mas": t["plx"], "detector_bias_arcsec_xy": {},
            "n_used": int(sum(q["n_images"] for q in positions)), "n_clipped": 0, "n_seasons": len(positions),
            "chi2": round(chi2, 2), "dof": dof,
            "note": ("Weighted linear fit of the season positions (season ePSF fits): position + free proper "
                     "motion + catalogue parallax. No detector bias term (unsaturated source, the EPSF is "
                     "built from unsaturated stars). " + ("Errors scaled by sqrt(chi2/dof)." if sc > 1 else
                     "No degrees of freedom left: errors are formal." if dof <= 0 else "")),
        }
        f = measured["fit"]
        print(f"  season fit: pm = {f['pmra_mas_yr']:+.0f} +- {f['pmra_err_mas_yr']:.0f}, "
              f"{f['pmdec_mas_yr']:+.0f} +- {f['pmdec_err_mas_yr']:.0f} mas/yr (catalogue {t['pmra']:+.0f}, "
              f"{t['pmdec']:+.0f}); chi2 {chi2:.1f} / {dof}")
    pairs_and_headline(measured, positions, min_n=5, method=(
        "season ePSF fit: SPHEREx empirical PSF fitted at one common position to all exposures of a "
        "season from the detectors where the target is detected, with catalogue neighbours at fixed "
        "positions and free fluxes; chi2 grid search around the prediction; errors = larger of the "
        "chi2 curvature (noise-scaled) and a bootstrap over exposures. Prediction = catalogue proper "
        "motion + annual parallax (Earth barycentric)."))
    return measured


# ---- relative photometry (brightness targets) ---------------------------------------------
def find_comparison_stars(med, eps, grid, tx, ty):
    """Candidate comparison stars in the season stacks of one bin: bright, isolated local
    maxima with no saturated pixel nearby, >= 60" from the target, away from the edge."""
    from scipy.ndimage import maximum_filter, binary_dilation
    st = np.nanmedian(np.stack([med[e][0] for e in eps]), axis=0)
    anysat = np.any(np.stack([med[e][1] for e in eps]), axis=0)
    noise = robust_sigma(st)
    f = np.where(np.isfinite(st), st, -np.inf)
    peaks = (f == maximum_filter(f, size=5)) & (f > 15 * noise)
    satd = binary_dilation(anysat, iterations=5)
    ny, nx = st.shape
    pk = [(float(f[y, x]), int(x), int(y)) for y, x in zip(*np.nonzero(peaks))]
    allpk = [(float(f[y, x]), int(x), int(y)) for y, x in zip(*np.nonzero((f == maximum_filter(f, size=5)) & (f > 5 * noise)))]
    out = []
    for v, x, y in sorted(pk, reverse=True):
        if satd[y, x] or not (12 <= x < nx - 12 and 12 <= y < ny - 12):
            continue
        if math.hypot(x - tx, y - ty) * PIX_ARCSEC < 60:
            continue
        if any(0 < math.hypot(x - x2, y - y2) * PIX_ARCSEC < 30 and v2 > 0.1 * v for v2, x2, y2 in allpk):
            continue                                    # a neighbour > 10 % of its peak within 30"
        w = np.clip(np.nan_to_num(st[y - 1:y + 2, x - 1:x + 2]), 0, None)
        yy, xx = np.mgrid[y - 1:y + 2, x - 1:x + 2]
        cx, cy = (float((w * xx).sum() / w.sum()), float((w * yy).sum() / w.sum())) if w.sum() > 0 else (x, y)
        ra, dec = (float(q) for q in grid.all_pix2world(cx, cy, 0))
        out.append({"ra": ra, "dec": dec, "peak_mjy_sr": round(v, 3)})
        if len(out) >= 4 * PHOT_COMPS:
            break
    return out


def saturated_radius(px, x, y):
    """Radius (native px) of the saturated / missing core around (x, y); 0 if none."""
    from scipy.ndimage import label
    m = px["satnan"]
    ny, nx = m.shape
    yy, xx = np.mgrid[:ny, :nx]
    rr = np.hypot(xx - x, yy - y)
    lab, n = label(m)
    ids = set(np.unique(lab[(rr < 1.5) & m])) - {0}
    if not ids:
        return 0.0
    return float(rr[np.isin(lab, list(ids))].max()) + 0.5


def relative_photometry(t, infos, bin_stacks, grid, ra_c, dec_c):
    """Target flux relative to 2-5 comparison stars in the same exposures, per season and bin.
    Unsaturated target: ePSF flux. Saturated core: mean surface brightness in an annulus just
    outside the largest saturated core of the bin (same annulus in every season), i.e. a
    wing-based estimate (flagged). Season value = median over exposures; error = scatter /
    sqrt(N) plus the apparent variation of the comparison stars themselves."""
    tx, ty = (float(v) for v in grid.all_world2pix(ra_c, dec_c, 0))
    res = []
    for b, eps, med in bin_stacks:
        exs = [i for i in infos if i.get("bin_um") == b and i["inside"] and i.get("epoch") in eps]
        cands = find_comparison_stars(med, eps, grid, tx, ty)
        # comparison fluxes per exposure (forced ePSF fit at the stack position)
        F = np.full((len(exs), len(cands)), np.nan)
        for a, i in enumerate(exs):
            px = i["_px"]
            for k, c in enumerate(cands):
                cx, cy = (float(v) for v in px["wcs"].all_world2pix(c["ra"], c["dec"], 0))
                ix, iy = int(round(cx)), int(round(cy))
                if not (STAMP_R <= ix < px["clean"].shape[1] - STAMP_R and STAMP_R <= iy < px["clean"].shape[0] - STAMP_R):
                    continue
                if px["satnan"][iy - 2:iy + 3, ix - 2:ix + 3].any():
                    continue
                r = forced_phot(px, cx, cy)
                if r and r["flux"] > 10 * r["err"]:
                    F[a, k] = r["flux"]
        okc = [k for k in range(len(cands)) if np.isfinite(F[:, k]).mean() >= 0.8] if len(exs) else []
        okc = sorted(okc, key=lambda k: -np.nanmedian(F[:, k]))[:PHOT_COMPS]
        entry = {"wavelength_um": b, "detector": BIN_DET[b], "seasons": [], "flags": []}
        res.append(entry)
        if len(okc) < PHOT_MIN_COMPS:
            entry["flags"].append(f"fewer than {PHOT_MIN_COMPS} usable comparison stars: no photometry")
            continue
        F = F[:, okc] / np.nanmedian(F[:, okc], axis=0)            # each comparison normalised to 1
        C = np.nanmean(F, axis=1)                                    # ensemble per exposure
        # target
        rs = np.array([saturated_radius(i["_px"], i["x"], i["y"]) for i in exs])
        if np.all(rs == 0):
            method, r_in, r_out = "psf", None, None
            T = np.array([(lambda q: q["flux"] if q else np.nan)(forced_phot(i["_px"], i["x"], i["y"])) for i in exs])
        else:
            method = "annulus"
            r_in = max(2.0, math.ceil(np.percentile(rs, 90)) + 1.0)
            r_out = r_in + 3.0
            T = np.full(len(exs), np.nan)
            for a, i in enumerate(exs):
                if rs[a] > r_in - 0.5:
                    continue
                px = i["_px"]
                ny, nx = px["clean"].shape
                yy, xx = np.mgrid[:ny, :nx]
                rr = np.hypot(xx - i["x"], yy - i["y"])
                ann = (rr >= r_in) & (rr < r_out)
                m = ann & px["good"]
                if m.sum() >= 0.5 * ann.sum():
                    T[a] = float(np.mean(px["clean"][m]))
        V = T / C
        ncomp_ok = np.isfinite(F).sum(1)
        V[ncomp_ok < PHOT_MIN_COMPS] = np.nan
        entry.update(method=method, saturated=method == "annulus",
                     annulus_arcsec=[round(r_in * PIX_NATIVE, 1), round(r_out * PIX_NATIVE, 1)] if r_in else None,
                     comparison_stars=[{"ra": round(cands[k]["ra"], 6), "dec": round(cands[k]["dec"], 6)} for k in okc],
                     n_comparison=len(okc))
        if method == "annulus":
            entry["flags"].append("saturated core: wing (annulus) estimate")
        # comparison-star systematic: apparent season-to-season change of each comparison
        # star measured against the others
        ep_ok = [e for e in eps if np.isfinite(V[[i["epoch"] == e for i in exs]]).any()]
        dev = []
        for k in range(F.shape[1]):
            others = np.nanmean(np.delete(F, k, axis=1), axis=1)
            q = [np.nanmedian((F[:, k] / others)[[i["epoch"] == e for i in exs]]) for e in ep_ok]
            dev += [q[j] / q[0] - 1 for j in range(1, len(q)) if np.isfinite(q[j]) and np.isfinite(q[0])]
        sys_frac = float(np.sqrt(np.mean(np.square(dev)))) if dev else 0.0
        entry["comparison_scatter_frac"] = round(sys_frac, 4)
        rows = []
        for e in ep_ok:
            sel = np.array([i["epoch"] == e for i in exs]) & np.isfinite(V)
            v = V[sel]
            lam = float(np.median([i["wavelength_um"] for i, s in zip(exs, sel) if s]))
            val = float(np.median(v))
            # robust scatter (one bad exposure must not dominate); error of a median
            sc = robust_sigma(v) if len(v) >= 3 else float(np.std(v, ddof=1)) if len(v) == 2 else float("nan")
            if len(v) >= 3 and not sc > 0:
                sc = float(np.std(v, ddof=1))
            err = float(1.2533 * sc / math.sqrt(len(v))) if len(v) >= 2 else float("nan")
            rows.append({"epoch": e, "n": int(len(v)), "wavelength_um": round(lam, 3), "value": val, "err": err})
        fr = [r["err"] / r["value"] for r in rows if np.isfinite(r["err"]) and r["value"] > 0]
        for r in rows:                                   # single-exposure season: typical scatter
            if not np.isfinite(r["err"]):
                r["err"] = float(np.median(fr) * r["value"]) if fr else float("nan")
                r["err_from_other_seasons"] = True
        if not rows or rows[0]["value"] <= 0:
            entry["flags"].append("reference season has no positive flux")
            continue
        v0, e0 = rows[0]["value"], rows[0]["err"]
        for r in rows:
            R = r["value"] / v0
            rel = math.sqrt((r["err"] / r["value"]) ** 2 + (e0 / v0) ** 2 + (sys_frac ** 2 if r is not rows[0] else 0)) \
                if r["value"] > 0 else float("nan")
            entry["seasons"].append({"epoch": r["epoch"], "n_images": r["n"], "wavelength_um": r["wavelength_um"],
                                     "ratio_to_first": round(R, 3),
                                     "ratio_err": round(R * rel, 3) if r is not rows[0] else 0.0,
                                     "dmag": round(-2.5 * math.log10(R), 3) if R > 0 else None,
                                     "dmag_err": round(1.0857 * rel, 3) if R > 0 and r is not rows[0] else 0.0,
                                     **({"err_from_other_seasons": True} if r.get("err_from_other_seasons") else {})})
        lams = [r["wavelength_um"] for r in rows]
        if max(lams) / min(lams) - 1 > 0.02:
            entry["flags"].append("seasons sample different wavelengths within the bin "
                                  f"({min(lams):.2f}-{max(lams):.2f} um)")
        print(f"  phot {b:.1f} um ({method}, {len(okc)} comps, comp scatter {100 * sys_frac:.1f} %): " +
              ", ".join(f"{s['epoch']} {s['ratio_to_first']:.3f}+-{s['ratio_err']:.3f} (N={s['n_images']})"
                        for s in entry["seasons"]))
    return {"bins": res, "reference": "first season with data in each bin",
            "method": ("Target flux divided by the mean of 2-5 comparison stars (each normalised to its median), "
                       "per exposure; season value = median. Unsaturated target: forced EPSF flux. Saturated "
                       "core: mean surface brightness in an annulus just outside the largest saturated core "
                       "of the bin (same annulus in every season) - a wing-based estimate, flagged. Error = "
                       "robust scatter/sqrt(N) of both seasons + the apparent season-to-season change of the "
                       "comparison stars (comparison_scatter_frac)."),
            "caveats": ["Static field stars inside the annulus dilute the measured change.",
                        "A bin spans +-6 % in wavelength; molecular bands can make the ratio depend on "
                        "where in the bin each season was observed."]}



# ---- main -------------------------------------------------------------------------------
def main(name, inline=None):
    t = load_target(name, inline)
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
        info["bin_um"] = which_bin(info["wavelength_um"], info["detector"])
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

    wbins, bin_stacks = [], []
    for b in bins:
        eps = [e for e in epochs if (b, e) in groups]
        med = {}
        for e in eps:
            g = groups[(b, e)]
            med[e] = (np.nanmedian(np.stack([x[1] for x in g]), axis=0),
                      clean_satmask(np.mean(np.stack([x[2] for x in g]), axis=0) > 0.5))
        bin_stacks.append((b, eps, med))
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

    # ---- motion targets: detection check first, then astrometry on what is detected ----
    if t.get("kind", "motion") == "motion":
        global GAIA_RADIUS_DEG                       # wider cutouts need a wider Gaia query
        GAIA_RADIUS_DEG = max(GAIA_RADIUS_DEG, round(footprint_radius(infos, ra_c, dec_c), 3))
        # Gaia DR3 field stars near the target: fitted as fixed-position neighbours
        try:
            gf = gaia_field(name, ra_c, dec_c)
            cosc = math.cos(math.radians(dec_c))
            t["_gaia_nb"] = [(s_[1], s_[2], s_[3], s_[4], s_[6]) for s_ in gf["stars"]
                             if math.hypot((s_[1] - ra_c) * cosc, s_[2] - dec_c) * 3600 < 75]
        except Exception as e:
            print("  WARNING: no Gaia field stars for the neighbour model:", e)
        detection, detected = detection_check(t, infos, epochs)
        used = [i for i in infos if i["inside"] and (i.get("epoch"), i["detector"]) in detected]
        snrs = [i["phot_snr"] for i in used if "phot_snr" in i]
        satfrac = float(np.mean([bool(i["saturated"]) for i in used])) if used else 0.0
        bright = bool(used) and (satfrac > 0.5 or float(np.median(snrs)) >= BRIGHT_SNR)
        detection["astrometry_path"] = "bright" if bright else "faint"
        detection["median_exposure_snr"] = round(float(np.median(snrs)), 1) if snrs else None
        if detection["status"] in ("not_detected", "detected_one_season"):
            measured = {"positions": [], "pairs": []}
        else:
            if bright:
                refit_with_neighbours(t, used)
            calib = field_calibration(t, name, used, "bright" if bright else "faint", ra_c, dec_c)
            if bright:
                measured = astrometry(t, used, epochs, ra_c, dec_c, grid_xy)
                measured["astrometry_path"] = "bright"
            else:
                measured = faint_astrometry(t, used, epochs, ra_c, dec_c, grid_xy)
            measured["field_calibration"] = calib
        if t.get("finding"):
            measured["finding"] = t["finding"]
        measured["status"] = detection["status"]
        measured["message"] = detection["message"]
        measured["detection"] = detection
    else:
        measured = {"positions": [], "pairs": [], "status": "brightness",
                    "photometry": relative_photometry(t, infos, bin_stacks, grid, ra_c, dec_c)}
    # where the catalogue puts the target in each season (viewer marker), independent of
    # whether it was measured
    markers = []
    for e in epochs:
        s_ = [i for i in infos if i.get("epoch") == e and i["inside"]]
        if s_:
            rp, dp = float(np.mean([i["ra_pred"] for i in s_])), float(np.mean([i["dec_pred"] for i in s_]))
            markers.append({"epoch": e, "ra": rp, "dec": dp, "png_xy": [round(v, 1) for v in grid_xy(rp, dp)]})


    # per-exposure table
    cols = ["file", "collection", "obs_id", "date", "mjd", "epoch", "detector", "wavelength_um",
            "bandwidth_um", "bin_um", "orient_deg", "x", "y", "inside", "flags_at_target", "saturated",
            "ra_pred", "dec_pred", "x_fit", "y_fit", "ra_fit", "dec_fit", "fit_method", "fit_quality", "fit_npix",
            "phot_flux_ujy", "phot_err_ujy", "phot_snr", "blended", "calib_east_arcsec", "calib_north_arcsec", "calib_nstars"]
    with open(out / "images.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for i in sorted(infos, key=lambda r: r["mjd"]):
            w.writerow({k: (f"{v:.7f}" if isinstance(v, float) else v) for k, v in i.items() if not k.startswith("_")})


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
                 "pmra_mas_yr": t["pmra"], "pmdec_mas_yr": t["pmdec"], "parallax_mas": t["plx"],
                 "label": "Gaia DR3" if t.get("gaia_dr3") else t.get("astrometry_label", "catalogue"),
                 "reference": t.get("notes", ""), "parallax_reference": t.get("plx_source", "")},
        "markers": markers,
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
    args = sys.argv[1:]
    inline = None
    if "--target-json" in args:
        k = args.index("--target-json")
        inline = json.loads(args[k + 1])
        del args[k:k + 2]
    main(args[0] if args else "barnard", inline)
