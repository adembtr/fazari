"""Synthetic sources for the injection tests (moving and/or changing point sources).

A source has a position at 2026.0, a proper motion (mas/yr, no parallax), and a flux in uJy
per season (flat in F_nu, i.e. the same AB magnitude at every wavelength, unless a per-season
factor is given). In every exposure it is placed with that exposure's own WCS (after the
registration offset, so it sits where a real star at that sky position would sit) and its own
EPSF (the row of the EPSF table nearest to the source on the detector), and Poisson noise of
the added signal is added (variance per unit signal measured from the exposure's own
VARIANCE vs IMAGE relation). The exposures are copied; the originals are not changed.
"""
import copy
import math

import numpy as np
from scipy.ndimage import map_coordinates, spline_filter

import blink as BL

R_INJ = 5                    # native px half size of the injected stamp (EPSF covers +-3.3 px)


def gain_slope(e):
    """d(VARIANCE)/d(signal) of an exposure (Poisson term), robust fit on bright pixels."""
    if "_gain_slope" in e:
        return e["_gain_slope"]
    px = e["_px"]
    img = px["clean"].astype(float)
    var = np.where(np.isfinite(px["var"]), px["var"], np.nan).astype(float)
    m = px["good"] & np.isfinite(img) & np.isfinite(var)
    if m.sum() < 200:
        e["_gain_slope"] = 0.0
        return 0.0
    x, y = img[m], var[m]
    base = np.median(y)
    hi = x > np.percentile(x, 98)
    k = 0.0
    if hi.sum() > 20:
        k = float(np.median((y[hi] - base) / np.maximum(x[hi], 1e-6)))
    e["_gain_slope"] = max(k, 0.0)
    return e["_gain_slope"]


def _psf_rows(e):
    px = e["_px"]
    if "_inj_psf" not in px:
        rows = px["epsf_rows"]
        px["_inj_psf"] = (rows["x"], rows["y"], [spline_filter(p, order=3) for p in rows["psf"]])
    return px["_inj_psf"]


def stamp(e, x, y):
    """EPSF of exposure e for a source at native pixel (x, y): (ix0, iy0, kernel 2D)."""
    xs, ys, psfs = _psf_rows(e)
    k = int(np.argmin((xs - x) ** 2 + (ys - y) ** 2))
    psf, ovs = psfs[k], e["_px"]["ovs"]
    c = (psf.shape[0] - 1) / 2
    ix, iy = int(round(x)), int(round(y))
    yy, xx = np.mgrid[iy - R_INJ:iy + R_INJ + 1, ix - R_INJ:ix + R_INJ + 1]
    u = c + ovs * (xx - x)
    v = c + ovs * (yy - y)
    ker = map_coordinates(psf, [v.ravel(), u.ravel()], order=3, mode="constant", cval=0.0, prefilter=False)
    return ix - R_INJ, iy - R_INJ, ker.reshape(xx.shape) * ovs * ovs


def inject(exps, sources, cal, seed=1):
    """Copies of exps with the sources added. sources: list of dicts
        ra, dec (deg at 2026.0), pmra, pmdec (mas/yr), flux_ujy, season_factor {season: x} (optional)
    Returns the new exposure list (same order)."""
    rng = np.random.default_rng(seed)
    out = []
    for e in exps:
        px = e["_px"]
        img = px["clean"].astype(np.float64).copy()
        var = px["var"].astype(np.float64).copy()
        ny, nx = img.shape
        cE, cN = cal.get(e["file"], (0.0, 0.0))
        add = np.zeros_like(img)
        for s in sources:
            dt = e["jyear"] - 2026.0
            cosd = math.cos(math.radians(s["dec"]))
            ra = s["ra"] + (s.get("pmra", 0.0) * dt / 3.6e6 + cE / 3600) / cosd
            de = s["dec"] + s.get("pmdec", 0.0) * dt / 3.6e6 + cN / 3600
            x, y = (float(v) for v in px["wcs"].all_world2pix(ra, de, 0))
            if not (-R_INJ <= x < nx + R_INJ and -R_INJ <= y < ny + R_INJ):
                continue
            fac = (s.get("season_factor") or {}).get(e["epoch"], 1.0)
            f = s["flux_ujy"] * fac / BL.PIXEL_UJY
            if f <= 0:
                continue
            x0, y0, ker = stamp(e, x, y)
            ys, xs = slice(max(y0, 0), min(y0 + ker.shape[0], ny)), slice(max(x0, 0), min(x0 + ker.shape[1], nx))
            add[ys, xs] += f * ker[ys.start - y0:ys.stop - y0, xs.start - x0:xs.stop - x0]
        if add.any():
            k = gain_slope(e)
            pos = np.clip(add, 0, None)
            noise = rng.normal(0.0, 1.0, img.shape) * np.sqrt(k * pos)
            img = img + add + noise
            var = np.where(np.isfinite(var), var + k * pos, var)
        ne = dict(e)
        ne["_px"] = dict(px, clean=img.astype(np.float32), var=var.astype(np.float32))
        ne["_px"].pop("_inj_psf", None)
        out.append(ne)
    return out


def ab_to_ujy(m):
    return 10 ** ((23.9 - m) / 2.5)
