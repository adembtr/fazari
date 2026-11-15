# Known-asteroid misses of test V8, one by one

What V8 missed (`site/data/verify/evidence/asteroids.csv`, round v1, 24 fields): 6 of 53 known asteroids brighter than
V 17 and 31 of 132 brighter than V 18 (the code and the report count V < 17 and V < 18; V8 writes "V<=17").
The objects are those of the newest run file per field in `cache/asteroids/runs/`, the files the V8 report was built
from. Nothing was downloaded and nothing was re-run for V8; its numbers stay as they are.

Code: `pipeline/asteroid_misses.py` (cache only; every network call raises; nothing is written to `cache/asteroids/runs/`).

```
uv run --no-project --with numpy,astropy,scipy,pillow,reproject,matplotlib python -I pipeline/asteroid_misses.py boxes
uv run ... python -I pipeline/asteroid_misses.py trial F10,F04,F09,F15,F20,F07,F02,F18
```

## How each miss was examined

The boxes of every missed object were run again from the cache with the code path of the V8 run (difference with the
3 references, matched filter, EPSF fits, residual cuts). Per sub-exposure: the forced EPSF S/N at the predicted
position, the reference flux R3 and the difference flux D3 in the 3 x 3 pixels there, and every candidate within 3 px
with its Z, S/N, EPSF chi2 and the chi2 the cut allows, the reference/excess ratio and why it was rejected. For six
of them the 9 x 9 pixels of the target, the reference and the difference were printed and looked at (Walraven,
Klepesta, Rollandia, Yabuuti, Dzhanibekov, Spiraea). A whole-field re-run with the same code reproduces the stored V8
counts of the field exactly (8 of 8 fields tried, below).

## Causes

| cause | what it is | V < 17 | V < 18 |
|---|---|---|---|
| A. faint star under it | the asteroid is found as a PSF-shaped peak, but the reference star in the same 3 x 3 pixels is brighter than its excess (ratio 1.2-4), so the residual cut (`STATIC_MAX` = 1) calls it a star residual | 1 | 9 |
| B. neighbour residual in the fit stamp | the asteroid is on empty sky, but a bright star 2-4 px away leaves its undersampled residual inside the 7 x 7 EPSF fit stamp; the fit's chi2 goes far over the allowance and the candidate is rejected as "not PSF-shaped" (or too few sub-exposures survive to confirm it) | 3 | 6 |
| C. bright star blend | the star under it is several times brighter than the asteroid; its subtraction residual is as large as the asteroid | 1 | 6 |
| D. crowded field | field F06 in the Galactic bulge (b = +4.7 deg): difference noise 10-50 times the median field | 1 | 3 |
| E. too faint in one exposure | forced S/N below 5 in every sub-exposure (combined over the visit 4-8): nothing to link | 0 | 6 |
| F. not re-examined | the reference patches are not in the cache with the extents recomputed offline; the run's reason stays | 0 | 1 |
| **total** | | **6** | **31** |

By detector (V < 18): A 2 on D2 / 7 on D3; B 3 / 3; C 3 / 3; D 0 / 3; E 4 / 2; F 0 / 1.

Not a cause of any of the 31: the detector edge (30 of 31 had all 4 sub-exposures boxed, Dzhanibekov 3), trailing
(fastest miss 72"/h: 2.3" = 0.4 px in one 114 s exposure), saturation or masked pixels (no NaN at any predicted
position), the ephemeris (largest SkyBoT uncertainty 0.79", the comet P/1999 XN120), the 2 px linking radius.

The run's own reason (`miss_reason`) names one cut in a fixed order; the cause found here can differ. The 5 objects
the run calls "seen in one sub-exposure only" are 3 x A, 1 x B and 1 x E here. Example: Hoffmeister ("seen in one sub-exposure only") is found
in all 4 sub-exposures at S/N 13-17 with a clean PSF fit; 3 of them are removed by the star-residual ratio (1.4-2.0).

### Every miss with V < 18

R3 / D3: reference and difference flux in the 3 x 3 pixels at the predicted position (MJy/sr x pixel); ratio = R3/D3
of the candidate as computed by the cut; chi2 allowed = 3 x (1 + (S/N/25)^2).

| V | Field | Object | rate ("/h) | forced S/N (visit) | pipeline reason (V8 run) | cause | evidence (offline re-run of the boxes) |
|---|---|---|---|---|---|---|---|
| 14.8 | F07 | Aida | 14.7 | 110.9 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) | C | R3 119-138 vs D3 -2..6: the star under it is ~20-30x the asteroid's excess |
| 15.0 | F10 | Walraven | 51.3 | 105.9 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 4 sub-exposure(s) | B | empty sky (ratio 0.01-0.7); bright star 2.8 px away; chi2 90-358 vs allowed 8-18 |
| 15.0 | F15 | Rollandia | 17.2 | 173.5 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) | B | 1 sub found; 3 subs chi2 32-85 vs allowed 30-37 (star residual at the stamp corner) |
| 16.3 | F22 | Luxembourg | 10.0 | 9.3 | on a bright static source: its excess was rejected as a static-source residual in 2 sub-exposure(s) | A | faint star under it: ratio 1.2-1.8 in 2 subs, chi2 2.0 ok in one; no peak in the other 2 |
| 16.6 | F06 | Quaide | 15.9 | -1.0 | on a bright static source: its excess was rejected as a static-source residual in 1 sub-exposure(s) | D | Galactic bulge (b +4.7), noise 0.28-0.49, forced S/N -2..1 per sub |
| 16.9 | F04 | Klepesta | 13.1 | 33.6 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 4 sub-exposure(s) | B | empty sky (ratio 0.03-0.05); chi2 8.5-197 vs allowed ~4 (star residual 2-3 px away) |
| 17.1 | F03 | Hoffmeister | 12.7 | 36.6 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) | A | ratio 1.4-2.0 in 3 subs with chi2 1.4-2.2 and S/N 13-17; 1 sub passed (single) |
| 17.1 | F07 | Spiraea | 6.9 | 14.1 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) | A | ratio 1.2-1.7 in 4 subs; chi2 7-10 in 3 subs, raised by a star residual 2-3 px away |
| 17.2 | F22 | Szmytowna | 4.1 | -5.1 | on a bright static source: its excess was rejected as a static-source residual in 3 sub-exposure(s) | C | star under it: R3 5.2-6.3, forced S/N -6..0 |
| 17.3 | F15 | P/1999 XN120 | 23.0 | 7.0 | bad subtraction at the position (no excess in 4 sub-exposure(s)) | C | comet, on a star: R3 3.7-6.0 vs D3 -0.6..0.5 |
| 17.3 | F22 | Carlmurray | 10.7 | 2.8 | on a bright static source: its excess was rejected as a static-source residual in 1 sub-exposure(s) | C | star under it: R3 3.3-4.9 vs D3 -0.5..1.1 |
| 17.4 | F01 | Fortov | 71.7 | 27.5 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) | C | star under it: R3 5-11 vs D3 -0.8..3.3, ratio 3-7 |
| 17.5 | F07 | Bakhrakh | 26.9 | 5.7 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 2 sub-exposure(s) | B | faint (forced S/N 1-4 per sub); chi2 6-14 vs 3-4 from a neighbour residual |
| 17.5 | F08 | Mikawa | 35.4 | 41.2 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) | C | bright star: R3 62-116, D3 -41..24; only 2 references |
| 17.5 | F10 | Tacitus | 16.4 | 12.8 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) | A | ratio 1.8-3.9 with chi2 0.8-1.3, S/N 4.5-6.8 in 4 subs |
| 17.5 | F20 | Yabuuti | 7.5 | 21.8 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 4 sub-exposure(s) | B | ratio 0.2-0.7; chi2 4.1-9.3 vs 3.3-3.5 (star residual 3-4 px away) |
| 17.5 | F22 | Arthur | 3.4 | 5.7 | forced S/N 5.7 over the sub-exposures, below the per-exposure detection threshold | E | forced S/N 1.2-4.7 per sub; 3.4"/h |
| 17.6 | F06 | Knacke | 13.8 | 0.5 | bad subtraction at the position (no excess in 2 sub-exposure(s)) | D | bulge field F06, noise 0.7-1.4, forced S/N ~0 |
| 17.6 | F07 | Aristarchus | 12.5 | 4.2 | too faint (forced S/N 4.2) | E | forced S/N 0.9-4.0 per sub (4.2 combined), on a faint star |
| 17.6 | F20 | Shulnazaria | 9.2 | 12.6 | on a bright static source: its excess was rejected as a static-source residual in 3 sub-exposure(s) | A | ratio 1.6-3.5 in 2 subs; strongest sub peak 1 px off with no excess in its 3 x 3 |
| 17.7 | F06 | 1999 VX19 | 24.1 | -0.4 | too faint (forced S/N -0.4) | D | bulge field F06, noise 0.9-1.6 (30-50x), forced S/N ~0 |
| 17.7 | F16 | Jurgens | 50.1 | 14.3 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) | A | ratio 1.15-1.3 in 3 subs with chi2 0.8-1.2, S/N 5-6; 1 sub passed (single) |
| 17.7 | F22 | 1998 UD8 | 8.7 | 7.4 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) | E | forced S/N 2.5-5.1 per sub; one sub at Z 5.3 (single) |
| 17.8 | F02 | Bohumilruprecht | 32.2 | 14.1 | on a bright static source: its excess was rejected as a static-source residual in 3 sub-exposure(s) | A | ratio 2.0-4.1 with chi2 1.9-3.9 (PSF-shaped), S/N 2-6 per sub |
| 17.8 | F09 | Dzhanibekov | 35.8 | 12.4 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 3 sub-exposure(s) | B | empty sky (ratio 0.05-0.2); chi2 4.1-8.8 vs 3.2 (star residual 3 px away) |
| 17.8 | F23 | Shapiro | 38.8 | 8.9 | on a bright static source: its excess was rejected as a static-source residual in 2 sub-exposure(s) | E | forced S/N 3.1-5.5 per sub |
| 17.8 | F24 | 1988 VD7 | 40.3 | 7.9 | bad subtraction at the position (no excess in 2 sub-exposure(s)) | F | not re-examined: its reference patches are not in the cache with the recomputed extents; run reason kept |
| 17.8 | F24 | Sagan | 42.4 | 11.7 | on a bright static source: its excess was rejected as a static-source residual in 3 sub-exposure(s) | A | ratio 1.7-2.3 in 3 subs; chi2 5-12 also raised |
| 17.9 | F15 | 2000 AV97 | 53.1 | 5.8 | forced S/N 5.8 over the sub-exposures, below the per-exposure detection threshold | E | forced S/N 1.9-4.0 per sub |
| 17.9 | F23 | Mohler | 31.6 | 4.7 | too faint (forced S/N 4.7) | E | forced S/N 1.2-3.5 per sub |
| 17.9 | F24 | 1992 PA4 | 31.0 | 5.6 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) | A | ratio 1.9 at Z 9.4 (chi2 1.9) in sub 1; sub 3 found (single) |

## The one fixable cause (B) and the fix

Cause B is a defect of the fit, not a threshold: the chi2 that is meant to say "this candidate is not a point source"
is computed over a 7 x 7 stamp that also holds pixels of another source, the residual of a neighbouring bright star
(an undersampled star subtracts badly; its residual reaches 30-100 % of its pixels and spreads by one pixel with the
pixel phase). The variance floor of 10 % of the reference (`MODEL_C`) is too small for that.

Fix (`pipeline/detect/asteroids.py`, `STAR_MASK_NSIG = 10.0`): in the EPSF fit of a candidate, the stamp pixels where
the reference is brighter than 10 x the difference noise, and their direct neighbours, are left out, except the
central 3 x 3 (single-exposure fits, the visit-stack fit and its per-sub-exposure fits). No threshold changed
(`CHI2_MAX`, `CHI2_SNR`, `STATIC_MAX`, `Z_DET`, `Z_CONFIRM` as in V8). `STAR_MASK_NSIG = None` gives the V8 behaviour
exactly. Recorded honestly: a first version without the one-pixel dilation recovered Walraven but not the others
(checked on F10, then on the six stamps of cause B); the dilation was added after looking at those stamps.

Effect on the missed objects, chi2 / allowed chi2 per sub-exposure, V8 code -> fix: Walraven 90-358 / 8-18 -> 1.9-7.8;
Rollandia 32-83 / 30-38 -> 1.0-1.9; Klepesta 8.5-197 / 4-5 -> 1.2-1.5 in 3 subs (161 in sub 1); Yabuuti 4.1-9.3 / 3.3-3.5
-> 0.9-3.2; Dzhanibekov 4.1-8.8 / 3.2 -> 1.6-2.1; Bakhrakh 5.6-13 / 3-4 -> 0.6-1.1 (but S/N 1.4-5 in 3 of 4 subs).

### Local trial (8 fields, cache only, both versions in the same process)

`asteroid_misses.py trial F10,F04,F09,F15,F20,F07,F02,F18`: the 5 fields with a cause-B miss (Bakhrakh's F07 is the
sixth) and 2 control fields (F02, F18). The V8-code pass reproduced the stored V8 counts of all 8 fields exactly
(found, known and false, single and stack).

| field | found single V8 code -> fix | false single | false stack |
|---|---|---|---|
| F10 | + Walraven (V 15.0) | 4 -> 5 | 4 -> 5 |
| F04 | + Klepesta (V 16.9) | 8 -> 11 | 2 -> 3 |
| F09 | + Dzhanibekov (V 17.8) | 6 -> 6 | 7 -> 7 |
| F15 | + Rollandia (V 15.0) | 4 -> 6 | 2 -> 7 |
| F20 | + Yabuuti (V 17.5) | 5 -> 5 | 4 -> 4 |
| F07 | none (Bakhrakh stays missed: too faint) | 1 -> 6 | 1 -> 2 |
| F02 | + Michela (V 18.0) | 4 -> 4 | 4 -> 4 |
| F18 | none | 9 -> 11 | 3 -> 4 |
| **8 fields** | V<17 19 -> 22 / 23; V<18 41 -> 46 / 55; V<19 76 -> 82 / 185; V<20 79 -> 85 / 526 | **41 -> 54** | **27 -> 36** |

No object found by the V8 code was lost. Expected for all 24 fields (the 8 fields hold all 6 cause-B misses with V < 18):
V < 17 about 50 / 53 (was 47), V < 18 about 106 / 132 (was 101); false detections up by about a third
(+13 of 41 here: about 96 -> 125-135 in all), because star-residual lobes that the old chi2 caught by accident now
reach the other cuts.
The 8 new false detections of F07 and F04 were listed: 6 of them have a reference/excess ratio of 0.5-0.97 in
every detection (just under `STATIC_MAX` = 1, i.e. on the wing of a star) and fluxes of 1-25 mJy, far brighter than
the asteroids found; 2 contain a detection of 68-124 mJy with chi2 470-2900 (a bright star's residual linked with a
weak peak). They look like star residuals, not unknown asteroids.
This is a trade: 5 real bright asteroids for about 30-40 more unmatched detections. The fix stays in the code; if the
re-run prefers the V8 false rate, set `STAR_MASK_NSIG = None`.

The other causes are not fixed: A is the `STATIC_MAX` threshold (a decision rule of V8, kept); C, D and E are limits
of single-exposure difference imaging with undersampled 6" pixels.

## Re-run (for a later, separate run; not done here)

Everything needed is in the cache (the trial above read no byte from the network).

```
cd /home/adem/Desktop/COMPETITION/NASA/fazari
UV="uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow python -I pipeline/find_asteroids.py"
$UV run --no-track --redo --only F01,F02,F03,F04,F05,F06,F07,F08,F09,F10,F11,F12,F13,F14,F15,F16,F17,F18,F19,F20,F21,F22,F23,F24
$UV track
$UV report --site
```

(`--redo` writes new time-stamped run files; the report takes the newest per field. `cache/asteroids/prod2.sh` runs
the same in groups.) Then V8 in `site/data/verify/tests.json` gets the new numbers with the round-v1 numbers kept.

- Time: about 30 s per field in one process from the cache (trial: 18-43 s, mean 29 s): about 12 min for 24 fields,
  plus a few minutes of tracklets and the report; about 5 min in 3 groups.
- Bytes: 0 for the 24 fields' detection (all boxes cached). Tracklets: the newly found objects get a second-visit
  search that is not cached; at the V8 rate (about 14 MB for about 135 attempts) about 1 MB for about 10 new attempts.
- CPU / memory: about 1.3 cores and 250 MB per process (nice 15 in the trial).

### More fields

The sky index has 2,056 ecliptic visits on D2/D3 with 4 sub-exposures inside |beta| <= 2 deg; 24 are used. A new field
costs about 7 MB (S3 boxes median 5.4 MB, 4.1-8.2 MB; SkyBoT 0.8 MB; tracklets about 0.6 MB) and about 4 min in one
process (V8 first runs: median 226 s, network-bound). So +24 fields (48 in all) is about 170 MB and about 1.5 h in one
process or about 30 min in 3 groups; +48 (72 in all) about 340 MB and 1 h in 3 groups. `select_fields(n)` re-bins the
mission span, so `select` with n = 48 would replace the 24 fields instead of adding to them: to keep the 24, the extra
fields need bin centres between the old ones (a small change to `select_fields`, e.g. an offset of half a bin).
