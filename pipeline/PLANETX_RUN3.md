# Planet X, run 3: result

Pre-registration: `pipeline/PLANETX_RUN3_PREREG.md`, commit 09bd296, pushed to GitHub 2026-11-15 12:15:32 +03 (GitHub push
event; commit time 12:15:31), together with the run-3 driver and the strip plan. First byte of image data read 16:07:36 +03
(`cache/planetx/ledger_run3.json`, first entry), after the 10,400-body injection test (E2) had finished (16:06:42).
Rules: distant-v3b, unchanged (md5 14dd135e1ec5f00771fcf26784a40f92; `pipeline/find_distant.py` md5 b67cdcb9b83a3aa958098fd6b7b3b43e).
Driver `pipeline/find_distant_run3.py` (sha256 3fa1c341...ad3a) and plan `pipeline/planetx_run3_plan.json` (sha256
89f13556...0e59), both identical to the hashes in the pre-registration. Numbers: `site/data/planetx/run3.json`, made by
`pipeline/planetx_run3_summary.py`.

## Answer

No candidate. Five new strips on the predicted orbit (nu +105, -95, +95, -65, -55), 2.58 deg^2 (350 AU): **0 links**
(0.40 chance links expected from the shuffled strips), so nothing to follow up. In these strips 50 % of injected bodies are
found down to **V 19.56**, 90 % down to V 19.00 (600 bodies).
Combined over all searched area (runs 1 + 2 + 3), registered method (bodies pooled by V): the ten old strips use E2's 10,400
bodies (`site/data/planetx/inject10k.json` was on dev, commit 99c1fce, when this summary was made), plus the 600 of run 3:
**no body brighter than V 19.45 (50 %; 90 %: V 18.10) between 350 and 500 AU in 7.07 deg^2 = 0.082 % of the predicted
band** (8640 deg^2). A planet of 2.07 Earth radii is that bright out to 365 AU if it reflects 75 %, 312 AU for 40 %, 262 AU
for 20 % (E2 alone, 4.49 deg^2: V 19.44, 364 / 311 / 262 AU). It says nothing about the rest of the band.

Everything ran as registered: all five strips fetched, searched and injected; heavy work finished 17:42 (stop time 18:00).

## Timeline (+03, 15 Nov 2026)

| step | time | source |
|---|---|---|
| strip plan from the sky index (no pixels) | 12:12:55 | `plan_run3.json` "made" |
| pre-registration pushed (with driver and plan) | 12:15:32 | GitHub push event of 09bd296 |
| waiting for E2 (one heavy slot); driver restarted pinned to cores 12-17 (no pixel read yet) | 12:18 - 16:07 | run log |
| E2 finished (its last block) | 16:06:42 | E2 run log |
| fetch (first byte - last byte) | 16:07:36 - 16:13:50 | ledger_run3.json |
| search, five strips | 16:14:08 - 16:21:59 | run log |
| injections, 50 cells | 16:22:10 - 17:42:03 | run log |

The header of the pre-registration says "written 12:15-12:30"; it was written 12:13-12:15 and pushed at 12:15:32 (the time
in the header was an estimate made before writing). Heat note (coordinator, 13:14): every heavy step ran on the efficiency
cores 12-17 (`taskset -c 12-17`, nice 15, 2 threads); it changes no result. Heat pauses of run 3 (package temperature, median of 5 readings, >= 90 C): 2, 47 s in all.

## Strips and search

Selection (registered rule, the run-2 rule with the run-2 strips added): points every 5 deg of nu on the Brown & Batygin 2021
median orbit ranked by time per degree (r^2), >= 6 deg from every searched strip (F1-F5, F2L, five R2), |b| >= 20 deg, >= 3
seasons with >= 45 exposures. Five points qualified (nu +105, -95, +95, -65, -55), so the approved fallback (widening the old
strips) was not used. On the nu > 0 side between +60 and +110 only +95 and +105 qualify (+100 is 5 deg from +105, +90 / +85
/ +80 are < 6 deg from F5, +75 to +60 have 2 full seasons); on the nu < 0 side -135 to -100 have only 2 full seasons.
Overlap with runs 1-2: none. The largest distance of a grid point from its strip's target is 2.39-2.75 deg; every run-3 target is >= 10.0 deg
from every searched target (closest: R3-nu+105 / R2-nu+115, R3-nu+95 / R3-nu+105, R3-nu-65 / R3-nu-55, all 10.0 deg; R3-nu-95
is 20 deg from F4), so no two strips can overlap.

| strip | r on median orbit (AU) | RA, Dec | exposures per season | area (deg^2, 350 AU) | 5-sigma depth per season (AB) | orphans per season | links | candidates | chance links per shuffled strip (N 2000) | MB | s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R3-nu+105 | 384 | 358.0113, -17.2906 | 55/56/74 | 0.47 | 19.72/19.79/19.86 | 21/34/28 | 0 | 0 | 0.05 | 171.4 | 60 |
| R3-nu-95 | 370 | 157.5836, +23.0562 | 45/58/43 | 0.49 | 19.63/19.67/19.61 | 49/21/23 | 0 | 0 | 0.065 | 135.3 | 46 |
| R3-nu+95 | 370 | 347.9884, -20.4714 | 80/76/62 | 0.54 | 19.80/19.81/19.75 | 22/50/15 | 0 | 0 | 0.04 | 202.0 | 84 |
| R3-nu-65 | 334 | 187.6698, +13.6309 | 57/56/59 | 0.50 | 19.86/19.56/19.84 | 28/27/69 | 0 | 0 | 0.12 | 159.4 | 60 |
| R3-nu-55 | 324 | 197.0203, +9.6108 | 75/69/59 | 0.58 | 19.87/19.53/19.81 | 48/40/61 | 0 | 0 | 0.12 | 188.1 | 87 |

929 exposures planned, 924 strips read (5: target outside the image, header only). 856.1 MB in 1853 requests (cap 1000 MB).
R3-nu-95 had exactly 45 exposures in two seasons of the index (the rule's minimum); 45 / 58 / 43 were usable in the search
(three outside the image), so the strip keeps three seasons and stays in the search and the limit (rule: >= 3 seasons).
Chance links expected over the five strips: 0.40; found: **0 links**. No link means nothing to list or follow up.

## Completeness (injection-recovery, as registered)

5 strips x 350 / 500 AU x V 18.5, 19, 19.4, 19.7, 20 x 12 bodies (seeds 301-305, one per strip; prograde within 25 deg
of the ecliptic, 0.75-1.2 x circular speed, grey body with the Sun's colours). Found = linked AND false-link probability
<= 0.05 against the strip's shuffled orphan lists without the injected bodies (N 1000). All 50 cells ran; all five strips
are in the limit.

| distance (AU) | found / injected by V | 50 % | 90 % |
|---|---|---|---|
| all | 18.5: 113/120, 19: 108/120, 19.4: 82/120, 19.7: 41/120, 20: 9/120 | 19.56 | 19.00 |
| 350 | 18.5: 56/60, 19: 55/60, 19.4: 40/60, 19.7: 21/60, 20: 3/60 | 19.56 | 19.03 |
| 500 | 18.5: 57/60, 19: 53/60, 19.4: 42/60, 19.7: 20/60, 20: 6/60 | 19.56 | 18.88 |

Per strip, 50 % point at 350 / 500 AU: R3-nu+105 19.46 / 19.50, R3-nu-95 19.40 / 19.33, R3-nu+95 19.75 / 19.64,
R3-nu-65 19.64 / 19.57, R3-nu-55 19.55 / 19.62. R3-nu-95 (fewest exposures, 45/58/43) is the shallowest, R3-nu+95 (80/76/62)
the deepest.
Linked at all: 360 of 600 (found: 353). Other links in the 50 injected runs with false-link probability <= 0.05: 4.
Median distance error of a found body: 0.4 AU. 4338 s of injected searches (54.6-149.4 s per cell).
Effective area (registered definition): 250 AU 2.44, 350 AU 2.58, 500 AU 2.68, 700 AU 2.74, 1000 AU 2.78 deg^2.
Run 3 alone is close to run 2 (V 19.56 against 19.55 at 50 %); its 90 % point (V 19.00) is fainter than run 2's (18.67):
at V 19, 108 of 120 found (run 2: 98 of 120). Not tested why; 120 bodies per V give about +-3 % on each fraction.

## Combined limit over runs 1 + 2 + 3

Registered method: every body of the strips in the limit pooled by V, 50 % / 90 % with `find_distant.crossing`; area =
2.08 (run 1) + 2.41 (run 2) + 2.58 (run 3) deg^2 at 350 AU = **7.07 deg^2 = 0.082 % of the band**. F2L stays out.
Old ten strips: E2's 10,400 bodies (all 20 blocks are complete; `inject10k.json` on dev since 99c1fce), as registered.

| set | bodies | found / injected by V | 50 % | 90 % | area (deg^2, 350 AU) |
|---|---|---|---|---|---|
| run 3 | 600 | 18.5: 113/120, 19: 108/120, 19.4: 82/120, 19.7: 41/120, 20: 9/120 | 19.56 | 19.00 | 2.58 |
| old ten strips (E2) | 10400 | 17.5: 948/1040, 18: 944/1040, 18.5: 895/1040, 18.75: 846/1040, 19: 803/1040, 19.2: 726/1040, 19.4: 577/1040, 19.55: 360/1040, 19.7: 257/1040, 20: 22/1040 | 19.44 | 18.08 | 4.49 |
| **runs 1 + 2 + 3 (E2 + run 3), the limit** | 11000 | 17.5: 948/1040, 18: 944/1040, 18.5: 1008/1160, 18.75: 846/1040, 19: 911/1160, 19.2: 726/1040, 19.4: 659/1160, 19.55: 360/1040, 19.7: 298/1160, 20: 31/1160 | **19.45** | **18.10** | **7.07** |
| runs 1 + 2 + 3, 12 bodies per cell (for comparison) | 1728 | 18.5: 333/360, 19: 300/360, 19.4: 227/360, 19.7: 98/360, 20: 16/264, 20.3: 0/24 | 19.51 | 18.64 | 7.07 |
| runs 1 + 2 (before) | 1128 | 18.5: 220/240, 19: 192/240, 19.4: 145/240, 19.7: 57/240, 20: 7/144, 20.3: 0/24 | 19.49 | 18.57 | 4.49 |

By distance (the limit): 350 AU V 19.43 (90 % not reached: V 17.5 463/520 = 89 %), 500 AU V 19.46 (90 %: V 18.31).
Area-weighted check (registered, not the headline): f(V) = (4.49 x f_old + 2.58 x f_run3) / 7.07 at the five V of the run-3
grid: 18.5 0.890, 19 0.819, 19.4 0.602, 19.7 0.282, 20 0.041: 50 % at V 19.50; 90 % not reached (89 % at V 18.5). Pooling
bodies weights the old strips 17 : 1 (bodies), the area 1.7 : 1, so the pooled 50 % point (19.45) leans on E2's denser test
(52 bodies per cell; E2 measured fewer found at V 18.5 than with 12 per cell, z -2.34).
Reach of the limit (V 19.45, 2.07 Earth radii, grey): 365 AU at albedo 0.75, 312 AU at 0.40, 262 AU at 0.20.

## What is not done / caveats

- Nothing was left out of the registered plan. No follow-up strip (no link, no candidate); no catalogue / SkyBoT check (only
  candidates get them).
- The pre-registration header gives "written 12:15-12:30"; the file was pushed at 12:15:32 (see timeline). Nothing in it was
  changed after the push.
- The combined limit mixes 52-body cells (E2, old ten strips) with 12-body cells (run 3), as registered; the 1728-body pool
  (12 per cell everywhere) and the area-weighted check are given next to it.
- The run-1 search is a declared second pass (v3b changed after run 1 was unsealed); runs 2 and 3 are blind: rules fixed and
  pushed before any pixel was read.
- All the caveats of PLANETX.md hold (grey reflector, static-source and ghost vetoes next to stars, only three seasons).

## Commands

```
U="taskset -c 12-17 nice -n 15 uv run --no-project --with astropy --with reproject --with numpy --with scipy --with pillow python -I"
$U pipeline/find_distant_run3.py plan
$U pipeline/find_distant_run3.py fetch --fields R3-nu+105,R3-nu-95,R3-nu+95,R3-nu-65,R3-nu-55 --cap-mb 1000
$U pipeline/find_distant_run3.py search --field R3-nu+105 --n-rand 2000 --threads 2 --out cache/planetx/results_run3
$U pipeline/find_distant_run3.py inject --field R3-nu+105 --dists 350,500 --mags 18.5,19,19.4,19.7,20 --nbody 12 --seed 301 \
   --orbits p9 --sed solar --n-rand 1000 --threads 2 --out cache/planetx/injections_run3      # seeds 301-305 in strip order
$U pipeline/planetx_run3_summary.py <run-1 injection folder> --e2 site/data/planetx/inject10k.json --site-line <line.json>
```
