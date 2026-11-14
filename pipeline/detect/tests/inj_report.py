#!/usr/bin/env python3
"""Completeness tables from the injection runs (tests/injection.py output).

  python3 pipeline/detect/tests/inj_report.py <dir with inj_*.json> [--json out.json]

Motion: recovered / injected per (speed, AB mag), with the injections outside the exposures
(no data at the position) left out of the denominator and counted separately. Brightness:
per (fractional change, mag) and appearing / disappearing. For each field and magnitude the
speed above which every injected mover was recovered, and the pooled recovery above it
(with the 95 % lower limit of the binomial fraction). False candidates: candidates and
variables of the finder that are not near any injected source, where "near" means within
6" of the source's TRACK over the data span (a fast injected mover leaves residuals far from
its 2026.0 position; those are counted separately as track fragments, not as false).
"""
import argparse
import glob
import json
import math
import os
from collections import defaultdict

TRACK_T = (2025.2, 2027.0)
NEAR = 6.0


def sep(ra1, de1, ra2, de2):
    c = math.cos(math.radians(0.5 * (de1 + de2)))
    return math.hypot(((ra2 - ra1 + 180) % 360 - 180) * c, de2 - de1) * 3600


def track_dist(s, ra, dec):
    """Smallest distance (arcsec) of (ra, dec) from the injected source's track over TRACK_T."""
    pmra, pmdec = s.get("pmra") or 0.0, s.get("pmdec") or 0.0
    best = 1e9
    n = 60
    for k in range(n + 1):
        t = TRACK_T[0] + (TRACK_T[1] - TRACK_T[0]) * k / n
        dt = t - 2026.0
        r = s["ra"] + pmra * dt / 3.6e6 / math.cos(math.radians(s["dec"]))
        d = s["dec"] + pmdec * dt / 3.6e6
        best = min(best, sep(r, d, ra, dec))
    return best


def lower95(k, n):
    """One-sided 95 % lower limit of a binomial fraction (Clopper-Pearson)."""
    if n == 0:
        return None
    if k == 0:
        return 0.0
    lo, hi = 0.0, k / n
    for _ in range(60):
        p = 0.5 * (lo + hi)
        # P(X >= k | p)
        tail = 1.0 - sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k))
        if tail < 0.05:
            lo = p
        else:
            hi = p
    return round(lo, 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--json")
    a = ap.parse_args()
    runs = []
    for p in sorted(glob.glob(os.path.join(a.dir, "inj_*.json"))):
        try:
            runs.append(json.load(open(p)))
        except ValueError:
            continue
    if not runs:
        print("no runs")
        return
    out = {"n_runs": len(runs), "fields": sorted({r["field"] for r in runs}), "runs": []}
    mot = defaultdict(lambda: [0, 0, 0, 0])         # (field, speed, mag) -> [recovered, eligible, no_data, blended misses]
    bri = defaultdict(lambda: [0, 0, 0])            # (field, frac/kind, mag)
    reasons = defaultdict(int)
    falses = []
    for r in runs:
        f, m = r["field"], r["mag_ab"]
        srcs = r["sources"]
        for s in srcs:
            nodata = any("outside the exposures" in x for x in (s.get("miss_reasons") or []))
            if s["kind"] == "motion":
                key = (f, s["speed"], m)
                c = mot[key]
            else:
                key = (f, s["frac"] if s["kind"] == "variable" else s["kind"], m)
                c = bri[key]
            if nodata:
                c[2] += 1
                continue
            c[1] += 1
            if s["recovered"]:
                c[0] += 1
            else:
                if s["kind"] == "motion" and any("blended" in x for x in (s.get("miss_reasons") or [])):
                    c[3] += 1
                for x in s.get("miss_reasons") or []:
                    reasons[(s["kind"] if s["kind"] == "motion" else "brightness", x.split(":")[0])] += 1
        nf, frag = 0, 0
        for c in r["false_candidates"]:
            d = min((track_dist(s, c["ra"], c["dec"]) for s in srcs), default=1e9)
            if d < NEAR:
                frag += 1
            else:
                nf += 1
                falses.append(dict(c, field=f, mag=m, seed=r["seed"]))
        out["runs"].append({"field": f, "mag": m, "seed": r["seed"], "false": nf, "track_fragments": frag,
                            "seconds": r.get("seconds")})
    # motion table
    speeds = sorted({k[1] for k in mot})
    mags = sorted({k[2] for k in mot})
    fields = sorted({k[0] for k in mot})
    print("## Motion: recovered / injected (outside the data left out)\n")
    for fld in fields:
        print(f"### {fld}\n")
        print("| speed \"/yr | " + " | ".join(f"AB {m:g}" for m in mags) + " |")
        print("|---|" + "---|" * len(mags))
        for v in speeds:
            cells = []
            for m in mags:
                k, n, nd, _ = mot.get((fld, v, m), [0, 0, 0, 0])
                cells.append(f"{k}/{n}" if n else ("–" if not nd else "no data"))
            print(f"| {v:g} | " + " | ".join(cells) + " |")
        print()
    # thresholds: per field and mag, smallest speed with all speeds >= it fully recovered
    thr = {}
    for excl in (False, True):
        for fld in fields:
            for m in mags:
                vmin = None
                for v in sorted(speeds, reverse=True):
                    k, n, _, nb = mot.get((fld, v, m), [0, 0, 0, 0])
                    n_ = n - nb if excl else n
                    if n_ and k < n_:
                        break
                    if n_:
                        vmin = v
                if vmin is not None:
                    K = sum(mot[(fld, v, m)][0] for v in speeds if v >= vmin and (fld, v, m) in mot)
                    N = sum(mot[(fld, v, m)][1] - (mot[(fld, v, m)][3] if excl else 0) for v in speeds
                            if v >= vmin and (fld, v, m) in mot)
                    thr[(fld, m, excl)] = (vmin, K, N)
    print("## Motion threshold: every injected mover at or above this speed was recovered\n")
    print("| field | AB | all: speed >= \"/yr | recovered | 95 % low | blends excluded: speed >= | recovered | 95 % low |")
    print("|---|---|---|---|---|---|---|---|")
    for fld in fields:
        for m in mags:
            if not any(mot.get((fld, v, m), [0, 0])[1] for v in speeds):
                continue
            a_ = thr.get((fld, m, False))
            b_ = thr.get((fld, m, True))
            ca = f"{a_[0]:g} | {a_[1]}/{a_[2]} | {lower95(a_[1], a_[2])}" if a_ else "none | – | –"
            cb = f"{b_[0]:g} | {b_[1]}/{b_[2]} | {lower95(b_[1], b_[2])}" if b_ else "none | – | –"
            print(f"| {fld} | {m:g} | {ca} | {cb} |")
    print()
    # brightness table
    kinds = sorted({k[1] for k in bri}, key=lambda x: (isinstance(x, str), x if not isinstance(x, str) else 0, str(x)))
    print("## Brightness change: recovered / injected\n")
    for fld in sorted({k[0] for k in bri}):
        print(f"### {fld}\n")
        print("| change | " + " | ".join(f"AB {m:g}" for m in mags) + " |")
        print("|---|" + "---|" * len(mags))
        for kd in kinds:
            cells = []
            for m in mags:
                k, n, nd = bri.get((fld, kd, m), [0, 0, 0])
                cells.append(f"{k}/{n}" if n else ("–" if not nd else "no data"))
            lab = f"+{100 * kd:g} %" if not isinstance(kd, str) else kd
            print(f"| {lab} | " + " | ".join(cells) + " |")
        print()
    print("## Miss reasons (counts)\n")
    for (kind, x), n in sorted(reasons.items(), key=lambda q: -q[1]):
        print(f"- {kind}: {x}: {n}")
    print("\n## False candidates per run (not near any injected track)\n")
    print("| field | AB | seed | false | track fragments |")
    print("|---|---|---|---|---|")
    for rr in out["runs"]:
        print(f"| {rr['field']} | {rr['mag']:g} | {rr['seed']} | {rr['false']} | {rr['track_fragments']} |")
    byk = defaultdict(int)
    for c in falses:
        byk[(c["kind"], "+".join(c["detectors"]))] += 1
    print("\nFalse candidates by kind and detector:", dict(byk))
    if a.json:
        out["motion"] = [{"field": k[0], "speed": k[1], "mag": k[2], "recovered": v[0], "injected": v[1], "no_data": v[2],
                          "blended_misses": v[3]}
                         for k, v in sorted(mot.items())]
        out["brightness"] = [{"field": k[0], "change": k[1], "mag": k[2], "recovered": v[0], "injected": v[1], "no_data": v[2]}
                             for k, v in sorted(bri.items(), key=lambda q: str(q[0]))]
        out["thresholds"] = [{"field": k[0], "mag": k[1], "blends_excluded": k[2], "speed_min": v[0], "recovered": v[1],
                              "injected": v[2], "lower95": lower95(v[1], v[2])} for k, v in sorted(thr.items())]
        out["miss_reasons"] = [{"kind": k[0], "reason": k[1], "n": v} for k, v in reasons.items()]
        out["false_candidates"] = falses
        with open(a.json, "w") as fh:
            json.dump(out, fh, indent=1)


if __name__ == "__main__":
    main()
