"""Detector P: distant Solar System bodies (the "Planet X" case) by parallax-linked orphans.

A body at d = 150-10000 AU does not move like a star. SPHEREx sees a field at solar elongation
~80-130 deg, twice a year (opposite spacecraft orientations), so from one season to the next the
Earth is on the other side of the Sun and the body jumps by the reflex parallax
    |Pi_b - Pi_a| / d,   |Pi_b - Pi_a| = 3.8-4.1e5 arcsec AU (measured from the real exposure times),
i.e. 1350" at 300 AU, 820" at 500 AU, 510" at 800 AU, 270" at 1500 AU, while between the two
same-orientation seasons one year apart the parallax nearly cancels (1e3-3e4 arcsec AU / d) and
the slow orbital motion remains (bound orbit: <= 1.83e6 / d^1.5 "/yr, 352"/yr at 300 AU, 31"/yr
at 1500 AU). Within one season (10-55 days) the body trails along the parallax direction by up
to 9e4 arcsec AU / d (110" at 800 AU in a field at ecliptic latitude -45 deg).
In the data it is a faint point source present at one place in one season and absent there in
the others: an "orphan".

Method
1. Own TAN grid (PIX arcsec/px) over the whole cutout (0.2 or 0.4 deg). Every exposure is
   resampled (WCS + Gaia registration offset ctx.cal), a template made of the SAME detector's
   exposures of the OTHER seasons at matched wavelength (|ln lambda ratio| <= TPL_DLNL, clipped
   inverse-variance mean) is subtracted, and the residual is matched-filtered (Gaussian EPSF
   width of the detector). Noise: VARIANCE + template variance + (EPS x PSF-smoothed static
   brightness)^2 (PSF/colour mismatch of stars); the statistic is put in units of its measured
   robust scatter.
2. Per season, shift-and-stack of the residuals along the parallax trail for trial w = 1/d
   (exposure i shifted by w (Pi_i - mean Pi), Pi_i = parallax factor of the exposure from the
   Earth's barycentric position (astropy built-in ephemeris) + spacecraft position X_SC/Y_SC/Z_SC).
   Orphans = peaks of max_w Z >= Z_ORPHAN that are not in a saturated zone, not within reach of a
   static source more than K_STATIC times brighter, not at the edge, and do not depend on one
   visit (drop-one-visit test).
3. Linking: orphans of >= 3 seasons must fit
       P_s = (P0 + mu (t_s - t0) + w Pi_s) / (1 - w lambda_s)     (lambda_s = observer . line of sight, AU)
   with 1/D_MAX <= w <= 1/D_MIN, a bound orbit |mu| <= K_ESC w^1.5, the per-season trail estimates
   of w, chi2 probability >= CHI2_P and consistent fluxes. A fourth season is checked by forced
   photometry at the predicted position.
4. False-link probability measured on the field itself: the orphan lists of every season are
   randomised (independent toroidal shifts + 90 deg turns/flips of each season's list, N_RAND times),
   linked again, and FAP = (1 + number of randomised fields with a link scoring >= the candidate) /
   (1 + N_RAND). confidence.percent = 100 (1 - FAP). A season-label permutation test is reported too.

Output: records of kind 'motion', class 'candidate', nature.label 'distant-solar-system-candidate';
'confirmed' only under the strict rule CONFIRM (all checks pass, FAP <= CONF_FAP).
Language: candidates, never discoveries.

ctx attributes used: exps (blink layout: file, path, mjd, jyear, epoch, detector, wavelength_um,
orient_deg, visit (optional), _px{clean, var, good, satnan, wcs}), cal ({file: (east, north) arcsec}),
seasons, field.ra / field.dec, log, info, images (optional, injection), shared (optional cache).
No other module of the finder is used except schema.new_candidate / schema.motion_dict.
"""
import math
import re
import time
from itertools import combinations, permutations

import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates, maximum_filter, binary_dilation
from scipy.spatial import cKDTree
from scipy.stats import chi2 as _chi2

from . import schema as SC

NAME = "P"
VERSION = "distant-v2"
RAD = 206264.806
AU_KM = 149597870.7
K_ESC = math.sqrt(2.0) * 2 * math.pi * RAD     # "/yr AU^1.5: transverse motion of a bound body <= K_ESC w^1.5
K_CIRC = 2 * math.pi * RAD                     # circular-orbit speed: K_CIRC w^1.5 "/yr
PIX_NATIVE = 6.15
PIXEL_UJY = 1e12 * (PIX_NATIVE / RAD) ** 2     # 1 MJy/sr over one native pixel in uJy
PSF_NATIVE = {1: 0.61, 2: 0.61, 3: 0.64, 4: 0.69, 5: 0.69, 6: 0.70}   # EPSF Gaussian sigma, native px

PIX = 4.0                   # arcsec per grid pixel (PSF sigma 1.2 px)
D_MIN, D_MAX = 150.0, 10000.0   # AU searched
COARSE = 8                  # WCS evaluated every COARSE grid px, bilinear in between (< 0.01 px error)
TPL_DLNL = 0.03             # template: other-season exposures of the same detector within 3 % in wavelength
TPL_MIN = 4                 # ... at least this many (else the nearest in wavelength)
TPL_OPP_DEG = 90.0          # ... and seen in the opposite spacecraft orientation (see residuals())
CLIP = 5.0                  # template per-pixel clipping (sigma)
EPS = 0.15                  # PSF/colour mismatch of static sources in a residual (fraction of the brightness)
Z_ORPHAN = 5.0              # orphan threshold (noise units, after the max over trial distances)
BG_BLOCK = 12               # grid px (48"): block-median background removed from every residual (the
                            # zodiacal / large-scale offsets differ between seasons)
NOISE_BLOCK = 20            # grid px (80"): the noise unit is the LOCAL robust scatter (bright-star halos,
                            # crowding and scattered light make the noise vary across the cutout)
EDGE_ARCSEC = 16.0          # orphans this close to the coverage edge are not used
COVER_FRAC = 0.4            # coverage: exposures seeing a pixel >= COVER_FRAC x the season median ...
COVER_STAR = 1.5            # ... counting an exposure only where the mismatch noise of static sources
                            # (EPS x brightness)^2 <= COVER_STAR x the photon variance
SAT_R_ARCSEC = 20.0         # orphans this close to a saturated core are not used
K_STATIC = 3.0              # ... nor where the static flux AT the orphan is >= K_STATIC x its flux
STATIC_R = 4.0              # arcsec (kept for reference; the veto uses the static flux AT the orphan)
STATIC_FMIN = 10.0          # uJy: static peaks (local maxima of the all-exposure flux map) used by the two vetoes
STAR_POS_ERR = 1.5          # arcsec: position error of a static peak on the 4" grid (parabola refined)
DROP_FRAC = 0.6             # drop-one-visit: S/N without the strongest visit >= DROP_FRAC x S/N (and >= 3)
MAX_ORPHANS = 150           # per season (strongest kept)
NW_MAX = 240                # trial distances per season (at most)
POS_SYS = 1.5               # arcsec, per-season position error floor (grid, shifts, smear, model)
LINK_K = 4.0                # search tolerance in sigma
CHI2_P = 0.01               # link model probability
FLUX_SYS = 0.35             # fractional flux scatter allowed between seasons (different wavelength mix)
FLUX_P = 0.001
W_SIG_MIN = 3.0             # parallax significance to list a link
N_RAND = 2000               # randomised orphan lists (false-link probability; floor 1 / (N_RAND + 1))
N_RAND_EMPTY = 200          # ... when the field has no link at all (only the field's false-link rate is reported)
REPORT_FAP = 0.05           # links with a larger false-link probability are counted in info only
CONF_FAP = 0.001            # confirmation needs FAP <= this ...
CONF_W_SIG = 5.0            # ... parallax >= 5 sigma
CONF_Z = 5.0                # ... every linked season >= 5 sigma
FORCED_MISS_SNR = 5.0       # a season where the body should be seen at >= this S/N but is not -> link rejected
ART_Z = 3.0                 # fixed-artifact test: residual >= ART_Z at a linked position in another season of the
ART_R = 8.0                 # same orientation, where the track puts the body >= ART_R" + 3 sigma away -> rejected
GHOST_K = 10.0              # orientation-ghost veto: a static source >= GHOST_K x the orphan flux within 3 sigma
                            # (+ STAR_POS_ERR) of the midpoint of two linked positions seen in opposite orientations
                            # (an optical ghost at a fixed detector offset from a star jumps by twice that offset
                            # when the spacecraft turns by 180 deg, mirror-symmetric about the star)


# --------------------------------------------------------------------------------- geometry
def _basis(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    n = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
    e = np.array([-math.sin(a), math.cos(a), 0.0])
    no = np.array([-math.sin(d) * math.cos(a), -math.sin(d) * math.sin(a), math.cos(d)])
    return n, e, no


_SC_RE = {k: re.compile((k.ljust(8) + "=").encode() + rb"\s*([-+0-9.EeDd]+)") for k in ("X_SC", "Y_SC", "Z_SC")}


def sc_km(e):
    """Spacecraft geocentric equatorial position (km) at mid-exposure from the IMAGE header
    (X_SC, Y_SC, Z_SC); zeros if not readable (the effect is < 0.05" at >= 150 AU)."""
    if "_sc_km" in e:
        return e["_sc_km"]
    v = np.zeros(3)
    try:
        with open(e["path"], "rb") as f:
            raw = f.read(5 * 2880 * 8)
        # first match after the IMAGE extension header starts (the primary header may not carry them)
        k0 = raw.find(b"EXTNAME = 'IMAGE")
        k0 = max(k0, 0)
        for j, k in enumerate(("X_SC", "Y_SC", "Z_SC")):
            m = _SC_RE[k].search(raw, k0)
            if m:
                v[j] = float(m.group(1).replace(b"D", b"E"))
    except (OSError, KeyError, ValueError):
        pass
    e["_sc_km"] = v
    return v


def observer_xyz(exps):
    """Barycentric equatorial position (AU) of SPHEREx at each exposure's mid-time."""
    from astropy.time import Time
    from astropy.coordinates import get_body_barycentric, solar_system_ephemeris
    import astropy.units as u
    mjd = np.array([e["mjd"] for e in exps], float)
    with solar_system_ephemeris.set("builtin"):
        p = get_body_barycentric("earth", Time(mjd, format="mjd", scale="utc"))
    E = np.stack([p.x.to_value(u.AU), p.y.to_value(u.AU), p.z.to_value(u.AU)], -1)
    return E + np.array([sc_km(e) for e in exps]) / AU_KM


def parallax_factors(obs, ra0, dec0):
    """Pi (arcsec AU, east/north; apparent offset of a body at distance d = Pi / d) and
    lambda = observer . line of sight (AU)."""
    n, e, no = _basis(ra0, dec0)
    return np.stack([-(obs @ e), -(obs @ no)], -1) * RAD, obs @ n


# --------------------------------------------------------------------------------- grid
class Grid:
    """North-up TAN grid (east left), standard coordinates xi (east), eta (north) in arcsec."""

    def __init__(self, ra0, dec0, n, pix=PIX):
        self.ra0, self.dec0, self.n, self.pix = ra0, dec0, n, pix
        self.c = (n - 1) / 2.0
        self.nv, self.ev, self.nov = _basis(ra0, dec0)

    def xy_to_std(self, x, y):
        return -(np.asarray(x, float) - self.c) * self.pix, (np.asarray(y, float) - self.c) * self.pix

    def std_to_xy(self, xi, eta):
        return self.c - np.asarray(xi, float) / self.pix, self.c + np.asarray(eta, float) / self.pix

    def std_to_world(self, xi, eta):
        X, Y = np.asarray(xi, float) / RAD, np.asarray(eta, float) / RAD
        v = self.nv[:, None] + np.outer(self.ev, np.ravel(X)) + np.outer(self.nov, np.ravel(Y))
        v /= np.linalg.norm(v, axis=0)
        ra = np.degrees(np.arctan2(v[1], v[0])) % 360
        dec = np.degrees(np.arcsin(np.clip(v[2], -1, 1)))
        return ra.reshape(np.shape(X)), dec.reshape(np.shape(X))

    def world_to_std(self, ra, dec):
        a, d = np.radians(np.asarray(ra, float)), np.radians(np.asarray(dec, float))
        u = np.stack([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)], -1)
        z = u @ self.nv
        return (u @ self.ev) / z * RAD, (u @ self.nov) / z * RAD


def make_grid(exps, ra0, dec0):
    side = max(max(e["_px"]["clean"].shape) for e in exps) * PIX_NATIVE
    n = int(round(side / PIX)) | 1
    return Grid(ra0, dec0, n)


def _mapping(e, g, cal):
    """Native (x, y) of every grid pixel in exposure e (WCS at a coarse lattice, bilinear between)."""
    K = int(math.ceil((g.n - 1) / COARSE)) + 2
    kk = np.arange(K, dtype=float) * COARSE
    X, Y = np.meshgrid(kk, kk)
    xi, eta = g.xy_to_std(X, Y)
    ra, dec = g.std_to_world(xi, eta)
    cE, cN = cal.get(e["file"], (0.0, 0.0)) if cal else (0.0, 0.0)
    ra = ra + cE / 3600.0 / math.cos(math.radians(g.dec0))
    dec = dec + cN / 3600.0
    px, py = e["_px"]["wcs"].all_world2pix(ra.ravel(), dec.ravel(), 0)
    px, py = px.reshape(K, K), py.reshape(K, K)
    idx = np.arange(g.n, dtype=float) / COARSE
    yy, xx = np.meshgrid(idx, idx, indexing="ij")
    Xn = map_coordinates(px, [yy, xx], order=1, mode="nearest")
    Yn = map_coordinates(py, [yy, xx], order=1, mode="nearest")
    return Xn, Yn


def _resample(a, Xn, Yn, cval=np.nan):
    return map_coordinates(np.asarray(a, np.float64), [Yn, Xn], order=1, mode="constant", cval=cval,
                           prefilter=False).astype(np.float32)


def _layers(e, g, cal, images):
    px = e["_px"]
    src = images.get(e["file"]) if images else None
    a = np.asarray(px["clean"] if src is None else src, np.float64)
    a = np.where(px["good"], a, np.nan)
    v = np.where(px["good"] & np.isfinite(px["var"]), px["var"], np.nan).astype(np.float64)
    Xn, Yn = _mapping(e, g, cal)
    I = _resample(a, Xn, Yn)
    V = _resample(v, Xn, Yn)
    S = _resample(px["satnan"].astype(np.float32), Xn, Yn, cval=0.0) > 0.25
    return I, V, S


def _det(e):
    return int(e.get("det") or int(str(e["detector"]).lstrip("D")))


def psf_sigma_px(det):
    return math.sqrt(PSF_NATIVE.get(det, 0.66) ** 2 + 1 / 6.0) * PIX_NATIVE / PIX


def _mf(R, VR, sig, valid):
    iv = np.where(valid, 1.0 / np.where(valid, VR, 1.0), 0.0)
    num = gaussian_filter(np.where(valid, R, 0.0) * iv, sig, mode="constant")
    den = gaussian_filter(iv, sig / math.sqrt(2), mode="constant") / (4 * math.pi * sig ** 2)
    return num.astype(np.float32), den.astype(np.float32)


def _clipped_mean(I, V):
    ok = np.isfinite(I) & np.isfinite(V) & (V > 0)
    Iz = np.where(ok, I, np.nan)
    if I.shape[0] >= 3:
        with np.errstate(all="ignore"):
            med = np.nanmedian(Iz, axis=0)
            tol = np.sqrt(np.where(ok, V, np.inf) + (0.05 * np.abs(med)) ** 2)
            ok &= np.abs(Iz - med) < CLIP * tol
    W = np.where(ok, 1.0 / np.where(ok, V, 1.0), 0.0)
    sw = W.sum(0)
    with np.errstate(all="ignore"):
        T = np.where(sw > 0, (W * np.nan_to_num(Iz)).sum(0) / np.where(sw > 0, sw, 1), np.nan)
        VT = np.where(sw > 0, 1.0 / np.where(sw > 0, sw, 1), np.nan)
    return T.astype(np.float32), VT.astype(np.float32)


def _shift_add(acc, a, dx, dy):
    """acc[y, x] += a[y + dy, x + dx] where defined."""
    n = a.shape[0]
    if abs(dx) >= n or abs(dy) >= n:
        return
    ys_d, ys_s = slice(max(0, -dy), n - max(0, dy)), slice(max(0, dy), n - max(0, -dy))
    xs_d, xs_s = slice(max(0, -dx), n - max(0, dx)), slice(max(0, dx), n - max(0, -dx))
    acc[ys_d, xs_d] += a[ys_s, xs_s]


def _robust_sigma(v):
    v = v[np.isfinite(v)]
    if v.size < 50:
        return 1.0
    lo, hi = np.percentile(v, [2, 98])
    c = v[(v > lo) & (v < hi)]
    med = np.median(c)
    return float(1.4826 * np.median(np.abs(c - med)) * 1.03) or 1.0


def _block_stat(a, b, fn, min_frac=0.3):
    """fn over b x b blocks of a (NaN = no data); returns the coarse map (NaN where too few data)."""
    n = a.shape[0]
    m = int(math.ceil(n / b))
    pad = np.full((m * b, m * b), np.nan, np.float32)
    pad[:n, :n] = a
    blk = pad.reshape(m, b, m, b).transpose(0, 2, 1, 3).reshape(m, m, b * b)
    ok = np.isfinite(blk)
    out = np.full((m, m), np.nan, np.float32)
    for i in range(m):
        for j in range(m):
            v = blk[i, j][ok[i, j]]
            if v.size >= min_frac * b * b:
                out[i, j] = fn(v)
    return out


def _upsample(c, b, n):
    """Coarse block map -> full grid (bilinear between block centres; NaN blocks filled by the nearest)."""
    from scipy.ndimage import distance_transform_edt
    c = np.array(c, np.float64)
    bad = ~np.isfinite(c)
    if bad.all():
        return np.zeros((n, n), np.float32)
    if bad.any():
        idx = distance_transform_edt(bad, return_distances=False, return_indices=True)
        c = c[tuple(idx)]
    yy = (np.arange(n) + 0.5) / b - 0.5
    Y, X = np.meshgrid(yy, yy, indexing="ij")
    return map_coordinates(c, [Y, X], order=1, mode="nearest").astype(np.float32)


def _background(R, b=BG_BLOCK):
    n = R.shape[0]
    m = int(math.ceil(n / b))
    pad = np.full((m * b, m * b), np.nan, np.float32)
    pad[:n, :n] = R
    blk = pad.reshape(m, b, m, b).transpose(0, 2, 1, 3).reshape(m, m, b * b)
    cnt = np.isfinite(blk).sum(2)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(blk, axis=2)
    med[cnt < 0.3 * b * b] = np.nan
    return _upsample(med, b, n)


def _local_sigma(Z, valid, b=NOISE_BLOCK):
    """Local robust scatter of a Z map (blocks, 3x3 median-smoothed, interpolated)."""
    from scipy.ndimage import median_filter
    a = np.where(valid, Z, np.nan).astype(np.float32)
    c = _block_stat(a, b, lambda v: _robust_sigma(v) if v.size >= 50 else np.nan, min_frac=0.25)
    ok = np.isfinite(c)
    if ok.sum() >= 3:
        cf = np.where(ok, c, np.nanmedian(c))
        sm = median_filter(cf, size=3, mode="nearest")
        c = np.where(ok, np.maximum(c, 0.8 * sm), np.nan)   # one noisy block does not lower its own unit
    return np.maximum(_upsample(c, b, Z.shape[0]), 0.3)


def ujy_to_ab(f):
    return 23.9 - 2.5 * math.log10(f) if f and f > 0 else None


# --------------------------------------------------------------------------------- step 1: residuals
def residuals(exps, g, cal, images=None, log=print):
    """Per exposure: matched-filter numerator/denominator of (exposure - other-season template)
    on grid g. Also the static (all-exposure) flux map and the saturation map."""
    N = len(exps)
    num, den, cnt = [None] * N, [None] * N, [None] * N
    n = g.n
    st_num = np.zeros((n, n), np.float64)
    st_den = np.zeros((n, n), np.float64)
    sat_cnt = np.zeros((n, n), np.float32)
    cov_cnt = np.zeros((n, n), np.float32)
    depth = {}
    for det in sorted({_det(e) for e in exps}):
        idx = [i for i, e in enumerate(exps) if _det(e) == det]
        sig = psf_sigma_px(det)
        L = [_layers(exps[i], g, cal, images) for i in idx]
        I = np.stack([q[0] for q in L])
        V = np.stack([q[1] for q in L])
        S = np.stack([q[2] for q in L])
        del L
        lam = np.array([exps[i]["wavelength_um"] for i in idx], float)
        sea = np.array([exps[i]["epoch"] for i in idx])
        ori = np.array([exps[i]["orient_deg"] for i in idx], float)
        # static sky of this detector (all exposures): the filter is linear, so sum first, filter once.
        # Bdet (all-exposure mean) scales the EPS mismatch noise. Bmin, the per-pixel MINIMUM of the season
        # means, marks only STATIC sources (a moving body is absent from at least one season): it decides
        # which pixels are too close to a bright static source to count as covered, so a bright moving body
        # does not mask itself out.
        sIv = np.zeros((n, n), np.float64)
        sv = np.zeros((n, n), np.float64)
        bmin = np.full((n, n), np.inf, np.float64)
        for su in np.unique(sea):
            a_s = np.zeros((n, n), np.float64)
            b_s = np.zeros((n, n), np.float64)
            for k in np.nonzero(sea == su)[0]:
                okk = np.isfinite(I[k]) & np.isfinite(V[k]) & (V[k] > 0) & ~S[k]
                sat_cnt += S[k]
                cov_cnt += okk
                iv = np.where(okk, 1.0 / np.where(okk, V[k], 1.0), 0.0)
                a_s += np.where(okk, I[k], 0.0) * iv
                b_s += iv
            sIv += a_s
            sv += b_s
            with np.errstate(all="ignore"):
                bmin = np.minimum(bmin, np.where(b_s > 0, a_s / np.where(b_s > 0, b_s, 1), np.inf))
            del a_s, b_s
        st_num += gaussian_filter(sIv, sig, mode="constant")
        st_den += gaussian_filter(sv, sig / math.sqrt(2), mode="constant") / (4 * math.pi * sig ** 2)
        with np.errstate(all="ignore"):
            Bdet = gaussian_filter(np.where(sv > 0, sIv / np.where(sv > 0, sv, 1), 0.0).clip(0, None), sig / 2)
        Bmin = gaussian_filter(np.where(np.isfinite(bmin), bmin, 0.0).clip(0, None), sig / 2)
        del sIv, sv, bmin
        for k, i in enumerate(idx):
            # template: other seasons seen in the OPPOSITE orientation only (a distant body moves by the
            # full reflex parallax between them; between same-orientation seasons one year apart it
            # moves only by its slow orbital motion and would subtract itself)
            opp = np.abs((ori - ori[k] + 180) % 360 - 180) > TPL_OPP_DEG
            others = np.nonzero((sea != sea[k]) & opp)[0]
            if not len(others):
                others = np.nonzero(sea != sea[k])[0]
            if not len(others):
                continue
            dl = np.abs(np.log(lam[others] / lam[k]))
            o = np.argsort(dl)
            sel = others[o[dl[o] <= TPL_DLNL]]
            if len(sel) < TPL_MIN:
                sel = others[o[:TPL_MIN]]
            T, VT = _clipped_mean(I[sel], V[sel])
            R = I[k] - T
            R = R - _background(R)
            VR = V[k] + VT + (EPS * Bdet) ** 2
            valid = np.isfinite(R) & np.isfinite(VR) & (VR > 0) & ~S[k]
            num[i], den[i] = _mf(R, VR, sig, valid)
            # coverage: pixels seen, and not dominated by the mismatch noise of a bright STATIC source
            cnt[i] = (valid & ((EPS * Bmin) ** 2 <= COVER_STAR * (V[k] + VT))).astype(np.uint8)
            dd = den[i][::3, ::3]
            okd = dd > 0.5 * np.median(dd[dd > 0]) if np.any(dd > 0) else None
            if okd is not None and okd.sum() > 200:
                zs = _robust_sigma((num[i][::3, ::3] / np.sqrt(np.where(dd > 0, dd, 1)))[okd])
                depth[i] = 5 * zs / math.sqrt(float(np.median(dd[okd]))) * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY
        del I, V, S
    with np.errstate(all="ignore"):
        F_static = np.where(st_den > 0, st_num / st_den, 0.0) * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY
    sat = (sat_cnt >= 2) & (sat_cnt >= 0.3 * np.maximum(cov_cnt + sat_cnt, 1))
    return num, den, F_static.astype(np.float32), sat, depth, cnt


# --------------------------------------------------------------------------------- step 2: orphans
def static_peaks(F, g, fmin=STATIC_FMIN):
    """Local maxima of the all-exposure flux map (stars, galaxies) with sub-pixel positions (arcsec)."""
    mx = maximum_filter(F, size=3, mode="constant", cval=-np.inf)
    ys, xs = np.nonzero((F == mx) & (F >= fmin))
    n = F.shape[0]
    fx = np.zeros(len(xs))
    fy = np.zeros(len(xs))
    for arr, ax in ((fx, 1), (fy, 0)):
        lo = np.clip((xs - 1, ys) if ax == 1 else (xs, ys - 1), 0, n - 1)
        hi = np.clip((xs + 1, ys) if ax == 1 else (xs, ys + 1), 0, n - 1)
        m1, c, p1 = F[lo[1], lo[0]], F[ys, xs], F[hi[1], hi[0]]
        dd = m1 - 2 * c + p1
        with np.errstate(all="ignore"):
            arr[:] = np.where(dd < 0, np.clip(0.5 * (m1 - p1) / np.where(dd < 0, dd, -1), -0.5, 0.5), 0.0)
    xi, eta = g.xy_to_std(xs + fx, ys + fy)
    P = np.stack([np.ravel(xi), np.ravel(eta)], -1) if len(xs) else np.zeros((0, 2))
    return {"xy": P, "flux": F[ys, xs].astype(float), "tree": cKDTree(P) if len(P) else None}


def _peak_flux_near(peaks, xi, eta, r):
    """Brightest static peak within r arcsec of (xi, eta) (0 if none)."""
    if peaks is None or peaks["tree"] is None:
        return 0.0
    jj = peaks["tree"].query_ball_point([xi, eta], r)
    return float(max((peaks["flux"][j] for j in jj), default=0.0))


def _visit_groups(exps, ii):
    """Exposures of a season grouped by visit (same time within 20 min)."""
    t = np.array([exps[i]["mjd"] for i in ii])
    o = np.argsort(t)
    grp, g, last = {}, -1, None
    for k in o:
        if last is None or (t[k] - last) * 1440 > 20:
            g += 1
        grp.setdefault(g, []).append(ii[k])
        last = t[k]
    return list(grp.values())


def season_search(exps, ii, Pi, num, den, g, F_static, satzone, wgrid=None, peaks=None, cnt=None):
    """Shift-and-stack the residuals of the season's exposures ii along the parallax trail for
    trial distances; return orphans and the season's stack description."""
    n = g.n
    ii = [i for i in ii if num[i] is not None]
    if len(ii) < 2:
        return None
    P = Pi[ii]
    Pbar = P.mean(0)
    spread = float(np.max(np.hypot(*(P - Pbar).T)))
    w_lo, w_hi = 1.0 / D_MAX, 1.0 / D_MIN
    if wgrid is not None:
        ws = np.asarray(wgrid, float)
    elif spread * w_hi < PIX:
        ws = np.array([0.5 * (w_lo + w_hi)])
    else:
        nw = int(min(NW_MAX, math.ceil((w_hi - w_lo) / (PIX / spread)) + 1))
        ws = np.linspace(w_lo, w_hi, nw)
    groups = _visit_groups(exps, ii)
    gP = [Pi[q].mean(0) - Pbar for q in groups]
    gnum = [np.sum([num[i] for i in q], 0) for q in groups]
    gden = [np.sum([den[i] for i in q], 0) for q in groups]
    gcnt = [np.sum([cnt[i] for i in q], 0, dtype=np.float32) for q in groups] if cnt is not None else None
    Zc = np.empty((len(ws), n, n), np.float16)
    Dmid = None
    for k, w in enumerate(ws):
        A = np.zeros((n, n), np.float32)
        D = np.zeros((n, n), np.float32)
        for p, a, d in zip(gP, gnum, gden):
            dx, dy = int(round(-w * p[0] / PIX)), int(round(w * p[1] / PIX))
            _shift_add(A, a, dx, dy)
            _shift_add(D, d, dx, dy)
        with np.errstate(all="ignore"):
            Zc[k] = np.where(D > 0, A / np.sqrt(np.where(D > 0, D, 1)), 0).astype(np.float16)
        if k == len(ws) // 2:
            Dmid = D
    # coverage, edge and saturation masks (from the middle trial)
    medD = np.median(Dmid[Dmid > 0]) if np.any(Dmid > 0) else 0
    if gcnt is not None:
        wm = ws[len(ws) // 2]
        C = np.zeros((n, n), np.float32)
        for p, c in zip(gP, gcnt):
            _shift_add(C, c, int(round(-wm * p[0] / PIX)), int(round(wm * p[1] / PIX)))
        medC = np.median(C[C > 0]) if np.any(C > 0) else 0
        cover = C >= COVER_FRAC * medC
    else:
        cover = Dmid >= COVER_FRAC * medD
    r = int(math.ceil(EDGE_ARCSEC / PIX))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    valid = ~binary_dilation(~cover, structure=(xx ** 2 + yy ** 2) <= r * r)
    valid &= ~satzone
    s_map = _local_sigma(Zc[len(ws) // 2].astype(np.float32), valid)
    s_z = float(np.median(s_map[valid])) if valid.any() else 1.0
    Zmax = np.max(Zc, axis=0).astype(np.float32) / s_map
    kbest = np.argmax(Zc, axis=0)
    a = np.where(valid, Zmax, -np.inf)
    mx = maximum_filter(a, size=5, mode="constant", cval=-np.inf)
    # a peak must also be a local maximum of the UNMASKED map: a residual that keeps rising into a masked
    # area (saturated or bright-star zone) leaves a false 'peak' on the mask boundary
    mx_all = maximum_filter(np.where(np.isfinite(Zmax), Zmax, -np.inf), size=3, mode="nearest")
    edge_pk = (a == mx) & (a >= Z_ORPHAN) & (Zmax < mx_all)
    ys, xs = np.nonzero((a == mx) & (a >= Z_ORPHAN) & ~edge_pk)
    order = np.argsort(-a[ys, xs])[:4 * MAX_ORPHANS]
    orph, rej, rej_list = [], {}, []
    if edge_pk.any():
        rej["peak continues into a masked area"] = int(edge_pk.sum())
        rej_list += [(float(x), float(y), float(Zmax[y, x]), "peak continues into a masked area")
                     for y, x in zip(*np.nonzero(edge_pk))]
    tmid = float(np.mean([exps[i]["jyear"] for i in ii]))
    span = float(np.ptp([exps[i]["jyear"] for i in ii]))
    for y, x in zip(ys[order], xs[order]):
        k = int(kbest[y, x])
        z = float(Zmax[y, x])
        w = float(ws[k])
        # sub-pixel position (parabola on Zmax)
        def para(m1, c, p1):
            dd = m1 - 2 * c + p1
            return 0.0 if not np.isfinite(dd) or dd >= 0 else float(np.clip(0.5 * (m1 - p1) / dd, -0.5, 0.5))
        fx = para(a[y, x - 1], a[y, x], a[y, x + 1]) if 0 < x < n - 1 else 0.0
        fy = para(a[y - 1, x], a[y, x], a[y + 1, x]) if 0 < y < n - 1 else 0.0
        # per-visit contributions at the trail position (drop-one-visit test, flux)
        sa, sd, vis = 0.0, 0.0, []
        for p, gn, gd in zip(gP, gnum, gden):
            dx, dy = int(round(-w * p[0] / PIX)), int(round(w * p[1] / PIX))
            yy_, xx_ = y + dy, x + dx
            if 0 <= yy_ < n and 0 <= xx_ < n:
                vis.append((float(gn[yy_, xx_]), float(gd[yy_, xx_])))
        if not vis:
            continue
        va = np.array([v[0] for v in vis])
        vd = np.array([v[1] for v in vis])
        sa, sd = va.sum(), vd.sum()
        if sd <= 0:
            continue
        kmax = int(np.argmax(va))
        s_loc = float(s_map[y, x])
        z_drop = (sa - va[kmax]) / math.sqrt(max(sd - vd[kmax], 1e-30)) / s_loc
        if z_drop < max(3.0, DROP_FRAC * z):
            rej["one visit dominates"] = rej.get("one visit dominates", 0) + 1
            rej_list.append((float(x), float(y), z, "one visit dominates"))
            continue
        F = sa / sd * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY
        eF = s_loc / math.sqrt(sd) * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY
        # static source under the orphan (a residual of it can mimic an orphan): the static flux map (matched
        # filter of the all-exposure stack) AT the orphan position exceeds K_STATIC x the orphan flux. A
        # brighter star reaches further (its PSF-mismatch residual scales with its brightness). Measured on
        # null fields: this removes 26 of 27 star-residual orphans (field-53.773) like a 3x3-box maximum, but
        # loses fewer real bodies next to stars (4 of 18 detections instead of 7 at AB 18.5).
        fs = float(map_coordinates(F_static, [[y + fy], [x + fx]], order=1, mode="nearest")[0])
        if fs > K_STATIC * max(F, 0):
            rej["static source nearby"] = rej.get("static source nearby", 0) + 1
            rej_list.append((float(x), float(y), z, "static source nearby"))
            continue
        # w interval from the trail (2 sigma: Z >= sqrt(Zmax^2 - 4))
        prof = Zc[:, y, x].astype(np.float32) / s_loc
        okw = prof >= math.sqrt(max(z * z - 4.0, 0.0))
        wl, wh = (float(ws[okw].min()), float(ws[okw].max())) if okw.any() else (w, w)
        if len(ws) > 1:
            dw = ws[1] - ws[0]
            wl, wh = max(w_lo, wl - dw), min(w_hi, wh + dw)
        else:
            wl, wh = w_lo, w_hi
        xi, eta = g.xy_to_std(x + fx, y + fy)
        orph.append(dict(x=float(x + fx), y=float(y + fy), xi=float(xi), eta=float(eta), z=z, z_drop=float(z_drop),
                         w=w, w_lo=wl, w_hi=wh, k=k, flux=float(F), eflux=float(eF), static=fs,
                         n_visits=len(vis)))
        if len(orph) >= MAX_ORPHANS:
            break
    lim = 5 * s_z / math.sqrt(medD) * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY if medD > 0 else None
    return dict(ii=ii, Pbar=Pbar, spread=spread, span=span, ws=ws, s_z=s_z, s_map=s_map, valid=valid, groups=groups, gP=gP,
                gnum=gnum, gden=gden, tmid=tmid, orphans=orph, rejected=rej, limit5_ujy=lim,
                Zc=Zc, medD=float(medD), rej_list=rej_list, Zmax=Zmax, kbest=kbest)


def forced(season, x, y, w):
    """Forced S/N and flux at grid (x, y) of a season's stack shifted for trial w."""
    n = season["Zc"].shape[1]
    ix, iy = int(round(x)), int(round(y))
    sa = sd = 0.0
    for p, gn, gd in zip(season["gP"], season["gnum"], season["gden"]):
        dx, dy = int(round(-w * p[0] / PIX)), int(round(w * p[1] / PIX))
        yy, xx = iy + dy, ix + dx
        if 0 <= yy < n and 0 <= xx < n:
            sa += float(gn[yy, xx])
            sd += float(gd[yy, xx])
    if sd <= 0 or not (0 <= ix < n and 0 <= iy < n) or not season["valid"][iy, ix]:
        return None
    s = float(season["s_map"][iy, ix])
    return dict(z=sa / math.sqrt(sd) / s, flux=sa / sd * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY,
                eflux=s / math.sqrt(sd) * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY)


def forced_by_detector(exps, season, x, y, w, num, den):
    """Per-detector forced flux (uJy) at the trail position: {D1: (flux, err, snr)}."""
    n = season["Zc"].shape[1]
    ix, iy = int(round(x)), int(round(y))
    acc = {}
    for i in season["ii"]:
        p = season["_Pi"][i] - season["Pbar"]
        dx, dy = int(round(-w * p[0] / PIX)), int(round(w * p[1] / PIX))
        yy, xx = iy + dy, ix + dx
        if 0 <= yy < n and 0 <= xx < n:
            d = exps[i]["detector"]
            q = acc.setdefault(d, [0.0, 0.0, []])
            q[0] += float(num[i][yy, xx])
            q[1] += float(den[i][yy, xx])
            q[2].append(exps[i]["wavelength_um"])
    out = {}
    s = float(season["s_map"][min(max(iy, 0), n - 1), min(max(ix, 0), n - 1)])
    for d, (a, b, lam) in sorted(acc.items()):
        if b > 0:
            f = a / b * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY
            ef = s / math.sqrt(b) * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY
            out[d] = dict(flux_ujy=round(f, 2), err_ujy=round(ef, 2), snr=round(f / ef, 1),
                          wavelength_um=[round(min(lam), 2), round(max(lam), 2)])
    return out


# --------------------------------------------------------------------------------- step 3: linking
def _pos_sigma(o):
    return math.hypot(math.sqrt(2) * 4.7 / max(o["z"], 1.0), POS_SYS)


def fit_link(pts, S, w_bounds=(1.0 / D_MAX, 1.0 / D_MIN)):
    """Weighted least squares of P_s = (P0 + mu (t_s - t0) + w Pi_s) / (1 - w lambda_s) on the
    linked points [(season index, orphan)], with the per-season trail estimates of w as extra data.
    Returns dict(theta, cov, chi2, dof, p) or None."""
    t0 = np.mean([S[s]["tmid"] for s, _ in pts])
    w = 0.5 * (w_bounds[0] + w_bounds[1])
    res = None
    for _ in range(4):
        rows, obs, sig = [], [], []
        for s, o in pts:
            fac = 1.0 - w * S[s]["lam"]
            dt = S[s]["tmid"] - t0
            Pb = S[s]["Pbar"]
            sg = _pos_sigma(o)
            rows.append([1, 0, dt, 0, Pb[0]]); obs.append(o["xi"] * fac); sig.append(sg)
            rows.append([0, 1, 0, dt, Pb[1]]); obs.append(o["eta"] * fac); sig.append(sg)
            if o["w_hi"] - o["w_lo"] < 0.5 * (w_bounds[1] - w_bounds[0]) and S[s]["spread"] > 0:
                # trail estimate of w; its systematic error: orbital motion during the season window
                # (<= escape speed) lengthens or shortens the parallax trail
                w_sys = K_ESC * max(w, 1e-6) ** 1.5 * S[s]["span"] / (2 * S[s]["spread"])
                sw = math.hypot(max((o["w_hi"] - o["w_lo"]) / 4.0, 1e-6), w_sys)
                rows.append([0, 0, 0, 0, 1]); obs.append(0.5 * (o["w_hi"] + o["w_lo"])); sig.append(sw)
        A = np.array(rows, float) / np.array(sig)[:, None]
        b = np.array(obs) / np.array(sig)
        theta, *_ = np.linalg.lstsq(A, b, rcond=None)
        w_new = float(theta[4])
        if abs(w_new - w) < 1e-7:
            w = w_new
            break
        w = min(max(w_new, 1e-6), 0.02)
    cov = np.linalg.pinv(A.T @ A)
    r = A @ theta - b
    chi2 = float(r @ r)
    dof = len(b) - 5
    p = float(_chi2.sf(chi2, dof)) if dof > 0 else 1.0
    return dict(theta=theta, cov=cov, chi2=chi2, dof=dof, p=p, t0=t0)


def _physical(fit):
    th, cov = fit["theta"], fit["cov"]
    w, sw = th[4], math.sqrt(max(cov[4, 4], 0))
    mu = math.hypot(th[2], th[3])
    smu = math.sqrt(max((th[2] ** 2 * cov[2, 2] + th[3] ** 2 * cov[3, 3]) / max(mu * mu, 1e-12), 0))
    ok_w = (w + 2 * sw >= 1.0 / D_MAX) and (w - 2 * sw <= 1.0 / D_MIN) and w > 0
    bound = K_ESC * max(w, 0) ** 1.5
    ok_mu = mu - 2 * smu <= bound
    return ok_w and ok_mu, w, sw, mu, smu, bound


def _flux_ok(orphs):
    f = np.array([o["flux"] for o in orphs])
    e = np.array([o["eflux"] for o in orphs])
    m = np.average(f, weights=1 / e ** 2)
    v = e ** 2 + (FLUX_SYS * m) ** 2
    c2 = float(np.sum((f - m) ** 2 / v))
    return float(_chi2.sf(c2, len(f) - 1)), m


def link(S, xy=None, full=False):
    """Find links of orphans in >= 3 seasons. S: list of season dicts (with orphans, Pbar, tmid,
    lam). xy: optional replacement positions per season [(xi array, eta array)] (randomisation).
    Returns the selected links (no shared orphans, largest total score; best first); with full=True
    also all links that passed the checks and the number rejected by each check."""
    m = len(S)
    L = []
    for s in range(m):
        os_ = S[s]["orphans"]
        if xy is None:
            P = np.array([[o["xi"], o["eta"]] for o in os_]) if os_ else np.zeros((0, 2))
        else:
            P = np.stack(xy[s], -1) if len(xy[s][0]) else np.zeros((0, 2))
        sig = np.array([_pos_sigma(o) for o in os_]) if os_ else np.zeros(0)
        L.append((P, sig))
    found = {}
    wl, wh = 1.0 / D_MAX, 1.0 / D_MIN
    for a, b, c in combinations(range(m), 3):
        Pa, sa = L[a]
        Pb, sb = L[b]
        Pc, sc_ = L[c]
        if not (len(Pa) and len(Pb) and len(Pc)):
            continue
        ta, tb, tc = S[a]["tmid"], S[b]["tmid"], S[c]["tmid"]
        r = (tc - ta) / (tb - ta)
        PIa, PIb, PIc = S[a]["Pbar"], S[b]["Pbar"], S[c]["Pbar"]
        G = (PIc - PIa) - r * (PIb - PIa)
        G2 = float(G @ G)
        if G2 <= 0:
            continue
        for i in range(len(Pa)):
            Q = Pa[i][None, :] + (Pb - Pa[i][None, :]) * r                       # (nb, 2)
            Dk = Pc[None, :, :] - Q[:, None, :]                                    # (nb, nc, 2)
            wk = (Dk @ G) / G2
            perp = Dk - wk[..., None] * G
            dperp = np.hypot(perp[..., 0], perp[..., 1])
            tol = LINK_K * np.sqrt(sc_[None, :] ** 2 + (r * sb[:, None]) ** 2 + ((1 - r) * sa[i]) ** 2) + 0.0
            dw = tol / math.sqrt(G2)
            ok = (dperp <= tol) & (wk + dw >= wl) & (wk - dw <= wh)
            if not ok.any():
                continue
            jj, kk = np.nonzero(ok)
            for j, k in zip(jj, kk):
                w = float(wk[j, k])
                mu = (Pb[j] - Pa[i] - w * (PIb - PIa)) / (tb - ta)
                if np.hypot(*mu) > K_ESC * max(w, 1e-9) ** 1.5 * 1.5 + 3 * float(tol[j, k]) / abs(tb - ta):
                    continue
                key = ((a, i), (b, int(j)), (c, int(k)))
                found[key] = True
    links = []
    stats = {"candidate_triples": len(found), "rejected_orbit_fit": 0, "rejected_physical": 0,
             "rejected_flux": 0, "rejected_ghost": 0, "rejected_fixed_artifact": 0}
    for key in found:
        pts = [(s, dict(S[s]["orphans"][q], **({} if xy is None else {"xi": float(L[s][0][q][0]),
                                                                        "eta": float(L[s][0][q][1])})))
               for s, q in key]
        fit = fit_link(pts, S)
        if fit is None or fit["p"] < CHI2_P:
            stats["rejected_orbit_fit"] += 1
            continue
        okp, w, sw, mu, smu, bound = _physical(fit)
        if not okp or w / max(sw, 1e-12) < W_SIG_MIN:
            stats["rejected_physical"] += 1
            continue
        fp, fm = _flux_ok([o for _, o in pts])
        if fp < FLUX_P:
            stats["rejected_flux"] += 1
            continue
        if _ghost(pts, S, fm):
            stats["rejected_ghost"] += 1
            continue
        if _recurrent(pts, fit, S):
            stats["rejected_fixed_artifact"] += 1
            continue
        score = math.sqrt(sum(o["z"] ** 2 for _, o in pts))
        links.append(dict(key=key, pts=pts, fit=fit, w=w, sw=sw, mu=mu, smu=smu, bound=bound, flux_p=fp,
                          flux=fm, score=score))
    # extend to more seasons: add an orphan of a further season if it fits
    out = []
    for lk in sorted(links, key=lambda q: -q["score"]):
        used = {s for s, _ in lk["key"]}
        for s in range(m):
            if s in used:
                continue
            P, sg = L[s]
            if not len(P):
                continue
            pred = _predict(lk["fit"], S[s])
            d = np.hypot(P[:, 0] - pred[0], P[:, 1] - pred[1])
            q = int(np.argmin(d))
            if d[q] <= LINK_K * math.hypot(sg[q], pred[2]):
                pts = lk["pts"] + [(s, dict(S[s]["orphans"][q], **({} if xy is None else {"xi": float(P[q][0]), "eta": float(P[q][1])})))]
                fit = fit_link(pts, S)
                okp, w, sw, mu, smu, bound = _physical(fit)
                if fit["p"] >= CHI2_P and okp:
                    lk.update(pts=pts, fit=fit, w=w, sw=sw, mu=mu, smu=smu, bound=bound,
                              key=tuple(sorted(lk["key"] + ((s, q),))),
                              score=math.sqrt(sum(o["z"] ** 2 for _, o in pts)))
        out.append(lk)
    final = _select(out)
    stats["passed"] = len(out)
    stats["selected"] = len(final)
    return (final, out, stats) if full else final


def _select(links, exact_max=18):
    """Links without shared orphans with the largest TOTAL score (exact per conflict component of up to
    exact_max links, greedy by score beyond). A greedy best-first choice can let one link built from
    two different objects (one object's same-orientation pair + another's opposite-orientation point)
    take the orphans of both. Each selected link gets its 'alternatives': other links through >= 2 of
    its orphans (not a subset of it) at a distance > 3 sigma different."""
    uniq = {}
    for lk in links:
        k = tuple(sorted(lk["key"]))
        if k not in uniq or lk["score"] > uniq[k]["score"]:
            uniq[k] = lk
    L = sorted(uniq.values(), key=lambda q: -q["score"])
    n = len(L)
    keys = [set(q["key"]) for q in L]
    nb = [{j for j in range(n) if j != i and keys[i] & keys[j]} for i in range(n)]
    seen, chosen = set(), []
    for i0 in range(n):
        if i0 in seen:
            continue
        comp, stack = [], [i0]
        seen.add(i0)
        while stack:
            i = stack.pop()
            comp.append(i)
            for j in nb[i]:
                if j not in seen:
                    seen.add(j)
                    stack.append(j)
        comp.sort()
        if len(comp) == 1:
            chosen += comp
            continue
        if len(comp) <= exact_max:
            best = [-1.0, []]

            def rec(cands, cur, tot):
                if tot + sum(L[c]["score"] for c in cands) <= best[0]:
                    return
                if not cands:
                    best[0], best[1] = tot, list(cur)
                    return
                c = cands[0]
                rec([x for x in cands[1:] if x not in nb[c]], cur + [c], tot + L[c]["score"])
                rec(cands[1:], cur, tot)
            rec(comp, [], 0.0)
            chosen += best[1]
        else:
            pick = []
            for c in comp:
                if not any(c in nb[q] for q in pick):
                    pick.append(c)
            chosen += pick
    for i in chosen:
        alts = []
        for j in nb[i]:
            if len(keys[i] & keys[j]) >= 2 and not keys[j] <= keys[i]:
                dsig = abs(L[j]["w"] - L[i]["w"]) / max(math.hypot(L[j]["sw"], L[i]["sw"]), 1e-12)
                if dsig > 3.0:
                    alts.append({"distance_au": round(1.0 / L[j]["w"], 1), "err_distance_au": round(L[j]["sw"] / L[j]["w"] ** 2, 1),
                                 "score": round(L[j]["score"], 1), "shared_orphans": len(keys[i] & keys[j]),
                                 "distance_difference_sigma": round(dsig, 1)})
        L[i]["alternatives"] = sorted(alts, key=lambda a: -a["score"])[:5]
    return [L[i] for i in sorted(chosen, key=lambda i: -L[i]["score"])]


def _ghost(pts, S, flux):
    """True if two linked positions seen in opposite spacecraft orientations are mirror images about
    a static source >= GHOST_K x brighter (optical ghost at a fixed detector offset)."""
    peaks = S[0].get("_peaks")
    if peaks is None:
        return False
    for (s1, o1), (s2, o2) in combinations(pts, 2):
        if abs((S[s1]["orient"] - S[s2]["orient"] + 180) % 360 - 180) < 90:
            continue
        r = 3.0 * 0.5 * math.hypot(_pos_sigma(o1), _pos_sigma(o2)) + STAR_POS_ERR
        if _peak_flux_near(peaks, 0.5 * (o1["xi"] + o2["xi"]), 0.5 * (o1["eta"] + o2["eta"]), r) >= GHOST_K * max(flux, 1e-9):
            return True
    return False


def _recurrent(pts, fit, S):
    """True if a linked detection is a fixed artifact: at its sky position another season seen in the SAME
    orientation also shows a >= ART_Z residual (unshifted stack), although the fitted track puts the body
    >= ART_R + 3 sigma away from there in that season."""
    g = S[0].get("_g")
    if g is None:
        return False
    for s, o in pts:
        for s2 in range(len(S)):
            if s2 == s or abs((S[s]["orient"] - S[s2]["orient"] + 180) % 360 - 180) >= 90:
                continue
            if "gnum" not in S[s2] or "valid" not in S[s2]:
                return False
            px_, py_, pe = _predict(fit, S[s2])
            if math.hypot(px_ - o["xi"], py_ - o["eta"]) < ART_R + 3 * pe:
                continue
            x, y = g.std_to_xy(o["xi"], o["eta"])
            fr = forced(S[s2], float(x), float(y), 0.0)
            if fr is not None and fr["z"] >= ART_Z:
                return True
    return False


def _predict(fit, Ss):
    th, cov = fit["theta"], fit["cov"]
    dt = Ss["tmid"] - fit["t0"]
    fac = 1.0 - th[4] * Ss["lam"]
    J = np.array([[1, 0, dt, 0, Ss["Pbar"][0]], [0, 1, 0, dt, Ss["Pbar"][1]]], float) / fac
    p = J @ th
    C = J @ cov @ J.T
    return float(p[0]), float(p[1]), float(math.sqrt(max(np.trace(C) / 2, 0)))


# --------------------------------------------------------------------------------- step 4: null tests
def randomised(S, n_rand, seed=1):
    """Best link score of each of n_rand randomised versions of the orphan lists (independent
    toroidal shifts and 90-degree turns / flips of every season's list)."""
    rng = np.random.default_rng(seed)
    half = S[0]["half"]
    best = []
    n_links = 0
    for _ in range(n_rand):
        xy = []
        for s in S:
            P = np.array([[o["xi"], o["eta"]] for o in s["orphans"]]) if s["orphans"] else np.zeros((0, 2))
            if len(P):
                k = rng.integers(4)
                for _r in range(k):
                    P = np.stack([-P[:, 1], P[:, 0]], -1)
                if rng.random() < 0.5:
                    P[:, 0] = -P[:, 0]
                P = (P + rng.uniform(-half, half, 2) + half) % (2 * half) - half
            xy.append((P[:, 0], P[:, 1]) if len(P) else (np.zeros(0), np.zeros(0)))
        lk, allk, _ = link(S, xy, full=True)
        n_links += len(lk)
        best.append(max([q["score"] for q in allk], default=0.0))
    return np.array(best), n_links


def two_season_pairs(S):
    """Orphan pairs of two seasons that a bound distant body could connect (exists w in range with
    |P_b - P_a - w (Pi_b - Pi_a)| <= bound motion x dt + 3 sigma): what a 2-season 'link' would accept."""
    ws = np.linspace(1.0 / D_MAX, 1.0 / D_MIN, 400)
    out = []
    for a, b in combinations(range(len(S)), 2):
        A = np.array([[o["xi"], o["eta"]] for o in S[a]["orphans"]]).reshape(-1, 2)
        B = np.array([[o["xi"], o["eta"]] for o in S[b]["orphans"]]).reshape(-1, 2)
        if not len(A) or not len(B):
            out.append({"from": S[a]["label"], "to": S[b]["label"], "pairs": 0, "consistent": 0})
            continue
        dt = abs(S[b]["tmid"] - S[a]["tmid"])
        dPi = S[b]["Pbar"] - S[a]["Pbar"]
        lim = K_ESC * ws ** 1.5 * dt + 3 * 2.0
        n_ok = 0
        for p in A:
            d = B[:, None, :] - p[None, None, :] - ws[None, :, None] * dPi                    # (nb, nw, 2)
            n_ok += int(np.any(np.hypot(d[..., 0], d[..., 1]) <= lim[None, :], axis=1).sum())
        out.append({"from": S[a]["label"], "to": S[b]["label"], "pairs": int(len(A) * len(B)), "consistent": n_ok})
    return out


def season_permutations(S):
    """Links found when the orphan lists are given to the wrong seasons (all non-identity permutations)."""
    m = len(S)
    res = []
    for perm in permutations(range(m)):
        # permutations that only swap seasons of the same orientation are not a null test: the parallax of
        # a real body is the same in both (it would still link, with the orbital motion reversed)
        if all(abs((S[k]["orient"] - S[perm[k]]["orient"] + 180) % 360 - 180) < 90 for k in range(m)):
            continue
        S2 = [dict(S[k], orphans=S[perm[k]]["orphans"]) for k in range(m)]
        lk = link(S2)
        res.append(dict(perm=list(perm), n_links=len(lk), best=max([q["score"] for q in lk], default=0.0)))
    return res


# --------------------------------------------------------------------------------- detector
def run(ctx):
    t_start = time.time()
    log = getattr(ctx, "log", print)
    info = {"name": "distant Solar System bodies: parallax-linked orphans (shift-and-stack per season along the "
                    "parallax trail, link >= 3 seasons, false-link probability from randomised orphan lists)",
            "version": VERSION}
    ctx.info[NAME] = info
    opts = getattr(ctx, "opts", None) or {}
    if opts.get("stage") == "quick":
        info["skipped"] = "quick stage (small boxes): the distant-body linker needs the whole cutout"
        return []
    exps = [e for e in ctx.exps if e.get("epoch") is not None]
    seasons = sorted({e["epoch"] for e in exps})
    info["seasons"] = seasons
    if len(seasons) < 3:
        info["skipped"] = f"needs >= 3 seasons (has {len(seasons)})"
        log(f"  P: skipped ({info['skipped']})")
        return []
    ra0, dec0 = float(ctx.field.ra), float(ctx.field.dec)
    g = make_grid(exps, ra0, dec0)
    obs = observer_xyz(exps)
    Pi, lam = parallax_factors(obs, ra0, dec0)
    t1 = time.time()
    num, den, F_static, sat, depth1, cnt = residuals(exps, g, getattr(ctx, "cal", None) or {}, getattr(ctx, "images", None), log)
    t2 = time.time()
    rr = int(math.ceil(SAT_R_ARCSEC / PIX))
    yy, xx = np.mgrid[-rr:rr + 1, -rr:rr + 1]
    satzone = binary_dilation(sat, structure=(xx ** 2 + yy ** 2) <= rr * rr) if sat.any() else sat
    peaks = static_peaks(F_static, g)
    S = []
    for s in seasons:
        ii = [i for i, e in enumerate(exps) if e["epoch"] == s]
        q = season_search(exps, ii, Pi, num, den, g, F_static, satzone, peaks=peaks, cnt=cnt)
        if q is None:
            continue
        q["label"] = s
        q["lam"] = float(np.mean(lam[q["ii"]]))
        q["_Pi"] = Pi
        q["half"] = g.n * g.pix / 2
        q["_g"], q["_Fs"], q["_peaks"] = g, F_static, peaks
        q["orient"] = float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians([exps[i]["orient_deg"] for i in q["ii"]])))))) % 360
        S.append(q)
    t3 = time.time()
    info["grid"] = {"pix_arcsec": PIX, "size_px": g.n, "size_deg": round(g.n * PIX / 3600, 3)}
    info["season_stacks"] = [{"season": q["label"], "n_exposures": len(q["ii"]), "n_visits": len(q["groups"]),
                              "jyear": round(q["tmid"], 4), "orient_deg": round(q["orient"], 1),
                              "parallax_factor_arcsec_au": [round(float(v), 0) for v in q["Pbar"]],
                              "trail_spread_arcsec_au": round(q["spread"], 0), "n_trial_distances": len(q["ws"]),
                              "noise_scale": round(q["s_z"], 3), "n_orphans": len(q["orphans"]),
                              "orphans_rejected": q["rejected"],
                              "orphans": [[round(float(v), 6) for v in g.std_to_world(o["xi"], o["eta"])] +
                                          [round(o["z"], 1), round(o["flux"], 1), round(1 / o["w_hi"]), round(1 / o["w_lo"])]
                                          for o in q["orphans"][:20]],
                              "limit_5sigma_ujy": None if q["limit5_ujy"] is None else round(q["limit5_ujy"], 2),
                              "limit_5sigma_ab": None if q["limit5_ujy"] is None else round(ujy_to_ab(q["limit5_ujy"]), 2)}
                             for q in S]
    info["depth"] = _depth_table(exps, S, depth1, den)
    if len(S) < 3:
        info["skipped"] = "fewer than 3 usable seasons"
        return []
    links, all_links, link_stats = link(S, full=True)
    info["link_checks"] = link_stats
    t4 = time.time()
    n_rand = int(opts.get("distant_n_rand", N_RAND))
    n_null = n_rand if links else min(n_rand, N_RAND_EMPTY)
    best_r, n_rand_links = randomised(S, n_null)
    perm = season_permutations(S)
    t5 = time.time()
    info["null"] = {"n_randomised": n_null, "false_links_per_randomised_field": round(n_rand_links / max(n_null, 1), 4),
                    "fraction_of_randomised_fields_with_a_link": round(float(np.mean(best_r > 0)), 4),
                    "season_permutations": perm,
                    "two_season_pairs_consistent": two_season_pairs(S)}
    info["n_links"] = len(links)
    # geometry summary for this field: parallax shift between seasons (per AU of 1/d)
    pairs = []
    for a, b in combinations(range(len(S)), 2):
        dP = float(np.hypot(*(S[b]["Pbar"] - S[a]["Pbar"])))
        pairs.append({"from": S[a]["label"], "to": S[b]["label"], "dt_yr": round(S[b]["tmid"] - S[a]["tmid"], 3),
                      "parallax_shift_arcsec_at_1au": round(dP, 0),
                      "shift_arcsec_at": {str(d): round(dP / d, 1) for d in (300, 500, 800, 1500)}})
    info["geometry"] = {"season_pairs": pairs, "distance_range_au": [D_MIN, D_MAX],
                        "bound_orbit_motion_arcsec_yr_at": {str(d): round(K_ESC / d ** 1.5, 1) for d in (300, 500, 800, 1500)}}
    recs = []
    for lk in links:
        fap = (1.0 + float(np.sum(best_r >= lk["score"]))) / (1.0 + n_rand)
        if len(links) > 1 and fap > CONF_FAP:
            # under the null hypothesis for THIS link its own orphans are unrelated, but the orphans of the
            # other links are explained by those links: randomise the field without them
            other = {k for q in links if q is not lk for k in q["key"]}
            Sk = [dict(q, orphans=[o for j, o in enumerate(q["orphans"]) if (si, j) not in other])
                  for si, q in enumerate(S)]
            br_k, _ = randomised(Sk, n_rand, seed=2)
            fap = (1.0 + float(np.sum(br_k >= lk["score"]))) / (1.0 + n_rand)
            lk["fap_note"] = "randomised without the orphans of the other links"
        lk["fap"] = fap
        if fap > REPORT_FAP:
            continue
        recs.append(_record(ctx, exps, g, S, lk, num, den, n_rand))
    info["n_candidates"] = len(recs)
    info["n_confirmed"] = sum(bool(r["confirmed"]) for r in recs)
    info["seconds_parts"] = {"setup": round(t1 - t_start, 1), "residuals": round(t2 - t1, 1),
                             "season_stacks": round(t3 - t2, 1), "linking": round(t4 - t3, 1),
                             "null_tests": round(t5 - t4, 1)}
    info["thresholds"] = {"z_orphan": Z_ORPHAN, "eps": EPS, "k_static": K_STATIC, "drop_frac": DROP_FRAC,
                          "chi2_p": CHI2_P, "flux_sys": FLUX_SYS, "w_sig_min": W_SIG_MIN, "report_fap": REPORT_FAP,
                          "confirm": {"fap": CONF_FAP, "w_sigma": CONF_W_SIG, "season_z": CONF_Z, "seasons": 3}}
    log(f"  P: {sum(len(q['orphans']) for q in S)} orphans in {len(S)} seasons, {len(links)} links, "
        f"{len(recs)} candidates ({info['n_confirmed']} confirmed); null: "
        f"{info['null']['false_links_per_randomised_field']} false links per randomised field "
        f"({time.time() - t_start:.1f} s)")
    # free the big arrays
    if not opts.get("distant_keep"):
        for q in S:
            for k in ("Zc", "gnum", "gden", "valid", "Zmax", "kbest", "s_map"):
                q.pop(k, None)
    if isinstance(getattr(ctx, "shared", None), dict):
        ctx.shared["P_seasons"] = S
    return recs


def _depth_table(exps, S, depth1, den):
    """5-sigma point-source depth (AB, flat F_nu) per detector: single exposure (median) and season
    stack (median over the season's valid area), and the all-detector season stack."""
    out = {"single_exposure_ab": {}, "season_stack_ab": {}, "season_all_detectors_ab": {}}
    for d in sorted({e["detector"] for e in exps}):
        v = [depth1[i] for i, e in enumerate(exps) if e["detector"] == d and i in depth1]
        if v:
            out["single_exposure_ab"][d] = round(ujy_to_ab(float(np.median(v))), 2)
    for q in S:
        row = {}
        for d in sorted({exps[i]["detector"] for i in q["ii"]}):
            ii = [i for i in q["ii"] if exps[i]["detector"] == d and den[i] is not None]
            if not ii:
                continue
            D = np.sum([den[i] for i in ii], 0)
            m = q["valid"] & (D > 0)
            if m.sum() < 100:
                continue
            f = 5 * q["s_z"] / math.sqrt(float(np.median(D[m]))) * (PIX / PIX_NATIVE) ** 2 * PIXEL_UJY
            row[d] = round(ujy_to_ab(f), 2)
        out["season_stack_ab"][q["label"]] = row
        if q["limit5_ujy"]:
            out["season_all_detectors_ab"][q["label"]] = round(ujy_to_ab(q["limit5_ujy"]), 2)
    return out


def _record(ctx, exps, g, S, lk, num, den, n_rand):
    fit = lk["fit"]
    th, cov = fit["theta"], fit["cov"]
    w, sw = lk["w"], lk["sw"]
    d = 1.0 / w
    sd = sw / w ** 2
    pos, fluxes, n_cells = [], {}, 0
    seasons_in = {s for s, _ in lk["pts"]}
    for s, o in sorted(lk["pts"], key=lambda q: S[q[0]]["tmid"]):
        ra, dec = g.std_to_world(o["xi"], o["eta"])
        byd = forced_by_detector(exps, S[s], o["x"], o["y"], w, num, den)
        fluxes[S[s]["label"]] = byd
        n_cells += sum(1 for v in byd.values() if v["snr"] >= 3)
        pos.append({"season": S[s]["label"], "jyear": round(S[s]["tmid"], 4), "ra": float(ra), "dec": float(dec),
                    "xi_arcsec": round(o["xi"], 2), "eta_arcsec": round(o["eta"], 2),
                    "err_arcsec": round(_pos_sigma(o), 2), "snr": round(o["z"], 1), "snr_without_best_visit": round(o["z_drop"], 1),
                    "flux_ujy": round(o["flux"], 2), "err_flux_ujy": round(o["eflux"], 2),
                    "trail_distance_au": [round(1 / o["w_hi"]), round(1 / o["w_lo"])], "n": o["n_visits"]})
    # seasons not in the link: forced photometry at the predicted position
    missing, forced_rows = False, []
    for s in range(len(S)):
        if s in seasons_in:
            continue
        px_, py_, pe = _predict(fit, S[s])
        x, y = g.std_to_xy(px_, py_)
        fr = None
        if 0 <= x < g.n and 0 <= y < g.n:
            fr = forced(S[s], x, y, w)
        row = {"season": S[s]["label"], "predicted_xi_eta_arcsec": [round(px_, 1), round(py_, 1)],
               "predicted_err_arcsec": round(pe, 1)}
        if fr is None:
            row["status"] = "outside the cutout or not covered"
        else:
            exp_snr = lk["flux"] / max(fr["eflux"], 1e-9)
            row.update(snr=round(fr["z"], 1), flux_ujy=round(fr["flux"], 2), expected_snr=round(exp_snr, 1))
            row["status"] = ("seen at the predicted position" if fr["z"] >= 3 else
                             ("NOT seen where it should be" if exp_snr >= FORCED_MISS_SNR and fr["z"] < 1.5 else
                              "too faint to tell"))
            missing |= row["status"].startswith("NOT")
        forced_rows.append(row)
    mu_e, mu_n = th[2], th[3]
    smu_e, smu_n = math.sqrt(max(cov[2, 2], 0)), math.sqrt(max(cov[3, 3], 0))
    last = pos[-1]
    fap = lk["fap"]
    n_seasons = len(lk["pts"])
    det_snr = {}
    for byd in fluxes.values():
        for dname, v in byd.items():
            a = det_snr.setdefault(dname, [0.0, 0.0])
            if v["err_ujy"] > 0:
                a[0] += v["flux_ujy"] / v["err_ujy"] ** 2
                a[1] += 1 / v["err_ujy"] ** 2
    per_det = {k: {"flux_ujy": round(a / b, 2), "err_ujy": round(1 / math.sqrt(b), 2),
                   "mag_ab": (round(ujy_to_ab(a / b), 2) if a / b > 0 else None), "snr": round(a / b * math.sqrt(b), 1)}
               for k, (a, b) in sorted(det_snr.items()) if b > 0}
    n_det3 = sum(1 for v in per_det.values() if v["snr"] >= 3)
    checks = [
        {"name": "independent seasons with a >= 5 sigma orphan", "pass": sum(o["z"] >= CONF_Z for _, o in lk["pts"]) >= 3,
         "value": sum(o["z"] >= CONF_Z for _, o in lk["pts"]), "need": ">= 3"},
        {"name": "orbit model fits (chi2 probability)", "pass": fit["p"] >= CHI2_P, "value": round(fit["p"], 4),
         "need": f">= {CHI2_P}"},
        {"name": "parallax significance (sigma)", "pass": w / sw >= CONF_W_SIG, "value": round(w / sw, 1),
         "need": f">= {CONF_W_SIG}"},
        {"name": "bound orbit (motion <= escape speed at that distance)", "pass": lk["mu"] - 2 * lk["smu"] <= lk["bound"],
         "value": round(lk["mu"], 2), "need": f"<= {round(lk['bound'], 2)} arcsec/yr"},
        {"name": "same brightness in every season (probability)", "pass": lk["flux_p"] >= FLUX_P,
         "value": round(lk["flux_p"], 4), "need": f">= {FLUX_P}"},
        {"name": "seen in >= 2 detectors (combined S/N >= 3 each)", "pass": n_det3 >= 2, "value": n_det3, "need": ">= 2"},
        {"name": "not missing in a season where it should be visible", "pass": not missing, "value": not missing, "need": True},
        {"name": "false-link probability (randomised orphan lists of this field)", "pass": fap <= CONF_FAP,
         "value": round(fap, 5), "need": f"<= {CONF_FAP} (with {n_rand} randomisations)"},
        {"name": "unique track (no other link through two of these detections at a different distance)",
         "pass": not lk.get("alternatives"), "value": len(lk.get("alternatives") or []), "need": 0},
    ]
    confirmed = all(c["pass"] for c in checks) and n_rand >= 1000
    conf_pct = round(100 * (1 - fap), 2)
    text = (f"A faint point source seen at {n_seasons} different places in {n_seasons} observing seasons, on the track "
            f"of a body about {d:.0f} AU from the Sun: a distant Solar System body candidate.")
    sentence = (f"{conf_pct}% of randomised versions of this field's unmatched sources gave no link this strong "
                f"(false-link probability {fap:.4f}, {n_rand} randomisations).")
    rec = SC.new_candidate(NAME, "motion", last["ra"], last["dec"], epoch=last["jyear"], cls="candidate",
                           positions=[{k: p[k] for k in ("season", "jyear", "ra", "dec", "err_arcsec")} | {"n": p["n"]}
                                      for p in pos],
                           motion=SC.motion_dict(mu_e * 1000, mu_n * 1000, smu_e * 1000, smu_n * 1000,
                                                 sig=lk["mu"] / max(lk["smu"], 1e-9), method="distant-body orbit fit"),
                           snr=round(lk["score"], 1), flux_ujy=round(lk["flux"], 2),
                           mag_ab=None if lk["flux"] <= 0 else round(ujy_to_ab(lk["flux"]), 2),
                           bins=sorted(per_det), season_pairs=[[pos[k]["season"], pos[k + 1]["season"]] for k in range(len(pos) - 1)],
                           flags=["distant-body link"] + (["confirmed (rule distant-v2)"] if confirmed else ["not confirmed"])
                                 + (["alternative track"] if lk.get("alternatives") else []),
                           notes=f"distance {d:.0f} +- {sd:.0f} AU; candidate for follow-up, not a discovery")
    evidence = {
        "positions": pos,
        "distance_au": round(d, 1), "err_distance_au": round(sd, 1),
        "inverse_distance_per_au": w, "err_inverse_distance": sw,
        "parallax_sigma": round(w / sw, 1),
        "orbital_motion_arcsec_yr": {"east": round(mu_e, 3), "north": round(mu_n, 3), "total": round(lk["mu"], 3),
                                     "err_total": round(lk["smu"], 3),
                                     "circular_orbit_arcsec_yr": round(K_CIRC * w ** 1.5, 3),
                                     "escape_limit_arcsec_yr": round(lk["bound"], 3),
                                     "transverse_speed_km_s": round(lk["mu"] / RAD * d * AU_KM / 3.15576e7, 3)},
        "fit": {"chi2": round(fit["chi2"], 2), "dof": fit["dof"], "probability": round(fit["p"], 4),
                "reference_jyear": round(fit["t0"], 4)},
        "fluxes_by_season_and_detector": fluxes, "flux_by_detector": per_det,
        "mean_flux_ujy": round(lk["flux"], 2), "flux_consistency_probability": round(lk["flux_p"], 4),
        "other_seasons_forced": forced_rows,
        "alternative_links": lk.get("alternatives") or [],
        "n_independent": {"seasons": n_seasons, "season_detector_cells_snr3": n_cells, "detectors_snr3": n_det3},
        "chance_alignment": {"false_alarm_probability": round(fap, 5), "n_randomised": n_rand,
                             "orphans_per_season": {q["label"]: len(q["orphans"]) for q in S},
                             "method": "orphan lists of each season independently shifted (toroidal) and turned/flipped, "
                                       "linked with the same rules; FAP = (1 + fields with a link scoring >= this) / (1 + N)"},
    }
    rec["nature"] = {"label": "distant-solar-system-candidate", "text": text, "evidence": evidence, "reason": None}
    rec["confidence"] = {"percent": conf_pct, "basis": "null-calibrated", "sentence": sentence,
                         "how": "false-link probability measured on this field by linking randomised copies of its "
                                "per-season unmatched-source lists with the same rules",
                         "false_alarm_probability": round(fap, 6), "gaia_difference_sigma": None,
                         "gaia_difference_percent": None}
    rec["confirmed"] = bool(confirmed)
    rec["confirmation"] = {"rule": "distant-v2", "checks": checks, "n_independent": n_seasons,
                           "sentence": ("All checks passed: confirmed as a candidate for follow-up (not a discovery)."
                                        if confirmed else "Not confirmed: " + "; ".join(c["name"] for c in checks if not c["pass"]) + ".")}
    rec["distance_au"] = round(d, 1)
    rec["err_distance_au"] = round(sd, 1)
    if len(pos) >= 2:
        # displacement between the two seasons closest to one year apart (same orientation)
        best = None
        for a in range(len(pos)):
            for b in range(a + 1, len(pos)):
                dt = pos[b]["jyear"] - pos[a]["jyear"]
                if best is None or abs(dt - 1) < abs(best[2] - 1):
                    best = (a, b, dt)
        a, b, dt = best
        dxi = pos[b]["xi_arcsec"] - pos[a]["xi_arcsec"]
        deta = pos[b]["eta_arcsec"] - pos[a]["eta_arcsec"]
        rec["motion"]["displacement"] = {"from": pos[a]["season"], "to": pos[b]["season"], "dt_yr": round(dt, 3),
                                         "arcsec": round(math.hypot(dxi, deta), 2),
                                         "err_arcsec": round(math.hypot(pos[a]["err_arcsec"], pos[b]["err_arcsec"]), 2),
                                         "pa_deg": round(math.degrees(math.atan2(dxi, deta)) % 360, 1)}
    return rec
