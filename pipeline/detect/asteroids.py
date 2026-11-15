"""Detector C, known-asteroid mode: recover known asteroids in SPHEREx ecliptic fields.

Method (details, numbers and limits: pipeline/ASTEROIDS.md):

1. Fields. From the static sky index catalogue, SPHEREx visits near the ecliptic (|beta| < 2 deg
   at the detector centre), one per time bin over the whole DR1 + QR3 span, so dates and
   ecliptic longitudes are spread. A visit = 4 sub-exposures of one detector taken 2.1 min apart
   (the pointing steps 0.2 deg between them, the wavelength at a sky point steps ~2.5 %).
2. Known objects. One IMCCE SkyBoT cone (radius R_CONE around the visit centre) at the first
   sub-exposure time: every known asteroid/comet with its geocentric position, V, rates and
   distance. Positions are moved to each sub-exposure time with the rates and then from the
   geocentre to SPHEREx (header X_SC/Y_SC/Z_SC; ssoephem.topocentric).
3. Boxes. For every known object with V <= V_ANALYSE inside the field, a BOX x BOX native-pixel
   box around its predicted pixel position is read from S3 (s3box: one Range request per row,
   box columns only) in each sub-exposure, plus N_REF reference exposures of the same detector
   and the same sky, taken >= REF_MIN_DAYS away (the object is elsewhere then), one per visit,
   with the wavelength closest to the target visit.
4. Blind detection. In each box: background-subtracted target minus the median of the
   references resampled onto the target pixels (cubic spline), noise = robust scatter of the
   difference plus a floor MODEL_C x reference brightness (star residuals); PSF-matched filter
   (SPHEREx EPSF of the detector when cached, else a Gaussian of the header PSF_FWHM); peaks
   with Z >= Z_DET; EPSF fit (position, flux, background) in the target's native pixels.
   The ephemeris is not used inside the box: every peak of the box is a detection.
5. Linking. Detections of the 4 sub-exposures at the same sky position (within LINK_PX) form
   an object; >= 2 sub-exposures are required (cosmic rays, hot pixels and persistence are
   fixed on the detector or in one exposure only, while the pointing moves 117 px between
   sub-exposures). The linked positions give a measured rate.
6. Matching. Objects are matched to ALL known objects of the cone (any V) within MATCH_PX:
   'asteroid-known'; unmatched objects are 'candidate' and are counted as false detections
   unless they are later shown to be real. Offsets detection - ephemeris are reported per
   sub-exposure in native pixels (6.15") and arcsec.
7. Tracklets across visits. For each recovered object, the next visit of the same sky within
   TRACK_DAYS (hours later) is processed the same way; the long-arc rate is compared with the
   ephemeris rate.

Usage (from the fazari/ folder):
  uv run --no-project --with astropy --with numpy --with scipy --with pillow \
      python -I pipeline/find_asteroids.py select            # choose the fields
  ... find_asteroids.py run [--only F01,F02] [--max-fields N]
  ... find_asteroids.py report                               # ASTEROIDS table + site JSON
Outputs: cache/asteroids/runs/<field>.json (per field), site/data/asteroids/ (report).
"""
import argparse
import csv
import gzip
import json
import math
import os
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates, correlate, maximum_filter, binary_dilation

import blink as BL
import sky_index as SI
from . import s3box as S3
from . import ssoephem as EPH
from . import schema as SC

NAME = "C"
PIX = BL.PIX_NATIVE                 # 6.15 arcsec
BOX = 33                            # box side (native px)
INNER = 4                           # peaks closer than this to the box edge are ignored
V_ANALYSE = 20.5                    # known objects brighter than this get boxes
R_CONE = 1.5                        # SkyBoT cone radius (deg) around the visit centre
EDGE_PX = 8                         # predicted position must be this far inside the detector
N_REF = 3
REF_MIN_DAYS = 1.0
MODEL_C = 0.10                      # noise floor: fraction of the reference brightness
Z_DET = 4.0                         # per-exposure peak threshold (candidates for linking)
Z_CONFIRM = 5.0                     # a linked object needs one exposure at Z >= this (or >= 3 exposures)
LINK_PX = 2.0
MATCH_PX = 2.0
FIT_R = 3                           # EPSF fit stamp half-size (7 x 7)
TRACK_DAYS = 1.0
STATIC_MAX = 1.0                    # reference flux / excess above this = residual of a static source
STATIC_MIN = -0.5                   # below this the excess comes from a hole in the reference
FLUX_V_MAX = 3.0                    # a match whose AB magnitude is this much brighter than the object's V is not it
CHI2_MAX = 3.0                      # EPSF fit reduced chi2 above this = not a point source ...
CHI2_SNR = 25.0                     # ... times (1 + (S/N / CHI2_SNR)^2): the EPSF is not perfect for bright sources
Z_STACK = 5.0                       # visit-stack detection threshold
CHI2_MAX_STACK = 6.0                # the stack PSF is broadened by the resampling and the motion
SUB_CHI2_MAX = 6.0                  # flux consistency of the sub-exposures (cosmic-ray test)
STAR_MASK_NSIG = 10.0               # EPSF fit: stamp pixels (outside the central 3 x 3) where the reference is brighter than
#                                     this many times the difference noise belong to a neighbouring star, whose undersampled
#                                     residual (up to ~30-100 % of its pixels) would make the candidate's chi2 "not PSF-shaped";
#                                     they and their direct neighbours are left out of the fit. None = old behaviour (whole
#                                     7 x 7 stamp). Added 2026-11-15 after pipeline/ASTEROID_MISSES.md; the V8 numbers were
#                                     measured without it (None).
OBJ_WORKERS = 6                     # objects processed at once (network-bound)
DETECTORS = (2, 3)                  # target detectors (1.1-2.4 um; D1 has airglow, D4-6 are faint for asteroids)
OUT_SITE = BL.ROOT / "site" / "data" / "asteroids"
RUNS = S3.CACHE / "runs"
FIELDS = S3.CACHE / "fields.json"
LEDGER = S3.CACHE / "bytes_ledger.json"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# =============================================================================== fields
def ecliptic_beta(ra, dec):
    eps = math.radians(23.4392911)
    ra, dec = math.radians(ra), math.radians(dec)
    return math.degrees(math.asin(math.sin(dec) * math.cos(eps) - math.cos(dec) * math.sin(eps) * math.sin(ra)))


def ecliptic_lambda(ra, dec):
    eps = math.radians(23.4392911)
    ra, dec = math.radians(ra), math.radians(dec)
    return math.degrees(math.atan2(math.sin(ra) * math.cos(eps) + math.tan(dec) * math.sin(eps), math.cos(ra))) % 360


def select_fields(n=24, beta_max=2.0, catalog=None):
    """Visits near the ecliptic spread over the mission: one per time bin, detectors alternating
    D2/D3, each with 4 sub-exposures and >= N_REF reference visits >= REF_MIN_DAYS away."""
    catalog = catalog or (BL.ROOT / "cache" / "sky_index" / "catalog.csv.gz")
    visits = {}
    with gzip.open(catalog, "rt") as fh:
        for r in csv.DictReader(fh):
            det = int(r["detector"])
            if det not in DETECTORS:
                continue
            ra, dec = float(r["ra_center"]), float(r["dec_center"])
            if abs(dec) > 30:                                 # quick cut before the exact beta
                continue
            b = ecliptic_beta(ra, dec)
            if abs(b) > beta_max + 0.5:
                continue
            vid = r["obs_id"].rsplit("_", 1)[0]
            visits.setdefault((vid, det), []).append(dict(obs_id=r["obs_id"], mjd=float(r["t_min"]), ra=ra, dec=dec,
                                                         beta=b, key=r["s3_key"], coll=r["collection"]))
    good = []
    for (vid, det), subs in visits.items():
        subs.sort(key=lambda s: s["obs_id"])
        if len(subs) != 4 or any(abs(s["beta"]) > beta_max for s in subs):
            continue
        good.append((subs[0]["mjd"], vid, det, subs))
    good.sort()
    log(f"{len(good)} ecliptic visits with 4 sub-exposures on D{DETECTORS}")
    t0, t1 = good[0][0], good[-1][0]
    fields = []
    for i in range(n):
        tc = t0 + (i + 0.5) * (t1 - t0) / n
        want = DETECTORS[i % len(DETECTORS)]
        cands = sorted(good, key=lambda g: (g[2] != want, abs(g[0] - tc)))
        for mjd, vid, det, subs in cands[:200]:
            if abs(mjd - tc) > (t1 - t0) / n:
                continue
            ra_c = float(np.mean([s["ra"] for s in subs]))
            dec_c = float(np.mean([s["dec"] for s in subs]))
            refs = [r for r in SI.find_images(ra_c, dec_c) if r["detector"] == det
                    and abs(r["mjd"] - mjd) >= REF_MIN_DAYS]
            nvis = len({r["obs_id"].rsplit("_", 1)[0] for r in refs})
            if nvis < N_REF:
                continue
            fields.append(dict(id=f"F{len(fields) + 1:02d}", visit=vid, detector=det, mjd=round(mjd, 6),
                               date=_date(mjd), ra=round(ra_c, 5), dec=round(dec_c, 5),
                               beta=round(ecliptic_beta(ra_c, dec_c), 3), lam=round(ecliptic_lambda(ra_c, dec_c), 2),
                               collection=subs[0]["coll"], n_ref_visits=nvis,
                               subs=[dict(obs_id=s["obs_id"], key=s["key"]) for s in subs]))
            log(f"  {fields[-1]['id']} {vid} D{det} {fields[-1]['date']} lambda {fields[-1]['lam']:.1f} "
                f"beta {fields[-1]['beta']:+.2f} ref visits {nvis}")
            break
    return fields


def _date(mjd):
    from astropy.time import Time
    return Time(mjd, format="mjd").iso[:16]


# =============================================================================== PSF
class PSF:
    """Native-pixel PSF kernels of one exposure near one position: the SPHEREx EPSF when its
    calibration file is cached, else a Gaussian with the header PSF_FWHM."""

    def __init__(self, exp, x, y):
        got = exp.epsf(x, y)
        if got is not None:
            psf, ovs = got
            self.kind = "epsf"
        else:
            ovs = 5
            fwhm = (exp.psf_fwhm_arcsec or 1.6 * PIX) / PIX
            s = fwhm / 2.3548 * ovs
            g = np.arange(33) - 16
            psf = np.exp(-0.5 * (g[None, :] ** 2 + g[:, None] ** 2) / s ** 2)
            psf /= psf.sum()
            self.kind = "gauss"
        self.px = {"psf": BL.prep_psf(psf), "ovs": ovs}

    def kernel(self, dx=0.0, dy=0.0, R=FIT_R):
        k = BL.epsf_kernels(self.px, dx, dy, R)
        return k.reshape(len(np.atleast_1d(dx)), 2 * R + 1, 2 * R + 1)


# =============================================================================== boxes
def target_box(exp, xc, yc, half):
    x0, y0 = xc - half, yc - half
    img = exp.box("IMAGE", x0, y0, xc + half, yc + half).astype(float)
    return img, (x0, y0)


def stack_detect(bs, exps):
    """Visit-stack detection: the differences of the sub-exposures (bs: list of (k, detect_box
    result)) resampled onto the box of the first one and averaged with inverse-variance weights.
    The asteroid moves < 0.5 px during a visit (MBA), so its signal adds while the noise drops by
    ~sqrt(n). Peaks with Z >= Z_STACK are fitted with the EPSF on the stack; each sub-exposure is
    then fitted at that position in its own native pixels (per-exposure astrometry). Rejected:
    static-source residuals (as in detect_box) and single-exposure events (cosmic rays: one
    sub-exposure carries the flux, the others none)."""
    k0, b0 = bs[0]
    ny, nx = b0["D"].shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    r, d = exps[k0].pix2world((xx + b0["origin"][0]).ravel(), (yy + b0["origin"][1]).ravel())
    num = np.zeros((ny, nx))
    den = np.zeros((ny, nx))
    for k, b in bs:
        if k == k0:
            Dk, Vk = b["D"], b["var"]
        else:
            x, y = exps[k].world2pix(r, d)
            c = [y - b["origin"][1], x - b["origin"][0]]
            Dk = map_coordinates(np.nan_to_num(b["D"]), c, order=1, mode="constant", cval=0.0).reshape(ny, nx)
            Vk = map_coordinates(np.nan_to_num(b["var"], nan=1e30), c, order=1, mode="constant", cval=1e30).reshape(ny, nx)
            bad = map_coordinates((~np.isfinite(b["D"])).astype(float), c, order=1, mode="constant", cval=1.0)
            Dk = np.where(bad.reshape(ny, nx) > 0.01, np.nan, Dk)
        good = np.isfinite(Dk) & np.isfinite(Vk) & (Vk > 0) & (Vk < 1e29)
        num += np.where(good, Dk / np.where(good, Vk, 1), 0.0)
        den += np.where(good, 1 / np.where(good, Vk, 1), 0.0)
    ok = den > 0
    Ds = np.where(ok, num / np.where(ok, den, 1), np.nan)
    Vs = np.where(ok, 1 / np.where(ok, den, 1), np.nan)
    psf0 = b0["_psf"]
    K = psf0.kernel(0.0, 0.0, FIT_R)[0]
    F, Z = matched_filter(Ds, Vs, K)
    inner = np.zeros((ny, nx), bool)
    inner[INNER:-INNER, INNER:-INNER] = True
    valid = inner & np.isfinite(Z)
    zv = Z[valid]
    zs = 1.4826 * np.median(np.abs(zv - np.median(zv))) if zv.size > 50 else 1.0
    zs = float(min(3.0, max(0.5, zs)))
    Zn = Z / zs
    out = dict(dets=[], rej=[], area_px=int(valid.sum()), z_scale=zs, D=Ds, var=Vs * zs * zs, Zn=Zn)
    a = np.where(valid, Zn, -np.inf)
    mx = maximum_filter(a, size=3, mode="constant", cval=-np.inf)
    ys, xs = np.nonzero((a == mx) & (a >= Z_STACK))
    for x, y in zip(xs, ys):
        f = fit_psf(Ds, Vs * zs * zs, psf0, float(x), float(y), exclude=b0.get("star"))
        if f is None or f["at_bound"] or f["flux"] <= 0:
            continue
        sr = static_ratio(b0["R"], Ds, x, y)
        X, Y = b0["origin"][0] + f["x"], b0["origin"][1] + f["y"]
        rr, dd = exps[k0].pix2world(X, Y)
        det = dict(ra=float(rr[0]), dec=float(dd[0]), z=float(Zn[y, x]), snr=f["snr"], flux=f["flux"],
                   eflux=f["eflux"], chi2r=f["chi2r"], static_ratio=None if sr is None else round(sr, 3), subs=[])
        # per-sub-exposure: forced flux at the stack position (consistency) and a free EPSF fit
        fl = []
        for k, b in bs:
            xk, yk = exps[k].world2pix(rr, dd)
            xk, yk = float(xk[0]) - b["origin"][0], float(yk[0]) - b["origin"][1]
            fc = forced(b, xk, yk)
            if fc:
                fl.append((fc["flux"], fc["eflux"]))
            fk = fit_psf(b["D"], b["var"], b["_psf"], xk, yk, exclude=b.get("star"))
            if fk and not fk["at_bound"] and fk["flux"] > 0 and fk["snr"] >= 3.0 and \
                    math.hypot(fk["x"] - xk, fk["y"] - yk) < 1.0:
                Xk, Yk = b["origin"][0] + fk["x"], b["origin"][1] + fk["y"]
                rk, dk = exps[k].pix2world(Xk, Yk)
                det["subs"].append(dict(k=k, x=Xk, y=Yk, ra=float(rk[0]), dec=float(dk[0]), snr=fk["snr"],
                                        flux=fk["flux"], eflux=fk["eflux"], ex=fk["ex"], ey=fk["ey"], chi2r=fk["chi2r"]))
        why = residual_reason(sr, f["chi2r"], CHI2_MAX_STACK * (1 + (snr_raw(f) / CHI2_SNR) ** 2))
        if not why and len(fl) >= 2:
            fv = np.array([q[0] for q in fl])
            ev = np.array([q[1] for q in fl])
            w = 1 / ev ** 2
            m = float(np.sum(w * fv) / np.sum(w))
            chi = float(np.sum(w * (fv - m) ** 2) / (len(fv) - 1))
            det["flux_chi2r"] = round(chi, 2)
            if chi > SUB_CHI2_MAX and np.max(fv / ev) > 3 * max(1.0, np.median(fv / ev)):
                why = "one sub-exposure only (cosmic ray)"
        if not why and len(det["subs"]) < 1:
            why = "no sub-exposure fit"
        (out["rej"] if why else out["dets"]).append(dict(det, why=why) if why else det)
    return out


class RefPatch:
    """One reference exposure, read once over the union of the target boxes of an object."""

    def __init__(self, exp, ra, dec, margin=3):
        self.exp = exp
        rx, ry = exp.world2pix(ra, dec)
        self.ok = bool(np.all(np.isfinite(rx)) and np.all(np.isfinite(ry)))
        if not self.ok:
            return
        self.x0, self.y0 = int(math.floor(rx.min())) - margin, int(math.floor(ry.min())) - margin
        self.x1, self.y1 = int(math.ceil(rx.max())) + margin, int(math.ceil(ry.max())) + margin
        if self.x1 < 0 or self.y1 < 0 or self.x0 > S3.NPIX - 1 or self.y0 > S3.NPIX - 1:
            self.ok = False
            return
        self.a = exp.box("IMAGE", self.x0, self.y0, self.x1, self.y1).astype(float)


def box_corners_world(tgt, xcs, ycs, half=BOX // 2):
    """Sky positions of the edges of the target boxes centred on (xcs, ycs) (lists)."""
    pts = []
    t = np.arange(-half, half + 1, 4.0)
    for xc, yc in zip(xcs, ycs):
        e = np.concatenate([np.stack([t, np.full_like(t, -half)], 1), np.stack([t, np.full_like(t, half)], 1),
                            np.stack([np.full_like(t, -half), t], 1), np.stack([np.full_like(t, half), t], 1)])
        pts.append(e + [xc, yc])
    pts = np.concatenate(pts)
    return tgt.pix2world(pts[:, 0], pts[:, 1])


def resample_ref(ref, tgt, origin, shape):
    """Reference image on the target box pixels (array or None). ref: RefPatch or Exposure."""
    x0, y0 = origin
    ny, nx = shape
    yy, xx = np.mgrid[y0:y0 + ny, x0:x0 + nx]
    r, d = tgt.pix2world(xx.ravel(), yy.ravel())
    exp = ref.exp if isinstance(ref, RefPatch) else ref
    rx, ry = exp.world2pix(r, d)
    if not (np.all(np.isfinite(rx)) and np.all(np.isfinite(ry))):
        return None
    bx0, by0 = int(math.floor(rx.min())) - 3, int(math.floor(ry.min())) - 3
    bx1, by1 = int(math.ceil(rx.max())) + 3, int(math.ceil(ry.max())) + 3
    if bx1 < 0 or by1 < 0 or bx0 > S3.NPIX - 1 or by0 > S3.NPIX - 1:
        return None
    if isinstance(ref, RefPatch):
        if not ref.ok or bx0 < ref.x0 or by0 < ref.y0 or bx1 > ref.x1 or by1 > ref.y1:
            return None
        a = ref.a[by0 - ref.y0:by1 - ref.y0 + 1, bx0 - ref.x0:bx1 - ref.x0 + 1]
    else:
        a = ref.box("IMAGE", bx0, by0, bx1, by1).astype(float)
    bad = ~np.isfinite(a)
    if bad.mean() > 0.3:
        return None
    fill = np.where(bad, np.nanmedian(a), a)
    out = map_coordinates(fill, [ry - by0, rx - bx0], order=3, mode="nearest")
    badr = map_coordinates(binary_dilation(bad, iterations=1).astype(float), [ry - by0, rx - bx0], order=1,
                           mode="constant", cval=1.0)
    out[badr > 0.01] = np.nan
    return out.reshape(ny, nx)


def register(T, R, noise, nsig=5.0):
    """Sub-pixel shift and flux scale of a resampled reference R that best match the target T
    on the bright pixels of the box (linearised: T ~ s*R + dx*dR/dx + dy*dR/dy + b). Removes
    the residual WCS misregistration and the colour/throughput difference that leave dipoles
    and ring residuals of the static stars. Kept only if well determined and small."""
    from scipy.ndimage import shift as nd_shift
    ok = np.isfinite(T) & np.isfinite(R)
    if not np.isfinite(noise) or noise <= 0:
        return R
    gy, gx = np.gradient(np.where(ok, R, 0.0))
    bright = ok & (R > nsig * noise)
    if bright.sum() < 12:
        return R
    sel = binary_dilation(bright, iterations=1) & ok
    A = np.stack([R[sel], gx[sel], gy[sel], np.ones(sel.sum())], 1)
    try:
        p, *_ = np.linalg.lstsq(A, T[sel], rcond=None)
    except np.linalg.LinAlgError:
        return R
    s = p[0]
    if not (0.5 < s < 2.0):
        return R
    dx, dy = p[1] / s, p[2] / s
    if math.hypot(dx, dy) > 0.8:
        return R
    filled = np.where(ok, R, 0.0)
    out = nd_shift(filled, (dy, dx), order=3, mode="nearest") * s
    out[~np.isfinite(R)] = np.nan
    return out


def robust_bg(a):
    v = a[np.isfinite(a)]
    if v.size < 20:
        return 0.0, float("nan")
    med = np.median(v)
    s = 1.4826 * np.median(np.abs(v - med))
    v = v[np.abs(v - med) < 3 * s]
    return float(np.median(v)), float(1.4826 * np.median(np.abs(v - np.median(v))))


def matched_filter(D, var, K):
    good = np.isfinite(D) & np.isfinite(var) & (var > 0)
    iv = np.where(good, 1.0 / np.where(good, var, 1.0), 0.0)
    num = correlate(np.where(good, D, 0.0) * iv, K, mode="constant")
    den = correlate(iv, K * K, mode="constant")
    ok = den > 0
    F = np.where(ok, num / np.where(ok, den, 1), np.nan)
    Z = np.where(ok, num / np.sqrt(np.where(ok, den, 1)), np.nan)
    return F, Z


def fit_psf(D, var, psf, x, y, R=FIT_R, iters=12, h=0.02, exclude=None):
    """EPSF fit (flux, dx, dy, background) at box position (x, y): dict or None.
    exclude: optional boolean array of D's shape; those stamp pixels outside the central 3 x 3 are not
    used (pixels of a neighbouring bright star, see STAR_MASK_NSIG).
    Gauss-Newton on the position (EPSF derivatives by finite differences, one batched kernel
    evaluation per iteration), flux and background solved linearly; position bounded to +-1.5 px
    from the start pixel. Errors from the normal matrix, scaled by max(1, reduced chi2)."""
    ix, iy = int(round(x)), int(round(y))
    ny, nx = D.shape
    if ix < R or iy < R or ix >= nx - R or iy >= ny - R:
        return None
    d = D[iy - R:iy + R + 1, ix - R:ix + R + 1]
    v = var[iy - R:iy + R + 1, ix - R:ix + R + 1]
    good = np.isfinite(d) & np.isfinite(v) & (v > 0)
    if good.sum() < 0.6 * d.size or not good[R - 1:R + 2, R - 1:R + 2].all():
        return None
    if exclude is not None:
        ex = exclude[iy - R:iy + R + 1, ix - R:ix + R + 1].copy()
        ex[R - 1:R + 2, R - 1:R + 2] = False
        good &= ~ex
    w = 1 / np.sqrt(v[good])
    dd = d[good] * w
    one = w
    px, py = x - ix, y - iy
    f = b = 0.0
    at_bound = False
    for _ in range(iters):
        K = psf.kernel(np.array([px, px + h, px]), np.array([py, py, py + h]), R)
        k0, kx, ky = K[0][good] * w, K[1][good] * w, K[2][good] * w
        A = np.stack([k0, one], 1)
        (f, b), *_ = np.linalg.lstsq(A, dd, rcond=None)
        if f <= 0:
            break
        J = np.stack([k0, f * (kx - k0) / h, f * (ky - k0) / h, one], 1)
        r = dd - f * k0 - b * one
        step, *_ = np.linalg.lstsq(J, r, rcond=None)
        sx, sy = np.clip(step[1:3], -0.5, 0.5)
        px, py = px + sx, py + sy
        if abs(px) > 1.5 or abs(py) > 1.5:
            px, py = float(np.clip(px, -1.5, 1.5)), float(np.clip(py, -1.5, 1.5))
            at_bound = True
        if abs(sx) < 1e-3 and abs(sy) < 1e-3:
            break
    K = psf.kernel(np.array([px, px + h, px]), np.array([py, py, py + h]), R)
    k0, kx, ky = K[0][good] * w, K[1][good] * w, K[2][good] * w
    (f, b), *_ = np.linalg.lstsq(np.stack([k0, one], 1), dd, rcond=None)
    J = np.stack([k0, f * (kx - k0) / h, f * (ky - k0) / h, one], 1)
    r = dd - f * k0 - b * one
    dof = max(1, int(good.sum()) - 4)
    chi2r = float(r @ r / dof)
    try:
        cov = np.linalg.inv(J.T @ J) * max(1.0, chi2r)
    except np.linalg.LinAlgError:
        return None
    ef = math.sqrt(max(cov[0, 0], 0))
    return dict(x=ix + px, y=iy + py, flux=float(f), eflux=ef, snr=float(f / ef) if ef > 0 else 0.0,
                ex=math.sqrt(max(cov[1, 1], 0)), ey=math.sqrt(max(cov[2, 2], 0)), chi2r=chi2r, bg=float(b),
                at_bound=bool(at_bound or abs(px) > 1.45 or abs(py) > 1.45))

def detect_box(tgt, refs, xc, yc, half=BOX // 2):
    """Blind detection in one box of exposure tgt centred on full-detector pixel (xc, yc).
    Returns dict: dets (list), n_ref, noise, area_px, D (difference), R (reference), origin."""
    T, origin = target_box(tgt, xc, yc, half)
    shape = T.shape
    Rs = []
    for ref in refs:
        a = resample_ref(ref, tgt, origin, shape)
        if a is not None and np.isfinite(a).mean() > 0.7:
            b, _ = robust_bg(a)
            Rs.append(a - b)
    out = dict(origin=origin, n_ref=len(Rs), dets=[], area_px=0)
    if len(Rs) < 2:
        out["reason"] = "fewer than 2 usable references"
        return out
    bT, sT = robust_bg(T)
    T = T - bT
    Rs = [register(T, a, sT) for a in Rs]
    R = np.nanmedian(np.stack(Rs), axis=0) if len(Rs) >= 3 else np.nanmean(np.stack(Rs), axis=0)
    D = T - R
    _, s = robust_bg(D)
    if not np.isfinite(s) or s <= 0:
        out["reason"] = "no noise estimate"
        return out
    psf = PSF(tgt, xc, yc)
    K = psf.kernel(0.0, 0.0, FIT_R)[0]
    Rpos = np.clip(np.nan_to_num(R), 0, None)
    var = s * s * np.ones_like(D) + (MODEL_C * Rpos) ** 2
    F, Z = matched_filter(D, var, K)
    inner = np.zeros(shape, bool)
    inner[INNER:-INNER, INNER:-INNER] = True
    valid = inner & np.isfinite(Z) & np.isfinite(D)
    zv = Z[valid]
    zs = 1.4826 * np.median(np.abs(zv - np.median(zv))) if zv.size > 50 else 1.0
    zs = float(min(3.0, max(0.8, zs)))
    Zn = Z / zs
    # pixels of a neighbouring star and their direct neighbours (the residual of an undersampled star spreads by up to
    # one pixel with the pixel phase), left out of the EPSF fits of the candidates (STAR_MASK_NSIG)
    star = binary_dilation(np.isfinite(R) & (R > STAR_MASK_NSIG * s), iterations=1) if STAR_MASK_NSIG else None
    out.update(noise=float(s), z_scale=zs, area_px=int(valid.sum()), psf=psf.kind, T=T, R=R, D=D, var=var * zs * zs,
               Zn=Zn, _psf=psf, star=star)
    a = np.where(valid, Zn, -np.inf)
    mx = maximum_filter(a, size=3, mode="constant", cval=-np.inf)
    ys, xs = np.nonzero((a == mx) & (a >= Z_DET))
    for x, y in zip(xs, ys):
        f = fit_psf(D, var * zs * zs, psf, float(x), float(y), exclude=star)
        if f is None or f["at_bound"] or f["flux"] <= 0 or snr_raw(f) < 0.8 * Z_DET:
            continue
        sr = static_ratio(R, D, x, y)
        X, Y = origin[0] + f["x"], origin[1] + f["y"]
        r, d = tgt.pix2world(X, Y)
        det = dict(x=X, y=Y, ra=float(r[0]), dec=float(d[0]), z=float(Zn[y, x]), snr=f["snr"],
                   flux=f["flux"], eflux=f["eflux"], ex=f["ex"], ey=f["ey"], chi2r=f["chi2r"],
                   static_ratio=None if sr is None else round(sr, 3))
        why = residual_reason(sr, f["chi2r"], CHI2_MAX * (1 + (snr_raw(f) / CHI2_SNR) ** 2))
        if why:
            out.setdefault("rej", []).append(dict(det, why=why))
        else:
            out["dets"].append(det)
    return out


def static_ratio(R, D, x, y):
    """Reference flux / difference flux in the 3 x 3 pixels at (x, y) (None if no excess)."""
    sl = (slice(max(0, y - 1), y + 2), slice(max(0, x - 1), x + 2))
    Rf, Df = float(np.nansum(R[sl])), float(np.nansum(D[sl]))
    return Rf / Df if Df > 0 else None


def residual_reason(sr, chi2r, chi2_max=None):
    """Why a positive peak of the difference is a residual of a static source (or None).
    A new point source on empty sky has a reference/excess ratio ~0 and a PSF-shaped excess
    (chi2r ~1); the residual of an undersampled star sits on a source of the reference (ratio
    > STATIC_MAX) and is not PSF-shaped (dipole: chi2r > CHI2_MAX). A negative ratio below
    STATIC_MIN means the excess comes from a hole in the reference, not from the target."""
    if sr is None:
        return "no excess"
    if sr > STATIC_MAX:
        return "static-source residual"
    if sr < STATIC_MIN:
        return "hole in the reference"
    if chi2r > (chi2_max or CHI2_MAX):
        return "not PSF-shaped"
    return None


def flux_mismatch(flux_ujy, vmag):
    """AB magnitude of the detection minus the known object's V when the detection is more than
    FLUX_V_MAX mag brighter (a star residual or another source at the predicted position), else None.
    Asteroids have AB(1-2.4 um) - V of about -2 to +0.5 (reflected sunlight, red slope)."""
    if vmag is None or not flux_ujy or flux_ujy <= 0:
        return None
    dm = 23.9 - 2.5 * math.log10(flux_ujy) - vmag
    return round(dm, 2) if dm < -FLUX_V_MAX else None


def snr_raw(f):
    """S/N of an EPSF fit before its errors are scaled by sqrt(chi2r). The chi2 allowance must grow
    with this one: the scaled S/N of a bright source shrinks as its chi2 grows (EPSF model error)."""
    return f["snr"] * math.sqrt(max(1.0, f["chi2r"]))


def forced(box, x, y):
    """Forced EPSF flux at box position (x, y) of a detect_box result (position fixed)."""
    D, var, psf = box.get("D"), box.get("var"), box.get("_psf")
    if D is None:
        return None
    ix, iy = int(round(x)), int(round(y))
    R = FIT_R
    ny, nx = D.shape
    if ix < R or iy < R or ix >= nx - R or iy >= ny - R:
        return None
    d = D[iy - R:iy + R + 1, ix - R:ix + R + 1]
    v = var[iy - R:iy + R + 1, ix - R:ix + R + 1]
    k = psf.kernel(x - ix, y - iy, R)[0]
    good = np.isfinite(d) & np.isfinite(v) & (v > 0)
    if good.sum() < 20:
        return None
    A = np.stack([k[good], np.ones(good.sum())], 1) / np.sqrt(v[good])[:, None]
    bvec = d[good] / np.sqrt(v[good])
    try:
        cov = np.linalg.inv(A.T @ A)
    except np.linalg.LinAlgError:
        return None
    p = cov @ A.T @ bvec
    return dict(flux=float(p[0]), eflux=float(math.sqrt(cov[0, 0])), snr=float(p[0] / math.sqrt(cov[0, 0])))


# =============================================================================== references
def pick_refs(ra, dec, det, mjd, lam_target, n=N_REF, exclude_visit=None):
    """Up to n reference exposures of detector det covering (ra, dec), >= REF_MIN_DAYS from mjd,
    one per visit, closest in wavelength to lam_target. Index records."""
    best = {}
    for r in SI.find_images(ra, dec, margin=0.0):
        if r["detector"] != det or abs(r["mjd"] - mjd) < REF_MIN_DAYS:
            continue
        vid = r["obs_id"].rsplit("_", 1)[0]
        if vid == exclude_visit:
            continue
        dl = abs(r["approx_lam_um"] - lam_target) if lam_target else 0.0
        if vid not in best or dl < best[vid][0]:
            best[vid] = (dl, r)
    return [r for _, r in sorted(best.values(), key=lambda t: t[0])[:n]]


def index_lambda(ra, dec, obs_id, det):
    for r in SI.find_images(ra, dec, margin=0.0):
        if r["obs_id"] == obs_id and r["detector"] == det:
            return r["approx_lam_um"]
    return None


# =============================================================================== one visit
def predict(objs, mjd0, exp):
    """Topocentric predicted (ra, dec) of all objects at exposure exp's mid time."""
    ras, decs = zip(*[EPH.at_time(o, mjd0, exp.mjd) for o in objs]) if objs else ((), ())
    dg = [o.get("dg") for o in objs]
    if not objs:
        return np.zeros(0), np.zeros(0)
    return EPH.topocentric(np.array(ras), np.array(decs), dg, exp.sc_km)


def process_visit(vis, objs, mjd0, wanted, log_prefix=""):
    """Run the boxes of one visit. vis: list of {obs_id, key}; objs: SkyBoT objects (all V);
    wanted: indices of objects that get boxes. Returns per-exposure detections and box info."""
    exps = [S3.exposure(s["key"]) for s in vis]
    det = exps[0].detector
    vid = vis[0]["obs_id"].rsplit("_", 1)[0]
    pred = [predict(objs, mjd0, e) for e in exps]
    pix = [e.world2pix(p[0], p[1]) if len(objs) else (np.zeros(0), np.zeros(0)) for e, p in zip(exps, pred)]
    def one_object(j):
        o = objs[j]
        res = []
        # references: same for all sub-exposures of the visit (closest to their mean wavelength)
        inside = [k for k in range(len(exps)) if EDGE_PX <= pix[k][0][j] <= S3.NPIX - 1 - EDGE_PX
                  and EDGE_PX <= pix[k][1][j] <= S3.NPIX - 1 - EDGE_PX]
        if not inside:
            return [dict(obj=j, k=None, reason="edge")]
        k0 = inside[0]
        ra0, dec0 = float(pred[k0][0][j]), float(pred[k0][1][j])
        lams = [index_lambda(ra0, dec0, vis[k]["obs_id"], det) for k in inside]
        lams = [l for l in lams if l]
        lam_t = float(np.mean(lams)) if lams else None
        refs = pick_refs(ra0, dec0, det, exps[k0].mjd, lam_t, exclude_visit=vid)
        ref_exps = []
        # one reference patch per reference exposure, covering the boxes of all sub-exposures
        rr, dd = [], []
        for k in inside:
            r_, d_ = box_corners_world(exps[k], [round(pix[k][0][j])], [round(pix[k][1][j])])
            rr.append(r_)
            dd.append(d_)
        rr, dd = np.concatenate(rr), np.concatenate(dd)
        for r in refs:
            try:
                ref_exps.append(RefPatch(S3.exposure(r["s3_key"]), rr, dd))
            except Exception as ex:                       # unreadable reference: skip it
                log(f"{log_prefix} ref {r['obs_id']} failed: {ex}")
        for k in range(len(exps)):
            if k not in inside:
                res.append(dict(obj=j, k=k, reason="edge"))
                continue
            xc, yc = int(round(pix[k][0][j])), int(round(pix[k][1][j]))
            try:
                b = detect_box(exps[k], ref_exps, xc, yc)
            except Exception as ex:
                log(f"{log_prefix} box {o['name']} sub {k + 1} failed: {type(ex).__name__}: {ex}")
                res.append(dict(obj=j, k=k, reason=f"error {type(ex).__name__}"))
                continue
            x_in, y_in = pix[k][0][j] - b["origin"][0], pix[k][1][j] - b["origin"][1]
            fc = forced(b, x_in, y_in)
            img_nan, static = None, None
            if b.get("T") is not None:
                iy, ix = int(round(y_in)), int(round(x_in))
                sl = (slice(max(0, iy - 1), iy + 2), slice(max(0, ix - 1), ix + 2))
                img_nan = bool((~np.isfinite(b["T"][sl])).any())
                Rloc = b["R"][sl]
                static = float(np.nansum(Rloc)) if np.isfinite(Rloc).any() else None
            lam = exps[k].wavelength(pix[k][0][j], pix[k][1][j])
            res.append(dict(obj=j, k=k, xc=xc, yc=yc, origin=b["origin"], n_ref=b["n_ref"],
                            refs=[r["obs_id"] for r in refs], ref_keys=[r["s3_key"] for r in refs],
                            noise=b.get("noise"), z_scale=b.get("z_scale"),
                            area_px=b["area_px"], psf=b.get("psf"), reason=b.get("reason"),
                            forced=fc, nan_near=img_nan, static_flux=static,
                            lam_um=None if lam is None else round(float(np.atleast_1d(lam)[0]), 4),
                            dets=b["dets"], n_rej=len(b.get("rej", [])), _box=b,
                            rej_near=[d["why"] for d in b.get("rej", [])
                                      if math.hypot(d["x"] - pix[k][0][j], d["y"] - pix[k][1][j]) <= MATCH_PX]))
        bs = [(r["k"], r["_box"]) for r in res if r.get("_box") is not None and r["_box"].get("D") is not None]
        if len(bs) >= 2:
            try:
                st = stack_detect(bs, exps)
                res.append(dict(obj=j, k="stack", k_list=[k for k, _ in bs], stack=st["dets"], n_rej=len(st["rej"]),
                                area_px=st["area_px"], _stack=st))
            except Exception as ex:
                log(f"{log_prefix} stack {o['name']} failed: {type(ex).__name__}: {ex}")
        return res

    boxes = []          # one per (object, exposure)
    with ThreadPoolExecutor(max_workers=OBJ_WORKERS) as ex:
        for r in ex.map(one_object, wanted):
            boxes.extend(r)
    return exps, pred, pix, boxes


def dedupe(dets, tol_px=1.0):
    out = []
    for d in sorted(dets, key=lambda d: -d["z"]):
        if all(math.hypot(d["x"] - o["x"], d["y"] - o["y"]) > tol_px for o in out):
            out.append(d)
    return out


def link(exps, dets_per_exp):
    """Group detections of the sub-exposures by sky position (within LINK_PX)."""
    groups = []
    for k, dets in enumerate(dets_per_exp):
        for d in dets:
            d = dict(d, k=k, mjd=exps[k].mjd)
            best = None
            for g in groups:
                if any(q["k"] == k for q in g):
                    continue
                q = g[-1]
                sep = SC.sep_arcsec(q["ra"], q["dec"], d["ra"], d["dec"]) / PIX
                if sep <= LINK_PX and (best is None or sep < best[0]):
                    best = (sep, g)
            if best:
                best[1].append(d)
            else:
                groups.append([d])
    return groups


def confirmed(g):
    """A linked group is a detection: >= 2 sub-exposures with one at Z >= Z_CONFIRM, or >= 3."""
    n = len({q["k"] for q in g})
    return n >= 3 or (n >= 2 and max(q["z"] for q in g) >= Z_CONFIRM)


def rate_fit(g):
    """Linear motion of a linked group: (rate_ra_cosd, rate_dec) in arcsec/h and errors."""
    if len(g) < 2:
        return None
    t = np.array([q["mjd"] for q in g]) * 24.0
    ra0, dec0 = g[0]["ra"], g[0]["dec"]
    cosd = math.cos(math.radians(dec0))
    e = np.array([((q["ra"] - ra0 + 180) % 360 - 180) * cosd * 3600 for q in g])
    n = np.array([(q["dec"] - dec0) * 3600 for q in g])
    sig = np.array([max(0.05, math.hypot(q.get("ex") or 0.3, q.get("ey") or 0.3) / math.sqrt(2) * PIX) for q in g])
    w = 1 / sig ** 2
    tm = np.sum(w * t) / np.sum(w)
    st = np.sum(w * (t - tm) ** 2)
    if st <= 0:
        return None
    re = np.sum(w * (t - tm) * e) / st
    rn = np.sum(w * (t - tm) * n) / st
    err = math.sqrt(1 / st)
    return dict(ra_cosd=float(re), dec=float(rn), err=float(err))


# =============================================================================== one field
def run_field(f, track=True):
    t0 = time.time()
    b0, q0 = S3.bytes_downloaded(), S3.STATS.requests
    eb0 = EPH.BYTES["net"]
    exps = [S3.exposure(s["key"]) for s in f["subs"]]
    mjd0 = exps[0].mjd
    objs = EPH.cone(mjd0, f["ra"], f["dec"], R_CONE)
    if objs is None:
        raise RuntimeError("SkyBoT and SB-Ident failed")
    det = exps[0].detector
    pred = [predict(objs, mjd0, e) for e in exps]
    pix = [e.world2pix(p[0], p[1]) for e, p in zip(exps, pred)]
    # field = cone of radius R_CONE; object 'in field' if inside >= 1 sub-exposure (EDGE_PX margin)
    in_field = []
    for j, o in enumerate(objs):
        ins = [EDGE_PX <= pix[k][0][j] <= S3.NPIX - 1 - EDGE_PX and EDGE_PX <= pix[k][1][j] <= S3.NPIX - 1 - EDGE_PX
               for k in range(len(exps))]
        if any(ins):
            in_field.append(j)
    wanted = [j for j in in_field if (objs[j]["vmag"] or 99) <= V_ANALYSE]
    log(f"{f['id']} {f['visit']} D{det} {f['date']}: {len(objs)} known SSOs in the cone, {len(in_field)} on the "
        f"detector, {len(wanted)} with V <= {V_ANALYSE}")
    exps, pred, pix, boxes = process_visit(f["subs"], objs, mjd0, wanted, log_prefix=f["id"])
    res = summarise_visit(f, exps, objs, mjd0, pred, pix, boxes, wanted, in_field)
    if track:
        try:
            res["tracklets"] = cross_visit(f, objs, mjd0, res)
        except Exception as ex:                    # tracklets are optional: keep the field result
            res["tracklets_error"] = f"{type(ex).__name__}: {ex}"
    res["bytes_s3"] = S3.bytes_downloaded() - b0
    res["requests_s3"] = S3.STATS.requests - q0
    res["bytes_skybot"] = EPH.BYTES["net"] - eb0
    res["seconds"] = round(time.time() - t0, 1)
    return res


def summarise_visit(f, exps, objs, mjd0, pred, pix, boxes, wanted, in_field):
    nk = len(exps)
    dets_k = [[] for _ in range(nk)]
    area = [0] * nk
    for b in boxes:
        if b.get("k") is None or "dets" not in b:
            continue
        dets_k[b["k"]].extend(b["dets"])
        area[b["k"]] += b["area_px"]
    dets_k = [dedupe(d) for d in dets_k]
    groups = link(exps, dets_k)
    # match every group to the nearest known object (any V) in every sub-exposure
    objects, used = [], set()
    for g in groups:
        offs = []
        for q in g:
            k = q["k"]
            pr, pd = pred[k]
            sep = np.array([SC.sep_arcsec(q["ra"], q["dec"], float(pr[j]), float(pd[j])) for j in range(len(objs))]) \
                if len(objs) else np.zeros(0)
            j = int(np.argmin(sep)) if len(sep) else -1
            offs.append((j, float(sep[j]) if j >= 0 else 1e9))
        js = [j for j, s in offs if s <= MATCH_PX * PIX]
        j = max(set(js), key=js.count) if js else None
        rec = dict(n_exp=len(g), dets=[], match=None)
        if j is not None:
            dm = flux_mismatch(float(np.median([q["flux"] for q in g])) * BL.PIXEL_UJY, objs[j]["vmag"])
            if dm is not None:
                rec["match_rejected"] = dict(idx=j, ab_minus_v=dm)
                j = None
        for q, (jj, s) in zip(g, offs):
            k = q["k"]
            dd = dict(sub=k + 1, mjd=round(q["mjd"], 6), x=round(q["x"], 3), y=round(q["y"], 3),
                      ra=round(q["ra"], 7), dec=round(q["dec"], 7), z=round(q["z"], 1), snr=round(q["snr"], 1),
                      flux_ujy=round(q["flux"] * BL.PIXEL_UJY, 1), eflux_ujy=round(q["eflux"] * BL.PIXEL_UJY, 1),
                      chi2r=round(q["chi2r"], 2), static_ratio=q["static_ratio"])
            if j is not None:
                pr, pd = pred[k]
                px_, py_ = pix[k][0][j], pix[k][1][j]
                de = ((q["ra"] - float(pr[j]) + 180) % 360 - 180) * math.cos(math.radians(q["dec"])) * 3600
                dn = (q["dec"] - float(pd[j])) * 3600
                dd.update(off_e=round(de, 2), off_n=round(dn, 2), off_arcsec=round(math.hypot(de, dn), 2),
                          off_px=round(math.hypot(de, dn) / PIX, 3), dx_px=round(q["x"] - px_, 3),
                          dy_px=round(q["y"] - py_, 3))
                lam = exps[k].wavelength(q["x"], q["y"])
                dd["lam_um"] = None if lam is None else round(float(np.atleast_1d(lam)[0]), 4)
            rec["dets"].append(dd)
        rf = rate_fit(g)
        rec["rate_measured"] = rf
        rec["confirmed"] = confirmed(g)
        if j is not None and rec["confirmed"]:
            rec["match"] = j
            used.add(j)
        elif j is not None:
            rec["match_single"] = j
        objects.append(rec)
    # visit-stack detections: dedupe (overlapping boxes), match to the mean prediction of their sub-exposures
    sdets = []
    for b in boxes:
        if b.get("k") == "stack":
            sdets.extend(dict(d, k_list=b["k_list"]) for d in b["stack"])
    uniq = []
    for d in sorted(sdets, key=lambda d: -d["z"]):
        if all(SC.sep_arcsec(d["ra"], d["dec"], q["ra"], q["dec"]) > PIX for q in uniq):
            uniq.append(d)
    sobjects = []
    for d in uniq:
        ks = d["k_list"]
        pr = np.mean([pred[k][0] for k in ks], 0)
        pd = np.mean([pred[k][1] for k in ks], 0)
        cosd = math.cos(math.radians(d["dec"]))
        sep = np.hypot(((pr - d["ra"] + 180) % 360 - 180) * cosd, pd - d["dec"]) * 3600 if len(objs) else np.zeros(0)
        j = int(np.argmin(sep)) if len(sep) else -1
        rec = dict(ra=round(d["ra"], 7), dec=round(d["dec"], 7), z=round(d["z"], 1), snr=round(d["snr"], 1),
                   flux_ujy=round(d["flux"] * BL.PIXEL_UJY, 1), chi2r=round(d["chi2r"], 2),
                   static_ratio=d["static_ratio"], flux_chi2r=d.get("flux_chi2r"), n_sub=len(d["subs"]), match=None,
                   subs=[])
        if j >= 0 and sep[j] <= MATCH_PX * PIX and flux_mismatch(d["flux"] * BL.PIXEL_UJY, objs[j]["vmag"]) is not None:
            rec["match_rejected"] = dict(idx=j, ab_minus_v=flux_mismatch(d["flux"] * BL.PIXEL_UJY, objs[j]["vmag"]))
        elif j >= 0 and sep[j] <= MATCH_PX * PIX:
            rec["match"] = j
            rec["off_px"] = round(float(sep[j]) / PIX, 3)
            rec["off_arcsec"] = round(float(sep[j]), 2)
        for q in d["subs"]:
            k = q["k"]
            dd = dict(sub=k + 1, mjd=round(exps[k].mjd, 6), x=round(q["x"], 3), y=round(q["y"], 3), ra=round(q["ra"], 7),
                      dec=round(q["dec"], 7), snr=round(q["snr"], 1), flux_ujy=round(q["flux"] * BL.PIXEL_UJY, 1),
                      ex=q["ex"], ey=q["ey"])
            if rec["match"] is not None:
                jj = rec["match"]
                de = ((q["ra"] - float(pred[k][0][jj]) + 180) % 360 - 180) * math.cos(math.radians(q["dec"])) * 3600
                dn = (q["dec"] - float(pred[k][1][jj])) * 3600
                dd.update(off_e=round(de, 2), off_n=round(dn, 2), off_arcsec=round(math.hypot(de, dn), 2),
                          off_px=round(math.hypot(de, dn) / PIX, 3))
                lam = exps[k].wavelength(q["x"], q["y"])
                dd["lam_um"] = None if lam is None else round(float(np.atleast_1d(lam)[0]), 4)
            rec["subs"].append(dd)
        sobjects.append(rec)
    # per known object (V <= V_ANALYSE in field): found / missed + reasons
    known = []
    by_obj = {}
    for b in boxes:
        by_obj.setdefault(b["obj"], []).append(b)
    for j in wanted:
        o = objs[j]
        recs = [r for r in objects if r.get("match") == j]
        bxs = [b for b in by_obj.get(j, []) if b.get("k") is not None and "dets" in b]
        fc = [b["forced"] for b in bxs if b.get("forced")]
        fsnr = None
        if fc:
            w = [1 / max(1e-12, c["eflux"]) ** 2 for c in fc]
            fl = sum(c["flux"] * wi for c, wi in zip(fc, w)) / sum(w)
            fsnr = fl * math.sqrt(sum(w))
        rec = dict(idx=j, name=o["name"], number=o["number"], cls=o["cls"], V=o["vmag"], H=None if o["H"] is None
                   else round(o["H"], 2), err_arcsec=o["err_arcsec"], dg=o["dg"], dh=o["dh"], phase=o["phase_deg"],
                   elong=o["elong_deg"], rate_cosd_h=o["dra_cosd_h"], rate_dec_h=o["ddec_h"],
                   n_boxes=len(bxs), forced_snr=None if fsnr is None else round(fsnr, 1),
                   noise=round(float(np.median([b["noise"] for b in bxs if b.get("noise")])), 5)
                   if any(b.get("noise") for b in bxs) else None,
                   ref_keys=next((b["ref_keys"] for b in bxs if b.get("ref_keys")), []),
                   n_ref=max([b.get("n_ref", 0) for b in bxs], default=0),
                   lam_um=next((b["lam_um"] for b in bxs if b.get("lam_um")), None),
                   predicted=[dict(sub=k + 1, x=round(float(pix[k][0][j]), 2), y=round(float(pix[k][1][j]), 2),
                                   ra=round(float(pred[k][0][j]), 7), dec=round(float(pred[k][1][j]), 7))
                              for k in range(nk)])
        if recs:
            r = max(recs, key=lambda r: r["n_exp"])
            offs = [d["off_px"] for d in r["dets"] if "off_px" in d]
            rec.update(found=True, n_det=r["n_exp"], off_px_median=round(float(np.median(offs)), 3),
                       off_px_max=round(float(np.max(offs)), 3),
                       flux_ujy=round(float(np.median([d["flux_ujy"] for d in r["dets"]])), 1),
                       snr=round(float(np.max([d["snr"] for d in r["dets"]])), 1), dets=r["dets"],
                       rate_measured=r["rate_measured"])
        else:
            rec.update(found=False, reason=miss_reason(o, bxs, fsnr, objects, j))
        srec = [q for q in sobjects if q.get("match") == j]
        if srec:
            q = max(srec, key=lambda q: q["snr"])
            so = [d["off_px"] for d in q["subs"] if "off_px" in d]
            rec.update(found_stack=True, stack=dict(off_px=q["off_px"], off_arcsec=q["off_arcsec"], snr=q["snr"],
                                                    flux_ujy=q["flux_ujy"], n_sub=q["n_sub"],
                                                    sub_off_px_median=round(float(np.median(so)), 3) if so else None,
                                                    sub_off_px_max=round(float(np.max(so)), 3) if so else None,
                                                    subs=q["subs"]))
        else:
            rec["found_stack"] = False
        known.append(rec)
    n_area = sum(area)
    unmatched = [r for r in objects if r.get("match") is None and r["confirmed"]]
    singles = [r for r in objects if not r["confirmed"]]
    return dict(field=f, n_cone=len(objs), n_on_detector=len(in_field), n_boxed=len(wanted),
                area_px=n_area, area_deg2_per_exposure=round(n_area / nk * (PIX / 3600) ** 2, 4),
                psf=sorted({b.get("psf") for b in boxes if b.get("psf")}),
                known=known, objects=objects, n_false=len(unmatched), n_single=len(singles),
                stack_objects=sobjects, n_false_stack=sum(q["match"] is None for q in sobjects),
                noise_median=round(float(np.median([b["noise"] for b in boxes if b.get("noise")])), 5)
                if any(b.get("noise") for b in boxes) else None,
                area_px_stack=sum(b.get("area_px", 0) for b in boxes if b.get("k") == "stack"),
                n_rejected_residuals=sum(b.get("n_rej", 0) for b in boxes if b.get("k") != "stack"),
                n_rejected_residuals_stack=sum(b.get("n_rej", 0) for b in boxes if b.get("k") == "stack"),
                exposures=[dict(obs_id=s["obs_id"], key=s["key"], mjd=e.mjd, sc_km=[round(v, 1) for v in e.sc_km],
                                psf_fwhm=e.psf_fwhm_arcsec) for s, e in zip(f["subs"], exps)],
                objs_all=[dict(name=o["name"], number=o["number"], V=o["vmag"]) for o in objs])


def miss_reason(o, bxs, fsnr, objects, j):
    if not bxs:
        return "edge (outside the detector in every sub-exposure)"
    if all(b.get("n_ref", 0) < 2 for b in bxs):
        return "no usable references (fewer than 2 reference images of this sky)"
    if (o.get("err_arcsec") or 0) > 2 * PIX:
        return f"ephemeris uncertainty large ({o['err_arcsec']:.0f}\")"
    if sum(bool(b.get("nan_near")) for b in bxs) >= max(1, len(bxs) // 2):
        return "masked pixels at the position (saturated star core / bad pixels)"
    bright = [r for r in objects if (r.get("match_rejected") or {}).get("idx") == j]
    if bright:
        return (f"a brighter source at the position ({-bright[0]['match_rejected']['ab_minus_v']:.1f} mag brighter than "
                f"the asteroid's V): bright static source, not the asteroid")
    single = [r for r in objects if r.get("match_single") == j]
    if single:
        return "seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3)"
    rej = [w for b in bxs for w in (b.get("rej_near") or [])[:1]]
    if rej:
        why = max(set(rej), key=rej.count)
        n = len(rej)
        if why == "static-source residual":
            return f"on a bright static source: its excess was rejected as a static-source residual in {n} sub-exposure(s)"
        if why == "not PSF-shaped":
            return f"not PSF-shaped: found but rejected by the EPSF chi2 cut in {n} sub-exposure(s)"
        return f"bad subtraction at the position ({why} in {n} sub-exposure(s))"
    st = [b.get("static_flux") for b in bxs if b.get("static_flux") is not None]
    if fsnr is not None and fsnr >= Z_CONFIRM:
        if st and np.median(st) > 0 and any((b.get("forced") or {}).get("flux", 0) > 0 for b in bxs) and \
                np.median(st) > 5 * max(1e-9, np.median([(b.get("forced") or {}).get("flux", 0) for b in bxs])):
            return f"bright static source under it (forced S/N {fsnr:.1f}, below the per-exposure threshold)"
        return f"forced S/N {fsnr:.1f} over the sub-exposures, below the per-exposure detection threshold"
    if st and np.median(st) > 0 and fsnr is not None and fsnr < Z_CONFIRM and np.median(st) > 20 * max(
            [b.get("noise") or 0 for b in bxs]):
        return f"too faint next to a bright static source (forced S/N {fsnr:.1f})"
    if fsnr is not None and fsnr <= -Z_CONFIRM:
        return f"bad subtraction at the position (forced S/N {fsnr:.1f}: star residual or reference artefact)"
    return f"too faint (forced S/N {fsnr:.1f})" if fsnr is not None else "too faint"


# =============================================================================== tracklets
def cross_visit(f, objs, mjd0, res, max_objects=40):
    """For recovered objects: the nearest other visit of the same detector within TRACK_DAYS
    covering the predicted position; detect blindly there, link with the visit's own measured
    motion (not the ephemeris), compare the long-arc rate with the ephemeris."""
    out = []
    det = f["detector"]
    found = [k for k in res["known"] if k.get("found") or k.get("found_stack")][:max_objects]
    for k in found:
        try:
            out.extend(_cross_one(f, objs, mjd0, res, k, det))
        except Exception as ex:
            out.append(dict(name=k["name"], status=f"error {type(ex).__name__}: {ex}"))
    return out


def _cross_one(f, objs, mjd0, res, k, det):
    """Tracklet of one recovered object (list with one record)."""
    out = []
    for _once in (0,):
        j = k["idx"]
        o = objs[j]
        dets1 = k["dets"] if k.get("found") else k["stack"]["subs"]
        if not dets1:
            continue
        p0 = dets1[0]
        visits = {}
        for r in SI.find_images(p0["ra"], p0["dec"], margin=0.0):
            if r["detector"] != det or not (0.02 < abs(r["mjd"] - mjd0) <= TRACK_DAYS):
                continue
            visits.setdefault(r["obs_id"].rsplit("_", 1)[0], []).append(r)
        if not visits:
            out.append(dict(name=o["name"], status="no other visit within %.1f d" % TRACK_DAYS))
            continue
        vid, subs = min(visits.items(), key=lambda kv: abs(kv[1][0]["mjd"] - mjd0))
        subs.sort(key=lambda r: r["obs_id"])
        mjd1 = subs[0]["mjd"]
        # ephemeris at the new time (fresh SkyBoT cone, small radius around the extrapolated position)
        ra1, dec1 = EPH.at_time(o, mjd0, mjd1)
        o1s = EPH.cone(mjd1 + S3.EXPOSURE_HALF_DAYS, ra1, dec1, 0.15)
        o1 = None
        for c in o1s or []:
            if c["name"] == o["name"]:
                o1 = c
        if o1 is None:
            out.append(dict(name=o["name"], status="ephemeris at the second visit not found"))
            continue
        vis = [dict(obs_id=r["obs_id"], key=r["s3_key"]) for r in subs]
        exps, pred, pix, boxes = process_visit(vis, [o1], mjd1 + S3.EXPOSURE_HALF_DAYS, [0], log_prefix=f["id"] + "T")
        dets_k = [dedupe(sum([b["dets"] for b in boxes if b.get("k") == kk and "dets" in b], []))
                  for kk in range(len(exps))]
        for b in boxes:                      # per-sub-exposure fits of visit-stack detections
            if b.get("k") == "stack":
                for sd in b["stack"]:
                    for q in sd["subs"]:
                        dets_k[q["k"]].append(dict(q, z=sd["z"]))
        dets_k = [dedupe(d) for d in dets_k]
        # blind linking: predict from the first visit's own detections and measured rate
        rm = k.get("rate_measured") if k.get("found") else rate_fit([dict(d) for d in dets1])
        last = dets1[-1]
        cands = []
        for kk, dl in enumerate(dets_k):
            for d in dl:
                dt_h = (exps[kk].mjd - last["mjd"]) * 24
                if rm:
                    pe = last["ra"] + rm["ra_cosd"] * dt_h / 3600 / math.cos(math.radians(last["dec"]))
                    pn = last["dec"] + rm["dec"] * dt_h / 3600
                    gate = 3 * PIX + 3 * rm["err"] * abs(dt_h) * 1.5
                else:
                    pe, pn, gate = last["ra"], last["dec"], 600.0
                sep = SC.sep_arcsec(d["ra"], d["dec"], pe, pn)
                if sep <= gate:
                    cands.append((sep, kk, d))
        if not cands:
            out.append(dict(name=o["name"], status="not detected in the second visit", visit2=vid,
                            dt_h=round((mjd1 - mjd0) * 24, 2)))
            continue
        # anchor = the candidate closest to the linking prediction; refit the motion with it and keep
        # the second-visit detections within LINK_PX of the refined track (one per sub-exposure).
        # A link needs >= 2 consistent detections in the second visit (as in the first visit).
        base = [dict(ra=d["ra"], dec=d["dec"], mjd=d["mjd"], ex=0.2, ey=0.2) for d in dets1]
        best = {}
        for sep0, kk_a, da in sorted(cands, key=lambda c: c[0]):
            ra_ = rate_fit(base + [dict(ra=da["ra"], dec=da["dec"], mjd=exps[kk_a].mjd, ex=da["ex"], ey=da["ey"])])
            if not ra_:
                continue
            sel = {}
            for sep, kk, d in cands:
                dt_h = (exps[kk].mjd - exps[kk_a].mjd) * 24
                pe = da["ra"] + ra_["ra_cosd"] * dt_h / 3600 / math.cos(math.radians(da["dec"]))
                pn = da["dec"] + ra_["dec"] * dt_h / 3600
                q = SC.sep_arcsec(d["ra"], d["dec"], pe, pn) / PIX
                if q <= LINK_PX and (kk not in sel or q < sel[kk][0]):
                    sel[kk] = (q, d)
            if len(sel) >= 2:
                best = sel
                break
        if len(best) < 2:
            out.append(dict(name=o["name"], status="not confirmed in the second visit (< 2 consistent detections)",
                            visit2=vid, dt_h=round((mjd1 - mjd0) * 24, 2)))
            continue
        pts = [dict(dd, mjd=exps[kk].mjd) for kk, (sep, dd) in sorted(best.items())]
        allp = [dict(ra=d["ra"], dec=d["dec"], mjd=d["mjd"], ex=0.2, ey=0.2) for d in dets1] + \
               [dict(ra=d["ra"], dec=d["dec"], mjd=d["mjd"], ex=d["ex"], ey=d["ey"]) for d in pts]
        rf = rate_fit(allp)
        # ephemeris rate between the two visits from the two predicted topocentric positions
        pa = (k["predicted"][0]["ra"], k["predicted"][0]["dec"], res["exposures"][0]["mjd"])
        kk0 = sorted(best)[0]
        pb = (float(pred[kk0][0][0]), float(pred[kk0][1][0]), exps[kk0].mjd)
        dt = (pb[2] - pa[2]) * 24
        cosd = math.cos(math.radians(pa[1]))
        er = (((pb[0] - pa[0] + 180) % 360 - 180) * cosd * 3600 / dt, (pb[1] - pa[1]) * 3600 / dt)
        offs = []
        for kk, (sep, d) in sorted(best.items()):
            pr, pd = pred[kk]
            offs.append(SC.sep_arcsec(d["ra"], d["dec"], float(pr[0]), float(pd[0])))
        if rf:
            dr = math.hypot(rf["ra_cosd"] - er[0], rf["dec"] - er[1])
            sp_m, sp_e = math.hypot(rf["ra_cosd"], rf["dec"]), math.hypot(*er)
            pa_m = math.degrees(math.atan2(rf["ra_cosd"], rf["dec"])) % 360
            pa_e = math.degrees(math.atan2(er[0], er[1])) % 360
        out.append(dict(name=o["name"], status="linked", visit2=vid, dt_h=round(dt, 3), n_det2=len(pts),
                        off2_px=[round(v / PIX, 3) for v in offs],
                        rate_measured=dict(ra_cosd=round(rf["ra_cosd"], 3), dec=round(rf["dec"], 3),
                                           speed=round(sp_m, 3), pa=round(pa_m, 2)) if rf else None,
                        rate_ephem=dict(ra_cosd=round(er[0], 3), dec=round(er[1], 3), speed=round(sp_e, 3),
                                        pa=round(pa_e, 2)),
                        rate_diff_arcsec_h=round(dr, 3) if rf else None,
                        rate_diff_frac=round(dr / sp_e, 4) if rf and sp_e > 0 else None,
                        pa_diff_deg=round(((pa_m - pa_e + 180) % 360) - 180, 2) if rf else None,
                        dets2=[dict(sub=kk + 1, mjd=round(d["mjd"], 6), ra=round(d["ra"], 7), dec=round(d["dec"], 7),
                                    x=round(d["x"], 2), y=round(d["y"], 2), snr=round(d["snr"], 1),
                                    flux_ujy=round(d["flux"] * BL.PIXEL_UJY, 1),
                                    pred_ra=round(float(pred[kk][0][0]), 7), pred_dec=round(float(pred[kk][1][0]), 7),
                                    off_px=round(SC.sep_arcsec(d["ra"], d["dec"], float(pred[kk][0][0]),
                                                               float(pred[kk][1][0])) / PIX, 3),
                                    key=vis[kk]["key"]) for kk, d in zip(sorted(best), pts)]))
        log(f"  {f['id']} tracklet {o['name']}: dt {dt:.2f} h, rate meas {out[-1]['rate_measured']} vs ephem "
            f"{out[-1]['rate_ephem']}")
    return out


# =============================================================================== CLI
def ledger_add(nbytes_s3, nreq, nbytes_sky, note):
    import fcntl
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with open(LEDGER.with_suffix(".lock"), "w") as lk:            # two run processes may finish together
        fcntl.flock(lk, fcntl.LOCK_EX)
        return _ledger_add(nbytes_s3, nreq, nbytes_sky, note)


def _ledger_add(nbytes_s3, nreq, nbytes_sky, note):
    d = {"runs": []}
    if LEDGER.exists():
        try:
            d = json.loads(LEDGER.read_text())
        except ValueError:
            pass
    d["runs"].append(dict(t=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), s3_bytes=nbytes_s3, s3_requests=nreq,
                          skybot_bytes=nbytes_sky, note=note))
    d["total_s3_bytes"] = sum(r["s3_bytes"] for r in d["runs"])
    d["total_s3_requests"] = sum(r["s3_requests"] for r in d["runs"])
    d["total_skybot_bytes"] = sum(r["skybot_bytes"] for r in d["runs"])
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(d, indent=1))
    return d


def _jsonable(o):
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items() if not str(k).startswith("_")}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def main(argv=None):
    ap = argparse.ArgumentParser(description="Recover known asteroids in SPHEREx ecliptic fields")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select")
    s.add_argument("--n", type=int, default=24)
    r = sub.add_parser("run")
    r.add_argument("--only", default="")
    r.add_argument("--max-fields", type=int, default=0)
    r.add_argument("--no-track", action="store_true")
    r.add_argument("--redo", action="store_true", help="recompute fields whose run file exists (new file name)")
    r.add_argument("--redo-before", default="", help="with --redo: only fields whose newest run file is older than "
                   "this local time (YYYY-mm-ddTHH:MM), so an interrupted redo resumes where it stopped")
    t = sub.add_parser("track", help="tracklets across visits for finished fields -> runs/T##.json")
    t.add_argument("--only", default="")
    rp = sub.add_parser("report")
    rp.add_argument("--site", action="store_true", help="write to site/data/asteroids/ (else cache/asteroids/report/)")
    rp.add_argument("--replace", action="store_true", help="with --site: replace summary.json / candidates.json and the "
                    "Results section of pipeline/ASTEROIDS.md (default: never overwrite, new timestamped names)")
    b = sub.add_parser("blink")
    b.add_argument("--field", required=True)
    b.add_argument("--name", required=True)
    b.add_argument("--site", action="store_true")
    a = ap.parse_args(argv)
    warnings.simplefilter("ignore")
    if a.cmd == "select":
        if FIELDS.exists():
            sys.exit(f"{FIELDS} exists (not overwritten)")
        fields = select_fields(a.n)
        FIELDS.parent.mkdir(parents=True, exist_ok=True)
        FIELDS.write_text(json.dumps(fields, indent=1))
        log(f"{len(fields)} fields -> {FIELDS}")
    elif a.cmd == "run":
        fields = json.loads(FIELDS.read_text())
        only = [x for x in a.only.split(",") if x]
        todo = [f for f in fields if not only or f["id"] in only]
        if a.max_fields:
            todo = todo[:a.max_fields]
        RUNS.mkdir(parents=True, exist_ok=True)
        cutoff = time.mktime(time.strptime(a.redo_before, "%Y-%m-%dT%H:%M")) if a.redo_before else None
        for f in todo:
            path = RUNS / f"{f['id']}.json"
            if path.exists() and not a.redo:
                log(f"{f['id']}: done ({path.name})")
                continue
            if path.exists() and cutoff:
                newest = max([path] + list(RUNS.glob(f"{f['id']}_*.json")), key=lambda q: q.stat().st_mtime)
                if newest.stat().st_mtime >= cutoff:
                    log(f"{f['id']}: already redone ({newest.name})")
                    continue
            if path.exists():
                path = RUNS / f"{f['id']}_{time.strftime('%Y%m%dT%H%M%S')}.json"
            b0, q0, e0 = S3.bytes_downloaded(), S3.STATS.requests, EPH.BYTES["net"]
            try:
                res = run_field(f, track=not a.no_track)
            except Exception as ex:
                # not written as a result: a later 'run' retries this field (cached ranges are reused)
                import traceback
                traceback.print_exc()
                (RUNS / f"err_{f['id']}_{time.strftime('%Y%m%dT%H%M%S')}.txt").write_text(
                    f"{type(ex).__name__}: {ex}\n{traceback.format_exc()}")
                ledger_add(S3.bytes_downloaded() - b0, S3.STATS.requests - q0, EPH.BYTES["net"] - e0, f["id"] + " failed")
                continue
            tmp = path.with_suffix(".part")
            tmp.write_text(json.dumps(_jsonable(res), indent=1))
            os.replace(tmp, path)
            led = ledger_add(S3.bytes_downloaded() - b0, S3.STATS.requests - q0, EPH.BYTES["net"] - e0, f["id"])
            kn = res.get("known", [])
            log(f"{f['id']}: found {sum(k['found'] for k in kn)}/{len(kn)} (V<={V_ANALYSE}), false {res.get('n_false')}, "
                f"{(S3.bytes_downloaded() - b0) / 1e6:.2f} MB S3 this field, total ledger "
                f"{led['total_s3_bytes'] / 1e6:.1f} MB S3 + {led['total_skybot_bytes'] / 1e6:.1f} MB SkyBoT")
    elif a.cmd == "track":
        fields = json.loads(FIELDS.read_text())
        only = [x for x in a.only.split(",") if x]
        for f in fields:
            if only and f["id"] not in only:
                continue
            srcs = sorted(RUNS.glob(f"{f['id']}.json")) + sorted(RUNS.glob(f"{f['id']}_*.json"))
            if not srcs:
                continue
            src = max(srcs, key=lambda q: q.stat().st_mtime)          # newest run of the field
            dst = RUNS / f"T_{src.stem}.json"
            if dst.exists():
                continue
            res = json.loads(src.read_text())
            b0, q0, e0 = S3.bytes_downloaded(), S3.STATS.requests, EPH.BYTES["net"]
            mjd0 = res["exposures"][0]["mjd"]
            objs = EPH.cone(mjd0, f["ra"], f["dec"], R_CONE)
            try:
                tr = cross_visit(f, objs, mjd0, res)
            except Exception as ex:
                log(f"{f['id']} tracklets failed: {type(ex).__name__}: {ex}")
                continue
            tmp = dst.with_suffix(".part")
            tmp.write_text(json.dumps(_jsonable({"field": f["id"], "tracklets": tr}), indent=1))
            os.replace(tmp, dst)
            ledger_add(S3.bytes_downloaded() - b0, S3.STATS.requests - q0, EPH.BYTES["net"] - e0, f["id"] + " tracklets")
            log(f"{f['id']}: {sum(t.get('status') == 'linked' for t in tr)}/{len(tr)} tracklets linked")
    elif a.cmd == "report":
        from . import asteroid_report
        asteroid_report.main(site=a.site, replace=a.replace)
    elif a.cmd == "blink":
        from . import asteroid_report
        asteroid_report.blink(a.field, a.name, site=a.site)
        led = ledger_add(S3.bytes_downloaded(), S3.STATS.requests, 0, f"blink {a.field} {a.name}")


if __name__ == "__main__":
    main()
