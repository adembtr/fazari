# Planet X, run 2: result

Pre-registration: `pipeline/PLANETX_RUN2_PREREG.md`, commit 1efa576, pushed to GitHub 2026-11-15 10:03:55 +03 (GitHub push
event; commit time 10:03:52). First byte of image data read 10:04:12 +03 (`cache/planetx/ledger_run2.json`, first entry).
Rules: distant-v3b, unchanged (md5 14dd135e1ec5f00771fcf26784a40f92; `pipeline/find_distant.py` md5 b67cdcb9b83a3aa958098fd6b7b3b43e,
both as at 05cfb1a). Driver `pipeline/find_distant_run2.py` (sha256 f3ee6120...3eb4) and plan `pipeline/planetx_run2_plan.json`
(sha256 ac257b5e...53ec), both identical to the hashes in the pre-registration. Numbers: `site/data/planetx/run2.json`, made by
`pipeline/planetx_run2_summary.py`.

## Answer

No candidate. Five new strips on the predicted orbit, 2.41 deg^2 (350 AU): 1 link, false-link probability 0.12, so not a
candidate (rule: <= 0.05). In these strips 50 % of injected bodies are found down to **V 19.55**, 90 % down to V 18.67
(600 bodies).
Combined with run 1 (same rules, same body model, 1128 bodies): **no body brighter than V 19.49 (50 %; 90 %: V 18.57) between
350 and 500 AU in 4.49 deg^2** = 0.052 % of the predicted band (8640 deg^2). A planet of 2.07 Earth radii is that bright out to
369 AU if it reflects 75 %, 315 AU for 40 %, 265 AU for 20 % (run 1: 360 / 308 / 259 AU). It says nothing about the rest of
the band.

Everything ran as registered: all five strips fetched, searched and injected, heavy work finished 10:51 (stop time was 12:00).

## Timeline (+03, 15 Nov 2026)

| step | time | source |
|---|---|---|
| strip plan from the sky index (no pixels) | 10:01:11 | `plan_run2.json` "made" |
| pre-registration pushed | 10:03:55 | GitHub push event of 1efa576 |
| fetch (first byte - last byte) | 10:04:12 - 10:10:41 | ledger_run2.json |
| search, five strips | 10:10:43 - 10:14:08 | run log |
| injections, 50 cells | 10:14:08 - 10:51:26 | run log |
| every link of R2-nu+170 listed (`planetx_run2_summary.py --links`) | 10:52 | results_run2/links_R2-nu+170.json |

## Strips and search

Selection (registered rule): points every 5 deg of nu on the Brown & Batygin 2021 median orbit ranked by time per degree
(r^2), >= 6 deg from every run-1 strip, |b| >= 20 deg, >= 3 seasons with >= 45 exposures.
Overlap with run 1: none. The largest distance of a grid point from its strip's target is 2.48-2.75 deg (run 2) and
1.77-2.58 deg (F1, F2, F2L); the closest pairs of targets are 10.0 deg (R2-nu+170 / F1) and 10.4 deg (R2-nu+145 / F2L),
and the new strips are 10 deg from each other.

| strip | r on median orbit (AU) | RA, Dec | exposures per season | area (deg^2, 350 AU) | 5-sigma depth per season (AB) | orphans per season | links | candidates | chance links per shuffled strip (N 2000) | MB | s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R2-nu+170 | 458 | 57.7663, +9.9085 | 72/72/60 | 0.54 | 19.72/19.72/19.77 | 24/45/23 | 1 | 0 | 0.1825 | 189.0 | 45 |
| R2-nu+145 | 439 | 35.1423, -0.9484 | 72/67/62 | 0.50 | 19.77/19.67/19.73 | 24/104/10 | 0 | 0 | 0.075 | 186.2 | 39 |
| R2-nu+135 | 427 | 26.1453, -5.3459 | 56/56/67 | 0.45 | 19.72/19.44/19.74 | 8/34/12 | 0 | 0 | 0.02 | 165.9 | 31 |
| R2-nu+125 | 413 | 17.0203, -9.6108 | 68/74/60 | 0.47 | 19.65/19.43/19.71 | 28/37/24 | 0 | 0 | 0.05 | 187.1 | 36 |
| R2-nu+115 | 399 | 7.6698, -13.6309 | 55/56/58 | 0.45 | 19.78/19.48/19.75 | 13/33/13 | 0 | 0 | 0.01 | 156.6 | 28 |

955 exposures planned, 953 strips read (2: target outside the image, header only). Chance links expected over the five
strips: 0.34; found: 1.

**The link** (R2-nu+170): 2117 +- 25 AU, S/N 7.7 / 5.2 / 7.3, false-link probability 0.120, about AB 19.2, fitted motion
10.6 "/yr (circular 13.3). Positions: 2025-08 RA 56.38968 Dec +9.57202; 2026-02 RA 56.33559 Dec +9.55788; 2026-08 RA 56.38715
Dec +9.57084. Not a candidate under the registered rule, so it was not followed up. As PLANETX.md says, beyond ~1000 AU the
rule IT MOVES has no power, and the two August positions are 10" apart, the pattern of a fixed source seen in both August
seasons (like the F1 link of run 1).

## Completeness (injection-recovery, as registered)

5 strips x 350 / 500 AU x V 18.5, 19, 19.4, 19.7, 20 x 12 bodies (seed 1, prograde within 25 deg of the ecliptic, 0.75-1.2 x
circular speed, grey body with the Sun's colours). Found = linked AND false-link probability <= 0.05 against the strip's
shuffled orphan lists without the injected bodies (N 1000).

| distance (AU) | found / injected by V | 50 % | 90 % |
|---|---|---|---|
| all | 18.5: 113/120, 19: 98/120, 19.4: 86/120, 19.7: 34/120, 20: 5/120 | 19.55 | 18.67 |
| 350 | 18.5: 56/60, 19: 52/60, 19.4: 43/60, 19.7: 18/60, 20: 0/60 | 19.56 | 18.75 |
| 500 | 18.5: 57/60, 19: 46/60, 19.4: 43/60, 19.7: 16/60, 20: 5/60 | 19.54 | 18.64 |

Per strip, 50 % point at 350 / 500 AU: R2-nu+170 19.62 / 19.40, R2-nu+145 19.50 / 19.60, R2-nu+135 19.32 / 19.53,
R2-nu+125 19.55 / 19.55, R2-nu+115 19.64 / 19.70.
Linked at all: 344 of 600 (found: 336). Other links in the 50 injected runs with false-link probability <= 0.05: 6.
Median distance error of a found body: 0.4 AU. 2009 s of injected searches.
Effective area (registered definition): 250 AU 2.24, 350 AU 2.41, 500 AU 2.53, 700 AU 2.60, 1000 AU 2.65 deg^2.
Run 2 is a little deeper than run 1 (V 19.55 against 19.39). Possible reasons, not measured: more exposures per season
(55-74; run 1 45-67, one season 114) and all five strips far from the galactic plane (|b| 33-76 deg; run 1: two at 23 deg).

## Combined with run 1

| | bodies | found / injected by V | 50 % | 90 % | area (deg^2, 350 AU) |
|---|---|---|---|---|---|
| run 1 (v3b pass) | 528 | 18.5: 107/120, 19: 94/120, 19.4: 59/120, 19.7: 23/120, 20: 2/24, 20.3: 0/24 | 19.39 | - | 2.08 |
| run 2 | 600 | 18.5: 113/120, 19: 98/120, 19.4: 86/120, 19.7: 34/120, 20: 5/120 | 19.55 | 18.67 | 2.41 |
| both | 1128 | 18.5: 220/240, 19: 192/240, 19.4: 145/240, 19.7: 57/240, 20: 7/144, 20.3: 0/24 | 19.49 | 18.57 | 4.49 |

By distance (both): 350 AU V 19.47, 500 AU V 19.50. The run-1 cells were read from the run-1 injection folder (the same
files as in PLANETX.md; their pooled 50 % point, 19.39, is reproduced).

## What is not done / caveats

- The one link was not checked against catalogues or SkyBoT and has no follow-up strip: the registered rule asks for that
  only for candidates.
- The run-1 search is a declared second pass (v3b changed after run 1 was unsealed); run 2 is blind: rules fixed and
  pushed before any pixel was read.
- The run-1 injection files live outside this repository (working folder); their numbers are in PLANETX.md.
- All the caveats of PLANETX.md hold (grey reflector, static-source and ghost vetoes next to stars, only three seasons).

## Commands

```
U="uv run --no-project --with astropy --with reproject --with numpy --with scipy --with pillow python -I"
$U pipeline/find_distant_run2.py plan
$U pipeline/find_distant_run2.py fetch --fields R2-nu+170,R2-nu+145,R2-nu+135,R2-nu+125,R2-nu+115 --cap-mb 1000
$U pipeline/find_distant_run2.py search --field R2-nu+170 --n-rand 2000 --threads 2 --out cache/planetx/results_run2
$U pipeline/find_distant_run2.py inject --field R2-nu+170 --dists 350,500 --mags 18.5,19,19.4,19.7,20 --nbody 12 --seed 1 \
   --orbits p9 --sed solar --n-rand 1000 --threads 2 --out cache/planetx/injections_run2
$U pipeline/planetx_run2_summary.py --links R2-nu+170
$U pipeline/planetx_run2_summary.py <run-1 injection folder>      # -> site/data/planetx/run2.json
```
