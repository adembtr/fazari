"""Three checks added on 2026-11-15, after the fast-star sweep, from data that were already on disk.

No new SPHEREx data and no new measurement: each check re-reads an existing output and writes one
small JSON for site/verify.html. None of them changes a test status in site/data/verify/tests.json.

  errscale  V12 error-bar multiplier k from the 86 measured stars of the sweep.
            Reads  site/data/fast_sweep/stars.csv
            Writes site/data/fast_sweep/error_scale.json
  w2        WISE 0855-0714: SPHEREx flux in the WISE W2 band against the AllWISE W2 magnitude.
            Reads  site/data/wise0855/spectrum.json (binned spectrum of pipeline/spectrum.py)
            Writes site/data/wise0855/w2_check.json
  align     Field-star residuals after the Gaia alignment, per exposure (pipeline/ASTROMETRY.md).
            Reads  a field_stars.csv export of blink.py (Barnard's Star: the local engine run
                   cache/jobs/barnard-local/, whose per-exposure corrections in images.csv equal
                   those of site/data/barnard/images.csv for all 358 exposures; --field-stars FILE)
            Writes site/data/verify/align_residuals.json

Python standard library only:
  python3 -I pipeline/extra_checks.py errscale|w2|align|all [--field-stars FILE]
Methods, numbers and their limits: pipeline/FAST_SWEEP.md, pipeline/FAINT.md (WISE 0855 against W2) and
pipeline/ASTROMETRY.md, in the sections dated 2026-11-15.
"""

import argparse
import csv
import json
import math
import random
import statistics as st
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
ADDED = "2026-11-15, after the fast-star sweep (extra information; no test was re-graded)"

# 2-D chi2 limits of 1 / 2 / 3 sigma (68.3 / 95.4 / 99.7 %), as in pipeline/fast_sweep.py
CHI2_LIM = (2.30, 6.18, 11.83)
EXPECT_FRAC = (0.683, 0.954, 0.997)
MEDIAN_CHI2_2DOF = 2 * math.log(2)          # 1.386
BOOT_N, BOOT_SEED = 10000, 20261115


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def commit():
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True,
                              text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def pct(xs, q):
    """Percentile (linear interpolation) of a list."""
    s = sorted(xs)
    if not s:
        return None
    i = (len(s) - 1) * q / 100
    lo, hi = math.floor(i), math.ceil(i)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)


def write(path, obj):
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False) + "\n")
    print("wrote", path.relative_to(ROOT))


# ------------------------------------------------------------------------------------------ errscale
def errscale():
    """One multiplier k for the V12 error bars.

    chi2 of a star = (dE/eE)^2 + (dN/eN)^2, the 2-D chi2 of pipeline/fast_sweep.py compare() with
    rho_EN = 0 (the sweep's fits gave |rho_EN| < 1e-15 for all 86 stars, so the formula is exact).
    k = sqrt(mean chi2 / 2): the RMS of the 172 normalised pull components, i.e. chi2/dof with 2 dof
    per star. Its +- is the 16-84 % range of a bootstrap over the stars. With the errors scaled by k,
    a star is within n sigma when chi2 / k^2 <= 2.30 / 6.18 / 11.83.
    """
    src = DATA / "fast_sweep" / "stars.csv"
    rows = [r for r in csv.DictReader(src.open()) if r["status"] == "measured"]
    f = lambda r, k: float(r[k])
    chi2 = []
    for r in rows:
        zE = (f(r, "meas_pmra_mas_yr") - f(r, "gaia_pmra_mas_yr")) / f(r, "err_pmra_mas_yr")
        zN = (f(r, "meas_pmdec_mas_yr") - f(r, "gaia_pmdec_mas_yr")) / f(r, "err_pmdec_mas_yr")
        chi2.append(zE * zE + zN * zN)
    n = len(chi2)
    # the table's own flags must come out of the same numbers
    flags = [sum(r[c] == "True" for r in rows) for c in ("within_1sigma", "within_2sigma", "pass_3sigma")]
    raw = [sum(x <= lim for x in chi2) for lim in CHI2_LIM]
    if raw != flags:
        sys.exit(f"errscale: recomputed counts {raw} differ from stars.csv flags {flags}")

    k = math.sqrt(sum(chi2) / (2 * n))
    rng = random.Random(BOOT_SEED)
    boot = sorted(math.sqrt(sum(rng.choices(chi2, k=n)) / (2 * n)) for _ in range(BOOT_N))
    k_lo, k_hi = pct(boot, 16), pct(boot, 84)
    k_med = math.sqrt(st.median(chi2) / MEDIAN_CHI2_2DOF)
    rng = random.Random(BOOT_SEED + 1)
    bmed = sorted(math.sqrt(st.median(rng.choices(chi2, k=n)) / MEDIAN_CHI2_2DOF) for _ in range(BOOT_N))
    # the k each level alone would need: the smallest k that puts the expected share of stars inside
    need = {}
    for lim, p, name in zip(CHI2_LIM, EXPECT_FRAC, ("1sigma", "2sigma", "3sigma")):
        ks = sorted(math.sqrt(x / lim) for x in chi2)
        need[name] = round(ks[math.ceil(p * n) - 1], 2)
    scaled = [sum(x / k ** 2 <= lim for x in chi2) for lim in CHI2_LIM]
    at = lambda kk: [sum(x / kk ** 2 <= lim for x in chi2) for lim in CHI2_LIM]
    # per-axis error of a star as in fast_sweep_report.py stats(): hypot(eE, eN) / sqrt(2)
    med_e = st.median([math.hypot(f(r, "err_pmra_mas_yr"), f(r, "err_pmdec_mas_yr")) / math.sqrt(2) for r in rows]) / 1000
    bar = next((r for r in rows if r["name"] == "Barnard's Star"), None)
    out = {
        "what": "One multiplier k for the 2-D error bars of the fast-star sweep (test V12), from the 86 measured stars",
        "added": ADDED,
        "status_note": "V12 keeps its status: its rule (every measured star within 3 sigma) is applied to the raw error bars. k is extra information.",
        "source": "site/data/fast_sweep/stars.csv",
        "code": "pipeline/extra_checks.py errscale",
        "repo_head_when_built": commit(),
        "built": now(),
        "n": n,
        "method": "k = sqrt(mean chi2 / 2) = RMS of the 2n normalised pull components (chi2/dof, 2 dof per star); "
                  "chi2 = (dE/eE)^2 + (dN/eN)^2 (rho_EN = 0 in every fit); +- = 16-84 % bootstrap over the stars",
        "k": round(k, 3),
        "k_err": round((k_hi - k_lo) / 2, 3),
        "k_ci68": [round(k_lo, 3), round(k_hi, 3)],
        "bootstrap": {"n": BOOT_N, "seed": BOOT_SEED},
        "mean_chi2": round(sum(chi2) / n, 3),
        "median_chi2": round(st.median(chi2), 3),
        "expected_within_1_2_3sigma": [round(p * n, 1) for p in EXPECT_FRAC],
        "raw_within_1_2_3sigma": raw,
        "scaled_within_1_2_3sigma": scaled,
        "scaled_within_at_k_ci68": [at(k_lo), at(k_hi)],
        "outside_3sigma_raw": n - raw[2],
        "outside_3sigma_scaled": n - scaled[2],
        "k_from_median_chi2": round(k_med, 3),
        "k_from_median_chi2_ci68": [round(pct(bmed, 16), 3), round(pct(bmed, 84), 3)],
        "k_needed_per_level": need,
        "median_error_arcsec_yr_per_axis": {"raw": round(med_e, 4), "scaled": round(med_e * k, 4)},
        "largest_chi2": [round(x, 2) for x in sorted(chi2)[-5:]],
    }
    if bar:
        out["barnard"] = {"speed_arcsec_yr": f(bar, "meas_pm_arcsec_yr"), "err_raw": f(bar, "meas_pm_err_arcsec_yr"),
                          "err_scaled": round(f(bar, "meas_pm_err_arcsec_yr") * k, 4), "gaia": f(bar, "gaia_pm_arcsec_yr")}
    write(DATA / "fast_sweep" / "error_scale.json", out)
    print(f"  k = {k:.3f} +- {(k_hi - k_lo) / 2:.3f} (68 %: {k_lo:.3f}-{k_hi:.3f}); within 1/2/3 sigma raw {raw}, "
          f"with k {scaled}, expected {out['expected_within_1_2_3sigma']}; k from median chi2 {k_med:.3f}; "
          f"k each level alone needs {need}")


# ------------------------------------------------------------------------------------------ w2
# WISE W2 (Wright et al. 2010, AJ 140, 1868; Jarrett et al. 2011, ApJ 735, 112): isophotal wavelength and
# the flux density of magnitude 0 for a source with F_nu ~ nu^-2 (the calibration spectrum of the system).
W2_LAMBDA_ISO_UM = 4.6028
W2_F0_JY = 171.787
W2_F0_ERR_JY = 2.516
W2_BAND_UM = (4.0, 5.0)      # top-hat: the part of the W2 response (~4.0-5.2 um) that SPHEREx covers (to 5.0 um)
# AllWISE Source Catalog (Cutri et al. 2013), the row of WISE 0855-0714 at its 2010 position, from an IRSA Gator
# cone search of radius 15" around (133.7951, -7.2451) on 2026-11-15 (the only source within 15"):
ALLWISE = {"designation": "J085510.74-071442.5", "ra": 133.7947597, "dec": -7.2451456,
           "w2mpro": 13.704, "w2sigmpro": 0.033, "w2snr": 32.4, "ph_qual": "AABU", "cc_flags": "0000", "nb": 1,
           "w2mjdmean": 55412.33,
           "source": "AllWISE Source Catalog (Cutri et al. 2013, IRSA, doi:10.26131/IRSA1), Gator cone search 2026-11-15"}


def w2():
    """W2-equivalent magnitude of WISE 0855-0714 from the SPHEREx binned spectrum.

    1. The binned spectrum of spectrum.json (per season x detector, 6 bins per detector: inverse-variance means
       of detections and non-detections, error inflated by sqrt(chi2r)) is pooled over the seasons per bin
       (inverse-variance mean, error inflated by sqrt(chi2r) when the seasons scatter more than their errors).
    2. The W2 response is approximated by a top-hat over the bins inside 4.0-5.0 um (photon counting):
       F_W2 = sum(F_i ln(b_i/a_i)) / sum((b_i^2 - a_i^2) / (2 lambda_iso^2)), i.e. the flux density at
       lambda_iso of a nu^-2 source that gives the same photon count; W2 = -2.5 log10(F_W2 / F0).
    """
    src = DATA / "wise0855" / "spectrum.json"
    spec = json.loads(src.read_text())
    lo_b, hi_b = W2_BAND_UM
    bins = {}
    for b in spec["binned"]:
        if b.get("kind") != "measured" or b.get("flux_err_ujy") in (None, 0) or b.get("flux_ujy") is None:
            continue
        a, c = float(b["lam_lo_um"]), float(b["lam_hi_um"])
        if c <= lo_b or a >= hi_b:
            continue
        bins.setdefault((b["detector"], a, c), []).append(b)
    num = den = var = 0.0
    used = []
    for (det, a, c), bs in sorted(bins.items(), key=lambda kv: kv[0][1]):
        a2, c2 = max(a, lo_b), min(c, hi_b)
        w = [1 / float(b["flux_err_ujy"]) ** 2 for b in bs]
        fl = [float(b["flux_ujy"]) for b in bs]
        m = sum(wi * fi for wi, fi in zip(w, fl)) / sum(w)
        e = 1 / math.sqrt(sum(w))
        if len(bs) > 1:
            c2r = sum(wi * (fi - m) ** 2 for wi, fi in zip(w, fl)) / (len(bs) - 1)
            e *= max(1.0, math.sqrt(c2r))
        wt = math.log(c2 / a2)                                  # photon counting: dlambda / lambda
        num += m * wt
        var += (e * wt) ** 2
        den += (c2 * c2 - a2 * a2) / (2 * W2_LAMBDA_ISO_UM ** 2)
        used.append({"detector": det, "lam_lo_um": a, "lam_hi_um": c, "seasons": [b["season"] for b in bs],
                     "flux_ujy": round(m, 1), "flux_err_ujy": round(e, 1)})
    F, E = num / den, math.sqrt(var) / den
    # same band, energy-counting weights (dlambda / lambda^2) and nu^-2 calibrator: a sensitivity check only
    ne = sum(u["flux_ujy"] * (1 / max(u["lam_lo_um"], lo_b) - 1 / min(u["lam_hi_um"], hi_b)) for u in used)
    de = sum((min(u["lam_hi_um"], hi_b) - max(u["lam_lo_um"], lo_b)) / W2_LAMBDA_ISO_UM ** 2 for u in used)
    F_energy = ne / de
    mag = -2.5 * math.log10(F / (W2_F0_JY * 1e6))
    mag_e = 2.5 / math.log(10) * E / F
    d = mag - ALLWISE["w2mpro"]
    d_e = math.hypot(mag_e, ALLWISE["w2sigmpro"])
    cov = sum(math.log(min(u["lam_hi_um"], hi_b) / max(u["lam_lo_um"], lo_b)) for u in used)
    out = {
        "what": "WISE 0855-0714: SPHEREx flux averaged over the WISE W2 band, as a W2 magnitude, against the AllWISE catalogue",
        "added": ADDED,
        "source": "site/data/wise0855/spectrum.json (binned spectrum, pipeline/spectrum.py)",
        "code": "pipeline/extra_checks.py w2",
        "repo_head_when_built": commit(),
        "built": now(),
        "band_um": [round(max(lo_b, min(u["lam_lo_um"] for u in used)), 3), hi_b],
        "band_note": "top-hat over the SPHEREx bins inside 4.0-5.0 um (W2 response ~4.0-5.2 um; SPHEREx stops at 5.0 um; "
                     "the 4.41-4.42 um gap between detectors D5 and D6 is left out of both sums); photon-counting weights; "
                     "seasons pooled per bin",
        "covered_fraction_of_band_ln": round(cov / math.log(hi_b / lo_b), 3),
        "zero_point": {"lambda_iso_um": W2_LAMBDA_ISO_UM, "F0_jy": W2_F0_JY, "F0_err_jy": W2_F0_ERR_JY,
                       "ref": "Wright et al. 2010, AJ 140, 1868; Jarrett et al. 2011, ApJ 735, 112 (nu^-2 calibration spectrum)"},
        "spherex": {"flux_ujy": round(F, 1), "flux_err_ujy": round(E, 1), "w2_vega_mag": round(mag, 3),
                    "w2_vega_mag_err": round(mag_e, 3), "n_bins": len(used),
                    "seasons": sorted({s for u in used for s in u["seasons"]}),
                    "flux_ujy_energy_counting": round(F_energy, 1)},
        "allwise": ALLWISE,
        "allwise_flux_ujy": round(W2_F0_JY * 1e6 * 10 ** (-0.4 * ALLWISE["w2mpro"]), 1),
        "diff_mag": round(d, 3),
        "diff_mag_err": round(d_e, 3),
        "diff_sigma": round(d / d_e, 2),
        "flux_ratio_spherex_over_allwise": round(10 ** (-0.4 * d), 3),
        "flux_scale_check": "spectrum.json caveat: two unsaturated field stars agree with 2MASS and AllWISE W1/W2 to 0.93-1.06 "
                            "(about +-6 %, not included in the +- above)",
        "caveats": ["AllWISE is from 2010 (mean W2 epoch MJD 55412), SPHEREx from 2025-2026; the object is known to vary at 4.5 um by a few per cent",
                    "the W2 response is replaced by a top-hat; the 5.0-5.2 um part of W2 is not seen by SPHEREx"],
        "bins": used,
    }
    write(DATA / "wise0855" / "w2_check.json", out)
    print(f"  SPHEREx W2-equivalent {F:.0f} +- {E:.0f} uJy = W2 {mag:.3f} +- {mag_e:.3f}; AllWISE {ALLWISE['w2mpro']} +- "
          f"{ALLWISE['w2sigmpro']}; diff {d:+.3f} +- {d_e:.3f} mag ({d / d_e:+.1f} sigma); ratio {10 ** (-0.4 * d):.3f}; "
          f"energy-counting {F_energy:.0f} uJy")


# ------------------------------------------------------------------------------------------ align
DEF_FIELD_STARS = ROOT / "cache" / "jobs" / "barnard-local" / "field_stars.csv"


def mad_sigma(xs):
    m = st.median(xs)
    return 1.4826 * st.median([abs(x - m) for x in xs])


def align(path):
    """Per exposure: median and robust scatter of the field-star offsets after the Gaia alignment.

    Offset after alignment = (east_arcsec - calib_east_arcsec, north_arcsec - calib_north_arcsec) for every
    reference star with status "used" (ASTROMETRY.md, field_stars.csv). Per exposure: the median offset (E, N)
    and the star-to-star scatter sqrt((sE^2 + sN^2) / 2), s = 1.4826 MAD (exposures with >= 5 stars).
    """
    path = Path(path)
    if not path.exists():
        sys.exit(f"align: {path} not found (a field_stars.csv export of blink.py; --field-stars FILE)")
    exp = {}
    for r in csv.DictReader(path.open()):
        if r["status"] != "used" or r["calib_east_arcsec"] == "" or r["east_arcsec"] == "":
            continue
        e = float(r["east_arcsec"]) - float(r["calib_east_arcsec"])
        n = float(r["north_arcsec"]) - float(r["calib_north_arcsec"])
        exp.setdefault(r["file"], {"det": r["detector"], "season": r["season"], "pts": []})["pts"].append((e, n))
    per = []
    for f, x in exp.items():
        es, ns = [p[0] for p in x["pts"]], [p[1] for p in x["pts"]]
        mE, mN = st.median(es), st.median(ns)
        sc = math.sqrt((mad_sigma(es) ** 2 + mad_sigma(ns) ** 2) / 2) if len(es) >= 5 else None
        per.append({"det": x["det"], "season": x["season"], "n": len(es), "mE": mE, "mN": mN, "off": math.hypot(mE, mN), "sc": sc})

    def row(name, sel):
        offs = [p["off"] for p in sel]
        scs = [p["sc"] for p in sel if p["sc"] is not None]
        return {"group": name, "exposures": len(sel), "stars_per_exposure_median": st.median([p["n"] for p in sel]),
                "median_E_arcsec": round(st.median([p["mE"] for p in sel]), 3),
                "median_N_arcsec": round(st.median([p["mN"] for p in sel]), 3),
                "offset_median_arcsec": round(st.median(offs), 3), "offset_p90_arcsec": round(pct(offs, 90), 3),
                "scatter_median_arcsec_per_axis": round(st.median(scs), 3) if scs else None}
    dets = sorted({p["det"] for p in per})
    table = [row(d, [p for p in per if p["det"] == d]) for d in dets] + [row("all", per)]
    target = "Barnard's Star" if "barnard" in str(path) else path.parent.name
    out = {
        "what": "Field-star offsets from Gaia DR3 after the Gaia alignment of pipeline/blink.py, per exposure",
        "added": ADDED,
        "target": target,
        "source": ("cache/" + str(path).split("/cache/", 1)[1]) if "/cache/" in str(path) else path.name,
        "source_note": "field_stars.csv of a local engine run of blink.py; its per-exposure corrections (images.csv "
                       "calib_east/north_arcsec) equal those of site/data/barnard/images.csv for all 358 exposures",
        "code": "pipeline/extra_checks.py align",
        "repo_head_when_built": commit(),
        "built": now(),
        "method": "offset = measured - Gaia - applied correction, per reference star with status 'used'; per exposure the "
                  "median offset (E, N) and the star-to-star scatter sqrt((sE^2+sN^2)/2), s = 1.4826 MAD (>= 5 stars). "
                  "Columns: median of the per-exposure medians (E, N); median and 90th percentile of the per-exposure "
                  "offset length; median of the per-exposure scatter",
        "pixel_arcsec": 6.2,
        "stars_used": sum(p["n"] for p in per),
        "table": table,
    }
    write(DATA / "verify" / "align_residuals.json", out)
    print("  | group | exposures | stars/exp | median E | median N | |offset| median | |offset| P90 | scatter/axis |")
    for t in table:
        print(f"  | {t['group']} | {t['exposures']} | {t['stars_per_exposure_median']:g} | {t['median_E_arcsec']:+.3f} | "
              f"{t['median_N_arcsec']:+.3f} | {t['offset_median_arcsec']:.3f} | {t['offset_p90_arcsec']:.3f} | "
              f"{t['scatter_median_arcsec_per_axis']:.3f} |")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("check", choices=["errscale", "w2", "align", "all"])
    ap.add_argument("--field-stars", default=str(DEF_FIELD_STARS), help="field_stars.csv for 'align'")
    a = ap.parse_args()
    if a.check in ("errscale", "all"):
        errscale()
    if a.check in ("w2", "all"):
        w2()
    if a.check in ("align", "all"):
        align(a.field_stars)


if __name__ == "__main__":
    main()
