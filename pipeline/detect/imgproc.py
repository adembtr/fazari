"""Matched filter, noise normalisation and peak finding on stack-grid images (Gaussian PSF).

For an image S with variance V and a point source of PSF P (Gaussian, sigma s pixels), the
optimal point-source statistic is
    F   = conv(S/V, P) / conv(1/V, P^2)        (PSF flux)
    eF  = 1 / sqrt(conv(1/V, P^2))
    Z   = F / eF
Resampling correlates neighbouring pixels, so Z is divided by its robust scatter over the
field (masked pixels and the brightest 2 % excluded): Z is then in units of the real noise.
"""
import math

import numpy as np
from scipy.ndimage import gaussian_filter, maximum_filter, minimum_filter, binary_dilation, label

import blink as BL
from . import data as Dt


def matched(S, V, sigma, mask=None):
    """(F, eF, Z_raw) for image S, variance V (inf/NaN = no data), Gaussian sigma (px)."""
    good = np.isfinite(S) & np.isfinite(V) & (V > 0)
    if mask is not None:
        good &= ~mask
    iv = np.where(good, 1.0 / np.where(good, V, 1.0), 0.0)
    num = gaussian_filter(np.where(good, S, 0.0) * iv, sigma, mode="constant")
    den = gaussian_filter(iv, sigma / math.sqrt(2), mode="constant") / (4 * math.pi * sigma ** 2)
    ok = den > 0
    F = np.where(ok, num / np.where(ok, den, 1), np.nan)
    eF = np.where(ok, 1 / np.sqrt(np.where(ok, den, 1)), np.nan)
    # the numerator above is conv(S/V, P) only up to the normalisation of P (sum 1): fine
    return F, eF, F / eF


def normalise(Z, valid, clip_frac=0.02):
    """Divide Z by its robust scatter over valid pixels (brightest/faintest clip_frac excluded)."""
    v = Z[valid & np.isfinite(Z)]
    if v.size < 100:
        return Z, 1.0
    lo, hi = np.percentile(v, [100 * clip_frac, 100 * (1 - clip_frac)])
    core = v[(v > lo) & (v < hi)]
    s = BL.robust_sigma(core) if core.size > 50 else BL.robust_sigma(v)
    # robust_sigma of a clipped Gaussian underestimates: correct for the 2 % clip (~1.03)
    s = s * 1.0 if not np.isfinite(s) or s <= 0 else s
    return Z / s, float(s)


def peaks(Z, thresh, valid, sign=+1, min_sep=2):
    """Local extrema of sign*Z above thresh within valid pixels: list of (x, y, z)."""
    a = np.where(valid & np.isfinite(Z), sign * Z, -np.inf)
    mx = maximum_filter(a, size=2 * min_sep + 1, mode="constant", cval=-np.inf)
    ys, xs = np.nonzero((a == mx) & (a >= thresh))
    out = []
    for x, y in zip(xs, ys):
        # sub-pixel refinement: parabola along each axis
        def para(m1, c, p1):
            den = m1 - 2 * c + p1
            return 0.0 if not np.isfinite(den) or den >= 0 else float(np.clip(0.5 * (m1 - p1) / den, -0.5, 0.5))
        n = a.shape[0]
        fx = para(a[y, x - 1], a[y, x], a[y, x + 1]) if 0 < x < n - 1 else 0.0
        fy = para(a[y - 1, x], a[y, x], a[y + 1, x]) if 0 < y < n - 1 else 0.0
        out.append((x + fx, y + fy, float(sign * a[y, x])))
    return out


def blobs(mask, min_px=4):
    """Connected regions of a boolean mask: list of (x_centroid, y_centroid, n_pixels, radius)."""
    lab, n = label(mask)
    out = []
    for k in range(1, n + 1):
        ys, xs = np.nonzero(lab == k)
        if len(xs) < min_px:
            continue
        out.append((float(xs.mean()), float(ys.mean()), int(len(xs)), float(math.sqrt(len(xs) / math.pi))))
    return out


def dilate(mask, r):
    if r <= 0:
        return mask
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return binary_dilation(mask, structure=(xx ** 2 + yy ** 2) <= r * r)


def stack_flux_ujy(F):
    """PSF flux on the stack grid (MJy/sr x stack pixels) -> microJansky."""
    return F * (Dt.STACK_PIX / BL.PIX_NATIVE) ** 2 * BL.PIXEL_UJY
