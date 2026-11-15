# Test V8 re-run with the star-mask fix, and 24 new fields: results

Plan, committed and pushed before the run: [`ASTEROIDS_RERUN_PLAN.md`](ASTEROIDS_RERUN_PLAN.md) (commit 716d899,
pushed 2026-11-15 08:51:08 UTC). Method: [`ASTEROIDS.md`](ASTEROIDS.md). The fix: [`ASTEROID_MISSES.md`](ASTEROID_MISSES.md)
(cause B). These are recovered **known** asteroids. Unmatched detections are candidates (most are star residuals), not
discoveries.

- Code: `pipeline/detect/asteroids.py` of 7eee529 (blob fe6a029) with `STAR_MASK_NSIG = 10`; round v1 (V8) ran with
  `None`. No threshold or decision rule changed. Launcher `pipeline/find_asteroids.py` unchanged.
- Run on 2026-11-15, 13:05-15:30 +03, one process at a time, `nice -n 15`, 2 CPU cores. The heat guard paused the
  process 60 times (CPU package 90-96 °C for a few seconds while other jobs ran). Logs and state: `ajan_durumu/a1_rerun/`
  (outside the repository).
- Numbers: `pipeline/asteroid_rerun.py compare --since 2026-11-15T13:05` (newest run file per field written by this run;
  round v1 = the run files the V8 report was built from). Same numbers: `site/data/asteroids/rerun.json`. Per field:
  `site/data/verify/evidence/asteroids_rerun.csv`. Full report of the 48 fields (`find_asteroids.py report`, written to
  `cache/asteroids/report/summary_20261115T153125.json`): `site/data/asteroids/summary_rerun.json`.
- Round v1 stays as it was: `site/data/asteroids/summary.json`, `candidates.json`, the Results section of
  `ASTEROIDS.md`, the V8 result, status and numbers in `site/data/verify/tests.json` and its evidence `asteroids.csv` are
  not changed. The re-run is a new block of V8 (`rerun_star_mask`, shown on verify.html only with `?extra=1`).

## What ran

| step | time (+03) | result |
|---|---|---|
| Part 1: F01-F24 from the cache (`run --no-track --redo`) | 13:05-13:26 | 24 / 24 fields; 0 bytes from S3 |
| Part 1 tracklets (`track`) | 13:26-13:28 | 24 / 24 fields; 0.27 MB |
| Part 2: F25-F48 (`run --no-track`, one field per call, plan order) | 13:28-15:11 | 24 / 24 fields; 2.9-6.2 min per field |
| Part 2 tracklets (`track --only F25,...,F48`) | 15:11-15:30 | **stopped at 15:30 by the plan's rule**: F25-F35 done, F36 was running, F36-F48 not done |
| Optional control (new fields with `STAR_MASK_NSIG = None`) | - | not run (no time left before 15:30) |

Data: 141.2 MB of S3 byte ranges for the whole job (ledger 130.5 -> 271.6 MB; 696,451 Range requests), under the
400 MB cap. The part of the stopped tracklet step is not in the ledger; the cached payload grew by 141.8 MB in all.

## Recovered / known (single exposures, confirmed in the visit)

| set | fields | V < 17 | V < 18 | V < 19 | V < 20 | false detections | false (visit stack) | tracklets linked / tried (wrong) |
|---|---|---|---|---|---|---|---|---|
| Round v1 (V8), stored | 24 | 47 / 53 | 101 / 132 | 205 / 451 | 217 / 1400 | 96 | 68 | 47 / 135 (1) |
| Re-run, the same 24 fields | 24 | **50 / 53** | **106 / 132** | **216 / 451** | 228 / 1400 | **115** | 95 | 51 / 143 (1) |
| Re-run, 24 new fields | 24 | **43 / 44** | **108 / 126** | **212 / 472** | 226 / 1433 | **130** | 91 | 47 / 105 (1), F25-F35 only |
| Re-run, all 48 fields | 48 | **93 / 97** | **214 / 258** | **428 / 923** | 454 / 2833 | **245** | 186 | 98 / 248 (2) |

Visit stack (V < 17 / 18 / 19): round v1 48 / 98 / 192; same 24 fields 49 / 101 / 199; new fields 41 / 100 / 209.
Position offset detection - ephemeris, all 48 fields: median 0.114 px (round v1 0.111), 90 % 0.363 px, 99.1 % within
1 px. Wrong tracklet links: F21 1989 CU8 (as in round v1) and F25 Grignard (5.4-5.6 px from the ephemeris).

**The same 24 fields.** 11 known objects gained, none lost. With V < 18 they are the five cause-B misses of
`ASTEROID_MISSES.md`: Walraven (F10, V 15.0), Rollandia (F15, 15.0), Klepesta (F04, 16.9), Yabuuti (F20, 17.5),
Dzhanibekov (F09, 17.8). Fainter: Michela (F02, 18.0), Abehiroshi (F23, 18.0), Terryalfriend (F17, 18.1), Polyakhova
(F23, 18.4), 1998 XW10 (F01, 18.5), Dimpna (F19, 18.5). Still missed with V < 17: Aida (F07, star under it, cause C),
Luxembourg (F22, faint star under it, A), Quaide (F06, bulge field, D). The numbers are the ones the 8-field trial of
`ASTEROID_MISSES.md` led to expect (about 50 / 53 and 106 / 132).

**The new fields.** The one miss with V < 17 is 33 Polyhymnia (F40, V 14.7): fewer than 2 reference images of that sky.

## False detections: the fix raises them

Defined as in V8: objects confirmed in the visit (>= 2 sub-exposures with one at Z >= 5, or >= 3) that match no known
object within 2 px. On the same 24 fields: **96 -> 115** (+19, +20 %); visit stack 68 -> 95. No field went down; 10 went
up: F04 8 -> 11, F06 1 -> 3, F07 1 -> 6, F10 4 -> 5, F14 6 -> 7, F15 4 -> 6, F16 2 -> 3, F18 9 -> 11, F21 3 -> 4,
F23 3 -> 4. This is the trade written in `ASTEROID_MISSES.md` (expected 125-135 there; 115 here): star-residual lobes
that the old chi2 rejected by accident now reach the other cuts. They were not inspected one by one in this run. The new
fields have 130 (median 5 per field); there is no "before" for them because the optional control did not run.

## Not done

- Tracklets of the new fields F36-F48 (13 fields): the step was stopped at 15:30 as the plan says. Their detection
  numbers above are complete; only the cross-visit links are missing.
- The optional control (new fields with `STAR_MASK_NSIG = None`).
- The asteroid page (`site/asteroids.html`) still shows round v1 only: the page has no `?extra=1` gate, so the new
  numbers are in the files above and on verify.html with `?extra=1`.

## Reproduce

```
UV="uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow python -I"
$UV pipeline/find_asteroids.py run --no-track --redo --only F01,...,F24 && $UV pipeline/find_asteroids.py track --only F01,...,F24
$UV pipeline/asteroid_rerun.py select --write                         # F25-F48 into cache/asteroids/fields.json
$UV pipeline/find_asteroids.py run --no-track --only F25              # ... one field per call, in the plan's order
$UV pipeline/find_asteroids.py track --only F25,...,F48
$UV pipeline/asteroid_rerun.py compare --since 2026-11-15T13:05 --out rerun.json --csv asteroids_rerun.csv
$UV pipeline/find_asteroids.py report                                 # new time-stamped files in cache/asteroids/report/
```
