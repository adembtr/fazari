# Planet X, run 2: pre-registration

Written 2026-11-15 10:04 +03, before any pixel of the strips below was read. This file is committed and pushed on its own;
the GitHub commit time is the third-party time stamp. Results go to `pipeline/PLANETX_RUN2.md` in a later commit.
Run 1 (5 strips + 1 follow-up strip, 2.08 deg^2, no candidate): `pipeline/PLANETX.md`.

## What was done before this file

- Strip plan from the static sky index only (exposure lists, no pixels): `pipeline/find_distant_run2.py plan`
  -> `cache/planetx/plan_run2.json` (made 2026-11-15 10:01:11 +03; hash below). The plan file is copied into the
  repository with the results; it must match the hash below.
- A timing test of the search with 2 threads on run-1 data already on disk (F2-ra45, read on 14 Nov): 38 s, the run-1
  result again (1 link, 0 candidates, 0.1035 chance links per shuffled strip). No new bytes.
- Throughput from the run-1 ledger: 166-226 strips (150-210 MB) per field in 46-88 s; search 40-80 s per strip;
  one injected cell (12 bodies) 44 s median (44 cells, 2497 s).

## Rules: unchanged

Detector `pipeline/detect/distant.py` = distant-v3b, driver `pipeline/find_distant.py`, both as committed (HEAD 05cfb1a),
not edited. The only new code is `pipeline/find_distant_run2.py` (source at the end of this file): it makes the strip plan
and otherwise runs `find_distant.py` unchanged, pointed at `plan_run2.json` and a separate byte ledger
`cache/planetx/ledger_run2.json`.

| file | md5 | sha256 | git blob at 05cfb1a |
|---|---|---|---|
| `pipeline/detect/distant.py` | 14dd135e1ec5f00771fcf26784a40f92 | e6544ae02848a7954fe8518cb3472b000e92675f5a57f1a09c4ff28ea9b1cc12 | 7fafc12e54574a216642108ef4d33fe77c1978f2 |
| `pipeline/find_distant.py` | b67cdcb9b83a3aa958098fd6b7b3b43e | a43b766b444b447fb9ad5ef698ad6d7fc64d5e4923fa89b8fc32d5b009813f3d | 2fd7877aaa91513ebe656ad9412dbb732ad409f0 |
| `pipeline/find_distant_run2.py` (new) | b59ac031e46962edb705ece92fc35461 | f3ee6120b291639e2d94e29f5460b1b5947abe1efaa3864c400897c663593eb4 | - |
| `pipeline/detect/inject.py` | 27310398166afe88536915cdfad51b08 | 5f55d517e2eea45905e67a082fb03d8242576a03da548059e25afab91a626cd0 | 19d16ec483a5b883c674e43f95b68c402893a4f0 |
| `pipeline/detect/schema.py` | c925b80450dba72ab800af434d373867 | 29917e00f4539fc3b477ab742d5565cbbbcf7a15b655c882fb710659e2565e7b | 2686ee92a7589e4a61c6f396d7271c29a7a7f288 |
| `pipeline/detect/__init__.py` | f298b59b4650681640ddc420b9c0c97d | 7fae409fb062bc50cf7f24c822f521d55fb7e65332ac19376a235e851f036e84 | d473e009b69a991163ebdeaaa59d0d282266c02d |
| `pipeline/blink.py` | d331ddf16f95fb9263c4dfb2aaa7f1a3 | a44bc525a5e3a8c9a50ba1db001e256696c120915acaaeeecdd62ba87577631e | 74c97587efa2496236cfe1478eff568e14a06e42 |
| `pipeline/fetch_region.py` | c18ed22c2fc889b26cf1f950b3cd911f | 6e7f9f63cadb154e8dfb7012f5283ed50cacb88deeead6e7240a3db955825dda | 3e0f1120b5ce9cd01f8497d47fae163ad755e52b |
| `pipeline/sky_index.py` | c3b0a07849e672be299225efad4bd734 | 6cb2660c8fe486fe01cf618a990d59ae37fa035da6e8a9e7e98ccb2227649161 | a5c59c431188edfd837e676a7fa29d34db27c594 |
| `cache/planetx/plan_run2.json` (plan) | c1350d45d60ad284ee4c83bdbf890fbd | ac257b5ed93d85fa0f29ba56aa1c8a0a69d9937c0e7771d4241116ff740c53ec | - |

## Strips

Same median orbit as run 1 (Brown & Batygin 2021, AJ 162, 219, uniform-prior medians: a 380 AU, q 300 AU, i 15.6 deg,
node 96.9 deg, varpi 246.7 deg). Selection rule (in the driver, applied mechanically):
points every 5 deg of true anomaly nu, ranked by the time the planet spends there per degree of nu (proportional to r^2,
Kepler's second law), so aphelion first as in run 1. Down that list a point is taken if it is >= 6 deg from the centre of
every strip already searched (F1-F5, F2L) and of every point already taken (a strip is at most 4.2 deg long), has
|b| >= 20 deg, and has >= 3 seasons with >= 45 D1-D3 exposures in the index (run-1 exposure rule), until 5 are taken.
Why: run 1 took aphelion, the density peak at RA 45 deg, perihelion and nu = -75 / +85; the time-weighted points next to
aphelion are the most probable places of the median orbit that are still unsearched. On the nu < 0 side every point
from nu -170 to -140 is within 20 deg of the galactic plane and nu -135 to -115 has only 2 full seasons, so all five
lie on the nu > 0 side, between the F2 strip and the F1 strip and beyond F2 towards RA 8 deg.

| order | strip | nu (deg) | r on median orbit (AU) | RA, Dec (deg) | ecl. lon, lat | gal. l, b | exposures (per season) | est. MB |
|---|---|---|---|---|---|---|---|---|
| 1 | R2-nu+170 | 170 | 458.1 | 57.7663, +9.9085 | 57.76, -10.00 | 178.81, -32.85 | 205 (73/72/60) | 197 |
| 2 | R2-nu+145 | 145 | 438.8 | 35.1423, -0.9484 | 32.53, -14.13 | 165.89, -56.20 | 202 (72/67/63) | 194 |
| 3 | R2-nu+135 | 135 | 426.7 | 26.1453, -5.3459 | 22.24, -15.07 | 155.45, -64.81 | 180 (56/57/67) | 167 |
| 4 | R2-nu+125 | 125 | 413.0 | 17.0203, -9.6108 | 11.88, -15.54 | 136.35, -72.05 | 202 (68/74/60) | 194 |
| 5 | R2-nu+115 | 115 | 398.6 | 7.6698, -13.6309 | 1.50, -15.53 | 102.15, -75.66 | 169 (55/56/58) | 157 |

Rejected on the way (from the plan's `considered` list): nu +-180, +-175, +165, +160, +155, +150, +140, +130, +120
(< 6 deg from a searched or taken strip); nu -170 to -140 (|b| < 20 deg); nu -135 to -115 (2 full seasons).
Each strip: 110 detector rows x 2040 columns of the IMAGE layer of every D1-D3 exposure in the plan (0.19 x 3.5 deg),
as run 1. Overlap with run-1 strips is checked after the search from the grid corners; any overlap is counted once.

## Search

`find_distant_run2.py fetch --fields <the five, in order> --cap-mb 1000`, then for each strip
`search --field <strip> --n-rand 2000 --threads 2 --out cache/planetx/results_run2`. All of distant-v3b as it is:
orphans >= 5 sigma per season, three-season links on one bound orbit, ONE TRACK (>= 0.6 of each season's S/N on the
link's track), IT MOVES (motion + 2 sigma >= 0.3 x circular speed), the vetoes, the null from N = 2000 shuffled orphan
lists of the same strip.

## Decision rules

- Link: three seasons joined by distant-v3b. Reported with positions, whatever its false-link probability.
- Candidate: a link with false-link probability <= 0.05 against the shuffled lists of its strip (a record of the search).
  A record that also meets the full rule (false-link probability <= 0.001, parallax >= 5 sigma, every season >= 5 sigma) is
  still called a candidate. Nothing in this run is called a discovery.
- Every candidate gets the run-1 checks: per-season S/N on the fitted track and without the two strongest visits; Gaia DR3 /
  2MASS / AllWISE / CatWISE2020 within 15"; SkyBoT known objects within 0.25 deg. Then, if time and bytes allow, a
  follow-up strip centred on it (same exposure rule), as for F2L in run 1: T1 a blind search of that strip (all
  exposures); T2 forced S/N at its three positions in only the exposures that did not cover them before, against 300
  random places of the same stacks, Fisher-combined. Supported: T1 links it again with false-link probability <= 0.05, or
  T2 combined p <= 0.01. Chance link: T1 does not link it and T2 combined p >= 0.1. Anything else: open. A supported
  candidate stays a candidate until a fourth season (data from Nov 2026 on) shows it.
- A strip whose null gives > 1.0 chance links per shuffled strip, or that keeps < 3 seasons, is reported but left out of
  the limit.
- Result "no candidate": an upper limit (below). Result "candidate": the checks above, then the limit from the
  injections all the same.
- Success: all five strips searched and injected by 12:00 +03. Partial: fewer strips done in time (reported as such;
  only strips with all their injection cells count for the limit). Failure: no strip searched, or the injections do not
  reach 50 % at V 18.5 in any strip (then no limit is claimed).

## Completeness (injection-recovery)

Same as run 1 (v3b pass): for each strip, `inject --field <strip> --dists 350,500 --mags 18.5,19,19.4,19.7,20 --nbody 12
--seed 1 --orbits p9 --sed solar --n-rand 1000 --threads 2 --out cache/planetx/injections_run2`:
bodies on exact 3-D tracks (prograde, within 25 deg of the ecliptic, 0.75-1.2 x circular speed), real EPSF, Poisson noise
of the added signal; magnitudes are V of a grey body with the Sun's colours. 5 strips x 2 distances x 5 magnitudes x 12
bodies = 600 bodies in 50 cells. Found = linked in three seasons AND false-link probability <= 0.05 against the shuffled
orphan lists of that strip without the injected bodies (N = 1000).

Numbers reported: per strip and pooled, found / injected by V and distance; 50 % and 90 % points (`find_distant.crossing`:
the faintest V where the found fraction, made non-increasing from the bright side, is still >= the level).
Effective area: reference positions whose three season positions (circular prograde body) are all covered, at 250 / 350 /
500 / 700 / 1000 AU, the run-1 definition.

Combined limit with run 1: the 528 v3b bodies of run 1 (350, 500 AU; V 18.5-20.3) and the 600 of run 2 pooled by V
(identical rule, distances and body model); 50 % and 90 % points of the pool; area = 2.08 deg^2 (run 1, 350 AU) + the
run-2 effective area at 350 AU. Also each run alone.

## Byte budget

Run-2 ledger `cache/planetx/ledger_run2.json`, every request logged. Five strips: estimated 887.5 MB; the fetch refuses a
strip that would take the ledger over 1000 MB. Follow-up strips for candidates: at most 2, <= 200 MB each.
Run 2 in all: <= 1400 MB. One header read + one byte range of 110 rows per exposure, <= 4 requests in flight.

## Time and load

Heavy steps (fetch, search, injections) in this order: fetch all five, search all five, inject strip by strip in the
order above (cells bright to faint). One heavy process, nice 15, 2 threads; free memory checked before each step.
Heavy work stops at 12:00 +03; documents and the site line by 12:30 +03. What is not done by then is written down as
not done.

## Appendix: `pipeline/find_distant_run2.py` (sha256 above)

```python
"""Second Planet X strip search (run 2): new strips on the same median orbit, same detector (distant-v3b), same driver.

  python pipeline/find_distant_run2.py plan        -> cache/planetx/plan_run2.json (never overwritten)
  python pipeline/find_distant_run2.py fetch  --fields R2-...,R2-... --cap-mb 900
  python pipeline/find_distant_run2.py search --field R2-... --out cache/planetx/results_run2 --threads 2
  python pipeline/find_distant_run2.py inject --field R2-... --out cache/planetx/injections_run2 --threads 2 ...
  python pipeline/find_distant_run2.py limits cache/planetx/injections_run2

Only the plan is new. Every other command is pipeline/find_distant.py unchanged, pointed at the run-2 plan and a
separate byte ledger (cache/planetx/ledger_run2.json). Pre-registration: pipeline/PLANETX_RUN2_PREREG.md.
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import find_distant as FD  # noqa: E402

FD.PLAN = FD.PX / "plan_run2.json"
FD.LEDGER = FD.PX / "ledger_run2.json"

N_STRIPS = 5
MIN_SEP_DEG = 6.0           # from every strip already searched and from each other (a strip is <= 4.2 deg long)
NU_STEP = 5.0
PREVIOUS = {"F1-aphelion": (67.13641, 13.90672), "F2-ra45": (45.0, 3.90335), "F3-perihelion": (247.13641, -13.90672),
            "F4-nu-75": (178.01128, 17.29059), "F5-nu+75": (337.58355, -23.05617), "F2L-link420": (44.4785, 3.6667)}
PLAN_RULE = ("Points every 5 deg of true anomaly nu on the same median orbit (Brown & Batygin 2021), ranked by the time the "
             "planet spends there per degree of nu (proportional to r^2, Kepler's second law: aphelion first, as in run 1). "
             "Going down that list, a point is taken if it lies >= 6 deg from the centre of every strip already searched "
             "(F1-F5, F2L) and of every point already taken, |b| >= 20 deg and >= 3 seasons with >= 45 D1-D3 exposures in "
             "the index (same exposure rule as run 1), until 5 points are taken. Strips: 110 rows x 2040 columns, as run 1.")


def sep_deg(a1, d1, a2, d2):
    a1, d1, a2, d2 = (math.radians(v) for v in (a1, d1, a2, d2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def cmd_plan(a):
    import sky_index as SI
    out = FD.PLAN
    if out.exists():
        sys.exit(f"{out} exists: not overwritten (the plan is the pre-registration)")
    nus = [((180.0 + k * NU_STEP + 180.0) % 360.0) - 180.0 for k in range(int(360 / NU_STEP))]
    ranked = sorted(nus, key=lambda nu: (-round(FD.orbit_point(nu)["r_au"] ** 2, 6), abs(nu), nu))
    taken, log = [], []
    for nu in ranked:
        if len(taken) >= N_STRIPS:
            break
        p = FD.orbit_point(nu)
        l, b = FD.galactic(p["ra"], p["dec"])
        near = [(n, sep_deg(p["ra"], p["dec"], ra, de)) for n, (ra, de) in
                list(PREVIOUS.items()) + [(t["name"], (t["ra"], t["dec"])) for t in taken]]
        n_min, s_min = min(near, key=lambda q: q[1])
        why = None
        if s_min < MIN_SEP_DEG:
            why = f"{s_min:.1f} deg from {n_min}"
        elif abs(b) < 20:
            why = f"|b| {abs(b):.1f}"
        else:
            seas, good = FD.usable(p)
            if good < 3:
                why = f"seasons with >= {FD.MIN_GOOD} exposures: {good}"
        log.append(dict(nu=nu, r_au=round(p["r_au"], 1), ra=round(p["ra"], 4), dec=round(p["dec"], 4), gal_b=round(b, 2),
                        nearest=n_min, nearest_deg=round(s_min, 2), rejected=why))
        print(f"nu {nu:+7.1f} r {p['r_au']:5.1f} RA {p['ra']:8.4f} Dec {p['dec']:+8.4f} b {b:+6.1f} nearest {n_min} {s_min:5.1f} deg: "
              f"{'REJECTED ' + why if why else 'TAKEN'}", flush=True)
        if why:
            continue
        ex = []
        for si, v in enumerate(seas):
            for r in v:
                c, e, n = SI.tangent_basis(np.float64(r["ra_center"]), np.float64(r["dec_center"]))
                px, py, _ = SI.project(SI.unit(np.float64(p["ra"]), np.float64(p["dec"])), c, e, n)
                cx, cy = zip(*[SI.project(SI.unit(np.float64(aa), np.float64(dd)), c, e, n)[:2] for aa, dd in r["corners"]])
                uu, vv = SI.quad_uv(float(px), float(py), [float(q) for q in cx], [float(q) for q in cy])
                ex.append(dict(s3_key=r["s3_key"], obs_id=r["obs_id"], collection=r["collection"], detector=r["detector"],
                               mjd=r["mjd"], approx_lam_um=r["approx_lam_um"], season_i=si, x_det=round(uu * 2040, 1), y_det=round(vv * 2040, 1)))
        name = f"R2-nu{int(round(nu)):+d}"
        taken.append(dict(name=name, nu_deg=nu, r_au=round(p["r_au"], 1), ra=round(p["ra"], 5), dec=round(p["dec"], 5),
                          ecl_lon=round(p["lon"], 3), ecl_lat=round(p["lat"], 3), gal_l=round(l, 2), gal_b=round(b, 2),
                          n_rows=FD.NROWS, seasons=[dict(mjd=[v[0]["mjd"], v[-1]["mjd"]], n=len(v)) for v in seas], exposures=ex))
    plan = dict(made=time.strftime("%Y-%m-%d %H:%M:%S %z"), source="Brown & Batygin 2021 (AJ 162, 219), uniform-prior medians",
                orbit=dict(a_au=FD.A, e=round(FD.E, 4), q_au=300.0, inc_deg=FD.INC, node_deg=FD.NODE, varpi_deg=FD.VARPI),
                rule=PLAN_RULE, previous=PREVIOUS, considered=log, fields=taken,
                est_total_mb=round(sum(len(f["exposures"]) for f in taken) * (FD.NROWS * 8160 + 28800) / 1e6, 1))
    out.write_text(json.dumps(plan, indent=1))
    for f in taken:
        print(f"{f['name']}: r {f['r_au']} AU RA {f['ra']} Dec {f['dec']} b {f['gal_b']} exposures {len(f['exposures'])} "
              f"{[s['n'] for s in f['seasons']]}")
    print("est. MB", plan["est_total_mb"], "->", out)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "plan":
        cmd_plan(None)
    else:
        FD.main()
```
