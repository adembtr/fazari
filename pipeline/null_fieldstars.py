"""No-change control for verify.html: do field stars that should not move show false motion?

Input: the per-star field calibration export of blink.py (field_stars.csv, see pipeline/ASTROMETRY.md),
made with  FAZARI_OUT=<tmp> blink.py <target>  (the site run does not write it).

Method (Python standard library only):
  1. Rows with status "used": unsaturated, isolated Gaia DR3 reference stars measured in each exposure
     with the same Gaussian centroid as a bright target. Residual = measured - Gaia (Gaia moved to
     the exposure time), east and north, arcsec, raw WCS.
  2. Hold-out calibration, so the test stars never calibrate themselves: the stars are split in two
     halves (by Gaia source_id); in every season x detector cell the shift of one half (median
     residual) is subtracted from the other half, and the other way round.
  3. Per star and season: inverse-variance mean of its calibrated residuals (>= 3 measurements).
  4. False motion of a star = residual(to season) - residual(from season), for the headline pair of
     the target's meta.json (same telescope orientation, ~1 yr). Gaia's own motion is already in
     the prediction, so a perfect method gives 0 for every star.
  Reported for the slow stars (Gaia proper motion < --pm-max mas/yr, default 20) and for all stars.

  python3 -I pipeline/null_fieldstars.py <field_stars.csv> [--target barnard] [--pm-max 20] [--out FILE]
Writes only --out (default site/data/verify/null_<target>.json, a new file).
"""

import csv
import json
import math
import statistics as st
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_MEAS = 3


def opt(name, default):
    if name in sys.argv:
        k = sys.argv.index(name)
        v = sys.argv[k + 1]
        del sys.argv[k:k + 2]
        return v
    return default


def robust_sigma(a):
    m = st.median(a)
    return 1.4826 * st.median([abs(x - m) for x in a])


def main():
    target = opt("--target", "barnard")
    pm_max = float(opt("--pm-max", "20"))
    out = Path(opt("--out", str(ROOT / "site" / "data" / "verify" / f"null_{target}.json")))
    src = Path(sys.argv[1])
    meta = json.loads((ROOT / "site" / "data" / target / "meta.json").read_text())
    m = meta["measured"]
    ep_from, ep_to = m["from_epoch"], m["to_epoch"]

    rows = [r for r in csv.DictReader(open(src, newline="")) if r["status"] == "used"]
    for r in rows:
        r["half"] = zlib.crc32(r["source_id"].encode()) % 2
        r["e"], r["n"] = float(r["east_arcsec"]), float(r["north_arcsec"])
        r["ee"], r["en"] = float(r["east_err_arcsec"]), float(r["north_err_arcsec"])
    # 2. hold-out cell shifts: cells[(season, detector, half)] = (median e, median n) of that half
    cells = {}
    for r in rows:
        cells.setdefault((r["season"], r["detector"], r["half"]), []).append((r["e"], r["n"]))
    shift = {k: (st.median(e for e, _ in v), st.median(n for _, n in v), len(v)) for k, v in cells.items()}
    # 3. per star x season, calibrated with the OTHER half
    acc = {}
    for r in rows:
        cal = shift.get((r["season"], r["detector"], 1 - r["half"]))
        if not cal or cal[2] < 5:
            continue
        w_e, w_n = 1 / max(r["ee"], 0.02) ** 2, 1 / max(r["en"], 0.02) ** 2
        a = acc.setdefault((r["source_id"], r["season"]), [0, 0, 0, 0, 0, r])
        a[0] += w_e * (r["e"] - cal[0]); a[1] += w_e
        a[2] += w_n * (r["n"] - cal[1]); a[3] += w_n
        a[4] += 1
    pos = {}
    for (sid, season), a in acc.items():
        if a[4] >= MIN_MEAS:
            pos[(sid, season)] = (a[0] / a[1], a[2] / a[3], 1 / math.sqrt(a[1]), 1 / math.sqrt(a[3]), a[4], a[5])
    # 4. false motion per star
    stars = []
    for (sid, season), p in pos.items():
        if season != ep_from or (sid, ep_to) not in pos:
            continue
        q = pos[(sid, ep_to)]
        r = p[5]
        pm = math.hypot(float(r["gaia_pmra"]), float(r["gaia_pmdec"]))
        de, dn = q[0] - p[0], q[1] - p[1]
        se, sn = math.hypot(p[2], q[2]), math.hypot(p[3], q[3])
        stars.append({"source_id": sid, "g": round(float(r["gaia_g"]), 2), "pm_mas_yr": round(pm, 1),
                      "de": round(de, 4), "dn": round(dn, 4), "err_e": round(se, 4), "err_n": round(sn, 4),
                      "n": [p[4], q[4]]})

    def summary(sel):
        if not sel:
            return None
        de = [s["de"] for s in sel]; dn = [s["dn"] for s in sel]
        tot = [math.hypot(a, b) for a, b in zip(de, dn)]
        # scale the formal errors by the robust scatter of the normalised motions (errors can be off)
        z = [x / s["err_e"] for x, s in zip(de, sel)] + [y / s["err_n"] for y, s in zip(dn, sel)]
        within = sum(1 for s in sel if abs(s["de"]) <= 3 * s["err_e"] and abs(s["dn"]) <= 3 * s["err_n"]) / len(sel)
        med_e, med_n = st.median(de), st.median(dn)
        # error of the median vector: 1.2533 * robust sigma / sqrt(N)
        return {
            "n_stars": len(sel),
            "median_vector_arcsec": [round(med_e, 4), round(med_n, 4)],
            "median_vector_err_arcsec": [round(1.2533 * robust_sigma(de) / math.sqrt(len(sel)), 4),
                                         round(1.2533 * robust_sigma(dn) / math.sqrt(len(sel)), 4)],
            "median_arcsec": round(math.hypot(med_e, med_n), 4),
            "scatter_arcsec": round(st.mean([robust_sigma(de), robust_sigma(dn)]), 4),
            "median_total_arcsec": round(st.median(tot), 4),
            "frac_within_3sigma": round(within, 3),
            "robust_sigma_of_normalised": round(robust_sigma(z), 3),
            "g_range": [min(s["g"] for s in sel), max(s["g"] for s in sel)],
            "max_gaia_pm_mas_yr": max(s["pm_mas_yr"] for s in sel),
        }

    slow = [s for s in stars if s["pm_mas_yr"] < pm_max]
    doc = {
        "target": meta["target"], "generator": "pipeline/null_fieldstars.py", "source_csv": src.name,
        "from": ep_from, "to": ep_to, "dt_years": m["dt_years"], "same_orientation": m.get("same_orientation"),
        "pm_max_mas_yr": pm_max,
        "slow": summary(slow), "all": summary(stars),
        "barnard_shift_arcsec": m["shift_arcsec"], "target_shift_err_arcsec": m["shift_err_arcsec"],
        "method": ("Gaia DR3 reference stars (G 10-17.5, RUWE <= 1.4, isolated, unsaturated, S/N >= 20) measured in the "
                   "target's exposures with the bright-target Gaussian centroid. Hold-out calibration: per season x detector, "
                   "the median residual of the other half of the stars is removed. Per star and season: inverse-variance "
                   "mean (>= 3 measurements). False motion = change of measured - Gaia between the two seasons."),
        "stars": sorted(stars, key=lambda s: s["g"]),
    }
    # flat fields used by verify.html
    if doc["slow"]:
        s = doc["slow"]
        doc.update(n_stars=s["n_stars"], median_arcsec=s["median_arcsec"], scatter_arcsec=s["scatter_arcsec"],
                   frac_within_3sigma=s["frac_within_3sigma"], g_range=s["g_range"], max_gaia_pm_mas_yr=pm_max)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1))
    print("wrote", out)
    for k in ("slow", "all"):
        print(k, json.dumps(doc[k]))


if __name__ == "__main__":
    main()
