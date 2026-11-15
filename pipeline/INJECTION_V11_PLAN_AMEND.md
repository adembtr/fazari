# Injection test V6 with finder v1.1 on new seeds: amendment, two more seeds

Added after the 13:05 stop, at Adem's request (~12:10, relayed by the coordinator: "two more seeds for V6, from the
cache"); finder v1.1, thresholds and grid unchanged. Written 2026-11-15 13:15-13:25 +03 and committed alone, before
any run under it. The plan [`INJECTION_V11_PLAN.md`](INJECTION_V11_PLAN.md) (e9b5dec) is not edited; this file adds
runs to it and changes nothing else. Its git commit and GitHub push time are recorded in `pipeline/INJECTION_V11.md`.

What was known when this was written: the results of the 18 runs of the plan (17 of seed 101, 1 of seed 102), published
in `pipeline/INJECTION_V11.md` (4d283b1, 13:12 +03): best bin of all finder v1.1 runs 173/182 = 95.1 %, V6 fails. The
request to add seeds came at ~12:10, while those runs were still going and before any of them was analysed. The runs
below are the next ones of the plan's own list, in its order; none is chosen from a result.

## Runs (in this order)

1. The 3 runs of seed 101 not reached before the 13:05 stop: Barnard's Star AB 18, Epsilon Indi B AB 19, WISE 0855
   AB 19.
2. The 19 remaining runs of seed 102 (WISE 0855 AB 15 of seed 102 is already done), in the plan's order:
   Eps Indi B 12, WISE 12, Barnard 12, Eps Indi B 13, WISE 13, Eps Indi B 14, WISE 14, Barnard 14, Eps Indi B 15,
   Eps Indi B 16, WISE 16, Barnard 16, Eps Indi B 17, WISE 17, Eps Indi B 18, WISE 18, Barnard 18, Eps Indi B 19,
   WISE 19.
3. Then seed 103, all 20 runs, in the plan's order (Eps Indi B 12, WISE 12, Barnard 12, ... , Eps Indi B 19, WISE 19).

Seeds 104-110 are not run under this amendment. The 18 finished runs are not run again.

## Unchanged from the plan

- Code: the worktree of the plan's runs, at 4d283b1. `pipeline/detect` and `pipeline/blink.py` are identical to
  fd233c6 (the code of the 18 runs) apart from the added analysis script `pipeline/detect/tests/inj_seeds.py`, which
  the injection run does not import. `tests/injection.py` md5 2d85b183f8d57a39495a2075f34158a4, `inject.py`
  27310398166afe88536915cdfad51b08, as in the plan.
- Thresholds, harness, recovery and false-candidate definitions, the command per run, the per-run grid (48 movers,
  16 brightness sources), the position and noise seeds (`default_rng(1000 * seed + 10 * AB)`, `default_rng(seed)`).
- Data: only the SPHEREx cutouts and Gaia lists already on this computer (the cache). Nothing is downloaded.
- Analysis: `pipeline/detect/tests/inj_seeds.py` and `pipeline/detect/tests/inj_report.py`, as for the 18 runs.
- Decision rule of V6: best bin >= 99 % passes, otherwise fails. The data that decide the status are every finder
  v1.1 injection run: the 5 seed-1 runs of the reduced re-run, the 18 runs of the plan and the runs of this amendment
  finished by the stop time. Same bins; a seed enters a bin only if every magnitude of that bin was run with that seed
  in that field; a bin with no complete seed is not evaluated. The new seeds alone are reported next to it and do not
  decide the status. False candidates are reported, not judged.

## Start, load and stop

- Start: after the asteroid re-run that holds the heavy slot has ended (by 15:30 at the latest), with available memory
  >= 6000 MB and the CPU package < 90 C, as in the plan.
- At most 2 worker processes, `nice -n 15`, one BLAS thread each, pinned to the efficiency cores 18-19. A heat guard
  pauses them (SIGSTOP / SIGCONT) while the package is >= 90 C, and no run starts at >= 90 C. This does not change a
  result.
- **Stop time 18:00 +03 (2026-11-15).** As in the plan: no run is started if its expected time (1.1 x the time of the
  same field and magnitude in an earlier seed, else of the longest finished run of that field) would end after it;
  the next run of the list that fits is started instead. A run still going at 18:00 is stopped and not counted.

## What will be reported

A dated section "Amendment run" appended to `pipeline/INJECTION_V11.md` (the earlier sections stay as they are): the
commit and push time of this file, what ran, what was not started, per-run rows, totals and bins of all finder v1.1
runs together and of the new seeds alone, and the V6 status by the rule above. Rows appended to
`site/data/verify/evidence/injection_v11.csv` (earlier rows unchanged), a new V6 block next to `v11_new_seeds` in
`site/data/verify/tests.json` (earlier numbers unchanged), and the V6 row of `pipeline/ACCURACY.md`.
