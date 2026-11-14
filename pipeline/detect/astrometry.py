"""Per-source astrometry over ALL exposures of a field (shared by detectors A, B and D).

1. Every source is predicted in every exposure (reference position + proper motion + parallax,
   when known) and fitted with the EPSF (measure.py) in native pixels, after the exposure's
   registration offset (calib.py) is applied. The fitted offset (east, north) from the
   prediction is therefore on the Gaia frame. Saturated sources are fitted on their wings with
   blink.centroid (pixel-integrated Gaussian), the bright-target estimator of blink.py.
2. Offsets are combined per season (weighted mean; errors = formal x sqrt(max(1, chi2r)),
   per-exposure floor EXP_FLOOR added in quadrature), using every exposure of every detector
   and wavelength (about 120 per season), not only the six blink bins. The same table is also
   made per detector (cell_tables).
3. Drift = straight line through the season offsets, with ONE POSITION OFFSET PER DETECTOR
   (fit_drift with cells=...). SPHEREx observes every point at one wavelength per exposure and
   each detector covers its own wavelength range, so the photocentre of anything that is not a
   single isolated point source (a blend of a blue and a red star, a galaxy) differs from
   detector to detector. Seasons do not hold the same mix of detectors (a source near the field
   edge can lack a detector in one season), and a pooled season mean then moves although nothing
   moved. With one offset per detector only differences measured at the same wavelength range
   count: a real motion is the same in every detector, a colour effect is not a motion at all.
   The per-season systematic floor (estimated from the Gaia reference stars) is common to the
   detectors of a season and enters as a correlated error. Saturated sources (wing fits) keep
   the pooled fit with one extra offset per telescope orientation (the wing-fit bias is fixed in
   detector axes and flips with the 180 deg turn).
4. Error calibration (drift_bootstrap): the residuals about the fitted track are re-assigned at
   random to the exposure times within each detector and the fit is repeated; the scatter of the
   refitted drifts is the statistical error of THIS source with all its non-Gaussian parts (few
   exposures in a season, faint-source flux normalisation, neighbours in the stamp). The larger
   of this and the formal error is used, the systematic floor is added, and the significance is
   recomputed (calibrate). This is what keeps the false-mover rate at the quoted level for
   faint sources.
5. The same fit is repeated for the short-wavelength (D1-D3) and long-wavelength (D4-D6)
   detectors separately and with one offset per telescope orientation: a real motion must agree
   in both halves where both see the source and must survive in same-orientation seasons.
"""
import math
import re

import numpy as np
from scipy.stats import chi2 as chi2dist, norm

import blink as BL
from . import calib as CAL
from . import measure as M

EXP_FLOOR = 0.08            # arcsec per exposure: PSF/pixel-phase systematics (bright-star pulls)
SEASON_FLOOR = 0.015        # default per-season systematic (arcsec); re-estimated per field
SAT_ORIENT_TERM = True
GROUPS = {"short": ("D1", "D2", "D3"), "long": ("D4", "D5", "D6")}
N_PERM = 200                # residual permutations of the drift error calibration
CELL_MIN_N = 2              # exposures in a season x detector cell
BLEND_ARCSEC = 8.0          # a source this close (1.3 native px) with >= BLEND_RATIO of the S/N = blend
BLEND_RATIO = 0.3


class Sources:
    """Sources with a reference position at t0 (Julian year) and an optional motion model."""

    def __init__(self, ra, dec, t0, pmra=None, pmdec=None, plx=None, ids=None, kind="src"):
        self.ra0 = np.asarray(ra, float)
        self.dec0 = np.asarray(dec, float)
        n = len(self.ra0)
        self.t0 = float(t0)
        self.pmra = np.zeros(n) if pmra is None else np.nan_to_num(np.asarray(pmra, float))
        self.pmdec = np.zeros(n) if pmdec is None else np.nan_to_num(np.asarray(pmdec, float))
        self.plx = np.zeros(n) if plx is None else np.nan_to_num(np.asarray(plx, float))
        self.ids = np.arange(n) if ids is None else np.asarray(ids)
        self.kind = kind
        self.n = n

    def at(self, mjd, jyear):
        dt = jyear - self.t0
        pe, pn = CAL.parallax_factors(self.ra0, self.dec0, mjd)
        dE = self.pmra * dt + self.plx * pe
        dN = self.pmdec * dt + self.plx * pn
        return self.ra0 + dE / 3.6e6 / np.cos(np.radians(self.dec0)), self.dec0 + dN / 3.6e6


def bright_neighbours(gaia):
    """Callable (mjd, jyear) -> (ra, dec) of the Gaia DR3 stars with G < blink.NB_FIT_GMAX: they
    are fitted at fixed positions in the wing fit of a saturated star (blink.py's neighbour
    model; a G = 15 star 35" from Barnard's Star moves its wing centroid by ~0.2")."""
    if gaia is None or gaia.n == 0:
        return None
    sel = np.nonzero(np.nan_to_num(gaia.G, nan=99) < BL.NB_FIT_GMAX)[0]
    if not len(sel):
        return None
    return lambda mjd, jy: gaia.at(mjd, sel)


def measure_all(exps, src, cal, images=None, sat_path=True, offsets=None, nb=None, frozen=None):
    """Linear EPSF quantities (measure.measure_linear) of every source in every exposure.
    offsets: optional (n_season_labels -> (dE, dN) arrays, arcsec) added to the predictions of
    each season (iteration). sat_path: True / False / boolean array: sources whose saturated
    core gets a wing fit (blink.centroid). frozen: optional (n_exp, n_src) fluxes of static stars
    (static_fluxes; NaN = free): subtracted with this flux instead of the per-exposure estimate.
    Returns dict of (n_exp, n_src) arrays."""
    ne, ns = len(exps), src.n
    keys = ("f", "ef", "gE", "gN", "vgE", "vgN", "chi2r", "satE", "satN", "lam", "x", "y")
    A = {k: np.full((ne, ns), np.nan) for k in keys}
    A["ok"] = np.zeros((ne, ns), bool)
    A["sat"] = np.zeros((ne, ns), bool)
    A["det"] = np.array([e["detector"] for e in exps])
    if ns == 0:
        return A
    allow = None if sat_path is True or sat_path is False else np.asarray(sat_path, bool)
    for a, e in enumerate(exps):
        r, d = src.at(e["mjd"], e["jyear"])
        if offsets is not None and e["epoch"] in offsets:
            oE, oN = offsets[e["epoch"]]
            r = r + np.nan_to_num(oE) / 3600 / np.cos(np.radians(d))
            d = d + np.nan_to_num(oN) / 3600
        on = CAL.on_cutout(e, r, d, margin=M.R_STAMP + 1)
        if not on.any():
            continue
        cE, cN = cal.get(e["file"], (0.0, 0.0))
        cosd = np.cos(np.radians(d[on]))
        rw, dw = r[on] + cE / 3600 / cosd, d[on] + cN / 3600
        img = None if images is None else images.get(e["file"])
        m = M.measure_linear(e, rw, dw, image=img, fixed_f=None if frozen is None else frozen[a][on])
        idx = np.nonzero(on)[0]
        nbw = None
        if nb is not None and (m["flag"] == "sat").any():
            nr, nd = nb(e["mjd"], e["jyear"])
            nbw = (nr + cE / 3600 / np.cos(np.radians(nd)), nd + cN / 3600)
        for k in ("f", "ef", "gE", "gN", "vgE", "vgN", "chi2r", "x", "y"):
            A[k][a, idx] = m[k]
        try:                                       # wavelength at each source (linear variable filter)
            A["lam"][a, idx] = e["_px"]["swcs"].pixel_to_world_values(np.nan_to_num(m["x"]), np.nan_to_num(m["y"]))[0]
        except Exception:
            A["lam"][a, idx] = e["wavelength_um"]
        A["ok"][a, idx] = m["ok"]
        if sat_path is not False:
            for j in np.nonzero(m["flag"] == "sat")[0]:
                if allow is not None and not allow[idx[j]]:
                    continue
                q = _sat_fit(e, rw[j], dw[j], img, nbw)
                if q is not None:
                    A["satE"][a, idx[j]], A["satN"][a, idx[j]] = q
                    A["sat"][a, idx[j]] = True
    return A


def _sat_fit(e, ra, dec, image=None, nbw=None):
    """Wing fit of a saturated source (blink.centroid, bright Gaia neighbours fitted at fixed
    positions), offset (east, north) arcsec."""
    px = e["_px"]
    wcs = px["wcs"]
    x0, y0 = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
    ny, nx = px["clean"].shape
    if not (6 <= round(x0) < nx - 6 and 6 <= round(y0) < ny - 6):
        return None
    img = (px["clean"] if image is None else image).astype(float)
    ok = px["good"] & np.isfinite(img)
    nbp = []
    if nbw is not None and len(nbw[0]):
        xs, ys = wcs.all_world2pix(nbw[0], nbw[1], 0)
        nbp = [(float(a), float(b)) for a, b in zip(xs, ys)
               if np.isfinite(a) and math.hypot(a - x0, b - y0) > BL.NB_FIT_MINPX and abs(a - x0) < 8 and abs(b - y0) < 8]
    c = BL.centroid(img, px["var"].astype(float), ok, x0, y0, nb=nbp)
    if not c:
        return None
    rr, dd = (float(v) for v in wcs.all_pix2world(c[0], c[1], 0))
    de, dn = BL.offset_arcsec(ra, dec, rr, dd)[:2]
    if math.hypot(de, dn) > 6.0:
        return None
    return de, dn


CELL_SNR = 5.0              # a season x detector cell is used if the source is detected there
STATIC_ARCSEC = 12.3        # two native pixels: inside this distance the PSFs of a mover and of a static star
                            # overlap, and the flux split of ONE exposure is not determined (the three-pass
                            # neighbour iteration of measure_linear leaves rho^3 of the light, rho = overlap)
STATIC_OWN = 3.0            # arcsec: a listed entry this close to a track may be the mover itself
STATIC_MIN_N = 4            # exposures of a detector needed for a star's flux model ...
STATIC_LIN_N = 8            # ... and for its slope with wavelength inside the detector
STATIC_ROUNDS = 2            # passes of measure_seasons in which the constant-flux models are fitted (then kept);
#                             more passes change nothing beyond the error: Luhman 16 2.816 / 2.826 / 2.834 +- 0.057 "/yr
#                             with 2 / 3 / 6 passes, WISE 0855 unchanged (tested 14 Nov)
TRACK_DT = (-1.0, -0.5, 0.0, 0.5, 1.0)     # years around 2026.0 at which a track is compared with the list


def beside_track(fs, ng, ra, dec, pmra, pmdec):
    """Listed sources (fs: catalogue stars first, ng of them, with their own motion; then
    uncatalogued deep-stack entries) seen from a track (position at 2026.0, motion in mas/yr).
    Returns dmin (smallest separation at the SAME time, arcsec, over TRACK_DT) and own (True
    where the entry may be the mover itself and must stay out of its neighbour model): an
    uncatalogued entry within STATIC_OWN of the track (the deep stack is built from all seasons
    and holds the mover's own image along its track); a catalogued star only if it stays within
    STATIC_OWN of the track at all times, or passes that close AND moves like the track (within
    half its speed): the mover's own catalogue entry. A catalogued star that the track merely
    passes is a real, separate source: it has to be modelled, not ignored."""
    if not fs.n:
        return np.array([]), np.zeros(0, bool)
    cosd = math.cos(math.radians(dec))
    sep = np.array([np.hypot((fs.ra0 - ra) * cosd * 3600 + (fs.pmra - pmra) * dt / 1000,
                             (fs.dec0 - dec) * 3600 + (fs.pmdec - pmdec) * dt / 1000) for dt in TRACK_DT])
    dmin = sep.min(0)
    cat = np.arange(fs.n) < ng
    alike = np.hypot(fs.pmra - pmra, fs.pmdec - pmdec) < 0.5 * math.hypot(pmra, pmdec)
    own = np.where(cat, (sep.max(0) < STATIC_OWN) | ((dmin < STATIC_OWN) & alike), dmin < STATIC_OWN)
    return dmin, own


def static_fluxes(exps, src, cal, A, static, target, images=None, offsets=None):
    """Brightness of static catalogued stars that stand beside a moving source.

    A static star keeps its brightness while the mover changes its distance from it, so all
    exposures together fix what a single exposure cannot. In every exposure the star's flux is
    fitted together with the mover's flux and position (measure.measure_beside: large variance
    where the two overlap, the plain variance where they are apart); per detector the
    inverse-variance weighted straight line in wavelength through all exposures is the star's
    flux (the linear variable filter changes the wavelength from exposure to exposure).
    static: indices of the stars in src; target: for each of them the index of its mover.
    A: the last measure_all result (fluxes of the other listed sources, wavelengths).
    Returns (n_exp, n_src) fluxes, NaN where no model exists and the source stays free:
    fewer than STATIC_MIN_N usable exposures in a detector, or a star whose season means differ
    from the line by more than 5 sigma (a variable star has no constant flux)."""
    ne = len(exps)
    static = np.asarray(static, int)
    target = np.broadcast_to(np.asarray(target, int), static.shape)
    out = np.full((ne, src.n), np.nan)
    if not len(static):
        return out
    F = np.full((ne, len(static)), np.nan)
    V = np.full((ne, len(static)), np.nan)
    other = np.ones(src.n, bool)
    other[np.unique(target)] = False
    for a, e in enumerate(exps):
        r, d = src.at(e["mjd"], e["jyear"])
        if offsets is not None and e["epoch"] in offsets:
            oE, oN = offsets[e["epoch"]]
            r = r + np.nan_to_num(oE) / 3600 / np.cos(np.radians(d))
            d = d + np.nan_to_num(oN) / 3600
        on = CAL.on_cutout(e, r[static], d[static], margin=M.R_STAMP + 1)
        if not on.any():
            continue
        cE, cN = cal.get(e["file"], (0.0, 0.0))
        rw, dw = r + cE / 3600 / np.cos(np.radians(d)), d + cN / 3600
        fa, efa = A["f"][a], A["ef"][a]
        sub = other & A["ok"][a] & np.isfinite(fa) & np.isfinite(efa) & (fa > 3 * efa)
        img = None if images is None else images.get(e["file"])
        F[a, on], V[a, on] = M.measure_beside(e, rw[static[on]], dw[static[on]], rw[target[on]], dw[target[on]],
                                              sub=(rw[sub], dw[sub], fa[sub]), image=img)
    det = np.asarray(A["det"])
    sea = np.array([e["epoch"] for e in exps])
    for k, s in enumerate(static):
        lam = A["lam"][:, s]
        for dn in np.unique(det):
            rows = np.nonzero((det == dn) & np.isfinite(F[:, k]) & np.isfinite(V[:, k]) & (V[:, k] > 0) & np.isfinite(lam))[0]
            if len(rows) < STATIC_MIN_N:
                continue
            y, v = F[rows, k], V[rows, k]
            l0 = float(np.mean(lam[rows]))
            x = lam[rows] - l0
            keep = np.ones(len(rows), bool)
            c0 = c1 = 0.0
            scale = 1.0
            for _ in range(4):
                w = keep / v
                if keep.sum() >= STATIC_LIN_N and np.ptp(x[keep]) > 0.05:
                    Sw, Sx, Sxx = w.sum(), (w * x).sum(), (w * x * x).sum()
                    Sy, Sxy = (w * y).sum(), (w * x * y).sum()
                    den = Sw * Sxx - Sx * Sx
                    c1 = (Sw * Sxy - Sx * Sy) / den if den > 0 else 0.0
                    c0 = (Sy - c1 * Sx) / Sw
                else:
                    c1 = 0.0
                    c0 = (w * y).sum() / w.sum()
                z = (y - c0 - c1 * x) / np.sqrt(v)
                scale = max(1.0, 1.4826 * float(np.median(np.abs(z[keep]))))
                new = np.abs(z) < 4.0 * scale
                if new.sum() < STATIC_MIN_N or (new == keep).all():
                    break
                keep = new
            variable = False
            for se in np.unique(sea[rows]):
                mm = keep & (sea[rows] == se)
                if mm.sum() >= 3:
                    wm = 1.0 / v[mm]
                    mres = float((wm * (y[mm] - c0 - c1 * x[mm])).sum() / wm.sum())
                    if abs(mres) > 5.0 * scale / math.sqrt(wm.sum()):
                        variable = True
            if variable:
                continue
            allr = (det == dn) & np.isfinite(lam)
            out[allr, s] = c0 + c1 * (lam[allr] - l0)
    return out


def season_table(exps, A, seasons, det_subset=None, floor=EXP_FLOOR):
    """Per season x source offset (arcsec) from the linear quantities: in each season x detector
    cell the source flux fbar = median of the per-exposure fluxes; each exposure gives
    delta_i = g_i / fbar; the season offset is their clipped, inverse-variance mean. No
    per-exposure S/N cut is applied (no selection bias for faint sources). Saturated sources
    use the wing-fit offsets."""
    ns = A["f"].shape[1]
    S = len(seasons)
    T = {k: np.full((S, ns), np.nan) for k in ("E", "N", "eE", "eN", "t", "snr", "orient", "flux")}
    T["n"] = np.zeros((S, ns), int)
    T["sat"] = np.zeros((S, ns), bool)
    jy = np.array([e["jyear"] for e in exps])
    ori = np.array([e["orient_deg"] for e in exps])
    dets = A["det"]
    for k, s in enumerate(seasons):
        rows = np.array([e["epoch"] == s and (det_subset is None or e["detector"] in det_subset) for e in exps])
        if not rows.any():
            continue
        f, ef = A["f"][rows], A["ef"][rows]
        ok = A["ok"][rows] & np.isfinite(f) & np.isfinite(A["gE"][rows])
        fbar = np.full(f.shape, np.nan)
        csnr = np.zeros(ns)
        for dname in np.unique(dets[rows]):
            rr = dets[rows] == dname
            fm = np.where(ok[rr], f[rr], np.nan)
            cnt = np.isfinite(fm).sum(0)
            with np.errstate(all="ignore"):
                med = np.nanmedian(fm, 0)
                efm = np.nanmedian(np.where(ok[rr], ef[rr], np.nan), 0)
                cs = med * np.sqrt(np.maximum(cnt, 1)) / efm
            use = (cnt >= 2) & (cs >= CELL_SNR) & (med > 0)
            fbar[rr] = np.where(use, med, np.nan)[None, :]
            csnr = np.sqrt(csnr ** 2 + np.where(use, cs, 0) ** 2)
        ok = ok & np.isfinite(fbar)
        with np.errstate(all="ignore"):
            dE = A["gE"][rows] / fbar
            dN = A["gN"][rows] / fbar
            eE = np.sqrt(A["vgE"][rows] / fbar ** 2 + floor ** 2)
            eN = np.sqrt(A["vgN"][rows] / fbar ** 2 + floor ** 2)
        # saturated: wing fits instead
        sat = A["sat"][rows]
        dE = np.where(sat, A["satE"][rows], dE)
        dN = np.where(sat, A["satN"][rows], dN)
        eE = np.where(sat, 0.3, eE)
        eN = np.where(sat, 0.3, eN)
        ok = (ok | sat) & np.isfinite(dE) & np.isfinite(dN)
        with np.errstate(all="ignore"):
            medE = np.nanmedian(np.where(ok, dE, np.nan), 0)
            medN = np.nanmedian(np.where(ok, dN, np.nan), 0)
            pull = np.hypot((dE - medE) / eE, (dN - medN) / eN)
            mp = np.nanmedian(np.where(ok, pull, np.nan), 0)
        ok = ok & (pull <= np.maximum(4.0 * mp / 1.1774, 3.0))
        wE = np.where(ok, 1 / eE ** 2, 0.0)
        wN = np.where(ok, 1 / eN ** 2, 0.0)
        sE, sN = wE.sum(0), wN.sum(0)
        n = ok.sum(0)
        has = n >= 2
        with np.errstate(all="ignore"):
            mE = np.where(has, (wE * np.nan_to_num(dE)).sum(0) / sE, np.nan)
            mN = np.where(has, (wN * np.nan_to_num(dN)).sum(0) / sN, np.nan)
            chi = ((wE * np.nan_to_num(dE - mE) ** 2).sum(0) + (wN * np.nan_to_num(dN - mN) ** 2).sum(0)) / np.maximum(2 * n - 2, 1)
            sc = np.sqrt(np.maximum(chi, 1.0))
            T["E"][k], T["N"][k] = mE, mN
            T["eE"][k] = np.where(has, sc / np.sqrt(sE), np.nan)
            T["eN"][k] = np.where(has, sc / np.sqrt(sN), np.nan)
            T["t"][k] = np.where(has, (ok * jy[rows][:, None]).sum(0) / np.maximum(n, 1), np.nan)
            T["orient"][k] = np.where(has, np.degrees(np.angle((ok * np.exp(1j * np.radians(ori[rows]))[:, None]).sum(0))) % 360, np.nan)
        T["n"][k] = n
        T["snr"][k] = np.where(has, csnr, 0)
        satk = (sat & ok).sum(0) > 0.5 * np.maximum(n, 1)
        T["sat"][k] = satk
        T["snr"][k] = np.where(satk, 1e4, T["snr"][k])
        T["eE"][k] = np.where(satk & has, np.maximum(T["eE"][k], 0.05), T["eE"][k])
        T["eN"][k] = np.where(satk & has, np.maximum(T["eN"][k], 0.05), T["eN"][k])
        with np.errstate(all="ignore"):
            T["flux"][k] = np.nanmedian(np.where(ok & ~sat, f, np.nan), 0)
    return T


def measure_seasons(exps, src, cal, seasons, images=None, sat_path=True, iters=2, nb=None, det_subset=None, tol=None,
                    n_conv=None, static=None, target=None):
    """measure_all + season_table, iterated: every further pass is centred on the season positions
    of the pass before (the linear estimator is exact only close to the true position: a source
    that starts 1" off needs the second pass, a partly saturated one more). det_subset: only
    these detectors enter the season offsets (e.g. the bands where a red object is seen).
    tol (arcsec): stop when no season of the first n_conv sources (default: all) moved by more
    than tol in the last pass (and after at most iters passes); None = exactly iters passes.
    static, target: indices of static catalogued stars beside moving sources and, for each, the
    index of its mover: from the second pass on they stay at their catalogue positions and are
    subtracted with their constant-flux model (static_fluxes) instead of a per-exposure flux."""
    A = measure_all(exps, src, cal, images=images, sat_path=sat_path, nb=nb)
    T = season_table(exps, A, seasons, det_subset=det_subset)
    frozen = None
    use_static = static is not None and len(static) > 0
    for it in range(iters - 1):
        off = {s: (np.clip(np.nan_to_num(T["E"][k]), -3, 3), np.clip(np.nan_to_num(T["N"][k]), -3, 3))
               for k, s in enumerate(seasons)}
        if use_static:
            for s in off:
                off[s][0][static] = 0.0
                off[s][1][static] = 0.0
            # the star's flux is fitted together with the mover's position, so it does not depend
            # on the mover's centring to first order: two rounds (the second on the first frozen
            # solution) are enough
            if frozen is None or it < STATIC_ROUNDS:
                frozen = static_fluxes(exps, src, cal, A, static, target, images=images, offsets=off)
        A = measure_all(exps, src, cal, images=images, sat_path=sat_path, offsets=off, nb=nb, frozen=frozen)
        T2 = season_table(exps, A, seasons, det_subset=det_subset)
        step = 0.0
        for k, s in enumerate(seasons):
            oE, oN = off[s]
            good = np.isfinite(T2["E"][k]) & ~T2["sat"][k] & (T2["snr"][k] >= CELL_SNR)
            if n_conv is not None:
                good[n_conv:] = False
            if good.any():
                step = max(step, float(np.max(np.hypot(T2["E"][k][good], T2["N"][k][good]))))
            # the offsets of this pass are relative to the shifted centring for EPSF fits AND for the
            # wing fits of saturated cores (measure_all shifts the start position of both): add the
            # shift back for both. (It used to be left out for saturated seasons, which returned
            # "offset 0" = the starting track itself for every saturated star.)
            T2["E"][k] = T2["E"][k] + oE
            T2["N"][k] = T2["N"][k] + oN
        A["_offsets"] = off
        if frozen is not None:
            A["_frozen"] = frozen
        T = T2
        if tol is not None and step <= tol:
            break
    return A, T


def fit_drift(T, j, t_ref=2026.0, floor=SEASON_FLOOR, min_n=3, orient_term=None, min_snr=10.0,
              fit_plx=False, ra=None, dec=None, plx_min_seasons=4, cells=None, cell_set=None):
    """Straight-line fit of the season offsets of source j. Returns dict or None.
      drift (E, N) arcsec/yr relative to the prediction, cov, offset at t_ref, chi2, dof,
      sig_motion (Gaussian-equivalent sigma of the drift vs no drift), seasons used.
    cells: per-detector season tables (cell_tables). When given, the fit has one position
    offset per detector (module docstring, point 3); cells measured on the wings of a saturated
    core get their own offset per detector AND telescope orientation (the wing-fit bias is fixed
    in detector axes and flips with the 180 deg turn). Without cells the detectors of a season
    are pooled (the older fit, kept for comparisons). cell_set: see _fit_cells."""
    use = (T["n"][:, j] >= min_n) & np.isfinite(T["E"][:, j]) & (T["snr"][:, j] >= min_snr)
    if use.sum() < 2:
        return None
    if cells is not None:
        return _fit_cells(T, cells, j, use, t_ref, floor, bool(orient_term), fit_plx, ra, dec, plx_min_seasons,
                          cell_set=cell_set)
    t = T["t"][use, j] - t_ref
    if t.max() - t.min() < 0.2:
        return None
    E, N = T["E"][use, j], T["N"][use, j]
    eE = np.sqrt(T["eE"][use, j] ** 2 + floor ** 2)
    eN = np.sqrt(T["eN"][use, j] ** 2 + floor ** 2)
    sat = bool(T["sat"][use, j].any())
    if orient_term is None:
        orient_term = sat and SAT_ORIENT_TERM
    ori = T["orient"][use, j]
    groups = np.zeros(len(t), int)
    if orient_term:
        o0 = ori[0]
        groups = np.array([0 if abs((o - o0 + 180) % 360 - 180) < 90 else 1 for o in ori])
        if len(set(groups)) == 2:
            # a group with a single season only calibrates its own offset: drop it if the other
            # group spans time on its own
            for gname in (0, 1):
                gm = groups == gname
                if gm.sum() == 1 and (~gm).sum() >= 2 and np.ptp(t[~gm]) >= 0.2:
                    keep = ~gm
                    t, E, N, eE, eN, groups = t[keep], E[keep], N[keep], eE[keep], eN[keep], groups[keep]
                    break
    ng = len(set(groups.tolist()))
    # free parallax (sources without a catalogue parallax): with >= 4 seasons always, with 3
    # seasons only when a straight line does not fit
    plx_cols = None
    if fit_plx and len(t) >= 3 and ra is not None:
        pf = [CAL.parallax_factors(np.array([ra]), np.array([dec]), (tt + t_ref - 2000.0) * 365.25 + 51544.5) for tt in t]
        plx_cols = (np.array([p[0][0] for p in pf]) / 1000, np.array([p[1][0] for p in pf]) / 1000)   # arcsec per mas

    def solve(with_plx):
        out = {}
        cols0 = [np.ones_like(t)] if ng == 1 else [(groups == g).astype(float) for g in sorted(set(groups.tolist()))]
        # stacked E and N system (the parallax couples them)
        nc = len(cols0)
        rows, ys, ws = [], [], []
        for comp, y, ey in ((0, E, eE), (1, N, eN)):
            for k in range(len(t)):
                r = np.zeros(2 * nc + 2 + (1 if with_plx else 0))
                for c in range(nc):
                    r[comp * nc + c] = cols0[c][k]
                r[2 * nc + comp] = t[k]
                if with_plx:
                    r[-1] = plx_cols[comp][k]
                rows.append(r / ey[k]); ys.append(y[k] / ey[k])
        X, yy = np.array(rows), np.array(ys)
        if X.shape[0] < X.shape[1]:
            return None
        p, *_ = np.linalg.lstsq(X, yy, rcond=None)
        cov = np.linalg.pinv(X.T @ X)
        chi2 = float(np.sum((yy - X @ p) ** 2))
        # static model (no proper motion, no parallax) for the significance
        keep = [c for c in range(X.shape[1]) if c < 2 * nc]
        p0, *_ = np.linalg.lstsq(X[:, keep], yy, rcond=None)
        chi2s = float(np.sum((yy - X[:, keep] @ p0) ** 2))
        return dict(p=p, cov=cov, chi2=chi2, chi2_static=chi2s, dof=len(yy) - X.shape[1], nc=nc)
    sol = solve(False)
    if sol is None:
        return None
    plx = None
    if plx_cols is not None:
        sol2 = solve(True)
        p_lin = chi2dist.sf(sol["chi2"], sol["dof"]) if sol["dof"] > 0 else 1.0
        if sol2 is not None and sol2["dof"] >= 1 and (len(t) >= plx_min_seasons or p_lin < 0.01):
            sol = sol2
            plx = (float(sol2["p"][-1]), float(math.sqrt(sol2["cov"][-1, -1])))
    nc = sol["nc"]
    p, cov = sol["p"], sol["cov"]
    bE, bN = float(p[2 * nc]), float(p[2 * nc + 1])
    ebE, ebN = float(math.sqrt(cov[2 * nc, 2 * nc])), float(math.sqrt(cov[2 * nc + 1, 2 * nc + 1]))
    sig = _sigma_from_chi2((bE / ebE) ** 2 + (bN / ebN) ** 2, 2)
    chi2, dof = sol["chi2"], sol["dof"]
    return {"bE": bE, "bN": bN, "ebE": ebE, "ebN": ebN, "aE": float(p[0]), "aN": float(p[nc]), "chi2": chi2, "dof": dof,
            "p_linear": float(chi2dist.sf(chi2, dof)) if dof > 0 else None,
            "sig_motion": sig, "n_seasons": int(len(t)), "orient_term": bool(ng == 2), "saturated": sat,
            "span_yr": float(t.max() - t.min()), "parallax_mas": plx, "unchecked": bool(dof < 1)}


def _sigma_from_chi2(x, dof):
    if not np.isfinite(x) or x <= 0:
        return 0.0
    p = chi2dist.sf(x, dof)
    if p <= 0:
        return float(math.sqrt(x))
    return float(min(norm.isf(p / 2), math.sqrt(x) + 1))


def cell_tables(exps, A, seasons):
    """Season tables per detector, {detector: T} (season_table of that detector alone), with the
    iteration offsets of measure_seasons applied."""
    out = {}
    off = A.get("_offsets")
    for d in sorted(set(np.asarray(A["det"]).tolist())):
        T = season_table(exps, A, seasons, det_subset=(d,))
        if off:
            for k, s in enumerate(seasons):
                if s in off:
                    T["E"][k] = T["E"][k] + off[s][0]
                    T["N"][k] = T["N"][k] + off[s][1]
        out[d] = T
    return out


WING_GAIN = 2.0             # the wing-fit cells of a partly saturated source are added to its EPSF cells when the
#                             EPSF cells alone give a drift error more than this factor larger (the wing-fit
#                             cells then hold >= 3/4 of the information), or no checkable fit (dof 0) at all


def _fit_cells(T, cells, j, use, t_ref, floor, orient_term, fit_plx, ra, dec, plx_min_seasons, cell_set=None):
    """fit_drift with one position offset per detector (and per telescope orientation when
    orient_term, and always for wing-fit cells of saturated cores): generalised least squares on
    the season x detector cells; the per-season systematic floor is common to the cells of a
    season (correlated error).

    A partly saturated source has EPSF cells (its unsaturated exposures) and wing-fit cells (the
    saturated ones); they never share an offset. Which cells enter ('cell_set' in the result):
      "epsf"  the EPSF cells alone: when their fit is over-determined (dof >= 1) and the wing-fit
              cells would improve the drift error by less than WING_GAIN. The EPSF fit is the
              better estimator (real PSF shape, no orientation-dependent wing bias).
      "all"   EPSF and wing-fit cells together, otherwise: when the EPSF cells give no fit, a fit
              without any degree of freedom (two cells: nothing checks it), or one that throws
              away most of what the exposures hold (HD 112943: 2 EPSF cells gave 0.76"/yr where
              the wing-fit cells of the same exposures give 0.1"/yr).
    cell_set: force one of the two (the refits of calibrate / drift_bootstrap must use the cells
    of the fit they calibrate); "epsf" falls back to all cells when the EPSF cells give no fit.
    A fit with dof 0 is marked 'unchecked': it is a number, not a tested measurement (the
    deciding code never accepts it as a candidate; see deep_astrom.judge, gaia_astrom.judge)."""
    o0 = T["orient"][use, j][0]
    rows = []                                       # (detector, group, season, t, E, N, eE, eN)
    any_sat = False
    for d, Td in cells.items():
        ok = use & (Td["n"][:, j] >= CELL_MIN_N) & np.isfinite(Td["E"][:, j]) & np.isfinite(Td["N"][:, j]) \
            & np.isfinite(Td["eE"][:, j]) & np.isfinite(Td["eN"][:, j]) & np.isfinite(Td["t"][:, j])
        for k in np.nonzero(ok)[0]:
            satc = bool(Td["sat"][k, j])
            any_sat |= satc
            g = 0
            if (orient_term or satc) and np.isfinite(Td["orient"][k, j]):
                g = int(abs((Td["orient"][k, j] - o0 + 180) % 360 - 180) >= 90)
            g += 2 * int(satc)                      # wing-fit cells never share an offset with EPSF cells
            rows.append((d, g, int(k), float(Td["t"][k, j] - t_ref), float(Td["E"][k, j]), float(Td["N"][k, j]),
                         float(Td["eE"][k, j]), float(Td["eN"][k, j])))
    def usable(rs):
        cnt = {}
        for r in rs:
            cnt[(r[0], r[1])] = cnt.get((r[0], r[1]), 0) + 1
        rs = [r for r in rs if cnt[(r[0], r[1])] >= 2]      # a lone cell only fixes its own offset
        ts = [r[3] for r in rs]
        if len(rs) < 2 or len({r[2] for r in rs}) < 2 or max(ts) - min(ts) < 0.2:
            return None
        return rs
    rows_e = usable([r for r in rows if r[1] < 2])
    rows_a = usable(rows)
    if rows_a is None:
        return None
    has_wing = any(r[1] >= 2 for r in rows_a)
    args = (T, j, t_ref, floor, fit_plx, ra, dec, plx_min_seasons)
    fe = _solve_cells(rows_e, *args) if rows_e is not None else None
    if not has_wing:                                # no usable wing-fit cells: nothing to choose
        f, which = fe, "epsf"
    elif cell_set == "epsf" and fe is not None:
        f, which = fe, "epsf"
    else:
        fa = _solve_cells(rows_a, *args)
        if cell_set == "all" or fe is None:
            f, which = (fa, "all") if fa is not None else (fe, "epsf")
        elif fa is None:
            f, which = fe, "epsf"
        else:
            se, sa = math.hypot(fe["ebE"], fe["ebN"]), math.hypot(fa["ebE"], fa["ebN"])
            take_all = fe["dof"] < 1 or se > WING_GAIN * sa
            f, which = (fa, "all") if take_all else (fe, "epsf")
            f["cell_sets"] = {"epsf": [fe["bE"], fe["bN"], fe["ebE"], fe["ebN"], fe["dof"]],
                              "all": [fa["bE"], fa["bN"], fa["ebE"], fa["ebN"], fa["dof"]]}
    if f is None:
        return None
    f["cell_set"] = which
    f["unchecked"] = bool(f["dof"] < 1)
    return f


def _solve_cells(rows, T, j, t_ref, floor, fit_plx, ra, dec, plx_min_seasons):
    """The generalised least-squares solution of _fit_cells for one set of cells (rows:
    (detector, group, season index, t, E, N, eE, eN)); None when it cannot be solved."""
    n = len(rows)
    sidx = np.array([r[2] for r in rows])
    t = np.array([r[3] for r in rows])
    E, N = np.array([r[4] for r in rows]), np.array([r[5] for r in rows])
    eE, eN = np.array([r[6] for r in rows]), np.array([r[7] for r in rows])
    groups = sorted({(r[0], r[1]) for r in rows})
    gi = {g: i for i, g in enumerate(groups)}
    G = len(groups)
    gidx = np.array([gi[(r[0], r[1])] for r in rows])
    same = (sidx[:, None] == sidx[None, :]).astype(float)
    C = np.zeros((2 * n, 2 * n))
    C[:n, :n] = np.diag(eE ** 2) + floor ** 2 * same
    C[n:, n:] = np.diag(eN ** 2) + floor ** 2 * same
    try:
        L = np.linalg.cholesky(C)
    except np.linalg.LinAlgError:
        return None
    pE = pN = None
    nsea = len(set(sidx.tolist()))
    if fit_plx and nsea >= 3 and ra is not None:
        pf = {k: CAL.parallax_factors(np.array([ra]), np.array([dec]), (T["t"][k, j] - 2000.0) * 365.25 + 51544.5)
              for k in set(sidx.tolist())}
        pE = np.array([pf[k][0][0] for k in sidx]) / 1000      # arcsec per mas
        pN = np.array([pf[k][1][0] for k in sidx]) / 1000

    def solve(with_plx):
        P = 2 * G + 2 + (1 if with_plx else 0)
        if 2 * n < P:
            return None
        X = np.zeros((2 * n, P))
        X[np.arange(n), gidx] = 1.0
        X[n + np.arange(n), G + gidx] = 1.0
        X[:n, 2 * G] = t
        X[n:, 2 * G + 1] = t
        if with_plx:
            X[:n, -1], X[n:, -1] = pE, pN
        y = np.concatenate([E, N])
        Xw, yw = np.linalg.solve(L, X), np.linalg.solve(L, y)
        if np.linalg.matrix_rank(Xw) < P:
            return None
        p, *_ = np.linalg.lstsq(Xw, yw, rcond=None)
        cov = np.linalg.pinv(Xw.T @ Xw)
        return dict(p=p, cov=cov, chi2=float(np.sum((yw - Xw @ p) ** 2)), dof=2 * n - P)
    sol = solve(False)
    if sol is None:
        return None
    plx = None
    if pE is not None:
        sol2 = solve(True)
        p_lin = chi2dist.sf(sol["chi2"], sol["dof"]) if sol["dof"] > 0 else 1.0
        if sol2 is not None and sol2["dof"] >= 1 and (nsea >= plx_min_seasons or p_lin < 0.01):
            sol = sol2
            plx = (float(sol2["p"][-1]), float(math.sqrt(max(sol2["cov"][-1, -1], 0.0))))
    p, cov = sol["p"], sol["cov"]
    bE, bN = float(p[2 * G]), float(p[2 * G + 1])
    cb = cov[2 * G:2 * G + 2, 2 * G:2 * G + 2]
    ebE, ebN = float(math.sqrt(max(cb[0, 0], 1e-12))), float(math.sqrt(max(cb[1, 1], 1e-12)))
    try:
        x2 = float(np.array([bE, bN]) @ np.linalg.solve(cb, np.array([bE, bN])))
    except np.linalg.LinAlgError:
        x2 = (bE / ebE) ** 2 + (bN / ebN) ** 2
    wg = np.array([np.sum(1 / eE[gidx == i] ** 2 + 1 / eN[gidx == i] ** 2) for i in range(G)])
    aE, aN = float(np.sum(wg * p[:G]) / wg.sum()), float(np.sum(wg * p[G:2 * G]) / wg.sum())
    chi2, dof = sol["chi2"], sol["dof"]
    two_ori = len({g[1] % 2 for g in groups}) == 2
    any_sat = any(g[1] >= 2 for g in groups)
    return {"bE": bE, "bN": bN, "ebE": ebE, "ebN": ebN, "cov_b": [[float(cb[0, 0]), float(cb[0, 1])], [float(cb[1, 0]), float(cb[1, 1])]],
            "aE": aE, "aN": aN, "chi2": chi2, "dof": dof,
            "p_linear": float(chi2dist.sf(chi2, dof)) if dof > 0 else None,
            "sig_motion": _sigma_from_chi2(x2, 2), "n_seasons": int(nsea), "orient_term": bool(two_ori),
            "saturated": bool(any_sat), "span_yr": float(t.max() - t.min()), "parallax_mas": plx,
            "n_cells": int(n), "detectors": sorted({g[0] for g in groups}), "model": "per-detector offsets"}


UNCHECKED_FLAG = ("two position measurements only (one detector, two seasons): the fit has no degree of freedom, "
                  "nothing checks this motion")
PLX_NEAREST = 768.1         # mas: parallax of the nearest star (Proxima Centauri, Gaia DR3: 768.07). No star or brown
#                             dwarf has more. A body bound to the Sun that drifts by arcseconds per year swings by
#                             tens of arcseconds between two seasons (nature.bound_orbit_limit): it leaves the stamp
#                             and is not what these fits follow. A larger fitted parallax therefore describes nothing
#                             physical: with seasons half a year apart the parallax term can absorb a jump of ONE
#                             season, which is what two sources that share the light differently do
PLX_NEAREST_SIGMA = 3.0     # "larger" = by more than this many sigma of the fitted value


def unphysical_parallax(plx, err=None):
    """Flag text when a fitted parallax (mas, with its error) is above the nearest star's, else None.
    plx may also be the (value, error) pair of a fit dict."""
    if isinstance(plx, (tuple, list)):
        plx, err = plx[0], plx[1]
    if plx is None or not math.isfinite(plx):
        return None
    if plx - PLX_NEAREST_SIGMA * (err or 0.0) <= PLX_NEAREST:
        return None
    return (f"fitted parallax {plx / 1000:.2f} arcsec is larger than that of the nearest star ({PLX_NEAREST / 1000:.2f}): "
            "not a physical track (the jump of one season: two sources or a blend, not a motion)")
P_LINE = 0.01               # straight-line fits below this probability are replaced (fit_motion)


def fit_motion(T, cells, j, floor, ra, dec, t_ref=2026.0, min_n=3, min_snr=10.0):
    """Motion of a source without a catalogue parallax (detectors A and D). Three models, all
    with one position offset per detector:
      linear                      position + drift; adopted when the cells lie on a straight line
                                  (probability >= P_LINE)
      linear + parallax           adopted otherwise, when the fitted annual parallax is positive,
                                  >= 3 sigma, and the fit is then acceptable
      same-orientation seasons    one offset per detector AND telescope orientation. SPHEREx sees a
                                  field at two epochs of the year, half a year apart and turned by
                                  180 deg, so seasons of one orientation share the same parallax
                                  displacement and the same orientation-dependent centroid bias:
                                  the drift between them is the proper motion alone. Adopted when
                                  the line does not fit and no significant parallax explains it.
    Returns the fit_drift dict of the adopted model with 'motion_model' (and 'orient_model' True
    when the last model was adopted), or None."""
    fL = fit_drift(T, j, t_ref=t_ref, floor=floor, min_n=min_n, min_snr=min_snr, cells=cells)
    if fL is None:
        return None
    fX = fit_drift(T, j, t_ref=t_ref, floor=floor, min_n=min_n, min_snr=min_snr, cells=cells, fit_plx=True,
                   ra=ra, dec=dec, plx_min_seasons=3)
    # 'plx_test': parallax (mas) and its error from the linear + parallax model whenever it can be
    # fitted (>= 3 seasons), adopted or not: nature.py compares it with the parallax a body bound
    # to the Sun would have to show
    plx_test = fX["parallax_mas"] if fX is not None and fX.get("parallax_mas") else None

    def done(f, model, orient):
        f["motion_model"], f["orient_model"], f["plx_test"] = model, orient, plx_test
        if f is not fL:
            f["p_linear_no_parallax"] = fL["p_linear"]
        return f
    if fL["p_linear"] is None or fL["p_linear"] >= P_LINE:
        return done(fL, "linear", False)
    if plx_test is not None and plx_test[0] > 0 and plx_test[0] >= 3 * plx_test[1] \
            and (fX["p_linear"] is None or fX["p_linear"] >= 1e-3):
        return done(fX, "linear + parallax", False)
    fP = fit_drift(T, j, t_ref=t_ref, floor=floor, min_n=min_n, min_snr=min_snr, cells=cells, orient_term=True)
    if fP is not None:
        fP["parallax_mas"] = None
        return done(fP, "same-orientation seasons (offset per detector and orientation)", True)
    return done(fL, "linear", False)


def flux_change(cells, j, min_det=3):
    """Did source j change brightness between its first and last season? Per detector the
    fractional change of the cell fluxes (measured at the fitted season positions, so a motion
    does not change them); returns dict(frac = median over detectors, err = its error from the
    scatter between detectors, n) or None with fewer than min_det detectors. A position shift
    that comes with a brightness change is what a variable star in an unresolved blend does
    (variability-induced motion): the photocentre moves towards the other star."""
    r = []
    for d, Td in cells.items():
        fl = Td["flux"][:, j]
        ok = np.isfinite(fl) & (Td["n"][:, j] >= 3) & ~Td["sat"][:, j]
        k = np.nonzero(ok)[0]
        if len(k) < 2 or fl[k[0]] <= 0 or fl[k[-1]] <= 0:
            continue
        r.append(2 * (fl[k[-1]] - fl[k[0]]) / (fl[k[-1]] + fl[k[0]]))
    if len(r) < min_det:
        return None
    r = np.array(r)
    return {"frac": float(np.median(r)), "err": float(1.2533 * max(BL.robust_sigma(r), 0.005) / math.sqrt(len(r))), "n": len(r)}


VIM_FRAC = 0.05             # brightness change (fraction) that makes a small position shift suspect ...
VIM_SIGMA = 5.0             # ... at this significance
VIM_MAX_SHIFT = 6.15        # arcsec: shifts larger than one native pixel cannot be a blend's photocentre


def vim_suspect(cells, j, shift_arcsec):
    """(True, note) when the position shift of source j (shift_arcsec in total over the seasons)
    comes with a significant brightness change and is small enough to be the photocentre shift
    of an unresolved blend with a variable star."""
    fc = flux_change(cells, j)
    if fc is None or shift_arcsec >= VIM_MAX_SHIFT:
        return False, fc
    if abs(fc["frac"]) >= VIM_FRAC and abs(fc["frac"]) >= VIM_SIGMA * fc["err"]:
        return True, fc
    return False, fc


def sed_ujy(cells, j):
    """Median flux (microJy) of source j per detector over the seasons where it is measured."""
    out = {}
    for d, Td in sorted(cells.items()):
        fl = Td["flux"][:, j]
        fl = fl[np.isfinite(fl)]
        if len(fl):
            out[str(d)] = round(float(np.median(fl)) * BL.PIXEL_UJY, 1)
    return out


def detector_votes(T, cells, j, floor, f_all, base=None, min_snr=10.0, min_n=3, orient_term=False):
    """The motion in every single detector: {detector: {"sigma", "agrees"}}. sigma = significance
    of the total drift from that detector's cells alone; agrees = within 3 sigma of the full fit
    f_all (both relative to the same track; base = drift of that track)."""
    out = {}
    for d, c in cells.items():
        f = fit_drift(T, j, floor=floor, cells={d: c}, min_snr=min_snr, min_n=min_n, orient_term=orient_term)
        if f is None or f["ebE"] > 5 or f["ebN"] > 5:
            continue
        tE, tN = f["bE"] + (base[0] if base else 0.0), f["bN"] + (base[1] if base else 0.0)
        dev = math.hypot((f["bE"] - f_all["bE"]) / max(f["ebE"], 1e-4), (f["bN"] - f_all["bN"]) / max(f["ebN"], 1e-4))
        out[str(d)] = {"sigma": round(_sigma_from_chi2((tE / f["ebE"]) ** 2 + (tN / f["ebN"]) ** 2, 2), 1),
                       "agrees": bool(dev <= 3.0)}
    return out


def drift_bootstrap(exps, A, seasons, j, n_perm=N_PERM, seed=1, t_ref=2026.0, use_cells=True, **kw):
    """Statistical error of the drift of source j from the data themselves. In every season x
    detector cell the mean offset is removed (this takes out the motion, the registration error
    and every other season-coherent part: those belong to the systematic floor), the residuals
    are scaled by sqrt(n / (n - 1)), re-assigned at random to the exposure times within each
    detector, and the fit is repeated n_perm times (fit_drift, same options, no floor). The rms
    of the refitted drifts is the error. Returns dict(sE, sN (arcsec/yr), n) or None."""
    ne = len(exps)
    rng = np.random.default_rng(seed + 7919 * int(j))
    dets = np.asarray(A["det"])
    sea = np.array([e["epoch"] for e in exps])
    keys = ("f", "ef", "gE", "gN", "vgE", "vgN", "satE", "satN")
    base = {k: np.array(A[k][:, j], float) for k in keys}
    satb = np.array(A["sat"][:, j], bool)
    okb = np.array(A["ok"][:, j], bool) & np.isfinite(base["f"]) & np.isfinite(base["gE"]) & np.isfinite(base["gN"])
    keep = np.zeros(ne, bool)
    for d in np.unique(dets):
        for s_ in seasons:
            c = (dets == d) & (sea == s_)
            m = c & okb & ~satb
            if m.sum() >= 2:
                fb = float(np.median(base["f"][m]))
                if fb > 0:
                    k_ = math.sqrt(m.sum() / (m.sum() - 1.0))
                    for g in ("gE", "gN"):
                        o = base[g][m] / fb
                        base[g][m] = (o - o.mean()) * k_ * fb
                    keep |= m
            m = c & satb & np.isfinite(base["satE"]) & np.isfinite(base["satN"])
            if m.sum() >= 2:
                k_ = math.sqrt(m.sum() / (m.sum() - 1.0))
                for g in ("satE", "satN"):
                    base[g][m] = (base[g][m] - base[g][m].mean()) * k_
                keep |= m
    if keep.sum() < 6:
        return None
    okb, satb = okb & keep & ~satb, satb & keep
    sub = {k: np.empty((ne, n_perm)) for k in keys}
    sub["ok"] = np.zeros((ne, n_perm), bool)
    sub["sat"] = np.zeros((ne, n_perm), bool)
    sub["det"] = dets
    for d in np.unique(dets):
        rows = np.nonzero(dets == d)[0]
        pick = rows[np.argsort(rng.random((n_perm, len(rows))), axis=1)].T      # (rows, n_perm)
        for k in keys:
            sub[k][rows, :] = base[k][pick]
        sub["ok"][rows, :] = okb[pick]
        sub["sat"][rows, :] = satb[pick]
    Tp = season_table(exps, sub, seasons)
    cp = cell_tables(exps, sub, seasons) if use_cells else None
    kw = dict(kw, floor=0.0, fit_plx=False)
    out = []
    for q in range(n_perm):
        fp = fit_drift(Tp, q, t_ref=t_ref, cells=cp, **kw)
        if fp:
            out.append((fp["bE"], fp["bN"]))
    if len(out) < max(20, 0.5 * n_perm):
        return None
    b = np.array(out)
    return {"sE": float(np.sqrt(np.mean(b[:, 0] ** 2))), "sN": float(np.sqrt(np.mean(b[:, 1] ** 2))), "n": len(out)}


def calibrate(exps, A, T, seasons, j, f, floor, cells=None, n_perm=N_PERM, base=None, **kw):
    """Fit f of source j with its drift errors calibrated by drift_bootstrap: statistical error =
    max(formal, bootstrap), plus the part of the formal error that comes from the systematic
    floor. The significance is recomputed (for the total drift when base = the (E, N) drift of
    the track the offsets are measured along). Adds 'error_inflation' and 'bootstrap' to f."""
    kw = {k: v for k, v in kw.items() if k in ("min_n", "min_snr", "orient_term")}
    if cells is not None and f.get("cell_set"):
        kw["cell_set"] = f["cell_set"]              # the refits use the cells of the fit they calibrate
    f0 = fit_drift(T, j, floor=0.0, cells=cells, **kw)
    bs = drift_bootstrap(exps, A, seasons, j, n_perm=n_perm, use_cells=cells is not None, **kw)
    out = dict(f)
    if f0 is None or bs is None:
        out["bootstrap"] = None
        if out.get("unchecked"):
            # no degree of freedom AND no residual permutation: nothing stands behind the formal
            # error of this fit, so it carries no significance (never a mover on such numbers)
            out["sig_motion"] = 0.0
            out["uncalibrated"] = True
        return out
    res = []
    for b, key in ((bs["sE"], "ebE"), (bs["sN"], "ebN")):
        stat0 = f0[key]
        sys2 = max(f[key] ** 2 - stat0 ** 2, 0.0)
        res.append((math.sqrt(max(stat0, b) ** 2 + sys2), max(stat0, b) / max(stat0, 1e-9)))
    out["ebE"], out["ebN"] = res[0][0], res[1][0]
    out["error_inflation"] = round(max(res[0][1], res[1][1]), 2)
    out["bootstrap"] = {"err_east_arcsec_yr": round(bs["sE"], 4), "err_north_arcsec_yr": round(bs["sN"], 4),
                        "formal_east": round(f0["ebE"], 4), "formal_north": round(f0["ebN"], 4), "n": bs["n"]}
    tE = out["bE"] + (base[0] if base else 0.0)
    tN = out["bN"] + (base[1] if base else 0.0)
    out["sig_motion"] = _sigma_from_chi2((tE / out["ebE"]) ** 2 + (tN / out["ebN"]) ** 2, 2)
    return out


def evidence(T, cells, j, floor, f, groups, ori_note, base=None, min_snr=10.0, min_n=3):
    """Structured form of the checks behind a motion (stored in the record as 'checks'; nature.py
    reads it for the 'confirmed' decision): significance of the motion in same-orientation
    seasons, in the two wavelength halves and in every single detector, and the brightness
    change that came with it."""
    m = re.search(r"confirmed by same-orientation seasons \(([\d.]+) sigma\)", ori_note or "")
    om = bool(f.get("orient_model")) or (f.get("motion_model") not in (None, "linear"))
    halves = {}
    for g, h in (groups or {}).items():
        tE, tN = h["bE"] + (base[0] if base else 0.0), h["bN"] + (base[1] if base else 0.0)
        dev = math.hypot((h["bE"] - f["bE"]) / math.hypot(h["ebE"], 1e-3), (h["bN"] - f["bN"]) / math.hypot(h["ebN"], 1e-3))
        halves[g] = {"sigma": round(_sigma_from_chi2((tE / h["ebE"]) ** 2 + (tN / h["ebN"]) ** 2, 2), 1), "agrees": bool(dev <= 3.5)}
    fc = flux_change(cells, j) if cells else None
    return {"same_orientation_sigma": float(m.group(1)) if m else None, "halves": halves,
            "detector_votes": detector_votes(T, cells, j, floor, f, base=base, min_snr=min_snr, min_n=min_n, orient_term=om)
            if cells else {},
            "flux_change": None if fc is None else {"frac": round(fc["frac"], 4), "err": round(fc["err"], 4), "n_detectors": fc["n"]}}


def blend_neighbour(src, snr_max, j, radius=BLEND_ARCSEC, ratio=BLEND_RATIO):
    """Distance (arcsec) to the nearest other source of the list within radius whose S/N is at
    least ratio x that of source j (SPHEREx cannot separate them: 6.15" pixels, FWHM ~9"), or None.
    snr_max: best season S/N of every source."""
    cosd = math.cos(math.radians(float(src.dec0[j])))
    dd = np.hypot((src.ra0 - src.ra0[j]) * cosd, src.dec0 - src.dec0[j]) * 3600
    sj = snr_max[j] if np.isfinite(snr_max[j]) else 0.0
    m = (dd > 0.05) & (dd < radius) & (np.nan_to_num(snr_max, nan=0.0) >= ratio * max(sj, 1e-9))
    m[j] = False
    return float(dd[m].min()) if m.any() else None


def estimate_season_floor(T, idx, max_err=0.04, fit=None):
    """Per-season systematic (arcsec) of well-measured static reference sources: the value that
    makes the season offsets of the TYPICAL reference star scatter as its errors say. For every
    star chi2(f) about a constant is divided by the median of the chi-square distribution with
    its degrees of freedom; the floor f brings the median of that ratio over the stars to 1.
    A sum over the stars (the earlier estimate) is set by its worst members: a few reference
    stars next to a bright moving or variable source raised the floor of the whole field by
    factors of 3-50 in the injection tests. Stars far off the typical scatter are dealt with
    one by one (blend, orientation and wavelength-half tests), not by the floor."""
    rows = []
    for j in idx:
        use = (T["n"][:, j] >= 5) & np.isfinite(T["E"][:, j]) & (T["eE"][:, j] < max_err) & (T["eN"][:, j] < max_err)
        if use.sum() < 2:
            continue
        rows.append((T["E"][use, j], T["N"][use, j], T["eE"][use, j], T["eN"][use, j]))
    if len(rows) < 5:
        return SEASON_FLOOR, len(rows)
    med = {d: float(chi2dist.ppf(0.5, d)) for d in range(1, 64)}

    def chi(f):
        r = []
        for E, N, eE, eN in rows:
            c, d = 0.0, 0
            for y, ey in ((E, eE), (N, eN)):
                w = 1 / (ey ** 2 + f ** 2)
                m = np.sum(w * y) / np.sum(w)
                c += float(np.sum(w * (y - m) ** 2))
                d += len(y) - 1
            r.append(c / med[min(max(d, 1), 63)])
        return float(np.median(r))
    if chi(0.0) <= 1.0:
        return 0.005, len(rows)
    lo, hi = 0.0, 0.5
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if chi(mid) > 1.0:
            lo = mid
        else:
            hi = mid
    return float(max(hi, 0.005)), len(rows)


def group_agreement(exps, A, seasons, j, fit_all, floor, t_ref=2026.0, cells=None, T=None, **kw):
    """Fit the short- and long-wavelength halves separately; returns list of per-group fits
    and whether they agree with the full fit (within 3 sigma) where they are measured.
    With cells (cell_tables) and the pooled table T the halves use the per-detector model."""
    res = {}
    if cells is not None and T is not None:
        for g, dets in GROUPS.items():
            sub = {d: c for d, c in cells.items() if d in dets}
            f = fit_drift(T, j, t_ref=t_ref, floor=floor, cells=sub, **kw) if sub else None
            if f and f["ebE"] < 5 and f["ebN"] < 5:
                res[g] = f
        agree = True
        for f in res.values():
            dE = (f["bE"] - fit_all["bE"]) / math.hypot(f["ebE"], 1e-3)
            dN = (f["bN"] - fit_all["bN"]) / math.hypot(f["ebN"], 1e-3)
            if math.hypot(dE, dN) > 3.5:
                agree = False
        return res, agree
    sub = {k: (v[:, j:j + 1] if isinstance(v, np.ndarray) and v.ndim == 2 else v) for k, v in A.items() if k != "_offsets"}
    for g, dets in GROUPS.items():
        T = season_table(exps, sub, seasons, det_subset=dets)
        if "_offsets" in A:
            for k, s in enumerate(seasons):
                if s in A["_offsets"]:
                    T["E"][k, 0] += A["_offsets"][s][0][j]
                    T["N"][k, 0] += A["_offsets"][s][1][j]
        f = fit_drift(T, 0, t_ref=t_ref, floor=floor)
        if f and f["ebE"] < 5 and f["ebN"] < 5:
            res[g] = f
    agree = True
    for f in res.values():
        dE = (f["bE"] - fit_all["bE"]) / math.hypot(f["ebE"], 1e-3)
        dN = (f["bN"] - fit_all["bN"]) / math.hypot(f["ebN"], 1e-3)
        if math.hypot(dE, dN) > 3.5:
            agree = False
    return res, agree


def orientation_check(T, j, f, floor, base=None, **kw):
    """Is the drift f also there when each telescope orientation gets its own offset (i.e. from
    same-orientation seasons only)? Returns (ok, note). Orientation-dependent position errors
    (PSF asymmetry, ghosts, blends that change with the 180 deg turn) do not survive this.
    base: (bE, bN) arcsec/yr of the track the offsets in T are relative to (a pass-2
    measurement along a fitted track); f is then the total drift."""
    fo = fit_drift(T, j, floor=floor, orient_term=True, **kw)        # kw may carry cells=
    if fo is not None and base is not None:
        fo = dict(fo, bE=fo["bE"] + base[0], bN=fo["bN"] + base[1])
        fo["sig_motion"] = _sigma_from_chi2((fo["bE"] / fo["ebE"]) ** 2 + (fo["bN"] / fo["ebN"]) ** 2, 2)
    if fo is None or not fo["orient_term"] and fo["n_seasons"] == f["n_seasons"]:
        # single orientation, or a single season in one orientation that could not be dropped
        same = fo is not None and fo["n_seasons"] < f["n_seasons"]
        if fo is None or not same:
            return True, "orientation test not possible"
    d = math.hypot((fo["bE"] - f["bE"]) / max(fo["ebE"], 1e-4), (fo["bN"] - f["bN"]) / max(fo["ebN"], 1e-4))
    if fo["sig_motion"] < 3.0 or d > 3.0:
        return False, f"not confirmed by same-orientation seasons ({fo['sig_motion']:.1f} sigma)"
    return True, f"confirmed by same-orientation seasons ({fo['sig_motion']:.1f} sigma)"
