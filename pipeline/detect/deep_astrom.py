"""Detector D: catalogue-free astrometry of every source of the deep stack.

The sources are the peaks (>= DEEP_SNR sigma, matched filter) of the per-detector deep stacks
(all exposures of all seasons). Sources that are Gaia DR3 stars are left to detector B; all
others (sources too red or too faint for Gaia: brown dwarfs, "Planet X"-like objects, galaxies)
are measured in every exposure exactly like the Gaia stars (astrometry.py), together with the
Gaia stars so that blends are modelled, and get a drift from their season positions.

Two passes: sources with a drift > PASS2_MIN arcsec/yr are re-measured along the fitted track
(the 7x7 px EPSF stamp then stays centred on them in every season).

A source is a candidate when its motion is >= SIG_MOTION sigma, the short- and long-wavelength
detector halves agree, and no brighter source lies within BLEND_ARCSEC. This path, with ~120
exposures per season and the Gaia registration, reaches motions far below what a difference
image shows (see pipeline/DETECTION.md, injection test).
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
GAIA_MATCH = 2.5            # arcsec: a deep source this close to a Gaia star (at its epoch) is that star
BLEND_ARCSEC = 8.0
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
    # merge across detectors (3")
    found.sort(key=lambda q: -q[2])
    merged = []
    for r, d, z, det, fl in found:
        for m in merged:
            if SC.sep_arcsec(m["ra"], m["dec"], r, d) < 3.0:
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


def run(ctx):
    src, ng = field_sources(ctx)
    A, T = field_measure(ctx)
    floor = ctx.season_floor
    if floor is None:
        ref = [j for j in range(ng) if ctx.gaia is not None and ctx.gaia.reference()[j]] if ng else \
            [j for j in range(src.n) if np.nanmax(T["snr"][:, j]) > 50]
        floor, _ = AS.estimate_season_floor(T, ref)
        ctx.season_floor = floor
    deep_idx = list(range(ng, src.n))
    info = {"name": "deep-stack source astrometry (catalogue-free)", "n_sources": len(deep_idx),
            "n_gaia_modelled": ng, "season_floor_arcsec": round(floor, 4)}
    first = {}
    for j in deep_idx:
        f = AS.fit_drift(T, j, floor=floor, fit_plx=True, ra=src.ra0[j], dec=src.dec0[j])
        if f:
            first[j] = f
    # pass 2: re-measure along the fitted track
    movers = [j for j, f in first.items() if math.hypot(f["bE"], f["bN"]) > PASS2_MIN and f["sig_motion"] >= 3]
    fits = dict(first)
    A2 = T2 = None
    if movers:
        s2 = AS.Sources(src.ra0[movers], src.dec0[movers], 2026.0, [first[j]["bE"] * 1000 for j in movers],
                        [first[j]["bN"] * 1000 for j in movers], None, ids=np.array(movers))
        A2, T2 = AS.measure_seasons(ctx.exps, s2, ctx.cal, ctx.seasons, images=ctx.images, sat_path=False)
        for k, j in enumerate(movers):
            f2 = AS.fit_drift(T2, k, floor=floor, fit_plx=True, ra=src.ra0[j], dec=src.dec0[j])
            if f2:
                f2 = dict(f2, bE=f2["bE"] + first[j]["bE"], bN=f2["bN"] + first[j]["bN"], pass2=True)
                # the significance vs "static" must be recomputed for the total motion
                f2["sig_motion"] = AS._sigma_from_chi2((f2["bE"] / f2["ebE"]) ** 2 + (f2["bN"] / f2["ebN"]) ** 2, 2)
                fits[j] = f2
    cands, counts = [], {"measured": len(fits), "candidates": 0, "rejected": 0}
    allxy = np.array([[r, d] for r, d in zip(src.ra0, src.dec0)])
    peakz = {f"S{k}": m["z"] for k, m in enumerate(deep_sources(ctx))}
    for j, f in fits.items():
        if f["sig_motion"] < SIG_MOTION:
            continue
        if f.get("pass2"):
            k = movers.index(j)
            groups, agree = AS.group_agreement(ctx.exps, A2, ctx.seasons, k, _rel(f, first[j]), floor)
        else:
            groups, agree = AS.group_agreement(ctx.exps, A, ctx.seasons, j, f, floor)
        flags = []
        cosd = math.cos(math.radians(src.dec0[j]))
        dd = np.hypot((allxy[:, 0] - src.ra0[j]) * cosd, allxy[:, 1] - src.dec0[j]) * 3600
        snr_j = np.nanmax(T["snr"][:, j])
        nb = (dd > 0.5) & (dd < BLEND_ARCSEC) & (np.nanmax(T["snr"], 0) > snr_j)
        if nb.any():
            flags.append(f"brighter source {dd[nb].min():.1f}\" away (blend)")
        if not agree:
            flags.append("detector halves disagree")
        bad_line = f["p_linear"] is not None and f["p_linear"] < 1e-3
        if bad_line:
            flags.append("season positions not on a straight line (parallax or blend?)")
        zone = RJ.in_sat_zone(ctx, src.ra0[j], src.dec0[j])[0]
        if zone:
            flags.append("in the wings of a saturated star")
        Tj_, jj_ = (T2, movers.index(j)) if f.get("pass2") else (T, j)
        ori_ok, ori_note = AS.orientation_check(Tj_, jj_, _rel(f, first[j]) if f.get("pass2") else f, floor)
        flags.append(ori_note)
        cls = "candidate" if agree and not nb.any() and not zone and not bad_line and ori_ok else "artifact"
        counts["candidates" if cls == "candidate" else "rejected"] += 1
        mo = SC.motion_dict(f["bE"] * 1000, f["bN"] * 1000, f["ebE"] * 1000, f["ebN"] * 1000, sig=f["sig_motion"],
                            method="D: EPSF astrometry of a deep-stack source, all exposures, Gaia-registered")
        if f.get("parallax_mas"):
            mo["parallax_mas"], mo["err_parallax_mas"] = round(f["parallax_mas"][0], 1), round(f["parallax_mas"][1], 1)
        ra = src.ra0[j] + f["aE"] / 3600 / cosd
        de = src.dec0[j] + f["aN"] / 3600
        Tj = T2 if f.get("pass2") else T
        jj = movers.index(j) if f.get("pass2") else j
        pos = []
        for k, s in enumerate(ctx.seasons):
            if Tj["n"][k, jj] >= 1 and np.isfinite(Tj["E"][k, jj]):
                t = float(Tj["t"][k, jj])
                # pass 2 offsets are relative to the first-pass track
                pE = first[j]["bE"] * (t - 2026.0) if f.get("pass2") else 0.0
                pN = first[j]["bN"] * (t - 2026.0) if f.get("pass2") else 0.0
                pos.append({"season": s, "jyear": round(t, 4),
                            "ra": float(src.ra0[j] + (Tj["E"][k, jj] + pE) / 3600 / cosd),
                            "dec": float(src.dec0[j] + (Tj["N"][k, jj] + pN) / 3600), "n": int(Tj["n"][k, jj]),
                            "err_arcsec": round(float(math.hypot(Tj["eE"][k, jj], Tj["eN"][k, jj])), 3)})
        fl = T["flux"][:, j][np.isfinite(T["flux"][:, j])]
        flux = round(float(np.median(fl)) * AS.BL.PIXEL_UJY, 1) if len(fl) else None
        c = SC.new_candidate(NAME, "motion", ra, de, 2026.0, cls=cls, motion=mo, positions=pos,
                             snr=round(float(snr_j), 1), flux_ujy=flux,
                             mag_ab=round(23.9 - 2.5 * math.log10(flux), 2) if flux and flux > 0 else None,
                             bins=sorted({e["detector"] for a, e in enumerate(ctx.exps) if A["ok"][a, j]}),
                             season_pairs=[[ctx.seasons[0], ctx.seasons[-1]]], flags=flags)
        c["fit"] = {"chi2": round(f["chi2"], 2), "dof": f["dof"], "n_seasons": f["n_seasons"],
                    "groups": {g: [round(v["bE"] * 1000, 1), round(v["bN"] * 1000, 1), round(v["ebE"] * 1000, 1),
                                   round(v["ebN"] * 1000, 1)] for g, v in groups.items()},
                    "deep_peak_sigma": round(peakz.get(str(src.ids[j]), float("nan")), 1)}
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
