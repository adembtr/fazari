#!/usr/bin/env python3
"""Faint-object mode (Fazari): float frames for the viewer, deep stacks, depth numbers.

What it writes (all NEW files, in <out>/faint/; nothing else in <out> is touched):
  faint.json             index read by site/js/faint_view.js (format below), depth table
  frames_<lam>um.bin     per wavelength bin, the blink frames as float data: for every season
                         frame of the bin (meta.json order) 3 planes of float16 (little endian),
                         value (MJy/sr), sigma (MJy/sr), PSF-matched S/N
  deep_<season>.bin      per season, the deep stack (all wavelengths) with the same 3 planes
  deep_<season>.png      quick-look PNG of the deep stack (asinh, same grid as the frames)
Planes are on the blink.py grid (TAN, 3"/px, 180 x 180, centred on the target at 2026.0), in
PNG order: row 0 = north, column 0 = east. NaN = no data, +inf = saturated core.

Method (pipeline/FAINT.md has the numbers)
  - every cutout is read and cleaned exactly as in blink.py (ZODI subtracted, FLAGS bad bits
    -> NaN, saturated pixels kept apart, residual median offset removed) and resampled to the
    grid with the same bilinear interpolation (reproject's edge handling)
  - frames: the median stack of the files listed for that frame in meta.json (identical to the
    PNG); sigma = sqrt(pi/2 / sum(1/var_i)) scaled to the measured pixel scatter
  - deep stack: all exposures of a season inside a wavelength range; per detector a 5 sigma
    clip about the median (tolerance = sqrt(var + (0.05 median)^2)), then an inverse-variance
    mean over all detectors; sigma = sqrt(1/sum(1/var_i)) scaled to the measured scatter
  - point-source statistic: matched filter with the effective PSF on the grid (the exposure's
    own EPSF, injected at the grid centre and resampled exactly like the data), after a 45"
    mesh background; F = corr(I/V, K) / corr(1/V, K^2) is the EPSF flux in uJy (the same flux
    scale as blink.py's forced photometry), its noise is MEASURED as the robust scatter of F
    at blank positions (so correlated noise and source confusion are included)

Usage (from fazari/):
  uv run --no-project --with astropy --with reproject --with numpy --with scipy \
      --with matplotlib --with pillow python -I pipeline/faint.py barnard
  ... python -I pipeline/faint.py --job <id>           (local-engine job folder)
Output folder: $FAZARI_OUT/<target>/faint, else site/data/<target>/faint. Existing files in it
are never overwritten (the run stops) unless --overwrite is given (used for engine jobs).
"""
import argparse
import json
import math
import os
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blink as BL  # noqa: E402

SCHEMA = "fazari-faint/1"
CLIP_SIGMA = 5.0            # per-detector outlier clip in the deep stacks
CLIP_MODEL = 0.05           # fractional term of the clip tolerance (colour / PSF changes)
KERNEL_R = 10               # effective PSF kernel half size (grid px): +-30" (EPSF covers +-20")
MESH = 15                   # background mesh (grid px = 45")
SAMPLE_STEP = 3             # blank-position lattice for the noise measurement (grid px)
EDGE_PX = 10                # keep the noise samples this far from the data edge (grid px)
SAT_PAD = 6                 # ... and from saturated cores (grid px)
F16_MAX = 65000.0
RANGES = {"all": (0.0, 9.9), "short": (0.70, 2.42), "long": (2.42, 5.10), "1-3um": (1.0, 3.0)}
AB_ZP_UJY = 23.9            # AB magnitude of 1 uJy


def ab_mag(ujy):
    return round(AB_ZP_UJY - 2.5 * math.log10(ujy), 2) if ujy and ujy > 0 else None


def robust_sigma(a):
    return BL.robust_sigma(a)


# ------------------------------------------------------------------------------------- reading
def read_exposure(path, ra_c, dec_c):
    """One cutout -> exposure dict with blink.py's '_px' layout (so blink.forced_phot works)."""
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        img = h["IMAGE"].data.astype(np.float64)
        flg = h["FLAGS"].data.astype(np.int64)
        var = h["VARIANCE"].data.astype(np.float64)
        zodi = h["ZODI"].data.astype(np.float64)
        wcs = WCS(hd)
        swcs = WCS(hd, fobj=h, key="W")
        swcs.sip = None
        mjd = float(hd.get("MJD-AVG", hd["MJD-OBS"]))
        orient = math.degrees(math.atan2(hd["PC2_1"], hd["PC1_1"])) % 360
        tab = h["EPSF"].data
        ovs = int(h["EPSF"].header.get("OVSMPX", 5))
        det_off = (1 - hd.get("CRPIX1A", 1.0), 1 - hd.get("CRPIX2A", 1.0))
        det = int(hd["DETECTOR"])
        ny, nx = img.shape
        x, y = (float(v) for v in wcs.all_world2pix(ra_c, dec_c, 0))
        xs, ys = min(max(x, 0), nx - 1), min(max(y, 0), ny - 1)
        lam = float(swcs.pixel_to_world_values(xs, ys)[0])
        k = int(np.argmin((tab["XCENTER"] - (xs + det_off[0])) ** 2 + (tab["YCENTER"] - (ys + det_off[1])) ** 2))
        psf = np.asarray(tab["EPSF"][k], float)
    sat = (flg & BL.SAT_BITS) != 0
    bad = ((flg & BL.BAD_BITS) != 0) & ~sat
    clean = img - zodi
    clean[bad] = np.nan
    good = np.isfinite(clean) & ~sat
    if good.sum() < 0.3 * good.size:
        return None
    clean -= np.nanmedian(clean[good])
    good_ph = good & np.isfinite(var) & (var > 0)
    detector = f"D{det}"
    return dict(file=path.name, path=path, collection=path.parent.name, mjd=mjd,
                jyear=float(Time(mjd, format="mjd").jyear), date=Time(mjd, format="mjd").iso[:10],
                detector=detector, det=det, wavelength_um=lam, bin_um=BL.which_bin(lam, detector),
                orient_deg=orient, x=x, y=y, inside=bool(0 <= x < nx and 0 <= y < ny),
                _px=dict(clean=clean.astype(np.float32), var=np.where(good_ph, var, np.inf).astype(np.float32),
                         good=good_ph, sat=sat, satnan=sat | ~np.isfinite(img), wcs=wcs, det_off=det_off,
                         psf=BL.prep_psf(psf), ovs=ovs))


def load_exposures(data_dir, ra_c, dec_c, files=None, log=print):
    """All cutouts of a field (data_dir/{dr1,qr3}/*.fits) with season and visit labels."""
    data_dir = Path(data_dir)
    if files is None:
        files = sorted(p for c in BL.COLLECTIONS for p in (data_dir / c).glob("*.fits") if (data_dir / c).is_dir())
    lst = {}
    for col in BL.COLLECTIONS:
        p = data_dir / f"liste_{col}.csv"
        if p.exists():
            import csv
            with open(p, newline="") as f:
                for r in csv.DictReader(f):
                    u = r.get("access_url", "")
                    if u.endswith(".fits"):
                        lst[u.rsplit("/", 1)[-1]] = r
    exps = []
    t0 = time.time()
    for p in files:
        try:
            e = read_exposure(p, ra_c, dec_c)
        except Exception as ex:                      # e.g. a file still being written
            log(f"  skip {p.name}: {ex}")
            continue
        if e is None:
            continue
        row = lst.get(p.name, {})
        e["mjd_t"] = float(row["t_min"]) if row.get("t_min") else e["mjd"]
        exps.append(e)
    if not exps:
        return exps
    ep = BL.split_epochs([e["mjd_t"] for e in exps])
    for e in exps:
        e["epoch"] = ep[e["mjd_t"]]
    order = sorted(range(len(exps)), key=lambda k: exps[k]["mjd"])
    v, last = -1, None
    for k in order:                                  # visit: mid-times within 20 min
        if last is None or (exps[k]["mjd"] - last) * 1440 > 20:
            v += 1
        exps[k]["visit"] = v
        last = exps[k]["mjd"]
    exps.sort(key=lambda e: (e["mjd"], e["det"]))
    log(f"  read {len(exps)} exposures in {time.time() - t0:.1f} s")
    return exps


# ------------------------------------------------------------------------------------- grid
class Grid:
    """The blink.py frame grid (TAN, 3"/px, 0.15 deg, centred on the target at 2026.0)."""

    def __init__(self, ra_c, dec_c):
        self.wcs, shape = BL.make_grid(ra_c, dec_c)
        self.n = shape[0]
        self.ra, self.dec = ra_c, dec_c
        self.pix = BL.PIX_ARCSEC
        yy, xx = np.mgrid[:self.n, :self.n]
        self.world = self.wcs.all_pix2world(xx.ravel(), yy.ravel(), 0)
        self.c = self.n // 2                          # kernel reference pixel (a pixel centre)

    def offset_pix(self, de, dn):
        """Sky offset (east, north arcsec) -> grid pixel offset (dx, dy). x grows to the WEST."""
        return -np.asarray(de) / self.pix, np.asarray(dn) / self.pix

    def to_pix(self, ra, dec):
        x, y = self.wcs.all_world2pix(np.atleast_1d(ra), np.atleast_1d(dec), 0)
        return x, y

    def to_world(self, x, y):
        return self.wcs.all_pix2world(np.atleast_1d(x), np.atleast_1d(y), 0)


def resample(a, xy, cval=np.nan):
    """Bilinear resampling exactly like reproject_interp(order='bilinear'): values are defined at
    pixel centres, the outer half pixel is extended, beyond it = cval."""
    from scipy.ndimage import map_coordinates
    a = np.pad(np.asarray(a, np.float64), 1, mode="edge")
    x, y = xy
    v = map_coordinates(a, [y.ravel() + 1, x.ravel() + 1], order=1, mode="constant", cval=cval, prefilter=False)
    ny, nx = a.shape[0] - 2, a.shape[1] - 2
    out = (x.ravel() < -0.5) | (x.ravel() > nx - 0.5) | (y.ravel() < -0.5) | (y.ravel() > ny - 0.5)
    v[out] = cval
    return v.reshape(x.shape).astype(np.float32)


class Layers:
    """Per-exposure grid layers (cached): image (blink 'clean', saturated values kept), variance,
    saturation fraction, and the exposure's effective PSF kernel on the grid (uJy -> MJy/sr)."""

    def __init__(self, grid):
        self.grid = grid
        self._xy, self._lay, self._ker = {}, {}, {}

    def xy(self, e):
        k = e["file"]
        if k not in self._xy:
            x, y = e["_px"]["wcs"].all_world2pix(self.grid.world[0], self.grid.world[1], 0)
            n = self.grid.n
            self._xy[k] = (x.reshape(n, n), y.reshape(n, n))
        return self._xy[k]

    def get(self, e):
        k = e["file"]
        if k not in self._lay:
            px, xy = e["_px"], self.xy(e)
            img = resample(px["clean"], xy)
            var = resample(np.where(px["good"], px["var"], np.nan), xy)
            sat = resample(px["sat"].astype(np.float32), xy, cval=0.0)
            self._lay[k] = (img, var, sat)
        return self._lay[k]

    def kernel(self, e):
        """Effective PSF of a 1 uJy point source at the centre of grid pixel (c, c): the EPSF in
        native pixels (blink.epsf_kernels), resampled like the data. (2R+1)^2 array, MJy/sr."""
        k = e["file"]
        if k not in self._ker:
            self._ker[k] = source_on_grid(e, self.xy(e), self.grid, self.grid.c, self.grid.c, 1.0)[0]
        return self._ker[k]


def native_stamp(e, xs, ys, flux_ujy, R=7):
    """Native-pixel image (MJy/sr) of a point source of flux_ujy at native (xs, ys): (ix, iy, stamp)."""
    px = e["_px"]
    ix, iy = int(round(xs)), int(round(ys))
    k = BL.epsf_kernels(px, xs - ix, ys - iy, R)[0].reshape(2 * R + 1, 2 * R + 1)
    return ix, iy, k * (flux_ujy / BL.PIXEL_UJY)


def source_on_grid(e, xy, grid, gx, gy, flux_ujy, R=7, half=KERNEL_R):
    """A point source at grid position (gx, gy) (float) as it appears in exposure e after the
    resampling, on the (2 half + 1)^2 box around round(gx), round(gy). Returns (box, x0, y0)."""
    r, d = grid.to_world(gx, gy)
    xs, ys = (float(v[0]) for v in e["_px"]["wcs"].all_world2pix(r, d, 0))
    ix, iy, st = native_stamp(e, xs, ys, flux_ujy, R)
    x0, y0 = int(round(gx)) - half, int(round(gy)) - half
    n = grid.n
    bx = slice(max(x0, 0), min(x0 + 2 * half + 1, n))
    by = slice(max(y0, 0), min(y0 + 2 * half + 1, n))
    X, Y = xy[0][by, bx] - (ix - R), xy[1][by, bx] - (iy - R)
    out = np.zeros((2 * half + 1, 2 * half + 1), np.float32)
    if X.size:
        from scipy.ndimage import map_coordinates
        v = map_coordinates(np.pad(st, 1), [Y.ravel() + 1, X.ravel() + 1], order=1, mode="constant", cval=0.0,
                            prefilter=False).reshape(X.shape)
        out[by.start - y0:by.stop - y0, bx.start - x0:bx.stop - x0] = v
    return out, x0, y0


def add_box(img, box, x0, y0):
    """img[y0:y0+h, x0:x0+w] += box (clipped at the edges), in place."""
    n = img.shape[0]
    h, w = box.shape
    ys, xs = slice(max(y0, 0), min(y0 + h, n)), slice(max(x0, 0), min(x0 + w, n))
    if ys.stop > ys.start and xs.stop > xs.start:
        img[ys, xs] += box[ys.start - y0:ys.stop - y0, xs.start - x0:xs.stop - x0]


# ------------------------------------------------------------------------------------- stats
def mesh_background(img, valid, box=MESH):
    """Smooth background: 3-sigma clipped median in box x box blocks, 3x3 median of the mesh,
    bilinear back to full size (SExtractor-like)."""
    from scipy.ndimage import median_filter, map_coordinates
    n = img.shape[0]
    nb = int(math.ceil(n / box))
    a = np.full((nb * box, nb * box), np.nan, np.float64)
    a[:n, :n] = np.where(valid, img, np.nan)
    blk = a.reshape(nb, box, nb, box).transpose(0, 2, 1, 3).reshape(nb, nb, -1)
    med = np.full((nb, nb), np.nan)
    for i in range(nb):
        for j in range(nb):
            v = blk[i, j]
            v = v[np.isfinite(v)]
            if v.size < 0.3 * box * box:
                continue
            for _ in range(3):
                m, s = np.median(v), 1.4826 * np.median(np.abs(v - np.median(v)))
                if s <= 0:
                    break
                v = v[np.abs(v - m) < 3 * s]
            med[i, j] = 2.5 * np.median(v) - 1.5 * np.mean(v) if v.size > 5 else np.nan
    if not np.isfinite(med).any():
        return np.zeros_like(img)
    fill = np.nanmedian(med)
    for _ in range(nb):
        m = ~np.isfinite(med)
        if not m.any():
            break
        p = np.pad(med, 1, constant_values=np.nan)
        nbrs = np.stack([p[1 + dy:1 + dy + nb, 1 + dx:1 + dx + nb] for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
        with np.errstate(all="ignore"):
            mm = np.nanmean(nbrs, 0)
        med[m] = mm[m]
    med[~np.isfinite(med)] = fill
    med = median_filter(med, 3, mode="nearest")
    c = (np.arange(n) + 0.5) / box - 0.5
    yy, xx = np.meshgrid(c, c, indexing="ij")
    return map_coordinates(med, [yy, xx], order=1, mode="nearest").astype(np.float32)


def matched(img, var, K, valid=None, bg=True):
    """PSF flux map F (uJy), its formal error eF and the weight map phi for image/variance on the
    grid with effective kernel K (MJy/sr per uJy). Optional mesh background subtraction."""
    from scipy.signal import fftconvolve
    ok = np.isfinite(img) & np.isfinite(var) & (var > 0)
    if valid is not None:
        ok &= valid
    d = np.where(ok, img, 0.0)
    if bg:
        d = np.where(ok, d - mesh_background(img, ok), 0.0)
    w = np.where(ok, 1.0 / np.where(ok, var, 1.0), 0.0)
    psi = fftconvolve(d * w, K[::-1, ::-1], mode="same")
    phi = fftconvolve(w, (K * K)[::-1, ::-1], mode="same")
    good = phi > 1e-3 * np.nanmax(phi) if np.isfinite(phi).any() and np.nanmax(phi) > 0 else np.zeros_like(ok)
    F = np.where(good, psi / np.where(good, phi, 1.0), np.nan)
    eF = np.where(good, 1.0 / np.sqrt(np.where(good, phi, 1.0)), np.nan)
    return F.astype(np.float32), eF.astype(np.float32), np.where(good, phi, 0.0).astype(np.float32), \
        np.where(good, psi, 0.0).astype(np.float32)


def sample_mask(valid_cov, satany, n):
    """Blank-position lattice: well inside the covered area, away from saturated cores."""
    from scipy.ndimage import binary_erosion, binary_dilation
    inner = binary_erosion(valid_cov, iterations=EDGE_PX, border_value=0)
    if satany is not None and satany.any():
        inner &= ~binary_dilation(satany, iterations=SAT_PAD)
    lat = np.zeros((n, n), bool)
    lat[::SAMPLE_STEP, ::SAMPLE_STEP] = True
    return inner & lat


def noise_stats(img, var, K, satmask=None, cov=None):
    """Blind scatter of an image: pixel scatter (MJy/sr) and point-source flux scatter (uJy) at
    blank positions. In crowded fields this includes source confusion (faint stars everywhere)."""
    n = img.shape[0]
    ok = np.isfinite(img) & np.isfinite(var) & (var > 0)
    if cov is not None:
        ok &= cov
    F, eF, phi, _ = matched(img, var, K, ok)
    m = sample_mask(ok & (phi > 0), satmask, n) & np.isfinite(F)
    if m.sum() < 30:
        return None
    bgsub = img - mesh_background(img, ok)
    return dict(n_samples=int(m.sum()), pixel_sigma_mjysr=float(robust_sigma(bgsub[m])),
                flux_sigma_ujy=float(robust_sigma(F[m])), flux_sigma_formal_ujy=float(np.median(eF[m])),
                _m=m, _eF=eF)


def split_noise(a, b, K, satmask=None, cov=None):
    """Instrumental noise from two independent halves a, b (dicts img/var): D = a - b has no static
    sources, so its scatter is the noise alone. Returns the factors by which the formal pixel and
    PSF-flux errors must be multiplied (pixel_scale, psf_scale)."""
    n = a["img"].shape[0]
    D = a["img"] - b["img"]
    VD = a["var"] + b["var"]
    ok = np.isfinite(D) & np.isfinite(VD) & (VD > 0) & (VD < np.inf)
    if cov is not None:
        ok &= cov
    F, eF, phi, _ = matched(D, VD, K, ok, bg=True)
    m = sample_mask(ok & (phi > 0), satmask, n) & np.isfinite(F)
    if m.sum() < 30:
        return None
    zp = D / np.sqrt(np.where(ok, VD, np.nan))
    return dict(pixel_scale=float(robust_sigma(zp[m])), psf_scale=float(robust_sigma((F / eF)[m])), n_samples=int(m.sum()))


def halves(es):
    """Split exposures into two interleaved halves (per detector, in time order)."""
    a, b = [], []
    by = {}
    for e in sorted(es, key=lambda e: e["mjd"]):
        by.setdefault(e["det"], []).append(e)
    flip = False
    for det in sorted(by):
        for k, e in enumerate(by[det]):
            ((a if (k % 2 == 0) != flip else b)).append(e)
        flip = not flip if len(by[det]) % 2 else flip
    return a, b


# ------------------------------------------------------------------------------------- stacks
def deep_stack(exps, lay, sel_fn=None, clip=True):
    """Inverse-variance mean of the selected exposures with a per-detector median clip.
    Returns dict(img, var, n, satfrac, satany, K (weighted mean kernel), nexp, dets, lam) or None."""
    sel = [e for e in exps if sel_fn is None or sel_fn(e)]
    if not sel:
        return None
    n = lay.grid.n
    num = np.zeros((n, n))
    sw = np.zeros((n, n))
    cnt = np.zeros((n, n), np.int16)
    sats = np.zeros((n, n), np.float32)
    Kw, Kn = 0.0, 0.0
    by_det = {}
    for e in sel:
        by_det.setdefault(e["det"], []).append(e)
    for det, es in sorted(by_det.items()):
        I = np.stack([lay.get(e)[0] for e in es])
        V = np.stack([lay.get(e)[1] for e in es])
        S = np.stack([lay.get(e)[2] for e in es])
        ok = np.isfinite(I) & np.isfinite(V) & (V > 0) & (S < 0.25)
        I = np.where(ok, I, np.nan)
        if clip and len(es) >= 3:
            with np.errstate(all="ignore"):
                med = np.nanmedian(I, axis=0)
            tol = np.sqrt(np.where(ok, V, np.inf) + (CLIP_MODEL * np.abs(med)) ** 2)
            ok &= np.abs(I - med) < CLIP_SIGMA * tol
        W = np.where(ok, 1.0 / np.where(ok, V, 1.0), 0.0)
        num += (W * np.nan_to_num(I)).sum(0)
        sw += W.sum(0)
        cnt += ok.sum(0).astype(np.int16)
        sats += (S > 0.5).sum(0)
        for k, e in enumerate(es):
            wk = float(np.median(W[k][W[k] > 0])) if (W[k] > 0).any() else 0.0
            Kw = Kw + wk * lay.kernel(e)
            Kn += wk
    img = np.where(sw > 0, num / np.where(sw > 0, sw, 1), np.nan).astype(np.float32)
    var = np.where(sw > 0, 1.0 / np.where(sw > 0, sw, 1), np.inf).astype(np.float32)
    lam = [e["wavelength_um"] for e in sel]
    return dict(img=img, var=var, n=cnt, satfrac=sats / len(sel), satany=sats > 0, K=(Kw / Kn) if Kn else None,
                nexp=len(sel), dets=sorted({e["detector"] for e in sel}), lam=(min(lam), max(lam)),
                mjd=float(np.mean([e["mjd"] for e in sel])))


def median_frame(exps_by_file, files, lay):
    """The blink.py frame: nanmedian of the resampled exposures, blink's saturation mask; plus a
    sigma map sqrt(pi/2 / sum 1/var) (scaled later) and the mean kernel."""
    es = [exps_by_file[f] for f in files if f in exps_by_file]
    if not es:
        return None
    I = np.stack([lay.get(e)[0] for e in es])
    V = np.stack([lay.get(e)[1] for e in es])
    S = np.stack([lay.get(e)[2] for e in es])
    with np.errstate(all="ignore"):
        med = np.nanmedian(I, axis=0)
    satm = BL.clean_satmask(np.mean(S > 0.5, axis=0) > 0.5)
    okv = np.isfinite(I) & np.isfinite(V) & (V > 0)
    sw = np.where(okv, 1.0 / np.where(okv, V, 1.0), 0.0).sum(0)
    var = np.where(sw > 0, (math.pi / 2 if len(es) >= 3 else 1.0) / np.where(sw > 0, sw, 1), np.inf)
    K = np.mean([lay.kernel(e) for e in es], axis=0)
    return dict(img=med.astype(np.float32), var=var.astype(np.float32), satmask=satm, satany=(S > 0.5).any(0),
                K=K, nexp=len(es))


def planes(st, satmask, K, split=None):
    """value, sigma and the PSF-matched S/N planes. The formal errors are scaled by the
    instrumental noise factors of split_noise (two independent halves), so S/N is in units of the
    noise, not of the source confusion; without halves the blind scatter is used instead."""
    img, var = st["img"], st["var"]
    ok = np.isfinite(img) & np.isfinite(var) & (var > 0) & ~satmask
    sig = np.sqrt(np.where(ok, var, np.nan))
    F, eF, phi, _ = matched(img, var, K, ok)
    m = sample_mask(ok, satmask, img.shape[0])
    if split:
        scale, zscale, how = split["pixel_scale"], split["psf_scale"], "split halves"
    else:
        bg = mesh_background(img, ok)
        scale = robust_sigma(((img - bg) / sig)[m]) if m.sum() > 50 else 1.0
        zscale = robust_sigma((F / eF)[m & np.isfinite(F)]) if m.sum() > 50 else 1.0
        how = "blind scatter"
    scale = float(scale) if np.isfinite(scale) and scale > 0 else 1.0
    zscale = float(zscale) if np.isfinite(zscale) and zscale > 0 else 1.0
    sig = sig * scale
    zf = F / (eF * zscale)
    value = np.where(satmask, np.inf, img)
    return value, sig, zf, dict(sigma_scale=round(scale, 3), psf_snr_scale=round(zscale, 3), noise_from=how,
                                median_mjysr=float(np.nanmedian(img[ok])) if ok.any() else None,
                                pixel_sigma_mjysr=float(np.nanmedian(sig[m])) if m.any() else None,
                                psf_flux_sigma_ujy=float(np.nanmedian((eF * zscale)[m])) if m.any() else None)


def to_f16(a):
    a = np.asarray(a, np.float64)
    out = np.where(np.isfinite(a), np.clip(a, -F16_MAX, F16_MAX), a)
    return np.flipud(out).astype("<f2")                 # PNG order: row 0 = north


def write_new(path, data, overwrite=False):
    path = Path(path)
    if path.exists() and not overwrite:
        raise FileExistsError(f"{path} exists (faint outputs are never overwritten; use a new folder)")
    tmp = path.with_name(path.name + ".part")
    if isinstance(data, (bytes, bytearray)):
        tmp.write_bytes(data)
    else:
        tmp.write_text(data)
    tmp.replace(path)


def quicklook_png(value, path, lo=None, hi=None, overwrite=False):
    """asinh PNG of a value plane (already in PNG order), same scale rules as blink.py."""
    from PIL import Image
    v = np.asarray(value, np.float64)
    fin = v[np.isfinite(v)]
    med = np.median(fin)
    mad = 1.4826 * np.median(np.abs(fin - med))
    lo = med - 1.5 * mad if lo is None else lo
    hi = np.percentile(fin, 99.9) if hi is None else hi
    s = BL.stretch(np.where(np.isfinite(v), v, np.nan), lo, hi, 3 * mad)
    s = np.where(np.isposinf(v), 1.0, s)
    s = BL.fill_nan(s)
    g = (s * 255).astype(np.uint8)
    im = Image.fromarray(g).resize((g.shape[1] * BL.UPSCALE, g.shape[0] * BL.UPSCALE), Image.NEAREST)
    if Path(path).exists() and not overwrite:
        raise FileExistsError(path)
    im.save(path, optimize=True)


# ------------------------------------------------------------------------------------- driver
class FieldRun:
    """Everything faint mode needs for one field (target or engine job)."""

    def __init__(self, name, data_dir, out_dir, ra_c, dec_c, meta=None, target=None, log=print):
        self.name, self.data_dir, self.out_dir = name, Path(data_dir), Path(out_dir) if out_dir else None
        self.meta, self.target, self.log = meta, target or {}, log
        self.grid = Grid(ra_c, dec_c)
        self.lay = Layers(self.grid)
        self.exps = None

    def load(self, files=None):
        self.exps = load_exposures(self.data_dir, self.grid.ra, self.grid.dec, files=files, log=self.log)
        self.by_file = {e["file"]: e for e in self.exps}
        return self.exps

    def seasons(self):
        return sorted({e["epoch"] for e in self.exps})

    # ---- depth --------------------------------------------------------------------------
    def partner(self, e):
        """Same detector and season, another visit, nearest wavelength (for the pair difference)."""
        c = [o for o in self.exps if o["det"] == e["det"] and o["epoch"] == e["epoch"] and o["visit"] != e["visit"]]
        return min(c, key=lambda o: abs(o["wavelength_um"] - e["wavelength_um"])) if c else None

    def single_noise(self, max_per_det=40):
        """Noise of single exposures (up to max_per_det per detector, evenly spread in time):
        instrumental (pair difference with a partner exposure: static sources cancel) and blind
        (scatter of the exposure itself, source confusion included)."""
        rows = []
        by = {}
        for e in self.exps:
            by.setdefault(e["detector"], []).append(e)
        for det, es in sorted(by.items()):
            step = max(1, len(es) // max_per_det)
            for e in es[::step]:
                img, var, sat = self.lay.get(e)
                K = self.lay.kernel(e)
                satm = sat > 0.5
                ns = noise_stats(np.where(sat < 0.25, img, np.nan), var, K, satm)
                p = self.partner(e)
                if not ns or p is None:
                    continue
                i2, v2, s2 = self.lay.get(p)
                sp = split_noise(dict(img=np.where(sat < 0.25, img, np.nan), var=var),
                                 dict(img=np.where(s2 < 0.25, i2, np.nan), var=v2), K, satm | (s2 > 0.5))
                if not sp:
                    continue
                eF = float(np.median(ns["_eF"][ns["_m"]]))
                rows.append(dict(file=e["file"], detector=det, epoch=e["epoch"], wavelength_um=e["wavelength_um"],
                                 flux_sigma_ujy=sp["psf_scale"] * eF, flux_sigma_formal_ujy=eF,
                                 blind_flux_sigma_ujy=ns["flux_sigma_ujy"],
                                 pixel_sigma_mjysr=sp["pixel_scale"] * float(np.median(np.sqrt(var[ns["_m"]]))),
                                 blind_pixel_sigma_mjysr=ns["pixel_sigma_mjysr"], psf_scale=sp["psf_scale"]))
        return rows

    def deep_noise(self, es, K=None):
        """Deep stack of exposures es: instrumental noise (two interleaved halves) and blind scatter."""
        st = deep_stack(es, self.lay)
        if st is None:
            return None, None
        satm = BL.clean_satmask(st["satfrac"] > 0.3)
        cov = st["n"] >= max(1, int(0.3 * st["nexp"] / max(1, len(st["dets"]))))
        ns = noise_stats(st["img"], st["var"], st["K"], satm, cov)
        A, B = halves(es)
        sa, sb = deep_stack(A, self.lay), deep_stack(B, self.lay)
        sp = split_noise(sa, sb, st["K"], satm, cov) if sa and sb else None
        if not ns or not sp:
            return st, None
        eF = float(np.median(ns["_eF"][ns["_m"]]))
        # the halves have twice the variance of the full stack, so the same scale applies
        return st, dict(n_exposures=st["nexp"], detectors=st["dets"], lam_um=[round(st["lam"][0], 3), round(st["lam"][1], 3)],
                        flux_sigma_ujy=sp["psf_scale"] * eF, flux_sigma_formal_ujy=eF, psf_scale=sp["psf_scale"],
                        blind_flux_sigma_ujy=ns["flux_sigma_ujy"],
                        pixel_sigma_mjysr=sp["pixel_scale"] * float(np.median(np.sqrt(st["var"][ns["_m"]]))),
                        blind_pixel_sigma_mjysr=ns["pixel_sigma_mjysr"], _split=sp, _satm=satm)

    def depth_table(self, ranges=("all", "short", "long"), log=True):
        """Single exposure vs deep stack: measured noise and 5 sigma point-source limits."""
        single = self.single_noise()
        out = {"single": {}, "deep": [], "method": (
            "Point-source flux = PSF-matched flux with the effective EPSF on the 3\" grid (EPSF flux in uJy, the same "
            "scale as blink.py's forced photometry, EPSF footprint +-3.3 native px), after a 45\" mesh background. "
            "Noise is measured, not taken from VARIANCE: robust scatter (1.4826 MAD) at blank positions (3-px lattice, "
            ">= 10 px inside the data, >= 6 px from saturated cores). 'Instrumental' = from a difference image in which "
            "static sources cancel (single exposure: minus a partner exposure of the same detector and season at the "
            "nearest wavelength, divided by sqrt(2) via the formal errors; deep stack: two interleaved halves). 'Blind' = "
            "scatter of the image itself, which in crowded fields is dominated by source confusion. 5 sigma limit = 5 x "
            "instrumental noise; AB = 23.9 - 2.5 log10(uJy).")}
        for det in sorted({r["detector"] for r in single}) + ["all"]:
            rr = [r for r in single if det == "all" or r["detector"] == det]
            if not rr:
                continue
            med = lambda k: float(np.median([r[k] for r in rr]))
            s = med("flux_sigma_ujy")
            out["single"][det] = dict(n_measured=len(rr), flux_sigma_ujy=round(s, 2),
                                      flux_sigma_formal_ujy=round(med("flux_sigma_formal_ujy"), 2),
                                      blind_flux_sigma_ujy=round(med("blind_flux_sigma_ujy"), 2),
                                      pixel_sigma_mjysr=round(med("pixel_sigma_mjysr"), 4),
                                      blind_pixel_sigma_mjysr=round(med("blind_pixel_sigma_mjysr"), 4),
                                      limit5_ujy=round(5 * s, 1), limit5_ab=ab_mag(5 * s),
                                      blind_limit5_ujy=round(5 * med("blind_flux_sigma_ujy"), 1),
                                      blind_limit5_ab=ab_mag(5 * med("blind_flux_sigma_ujy")))
        sig1 = {r["file"]: r["flux_sigma_ujy"] for r in single}
        det_sigma = {d: v["flux_sigma_ujy"] for d, v in out["single"].items()}
        for s in self.seasons():
            for rg in ranges:
                lo, hi = RANGES[rg]
                es = [e for e in self.exps if e["epoch"] == s and lo <= e["wavelength_um"] < hi]
                if len(es) < 4:
                    continue
                st, ns = self.deep_noise(es)
                if not ns:
                    continue
                ideal = 1 / math.sqrt(sum(1 / sig1.get(e["file"], det_sigma.get(e["detector"], np.inf)) ** 2 for e in es))
                f = ns["flux_sigma_ujy"]
                row = dict(epoch=s, range=rg, **{k: (round(v, 4) if isinstance(v, float) else v)
                                                 for k, v in ns.items() if not k.startswith("_")},
                           ideal_flux_sigma_ujy=round(ideal, 3), limit5_ujy=round(5 * f, 2), limit5_ab=ab_mag(5 * f),
                           blind_limit5_ujy=round(5 * ns["blind_flux_sigma_ujy"], 1),
                           blind_limit5_ab=ab_mag(5 * ns["blind_flux_sigma_ujy"]),
                           gain_mag_vs_single=round(2.5 * math.log10(det_sigma["all"] / f), 2))
                out["deep"].append(row)
                if log:
                    self.log(f"  deep {s} {rg:5s} N={len(es):3d}: sigma_F {f:.2f} uJy (formal {ns['flux_sigma_formal_ujy']:.2f}, "
                             f"ideal {ideal:.2f}, blind {ns['blind_flux_sigma_ujy']:.1f}); 5 sigma {5 * f:.1f} uJy = AB "
                             f"{ab_mag(5 * f)}; gain {row['gain_mag_vs_single']} mag")
        if log:
            a = out["single"].get("all", {})
            self.log(f"  single exposure (median of {a.get('n_measured')}): sigma_F {a.get('flux_sigma_ujy')} uJy "
                     f"(blind {a.get('blind_flux_sigma_ujy')}), 5 sigma {a.get('limit5_ujy')} uJy = AB {a.get('limit5_ab')}")
        out["single_rows"] = single
        return out

    # ---- products -----------------------------------------------------------------------
    def products(self, overwrite=False, depth=True, ranges=("all", "short", "long")):
        od = self.out_dir / "faint"
        od.mkdir(parents=True, exist_ok=True)
        meta = self.meta or {}
        doc = {"schema": SCHEMA, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "target": meta.get("target", self.name), "ra": self.grid.ra, "dec": self.grid.dec,
               "grid": {"size_px": [self.grid.n, self.grid.n], "pixel_arcsec": self.grid.pix, "projection": "TAN",
                        "order": "row 0 = north, column 0 = east (PNG order)",
                        "png_upscale": BL.UPSCALE, "png_label_strip_px": BL.LABEL_H},
               "dtype": "float16-le", "planes": ["value_mjysr", "sigma_mjysr", "psf_snr"],
               "plane_bytes": self.grid.n * self.grid.n * 2,
               "notes": ("value: MJy/sr, ZODI subtracted (NaN = no data, +inf = saturated core). sigma: per-pixel 1 sigma "
                         "scaled to the measured scatter. psf_snr: PSF-matched point-source S/N (matched filter with the "
                         "effective EPSF, normalised to unit scatter at blank positions)."),
               "frames": {}, "deep": []}
        # frames: replicate the blink.py median stacks (meta.json file lists)
        for b in meta.get("wavelength_bins", []):
            key = f"{b['wavelength_um']:.1f}"
            fn = f"frames_{key}um.bin"
            blob, entries = bytearray(), []
            for f in b["frames"]:
                st = median_frame(self.by_file, f.get("files", []), self.lay)
                if st is None:
                    entries.append(None)
                    continue
                fl = [x for x in f.get("files", []) if x in self.by_file]
                A, B = halves([self.by_file[x] for x in fl])
                sa, sb = deep_stack(A, self.lay), deep_stack(B, self.lay)
                sp = split_noise(sa, sb, st["K"], st["satmask"]) if sa and sb else None
                if sp:                       # median of N: the halves are means, scale ~ as for a mean
                    sp = dict(sp)
                v, s, z, info = planes(st, st["satmask"], st["K"], sp)
                entries.append(dict(epoch=f["epoch"], offset=len(blob), n_images=st["nexp"], **info))
                for p in (v, s, z):
                    blob += to_f16(p).tobytes()
            write_new(od / fn, bytes(blob), overwrite)
            doc["frames"][key] = {"file": fn, "frames": entries,
                                  "stretch": b.get("stretch")}
            self.log(f"  frames {key} um: {sum(e is not None for e in entries)} season frames -> {fn}")
        # deep stacks: one per season, all wavelengths
        for s in self.seasons():
            st, ns = self.deep_noise([e for e in self.exps if e["epoch"] == s])
            if st is None:
                continue
            satm = BL.clean_satmask(st["satfrac"] > 0.3)
            v, sg, z, info = planes(st, satm, st["K"], ns["_split"] if ns else None)
            fn = f"deep_{s}.bin"
            write_new(od / fn, b"".join(to_f16(p).tobytes() for p in (v, sg, z)), overwrite)
            quicklook_png(np.flipud(np.where(np.isfinite(v) | np.isposinf(v), v, np.nan)), od / f"deep_{s}.png",
                          overwrite=overwrite)
            fin = v[np.isfinite(v)]
            mad = 1.4826 * float(np.median(np.abs(fin - np.median(fin))))
            stretch = {"type": "asinh", "lo": float(np.median(fin) - 1.5 * mad), "hi": float(np.percentile(fin, 99.97)),
                       "soft": 3 * mad, "unit": "MJy/sr (zodi subtracted)", "rule": "blink.py frame rule"}
            doc["deep"].append(dict(epoch=s, file=fn, png=f"deep_{s}.png", range="all", n_exposures=st["nexp"], stretch=stretch,
                                    detectors=st["dets"], lam_um=[round(st["lam"][0], 3), round(st["lam"][1], 3)],
                                    date=Time(st["mjd"], format="mjd").iso[:10], **info))
            self.log(f"  deep {s}: {st['nexp']} exposures {'+'.join(st['dets'])} -> {fn}")
        if depth:
            d = self.depth_table(ranges=ranges)
            d.pop("single_rows", None)
            doc["depth"] = d
        write_new(od / "faint.json", json.dumps(doc, indent=1, allow_nan=False, default=_json_default), overwrite)
        self.log(f"  wrote {od / 'faint.json'}")
        return doc


def _json_default(o):
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def clean_json(o):
    if isinstance(o, dict):
        return {k: clean_json(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean_json(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not math.isfinite(float(o)) else float(o)
    if isinstance(o, np.integer):
        return int(o)
    return o


def target_run(name, out_root=None, log=print):
    t = BL.load_target(name)
    ra_c, dec_c = BL.target_position(t, Time(BL.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    mp = BL.ROOT / "site" / "data" / name / "meta.json"
    meta = json.loads(mp.read_text()) if mp.exists() else None
    out = Path(out_root) / name if out_root else BL.OUT / name
    return FieldRun(name, BL.DATA / name, out, ra_c, dec_c, meta=meta, target=t, log=log)


def job_run(out_dir, inputs_dir, log=print):
    """Local-engine job: products in out_dir (cache/jobs/<id>), cutouts in inputs_dir."""
    meta = json.loads((Path(out_dir) / "meta.json").read_text())
    return FieldRun(Path(out_dir).name, inputs_dir, out_dir, meta["ra"], meta["dec"], meta=meta, log=log)


def post_step(ctx):
    """local/job_worker.py POST_STEPS entry: faint-mode products of a finished FULL job
    (float frames, deep stacks, proper-motion shift-and-stack) in <job>/faint/."""
    run = job_run(ctx["out"], ctx["inputs"], log=lambda *a: print(*a, flush=True))
    t = dict(ctx.get("target") or {})
    if t.get("ra") is not None and t.get("dec") is not None:
        for k, v in (("pmra", 0.0), ("pmdec", 0.0), ("plx", 0.0), ("epoch", 2016.0)):
            t[k] = v if t.get(k) is None else t[k]
        run.target = t
    if ctx.get("status") is not None:
        ctx["status"].set(message="faint-object mode: deep stacks and shift-and-stack")
    run.load()
    doc = run.products(overwrite=True, depth=False)
    out = {"faint": "faint/faint.json", "n_frames": sum(len(v["frames"]) for v in doc["frames"].values()),
           "n_deep": len(doc["deep"])}
    try:
        from detect import shift_stack
        ss = shift_stack.run_field(run, mode="pm", overwrite=True)
        out["shiftstack"] = "faint/shiftstack.json"
        out["n_shiftstack_candidates"] = len(ss)
    except Exception as e:                                   # the products above stay valid
        out["shiftstack_error"] = f"{type(e).__name__}: {e}"
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fazari faint-object mode: float frames, deep stacks, depth")
    ap.add_argument("target", nargs="?")
    ap.add_argument("--job", help="local-engine job folder (cache/jobs/<id>)")
    ap.add_argument("--inputs", help="cutout folder of the job (default cache/local/inputs/<id>)")
    ap.add_argument("--out", help="output root (<out>/<target>/faint); default FAZARI_OUT or site/data")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--no-depth", action="store_true")
    ap.add_argument("--shiftstack", action="store_true", help="also run the shift-and-stack search (proper motion)")
    ap.add_argument("--shiftstack-long", action="store_true",
                    help="also a proper-motion search with 3.8-5.1 um only (cold brown dwarfs; run tag pm_long)")
    ap.add_argument("--sso", action="store_true", help="also the fast-mover (arcsec/h) search within visit windows")
    a = ap.parse_args(argv)
    if a.job:
        jd = Path(a.job)
        inputs = Path(a.inputs) if a.inputs else jd.parent.parent / "local" / "inputs" / jd.name
        run = job_run(jd, inputs)
    else:
        run = target_run(a.target or "barnard", a.out)
    run.log(f"faint mode: {run.name} -> {run.out_dir / 'faint'}")
    run.load()
    run.products(overwrite=a.overwrite, depth=not a.no_depth)
    if a.shiftstack or a.shiftstack_long or a.sso:
        from detect import shift_stack
        if a.shiftstack:
            shift_stack.run_field(run, mode="pm", overwrite=a.overwrite)
        if a.shiftstack_long:
            shift_stack.run_field(run, mode="pm", overwrite=a.overwrite, tag="pm_long", lam_range=(3.8, 5.1))
        if a.sso:
            shift_stack.run_field(run, mode="sso", overwrite=a.overwrite)


if __name__ == "__main__":
    main()
