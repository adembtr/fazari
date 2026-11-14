# Fast-star sweep: SPHEREx proper motions of Gaia DR3 fast stars vs Gaia DR3

Code: `pipeline/fast_sweep.py` (selection, S3 box reads, measurement) and `pipeline/fast_sweep_report.py`
(table, statistics, figure). Outputs: `site/data/fast_sweep/{stars.csv, summary.json, figure.json, figure.png}`.
Working state and byte ledger: `ajan_durumu/hizli_yildiz.md`, `cache/fast_sweep/ledger.json`.

```
uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow \
    python -I -u pipeline/fast_sweep.py run --box 0.12 --k 3 --max 90 --budget-mb 1150   # restartable
... python -I -u pipeline/fast_sweep.py report --box 0.12 --k 3 --max 90
```

## Question

Does the project's astrometry measure how far a star moved between SPHEREx seasons correctly, for
many stars measured the same way, not only for the four showcase targets? Every star of the sample is
measured with one fixed procedure and compared with ESA Gaia DR3. Failures stay in the table.

## Pre-registered rule (written 2026-11-14 17:06 +03, before any star was measured)

- Universe: the 4,586 stars of `site/data/fast_stars.json.gz` (Gaia DR3, total motion > 0.5"/yr, bright
  enough for SPHEREx, 2+ seasons in the sky index) that have two seasons 365 +- 60 days apart (proxy for
  "same telescope orientation"): 4,412 stars.
- Sample: F = the 50 fastest; R = a random sample (numpy `default_rng(20261114)`) of 10 stars from each
  speed class [0.5,0.7) [0.7,1) [1,2) [2,4) [4,inf) "/yr of the rest (a class with < 10 left: all of it).
  Processing order F1 R1 F2 R2 ...; if the budget forces fewer stars, the tail of this order is dropped.
- Pass criterion: measured motion vector within 3 sigma of Gaia (2-D chi2 with the measured, calibrated
  covariance). "Within 1 / 2 sigma" = chi2 <= 2.30 / 6.18 (68.3 / 95.4 % for correct 2-D error bars).
- Failure classes: no data, no same-orientation pair, target not measured (no drift fit), saturated wing
  fit failed, fetch error. Flags (kept in the statistics, also split): saturated, blended, unregistered
  exposures.
- Gaia is used only (a) to register every exposure on the OTHER Gaia stars of the box (the target is
  excluded from the reference list) and (b) for the final comparison. Nothing is tuned toward Gaia.

### Recorded changes (all decided without looking at any Gaia comparison)

1. The rule yields 90 stars, not 100 (classes [2,4) and [4,inf) have < 10 stars left after the 50 fastest).
2. Exposures per (season, detector): the K closest in time to the season's median date (evenly spaced
   picks left > 30-day gaps inside a season and the pipeline's season splitter cut 3 seasons into 5).
3. Registration cell minimum 3 distinct reference stars instead of the pipeline's 5 (set in the wrapper,
   the tree is not edited): in small boxes only G <~ 16 stars reach S/N 20 per exposure.
4. Box-size rule: no candidate reached ">= 80 % of exposures with an exposure/cell offset"; the errors are
   flat with box size (they cannot see a missing registration), so the rule was replaced by "the smallest
   box that leaves no exposure without a Gaia registration on all three test stars": 0.12 deg.
5. The "weak registration" flag became "some exposures without any Gaia registration" (the 80 % rule
   would flag almost every star).

## Data and cost

Per star: the sky-index exposures at the star's 2026.0 position; per season and detector the 3 exposures
closest to the season's median date (54 exposures for 3 seasons x 6 detectors). From each exposure a
0.12 x 0.12 deg box (71 x 71 native pixels) is read from the public S3 bucket with HTTP Range: PRIMARY +
IMAGE header (28.8 kB), FLAGS header (17.3 kB), the tile-compressed FLAGS rows of the box (~4.2 kB per
row: each tile is a full 2,040-pixel row), the IMAGE rows of the box (284 bytes per row), the WCS-WAVE
tail (5.8 kB); EPSF tables once per calibration id (all six were already in the project's cache).
VARIANCE = box robust noise^2 and ZODI = box median are synthetic, as in `local/quick.py` (each would
cost as much as IMAGE). At most 4 requests in flight (`fetch_region.http_get` semaphore), backoff on
errors. Measured throughput 20 requests/s (latency 0.17-0.19 s); a star costs 15-26 MB and ~3.5 min of
reading; the measurement (~40 s) overlaps the next star's reading.

## Measurement (detector B path of the tree)

1. `detect.run.prepare`: exposures cleaned as `blink.py` does; every exposure registered on the Gaia DR3
   reference stars of the box (G 10-17.5, RUWE <= 1.4, isolated, the target excluded) moved to the
   exposure's time with their Gaia motion and parallax.
2. `deep_astrom.field_measure` -> `astrometry.measure_seasons`: every Gaia star of the box (and the
   non-Gaia deep sources) is predicted in every exposure and fitted with the EPSF (saturated cores: wing fit,
   `blink.centroid`), two passes, the second centred on the first pass's season positions.
3. `astrometry.fit_drift` with one position offset per detector (and per telescope orientation for wing-fit
   cells) gives the drift relative to the prediction; `astrometry.calibrate` replaces the formal drift
   error by the residual-permutation error when larger (200 permutations).
4. Measured motion = Gaia motion + drift. Season positions, the displacement between the two
   same-orientation seasons farthest apart, its arcsec, error and position angle are recorded too.

### Is the comparison independent of Gaia's value for the target?

The target's Gaia motion is only the starting track of the fit: the offsets are measured from it and the
fitted drift is added back, so a perfect measurement returns the star's own motion whatever the start.
The linear EPSF estimator is exact only near the true position, so a wrong start could pull the result
toward it. Every star is therefore measured a second time with its starting track deliberately wrong by
+10 % of its Gaia motion (same 2026.0 position); pull = (shift of the result) / (shift of the start).
Pull 0 = independent, pull 1 = the result just repeats the start. Results below.

## Results — INTERIM: 14 of 90 pre-registered stars (target 100), sweep continuing

Built 2026-11-14 18:10 +03 from `site/data/fast_sweep/summary.json`. Code version (core tag) 1370ca11c5 =
the tree's v1 detection core (TEST-READY v1 16:58); sha1 of every file in `summary.json`. Box 0.12 deg,
K = 3 exposures per season and detector (52-54 exposures, 2-3 seasons per star). MB read so far: 338.7
(ledger) / 342.0 (reconstructed from the disk cache), including 85 MB of box-size tests.

- Attempted 14 (the first 14 of the order: 7 fastest + 7 random), measured 14, failed 0.
- |measured - Gaia| (vector): median 6.1 %, 90th percentile 17.0 %; median 0.22"/yr, P90 0.46"/yr.
- Error bars: 71 % within 1 sigma (expected 68 %), 93 % within 2 sigma (expected 95 %), 100 % within 3 sigma
  (pass). Median calibrated error 0.14"/yr per axis -> smallest motion seen at 5 sigma ~0.7"/yr
  (unsaturated stars: 0.10"/yr, 0.48"/yr at 5 sigma; saturated wing fits: 0.16"/yr, 0.82"/yr).
- Saturated (8): median 3.2 %, 88 % within 2 sigma. Not saturated (6): median 8.7 % (slower stars: a
  larger percentage for a similar error in "/yr), 100 % within 2 sigma.
- Fastest set (7, 5.2-10.4"/yr): median 3.2 %; random set (7, 0.53-2.1"/yr): median 9.9 %.
- Same-orientation season pair (displacement over ~1 yr / dt): median |speed - Gaia| 3.4 %, 86 % within 2 sigma.
- Independence: median pull 0.0005, 90th percentile |pull| 0.29 (two stars above 0.1: PM J12445-1306N 0.35,
  a 0.53"/yr star where the 10 % test step is 0.05"/yr, half its 0.10"/yr error; HD 112943 -1.0, the dof = 0 fit below).

| # | star | Gaia "/yr | measured "/yr | diff % | sigma (2-D) | pair "/yr | pull | flags |
|---|---|---|---|---|---|---|---|---|
| 1 | Barnard's Star | 10.393 | 10.368 +- 0.120 | 2.3 | 1.08 | 10.337 | -0.075 | saturated |
| 2 | DENIS J125310.8-570924 | 1.622 | 1.571 +- 0.100 | 4.7 | 0.37 | 1.584 | 0.019 | blended (1.7") |
| 3 | Kapteyn's Star | 8.644 | 8.900 +- 0.137 | 3.1 | 1.73 | 9.027 | 0.000 | saturated |
| 4 | HD 219134 | 2.095 | 1.729 +- 0.248 | 17.5 | 0.96 | 1.834 | 0.000 | saturated |
| 5 | Groombridge 1830 | 7.062 | 6.923 +- 0.132 | 3.3 | 1.20 | 7.010 | -0.001 | saturated, unregistered exp. |
| 6 | PM J12445-1306N | 0.528 | 0.610 +- 0.099 | 15.8 | 0.38 | 0.589 | 0.350 | unregistered exp. |
| 7 | Lacaille 9352 | 6.896 | 6.784 +- 0.189 | 3.2 | 0.67 | 6.761 | -0.004 | saturated, unregistered exp. |
| 8 | G 198-58 | 0.714 | 0.731 +- 0.105 | 7.5 | 0.28 | 0.710 | 0.003 | |
| 9 | HD 225213 | 6.098 | 6.071 +- 0.137 | 1.0 | 0.11 | 6.085 | 0.002 | saturated, unregistered exp. |
| 10 | HD 112943 | 0.807 | 1.141 +- 0.757 | 41.8 | 0.13 | 1.000 | -1.007 | dof = 0 fit (core issue) |
| 11 | 61 Cygni A | 5.282 | 5.754 +- 0.271 | 12.6 | 2.75 | 5.744 | 0.133 | saturated, unregistered exp. |
| 12 | SCR J1053-3858 | 0.633 | 0.620 +- 0.059 | 3.7 | 0.11 | 0.638 | 0.001 | |
| 13 | 61 Cyg B | 5.179 | 5.552 +- 0.414 | 9.6 | 0.59 | 5.479 | 0.000 | saturated, unregistered exp. |
| 14 | G 158-27 | 2.060 | 1.857 +- 0.187 | 9.9 | 0.62 | 1.911 | 0.021 | unregistered exp. |

## Limits (numbers)

- Cost: 15-27 MB and ~3.3 min of S3 reading per star (FLAGS rows are ~70 % of the bytes; 4 requests in
  flight at ~20 requests/s). 100 stars need ~2.3 GB and ~5.5 h.
- Only 54 of the ~360 exposures per star are used: errors are ~2.5x those of a full run (Barnard: 0.12"/yr
  here vs 0.05"/yr with all exposures in the targeted pipeline).
- Registration: median 19 % of the exposures get their own exposure/cell Gaia offset, the rest a season
  median; 7 of 14 stars have some exposures with no Gaia registration at all (raw SPHEREx WCS for those).
- Saturated stars measured on two seasons only (the single opposite-orientation season of a wing fit only
  fixes its own offset).
- Open core issue (reported to the core author): `astrometry._fit_cells` uses the unsaturated (EPSF) cells
  alone whenever they give a fit, even a 2-season fit with dof = 0; for HD 112943 (8.3 AB) that gives
  0.76"/yr error where the wing-fit cells would constrain the motion far better.
- VARIANCE and ZODI are not read (synthetic, as in local/quick.py); per-exposure weights are therefore uniform.

## Two-line summary for the evidence page

EN: We measured the motion of 14 fast stars from a pre-registered list of 90 in real SPHEREx images, all with
one method, and compared with ESA Gaia DR3: median difference 6 % (3 % for the 7 fastest), 93 % agree within
2 sigma and all 14 within 3 sigma; interim result, the sweep continues.

TR: Önceden kayda geçirilmiş 90 yıldızlık listeden 14 hızlı yıldızın hareketini gerçek SPHEREx görüntülerinde
tek bir yöntemle ölçtük ve ESA Gaia DR3 ile karşılaştırdık: ortanca fark %6 (en hızlı 7 yıldızda %3), %93'ü
2 sigma, 14'ünün hepsi 3 sigma içinde uyuşuyor; ara sonuç, tarama sürüyor.
