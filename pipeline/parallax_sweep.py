"""Parallax of the fast-star sweep stars from their SPHEREx season positions, compared with Gaia DR3.

Rule (sample, model, errors, decision) fixed before this code was written: pipeline/PARALLAX_SWEEP_RULE.md
(commit 6549d13). Reads only cache/fast_sweep/results/B0.12_K3/*.json and site/data/fast_stars.json.gz.
Writes site/data/fast_sweep/parallax.csv and parallax_summary.json.

    uv run --no-project --with numpy,astropy python -I pipeline/parallax_sweep.py
"""
import csv
import glob
import gzip
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
from astropy.coordinates import get_body_barycentric  # noqa: E402
from astropy.time import Time  # noqa: E402


def parallax_factors(ra, dec, mjd_):
    """(east, north) displacement per mas of parallax at time mjd (Earth barycentric). Same formula as
    detect/calib.parallax_factors (copied: importing detect pulls in blink.py and its image libraries)."""
    X, Y, Z = get_body_barycentric("earth", Time(mjd_, format="mjd")).xyz.to_value("AU")
    a, d = np.radians(ra), np.radians(dec)
    return (X * np.sin(a) - Y * np.cos(a),
            X * np.cos(a) * np.sin(d) + Y * np.sin(a) * np.sin(d) - Z * np.cos(d))

RES = os.path.join(ROOT, "cache/fast_sweep/results/B0.12_K3")
OUT = os.path.join(ROOT, "site/data/fast_sweep")
CLEAN_FLAG = "known mover confirmed"
N_MIN, SIGMA_S_MAX, FRAC3_MIN = 10, 0.20, 0.95       # decision of the rule


def mjd(jyear):
    return (jyear - 2000.0) * 365.25 + 51544.5


def fit_star(r, inflate=True):
    S = r["seasons"]
    ra0, de0 = S[0]["ra"], S[0]["dec"]
    cosd = math.cos(math.radians(de0))
    t = np.array([s["jyear"] for s in S])
    t0 = t.mean()
    infl = (r.get("error_inflation") or 1.0) if inflate else 1.0
    fl = r.get("floor") or 0.0
    rows, y, sig = [], [], []
    for s, tk in zip(S, t):
        pe, pn = parallax_factors(np.array([s["ra"]]), np.array([s["dec"]]), mjd(tk))
        pe, pn = float(pe[0]) / 1000.0, float(pn[0]) / 1000.0          # arcsec per mas
        rows.append([1, 0, tk - t0, 0, pe]); y.append((s["ra"] - ra0) * cosd * 3600)
        sig.append(math.hypot(s["eE"] * infl, fl))
        rows.append([0, 1, 0, tk - t0, pn]); y.append((s["dec"] - de0) * 3600)
        sig.append(math.hypot(s["eN"] * infl, fl))
    A, y, sig = np.array(rows, float), np.array(y), np.array(sig)
    Aw, yw = A / sig[:, None], y / sig
    cov = np.linalg.inv(Aw.T @ Aw)
    p = cov @ Aw.T @ yw
    chi2 = float(((yw - Aw @ p) ** 2).sum())
    dof = len(y) - 5
    # how far the parallax factors swing between seasons (arcsec per arcsec of parallax, E/N)
    return {"plx": p[4], "eplx": math.sqrt(cov[4, 4]), "pmE": p[2] * 1000, "pmN": p[3] * 1000,
            "chi2": chi2, "dof": dof}


def scale(rows):
    pm = np.array([r["plx_meas_mas"] for r in rows]); pg = np.array([r["plx_gaia_mas"] for r in rows])
    w = 1 / np.array([r["plx_err_mas"] for r in rows]) ** 2
    s = float((w * pm * pg).sum() / (w * pg ** 2).sum())
    es_formal = float(1 / math.sqrt((w * pg ** 2).sum()))
    chi2 = float((w * (pm - s * pg) ** 2).sum())
    n = len(rows)
    birge = math.sqrt(chi2 / (n - 1)) if n > 1 else float("nan")
    es = es_formal * max(1.0, birge)
    d = pm - pg
    md = float((w * d).sum() / w.sum()); emd = float(1 / math.sqrt(w.sum()))
    z = d / np.array([r["plx_err_mas"] for r in rows])
    return {"n": n, "scale": round(s, 4), "scale_err": round(es, 4), "scale_err_formal": round(es_formal, 4),
            "chi2": round(chi2, 2), "chi2_per_dof": round(chi2 / max(n - 1, 1), 3),
            "weighted_mean_diff_mas": round(md, 2), "weighted_mean_diff_err_mas": round(emd, 2),
            "within_1sigma": int((abs(z) <= 1).sum()), "within_2sigma": int((abs(z) <= 2).sum()),
            "within_3sigma": int((abs(z) <= 3).sum()),
            "median_abs_z": round(float(np.median(abs(z))), 3) if n else None,
            "median_plx_err_mas": round(float(np.median([r["plx_err_mas"] for r in rows])), 1) if n else None}


def decide(st):
    if st["n"] < N_MIN:
        return "limit"
    if abs(st["scale"] - 1) > 3 * st["scale_err"] or st["within_3sigma"] < FRAC3_MIN * st["n"]:
        return "fail"
    if st["scale_err"] > SIGMA_S_MAX:
        return "limit"
    return "pass"


def main():
    gaia = {s[0]: s for s in json.load(gzip.open(os.path.join(ROOT, "site/data/fast_stars.json.gz")))["stars"]}
    rows = []
    for f in sorted(glob.glob(os.path.join(RES, "*.json"))):
        r = json.load(open(f))
        if not r.get("ok"):
            continue
        S = r["seasons"]
        plx_g = gaia[r["sid"]][8]
        clean = r.get("judge_cls") == "gaia-known" and all(x == CLEAN_FLAG for x in r.get("judge_flags", []))
        orients = {int(((s["orient"] + 90) % 360) // 180) for s in S}
        nsat = sum(bool(s["sat"]) for s in S)
        base = len(S) >= 3 and len(orients) == 2 and clean and plx_g is not None and plx_g > 0
        group = ("primary" if base and nsat == 0 else "saturated" if base else "excluded")
        why = [] if base else [w for w, c in (("< 3 seasons", len(S) < 3), ("one orientation", len(orients) < 2),
                                               ("judge not clean", not clean),
                                               ("no Gaia parallax", not (plx_g and plx_g > 0))) if c]
        a = fit_star(r) if len(S) >= 3 else None
        b = fit_star(r, inflate=False) if len(S) >= 3 else None
        row = {"sid": r["sid"], "name": r["name"], "group": group, "excluded_why": "; ".join(why),
               "n_seasons": len(S), "n_saturated_seasons": nsat, "plx_gaia_mas": plx_g,
               "plx_meas_mas": None, "plx_err_mas": None, "plx_err_formal_mas": None, "z": None, "within3": None,
               "fit_chi2": None, "fit_dof": None, "error_inflation": r.get("error_inflation"),
               "floor_arcsec": r.get("floor"), "judge_flags": " | ".join(r.get("judge_flags", []))}
        if a:
            row.update(plx_meas_mas=round(a["plx"], 2), plx_err_mas=round(a["eplx"], 2),
                       plx_err_formal_mas=round(b["eplx"], 2), plx_meas_formal_mas=round(b["plx"], 2),
                       fit_chi2=round(a["chi2"], 3), fit_dof=a["dof"])
            if plx_g:
                z = (a["plx"] - plx_g) / a["eplx"]
                row.update(z=round(z, 3), within3=bool(abs(z) <= 3))
        rows.append(row)
    prim = [r for r in rows if r["group"] == "primary"]
    sat = [r for r in rows if r["group"] == "saturated"]
    form = [dict(r, plx_meas_mas=r["plx_meas_formal_mas"], plx_err_mas=r["plx_err_formal_mas"]) for r in prim]
    summ = {
        "what": "Parallaxes from the SPHEREx season positions of the fast-star sweep, compared with Gaia DR3",
        "rule": "pipeline/PARALLAX_SWEEP_RULE.md (commit 6549d13, pushed 2026-11-15T07:11:04Z, before this code existed)",
        "code": "pipeline/parallax_sweep.py",
        "primary": scale(prim),
        "decision": decide(scale(prim)),
        "decision_rule": f"N >= {N_MIN}; fail if |s-1| > 3 sigma_s or < {FRAC3_MIN:.0%} within 3 sigma; "
                         f"limit if sigma_s > {SIGMA_S_MAX}; else pass",
        "secondary": {
            "primary_formal_errors_no_inflation": scale(form),
            "primary_4_seasons": scale([r for r in prim if r["n_seasons"] >= 4]),
            "primary_3_seasons": scale([r for r in prim if r["n_seasons"] == 3]),
            "saturated": scale(sat),
            "all_judge_clean": scale(prim + sat),
        },
        "excluded": [{"name": r["name"], "why": r["excluded_why"]} for r in rows if r["group"] == "excluded"],
    }
    os.makedirs(OUT, exist_ok=True)
    cols = ["sid", "name", "group", "n_seasons", "n_saturated_seasons", "plx_gaia_mas", "plx_meas_mas", "plx_err_mas",
            "z", "within3", "plx_meas_formal_mas", "plx_err_formal_mas", "fit_chi2", "fit_dof", "error_inflation",
            "floor_arcsec", "excluded_why", "judge_flags"]
    order = {"primary": 0, "saturated": 1, "excluded": 2}
    rows.sort(key=lambda r: (order[r["group"]], -(r["plx_gaia_mas"] or 0)))
    with open(os.path.join(OUT, "parallax.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    with open(os.path.join(OUT, "parallax_summary.json"), "w") as fh:
        json.dump(summ, fh, indent=1)
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
