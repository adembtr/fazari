# Planet X: 10,400-body injection test (result)

**Added after the run 2 pre-registration (1efa576), at Adem's request. Detection rules unchanged.**

Plan: `pipeline/PLANETX_INJECT10K_PLAN.md`, commit 152e9ba, pushed to GitHub 2026-11-15 11:07:12 +03 (push event), before the
first test body was injected (first run started 11:07:42, run log). Amendment 36ed43d (pushed 12:09:42, approved by
Adem): run until all 20 blocks are done instead of stopping at 15:30; nothing else changed. Rules: distant-v3b (md5 14dd135e1ec5f00771fcf26784a40f92),
`pipeline/find_distant.py` and `pipeline/find_distant_run2.py` unchanged (the hashes in the plan). Numbers:
`site/data/planetx/inject10k.json`, made by `pipeline/planetx_inject10k_summary.py` (this file and the PLANETX.md section too).
The search results of runs 1 and 2 do not change (no candidate): this test only measures the completeness again, with more bodies.

## Answer

10,400 test bodies (200 runs of 52) in 20 complete blocks over 10 strips: 50 % are found down to
**V 19.44** (bootstrap 16-84 %: 19.43-19.45); 90 % down to **V 18.08** (bootstrap 16-84 %: 17.96-18.12).
The 1128 bodies of runs 1 and 2 gave V 19.49 (16-84 %: 19.46-19.5) and V 18.57.
Bright end: found at V 17.5 / 18 / 18.5: 948/1040 (91 %) / 944/1040 (91 %) / 895/1040 (86 %) (1128 bodies, V 18.5: 220/240 (92 %)).
**New upper limit: no body brighter than V 19.44 (50 % completeness) between 350 and 500 AU in 4.49 deg^2**
(0.052 % of the predicted band, 8640 deg^2). A planet of 2.07 Earth radii is that bright out to
364 AU if it reflects 75 %, 311 AU for 40 %, 262 AU for 20 % (with V 19.49: 369 / 315 / 265 AU).
The 16-84 % range of the 50 % point is 0.02 mag wide (1128 bodies: 0.04 mag).
Against the 1128 bodies the 50 % point moves by -0.05 mag and the 90 % point by -0.49 mag. In the density check (below) the 52-body runs find 86 % at V 18.5 against 92 % for the 12-body runs in the same strips (z -2.34): part of the shift of the 90 % point may come from the denser test (not separated here).
It says nothing about the rest of the band.

## How it ran (+03, 15 Nov 2026)

| step | time | source |
|---|---|---|
| plan pushed | 11:07:12 | GitHub push event of 152e9ba |
| first run started | 11:07:42 | run log |
| watcher changed (see deviations) | 11:12:52 | run log |
| plan amendment pushed: run until all 20 blocks are done (Adem's approval; old stop 15:30) | 12:09:42 | GitHub push event of 36ed43d |
| runs pinned to cores 12-17 (see deviations) | 13:07:52 | run log |
| last result file written | 16:06:40 | file times |
| stopped early | no | run log |

Heat pauses: 94 (40 min in all; package temperature, median of 5 readings, >= 90 C). Other heavy jobs (one or
two processes) ran on the machine at the same time for most of the run. 4.47 h of injected searches
in the blocks of the limit (cell times, without strip loading and pauses).

## Completeness

| set | bodies | found / injected by V | 50 % | 90 % |
|---|---|---|---|---|
| this test, all | 10400 | 17.5: 948/1040, 18: 944/1040, 18.5: 895/1040, 18.75: 846/1040, 19: 803/1040, 19.2: 726/1040, 19.4: 577/1040, 19.55: 360/1040, 19.7: 257/1040, 20: 22/1040 | 19.44 | 18.08 |
| this test, 350 AU | 5200 | 17.5: 463/520, 18: 464/520, 18.5: 438/520, 18.75: 413/520, 19: 394/520, 19.2: 349/520, 19.4: 276/520, 19.55: 181/520, 19.7: 118/520, 20: 13/520 | 19.43 | not reached |
| this test, 500 AU | 5200 | 17.5: 485/520, 18: 480/520, 18.5: 457/520, 18.75: 433/520, 19: 409/520, 19.2: 377/520, 19.4: 301/520, 19.55: 179/520, 19.7: 139/520, 20: 9/520 | 19.45 | 18.26 |
| this test, old 5 (F1-F5) | 5200 | 17.5: 464/520, 18: 456/520, 18.5: 421/520, 18.75: 400/520, 19: 370/520, 19.2: 325/520, 19.4: 248/520, 19.55: 150/520, 19.7: 103/520, 20: 11/520 | 19.37 | not reached |
| this test, new 5 (R2) | 5200 | 17.5: 484/520, 18: 488/520, 18.5: 474/520, 18.75: 446/520, 19: 433/520, 19.2: 401/520, 19.4: 329/520, 19.55: 210/520, 19.7: 154/520, 20: 11/520 | 19.49 | 18.55 |
| runs 1 + 2 (before) | 1128 | 18.5: 220/240, 19: 192/240, 19.4: 145/240, 19.7: 57/240, 20: 7/144, 20.3: 0/24 | 19.49 | 18.57 |
| this test + runs 1 + 2 | 11528 | 17.5: 948/1040, 18: 944/1040, 18.5: 1115/1280, 18.75: 846/1040, 19: 995/1280, 19.2: 726/1040, 19.4: 722/1280, 19.55: 360/1040, 19.7: 314/1280, 20: 29/1184, 20.3: 0/24 | 19.44 | 18.11 |

Linked at all: 6517 of 10400. Median distance error of a found body: 0.3 AU.
Links in the injected runs that are not an injected body (false-link probability <= 0.05): 300
(not examined one by one; 52 test bodies share one strip, and no candidate list depends on them). 500 AU blocks in the limit: all 10 strips.

Per strip:

| strip | bodies | 50 % | 90 % | found at V 17.5 / 18 / 18.5 / 19 / 19.4 / 19.7 / 20 |
|---|---|---|---|---|
| R2-nu+170 | 1040 | 19.43 | not reached | 91/104 / 99/104 / 91/104 / 77/104 / 57/104 / 26/104 / 2/104 |
| F1-aphelion | 1040 | 19.27 | not reached | 92/104 / 93/104 / 83/104 / 78/104 / 39/104 / 7/104 / 0/104 |
| R2-nu+145 | 1040 | 19.58 | 18.65 | 103/104 / 98/104 / 96/104 / 90/104 / 66/104 / 34/104 / 4/104 |
| F2-ra45 | 1040 | 19.21 | not reached | 86/104 / 83/104 / 75/104 / 64/104 / 38/104 / 15/104 / 0/104 |
| R2-nu+135 | 1040 | 19.48 | 17.94 | 98/104 / 93/104 / 95/104 / 86/104 / 68/104 / 29/104 / 0/104 |
| F3-perihelion | 1040 | 19.21 | not reached | 92/104 / 87/104 / 79/104 / 60/104 / 35/104 / 8/104 / 2/104 |
| R2-nu+125 | 1040 | 19.48 | not reached | 92/104 / 99/104 / 96/104 / 89/104 / 67/104 / 29/104 / 1/104 |
| F4-nu-75 | 1040 | 19.6 | 18.81 | 102/104 / 97/104 / 95/104 / 89/104 / 73/104 / 39/104 / 8/104 |
| R2-nu+115 | 1040 | 19.5 | 18.6 | 100/104 / 99/104 / 96/104 / 91/104 / 71/104 / 36/104 / 4/104 |
| F5-nu+75 | 1040 | 19.48 | not reached | 92/104 / 96/104 / 89/104 / 79/104 / 63/104 / 34/104 / 1/104 |

Uncertainty (bootstrap of the bodies within each V, 2000 resamples, seed 10000):

| bodies | 50 % point: 16 / 50 / 84 % of resamples | 90 % point: 16 / 50 / 84 % | 90 % not reached in |
|---|---|---|---|
| 10400 (this test) | 19.43 / 19.44 / 19.45 | 17.96 / 18.06 / 18.12 | 9.6 % |
| 1128 (runs 1 + 2) | 19.46 / 19.48 / 19.5 | 18.53 / 18.59 / 18.65 | 13.6 % |

Not in the plan (written after the V 17.5 runs were seen): without the V 17.5 bin the same crossing gives 50 % at V 19.44 and
90 % at V 18.08. Only the planned numbers above are the result.

## Density check (as planned; nothing corrected)

The found fraction of the 52-body runs against the 12-body runs of runs 1 and 2 in the same strips and at the same distance
(the blocks of the limit, pooled; at V 20 the 12-body side has the run-2 strips and F4 only):

| V | 52 per run: found | 12 per run (runs 1-2): found | z |
|---|---|---|---|
| 18.5 | 895/1040 (86 %) | 220/240 (92 %) | -2.34 |
| 19 | 803/1040 (77 %) | 192/240 (80 %) | -0.94 |
| 19.4 | 577/1040 (55 %) | 145/240 (60 %) | -1.39 |
| 19.7 | 257/1040 (25 %) | 57/240 (24 %) | 0.31 |
| 20 | 22/1040 (2 %) | 7/144 (5 %) | -2.0 |

## Coverage

The coverage masks written by this test are identical to those of runs 1 and 2 in 10 of 10
strips (no difference); the area is the run-1 / run-2 effective area
at 350 AU of the strips in the limit: 4.49 deg^2.

## Deviations from the plan and what is not done

- Not done: nothing (all 20 blocks).
- Stop condition: 15:30 in the plan; changed by the amendment 36ed43d (pushed 12:09:42, before 15:30, approved by Adem) to
  "all 20 blocks". The driver was restarted for it at 12:09:57 without stopping the running block.
- The load watcher: the plan said one reading every 30 s. The package temperature jumps between ~50 and ~97 C within seconds,
  so from 11:12:52 the watcher reads the median of 5 readings (1 s apart) every ~20 s; pause at >= 90 C, resume
  below 85 C. The runs themselves, cells, seeds and order are as planned.
- From 13:07:52 the run was pinned to the efficiency cores 12-17 (against the heat spikes, at the coordinator's request);
  this changes the speed, not the result.
- Time per run: ~81 s on average (plan estimate 42 s, from the timing cell
  run alone on the machine).
- Bright end: why 9 % of the brightest bodies (V 17.5) are missed was not examined here (in run 1 the
  static-source and ghost vetoes next to stars were the measured cause in one strip; `pipeline/PLANETX.md`).
- All caveats of `pipeline/PLANETX.md` hold (grey reflector, static-source and ghost vetoes next to stars, three seasons only).

## Commands

```
U="nice -n 15 uv run --no-project --with astropy --with reproject --with numpy --with scipy --with pillow python -I"
$U pipeline/find_distant_run2.py inject --field R2-nu+170 --dists 350 --mags 17.5,18,18.5,18.75,19,19.2,19.4,19.55,19.7,20 \
   --nbody 52 --seed 101 --orbits p9 --sed solar --n-rand 1000 --threads 2 --out cache/planetx/injections_10k
$U pipeline/find_distant.py inject --field F1-aphelion --dists 350 ... --seed 102 ...      # old strips: find_distant.py
# (strip order and seeds: the plan; driver scripts ajan_durumu/e2_inject10k/run_10k.sh, _v2.sh, _v3.sh, outside the repository)
$U pipeline/planetx_inject10k_summary.py <run-1 injection folder> --links links.json --log run_10k.log --docs
```
