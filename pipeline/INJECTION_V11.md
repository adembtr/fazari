# Injection test V6 with finder v1.1 on new seeds: results

Plan: [`INJECTION_V11_PLAN.md`](INJECTION_V11_PLAN.md), commit e9b5dec, pushed to `dev` on GitHub at 2026-11-15 08:07:53 UTC
(11:07:53 +03, GitHub repository activity). The first run with a new seed started at 11:08:09 +03. Nothing in the finder,
its thresholds, the injection harness or the V6 rule was changed. The numbers below are as they came out.

## Result in short

- 18 runs finished: 17 of the 20 runs of seed 101 (Barnard's Star AB 18, Epsilon Indi B AB 19 and WISE 0855 AB 19 not
  reached) and 1 run of seed 102 (WISE 0855 AB 15). 1152 bodies injected (864 movers, 288 brightness changes); 75 fell
  where there is no data and are left out, as in every round.
- Recovered: **503 of 818 movers** and **156 of 259 brightness changes**. **49 false candidates** (plus 32 track
  fragments of fast injected movers, which are not counted as false).
- Best bin, new seeds alone: 130/137 = **94.9 %** (WISE 0855, at least 1"/yr, AB 12-17). Best bin of the earlier rounds,
  Epsilon Indi B at least 0.3"/yr AB 12-14: 84/91 = 92.3 % with seed 101 (seed 1 with v1.1: 89/91 = 97.8 %).
- Best bin, all finder v1.1 runs (the data that decide the status by the plan): Epsilon Indi B, at least 0.3"/yr,
  AB 12-14, seeds 1 and 101: **173/182 = 95.1 %** (95 % lower limit 91.5 %), below the 99 % target.
- **V6 stays "fail"** by its unchanged rule.
- Same 17 runs, seed 101 with finder v1.1 against seed 1 with finder v1 (round v1): movers 472/772 against 465/764,
  brightness changes 148/245 against 154/253, false candidates 47 against 80. On new positions v1.1 recovers about as
  many movers as v1 did on the old ones, with fewer false candidates. The 97.8 % of the best bin does not come back on
  new positions: seed 101 gives 92.3 % there.

## What ran, and the changes from the plan

| | |
|---|---|
| Code | `dev` fd233c6, then rebased; `pipeline/detect` and `pipeline/blink.py` as tested in round v1.1 (a5de792) except `asteroids.py` (not imported by the injection test) |
| Timing run (not counted) | WISE 0855 AB 14, old seed 1, 11:04-11:06: every record equal to the round v1.1 run |
| New runs | 11:08:09 - 13:04:37 +03, 18 runs, 6976 s of run time in all |
| Not started | 182 runs of the list (the last 3 of seed 101, 19 of seed 102, all of seeds 103-110): when its turn came (13:01-13:04), each would have ended after the stop time |
| Stopped unfinished | none |

Changes from the plan, all decided without looking at any result of a new seed, none of them changing a result:

1. **Stop time 13:05 instead of 13:20.** The plan says 13:20, but the work limit was 2 hours after the plan push
   (11:07:53, so 13:07:53). Decided at 11:08, before the first run with a new seed. The driver ended at 13:04:47.
2. **Workers.** From 11:08 to 11:15 two runs at a time (the plan allows two); from 11:15 one run at a time, because
   the CPU package was at 89-98 C with another heavy job running (instruction from the coordinator). The two runs going
   at that moment were finished first. All workers ran on the 8 efficiency cores (CPU 12-19), with one BLAS thread each.
   A heat guard paused the workers (SIGSTOP / SIGCONT) when the package was >= 90 C on two readings 20 s apart, 14 times
   for 10-121 s, and the driver did not start a run while it was >= 90 C (8 waits of 10-21 s). A run's result does not
   depend on any of this: the timing run with one BLAS thread gave exactly the round v1.1 record.
3. **Order at the end.** As the plan says, a run is not started if it would end after the stop time. At 13:01 the
   driver skipped the three rest runs of seed 101 and the first runs of seed 102 for that reason and started the next
   run in the list that fitted, WISE 0855 AB 15 of seed 102. That run counts in the totals; it enters no bin, because
   seed 102 has no other run.

Run outputs (one JSON per run, with every injected source, its recovery, miss reasons and the false candidates) are
kept outside the repository, as for earlier rounds. The per-bin numbers are in the evidence file below.

## Per run

| field | AB | seed | set | movers | brightness | false | track fragments | seconds |
|---|---|---|---|---|---|---|---|---|
| eps_indi_b | 12 | 1 | v1.1 reduced re-run | 37/46 | 10/13 | 5 | 2 | 509.6 |
| eps_indi_b | 13 | 1 | v1.1 reduced re-run | 34/42 | 13/15 | 8 | 1 | 427.7 |
| eps_indi_b | 14 | 1 | v1.1 reduced re-run | 35/46 | 10/15 | 3 | 0 | 480.8 |
| wise0855 | 14 | 1 | v1.1 reduced re-run | 33/46 | 9/15 | 0 | 0 | 195.9 |
| wise0855 | 18 | 1 | v1.1 reduced re-run | 16/45 | 4/14 | 1 | 1 | 119.0 |
| barnard | 12 | 101 | new seed | 28/48 | 12/16 | 11 | 1 | 1020.6 |
| barnard | 14 | 101 | new seed | 30/48 | 12/16 | 3 | 0 | 984.6 |
| barnard | 16 | 101 | new seed | 25/47 | 9/16 | 8 | 4 | 838.4 |
| eps_indi_b | 12 | 101 | new seed | 31/46 | 11/13 | 4 | 1 | 445.3 |
| eps_indi_b | 13 | 101 | new seed | 36/45 | 10/11 | 7 | 4 | 434.7 |
| eps_indi_b | 14 | 101 | new seed | 33/44 | 11/16 | 3 | 2 | 430.2 |
| eps_indi_b | 15 | 101 | new seed | 34/46 | 9/14 | 1 | 0 | 473.0 |
| eps_indi_b | 16 | 101 | new seed | 27/45 | 8/14 | 2 | 1 | 324.7 |
| eps_indi_b | 17 | 101 | new seed | 22/44 | 6/14 | 2 | 5 | 314.6 |
| eps_indi_b | 18 | 101 | new seed | 9/43 | 5/15 | 1 | 8 | 191.7 |
| wise0855 | 12 | 101 | new seed | 34/47 | 11/15 | 1 | 0 | 211.0 |
| wise0855 | 13 | 101 | new seed | 33/44 | 10/15 | 0 | 0 | 205.6 |
| wise0855 | 14 | 101 | new seed | 31/46 | 10/15 | 0 | 0 | 290.8 |
| wise0855 | 15 | 101 | new seed | 32/46 | 8/14 | 1 | 0 | 170.6 |
| wise0855 | 16 | 101 | new seed | 28/46 | 7/15 | 1 | 1 | 153.4 |
| wise0855 | 17 | 101 | new seed | 22/45 | 5/13 | 1 | 1 | 152.8 |
| wise0855 | 18 | 101 | new seed | 17/42 | 4/13 | 1 | 3 | 149.3 |
| wise0855 | 15 | 102 | new seed | 31/46 | 8/14 | 2 | 1 | 184.2 |

Movers and brightness changes: recovered / injected, injections with no data at their position left out. The seed-1
rows are the round v1.1 reduced re-run (15 Nov 02:21-02:43), shown because they enter the status bins. Run times of the
new seeds are on the efficiency cores, with pauses (see above).

## V6 bins (rule unchanged: best bin >= 99 % passes)

Movers recovered / injected at or above the speed, pooled over the magnitudes of the field's grid and over the seeds
that ran every magnitude of the bin. 95 % low = one-sided Clopper-Pearson lower limit.

| field | bin | new seeds alone | 95 % low | all finder v1.1 runs (seeds) | 95 % low |
|---|---|---|---|---|---|
| Epsilon Indi B | >= 0.3"/yr, AB 12-14 | 84/91 = 92.3 % | 86.0 % | **173/182 = 95.1 %** (1, 101) | 91.5 % |
| Epsilon Indi B | >= 0.3"/yr, AB 12-16 | 138/152 = 90.8 % | 86.0 % | 138/152 = 90.8 % (101) | 86.0 % |
| Epsilon Indi B | >= 1"/yr, AB 12-17 | 120/135 = 88.9 % | 83.4 % | 120/135 = 88.9 % (101) | 83.4 % |
| Epsilon Indi B | >= 1"/yr, AB 18 | 9/23 = 39.1 % | 22.2 % | 9/23 = 39.1 % (101) | 22.2 % |
| Epsilon Indi B | >= 5"/yr, AB 18 | 7/16 = 43.8 % | 22.7 % | 7/16 = 43.8 % (101) | 22.7 % |
| WISE 0855 | >= 0.3"/yr, AB 12-14 | 87/93 = 93.5 % | 87.7 % | 87/93 = 93.5 % (101) | 87.7 % |
| WISE 0855 | >= 0.3"/yr, AB 12-16 | 141/154 = 91.6 % | 86.9 % | 141/154 = 91.6 % (101) | 86.9 % |
| WISE 0855 | >= 1"/yr, AB 12-17 | **130/137 = 94.9 %** | 90.6 % | 130/137 = 94.9 % (101) | 90.6 % |
| WISE 0855 | >= 1"/yr, AB 18 | 17/21 = 81.0 % | 61.6 % | 33/45 = 73.3 % (1, 101) | 60.4 % |
| WISE 0855 | >= 5"/yr, AB 18 | 15/16 = 93.8 % | 73.6 % | 27/32 = 84.4 % (1, 101) | 69.9 % |
| Barnard's Star | >= 0.3"/yr, AB 12-14 | 52/64 = 81.2 % | 71.4 % | 52/64 = 81.2 % (101) | 71.4 % |
| Barnard's Star | >= 0.3"/yr, AB 12-16 | 76/96 = 79.2 % | 71.2 % | 76/96 = 79.2 % (101) | 71.2 % |
| Barnard's Star | >= 1"/yr, AB 12-17 | 66/72 = 91.7 % | 84.2 % | 66/72 = 91.7 % (101) | 84.2 % |
| Barnard's Star | >= 1"/yr, AB 18 | not evaluated (AB 18 not run) | | not evaluated | |
| Barnard's Star | >= 5"/yr, AB 18 | not evaluated (AB 18 not run) | | not evaluated | |

- **Status by the plan: best bin of all finder v1.1 runs 173/182 = 95.1 % < 99 % -> V6 fails.** The new seeds alone
  give the same answer (best 94.9 %).
- For comparison (round v1, finder v1, seed 1): Epsilon Indi B >= 0.3"/yr AB 12-14 89/91 = 97.8 %; WISE 0855 >= 1"/yr
  AB 12-17 131/137 = 95.6 %; Barnard's Star >= 0.3"/yr AB 12-14 48/64 = 75.0 %; WISE 0855 >= 1"/yr AB 18 15/24.
- Reaching 99 % in the Epsilon Indi B bin with seeds 1 and 101 together would have needed at most 1 miss in 182;
  there are 9.

The 7 misses of seed 101 in the Epsilon Indi B bin (>= 0.3"/yr, AB 12-14), with the harness's own miss reasons:

| AB | speed "/yr | reason |
|---|---|---|
| 12 | 0.3 | blended (a real source 0.7" away); rejected as a blend / colour shift |
| 12 | 1 | blended (a real source 5.7" away) |
| 12 | 2 | in the wings of a saturated star (rejected) |
| 12 | 40 | too faint for the measurement: season S/N 0 in the oracle, only 72 exposures cover the track, not in the source list |
| 13 | 0.3 | blended (a source with >= 30 % of its S/N 5.8" away; rejected) |
| 13 | 40 | rejected for crowding: 9" from the track of a brighter moving source |
| 14 | 2 | in the wings of a saturated star (rejected) |

So 5 of the 7 are next to a real source (3 blends, 2 saturated-star wings), which the rule counts as misses, as in every
round. The 6 misses of the WISE 0855 bin >= 0.3"/yr AB 12-14 are: 3 blends, 1 saturated-star zone, 1 too slow
(0.3"/yr at AB 14, not in the source list), 1 too faint (a 20"/yr track covered by 4 exposures).

## Motion: recovered / injected (new seeds; WISE 0855 AB 15 holds seeds 101 and 102)

Epsilon Indi B

| speed "/yr | AB 12 | AB 13 | AB 14 | AB 15 | AB 16 | AB 17 | AB 18 |
|---|---|---|---|---|---|---|---|
| 0.02 | 0/3 | 0/3 | 0/4 | 0/3 | 0/4 | 0/4 | 0/4 |
| 0.05 | 0/4 | 0/4 | 0/4 | 0/3 | 0/4 | 0/4 | 0/4 |
| 0.1 | 2/4 | 4/4 | 2/4 | 1/4 | 0/4 | 0/4 | 0/3 |
| 0.2 | 2/4 | 4/4 | 2/2 | 3/4 | 3/4 | 0/4 | 0/2 |
| 0.3 | 3/4 | 3/4 | 3/3 | 3/4 | 2/4 | 3/3 | 0/4 |
| 0.5 | 3/3 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 0/3 |
| 1 | 3/4 | 3/3 | 4/4 | 3/4 | 3/4 | 2/3 | 1/4 |
| 2 | 3/4 | 3/3 | 3/4 | 4/4 | 4/4 | 1/3 | 1/3 |
| 5 | 4/4 | 4/4 | 4/4 | 4/4 | 3/3 | 2/3 | 2/4 |
| 10 | 4/4 | 4/4 | 4/4 | 4/4 | 2/4 | 3/4 | 2/4 |
| 20 | 4/4 | 4/4 | 3/3 | 4/4 | 3/3 | 4/4 | 3/4 |
| 40 | 3/4 | 3/4 | 4/4 | 4/4 | 3/3 | 3/4 | 0/4 |

WISE 0855

| speed "/yr | AB 12 | AB 13 | AB 14 | AB 15 | AB 16 | AB 17 | AB 18 |
|---|---|---|---|---|---|---|---|
| 0.02 | 0/4 | 0/2 | 0/4 | 0/7 | 0/4 | 0/4 | 0/4 |
| 0.05 | 0/4 | 0/4 | 0/4 | 0/8 | 0/4 | 0/4 | 0/4 |
| 0.1 | 1/4 | 0/4 | 0/4 | 1/8 | 0/4 | 0/4 | 0/3 |
| 0.2 | 4/4 | 4/4 | 2/2 | 7/8 | 1/4 | 0/4 | 0/2 |
| 0.3 | 4/4 | 4/4 | 3/4 | 7/8 | 4/4 | 0/4 | 0/4 |
| 0.5 | 2/3 | 3/4 | 3/4 | 6/8 | 3/4 | 2/3 | 0/4 |
| 1 | 4/4 | 4/4 | 4/4 | 8/8 | 4/4 | 3/4 | 0/3 |
| 2 | 4/4 | 3/3 | 4/4 | 6/6 | 4/4 | 3/3 | 2/2 |
| 5 | 4/4 | 4/4 | 4/4 | 7/7 | 4/4 | 3/3 | 4/4 |
| 10 | 4/4 | 4/4 | 4/4 | 7/8 | 2/3 | 4/4 | 4/4 |
| 20 | 4/4 | 4/4 | 3/4 | 8/8 | 3/3 | 4/4 | 4/4 |
| 40 | 3/4 | 3/3 | 4/4 | 6/8 | 3/4 | 3/4 | 3/4 |

Barnard's Star

| speed "/yr | AB 12 | AB 14 | AB 16 |
|---|---|---|---|
| 0.02 | 0/4 | 0/4 | 0/4 |
| 0.05 | 0/4 | 0/4 | 0/3 |
| 0.1 | 1/4 | 1/4 | 0/4 |
| 0.2 | 1/4 | 3/4 | 1/4 |
| 0.3 | 2/4 | 1/4 | 1/4 |
| 0.5 | 2/4 | 2/4 | 2/4 |
| 1 | 3/4 | 4/4 | 3/4 |
| 2 | 3/4 | 3/4 | 4/4 |
| 5 | 4/4 | 4/4 | 3/4 |
| 10 | 4/4 | 4/4 | 4/4 |
| 20 | 4/4 | 4/4 | 4/4 |
| 40 | 4/4 | 4/4 | 3/4 |

This is the first injection measurement of finder v1.1 in the Barnard's Star field (round v1.1 did not re-run it).

## Brightness changes, miss reasons, false candidates (new seeds)

- Brightness changes by size, all fields and magnitudes pooled: +3 % 0/33, +5 % 7/33, +10 % 25/35, +20 % 25/33,
  +50 % 27/31, +100 % 30/33, appearing 26/32, disappearing 16/29 (per field and AB in the evidence file).
- Miss reasons (a miss can have more than one): motion too slow (< 5 x the achievable motion error) 229, blended (a
  source within 8") 60, not in the deep-stack source list 56, rejected 44, saturated-star zone 20, too faint (season
  S/N < 10) 15, not detected 8; brightness not detected 63, rejected 15, blended 13, not in the source list 11,
  saturated-star zone 5.
- False candidates by kind and detector (49): variable V 16, variable B+V 13, motion A 6, appearing A 3, appearing V 3,
  variable A+B+V 3, disappearing A 2, motion D 2, motion A+B+D 1. Per field: Barnard's Star 22 in 3 runs, Epsilon Indi B
  20 in 7 runs, WISE 0855 7 in 8 runs. V6 has no pass threshold for false candidates.

## Evidence and how to repeat

- `site/data/verify/evidence/injection_v11.csv` (new; `injection.csv` is not changed): per field, AB, seed and bin the
  recovered, injected and no-data counts (motion by speed, brightness by change), the false candidates of each run, and
  the pooled bins above (rows "pooled bin, ..."). The 5 seed-1 runs of the reduced re-run are included, marked
  "seed 1 (reduced re-run)".
- `pipeline/detect/tests/inj_seeds.py` makes that file and the tables above from the run outputs:
  `python3 -I pipeline/detect/tests/inj_seeds.py --new <new runs> --old <round v1.1 runs> --csv <file>`.
  The motion and brightness tables and the miss reasons come from `pipeline/detect/tests/inj_report.py <new runs>`.
- One run: the command in the plan, e.g. `... injection.py --out <dir> --field eps_indi_b --mags 12 --seed 101`.
- `site/data/verify/tests.json`, test V6: the numbers are in a new block `v11_new_seeds`; the v0, v1 and reduced
  re-run numbers, the V6 text and its status stay as they were. `verify.html` shows the new sentence only with
  `?extra=1` until the team lead has read it (`extra_only` in the block, `laterLines` in `site/js/verify_tests.js`).
