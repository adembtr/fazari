#!/usr/bin/env python3
"""Date-shuffle null test of the astrometric movers (detectors B and D).

  uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib \
      --with pillow python -I pipeline/detect/tests/shuffle.py --out /tmp/shuf --n 100 eps_indi_b barnard ...

Every source of the field (Gaia DR3 stars and deep-stack sources, as the finder uses them) is
measured once in every exposure (astrometry.measure_seasons, one pass, at the predicted
positions). Then the exposures' season labels and dates are shuffled:
  exposure shuffle   the (season, date) labels are randomly permuted over the exposures N times:
                     every pseudo-season mixes exposures of all real seasons, so no real motion
                     survives; whatever passes the mover criteria is a fake mover.
  season permutation whole seasons swap their dates (all permutations except the identity and
                     the time reversal, which keep straight-line motion): season-coherent
                     systematics stay, real motion becomes a zig-zag.
For each shuffle the mover criteria of detectors B and D are applied (drift >= 5 sigma; for
Gaia stars the drift relative to the Gaia motion; detector halves agree; straight line; no
blend; outside saturated-star wings; same-orientation confirmation; for Gaia stars the offset
from the Gaia position must match the drift). The real labels are run through the same code as
a reference. Writes <out>/shuffle_<field>.json and prints fake movers per shuffle.
Detector A (difference images) is not part of this test (it needs new stacks per shuffle); its
false alarms are measured on the null fields (tests/blind.py).
"""
import argparse
import itertools
import json
import math
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))

import numpy as np                                   # noqa: E402

from detect import astrometry as AS                  # noqa: E402
from detect import data as Dt                        # noqa: E402
from detect import deep_astrom as DA                 # noqa: E402
from detect import gaia_astrom as GA                 # noqa: E402
from detect import reject as RJ                      # noqa: E402
from detect import run as R                          # noqa: E402
from detect import schema as SC                      # noqa: E402

SIG = 5.0


def field_of(name, out):
    if name.startswith("job:"):
        return Dt.job_field(name[4:], out_dir=out / name.replace(":", "_"))
    f = Dt.challenge_field(name)
    f.out_dir = out / name
    return f


def movers(ctx, A, T, exps, src, ng, floor, gt):
    """Indices of sources passing the B / D mover criteria for this season table, and the
    number with a drift >= SIG before the checks."""
    # v1.1 (algorithm agent, with the coordinator's permission; the only change in this file): the
    # finder's own complete decision is applied, so the test measures the rule that is shipped.
    # The v0 re-implementation below is kept for reference and is no longer reached.
    return DA.null_movers(ctx, exps, A, T, src, ng, floor)
    hits, raw = [], 0
    snr_max = np.nanmax(np.where(np.isfinite(T["snr"]), T["snr"], -1), 0)
    cosd = math.cos(math.radians(ctx.field.dec))
    for j in range(src.n):
        gaia = j < ng
        f = AS.fit_drift(T, j, floor=floor, min_n=GA.MIN_SEASON_N) if gaia else \
            AS.fit_drift(T, j, floor=floor, fit_plx=True, ra=src.ra0[j], dec=src.dec0[j])
        if f is None or f["sig_motion"] < SIG:
            continue
        raw += 1
        _, agree = AS.group_agreement(exps, A, ctx.seasons, j, f, floor)
        if not agree:
            continue
        if f["p_linear"] is not None and f["p_linear"] < 1e-3:
            continue
        if gaia:
            if GA._brighter_neighbour(gt, j, 8.0):
                continue
            if RJ.in_sat_zone(ctx, src.ra0[j], src.dec0[j], allow_core=True)[0]:
                continue
            dt_g = 2026.0 - GA.GAIA_EPOCH
            res = math.hypot(f["aE"] - f["bE"] * dt_g, f["aN"] - f["bN"] * dt_g)
            tol = max(1.0, 3 * math.hypot(0.1, dt_g * math.hypot(f["ebE"], f["ebN"]) / math.sqrt(2)))
            if res > tol:
                continue
        else:
            dd = np.hypot((src.ra0 - src.ra0[j]) * cosd, src.dec0 - src.dec0[j]) * 3600
            if ((dd > 0.5) & (dd < DA.BLEND_ARCSEC) & (snr_max > snr_max[j])).any():
                continue
            if RJ.in_sat_zone(ctx, src.ra0[j], src.dec0[j])[0]:
                continue
        ok, _ = AS.orientation_check(T, j, f, floor, min_n=GA.MIN_SEASON_N)
        if not ok:
            continue
        hits.append({"j": j, "gaia": gaia, "ra": round(float(src.ra0[j]), 6), "dec": round(float(src.dec0[j]), 6),
                     "drift_mas_yr": [round(1000 * f["bE"], 1), round(1000 * f["bN"], 1)],
                     "sigma": round(f["sig_motion"], 1)})
    return hits, raw


def run_field(name, a, out):
    t0 = time.time()
    field = field_of(name, out)
    exps, gt, cal, summ = R.prepare(field, log=lambda *x: None)
    ctx = R.Ctx(field, exps, gt, cal, summ, log=lambda *x: None)
    src, ng = DA.field_sources(ctx)
    fast = np.hypot(src.pmra, src.pmdec) > DA.SAT_PM_MIN
    A, T0 = AS.measure_seasons(exps, src, cal, ctx.seasons, sat_path=fast, nb=AS.bright_neighbours(gt), iters=1)
    ref = [j for j in range(ng) if gt is not None and gt.reference()[j]] if ng else \
        [j for j in range(src.n) if np.nanmax(T0["snr"][:, j]) > 50]
    floor, _ = AS.estimate_season_floor(T0, ref)
    seasons = ctx.seasons
    real_hits, real_raw = movers(ctx, A, T0, exps, src, ng, floor, gt)
    rng = np.random.default_rng(a.seed)
    shuffles = []
    labels = [(e["epoch"], e["jyear"]) for e in exps]
    for k in range(a.n):
        perm = rng.permutation(len(exps))
        sh = [dict(e, epoch=labels[perm[i]][0], jyear=labels[perm[i]][1]) for i, e in enumerate(exps)]
        T = AS.season_table(sh, A, seasons)
        hits, raw = movers(ctx, A, T, sh, src, ng, floor, gt)
        shuffles.append({"n_movers": len(hits), "n_drift_5sigma": raw, "movers": hits})
    # whole-season permutations (not identity, not time reversal)
    tmean = {s: float(np.mean([e["jyear"] for e in exps if e["epoch"] == s])) for s in seasons}
    perms = []
    for p in itertools.permutations(range(len(seasons))):
        if list(p) == list(range(len(seasons))) or list(p) == list(range(len(seasons)))[::-1]:
            continue
        mp = {seasons[i]: seasons[p[i]] for i in range(len(seasons))}
        sh = [dict(e, epoch=mp[e["epoch"]], jyear=e["jyear"] - tmean[e["epoch"]] + tmean[mp[e["epoch"]]]) for e in exps]
        T = AS.season_table(sh, A, seasons)
        hits, raw = movers(ctx, A, T, sh, src, ng, floor, gt)
        perms.append({"permutation": [mp[s] for s in seasons], "n_movers": len(hits), "n_drift_5sigma": raw,
                      "movers": hits})
    n_m = [s["n_movers"] for s in shuffles]
    doc = {"field": name, "n_exposures": len(exps), "seasons": seasons, "n_sources": int(src.n), "n_gaia": int(ng),
           "season_floor_arcsec": round(floor, 4), "n_shuffles": a.n, "seed": a.seed,
           "real_labels": {"n_movers": len(real_hits), "n_drift_5sigma": real_raw, "movers": real_hits},
           "exposure_shuffle": {"fake_movers_total": int(sum(n_m)), "fake_movers_per_shuffle_mean": round(float(np.mean(n_m)), 3),
                                "max_in_one_shuffle": int(max(n_m)) if n_m else 0,
                                "shuffles_with_any": int(sum(1 for x in n_m if x)),
                                "drift_5sigma_per_shuffle_mean": round(float(np.mean([s["n_drift_5sigma"] for s in shuffles])), 2),
                                "shuffles": shuffles},
           "season_permutations": perms, "seconds": round(time.time() - t0, 1)}
    dest = out / f"shuffle_{name.replace('job:', 'job_')[:40]}.json"
    dest.with_suffix(".part").write_text(json.dumps(SC._clean(doc), indent=1))
    dest.with_suffix(".part").replace(dest)
    es = doc["exposure_shuffle"]
    print(f"{name}: real {len(real_hits)} movers ({real_raw} at >= 5 sigma before checks); {a.n} exposure shuffles: "
          f"{es['fake_movers_total']} fake movers in total (max {es['max_in_one_shuffle']} in one, "
          f"{es['shuffles_with_any']} shuffles with any; {es['drift_5sigma_per_shuffle_mean']} drifts >= 5 sigma per shuffle "
          f"before checks); season permutations: {[p['n_movers'] for p in perms]}  ({doc['seconds']} s)", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fields", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name in a.fields:
        dest = out / f"shuffle_{name.replace('job:', 'job_')[:40]}.json"
        try:
            json.loads(dest.read_text())
            print(f"{name}: done before, skipped", flush=True)
            continue
        except (OSError, ValueError):
            pass
        run_field(name, a, out)


if __name__ == "__main__":
    main()
