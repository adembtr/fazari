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

(one level per season, one colour slope shared by the seasons). The levels of one detector are
only ever compared with each other (same wavelength range), never across detectors.

Decision (per source and season pair): each detector d gives a fractional change
r_d = (a_s2 - a_s1) / mean level, with variance from the fit plus a per-detector systematic
floor (the season-to-season scatter of all bright sources of the field in that detector, their
statistical errors removed). The detectors are combined by inverse-variance weighting:

    r = sum(w_d r_d) / sum(w_d),   sigma_r = 1 / sqrt(sum(w_d)),   Z = r / sigma_r

A source is a variable candidate when |Z| >= SIG_VAR and |r| >= MIN_FRAC, AND the change does
not rest on one detector: with the most significant detector left out the rest still shows it
at >= SIG_LOO sigma, and >= 2 detectors show the same sign at >= 2 sigma. (A source measured in
a single detector needs two season pairs without a common season instead: one season x detector
level alone is never enough.) Levels are compared at matched wavelengths: a season enters a
detector's comparison only if its exposures sample >= MIN_LAM_COVER of the wavelength range that
detector sampled over all seasons (no extrapolation of the colour term). Requiring 5 sigma in two single detectors,
as before, wasted most of the information: six detectors of ~18 exposures each see a 5-10 %
change of an AB 16 source at only ~2-4 sigma each, but at 5-10 sigma together.
A change seen only between opposite telescope orientations (when a same-orientation pair
exists and does not show it) is rejected (ghosts and stray light follow the orientation).

Unresolved pairs: catalogue entries closer than PAIR_ARCSEC (half a pixel) are one source for
SPHEREx; the brighter entry carries the record ("unresolved pair" flag), the other is skipped.
A neighbour between PAIR_ARCSEC and BLEND_ARCSEC with >= 30 % of the flux makes the record an
artifact (blended: its light leaks into the fit by an amount that depends on the pointing).

Colour changes: the combined change assumes that all detectors move in the same direction. A
source whose colour changes (dust clearing or forming, a temperature change: RW Aur brightened
by 30-50 % at 0.75-1.6 um while it faded by 50 % at 4-5 um) cancels in it. Such a source is a
variable candidate as well when >= MIN_DET_COLOUR detectors changed by >= SIG_VAR each on their
own between the same two seasons, with both signs present ("rule": "colour change" in the
record). Two detectors at 5 sigma each are the "does not rest on one detector" condition.
"""
import math

import numpy as np

import blink as BL
from . import data as Dt
from . import deep_astrom
from . import reject as RJ
from . import schema as SC

NAME = "V"
SIG_VAR = 5.0               # combined significance (all detectors) of a season-to-season change
SIG_LOO = 3.0               # ... and with the most significant detector left out
SIG_DET = 2.0               # a detector "agrees" when it shows the same sign at this significance
MIN_FRAC = 0.03             # smallest fractional change reported
MIN_DET_COLOUR = 2          # detectors that must each show a >= SIG_VAR change for a colour change (both signs present)
FLOOR_MIN_SNR = 30.0        # sources used for the per-detector systematic floor
FLOOR_DEFAULT = 0.02
EXP_FLOOR = 0.02            # per-exposure fractional photometric floor
ZP_MIN_SNR = 30.0
ZP_MIN_N = 5
MIN_EXP_SEASON = 3
MIN_LAM_COVER = 0.5         # a season must sample this fraction of the detector's wavelength range (see _fit_levels)
BLEND_ARCSEC = 8.0
PAIR_ARCSEC = 3.1           # half a native pixel: list entries this close are one unresolved source


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
    # systematic floor per detector: the excess of the season-to-season scatter of the bright
    # unsaturated sources over their statistical errors (robust: real variables do not set it)
    floor, pooled = {}, []
    per = {}
    for (j, dd), L in levels.items():
        ss = [s for s in seasons if s in L and L[s][2] >= MIN_EXP_SEASON]
        for a_, b_ in zip(ss[:-1], ss[1:]):
            a1, e1, _ = L[a_]
            a2, e2, _ = L[b_]
            if a1 > 0 and a2 > 0 and a1 / e1 > FLOOR_MIN_SNR and a2 / e2 > FLOOR_MIN_SNR:
                per.setdefault(dd, []).append((a2 / a1 - 1, (e1 / a1) ** 2 + (e2 / a2) ** 2))
    for d in np.unique(dets):
        pooled += per.get(d, [])
    f_all = _excess_floor(pooled) if len(pooled) >= 8 else FLOOR_DEFAULT
    for d in np.unique(dets):
        fr = per.get(d, [])
        floor[d] = round(_excess_floor(fr), 4) if len(fr) >= 8 else round(max(f_all, 0.01), 4)
    info["season_floor_frac"] = {str(k): v for k, v in floor.items()}
    info["n_floor_pairs"] = {str(d): len(per.get(d, [])) for d in np.unique(dets)}
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
    counts = {"tested": 0, "variable": 0, "appearing_disappearing": 0, "rejected": 0}
    keys = {}
    for key, L in allv.items():
        keys.setdefault(key[:-1], {})[key[-1]] = L
    for skey, per_det in keys.items():
        counts["tested"] += 1
        rows = []
        for d, L in per_det.items():
            ss = [s for s in seasons if s in L and L[s][2] >= MIN_EXP_SEASON]
            for i1 in range(len(ss)):
                for i2 in range(i1 + 1, len(ss)):
                    a1, e1, n1 = L[ss[i1]]
                    a2, e2, n2 = L[ss[i2]]
                    ref = max(abs(a1), abs(a2), 1e-30)
                    fl = floor.get(d, FLOOR_DEFAULT) * ref
                    err = math.sqrt(e1 ** 2 + e2 ** 2 + 2 * fl ** 2)
                    sig = (a2 - a1) / err
                    frac = a2 / a1 - 1 if a1 > 3 * e1 else float("inf") if a2 > 0 else float("nan")
                    same = Dt.same_orientation(sinfo[ss[i1]]["orient_deg"], sinfo[ss[i2]]["orient_deg"])
                    rows.append({"detector": d, "from": ss[i1], "to": ss[i2], "same_orientation": same,
                                 "flux_ujy": [round(a1 * BL.PIXEL_UJY, 1), round(a2 * BL.PIXEL_UJY, 1)],
                                 "err_ujy": [round(e1 * BL.PIXEL_UJY, 1), round(e2 * BL.PIXEL_UJY, 1)],
                                 "change_frac": None if not np.isfinite(frac) else round(frac, 4), "sigma": round(sig, 1)})
        comb = combined_changes(per_det, seasons, floor, sinfo)
        if not comb:
            continue
        single = max(c["n_detectors"] for c in comb) < 2
        grey = [c for c in comb if abs(c["sigma"]) >= SIG_VAR and abs(c["change"]) >= MIN_FRAC and
                (c["n_detectors"] < 2 or (c["sigma_without_best_detector"] >= SIG_LOO and c["n_detectors_agree"] >= 2))]
        # a colour change: >= MIN_DET_COLOUR detectors changed by >= SIG_VAR each in the same season pair,
        # in both directions (dust, temperature); the combined change of such a source is small
        colour = [c for c in comb if c["n_detectors_5sigma"] >= MIN_DET_COLOUR and c["brighter_in"] and c["fainter_in"]
                  and not any(c is g for g in grey)]
        hits = grey + colour
        if not hits:
            continue
        if single:
            # one detector only: a change that rests on one season x detector level cannot be told
            # from one bad level; two season pairs without a common season are needed (>= 4 seasons)
            pairs = [(h["from"], h["to"]) for h in hits]
            if not any(not (set(a) & set(b)) for i, a in enumerate(pairs) for b in pairs[i + 1:]):
                counts["single_detector_unconfirmed"] = counts.get("single_detector_unconfirmed", 0) + 1
                continue
        flags0 = []
        cls0 = None
        same_avail = any(c["same_orientation"] for c in comb)
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
            with np.errstate(all="ignore"):
                nbf = np.nanmax(T["flux"], 0)
            # entries closer than half a pixel are ONE unresolved source for a 6.15" pixel (they are not
            # subtracted from each other, measure.NB_MIN_SEP: each sees the common light). The
            # brighter entry carries the record; the change is that of the combined light.
            nbf0 = np.nan_to_num(nbf)
            pair = (dd > 0.05) & (dd <= PAIR_ARCSEC)
            if (pair & ((nbf0 > fl_j) | ((nbf0 == fl_j) & (np.arange(src.n) < j)))).any():
                counts["second_entry_of_unresolved_pair"] = counts.get("second_entry_of_unresolved_pair", 0) + 1
                continue
            if pair.any():
                flags0.append(f"unresolved pair: {int(pair.sum()) + 1} catalogue entries within half a pixel, the change "
                              "is that of their combined light")
            blend = (dd > PAIR_ARCSEC) & (dd < BLEND_ARCSEC) & (nbf0 > 0.3 * max(fl_j, 0))
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
        hs = [h for h in hits if h["same_orientation"]] or hits       # the pair a ghost cannot fake comes first
        gs = [h for h in hs if any(h is g for g in grey)]
        is_colour = not gs
        best = max(gs, key=lambda h: abs(h["sigma"])) if gs else \
            max(hs, key=lambda h: abs(h["strongest_detector"]["sigma"]))
        kind, cls = "variable", "variable"
        if best["absent_in"] and not is_colour:
            kind = "appearing" if best["sigma"] > 0 else "disappearing"
            cls = "candidate"
        flags = flags0 + flags
        if cls0 == "artifact":
            cls = "artifact"
            counts["rejected"] += 1
        elif kind == "variable":
            counts["variable"] += 1
        else:
            counts["appearing_disappearing"] += 1
        c = SC.new_candidate(NAME, kind, ra, dec, 2026.0, cls=cls, snr=sn,
                             bins=sorted({d for h in hits for d in h["detectors"]}),
                             season_pairs=sorted([list(p) for p in {(h["from"], h["to"]) for h in hits}]), flags=flags)
        c["brightness"] = {"max_change_frac": best["change_frac"], "max_sigma": best["sigma"], "changes": rows,
                           "combined": comb,
                           "method": "detectors combined by inverse-variance weighting of their fractional changes; "
                                     "confirmed with the most significant detector left out"}
        if is_colour:
            sd = best["strongest_detector"]
            c["brightness"].update(
                max_change_frac=sd["change_frac"] if sd["change_frac"] is not None else sd["change"],
                max_sigma=sd["sigma"], rule="colour change",
                colour_change={"from": best["from"], "to": best["to"], "same_orientation": best["same_orientation"],
                               "brighter_in": best["brighter_in"], "fainter_in": best["fainter_in"]},
                method=f"colour change: {best['n_detectors_5sigma']} detectors changed by >= {SIG_VAR:g} sigma each "
                       "between the same two seasons, in opposite directions (the combined change of all "
                       "detectors is small for such a source)")
            c["flags"].append("colour change: brighter in " + ", ".join(best["brighter_in"]) + "; fainter in "
                              + ", ".join(best["fainter_in"]))
        else:
            c["brightness"]["rule"] = "all detectors together"
        if skey[0] != "sat" and skey[0] < ng and ctx.gaia is not None:
            c["match"]["gaia_dr3"] = {"source_id": str(ctx.gaia.sid[skey[0]]), "G": round(float(ctx.gaia.G[skey[0]]), 2)}
        cands.append(c)
    info.update(counts=counts, thresholds={"sigma": SIG_VAR, "sigma_without_best_detector": SIG_LOO,
                                           "detector_agree_sigma": SIG_DET, "min_frac": MIN_FRAC, "exp_floor": EXP_FLOOR})
    ctx.info[NAME] = info
    ctx.log(f"  V: {counts}; season floors {floor}")
    return cands


def _excess_floor(pairs):
    """Fractional floor f (per season level) that makes the season-to-season changes z of bright
    sources scatter as sqrt(their statistical variance + 2 f^2): pairs = [(z, var_stat), ...]."""
    z = np.array([p[0] for p in pairs], float)
    v = np.array([p[1] for p in pairs], float)
    z = z - np.median(z)

    def spread(f):
        return BL.robust_sigma(z / np.sqrt(v + 2 * f * f))
    if not np.isfinite(spread(0.0)) or spread(0.0) <= 1.0:
        return 0.003
    lo, hi = 0.0, 0.5
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if spread(mid) > 1.0:
            lo = mid
        else:
            hi = mid
    return float(max(hi, 0.003))


def combined_changes(per_det, seasons, floor, sinfo):
    """Season-to-season changes of one source with its detectors combined.
    per_det: {detector: {season: (level, error, n)}}. Returns one dict per season pair:
      from, to, same_orientation, change (fraction of the mean level), err, sigma,
      change_frac (level_to / level_from - 1, None when the source is absent in 'from'),
      n_detectors, n_detectors_agree, sigma_without_best_detector, detectors, absent_in."""
    use = {}
    for d, L in per_det.items():
        ss = [s for s in seasons if s in L and L[s][2] >= MIN_EXP_SEASON and np.isfinite(L[s][0]) and L[s][1] > 0]
        if len(ss) < 2:
            continue
        a = np.array([L[s][0] for s in ss])
        e = np.array([L[s][1] for s in ss])
        w = 1 / e ** 2
        m = float(np.sum(w * a) / np.sum(w))
        if m <= 0 or m * math.sqrt(np.sum(w)) < 5:
            continue                                # the detector does not detect the source
        use[d] = (m, {s: (L[s][0] / m, L[s][1] / m) for s in ss}, floor.get(d, FLOOR_DEFAULT))
    out = []
    for i1 in range(len(seasons)):
        for i2 in range(i1 + 1, len(seasons)):
            s1, s2 = seasons[i1], seasons[i2]
            ds = [d for d in use if s1 in use[d][1] and s2 in use[d][1]]
            if not ds:
                continue
            r = np.array([use[d][1][s2][0] - use[d][1][s1][0] for d in ds])
            v = np.array([use[d][1][s1][1] ** 2 + use[d][1][s2][1] ** 2 + 2 * use[d][2] ** 2 for d in ds])
            w = 1 / v
            rr, sr = float(np.sum(w * r) / np.sum(w)), float(1 / math.sqrt(np.sum(w)))
            z = rr / sr
            zd = r / np.sqrt(v)
            agree = int(np.sum(np.sign(rr) * zd >= SIG_DET))
            if len(ds) >= 2:
                k = int(np.argmax(np.sign(rr) * zd))            # the detector that carries most of it
                keep = np.arange(len(ds)) != k
                loo = float(np.sign(rr) * np.sum(w[keep] * r[keep]) / math.sqrt(np.sum(w[keep])))
            else:
                loo = 0.0
            # combined levels of the two seasons (same weights) and whether the source is absent in one
            l1 = float(np.sum(w * np.array([use[d][1][s1][0] for d in ds])) / np.sum(w))
            l2 = float(np.sum(w * np.array([use[d][1][s2][0] for d in ds])) / np.sum(w))
            e1 = float(math.sqrt(np.sum(w ** 2 * np.array([use[d][1][s1][1] ** 2 for d in ds]))) / np.sum(w))
            e2 = float(math.sqrt(np.sum(w ** 2 * np.array([use[d][1][s2][1] ** 2 for d in ds]))) / np.sum(w))
            absent = s1 if l1 < 3 * e1 else s2 if l2 < 3 * e2 else None
            # detectors that changed on their own (>= SIG_VAR each): a colour change moves the blue and
            # the red detectors in opposite directions and cancels in the combined change
            own = (np.abs(zd) >= SIG_VAR) & (np.abs(r) >= MIN_FRAC)
            kb = int(np.argmax(np.abs(zd)))
            out.append({"from": s1, "to": s2,
                        "same_orientation": Dt.same_orientation(sinfo[s1]["orient_deg"], sinfo[s2]["orient_deg"]),
                        "change": round(rr, 4), "err": round(sr, 4), "sigma": round(z, 1),
                        "change_frac": round(l2 / l1 - 1, 4) if l1 > 3 * e1 else None,
                        "n_detectors": len(ds), "n_detectors_agree": agree,
                        "sigma_without_best_detector": round(loo, 1), "detectors": sorted(str(d) for d in ds),
                        "absent_in": absent,
                        "n_detectors_5sigma": int(own.sum()),
                        "brighter_in": sorted(str(d) for d, o, q in zip(ds, own, zd) if o and q > 0),
                        "fainter_in": sorted(str(d) for d, o, q in zip(ds, own, zd) if o and q < 0),
                        "strongest_detector": {"detector": str(ds[kb]), "change": round(float(r[kb]), 4),
                                               "change_frac": _frac(use[ds[kb]][1][s1], use[ds[kb]][1][s2]),
                                               "sigma": round(float(zd[kb]), 1)}})
    return out


def _frac(a, b):
    """level_to / level_from - 1 of two (level, error) pairs; None when 'from' is not detected."""
    return round(b[0] / a[0] - 1, 4) if a[0] > 3 * a[1] else None


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
    span = float(np.ptp(lam[np.isfinite(lam)])) if np.isfinite(lam).any() else 0.0
    for k, s in enumerate(present):
        m = (sea == s) & keep
        n = int(m.sum())
        # wavelength coverage: a level is the flux at the mean wavelength of ALL seasons. A season
        # that sampled only a small part of the detector's wavelength range (a season that has just
        # begun, a source near the field edge) gets there by extrapolating the colour term, which
        # is wrong for any spectrum that is not a straight line (seen: three exposures of a new
        # season made a G = 16 star "disappear"). Such a season has no level in this detector.
        if span > 0.01 and n and np.isfinite(lam[m]).any() and float(np.ptp(lam[m][np.isfinite(lam[m])])) < MIN_LAM_COVER * span:
            continue
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
