"""Tables, summary statistics and the figure of the fast-star sweep (pipeline/fast_sweep.py report).

Writes (new files): site/data/fast_sweep/stars.csv, summary.json, figure.json, figure.png.
"""
import csv
import json
import math
import time

import numpy as np

import fast_sweep as FS


def _q(a, q):
    return float(np.percentile(a, q)) if len(a) else None


def stats(rows):
    m = [r for r in rows if r.get("ok")]
    if not m:
        return {"n": 0}
    pct = np.array([r["diff"]["pct"] for r in m])
    ab = np.array([r["diff"]["abs_mas_yr"] for r in m]) / 1000
    err = np.array([math.hypot(r["eE"], r["eN"]) / math.sqrt(2) for r in m]) / 1000
    return {"n": len(m),
            "median_abs_diff_pct": round(_q(pct, 50), 2), "p90_abs_diff_pct": round(_q(pct, 90), 2),
            "median_abs_diff_arcsec_yr": round(_q(ab, 50), 4), "p90_abs_diff_arcsec_yr": round(_q(ab, 90), 4),
            "frac_within_1sigma": round(float(np.mean([r["diff"]["within1"] for r in m])), 3),
            "frac_within_2sigma": round(float(np.mean([r["diff"]["within2"] for r in m])), 3),
            "frac_within_3sigma_pass": round(float(np.mean([r["diff"]["pass3"] for r in m])), 3),
            "median_error_arcsec_yr_per_axis": round(_q(err, 50), 4),
            "min_motion_5sigma_arcsec_yr": round(5 * _q(err, 50), 3)}


def flags_of(r):
    f = []
    if r.get("saturated"):
        f.append("saturated")
    if r.get("blend_gaia_arcsec"):
        f.append(f"blended({r['blend_gaia_arcsec']:.1f}\")")
    if r.get("reg") and (r["reg"].get("source_of_offset") or {}).get("none", 0) > 0:
        f.append("unregistered-exposures")
    if r.get("reg") and r["reg"].get("mode") != "gaia":
        f.append("self-registered")
    if r.get("ok") and r.get("pair") is None:
        f.append("no-same-orientation-pair")
    return f


def report(a):
    S, nu = FS.sample()
    S = S[:a.max]
    d = FS.CACHE / "results" / f"B{a.box:.2f}_K{a.k}"
    cv = json.loads((d / "code_version.json").read_text())
    rows, attempted = [], []
    for s in S:
        p = d / f"{s['sid']}.json"
        if not p.exists():
            continue
        r = json.loads(p.read_text())
        r["_s"] = s
        attempted.append(r)
    versions = sorted({r.get("code_version") for r in attempted})
    OUT = FS.OUTD
    OUT.mkdir(parents=True, exist_ok=True)
    cols = ["order", "set", "gaia_dr3_source_id", "name", "ra_2026", "dec_2026", "m_spx_ab", "speed_class",
            "gaia_pmra_mas_yr", "gaia_pmdec_mas_yr", "gaia_pm_arcsec_yr", "gaia_pa_deg",
            "meas_pmra_mas_yr", "meas_pmdec_mas_yr", "err_pmra_mas_yr", "err_pmdec_mas_yr",
            "meas_pm_arcsec_yr", "meas_pm_err_arcsec_yr", "meas_pa_deg", "meas_pa_err_deg",
            "diff_mas_yr", "diff_pct", "diff_sigma_2d", "within_1sigma", "within_2sigma", "pass_3sigma",
            "pair_from", "pair_to", "pair_dt_yr", "pair_shift_arcsec", "pair_shift_err_arcsec", "pair_pa_deg",
            "pair_speed_arcsec_yr", "pair_diff_pct", "independence_pull", "saturated", "flags", "status", "reason",
            "n_exposures", "n_seasons", "ref_stars_per_exposure", "registration_own_frac", "box_deg", "k_per_det_season",
            "mb_read", "code_version"]
    led0 = json.loads((FS.CACHE / "ledger.json").read_text())
    sid_bytes = {}
    for e in led0["entries"]:
        sid_bytes[e["sid"]] = sid_bytes.get(e["sid"], 0) + e["bytes"]
    out_rows = []
    for r in attempted:
        s = r["_s"]
        ok = bool(r.get("ok"))
        ra, dec = FS.pos2026(s)
        g = r.get("gaia") or {"pmra": s["pmra"], "pmdec": s["pmdec"], "pm": s["pm"] * 1000,
                              "pa": math.degrees(math.atan2(s["pmra"], s["pmdec"])) % 360}
        p = r.get("pair") or {}
        dd = r.get("diff") or {}
        mm = r.get("meas") or {}
        fe = r.get("fetch") or {}

        def f(v, n):
            return "" if v is None else round(v, n)
        out_rows.append({
            "order": s["order"], "set": "fastest" if s["set"] == "F" else "random", "gaia_dr3_source_id": s["sid"],
            "name": s["name"] or "", "ra_2026": round(ra, 6), "dec_2026": round(dec, 6), "m_spx_ab": s["m_spx"],
            "speed_class": FS.speed_class(s["pm"]),
            "gaia_pmra_mas_yr": g["pmra"], "gaia_pmdec_mas_yr": g["pmdec"], "gaia_pm_arcsec_yr": round(g["pm"] / 1000, 4),
            "gaia_pa_deg": round(g["pa"], 2),
            "meas_pmra_mas_yr": f(r.get("pmE"), 1), "meas_pmdec_mas_yr": f(r.get("pmN"), 1),
            "err_pmra_mas_yr": f(r.get("eE"), 1), "err_pmdec_mas_yr": f(r.get("eN"), 1),
            "meas_pm_arcsec_yr": f(mm.get("pm") and mm["pm"] / 1000, 4),
            "meas_pm_err_arcsec_yr": f(mm.get("pm_err") and mm["pm_err"] / 1000, 4),
            "meas_pa_deg": f(mm.get("pa"), 2), "meas_pa_err_deg": f(mm.get("pa_err"), 2),
            "diff_mas_yr": f(dd.get("abs_mas_yr"), 1), "diff_pct": f(dd.get("pct"), 2), "diff_sigma_2d": f(dd.get("sigma"), 2),
            "within_1sigma": dd.get("within1", ""), "within_2sigma": dd.get("within2", ""), "pass_3sigma": dd.get("pass3", ""),
            "pair_from": p.get("from", ""), "pair_to": p.get("to", ""), "pair_dt_yr": f(p.get("dt_yr"), 3),
            "pair_shift_arcsec": f(p.get("arcsec"), 3), "pair_shift_err_arcsec": f(p.get("err_arcsec"), 3),
            "pair_pa_deg": f(p.get("pa_deg"), 2), "pair_speed_arcsec_yr": f(p.get("speed"), 4),
            "pair_diff_pct": f(p.get("gaia_pct"), 2),
            "independence_pull": f((r.get("perturb") or {}).get("pull"), 3),
            "saturated": bool(r.get("saturated")), "flags": ";".join(flags_of(r)),
            "status": "measured" if ok else "failed", "reason": "" if ok else r.get("why", ""),
            "n_exposures": r.get("n_exposures_used", r.get("n_exposures_loaded", "")),
            "n_seasons": r.get("n_seasons", r.get("n_seasons_loaded", "")),
            "ref_stars_per_exposure": f(r.get("n_ref_in_box_median"), 1),
            "registration_own_frac": f((r.get("reg") or {}).get("frac_own"), 3),
            "box_deg": a.box, "k_per_det_season": a.k, "mb_read": round(sid_bytes.get(s["sid"], 0) / 1e6, 2),
            "code_version": r.get("code_version")})
    with open(OUT / "stars.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(out_rows)
    m = [r for r in attempted if r.get("ok")]
    for r in attempted:
        r["_cls"] = FS.speed_class(r["_s"]["pm"])
    by_class = {c: stats([r for r in m if r["_cls"] == c]) for c in sorted({r["_cls"] for r in attempted})}
    sat = stats([r for r in m if r.get("saturated")])
    uns = stats([r for r in m if not r.get("saturated")])
    clean = stats([r for r in m if not flags_of(r)])
    fails = {}
    for r in attempted:
        if not r.get("ok"):
            k = r.get("why", "?").split(":")[0].split("(")[0].strip()
            fails.setdefault(k, []).append(r["_s"]["name"] or r["_s"]["sid"])
    pulls = [r["perturb"]["pull"] for r in m if (r.get("perturb") or {}).get("pull") is not None]
    led = json.loads((FS.CACHE / "ledger.json").read_text())
    per_sid = {}
    for e in led["entries"]:
        per_sid[e["sid"]] = per_sid.get(e["sid"], 0) + e["bytes"]
    pair_ok = [r for r in m if r.get("pair")]
    status = (f"interim: {len(attempted)} of {len(S)} pre-registered stars (target 100), sweep continuing"
              if len(attempted) < len(S) else "final")
    summ = {
        "status": status,
        "built": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "what": "Proper motions of Gaia DR3 fast stars measured in SPHEREx images (detector B path, Gaia-registered on "
                "the other stars of the box) compared with Gaia DR3",
        "preregistered": "pipeline/FAST_SWEEP.md (rule written 2026-11-14 17:06 +03 before any measurement)",
        "box_deg": a.box, "k_exposures_per_detector_per_season": a.k,
        "code_version": cv["tag"], "code_files_sha1": cv["files"], "versions_in_table": versions,
        "sample_size": len(S), "attempted": len(attempted), "measured": len(m), "failed": len(attempted) - len(m),
        "failures": fails,
        "all": stats(m), "clean_no_flags": clean, "saturated": sat, "not_saturated": uns, "by_speed_class": by_class,
        "fastest_set": stats([r for r in m if r["_s"]["set"] == "F"]),
        "random_set": stats([r for r in m if r["_s"]["set"] == "R"]),
        "same_orientation_pair": {"n": len(pair_ok),
                                  "median_abs_diff_pct": round(_q(np.abs([r["pair"]["gaia_pct"] for r in pair_ok]), 50), 2) if pair_ok else None,
                                  "frac_within_2sigma": round(float(np.mean([abs(r["pair"]["sigma"]) <= 2 for r in pair_ok])), 3) if pair_ok else None},
        "independence": {"test": f"starting track wrong by +{FS.PERTURB:.0%} of the Gaia motion (same 2026.0 position)",
                         "n": len(pulls), "median_pull": round(_q(np.array(pulls), 50), 4) if pulls else None,
                         "p90_abs_pull": round(_q(np.abs(pulls), 90), 4) if pulls else None,
                         "meaning": "pull = fraction of a wrong starting motion that survives in the result "
                                    "(0 = the result does not depend on Gaia's value of the target's motion)"},
        "bytes_read_total_mb": round(led["total_bytes"] / 1e6, 1),
        "bytes_read_disk_reconstruction_mb": round(FS.ledger_disk()["total_bytes"] / 1e6, 1),
        "registration": {"median_frac_exposure_or_cell_offsets": round(_q(np.array([r["reg"]["frac_own"] for r in m]), 50), 3) if m else None,
                         "n_with_unregistered_exposures": sum(1 for r in m if (r["reg"].get("source_of_offset") or {}).get("none", 0) > 0)},
    }
    (OUT / "summary.json").write_text(json.dumps(FS._clean(summ), indent=1))
    # figure data + PNG
    pts = [{"sid": r["_s"]["sid"], "name": r["_s"]["name"], "gaia": round(r["gaia"]["pm"] / 1000, 4),
            "meas": round(r["meas"]["pm"] / 1000, 4), "err": round(r["meas"]["pm_err"] / 1000, 4),
            "diff_pct": round(r["diff"]["pct"], 2), "sigma": round(r["diff"]["sigma"], 2),
            "saturated": bool(r.get("saturated"))} for r in m]
    fig = {"title": "SPHEREx-measured vs Gaia DR3 proper motion", "status": status, "code_version": cv["tag"], "x": "Gaia DR3 total proper motion (arcsec/yr)",
           "y": "measured / Gaia - 1 (%)", "points": pts, "summary": summ["all"]}
    (OUT / "figure.json").write_text(json.dumps(FS._clean(fig), indent=1))
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fg, (a1, a2) = plt.subplots(1, 2, figsize=(10, 4.2), dpi=110)
        for sat_, c, lab in ((False, "#2a6fdb", "not saturated"), (True, "#d9822b", "saturated (wing fit)")):
            P = [p for p in pts if p["saturated"] == sat_]
            if not P:
                continue
            g = np.array([p["gaia"] for p in P]); y = np.array([p["meas"] for p in P]); e = np.array([p["err"] for p in P])
            a1.errorbar(g, y, yerr=e, fmt="o", ms=3.5, color=c, label=lab, lw=0.8)
            a2.errorbar(g, 100 * (y / g - 1), yerr=100 * e / g, fmt="o", ms=3.5, color=c, lw=0.8)
        lim = [0.4, 12]
        a1.plot(lim, lim, color="#888", lw=0.8, zorder=0)
        a1.set_xscale("log"); a1.set_yscale("log"); a1.set_xlim(lim); a1.set_ylim(lim)
        a1.set_xlabel("Gaia DR3 proper motion (arcsec/yr)"); a1.set_ylabel("SPHEREx measured (arcsec/yr)")
        a1.legend(fontsize=8, frameon=False)
        a2.axhline(0, color="#888", lw=0.8)
        a2.set_xscale("log"); a2.set_xlim(lim)
        a2.set_xlabel("Gaia DR3 proper motion (arcsec/yr)"); a2.set_ylabel("speed difference (%)")
        s_ = summ["all"]
        a2.set_title(f"N={s_.get('n')}  median |diff| {s_.get('median_abs_diff_pct')} %  "
                     f"within 2σ {100 * (s_.get('frac_within_2sigma') or 0):.0f} %", fontsize=9)
        fg.suptitle(f"Fazari fast-star sweep ({status}; code {cv['tag']})", fontsize=9)
        fg.tight_layout()
        fg.savefig(OUT / "figure.png")
    except Exception as ex:
        print("figure failed:", ex)
    print(json.dumps(FS._clean(summ), indent=1))
