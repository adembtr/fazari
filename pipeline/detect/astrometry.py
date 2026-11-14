"""Per-source astrometry over ALL exposures of a field (shared by detectors B and D).

1. Every source is predicted in every exposure (reference position + proper motion + parallax,
   when known) and fitted with the EPSF (measure.py) in native pixels, after the exposure's
   registration offset (calib.py) is applied. The fitted offset (east, north) from the
   prediction is therefore on the Gaia frame. Saturated sources are fitted on their wings with
   blink.centroid (pixel-integrated Gaussian), the bright-target estimator of blink.py.
2. Offsets are combined per season (weighted mean; errors = formal x sqrt(max(1, chi2r)),
   per-exposure floor EXP_FLOOR added in quadrature), using every exposure of every detector
   and wavelength (about 120 per season), not only the six blink bins.
3. A straight line through the season offsets gives the drift (mas/yr) relative to the
   prediction, with a per-season systematic floor (estimated from the Gaia reference stars)
   added in quadrature. Saturated sources get one extra offset per telescope orientation (the
   wing-fit bias is fixed in detector axes and flips with the 180 deg turn).
4. The same fit is repeated with the short-wavelength (D1-D3) and long-wavelength (D4-D6)
   detectors separately: a real motion must agree in both halves where both see the source.
"""
import math

import numpy as np
from scipy.stats import chi2 as chi2dist, norm

import blink as BL
from . import calib as CAL
from . import measure as M

EXP_FLOOR = 0.08            # arcsec per exposure: PSF/pixel-phase systematics (bright-star pulls)
SEASON_FLOOR = 0.015        # default per-season systematic (arcsec); re-estimated per field
SAT_ORIENT_TERM = True
GROUPS = {"short": ("D1", "D2", "D3"), "long": ("D4", "D5", "D6")}


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


def measure_all(exps, src, cal, images=None, sat_path=True, offsets=None, nb=None):
    """Linear EPSF quantities (measure.measure_linear) of every source in every exposure.
    offsets: optional (n_season_labels -> (dE, dN) arrays, arcsec) added to the predictions of
    each season (iteration). sat_path: True / False / boolean array: sources whose saturated
    core gets a wing fit (blink.centroid). Returns dict of (n_exp, n_src) arrays."""
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
        m = M.measure_linear(e, rw, dw, image=img)
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


def measure_seasons(exps, src, cal, seasons, images=None, sat_path=True, iters=2, nb=None, det_subset=None):
    """measure_all + season_table, iterated: the second pass is centred on the first-pass
    season positions (keeps the linearisation exact for offsets up to ~2"). det_subset: only
    these detectors enter the season offsets (e.g. the bands where a red object is seen)."""
    A = measure_all(exps, src, cal, images=images, sat_path=sat_path, nb=nb)
    T = season_table(exps, A, seasons, det_subset=det_subset)
    for _ in range(iters - 1):
        off = {s: (np.clip(np.nan_to_num(T["E"][k]), -3, 3), np.clip(np.nan_to_num(T["N"][k]), -3, 3))
               for k, s in enumerate(seasons)}
        A = measure_all(exps, src, cal, images=images, sat_path=sat_path, offsets=off, nb=nb)
        T2 = season_table(exps, A, seasons, det_subset=det_subset)
        for k, s in enumerate(seasons):
            oE, oN = off[s]
            T2["E"][k] = T2["E"][k] + np.where(T2["sat"][k], 0.0, oE)
            T2["N"][k] = T2["N"][k] + np.where(T2["sat"][k], 0.0, oN)
        A["_offsets"] = off
        T = T2
    return A, T


def fit_drift(T, j, t_ref=2026.0, floor=SEASON_FLOOR, min_n=3, orient_term=None, min_snr=10.0,
              fit_plx=False, ra=None, dec=None, plx_min_seasons=4):
    """Straight-line fit of the season offsets of source j. Returns dict or None.
      drift (E, N) arcsec/yr relative to the prediction, cov, offset at t_ref, chi2, dof,
      sig_motion (Gaussian-equivalent sigma of the drift vs no drift), seasons used."""
    use = (T["n"][:, j] >= min_n) & np.isfinite(T["E"][:, j]) & (T["snr"][:, j] >= min_snr)
    if use.sum() < 2:
        return None
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
            "span_yr": float(t.max() - t.min()), "parallax_mas": plx}


def _sigma_from_chi2(x, dof):
    if not np.isfinite(x) or x <= 0:
        return 0.0
    p = chi2dist.sf(x, dof)
    if p <= 0:
        return float(math.sqrt(x))
    return float(min(norm.isf(p / 2), math.sqrt(x) + 1))


def estimate_season_floor(T, idx, max_err=0.04, fit=None):
    """Per-season systematic (arcsec) that makes the season offsets of well-measured static
    reference sources scatter as their errors say (reduced chi2 = 1 about a constant)."""
    rows = []
    for j in idx:
        use = (T["n"][:, j] >= 5) & np.isfinite(T["E"][:, j]) & (T["eE"][:, j] < max_err) & (T["eN"][:, j] < max_err)
        if use.sum() < 2:
            continue
        rows.append((T["E"][use, j], T["N"][use, j], T["eE"][use, j], T["eN"][use, j]))
    if len(rows) < 5:
        return SEASON_FLOOR, len(rows)

    def chi(f):
        c, d = 0.0, 0
        for E, N, eE, eN in rows:
            for y, ey in ((E, eE), (N, eN)):
                w = 1 / (ey ** 2 + f ** 2)
                m = np.sum(w * y) / np.sum(w)
                c += float(np.sum(w * (y - m) ** 2))
                d += len(y) - 1
        return c / max(d, 1)
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


def group_agreement(exps, A, seasons, j, fit_all, floor, t_ref=2026.0):
    """Fit the short- and long-wavelength halves separately; returns list of per-group fits
    and whether they agree with the full fit (within 3 sigma) where they are measured."""
    res = {}
    sub = {k: (v[:, j:j + 1] if isinstance(v, np.ndarray) and v.ndim == 2 else v) for k, v in A.items() if k != "_offsets"}
    for g, dets in GROUPS.items():
        T = season_table(exps, sub, seasons, det_subset=dets)
        if "_offsets" in A:
            for k, s in enumerate(seasons):
                if s in A["_offsets"]:
                    T["E"][k, 0] += 0.0 if T["sat"][k, 0] else A["_offsets"][s][0][j]
                    T["N"][k, 0] += 0.0 if T["sat"][k, 0] else A["_offsets"][s][1][j]
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


def orientation_check(T, j, f, floor, **kw):
    """Is the drift f also there when each telescope orientation gets its own offset (i.e. from
    same-orientation seasons only)? Returns (ok, note). Orientation-dependent position errors
    (PSF asymmetry, ghosts, blends that change with the 180 deg turn) do not survive this."""
    fo = fit_drift(T, j, floor=floor, orient_term=True, **kw)
    if fo is None or not fo["orient_term"] and fo["n_seasons"] == f["n_seasons"]:
        # single orientation, or a single season in one orientation that could not be dropped
        same = fo is not None and fo["n_seasons"] < f["n_seasons"]
        if fo is None or not same:
            return True, "orientation test not possible"
    d = math.hypot((fo["bE"] - f["bE"]) / max(fo["ebE"], 1e-4), (fo["bN"] - f["bN"]) / max(fo["ebN"], 1e-4))
    if fo["sig_motion"] < 3.0 or d > 3.0:
        return False, f"not confirmed by same-orientation seasons ({fo['sig_motion']:.1f} sigma)"
    return True, f"confirmed by same-orientation seasons ({fo['sig_motion']:.1f} sigma)"
