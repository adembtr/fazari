"""Planet X run 3: numbers of the search, the injections and the limit over runs 1 + 2 + 3 -> site/data/planetx/run3.json.

  python pipeline/planetx_run3_summary.py <run-1 injection folder (v3b cells)> [--e2 site/data/planetx/inject10k.json]
                                          [--site-line site_line.json]
  python pipeline/planetx_run3_summary.py --links <strip>     every link of a strip, also those with false-link probability
                                                             > 0.05 (the search again, nothing else changed) -> results_run3/links_<strip>.json

Reads cache/planetx/plan_run3.json, results_run3/, injections_run3/, ledger_run3.json; for the ten old strips either E2's
cells (injections_10k/, only the blocks inject10k.json counts; --e2) or run 1's v3b cells + run 2's cells (injections_run2/).
Same limit method as pipeline/planetx_run2_summary.py (bodies pooled by V, find_distant.crossing).
Rules: pipeline/PLANETX_RUN3_PREREG.md.
"""
import glob
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import find_distant as FD  # noqa: E402
import planetx_run2_summary as S2  # noqa: E402  (eff_area, tally: the run-2 definitions, unchanged)

PX = FD.PX
OUT = FD.REPO / "site" / "data" / "planetx" / "run3.json"
RUN2_JSON = FD.REPO / "site" / "data" / "planetx" / "run2.json"
RUN1_AREA_350, RUN2_AREA_350 = 2.08, 2.41
BAND = 8640.0
H_CASES = {"0.75": -6.176, "0.40": -5.494, "0.20": -4.741}     # summary.json: 2.07 Earth radii, V = H + 10 log10(d / AU)


def field_of(f):
    return json.load(open(f))["field"].split(":")[-1]


def links_of(name, threads=2):
    from detect import distant as D
    FD.PLAN = PX / "plan_run3.json"
    field, exps, spec = FD.load_strips(name)
    ctx = FD.make_ctx(field, exps, spec, {"no_sso": True, "distant_n_rand": 2000, "distant_template": "all",
                                          "distant_threads": threads, "distant_report_fap": 1.0}, log=lambda *a: None)
    rows = []
    for r in D.run(ctx):
        ev = r["nature"]["evidence"]
        mo = ev["orbital_motion_arcsec_yr"]
        rows.append({"strip": name, "distance_au": r["distance_au"], "err_au": r["err_distance_au"],
                     "fap": r["confidence"]["false_alarm_probability"], "confirmed": r["confirmed"], "mag_ab": r.get("mag_ab"),
                     "snr": [q["snr"] for q in ev["positions"]], "positions": [[q["season"], q["ra"], q["dec"]] for q in ev["positions"]],
                     "motion_arcsec_yr": mo["total"], "circular_arcsec_yr": mo["circular_orbit_arcsec_yr"],
                     "failed_checks": [k["name"] for k in r["confirmation"]["checks"] if not k["pass"]]})
    res = {"strip": name, "version": D.VERSION, "n_links": ctx.info["P"]["n_links"],
           "chance_links_per_shuffled_strip": ctx.info["P"]["null"]["false_links_per_randomised_field"], "links": rows}
    (PX / "results_run3" / f"links_{name}.json").write_text(json.dumps(res, indent=1, default=str))
    print(json.dumps(res, indent=1, default=str))


def grid_reach_deg(vp, ra_t, dec_t):
    """Upper bound of the distance (deg) of a grid point from the strip's target: centre offset + half diagonal."""
    g = np.load(vp)["grid"]
    ra0, dec0, nx, ny, pix = (float(v) for v in g[:5])
    from find_distant_run3 import sep_deg
    return sep_deg(ra0, dec0, ra_t, dec_t) + math.hypot(nx, ny) * pix / 2 / 3600


def weighted(parts):
    """Area-weighted found fraction at the V common to every part: parts = [(area, tally['all'])]."""
    common = sorted(set.intersection(*[{float(m) for m in q["found"]} for _, q in parts]))
    tot = sum(a for a, _ in parts)
    fr = [sum(a * q["found"][f"{m:g}"][0] / q["found"][f"{m:g}"][1] for a, q in parts) / tot for m in common]
    c50, c90 = FD.crossing(common, fr, 0.5), FD.crossing(common, fr, 0.9)
    return {"v": common, "fraction": [round(x, 4) for x in fr], "m50": None if c50 is None else round(c50, 2),
            "m90": None if c90 is None else round(c90, 2), "areas": [a for a, _ in parts]}


def reach(m50):
    return {k: (None if m50 is None else round(10 ** ((m50 - h) / 10.0))) for k, h in H_CASES.items()}


def main():
    if sys.argv[1] == "--links":
        links_of(sys.argv[2])
        return
    run1_dir = sys.argv[1]
    e2 = json.load(open(sys.argv[sys.argv.index("--e2") + 1])) if "--e2" in sys.argv else None
    line = json.load(open(sys.argv[sys.argv.index("--site-line") + 1])) if "--site-line" in sys.argv else None
    plan = json.loads((PX / "plan_run3.json").read_text())
    led = json.loads((PX / "ledger_run3.json").read_text())
    mb = {}
    for e in led["entries"]:
        mb[e["field"]] = mb.get(e["field"], 0.0) + e["bytes"] / 1e6
    inj_files = sorted(glob.glob(str(PX / "injections_run3" / "inj_*.json")))
    cells = {}
    for f in inj_files:
        cells[field_of(f)] = cells.get(field_of(f), 0) + 1
    strips, done, links = [], [], []
    for f in plan["fields"]:
        name = f["name"]
        row = {"name": name, "nu_deg": f["nu_deg"], "r_au": f["r_au"], "ra": f["ra"], "dec": f["dec"], "ecl_lon": f["ecl_lon"],
               "ecl_lat": f["ecl_lat"], "gal_b": f["gal_b"], "n_plan": len(f["exposures"]), "mb_read": round(mb.get(name, 0.0), 1),
               "n_strips": len(list((PX / "strips" / name).glob("*_strip.fits"))), "searched": False, "injection_cells": cells.get(name, 0)}
        fj = PX / "strips" / name / "fetch.json"
        if fj.exists():
            row["not_read"] = json.load(open(fj))["not_read"]
        p = PX / "results_run3" / f"plain_strip_{name}.json"
        if p.exists():
            r = json.load(open(p))
            info = r["info"]
            ss = info["season_stacks"]
            row.update(searched=True, seconds=r["seconds"], version=r["version"], seasons=[s["season"] for s in ss],
                       n_exposures=[s["n_exposures"] for s in ss], depth_ab=[s["limit_5sigma_ab"] for s in ss],
                       n_orphans=[s["n_orphans"] for s in ss], grid_deg=info["grid"]["size_deg"], n_links=info["n_links"],
                       n_candidates=len(r["records"]), n_confirmed=sum(bool(c["confirmed"]) for c in r["records"]),
                       chance_links_per_shuffled_strip=info["null"]["false_links_per_randomised_field"],
                       n_shuffled=info["null"]["n_randomised"], link_checks=info.get("link_checks"))
            lp = PX / "results_run3" / f"links_{name}.json"
            if lp.exists():
                row["links"] = json.load(open(lp))["links"]
            for c in r["records"]:
                ev = c["nature"]["evidence"]
                links.append({"strip": name, "distance_au": c["distance_au"], "err_au": c["err_distance_au"],
                              "fap": c["confidence"]["false_alarm_probability"], "confirmed": c["confirmed"],
                              "snr": [q["snr"] for q in ev["positions"]], "positions": [[q["season"], q.get("ra"), q.get("dec")] for q in ev["positions"]]})
            vp = PX / "injections_run3" / f"valid_strip_{name}.npz"
            if vp.exists():
                z = np.load(vp)
                valid = {k[6:]: z[k].astype(bool) for k in z.files if k.startswith("valid_")}
                row["area_eff_deg2"] = {str(d): round(S2.eff_area(valid, ss, d), 3) for d in (250, 350, 500, 700, 1000)}
                row["grid_reach_deg"] = round(grid_reach_deg(vp, f["ra"], f["dec"]), 2)
            row["usable_for_limit"] = (row["injection_cells"] >= 10 and row["chance_links_per_shuffled_strip"] <= 1.0 and len(ss) >= 3)
            if row["usable_for_limit"]:
                done.append(name)
        strips.append(row)
    # separations: every run-3 target against every searched target and each other
    prev = dict(plan["previous"])
    seps = []
    for s in strips:
        others = {k: v for k, v in prev.items()}
        others.update({q["name"]: (q["ra"], q["dec"]) for q in strips if q["name"] != s["name"]})
        n, d = min(((k, FD_sep(s["ra"], s["dec"], *v)) for k, v in others.items()), key=lambda q: q[1])
        seps.append({"strip": s["name"], "nearest": n, "deg": round(d, 2)})
    run3_files = [f for f in inj_files if field_of(f) in done]
    run3 = S2.tally(run3_files)
    run1_files = sorted(glob.glob(f"{run1_dir}/inj_*.json"))
    r2 = json.load(open(RUN2_JSON))
    run2_files = [f for f in sorted(glob.glob(str(PX / "injections_run2" / "inj_*.json"))) if field_of(f) in set(r2["strips_in_limit"])]
    pool_1728 = S2.tally(run1_files + run2_files + run3_files)
    before = S2.tally(run1_files + run2_files)
    if e2 is not None:
        blocks = {(b[0], int(b[1])) for b in e2["blocks_in_limit"]}
        e2_files = [f for f in sorted(glob.glob(str(PX / "injections_10k" / "inj_*.json")))
                    if (field_of(f), int(json.load(open(f))["d_au"])) in blocks]
        old_files, old_name = e2_files, f"E2 10k test ({len(blocks)} blocks of strip x distance)"
    else:
        old_files, old_name = run1_files + run2_files, "runs 1 + 2 (528 + 600 bodies)"
    old = S2.tally(old_files)
    combined = S2.tally(old_files + run3_files)
    area3 = {d: round(sum(s.get("area_eff_deg2", {}).get(d, 0.0) for s in strips if s["name"] in done), 3) for d in ("250", "350", "500", "700", "1000")}
    area_all = round(RUN1_AREA_350 + RUN2_AREA_350 + area3["350"], 2)
    wcheck = weighted([(RUN1_AREA_350 + RUN2_AREA_350, old["all"]), (area3["350"], run3["all"])]) if run3_files else None
    rec = [b for f in run3_files for b in json.load(open(f))["bodies"] if b["recovered"]]
    stats = {"linked": sum(json.load(open(f))["n_linked"] for f in run3_files),
             "found": len(rec), "other_links_fap_le_0.05": sum(json.load(open(f))["n_false_records"] for f in run3_files),
             "distance_err_median_au": round(float(np.median([abs(b["d_fit"] - b["d_au"]) for b in rec])), 2) if rec else None,
             "seconds": round(sum(json.load(open(f))["seconds"] for f in run3_files)),
             "per_strip": {n: S2.tally([f for f in run3_files if field_of(f) == n])["by_distance"] for n in done}}
    res = {"run": 3, "rules": "distant-v3b (md5 14dd135e1ec5f00771fcf26784a40f92)", "prereg": "pipeline/PLANETX_RUN3_PREREG.md",
           "strips": strips, "strips_in_limit": done, "candidates": links, "separations": seps,
           "n_links": sum(s.get("n_links", 0) for s in strips), "n_candidates": len(links),
           "bytes_read": int(led["total_bytes"]), "requests": int(led["requests"]),
           "injection_stats": stats, "old_strips_bodies": old_name, "e2_used": e2 is not None,
           "limits": {"run3": run3, "old_strips": old, "combined": combined, "pool_runs123_1728": pool_1728,
                      "runs12_1128": before, "area_weighted_check": wcheck},
           "area_eff_deg2": {"run3": area3, "run1_350": RUN1_AREA_350, "run2_350": RUN2_AREA_350, "combined_350": area_all},
           "band_deg2": BAND, "band_fraction_combined": round(area_all / BAND, 6),
           "reach_au_combined_m50": reach(combined["all"]["m50"]), "reach_au_run3_m50": reach(run3["all"]["m50"])}
    if line:
        res["site_line"] = line
    OUT.write_text(json.dumps(res, indent=1, ensure_ascii=False, default=float))
    print(json.dumps({k: res[k] for k in ("strips_in_limit", "n_links", "n_candidates", "bytes_read", "requests", "area_eff_deg2",
                                          "band_fraction_combined", "old_strips_bodies", "separations", "injection_stats",
                                          "reach_au_combined_m50")}, indent=1, default=float))
    for k in ("run3", "old_strips", "combined", "pool_runs123_1728", "runs12_1128"):
        L = res["limits"][k]
        print(k, L["all"]["n_bodies"], "m50", L["all"]["m50"], "m90", L["all"]["m90"], L["all"]["found"],
              {d: (q["m50"], q["m90"]) for d, q in L["by_distance"].items()})
    print("area-weighted check", wcheck)


def FD_sep(a1, d1, a2, d2):
    from find_distant_run3 import sep_deg
    return sep_deg(a1, d1, a2, d2)


if __name__ == "__main__":
    main()
