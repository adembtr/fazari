# Injection test V6 with finder v1.1 on new seeds: plan written before the runs

Written 2026-11-15 11:05-11:15 +03 and committed alone, before any run with a new seed. Its git commit and the GitHub
push time are the proof of the order; they are recorded in `pipeline/INJECTION_V11.md` (the results file), not here,
so that this file is not edited after the commit.

What was run before writing this: one timing run, WISE 0855 AB 14 with the OLD seed 1 (11:04-11:06, not counted).
Its output is identical to the round v1.1 run of the same field, magnitude and seed (every record equal, run time
apart: 94.5 s now, 195.9 s at night), so the code and data below reproduce round v1.1. No run with a seed of this
plan has been made.

## Question

Test V6 (injection recovery) failed with finder v1.1 on a reduced re-run: 5 of the 20 runs of round v1, seed 1, the
same injected positions as v1. Best bin 89/91 = 97.8 % (Epsilon Indi B, >= 0.3"/yr, AB 12-14), below the 99 % target.
Does the finder, unchanged, reach the target on new random positions, and what do the other 15 runs of the V6 grid
give with finder v1.1?

## Finder and harness (unchanged)

- Code: `dev` at fd233c6, run from a separate worktree. `pipeline/detect` and `pipeline/blink.py` are identical to the
  commit tested in round v1.1 (a5de792; candidate finder v1.1 is f50d77d) apart from `pipeline/detect/asteroids.py`,
  which the injection test does not import (md5 of every other file equal to the round v1.1 list). Git tree of
  `pipeline/detect` at fd233c6: 80b22f49645398f7bddb6e5229b8cd5430377e2c (a5de792: a478696890e628d45b46b77c88d013f9be519bb0;
  the only difference is asteroids.py).
- Thresholds: frozen at TEST-READY v1 16:58, unchanged in round v1.1, not changed here.
- Harness: `pipeline/detect/tests/injection.py` (md5 2d85b183f8d57a39495a2075f34158a4) and `pipeline/detect/inject.py`
  (27310398166afe88536915cdfad51b08), unchanged. Detectors A, B, D, V, no asteroid query, as in every earlier round.
  Recovered mover: a non-artifact motion candidate within 5" whose velocity is within max(3 sigma, 25 % of the speed,
  0.02"/yr) of the injected one, at >= 5 sigma. Recovered brightness change: a variable / appearing / disappearing
  candidate within 5". False candidate: a candidate or variable more than 6" from every injected track
  (`tests/inj_report.py`).
- Command per run (one field, one magnitude, one seed), from the worktree, with `FAZARI_CACHE` set to the local cache
  that holds the EPSF tables and one BLAS thread per process:
  `nice -n 15 uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow python -I -u pipeline/detect/tests/injection.py --out <dir> --field <field> --mags <AB> --seed <seed>`

## Data (only pixel data already on disk; nothing is downloaded)

- SPHEREx cutouts already on this computer (`veri/real_spherex/`, next to the repository): Epsilon Indi B 458 exposures,
  WISE 0855 258, Barnard's Star 358. Gaia lists: `site/data/<field>/gaia_field.json` (in the repository).
- These are the three fields of V6 in every earlier round. Other fields with cutouts on disk (R Dra, RW Aur, the job
  fields) are not used: the bins of V6 are defined on these three fields.

## Grid (the V6 grid of rounds v0 and v1)

- Fields and AB magnitudes: Epsilon Indi B 12, 13, 14, 15, 16, 17, 18, 19; WISE 0855 12-19 (same eight); Barnard's
  Star 12, 14, 16, 18. 20 runs per seed.
- Per run (fixed in `injection.py`): 48 movers, 4 at each speed 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10, 20,
  40"/yr, random position angle; 16 brightness sources: +3, +5, +10, +20, +50, +100 % in the later half of the seasons
  (2 each), 2 appearing, 2 disappearing. Positions random, >= 45" apart, >= 45" from the stack edge, outside
  saturated-star zones (+10").
- Seeds: 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, in this order, as many as the time allows. Never used
  before with `tests/injection.py`: every earlier injection run of this test used seed 1 (rounds v0, v1, v1.1 and the
  development runs) and round v0 also seed 2 (Epsilon Indi B); a search of this computer for `inj_*_s<seed>.json`
  finds no other seed of this harness (seeds 1-24 of the Planet X injections belong to another harness and other
  fields). Positions come from `numpy.random.default_rng(1000 * seed + 10 * AB)` (101120 ... 110190; seeds 1 and 2
  give 1120-1190 and 2120-2190), the added noise from `default_rng(seed)`. So every position is new.

## Run order and load

- Seed after seed (101 first). Inside one seed, fields and magnitudes interleaved, bright first, so that a stop in
  the middle of a seed leaves whole bins:
  Eps Indi B 12, WISE 12, Barnard 12, Eps Indi B 13, WISE 13, Eps Indi B 14, WISE 14, Barnard 14, Eps Indi B 15,
  WISE 15, Eps Indi B 16, WISE 16, Barnard 16, Eps Indi B 17, WISE 17, Eps Indi B 18, WISE 18, Barnard 18,
  Eps Indi B 19, WISE 19.
- One driver process with at most 2 worker processes (one run each), `nice -n 15`, one BLAS thread each. Before each
  start: available memory >= 6000 MB and CPU package < 90 C, otherwise wait. Run outputs stay outside the repository.

## Stop time

- **13:20 +03 (2026-11-15).** No run is started after it, and no run is started if its expected time (1.1 x the time
  of the same field and magnitude in an earlier seed, else of the longest finished run of that field, else a first
  guess: Epsilon Indi B 300 s, WISE 0855 150 s, Barnard 700 s) would end after it. A run still going at 13:20 is
  stopped and not counted (a run's result file is written only when the run is complete). If the list ends earlier,
  the work ends earlier.

## What will be reported (pipeline/INJECTION_V11.md)

- The plan commit and its push time; what ran, what was stopped, what was left out.
- Per run: field, AB, seed, movers recovered / injected, brightness changes recovered / injected, false candidates,
  track fragments, seconds.
- Totals over all finished runs and over the seeds that finished all 20 runs (comparable with the 20-run totals of
  rounds v0 and v1: 466 and 473 of 868 movers).
- Motion recovered / injected per speed and AB, brightness per change and AB, the motion thresholds of
  `inj_report.py`, miss reasons, false candidates by kind and detector.
- The bins below for the new seeds alone and for all finder v1.1 runs together.
- Evidence: a new file `site/data/verify/evidence/injection_v11.csv` (per field, AB, seed and bin: recovered and
  injected; false candidates per run). `injection.csv` is not changed. `tests.json` V6 gets a new block with these
  numbers; the numbers already there (v0, v1, the v1.1 reduced re-run) stay as they are.

## How the V6 rule is applied (the rule is not changed)

- Rule as in rounds v0, v1 and v1.1: V6 passes if the best bin reaches the 99 % target; otherwise it fails.
  Recovery in a bin = movers recovered / movers injected, pooled over the runs in the bin; injections with no data
  at their position are left out; blends and saturated-star zones count as misses.
- Bins (the list of round v0, per field): >= 0.3"/yr AB 12-14; >= 0.3"/yr AB 12-16; >= 1"/yr AB 12-17;
  >= 1"/yr AB 18; >= 5"/yr AB 18. Magnitudes are those of the field's grid (Barnard: 12 and 14 for AB 12-14, as in
  round v1). Best bin = the bin with the highest fraction.
- Data that decide the status: every finder v1.1 injection run, i.e. the 5 seed-1 runs of the reduced re-run
  (15 Nov 02:21-02:43: Epsilon Indi B AB 12, 13, 14, WISE 0855 AB 14, 18) and the new-seed runs finished by the stop
  time. A seed enters a bin only if every magnitude of that bin was run with that seed in that field (so seed 1
  enters Epsilon Indi B AB 12-14 and the WISE 0855 AB 18 bins only). A bin with no complete seed is not evaluated.
- The new seeds alone are reported next to it with the same bins; they do not decide the status.
- False candidates have no pass threshold in V6; they are reported, not judged.
- Nothing in this file is changed after the runs start. Any deviation is written in `pipeline/INJECTION_V11.md` with
  its time and reason.
