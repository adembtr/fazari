#!/usr/bin/env python3
"""V6 bins over several injection seeds (pipeline/INJECTION_V11_PLAN.md).

  python3 -I pipeline/detect/tests/inj_seeds.py --new <dir> [--old <dir>] [--csv out.csv] [--json out.json]
  ... --csv <new csv> --amend-of <earlier csv>   (amendment, pipeline/INJECTION_V11_PLAN_AMEND.md: the runs that are
                                                  not in the earlier csv are tagged "new seed (amendment)" and only
                                                  they go into the new csv, then the pooled bins of all runs as
                                                  "pooled bin after amendment, ..."; the earlier csv is only read)

<dir> holds tests/injection.py outputs (inj_<field>_m<AB>_s<seed>.json). --new: the runs of the new seeds;
--old: the earlier runs of the same finder (here the seed-1 runs of the round v1.1 reduced re-run).
Prints per-run totals, totals per complete seed and the V6 bins for the new seeds alone and for both sets together.

Bins (round v0 list, per field): >= 0.3"/yr AB 12-14, >= 0.3"/yr AB 12-16, >= 1"/yr AB 12-17, >= 1"/yr AB 18,
>= 5"/yr AB 18; AB values are those of the field's grid. A seed enters a bin only if every AB of that bin was run
with that seed in that field. Recovery = recovered / injected, injections with no data at their position left out,
blends and saturated-star zones counted as misses. False candidates and track fragments as in inj_report.py.
"""
import argparse
import csv
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inj_report import NEAR, lower95, track_dist          # noqa: E402

GRID = {"eps_indi_b": [12, 13, 14, 15, 16, 17, 18, 19], "wise0855": [12, 13, 14, 15, 16, 17, 18, 19],
        "barnard": [12, 14, 16, 18]}
BINS = [(0.3, 12, 14), (0.3, 12, 16), (1.0, 12, 17), (1.0, 18, 18), (5.0, 18, 18)]
TARGET = 99.0


def load(d, tag):
    runs = {}
    for p in sorted(glob.glob(os.path.join(d, "inj_*.json"))):
        try:
            r = json.load(open(p))
        except ValueError:
            continue
        r["_set"] = tag
        runs[(r["field"], int(round(r["mag_ab"])), int(r["seed"]))] = r
    return runs


def nodata(s):
    return any("outside the exposures" in x for x in (s.get("miss_reasons") or []))


def run_row(r):
    mv = [s for s in r["sources"] if s["kind"] == "motion" and not nodata(s)]
    br = [s for s in r["sources"] if s["kind"] != "motion" and not nodata(s)]
    nf = frag = 0
    for c in r["false_candidates"]:
        if min((track_dist(s, c["ra"], c["dec"]) for s in r["sources"]), default=1e9) < NEAR:
            frag += 1
        else:
            nf += 1
    return dict(m_rec=sum(s["recovered"] for s in mv), m_inj=len(mv), b_rec=sum(s["recovered"] for s in br),
                b_inj=len(br), false=nf, frag=frag, seconds=r.get("seconds"))


def bin_value(runs, field, vmin, lo, hi):
    mags = [m for m in GRID[field] if lo <= m <= hi]
    seeds = sorted({k[2] for k in runs if k[0] == field})
    full = [s for s in seeds if all((field, m, s) in runs for m in mags)]
    k = n = 0
    for s in full:
        for m in mags:
            for x in runs[(field, m, s)]["sources"]:
                if x["kind"] == "motion" and x["speed"] >= vmin - 1e-9 and not nodata(x):
                    n += 1
                    k += bool(x["recovered"])
    return dict(field=field, min_speed=vmin, mag_lo=lo, mag_hi=hi, seeds=full, recovered=k, injected=n,
                percent=round(100 * k / n, 1) if n else None, lower95=lower95(k, n) if n else None)


def bins(runs):
    out = [bin_value(runs, f, v, lo, hi) for f in GRID for v, lo, hi in BINS]
    ev = [b for b in out if b["injected"]]
    best = max(ev, key=lambda b: (b["recovered"] / b["injected"], b["injected"])) if ev else None
    return out, best


def lab(b):
    ab = f"AB {b['mag_lo']}" + (f"-{b['mag_hi']}" if b["mag_hi"] != b["mag_lo"] else "")
    return f"{b['field']} >= {b['min_speed']:g}\"/yr {ab}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new", required=True)
    ap.add_argument("--old")
    ap.add_argument("--csv")
    ap.add_argument("--json")
    ap.add_argument("--amend-of")
    a = ap.parse_args()
    new = load(a.new, "new seed")
    had = set()                                 # (field, AB, seed) of the per-run rows of the earlier csv
    if a.amend_of:
        with open(a.amend_of, newline="") as fh:
            for r in csv.DictReader(fh):
                if not r["kind"].startswith("pooled bin"):
                    had.add((r["field"], int(r["mag_ab"]), int(r["seed"])))
        for k in new:
            if k not in had:
                new[k]["_set"] = "new seed (amendment)"
    old = load(a.old, "seed 1 (reduced re-run)") if a.old else {}
    both = dict(old)
    both.update(new)
    rows = {k: run_row(r) for k, r in both.items()}
    order = sorted(both, key=lambda k: (k[2], k[0], k[1]))
    print("| field | AB | seed | set | movers | brightness | false | track fragments | seconds |")
    print("|---|---|---|---|---|---|---|---|---|")
    for k in order:
        x = rows[k]
        print(f"| {k[0]} | {k[1]} | {k[2]} | {both[k]['_set']} | {x['m_rec']}/{x['m_inj']} | {x['b_rec']}/{x['b_inj']} | "
              f"{x['false']} | {x['frag']} | {x['seconds']} |")
    tot = lambda ks: {q: sum(rows[k][q] for k in ks) for q in ("m_rec", "m_inj", "b_rec", "b_inj", "false", "frag")}
    nk = [k for k in new]
    full_seeds = sorted(s for s in {k[2] for k in nk}
                        if all((f, m, s) in new for f in GRID for m in GRID[f]))
    summ = {"new_runs": len(nk), "new_total": tot(nk), "complete_seeds": full_seeds,
            "complete_seed_totals": {s: tot([k for k in nk if k[2] == s]) for s in full_seeds},
            "old_runs": len(old), "old_total": tot(list(old))}
    if a.amend_of:
        ak = [k for k in nk if k not in had]
        summ["amendment_runs"] = sorted(ak, key=lambda k: (k[2], k[0], k[1]))
        summ["amendment_total"] = tot(ak)
        print("\namendment runs", len(ak), summ["amendment_total"])
    print("\nnew runs", len(nk), summ["new_total"])
    for s, t in summ["complete_seed_totals"].items():
        print("complete seed", s, t)
    for name, rs in (("new seeds alone", new), ("all finder v1.1 runs", both)):
        out, best = bins(rs)
        summ[name] = {"bins": out, "best": best}
        print(f"\nBins, {name}:")
        for b in out:
            if b["injected"]:
                print(f"- {lab(b)}: {b['recovered']}/{b['injected']} = {b['percent']} % (95 % low {b['lower95']}), seeds {b['seeds']}")
            else:
                print(f"- {lab(b)}: not evaluated (no seed with every AB of the bin)")
        if best:
            st = "pass" if best["percent"] >= TARGET else "fail"
            print(f"best: {lab(best)} {best['recovered']}/{best['injected']} = {best['percent']} % -> {st} (target {TARGET:g} %)")
            summ[name]["status"] = st
    if a.json:
        json.dump(summ, open(a.json, "w"), indent=1, default=str)
    if a.csv:
        with open(a.csv, "w", newline="") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(["kind", "field", "mag_ab", "seed", "set", "bin", "recovered", "injected", "no_data"])
            for k in order:
                if k in had:
                    continue
                r = both[k]
                cells = {}
                for s in r["sources"]:
                    b = ("motion", s["speed"]) if s["kind"] == "motion" else \
                        ("brightness", s["frac"] if s["kind"] == "variable" else s["kind"])
                    c = cells.setdefault(b, [0, 0, 0])
                    if nodata(s):
                        c[2] += 1
                    else:
                        c[1] += 1
                        c[0] += bool(s["recovered"])
                for (kind, bn), c in sorted(cells.items(), key=lambda q: (q[0][0] != "motion", str(q[0][1]) if isinstance(q[0][1], str) else f"{q[0][1]:08.3f}")):
                    w.writerow([kind, k[0], k[1], k[2], r["_set"], bn, c[0], c[1], c[2]])
                w.writerow(["false candidates per run", k[0], k[1], k[2], r["_set"], "", rows[k]["false"], "", ""])
            for name in ("new seeds alone", "all finder v1.1 runs"):
                for b in summ[name]["bins"]:
                    if b["injected"]:
                        w.writerow([("pooled bin after amendment, " if a.amend_of else "pooled bin, ") + name, b["field"], f"{b['mag_lo']}-{b['mag_hi']}",
                                    " ".join(str(s) for s in b["seeds"]), "", f">= {b['min_speed']:g}", b["recovered"],
                                    b["injected"], ""])


if __name__ == "__main__":
    main()
