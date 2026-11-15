"""Planet X, 10,400-body injection test: completeness curve and limit -> site/data/planetx/inject10k.json.

  python pipeline/planetx_inject10k_summary.py <run-1 injection folder (v3b cells)> [--links links.json]

Plan (written and pushed before the run): pipeline/PLANETX_INJECT10K_PLAN.md. Added after the run 2 pre-registration (1efa576),
at Adem's request; detection rules unchanged (distant-v3b). Reads cache/planetx/injections_10k/ (this test),
cache/planetx/injections_run2/ and the run-1 folder (the 1128 earlier bodies), site/data/planetx/run2.json (area) and
site/data/planetx/summary.json (brightness model). The limit method is that of pipeline/planetx_run2_summary.py (tally,
find_distant.crossing); new here: a bootstrap of the bodies and a density check (52 against 12 bodies per cell).
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
SITE = FD.REPO / "site" / "data" / "planetx"
OUT = SITE / "inject10k.json"
INJ = PX / "injections_10k"
MAGS = [17.5, 18.0, 18.5, 18.75, 19.0, 19.2, 19.4, 19.55, 19.7, 20.0]
ORDER = ["R2-nu+170", "F1-aphelion", "R2-nu+145", "F2-ra45", "R2-nu+135", "F3-perihelion", "R2-nu+125", "F4-nu-75",
         "R2-nu+115", "F5-nu+75"]
SEEDS = {(f, 350): 101 + i for i, f in enumerate(ORDER)} | {(f, 500): 111 + i for i, f in enumerate(ORDER)}
OLD = [f for f in ORDER if f.startswith("F")]
NEW = [f for f in ORDER if f.startswith("R2")]
DENSITY_MAGS = [18.5, 19.0, 19.4, 19.7, 20.0]
N_BOOT, BOOT_SEED = 2000, 10000


def strip_of(r):
    return r["field"].split(":")[-1]


def load(files):
    return [(f, json.load(open(f))) for f in files]


def bodies_by_mag(cells):
    """{V: 0/1 array of found bodies} pooled over the cells."""
    by = defaultdict(list)
    for _, r in cells:
        by[float(r["mag_ab"])] += [bool(b["recovered"]) for b in r["bodies"]]
    return {m: np.array(v, bool) for m, v in sorted(by.items())}


def crossings(by):
    mags = sorted(by)
    fr = [float(by[m].mean()) if len(by[m]) else 0.0 for m in mags]
    return FD.crossing(mags, fr, 0.5), FD.crossing(mags, fr, 0.9)


def bootstrap(by, n=N_BOOT, seed=BOOT_SEED):
    rng = np.random.default_rng(seed)
    mags = sorted(by)
    c50, c90 = [], []
    for _ in range(n):
        fr = [float(by[m][rng.integers(0, len(by[m]), len(by[m]))].mean()) for m in mags]
        c50.append(FD.crossing(mags, fr, 0.5))
        c90.append(FD.crossing(mags, fr, 0.9))

    def q(c):
        ok = np.array([x for x in c if x is not None], float)
        if not len(ok):
            return {"p16": None, "p50": None, "p84": None, "frac_not_reached": 1.0}
        return {"p16": round(float(np.percentile(ok, 16)), 2), "p50": round(float(np.percentile(ok, 50)), 2),
                "p84": round(float(np.percentile(ok, 84)), 2), "frac_not_reached": round(1 - len(ok) / len(c), 4)}
    return {"n_resamples": n, "seed": seed, "m50": q(c50), "m90": q(c90)}


def wilson(k, n, z=1.0):
    if n == 0:
        return None, None
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return round(c - h, 4), round(c + h, 4)


def curve(by):
    out = []
    for m in sorted(by):
        k, n = int(by[m].sum()), len(by[m])
        lo, hi = wilson(k, n)
        out.append({"v": m, "found": k, "n": n, "frac": round(k / n, 4) if n else None, "lo68": lo, "hi68": hi})
    return out


def r2(x):
    return None if x is None else round(x, 2)


def fmt(x, d, tr):
    if x is None:
        return "-"
    s = f"{x:,.{d}f}"
    if tr:
        s = s.replace(",", "_").replace(".", ",").replace("_", ".")
    return s


# Turkish case endings after a number: from the last word it is read with ("19,62" -> "iki", "360" -> "altmış")
_TR_UNIT = {1: "bir", 2: "iki", 3: "üç", 4: "dört", 5: "beş", 6: "altı", 7: "yedi", 8: "sekiz", 9: "dokuz"}
_TR_TENS = {1: "on", 2: "yirmi", 3: "otuz", 4: "kırk", 5: "elli", 6: "altmış", 7: "yetmiş", 8: "seksen", 9: "doksan"}


def _tr_last_word(numstr):
    part = numstr.split(",")[-1].replace(".", "")
    digits = [int(c) for c in part if c.isdigit()]
    if digits and digits[-1]:
        return _TR_UNIT[digits[-1]]
    if len(digits) >= 2 and digits[-2]:
        return _TR_TENS[digits[-2]]
    if len(digits) >= 3 and digits[-3]:
        return "yüz"
    return "bin" if len(digits) >= 4 else "sıfır"


def tr_case(numstr, case):
    """numstr + "'" + ending: case dat (-e/-a), abl (-den/-dan/-ten/-tan), loc (-de/-da/-te/-ta), poss (-si/-sı/-i/-ı...)."""
    w = _tr_last_word(numstr)
    last_v = [c for c in w if c in "aeıioöuü"][-1]
    back = last_v in "aıou"
    ends_v = w[-1] in "aeıioöuü"
    hard = w[-1] in "çfhkpsşt"
    if case == "dat":
        e = ("y" if ends_v else "") + ("a" if back else "e")
    elif case == "abl":
        e = ("t" if hard else "d") + ("an" if back else "en")
    elif case == "loc":
        e = ("t" if hard else "d") + ("a" if back else "e")
    else:
        e = ("s" if ends_v else "") + {"a": "ı", "ı": "ı", "o": "u", "u": "u", "e": "i", "i": "i", "ö": "ü", "ü": "ü"}[last_v]
    return f"{numstr}'{e}"


def main():
    run1_dir = sys.argv[1]
    links = json.load(open(sys.argv[sys.argv.index("--links") + 1])) if "--links" in sys.argv else {}
    cells = load(sorted(glob.glob(str(INJ / "inj_*.json"))))
    # complete blocks: one strip x one distance x all 10 magnitudes with the planned seed
    blk = defaultdict(list)
    for f, r in cells:
        key = (strip_of(r), int(r["d_au"]))
        if SEEDS.get(key) == int(r["seed"]) and r["version"] == "distant-v3b":
            blk[key].append((f, r))
    complete = [k for k in SEEDS if {float(r["mag_ab"]) for _, r in blk.get(k, [])} >= set(MAGS)]
    used = [c for k in complete for c in blk[k]]
    left_out = [{"strip": k[0], "d_au": k[1], "cells_done": len(blk.get(k, []))} for k in SEEDS if k not in complete]

    def tally(sel):
        by = bodies_by_mag(sel)
        c50, c90 = crossings(by)
        return {"found": {f"{m:g}": [int(v.sum()), len(v)] for m, v in by.items()}, "n_bodies": int(sum(len(v) for v in by.values())),
                "m50": r2(c50), "m90": r2(c90)}

    by_all = bodies_by_mag(used)
    L = {"all": tally(used),
         "by_distance": {str(d): tally([c for c in used if int(c[1]["d_au"]) == d]) for d in (350, 500)},
         "old5": tally([c for c in used if strip_of(c[1]) in OLD]),
         "new5": tally([c for c in used if strip_of(c[1]) in NEW]),
         "by_strip": {s: tally([c for c in used if strip_of(c[1]) == s]) for s in ORDER}}
    # the 1128 earlier bodies (run 1 v3b pass + run 2), read from their own files
    before_cells = load(sorted(glob.glob(f"{run1_dir}/inj_*.json")) + sorted(glob.glob(str(PX / "injections_run2" / "inj_*.json"))))
    by_before = bodies_by_mag(before_cells)
    Lb = tally(before_cells)
    Lpool = tally(used + before_cells)
    # density check: 52-body cells against the 12-body cells of runs 1-2, same strips, distances and magnitudes
    dens = []
    for m in DENSITY_MAGS:
        a = np.array([b for _, r in used if float(r["mag_ab"]) == m for b in (bool(q["recovered"]) for q in r["bodies"])], bool)
        b = np.array([q for _, r in before_cells if float(r["mag_ab"]) == m and (strip_of(r), int(r["d_au"])) in complete
                      for q in (bool(x["recovered"]) for x in r["bodies"])], bool)
        if not len(a) or not len(b):
            continue
        p = (a.sum() + b.sum()) / (len(a) + len(b))
        se = math.sqrt(p * (1 - p) * (1 / len(a) + 1 / len(b))) if 0 < p < 1 else float("nan")
        dens.append({"v": m, "found_52": [int(a.sum()), len(a)], "found_12": [int(b.sum()), len(b)],
                     "frac_52": round(float(a.mean()), 4), "frac_12": round(float(b.mean()), 4),
                     "z": round(float((a.mean() - b.mean()) / se), 2) if se == se and se > 0 else None})
    # coverage masks: the same as runs 1 and 2 (same strips, same code)
    masks = {}
    for s in ORDER:
        new = INJ / f"valid_strip_{s}.npz"
        old = Path(run1_dir) / f"valid_strip_{s}.npz" if s in OLD else PX / "injections_run2" / f"valid_strip_{s}.npz"
        if new.exists() and old.exists():
            zn, zo = np.load(new), np.load(old)
            ks = sorted(k for k in zn.files if k.startswith("valid_"))
            masks[s] = bool(ks == sorted(k for k in zo.files if k.startswith("valid_")) and all(np.array_equal(zn[k], zo[k]) for k in ks))
        else:
            masks[s] = None
    run2 = json.loads((SITE / "run2.json").read_text())
    S = json.loads((SITE / "summary.json").read_text())
    # effective area at 350 AU (run-1 / run-2 definition) of the strips that have a complete block in the limit
    a350 = {f["name"]: f["area_eff_deg2"]["350"] for f in S["fields"]} | {q["name"]: q["area_eff_deg2"]["350"] for q in run2["strips"]}
    in_lim = sorted({k[0] for k in complete}, key=ORDER.index)
    area = round(sum(a350[s_] for s_ in in_lim), 2)
    band = run2["band_deg2"]
    reach = {c["key"]: {"albedo": c["albedo"], "au": None if L["all"]["m50"] is None else round(10 ** ((L["all"]["m50"] - c["H"]) / 10))}
             for c in S["expected"]["cases"]}
    reach_b = {c["key"]: round(10 ** ((Lb["m50"] - c["H"]) / 10)) for c in S["expected"]["cases"]}
    found_rows = [b for _, r in used for b in r["bodies"] if b.get("recovered") and b.get("d_fit") is not None]
    derr = float(np.median([abs(b["d_fit"] - b["d_au"]) for b in found_rows])) if found_rows else None
    res = {
        "test": "inject10k", "added_after": "run 2 pre-registration (1efa576), at Adem's request; detection rules unchanged",
        "plan": "pipeline/PLANETX_INJECT10K_PLAN.md", "rules": "distant-v3b (md5 14dd135e1ec5f00771fcf26784a40f92)",
        "strips": ORDER, "old5": OLD, "new5": NEW, "distances_au": [350, 500], "mags_v": MAGS, "bodies_per_cell": 52,
        "seeds": {f"{k[0]}|{k[1]}": v for k, v in SEEDS.items()},
        "n_cells": len(used), "n_bodies": L["all"]["n_bodies"], "blocks_in_limit": [list(k) for k in complete], "left_out": left_out,
        "n_cells_on_disk": len(cells), "seconds_injected_searches": round(sum(r["seconds"] for _, r in used), 1),
        "n_linked": sum(r["n_linked"] for _, r in used), "other_links_fap_le_0.05": sum(int(r["n_false_records"]) for _, r in used),
        "distance_err_median_au": None if derr is None else round(derr, 2),
        "limits": {"inject10k": L, "before_1128": Lb, "pooled_all": Lpool},
        "bootstrap": {"inject10k": bootstrap(by_all), "before_1128": bootstrap(by_before)},
        # NOT in the plan (added after seeing the V 17.5 cells): the same crossing without the V 17.5 bin
        "not_in_plan_m50_m90_without_v17.5": [r2(x) for x in crossings({m: q for m, q in by_all.items() if m >= 18.0})],
        "curve": curve(by_all), "curve_before": curve(by_before), "density_check": dens, "coverage_masks_same_as_before": masks,
        "strips_in_limit": in_lim, "area_eff_deg2_350_by_strip": {k: a350[k] for k in in_lim},
        "area_eff_deg2_350": area, "band_deg2": band, "band_fraction_350": round(area / band, 6),
        "reach_m50_au": reach, "reach_m50_au_before": reach_b,
    }
    # one block of page text, EN and TR (numbers filled in here)
    A, B, BS = L["all"], Lb, res["bootstrap"]["inject10k"]
    nb, nbf = res["n_bodies"], B["n_bodies"]
    t = {}
    for lg in ("en", "tr"):
        tr = lg == "tr"
        v = {"n": fmt(nb, 0, tr), "nb": fmt(nbf, 0, tr), "m50": fmt(A["m50"], 2, tr), "m90": fmt(A["m90"], 2, tr),
             "b50": fmt(B["m50"], 2, tr), "b90": fmt(B["m90"], 2, tr), "area": fmt(area, 2, tr),
             "pct": fmt(100 * area / band, 3, tr), "lo50": fmt(BS["m50"]["p16"], 2, tr), "hi50": fmt(BS["m50"]["p84"], 2, tr),
             "lo90": fmt(BS["m90"]["p16"], 2, tr), "hi90": fmt(BS["m90"]["p84"], 2, tr),
             "dhi": fmt(reach["hi"]["au"], 0, tr), "dmid": fmt(reach["mid"]["au"], 0, tr), "dlo": fmt(reach["lo"]["au"], 0, tr),
             "cells": fmt(res["n_cells"], 0, tr)}
        dd = {q["v"]: q for q in dens}
        cur = res["curve"]
        bright = cur[0] if cur else None
        v.update(nstrips=fmt(len({k[0] for k in complete}), 0, tr),
                 vb=fmt(bright["v"], 1, tr) if bright else "-", fb=fmt(100 * bright["frac"], 0, tr) if bright else "-",
                 nr90=fmt(round(BS["m90"]["frac_not_reached"] * BS["n_resamples"]), 0, tr), nboot=fmt(BS["n_resamples"], 0, tr),
                 a185=fmt(100 * dd[18.5]["frac_52"], 0, tr) if 18.5 in dd else "-", b185=fmt(100 * dd[18.5]["frac_12"], 0, tr) if 18.5 in dd else "-",
                 a19=fmt(100 * dd[19.0]["frac_52"], 0, tr) if 19.0 in dd else "-", a194=fmt(100 * dd[19.4]["frac_52"], 0, tr) if 19.4 in dd else "-",
                 b19=fmt(100 * dd[19.0]["frac_12"], 0, tr) if 19.0 in dd else "-", b194=fmt(100 * dd[19.4]["frac_12"], 0, tr) if 19.4 in dd else "-")
        if tr:
            for kk in ("m50", "m90", "pct", "vb", "fb"):
                for case in ("dat", "abl", "poss", "loc"):
                    v[f"{kk}_{case}"] = tr_case(v[kk], case)
        has90 = A["m90"] is not None
        if lg == "en":
            t["en"] = {
                "h": "The limit with {n} test bodies",
                "tag": "Added after the run 2 pre-registration",
                "sub": ("Added after the run 2 pre-registration (1efa576), at Adem's request; plan {plan} pushed before the test ran. "
                        "Detection rules unchanged (distant-v3b). The same strips, the same body model, 52 bodies per run instead "
                        "of 12. The search result does not change: no candidate. Only the limit is measured with more bodies."),
                "line": ("Added after pre-registration: with {n} test bodies in the same {nstrips} strips, 50 % are found down to V {m50}"
                         + (" and 90 % down to V {m90}" if has90 else "; a 90 % point is not reached, because only {fb} % of the brightest test bodies (V {vb}) are found")
                         + " (the 1128 bodies before: V {b50} and {b90}). No body brighter than V {m50} between "
                         "350 and 500 AU in {area} deg² ({pct} % of the predicted band)."),
                "line_links": "Plan {plan}, result {res}.", "line_links_plan": "Plan {plan}.",
                "x": "visual magnitude V of the test body", "y": "found",
                "k_new": "{n} bodies (this test)", "k_old": "{nb} bodies (runs 1 and 2)", "k_lvl": "50 % and 90 %",
                "cap": ("Found fraction per magnitude, bars: 68 % range. 50 % point V {m50} (bootstrap 16-84 %: {lo50}-{hi50}); "
                        + ("90 % point V {m90} ({lo90}-{hi90}); " if has90 else "90 % point: not reached (V {vb}: {fb} % found; not reached in {nr90} of {nboot} bootstrap resamples either); ")
                        + "{cells} runs over {nstrips} strips at 350 and 500 AU. Found at V 18.5 / 19 / 19.4: {a185} / {a19} / {a194} % with 52 bodies per run, "
                        "{b185} / {b19} / {b194} % with 12 per run in the same strips (runs 1 and 2). A planet of 2.07 Earth radii "
                        "is as bright as V {m50} out to {dhi} AU if it reflects 75 %, {dmid} AU for 40 %, {dlo} AU for 20 %."),
            }
        else:
            t["tr"] = {
                "h": "{n} test cismiyle sınır",
                "tag": "2. aramanın ön kaydından sonra eklendi",
                "sub": ("2. aramanın ön kaydından (1efa576) sonra, Adem'in isteğiyle eklendi; plan {plan} test başlamadan önce "
                        "GitHub'a gönderildi. Bulma kuralları değişmedi (distant-v3b). Aynı şeritler, aynı cisim modeli; her "
                        "çalıştırmada 12 yerine 52 cisim. Arama sonucu değişmiyor: aday yok. Yalnızca sınır daha çok cisimle ölçülüyor."),
                "line": ("Ön kayıttan sonra eklendi: aynı {nstrips} şeritte {n} test cismiyle cisimlerin "
                         + ("%50'si V {m50_dat}, %90'ı V {m90_dat} kadar bulunuyor" if has90 else
                            "%50'si V {m50_dat} kadar bulunuyor; en parlak test cisimlerinin (V {vb}) yalnızca %{fb_poss} bulunduğu için %90 noktasına ulaşılmıyor")
                         + " (önceki 1128 cisimle: V {b50} ve {b90}). 350-500 AU arasında {area} deg²'de (öngörülen "
                         "kuşağın %{pct_poss}) V {m50_abl} parlak cisim yok."),
                "line_links": "Plan {plan}, sonuç {res}.", "line_links_plan": "Plan {plan}.",
                "x": "test cisminin görsel parlaklığı (V kadir)", "y": "bulunan",
                "k_new": "{n} cisim (bu test)", "k_old": "{nb} cisim (1. ve 2. arama)", "k_lvl": "%50 ve %90",
                "cap": ("Her parlaklıkta bulunan oran; çubuklar %68 aralığı. %50 noktası V {m50} (bootstrap %16-84: {lo50}-{hi50}); "
                        + ("%90 noktası V {m90} ({lo90}-{hi90}); " if has90 else "%90 noktasına ulaşılmıyor (V {vb_loc} bulunan: %{fb}; {nboot} bootstrap örneğinin {nr90} tanesinde de ulaşılmıyor); ")
                        + "{nstrips} şeritte, 350 ve 500 AU'da {cells} çalıştırma. V 18,5 / 19 / 19,4'te bulunan: çalıştırma başına 52 cisimle "
                        "%{a185} / %{a19} / %{a194}, aynı şeritlerde 12 cisimle (1. ve 2. arama) %{b185} / %{b19} / %{b194}. 2,07 Dünya "
                        "yarıçapında bir gezegen ışığın %75'ini yansıtıyorsa {dhi} AU'ya, %40'ını yansıtıyorsa {dmid} AU'ya, "
                        "%20'sini yansıtıyorsa {dlo} AU'ya kadar V {m50} kadar parlak görünür."),
            }
        for k, s in t[lg].items():
            for kk, vv in v.items():
                s = s.replace("{" + kk + "}", vv)
            t[lg][k] = s
    res["site_text"] = t
    res["links"] = links
    OUT.write_text(json.dumps(res, indent=1, ensure_ascii=False, default=float))
    print(json.dumps({k: res[k] for k in ("n_cells", "n_bodies", "left_out", "other_links_fap_le_0.05", "distance_err_median_au",
                                          "coverage_masks_same_as_before", "reach_m50_au", "reach_m50_au_before")}, indent=1))
    for k in ("inject10k", "before_1128", "pooled_all"):
        q = res["limits"][k]
        q = q.get("all", q)
        print(k, q["n_bodies"], "m50", q["m50"], "m90", q["m90"], q["found"])
    for k in ("by_distance", "old5", "new5"):
        print(k, json.dumps(L[k]) if k != "by_distance" else {d: (x["m50"], x["m90"]) for d, x in L[k].items()})
    print("by strip", {s: (x["m50"], x["m90"], x["n_bodies"]) for s, x in L["by_strip"].items()})
    print("bootstrap", json.dumps(res["bootstrap"]))
    print("density", json.dumps(dens))
    print("\n\n".join(md_tables(res).values()))
    if "--docs" in sys.argv:
        write_docs(res, sys.argv[sys.argv.index("--log") + 1] if "--log" in sys.argv else None)


def md_tables(res):
    """Markdown tables of pipeline/PLANETX_INJECT10K.md: {name: table text}."""
    L = res["limits"]["inject10k"]
    T = {}

    def row(name, q):
        f = ", ".join(f"{m}: {k}/{n}" for m, (k, n) in q["found"].items())
        return f"| {name} | {q['n_bodies']} | {f} | {q['m50']} | {q['m90'] if q['m90'] is not None else 'not reached'} |"
    t = ["| set | bodies | found / injected by V | 50 % | 90 % |", "|---|---|---|---|---|", row("this test, all", L["all"])]
    t += [row(f"this test, {d} AU", q) for d, q in L["by_distance"].items() if q["n_bodies"]]
    t += [row("this test, old 5 (F1-F5)", L["old5"]), row("this test, new 5 (R2)", L["new5"]),
          row("runs 1 + 2 (before)", res["limits"]["before_1128"]), row("this test + runs 1 + 2", res["limits"]["pooled_all"])]
    T["limits"] = "\n".join(t)
    t = ["| strip | bodies | 50 % | 90 % | found at V 17.5 / 18 / 18.5 / 19 / 19.4 / 19.7 / 20 |", "|---|---|---|---|---|"]
    for st, q in L["by_strip"].items():
        if not q["n_bodies"]:
            continue
        fz = " / ".join(f"{q['found'].get(m, [0, 0])[0]}/{q['found'].get(m, [0, 0])[1]}" for m in ("17.5", "18", "18.5", "19", "19.4", "19.7", "20"))
        t.append(f"| {st} | {q['n_bodies']} | {q['m50']} | {q['m90'] if q['m90'] is not None else 'not reached'} | {fz} |")
    T["strips"] = "\n".join(t)
    t = ["| V | 52 per run: found | 12 per run (runs 1-2): found | z |", "|---|---|---|---|"]
    for q in res["density_check"]:
        t.append(f"| {q['v']:g} | {q['found_52'][0]}/{q['found_52'][1]} ({100 * q['frac_52']:.0f} %) | "
                 f"{q['found_12'][0]}/{q['found_12'][1]} ({100 * q['frac_12']:.0f} %) | {q['z']} |")
    T["density"] = "\n".join(t)
    t = ["| bodies | 50 % point: 16 / 50 / 84 % of resamples | 90 % point: 16 / 50 / 84 % | 90 % not reached in |", "|---|---|---|---|"]
    for k, b in res["bootstrap"].items():
        n = res["n_bodies"] if k == "inject10k" else res["limits"]["before_1128"]["n_bodies"]
        t.append(f"| {n} ({'this test' if k == 'inject10k' else 'runs 1 + 2'}) | {b['m50']['p16']} / {b['m50']['p50']} / {b['m50']['p84']} | "
                 f"{b['m90']['p16']} / {b['m90']['p50']} / {b['m90']['p84']} | {100 * b['m90']['frac_not_reached']:.1f} % |")
    T["bootstrap"] = "\n".join(t)
    return T



def run_log(path):
    """Times from the run log (ajan_durumu/e2_inject10k/run_10k.log): first start, heat pauses, stop."""
    import datetime as dt
    out = {"first_start": None, "pauses": 0, "paused_s": 0, "stop_line": None, "driver_swap": None, "pinned": None}
    if not path or not Path(path).exists():
        return out
    t_p = None
    for ln in Path(path).read_text().splitlines():
        try:
            t = dt.datetime.strptime(ln[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        rest = ln[20:]
        if rest.startswith("START") and out["first_start"] is None:
            out["first_start"] = ln[11:19]
        elif rest.startswith("PAUSED"):
            out["pauses"] += 1
            t_p = t
        elif rest.startswith("RESUMED") and t_p is not None:
            out["paused_s"] += (t - t_p).total_seconds()
            t_p = None
        elif rest.startswith("v1 driver stopped") and out["driver_swap"] is None:
            out["driver_swap"] = ln[11:19]
        elif rest.startswith("pinned driver"):
            out["pinned"] = ln[11:19]
        elif rest.startswith("STOP TIME"):
            out["stop_line"] = ln[11:19]
    return out


def write_docs(res, log):
    """pipeline/PLANETX_INJECT10K.md and the section of pipeline/PLANETX.md between the inject10k markers."""
    import datetime as dt
    L, B, BS, BB = res["limits"]["inject10k"], res["limits"]["before_1128"], res["bootstrap"]["inject10k"], res["bootstrap"]["before_1128"]
    A = L["all"]
    T = md_tables(res)
    files = sorted(INJ.glob("inj_*.json"))
    last = dt.datetime.fromtimestamp(max(f.stat().st_mtime for f in files)).strftime("%H:%M:%S") if files else "-"
    nblk, nstr = len(res["blocks_in_limit"]), len(res["strips_in_limit"])
    d500 = sorted(k[0] for k in res["blocks_in_limit"] if k[1] == 500)
    rc = {k: v["au"] for k, v in res["reach_m50_au"].items()}
    rb = res["reach_m50_au_before"]
    cur = {q["v"]: q for q in res["curve"]}
    c175, c18 = cur.get(17.5), cur.get(18.0)
    nip = res["not_in_plan_m50_m90_without_v17.5"]
    if A["m90"] is not None:
        s90 = f"90 % down to **V {A['m90']}** (bootstrap 16-84 %: {BS['m90']['p16']}-{BS['m90']['p84']})"
    else:
        s90 = (f"a 90 % point is **not reached**: at the brightest V tested, 17.5, {c175['found']} of {c175['n']} are found "
               f"({100 * c175['frac']:.0f} %; V 18: {100 * c18['frac']:.0f} %), and the registered crossing makes the found fraction "
               f"non-increasing from the bright side (90 % not reached in {100 * BS['m90']['frac_not_reached']:.0f} % of the bootstrap resamples)")
    w_now = BS["m50"]["p84"] - BS["m50"]["p16"]
    dens = {q["v"]: q for q in res["density_check"]}
    shift_txt = ""
    if A["m50"] is not None and B["m50"] is not None:
        shift_txt = f"Against the 1128 bodies the 50 % point moves by {A['m50'] - B['m50']:+.2f} mag"
        shift_txt += (f" and the 90 % point by {A['m90'] - B['m90']:+.2f} mag." if A["m90"] is not None and B["m90"] is not None else ".")
        if 18.5 in dens:
            q = dens[18.5]
            shift_txt += (f" In the density check (below) the 52-body runs find {100 * q['frac_52']:.0f} % at V 18.5 against "
                          f"{100 * q['frac_12']:.0f} % for the 12-body runs in the same strips (z {q['z']}): part of the shift of the "
                          f"90 % point may come from the denser test (not separated here).")
    bright_txt = " / ".join(f"{cur[m]['found']}/{cur[m]['n']} ({100 * cur[m]['frac']:.0f} %)" for m in (17.5, 18.0, 18.5) if m in cur)
    cb = {q["v"]: q for q in res["curve_before"]}
    b185 = f"{cb[18.5]['found']}/{cb[18.5]['n']} ({100 * cb[18.5]['frac']:.0f} %)" if 18.5 in cb else "-"
    w_bef = BB["m50"]["p84"] - BB["m50"]["p16"]
    ok_masks = [k for k, v in res["coverage_masks_same_as_before"].items() if v]
    left = [f"{q['strip']} {q['d_au']} AU ({q['cells_done']} of 10 cells)" for q in res["left_out"]]
    R = run_log(log)
    dens_txt = "; ".join(f"V {v:g}: {100 * q['frac_52']:.0f} % against {100 * q['frac_12']:.0f} % (z {q['z']})" for v, q in dens.items())
    md = f"""# Planet X: {res['n_bodies']:,}-body injection test (result)

**Added after the run 2 pre-registration (1efa576), at Adem's request. Detection rules unchanged.**

Plan: `pipeline/PLANETX_INJECT10K_PLAN.md`, commit 152e9ba, pushed to GitHub 2026-11-15 11:07:12 +03 (push event), before the
first test body was injected (first run started {R['first_start']}, run log). Amendment 36ed43d (pushed 12:09:42, approved by
Adem): run until all 20 blocks are done instead of stopping at 15:30; nothing else changed. Rules: distant-v3b (md5 14dd135e1ec5f00771fcf26784a40f92),
`pipeline/find_distant.py` and `pipeline/find_distant_run2.py` unchanged (the hashes in the plan). Numbers:
`site/data/planetx/inject10k.json`, made by `pipeline/planetx_inject10k_summary.py` (this file and the PLANETX.md section too).
The search results of runs 1 and 2 do not change (no candidate): this test only measures the completeness again, with more bodies.

## Answer

{res['n_bodies']:,} test bodies ({res['n_cells']} runs of 52) in {nblk} complete blocks over {nstr} strips: 50 % are found down to
**V {A['m50']}** (bootstrap 16-84 %: {BS['m50']['p16']}-{BS['m50']['p84']}); {s90}.
The 1128 bodies of runs 1 and 2 gave V {B['m50']} (16-84 %: {BB['m50']['p16']}-{BB['m50']['p84']}) and V {B['m90']}.
Bright end: found at V 17.5 / 18 / 18.5: {bright_txt} (1128 bodies, V 18.5: {b185}).
**New upper limit: no body brighter than V {A['m50']} (50 % completeness) between 350 and 500 AU in {res['area_eff_deg2_350']} deg^2**
({100 * res['band_fraction_350']:.3f} % of the predicted band, {res['band_deg2']:.0f} deg^2). A planet of 2.07 Earth radii is that bright out to
{rc['hi']} AU if it reflects 75 %, {rc['mid']} AU for 40 %, {rc['lo']} AU for 20 % (with V {B['m50']}: {rb['hi']} / {rb['mid']} / {rb['lo']} AU).
The 16-84 % range of the 50 % point is {w_now:.2f} mag wide (1128 bodies: {w_bef:.2f} mag).
{shift_txt}
It says nothing about the rest of the band.

## How it ran (+03, 15 Nov 2026)

| step | time | source |
|---|---|---|
| plan pushed | 11:07:12 | GitHub push event of 152e9ba |
| first run started | {R['first_start']} | run log |
| watcher changed (see deviations) | {R['driver_swap'] or '-'} | run log |
| plan amendment pushed: run until all 20 blocks are done (Adem's approval; old stop 15:30) | 12:09:42 | GitHub push event of 36ed43d |
| runs pinned to cores 12-17 (see deviations) | {R['pinned'] or '-'} | run log |
| last result file written | {last} | file times |
| stopped early | {R['stop_line'] or 'no'} | run log |

Heat pauses: {R['pauses']} ({R['paused_s'] / 60:.0f} min in all; package temperature, median of 5 readings, >= 90 C). Other heavy jobs (one or
two processes) ran on the machine at the same time for most of the run. {res['seconds_injected_searches'] / 3600:.2f} h of injected searches
in the blocks of the limit (cell times, without strip loading and pauses).

## Completeness

{T['limits']}

Linked at all: {res['n_linked']} of {res['n_bodies']}. Median distance error of a found body: {res['distance_err_median_au']} AU.
Links in the injected runs that are not an injected body (false-link probability <= 0.05): {res['other_links_fap_le_0.05']}
(not examined one by one; 52 test bodies share one strip, and no candidate list depends on them). 500 AU blocks in the limit: {('all ' + str(len(d500)) + ' strips') if len(d500) == len(ORDER) else (', '.join(d500) or 'none')}.

Per strip:

{T['strips']}

Uncertainty (bootstrap of the bodies within each V, {BS['n_resamples']} resamples, seed {BS['seed']}):

{T['bootstrap']}

Not in the plan (written after the V 17.5 runs were seen): without the V 17.5 bin the same crossing gives 50 % at V {nip[0]} and
90 % at V {nip[1] if nip[1] is not None else 'not reached'}. Only the planned numbers above are the result.

## Density check (as planned; nothing corrected)

The found fraction of the 52-body runs against the 12-body runs of runs 1 and 2 in the same strips and at the same distance
(the blocks of the limit, pooled; at V 20 the 12-body side has the run-2 strips and F4 only):

{T['density']}

## Coverage

The coverage masks written by this test are identical to those of runs 1 and 2 in {len(ok_masks)} of {len(res['coverage_masks_same_as_before'])}
strips ({', '.join(k for k, v in res['coverage_masks_same_as_before'].items() if v is False) or 'no difference'}); the area is the run-1 / run-2 effective area
at 350 AU of the strips in the limit: {res['area_eff_deg2_350']} deg^2.

## Deviations from the plan and what is not done

- Not done: {'; '.join(left) if left else 'nothing (all 20 blocks)'}{' (plan rule: only complete blocks count)' if left else ''}.
- Stop condition: 15:30 in the plan; changed by the amendment 36ed43d (pushed 12:09:42, before 15:30, approved by Adem) to
  "all 20 blocks". The driver was restarted for it at 12:09:57 without stopping the running block.
- The load watcher: the plan said one reading every 30 s. The package temperature jumps between ~50 and ~97 C within seconds,
  so from {R['driver_swap'] or '-'} the watcher reads the median of 5 readings (1 s apart) every ~20 s; pause at >= 90 C, resume
  below 85 C. The runs themselves, cells, seeds and order are as planned.
- From {R['pinned'] or '-'} the run was pinned to the efficiency cores 12-17 (against the heat spikes, at the coordinator's request);
  this changes the speed, not the result.
- Time per run: ~{res['seconds_injected_searches'] / max(res['n_cells'], 1):.0f} s on average (plan estimate 42 s, from the timing cell
  run alone on the machine).
- Bright end: why {100 - 100 * c175['frac']:.0f} % of the brightest bodies (V 17.5) are missed was not examined here (in run 1 the
  static-source and ghost vetoes next to stars were the measured cause in one strip; `pipeline/PLANETX.md`).
- All caveats of `pipeline/PLANETX.md` hold (grey reflector, static-source and ghost vetoes next to stars, three seasons only).

## Commands

```
U="nice -n 15 uv run --no-project --with astropy --with reproject --with numpy --with scipy --with pillow python -I"
$U pipeline/find_distant_run2.py inject --field R2-nu+170 --dists 350 --mags 17.5,18,18.5,18.75,19,19.2,19.4,19.55,19.7,20 \\
   --nbody 52 --seed 101 --orbits p9 --sed solar --n-rand 1000 --threads 2 --out cache/planetx/injections_10k
$U pipeline/find_distant.py inject --field F1-aphelion --dists 350 ... --seed 102 ...      # old strips: find_distant.py
# (strip order and seeds: the plan; driver scripts ajan_durumu/e2_inject10k/run_10k.sh, _v2.sh, _v3.sh, outside the repository)
$U pipeline/planetx_inject10k_summary.py <run-1 injection folder> --links links.json --log run_10k.log --docs
```
"""
    (FD.REPO / "pipeline" / "PLANETX_INJECT10K.md").write_text(md)
    # the short section of PLANETX.md
    sec = f"""<!-- inject10k: written by pipeline/planetx_inject10k_summary.py -->
## {res['n_bodies']:,}-body injection test (15 Nov 2026, added after the run 2 pre-registration)

Added after the run 2 pre-registration (1efa576), at Adem's request. Detection rules unchanged. Plan
`pipeline/PLANETX_INJECT10K_PLAN.md` (pushed 11:07:12 +03, before the test ran; amendment 36ed43d at 12:09: run until all
20 blocks are done); result `pipeline/PLANETX_INJECT10K.md`.
- The same strips (F1-F5, R2 x 5), the same body model, 52 bodies per run, V 17.5-20 in 10 steps, 350 / 500 AU:
  {res['n_bodies']:,} bodies in {nblk} complete blocks ({nstr} strips). The candidate lists do not change.
- 50 % found down to **V {A['m50']}** (16-84 %: {BS['m50']['p16']}-{BS['m50']['p84']}; 1128 bodies: V {B['m50']}); 90 %: {('V ' + str(A['m90'])) if A['m90'] is not None else f"not reached (V 17.5: {100 * c175['frac']:.0f} % found)"} (1128 bodies: V {B['m90']}).
- **No body brighter than V {A['m50']} between 350 and 500 AU in {res['area_eff_deg2_350']} deg^2** ({100 * res['band_fraction_350']:.3f} % of the band).
- Density check: 52 bodies per run against 12 per run, found at {dens_txt}.
<!-- /inject10k -->
"""
    px = FD.REPO / "pipeline" / "PLANETX.md"
    txt = px.read_text()
    a, b = "<!-- inject10k: written by pipeline/planetx_inject10k_summary.py -->", "<!-- /inject10k -->\n"
    if a in txt:
        txt = txt[:txt.index(a)] + sec + txt[txt.index(b) + len(b):]
    else:
        k = txt.index("## Measured, assumed, not verified")
        txt = txt[:k] + sec + "\n" + txt[k:]
    px.write_text(txt)

if __name__ == "__main__":
    main()
