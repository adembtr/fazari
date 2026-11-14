"""Detector B: catalogue-based astrometry of every Gaia DR3 star in the field.

Each Gaia DR3 star (G < 19, the blink.py gaia_field.json list) is predicted in every exposure
with its Gaia proper motion and parallax and measured there (astrometry.py: EPSF fit, Gaia
registration, all ~120 exposures per season). The season offsets measured - Gaia give a drift
d (mas/yr) with errors; the measured proper motion is Gaia + d.

Classes (only the first two are written to candidates.json)
  known mover confirmed   |measured pm| >= SIG_MOTION sigma and d < SIG_ANOMALY sigma  -> gaia-known
  anomalous vs Gaia       d >= SIG_ANOMALY sigma, both detector halves agree           -> candidate
  no significant motion   everything else (counted in the summary)
Gaia 2-parameter solutions (no proper motion) that move significantly are candidates.

When <out>/field_stars.csv from pipeline/blink.py (field_calibration export) exists, the same
drift is also computed from its per-star, per-exposure measurements (status 'used', minus the
applied cell calibration) and compared star by star (summary 'field_stars_csv_check').
"""
import csv
import math

import numpy as np

from . import astrometry as AS
from . import reject as RJ
from . import schema as SC

NAME = "B"
SIG_MOTION = 5.0
SIG_ANOMALY = 5.0
MIN_SEASON_N = 3
GAIA_EPOCH = 2016.0


def judge(ctx, exps, A, T, cells, src, j, floor, smax=None, n_perm=AS.N_PERM):
    """Decision of detector B for Gaia star j of a measurement (A, T, cells). None if the star has
    no drift fit, else dict: f (fit; errors calibrated by residual permutation when the star is
    reported), pmE, pmN, eE, eN (mas/yr, measured = Gaia + drift), sig_abs (significance of the
    total motion), dev (drift vs the Gaia prediction, sigma), dev_formal (before calibration),
    cls (None | 'gaia-known' | 'candidate' | 'artifact'), flags, groups."""
    gt = ctx.gaia
    f = AS.fit_drift(T, j, floor=floor, min_n=MIN_SEASON_N, cells=cells)
    if f is None:
        return None
    two_par = not gt.has5p[j]

    def total(f):
        pmE = (0 if not np.isfinite(gt.pmra[j]) else gt.pmra[j]) + f["bE"] * 1000
        pmN = (0 if not np.isfinite(gt.pmdec[j]) else gt.pmdec[j]) + f["bN"] * 1000
        eE, eN = f["ebE"] * 1000, f["ebN"] * 1000
        return pmE, pmN, eE, eN, AS._sigma_from_chi2((pmE / eE) ** 2 + (pmN / eN) ** 2, 2)
    pmE, pmN, eE, eN, sig_abs = total(f)
    out = {"f": f, "dev_formal": f["sig_motion"], "dev": f["sig_motion"], "cls": None, "flags": [], "groups": {},
           "two_par": two_par, "pmE": pmE, "pmN": pmN, "eE": eE, "eN": eN, "sig_abs": sig_abs}
    if f["sig_motion"] < SIG_ANOMALY and (sig_abs < SIG_MOTION or two_par):
        return out
    f = AS.calibrate(exps, A, T, ctx.seasons, j, f, floor, cells=cells, n_perm=n_perm, min_n=MIN_SEASON_N)
    pmE, pmN, eE, eN, sig_abs = total(f)
    dev = f["sig_motion"]
    out.update(f=f, dev=dev, pmE=pmE, pmN=pmN, eE=eE, eN=eN, sig_abs=sig_abs)
    flags = out["flags"]
    # a fit without a degree of freedom (two cells) is a number that nothing checks: it never makes
    # a star anomalous, and without calibrated errors it is not reported at all
    unchecked = bool(f.get("unchecked"))
    if unchecked and f.get("uncalibrated"):
        return out
    if dev >= SIG_ANOMALY:
        groups, agree = AS.group_agreement(exps, A, ctx.seasons, j, f, floor, cells=cells, T=T, min_n=MIN_SEASON_N)
        out["groups"] = groups
        if not agree:
            flags.append("detector halves disagree")
        bad_line = f["p_linear"] is not None and f["p_linear"] < 1e-3
        if bad_line:
            flags.append("season positions not on a straight line")
        if np.isfinite(gt.ruwe[j]) and gt.ruwe[j] > 1.4:
            flags.append(f"Gaia RUWE {gt.ruwe[j]:.1f} (possible binary)")
        if f["saturated"]:
            flags.append("saturated: wing fit")
        # a real motion change since Gaia also moves the star away from the Gaia position:
        # offset at 2026 ~ drift x (2026 - Gaia epoch). A drift without that offset is not the
        # catalogued star's own motion: a wavelength- or brightness-dependent photocentre of a
        # blend, or (rarely) another source moving through the star's position.
        dt_g = 2026.0 - GAIA_EPOCH
        res = math.hypot(f["aE"] - f["bE"] * dt_g, f["aN"] - f["bN"] * dt_g)
        tol = max(1.0, 3 * math.hypot(0.1, dt_g * math.hypot(f["ebE"], f["ebN"]) / math.sqrt(2)))
        off_ok = res <= tol
        out["own_motion"] = bool(off_ok)
        out["offset_2026_arcsec"] = math.hypot(f["aE"], f["aN"])
        # blends: Gaia magnitudes describe the star (used when the star itself moves); the measured
        # S/N of the listed neighbours describes whatever light is at this position
        near = _brighter_neighbour(gt, j, 8.0)
        if near is None and smax is not None:
            near = AS.blend_neighbour(src, smax, j)
        if near:
            flags.append(f"blended: comparable or brighter source {near:.1f}\" away")
        zone = RJ.in_sat_zone(ctx, src.ra0[j], src.dec0[j], allow_core=True)[0]
        if zone:
            flags.append("in the wings of a saturated star")
        ori_ok, ori_note = AS.orientation_check(T, j, f, floor, min_n=MIN_SEASON_N, cells=cells)
        flags.append(ori_note)
        if not off_ok:
            flags.append(f"offset from Gaia at 2026 is {math.hypot(f['aE'], f['aN']):.1f}\", the drift implies "
                         f"{dt_g * math.hypot(f['bE'], f['bN']):.1f}\" since {GAIA_EPOCH:.0f} (blend / colour shift?)")
        # v1: a drift without the matching offset is rejected (seen on a variable star in the
        # Luhman 16 field: 0.44"/yr together with a 17 % fading = variability-induced motion of
        # an unresolved blend). Accepting "another source moving through the star's position"
        # needs the brightness test (astrometry.vim_suspect) and is not switched on yet.
        vim, fc = AS.vim_suspect(cells, j, math.hypot(f["bE"], f["bN"]) * f["span_yr"]) if cells is not None else (False, None)
        if vim:
            flags.append(f"the shift comes with a brightness change of {100 * fc['frac']:+.0f} %: photocentre of an "
                         "unresolved blend with a variable star (variability-induced motion)")
        if unchecked:
            flags.append(AS.UNCHECKED_FLAG)
        if agree and not near and not zone and not bad_line and ori_ok and off_ok and not vim and not unchecked:
            out["cls"] = "candidate"
            flags.insert(0, "Gaia 2-parameter solution: motion not in Gaia" if two_par else "anomalous vs Gaia")
        else:
            out["cls"] = "artifact"
        gbase = (0.0 if not np.isfinite(gt.pmra[j]) else gt.pmra[j] / 1000, 0.0 if not np.isfinite(gt.pmdec[j]) else gt.pmdec[j] / 1000)
        # the significance of the TOTAL motion in same-orientation seasons, halves and detectors
        _, tnote = AS.orientation_check(T, j, dict(f, bE=f["bE"] + gbase[0], bN=f["bN"] + gbase[1]), floor, base=gbase,
                                        min_n=MIN_SEASON_N, cells=cells)
        out["checks"] = AS.evidence(T, cells, j, floor, f, groups, tnote, base=gbase, min_n=MIN_SEASON_N)
    elif sig_abs >= SIG_MOTION and not two_par:
        out["cls"] = "gaia-known"
        flags.append("known mover confirmed")
        gbase = (gt.pmra[j] / 1000, gt.pmdec[j] / 1000)
        groups, agree = AS.group_agreement(exps, A, ctx.seasons, j, f, floor, cells=cells, T=T, min_n=MIN_SEASON_N)
        out["groups"] = groups
        _, tnote = AS.orientation_check(T, j, dict(f, bE=f["bE"] + gbase[0], bN=f["bN"] + gbase[1]), floor, base=gbase,
                                        min_n=MIN_SEASON_N, cells=cells)
        flags.append(tnote)
        if unchecked:
            flags.append(AS.UNCHECKED_FLAG)
        out["checks"] = AS.evidence(T, cells, j, floor, f, groups, tnote, base=gbase, min_n=MIN_SEASON_N)
    return out


def run(ctx):
    gt = ctx.gaia
    info = {"name": "Gaia DR3 astrometry (catalogue-based)"}
    if gt is None or gt.n == 0:
        ctx.info[NAME] = dict(info, skipped="no Gaia DR3 field stars")
        return []
    from . import deep_astrom
    src, ng = deep_astrom.field_sources(ctx)     # Gaia stars first, then the non-Gaia deep sources
    A, T = deep_astrom.field_measure(ctx)        # measured together (blends modelled)
    cells = deep_astrom.field_cells(ctx)
    smax = deep_astrom.snr_max(T)
    ref = np.nonzero(gt.reference())[0]
    floor, nfl = AS.estimate_season_floor(T, ref)
    floor = max(floor, float((ctx.opts or {}).get("min_season_floor") or 0.0))     # quick boxes: run.quick_verdict
    ctx.season_floor = floor
    ctx.shared["gaia_meas"] = (A, T)
    ctx.log(f"  B: {gt.n} Gaia stars measured; per-season systematic floor {floor:.3f}\" from {nfl} stars")
    cands, counts, fits = [], {"measured": 0, "known_mover_confirmed": 0, "anomalous": 0, "no_significant_motion": 0,
                               "rejected": 0}, {}
    for j in range(ng):
        r = judge(ctx, ctx.exps, A, T, cells, src, j, floor, smax)
        if r is None:
            continue
        counts["measured"] += 1
        f, cls, flags = r["f"], r["cls"], r["flags"]
        fits[int(gt.sid[j])] = (f["bE"], f["bN"], f["ebE"], f["ebN"])
        counts[{"gaia-known": "known_mover_confirmed", "candidate": "anomalous", "artifact": "rejected",
                None: "no_significant_motion"}[cls]] += 1
        if cls is None:
            continue
        pmE, pmN, eE, eN, sig_abs, dev = r["pmE"], r["pmN"], r["eE"], r["eN"], r["sig_abs"], r["dev"]
        mo = SC.motion_dict(pmE, pmN, eE, eN, sig=sig_abs, method="B: EPSF astrometry, all exposures, Gaia-registered, "
                            "one offset per detector, errors from residual permutation")
        mo["deviation_from_gaia_sigma"] = round(dev, 1)
        mo["drift_vs_gaia_mas_yr"] = [round(f["bE"] * 1000, 1), round(f["bN"] * 1000, 1)]
        pos = _season_positions(T, j, src, ctx)
        # barycentric position at 2026.0 (prediction + fitted offset)
        c = SC.new_candidate(NAME, "motion", src.ra0[j] + f["aE"] / 3600 / math.cos(math.radians(src.dec0[j])),
                             src.dec0[j] + f["aN"] / 3600, 2026.0, cls=cls, motion=mo, positions=pos,
                             snr=round(float(np.nanmax(T["snr"][:, j])), 1),
                             flux_ujy=_flux(T, j), bins=sorted({e["detector"] for a, e in enumerate(ctx.exps) if A["ok"][a, j]}),
                             season_pairs=[[ctx.seasons[0], ctx.seasons[-1]]], flags=flags)
        c["mag_ab"] = None if not c["flux_ujy"] else round(23.9 - 2.5 * math.log10(c["flux_ujy"]), 2) if c["flux_ujy"] > 0 else None
        c["match"]["gaia_dr3"] = {"source_id": str(gt.sid[j]), "G": _r(gt.G[j], 2), "pmra_mas_yr": _r(gt.pmra[j], 1),
                                  "pmdec_mas_yr": _r(gt.pmdec[j], 1), "parallax_mas": _r(gt.plx[j], 2),
                                  "ruwe": _r(gt.ruwe[j], 2), "sep_arcsec": round(math.hypot(f["aE"], f["aN"]), 2)}
        if r.get("own_motion") is not None:
            c["match"]["gaia_dr3"]["own_motion"] = r["own_motion"]
        c["checks"] = r.get("checks")
        c["sed_ujy"] = AS.sed_ujy(cells, j)
        c["fit"] = {"chi2": round(f["chi2"], 2), "dof": f["dof"], "n_seasons": f["n_seasons"],
                    "orient_term": f["orient_term"], "season_floor_arcsec": round(floor, 3),
                    "saturated": bool(f.get("saturated")), "model": f.get("model", "pooled detectors"),
                    "n_cells": f.get("n_cells"), "cell_set": f.get("cell_set"), "unchecked": bool(f.get("unchecked")),
                    "error_inflation": f.get("error_inflation"), "bootstrap": f.get("bootstrap")}
        cands.append(c)
    info.update(counts=counts, season_floor_arcsec=round(floor, 4), n_floor_stars=nfl,
                thresholds={"motion_sigma": SIG_MOTION, "anomaly_sigma": SIG_ANOMALY},
                model="one position offset per detector; drift errors calibrated by residual permutation")
    if ctx.field.field_stars_csv and ctx.field.field_stars_csv.exists():
        info["field_stars_csv_check"] = csv_check(ctx.field.field_stars_csv, fits, ctx)
    ctx.info[NAME] = info
    ctx.log(f"  B: {counts}")
    return cands


def _brighter_neighbour(gt, j, rad):
    """Distance to a Gaia star that can bias this star's position: brighter within rad, or
    within 4" and less than 2.5 mag fainter."""
    cosd = math.cos(math.radians(gt.dec[j]))
    d = np.hypot((gt.ra - gt.ra[j]) * cosd, gt.dec - gt.dec[j]) * 3600
    m = (d > 0.05) & (((d < rad) & (gt.G < gt.G[j])) | ((d < 4.0) & (gt.G < gt.G[j] + 2.5)))
    return float(d[m].min()) if m.any() else None


def _season_positions(T, j, src, ctx):
    out = []
    for k, s in enumerate(ctx.seasons):
        if T["n"][k, j] < 1 or not np.isfinite(T["E"][k, j]):
            continue
        t = float(T["t"][k, j])
        r, d = src.at(_mjd(t), t)
        cosd = math.cos(math.radians(d[j]))
        out.append({"season": s, "jyear": round(t, 4), "ra": float(r[j] + T["E"][k, j] / 3600 / cosd),
                    "dec": float(d[j] + T["N"][k, j] / 3600), "n": int(T["n"][k, j]),
                    "err_arcsec": round(float(math.hypot(T["eE"][k, j], T["eN"][k, j])), 3)})
    return out


def _flux(T, j):
    f = T["flux"][:, j][np.isfinite(T["flux"][:, j])]
    return round(float(np.median(f)) * AS.BL.PIXEL_UJY, 1) if len(f) else None


def _mjd(jyear):
    return (jyear - 2000.0) * 365.25 + 51544.5


def _r(v, n):
    return None if v is None or not np.isfinite(v) else round(float(v), n)


def csv_check(path, fits, ctx):
    """Drift of the reference stars from blink.py's field_stars.csv, compared with B."""
    per = {}
    try:
        with open(path, newline="") as fh:
            for r in csv.DictReader(fh):
                if r.get("status") != "used" or r.get("east_arcsec") in ("", None):
                    continue
                cE = float(r["calib_east_arcsec"] or 0)
                cN = float(r["calib_north_arcsec"] or 0)
                per.setdefault(r["source_id"], {}).setdefault(r["season"], []).append(
                    (float(r["mjd"]), float(r["east_arcsec"]) - cE, float(r["north_arcsec"]) - cN))
    except (OSError, ValueError, KeyError) as ex:
        return {"error": str(ex)}
    diffs = []
    for sid, ss in per.items():
        pts = []
        for s, rows in ss.items():
            if len(rows) < 3:
                continue
            a = np.array(rows)
            pts.append(((a[:, 0].mean() - 51544.5) / 365.25 + 2000.0, np.median(a[:, 1]), np.median(a[:, 2])))
        if len(pts) < 2 or int(sid) not in fits:
            continue
        p = np.array(pts)
        if np.ptp(p[:, 0]) < 0.2:
            continue
        bE = np.polyfit(p[:, 0], p[:, 1], 1)[0]
        bN = np.polyfit(p[:, 0], p[:, 2], 1)[0]
        f = fits[int(sid)]
        diffs.append((bE - f[0], bN - f[1]))
    if not diffs:
        return {"n_stars": 0}
    d = np.array(diffs) * 1000
    return {"n_stars": len(d), "median_diff_mas_yr": [round(float(np.median(d[:, 0])), 1), round(float(np.median(d[:, 1])), 1)],
            "robust_spread_mas_yr": [round(AS.BL.robust_sigma(d[:, 0]), 1), round(AS.BL.robust_sigma(d[:, 1]), 1)],
            "note": "drift of blink.py's field_stars.csv measurements minus detector B's, per reference star"}
