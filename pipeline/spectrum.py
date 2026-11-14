#!/usr/bin/env python3
"""On-the-fly spectrum of one source from all its SPHEREx exposures (Fazari).

SPHEREx is a linear-variable-filter spectrometer: in each exposure a source is seen at ONE
wavelength (0.75-5 um), the one the filter passes at its pixel. The ~100+ exposures of a
season therefore sample its spectrum. This script measures the source in every exposure:

  - position: the catalogue position moved to the exposure time (blink.target_position:
    proper motion, perspective acceleration, parallax);
  - wavelength and bandwidth at that pixel: spectral WCS 'W' (WCS-WAVE lookup table);
  - flux: forced fit of the SPHEREx empirical PSF (EPSF extension, the entry nearest the
    target on the detector) at the fixed predicted position, flux free, + a constant
    background, with Gaia DR3 field stars / catalogue neighbours near the stamp fitted at
    their fixed positions (same model as blink.py's detection check), on IMAGE - ZODI with
    the FLAGS-masked pixels left out; error from VARIANCE;
  - noise check: the same fit at 24 random positions of each exposure; the robust scatter of
    those S/N values per season x detector (>= 1) scales the errors (noise_scale);
  - flux unit: the MJy/sr image times the solid angle of the pixel at the target (from the
    WCS) -> uJy (the EPSF is normalised to the total flux: two unsaturated field stars agree with
    2MASS J/H/Ks and AllWISE W1/W2 to 0.93-1.06);
    AB magnitude = 23.9 - 2.5 log10(flux / uJy).

Status of each exposure (spectrum.csv column "status"):
  detection       unsaturated, S/N >= 3
  nondetection    unsaturated, S/N < 3: 3-sigma upper limit in upper_limit_ujy
  saturated_wing  saturated core (OVERFLOW or no value within 1.5 px of the position):
                  the PSF fitted to the unsaturated wing pixels only. A rough estimate,
                  labelled "saturated (wing estimate)", never a normal point
  saturated       saturated core and too little unsaturated PSF left: no flux
  flagged         less than half of the PSF falls on usable pixels (unsaturated source), or a
                  bright / saturated source whose fitted centre is > 1 px (6") from the
                  predicted position (a bad exposure WCS; pos_offset_px): flux kept, not used
                  in the binned spectrum
  no_fit          the fit was impossible (too few pixels)
Exposures where the target is outside the image (or < 6 px from its edge) are not listed.
Column "method": psf (normal fit) or psf_wing (EPSF fitted to the unsaturated pixels around a
saturated core); sat_radius_px = radius of the saturated region (the EPSF reaches 3.3 px, so cores
larger than ~3 px get no estimate).

Binned spectrum (spectrum.json "binned"): per season, each detector split into 6 bins equal in
log wavelength; inverse-variance mean of the unsaturated measurements (detections AND
non-detections, so faint sources are not biased up), error inflated by sqrt(chi2r) when the
exposures scatter more than their errors; S/N < 3 -> upper limit. A bin with only saturated
wing estimates gets their median, flagged "saturated_wing".

Usage (from the fazari/ folder):
  uv run --no-project --with astropy --with reproject --with numpy --with scipy \
      --with matplotlib --with pillow python -I pipeline/spectrum.py barnard
  ... pipeline/spectrum.py <id> --target-json '{"name": .., "ra": .., "dec": .., ...}' --data-target barnard
      (a source of your choice, measured in the cutouts of another target)
Inputs: as blink.py (FAZARI_DATA, FAZARI_TARGETS, pipeline/targets*.json); Gaia field stars from
  site/data/<id>/gaia_field.json, <out>/<id>/ or cache/gaia/<id>/ (else fetched once from IRSA TAP
  and cached in <out>/<id>/, or in the gitignored cache/gaia/<id>/ when <out> is site/data).
Outputs: <out>/<id>/spectrum.csv (one row per exposure) and spectrum.json (points, binned
  spectrum, summary); <out> = --out, else env FAZARI_OUT, else site/data. Nothing else is written.
The local engine runs job_step() after blink.py for every full job (local/job_worker.py
POST_STEPS); the browser engine writes the same format (site/js/spectrum.js).
"""
import argparse
import csv
import io
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blink as B                                    # noqa: E402  (helpers and constants)

FORMAT = "fazari-spectrum/1"
SNR_DET = 3.0               # per exposure and per bin: S/N >= 3 is a detection
NSIG_UL = 3.0               # upper limit = max(flux, 0) + 3 sigma
CORE_R = 1.5                # native px: a saturated / NaN pixel this close = saturated core
MIN_PSF_FRAC = 0.5          # unsaturated target: < 50 % of the PSF on usable pixels -> flagged
POS_CHECK_SNR = 20.0        # bright (S/N >= 20) or saturated: free centroid fit as a position check ...
POS_MAX_PX = 1.0            # ... more than 1 native px (6") from the prediction -> flagged (bad WCS)
WING_MIN_FRAC = 0.03        # saturated target: >= 3 % of the PSF on unsaturated pixels for a wing estimate
WING_MIN_PIX = 12
GAIA_NB_ARCSEC = 75.0       # Gaia field stars this close to the target are fitted with it
BINS_PER_DET = 6
DET_RANGES = {"D1": (0.75, 1.09), "D2": (1.10, 1.62), "D3": (1.63, 2.41),
              "D4": (2.42, 3.82), "D5": (3.83, 4.41), "D6": (4.42, 5.00)}
# saturated wing fit: bloomed pixels carry charge spilled from the core
WING_EXTRA_BAD = B.B["BLOOM"]
# pixel defects: a flagged / NaN pixel that is one of these is a bad pixel, not a saturated
# star (dead pixels also carry SUR_ERROR and TRANSIENT)
DEFECT_BITS = B.B["NONFUNC"] | B.B["HOT"] | B.B["COLD"] | B.B["MISSING_DATA"]
STATUS_LABELS = {"detection": "detection (S/N ≥ 3)",
                 "nondetection": "non-detection (3σ upper limit)",
                 "saturated_wing": "saturated (wing estimate)",
                 "saturated": "saturated (no estimate)",
                 "flagged": "flagged (bad pixels or source off its predicted position; not binned)",
                 "no_fit": "no fit"}
COLUMNS = ["season", "date", "mjd", "file", "obs_id", "collection", "detector", "wavelength_um",
           "bandwidth_um", "x_pix", "y_pix", "pos_offset_px", "flux_ujy", "flux_err_ujy", "snr", "ab_mag", "ab_mag_err",
           "upper_limit_ujy", "ab_mag_limit", "status", "method", "saturated", "sat_core_px", "sat_radius_px", "psf_frac_used",
           "n_pix", "chi2r", "noise_scale", "flux_err_var_ujy", "flags_at_target", "flag_names",
           "blended", "pixel_area_arcsec2"]
METHOD = ("Forced fit of the SPHEREx empirical PSF (EPSF extension, nearest entry on the detector) at the "
          "catalogue position moved to each exposure (proper motion, parallax), flux free, constant "
          "background, Gaia DR3 field stars and catalogue neighbours fitted at fixed positions; "
          "11x11 native-pixel stamp of IMAGE - ZODI, FLAGS-masked pixels left out, weights from VARIANCE. "
          "Flux = MJy/sr x pixel solid angle at the target (WCS) -> uJy (total flux of the normalised "
          "EPSF). Errors from VARIANCE x noise_scale (robust S/N scatter of "
          "the same fit at 24 random positions, per season and detector, >= 1). Wavelength and "
          "bandwidth at the target pixel from the spectral WCS (WCS-WAVE). Saturated cores: PSF fitted to "
          "the unsaturated wing pixels only (saturated_wing, a rough estimate).")
FLAG_NAMES = {v: k for k, v in B.B.items()}


def _g(v, n=6):
    """Round to n significant digits for the outputs (None stays None)."""
    if v is None or not np.isfinite(v):
        return None
    return float(f"{v:.{n}g}")


def ab_mag(f):
    return 23.9 - 2.5 * math.log10(f) if f and f > 0 else None


def flag_names(f):
    return "|".join(n for b, n in sorted(FLAG_NAMES.items()) if f >= 0 and f & b)


# ---- measurement ---------------------------------------------------------------------------
def fit_psf(px, x0, y0, nb_xy, R=B.STAMP_R, extra_bad=None):
    """blink.forced_phot with the PSF-coverage diagnostics the spectrum needs and without the
    60 % good-pixel rule (the caller decides): dict(flux, err, chi2r, blended, psf_frac, n_pix)."""
    ix, iy = int(round(x0)), int(round(y0))
    ny, nx = px["clean"].shape
    if not (R <= ix < nx - R and R <= iy < ny - R):
        return None
    sl = (slice(iy - R, iy + R + 1), slice(ix - R, ix + R + 1))
    g = px["good"][sl].ravel().copy()
    if extra_bad is not None:
        g &= ~extra_bad[sl].ravel()
    d = px["clean"][sl].ravel().astype(float)
    w = 1.0 / np.sqrt(px["var"][sl].ravel().astype(float))
    cols, blended = B.neighbour_columns(px, ix, iy, x0, y0, nb_xy, R)
    k0 = B.epsf_kernels(px, x0 - ix, y0 - iy, R)[0]
    cols.insert(0, k0)
    A = np.stack(cols, 1)[g] * w[g, None]
    b = d[g] * w[g]
    if len(b) < A.shape[1] + 3:
        return None
    try:
        p, *_ = np.linalg.lstsq(A, b, rcond=None)
        cov = np.linalg.pinv(A.T @ A)
    except np.linalg.LinAlgError:
        return None
    dof = max(len(b) - A.shape[1], 1)
    return dict(flux=float(p[0]), err=float(math.sqrt(max(cov[0, 0], 0))),
                chi2r=float(np.sum((b - A @ p) ** 2) / dof), blended=blended,
                psf_frac=float(k0[g].sum()), n_pix=int(g.sum()))


def pixel_area(wcs, x, y):
    """Solid angle of the native pixel at (x, y), arcsec^2 (WCS Jacobian)."""
    r0, d0 = (float(v) for v in wcs.all_pix2world(x, y, 0))
    r1, d1 = (float(v) for v in wcs.all_pix2world(x + 1, y, 0))
    r2, d2 = (float(v) for v in wcs.all_pix2world(x, y + 1, 0))
    jx, jy = B.offset_arcsec(r0, d0, r1, d1)[:2], B.offset_arcsec(r0, d0, r2, d2)[:2]
    return abs(jx[0] * jy[1] - jx[1] * jy[0])


def read_exposure(path, t):
    """What the spectrum needs from one cutout (no reprojection, no centroid): predicted pixel,
    wavelength, cleaned stamp layers. Returns an info dict (blink-style, with '_px') or None."""
    from astropy.io import fits
    from astropy.time import Time
    from astropy.wcs import WCS
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        wcs = WCS(hd)
        mjd = float(hd.get("MJD-AVG", hd["MJD-OBS"]))
        ra, dec = B.target_position(t, mjd)
        x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
        img = h["IMAGE"].data
        ny, nx = img.shape
        inside = B.EDGE_PX <= x <= nx - 1 - B.EDGE_PX and B.EDGE_PX <= y <= ny - 1 - B.EDGE_PX
        info = dict(file=path.name, mjd=mjd, date=Time(mjd, format="mjd").iso[:10],
                    detector=f"D{int(hd['DETECTOR'])}", x=x, y=y, inside=inside, ra_pred=ra, dec_pred=dec)
        if not inside:
            return info
        swcs = WCS(hd, fobj=h, key="W")
        swcs.sip = None
        lam, bw = (float(v) for v in swcs.pixel_to_world_values(x, y))
        img = img.astype(np.float64)
        flg = h["FLAGS"].data.astype(np.int64)
        var = h["VARIANCE"].data.astype(np.float64)
        zodi = h["ZODI"].data.astype(np.float64)
        epsf_tab = h["EPSF"].data
        ovs = int(h["EPSF"].header.get("OVSMPX", 5))
        det_off = (1 - hd.get("CRPIX1A", 1.0), 1 - hd.get("CRPIX2A", 1.0))
        k = int(np.argmin((epsf_tab["XCENTER"] - (x + det_off[0])) ** 2 + (epsf_tab["YCENTER"] - (y + det_off[1])) ** 2))
        psf = B.prep_psf(np.asarray(epsf_tab["EPSF"][k], float))
    ix, iy = int(round(x)), int(round(y))
    f_at = int(flg[iy, ix])
    sat = (flg & B.SAT_BITS) != 0
    bad = ((flg & B.BAD_BITS) != 0) & ~sat
    clean = img - zodi                                  # zodiacal light model removed
    clean[bad] = np.nan
    good = ~bad & ~sat & np.isfinite(clean) & np.isfinite(var) & (var > 0)
    satnan = sat | ~np.isfinite(img)
    yy, xx = np.mgrid[:ny, :nx]
    core = np.hypot(xx - x, yy - y) <= CORE_R
    # saturated core = OVERFLOW (or no value) within CORE_R. SUR_ERROR / NONLINEAR alone are not
    # enough: they also mark cosmic-ray hits and slightly non-linear pixels of unsaturated
    # sources (those pixels are still left out of the fit, as in blink.py)
    over = ((flg & B.B["OVERFLOW"]) != 0) | ~np.isfinite(img)
    satcore = over & core & ((flg & DEFECT_BITS) == 0)
    unusable = satnan & ((flg & DEFECT_BITS) == 0)     # saturated / non-linear / no value: radius
    info.update(wavelength_um=lam, bandwidth_um=bw, flags_at_target=f_at,
                sat_core_px=int(satcore.sum()), pixel_area_arcsec2=pixel_area(wcs, x, y))
    info["saturated"] = bool(info["sat_core_px"] > 0)
    info["_px"] = dict(clean=clean.astype(np.float32), var=np.where(good, var, np.inf).astype(np.float32),
                       good=good, satnan=satnan, wcs=wcs, psf=psf, ovs=ovs, path=path,
                       bloom=(flg & WING_EXTRA_BAD) != 0, over=unusable)
    return info


def saturated_radius(px, x, y):
    """Radius (native px) of the saturated core around (x, y): the connected region of saturated /
    non-linear / no-value pixels touching the core (blink.saturated_radius without defect pixels)."""
    from scipy.ndimage import label
    m = px["over"]
    ny, nx = m.shape
    yy, xx = np.mgrid[:ny, :nx]
    rr = np.hypot(xx - x, yy - y)
    lab, _ = label(m)
    ids = set(np.unique(lab[(rr <= CORE_R) & m])) - {0}
    return float(rr[np.isin(lab, list(ids))].max()) + 0.5 if ids else 0.0


def measure(t, i):
    """Forced photometry of the target in exposure i (info from read_exposure): adds the
    flux columns and the status."""
    px = i["_px"]
    nb = B.neighbour_pixels(t, i)
    to_ujy = 1e12 * i["pixel_area_arcsec2"] / 206264.806 ** 2      # MJy/sr x pixel solid angle -> uJy
    i["to_ujy"] = to_ujy
    method = "psf"
    if i["saturated"]:
        # wing estimate: the EPSF fitted to the unsaturated, unbloomed pixels around the core.
        # The EPSF reaches 3.3 px, so a core larger than ~3 px leaves too little PSF: no estimate.
        # (A radial wing profile from bright unsaturated field stars was tried for those: the
        # cutouts' stars are too faint to calibrate it beyond 5 px; its self-check was off 3-7x.)
        r = fit_psf(px, i["x"], i["y"], nb, extra_bad=px["bloom"])
        i["sat_radius_px"] = saturated_radius(px, i["x"], i["y"])
        method = "psf_wing"
        if r and r["err"] > 0 and r["flux"] > 0 and r["psf_frac"] >= WING_MIN_FRAC and r["n_pix"] >= WING_MIN_PIX:
            status = "saturated_wing"
        else:
            status = "saturated"
    else:
        r = fit_psf(px, i["x"], i["y"], nb)
        if not r or r["err"] <= 0:
            status = "no_fit"
        elif r["psf_frac"] < MIN_PSF_FRAC:
            status = "flagged"
        else:
            status = "measured"                         # detection / nondetection after noise scaling
    # position check: a bright or saturated source must sit at the predicted position; a free
    # centroid fit (blink.centroid, unsaturated wing pixels) more than POS_MAX_PX away means the
    # exposure's WCS (or the catalogue position) is off and the forced flux is meaningless
    if i["saturated"] or (r and r["err"] > 0 and r["flux"] >= POS_CHECK_SNR * r["err"]):
        c = B.centroid(px["clean"], px["var"], px["good"], i["x"], i["y"])
        if c:
            i["pos_offset_px"] = math.hypot(c[0] - i["x"], c[1] - i["y"])
            if i["pos_offset_px"] > POS_MAX_PX and status in ("measured", "saturated_wing"):
                status = "flagged"
    i["status"] = status
    i["method"] = method if status not in ("saturated", "no_fit") else ""
    if r and r["err"] > 0 and status != "saturated":
        i.update(flux_ujy=r["flux"] * to_ujy, flux_err_var_ujy=r["err"] * to_ujy, chi2r=r["chi2r"],
                 blended=r["blended"], psf_frac_used=r["psf_frac"], n_pix=r["n_pix"])
    elif r:
        i.update(psf_frac_used=r["psf_frac"], n_pix=r["n_pix"])
    if not i["saturated"]:
        i["_blank"] = B.blank_snr(i)                    # noise reference (random positions)
    return i


def finish_rows(infos):
    """Noise scale per season x detector, final errors, status, magnitudes."""
    cells = {}
    for i in infos:
        cells.setdefault((i.get("epoch"), i["detector"]), []).extend(i.get("_blank", []))
    for i in infos:
        s = B.robust_sigma(cells.get((i.get("epoch"), i["detector"]), []))
        i["noise_scale"] = max(1.0, s) if np.isfinite(s) else 1.0
        if "flux_ujy" not in i:
            continue
        i["flux_err_ujy"] = i["flux_err_var_ujy"] * i["noise_scale"]
        i["snr"] = i["flux_ujy"] / i["flux_err_ujy"]
        if i["status"] == "measured":
            i["status"] = "detection" if i["snr"] >= SNR_DET else "nondetection"
        if i["status"] == "nondetection":
            i["upper_limit_ujy"] = max(i["flux_ujy"], 0.0) + NSIG_UL * i["flux_err_ujy"]
            i["ab_mag_limit"] = ab_mag(i["upper_limit_ujy"])
        elif i["flux_ujy"] > 0:
            i["ab_mag"] = ab_mag(i["flux_ujy"])
            i["ab_mag_err"] = 1.0857 * i["flux_err_ujy"] / i["flux_ujy"]


# ---- products (same format in site/js/spectrum.js) ------------------------------------------
def det_bins(det):
    lo, hi = DET_RANGES[det]
    e = np.exp(np.linspace(math.log(lo), math.log(hi), BINS_PER_DET + 1))
    return list(zip(e[:-1], e[1:]))


def binned(rows):
    """Per season and wavelength bin (6 per detector, equal in log wavelength)."""
    out = []
    seasons = sorted({r["season"] for r in rows if r["season"]})
    for s in seasons:
        for det in DET_RANGES:
            rs = [r for r in rows if r["season"] == s and r["detector"] == det]
            if not rs:
                continue
            edges = det_bins(det)
            for k, (lo, hi) in enumerate(edges):
                sel = [r for r in rs if (lo <= r["wavelength_um"] < hi) or (k == 0 and r["wavelength_um"] < lo)
                       or (k == len(edges) - 1 and r["wavelength_um"] >= hi)]
                if not sel:
                    continue
                meas = [r for r in sel if r["status"] in ("detection", "nondetection")]
                wing = [r for r in sel if r["status"] == "saturated_wing"]
                e = {"season": s, "detector": det, "lam_lo_um": _g(lo, 4), "lam_hi_um": _g(hi, 4),
                     "n": 0, "n_saturated": sum(r["saturated"] for r in sel)}
                if meas:
                    f = np.array([r["flux_ujy"] for r in meas])
                    w = 1 / np.array([r["flux_err_ujy"] for r in meas]) ** 2
                    m = float(np.sum(w * f) / np.sum(w))
                    err = float(1 / math.sqrt(np.sum(w)))
                    chi = float(np.sum(w * (f - m) ** 2) / (len(f) - 1)) if len(f) > 1 else 1.0
                    err *= math.sqrt(max(1.0, chi))
                    snr = m / err
                    e.update(kind="measured", n=len(meas), wavelength_um=_g(float(np.mean([r["wavelength_um"] for r in meas])), 5),
                             flux_ujy=_g(m), flux_err_ujy=_g(err), snr=_g(snr, 4), chi2r=_g(chi, 4),
                             detected=bool(snr >= SNR_DET))
                    if snr >= SNR_DET:
                        e.update(ab_mag=_g(ab_mag(m), 5), ab_mag_err=_g(1.0857 / snr, 3))
                    else:
                        ul = max(m, 0.0) + NSIG_UL * err
                        e.update(upper_limit_ujy=_g(ul), ab_mag_limit=_g(ab_mag(ul), 5))
                elif wing:
                    f = np.array([r["flux_ujy"] for r in wing])
                    m = float(np.median(f))
                    if len(f) >= 3:
                        err = 1.2533 * B.robust_sigma(f) / math.sqrt(len(f))
                    elif len(f) == 2:
                        err = float(np.std(f, ddof=1)) / math.sqrt(2)
                    else:
                        err = wing[0]["flux_err_ujy"]
                    err = max(err, float(np.median([r["flux_err_ujy"] for r in wing])) / math.sqrt(len(f)))
                    e.update(kind="saturated_wing", n=len(wing),
                             wavelength_um=_g(float(np.mean([r["wavelength_um"] for r in wing])), 5),
                             flux_ujy=_g(m), flux_err_ujy=_g(err), snr=_g(m / err, 4) if err > 0 else None,
                             detected=True, ab_mag=_g(ab_mag(m), 5), ab_mag_err=_g(1.0857 * err / m, 3) if m > 0 else None)
                else:
                    e.update(kind="none", wavelength_um=_g(float(np.mean([r["wavelength_um"] for r in sel])), 5))
                out.append(e)
    return out


def summary(rows, bins, n_outside):
    seasons = sorted({r["season"] for r in rows if r["season"]})
    cnt = lambda rs, st: sum(r["status"] == st for r in rs)       # noqa: E731
    per = []
    for s in seasons:
        rs = [r for r in rows if r["season"] == s]
        per.append({"season": s, "n": len(rs), "n_detection": cnt(rs, "detection"),
                    "n_nondetection": cnt(rs, "nondetection"), "n_saturated": sum(r["saturated"] for r in rs),
                    "n_saturated_wing": cnt(rs, "saturated_wing"), "n_flagged": cnt(rs, "flagged") + cnt(rs, "no_fit"),
                    "lam_min_um": _g(min(r["wavelength_um"] for r in rs), 4),
                    "lam_max_um": _g(max(r["wavelength_um"] for r in rs), 4)})
    det = [b for b in bins if b.get("kind") == "measured" and b.get("detected")]
    sat = [r for r in rows if r["saturated"]]
    sat_det = {}
    for r in rows:
        d = sat_det.setdefault(r["detector"], [0, 0])
        d[0] += 1
        d[1] += bool(r["saturated"])
    return {"n_exposures": len(rows), "n_outside": n_outside, "seasons": per,
            "n_detection": cnt(rows, "detection"), "n_nondetection": cnt(rows, "nondetection"),
            "n_saturated": len(sat), "n_saturated_wing": cnt(rows, "saturated_wing"),
            "n_flagged": cnt(rows, "flagged") + cnt(rows, "no_fit"),
            "saturated_by_detector": {k: {"n": v[0], "saturated": v[1]} for k, v in sorted(sat_det.items())},
            "saturated_range_um": [_g(min(r["wavelength_um"] for r in sat), 4), _g(max(r["wavelength_um"] for r in sat), 4)] if sat else None,
            "detected_range_um": [min(b["lam_lo_um"] for b in det), max(b["lam_hi_um"] for b in det)] if det else None,
            "detected_detectors": sorted({b["detector"] for b in det}),
            "n_bins_detected": len(det), "n_bins_measured": sum(b.get("kind") == "measured" for b in bins)}


def to_row(i):
    """One spectrum.csv row (dict over COLUMNS) from an info dict."""
    sat = bool(i["saturated"])
    return {"season": i.get("epoch", ""), "date": i["date"], "mjd": round(i["mjd"], 6), "file": i["file"],
            "obs_id": i.get("obs_id", ""), "collection": i.get("collection", ""), "detector": i["detector"],
            "wavelength_um": round(i["wavelength_um"], 5), "bandwidth_um": round(i["bandwidth_um"], 5),
            "x_pix": round(i["x"], 3), "y_pix": round(i["y"], 3), "pos_offset_px": _g(i.get("pos_offset_px"), 3),
            "flux_ujy": _g(i.get("flux_ujy")), "flux_err_ujy": _g(i.get("flux_err_ujy")), "snr": _g(i.get("snr"), 4),
            "ab_mag": _g(i.get("ab_mag"), 5), "ab_mag_err": _g(i.get("ab_mag_err"), 3),
            "upper_limit_ujy": _g(i.get("upper_limit_ujy")), "ab_mag_limit": _g(i.get("ab_mag_limit"), 5),
            "status": i["status"], "method": i.get("method", ""), "saturated": sat, "sat_core_px": i["sat_core_px"],
            "sat_radius_px": _g(i.get("sat_radius_px"), 3),
            "psf_frac_used": _g(i.get("psf_frac_used"), 3), "n_pix": i.get("n_pix"), "chi2r": _g(i.get("chi2r"), 4),
            "noise_scale": _g(i.get("noise_scale"), 3), "flux_err_var_ujy": _g(i.get("flux_err_var_ujy")),
            "flags_at_target": i["flags_at_target"], "flag_names": flag_names(i["flags_at_target"]),
            "blended": bool(i.get("blended", False)), "pixel_area_arcsec2": _g(i["pixel_area_arcsec2"], 5)}


def build(t, rows, n_outside, ra_c, dec_c, engine="python", extra=None):
    """spectrum.json content (format FORMAT; site/js/spectrum.js builds the same)."""
    rows = sorted(rows, key=lambda r: (r["season"], r["wavelength_um"], r["mjd"]))
    bins = binned(rows)
    return {"format": FORMAT, "engine": engine, "target": t.get("name"), "ra": ra_c, "dec": dec_c,
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "units": {"flux": "uJy", "wavelength": "um", "ab_mag": "AB = 23.9 - 2.5 log10(flux/uJy)"},
            "seasons": sorted({r["season"] for r in rows if r["season"]}),
            "method": METHOD, "status_labels": STATUS_LABELS,
            "parameters": {"snr_detection": SNR_DET, "upper_limit_sigma": NSIG_UL, "stamp_px": 2 * B.STAMP_R + 1,
                           "position_check_snr": POS_CHECK_SNR, "position_max_offset_px": POS_MAX_PX,
                           "core_radius_px": CORE_R, "min_psf_frac": MIN_PSF_FRAC, "wing_min_psf_frac": WING_MIN_FRAC,
                           "bins_per_detector": BINS_PER_DET, "detector_ranges_um": DET_RANGES},
            "caveats": ["Flux check: two unsaturated Gaia field stars (eps_indi_b cutouts) agree with 2MASS J/H/Ks "
                        "and AllWISE W1/W2 to 0.93-1.06 (mean ratio 1.00).",
                        "Saturated points (saturated_wing) come from the PSF wings only. On unsaturated stars with "
                        "the core masked, the estimate recovers 0.88 +- 0.12 of the flux for a 1.5 px core and "
                        "0.60 +- 0.19 for a 2 px core; larger saturated cores can be off by a factor of 2. They "
                        "are never plotted as normal points.",
                        "Each exposure sees the source through a narrow band (bandwidth_um) at one time: "
                        "a variable source mixes time and wavelength within a season."],
            "summary": summary(rows, bins, n_outside), "columns": COLUMNS, "points": rows, "binned": bins,
            **(extra or {})}


def csv_text(rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator="\n")
    w.writeheader()
    for r in sorted(rows, key=lambda r: (r["season"], r["wavelength_um"], r["mjd"])):
        w.writerow({k: ("" if r.get(k) is None else r[k]) for k in COLUMNS})
    return buf.getvalue()


def write(out_dir, spec):
    """spectrum.csv + spectrum.json (atomic replace; nothing else in out_dir is touched)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, text in (("spectrum.csv", csv_text(spec["points"])), ("spectrum.json", json.dumps(spec, indent=1))):
        tmp = out_dir / (name + ".part")
        tmp.write_text(text)
        os.replace(tmp, out_dir / name)


# ---- driver ----------------------------------------------------------------------------------
def load_gaia(name, ra_c, dec_c, out_root, fetch=True):
    """Gaia DR3 field (blink.gaia_field format) from site/data/<name>/, <out>/<name>/ or the
    gitignored cache/gaia/<name>/; else fetched once from IRSA TAP (blink.gaia_field) and cached
    in <out>/<name>/, or in cache/gaia/<name>/ when <out> is the repository's site/data (where
    this script writes nothing but the spectrum files). None if not available."""
    repo_out = out_root.resolve() == (B.ROOT / "site" / "data").resolve()
    alt = B.ROOT / "cache" / "gaia" / name / "gaia_field.json"
    for p in (B.ROOT / "site" / "data" / name / "gaia_field.json", out_root / name / "gaia_field.json", alt):
        if p.exists():
            return json.loads(p.read_text())
    if not fetch:
        return None
    real_out = B.OUT
    B.OUT = alt.parent.parent if repo_out else out_root     # blink.gaia_field caches in B.OUT/<name>/
    try:
        return B.gaia_field(name, ra_c, dec_c)
    finally:
        B.OUT = real_out


def gaia_lists(gf, ra_c, dec_c):
    """Gaia stars within GAIA_NB_ARCSEC of the target as (ra, dec, pmra, pmdec, G), the form of
    blink.py's t['_gaia_nb']; None without a Gaia field."""
    if not gf:
        return None
    cosc = math.cos(math.radians(dec_c))
    return [(s[1], s[2], s[3], s[4], s[6]) for s in gf["stars"]
            if math.hypot((s[1] - ra_c) * cosc, s[2] - dec_c) * 3600 < GAIA_NB_ARCSEC]


def run(name, t, files, listing, out_dir, gaia=None, log=print):
    """Measure every cutout in `files` and write <out_dir>/spectrum.{csv,json}. Returns the spec.
    gaia: blink.gaia_field()-style dict (neighbour model) or None."""
    from astropy.time import Time
    t0 = time.time()
    t = dict(t)
    for k, v in (("pmra", 0.0), ("pmdec", 0.0), ("plx", 0.0), ("epoch", 2016.0)):
        t.setdefault(k, v)
    ra_c, dec_c = B.target_position(t, Time(B.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    gaia_nb = gaia_lists(gaia, ra_c, dec_c)
    if gaia_nb is not None:
        t["_gaia_nb"] = gaia_nb
    infos = []
    for p in files:
        try:
            i = read_exposure(p, t)
        except Exception as e:                       # e.g. a file still being written
            log(f"  skip {p.name}: {e}")
            continue
        if i is None:
            continue
        row = listing.get(p.name, {})
        i["collection"] = p.parent.name
        i["obs_id"] = row.get("obs_id", "")
        i["mjd_t"] = float(row["t_min"]) if row.get("t_min") else i["mjd"]
        infos.append(i)
    inside = [i for i in infos if i["inside"] and np.isfinite(i.get("wavelength_um", np.nan))]
    if not inside:
        raise RuntimeError("no exposure contains the target")
    ep = B.split_epochs([i["mjd_t"] for i in infos if i["inside"]])
    for i in inside:
        i["epoch"] = ep.get(i["mjd_t"], "")
    for i in inside:
        measure(t, i)
        i.pop("_px", None)                           # free the arrays
    finish_rows(inside)
    rows = [to_row(i) for i in inside]
    spec = build(t, rows, len(infos) - len(inside), ra_c, dec_c,
                 extra={"neighbours": {"gaia_dr3": len(t.get("_gaia_nb", []) or []),
                                       "catalogue": len(t.get("neighbors", {}).get("list", []))},
                        "seconds": round(time.time() - t0, 1)})
    write(out_dir, spec)
    s = spec["summary"]
    log(f"spectrum: {s['n_exposures']} exposures ({s['n_detection']} detections, {s['n_nondetection']} non-detections, "
        f"{s['n_saturated']} saturated of which {s['n_saturated_wing']} wing estimates, {s['n_flagged']} flagged); "
        f"detected {s['detected_range_um']} um; {spec['seconds']} s -> {out_dir}")
    return spec


def job_step(ctx):
    """local/job_worker.py post-step (full result only): spectrum of the job's target from the
    job's cutouts, written next to the blink products (spectrum.csv, spectrum.json)."""
    out = Path(ctx["out"])
    inputs = Path(ctx["inputs"])
    t = dict(ctx["target"])
    files = sorted(p for c in B.COLLECTIONS if (inputs / c).is_dir() for p in (inputs / c).glob("*.fits"))
    listing = {}
    for c in B.COLLECTIONS:
        lp = inputs / f"liste_{c}.csv"
        if lp.exists():
            with open(lp, newline="") as f:
                for r in csv.DictReader(f):
                    u = r.get("access_url", "")
                    if u.endswith(".fits"):
                        listing[u.rsplit("/", 1)[-1]] = r
    # Gaia field stars from the caches only (no network in a post-step): the committed list of a
    # challenge target, else the one blink.py fetched for this job (motion targets)
    gaia = None
    for p in (B.ROOT / "site" / "data" / (t.get("gaia_cache_key") or ctx["job_id"]) / "gaia_field.json",
              out / "gaia_field.json", B.ROOT / "cache" / "gaia" / (t.get("gaia_cache_key") or ctx["job_id"]) / "gaia_field.json"):
        if p.exists():
            gaia = json.loads(p.read_text())
            break
    if gaia is None:
        print("  spectrum: no cached Gaia field stars; neighbours not modelled", flush=True)
    status = ctx.get("status")
    if status is not None:
        status.set(message=f"post-step: spectrum ({len(files)} exposures)")
    spec = run(ctx["job_id"], t, files, listing, out, gaia=gaia, log=lambda m: print(m, flush=True))
    s = spec["summary"]
    return {"file": "spectrum.json", "n_exposures": s["n_exposures"], "detected_range_um": s["detected_range_um"],
            "n_saturated": s["n_saturated"]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("target", help="target id (pipeline/targets.json or FAZARI_TARGETS), or a free id with --target-json")
    ap.add_argument("--target-json", help="the source inline (as blink.py --target-json)")
    ap.add_argument("--data-target", help="read the cutouts of this target (default: the id)")
    ap.add_argument("--out", help="output root (default: env FAZARI_OUT, else site/data)")
    ap.add_argument("--no-gaia", action="store_true", help="do not model Gaia DR3 field stars")
    a = ap.parse_args(argv)
    t = B.load_target(a.target, json.loads(a.target_json) if a.target_json else None)
    data_name = a.data_target or a.target
    files = sorted(p for c in B.COLLECTIONS if (B.DATA / data_name / c).is_dir()
                   for p in (B.DATA / data_name / c).glob("*.fits"))
    out_root = Path(a.out).expanduser().resolve() if a.out else B.OUT
    print(f"{t['name']}: {len(files)} cutouts in {B.DATA / data_name}")
    from astropy.time import Time
    ra_c, dec_c = B.target_position(t, Time(B.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    gaia = None
    if not a.no_gaia:
        try:
            # the Gaia field of the cutouts' target (same sky) when measuring another source there
            gaia = load_gaia(data_name, *B.target_position(B.load_target(data_name), Time(B.EPOCH_CENTER, format="jyear").mjd,
                                                           with_parallax=False), out_root) \
                if a.data_target else load_gaia(a.target, ra_c, dec_c, out_root)
        except Exception as e:
            print("  WARNING: no Gaia field stars:", e)
        if gaia is None:
            print("  note: no Gaia field stars; neighbours not modelled")
    run(a.target, t, files, B.listing(data_name), out_root / a.target, gaia=gaia)


if __name__ == "__main__":
    main()
