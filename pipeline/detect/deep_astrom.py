"""Detector D: catalogue-free astrometry of every source of the deep stack.

The sources are the peaks (>= DEEP_SNR sigma, matched filter) of the per-detector deep stacks
(all exposures of all seasons). A peak within GAIA_MATCH (half a native pixel) of a Gaia DR3 star
is that star (or an unresolved blend with it) and is left to detector B; all others (sources too
red or too faint for Gaia: brown dwarfs, "Planet X"-like objects, galaxies) are measured in
every exposure exactly like the Gaia stars (astrometry.py), together with the Gaia stars so that
blends are modelled, and get a drift from their season positions (one position offset per
detector, errors calibrated on the source's own residuals).

Two passes: sources with a drift > PASS2_MIN arcsec/yr are re-measured along the fitted track
(the 7x7 px EPSF stamp then stays centred on them in every season).

A source is a candidate when its motion is >= SIG_MOTION sigma after the error calibration, the
short- and long-wavelength detector halves agree, the cells lie on a straight line, no source
with >= 30 % of its S/N lies within 8" (SPHEREx cannot separate them), it is outside the wings
of saturated stars, and the motion survives in same-orientation seasons. judge() is that
complete decision for one source; null_movers() applies it (and detector B's) to any season
table, which is what the shuffle null test calls.
"""
import math

import numpy as np

from . import astrometry as AS
from . import calib as CAL
from . import data as Dt
from . import imgproc as IP
from . import reject as RJ
from . import schema as SC

NAME = "D"
DEEP_SNR = 5.0
DEEP_RAW_MIN = 50.0         # formal matched-filter S/N that always counts as a source (~AB 20 in D2)
SIG_MOTION = 5.0
GAIA_MATCH = 3.1            # arcsec = half a native pixel: a deep-stack peak this close to a Gaia star (at
#                             2026.0) is that star or an unresolved blend with it and is measured by detector B.
#                             Peaks further out are sources of their own; if the Gaia star next to them has
#                             >= 30 % of their S/N they are blends (astrometry.blend_neighbour) and not reported.
MERGE_ARCSEC = 6.15         # peaks of different detectors closer than this are one source
BLEND_ARCSEC = AS.BLEND_ARCSEC
OWN_CORE_ARCSEC = 6.15      # a source this close to the centre of a saturation core ...
OWN_CORE_MAX = 10.0         # ... of at most this radius (arcsec) is that partly saturated source itself
PASS2_MIN = 0.4             # arcsec/yr
EDGE_ARCSEC = 25.0          # sources this close to the stack edge are not used
SAT_PM_MIN = 300.0          # mas/yr: Gaia stars this fast get wing fits when saturated


def deep_sources(ctx, thresh=DEEP_SNR):
    """Peaks of the per-detector deep stacks, merged across detectors (cached in ctx.shared)."""
    if "deep_sources" in ctx.shared:
        return ctx.shared["deep_sources"]
    g = ctx.grid
    found = []                                   # (ra, dec, z, detector, flux_ujy)
    sat_all = np.zeros((g.n, g.n), bool)
    for det in sorted({e["detector"] for e in ctx.exps}):
        sel = [e for e in ctx.exps if e["detector"] == det]
        st = ctx.stacker.stack(sel, images=ctx.images)
        if st is None:
            continue
        sig = Dt.grid_psf_sigma(int(det[1]))
        cover = st["n"] >= max(3, 0.3 * np.median(st["n"][st["n"] > 0]))
        # saturated cores only ('satany' = flagged or NaN in ANY exposure would cover most of a
        # deep stack of ~100 dithered exposures)
        sat = IP.dilate(st["satcore"], 3)
        sat_all |= sat
        F, eF, Z = IP.matched(st["img"], st["var"], sig, mask=~cover)
        valid = cover & ~sat & IP.dilate(cover, 0)
        Zn, s = IP.normalise(Z, valid)
        # threshold: thresh x the robust scatter of the S/N map, but at most DEEP_RAW_MIN in formal
        # S/N. A deep stack of ~100 exposures is confusion-limited (the scatter of the map is faint
        # sources, s ~ 100 in D1-D4), and 5 s would keep only sources brighter than AB ~17.
        for x, y, z in IP.peaks(Zn, min(thresh, DEEP_RAW_MIN / s), valid, +1, min_sep=2):
            r, d = g.to_world(x, y)
            ix, iy = int(round(x)), int(round(y))
            found.append((float(r[0]), float(d[0]), z, det, float(IP.stack_flux_ujy(F[iy, ix]))))
    # merge across detectors (one native pixel: closer peaks cannot be told apart, and two list
    # entries for one source would share its flux at random in the joint fit)
    found.sort(key=lambda q: -q[2])
    merged = []
    for r, d, z, det, fl in found:
        for m in merged:
            if SC.sep_arcsec(m["ra"], m["dec"], r, d) < MERGE_ARCSEC:
                m["dets"].add(det)
                m["flux"][det] = fl
                break
        else:
            merged.append({"ra": r, "dec": d, "z": z, "dets": {det}, "flux": {det: fl}})
    # stay away from the stack edge
    eE, eN = g.offset(np.array([m["ra"] for m in merged]), np.array([m["dec"] for m in merged])) if merged else ([], [])
    half = g.n * g.pix / 2 - EDGE_ARCSEC
    merged = [m for m, a, b in zip(merged, eE, eN) if abs(a) < half and abs(b) < half]
    ctx.shared["deep_sources"] = merged
    ctx.shared["deep_satmask"] = sat_all
    ctx.log(f"  deep stack: {len(merged)} sources >= {thresh} sigma")
    return merged


def field_sources(ctx):
    """Gaia DR3 stars (with their motion) + deep-stack sources not in Gaia (static)."""
    if "field_sources" in ctx.shared:
        return ctx.shared["field_sources"]
    deep = deep_sources(ctx)
    gt = ctx.gaia
    ra, dec, pmra, pmdec, plx, ids, kind = [], [], [], [], [], [], []
    ng = 0
    if gt is not None and gt.n:
        r26, d26 = gt.at(Dt.Time(2026.0, format="jyear").mjd, parallax=False)
        ng = gt.n
        ra += list(r26); dec += list(d26)
        pmra += list(np.nan_to_num(gt.pmra)); pmdec += list(np.nan_to_num(gt.pmdec)); plx += list(np.nan_to_num(gt.plx))
        ids += [f"G{s}" for s in gt.sid]; kind += ["gaia"] * ng
        cosd = math.cos(math.radians(ctx.field.dec))
        gxy = np.stack([r26 * cosd * 3600, d26 * 3600], 1)
    nd = 0
    for k, m in enumerate(deep):
        if ng:
            dd = np.hypot(gxy[:, 0] - m["ra"] * cosd * 3600, gxy[:, 1] - m["dec"] * 3600)
            if dd.min() < GAIA_MATCH:
                m["gaia"] = int(np.argmin(dd))
                continue
        ra.append(m["ra"]); dec.append(m["dec"]); pmra.append(0.0); pmdec.append(0.0); plx.append(0.0)
        ids.append(f"S{k}"); kind.append("deep")
        nd += 1
    # Gaia stars move with their own (2016 -> 2026) motion: their reference epoch is 2026.0
    src = AS.Sources(ra, dec, 2026.0, pmra, pmdec, plx, ids=np.array(ids, dtype=object))
    src.kind_arr = np.array(kind)
    ctx.shared["field_sources"] = (src, ng)
    return src, ng


def field_measure(ctx):
    if "field_measure" not in ctx.shared:
        src, ng = field_sources(ctx)
        # wing fits of saturated cores only for known fast movers (the slow path); other
        # saturated movers are found by detector A and refined there
        fastpm = np.hypot(src.pmra, src.pmdec) > SAT_PM_MIN
        A, T = AS.measure_seasons(ctx.exps, src, ctx.cal, ctx.seasons, images=ctx.images, sat_path=fastpm,
                                  nb=AS.bright_neighbours(ctx.gaia))
        ctx.shared["field_measure"] = (A, T)
    return ctx.shared["field_measure"]


def field_cells(ctx):
    """Per-detector season tables of the field measurement (astrometry.cell_tables), cached."""
    if "field_cells" not in ctx.shared:
        A, T = field_measure(ctx)
        ctx.shared["field_cells"] = AS.cell_tables(ctx.exps, A, ctx.seasons)
    return ctx.shared["field_cells"]


def snr_max(T):
    """Best season S/N of every source of a season table."""
    with np.errstate(all="ignore"):
        return np.nanmax(np.where(np.isfinite(T["snr"]), T["snr"], 0.0), 0)


def judge(ctx, exps, A, T, cells, j, floor, ra, dec, base=None, near=None, n_perm=AS.N_PERM):
    """Complete mover decision of detector D for source j of a measurement (A, T, cells) at sky
    position (ra, dec): None if there is no fit or the drift is below SIG_MOTION, else
    dict(f=fit with calibrated errors, cls='candidate' | 'artifact' | None, flags, groups);
    cls None = below SIG_MOTION after the error calibration.
    base: (E, N) drift (arcsec/yr) of the track the offsets were measured along (pass 2); the
    significance then refers to the total drift. near: distance (arcsec) of a blending neighbour
    (astrometry.blend_neighbour on the field source list), or None."""
    f = AS.fit_motion(T, cells, j, floor, ra, dec)
    if f is None:
        return None
    tot = _total(f, base)
    if AS._sigma_from_chi2((tot["bE"] / f["ebE"]) ** 2 + (tot["bN"] / f["ebN"]) ** 2, 2) < SIG_MOTION:
        return None
    om = bool(f.get("orient_model"))
    f = AS.calibrate(exps, A, T, ctx.seasons, j, f, floor, cells=cells, n_perm=n_perm, base=base, orient_term=om)
    if f["sig_motion"] < SIG_MOTION:
        return {"f": f, "cls": None, "flags": ["below 5 sigma after the error calibration"], "groups": {}}
    flags = []
    if f["motion_model"] != "linear":
        flags.append("motion model: " + f["motion_model"])
    # the halves are compared in the parallax-free model when the line did not fit
    groups, agree = AS.group_agreement(exps, A, ctx.seasons, j, f, floor, cells=cells, T=T,
                                       orient_term=om or f["motion_model"] != "linear")
    if not agree:
        flags.append("detector halves disagree")
    bad_line = f["p_linear"] is not None and f["p_linear"] < 1e-3
    if bad_line:
        flags.append("season positions not on a straight line (parallax or blend?)")
    if near is not None:
        flags.append(f"blended: a source with >= {int(100 * AS.BLEND_RATIO)} % of its S/N is {near:.1f}\" away")
    zone, zdist, zcore = RJ.in_sat_zone(ctx, ra, dec)
    if zone and zdist <= OWN_CORE_ARCSEC and zcore <= OWN_CORE_MAX:
        zone = False                 # a partly saturated source itself (small core at its own position)
    if zone:
        flags.append("in the wings of a saturated star")
    ori_ok, ori_note = AS.orientation_check(T, j, _total(f, base), floor, base=base, cells=cells)
    flags.append(ori_note)
    ok = agree and near is None and not zone and not bad_line and ori_ok
    return {"f": f, "cls": "candidate" if ok else "artifact", "flags": flags, "groups": groups}


def _total(f, base):
    return f if not base else dict(f, bE=f["bE"] + base[0], bN=f["bN"] + base[1])


def null_movers(ctx, exps, A, T, src, ng, floor, n_perm=AS.N_PERM):
    """Sources that pass the complete mover criteria of detectors B (Gaia stars: drift relative
    to the Gaia motion) and D (other sources) for the season table T made from exps (pass 1
    only). For null tests on shuffled exposure dates (tests/shuffle.py): whatever is returned
    there is a false mover. Returns (hits, number with a formal drift >= 5 sigma)."""
    from . import gaia_astrom as GA
    cells = AS.cell_tables(exps, A, ctx.seasons)
    smax = snr_max(T)
    hits, raw = [], 0
    for j in range(src.n):
        if j < ng:
            r = GA.judge(ctx, exps, A, T, cells, src, j, floor, smax, n_perm=n_perm)
            if r is None or r["dev_formal"] < GA.SIG_ANOMALY:
                continue
            raw += 1
        else:
            f0 = AS.fit_motion(T, cells, j, floor, src.ra0[j], src.dec0[j])
            if f0 is None or f0["sig_motion"] < SIG_MOTION:
                continue
            raw += 1
            r = judge(ctx, exps, A, T, cells, j, floor, src.ra0[j], src.dec0[j], near=AS.blend_neighbour(src, smax, j),
                      n_perm=n_perm)
        if r is None or r["cls"] != "candidate":
            continue
        f = r["f"]
        hits.append({"j": int(j), "gaia": bool(j < ng), "ra": round(float(src.ra0[j]), 6), "dec": round(float(src.dec0[j]), 6),
                     "drift_mas_yr": [round(1000 * f["bE"], 1), round(1000 * f["bN"], 1)], "sigma": round(f["sig_motion"], 1),
                     "error_inflation": f.get("error_inflation")})
    return hits, raw


def run(ctx):
    src, ng = field_sources(ctx)
    A, T = field_measure(ctx)
    cells = field_cells(ctx)
    floor = ctx.season_floor
    if floor is None:
        ref = [j for j in range(ng) if ctx.gaia is not None and ctx.gaia.reference()[j]] if ng else \
            [j for j in range(src.n) if np.nanmax(T["snr"][:, j]) > 50]
        floor, _ = AS.estimate_season_floor(T, ref)
        ctx.season_floor = floor
    deep_idx = list(range(ng, src.n))
    info = {"name": "deep-stack source astrometry (catalogue-free)", "n_sources": len(deep_idx),
            "n_gaia_modelled": ng, "season_floor_arcsec": round(floor, 4),
            "model": "one position offset per detector; drift errors calibrated by residual permutation"}
    smax = snr_max(T)
    first = {}
    for j in deep_idx:
        f = AS.fit_motion(T, cells, j, floor, src.ra0[j], src.dec0[j])
        if f:
            first[j] = f
    # pass 2: re-measure along the fitted track
    movers = [j for j, f in first.items() if math.hypot(f["bE"], f["bN"]) > PASS2_MIN and f["sig_motion"] >= 3]
    A2 = T2 = cells2 = None
    if movers:
        s2 = AS.Sources(src.ra0[movers], src.dec0[movers], 2026.0, [first[j]["bE"] * 1000 for j in movers],
                        [first[j]["bN"] * 1000 for j in movers], None, ids=np.array(movers))
        A2, T2 = AS.measure_seasons(ctx.exps, s2, ctx.cal, ctx.seasons, images=ctx.images, sat_path=False)
        cells2 = AS.cell_tables(ctx.exps, A2, ctx.seasons)
    cands, counts = [], {"measured": len(first), "candidates": 0, "rejected": 0, "below_5_sigma_after_calibration": 0}
    peakz = {f"S{k}": m["z"] for k, m in enumerate(deep_sources(ctx))}
    for j, f1 in first.items():
        ra0, de0 = float(src.ra0[j]), float(src.dec0[j])
        near = AS.blend_neighbour(src, smax, j)
        r, base, Tj, jj = None, None, T, j
        if j in movers:
            k = movers.index(j)
            if AS.fit_motion(T2, cells2, k, floor, ra0, de0) is not None:
                base, Tj, jj = (f1["bE"], f1["bN"]), T2, k
                r = judge(ctx, ctx.exps, A2, T2, cells2, k, floor, ra0, de0, base=base, near=near)
        if base is None:
            r = judge(ctx, ctx.exps, A, T, cells, j, floor, ra0, de0, near=near)
        if r is None:
            continue
        if r["cls"] is None:
            counts["below_5_sigma_after_calibration"] += 1
            continue
        f, cls, flags, groups = _total(r["f"], base), r["cls"], r["flags"], r["groups"]
        counts["candidates" if cls == "candidate" else "rejected"] += 1
        mo = SC.motion_dict(f["bE"] * 1000, f["bN"] * 1000, f["ebE"] * 1000, f["ebN"] * 1000, sig=f["sig_motion"],
                            method="D: EPSF astrometry of a deep-stack source, all exposures, Gaia-registered, "
                                   "one offset per detector, errors from residual permutation")
        if f.get("parallax_mas"):
            mo["parallax_mas"], mo["err_parallax_mas"] = round(f["parallax_mas"][0], 1), round(f["parallax_mas"][1], 1)
        cosd = math.cos(math.radians(de0))
        ra = ra0 + f["aE"] / 3600 / cosd
        de = de0 + f["aN"] / 3600
        pos = []
        for k, s in enumerate(ctx.seasons):
            if Tj["n"][k, jj] >= 1 and np.isfinite(Tj["E"][k, jj]):
                t = float(Tj["t"][k, jj])
                # pass 2 offsets are relative to the first-pass track
                pE = base[0] * (t - 2026.0) if base else 0.0
                pN = base[1] * (t - 2026.0) if base else 0.0
                pos.append({"season": s, "jyear": round(t, 4),
                            "ra": float(ra0 + (Tj["E"][k, jj] + pE) / 3600 / cosd),
                            "dec": float(de0 + (Tj["N"][k, jj] + pN) / 3600), "n": int(Tj["n"][k, jj]),
                            "err_arcsec": round(float(math.hypot(Tj["eE"][k, jj], Tj["eN"][k, jj])), 3)})
        fl = T["flux"][:, j][np.isfinite(T["flux"][:, j])]
        flux = round(float(np.median(fl)) * AS.BL.PIXEL_UJY, 1) if len(fl) else None
        c = SC.new_candidate(NAME, "motion", ra, de, 2026.0, cls=cls, motion=mo, positions=pos,
                             snr=round(float(smax[j]), 1), flux_ujy=flux,
                             mag_ab=round(23.9 - 2.5 * math.log10(flux), 2) if flux and flux > 0 else None,
                             bins=sorted({e["detector"] for a, e in enumerate(ctx.exps) if A["ok"][a, j]}),
                             season_pairs=[[ctx.seasons[0], ctx.seasons[-1]]], flags=flags)
        c["fit"] = {"chi2": round(f["chi2"], 2), "dof": f["dof"], "n_seasons": f["n_seasons"],
                    "groups": {g: [round(v["bE"] * 1000, 1), round(v["bN"] * 1000, 1), round(v["ebE"] * 1000, 1),
                                   round(v["ebN"] * 1000, 1)] for g, v in groups.items()},
                    "deep_peak_sigma": round(peakz.get(str(src.ids[j]), float("nan")), 1),
                    "model": f.get("model", "pooled detectors"), "motion_model": f.get("motion_model"),
                    "p_linear": f.get("p_linear"), "p_linear_no_parallax": f.get("p_linear_no_parallax"),
                    "n_cells": f.get("n_cells"), "detectors": f.get("detectors"), "pass2": bool(base),
                    "error_inflation": f.get("error_inflation"), "bootstrap": f.get("bootstrap")}
        cands.append(c)
    info["counts"] = counts
    ctx.info[NAME] = info
    ctx.log(f"  D: {len(deep_idx)} non-Gaia sources; {counts}")
    return cands


def _rel(f, f1):
    """A pass-2 fit expressed relative to the pass-2 track (what group_agreement compares)."""
    return dict(f, bE=f["bE"] - f1["bE"], bN=f["bN"] - f1["bN"])


def self_registration(field, exps, log=print):
    """Registration without Gaia: bright isolated deep-stack sources, assumed static."""
    g = Dt.Grid(field.ra, field.dec)

    class _C:
        pass
    c = _C()
    c.grid, c.exps, c.images, c.log, c.shared = g, exps, None, log, {}
    c.stacker = Dt.Stacker(exps, g, {})
    deep = deep_sources(c, thresh=20.0)
    if len(deep) < 5:
        return {e["file"]: (0.0, 0.0) for e in exps}, {"mode": "none", "note": "too few bright sources"}
    xy = np.array([[m["ra"], m["dec"]] for m in deep])
    cosd = math.cos(math.radians(field.dec))
    iso = []
    for k in range(len(xy)):
        dd = np.hypot((xy[:, 0] - xy[k, 0]) * cosd, xy[:, 1] - xy[k, 1]) * 3600
        iso.append(np.sum(dd < 12.0) == 1)
    sel = np.array(iso)
    return CAL.registration(exps, xy[sel, 0], xy[sel, 1], np.arange(len(xy))[sel], log=log, mode="self")
