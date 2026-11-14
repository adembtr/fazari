"""Sky background for site/vr.html: the SPHEREx DR1 all-sky HiPS turned into one equirectangular JPEG.

One-off and reproducible. Run from the repo root:

    uv run --no-project --with numpy --with pillow --with healpy python pipeline/vr_sky.py

What it does
- Downloads HiPS order-1 tiles (48 tiles of 512 x 512 px, about 0.057 deg per pixel) of the
  SPHEREx DR1 all-sky cube at NASA/IPAC IRSA for a few of its 102 wavelength frames
  (https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube; 8-bit PNG tiles that IRSA
  already stretched with asinh, cut 0-40 MJy/sr). At most 4 requests in flight; cached in --cache.
- Averages the frames of each colour group (blue ~1.1 um, green ~2.1 um, red ~3.6 um) and resamples
  the HEALPix tiles to an equirectangular grid in ICRS: x = right ascension increasing to the LEFT
  (as seen from inside the sphere, east to the left), from RA 180 at x=0 through RA 0 in the middle;
  y = declination from +90 at the top. The page's shader uses the same convention.
- Display stretch only (no science is done on this image): light Gaussian blur (sigma 0.8 px on the sky, widened along RA by 1/cos dec), black
  point at the 65th percentile of the sky, white point near the brightest pixels, asinh. Pixels without
  data (the two ecliptic-pole deep fields) are filled with the mean of the sky around them.
  Optional --keep < 1 flattens large-scale background (off by default: it leaves halos).
- Writes site/data/vr/sky_4k.jpg (4096 x 2048), sky_2k.jpg (2048 x 1024, loaded first) and
  site/data/vr/sky.json (frames used, credit, conventions).

Tile pixel orientation inside a HiPS tile (which corner is which nested sub-pixel) is not guessed: the
script tries the 8 flips/transposes and keeps the one where known bright infrared stars land on bright
pixels (printed).
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import json
import time
import urllib.request
from pathlib import Path

import healpy as hp
import numpy as np
from PIL import Image

BASE = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
ORDER = 1
TILE = 512
# frame index = 17*(band-1) + (channel-1); wavelengths from the HiPS properties (data_cube_crval3_arr)
GROUPS = {
    "blue": [14, 16, 18],      # 1.050, 1.102, 1.139 um (band 1/2)
    "green": [42, 44, 46],     # 1.995, 2.089, 2.189 um (band 3)
    "red": [62, 64, 66],       # 3.293, 3.476, 3.667 um (band 4)
}
WAVE = {14: 1.050, 16: 1.102, 18: 1.139, 42: 1.995, 44: 2.089, 46: 2.189, 62: 3.293, 64: 3.476, 66: 3.667}
CREDIT = ("SPHEREx DR1 all-sky HiPS: NASA/SPHEREx, Caltech/IPAC (NASA/IPAC Infrared Science Archive). "
          "False colour from 9 of the 102 wavelength frames: blue 1.05-1.14 um, green 2.0-2.19 um, red 3.29-3.67 um.")
# Bright infrared stars (ICRS deg) to fix the tile orientation.
CHECK = [(88.793, 7.407), (247.352, -26.432), (68.980, 16.509), (213.915, 19.182), (34.837, -2.977),
         (101.287, -16.716), (116.329, 28.026), (79.172, 45.998), (141.897, -8.659), (279.234, 38.784),
         (95.988, -52.696), (161.692, -59.684), (206.885, 49.313), (252.166, -69.028), (24.429, -57.237)]


def url(npix: int, frame: int) -> str:
    d = (npix // 10000) * 10000
    return f"{BASE}/Norder{ORDER}/Dir{d}/Npix{npix}" + (f"_{frame}" if frame else "") + ".png"


def fetch(u: str, cache: Path) -> np.ndarray:
    f = cache / u.split("/spherex_allsky_cube/")[1].replace("/", "_")
    if not f.exists() or f.stat().st_size == 0:
        for i in range(30):                         # the network drops for minutes at a time
            try:
                req = urllib.request.Request(u, headers={"User-Agent": "fazari-vr-sky/1"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    b = r.read()
                f.write_bytes(b)
                break
            except Exception as e:  # noqa: BLE001
                print("retry", u, e)
                time.sleep(min(60, 5 * (i + 1)))
        else:
            raise RuntimeError("could not download " + u)
    im = Image.open(io.BytesIO(f.read_bytes()))
    a = np.asarray(im.convert("LA"), dtype=np.float32)
    v, alpha = a[..., 0], a[..., 1]
    v[alpha == 0] = np.nan                          # transparent = no data
    return v


def tile_lookup(tiles: np.ndarray, npix_sub: np.ndarray, mode: int) -> np.ndarray:
    """Value at nested order (ORDER+9) pixels: tile = idx >> 18, (x, y) from the de-interleaved low bits."""
    sub = npix_sub & ((1 << 18) - 1)
    tile = npix_sub >> 18
    x = np.zeros_like(sub)
    y = np.zeros_like(sub)
    for b in range(9):
        x |= ((sub >> (2 * b)) & 1) << b
        y |= ((sub >> (2 * b + 1)) & 1) << b
    if mode & 1:
        x = TILE - 1 - x
    if mode & 2:
        y = TILE - 1 - y
    if mode & 4:
        x, y = y, x
    return tiles[tile, y, x]


def highpass_keep(img: np.ndarray, keep: float, size: int) -> np.ndarray:
    """img - (1-keep) * smooth(img), smooth = block median (cheap and robust to stars)."""
    h, w = img.shape
    bh, bw = h // size, w // size
    blk = img[: bh * size, : bw * size].reshape(bh, size, bw, size)
    med = np.nanmedian(blk.transpose(0, 2, 1, 3).reshape(bh, bw, -1), axis=2)
    med = np.where(np.isfinite(med), med, np.nanmedian(med))
    sm = np.asarray(Image.fromarray(med.astype(np.float32)).resize((w, h), Image.BILINEAR))
    return img - (1 - keep) * sm


def blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian of `sigma` output pixels ON THE SKY (display only; tames the pixel noise of the nearest-pixel
    HEALPix lookup). Along RA a row at declination d is stretched by 1/cos(d), so its kernel is widened by the
    same factor; otherwise stars away from the equator come out elongated along the meridians."""
    if sigma <= 0:
        return img
    h, w = img.shape

    def kern(sg):
        r = int(np.ceil(3 * sg))
        k = np.exp(-0.5 * (np.arange(-r, r + 1) / sg) ** 2)
        return r, k / k.sum()

    r, k = kern(sigma)
    out = np.apply_along_axis(lambda v: np.convolve(np.pad(v, r, mode="edge"), k, mode="valid"), 0, img)
    dec = 90.0 - 180.0 * (np.arange(h) + 0.5) / h
    for y in range(h):
        sx = min(sigma / max(np.cos(np.radians(dec[y])), 1e-3), w / 8)
        rx, kx = kern(sx)
        out[y] = np.convolve(np.pad(out[y], rx, mode="wrap"), kx, mode="valid")
    return out


def fill_holes(img: np.ndarray) -> np.ndarray:
    """Pixels without data (transparent in the tiles) get the mean of the surrounding sky, from coarse to fine."""
    bad = ~np.isfinite(img)
    if not bad.any():
        return img
    out = img.copy()
    h, w = img.shape
    for f in (4, 16, 64):
        sm = Image.fromarray(np.nan_to_num(img, nan=0).astype(np.float32)).resize((w // f, h // f), Image.BOX)
        wt = Image.fromarray(np.isfinite(img).astype(np.float32)).resize((w // f, h // f), Image.BOX)
        s_ = np.asarray(sm.resize((w, h), Image.BILINEAR)); w_ = np.asarray(wt.resize((w, h), Image.BILINEAR))
        est = np.where(w_ > 0.05, s_ / np.maximum(w_, 1e-6), np.nan)
        fill = bad & ~np.isfinite(out) & np.isfinite(est)
        out[fill] = est[fill]
    print("filled", int(bad.sum()), "pixels without data")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data/vr")
    ap.add_argument("--cache", default=str(Path.home() / ".cache" / "fazari_vr_sky"))
    ap.add_argument("--width", type=int, default=4096)
    ap.add_argument("--keep", type=float, default=1.0, help="<1: subtract (1-keep) of a wide median (flattens scan steps)")
    ap.add_argument("--black", type=float, default=65.0, help="black point, percentile of the sky")
    ap.add_argument("--white", type=float, default=99.98, help="white point, percentile")
    ap.add_argument("--soft", type=float, default=5.0, help="asinh softening of the display stretch")
    ap.add_argument("--quality", type=int, default=78)
    ap.add_argument("--blur", type=float, default=0.8, help="Gaussian sigma in output pixels (display only)")
    a = ap.parse_args()
    cache = Path(a.cache)
    cache.mkdir(parents=True, exist_ok=True)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    ntiles = 12 * 4 ** ORDER
    frames = [f for g in GROUPS.values() for f in g]
    jobs = [(f, n) for f in frames for n in range(ntiles)]
    cubes = {f: np.full((ntiles, TILE, TILE), np.nan, np.float32) for f in frames}
    with cf.ThreadPoolExecutor(max_workers=4) as ex:      # at most 4 requests in flight
        futs = {ex.submit(fetch, url(n, f), cache): (f, n) for f, n in jobs}
        for k, fu in enumerate(cf.as_completed(futs)):
            f, n = futs[fu]
            cubes[f][n] = fu.result()
            if k % 48 == 0:
                print(f"{k}/{len(jobs)} tiles")
    print("downloaded", sum(p.stat().st_size for p in cache.iterdir()) / 1e6, "MB in cache")

    W = a.width
    H = W // 2
    nside = 2 ** (ORDER + 9)

    # orientation check at the bright stars (green group, 3x3 max around each)
    g = np.nanmean(np.stack([cubes[f] for f in GROUPS["green"]]), axis=0)
    best = None
    for mode in range(8):
        sc = []
        for ra, dec in CHECK:
            th, ph = np.radians(90 - dec), np.radians(ra)
            idx = hp.ang2pix(nside, th, ph, nest=True)
            vals = [tile_lookup(g, np.array([j]), mode)[0] for j in [idx]]
            # neighbours too
            nb = hp.get_all_neighbours(nside, th, ph, nest=True)
            vals += [tile_lookup(g, np.array([j]), mode)[0] for j in nb if j >= 0]
            sc.append(np.nanmax(vals))
        s = float(np.nanmean(sc))
        print("orientation", mode, "mean value at bright stars", round(s, 1))
        if best is None or s > best[1]:
            best = (mode, s)
    mode = best[0]
    print("using orientation", mode)

    # equirectangular grid: column x -> RA = 180 - 360 * (x + 0.5) / W (RA grows to the left), row y -> Dec
    xs = (np.arange(W) + 0.5) / W
    ys = (np.arange(H) + 0.5) / H
    ra = (180.0 - 360.0 * xs) % 360.0
    dec = 90.0 - 180.0 * ys
    RA, DEC = np.meshgrid(ra, dec)
    idx = hp.ang2pix(nside, np.radians(90 - DEC), np.radians(RA), nest=True).ravel()

    chans = []
    for name in ("red", "green", "blue"):
        m = np.nanmean(np.stack([cubes[f] for f in GROUPS[name]]), axis=0)
        img = tile_lookup(m, idx, mode).reshape(H, W)
        img = blur(fill_holes(img), a.blur)
        if a.keep < 1:
            img = highpass_keep(img, keep=a.keep, size=W // 64)
        lo, hi = np.nanpercentile(img, a.black), np.nanpercentile(img, a.white)
        img = np.clip((img - lo) / (hi - lo), 0, 1)
        img = np.arcsinh(img * a.soft) / np.arcsinh(a.soft)
        chans.append(np.nan_to_num(img, nan=0.0))
        print(name, "done", "black", round(float(lo), 2), "white", round(float(hi), 2))
    rgb = (np.stack(chans, axis=-1) * 255).astype(np.uint8)
    im = Image.fromarray(rgb, "RGB")
    im.save(out / "sky_4k.jpg", quality=a.quality, optimize=True, progressive=True)
    im.resize((W // 2, H // 2), Image.LANCZOS).save(out / "sky_2k.jpg", quality=a.quality, optimize=True, progressive=True)
    meta = {
        "_note": "Sky background of site/vr.html, built by pipeline/vr_sky.py. Display image only.",
        "source": BASE, "hips_order": ORDER, "frames": {k: [{"frame": f, "um": WAVE[f]} for f in v] for k, v in GROUPS.items()},
        "projection": "equirectangular ICRS; x=0 is RA 180 deg, RA increases to the left, middle column RA 0; top row Dec +90",
        "tile_orientation_mode": mode, "credit": CREDIT,
        "stretch": {"blur_sigma_px": a.blur, "black_percentile": a.black, "white_percentile": a.white, "asinh_soft": a.soft, "keep": a.keep},
        "no_data": "Two small patches at the ecliptic poles (RA 270 Dec +66.6 and RA 90 Dec -66.6, the SPHEREx deep fields) have no pixels in this HiPS; they are filled with the mean of the sky around them.",
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out / "sky.json").write_text(json.dumps(meta, indent=1))
    for p in ("sky_4k.jpg", "sky_2k.jpg"):
        print(p, (out / p).stat().st_size / 1e6, "MB")


if __name__ == "__main__":
    main()
