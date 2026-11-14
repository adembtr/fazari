"""Batched EPSF astrometry and photometry of a source list in one exposure (native pixels).

For every source a (2R+1)^2 native-pixel stamp is fitted with the exposure's SPHEREx empirical
PSF (EPSF extension, the PSF row nearest the cutout centre):

    model = f * EPSF(pixel - (x, y)) + b          (f, x, y, b free)

by Gauss-Newton (linearised in the position, solved for all sources at once). Sources of the
list that fall near each other are modelled together: in every iteration the current model of
each neighbour is subtracted from the stamp before the fit (a Jacobi sweep), so a faint source
next to a bright one is not pulled. Saturated / missing pixels have zero weight; a source with
a saturated or missing pixel in its central 3x3 is not fitted (flag 'sat').

Pixel errors: the VARIANCE layer plus MODEL_ERR x model (PSF mismatch of bright stars); the
position covariance is the inverse normal matrix scaled by max(1, reduced chi2).

Returned offsets are sky offsets (east, north; arcsec) of the fitted position from the input
position, computed with the exposure's own WCS (SIP included). Nothing here knows about Gaia
or seasons: calibration and combination happen in calib.py / astrometry code.
"""
import math

import numpy as np
from scipy.ndimage import map_coordinates

import blink as BL

R_STAMP = 3                 # stamp half size (native px): 7 x 7 = 43" x 43"
MODEL_ERR = 0.03            # fractional model error per pixel (EPSF vs real PSF)
ITERS = 6
MAX_STEP = 0.5              # native px per Gauss-Newton step
FD_H = 0.02                 # finite-difference step (native px) for the PSF derivatives
NB_PAD = 4                  # neighbours up to R + NB_PAD px away are subtracted
NB_MIN_SEP = 0.5            # native px: list entries closer than this cannot be told apart (FWHM ~1-1.5 px) and
#                             are NOT subtracted from each other: each then measures their common light. Subtracting
#                             them made the Jacobi sweep oscillate (a Gaia pair 0.4" apart: fluxes 7 / 0.7, then
#                             5 / 33, then 0 / 0 in consecutive exposures), which looked like a vanished star.


def _kern(px, dx, dy, R):
    """EPSF values on the stamp grid for sources at sub-pixel offsets (dx, dy) from the stamp
    centre pixel: dx, dy shape (M,), returns (M, P). Same convention as blink.epsf_kernels."""
    psf, ovs = px["psf"], px["ovs"]
    c = (psf.shape[0] - 1) / 2
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    u = c + ovs * (xx.ravel()[None, :] - dx[:, None])
    v = c + ovs * (yy.ravel()[None, :] - dy[:, None])
    k = map_coordinates(psf, [v.ravel(), u.ravel()], order=3, mode="constant", cval=0.0, prefilter=False)
    return k.reshape(len(dx), -1) * ovs * ovs


def measure(e, ra, dec, R=R_STAMP, fix_pos=False, model_err=MODEL_ERR, image=None):
    """Fit sources at sky positions (ra, dec) (degrees, arrays; the positions where this
    exposure's WCS should see them) in exposure e. image: replacement native image (injection
    tests), else the cleaned image. Returns a dict of arrays (one entry per source):
      ok, flag ('', 'edge', 'sat', 'fail'), x, y, dE, dN (arcsec, fitted - input), eE, eN, cEN,
      flux (MJy/sr summed over the PSF), eflux, snr, chi2r, npix
    With fix_pos=True only flux and background are fitted (forced photometry)."""
    px = e["_px"]
    ra = np.atleast_1d(np.asarray(ra, float))
    dec = np.atleast_1d(np.asarray(dec, float))
    ns = len(ra)
    out = {k: np.full(ns, np.nan) for k in ("x", "y", "dE", "dN", "eE", "eN", "cEN", "flux", "eflux",
                                            "snr", "chi2r", "npix")}
    out["ok"] = np.zeros(ns, bool)
    out["flag"] = np.array(["edge"] * ns, dtype=object)
    if ns == 0:
        return out
    wcs = px["wcs"]
    img = px["clean"] if image is None else image
    ny, nx = img.shape
    x0, y0 = wcs.all_world2pix(ra, dec, 0)
    ix, iy = np.round(x0).astype(int), np.round(y0).astype(int)
    inside = (ix >= R) & (ix < nx - R) & (iy >= R) & (iy < ny - R) & np.isfinite(x0) & np.isfinite(y0)
    idx = np.nonzero(inside)[0]
    if not len(idx):
        return out
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    P = (2 * R + 1) ** 2
    gy = iy[idx, None] + yy.ravel()[None, :]
    gx = ix[idx, None] + xx.ravel()[None, :]
    d = np.asarray(img, float)[gy, gx]
    var = np.asarray(px["var"], float)[gy, gx]
    good = np.asarray(px["good"])[gy, gx] & np.isfinite(d) & np.isfinite(var) & (var > 0)
    # central 3x3 saturated or missing -> not measurable
    cen = (np.abs(xx.ravel()) <= 1) & (np.abs(yy.ravel()) <= 1)
    satc = np.asarray(px["satnan"])[gy, gx][:, cen].any(1)
    d = np.where(good, d, 0.0)
    var = np.where(good, var, 1.0)
    n = len(idx)
    dx = x0[idx] - ix[idx]
    dy = y0[idx] - iy[idx]
    # neighbour pairs (s, t): t's light falls on s's stamp
    pairs_s, pairs_t = [], []
    lim = R + NB_PAD
    xs, ys = x0[idx], y0[idx]
    for a in range(n):
        m = (np.abs(xs - xs[a]) <= lim) & (np.abs(ys - ys[a]) <= lim) & (np.hypot(xs - xs[a], ys - ys[a]) >= NB_MIN_SEP)
        m[a] = False
        for b in np.nonzero(m)[0]:
            pairs_s.append(a)
            pairs_t.append(b)
    pairs_s = np.array(pairs_s, int)
    pairs_t = np.array(pairs_t, int)
    f = np.zeros(n)
    b = np.zeros(n)
    ok = ~satc & (good.sum(1) >= 0.6 * P)
    for it in range(ITERS + 1):
        # neighbour light on each stamp (current fluxes and positions)
        C = np.zeros((n, P))
        if len(pairs_s) and it > 0:
            ox = (xs[pairs_t] - ix[idx][pairs_s])
            oy = (ys[pairs_t] - iy[idx][pairs_s])
            kn = _kern(px, ox, oy, R) * np.where(ok[pairs_t], np.clip(f[pairs_t], 0, None), 0.0)[:, None]
            np.add.at(C, pairs_s, kn)
        dd = d - C
        k0 = _kern(px, dx, dy, R)
        if fix_pos or it == 0:
            A = np.stack([k0, np.ones_like(k0)], 2)
        else:
            kx = (_kern(px, dx + FD_H, dy, R) - _kern(px, dx - FD_H, dy, R)) / (2 * FD_H)
            ky = (_kern(px, dx, dy + FD_H, R) - _kern(px, dx, dy - FD_H, R)) / (2 * FD_H)
            A = np.stack([k0, kx, ky, np.ones_like(k0)], 2)
        mod = np.clip(f, 0, None)[:, None] * k0
        w = good / (var + (model_err * mod) ** 2)
        N = np.einsum("np,npi,npj->nij", w, A, A)
        rhs = np.einsum("np,npi,np->ni", w, A, dd)
        N += np.eye(A.shape[2])[None] * 1e-12
        try:
            p = np.linalg.solve(N, rhs[..., None])[..., 0]
        except np.linalg.LinAlgError:
            p = np.zeros_like(rhs)
            for a in range(n):
                try:
                    p[a] = np.linalg.lstsq(N[a], rhs[a], rcond=None)[0]
                except np.linalg.LinAlgError:
                    ok[a] = False
        f = p[:, 0]
        b = p[:, -1]
        if fix_pos or it == 0:
            continue
        pos = f > 0
        stepx = np.where(pos, p[:, 1] / np.where(pos, f, 1), 0.0)
        stepy = np.where(pos, p[:, 2] / np.where(pos, f, 1), 0.0)
        dx = dx + np.clip(stepx, -MAX_STEP, MAX_STEP)
        dy = dy + np.clip(stepy, -MAX_STEP, MAX_STEP)
        xs = ix[idx] + dx
        ys = iy[idx] + dy
        if it == ITERS:
            break
    # covariance at the solution: columns k, f dk/dx, f dk/dy, 1
    k0 = _kern(px, dx, dy, R)
    C = np.zeros((n, P))
    if len(pairs_s):
        ox = (xs[pairs_t] - ix[idx][pairs_s])
        oy = (ys[pairs_t] - iy[idx][pairs_s])
        kn = _kern(px, ox, oy, R) * np.where(ok[pairs_t], np.clip(f[pairs_t], 0, None), 0.0)[:, None]
        np.add.at(C, pairs_s, kn)
    dd = d - C
    mod = np.clip(f, 0, None)[:, None] * k0 + b[:, None]
    w = good / (var + (model_err * np.clip(f, 0, None)[:, None] * k0) ** 2)
    if fix_pos:
        A = np.stack([k0, np.ones_like(k0)], 2)
    else:
        kx = (_kern(px, dx + FD_H, dy, R) - _kern(px, dx - FD_H, dy, R)) / (2 * FD_H)
        ky = (_kern(px, dx, dy + FD_H, R) - _kern(px, dx, dy - FD_H, R)) / (2 * FD_H)
        A = np.stack([k0, f[:, None] * kx, f[:, None] * ky, np.ones_like(k0)], 2)
    N = np.einsum("np,npi,npj->nij", w, A, A) + np.eye(A.shape[2])[None] * 1e-12
    chi2 = np.sum(w * (dd - mod) ** 2, 1)
    npix = good.sum(1)
    chi2r = chi2 / np.maximum(npix - A.shape[2], 1)
    try:
        cov = np.linalg.inv(N)
    except np.linalg.LinAlgError:
        cov = np.array([np.linalg.pinv(a) for a in N])
    cov = cov * np.maximum(chi2r, 1.0)[:, None, None]
    J = np.array(e["jac_pred"])                       # d(east, north)/d(x, y), arcsec per native px
    res_ok = ok & np.isfinite(f) & (np.abs(dx) < R - 0.5) & (np.abs(dy) < R - 0.5)
    if not fix_pos:
        res_ok &= f > 0
        rr, dd_ = wcs.all_pix2world(xs, ys, 0)
        cosd = np.cos(np.radians(dec[idx]))
        dE = ((rr - ra[idx] + 180) % 360 - 180) * cosd * 3600
        dN = (dd_ - dec[idx]) * 3600
        cxy = cov[:, 1:3, 1:3]
        ce = np.einsum("ij,njk,lk->nil", J, cxy, J)
        out["dE"][idx], out["dN"][idx] = dE, dN
        out["eE"][idx] = np.sqrt(np.clip(ce[:, 0, 0], 0, None))
        out["eN"][idx] = np.sqrt(np.clip(ce[:, 1, 1], 0, None))
        out["cEN"][idx] = ce[:, 0, 1]
    out["x"][idx], out["y"][idx] = xs, ys
    out["flux"][idx] = f
    out["eflux"][idx] = np.sqrt(np.clip(cov[:, 0, 0], 0, None))
    out["snr"][idx] = f / np.maximum(out["eflux"][idx], 1e-30)
    out["chi2r"][idx] = chi2r
    out["npix"][idx] = npix
    out["ok"][idx] = res_ok
    fl = np.array(["fail"] * n, dtype=object)
    fl[res_ok] = ""
    fl[satc] = "sat"
    out["flag"][idx] = fl
    return out


def flux_ujy(f):
    """EPSF flux (MJy/sr summed over native pixels) -> microJansky."""
    return f * BL.PIXEL_UJY


def measure_linear(e, ra, dec, R=R_STAMP, model_err=MODEL_ERR, image=None, jacobi=3):
    """Linear EPSF fit at FIXED positions (no position iteration): for every source
        data = f K + gx dK/dx + gy dK/dy + b
    with K the EPSF at the input position; gx = f * dx, gy = f * dy, where (dx, dy) is the
    source's offset (native px) from the input position. Being linear in the data, these
    estimates can be summed over many exposures without the selection and non-linearity biases
    of per-exposure position fits of faint sources (astrometry.season_table).
    Returns arrays: ok, flag, f, ef, gE, gN (= J (gx, gy), arcsec x flux), vgE, vgN, cgEN,
    cfgE, cfgN (covariances with f), chi2r."""
    px = e["_px"]
    ra = np.atleast_1d(np.asarray(ra, float))
    dec = np.atleast_1d(np.asarray(dec, float))
    ns = len(ra)
    keys = ("f", "ef", "gE", "gN", "vgE", "vgN", "cgEN", "cfgE", "cfgN", "chi2r", "x", "y")
    out = {k: np.full(ns, np.nan) for k in keys}
    out["ok"] = np.zeros(ns, bool)
    out["flag"] = np.array(["edge"] * ns, dtype=object)
    if ns == 0:
        return out
    wcs = px["wcs"]
    img = px["clean"] if image is None else image
    ny, nx = img.shape
    x0, y0 = wcs.all_world2pix(ra, dec, 0)
    ix, iy = np.round(np.nan_to_num(x0, nan=-99)).astype(int), np.round(np.nan_to_num(y0, nan=-99)).astype(int)
    inside = (ix >= R) & (ix < nx - R) & (iy >= R) & (iy < ny - R)
    idx = np.nonzero(inside)[0]
    if not len(idx):
        return out
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    P = (2 * R + 1) ** 2
    gy = iy[idx, None] + yy.ravel()[None, :]
    gx = ix[idx, None] + xx.ravel()[None, :]
    d = np.asarray(img, float)[gy, gx]
    var = np.asarray(px["var"], float)[gy, gx]
    good = np.asarray(px["good"])[gy, gx] & np.isfinite(d) & np.isfinite(var) & (var > 0)
    cen = (np.abs(xx.ravel()) <= 1) & (np.abs(yy.ravel()) <= 1)
    satc = np.asarray(px["satnan"])[gy, gx][:, cen].any(1)
    d = np.where(good, d, 0.0)
    var = np.where(good, var, 1.0)
    n = len(idx)
    xs, ys = x0[idx], y0[idx]
    dx, dy = xs - ix[idx], ys - iy[idx]
    lim = R + NB_PAD
    ps, pt = [], []
    for a in range(n):
        m = (np.abs(xs - xs[a]) <= lim) & (np.abs(ys - ys[a]) <= lim) & (np.hypot(xs - xs[a], ys - ys[a]) >= NB_MIN_SEP)
        m[a] = False
        for b in np.nonzero(m)[0]:
            ps.append(a)
            pt.append(b)
    ps, pt = np.array(ps, int), np.array(pt, int)
    k0 = _kern(px, dx, dy, R)
    kn = _kern(px, xs[pt] - ix[idx][ps], ys[pt] - iy[idx][ps], R) if len(ps) else None
    ok = ~satc & (good.sum(1) >= 0.6 * P)
    f = np.zeros(n)
    for it in range(jacobi + 1):
        C = np.zeros((n, P))
        if kn is not None and it > 0:
            np.add.at(C, ps, kn * np.where(ok[pt], np.clip(f[pt], 0, None), 0.0)[:, None])
        dd = d - C
        if it < jacobi:
            A = np.stack([k0, np.ones_like(k0)], 2)
            w = good / (var + (model_err * np.clip(f, 0, None)[:, None] * k0) ** 2)
            N = np.einsum("np,npi,npj->nij", w, A, A) + np.eye(2)[None] * 1e-12
            rhs = np.einsum("np,npi,np->ni", w, A, dd)
            f = np.linalg.solve(N, rhs[..., None])[..., 0][:, 0]
    kx = (_kern(px, dx + FD_H, dy, R) - _kern(px, dx - FD_H, dy, R)) / (2 * FD_H)
    ky = (_kern(px, dx, dy + FD_H, R) - _kern(px, dx, dy - FD_H, R)) / (2 * FD_H)
    A = np.stack([k0, kx, ky, np.ones_like(k0)], 2)
    w = good / (var + (model_err * np.clip(f, 0, None)[:, None] * k0) ** 2)
    N = np.einsum("np,npi,npj->nij", w, A, A) + np.eye(4)[None] * 1e-12
    rhs = np.einsum("np,npi,np->ni", w, A, dd)
    try:
        cov = np.linalg.inv(N)
    except np.linalg.LinAlgError:
        cov = np.array([np.linalg.pinv(a) for a in N])
    p = np.einsum("nij,nj->ni", cov, rhs)
    res = dd - np.einsum("npi,ni->np", A, p)
    npix = good.sum(1)
    chi2r = np.sum(w * res ** 2, 1) / np.maximum(npix - 4, 1)
    cov = cov * np.maximum(chi2r, 1.0)[:, None, None]
    J = np.array(e["jac_pred"])
    g = np.einsum("ij,nj->ni", J, p[:, 1:3])
    cg = np.einsum("ij,njk,lk->nil", J, cov[:, 1:3, 1:3], J)
    cfg = np.einsum("ij,nj->ni", J, cov[:, 0, 1:3])
    out["f"][idx], out["ef"][idx] = p[:, 0], np.sqrt(np.clip(cov[:, 0, 0], 0, None))
    out["gE"][idx], out["gN"][idx] = g[:, 0], g[:, 1]
    out["vgE"][idx], out["vgN"][idx], out["cgEN"][idx] = cg[:, 0, 0], cg[:, 1, 1], cg[:, 0, 1]
    out["cfgE"][idx], out["cfgN"][idx] = cfg[:, 0], cfg[:, 1]
    out["chi2r"][idx] = chi2r
    out["x"][idx], out["y"][idx] = xs, ys
    out["ok"][idx] = ok & np.isfinite(p[:, 0])
    fl = np.array([""] * n, dtype=object)
    fl[~ok] = "fail"
    fl[satc] = "sat"
    out["flag"][idx] = fl
    return out
