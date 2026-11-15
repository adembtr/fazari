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

## Amendment run (2026-11-15, 15:30-17:57 +03)

Plan: [`INJECTION_V11_PLAN_AMEND.md`](INJECTION_V11_PLAN_AMEND.md), commit 015b291, pushed to `dev` on GitHub at
2026-11-15 10:16:15 UTC (13:16:15 +03, GitHub repository activity), before any run under it. The file says "written
13:15-13:25"; it was in fact written about 13:13-13:16 (the push time is the record). Finder v1.1, thresholds, grid,
harness and the V6 rule unchanged. The sections above are not changed; the numbers below are as they came out.

### Result in short

- **42 runs, the whole amendment list**: the 3 runs of seed 101 not reached before 13:05 (Barnard's Star AB 18,
  Epsilon Indi B AB 19, WISE 0855 AB 19), the 19 remaining runs of seed 102 and all 20 runs of seed 103. None was left
  out for the 18:00 stop, none was stopped. Seeds 101, 102 and 103 now each have all 20 runs of the V6 grid.
- **2688 bodies injected** (42 runs x 64: 2016 movers, 672 brightness changes); 235 fell where there is no data and are
  left out, as in every round. Recovered: **932 of 1855 movers**, **318 of 598 brightness changes**; **103 false
  candidates** (plus 60 track fragments of fast injected movers, not counted as false).
- All 60 new-seed runs (seeds 101-103) together: movers 1435/2673, brightness changes 474/857, false candidates 152,
  track fragments 92.
- Per complete seed, 20 runs each (comparable with the 20-run totals of round v0, 466/868 movers, and round v1,
  473/868, both seed 1): seed 101 movers 476/883, brightness 151/283, false 56; seed 102 486/893, 162/287, 52;
  seed 103 473/897, 161/287, 44 (round v0: brightness 140/287, false 126; round v1: 158/287, 88).
- Best bin, **all finder v1.1 runs** (the data that decide the status): Epsilon Indi B, at least 0.3"/yr, AB 12-14,
  seeds 1, 101, 102 and 103: **346/359 = 96.4 %** (95 % lower limit 94.3 %), below the 99 % target. Reaching 99 % with
  359 movers would allow at most 3 misses; there are 13.
- **V6 stays "fail"** by its unchanged rule. The new seeds alone give the same answer: best bin 257/268 = 95.9 %, the
  same Epsilon Indi B bin.

### What ran

| | |
|---|---|
| Code | 4d283b1 (`pipeline/detect` and `pipeline/blink.py` as in the 18 runs above; `tests/injection.py` and `inject.py` md5 as in the plan) |
| Runs | 15:30:40 - 17:56:43 +03 after the asteroid re-run had ended; 2 workers on CPU 18-19, `nice -n 15`, one BLAS thread each |
| Heat | the guard never paused a worker (no two readings >= 90 C in a row); the driver waited twice, 10 s each, at 94-95 C |
| Not started | none |
| Stopped unfinished | none counted (see the line below) |

- Outage, 15:40: the driver stopped because its code folder (the worktree of the earlier runs) was moved away in a
  clean-up; restarted at 15:43:41 from a git archive of the same commit 4d283b1 (check: WISE 0855 AB 19 seed 101 re-run
  from it gave the same record); Epsilon Indi B AB 12 seed 102, running at 15:40, was stopped and run again from the
  start; Barnard's Star AB 18 seed 101, which ended at 15:40:20, was re-run as a check and gave the same record (counted
  once).
- Changes from "What will be reported" in the amendment (instruction from the coordinator at ~13:35, after the team
  lead decided to show the earlier block on the site; decided before any amendment run, no result changes): the rows
  go into a new evidence file `site/data/verify/evidence/injection_v11_amend.csv` instead of being appended to
  `injection_v11.csv`, which is not changed; `pipeline/ACCURACY.md` is not changed; the numbers are in a new
  `tests.json` V6 block `v11_amend`, shown on `verify.html` only with `?extra=1`.

### Per run (amendment runs)

| field | AB | seed | movers | brightness | false | track fragments | seconds |
|---|---|---|---|---|---|---|---|
| eps_indi_b | 19 | 101 | 1/38 | 1/12 | 1 | 1 | 106.4 |
| wise0855 | 19 | 101 | 1/36 | 0/12 | 1 | 1 | 67.3 |
| barnard | 18 | 101 | 2/37 | 2/14 | 7 | 8 | 544.5 |
| eps_indi_b | 12 | 102 | 38/46 | 13/14 | 2 | 0 | 511.2 |
| eps_indi_b | 13 | 102 | 34/44 | 12/15 | 6 | 1 | 406.6 |
| eps_indi_b | 14 | 102 | 36/46 | 13/14 | 0 | 0 | 405.0 |
| eps_indi_b | 15 | 102 | 35/46 | 11/13 | 2 | 0 | 327.3 |
| eps_indi_b | 16 | 102 | 30/46 | 9/13 | 1 | 0 | 317.7 |
| eps_indi_b | 17 | 102 | 24/44 | 7/12 | 2 | 1 | 285.8 |
| eps_indi_b | 18 | 102 | 12/43 | 6/13 | 0 | 3 | 244.3 |
| eps_indi_b | 19 | 102 | 0/40 | 1/12 | 2 | 0 | 87.7 |
| wise0855 | 12 | 102 | 31/45 | 11/15 | 1 | 1 | 227.7 |
| wise0855 | 13 | 102 | 34/45 | 7/15 | 1 | 0 | 211.3 |
| wise0855 | 14 | 102 | 34/46 | 10/16 | 2 | 1 | 199.0 |
| wise0855 | 16 | 102 | 27/48 | 6/14 | 1 | 1 | 183.9 |
| wise0855 | 17 | 102 | 20/45 | 6/13 | 1 | 0 | 149.4 |
| wise0855 | 18 | 102 | 11/41 | 5/15 | 1 | 2 | 123.0 |
| wise0855 | 19 | 102 | 4/38 | 0/15 | 1 | 0 | 83.1 |
| barnard | 12 | 102 | 32/48 | 12/16 | 7 | 0 | 916.5 |
| barnard | 14 | 102 | 27/48 | 10/16 | 10 | 0 | 879.4 |
| barnard | 16 | 102 | 24/48 | 10/16 | 5 | 1 | 776.0 |
| barnard | 18 | 102 | 2/40 | 5/16 | 5 | 16 | 434.2 |
| eps_indi_b | 12 | 103 | 34/43 | 9/13 | 5 | 1 | 493.6 |
| eps_indi_b | 13 | 103 | 34/44 | 14/16 | 3 | 0 | 418.7 |
| eps_indi_b | 14 | 103 | 33/45 | 10/15 | 3 | 0 | 441.6 |
| eps_indi_b | 15 | 103 | 30/44 | 11/15 | 0 | 2 | 301.3 |
| eps_indi_b | 16 | 103 | 32/46 | 10/14 | 2 | 0 | 352.2 |
| eps_indi_b | 17 | 103 | 26/48 | 9/14 | 0 | 0 | 352.6 |
| eps_indi_b | 18 | 103 | 11/43 | 7/15 | 1 | 2 | 207.5 |
| eps_indi_b | 19 | 103 | 1/43 | 2/11 | 0 | 0 | 89.2 |
| wise0855 | 12 | 103 | 32/46 | 9/15 | 0 | 0 | 232.5 |
| wise0855 | 13 | 103 | 33/45 | 10/15 | 0 | 1 | 215.0 |
| wise0855 | 14 | 103 | 32/46 | 9/15 | 0 | 1 | 207.3 |
| wise0855 | 15 | 103 | 31/45 | 6/14 | 1 | 0 | 198.6 |
| wise0855 | 16 | 103 | 24/47 | 6/14 | 1 | 0 | 170.0 |
| wise0855 | 17 | 103 | 20/46 | 7/16 | 1 | 0 | 161.9 |
| wise0855 | 18 | 103 | 15/43 | 4/16 | 1 | 1 | 124.2 |
| wise0855 | 19 | 103 | 0/41 | 0/10 | 1 | 0 | 59.7 |
| barnard | 12 | 103 | 28/48 | 12/16 | 9 | 1 | 910.8 |
| barnard | 14 | 103 | 28/48 | 13/16 | 7 | 2 | 921.2 |
| barnard | 16 | 103 | 25/48 | 7/16 | 4 | 0 | 791.3 |
| barnard | 18 | 103 | 4/38 | 6/11 | 5 | 12 | 518.5 |

Movers and brightness changes: recovered / injected, injections with no data at their position left out. The 18
earlier new-seed runs and the 5 seed-1 runs are in the table above. AB 19 and Barnard's Star AB 18 are the faint end
of the grid (movers 2/121 at Epsilon Indi B AB 19, 5/115 at WISE 0855 AB 19, 8/115 at Barnard's Star AB 18).

### V6 bins after the amendment (rule unchanged: best bin >= 99 % passes)

Movers recovered / injected at or above the speed, pooled over the magnitudes of the field's grid and over the seeds
that ran every magnitude of the bin. 95 % low = one-sided Clopper-Pearson lower limit.

| field | bin | new seeds alone (101-103) | 95 % low | all finder v1.1 runs (seeds) | 95 % low |
|---|---|---|---|---|---|
| Epsilon Indi B | >= 0.3"/yr, AB 12-14 | 257/268 = 95.9 % | 93.3 % | **346/359 = 96.4 %** (1, 101, 102, 103) | 94.3 % |
| Epsilon Indi B | >= 0.3"/yr, AB 12-16 | 423/448 = 94.4 % | 92.3 % | 423/448 = 94.4 % (101, 102, 103) | 92.3 % |
| Epsilon Indi B | >= 1"/yr, AB 12-17 | 369/399 = 92.5 % | 89.9 % | 369/399 = 92.5 % (101, 102, 103) | 89.9 % |
| Epsilon Indi B | >= 1"/yr, AB 18 | 32/64 = 50.0 % | 39.1 % | 32/64 = 50.0 % (101, 102, 103) | 39.1 % |
| Epsilon Indi B | >= 5"/yr, AB 18 | 26/44 = 59.1 % | 45.6 % | 26/44 = 59.1 % (101, 102, 103) | 45.6 % |
| WISE 0855 | >= 0.3"/yr, AB 12-14 | 260/274 = 94.9 % | 92.1 % | 260/274 = 94.9 % (101, 102, 103) | 92.1 % |
| WISE 0855 | >= 0.3"/yr, AB 12-16 | 420/458 = 91.7 % | 89.3 % | 420/458 = 91.7 % (101, 102, 103) | 89.3 % |
| WISE 0855 | >= 1"/yr, AB 12-17 | 383/407 = 94.1 % | 91.8 % | 383/407 = 94.1 % (101, 102, 103) | 91.8 % |
| WISE 0855 | >= 1"/yr, AB 18 | 43/62 = 69.4 % | 58.4 % | 59/86 = 68.6 % (1, 101, 102, 103) | 59.4 % |
| WISE 0855 | >= 5"/yr, AB 18 | 33/43 = 76.7 % | 63.7 % | 45/59 = 76.3 % (1, 101, 102, 103) | 65.4 % |
| Barnard's Star | >= 0.3"/yr, AB 12-14 | 152/192 = 79.2 % | 73.8 % | 152/192 = 79.2 % (101, 102, 103) | 73.8 % |
| Barnard's Star | >= 0.3"/yr, AB 12-16 | 224/288 = 77.8 % | 73.4 % | 224/288 = 77.8 % (101, 102, 103) | 73.4 % |
| Barnard's Star | >= 1"/yr, AB 12-17 | 184/216 = 85.2 % | 80.6 % | 184/216 = 85.2 % (101, 102, 103) | 80.6 % |
| Barnard's Star | >= 1"/yr, AB 18 | 8/63 = 12.7 % | 6.5 % | 8/63 = 12.7 % (101, 102, 103) | 6.5 % |
| Barnard's Star | >= 5"/yr, AB 18 | 8/45 = 17.8 % | 9.2 % | 8/45 = 17.8 % (101, 102, 103) | 9.2 % |

- **Status by the rule: best bin of all finder v1.1 runs 346/359 = 96.4 % < 99 % -> V6 fails.**
- The 13 misses of that bin: 2 of seed 1 and 7 of seed 101 (listed above), and 4 of seeds 102 and 103:

| seed | AB | speed "/yr | reason (the harness's own miss reasons) |
|---|---|---|---|
| 102 | 12 | 10 | not in the deep-stack source list; rejected for crowding, 10" from the track of a brighter moving source |
| 102 | 13 | 0.5 | blended (a source within 8"); rejected: detector halves disagree, season positions not on a straight line |
| 103 | 14 | 2 | in the wings of a saturated star (rejected) |
| 103 | 14 | 2 | rejected by the motion model: season positions not on a straight line (parallax or blend?) |

- Miss reasons over all 60 new-seed runs (a miss can have more than one): motion too slow (< 5 x the achievable motion
  error) 831, not in the deep-stack source list 461, blended 247, rejected 148, too faint (season S/N < 10) 123,
  saturated-star zone 62, not detected 29; brightness not detected 192, not in the source list 97, blended 64,
  rejected 57, saturated-star zone 13.
- False candidates of the 60 new-seed runs by kind and detector (152): variable V 49, variable B+V 46, motion A 24,
  variable A+B+V 7, appearing A 6, appearing V 6, motion D 6, disappearing A 4, motion D+V 2, variable A+V 1, motion
  A+B+D 1. V6 has no pass threshold for false candidates.

### Evidence and how to repeat

- `site/data/verify/evidence/injection_v11_amend.csv` (new): the same columns as `injection_v11.csv`, for the 42
  amendment runs (set "new seed (amendment)"), then the pooled bins after the amendment (rows "pooled bin after
  amendment, new seeds alone" and "pooled bin after amendment, all finder v1.1 runs"). With `injection_v11.csv` it
  holds every run.
- Made by `python3 -I pipeline/detect/tests/inj_seeds.py --new <new-seed runs> --old <round v1.1 runs> --csv
  injection_v11_amend.csv --amend-of site/data/verify/evidence/injection_v11.csv` (the option `--amend-of` was added
  for this; without it the script gives the same output as before). Motion and brightness tables and miss reasons:
  `pipeline/detect/tests/inj_report.py <new-seed runs>`.
- `site/data/verify/tests.json`, test V6: new block `v11_amend` with `"extra_only": true`; the V6 text, numbers,
  status and the block `v11_new_seeds` are not changed.
