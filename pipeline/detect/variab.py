"""Detector V: brightness changes of every source, from the photometry of all exposures.

Sources: the Gaia DR3 stars and the deep-stack sources (deep_astrom.field_sources), measured in
every exposure with the linear EPSF fit at their (moving) positions (astrometry.measure_all:
forced fluxes, no S/N selection). Saturated stars (blobs of the saturation masks) are measured
in an annulus just outside their saturated core instead (wing photometry, as blink.py does for
RW Aur and R Dra; same annulus in every season).

Per exposure, a photometric zero point z_i = median over bright reference sources of
(flux / that source's median flux in the detector) removes calibration and throughput changes.
Each exposure samples a different wavelength across the linear variable filter, so per source
and detector the normalised fluxes are fitted as

    F_i / z_i = a_season + c (lambda_i - mean lambda)

(one level per season, one colour slope shared by the seasons). Season-to-season changes
a_s2 / a_s1 - 1 get errors from the fit plus a per-detector systematic floor (the scatter of
the same ratio for all bright sources of the field). A source is a variable candidate when
|change| >= SIG_VAR sigma in >= 2 (detector, season pair) combinations, and >= MIN_FRAC.
"""
import math

import numpy as np

import blink as BL
from . import data as Dt
from . import deep_astrom
from . import reject as RJ
from . import schema as SC

NAME = "V"
SIG_VAR = 5.0
MIN_FRAC = 0.03             # smallest fractional change reported
EXP_FLOOR = 0.02            # per-exposure fractional photometric floor
ZP_MIN_SNR = 30.0
ZP_MIN_N = 5
MIN_EXP_SEASON = 3
BLEND_ARCSEC = 8.0


def run(ctx):
    src, ng = deep_astrom.field_sources(ctx)
    A, T = deep_astrom.field_measure(ctx)
    exps = ctx.exps
    info = {"name": "brightness changes (forced EPSF / annulus photometry of all exposures)"}
    F = A["f"].copy()
    E = A["ef"].copy()
    ok = A["ok"] & np.isfinite(F) & np.isfinite(E) & (E > 0) & ~A["sat"]
    lam = A["lam"]
    dets = A["det"]
    seasons = ctx.seasons
    sinfo = ctx.season_info
    sea = np.array([e["epoch"] for e in exps])
    zones = RJ.sat_zones(ctx)
    inzone = np.array([RJ.in_sat_zone(ctx, r, d)[0] for r, d in zip(src.ra0, src.dec0)]) if src.n else np.zeros(0, bool)
    # per-exposure zero points
    z = np.ones(len(exps))
    med = np.full(F.shape, np.nan)
    for d in np.unique(dets):
        rows = dets == d
        with np.errstate(all="ignore"):
            m = np.nanmedian(np.where(ok[rows], F[rows], np.nan), 0)
        med[rows] = m[None, :]
    snr = np.where(ok, F / E, 0)
    for i in range(len(exps)):
        refs = ok[i] & (snr[i] >= ZP_MIN_SNR) & (med[i] > 0) & ~inzone
        if refs.sum() >= ZP_MIN_N:
            z[i] = float(np.median(F[i, refs] / med[i, refs]))
    info["zero_point_spread"] = round(float(np.std(z)), 4)
    info["n_zero_points"] = int(np.sum(z != 1.0))
    Fn, En = F / z[:, None], E / z[:, None]
    # level per season and detector
    levels = {}                                         # (j, det) -> {season: (a, err, n)}
    for d in np.unique(dets):
        rows = np.nonzero(dets == d)[0]
        for j in range(src.n):
            r = rows[ok[rows, j]]
            if len(r) < 2 * MIN_EXP_SEASON or inzone[j]:
                continue
            levels[(j, d)] = _fit_levels(Fn[r, j], En[r, j], lam[r, j], sea[r], seasons)
    # saturated stars: annulus photometry
    sat_levels, sat_src = _saturated(ctx, z, zones)
    allv = dict(levels)
    for key, v in sat_levels.items():
        allv[("sat", key[0], key[1])] = v
    # systematic floor per detector from bright, unsaturated sources
    floor = {}
    for d in np.unique(dets):
        fr = []
        for (j, dd), L in levels.items():
            if dd != d:
                continue
            ss = [s for s in seasons if s in L and L[s][2] >= MIN_EXP_SEASON]
            for a_, b_ in zip(ss[:-1], ss[1:]):
                a1, e1, _ = L[a_]
                a2, e2, _ = L[b_]
                if a1 > 0 and a1 / e1 > 100 and a2 / e2 > 100:
                    fr.append(a2 / a1 - 1)
        floor[d] = round(max(BL.robust_sigma(fr) / math.sqrt(2), 0.005), 4) if len(fr) >= 8 else 0.02
    info["season_floor_frac"] = floor
    # per-exposure point-source noise per detector (sensitivity card)
    vn = {}
    for d in np.unique(dets):
        rows_d = dets == d
        faint = ok[rows_d] & (snr[rows_d] < 20) & (snr[rows_d] > 0)
        if faint.sum() >= 20:
            s1 = float(np.median(E[rows_d][faint])) * BL.PIXEL_UJY
            nps = [int(np.sum(rows_d & (sea == s_))) for s_ in seasons]
            nps = [x for x in nps if x > 0]
            vn[str(d)] = (s1, float(np.median(nps)) if nps else 0, floor.get(d, 0.02))
    ctx.shared["V_noise"] = vn
    cands = []
    counts = {"tested": 0, "variable": 0, "appearing_disappearing": 0}
    keys = {}
    for key, L in allv.items():
        keys.setdefault(key[:-1], {})[key[-1]] = L
    for skey, per_det in keys.items():
        counts["tested"] += 1
        hits, rows = [], []
        for d, L in per_det.items():
            ss = [s for s in seasons if s in L and L[s][2] >= MIN_EXP_SEASON]
            for i1 in range(len(ss)):
                for i2 in range(i1 + 1, len(ss)):
                    a1, e1, n1 = L[ss[i1]]
                    a2, e2, n2 = L[ss[i2]]
                    ref = max(abs(a1), abs(a2), 1e-30)
                    fl = floor.get(d, 0.02) * ref
                    err = math.sqrt(e1 ** 2 + e2 ** 2 + 2 * fl ** 2)
                    sig = (a2 - a1) / err
                    frac = a2 / a1 - 1 if a1 > 3 * e1 else float("inf") if a2 > 0 else float("nan")
                    same = Dt.same_orientation(sinfo[ss[i1]]["orient_deg"], sinfo[ss[i2]]["orient_deg"])
                    rows.append({"detector": d, "from": ss[i1], "to": ss[i2], "same_orientation": same,
                                 "flux_ujy": [round(a1 * BL.PIXEL_UJY, 1), round(a2 * BL.PIXEL_UJY, 1)],
                                 "err_ujy": [round(e1 * BL.PIXEL_UJY, 1), round(e2 * BL.PIXEL_UJY, 1)],
                                 "change_frac": None if not np.isfinite(frac) else round(frac, 4), "sigma": round(sig, 1)})
                    if abs(sig) >= SIG_VAR and (not np.isfinite(frac) or abs(frac) >= MIN_FRAC):
                        hits.append(rows[-1])
        if not hits:
            continue
        ndet = len({h["detector"] for h in hits})
        npair = len({(h["from"], h["to"]) for h in hits})
        if len(hits) < 2 or (ndet < 2 and npair < 2):
            continue
        flags0 = []
        cls0 = None
        same_avail = any(r["same_orientation"] for r in rows)
        if same_avail and not any(h["same_orientation"] for h in hits):
            cls0 = "artifact"
            flags0.append("changes only between opposite telescope orientations (ghost / stray light?)")
        elif not same_avail:
            flags0.append("no same-orientation season pair: ghosts cannot be excluded")
        if skey[0] != "sat":
            j = skey[0]
            cosd = math.cos(math.radians(src.dec0[j]))
            dd = np.hypot((src.ra0 - src.ra0[j]) * cosd, src.dec0 - src.dec0[j]) * 3600
            fl_j = np.nanmax(T["flux"][:, j]) if np.isfinite(T["flux"][:, j]).any() else 0
            nbf = np.nanmax(T["flux"], 0)
            blend = (dd > 0.05) & (dd < BLEND_ARCSEC) & (np.nan_to_num(nbf) > 0.3 * max(fl_j, 0))
            if blend.any():
                cls0 = "artifact"
                flags0.append(f"blended (source {dd[blend].min():.1f}\" away)")
            if RJ.in_sat_zone(ctx, src.ra0[j], src.dec0[j])[0]:
                cls0 = "artifact"
                flags0.append("in the wings of a saturated star")
        if skey[0] == "sat":
            ra, dec = sat_src[skey[1]][:2]
            flags = ["saturated: wing (annulus) photometry"]
            if sat_src[skey[1]][2]:
                flags.append(sat_src[skey[1]][2])
            sn = None
        else:
            j = skey[0]
            ra, dec = src.ra0[j], src.dec0[j]
            flags = []
            sn = round(float(np.nanmax(T["snr"][:, j])), 1)
        best = max(hits, key=lambda h: abs(h["sigma"]))
        kind, cls = "variable", "variable"
        lows = [h for h in hits if h["flux_ujy"][0] < 3 * h["err_ujy"][0] or h["flux_ujy"][1] < 3 * h["err_ujy"][1]]
        if len(lows) >= 2:
            kind = "appearing" if best["sigma"] > 0 else "disappearing"
            cls = "candidate"
        flags = flags0 + flags
        if cls0 == "artifact":
            cls = "artifact"
            counts["rejected"] = counts.get("rejected", 0) + 1
        elif kind == "variable":
            counts["variable"] += 1
        else:
            counts["appearing_disappearing"] += 1
        c = SC.new_candidate(NAME, kind, ra, dec, 2026.0, cls=cls, snr=sn,
                             bins=sorted({h["detector"] for h in hits}),
                             season_pairs=sorted([list(p) for p in {(h["from"], h["to"]) for h in hits}]), flags=flags)
        c["brightness"] = {"max_change_frac": best["change_frac"], "max_sigma": best["sigma"], "changes": rows}
        if skey[0] != "sat" and skey[0] < ng and ctx.gaia is not None:
            c["match"]["gaia_dr3"] = {"source_id": str(ctx.gaia.sid[skey[0]]), "G": round(float(ctx.gaia.G[skey[0]]), 2)}
        cands.append(c)
    info.update(counts=counts, thresholds={"sigma": SIG_VAR, "min_frac": MIN_FRAC, "exp_floor": EXP_FLOOR})
    ctx.info[NAME] = info
    ctx.log(f"  V: {counts}; season floors {floor}")
    return cands


def _fit_levels(f, e, lam, sea, seasons):
    """Weighted fit F = a_s + c (lam - mean): {season: (a, err, n)}."""
    present = [s for s in seasons if (sea == s).sum() >= 1]
    if not present:
        return {}
    lm = np.nanmean(lam) if np.isfinite(lam).any() else 0.0
    dl = np.nan_to_num(lam - lm)
    level = np.nanmedian(f)
    w = 1 / (e ** 2 + (EXP_FLOOR * abs(level)) ** 2)
    cols = [(sea == s).astype(float) for s in present]
    use_slope = np.ptp(dl) > 0.01 and len(f) >= len(present) + 3
    X = np.stack(cols + ([dl] if use_slope else []), 1)
    sw = np.sqrt(w)
    keep = np.ones(len(f), bool)
    for _ in range(3):                                  # clip 4 sigma outliers
        p, *_ = np.linalg.lstsq(X[keep] * sw[keep, None], f[keep] * sw[keep], rcond=None)
        r = (f - X @ p) * sw
        new = np.abs(r) < 4 * max(1.0, BL.robust_sigma(r[keep]))
        if (new == keep).all() or new.sum() < X.shape[1] + 1:
            break
        keep = new
    Xk = X[keep] * sw[keep, None]
    cov = np.linalg.pinv(Xk.T @ Xk)
    chi = float(np.sum(((f[keep] - X[keep] @ p) * sw[keep]) ** 2)) / max(keep.sum() - X.shape[1], 1)
    sc = math.sqrt(max(chi, 1.0))
    out = {}
    for k, s in enumerate(present):
        n = int(((sea == s) & keep).sum())
        out[s] = (float(p[k]), float(math.sqrt(max(cov[k, k], 0)) * sc), n)
    return out


def _saturated(ctx, z, zones):
    """Annulus photometry of the saturated stars: {(star index, detector): levels}."""
    out, srcs = {}, []
    motion = []
    for name, recs in ctx.shared.get("records", {}).items():
        for c in recs:
            if c.get("kind") == "motion" and c.get("motion") and c["motion"]["speed_arcsec_yr"] > 0.5:
                motion.append((c["ra"], c["dec"]))
    for k, (ra, dec, core, rad) in enumerate(zones):
        note = ""
        if any(SC.sep_arcsec(ra, dec, r, d) < core + 15 for r, d in motion):
            note = "moving star: annulus changes with the motion (not used)"
        srcs.append((ra, dec, note))
        if note:
            continue
        per = {}
        for i, e in enumerate(ctx.exps):
            px = e["_px"]
            x, y = (float(v) for v in px["wcs"].all_world2pix(ra, dec, 0))
            ny, nx = px["clean"].shape
            if not (8 <= x < nx - 8 and 8 <= y < ny - 8):
                continue
            per.setdefault(e["detector"], []).append((i, x, y))
        for d, lst in per.items():
            radii = [BL.saturated_radius(ctx.exps[i]["_px"], x, y) for i, x, y in lst]
            if max(radii) == 0:
                continue
            r_in = max(2.0, math.ceil(np.percentile(radii, 90)) + 1.0)
            r_out = r_in + 3.0
            vals, errs, lam, sea = [], [], [], []
            for (i, x, y), r0 in zip(lst, radii):
                if r0 > r_in - 0.5:
                    continue
                px = ctx.exps[i]["_px"]
                yy, xx = np.mgrid[:px["clean"].shape[0], :px["clean"].shape[1]]
                rr = np.hypot(xx - x, yy - y)
                ann = (rr >= r_in) & (rr < r_out)
                m = ann & px["good"]
                if m.sum() < 0.5 * ann.sum():
                    continue
                v = float(np.mean(px["clean"][m])) / z[i]
                ev = float(math.sqrt(np.sum(px["var"][m])) / m.sum()) / z[i]
                vals.append(v)
                errs.append(ev)
                lam.append(ctx.exps[i]["wavelength_um"])
                sea.append(ctx.exps[i]["epoch"])
            if len(vals) >= 2 * MIN_EXP_SEASON:
                # wing photometry is noisier than its formal error: 5 % per exposure floor
                e_ = np.sqrt(np.array(errs) ** 2 + (0.05 * np.abs(np.array(vals))) ** 2)
                out[(k, d)] = _fit_levels(np.array(vals), e_, np.array(lam), np.array(sea), ctx.seasons)
    return out, srcs
