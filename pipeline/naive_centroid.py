"""Naive positions of a saturated star, for comparison with our wing fit (verify.html, "Why you can
trust this").

On the SAME exposures that blink.py used for the target (images.csv: inside the cutout, wing fit
succeeded), two naive estimates of the star's position are made, with no saturation handling and no
Gaia field-star calibration:

  brightest  the brightest finite pixel within 5 native pixels of the predicted position;
  moment     the brightness-weighted centre (first moment) of an 11 x 11 native-pixel box (larger
             than the saturated core, so the result follows the blob, not the box), re-centred 5 times. Saturated / missing pixels (the core, NaN in the L2 image) are filled with the
             brightest finite value in the box, i.e. the core is treated as a flat white blob, as it
             looks in a picture.

Season position = median of the per-exposure positions (RA, Dec through each exposure's own WCS).
The shift between two seasons is compared with the Gaia DR3 prediction and with our own result
from meta.json. Also exported: the pixels of one exposure (box around the star, saturated pixels,
the pixels our wing fit uses) for the figure on verify.html.

Reads the cutouts (FAZARI_DATA or ../veri/real_spherex), site/data/<target>/images.csv and meta.json.
Writes only --out (default site/data/verify/naive_<target>.json, a new file).

  uv run --no-project --with astropy --with numpy --with scipy --with pillow --with reproject \
      python -I pipeline/naive_centroid.py [barnard] [--out FILE]
"""

import csv
import json
import math
import sys
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blink  # noqa: E402  (same target propagation, flag bits and data directory as the pipeline)

FIT_HALF = 5          # blink.centroid() box: 11 x 11 native pixels
MOM_HALF = 5          # naive first-moment box: 11 x 11 (larger than the saturated core)
PEAK_R = 5            # brightest pixel searched within this many pixels of the prediction
FIG_HALF = 6          # figure: 13 x 13 pixels


def season_median(rows):
    ra = np.array([r[0] for r in rows]); dec = np.array([r[1] for r in rows])
    # median of the tangent-plane offsets from the first point (no RA wrap issues here)
    ra0, dec0 = ra[0], dec[0]
    e = (ra - ra0) * math.cos(math.radians(dec0)) * 3600
    n = (dec - dec0) * 3600
    me, mn = float(np.median(e)), float(np.median(n))
    # robust error of the median: 1.2533 * 1.4826 * MAD / sqrt(N)
    se = 1.2533 * 1.4826 * float(np.median(np.abs(e - me))) / math.sqrt(len(e))
    sn = 1.2533 * 1.4826 * float(np.median(np.abs(n - mn))) / math.sqrt(len(n))
    return ra0 + me / 3600 / math.cos(math.radians(dec0)), dec0 + mn / 3600, se, sn


def naive_positions(path, t):
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        img = h["IMAGE"].data.astype(np.float64)
        flg = h["FLAGS"].data.astype(np.int64)
        zodi = h["ZODI"].data.astype(np.float64)
        wcs = WCS(hd)
        mjd = float(hd.get("MJD-AVG", hd["MJD-OBS"]))
    ra_p, dec_p = blink.target_position(t, mjd)
    x, y = (float(v) for v in wcs.all_world2pix(ra_p, dec_p, 0))
    sat = (flg & blink.SAT_BITS) != 0
    bad = ((flg & blink.BAD_BITS) != 0) & ~sat
    clean = img - zodi
    clean[bad] = np.nan
    good = np.isfinite(clean) & ~sat
    clean -= np.nanmedian(clean[good])
    ny, nx = clean.shape
    out = {"mjd": mjd, "x_pred": x, "y_pred": y}

    # brightest finite, unsaturated pixel near the prediction
    ix, iy = int(round(x)), int(round(y))
    ys, xs = slice(max(iy - PEAK_R, 0), min(iy + PEAK_R + 1, ny)), slice(max(ix - PEAK_R, 0), min(ix + PEAK_R + 1, nx))
    sub = np.where(good[ys, xs], clean[ys, xs], -np.inf)
    j = np.unravel_index(int(np.argmax(sub)), sub.shape)
    bx, by = xs.start + j[1], ys.start + j[0]
    out["brightest"] = tuple(float(v) for v in wcs.all_pix2world(bx, by, 0)) + (float(bx), float(by))

    # first moment with the saturated core filled flat (11 x 11 box; 7 x 7 as a variant)
    for key, half in (("moment", MOM_HALF), ("moment7", 3)):
        c = moment(clean, sat, x, y, half)
        if c:
            out[key] = tuple(float(v) for v in wcs.all_pix2world(c[0], c[1], 0)) + c
    if "moment" not in out:
        return out
    out["_img"] = (clean, sat, bad, wcs)
    return out


def moment(clean, sat, x, y, half, iters=5):
    """Brightness-weighted centre of a (2 half + 1)^2 box, re-centred iters times; saturated or
    missing pixels are filled with the brightest finite value in the box (a flat white core)."""
    ny, nx = clean.shape
    cx, cy = x, y
    for _ in range(iters):
        jx, jy = int(round(cx)), int(round(cy))
        if not (half <= jx < nx - half and half <= jy < ny - half):
            return None
        ys, xs = slice(jy - half, jy + half + 1), slice(jx - half, jx + half + 1)
        b = clean[ys, xs].copy()
        hole = ~np.isfinite(b) | sat[ys, xs]
        top = np.nanmax(np.where(hole, np.nan, b)) if np.any(~hole) else 1.0
        b[hole] = top
        b = np.clip(b, 0, None)
        yy, xx = np.mgrid[ys, xs]
        w = b.sum()
        if w <= 0:
            return None
        cx, cy = float((xx * b).sum() / w), float((yy * b).sum() / w)
    return cx, cy


def figure(info, row, t):
    """Pixels of one exposure around the star for verify.html (y = 0 is the bottom row)."""
    clean, sat, bad, wcs = info["_img"]
    xf, yf = float(row["x_fit"]), float(row["y_fit"])
    ix, iy = int(round(info["x_pred"])), int(round(info["y_pred"]))
    H = FIG_HALF
    box = clean[iy - H:iy + H + 1, ix - H:ix + H + 1]
    sbox = sat[iy - H:iy + H + 1, ix - H:ix + H + 1] | ~np.isfinite(box)
    fin = box[np.isfinite(box) & ~sbox]
    hi = float(np.percentile(fin, 99.5)) if fin.size else 1.0
    soft = hi / 30
    def tone(v):
        if not np.isfinite(v):
            return None
        return int(round(255 * np.clip(np.arcsinh(max(v, 0) / soft) / np.arcsinh(hi / soft), 0, 1)))
    pixels = [[tone(box[j, i]) for i in range(2 * H + 1)] for j in range(2 * H + 1)]
    satm = [[bool(sbox[j, i]) for i in range(2 * H + 1)] for j in range(2 * H + 1)]
    fitm = [[bool(abs(i + ix - H - int(round(info["x_pred"]))) <= FIT_HALF and abs(j + iy - H - int(round(info["y_pred"]))) <= FIT_HALF
                  and not sbox[j, i] and not bad[iy - H + j, ix - H + i]) for i in range(2 * H + 1)] for j in range(2 * H + 1)]
    rel = lambda px, py: [round(px - (ix - H), 2), round(py - (iy - H), 2)]
    return {
        "file": row["file"], "date": row["date"], "detector": row["detector"],
        "wavelength_um": round(float(row["wavelength_um"]), 3), "box": 2 * H + 1, "fit_box": 2 * FIT_HALF + 1,
        "pixel_arcsec": blink.PIX_NATIVE, "n_saturated": int(sbox.sum()),
        "n_fit_pixels": int(sum(map(sum, fitm))),
        "pixels": pixels, "saturated": satm, "fit": fitm,
        "xy_gaia": rel(info["x_pred"], info["y_pred"]), "xy_fit": rel(xf, yf),
        "xy_moment": rel(*info["moment"][2:]) if "moment" in info else None,
        "xy_brightest": rel(*info["brightest"][2:]),
        "note": "native pixels (not north-up); y = 0 is the bottom row; saturated = FLAGS OVERFLOW/SUR_ERROR/NONLINEAR or NaN",
    }


def main():
    args = [a for a in sys.argv[1:]]
    out = None
    if "--out" in args:
        k = args.index("--out"); out = Path(args[k + 1]); del args[k:k + 2]
    name = args[0] if args else "barnard"
    out = out or blink.ROOT / "site" / "data" / "verify" / f"naive_{name}.json"
    t = blink.load_target(name)
    site = blink.ROOT / "site" / "data" / name
    meta = json.loads((site / "meta.json").read_text())
    m = meta["measured"]
    rows = [r for r in csv.DictReader(open(site / "images.csv", newline="")) if r["inside"] == "True" and r["ra_fit"]]
    lst = blink.listing(name)
    per = {}            # epoch -> method -> list of (ra, dec)
    fig = None
    n_fail = 0
    # figure exposure: first season, D3, wavelength closest to 2.0 um, a normal wing fit (width 1-3 px)
    cand = [r for r in rows if r["epoch"] == m["from_epoch"] and r["detector"] == "D3" and 1.0 < float(r["fit_quality"] or 0) < 3.0]
    fig_file = min(cand, key=lambda r: abs(float(r["wavelength_um"]) - 2.0))["file"] if cand else None
    for r in rows:
        col = lst.get(r["file"], {}).get("collection") or r.get("collection")
        path = blink.DATA / name / col / r["file"]
        if not path.exists():
            n_fail += 1
            continue
        info = naive_positions(path, t)
        for meth in ("brightest", "moment", "moment7"):
            if meth in info:
                per.setdefault(r["epoch"], {}).setdefault(meth, []).append(info[meth][:2])
        if fig is None and r["file"] == fig_file and "moment" in info:
            fig = figure(info, r, t)
    seasons = {}
    for ep, d in per.items():
        seasons[ep] = {meth: dict(zip(("ra", "dec", "err_east_arcsec", "err_north_arcsec"), season_median(v)), n=len(v))
                       for meth, v in d.items()}
    methods = []
    for meth in ("brightest", "moment", "moment7"):
        pairs = []
        for p in m.get("pairs") or []:
            a, b = seasons.get(p["from"], {}).get(meth), seasons.get(p["to"], {}).get(meth)
            if not a or not b:
                continue
            de, dn, s, pa = blink.offset_arcsec(a["ra"], a["dec"], b["ra"], b["dec"])
            err = math.hypot(math.hypot(a["err_east_arcsec"], b["err_east_arcsec"]), math.hypot(a["err_north_arcsec"], b["err_north_arcsec"])) / math.sqrt(2)
            pairs.append({"from": p["from"], "to": p["to"], "same_orientation": p.get("same_orientation"),
                          "shift_arcsec": round(s, 3), "pa_deg": round(pa, 2), "err_arcsec": round(err, 3),
                          "gaia_arcsec": p["gaia_predicted_arcsec"], "gaia_pa_deg": p["gaia_pa_deg"],
                          "ours_arcsec": p["shift_arcsec"], "ours_pa_deg": p["pa_deg"],
                          "n": [a["n"], b["n"]]})
        head = next((p for p in pairs if p["from"] == m["from_epoch"] and p["to"] == m["to_epoch"]), None)
        if head:
            methods.append({"id": meth, "shift_arcsec": head["shift_arcsec"], "pa_deg": head["pa_deg"],
                            "err_arcsec": head["err_arcsec"], "pairs": pairs})
    doc = {
        "target": meta["target"], "generator": "pipeline/naive_centroid.py",
        "from": m["from_epoch"], "to": m["to_epoch"], "dt_years": m["dt_years"],
        "gaia_arcsec": m["gaia_predicted_arcsec"], "gaia_pa_deg": m["gaia_pa_deg"],
        "ours_arcsec": m["shift_arcsec"], "ours_err_arcsec": m["shift_err_arcsec"], "ours_pa_deg": m["pa_deg"],
        "n_exposures": [len(per.get(m["from_epoch"], {}).get("moment", [])), len(per.get(m["to_epoch"], {}).get("moment", []))],
        "n_missing_files": n_fail,
        "methods": methods,
        "method_text": {
            "brightest": f"brightest finite, unsaturated pixel within {PEAK_R} native px of the predicted position",
            "moment": f"first moment of a {2 * MOM_HALF + 1}x{2 * MOM_HALF + 1} native-px box, re-centred 5 times, saturated/missing "
                      "core filled with the brightest finite value in the box",
            "moment7": "the same with a 7x7 box (variant, to show how much the choice matters)",
            "season": "median of the per-exposure RA/Dec (each exposure's own WCS); no field-star calibration, no detector-bias model",
        },
        "core": fig,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1))
    print("wrote", out)
    for me in methods:
        print(f"  {me['id']:10s} headline {me['shift_arcsec']:.3f} +- {me['err_arcsec']:.3f}\" PA {me['pa_deg']:.1f}")
        for p in me["pairs"]:
            print(f"     {p['from']} -> {p['to']} same={p['same_orientation']}: {p['shift_arcsec']:.3f}\" PA {p['pa_deg']:.1f} | ours {p['ours_arcsec']} | Gaia {p['gaia_arcsec']}")
    print(f"  ours {m['shift_arcsec']} +- {m['shift_err_arcsec']}, Gaia {m['gaia_predicted_arcsec']}")


if __name__ == "__main__":
    main()
