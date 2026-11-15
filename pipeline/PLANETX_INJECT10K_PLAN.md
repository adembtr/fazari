# Planet X: 10,000-body injection test (plan)

**Added after the run 2 pre-registration (1efa576), at Adem's request. Detection rules unchanged.**

Written 2026-11-15 ~11:15 +03, before any of the injections below was run. This file is committed and pushed on its own; the
GitHub push time is the time stamp. Results go to `pipeline/PLANETX_INJECT10K.md` in a later commit.
The search itself is NOT repeated: the candidate lists of run 1 (`pipeline/PLANETX.md`) and run 2 (`pipeline/PLANETX_RUN2.md`)
do not change. Only the completeness curve, and so the upper limit, gets more test bodies.

## What was done before this file

- One timing cell, not counted and not kept for the result: strip R2-nu+145, 350 AU, V 19.4, 50 bodies, seed 999 (outside the
  seed list below), written to a scratch folder: 47.9 s for the cell (12-body cells of run 2: 29-41 s per cell), 51 s to load the
  strip and run the plain search first. 31 of 50 found. Nothing else was injected or searched.

## Code: unchanged

| file | md5 |
|---|---|
| `pipeline/detect/distant.py` (distant-v3b) | 14dd135e1ec5f00771fcf26784a40f92 |
| `pipeline/find_distant.py` | b67cdcb9b83a3aa958098fd6b7b3b43e |
| `pipeline/find_distant_run2.py` | b59ac031e46962edb705ece92fc35461 |
| `pipeline/detect/inject.py` | 27310398166afe88536915cdfad51b08 |
| `cache/planetx/plan_prereg.json` (run-1 strips) | c91037ce1477954a29ef373e424d7940 |
| `cache/planetx/plan_run2.json` = `pipeline/planetx_run2_plan.json` (run-2 strips) | c1350d45d60ad284ee4c83bdbf890fbd |

The same files and hashes as in `pipeline/PLANETX_RUN2_PREREG.md` (commit 05cfb1a / 1efa576). No code is edited for this test.
The only new code comes after the run: a summary script that reads the result files (limit method below).

## Strips (10)

Old 5 = the run-1 strips F1-aphelion, F2-ra45, F3-perihelion, F4-nu-75, F5-nu+75 (`plan_prereg.json`).
New 5 = the run-2 strips R2-nu+170, R2-nu+145, R2-nu+135, R2-nu+125, R2-nu+115 (`plan_run2.json`).
F2L-link420 (run 1's follow-up strip) is NOT included: it was read only to check one link, it overlaps F2-ra45, and it is not
part of run 1's area (2.08 deg^2 = F1-F5) or of run 1's limit.

Pixel data: every strip is already on disk (`cache/planetx/strips/<strip>/`, 165-226 exposures each). No byte is read from IRSA.

## Body model (same as runs 1 and 2)

`find_distant.py inject` as it is: bodies on exact 3-D tracks, prograde, within 25 deg of the ecliptic, 0.75-1.2 x circular
speed (`--orbits p9`), real EPSF, Poisson noise of the added signal; V of a grey body with the Sun's colours (`--sed solar`).
Distances 350 and 500 AU (as runs 1 and 2). Found = linked in three seasons AND false-link probability <= 0.05 against the
shuffled orphan lists of that strip without the injected bodies (`--n-rand 1000`).

One difference: **52 bodies per cell instead of 12.** The time of a cell is set by the residual images of all exposures, not
by the number of bodies (timing cell above), so 10,000 bodies at 12 per cell (~830 cells, ~9 h) do not fit in the time;
52 per cell do. Bodies are kept >= 90" apart in every season (unchanged code). Density check, reported as it comes out and not
used to correct anything: at V 18.5, 19, 19.4, 19.7 and 20, the found fraction of the 52-body cells against the 12-body cells
of runs 1 and 2 in the same strips (pooled; two-proportion z).

## Cells, bodies, magnitudes

- Magnitude grid (V): 17.5, 18, 18.5, 18.75, 19, 19.2, 19.4, 19.55, 19.7, 20 (10 values; finer near the 90 % and 50 % points
  of runs 1-2, V 18.57 and 19.49; 17.5 and 18 show the bright end).
- 10 strips x 2 distances x 10 magnitudes = 200 cells x 52 bodies = **10,400 bodies** (a cell can hold fewer if the strip has no
  room; the count is reported as it comes out).

## Seeds (new, never used before)

Seeds used before in strip and field injections: 1-24 (and 999 for the timing cell above). This test uses 101-120, one per
strip and distance:

| order | strip | 350 AU | 500 AU |
|---|---|---|---|
| 1 | R2-nu+170 | 101 | 111 |
| 2 | F1-aphelion | 102 | 112 |
| 3 | R2-nu+145 | 103 | 113 |
| 4 | F2-ra45 | 104 | 114 |
| 5 | R2-nu+135 | 105 | 115 |
| 6 | F3-perihelion | 106 | 116 |
| 7 | R2-nu+125 | 107 | 117 |
| 8 | F4-nu-75 | 108 | 118 |
| 9 | R2-nu+115 | 109 | 119 |
| 10 | F5-nu+75 | 110 | 120 |

(Bodies of a cell: `default_rng(1000 x seed + AU + int(10 x V))`; noise: `default_rng(seed)`; shuffled lists: seed 3, as before.)

## Run order (a partial stop stays balanced)

Pass A: 350 AU in all 10 strips, in the order above (new and old strips alternate), magnitudes bright to faint.
Pass B: 500 AU in all 10 strips, same order. One command per strip and pass:

```
U="nice -n 15 uv run --no-project --with astropy --with reproject --with numpy --with scipy --with pillow python -I"
OUT=cache/planetx/injections_10k
# old strips (plan_prereg.json)
$U pipeline/find_distant.py      inject --field F1-aphelion --dists 350 --mags 17.5,18,18.5,18.75,19,19.2,19.4,19.55,19.7,20 \
   --nbody 52 --seed 102 --orbits p9 --sed solar --n-rand 1000 --threads 2 --out $OUT
# new strips (plan_run2.json)
$U pipeline/find_distant_run2.py inject --field R2-nu+170 --dists 350 --mags 17.5,18,18.5,18.75,19,19.2,19.4,19.55,19.7,20 \
   --nbody 52 --seed 101 --orbits p9 --sed solar --n-rand 1000 --threads 2 --out $OUT
```

If the run stops early, the limit uses only complete blocks (one strip x one distance x all 10 magnitudes); the rest is
reported as not done. After pass A every strip has its 350 AU block.

## Stop time and load

Estimated 200 cells x ~42 s + 20 strip loads x ~55 s = ~2.6 h. Heavy compute stops at **15:30 +03** whatever is done;
results committed by 16:00. One heavy process, nice 15, 2 threads. A watcher checks free memory and CPU temperature every 30 s
and pauses the process (SIGSTOP) while available memory < 6000 MB or the package temperature >= 90 C, then resumes it.

## Limit (same method as `pipeline/planetx_run2_summary.py`)

- Found / injected per V, pooled over the strips in the limit; 50 % and 90 % points with `find_distant.crossing` (the faintest
  V where the found fraction, made non-increasing from the bright side, is still >= the level, linear between grid points).
  Also per distance, per strip, old 5 and new 5 apart.
- Area: the same strips, so the same effective area as before: 2.08 (run 1) + 2.41 (run 2) = 4.49 deg^2 at 350 AU
  (0.052 % of the 8640 deg^2 band). Checked by comparing the coverage masks the new runs write with those of runs 1 and 2.
- The new upper limit = the 10,400 bodies alone. Also given: all 11,528 bodies (with runs 1-2) pooled by V, and the 1128-body
  numbers for comparison.
- Uncertainty (new, for both the 10,400 and the 1128 bodies): bootstrap of the bodies within each V (2000 resamples,
  `numpy.random.default_rng(10000)`), 16-84 % range of the 50 % and 90 % points.
- Other links in the injected runs (false-link probability <= 0.05, not an injected body) are counted and reported.

## Amendment (2026-11-15 12:10 +03): stop condition

Written at 12:10 +03, before the old stop time (15:30), while the run was going (4 of 20 blocks done: 350 AU of R2-nu+170,
F1-aphelion, R2-nu+145, F2-ra45). Approved by Adem (~12:10, "Evet, böyle", relayed by the coordinator session).
- Old: heavy compute stops at 15:30 +03 whatever is done. New: the run stops when all 20 blocks are done (estimated ~16:30 +03).
- Reason: heat pauses (package temperature >= 90 C, other heavy jobs on the machine) make a run take ~70-90 s instead of the
  estimated 42 s, so 15:30 would leave 3-5 blocks undone.
- Nothing else changes: strips, order, seeds, body model, 52 bodies per run, magnitude grid, detection rules (distant-v3b) and
  the limit method stay as above. If the run is stopped early anyway, only complete blocks count, as above.
