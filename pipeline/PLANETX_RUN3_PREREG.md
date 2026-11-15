# Planet X, run 3: pre-registration

Written 2026-11-15 12:15-12:30 +03, before any pixel of the strips below was read. This file, the run-3 driver and the
strip plan are committed and pushed together, before the search; the GitHub push time is the third-party time stamp.
Results go to `pipeline/PLANETX_RUN3.md` in a later commit.
Run 1 (5 strips + 1 follow-up strip, 2.08 deg^2, no candidate): `pipeline/PLANETX.md`. Run 2 (5 strips, 2.41 deg^2, no
candidate; registered in 1efa576): `pipeline/PLANETX_RUN2_PREREG.md`, `pipeline/PLANETX_RUN2.md`. Run 3 copies run 2's method.

## What was done before this file

- Strip plan from the static sky index only (exposure lists, no pixels): `pipeline/find_distant_run3.py plan`
  -> `cache/planetx/plan_run3.json` (made 2026-11-15 12:12:55 +03; hash below). A copy is committed with this file as
  `pipeline/planetx_run3_plan.json` (identical bytes).
- Before that, the same selection was printed once by a scratch script (same rule, same index, no file written, no pixels)
  to see whether five points qualify; it gave the same five points.
- No pixel of these strips has been read, and no timing test was made. Throughput from run 2: 884.8 MB fetched in 6.5 min,
  31-45 s of search per strip, 50 injected cells in 37 min (machine alone; now another heavy job runs next to it).

## Rules: unchanged

Detector `pipeline/detect/distant.py` = distant-v3b and driver `pipeline/find_distant.py`, as committed (05cfb1a) and as
used in runs 1 and 2; not edited. The only new code is `pipeline/find_distant_run3.py` (source at the end of this file):
the run-2 plan rule with the five run-2 strips added to the list of strips already searched; every other command is
`find_distant.py` unchanged, pointed at `plan_run3.json` and a separate byte ledger `cache/planetx/ledger_run3.json`.

| file | md5 | sha256 | git blob |
|---|---|---|---|
| `pipeline/detect/distant.py` | 14dd135e1ec5f00771fcf26784a40f92 | e6544ae02848a7954fe8518cb3472b000e92675f5a57f1a09c4ff28ea9b1cc12 | 7fafc12e54574a216642108ef4d33fe77c1978f2 |
| `pipeline/find_distant.py` | b67cdcb9b83a3aa958098fd6b7b3b43e | a43b766b444b447fb9ad5ef698ad6d7fc64d5e4923fa89b8fc32d5b009813f3d | 2fd7877aaa91513ebe656ad9412dbb732ad409f0 |
| `pipeline/find_distant_run3.py` (new) | 9ea51449972849f11c7fdcd02635b1d3 | 3fa1c3417c64c641582979a50a7770e36eac486ddba99e27620431e996f5ad3a | a67960f65506e2a65e949c2f80132d5da09c4ff7 |
| `pipeline/find_distant_run2.py` (run 2, not used here) | b59ac031e46962edb705ece92fc35461 | f3ee6120b291639e2d94e29f5460b1b5947abe1efaa3864c400897c663593eb4 | f9964b78f38c08b5b0c78a4254c9b838ba171fe3 |
| `pipeline/detect/inject.py` | 27310398166afe88536915cdfad51b08 | 5f55d517e2eea45905e67a082fb03d8242576a03da548059e25afab91a626cd0 | 19d16ec483a5b883c674e43f95b68c402893a4f0 |
| `pipeline/detect/schema.py` | c925b80450dba72ab800af434d373867 | 29917e00f4539fc3b477ab742d5565cbbbcf7a15b655c882fb710659e2565e7b | 2686ee92a7589e4a61c6f396d7271c29a7a7f288 |
| `pipeline/detect/__init__.py` | f298b59b4650681640ddc420b9c0c97d | 7fae409fb062bc50cf7f24c822f521d55fb7e65332ac19376a235e851f036e84 | d473e009b69a991163ebdeaaa59d0d282266c02d |
| `pipeline/blink.py` | d331ddf16f95fb9263c4dfb2aaa7f1a3 | a44bc525a5e3a8c9a50ba1db001e256696c120915acaaeeecdd62ba87577631e | 74c97587efa2496236cfe1478eff568e14a06e42 |
| `pipeline/fetch_region.py` | c18ed22c2fc889b26cf1f950b3cd911f | 6e7f9f63cadb154e8dfb7012f5283ed50cacb88deeead6e7240a3db955825dda | 3e0f1120b5ce9cd01f8497d47fae163ad755e52b |
| `pipeline/sky_index.py` | c3b0a07849e672be299225efad4bd734 | 6cb2660c8fe486fe01cf618a990d59ae37fa035da6e8a9e7e98ccb2227649161 | a5c59c431188edfd837e676a7fa29d34db27c594 |
| `pipeline/planetx_run2_summary.py` (limit method) | 0014881ebc927fbab228528cfceba68c | 89e250c2627b7c421282a0e9c7f244393800400a2e89d37503ee00ab2feabc47 | 8cff148f83982deb70837551a497b71537970620 |
| `cache/planetx/plan_run3.json` = `pipeline/planetx_run3_plan.json` (plan) | 132dc62d17e5e5360c792244e44cc2c0 | 89f1355651c49913773d525acc294bdf4b700c9bc92dc296e85bbe8b3cad0e59 | c4ae8f63b36fe0722d5b101fe5755f7cbea1a856 |

Every hash of the detector, driver and helper files is the same as in `PLANETX_RUN2_PREREG.md`.

## Strips

Same median orbit as runs 1 and 2 (Brown & Batygin 2021, AJ 162, 219, uniform-prior medians: a 380 AU, q 300 AU,
i 15.6 deg, node 96.9 deg, varpi 246.7 deg). Selection rule = run 2's, applied mechanically by the driver: points every
5 deg of true anomaly nu, ranked by the time the planet spends there per degree of nu (proportional to r^2), so aphelion
first. Down that list a point is taken if it is >= 6 deg from the centre of every strip already searched (F1-F5, F2L and
the five run-2 strips R2-nu+170, +145, +135, +125, +115) and of every point already taken, has |b| >= 20 deg, and has
>= 3 seasons with >= 45 D1-D3 exposures in the index, until 5 are taken.

Five points qualify, so the approved fallback (widening the ten existing strips across the orbit with other detector
rows of the same exposures) is NOT used.

| order | strip | nu (deg) | r on median orbit (AU) | RA, Dec (deg) | ecl. lon, lat | gal. l, b | exposures (per season) | est. MB |
|---|---|---|---|---|---|---|---|---|
| 1 | R3-nu+105 | +105 | 384.1 | 358.0113, -17.2906 | 351.15, -15.04 | 65.51, -73.12 | 185 (55/56/74) | 171 |
| 2 | R3-nu-95 | -95 | 369.9 | 157.5836, +23.0562 | 150.68, +12.69 | 212.28, +57.90 | 149 (45/59/45) | 138 |
| 3 | R3-nu+95 | +95 | 369.9 | 347.9884, -20.4714 | 340.86, -14.08 | 43.89, -66.34 | 218 (80/76/62) | 202 |
| 4 | R3-nu-65 | -65 | 333.5 | 187.6698, +13.6309 | 181.50, +15.53 | 282.15, +75.66 | 173 (57/56/60) | 160 |
| 5 | R3-nu-55 | -55 | 324.0 | 197.0203, +9.6108 | 191.88, +15.54 | 316.35, +72.05 | 204 (75/70/59) | 189 |

Seasons (MJD of first-last exposure in the index) are in the plan: three at each point, about six months apart
(2025, 2025-26, 2026), as in runs 1-2. R3-nu-95 has exactly 45 exposures in two of its seasons,
the minimum of the rule; it is taken as the rule says.

Rejected on the way (the plan's `considered` list, 50 points): nu 180, +-175, +-170 (+170: R2 strip), +-165, +-160,
+-155, +-150, +-145, +-140, +-135, +-130, +-125, +-120, +-115, +-110, -105, +-100, +-90, +-85, +-80, +-75, +-70, +65, +-60.
Reasons: < 6 deg from a searched or taken strip (all positive nu from +180 to +110, +100, +90, +85, +80, -175, -90, -80,
-75, -70, -60); |b| < 20 deg (nu -170 to -140); only 2 seasons with >= 45 exposures (nu -135 to -100, -85, +75, +70,
+65, +60). The run-2 note "nu +60...+110 still open" is answered by the index: only +95 and +105 qualify there.
Not considered (the rule stops after 5 points): +55 and |nu| <= 50.

Each strip: 110 detector rows x 2040 columns of the IMAGE layer of every D1-D3 exposure in the plan (0.19 x 3.5 deg),
as runs 1 and 2. The five centres are >= 10 deg from every searched strip centre and from each other (a strip reaches
<= 2.75 deg from its centre in runs 1-2), so no overlap is expected; it is checked after the search from the grid
corners, and any overlap is counted once.

## Search

```
U="nice -n 15 uv run --no-project --with astropy --with reproject --with numpy --with scipy --with pillow python -I"
$U pipeline/find_distant_run3.py fetch --fields R3-nu+105,R3-nu-95,R3-nu+95,R3-nu-65,R3-nu-55 --cap-mb 1000
$U pipeline/find_distant_run3.py search --field <strip> --n-rand 2000 --threads 2 --out cache/planetx/results_run3
```

All of distant-v3b as it is: orphans >= 5 sigma per season, three-season links on one bound orbit, ONE TRACK (>= 0.6 of
each season's S/N on the link's track), IT MOVES (motion + 2 sigma >= 0.3 x circular speed), the vetoes, the null from
N = 2000 shuffled orphan lists of the same strip. Every link of a strip with a link is listed afterwards with
`planetx_run2_summary.py --links`'s method (the search again with every false-link probability reported, nothing else
changed), in a run-3 copy of the summary script.

## Decision rules (as run 2)

- Link: three seasons joined by distant-v3b. Reported with positions, whatever its false-link probability.
- Candidate: a link with false-link probability <= 0.05 against the shuffled lists of its strip (a record of the search).
  A record that also meets the full rule (false-link probability <= 0.001, parallax >= 5 sigma, every season >= 5 sigma)
  is still called a candidate. Nothing in this run is called a discovery. Anything else: "no candidate".
- Every candidate gets the run-1 checks: per-season S/N on the fitted track and without the two strongest visits; Gaia DR3 /
  2MASS / AllWISE / CatWISE2020 within 15"; SkyBoT known objects within 0.25 deg (catalogue queries, not image bytes).
  A follow-up strip centred on it (T1 blind search, T2 forced S/N in the exposures that did not cover it, as in run 2) only
  if it fits under the byte cap below and before the stop time; otherwise the candidate is reported as open.
- A strip whose null gives > 1.0 chance links per shuffled strip, or that keeps < 3 seasons, is reported but left out of
  the limit.
- Success: all five strips searched and injected by 18:00 +03. Partial: fewer strips done in time (reported as such; only
  strips with all 10 of their injection cells count for the limit). Failure: no strip searched, or the injections do not
  reach 50 % at V 18.5 in any strip (then no run-3 limit is claimed).

## Completeness (injection-recovery, same body model as runs 1-2)

For each strip, `inject --field <strip> --dists 350,500 --mags 18.5,19,19.4,19.7,20 --nbody 12 --seed <seed> --orbits p9
--sed solar --n-rand 1000 --threads 2 --out cache/planetx/injections_run3`: bodies on exact 3-D tracks (prograde, within
25 deg of the ecliptic, 0.75-1.2 x circular speed), real EPSF, Poisson noise of the added signal; magnitudes are V of a
grey body with the Sun's colours. 5 strips x 2 distances x 5 magnitudes x 12 bodies = **600 bodies in 50 cells**.
Found = linked in three seasons AND false-link probability <= 0.05 against the shuffled orphan lists of that strip without
the injected bodies (N = 1000).

Seeds (new; never used before in a strip injection: runs 1-2 and the field tests used 1-24, E2's 10k test 101-120, the
timing cells 999; seeds 301-305 appear in no plan or run script of this project):

| strip | seed |
|---|---|
| R3-nu+105 | 301 |
| R3-nu-95 | 302 |
| R3-nu+95 | 303 |
| R3-nu-65 | 304 |
| R3-nu-55 | 305 |

(Bodies of a cell: `default_rng(1000 x seed + AU + int(10 x V))`; noise: `default_rng(seed)`; shuffled lists: seed 3, as
before.) Order: strip by strip in the order of the table above, cells 350 AU then 500 AU, bright to faint.

Effective area (as runs 1-2): reference positions whose three season positions (circular prograde body) are all covered,
at 250 / 350 / 500 / 700 / 1000 AU, from the coverage masks the injection runs write (`valid_strip_<strip>.npz`).

## What is reported

- Per strip: exposures planned and read, MB, seasons, 5-sigma depth per season, orphans, links, candidates, chance links
  per shuffled strip, search time, effective area; every link with positions, S/N, distance and false-link probability.
- Run 3 alone: found / injected by V and distance, pooled and per strip; 50 % and 90 % points with
  `find_distant.crossing` (the faintest V where the found fraction, made non-increasing from the bright side, is still >= the
  level, linear between grid points); linked-at-all counts; other links in the injected runs; median distance error.
- **Combined limit over all searched area (runs 1 + 2 + 3)**, method of `pipeline/planetx_run2_summary.py`: every body of
  the strips in the limit pooled by V, 50 % / 90 % with `find_distant.crossing`, also per distance; area = 2.08 deg^2
  (run 1, 350 AU) + 2.41 deg^2 (run 2, 350 AU) + the run-3 effective area at 350 AU of the strips in the limit; band
  fraction = area / 8640 deg^2. F2L stays out (as in runs 1-2).
  - Bodies for the ten old strips: if `site/data/planetx/inject10k.json` (E2, `pipeline/PLANETX_INJECT10K_PLAN.md`) is on
    `origin/dev` when the run-3 summary is made, the E2 bodies (`cache/planetx/injections_10k/inj_*.json`, only the
    blocks E2 counts in its limit); otherwise run 1's 528 v3b bodies plus run 2's 600. Which one was used is stated.
  - With E2's bodies, also given: the 1728-body pool (runs 1, 2, 3; 12 bodies per cell everywhere) for comparison.
  - Check, also given (not the headline): an area-weighted curve, f(V) = sum over {old ten strips, run 3} of
    area(350 AU) x found fraction(V) / total area, at the five V of the run-3 grid (all of them are in the E2 grid too),
    with the same crossing rule. Pooling bodies weights each run by its number of bodies, not by its area.
- Reach for a planet of 2.07 Earth radii at albedo 0.75 / 0.40 / 0.20 for the combined 50 % point, as in run 2.
- Byte ledger total and requests; timeline from the ledger and the run logs; what was not done.
- Files: `pipeline/PLANETX_RUN3.md`, a short section in `pipeline/PLANETX.md`, `site/data/planetx/run3.json` (EN/TR text
  of one page line inside it, like `run2.json`), one line on the Planet X page under the run-2 line.

## Byte budget

Run-3 ledger `cache/planetx/ledger_run3.json`, every request logged. Five strips: estimated 860.6 MB; the fetch refuses a
strip that would take the ledger over 1000 MB. **Hard cap 1000 MB for run 3 in all**, follow-up strips included (a
follow-up strip is read only if the ledger stays <= 1000 MB). One header read + one byte range of 110 rows per exposure,
<= 4 requests in flight.

## Time and load

- No pixel byte is read while the E2 injection process (`find_distant_run2.py inject`) runs: the fetch starts when no such
  process is left and E2's last block is written (expected ~16:30 +03), and free memory (available >= 6000 MB) and CPU
  temperature (< 90 C) are checked.
- Heavy steps in this order: fetch all five, search all five, inject strip by strip in the order above. One heavy process,
  nice 15, 2 threads; paused (SIGSTOP) while the package temperature is >= 90 C or available memory < 6000 MB.
- **Heavy work stops at 18:00 +03** whatever is done; documents and the page line by 18:30 +03. What is not done by then is
  written down as not done.

## Appendix: `pipeline/find_distant_run3.py` (sha256 above; committed in the same commit)

```python
"""Third Planet X strip search (run 3): new strips on the same median orbit, same detector (distant-v3b), same driver.

  python pipeline/find_distant_run3.py plan        -> cache/planetx/plan_run3.json (never overwritten)
  python pipeline/find_distant_run3.py fetch  --fields R3-...,R3-... --cap-mb 1000
  python pipeline/find_distant_run3.py search --field R3-... --out cache/planetx/results_run3 --threads 2
  python pipeline/find_distant_run3.py inject --field R3-... --out cache/planetx/injections_run3 --threads 2 ...
  python pipeline/find_distant_run3.py limits cache/planetx/injections_run3

Only the plan is new: the run-2 rule (pipeline/find_distant_run2.py) with the five run-2 strips added to the strips
already searched. Every other command is pipeline/find_distant.py unchanged, pointed at the run-3 plan and a separate
byte ledger (cache/planetx/ledger_run3.json). Pre-registration: pipeline/PLANETX_RUN3_PREREG.md.
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import find_distant as FD  # noqa: E402

FD.PLAN = FD.PX / "plan_run3.json"
FD.LEDGER = FD.PX / "ledger_run3.json"

N_STRIPS = 5
MIN_SEP_DEG = 6.0           # from every strip already searched and from each other (a strip is <= 4.2 deg long)
NU_STEP = 5.0
# run 1 (F1-F5), its follow-up strip (F2L) and run 2 (R2-*, centres from pipeline/planetx_run2_plan.json)
PREVIOUS = {"F1-aphelion": (67.13641, 13.90672), "F2-ra45": (45.0, 3.90335), "F3-perihelion": (247.13641, -13.90672),
            "F4-nu-75": (178.01128, 17.29059), "F5-nu+75": (337.58355, -23.05617), "F2L-link420": (44.4785, 3.6667),
            "R2-nu+170": (57.7663, 9.90852), "R2-nu+145": (35.14228, -0.94843), "R2-nu+135": (26.14525, -5.34592),
            "R2-nu+125": (17.02032, -9.61076), "R2-nu+115": (7.66979, -13.6309)}
PLAN_RULE = ("Points every 5 deg of true anomaly nu on the same median orbit (Brown & Batygin 2021), ranked by the time the "
             "planet spends there per degree of nu (proportional to r^2, Kepler's second law: aphelion first, as in runs 1 "
             "and 2). Going down that list, a point is taken if it lies >= 6 deg from the centre of every strip already "
             "searched (F1-F5, F2L, R2-nu+170, +145, +135, +125, +115) and of every point already taken, |b| >= 20 deg and "
             ">= 3 seasons with >= 45 D1-D3 exposures in the index (same exposure rule as runs 1 and 2), until 5 points are "
             "taken. Strips: 110 rows x 2040 columns, as runs 1 and 2.")


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
        name = f"R3-nu{int(round(nu)):+d}"
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
