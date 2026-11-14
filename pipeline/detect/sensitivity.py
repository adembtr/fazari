"""Per-field sensitivity card: what this field's own data can detect.

Written into candidates.json as "sensitivity". It is a fast estimate from the field's own noise,
depth, number of exposures and season layout (no injection run per click), calibrated with the
injection tests (pipeline/DETECTION.md):

  motion, astrometric path (B/D): per-season position error of a source of flux F
      sigma_season(F) = c_theta * sigma_F / F  (+) floor_season
  (c_theta: position error x season S/N of the field's sources; sigma_F: season flux noise;
  floor_season: systematic per season, from the Gaia reference stars), the proper-motion error
  of a straight-line fit through the field's seasons, and the speed found at >= 99 % in the
  injection tests: v_min = K_MOTION x sigma_pm.
  motion, difference images (A): fast movers (shift >= 1 PSF FWHM between same-orientation
  seasons) down to the 5 sigma depth of the single-season wavelength-bin stacks (+ K_DEPTH mag).
  brightness (V): fractional change >= K_BRIGHT x sqrt(2) x (sigma_level / F (+) floor).
"""
import math

import numpy as np

import blink as BL
from . import data as Dt

# calibration against the injection tests (99 % completeness / the 5 sigma estimate); see
# pipeline/DETECTION.md, "Injection tests". Updated from the test results.
K_MOTION = 1.0
K_BRIGHT = 1.0
K_DEPTH = 0.0
MAGS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]


def card(ctx):
    out = {"n_exposures": len(ctx.exps), "n_seasons": len(ctx.seasons)}
    si = ctx.season_info
    t = np.array([si[s]["jyear"] for s in ctx.seasons])
    out["span_yr"] = round(float(t.max() - t.min()), 3) if len(t) else 0.0
    out["same_orientation_pair"] = bool(ctx.shared.get("A_same_pairs"))
    if len(t) < 2:
        out["text"] = "Only one season: no motion or brightness change can be measured here."
        return out
    G = 1 / math.sqrt(np.sum((t - t.mean()) ** 2))          # pm error per unit season error
    rows = []
    fm = ctx.shared.get("field_measure")
    floor = ctx.season_floor or 0.02
    if fm:
        A, T = fm
        snr = T["snr"]
        e = np.sqrt((T["eE"] ** 2 + T["eN"] ** 2) / 2)
        fl = T["flux"] * BL.PIXEL_UJY
        m = np.isfinite(e) & (snr >= 10) & (snr <= 200) & np.isfinite(fl) & (fl > 0)
        if m.sum() >= 10:
            # remove the floor before measuring the statistical part
            stat = np.sqrt(np.clip(e[m] ** 2 - floor ** 2, 1e-8, None))
            c_theta = float(np.median(stat * snr[m]))
            sig_f = float(np.median(fl[m] / snr[m]))             # season flux noise (uJy)
            out["astrometry_model"] = {"c_theta_arcsec": round(c_theta, 3), "season_flux_noise_ujy": round(sig_f, 2),
                                       "season_floor_arcsec": round(floor, 4), "n_sources": int(m.sum())}
            for mag in MAGS:
                F = 10 ** ((23.9 - mag) / 2.5)
                s_season = math.hypot(c_theta * sig_f / F, floor)
                s_pm = s_season * G
                rows.append({"mag_ab": mag, "flux_ujy": round(F, 1), "season_snr": round(F / sig_f, 1),
                             "season_pos_err_arcsec": round(s_season, 4), "pm_err_arcsec_yr": round(s_pm, 4),
                             "min_speed_arcsec_yr": round(K_MOTION * 5 * s_pm, 3) if F / sig_f >= 10 else None})
    out["motion"] = rows
    # difference-image depth per bin (5 sigma, single season)
    depth = {}
    for (u, s), st in (ctx.shared.get("A_stacks") or {}).items():
        from .diffimg import unit_dets
        sig = Dt.grid_psf_sigma(max(int(d[1:]) for d in unit_dets(u)))
        iv = np.where(np.isfinite(st["var"]) & (st["var"] > 0), 1 / st["var"], 0)
        from scipy.ndimage import gaussian_filter
        den = gaussian_filter(iv, sig / math.sqrt(2)) / (4 * math.pi * sig ** 2)
        good = den > 0.5 * np.max(den)
        if good.any():
            eF = float(np.median(1 / np.sqrt(den[good])))
            # stacks are confusion- and resampling-correlated: scale by the empirical noise (x 1.5 typical)
            f5 = 5 * 1.5 * eF * (Dt.STACK_PIX / BL.PIX_NATIVE) ** 2 * BL.PIXEL_UJY
            depth.setdefault(u, []).append(23.9 - 2.5 * math.log10(f5) + K_DEPTH)
    out["diff_depth_ab_5sigma"] = {u: round(float(np.median(v)), 2) for u, v in sorted(depth.items())}
    # brightness
    vn = ctx.shared.get("V_noise") or {}
    brows = []
    for mag in MAGS:
        F = 10 ** ((23.9 - mag) / 2.5)
        best = None
        for d, (s1_ujy, n, fl) in vn.items():
            if not s1_ujy or not n:
                continue
            frac = math.sqrt(2) * math.hypot(s1_ujy / math.sqrt(n) / F, fl)
            if best is None or frac < best[0]:
                best = (frac, d)
        if best:
            brows.append({"mag_ab": mag, "min_change_frac": round(K_BRIGHT * 5 * best[0], 3), "detector": best[1]})
    out["brightness"] = brows
    out["text"] = _text(out)
    out["calibration"] = {"K_MOTION": K_MOTION, "K_BRIGHT": K_BRIGHT, "K_DEPTH": K_DEPTH,
                          "note": "factors from the injection tests, pipeline/DETECTION.md"}
    return out


def _text(c):
    parts = []
    mo = [r for r in c.get("motion", []) if r.get("min_speed_arcsec_yr")]
    if mo:
        def at(mag):
            r = next((r for r in mo if r["mag_ab"] == mag), None)
            return r["min_speed_arcsec_yr"] if r else None
        bright = min(mo, key=lambda r: r["min_speed_arcsec_yr"])
        faint = max(mo, key=lambda r: r["mag_ab"])
        parts.append(f"Motion: >= {bright['min_speed_arcsec_yr']:.2f}\"/yr for sources brighter than AB "
                     f"{max(r['mag_ab'] for r in mo if r['min_speed_arcsec_yr'] <= 1.5 * bright['min_speed_arcsec_yr'])}, "
                     f">= {faint['min_speed_arcsec_yr']:.2f}\"/yr at AB {faint['mag_ab']}")
    dep = c.get("diff_depth_ab_5sigma") or {}
    if dep:
        parts.append(f"fast movers (shift > 10\" between same-orientation seasons) to AB ~{max(dep.values()):.1f}")
    br = c.get("brightness") or []
    if br:
        ok = [r for r in br if r["min_change_frac"] <= 0.5]
        if ok:
            b0 = min(br, key=lambda r: r["min_change_frac"])
            lim = max(ok, key=lambda r: r["mag_ab"])
            parts.append(f"Brightness changes: >= {100 * b0['min_change_frac']:.0f} % for sources brighter than AB "
                         f"{max(r['mag_ab'] for r in br if r['min_change_frac'] <= 1.5 * b0['min_change_frac'])}, "
                         f">= 50 % to AB {lim['mag_ab']}")
    return "; ".join(parts) + f" ({c['n_seasons']} seasons over {c['span_yr']:.2f} yr, {c['n_exposures']} exposures)."
