"""Registration of every exposure on the Gaia DR3 frame (or, without Gaia, on the field itself).

Gaia DR3 reference stars pass the cuts of pipeline/ASTROMETRY.md (G 10-17.5, 5/6-parameter
solution, RUWE <= 1.4, no other G < 19 star within 12"); they are moved to each exposure's
mid-time (proper motion + annual parallax, Earth barycentric position) and measured with the
same EPSF fit (measure.py) that measures every other source, so the registration and the
measurements share one estimator.

Offsets measured - Gaia (east, north) are pooled per season x detector cell (same pointing
pattern, detector and orientation), clipped (3 sigma on the residual length) and averaged, as in
pipeline/ASTROMETRY.md; a cell with < CAL_MIN_STARS distinct stars or an error > CAL_MAX_ERR
takes the median of the accepted cells of its season. When the per-exposure offset itself is
well measured (>= CAL_EXP_MIN distinct stars, error <= CAL_EXP_MAXERR) it is used instead
(SPHEREx pointings can differ by a few hundredths of an arcsec within a cell).

Self-calibration (no Gaia): the same procedure with the field's own bright, isolated sources,
whose reference positions are their mean positions over all exposures (they are assumed static;
the clipping removes the few that move).

If <out>/field_stars.csv (pipeline/blink.py field_calibration export) exists, its per-exposure
calib_east/north_arcsec values are read and compared with ours (summary only).
"""
import csv
import math

import numpy as np
from astropy.coordinates import get_body_barycentric
from astropy.time import Time

import blink as BL
from . import measure as M

CAL_GMIN, CAL_GMAX, CAL_RUWE, CAL_ISOL = BL.CAL_GMIN, BL.CAL_GMAX, BL.CAL_RUWE, BL.CAL_ISOL_ARCSEC
CAL_MIN_SNR = 20.0
CAL_MATCH = 2.0             # arcsec: larger |measured - Gaia| = mismatch
CAL_MIN_STARS = 5
CAL_MAX_ERR = 0.08
CAL_EXP_MIN = 8
CAL_EXP_MAXERR = 0.04

_EARTH = {}


def earth_xyz(mjd):
    k = round(float(mjd), 5)
    if k not in _EARTH:
        _EARTH[k] = get_body_barycentric("earth", Time(k, format="mjd")).xyz.to_value("AU")
    return _EARTH[k]


def parallax_factors(ra, dec, mjd):
    """(east, north) displacement per mas of parallax at time mjd (Earth barycentric)."""
    X, Y, Z = earth_xyz(mjd)
    a, d = np.radians(ra), np.radians(dec)
    return (X * np.sin(a) - Y * np.cos(a),
            X * np.cos(a) * np.sin(d) + Y * np.sin(a) * np.sin(d) - Z * np.cos(d))


class GaiaTable:
    """Gaia DR3 field stars as arrays (blink.py gaia_field.json)."""

    def __init__(self, gaia, target_id=None):
        st = gaia["stars"]
        col = {c: i for i, c in enumerate(gaia["columns"])}

        def arr(name, fill=np.nan):
            return np.array([fill if s[col[name]] is None else s[col[name]] for s in st], float)
        self.sid = np.array([int(s[col["source_id"]]) for s in st], np.int64)
        self.ra, self.dec = arr("ra"), arr("dec")
        self.pmra, self.pmdec, self.plx = arr("pmra"), arr("pmdec"), arr("parallax")
        self.G, self.ruwe = arr("phot_g_mean_mag"), arr("ruwe")
        self.has5p = np.isfinite(self.pmra) & np.isfinite(self.plx)
        self.epoch = float(gaia.get("ref_epoch", 2016.0))
        self.n = len(self.sid)
        cosd = math.cos(math.radians(np.nanmedian(self.dec))) if self.n else 1.0
        xy = np.stack([self.ra * cosd * 3600, self.dec * 3600], 1) if self.n else np.zeros((0, 2))
        self.isolated = np.ones(self.n, bool)
        if self.n:
            from scipy.spatial import cKDTree
            tr = cKDTree(xy)
            cnt = np.array([len(v) for v in tr.query_ball_point(xy, CAL_ISOL)])
            self.isolated = cnt <= 1
        self.target_id = int(target_id) if target_id not in (None, "", "None") else None

    def reference(self):
        m = (self.has5p & (self.G >= CAL_GMIN) & (self.G <= CAL_GMAX) & (self.ruwe <= CAL_RUWE)
             & self.isolated)
        if self.target_id is not None:
            m &= self.sid != self.target_id
        return m

    def at(self, mjd, sel=None, parallax=True):
        """(ra, dec) of the stars at time mjd: proper motion + annual parallax."""
        s = slice(None) if sel is None else sel
        ra, dec = self.ra[s], self.dec[s]
        dt = Time(mjd, format="mjd").jyear - self.epoch
        pe, pn = parallax_factors(ra, dec, mjd)
        plx = np.nan_to_num(self.plx[s]) if parallax else np.zeros(len(ra))
        dE = np.nan_to_num(self.pmra[s]) * dt + plx * pe
        dN = np.nan_to_num(self.pmdec[s]) * dt + plx * pn
        return ra + dE / 3.6e6 / np.cos(np.radians(dec)), dec + dN / 3.6e6


def on_cutout(e, ra, dec, margin=4):
    x, y = e["_px"]["wcs"].all_world2pix(ra, dec, 0)
    ny, nx = e["shape"]
    return (x >= margin) & (x < nx - margin) & (y >= margin) & (y < ny - margin)


def clipped_mean(dE, dN, w, ids, clip=3.0):
    """Clipped weighted mean offset; error from the scatter of distinct stars."""
    use = np.isfinite(dE) & np.isfinite(dN)
    if use.sum() < 2:
        return None
    for _ in range(6):
        mE = np.average(dE[use], weights=w[use])
        mN = np.average(dN[use], weights=w[use])
        rr = np.hypot(dE - mE, dN - mN)
        sig = max(1.4826 * np.median(rr[use]) / 1.1774, 0.03)
        new = np.isfinite(rr) & (rr < clip * sig)
        if new.sum() < 2 or (new == use).all():
            break
        use = new
    nd = len(set(ids[use].tolist()))
    sE = float(np.std(dE[use] - mE, ddof=1)) if use.sum() > 1 else 0.3
    sN = float(np.std(dN[use] - mN, ddof=1)) if use.sum() > 1 else 0.3
    neff = max(min(int(use.sum()), nd), 1)
    return dict(east=float(mE), north=float(mN), err_east=sE / math.sqrt(neff), err_north=sN / math.sqrt(neff),
                n=int(use.sum()), n_stars=nd, rms=(sE, sN))


def registration(exps, ref_ra, ref_dec, ref_ids, log=print, mode="gaia", min_snr=CAL_MIN_SNR, nb=None):
    """Per-exposure registration offsets (east, north arcsec; WCS - reference frame).
    ref_ra / ref_dec: callables mjd -> (ra, dec) arrays of the reference sources, or fixed arrays.
    nb: optional callable mjd -> (ra, dec) of other catalogue stars, fitted together with the
    reference stars (crowded fields: their light is modelled, not left in the residuals).
    Returns (cal dict file -> (east, north), summary dict)."""
    per_exp, pooled = {}, {}
    for e in exps:
        r, d = (ref_ra(e["mjd"]) if callable(ref_ra) else (ref_ra, ref_dec))
        on = on_cutout(e, r, d, margin=M.R_STAMP + 1)
        if on.sum() == 0:
            continue
        nr = int(on.sum())
        rr, dd = r[on], d[on]
        if nb is not None:
            r2, d2 = nb(e["mjd"])
            on2 = on_cutout(e, r2, d2, margin=-M.R_STAMP)
            rr, dd = np.r_[rr, r2[on2]], np.r_[dd, d2[on2]]
        m = M.measure_linear(e, rr, dd)            # same linear estimator as the measurements
        m = {k: (v[:nr] if hasattr(v, "__len__") and len(v) == len(rr) else v) for k, v in m.items()}
        ids = ref_ids[on]
        with np.errstate(all="ignore"):
            f = m["f"]
            dE, dN = m["gE"] / f, m["gN"] / f
            eE, eN = np.sqrt(m["vgE"]) / np.abs(f), np.sqrt(m["vgN"]) / np.abs(f)
            # S/N cut on the statistical error (the errors are scaled up by the fit's chi2 for
            # the weights; in crowded stamps that scaling would remove every star)
            snr = f / (m["ef"] / np.sqrt(np.maximum(np.nan_to_num(m["chi2r"], nan=1.0), 1.0)))
            good = m["ok"] & (snr >= min_snr) & (np.hypot(dE, dN) < CAL_MATCH)
        rows = (dE[good], dN[good], ids[good], 1.0 / (eE[good] ** 2 + eN[good] ** 2 + 0.02 ** 2))
        pooled.setdefault((e["epoch"], e["detector"]), []).append(rows)
        if good.sum() >= 3:
            per_exp[e["file"]] = clipped_mean(rows[0], rows[1], rows[3], rows[2])
    cells = {}
    for k, lst in pooled.items():
        dE = np.concatenate([a[0] for a in lst]); dN = np.concatenate([a[1] for a in lst])
        ids = np.concatenate([a[2] for a in lst]); w = np.concatenate([a[3] for a in lst])
        c = clipped_mean(dE, dN, w, ids) if len(dE) >= 2 else None
        cells[k] = c
    good = {k: c for k, c in cells.items() if c and c["n_stars"] >= CAL_MIN_STARS
            and max(c["err_east"], c["err_north"]) <= CAL_MAX_ERR}
    cal, src = {}, {"exposure": 0, "cell": 0, "season": 0, "none": 0}
    for e in exps:
        k = (e["epoch"], e["detector"])
        pe = per_exp.get(e["file"])
        if pe and pe["n_stars"] >= CAL_EXP_MIN and max(pe["err_east"], pe["err_north"]) <= CAL_EXP_MAXERR:
            cal[e["file"]] = (pe["east"], pe["north"])
            src["exposure"] += 1
        elif k in good:
            cal[e["file"]] = (good[k]["east"], good[k]["north"])
            src["cell"] += 1
        else:
            same = [c for (s, _), c in good.items() if s == e["epoch"]]
            if same:
                cal[e["file"]] = (float(np.median([c["east"] for c in same])),
                                  float(np.median([c["north"] for c in same])))
                src["season"] += 1
            else:
                cal[e["file"]] = (0.0, 0.0)
                src["none"] += 1
    summ = {"mode": mode, "n_reference": int(len(ref_ids)), "source_of_offset": src,
            "cells": [{"season": s, "detector": d, "accepted": (s, d) in good,
                       **({"east_arcsec": round(c["east"], 3), "north_arcsec": round(c["north"], 3),
                           "err_east_arcsec": round(c["err_east"], 3), "err_north_arcsec": round(c["err_north"], 3),
                           "n": c["n"], "n_stars": c["n_stars"],
                           "star_rms_arcsec": [round(c["rms"][0], 3), round(c["rms"][1], 3)]} if c else {})}
                      for (s, d), c in sorted(cells.items())]}
    log(f"  registration ({mode}): {len(ref_ids)} reference sources; offsets from {src}")
    return cal, summ


def field_stars_offsets(path):
    """Per-exposure calib offsets of a blink.py field_stars.csv: file -> (east, north)."""
    out = {}
    try:
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                if r.get("calib_east_arcsec") not in (None, "") and r["file"] not in out:
                    out[r["file"]] = (float(r["calib_east_arcsec"]), float(r["calib_north_arcsec"]))
    except (OSError, ValueError, KeyError):
        return {}
    return out


def compare_with_blink(cal, path):
    """Median and robust spread of (ours - blink.py) per-exposure offsets."""
    other = field_stars_offsets(path)
    common = [f for f in cal if f in other]
    if not common:
        return None
    dE = np.array([cal[f][0] - other[f][0] for f in common])
    dN = np.array([cal[f][1] - other[f][1] for f in common])
    return {"n_exposures": len(common), "median_diff_arcsec": [round(float(np.median(dE)), 3), round(float(np.median(dN)), 3)],
            "robust_spread_arcsec": [round(BL.robust_sigma(dE), 3), round(BL.robust_sigma(dN), 3)]}
