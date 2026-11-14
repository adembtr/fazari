"""Detector C: fast movers within a season (asteroids, other transients).

Every exposure is compared with the median of the other exposures of the same detector and
season (all on the common stack grid, Gaia-registered). A source that is in this exposure but
not in the season median is a transient:

    R = I_k - median,   V = V_k + 1.57 x median(V)/N + (MODEL_C x median brightness)^2

MODEL_C absorbs the flux changes of static stars between exposures (each exposure samples a
different wavelength across the linear variable filter, so a star's flux changes with its
colour). Peaks of the matched-filtered R above SIG_C are re-fitted in the exposure's native
pixels with the EPSF (PSF-shaped, not a single hot pixel or cosmic ray).

Detections in the same visit (the six detectors observe at once: D1+D4, D2+D5, D3+D6 see the
same sky; a visit also has 2-4 consecutive exposures a couple of minutes apart) are linked
when their positions agree within LINK_ARCSEC (an asteroid moves < 1"/min). An object seen in
>= 2 exposures of a visit, or once at >= SIG_SINGLE, is a transient candidate; it is then
checked against IMCCE SkyBoT (sso.py) at its time and becomes 'asteroid-known' when matched.
"""
import math

import numpy as np
from scipy.ndimage import gaussian_filter

from . import data as Dt
from . import imgproc as IP
from . import measure as M
from . import schema as SC

NAME = "C"
SIG_C = 5.5
SIG_SINGLE = 7.0
MODEL_C = 0.15
MIN_GROUP = 5               # exposures per detector and season to form a median
LINK_ARCSEC = 12.0
EDGE_PX = 6
MAX_PER_EXPOSURE = 20       # more peaks than this in one exposure = bad exposure (skipped)


def run(ctx):
    g = ctx.grid
    det_list = []                                   # all detections
    info = {"name": "single-exposure transients within a season", "n_exposures": 0, "n_skipped_bad": 0}
    groups = {}
    for e in ctx.exps:
        groups.setdefault((e["detector"], e["epoch"]), []).append(e)
    for (det, s), ex in sorted(groups.items()):
        if len(ex) < MIN_GROUP:
            continue
        sig = Dt.grid_psf_sigma(int(det[1]))
        L = [ctx.stacker.layers(e, None if ctx.images is None else ctx.images.get(e["file"])) for e in ex]
        I = np.stack([l[0] for l in L])
        V = np.stack([l[1] for l in L])
        S = np.stack([l[2] for l in L])
        med = np.nanmedian(I, axis=0)
        vmed = np.nanmedian(V, axis=0)
        n = np.isfinite(I).sum(0)
        bright = gaussian_filter(np.nan_to_num(np.clip(med, 0, None)), sig / 2)
        satm = IP.dilate(S.any(0), 2)
        for k, e in enumerate(ex):
            info["n_exposures"] += 1
            R = I[k] - med
            var = V[k] + 1.57 * vmed / np.maximum(n - 1, 1) + (MODEL_C * bright) ** 2
            cover = np.isfinite(R) & np.isfinite(var) & (n >= MIN_GROUP - 1)
            valid = ~IP.dilate(~cover, EDGE_PX) & ~satm
            F, eF, Z = IP.matched(R, var, sig, mask=~valid)
            Zn, scale = IP.normalise(Z, valid)
            pk = IP.peaks(Zn, SIG_C, valid, +1, min_sep=3)
            if len(pk) > MAX_PER_EXPOSURE:
                info["n_skipped_bad"] += 1
                continue
            for x, y, z in pk:
                r, d = g.to_world(x, y)
                ix, iy = int(round(x)), int(round(y))
                # native-pixel EPSF check
                q = M.measure(e, [float(r[0]) + ctx.cal.get(e["file"], (0, 0))[0] / 3600 / math.cos(math.radians(float(d[0])))],
                              [float(d[0]) + ctx.cal.get(e["file"], (0, 0))[1] / 3600],
                              image=None if ctx.images is None else ctx.images.get(e["file"]))
                if not q["ok"][0] or q["snr"][0] < 4 or q["chi2r"][0] > 6 or math.hypot(q["dE"][0], q["dN"][0]) > 6:
                    continue
                static = F[iy, ix]
                det_list.append(dict(file=e["file"], detector=det, season=s, visit=e["visit"], mjd=e["mjd"],
                                     jyear=e["jyear"], ra=float(r[0]) + q["dE"][0] / 3600 / math.cos(math.radians(float(d[0]))),
                                     dec=float(d[0]) + q["dN"][0] / 3600, z=float(z),
                                     flux_ujy=float(IP.stack_flux_ujy(F[iy, ix])), native_snr=float(q["snr"][0]),
                                     x=float(x), y=float(y), static_ujy=float(IP.stack_flux_ujy(np.nan_to_num(static)))))
    # link detections within a visit
    det_list.sort(key=lambda q: (q["visit"], q["mjd"]))
    objs = []
    for q in det_list:
        for o in objs:
            if o[0]["visit"] != q["visit"]:
                continue
            last = o[-1]
            if SC.sep_arcsec(last["ra"], last["dec"], q["ra"], q["dec"]) < LINK_ARCSEC + abs(q["mjd"] - last["mjd"]) * 1440 * 1.0:
                o.append(q)
                break
        else:
            objs.append([q])
    cands = []
    nsingle = 0
    for o in objs:
        best = max(o, key=lambda q: q["z"])
        nexp = len({q["file"] for q in o})
        if nexp < 2 and best["z"] < SIG_SINGLE:
            nsingle += 1
            continue
        flags = [] if nexp >= 2 else ["single exposure"]
        rate = None
        times = sorted({round(q["mjd"], 5) for q in o})
        if len(times) >= 2:
            a, b = o[0], o[-1]
            dtm = (b["mjd"] - a["mjd"]) * 24
            if dtm > 0:
                rate = round(SC.sep_arcsec(a["ra"], a["dec"], b["ra"], b["dec"]) / dtm, 2)
        c = SC.new_candidate(NAME, "transient", best["ra"], best["dec"], round(best["jyear"], 6), cls="candidate",
                             snr=round(best["z"], 1), flux_ujy=round(best["flux_ujy"], 1),
                             bins=sorted({q["detector"] for q in o}), season_pairs=[], flags=flags)
        m = Dt.jy_to_ab(best["flux_ujy"])
        c["mag_ab"] = round(m, 2) if m else None
        c["mjd"] = best["mjd"]
        c["season"] = best["season"]
        c["detections"] = [{"file": q["file"], "detector": q["detector"], "mjd": round(q["mjd"], 6),
                            "ra": q["ra"], "dec": q["dec"], "snr": round(q["z"], 1), "flux_ujy": round(q["flux_ujy"], 1)}
                           for q in o]
        c["rate_arcsec_per_hour"] = rate
        cands.append(c)
    info.update(n_detections=len(det_list), n_objects=len(objs), n_single_low=nsingle, n_candidates=len(cands),
                thresholds={"sigma": SIG_C, "single_sigma": SIG_SINGLE, "model_frac": MODEL_C, "link_arcsec": LINK_ARCSEC})
    ctx.info[NAME] = info
    ctx.log(f"  C: {info['n_exposures']} exposures, {len(det_list)} detections -> {len(cands)} transient candidates "
            f"({nsingle} weak single-exposure detections dropped)")
    return cands
