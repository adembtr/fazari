#!/usr/bin/env python3
"""Injection test: synthetic moving and changing point sources in the real cutouts of a field.

  uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib \
      --with pillow python -I pipeline/detect/tests/injection.py --field eps_indi_b --mag 16 \
      --out /tmp/inj --seed 1

One run = one AB magnitude: N_MOVE moving sources (speeds SPEEDS, random position angles) and
N_VAR static sources whose flux changes between seasons (fractions FRACS, plus appearing and
disappearing ones), placed at random positions >= SPACING apart and >= EDGE from the stack edge.
The full finder (A, B, D, V) runs on the injected exposures (registration of the original
field). Every injected source is then matched to the candidates and, when missed, given a
reason from an oracle measurement at its true position (season S/N, achievable motion error),
its environment (brighter source within 8", saturated-star zone) and any rejected record.
Writes <out>/inj_<field>_m<mag>_s<seed>.json.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))           # pipeline/

import numpy as np                                  # noqa: E402

from detect import astrometry as AS                 # noqa: E402
from detect import data as Dt                       # noqa: E402
from detect import inject as INJ                    # noqa: E402
from detect import reject as RJ                     # noqa: E402
from detect import run as R                         # noqa: E402
from detect import schema as SC                     # noqa: E402
from detect import diffimg, gaia_astrom, deep_astrom, variab   # noqa: E402

SPEEDS = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 40.0]     # arcsec/yr
N_PER_SPEED = 4
FRACS = [0.03, 0.05, 0.1, 0.2, 0.5, 1.0]                            # flux change, later seasons
N_PER_FRAC = 2
N_APPEAR = 2
SPACING = 45.0
EDGE = 45.0


def field_of(name):
    if name.startswith("job:"):
        return Dt.job_field(name[4:], out_dir="/nonexistent")
    return Dt.challenge_field(name)


def place(ctx, n, rng, avoid_sat=10.0):
    g = ctx.grid
    half = g.n * g.pix / 2 - EDGE
    pts = []
    tries = 0
    zones = RJ.sat_zones(ctx)
    while len(pts) < n and tries < 20000:
        tries += 1
        e, nn = rng.uniform(-half, half, 2)
        if any(math.hypot(e - a, nn - b) < SPACING for a, b in pts):
            continue
        ra = g.ra + e / 3600 / math.cos(math.radians(g.dec))
        de = g.dec + nn / 3600
        if any(SC.sep_arcsec(z[0], z[1], ra, de) < z[2] + avoid_sat for z in zones):
            continue
        pts.append((e, nn))
    return [(g.ra + e / 3600 / math.cos(math.radians(g.dec)), g.dec + nn / 3600) for e, nn in pts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", required=True)
    ap.add_argument("--mags", required=True, help="comma list of AB magnitudes")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    field = field_of(a.field)
    prepared = None
    for mag in [float(m) for m in a.mags.split(",")]:
        done = Path(a.out) / f"inj_{a.field.replace('job:', 'job_')[:40]}_m{mag:g}_s{a.seed}.json"
        try:
            json.loads(done.read_text())
            print(f"{a.field} m={mag}: done before ({done.name}), skipped", flush=True)
            continue
        except (OSError, ValueError):
            pass
        prepared = prepared or R.prepare(field, log=lambda *x: None)
        one(a, field, prepared, mag)


def one(a, field, prepared, mag):
    t0 = time.time()
    a.mag = mag
    rng = np.random.default_rng(a.seed * 1000 + int(a.mag * 10))
    exps, gt, cal, summ = prepared
    base = R.Ctx(field, exps, gt, cal, summ, log=lambda *x: None)
    seasons = base.seasons
    flux = INJ.ab_to_ujy(a.mag)
    nmove = len(SPEEDS) * N_PER_SPEED
    nvar = len(FRACS) * N_PER_FRAC + 2 * N_APPEAR
    pos = place(base, nmove + nvar, rng)
    srcs = []
    k = 0
    for v in SPEEDS:
        for _ in range(N_PER_SPEED):
            if k >= len(pos):
                break
            pa = rng.uniform(0, 360)
            srcs.append(dict(kind="motion", ra=pos[k][0], dec=pos[k][1], speed=v, pa=pa,
                             pmra=1000 * v * math.sin(math.radians(pa)), pmdec=1000 * v * math.cos(math.radians(pa)),
                             flux_ujy=flux))
            k += 1
    later = seasons[len(seasons) // 2:]
    for fr in FRACS:
        for _ in range(N_PER_FRAC):
            if k >= len(pos):
                break
            sf = {s: (1.0 + fr if s in later else 1.0) for s in seasons}
            srcs.append(dict(kind="variable", ra=pos[k][0], dec=pos[k][1], frac=fr, pmra=0.0, pmdec=0.0,
                             flux_ujy=flux, season_factor=sf))
            k += 1
    for kind in ("appearing", "disappearing"):
        for _ in range(N_APPEAR):
            if k >= len(pos):
                break
            sf = {s: ((1.0 if s in later else 0.0) if kind == "appearing" else (0.0 if s in later else 1.0)) for s in seasons}
            srcs.append(dict(kind=kind, ra=pos[k][0], dec=pos[k][1], pmra=0.0, pmdec=0.0, flux_ujy=flux, season_factor=sf))
            k += 1
    inj = INJ.inject(exps, srcs, cal, seed=a.seed)
    cands, ctx = R.find(field, detectors=[diffimg, gaia_astrom, deep_astrom, variab], prepared=(inj, gt, cal, summ),
                        log=lambda *x: None, opts={"no_sso": True})
    # oracle measurement of the injected movers at their true track
    mv = [s for s in srcs if s["kind"] == "motion"]
    osrc = AS.Sources([s["ra"] for s in mv], [s["dec"] for s in mv], 2026.0, [s["pmra"] for s in mv],
                      [s["pmdec"] for s in mv], None)
    _, OT = AS.measure_seasons(inj, osrc, cal, seasons, sat_path=False)
    floor = ctx.season_floor or AS.SEASON_FLOOR
    allsrc = deep_astrom.field_sources(base)[0]
    results = []
    for s in srcs:
        r = dict(s)
        r.pop("season_factor", None)
        near = [c for c in cands if SC.sep_arcsec(c["ra"], c["dec"], s["ra"], s["dec"]) < 5.0]
        # environment
        cosd = math.cos(math.radians(s["dec"]))
        dd = np.hypot((allsrc.ra0 - s["ra"]) * cosd, allsrc.dec0 - s["dec"]) * 3600 if allsrc.n else np.array([])
        r["nearest_source_arcsec"] = round(float(dd.min()), 1) if len(dd) else None
        r["in_sat_zone"] = bool(RJ.in_sat_zone(ctx, s["ra"], s["dec"])[0])
        if s["kind"] == "motion":
            j = mv.index(s)
            fo = AS.fit_drift(OT, j, floor=floor, min_snr=0)
            r["oracle_season_snr"] = round(float(np.nanmedian(OT["snr"][:, j])), 1)
            r["oracle_n_exposures"] = int(np.nansum(OT["n"][:, j]))
            r["oracle_pm_err_mas_yr"] = round(1000 * math.hypot(fo["ebE"], fo["ebN"]) / math.sqrt(2), 1) if fo else None
            hit = None
            for c in near:
                m = c.get("motion")
                if c["kind"] != "motion" or not m or c["class"] in ("artifact",):
                    continue
                dv = math.hypot(m["pmra_mas_yr"] - s["pmra"], m["pmdec_mas_yr"] - s["pmdec"]) / 1000
                tol = max(3 * math.hypot(m["err_pmra_mas_yr"], m["err_pmdec_mas_yr"]) / 1000, 0.25 * s["speed"], 0.02)
                if dv < tol and (m["significance_sigma"] or 0) >= 5:
                    hit = c
                    break
            r["recovered"] = hit is not None
            if hit:
                m = hit["motion"]
                r.update(found_by=hit["detectors"], class_=hit["class"], meas_speed=m["speed_arcsec_yr"],
                         meas_pa=m["pa_deg"], meas_err=m["err_speed_arcsec_yr"], sig=m["significance_sigma"])
        else:
            hit = None
            for c in near:
                if c["class"] == "artifact":
                    continue
                if (s["kind"] == "variable" and c["kind"] == "variable") or \
                        (s["kind"] in ("appearing", "disappearing") and c["kind"] in ("appearing", "disappearing", "variable")):
                    hit = c
                    break
            r["recovered"] = hit is not None
            if hit:
                r.update(found_by=hit["detectors"], class_=hit["class"],
                         meas_frac=(hit.get("brightness") or {}).get("max_change_frac"))
        if not r["recovered"]:
            reasons = []
            if r["in_sat_zone"]:
                reasons.append("saturated-star zone")
            if r["nearest_source_arcsec"] is not None and r["nearest_source_arcsec"] < 8:
                reasons.append("blended (source within 8\")")
            if s["kind"] == "motion" and r.get("oracle_n_exposures") == 0:
                reasons.append("outside the exposures (no data at its position)")
            elif s["kind"] == "motion":
                if (r.get("oracle_season_snr") or 0) < 10:
                    reasons.append("too faint (season S/N < 10)")
                elif r.get("oracle_pm_err_mas_yr") and 1000 * s["speed"] < 5 * r["oracle_pm_err_mas_yr"]:
                    reasons.append("too slow (< 5 x achievable motion error)")
            rej = [c for c in near if c["class"] == "artifact"]
            if rej:
                reasons.append("rejected: " + "; ".join(rej[0]["flags"][:2]))
            if not reasons:
                reasons.append("not detected")
            r["miss_reasons"] = reasons
        results.append(r)
    # false candidates: non-artifact, not gaia-known, not matched to an injected source
    used = set()
    for s in srcs:
        for c in cands:
            if SC.sep_arcsec(c["ra"], c["dec"], s["ra"], s["dec"]) < 6.0:
                used.add(c["id"])
    false = [{"id": c["id"], "class": c["class"], "kind": c["kind"], "detectors": c["detectors"], "ra": c["ra"], "dec": c["dec"],
              "flags": c["flags"][:3]} for c in cands
             if c["class"] in ("candidate", "variable") and c["id"] not in used]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    doc = {"field": a.field, "mag_ab": a.mag, "flux_ujy": round(flux, 2), "seed": a.seed, "seasons": seasons,
           "n_exposures": len(exps), "season_floor_arcsec": floor, "sources": results, "false_candidates": false,
           "seconds": round(time.time() - t0, 1)}
    name = a.field.replace("job:", "job_")[:40]
    dest = out / f"inj_{name}_m{a.mag:g}_s{a.seed}.json"
    tmp = dest.with_suffix(".part")
    tmp.write_text(json.dumps(SC._clean(doc), indent=1))
    tmp.replace(dest)                    # complete files only: a restart skips them
    rec = [r for r in results if r["kind"] == "motion"]
    print(f"{a.field} m={a.mag}: motion {sum(r['recovered'] for r in rec)}/{len(rec)}, "
          f"brightness {sum(r['recovered'] for r in results if r['kind'] != 'motion')}/{len(results) - len(rec)}, "
          f"false {len(false)}  ({time.time() - t0:.0f} s)", flush=True)


if __name__ == "__main__":
    main()
