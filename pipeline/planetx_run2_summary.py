"""Planet X run 2: numbers of the search, the injections and the limit combined with run 1 -> site/data/planetx/run2.json.

  python pipeline/planetx_run2_summary.py <run-1 injection folder (v3b cells)> [--site-line site_line.json]
  python pipeline/planetx_run2_summary.py --links <strip>     every link of a strip, also those with false-link probability
                                                             > 0.05 (the search again, nothing else changed) -> results_run2/links_<strip>.json

Reads cache/planetx/plan_run2.json, results_run2/, injections_run2/, ledger_run2.json. Rules: pipeline/PLANETX_RUN2_PREREG.md.
"""
import glob
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import find_distant as FD  # noqa: E402

PX = FD.PX
OUT = FD.REPO / "site" / "data" / "planetx" / "run2.json"
RAD = 206264.806
K_CIRC = 2 * math.pi * RAD
PIX = 4.0
RUN1_AREA_350 = 2.08


def eff_area(valid, seasons, d_au):
    """deg^2 of reference positions whose three season positions (circular prograde body at d_au) are all valid (run-1 definition)."""
    w = 1.0 / d_au
    mu = K_CIRC * w ** 1.5
    t0 = float(np.mean([s["jyear"] for s in seasons]))
    ok = None
    for s in seasons:
        v = valid[s["season"]]
        dxi = w * s["parallax_factor_arcsec_au"][0] + mu * (s["jyear"] - t0)
        deta = w * s["parallax_factor_arcsec_au"][1]
        dx, dy = int(round(-dxi / PIX)), int(round(deta / PIX))
        sh = np.zeros_like(v)
        ny, nx = v.shape
        ys0, ys1 = max(0, -dy), min(ny, ny - dy)
        xs0, xs1 = max(0, -dx), min(nx, nx - dx)
        if ys1 > ys0 and xs1 > xs0:
            sh[ys0:ys1, xs0:xs1] = v[ys0 + dy:ys1 + dy, xs0 + dx:xs1 + dx]
        ok = sh if ok is None else (ok & sh)
    return float(ok.sum()) * (PIX / 3600) ** 2


def tally(files, strips=None):
    by = defaultdict(lambda: [0, 0])
    byd = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for f in files:
        r = json.load(open(f))
        if strips is not None and r["field"].split(":")[-1] not in strips:
            continue
        m, d = float(r["mag_ab"]), int(r["d_au"])
        k = sum(bool(b["recovered"]) for b in r["bodies"])
        n = len(r["bodies"])
        by[m][0] += k
        by[m][1] += n
        byd[d][m][0] += k
        byd[d][m][1] += n

    def lim(t):
        mags = sorted(t)
        fr = [t[m][0] / max(t[m][1], 1) for m in mags]
        c50, c90 = FD.crossing(mags, fr, 0.5), FD.crossing(mags, fr, 0.9)
        return {"found": {f"{m:g}": t[m] for m in mags}, "n_bodies": sum(t[m][1] for m in mags),
                "m50": None if c50 is None else round(c50, 2), "m90": None if c90 is None else round(c90, 2)}
    return {"all": lim(by), "by_distance": {str(d): lim(t) for d, t in sorted(byd.items())}}


def links_of(name, threads=2):
    from detect import distant as D
    FD.PLAN = PX / "plan_run2.json"
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
    (PX / "results_run2" / f"links_{name}.json").write_text(json.dumps(res, indent=1, default=str))
    print(json.dumps(res, indent=1, default=str))


def main():
    if sys.argv[1] == "--links":
        links_of(sys.argv[2])
        return
    run1_dir = sys.argv[1]
    line = None
    if "--site-line" in sys.argv:
        line = json.load(open(sys.argv[sys.argv.index("--site-line") + 1]))
    plan = json.loads((PX / "plan_run2.json").read_text())
    led = json.loads((PX / "ledger_run2.json").read_text())
    mb = defaultdict(float)
    for e in led["entries"]:
        mb[e["field"]] += e["bytes"] / 1e6
    inj_files = sorted(glob.glob(str(PX / "injections_run2" / "inj_*.json")))
    cells = defaultdict(int)
    for f in inj_files:
        cells[json.load(open(f))["field"].split(":")[-1]] += 1
    strips, done, links = [], [], []
    for f in plan["fields"]:
        name = f["name"]
        row = {"name": name, "nu_deg": f["nu_deg"], "r_au": f["r_au"], "ra": f["ra"], "dec": f["dec"], "ecl_lon": f["ecl_lon"],
               "ecl_lat": f["ecl_lat"], "gal_b": f["gal_b"], "n_plan": len(f["exposures"]), "mb_read": round(mb.get(name, 0.0), 1),
               "n_strips": len(list((PX / "strips" / name).glob("*_strip.fits"))), "searched": False, "injection_cells": cells.get(name, 0)}
        p = PX / "results_run2" / f"plain_strip_{name}.json"
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
            lp = PX / "results_run2" / f"links_{name}.json"
            if lp.exists():
                row["links"] = json.load(open(lp))["links"]
            for c in r["records"]:
                ev = c["nature"]["evidence"]
                links.append({"strip": name, "distance_au": c["distance_au"], "err_au": c["err_distance_au"],
                              "fap": c["confidence"]["false_alarm_probability"], "confirmed": c["confirmed"],
                              "snr": [q["snr"] for q in ev["positions"]], "positions": [[q["season"], q.get("ra"), q.get("dec")] for q in ev["positions"]]})
            vp = PX / "injections_run2" / f"valid_strip_{name}.npz"
            if vp.exists():
                z = np.load(vp)
                valid = {k[6:]: z[k].astype(bool) for k in z.files if k.startswith("valid_")}
                row["area_eff_deg2"] = {str(d): round(eff_area(valid, ss, d), 3) for d in (250, 350, 500, 700, 1000)}
            row["usable_for_limit"] = (row["injection_cells"] >= 10 and row["chance_links_per_shuffled_strip"] <= 1.0 and len(ss) >= 3)
            if row["usable_for_limit"]:
                done.append(name)
        strips.append(row)
    run2 = tally(inj_files, set(done))
    run1 = tally(sorted(glob.glob(f"{run1_dir}/inj_*.json")))
    both = tally(sorted(glob.glob(f"{run1_dir}/inj_*.json")) + [f for f in inj_files if json.load(open(f))["field"].split(":")[-1] in done])
    area2 = {d: round(sum(s.get("area_eff_deg2", {}).get(d, 0.0) for s in strips if s["name"] in done), 3) for d in ("250", "350", "500", "700", "1000")}
    res = {"run": 2, "rules": "distant-v3b (md5 14dd135e1ec5f00771fcf26784a40f92)", "prereg": "pipeline/PLANETX_RUN2_PREREG.md",
           "strips": strips, "strips_in_limit": done, "candidates": links,
           "n_links": sum(s.get("n_links", 0) for s in strips), "n_candidates": len(links),
           "bytes_read": int(led["total_bytes"]), "requests": int(led["requests"]),
           "limits": {"run2": run2, "run1": run1, "combined": both},
           "area_eff_deg2": {"run2": area2, "run1_350": RUN1_AREA_350, "combined_350": round(RUN1_AREA_350 + area2["350"], 2)},
           "band_deg2": 8640}
    if line:
        res["site_line"] = line
    OUT.write_text(json.dumps(res, indent=1, default=float))
    print(json.dumps({k: res[k] for k in ("strips_in_limit", "n_links", "n_candidates", "bytes_read", "area_eff_deg2")}, indent=1))
    for k in ("run2", "run1", "combined"):
        L = res["limits"][k]
        print(k, L["all"]["n_bodies"], "m50", L["all"]["m50"], "m90", L["all"]["m90"], L["all"]["found"],
              {d: q["m50"] for d, q in L["by_distance"].items()})


if __name__ == "__main__":
    main()
