#!/usr/bin/env python3
"""Check: can scattered light from Epsilon Indi A, or a local background gradient, explain the
sky-fixed offset of Epsilon Indi B's SPHEREx position from its Gaia DR3 prediction?

Usage (from the fazari/ folder):
  uv run --no-project --with astropy --with reproject --with numpy --with scipy \
      --with matplotlib --with pillow python -I pipeline/eps_indi_check.py

Three tests, all on the WCS positions without the field-star calibration (both variants are
treated identically, so the comparison is clean):
 1. Background plane: in every exposure a plane is fitted to an annulus around B (6-14 native
    px, 3-sigma clipped, flagged pixels and catalogue stars excluded) and subtracted before the
    same Gaussian wing/centroid fit. Joint fit (position + proper motion + one detector-fixed
    bias per detector, parallax fixed) and per-season offsets, before and after.
 2. Direction: the local gradient and the direction to Eps Indi A, in sky and detector axes,
    per season/orientation, compared with the offset direction.
 3. Field stars: Gaia DR3 reference stars in the same exposures, grouped by distance from
    Eps Indi A; orientation-averaged measured - Gaia (detector-fixed centroid bias cancels).
Prints a report; writes nothing into site/.
"""
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blink  # noqa: E402

A = dict(source_id=6412595290592307840, ra=330.87240787960, dec=-56.79725466123, epoch=2016.0,
         pmra=3966.661, pmdec=-2536.192, plx=274.8431)          # Gaia DR3, G = 4.32


def plane_subtracted(px, x, y, r_in=6.0, r_out=14.0, star_xy=()):
    """Clean image minus a plane fitted to an annulus around (x, y). Returns (image, gx, gy)
    with the gradient in MJy/sr per native px."""
    img = px["clean"].astype(float)
    ny, nx = img.shape
    yy, xx = np.mgrid[:ny, :nx]
    rr = np.hypot(xx - x, yy - y)
    m = (rr >= r_in) & (rr < r_out) & px["good"] & np.isfinite(img)
    for sx, sy in star_xy:                                   # keep catalogue stars out
        m &= np.hypot(xx - sx, yy - sy) > 2.0
    X, Y, Z = (xx[m] - x).astype(float), (yy[m] - y).astype(float), img[m]
    use = np.ones(len(Z), bool)
    for _ in range(5):
        Am = np.stack([np.ones(use.sum()), X[use], Y[use]], 1)
        p, *_ = np.linalg.lstsq(Am, Z[use], rcond=None)
        res = Z - (p[0] + p[1] * X + p[2] * Y)
        s = blink.robust_sigma(res[use])
        new = np.abs(res) < 3 * s
        if (new == use).all():
            break
        use = new
    return img - (p[0] + p[1] * (xx - x) + p[2] * (yy - y)), float(p[1]), float(p[2])


def pa(e, n):
    return math.degrees(math.atan2(e, n)) % 360


def joint(t, rows, key, ra_c, dec_c):
    """blink.joint_fit on one centroid variant; per-season bias-corrected offsets from Gaia."""
    s = []
    for r in rows:
        if key not in r:
            continue
        q = dict(r["info"])
        q.update(r[key])
        s.append(q)
    fit, corr = blink.joint_fit(t, s, ra_c, dec_c)
    out = {}
    for q in s:
        db, ok = corr[q["file"]]
        if not ok:
            continue
        e, n = blink.offset_arcsec(q["ra_pred"], q["dec_pred"], q["ra_fit"], q["dec_fit"])[:2]
        out.setdefault(q["season"], []).append((e - db[0], n - db[1], q["orient_deg"]))
    seasons = {k: (np.mean([v[0] for v in vs]), np.mean([v[1] for v in vs]),
                   np.std([v[0] for v in vs]) / math.sqrt(len(vs)), np.std([v[1] for v in vs]) / math.sqrt(len(vs)),
                   len(vs), float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians([v[2] for v in vs])))))) % 360)
               for k, vs in out.items()}
    return fit, seasons


def main():
    name = "eps_indi_b"
    t = blink.load_target(name)
    ra_c, dec_c = blink.target_position(t, blink.Time(blink.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    gaia = blink.gaia_field(name, ra_c, dec_c)
    refs = blink.reference_stars(gaia, t, ra_c, dec_c)
    files = sorted(p for c in blink.COLLECTIONS for p in (blink.DATA / name / c).glob("*.fits"))
    rows, stars = [], []
    for p in files:
        info, clean, sat, wcs, _ = blink.read_exposure(p, t)
        if not info["inside"] or "ra_fit" not in info:
            continue
        px = info["_px"]
        x, y = info["x"], info["y"]
        J = np.array(info["jac_pred"])
        # catalogue stars near B, kept out of the plane fit
        sxy = []
        for s in refs:
            r_, d_ = blink.target_position(s, info["mjd"])
            if blink.offset_arcsec(r_, d_, info["ra_pred"], info["dec_pred"])[2] < 100:
                sxy.append(tuple(float(v) for v in wcs.all_world2pix(r_, d_, 0)))
        sub, gx, gy = plane_subtracted(px, x, y, star_xy=sxy)
        c = blink.centroid(sub, px["var"].astype(float), px["good"], x, y)
        ra_a, dec_a = blink.target_position(A, info["mjd"])
        ax, ay = (float(v) for v in wcs.all_world2pix(ra_a, dec_a, 0))
        gE, gN = J @ np.array([gx, gy])                       # gradient direction on the sky
        row = {"info": dict(info, _px=None), "gauss": {}, "grad_sky": (float(gE), float(gN)),
               "grad_px": (gx, gy), "to_A_px": (ax - x, ay - y)}
        row["info"]["season"] = info["date"][:7]
        if c:
            rr, dd = (float(v) for v in wcs.all_pix2world(c[0], c[1], 0))
            r1, d1 = (float(v) for v in wcs.all_pix2world(c[0] + 1, c[1], 0))
            r2, d2 = (float(v) for v in wcs.all_pix2world(c[0], c[1] + 1, 0))
            jx, jy = blink.offset_arcsec(rr, dd, r1, d1)[:2], blink.offset_arcsec(rr, dd, r2, d2)[:2]
            row["plane"] = dict(ra_fit=rr, dec_fit=dd, jac=[[jx[0], jy[0]], [jx[1], jy[1]]])
        rows.append(row)
        # field stars: residual vs distance to A
        for e, n, xe, xn, sid in blink.star_residuals(info, refs, "bright"):
            sr, sd = info["ra_pred"] + xe / math.cos(math.radians(info["dec_pred"])), info["dec_pred"] + xn
            stars.append((e, n, blink.offset_arcsec(sr, sd, ra_a, dec_a)[2] / 60, info["orient_deg"], info["detector"]))
    # season labels as in the pipeline
    ep = blink.split_epochs([r["info"]["mjd"] for r in rows])
    for r in rows:
        r["info"]["season"] = ep[r["info"]["mjd"]]

    print(f"{len(rows)} exposures, {len(stars)} field-star measurements")
    pa_A = pa(*blink.offset_arcsec(t["ra"], t["dec"], A["ra"], A["dec"])[:2])
    print(f"Eps Indi A from B: {blink.offset_arcsec(t['ra'], t['dec'], A['ra'], A['dec'])[2] / 60:.2f} arcmin at PA {pa_A:.0f} deg")

    print("\n1) background plane subtracted before the centroid (WCS positions, no field calibration)")
    res = {k: joint(t, rows, k, ra_c, dec_c) for k in ("gauss", "plane")}
    for k, (fit, seasons) in res.items():
        print(f"  {k:6}: joint-fit position - Gaia = {fit['pos_2026_minus_gaia_east_arcsec']:+.3f}\" E "
              f"{fit['pos_2026_minus_gaia_north_arcsec']:+.3f}\" N; pm {fit['pmra_mas_yr']:+.0f} +- {fit['pmra_err_mas_yr']:.0f}, "
              f"{fit['pmdec_mas_yr']:+.0f} +- {fit['pmdec_err_mas_yr']:.0f}; rms {fit['rms_per_exposure_arcsec']:.3f}")
        for se, v in sorted(seasons.items()):
            print(f"     {se} (orient {v[5]:5.1f}, N={v[4]:3d}): {v[0]:+.3f} +- {v[2]:.3f} E  {v[1]:+.3f} +- {v[3]:.3f} N")

    print("\n2) local gradient and direction to A, per season")
    for se in sorted({r["info"]["season"] for r in rows}):
        s = [r for r in rows if r["info"]["season"] == se]
        g = np.mean([r["grad_sky"] for r in s], 0)
        gp = np.mean([r["grad_px"] for r in s], 0)
        a = np.mean([r["to_A_px"] for r in s], 0)
        ori = float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians([r["info"]["orient_deg"] for r in s])))))) % 360
        print(f"  {se} orient {ori:5.1f}: gradient {math.hypot(*gp) * 1000:.2f} mMJy/sr/px toward sky PA {pa(*g):.0f} "
              f"(detector angle {math.degrees(math.atan2(gp[1], gp[0])) % 360:.0f}); A at detector angle "
              f"{math.degrees(math.atan2(a[1], a[0])) % 360:.0f}, {math.hypot(*a):.0f} px")

    print("\n3) field stars: orientation-averaged measured - Gaia vs distance from A (arcmin)")
    st = np.array([(e, n, d, math.cos(math.radians(o)) > 0) for e, n, d, o, _ in stars], float)
    for lo, hi in ((0, 5), (5, 6), (6, 7.5), (7.5, 9), (9, 20)):
        sel = (st[:, 2] >= lo) & (st[:, 2] < hi)
        if sel.sum() < 10:
            continue
        mA = st[sel & (st[:, 3] == 1)][:, :2]
        mB = st[sel & (st[:, 3] == 0)][:, :2]
        if len(mA) < 5 or len(mB) < 5:
            continue
        avg = (np.median(mA, 0) + np.median(mB, 0)) / 2
        err = np.hypot(1.2533 * np.std(mA, 0) / np.sqrt(len(mA)), 1.2533 * np.std(mB, 0) / np.sqrt(len(mB))) / 2
        print(f"  {lo:4.1f}-{hi:4.1f}': n={sel.sum():4d}  {avg[0]:+.3f} +- {err[0]:.3f} E  {avg[1]:+.3f} +- {err[1]:.3f} N")


if __name__ == "__main__":
    main()
