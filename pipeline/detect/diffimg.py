"""Detector A: season-difference images, catalogue-free.

For every wavelength bin (blink.py bins: one detector, +-6 % around the bin centre) each season
is stacked (inverse-variance mean on a common 3"/px grid, per-pixel clipping, exposures
registered on the Gaia frame), and two seasons are subtracted:

    D = S_later - S_earlier,   V = V1 + V2 + (MODEL_FRAC x PSF-smoothed brightness)^2

The last term is the PSF-mismatch allowance of bright stars (orientation, wavelength and
pixel-phase differences between the seasons). Z = matched filter of D (Gaussian PSF), divided
by its robust scatter. Positive and negative peaks above SIG sigma are kept.

Season pairs: same-orientation pairs first (SPHEREx turns by 180 deg between some seasons; the
asymmetric PSF then leaves dipole-like residuals on every bright star). Opposite-orientation
pairs are used too, but a motion seen only there must be larger than FLIP_MIN_SHIFT.

Interpretation of the peaks of one difference image
  negative + positive peak (distance <= V_MAX x dt, similar |flux|) -> motion: the source is
      fitted (Gaussian PSF) in both season stacks; vector = later - earlier position
  lone positive / negative peak, source absent from the earlier / later stack -> appearing /
      disappearing; present in both stacks -> variable
  saturated cores (blobs of the saturation mask) that shift between seasons -> motion

Consistency: an object is kept only if it is seen in >= 2 wavelength bins or >= 2 season pairs;
with >= 3 seasons the season positions must lie on a straight line, evenly in time (chi2 test).
Motions are then re-measured with the native-pixel EPSF astrometry of all exposures
(astrometry.py), which gives the final vector and errors.

Rejections (-> not reported, or class 'artifact'): saturated cores (dilated) and missing pixels,
the stack edge, PSF wings of bright stars (|flux change| < WING_FRAC of the star), dipoles
without a significant shift, motions seen only in opposite-orientation pairs below
FLIP_MIN_SHIFT, objects seen in a single bin and a single season pair.
"""
import math

import numpy as np
from scipy.ndimage import gaussian_filter
from scipy.optimize import least_squares
from scipy.stats import chi2 as chi2dist

from . import astrometry as AS
from . import data as Dt
from . import imgproc as IP
from . import reject as RJ
from . import schema as SC

NAME = "A"
SIG = 5.0                   # lone peaks (appearing / disappearing)
SIG_LOBE = 4.0              # each lobe of a motion pair ...
SIG_PAIR = 6.5              # ... and both lobes together (quadrature sum)
MODEL_FRAC = 0.05
V_MAX = 60.0                # arcsec/yr: largest motion paired (a 1000 AU object moves ~40"/yr)
MIN_PAIR_SEP = 2.0          # arcsec: minimum lobe separation considered
FLUX_RATIO = 2.5            # |F+| / |F-| within 1/FLUX_RATIO .. FLUX_RATIO for a motion pair
FLIP_MIN_SHIFT = 1.5        # arcsec: smallest shift accepted from opposite-orientation pairs only
SAT_DILATE = 2              # stack px around saturated cores
EDGE_PX = 6                 # stack px from the coverage edge
WING_FRAC = 0.08            # a change smaller than this fraction of the source = PSF residual
MIN_EXP = 2                 # exposures per season and bin for a stack
MIN_EXP_LONE = 3            # lone peaks (appearing / disappearing) need clipped stacks
CLUSTER_ARCSEC = 60.0       # >= CLUSTER_N other peaks this close to a lone peak = structured residual
CLUSTER_N = 3
WIDTH_RANGE = (0.6, 1.6)    # fitted Gaussian width / PSF width of a point source
MIN_SHIFT_SIG = 4.0         # stack-fit shift must be this many sigma
GROUP_POS = 4.0             # arcsec: records of one object agree to this (+ errors) at 2026.0


def _units(ctx):
    """Stack units: the six wavelength bins (as blink.py), every detector with all its exposures
    (about twice as deep), and D5+D6 together (deepest at 4-5 um, where cold brown dwarfs and
    'Planet X'-like objects are brightest). Lone peaks (appearing / disappearing) are taken from
    the bins only, where a source's colour cannot change its flux between seasons."""
    us = {}
    for e in ctx.exps:
        u = Dt.unit_of(e, "bin")
        if u:
            us.setdefault(u, []).append(e)
        us.setdefault(e["detector"], []).append(e)
        if e["detector"] in ("D5", "D6"):
            us.setdefault("D5+D6", []).append(e)
    return us


def unit_dets(u):
    if u.endswith("um"):
        return frozenset([Dt.BL.BIN_DET[float(u[:-2])]])
    return frozenset(u.split("+"))


def independent_units(units):
    """Largest number of units with pairwise disjoint detector sets (greedy, smallest first)."""
    sets = sorted({unit_dets(u) for u in units}, key=len)
    used, n = set(), 0
    for d in sets:
        if not (d & used):
            used |= d
            n += 1
    return n


def fit_gauss(img, var, x0, y0, sigma, half=5, fix_pos=False):
    """Gaussian-PSF fit (flux, x, y, bg) on a stack image around (x0, y0). Returns dict or None."""
    n = img.shape[0]
    ix, iy = int(round(x0)), int(round(y0))
    if not (half <= ix < n - half and half <= iy < n - half):
        return None
    ys, xs = slice(iy - half, iy + half + 1), slice(ix - half, ix + half + 1)
    d, v = img[ys, xs].astype(float), var[ys, xs].astype(float)
    yy, xx = np.mgrid[ys, xs]
    m = np.isfinite(d) & np.isfinite(v) & (v > 0)
    if m.sum() < 0.6 * d.size:
        return None
    d, v, xx, yy = d[m], v[m], xx[m].astype(float), yy[m].astype(float)
    norm = 1 / (2 * math.pi * sigma ** 2)
    err = np.sqrt(v + (0.03 * np.abs(d)) ** 2)
    if fix_pos:
        A = np.stack([norm * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * sigma ** 2)), np.ones_like(xx)], 1) / err[:, None]
        p, *_ = np.linalg.lstsq(A, d / err, rcond=None)
        cov = np.linalg.pinv(A.T @ A)
        return {"flux": float(p[0]), "eflux": float(math.sqrt(max(cov[0, 0], 0))), "x": x0, "y": y0}

    def model(p):
        f, x, y, b = p
        return f * norm * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2)) + b
    f0 = max(float(np.nansum(d - np.median(d))), 1e-6)
    p0 = [f0, x0, y0, float(np.median(d))]
    lo = [-np.inf, x0 - 2.5, y0 - 2.5, -np.inf]
    hi = [np.inf, x0 + 2.5, y0 + 2.5, np.inf]
    try:
        r = least_squares(lambda p: (model(p) - d) / err, p0, bounds=(lo, hi), x_scale="jac")
    except Exception:
        return None
    if not r.success:
        return None
    try:
        cov = np.linalg.inv(r.jac.T @ r.jac) * max(1.0, 2 * r.cost / max(len(d) - 4, 1))
    except np.linalg.LinAlgError:
        return None
    if np.any(np.isclose(r.x[1:3], lo[1:3])) or np.any(np.isclose(r.x[1:3], hi[1:3])):
        return None
    return {"flux": float(r.x[0]), "eflux": float(math.sqrt(max(cov[0, 0], 0))), "x": float(r.x[1]), "y": float(r.x[2]),
            "ex": float(math.sqrt(max(cov[1, 1], 0))), "ey": float(math.sqrt(max(cov[2, 2], 0)))}


def fit_width(img, var, x0, y0, sigma, half=5):
    """Gaussian width (stack px) of the source at (x0, y0), free position and width."""
    n = img.shape[0]
    ix, iy = int(round(x0)), int(round(y0))
    if not (half <= ix < n - half and half <= iy < n - half):
        return None
    ys, xs = slice(iy - half, iy + half + 1), slice(ix - half, ix + half + 1)
    d, v = img[ys, xs].astype(float), var[ys, xs].astype(float)
    yy, xx = np.mgrid[ys, xs]
    m = np.isfinite(d) & np.isfinite(v) & (v > 0)
    if m.sum() < 0.6 * d.size:
        return None
    d, v, xx, yy = d[m], v[m], xx[m].astype(float), yy[m].astype(float)
    err = np.sqrt(v + (0.03 * np.abs(d)) ** 2)

    def model(p):
        f, x, y, s, b = p
        return f / (2 * math.pi * s * s) * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s)) + b
    f0 = max(float(np.sum(d - np.median(d))), 1e-6)
    try:
        r = least_squares(lambda p: (model(p) - d) / err, [f0, x0, y0, sigma, float(np.median(d))],
                          bounds=([0, x0 - 2, y0 - 2, 0.3 * sigma, -np.inf], [np.inf, x0 + 2, y0 + 2, 4 * sigma, np.inf]))
    except Exception:
        return None
    return float(r.x[3]) if r.success else None


def run(ctx):
    units = _units(ctx)
    sinfo = ctx.season_info
    info = {"name": "season-difference images (catalogue-free)", "units": {}, "pairs": []}
    records, lone, arts = [], [], []
    stacks = {}
    ss_all = ctx.seasons
    ctx.shared["A_same_pairs"] = any(Dt.same_orientation(sinfo[a]["orient_deg"], sinfo[b]["orient_deg"])
                                     for i, a in enumerate(ss_all) for b in ss_all[i + 1:])
    for u, ex in sorted(units.items()):
        by = {}
        for e in ex:
            by.setdefault(e["epoch"], []).append(e)
        ss = [s for s in ctx.seasons if len(by.get(s, [])) >= MIN_EXP]
        info["units"][u] = {s: len(by.get(s, [])) for s in ctx.seasons}
        if len(ss) < 2:
            continue
        sig = Dt.grid_psf_sigma(int(ex[0]["det"]))
        for s in ss:
            stacks[(u, s)] = ctx.stacker.stack(by[s], images=ctx.images)
        for i1 in range(len(ss)):
            for i2 in range(i1 + 1, len(ss)):
                s1, s2 = ss[i1], ss[i2]
                same = Dt.same_orientation(sinfo[s1]["orient_deg"], sinfo[s2]["orient_deg"])
                dt = sinfo[s2]["jyear"] - sinfo[s1]["jyear"]
                r, a, l = _pair(ctx, u, sig, s1, s2, stacks[(u, s1)], stacks[(u, s2)], same, dt,
                                lone_units=u.endswith("um"))
                records += r
                arts += a
                lone += l
                info["pairs"].append({"unit": u, "from": s1, "to": s2, "same_orientation": same,
                                      "dt_yr": round(dt, 3), "n_motion": len(r), "n_lone": len(l), "n_rejected": len(a)})
    ctx.shared["A_stacks"] = stacks
    cands = _group_motion(ctx, records) + _group_lone(ctx, lone)
    reasons = {}
    for r in arts:
        reasons[r.get("artifact", "?")] = reasons.get(r.get("artifact", "?"), 0) + 1
    info["rejected_peaks_by_reason"] = reasons
    info["thresholds"] = {"sigma": SIG, "sigma_lobe": SIG_LOBE, "sigma_pair": SIG_PAIR, "model_frac": MODEL_FRAC, "v_max_arcsec_yr": V_MAX,
                          "flip_min_shift_arcsec": FLIP_MIN_SHIFT, "flux_ratio": FLUX_RATIO, "wing_frac": WING_FRAC}
    info["n_records"] = {"motion": len(records), "lone": len(lone), "rejected_peaks": len(arts)}
    ctx.info[NAME] = info
    ctx.log(f"  A: {len(records)} motion records, {len(lone)} lone-peak records, {len(arts)} rejected peaks "
            f"-> {sum(c['class'] != 'artifact' for c in cands)} objects")
    return cands


def _erode(m, r):
    return ~IP.dilate(~m, r)


def _pair(ctx, u, sig, s1, s2, A1, A2, same, dt, lone_units=True):
    g = ctx.grid
    cover = (A1["n"] >= 1) & (A2["n"] >= 1) & np.isfinite(A1["img"]) & np.isfinite(A2["img"])
    # saturated cores (saturated in >= 30 % of the exposures) are masked; a pixel saturated in a
    # few exposures only is NaN there and the stack uses the other exposures
    sat = IP.dilate(A1["sat"] | A2["sat"], SAT_DILATE)
    valid = _erode(cover, EDGE_PX) & ~sat
    D = A2["img"] - A1["img"]
    bright = gaussian_filter(np.nan_to_num(np.maximum(A1["img"], A2["img"])), sig / 2)
    V = A1["var"] + A2["var"] + (MODEL_FRAC * np.clip(bright, 0, None)) ** 2
    F, eF, Z = IP.matched(D, V, sig, mask=~valid)
    Zn, scale = IP.normalise(Z, valid)
    pos = IP.peaks(Zn, SIG_LOBE, valid, +1)
    neg = IP.peaks(Zn, SIG_LOBE, valid, -1)
    recs, arts, lone = [], [], []
    used_p, used_n = set(), set()
    dmax = max(V_MAX * abs(dt), 20.0) / g.pix
    cand = []
    for a, (xn, yn, zn) in enumerate(neg):
        fn = F[int(round(yn)), int(round(xn))]
        for b, (xp, yp, zp) in enumerate(pos):
            dd = math.hypot(xp - xn, yp - yn)
            if dd * g.pix < MIN_PAIR_SEP or dd > dmax or math.hypot(zn, zp) < SIG_PAIR:
                continue
            fp = F[int(round(yp)), int(round(xp))]
            ratio = abs(fp) / max(abs(fn), 1e-30)
            if not (1 / FLUX_RATIO <= ratio <= FLUX_RATIO):
                continue
            cand.append((abs(math.log(ratio)) + 0.02 * dd, a, b, dd))
    for _, a, b, dd in sorted(cand):
        if a in used_n or b in used_p:
            continue
        xn, yn, zn = neg[a]
        xp, yp, zp = pos[b]
        r = _motion_from_stacks(ctx, u, sig, s1, s2, A1, A2, (xn, yn), (xp, yp), dd, dt, same, min(zn, zp))
        if r is None:
            continue
        used_n.add(a)
        used_p.add(b)
        (arts if r.get("artifact") else recs).append(r)
    recs += _sat_shift(ctx, u, s1, s2, A1, A2, dt, same)
    lone_ok = A1["nexp"] >= MIN_EXP_LONE and A2["nexp"] >= MIN_EXP_LONE
    allpk = [(x, y) for x, y, _ in pos + neg]
    for sign, lst, used in ((+1, pos, used_p), (-1, neg, used_n)):
        for k, (x, y, z) in enumerate(lst):
            if k in used or abs(z) < SIG or not lone_units:
                continue
            if not lone_ok:
                arts.append({"artifact": f"lone peak in a stack of < {MIN_EXP_LONE} exposures (no outlier clipping)"})
                continue
            ix, iy = int(round(x)), int(round(y))
            if min(A1["n"][iy, ix], A2["n"][iy, ix]) < max(MIN_EXP_LONE, 0.5 * min(A1["nexp"], A2["nexp"])):
                arts.append({"artifact": "lone peak where few exposures cover the pixel"})
                continue
            if sum(1 for xx, yy in allpk if 0 < math.hypot(xx - x, yy - y) * g.pix < CLUSTER_ARCSEC) >= CLUSTER_N:
                arts.append({"artifact": "structured residual (ghost, spike or extended emission)"})
                continue
            src_img = A2 if sign > 0 else A1
            w = fit_width(src_img["img"], src_img["var"], x, y, sig)
            if w is None or not (WIDTH_RANGE[0] * sig <= w <= WIDTH_RANGE[1] * sig):
                arts.append({"artifact": "not point-like in the stack where it is present"})
                continue
            ix, iy = int(round(x)), int(round(y))
            q1 = fit_gauss(A1["img"], A1["var"], x, y, sig, fix_pos=True)
            q2 = fit_gauss(A2["img"], A2["var"], x, y, sig, fix_pos=True)
            if not q1 or not q2:
                continue
            r, d = g.to_world(x, y)
            if RJ.in_sat_zone(ctx, float(r[0]), float(d[0]))[0]:
                arts.append({"artifact": "in the wings of a saturated star"})
                continue
            rec = dict(unit=u, s1=s1, s2=s2, same=same, dt=dt, ra=float(r[0]), dec=float(d[0]), z=z, sign=sign,
                       f1=q1["flux"], e1=q1["eflux"], f2=q2["flux"], e2=q2["eflux"], dflux=float(F[iy, ix]),
                       edflux=float(eF[iy, ix] * scale))
            if abs(rec["dflux"]) < WING_FRAC * max(abs(q1["flux"]), abs(q2["flux"])):
                rec["artifact"] = f"bright-source PSF residual (change < {int(100 * WING_FRAC)} % of the source)"
                arts.append(rec)
                continue
            lo_ = q1 if sign > 0 else q2
            if lo_["flux"] >= 3 * lo_["eflux"]:
                # present in both seasons: a brightness change, measured properly by detector V
                arts.append({"artifact": "flux change of a source present in both seasons (left to detector V)"})
                continue
            rec["kind"] = "appearing" if sign > 0 else "disappearing"
            lone.append(rec)
    return recs, arts, lone


def _motion_from_stacks(ctx, u, sig, s1, s2, A1, A2, pn, pp, dd, dt, same, z):
    """Fit the source in both season stacks: earlier position near the negative lobe, later
    near the positive one (overlapping lobes: both fits start from the midpoint)."""
    g = ctx.grid
    if dd < 3.5 * sig:
        st1 = st2 = ((pn[0] + pp[0]) / 2, (pn[1] + pp[1]) / 2)
    else:
        st1, st2 = pn, pp
    q1 = fit_gauss(A1["img"], A1["var"], st1[0], st1[1], sig)
    q2 = fit_gauss(A2["img"], A2["var"], st2[0], st2[1], sig)
    if not q1 or not q2 or q1["flux"] <= 0 or q2["flux"] <= 0:
        return None
    if q1["flux"] < 5 * q1["eflux"] or q2["flux"] < 5 * q2["eflux"]:
        return None
    r1, d1 = g.to_world(q1["x"], q1["y"])
    r2, d2 = g.to_world(q2["x"], q2["y"])
    dE, dN, sep, pa = Dt.BL.offset_arcsec(float(r1[0]), float(d1[0]), float(r2[0]), float(d2[0]))
    err = g.pix * math.hypot(math.hypot(q1["ex"], q1["ey"]), math.hypot(q2["ex"], q2["ey"])) / math.sqrt(2)
    err = math.hypot(err, 0.1 if same else 0.25)           # stack registration / PSF floor
    rec = dict(unit=u, s1=s1, s2=s2, same=same, dt=dt, ra1=float(r1[0]), dec1=float(d1[0]), ra2=float(r2[0]),
               dec2=float(d2[0]), dE=dE, dN=dN, sep=sep, err=err, f1=q1["flux"], f2=q2["flux"], z=z,
               ra=float(r2[0]), dec=float(d2[0]))
    if RJ.in_sat_zone(ctx, rec["ra1"], rec["dec1"], allow_core=True)[0] or \
            RJ.in_sat_zone(ctx, rec["ra2"], rec["dec2"], allow_core=True)[0]:
        rec["artifact"] = "in the wings of a saturated star"
    elif sep < MIN_SHIFT_SIG * err:
        rec["artifact"] = "dipole without a significant shift (registration / PSF residual)"
    elif not same and sep < FLIP_MIN_SHIFT:
        rec["artifact"] = "small dipole in an opposite-orientation pair (PSF asymmetry)"
    elif max(q1["flux"], q2["flux"]) / max(min(q1["flux"], q2["flux"]), 1e-30) > 3.0:
        rec["artifact"] = "flux differs by > 3x between the seasons"
    return rec


def _sat_shift(ctx, u, s1, s2, A1, A2, dt, same):
    """Saturated cores whose centroid moves between the seasons (bright movers)."""
    g = ctx.grid
    b1 = IP.blobs(A1["sat"], min_px=4)
    b2 = IP.blobs(A2["sat"], min_px=4)
    out, used = [], set()
    dmax = max(V_MAX * abs(dt), 20.0) / g.pix
    for x1, y1, n1, _ in b1:
        # a static saturated star has a core at the same place in the other season
        if any(math.hypot(x2 - x1, y2 - y1) < 1.0 for x2, y2, _, _ in b2):
            continue
        best = None
        for k, (x2, y2, n2, _) in enumerate(b2):
            dd = math.hypot(x2 - x1, y2 - y1)
            if k in used or dd > dmax or not (0.4 < n2 / n1 < 2.5):
                continue
            if any(math.hypot(x2 - xa, y2 - ya) < 1.0 for xa, ya, _, _ in b1):
                continue                                   # this core was already there: static star
            if best is None or dd < best[0]:
                best = (dd, k)
        if best is None:
            continue
        dd, k = best
        x2, y2, n2, _ = b2[k]
        err = g.pix * (0.3 + 0.2 * abs(math.sqrt(n2) - math.sqrt(n1)))   # blob centroid noise
        if dd * g.pix < max(3.0, 4 * err) or (not same and dd * g.pix < 2 * FLIP_MIN_SHIFT + 1.5):
            continue
        used.add(k)
        ra1, de1 = g.to_world(x1, y1)
        ra2, de2 = g.to_world(x2, y2)
        dE, dN, sep, pa = Dt.BL.offset_arcsec(float(ra1[0]), float(de1[0]), float(ra2[0]), float(de2[0]))
        out.append(dict(unit=u, s1=s1, s2=s2, same=same, dt=dt, ra1=float(ra1[0]), dec1=float(de1[0]),
                        ra2=float(ra2[0]), dec2=float(de2[0]), dE=dE, dN=dN, sep=sep, err=err, f1=None, f2=None,
                        z=99.0, ra=float(ra2[0]), dec=float(de2[0]), saturated=True))
    return out


def _group_motion(ctx, recs):
    sinfo = ctx.season_info
    for r in recs:
        r["t1"], r["t2"] = sinfo[r["s1"]]["jyear"], sinfo[r["s2"]]["jyear"]
        vE, vN = r["dE"] / r["dt"], r["dN"] / r["dt"]
        cosd = math.cos(math.radians(r["dec1"]))
        r["p26"] = (r["ra1"] + vE * (2026.0 - r["t1"]) / 3600 / cosd, r["dec1"] + vN * (2026.0 - r["t1"]) / 3600, vE, vN)
    groups = []
    for r in sorted(recs, key=lambda r: (not r["same"], -min(r["z"], 50), r["err"])):
        for gp in groups:
            if _consistent(gp[0], r):
                gp.append(r)
                break
        else:
            groups.append([r])
    cands = []
    for gp in groups:
        units = sorted({r["unit"] for r in gp})
        pairs = sorted({(r["s1"], r["s2"]) for r in gp})
        flags, cls = [], "candidate"
        if independent_units(units) < 2 and len(pairs) < 2:
            cls = "artifact"
            flags.append("seen in one detector and one season pair only")
        if not any(r["same"] for r in gp) and max(r["sep"] for r in gp) < 2 * FLIP_MIN_SHIFT:
            cls = "artifact"
            flags.append("only in opposite-orientation pairs")
        pos = {}
        for r in gp:
            for s, ra, de, t in ((r["s1"], r["ra1"], r["dec1"], r["t1"]), (r["s2"], r["ra2"], r["dec2"], r["t2"])):
                pos.setdefault(s, []).append((ra, de, t, r["err"]))
        sp = []
        for s in sorted(pos):
            a = np.array(pos[s])
            sp.append({"season": s, "jyear": round(float(a[:, 2].mean()), 4), "ra": float(np.median(a[:, 0])),
                       "dec": float(np.median(a[:, 1])), "n": len(a), "err_arcsec": round(float(np.median(a[:, 3])), 3)})
        mo, plin = _linear(sp)
        if plin is not None and plin < 1e-4 and len(sp) >= 3:
            # a nearby object adds its annual parallax: accept the track if a parallax fixes it
            plin2, plx = _linear_plx(sp)
            if plin2 is not None and plin2 >= 1e-4 and 0 < plx < 2000:
                flags.append(f"season positions need a parallax of ~{plx:.0f} mas (nearby object?)")
            else:
                flags.append("season positions not collinear / not evenly spaced in time")
                cls = "artifact"
        sat = any(r.get("saturated") for r in gp)
        if sat:
            flags.append("saturated core tracked")
        if cls == "candidate" and not sat and len(pairs) == 1 and len(ctx.seasons) >= 3:
            note, missing = _other_seasons(ctx, gp[0], units)
            if note:
                flags.append(note)
            if missing:
                cls = "artifact"
        p26 = gp[0]["p26"]
        zs = [r["z"] for r in gp if r["z"] < 99]
        c = SC.new_candidate(NAME, "motion", p26[0], p26[1], 2026.0, cls=cls, positions=sp, motion=mo,
                             snr=round(max(zs), 1) if zs else None, bins=units,
                             season_pairs=[list(p) for p in pairs], flags=flags)
        c["n_records"] = len(gp)
        c["_sat_only"] = all(r.get("saturated") for r in gp)
        cands.append(c)
    n_sat_art = sum(1 for c in cands if c["class"] == "artifact" and c.get("_sat_only"))
    ctx.shared["A_sat_artifacts"] = n_sat_art
    cands = [c for c in cands if not (c["class"] == "artifact" and c.get("_sat_only"))]
    for c in cands:
        if c["class"] == "candidate":
            _refine(ctx, c)
    return cands


def _other_seasons(ctx, r, units):
    """An object seen in one season pair only, in a field with more seasons: forced flux at the
    position its track predicts in the other seasons' stacks (same units). Returns (flag text,
    missing?): missing = absent (S/N < 3 and >= 5 sigma below the flux seen in the pair) in
    every other season that covers the predicted position."""
    stacks = ctx.shared.get("A_stacks") or {}
    vE, vN = r["p26"][2], r["p26"][3]
    cosd = math.cos(math.radians(r["p26"][1]))
    tested, absent = [], []
    for s in ctx.seasons:
        if s in (r["s1"], r["s2"]):
            continue
        t = ctx.season_info[s]["jyear"]
        ra = r["p26"][0] + vE * (t - 2026.0) / 3600 / cosd
        de = r["p26"][1] + vN * (t - 2026.0) / 3600
        res = []
        for u in units:
            st, s1st, s2st = stacks.get((u, s)), stacks.get((u, r["s1"])), stacks.get((u, r["s2"]))
            if st is None or s1st is None or s2st is None:
                continue
            sig = Dt.grid_psf_sigma(max(int(d[1:]) for d in unit_dets(u)))
            x, y = ctx.grid.to_pix(ra, de)
            f = fit_gauss(st["img"], st["var"], float(x[0]), float(y[0]), sig, fix_pos=True)
            x1, y1 = ctx.grid.to_pix(r["ra1"], r["dec1"])
            x2, y2 = ctx.grid.to_pix(r["ra2"], r["dec2"])
            f1 = fit_gauss(s1st["img"], s1st["var"], float(x1[0]), float(y1[0]), sig, fix_pos=True)
            f2 = fit_gauss(s2st["img"], s2st["var"], float(x2[0]), float(y2[0]), sig, fix_pos=True)
            if f is None or f1 is None or f2 is None or not (f["eflux"] > 0):
                continue
            fref = 0.5 * (f1["flux"] + f2["flux"])
            res.append((f["flux"], f["eflux"], fref))
        if not res:
            continue
        tested.append(s)
        if all(fl / ef < 3 and fl < fref - 5 * ef for fl, ef, fref in res):
            absent.append(s)
    if not tested:
        return "one season pair only; the other seasons do not cover its track", False
    if absent and len(absent) == len(tested):
        return f"not seen in {', '.join(absent)} where its track predicts it (one season pair only)", True
    return f"one season pair only; present at the predicted position in {', '.join(s for s in tested if s not in absent)}", False


def _consistent(q, r):
    """Is record r the same object as record q (linear motion of q, allowing for parallax
    and the errors)?"""
    vE, vN = q["p26"][2], q["p26"][3]
    cosd = math.cos(math.radians(q["p26"][1]))
    # q's predicted positions at r's two epochs
    pr = []
    for t in (r["t1"], r["t2"]):
        pr.append((q["p26"][0] + vE * (t - 2026.0) / 3600 / cosd, q["p26"][1] + vN * (t - 2026.0) / 3600))
    v = math.hypot(vE, vN)
    tol = 3.0 + 2 * (q["err"] + r["err"]) + 0.15 * v * max(abs(r["t1"] - 2026.0), abs(r["t2"] - 2026.0), 0.5)
    d1 = SC.sep_arcsec(pr[0][0], pr[0][1], r["ra1"], r["dec1"])
    d2 = SC.sep_arcsec(pr[1][0], pr[1][1], r["ra2"], r["dec2"])
    if d1 > tol or d2 > tol:
        return False
    # displacement agrees (parallax between seasons <~ 1" for anything closer than 2 pc... allow 1.5")
    dEq, dNq = vE * r["dt"], vN * r["dt"]
    return math.hypot(r["dE"] - dEq, r["dN"] - dNq) < 1.5 + 3 * math.hypot(q["err"], r["err"]) + 0.15 * math.hypot(dEq, dNq)


def _linear(sp):
    """Straight-line motion through season positions: (motion dict, p-value of the line)."""
    if len(sp) < 2:
        return None, None
    t = np.array([p["jyear"] for p in sp]) - 2026.0
    ra0, de0 = sp[0]["ra"], sp[0]["dec"]
    cosd = math.cos(math.radians(de0))
    E = np.array([((p["ra"] - ra0 + 180) % 360 - 180) * cosd * 3600 for p in sp])
    N = np.array([(p["dec"] - de0) * 3600 for p in sp])
    e = np.array([max(p["err_arcsec"], 0.05) for p in sp])
    X = np.stack([np.ones_like(t), t], 1) / e[:, None]
    out, chi = [], 0.0
    for y in (E, N):
        p, *_ = np.linalg.lstsq(X, y / e, rcond=None)
        cov = np.linalg.pinv(X.T @ X)
        out.append((p[1], math.sqrt(cov[1, 1])))
        chi += float(np.sum((y / e - X @ p) ** 2))
    dof = 2 * (len(sp) - 2)
    plin = float(chi2dist.sf(chi, dof)) if dof > 0 else None
    sig = math.hypot(out[0][0] / out[0][1], out[1][0] / out[1][1])
    return SC.motion_dict(out[0][0] * 1000, out[1][0] * 1000, out[0][1] * 1000, out[1][1] * 1000, sig=sig,
                          method="A: season-stack positions (Gaussian PSF fit)"), plin


def _linear_plx(sp):
    """p-value of a straight line + annual parallax through the season positions, and the parallax (mas)."""
    from . import calib as CAL
    if len(sp) < 3:
        return None, None
    t = np.array([p["jyear"] for p in sp]) - 2026.0
    ra0, de0 = sp[0]["ra"], sp[0]["dec"]
    cosd = math.cos(math.radians(de0))
    E = np.array([((p["ra"] - ra0 + 180) % 360 - 180) * cosd * 3600 for p in sp])
    N = np.array([(p["dec"] - de0) * 3600 for p in sp])
    e = np.array([max(p["err_arcsec"], 0.05) for p in sp])
    pf = [CAL.parallax_factors(np.array([ra0]), np.array([de0]), (tt + 2026.0 - 2000.0) * 365.25 + 51544.5) for tt in t]
    PE = np.array([p[0][0] for p in pf]) / 1000
    PN = np.array([p[1][0] for p in pf]) / 1000
    n = len(t)
    X = np.zeros((2 * n, 5))
    X[:n, 0] = 1; X[:n, 2] = t; X[:n, 4] = PE
    X[n:, 1] = 1; X[n:, 3] = t; X[n:, 4] = PN
    y = np.concatenate([E, N]); w = np.concatenate([e, e])
    p, *_ = np.linalg.lstsq(X / w[:, None], y / w, rcond=None)
    chi = float(np.sum(((y - X @ p) / w) ** 2))
    dof = 2 * n - 5
    return (float(chi2dist.sf(chi, dof)) if dof > 0 else 1.0), float(p[4])


def _refine(ctx, c):
    """Re-measure an A motion in every exposure along its track (EPSF or wing fit)."""
    mo = c["motion"]
    if not mo:
        return
    # the candidate plus the field sources near its track (fitted together: blends modelled)
    from . import deep_astrom
    fs, ng = deep_astrom.field_sources(ctx)
    cosd = math.cos(math.radians(c["dec"]))
    track = [(c["ra"] + mo["pmra_mas_yr"] * dt / 3.6e6 / cosd, c["dec"] + mo["pmdec_mas_yr"] * dt / 3.6e6)
             for dt in (-1.0, -0.5, 0.0, 0.5, 1.0)]
    dmin = np.min([np.hypot((fs.ra0 - r) * cosd, fs.dec0 - d) * 3600 for r, d in track], 0) if fs.n else np.array([])
    nb = np.nonzero((dmin > 3.0) & (dmin < 40.0))[0] if fs.n else np.array([], int)
    src = AS.Sources(np.r_[c["ra"], fs.ra0[nb]], np.r_[c["dec"], fs.dec0[nb]], 2026.0,
                     np.r_[mo["pmra_mas_yr"], fs.pmra[nb]], np.r_[mo["pmdec_mas_yr"], fs.pmdec[nb]],
                     np.r_[0.0, fs.plx[nb]])
    allow = np.zeros(src.n, bool)
    allow[0] = True
    # only the detectors where it was seen (a very red object is noise in the blue detectors)
    dets = sorted({d for u in c["bins"] for d in unit_dets(u)})
    A, T = AS.measure_seasons(ctx.exps, src, ctx.cal, ctx.seasons, images=ctx.images, sat_path=allow,
                              nb=AS.bright_neighbours(ctx.gaia), iters=3, det_subset=dets or None)
    floor = ctx.season_floor if ctx.season_floor else AS.SEASON_FLOOR
    f = AS.fit_drift(T, 0, floor=floor, fit_plx=True, ra=c["ra"], dec=c["dec"], min_snr=5.0)
    if f is None or math.hypot(f["bE"], f["bN"]) > 0.5 * max(mo["speed_arcsec_yr"], 1.0):
        c["flags"].append("native-pixel refinement failed (stack motion kept)")
        return
    pmE = mo["pmra_mas_yr"] + f["bE"] * 1000
    pmN = mo["pmdec_mas_yr"] + f["bN"] * 1000
    eE, eN = max(f["ebE"] * 1000, 1.0), max(f["ebN"] * 1000, 1.0)
    # the stack and the native-pixel motions use the same exposures; when they differ by more
    # than 3 sigma a systematic error dominates: inflate the error to half the difference
    dpm = math.hypot(pmE - mo["pmra_mas_yr"], pmN - mo["pmdec_mas_yr"])
    estk = math.hypot(mo["err_pmra_mas_yr"], mo["err_pmdec_mas_yr"]) / math.sqrt(2)
    if dpm > 3 * math.hypot(estk, math.hypot(eE, eN) / math.sqrt(2)):
        eE, eN = max(eE, dpm / 2), max(eN, dpm / 2)
        c["flags"].append(f"stack and native-pixel motions differ by {dpm / 1000:.2f}\"/yr (error inflated)")
    sig = AS._sigma_from_chi2((pmE / eE) ** 2 + (pmN / eN) ** 2, 2)
    stack_est = mo["speed_arcsec_yr"]
    c["motion"] = SC.motion_dict(pmE, pmN, eE, eN, sig=sig,
                                 method="found by A; motion from EPSF/wing astrometry of all exposures along the track")
    c["motion"]["stack_estimate_arcsec_yr"] = stack_est
    if f.get("parallax_mas"):
        c["motion"]["parallax_mas"] = round(f["parallax_mas"][0], 1)
        c["motion"]["err_parallax_mas"] = round(f["parallax_mas"][1], 1)
    cosd = math.cos(math.radians(c["dec"]))
    c["ra"] += f["aE"] / 3600 / cosd
    c["dec"] += f["aN"] / 3600
    pos = []
    for k, s in enumerate(ctx.seasons):
        if T["n"][k, 0] >= 1 and np.isfinite(T["E"][k, 0]):
            t = float(T["t"][k, 0])
            r, d = src.at((t - 2000.0) * 365.25 + 51544.5, t)
            pos.append({"season": s, "jyear": round(t, 4), "ra": float(r[0] + T["E"][k, 0] / 3600 / cosd),
                        "dec": float(d[0] + T["N"][k, 0] / 3600), "n": int(T["n"][k, 0]),
                        "err_arcsec": round(float(math.hypot(T["eE"][k, 0], T["eN"][k, 0])), 3)})
    if pos:
        c["positions"] = pos
    fl = T["flux"][:, 0][np.isfinite(T["flux"][:, 0])]
    if len(fl):
        c["flux_ujy"] = round(float(np.median(fl)) * Dt.BL.PIXEL_UJY, 1)
        m = Dt.jy_to_ab(c["flux_ujy"])
        c["mag_ab"] = round(m, 2) if m else None
    if f["saturated"]:
        c["flags"].append("saturated: wing-fit astrometry")
    c["fit"] = {"chi2": round(f["chi2"], 2), "dof": f["dof"], "n_seasons": f["n_seasons"], "orient_term": f["orient_term"]}


def _group_lone(ctx, recs):
    groups = []
    for r in sorted(recs, key=lambda r: -r["z"]):
        for gp in groups:
            if gp[0]["kind"] == r["kind"] and SC.sep_arcsec(gp[0]["ra"], gp[0]["dec"], r["ra"], r["dec"]) < GROUP_POS:
                gp.append(r)
                break
        else:
            groups.append([r])
    out = []
    for gp in groups:
        units = sorted({r["unit"] for r in gp})
        pairs = sorted({(r["s1"], r["s2"]) for r in gp})
        cls, flags = "candidate", []
        # a single-exposure artifact of one season shows in every pair with that season: the
        # source must be seen in >= 2 wavelength bins, or be present in >= 2 different seasons
        present = {r["s2"] if r["kind"] == "appearing" else r["s1"] for r in gp}
        if independent_units(units) < 2 and len(present) < 2:
            cls = "artifact"
            flags.append("one bin, present in one season only")
        if ctx.shared.get("A_same_pairs") and not any(r["same"] for r in gp):
            cls = "artifact"
            flags.append("only between opposite telescope orientations (ghost / stray light?)")
        best = gp[0]
        ch = [{"unit": r["unit"], "from": r["s1"], "to": r["s2"],
               "flux_ujy": [round(IP.stack_flux_ujy(r["f1"]), 1), round(IP.stack_flux_ujy(r["f2"]), 1)],
               "err_ujy": [round(IP.stack_flux_ujy(r["e1"]), 1), round(IP.stack_flux_ujy(r["e2"]), 1)]} for r in gp]
        c = SC.new_candidate(NAME, best["kind"], best["ra"], best["dec"], 2026.0, cls=cls, snr=round(best["z"], 1),
                             bins=units, season_pairs=[list(p) for p in pairs], flags=flags)
        c["flux_changes"] = ch
        out.append(c)
    return out
