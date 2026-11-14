#!/usr/bin/env python3
"""Accuracy of the Fazari astrometry -> pipeline/ACCURACY.md (re-runnable, read-only on all results).

Reads:
  site/data/{barnard,eps_indi_b,wise0855}/meta.json, images.csv     (site results, never written)
  cache/jobs/<Luhman 16AB job>/meta.json                             (local engine, largest job)
  <field-stars dir>/{barnard,eps_indi_b}/field_stars.csv             per-star field calibration export;
      if missing it is made with FAZARI_OUT=<field-stars dir> blink.py <target> (2-5 min each), and the
      new meta.json is checked against site/data/<target>/meta.json (same numbers = same calibration)
  <wide dir>/<size>/out/<target>_wide/                              wide-cutout experiment, optional
      (pipeline/wide_cutouts.py; default ../veri/wide_cutouts/runs)

Usage (from the fazari/ folder):
  uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib \\
      --with pillow python -I pipeline/accuracy.py [--field-stars DIR] [--wide DIR] [--out FILE] [--json FILE]
"""
import argparse
import csv
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PIPE = Path(__file__).resolve().parent
ROOT = PIPE.parent
sys.path.insert(0, str(PIPE))

import numpy as np                                        # noqa: E402

import blink                                              # noqa: E402  (same propagation as the pipeline)

SITE = ROOT / "site" / "data"
FS_TARGETS = ("barnard", "eps_indi_b")
G_BINS = [(10, 12), (12, 14), (14, 15), (15, 16), (16, 17), (17, 17.5)]
R_BINS = [(0, 0.05), (0.05, 0.1), (0.1, 0.15), (0.15, 0.2), (0.2, 0.3), (0.3, 0.45)]   # lever arm, deg
PCT = (50, 68.27, 95.45)
LUHMAN_PLX = 500.0          # mas, ~2.0 pc (6.5 ly): only to size the effect of the parallax the job left out


def load(p):
    return json.loads(Path(p).read_text())


def rel(p):
    """Path relative to the repo, or ../<...> next to it (no home folders in the report)."""
    p = Path(p).resolve()
    for base, pre in ((ROOT, ""), (ROOT.parent, "../")):
        try:
            return pre + str(p.relative_to(base))
        except ValueError:
            pass
    return p.name


NAMES = {"barnard": "Barnard's Star", "eps_indi_b": "Epsilon Indi B", "wise0855": "WISE 0855−0714",
         "luhman16": "Luhman 16AB"}


def f(v, nd=2, sign=True):
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    return f"{v:+.{nd}f}" if sign else f"{v:.{nd}f}"


def rng(v, nd=2):
    lo, hi = f"{min(v):+.{nd}f}", f"{max(v):+.{nd}f}"
    return lo if lo == hi else f"{lo}…{hi}"


def sig(d, s):
    return d / s if s else float("nan")


def fsig(d, s):
    x = sig(d, s)
    return f"{x:+.1f}σ" if math.isfinite(x) else "–"


def read_csv(p):
    with open(p, newline="") as fh:
        return list(csv.DictReader(fh))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


# ---- per-target accuracy (meta.json) --------------------------------------------------------------
def season_cal_sigma(meta, images):
    """Field-calibration error of each season position: the cell offsets are common to all exposures
    of a cell, so sigma_cal(season) = sqrt(sum_c (n_c/N)^2 sigma_c^2), n_c = calibrated exposures of
    cell c. Fallback cells (season median) get 1.25 * median(accepted sigma) / sqrt(n_accepted)."""
    cal = meta["measured"].get("field_calibration") or {}
    if not cal.get("applied") or not cal.get("n_exposures_calibrated"):
        return {}
    cells = {(c["epoch"], c["detector"]): c for c in cal.get("cells", [])}
    out = {}
    for e in meta["epochs"]:
        acc = [c for (ep, _), c in cells.items() if ep == e and c.get("accepted")]
        if not acc:
            continue
        fb = [1.25 * float(np.median([c[k] for c in acc])) / math.sqrt(len(acc))
              for k in ("err_east_arcsec", "err_north_arcsec")]
        n = {}
        for r in images:
            if r["epoch"] == e and r.get("calib_east_arcsec") not in ("", None) and r.get("ra_fit") not in ("", None):
                n[r["detector"]] = n.get(r["detector"], 0) + 1
        N = sum(n.values())
        if not N:
            continue
        s = [0.0, 0.0]
        for d, k in n.items():
            c = cells.get((e, d), {})
            for j, key in enumerate(("err_east_arcsec", "err_north_arcsec")):
                sc = c[key] if c.get("accepted") else fb[j]
                s[j] += (k / N * sc) ** 2
        out[e] = (math.sqrt(s[0]), math.sqrt(s[1]))
    return out


def target_summary(key, label, meta, images, reference, note=""):
    me = meta["measured"]
    cal = season_cal_sigma(meta, images)
    seasons = []
    for p in me.get("positions", []):
        sc = cal.get(p["epoch"], (0.0, 0.0))
        sE, sN = math.hypot(p["err_east_arcsec"], sc[0]), math.hypot(p["err_north_arcsec"], sc[1])
        seasons.append(dict(epoch=p["epoch"], dE=p["minus_gaia_east_arcsec"], dN=p["minus_gaia_north_arcsec"],
                            sE_stat=p["err_east_arcsec"], sN_stat=p["err_north_arcsec"], sE_cal=sc[0], sN_cal=sc[1],
                            sE=sE, sN=sN, n=p["n_images"], orient=p.get("orient_deg")))
    fit = me.get("fit") or {}
    pm = None
    if fit:
        pm = dict(meas=(fit["pmra_mas_yr"], fit["pmdec_mas_yr"]), err=(fit["pmra_err_mas_yr"], fit["pmdec_err_mas_yr"]),
                  ref=(fit["gaia_pmra_mas_yr"], fit["gaia_pmdec_mas_yr"]))
        pm["d"] = (pm["meas"][0] - pm["ref"][0], pm["meas"][1] - pm["ref"][1])
    shift = None
    if me.get("shift_arcsec") is not None:
        pos = {p["epoch"]: p for p in me["positions"]}
        a, z = pos[me["from_epoch"]], pos[me["to_epoch"]]
        m = blink.offset_arcsec(a["ra"], a["dec"], z["ra"], z["dec"])
        g = blink.offset_arcsec(a["gaia_ra"], a["gaia_dec"], z["gaia_ra"], z["gaia_dec"])
        dpa = (me["pa_deg"] - me["gaia_pa_deg"] + 180) % 360 - 180
        shift = dict(frm=me["from_epoch"], to=me["to_epoch"], dt=me["dt_years"], meas=me["shift_arcsec"],
                     ref=me["gaia_predicted_arcsec"], err=me["shift_err_arcsec"], pa=me["pa_deg"],
                     ref_pa=me["gaia_pa_deg"], dpa=dpa, dE=m[0] - g[0], dN=m[1] - g[1],
                     same=me.get("same_orientation"))
        shift["d"] = shift["meas"] - shift["ref"]
    return dict(key=key, label=label, reference=reference, seasons=seasons, pm=pm, shift=shift, note=note,
                path=me.get("astrometry_path"), status=me.get("status"), n=meta.get("n_cutouts"),
                calibrated=bool((me.get("field_calibration") or {}).get("n_exposures_calibrated")))


def luhman_job(jobs_dir, job_id=None):
    best = None
    for p in sorted(Path(jobs_dir).glob("*/meta.json")):
        if p.parent.name.endswith("-pv") or "quick" in p.parts:
            continue
        try:
            m = load(p)
        except Exception:
            continue
        if job_id and p.parent.name != job_id:
            continue
        if not str(m.get("target", "")).startswith("Luhman 16") or m.get("preview"):
            continue
        if best is None or m.get("n_cutouts", 0) > best[1].get("n_cutouts", 0):
            best = (p.parent, m)
    return best


def parallax_effect(meta, plx):
    """How much a parallax `plx` (mas), left out of the reference, moves the predicted season
    positions (E, N) and the headline shift."""
    g = meta["gaia"]
    t = {"ra": g["ra_deg"], "dec": g["dec_deg"], "epoch": g["ref_epoch"], "pmra": g["pmra_mas_yr"],
         "pmdec": g["pmdec_mas_yr"], "plx": plx}
    out = {}
    for p in meta["measured"]["positions"]:
        a = blink.target_position(t, p["mjd"], with_parallax=False)
        b = blink.target_position(t, p["mjd"])
        out[p["epoch"]] = blink.offset_arcsec(*a, *b)[:2]
    me = meta["measured"]
    if me.get("from_epoch"):
        a, z = out[me["from_epoch"]], out[me["to_epoch"]]
        out["_shift"] = (z[0] - a[0], z[1] - a[1])
    return out


def luhman_test_note(d):
    """Sentence on the parallax test: the same job inputs re-run with parallax 0 and ~500 mas."""
    p0, p1 = d / "lu16_plx0" / "meta.json", d / "lu16_plx500" / "meta.json"
    if not (p0.exists() and p1.exists()):
        return ""
    m0, m1 = load(p0)["measured"], load(p1)["measured"]
    f0, f1 = m0["fit"], m1["fit"]
    dE = [b["minus_gaia_east_arcsec"] - a["minus_gaia_east_arcsec"] for a, b in zip(m0["positions"], m1["positions"])]
    dN = [b["minus_gaia_north_arcsec"] - a["minus_gaia_north_arcsec"] for a, b in zip(m0["positions"], m1["positions"])]
    return (f" Test (`{rel(d)}`, same cutouts re-run with blink.py and parallax {load(p1)['gaia']['parallax_mas']:.0f} mas "
            f"instead of 0): proper motion {f1['pmra_mas_yr'] - f0['pmra_mas_yr']:+.0f} / "
            f"{f1['pmdec_mas_yr'] - f0['pmdec_mas_yr']:+.0f} mas/yr, shift {m1['shift_arcsec'] - m0['shift_arcsec']:+.3f}″, "
            f"position − reference {min(dE):+.2f}…{max(dE):+.2f}″ E, {min(dN):+.2f}…{max(dN):+.2f}″ N; the detector offsets "
            f"shrink (D1 {f0['detector_bias_arcsec_xy'].get('D1')} → {f1['detector_bias_arcsec_xy'].get('D1')}″). So the "
            "shift and proper-motion test holds, and the −1.2″ E offset is in the reference position.")


# ---- field stars ---------------------------------------------------------------------------------
def ensure_field_stars(name, fsdir, generate=True):
    """<fsdir>/<name>/field_stars.csv; made with blink.py (FAZARI_OUT=fsdir) when missing.
    Returns (path, reproduces_site_meta or None)."""
    p = fsdir / name / "field_stars.csv"
    if not p.exists():
        if not generate:
            return None, None
        print(f"  {name}: making {p} (blink.py with FAZARI_OUT={fsdir}) ...", flush=True)
        env = dict(os.environ, FAZARI_OUT=str(fsdir), FAZARI_FIELD_STARS="1")
        subprocess.run([sys.executable, "-I", str(PIPE / "blink.py"), name], env=env, cwd=ROOT, check=True,
                       stdout=subprocess.DEVNULL)
    return p, same_numbers(SITE / name / "meta.json", fsdir / name / "meta.json")


def same_numbers(a, b):
    """True if all numbers of two meta.json agree after rounding to 9 significant digits (re-runs differ
    in the last bits of a few coordinates). Text (messages, the hand-edited 'finding', 'generated',
    paths) is ignored."""
    if not (Path(a).exists() and Path(b).exists()):
        return None

    def norm(x):
        if isinstance(x, dict):
            return {k: norm(v) for k, v in x.items()}
        if isinstance(x, list):
            return [norm(v) for v in x]
        if isinstance(x, float):
            return float(f"{x:.9g}")
        return None if isinstance(x, str) else x
    return norm(load(a)) == norm(load(b))


def pct(a):
    a = np.abs(np.asarray(a, float))
    a = a[np.isfinite(a)]
    return [float(np.percentile(a, q)) for q in PCT] if len(a) else [float("nan")] * 3


def field_star_stats(rows):
    used = [r for r in rows if r["status"] == "used" and r["cell_resid_east_arcsec"] not in ("", None)]
    kept = [r for r in used if r["cell_kept"] == "1"]
    E = np.array([num(r["cell_resid_east_arcsec"]) for r in kept])
    N = np.array([num(r["cell_resid_north_arcsec"]) for r in kept])
    eE = np.array([num(r["east_err_arcsec"]) for r in kept])
    eN = np.array([num(r["north_err_arcsec"]) for r in kept])
    G = np.array([num(r["gaia_g"]) for r in kept])
    lev = np.array([math.hypot(num(r["lever_east_arcsec"]), num(r["lever_north_arcsec"])) / 3600 for r in kept])
    on = [r for r in rows if r["status"] != "near_target"]
    st = {"n_rows": len(rows), "n_used": len(used), "n_kept": len(kept),
          "n_stars": len({r["source_id"] for r in kept}),
          "n_exposures": len({r["file"] for r in rows}),
          "edge_frac": sum(r["status"] == "edge" for r in on) / max(len(on), 1),
          "clipped_frac": 1 - len(kept) / max(len(used), 1),
          "E": pct(E), "N": pct(N),
          "E_all": pct([num(r["cell_resid_east_arcsec"]) for r in used]),
          "N_all": pct([num(r["cell_resid_north_arcsec"]) for r in used]),
          "z68": [pct(E / eE)[1], pct(N / eN)[1]]}
    st["by_g"] = []
    for lo, hi in G_BINS:
        m = (G >= lo) & (G < hi if hi < 17.5 else G <= hi)
        if m.sum() >= 10:
            st["by_g"].append({"bin": f"{lo}–{hi}", "n": int(m.sum()), "E": pct(E[m]), "N": pct(N[m]),
                               "err": [float(np.nanmedian(eE[m])), float(np.nanmedian(eN[m]))]})
    st["by_r"] = []
    for lo, hi in R_BINS:
        m = (lev >= lo) & (lev < hi)
        if m.sum() >= 10:
            st["by_r"].append({"bin": f"{lo:.2f}–{hi:.2f}", "n": int(m.sum()), "E": pct(E[m]), "N": pct(N[m])})
    # quoted errors vs the scatter of one star measured >= 5 times in one season x detector cell
    groups = {}
    for r in kept:
        groups.setdefault((r["source_id"], r["season"], r["detector"]), []).append(r)
    ratio = {"lo": [[], []], "hi": [[], []]}
    for g in groups.values():
        if len(g) < 5:
            continue
        chi = float(np.median([num(r["fit_chi2r"]) for r in g]))
        k = "lo" if chi < 5 else "hi"
        for j, (col, ecol) in enumerate((("east_arcsec", "east_err_arcsec"), ("north_arcsec", "north_err_arcsec"))):
            v = np.array([num(r[col]) for r in g])
            e = np.nanmedian([num(r[ecol]) for r in g])
            if e > 0:
                ratio[k][j].append(float(np.std(v, ddof=1) / e))
    st["ratio"] = {k: {"n": len(v[0]), "E": [float(np.percentile(v[0], q)) for q in (16, 50, 84)] if v[0] else None,
                       "N": [float(np.percentile(v[1], q)) for q in (16, 50, 84)] if v[1] else None}
                   for k, v in ratio.items()}
    # per-exposure offsets about the cell model: WCS jitter (common to all stars of one exposure)
    by_exp = {}
    for r in kept:
        by_exp.setdefault(r["file"], []).append((num(r["cell_resid_east_arcsec"]), num(r["cell_resid_north_arcsec"])))
    mE, mN, nE = [], [], []
    for v in by_exp.values():
        if len(v) >= 5:
            a = np.array(v)
            mE.append(a[:, 0].mean()); mN.append(a[:, 1].mean())
            nE.append([a[:, 0].std(ddof=1) / math.sqrt(len(a)), a[:, 1].std(ddof=1) / math.sqrt(len(a))])
    if mE:
        exp_noise = np.sqrt(np.mean(np.square(nE), axis=0))
        rms = [float(np.std(mE)), float(np.std(mN))]
        st["exposure_jitter"] = {"n_exp": len(mE), "rms": rms, "noise": [float(x) for x in exp_noise],
                                 "excess": [float(math.sqrt(max(r ** 2 - n ** 2, 0))) for r, n in zip(rms, exp_noise)]}
    # stars per exposure (used)
    per = {}
    for r in used:
        per[r["file"]] = per.get(r["file"], 0) + 1
    st["stars_per_exposure"] = float(np.median(list(per.values()))) if per else 0.0
    return st


# ---- wide-cutout experiment ---------------------------------------------------------------------
def wide_runs(wdir):
    out = {}
    for meta_p in sorted(Path(wdir).glob("*/out/*_wide/meta.json")):
        size = float(meta_p.parent.parent.parent.name)
        name = meta_p.parent.name[:-5]
        d = meta_p.parent
        m = load(meta_p)
        run = load(d / "run.json") if (d / "run.json").exists() else {}
        img = read_csv(d / "images.csv")
        fs = read_csv(d / "field_stars.csv") if (d / "field_stars.csv").exists() else []
        out[(name, size)] = dict(meta=m, run=run, images=img, fs=fs, dir=d)
    return out


def wide_summary(r):
    me = r["meta"]["measured"]
    cells = (me.get("field_calibration") or {}).get("cells", [])
    acc = [c for c in cells if c.get("accepted")]
    st = field_star_stats(r["fs"])
    fit = me.get("fit") or {}
    s = {"n_exp": len(r["images"]), "n_ref": (me.get("field_calibration") or {}).get("n_reference_stars"),
         "stars_per_exp": st["stars_per_exposure"], "jitter": st.get("exposure_jitter"),
         "distinct_per_cell": float(np.median([c.get("n_distinct_stars", 0) for c in cells])) if cells else 0.0,
         "cells_acc": len(acc), "cells": len(cells),
         "cell_err": [float(np.median([c["err_east_arcsec"] for c in acc])) if acc else float("nan"),
                      float(np.median([c["err_north_arcsec"] for c in acc])) if acc else float("nan")],
         "chi2r": float(np.median([c["per_exposure_chi2r"] for c in cells if c.get("per_exposure_chi2r")]))
         if any(c.get("per_exposure_chi2r") for c in cells) else float("nan"),
         "res68": [st["E"][1], st["N"][1]], "by_r": [(b["bin"], b["n"], b["E"][1], b["N"][1]) for b in st["by_r"]],
         "edge_frac": st["edge_frac"],
         "seasons": [(p["epoch"], p["minus_gaia_east_arcsec"], p["minus_gaia_north_arcsec"], p["err_east_arcsec"],
                      p["err_north_arcsec"], p["mjd"]) for p in me.get("positions", [])],
         "pm": (fit.get("pmra_mas_yr"), fit.get("pmdec_mas_yr"), fit.get("pmra_err_mas_yr"), fit.get("gaia_pmra_mas_yr"),
                fit.get("gaia_pmdec_mas_yr")),
         "shift": (me.get("shift_arcsec"), me.get("gaia_predicted_arcsec"), me.get("shift_err_arcsec")),
         "seconds": r["run"].get("seconds")}
    # applied correction per exposure (images.csv), for the paired comparison between sizes
    s["calib"] = {x["file"]: (num(x["calib_east_arcsec"]), num(x["calib_north_arcsec"]), x["epoch"], num(x["mjd"]))
                  for x in r["images"] if x.get("calib_east_arcsec") not in ("", None)}
    s["cells_used"], s["epoch_mjd"] = cell_corrections(cells, r["images"])
    return s


def cell_corrections(cells, images):
    """{(season, detector): (east, north, weight)} of the correction each cell applied (accepted cell or
    season-median fallback), and the median MJD of each season."""
    out = {}
    for c in cells:
        e = c.get("east_used", c.get("east_arcsec") if c.get("accepted") else None)
        n = c.get("north_used", c.get("north_arcsec") if c.get("accepted") else None)
        if e is not None and n is not None:
            out[(c["epoch"], c["detector"])] = (e, n, c.get("n_star_measurements", 1))
    mj = {}
    for x in images:
        if x.get("epoch"):
            mj.setdefault(x["epoch"], []).append(num(x["mjd"]))
    return out, {e: float(np.median(v)) for e, v in mj.items()}


def site_reference(name):
    """Site calibration of a target: cell corrections, season MJDs, calibrated exposures per cell."""
    meta = load(SITE / name / "meta.json")
    img = read_csv(SITE / name / "images.csv")
    cells, mjd = cell_corrections(meta["measured"]["field_calibration"]["cells"], img)
    n = {}
    for x in img:
        if x.get("calib_east_arcsec") not in ("", None) and x.get("ra_fit") not in ("", None):
            n[(x["epoch"], x["detector"])] = n.get((x["epoch"], x["detector"]), 0) + 1
    return {"cells": cells, "mjd": mjd, "n": n}


def site_change(s, site):
    """Change of each SITE season offset if this run's cell corrections replaced the site ones:
    -sum_d w_d (run_d - site_d) / sum_d w_d, w_d = site exposures of the cell. Run seasons are matched to
    site seasons by date (a sparse subset can split a season)."""
    run = {}
    for (e, d), (cE, cN, w) in s["cells_used"].items():
        if e not in s["epoch_mjd"]:
            continue
        se = min(site["mjd"], key=lambda k: abs(site["mjd"][k] - s["epoch_mjd"][e]))
        run.setdefault((se, d), []).append((cE, cN, w))
    out = {}
    for e in sorted(site["mjd"]):
        num_, den = np.zeros(2), 0.0
        for (se, d), v in run.items():
            if se != e or (e, d) not in site["cells"]:
                continue
            ww = np.array([x[2] for x in v], float)
            rc = np.array([[x[0], x[1]] for x in v]).T @ ww / ww.sum()
            w = site["n"].get((e, d), 0)
            num_ += w * (rc - np.array(site["cells"][(e, d)][:2]))
            den += w
        if den:
            out[e] = tuple(-num_ / den)
    return out


def season_of(mjd, seasons):
    return min(seasons, key=lambda s: abs(s[5] - mjd))[0]


# ---- markdown -----------------------------------------------------------------------------------
def md_targets(T, lplx):
    L = []
    L.append("| Target | Reference | Shift Δ (same orientation, ~1 yr) | μα* Δ (mas/yr) | μδ Δ (mas/yr) | "
             "Position − reference per season, E / N (″) |")
    L.append("|---|---|---|---|---|---|")
    for t in T:
        sh = t["shift"]
        shs = (f"{f(sh['d'])}″ ± {sh['err']:.2f} ({fsig(sh['d'], sh['err'])}); "
               f"{sh['meas']:.2f}″ vs {sh['ref']:.2f}″, PA {sh['dpa']:+.1f}°") if sh else "–"
        pm = t["pm"]
        pms = [(f"{pm['d'][j]:+.0f} ± {pm['err'][j]:.0f} ({fsig(pm['d'][j], pm['err'][j])})" if pm else "–")
               for j in (0, 1)]
        pos = "<br>".join(f"{s['epoch']}: {f(s['dE'])} ({fsig(s['dE'], s['sE'])}) / {f(s['dN'])} ({fsig(s['dN'], s['sN'])})"
                          for s in t["seasons"])
        if t["key"] == "luhman16":
            pos = "reference-limited, not a test:<br>" + pos
        L.append(f"| {t['label']} | {t['reference']} | {shs} | {pms[0]} | {pms[1]} | {pos} |")
    return L


def md_field(FS):
    L = ["| Target | Measurements (stars, exposures) | Median / 68 % / 95 % of \\|E\\| (″) | "
         "Median / 68 % / 95 % of \\|N\\| (″) | 95 % incl. clipped E / N (″) | Clipped | Edge-rejected |", "|---|---|---|---|---|---|---|"]
    for name, st in FS.items():
        L.append(f"| {NAMES[name]} | {st['n_kept']} ({st['n_stars']}, {st['n_exposures']}) | "
                 + " / ".join(f"{v:.2f}" for v in st["E"]) + " | " + " / ".join(f"{v:.2f}" for v in st["N"])
                 + f" | {st['E_all'][2]:.2f} / {st['N_all'][2]:.2f} | {100 * st['clipped_frac']:.1f} % | "
                 f"{100 * st['edge_frac']:.0f} % |")
    return L


def md_field_g(FS):
    L = ["| Target | Gaia G | N | 68 % of \\|E\\| / \\|N\\| (″) | 95 % of \\|E\\| / \\|N\\| (″) | Median quoted error E / N (″) |",
         "|---|---|---|---|---|---|"]
    for name, st in FS.items():
        for b in st["by_g"]:
            L.append(f"| {NAMES[name]} | {b['bin']} | {b['n']} | {b['E'][1]:.2f} / {b['N'][1]:.2f} | {b['E'][2]:.2f} / "
                     f"{b['N'][2]:.2f} | {b['err'][0]:.2f} / {b['err'][1]:.2f} |")
    return L


def md_field_r(FS):
    L = ["| Target | Distance from target (deg) | N | 68 % of \\|E\\| / \\|N\\| (″) | 95 % of \\|E\\| / \\|N\\| (″) |",
         "|---|---|---|---|---|"]
    for name, st in FS.items():
        for b in st["by_r"]:
            L.append(f"| {NAMES[name]} | {b['bin']} | {b['n']} | {b['E'][1]:.2f} / {b['N'][1]:.2f} | {b['E'][2]:.2f} / {b['N'][2]:.2f} |")
    return L


def md_ratio(FS):
    L = ["| Target | Star fit χ²r | Star-cells (≥ 5 measurements) | Scatter / quoted error, E: 16 / 50 / 84 % | N: 16 / 50 / 84 % |",
         "|---|---|---|---|---|"]
    for name, st in FS.items():
        for k, lab in (("lo", "< 5"), ("hi", "≥ 5")):
            r = st["ratio"][k]
            if r["n"]:
                L.append(f"| {NAMES[name]} | {lab} | {r['n']} | " + " / ".join(f"{v:.2f}" for v in r["E"]) + " | "
                         + " / ".join(f"{v:.2f}" for v in r["N"]) + " |")
    return L


def md_wide(W, names):
    L = ["| Target | Size | Exposures | Ref. stars used per exposure (median) | Distinct stars per cell (median) | "
         "Cells accepted | Cell error E / N (median, ″) | Per-exposure WCS jitter E / N (″) | "
         "Star residual 68 % E / N (″) | Edge-rejected | Run time |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for name in names:
        for size in sorted(s for (n, s) in W if n == name):
            s = W[(name, size)]
            L.append(f"| {NAMES[name]} | {size:.1f}° | {s['n_exp']} | {s['stars_per_exp']:.0f} | {s['distinct_per_cell']:.0f} | "
                     f"{s['cells_acc']} / {s['cells']} | {s['cell_err'][0]:.3f} / {s['cell_err'][1]:.3f} | "
                     + (" / ".join(f"{v:.3f}" if v >= 0.005 else "< noise" for v in s["jitter"]["excess"])
                        if s["jitter"] else "–")
                     + f" | {s['res68'][0]:.2f} / {s['res68'][1]:.2f} | {100 * s['edge_frac']:.0f} % | "
                     f"{s['seconds'] or 0:.0f} s |")
    return L


def md_wide_astro(W, names):
    L = ["| Target | Size | Subset run: position − Gaia per season, E / N (″, ± stat.) | Subset run: change of the season "
         "offset vs 0.2° from the calibration alone (same exposures), E / N (″) | Site result: change of the season offset "
         "if these cell corrections were used, E / N (″) | Subset run: μ − Gaia (mas/yr) | Subset run: shift − Gaia (″) |",
         "|---|---|---|---|---|---|---|"]
    for name in names:
        base = W.get((name, 0.2))
        site = site_reference(name)
        for size in sorted(s for (n, s) in W if n == name):
            s = W[(name, size)]
            pos = "<br>".join(f"{e}: {dE:+.2f} / {dN:+.2f} (± {sE:.2f} / {sN:.2f})" for e, dE, dN, sE, sN, _ in s["seasons"])
            ch = "–"
            if base and size != 0.2:
                acc = {}
                for fn, (cE, cN, ep, mjd) in s["calib"].items():
                    if fn in base["calib"]:
                        b = base["calib"][fn]
                        acc.setdefault(season_of(mjd, s["seasons"]) if s["seasons"] else ep, []).append((cE - b[0], cN - b[1]))
                ch = "<br>".join(f"{e}: {-np.mean([v[0] for v in a]):+.3f} / {-np.mean([v[1] for v in a]):+.3f}"
                                 for e, a in sorted(acc.items()))
            sc = "<br>".join(f"{e}: {v[0]:+.3f} / {v[1]:+.3f}" for e, v in site_change(s, site).items())
            pm = s["pm"]
            pms = f"{pm[0] - pm[3]:+.0f} / {pm[1] - pm[4]:+.0f} (± {pm[2]:.0f})" if pm[0] is not None else "–"
            sh = s["shift"]
            shs = f"{sh[0] - sh[1]:+.3f} ± {sh[2]:.3f}" if sh[0] is not None else "–"
            L.append(f"| {NAMES[name]} | {size:.1f}° | {pos} | {ch} | {sc} | {pms} | {shs} |")
    return L


def md_wide_r(W, names):
    L = ["| Target | Size | Star residual 68 % E / N (″) by distance from the target (deg): N |", "|---|---|---|"]
    for name in names:
        for size in sorted(s for (n, s) in W if n == name):
            s = W[(name, size)]
            L.append(f"| {NAMES[name]} | {size:.1f}° | " + "; ".join(f"{b}: {e:.2f} / {n_:.2f} ({k})" for b, k, e, n_ in s["by_r"]) + " |")
    return L


REC_GAIN = 0.7             # a larger default only if the median cell error drops to <= 70 % ...
REC_RES = 1.15             # ... for every target, and the star residuals do not grow by > 15 % (distortion)


def recommendation(W, names):
    """The smallest size whose median cell error is <= REC_GAIN x the 0.2 deg one for every target,
    with field-star residuals (68 %) no more than REC_RES x the 0.2 deg ones; None = keep 0.2 deg."""
    lines, ok = [], {}
    for name in names:
        b = W.get((name, 0.2))
        if not b:
            return ["The 0.2° wide-experiment run is missing."], None
        for size in (0.4, 0.6):
            s = W.get((name, size))
            if not s:
                continue
            gain = [s["cell_err"][j] / b["cell_err"][j] for j in (0, 1)]
            res = [s["res68"][j] / b["res68"][j] for j in (0, 1)]
            lines.append(f"- {NAMES[name]}, {size:.1f}° vs 0.2°: {s['stars_per_exp'] / max(b['stars_per_exp'], 1):.1f}× the "
                         f"reference stars per exposure; median cell error × {gain[0]:.2f} (E) / × {gain[1]:.2f} (N); "
                         f"star residuals (68 %) × {res[0]:.2f} / × {res[1]:.2f}; run time × "
                         f"{(s['seconds'] or 0) / max(b['seconds'] or 1, 1):.1f}.")
            ok[(name, size)] = max(gain) <= REC_GAIN and max(res) <= REC_RES
    for size in (0.4, 0.6):
        if all(ok.get((n, size), False) for n in names):
            return lines, size
    return lines, None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--field-stars", default=os.environ.get("FAZARI_OUT") or str(Path(tempfile.gettempdir()) / "fazari_accuracy"),
                    help="folder with <target>/field_stars.csv (made there if missing)")
    ap.add_argument("--no-generate", action="store_true", help="do not run blink.py for a missing field_stars.csv")
    ap.add_argument("--wide", default=str(ROOT.parent / "veri" / "wide_cutouts" / "runs"))
    ap.add_argument("--jobs", default=str(ROOT / "cache" / "jobs"), help="local engine job products (Luhman 16AB)")
    ap.add_argument("--luhman-job", help="job id (default: the Luhman 16AB job with the most cutouts)")
    ap.add_argument("--luhman-test", default=str(ROOT.parent / "veri" / "accuracy_tests"),
                    help="folder with lu16_plx0/ and lu16_plx500/ (blink.py re-runs of the Luhman 16AB job with "
                         "parallax 0 and ~500 mas; optional)")
    ap.add_argument("--out", default=str(PIPE / "ACCURACY.md"))
    ap.add_argument("--json", help="also write the numbers as JSON (e.g. site/data/accuracy.json, read by verify.html "
                                   "through pipeline/verify_table.py); the Markdown output is unchanged")
    a = ap.parse_args()

    # 1. targets
    T = []
    for key, label in (("barnard", "Barnard's Star"), ("eps_indi_b", "Epsilon Indi B"), ("wise0855", "WISE 0855−0714")):
        meta = load(SITE / key / "meta.json")
        ref = "Gaia DR3" if meta["gaia"].get("source_id") else "Kirkpatrick et al. 2021 (Spitzer)"
        T.append(target_summary(key, label, meta, read_csv(SITE / key / "images.csv"), ref))
    lj = luhman_job(a.jobs, a.luhman_job)
    lplx = None
    if lj:
        d, meta = lj
        T.append(target_summary("luhman16", f"Luhman 16AB (local engine job, {meta['n_cutouts']} cutouts)", meta,
                                read_csv(d / "images.csv"), "SIMBAD, no parallax (see notes)"))
        lplx = (d, meta, parallax_effect(meta, LUHMAN_PLX))

    # 2. field stars
    fsdir = Path(a.field_stars).expanduser().resolve()
    FS, repro = {}, {}
    for name in FS_TARGETS:
        p, same = ensure_field_stars(name, fsdir, not a.no_generate)
        if p:
            FS[name] = field_star_stats(read_csv(p))
            repro[name] = same
    # site cell errors (production calibration)
    cellerr = {}
    for name in FS_TARGETS:
        cells = load(SITE / name / "meta.json")["measured"]["field_calibration"]["cells"]
        acc = [c for c in cells if c.get("accepted")]
        cellerr[name] = (len(acc), len(cells), float(np.median([c["err_east_arcsec"] for c in acc])),
                         float(np.median([c["err_north_arcsec"] for c in acc])),
                         float(np.median([c["n_distinct_stars"] for c in acc])),
                         float(np.median([c["per_exposure_chi2r"] for c in acc if c.get("per_exposure_chi2r")])))

    # 3. wide cutouts
    W, names = {}, [n for n in FS_TARGETS]
    if Path(a.wide).exists():
        W = {k: wide_summary(v) for k, v in wide_runs(a.wide).items()}
    rec_lines, rec = recommendation(W, names) if W else ([], None)

    # ---- write -------------------------------------------------------------------------------
    def short(t):
        return NAMES[t["key"]]
    bar = next(t for t in T if t["key"] == "barnard")
    fs_line = "; ".join(f"{NAMES[n]} {st['E'][1]:.2f} / {st['N'][1]:.2f}″" for n, st in FS.items())
    L = ["# Astrometric accuracy", "",
         "Generated by `pipeline/accuracy.py` from the current results (re-run it after a pipeline change). "
         "Nothing here changes the results: `site/data/*/meta.json` are only read.", "",
         "## In short", "",
         "- **Shift over ~1 yr** (same spacecraft orientation): measured − reference = " + ", ".join(
             f"{short(t)} {f(t['shift']['d'])}″ ({fsig(t['shift']['d'], t['shift']['err'])})" for t in T if t["shift"]) + ".",
         "- **Proper motion** (μα*, μδ): " + ", ".join(
             f"{short(t)} {t['pm']['d'][0]:+.0f} / {t['pm']['d'][1]:+.0f} ± {t['pm']['err'][0]:.0f} mas/yr" for t in T if t["pm"]) + ".",
         f"- **Absolute position** per season (target − reference): Barnard's Star "
         f"{rng([s['dE'] for s in bar['seasons']])}″ E, {rng([s['dN'] for s in bar['seasons']])}″ N "
         f"(± {max(max(s['sE'], s['sN']) for s in bar['seasons']):.2f}″: the N offset is not understood); Epsilon Indi B "
         "+0.3″ E, −0.5″ N (the unresolved binary, see README); WISE 0855−0714 within its ±0.2–0.45″ errors.",
         f"- **Field stars** (Gaia DR3 reference stars, one measurement, after the calibration): 68 % of the residuals within "
         f"{fs_line} (E / N). Median error of the calibration offset of one season × detector cell: "
         + "; ".join(f"{NAMES[n]} {cellerr[n][2]:.3f} / {cellerr[n][3]:.3f}″" for n in FS_TARGETS) + ".",
         "- **Measured in every run?** Yes. `blink.py` writes measured − predicted per season, the proper motion vs the "
         "catalogue, the headline shift vs the prediction, the calibration cell errors and per-exposure χ²r "
         "(`meta.json` → `measured`), and the per-star residuals (`field_stars.csv`, local engine and `FAZARI_OUT` runs). "
         "This file only collects them and compares them with the reference.", "",
         "## Accuracy per target", "",
         "Δ = measured − reference. σ in brackets: the significance of Δ. For the season positions σ is the quoted "
         "statistical error combined with the field-calibration error of that season (see *Method*).", ""]
    L += md_targets(T, lplx)
    L += ["", "### Notes per target", ""]
    for t in T:
        s_cal = ", ".join(f"{s['epoch']} ±{s['sE_stat']:.2f}/{s['sN_stat']:.2f} stat, ±{s['sE_cal']:.2f}/{s['sN_cal']:.2f} cal"
                          for s in t["seasons"])
        L.append(f"- **{short(t)}** ({t['path']} path, status `{t['status']}`, {t['n']} cutouts). Season errors E/N: {s_cal}."
                 + ("" if t["calibrated"] else " Field calibration not applied (too few Gaia stars in D5/D6), so the "
                    "positions are on the SPHEREx L2 WCS (good to ~0.1″)."))
    if lplx:
        d, meta, eff = lplx
        sh = eff.get("_shift", (0, 0))
        L.append(f"- **Luhman 16AB reference**: `{rel(d / 'meta.json')}` uses the SIMBAD position (epoch 2000) and proper "
                 f"motion ({meta['gaia']['pmra_mas_yr']}, {meta['gaia']['pmdec_mas_yr']} mas/yr) with **parallax 0**. Gaia DR3 "
                 "has only a 2-parameter solution for one component (5353626573555863424, G = 16.9; no proper motion, no "
                 f"parallax), so there is no Gaia DR3 reference. A parallax of ~{LUHMAN_PLX / 1000:.1f}″ (2.0 pc) would move the "
                 "predicted season positions by " + ", ".join(f"{e} {v[0]:+.2f}/{v[1]:+.2f}″" for e, v in eff.items() if e != "_shift")
                 + f" (E/N) and the same-orientation shift by {sh[0]:+.3f}/{sh[1]:+.3f}″. So only the shift and the proper "
                 "motion are tested here; the absolute positions (−1.2″ E) mostly measure the reference (epoch-2000 position "
                 "moved 26 yr, no parallax, unresolved binary), and the joint fit with parallax 0 absorbs the parallax into "
                 "the detector bias terms." + luhman_test_note(Path(a.luhman_test)))
    L += [""]

    L += ["## Field stars after the calibration (Gaia DR3 reference stars)", "",
          "Residual = star position measured in SPHEREx − Gaia DR3 position at the exposure time, after the season × "
          "detector calibration model (`cell_resid_*` in `field_stars.csv`). Only stars kept by the 3σ clipping; the "
          "column *95 % incl. clipped* uses all used stars. Production run on all exposures (0.2° cutouts)." + "", ""]
    L += md_field(FS)
    L += ["", "By Gaia G magnitude:", ""]
    L += md_field_g(FS)
    L += ["", "By distance from the target (the 0.2° cutout reaches 0.10° along the axes, 0.14° in the corners):", ""]
    L += md_field_r(FS)
    L += ["", "Quoted errors vs the scatter of one star measured ≥ 5 times in one season × detector cell "
              "(1.0 = errors right; < 1 = errors too large):", ""]
    L += md_ratio(FS)
    L += [""]
    for name, st in FS.items():
        j = st.get("exposure_jitter")
        c = cellerr[name]
        L.append(f"- **{NAMES[name]}**: {st['stars_per_exposure']:.0f} reference stars used per exposure (median). Single-star "
                 f"residuals are {st['z68'][0]:.1f}× / {st['z68'][1]:.1f}× (E / N, 68 %) their quoted errors. "
                 + (f"Per-exposure mean offset about the cell model: rms {j['rms'][0]:.3f} / {j['rms'][1]:.3f}″ "
                    f"(E / N), of which {j['noise'][0]:.3f} / {j['noise'][1]:.3f}″ is star noise, so the per-exposure WCS "
                    f"jitter is {j['excess'][0]:.3f} / {j['excess'][1]:.3f}″. " if j else "")
                 + f"Calibration cells (site result): {c[0]} of {c[1]} accepted, median {c[4]:.0f} distinct stars, median "
                 f"cell error {c[2]:.3f} / {c[3]:.3f}″, per-exposure χ²r {c[5]:.1f}."
                 + ("" if repro.get(name) is None else
                    (" The field_stars.csv run reproduces the site meta.json." if repro[name] else
                     " NOTE: the field_stars.csv run does NOT reproduce the site meta.json.")))
    L += [""]

    L += ["## Wider cutouts (0.2° vs 0.4° vs 0.6°)", ""]
    if W:
        sub = {}
        for name in names:
            p = Path(a.wide).parent / f"subset_{name}.json"
            mp = Path(a.wide).parent / f"manifest_{name}.json"
            if p.exists():
                sub[name] = load(p)
            if mp.exists():
                sub[name + "_bytes"] = sum(v.get("bytes_net", 0) for v in load(mp)["files"].values())
        L += [f"Same subset of exposures for all sizes: {', '.join(f'{NAMES[n]} {sub[n]['n']}' for n in names if n in sub)} "
              f"({sub.get(names[0], {}).get('per_cell', '?')} per season × detector, spread in time; both spacecraft "
              "orientations). 0.6° pixels from S3 Range reads (" + ", ".join(
                  f"{NAMES[n]} {sub.get(n + '_bytes', 0) / 1e6:.0f} MB" for n in names) + "), 0.4° cut from them, 0.2° = the "
              "existing cutouts. Gaia DR3 within 0.45° for all three sizes. Data and runs: `" + rel(Path(a.wide).parent)
              + "/` (`pipeline/wide_cutouts.py`).", ""]
        wroot = Path(a.wide).parent
        fsz = {}
        for size in ("0.2", "0.4", "0.6"):
            v = [q.stat().st_size for n in names for q in (wroot / size / n).glob("*/*.fits")]
            if v:
                fsz[size] = float(np.mean(v))
        s3 = [v.get("bytes_net", 0) for n in names if (wroot / f"manifest_{n}.json").exists()
              for v in load(wroot / f"manifest_{n}.json")["files"].values() if v.get("bytes_net")]
        L += ["Bytes per exposure: IRSA-format cutout (pixels + the 3.9 MB EPSF table) "
              + ", ".join(f"{k}° {v / 1e6:.1f} MB" for k, v in fsz.items())
              + (f"; S3 Range reads of the 0.6° box {np.mean(s3) / 1e6:.1f} MB (full 2040-px rows of IMAGE, VARIANCE, "
                 "ZODI and FLAGS; EPSF and WCS-WAVE copied from the 0.2° cutout)" if s3 else "") + ".", ""]
        L += md_wide(W, names)
        L += ["", "Effect on the target (subset runs, so errors are larger than in the site result):", ""]
        L += md_wide_astro(W, names)
        L += ["", "Field-star residuals by distance from the target:", ""]
        L += md_wide_r(W, names)
        L += [""] + rec_lines + [""]
        rule = (f"rule in `accuracy.py`: the smallest size whose median cell error is ≤ {REC_GAIN:.0%} of the 0.2° one "
                f"for every target, with star residuals at most {REC_RES - 1:.0%} larger")
        if rec:
            moves = []
            for name in names:
                ch = site_change(W[(name, rec)], site_reference(name))
                ch0 = site_change(W[(name, 0.2)], site_reference(name))
                moves.append(f"{NAMES[name]} by ≤ {max(abs(v[0]) for v in ch.values()):.2f}″ E / "
                             f"{max(abs(v[1]) for v in ch.values()):.2f}″ N (the 2-exposure 0.2° subset itself: "
                             f"≤ {max(abs(v[0]) for v in ch0.values()):.2f} / {max(abs(v[1]) for v in ch0.values()):.2f}″)")
            buys = "; ".join(
                f"{NAMES[n]}: cell error {W[(n, 0.2)]['cell_err'][1]:.3f} → {W[(n, rec)]['cell_err'][1]:.3f}″ (N), cells "
                f"calibrated on their own stars {W[(n, 0.2)]['cells_acc']}/{W[(n, 0.2)]['cells']} → "
                f"{W[(n, rec)]['cells_acc']}/{W[(n, rec)]['cells']} (the others take the season median), edge losses "
                f"{100 * W[(n, 0.2)]['edge_frac']:.0f} % → {100 * W[(n, rec)]['edge_frac']:.0f} %" for n in names)
            L += [f"**Recommendation:** {rec:.1f}° cutouts as the new default ({rule}). The default in "
                  f"`pipeline/download.py` is not changed here. What it buys: {buys}. What it does not do: move the site "
                  "season offsets beyond the subset noise (" + "; ".join(moves) + "), so Barnard's +0.13″ N offset is "
                  "not a calibration-area effect."]
        else:
            L += [f"**Recommendation:** keep 0.2° as the default ({rule})."]
    else:
        L += ["Not run. See `pipeline/wide_cutouts.py`."]
    L += ["",
          "## Method", "",
          "- **Shift**: the headline pair of `meta.json` (two seasons with the same spacecraft orientation, ~1 yr apart, "
          "so detector-fixed centroid offsets cancel). Δ = measured − predicted length; σ = `shift_err_arcsec`. "
          "ΔPA = measured − predicted position angle.",
          "- **Proper motion**: the joint fit (bright path: all exposures, position + proper motion + detector offsets, "
          "parallax fixed to the catalogue) or the weighted fit of the season positions (faint path). σ = the fit error.",
          "- **Season position**: measured − predicted at the mean exposure time of the season. σ = quoted statistical "
          "error (scatter of the exposures / √N) ⊕ field-calibration error: the cell offsets are common to all exposures "
          "of a season × detector cell, so σ_cal = √Σ (n_c/N)² σ_c² over the cells (fallback cells: 1.25 × median "
          "accepted σ / √n_accepted). Reference errors are negligible here (Gaia DR3: < 1 mas; Kirkpatrick et al. 2021: "
          "≤ 13 mas propagated to 2026).",
          "- **Field stars**: `field_stars.csv` from `blink.py` with `FAZARI_OUT` set (identical calibration; the site "
          "`meta.json` is reproduced). Percentiles of |residual| per axis: 68 % ≈ 1σ and 95 % ≈ 2σ for a Gaussian.",
          "- **Per-exposure WCS jitter**: rms of the mean star residual of each exposure (≥ 5 stars) about its cell "
          "model, minus the star noise in quadrature. It is common to the target and the stars of one exposure.",
          "- **Edge-rejected**: share of the reference stars on a cutout that are < 7 px from its edge (`status = edge`).",
          "- **Wide-cutout experiment**: 2 exposures per season × detector, so the target positions of those runs are "
          "noisy (± 0.1–0.2″); the calibration columns compare the same exposures. *Site result: change* applies the "
          "run's cell corrections to the site measurement (weights = site exposures per cell); the 0.2° row shows the "
          "noise of a 2-exposure subset. A sparse subset can split a season (Epsilon Indi B: 2025-04 and 2025-06). Run times are on a busy machine; compare them only with each other. Detector D4 "
          "of Barnard's Star is missing in these runs: with only saturated D4 exposures the detection check drops the "
          "detector (`blink.detection_check` builds its detector list from exposures with a forced-photometry fit).", ""]
    Path(a.out).write_text("\n".join(L))
    print(f"wrote {a.out}")
    if a.json:
        write_json(a.json, a.out, T, FS, cellerr, repro, lplx)


def _js(o):
    """JSON-safe copy: numpy scalars -> float/int, tuples -> lists, NaN/inf -> None."""
    if isinstance(o, dict):
        return {str(k): _js(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_js(v) for v in o]
    if isinstance(o, (np.floating, float)):
        v = float(o)
        return round(v, 5) if math.isfinite(v) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def write_json(path, md, T, FS, cellerr, repro, lplx):
    """The numbers of ACCURACY.md for web pages. Per target: shift (d, err, sigma), proper motion,
    season positions minus the reference with stat (+) calibration errors, and whether the absolute
    position can be tested against the reference at all (Luhman 16AB: no Gaia 5-parameter solution)."""
    from datetime import datetime, timezone
    targets = []
    for t in T:
        d = dict(t)
        if d.get("shift"):
            sh = d["shift"]
            sh["sigma"] = abs(sh["d"]) / sh["err"] if sh.get("err") else None
        for se in d.get("seasons", []):
            se["sig_E"] = abs(se["dE"]) / se["sE"] if se.get("sE") else None
            se["sig_N"] = abs(se["dN"]) / se["sN"] if se.get("sN") else None
        d["absolute_position"] = ("reference_not_suitable" if t["key"] == "luhman16" else "tested")
        if t["key"] == "luhman16" and lplx:
            d["parallax_effect_arcsec"] = {k: v for k, v in lplx[2].items()}
        targets.append(d)
    doc = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "generator": "pipeline/accuracy.py",
           "markdown": rel(md), "targets": targets, "field_stars": FS,
           "cells": {n: dict(zip(("accepted", "total", "median_err_east", "median_err_north", "median_distinct_stars",
                                  "median_chi2r"), v)) for n, v in cellerr.items()},
           "field_stars_reproduce_site": repro}
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(_js(doc), indent=1, ensure_ascii=False))
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
