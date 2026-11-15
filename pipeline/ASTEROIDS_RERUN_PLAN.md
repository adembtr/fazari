# Test V8 re-run with the star-mask fix, and 24 new fields: plan (written before the run)

Written 2026-11-15 before any of the runs below and before any pixel of a new field was read. Approved by the team
lead ("Evet, başlasın"). Results will go to `pipeline/ASTEROIDS_RERUN.md`; the V8 numbers of round v1 stay as they are
(V < 17: 47 / 53, V < 18: 101 / 132, V < 19: 205 / 451, V < 20: 217 / 1400; 96 false detections) and are shown next to
the new ones.

## Code

- Repository state: `dev` at 1ebd6dd. Detection code: `pipeline/detect/asteroids.py` of commit 7eee529
  (git blob fe6a029), run with `pipeline/find_asteroids.py` unchanged.
- The one change against the V8 run (blob c171936, 7eee529^): `STAR_MASK_NSIG = 10.0` (V8: `None`, the whole 7 x 7
  EPSF fit stamp). Stamp pixels outside the central 3 x 3 where the reference is brighter than 10 x the difference
  noise, and their direct neighbours, are left out of the EPSF fits (single exposures, visit stack and its
  per-sub-exposure fits). Why: `pipeline/ASTEROID_MISSES.md`, cause B.
- No threshold or decision rule changes: `CHI2_MAX` 3, `CHI2_SNR` 25, `STATIC_MAX` 1, `STATIC_MIN` -0.5, `Z_DET` 4,
  `Z_CONFIRM` 5, `Z_STACK` 5, `LINK_PX` 2, `MATCH_PX` 2, `MODEL_C` 0.10, `V_ANALYSE` 20.5 as in V8.
- Helper modules changed after the V8 run (`blink.py`, `fetch_region.py`, `schema.py`: engine and schema work). The
  trial of 7eee529 reproduced the stored V8 counts of 8 fields exactly with `STAR_MASK_NSIG = None`, so they do not
  change the detection.
- New tool (no detection code): `pipeline/asteroid_rerun.py` (`select`: the new fields; `compare`: the tables below).
  It is committed with the results.

## Part 1: the same 24 fields (F01-F24), from the cache

```
UV="uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow python -I"
$UV pipeline/find_asteroids.py run --no-track --redo --only F01,...,F24
$UV pipeline/find_asteroids.py track --only F01,...,F24
```

- Every box, header and SkyBoT cone of these fields is in `cache/asteroids/`; the detection reads 0 bytes. The
  tracklet step searches a second visit for objects that are recovered now and were not in V8: about 1 MB, counted
  in the data cap.
- `--redo` writes new time-stamped run files; the V8 run files stay (`F01_20261114T163133.json` ... the newest file
  of each field before the V8 report of 2026-11-14 13:41:58 UTC; `asteroid_rerun.py compare` reproduces 47 / 53,
  101 / 132, 205 / 451, 217 / 1400 and 96 false detections from them).
- Part 1 runs first: it decides the fix.

## Part 2: 24 new fields

Selection rule (fixed here, before any of their pixels is read): the same criteria as `select_fields` in
`detect/asteroids.py`: visits on D2 / D3 whose 4 sub-exposures are within 2 deg of the ecliptic (2,056 visits in the
static sky index), the mission span MJD 60790.164-61316.620 cut into 24 equal bins of 21.936 d, in each bin the visit
nearest the bin centre within one bin width, detectors alternating D2 / D3, at least 3 reference visits of the same
detector >= 1 day away. Two differences only: the bin centres are moved by half a bin (to t0 + (i + 1) x 21.936 d),
and the 24 visits of V8 are left out. The same code with the centres not moved gives the 24 V8 fields again (checked).

The list, from the static sky index (`cache/sky_index/catalog.csv.gz` and `site/index`, no pixel read):

| Field | bin | Visit | Det | Date (UTC) | λ_ecl | β | ref. visits |
|---|---|---|---|---|---|---|---|
| F25 | 0 | 2025W20_2D_0297 | D2 | 2025-05-17 06:45 | 330.0° | -0.12° | 13 |
| F26 | 1 | 2025W23_2B_0496 | D3 | 2025-06-07 19:37 | 332.8° | +1.18° | 17 |
| F27 | 2 | 2025W26_2A_0618 | D2 | 2025-06-29 15:46 | 213.4° | -0.53° | 17 |
| F28 | 3 | 2025W30_1B_0191 | D3 | 2025-07-22 01:50 | 237.2° | +0.33° | 21 |
| F29 | 4 | 2025W33_1B_0318 | D2 | 2025-08-12 17:09 | 53.3° | -1.30° | 18 |
| F30 | 5 | 2025W36_1A_0403 | D3 | 2025-09-02 18:33 | 69.4° | +0.20° | 16 |
| F31 | 6 | 2025W39_1A_0662 | D2 | 2025-09-25 11:00 | 93.3° | -0.12° | 20 |
| F32 | 7 | 2025W42_2A_0213 | D3 | 2025-10-17 11:08 | 112.8° | -1.18° | 11 |
| F33 | 8 | 2025W45_2A_0442 | D2 | 2025-11-08 12:51 | 140.0° | -1.30° | 12 |
| F34 | 9 | 2025W48_2A_0706 | D3 | 2025-11-30 12:47 | 156.1° | +0.39° | 13 |
| F35 | 10 | 2025W52_1A_0081 | D2 | 2025-12-22 09:38 | 180.0° | -0.51° | 20 |
| F36 | 11 | 2026W03_1A_0399 | D3 | 2026-01-13 22:37 | 196.1° | -0.39° | 18 |
| F37 | 12 | 2026W06_1A_0512 | D2 | 2026-02-04 13:29 | 50.0° | -0.34° | 17 |
| F38 | 13 | 2026W09_2A_0063 | D3 | 2026-02-26 19:14 | 239.4° | +1.18° | 22 |
| F39 | 14 | 2026W12_2A_0033 | D2 | 2026-03-19 16:08 | 93.4° | -1.12° | 20 |
| F40 | 15 | 2026W15_2A_0501 | D3 | 2026-04-11 13:15 | 127.2° | +1.12° | 12 |
| F41 | 16 | 2026W18_2A_0606 | D2 | 2026-05-02 23:21 | 313.3° | +1.06° | 14 |
| F42 | 17 | 2026W21_2A_0584 | D3 | 2026-05-24 23:13 | 332.9° | +0.49° | 15 |
| F43 | 18 | 2026W25_1A_0180 | D2 | 2026-06-15 23:07 | 350.2° | -0.61° | 16 |
| F44 | 19 | 2026W28_1A_0537 | D3 | 2026-07-08 06:19 | 224.1° | -1.14° | 25 |
| F45 | 20 | 2026W31_1B_0508 | D2 | 2026-07-29 15:30 | 236.9° | -1.02° | 23 |
| F46 | 21 | 2026W34_2A_0049 | D3 | 2026-08-20 17:48 | 56.3° | -1.08° | 13 |
| F47 | 22 | 2026W37_2A_0235 | D2 | 2026-09-11 15:06 | 283.6° | -0.24° | 21 |
| F48 | 23 | 2026W40_2A_0532 | D3 | 2026-10-03 14:53 | 307.4° | +1.21° | 17 |

`asteroid_rerun.py select --write` adds them to `cache/asteroids/fields.json` as F25-F48 (the 24-field file is kept as
`fields_v8.json`). None of these fields is dropped or replaced after its pixels are seen; a field that fails
(error or stop) is listed as not done.

Order of processing: pairs of neighbouring bins (one D2, one D3), the pairs spread over the mission, so that a stop
part-way still leaves fields spread in time and detector:
F25, F26, F37, F38, F31, F32, F43, F44, F27, F28, F39, F40, F33, F34, F45, F46, F29, F30, F41, F42, F35, F36, F47, F48.
One field per call: `$UV pipeline/find_asteroids.py run --no-track --only F25` (then F26, ...). After the 24 (or the
stop), `track --only <the new fields done>`.

Data cap: at most 400 MB of S3 byte ranges for this whole job (parts 1 and 2 with their tracklets), counted by
`cache/asteroids/bytes_ledger.json` (`total_s3_bytes` was 130,456,268 before the job). A new field is started only
while the job's bytes + 10 MB <= 400 MB; the next ones are listed as not done. Expected: about 7 MB per field,
about 170 MB for 24.

## Load and stop time

- The heavy run starts after the injection driver (PID 179897) has exited, with `free -m` available >= 6000 MB and
  the CPU package < 90 °C. One process at a time, `nice -n 15`, pinned to 2 CPU cores (`taskset`): at most 2 cores
  of compute. The run's object threads (`OBJ_WORKERS` = 6, unchanged) wait on S3 Range requests; they do not add
  cores. A guard pauses the process (SIGSTOP) while the package is >= 90 °C and resumes it under 85 °C.
- Heavy work ends at 15:30 at the latest. A new field is started only before 15:22; a field still running at 15:30
  is stopped and listed as not done. Tracklets of the new fields run only in the time left before 15:30.
- If time remains before 15:30 (lowest priority): the new fields once more from the cache with
  `STAR_MASK_NSIG = None` (`asteroid_misses.py trial`, nothing written to `runs/`), to see the fix's effect on false
  detections there too.
- State and logs: `ajan_durumu/a1_rerun/` (outside the repository).

## What will be reported

`pipeline/ASTEROIDS_RERUN.md`, `site/data/verify/tests.json` (V8: a new block; the round-v1 numbers kept),
`site/asteroids.html` (new numbers next to the old ones):

- Per magnitude bin (V < 17, 18, 19, 20): recovered / known, single exposures (and the visit stack), for
  (a) V8 round v1 (stored, 24 fields), (b) re-run on the same 24 fields, (c) the new fields, (d) all together.
- False detections, defined as in V8: confirmed objects (>= 2 sub-exposures, one at Z >= 5, or >= 3) in single
  exposures that match no known object within 2 px; also the visit-stack count. Before / after on the 24 old fields,
  per field, and whether the fix raises them. For the new fields there is no "before" unless the optional control runs.
- The known objects gained or lost on the old fields, tracklets linked / tried / wrong, position offsets, bytes read.
- Fields not done, and why.
- Status of V8 follows its existing rule: "limit" (shows how far the method reaches; no pass threshold).
- The old outputs stay: `site/data/asteroids/summary.json` and `candidates.json` are not replaced, and the Results
  section of `pipeline/ASTEROIDS.md` stays. `find_asteroids.py report` (without `--site` / `--replace`) writes new,
  time-stamped files in `cache/asteroids/report/` (its `results.md` is copied to `results_v8.md` first); the new
  summary is published as `site/data/asteroids/summary_rerun.json`.
