#!/usr/bin/env python3
"""Tests for fetch_region.py (Fazari, NASA Space Apps 2026).

  uv run --no-project --with astropy --with numpy python -I pipeline/test_fetch_region.py [--skip-luhman]

1. RICE_1: the pure-Python decoder equals astropy's C codec (synthetic tiles and real FLAGS rows).
2. Geometry: the IRSA cutout rule reproduces x0, y0, nx, ny of every local IRSA cutout (headers only, no download).
3. Barnard: >= 12 images (DR1 + QR3, all 6 detectors, many dates, border and 116/118 px cases) read from S3
   and compared with IRSA cutouts: IMAGE, FLAGS, ZODI (and VARIANCE on 2) bit-exact, headers equal, WCS pixel->sky < 1e-6 deg,
   written FITS file round trip, wavelength vs astropy -TAB.
4. Luhman 16AB: images from IRSA SIA; region inside, finite, bright source where Luhman 16 should be.
Measured bytes and time per region are printed (first run = cold cache; later runs use cache/s3/;
set FAZARI_S3_CACHE=<empty dir> to measure cold reads again).
Local IRSA cutouts are read only (default ../veri/real_spherex, or FAZARI_DATA).
"""
import argparse
import glob
import math
import sys
import time
import warnings
from collections import Counter
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_region as fr  # noqa: E402

DATA = fr.default_data_dir()
OUT = fr.ROOT / "cache" / "test_regions"
LUHMAN = {"ra": 162.3289, "dec": -53.3194, "epoch": 2000.0, "pmra": -2763.0, "pmdec": 358.0}  # mas/yr, approx.
failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print("  FAIL:", msg)
    return cond


def quiet_wcs(header, **kw):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return WCS(header, relax=True, **kw)


# ----------------------------------------------------------------------------------------------

def test_rice():
    print("[1] RICE_1 decoder")
    from astropy.io.fits.hdu.compressed._codecs import Rice1
    rng = np.random.default_rng(1)
    cases = [np.zeros(2040, np.int32),                                   # low-entropy blocks
             rng.integers(-2**31, 2**31 - 1, 2040, dtype=np.int64).astype(np.int32),   # high-entropy
             (rng.integers(0, 4, 2040) * 4096 + 2097152).astype(np.int32),            # flag-like
             np.cumsum(rng.integers(-50, 50, 1000)).astype(np.int32),
             np.array([7], np.int32), np.arange(33, dtype=np.int32)]
    for i, a in enumerate(cases):
        enc = Rice1(blocksize=32, bytepix=4, tilesize=a.size).encode(a.astype(">i4"))
        check(np.array_equal(fr.rice_decode(enc, a.size), a), f"rice synthetic case {i}")
    # real FLAGS rows: decode a few rows of one file with both decoders
    key = "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"
    f = fr.S3File(key)
    flags = fr.scan_layout(f, upto="FLAGS")["FLAGS"]
    t0 = time.monotonic()
    py_rows = fr.read_compressed_rows(f, flags, 209, 214, decoder=lambda raw: fr.rice_decode(raw, 2040))
    t_py = time.monotonic() - t0
    c_rows = fr.read_compressed_rows(f, flags, 209, 214)
    check(np.array_equal(py_rows, c_rows), "rice python vs astropy codec on real FLAGS rows")
    print(f"  ok: {len(cases)} synthetic tiles + 6 real rows; pure Python {t_py / 6 * 1000:.0f} ms/row")


# ----------------------------------------------------------------------------------------------

def local_cutouts(target):
    out = []
    for coll in ("dr1", "qr3"):
        lst = DATA / target / f"liste_{coll}.csv"
        keys = {Path(r["key"]).name: r["key"] for r in fr.read_image_list(lst)} if lst.exists() else {}
        for fn in sorted(glob.glob(str(DATA / target / coll / "*.fits"))):
            name = Path(fn).name
            out.append({"file": fn, "coll": coll, "key": keys.get(name)})
    return out


def test_geometry():
    print("[2] IRSA cutout geometry (all local cutouts, headers only)")
    total, bad, sizes = 0, 0, Counter()
    for target in sorted(p.name for p in DATA.iterdir() if (p / "liste_dr1.csv").exists()):
        ra, dec = fr.target_position(target)
        n_t = 0
        for c in local_cutouts(target):
            try:
                h = fits.getheader(c["file"], 1)
            except Exception:
                continue                                   # being written by the downloader
            x0, y0 = int(round(1 - h["CRPIX1A"])), int(round(1 - h["CRPIX2A"]))
            full = h.copy()
            full["CRPIX1"] += x0
            full["CRPIX2"] += y0
            g = fr.irsa_geometry(fr.celestial_wcs(full), ra, dec, (2040, 2040), size_deg=0.2)
            got = (g["x0"], g["y0"], g["x1"] - g["x0"] + 1, g["y1"] - g["y0"] + 1)
            want = (x0, y0, h["NAXIS1"], h["NAXIS2"])
            total += 1
            n_t += 1
            sizes[(g["nx"], g["ny"])] += 1
            if got != want:
                bad += 1
                print(f"  mismatch {Path(c['file']).name}: got {got} want {want} px {g['px']:.3f} {g['py']:.3f}")
        print(f"  {target}: {n_t} cutouts")
    check(bad == 0, f"geometry mismatches: {bad}/{total}")
    print(f"  {total - bad}/{total} cutouts match; unclipped sizes seen: {dict(sizes)}")


# ----------------------------------------------------------------------------------------------

def pick_barnard(cutouts):
    """>= 12 images: each collection x detector 1..6 (spread over dates) + border/116/118 px cases."""
    info = []
    for c in cutouts:
        h = fits.getheader(c["file"], 1)
        info.append(dict(c, det=h["DETECTOR"], date=h["DATE-AVG"], nx=h["NAXIS1"], ny=h["NAXIS2"],
                         x0=1 - h["CRPIX1A"], y0=1 - h["CRPIX2A"]))
    chosen = []
    for coll in ("dr1", "qr3"):
        for det in range(1, 7):
            cand = sorted((i for i in info if i["coll"] == coll and i["det"] == det), key=lambda i: i["date"])
            if cand:
                chosen.append(cand[(det * 7) % len(cand)])          # spread the dates
    extra = [lambda i: i["y0"] == 0 and i["ny"] < 117,                  # clipped at bottom
             lambda i: i["y0"] + i["ny"] == 2040 and i["ny"] < 117,     # clipped at top
             lambda i: i["nx"] == 118,
             lambda i: i["nx"] == 116 and i["x0"] > 0]
    for cond in extra:
        for i in info:
            if cond(i) and i not in chosen:
                chosen.append(i)
                break
    return chosen


def sky_corners(w, nx, ny):
    pts = np.array([[0, 0], [nx - 1, 0], [0, ny - 1], [nx - 1, ny - 1], [(nx - 1) / 2, (ny - 1) / 2]], float)
    return pts, w.all_pix2world(pts, 0)


def sep_deg(a, b):
    ra1, de1, ra2, de2 = map(np.radians, (a[:, 0], a[:, 1], b[:, 0], b[:, 1]))
    h = np.sin((de2 - de1) / 2) ** 2 + np.cos(de1) * np.cos(de2) * np.sin((ra2 - ra1) / 2) ** 2
    return np.degrees(2 * np.arcsin(np.sqrt(h)))                       # haversine: exact for tiny angles


def compare_headers(ours, irsa, label):
    ok = True
    ck = [k for k in irsa.keys() if k not in ("COMMENT", "HISTORY", "")]
    for k in ck:
        if k not in ours or ours[k] != irsa[k]:
            ok = check(False, f"{label}: header {k} ours={ours.get(k)!r} irsa={irsa[k]!r}") and ok
    extra = [k for k in ours.keys() if k not in irsa and k not in ("COMMENT", "HISTORY", "")]
    ok = check(not extra, f"{label}: extra header keys {extra}") and ok
    for k in ("COMMENT", "HISTORY"):
        ok = check(list(ours.get(k, [])) == list(irsa.get(k, [])), f"{label}: {k} cards differ") and ok
    return ok


def test_barnard(n_min=12):
    print("[3] Barnard: S3 regions vs IRSA cutouts")
    ra, dec = fr.target_position("barnard")
    chosen = pick_barnard([c for c in local_cutouts("barnard") if c["key"]])
    check(len(chosen) >= n_min, f"only {len(chosen)} Barnard images picked")
    # extra: an Eps Indi B image from an "l2b_retry" folder whose CRPIX is not x.5 (tests IRSA's CRPIX arithmetic)
    for c in local_cutouts("eps_indi_b"):
        if c["key"] and "2026W40_1A_0721_1D5" in c["file"]:
            h = fits.getheader(c["file"], 1)
            chosen.append(dict(c, det=h["DETECTOR"], target="eps_indi_b"))
    rows = []
    for n, c in enumerate(chosen):
        ra, dec = fr.target_position(c.get("target", "barnard"))
        stats = fr.Stats()
        layers = ("IMAGE", "FLAGS", "ZODI") + (("VARIANCE",) if n < 2 else ())     # VARIANCE on two images
        r = fr.read_region(c["key"], ra, dec, size_deg=0.2, layers=layers, stats=stats)
        name = Path(c["file"]).name
        irsa = fits.open(c["file"])
        label = f"{c['coll']} D{c['det']} {name[7:30]}"
        ok = check(r["ok"], f"{label}: not ok ({r.get('reason')})")
        worst = float("nan")
        if ok:
            for layer in layers:
                a, b = r["arrays"][layer], irsa[layer].data
                eq = a.shape == b.shape and np.array_equal(a, b, equal_nan=(a.dtype.kind == "f"))
                ok = check(eq, f"{label}: {layer} differs (shape {a.shape} vs {b.shape})") and ok
                ok = compare_headers(r["headers"][layer], irsa[layer].header, f"{label} {layer}") and ok
            ok = check(np.array_equal(np.asarray(r["wave_hdu"].data.tolist(), dtype=object),
                                      np.asarray(irsa["WCS-WAVE"].data.tolist(), dtype=object)),
                       f"{label}: WCS-WAVE table differs") and ok
            # WCS: our cutout WCS vs IRSA cutout WCS, and vs the full image WCS at shifted pixels
            nx, ny = r["box"]["nx"], r["box"]["ny"]
            pts, ours = sky_corners(r["wcs"], nx, ny)
            _, theirs = sky_corners(quiet_wcs(irsa["IMAGE"].header), nx, ny)
            full_h = r["headers"]["IMAGE"].copy()
            full_h["CRPIX1"] += r["box"]["x0"]
            full_h["CRPIX2"] += r["box"]["y0"]
            full_sky = quiet_wcs(full_h).all_pix2world(pts + [r["box"]["x0"], r["box"]["y0"]], 0)
            worst = max(sep_deg(ours, theirs).max(), sep_deg(ours, full_sky).max())
            ok = check(worst < 1e-6, f"{label}: WCS differs by {worst:.2e} deg") and ok
            # wavelength vs astropy -TAB (SIP keys removed, they confuse the 'W' WCS in astropy)
            hw = irsa["IMAGE"].header.copy()
            for k in [k for k in hw.keys() if fr._SIP_KEYS.match(k)]:
                del hw[k]
            ww = quiet_wcs(hw, key="W", fobj=irsa)
            yy, xx = np.mgrid[0:ny:10, 0:nx:10]
            wl_ref, bw_ref = ww.pixel_to_world_values(xx, yy)
            wl, bw = fr.wave_lookup(r["headers"]["IMAGE"], r["wave_hdu"], xx, yy)
            ok = check(np.allclose(wl, wl_ref, rtol=0, atol=1e-6) and np.allclose(bw, bw_ref, rtol=0, atol=1e-7),
                       f"{label}: wavelength lookup differs from astropy -TAB") and ok
            # written file round trip
            out = fr.write_cutout(r, OUT / name.replace(".fits", "_region.fits"), ra, dec, 0.2)
            with fits.open(out) as back:
                for layer in ("IMAGE", "FLAGS", "ZODI"):
                    ok = check(np.array_equal(back[layer].data, irsa[layer].data,
                                              equal_nan=(back[layer].data.dtype.kind == "f")),
                               f"{label}: written {layer} differs") and ok
        irsa.close()
        st = r["stats"]
        rows.append((label, r["box"]["nx"] if r["ok"] else 0, r["box"]["ny"] if r["ok"] else 0, ok,
                     st["bytes_net"], st["requests"], st["seconds"], worst))
    print(f"  {'image':42s} {'size':>8s} {'equal':>6s} {'MB net':>7s} {'req':>4s} {'sec':>6s} {'WCS dev':>8s}")
    for lab, nx, ny, ok, b, q, s, w in rows:
        print(f"  {lab:42s} {nx:>4d}x{ny:<3d} {str(ok):>6s} {b / 1e6:7.2f} {q:4d} {s:6.2f} {w:8.1e}")
    good = sum(r[3] for r in rows)
    net = [r for r in rows if r[4] > 0]
    print(f"  {good}/{len(rows)} images identical to IRSA")
    if net:
        print(f"  reads with network traffic: mean {np.mean([r[4] for r in net]) / 1e6:.2f} MB, "
              f"{np.mean([r[5] for r in net]):.1f} requests, {np.mean([r[6] for r in net]):.2f} s per region")


# ----------------------------------------------------------------------------------------------

def test_luhman(n=4):
    print("[4] Luhman 16AB: images from IRSA SIA, sanity of the region")
    images = fr.sia_query(LUHMAN["ra"], LUHMAN["dec"], "dr1")
    check(len(images) > 0, "SIA returned no images for Luhman 16")
    images.sort(key=lambda r: r["t_min"])
    if not images:
        return
    pick = [images[int(i)] for i in np.linspace(0, len(images) - 1, min(n, len(images)))]
    print(f"  SIA: {len(images)} DR1 images; using {len(pick)}")
    for im in pick:
        r = fr.read_region(im["key"], LUHMAN["ra"], LUHMAN["dec"], size_deg=0.2, edge="pad",
                           layers=("IMAGE", "FLAGS", "ZODI"))
        g = r["geometry"]
        label = Path(im["key"]).name[7:30]
        if not check(r["ok"] and g["contains"], f"Luhman {label}: target not inside ({r.get('reason')})"):
            continue
        img = r["arrays"]["IMAGE"]
        fin = float(np.isfinite(img).mean())
        check(fin > 0.9, f"Luhman {label}: only {fin:.2%} finite pixels")
        # expected position at the image epoch (linear proper motion from J2000)
        yr = 2000.0 + (r["obs"]["mjd_avg"] - 51544.5) / 365.25
        dt = yr - LUHMAN["epoch"]
        dec_t = LUHMAN["dec"] + LUHMAN["pmdec"] / 3.6e6 * dt
        ra_t = LUHMAN["ra"] + LUHMAN["pmra"] / 3.6e6 * dt / math.cos(math.radians(LUHMAN["dec"]))
        ex, ey = r["wcs"].all_world2pix([[ra_t, dec_t]], 0)[0]
        cx, cy = r["wcs"].all_world2pix([[LUHMAN["ra"], LUHMAN["dec"]]], 0)[0]
        med = np.nanmedian(img)
        mad = 1.4826 * np.nanmedian(np.abs(img - med))
        yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
        near = (np.hypot(xx - ex, yy - ey) < 6) & np.isfinite(img)
        peak_i = np.nanargmax(np.where(near, img, -np.inf))
        py, px = np.unravel_index(peak_i, img.shape)
        snr = (img[py, px] - med) / mad
        rank = int((img[np.isfinite(img)] > img[py, px]).sum())
        win = near & (np.hypot(xx - px, yy - py) < 4)               # flux centroid around the peak
        wgt = np.where(win, np.clip(img - med, 0, None), 0)
        cx_s, cy_s = (wgt * xx).sum() / wgt.sum(), (wgt * yy).sum() / wgt.sum()
        off = math.hypot(cx_s - ex, cy_s - ey)
        sat = int(((r["arrays"]["FLAGS"] & 0b111) != 0)[win].sum())  # TRANSIENT/OVERFLOW/SUR_ERROR in core
        print(f"  {label} D{r['obs']['detector']} {r['obs']['date_avg'][:10]} {r['wavelength']['um_at_target']:.2f} um: "
              f"finite {fin:.3f}, peak S/N {snr:.0f}, centroid {off:.1f} px from predicted "
              f"(predicted is {math.hypot(ex - cx, ey - cy):.1f} px from the J2000 position), "
              f"{rank} brighter px in region, {sat} core px flagged SUR/OVERFLOW/TRANSIENT; "
              f"{r['stats']['bytes_net'] / 1e6:.2f} MB, {r['stats']['seconds']:.2f} s")
        check(snr > 20 and off < 3.0, f"Luhman {label}: no bright source at the predicted position")
        fr.write_cutout(r, OUT / ("luhman16_" + Path(im["key"]).name.replace(".fits", "_region.fits")),
                        LUHMAN["ra"], LUHMAN["dec"], 0.2)


def test_edges():
    print("[5] Edge cases: pad mode and an image that does not contain the point")
    ra, dec = fr.target_position("barnard")
    clipped = [c for c in pick_barnard([c for c in local_cutouts("barnard") if c["key"]])
               if c["y0"] == 0 and c["ny"] < 117][:1]
    for c in clipped:
        r = fr.read_region(c["key"], ra, dec, layers=("IMAGE",), edge="pad", wave=False)
        img = r["arrays"]["IMAGE"]
        with fits.open(c["file"]) as irsa:
            ref = irsa["IMAGE"].data
            ny = ref.shape[0]
            inner = img[img.shape[0] - ny:, :]
            check(img.shape == (r["geometry"]["ny"], r["geometry"]["nx"]), "pad: wrong shape")
            check(np.isnan(img[:img.shape[0] - ny]).all(), "pad: padded rows not NaN")
            check(np.array_equal(inner, ref, equal_nan=True), "pad: inner part differs from IRSA")
            print(f"  pad ok: {img.shape}, padded {r.get('padded')}")
    # an image far from the point: the Luhman position in a Barnard image
    key = "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"
    r = fr.read_region(key, LUHMAN["ra"], LUHMAN["dec"])
    check(not r["ok"] and not r["geometry"]["contains"], "far point should not overlap")
    print(f"  far point: ok={r['ok']} reason='{r['reason']}'")
    # just outside the border: a point 30 px beyond the image edge still overlaps (pad report)
    f = fr.S3File(key)
    w = fr.celestial_wcs(fr.scan_layout(f, upto="IMAGE")["IMAGE"].header)
    ra_o, dec_o = w.all_pix2world([[2069.0, 1000.0]], 0)[0]
    r = fr.read_region(key, ra_o, dec_o, layers=("IMAGE",), edge="pad", wave=False)
    g = r["geometry"]
    check(r["ok"] and not g["contains"] and r["padded"]["right"] == g["x0u"] + g["nx"] - 2040
          and r["arrays"]["IMAGE"].shape == (g["ny"], g["nx"]) and np.isnan(r["arrays"]["IMAGE"][:, -88:]).all(),
          f"outside-border point: {r.get('reason')} {r.get('padded')}")
    print(f"  point 30 px beyond the border: ok={r['ok']} contains={r['geometry']['contains']} "
          f"reason='{r['reason']}', padded {r.get('padded')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-luhman", action="store_true")
    ap.add_argument("--only", help="comma list: rice,geometry,barnard,edges,luhman")
    a = ap.parse_args()
    tests = {"rice": test_rice, "geometry": test_geometry, "barnard": test_barnard, "edges": test_edges,
             "luhman": test_luhman}
    names = a.only.split(",") if a.only else list(tests)
    if a.skip_luhman and "luhman" in names:
        names.remove("luhman")
    t0 = time.monotonic()
    for n in names:
        tests[n]()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILURE(S)'} in {time.monotonic() - t0:.1f} s")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
