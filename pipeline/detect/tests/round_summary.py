#!/usr/bin/env python3
"""Markdown summary of one test round (tests/run_round.sh output folder).

  python3 -I pipeline/detect/tests/round_summary.py <OUT> --version v1 >> ajan_durumu/test_sonuclari.md
"""
import argparse
import glob
import json
import math
import os


def load(p):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--version", default="?")
    a = ap.parse_args()
    o = a.out
    print(f"\n## Test round {a.version}  (output: {o})\n")
    # ---- blind recovery and null fields
    rows = [load(p) for p in sorted(glob.glob(os.path.join(o, "blind", "*", "blind_row.json")))]
    rows = [r for r in rows if r]
    print("### 1. Blind recovery (finder not told the target position)\n")
    print("| field | found | class / detectors | speed \"/yr | ref | d speed (sigma) | PA | ref PA | d PA | sep \" | seconds |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        ref, rec = r.get("reference"), r.get("recovered")
        if not ref:
            continue
        if rec:
            e = rec.get("err_speed") or float("nan")
            ds = rec["d_speed"] / e if e and e > 0 else float("nan")
            print(f"| {r['field']} | yes | {rec['class']} {'+'.join(rec['detectors'])} | {rec['speed_arcsec_yr']:.3f} ± {e:.3f} | "
                  f"{ref['speed_arcsec_yr']:.3f} | {rec['d_speed']:+.3f} ({ds:+.1f}) | {rec['pa_deg']:.1f} ± {rec['err_pa']} | "
                  f"{ref['pa_deg']:.1f} | {rec['d_pa']:+.1f} | {rec['sep_arcsec']} | {r['seconds']} |")
        else:
            print(f"| {r['field']} | NO | – | – | {ref['speed_arcsec_yr']:.3f} | – | – | {ref['pa_deg']:.1f} | – | – | {r['seconds']} |")
    print("\n### 1b. Brightness-change targets (variable at the target position, within 10\")\n")
    print("| field | found | detectors | max change | sigma | flags |")
    print("|---|---|---|---|---|---|")
    for name in ("rw_aur", "r_dra"):
        d = load(os.path.join(o, "blind", name, "candidates.json"))
        if not d:
            continue
        fra, fde = d["field"]["ra"], d["field"]["dec"]
        hit = None
        for c in d["candidates"]:
            if c["class"] == "artifact" or c["kind"] not in ("variable", "appearing", "disappearing"):
                continue
            sep = math.hypot((c["ra"] - fra) * math.cos(math.radians(fde)), c["dec"] - fde) * 3600
            if sep < 10 and (hit is None or sep < hit[0]):
                hit = (sep, c)
        if hit:
            b = hit[1].get("brightness") or {}
            print(f"| {name} | yes | {'+'.join(hit[1]['detectors'])} | {b.get('max_change_frac')} | {b.get('max_sigma')} | {hit[1]['flags'][:2]} |")
        else:
            print(f"| {name} | NO | – | – | – | – |")
    print("\n### 2. Candidates per field (non-artifact, not the reference target)\n")
    print("| field | moving candidates | variable / appearing / disappearing | Gaia-known movers | artifacts | candidates.json |")
    print("|---|---|---|---|---|---|")
    for r in rows:
        tgt = (r.get("recovered") or {}).get("id")
        na = [c for c in r["non_artifact"] if c["id"] != tgt]
        mov = [c for c in na if c["kind"] == "motion" and c["class"] == "candidate"]
        var = [c for c in na if c["kind"] != "motion" and c["class"] in ("candidate", "variable")]
        gk = [c for c in na if c["class"] == "gaia-known"]
        path = os.path.join(o, "blind", r["field"].replace(":", "_"), "candidates.json")
        print(f"| {r['field']} | {len(mov)} | {len(var)} | {len(gk)} | {r['summary']['by_class']['artifact']} | {path} |")
    print("\nDetails of the non-target candidates (for checking):\n")
    for r in rows:
        tgt = (r.get("recovered") or {}).get("id")
        for c in r["non_artifact"]:
            if c["id"] == tgt or c["class"] == "gaia-known":
                continue
            print(f"- {r['field']} {c['id']} {c['class']} {c['kind']} {'+'.join(c['detectors'])} "
                  f"ra {c['ra']} dec {c['dec']} speed {c['speed']} pa {c['pa']} flags {c['flags']}")
    # ---- shuffle null
    print("\n### 3. Date-shuffle null test (detectors B + D; 100 exposure-label shuffles, all season permutations)\n")
    print("| field | sources | real-label movers | fake movers / 100 shuffles | max in one | drifts >= 5 sigma per shuffle before checks | season permutations (fake movers each) |")
    print("|---|---|---|---|---|---|---|")
    for p in sorted(glob.glob(os.path.join(o, "shuf", "shuffle_*.json"))):
        d = load(p)
        if not d:
            continue
        es = d["exposure_shuffle"]
        print(f"| {d['field']} | {d['n_sources']} | {d['real_labels']['n_movers']} | {es['fake_movers_total']} / {d['n_shuffles']} | "
              f"{es['max_in_one_shuffle']} | {es['drift_5sigma_per_shuffle_mean']} | {[x['n_movers'] for x in d['season_permutations']]} |")
    # ---- injection
    rp = os.path.join(o, "inj", "report.md")
    if os.path.exists(rp):
        print("\n### 4. Injection (completeness)\n")
        txt = open(rp).read().replace("\n## ", "\n#### ").replace("\n### ", "\n##### ")
        if txt.startswith("## "):
            txt = "#### " + txt[3:]
        print(txt)


if __name__ == "__main__":
    main()
