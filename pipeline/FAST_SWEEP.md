# Fast-star sweep: SPHEREx proper motions of Gaia DR3 fast stars vs Gaia DR3

Code: `pipeline/fast_sweep.py` (selection, S3 box reads, measurement) and `pipeline/fast_sweep_report.py`
(table, statistics, figure). Outputs: `site/data/fast_sweep/{stars.csv, summary.json, figure.json, figure.png}`.
Working state and byte ledger: `ajan_durumu/hizli_yildiz.md`, `cache/fast_sweep/ledger.json`.

```
# the final table was run from a frozen copy of commit 522d3ab (see "How the run was done"):
setsid nohup bash /home/adem/Desktop/COMPETITION/NASA/fazari_sweep_v1/run_sweep.sh >/dev/null 2>&1 < /dev/null &
cd /home/adem/Desktop/COMPETITION/NASA/fazari_sweep_v1 && FAST_SWEEP_OUT=<repo>/site/data/fast_sweep \
  uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow \
  python -I report_frozen.py           # pipeline/fast_sweep_report.py of the repo on the frozen module
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
6. (20:41, 14 Nov; no result existed for the stars it affects) Gaia DR3 field rows may come from the ESA Gaia
   Archive when IRSA's TAP fails (IRSA returned HTTP 502 all evening): same rows, checked equal on 3 measured fields.
   A data source, not a change of the measurement or the sample.

## Data and cost

Per star: the sky-index exposures at the star's 2026.0 position; per season and detector the 3 exposures
closest to the season's median date (54 exposures for 3 seasons x 6 detectors). From each exposure a
0.12 x 0.12 deg box (71 x 71 native pixels) is read from the public S3 bucket with HTTP Range: PRIMARY +
IMAGE header (28.8 kB), FLAGS header (17.3 kB), the tile-compressed FLAGS rows of the box (~4.2 kB per
row: each tile is a full 2,040-pixel row), the IMAGE rows of the box (284 bytes per row), the WCS-WAVE
tail (5.8 kB); EPSF tables once per calibration id (all six were already in the project's cache).
VARIANCE = box robust noise^2 and ZODI = box median are synthetic, as in `local/quick.py` (each would
cost as much as IMAGE). At most 4 requests in flight (`fetch_region.http_get` semaphore), backoff on
errors. Measured throughput 20 requests/s (latency 0.17-0.19 s); a star cost 9-33 MB (median 25 MB) and ~3.5 min of
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

## How the run was done

- One measurement version for the whole table: core tag 1370ca11c5 (the v1 detection core, TEST-READY v1 16:58),
  every star. Stars 1-14 ran from the repo tree (17:31-18:09); stars 15-90 ran from a frozen copy of commit 522d3ab
  (`git archive` of pipeline/, site/index and site/data/fast_stars.json.gz into `../fazari_sweep_v1/`, cache linked
  to the repo's `cache/`), because the core of the tree was being changed to v1.1. The core file hashes of the copy
  equal those in `summary.json` (`code_files_sha1`). `fast_sweep.py` itself differs (stars 1-14: 121da536ab, edited
  two minutes after that run started; 15-90: 4b3e306b49); star 1 re-measured with the frozen copy reproduces its
  stored result bit for bit.
- The run was started 5 times; every restart skips finished stars (same frozen code, same results):
  17:31 (stars 1-14, stopped 18:09 for the move), 20:20 (frozen copy), 20:37 and 20:41 (deliberate stops to add
  network patience and the second Gaia source, below), 23:09 (**1 restart for memory**: the process grows about
  250 MB per star, 7.3 GB at star 44, and the PC froze; clean STOP and relaunch, no further memory restart was needed).
  Stars 15-90: 20:20 to 01:39.
- Launcher additions (`../fazari_sweep_v1/launch_sweep.py`; measurement code untouched, core tag asserted at start):
  network requests retried for hours instead of ~31 s (a fetch that fails because of our own network is not a
  property of the star; no star needed a network repair); the Gaia TAP query shares the 4 request slots, so at most
  4 requests were in flight at any time.
- Second Gaia DR3 source (decided 20:41, before any result of the affected stars existed): IRSA's TAP returned
  HTTP 502 all evening, so the same rows were taken from the ESA Gaia Archive (`gaiadr3.gaia_source`, same cone,
  columns, units, epoch, rounded to IRSA's decimals). Checked first on 3 already-measured fields (Barnard's Star,
  DENIS J1253-5709, 61 Cygni A: 1908 / 3987 / 3254 rows, identical source ids, positions, proper motions and
  parallaxes; only last-digit rounding, 1e-6 mag in G and 1e-7 deg in one dec). Gaia rows per star: IRSA 15, ESA 75
  (`stars.csv` column `gaia_rows_source`).
- Bytes: 2,216.9 MB of S3 range reads in the ledger (2,220.2 MB reconstructed from the disk cache), including the
  85 MB of box-size tests; budget 2,600 MB. Per star 9-33 MB (median 25 MB).

## Results — FINAL: 90 of 90 pre-registered stars attempted, 86 measured, 4 failed

Built 2026-11-15 from `site/data/fast_sweep/summary.json`; full table `stars.csv`. Box 0.12 deg, K = 3
exposures per season and detector (42-66 exposures used, 2-4 seasons per star).

- |measured - Gaia| (vector), 86 stars: median 7.1 %, 90th percentile 25.2 %; median 0.17"/yr, P90 0.51"/yr.
- Error bars (2-D, calibrated): within 1 / 2 / 3 sigma 60.5 / 83.7 / 94.2 % (52 / 72 / 81 stars) against the
  expected 68.3 / 95.4 / 99.7 % (58.7 +- 4.3 / 82.0 +- 1.9 / 85.7 +- 0.5 stars). Median chi2 1.40 against the expected
  1.39: **for the typical star the error bars are right (scale 1.00), but the tail is too heavy**: 14 stars lie beyond
  2 sigma (4.0 expected) and 5 beyond 3 sigma (0.26 expected). The quoted errors are too small for roughly 5-10 % of
  the stars (listed below). Nothing was tuned after seeing this.
- Fastest set (48 measured of 50, 2.39-10.39"/yr): median 5.2 %, P90 16.3 % (0.19"/yr); 54 / 79 / 94 % within
  1 / 2 / 3 sigma; median chi2 1.64 (errors ~9 % small). Random set (38 of 40, 0.51-2.38"/yr): median 14.2 %,
  P90 39.3 % (0.13"/yr); 68 / 89 / 95 %; median chi2 1.09 (errors ~12 % large).
- Saturated (wing fit, 33): median 5.3 % (0.22"/yr), 64 / 88 / 97 %. Not saturated (53): median 8.7 % (0.14"/yr),
  58 / 81 / 92 %.
- By speed class ("/yr; n; median %; median "/yr; within 1/2/3 sigma): 0.5-0.7: 9, 19.8 %, 0.11, 67/89/89 %;
  0.7-1: 10, 23.8 %, 0.20, 60/90/100 %; 1-2: 9, 8.3 %, 0.09, 89/89/89 %; 2-4: 42, 6.2 %, 0.18, 57/79/93 %;
  > 4: 16, 4.0 %, 0.23, 50/88/100 %. The error in "/yr is similar in every class, so the percentage grows for
  slow stars.
- Smallest motion seen at 5 sigma: 0.64"/yr (median per-axis error 0.13"/yr); unsaturated 0.47"/yr, saturated 0.72"/yr.
- Same-orientation season pair (displacement over ~1 yr / dt): 86 stars, median |speed - Gaia| 4.3 %, 80 % within 2 sigma.
- Independence (starting track wrong by +10 %): median pull 0.003, 90th percentile |pull| 0.23; 18 of 86 stars above
  0.1, 6 above 0.3 (PM J12445-1306N 0.35, eps Ind 0.35, HD 217357 0.46, PM 13391-3400 0.61, HD 112943 -1.01,
  L 205-56 -3.28; the last two are dof = 0 fits). For the typical star the result does not depend on Gaia's value.
- Registration: median 33 % of exposures get their own exposure/cell Gaia offset; 37 of 86 stars have some
  exposures with no Gaia registration.

Stars beyond 3 sigma (kept in every statistic):

| # | star | Gaia "/yr | measured "/yr | diff % | sigma | pair "/yr | note |
|---|---|---|---|---|---|---|---|
| 62 | HD 132142 | 1.082 | 5.091 +- 0.831 | 370 | 4.4 | 1.118 | dof = 0 two-season fit (core issue below); its own season pair agrees with Gaia |
| 69 | LAWD 37 | 2.684 | 2.244 +- 0.094 | 22 | 6.4 | 2.209 | 18 of 54 exposures unregistered; the code's judge flags "position at 2026 within 0.2" of Gaia but drift implies 6" since 2016" |
| 57 | Ross 578 | 3.066 | 2.389 +- 0.119 | 22 | 5.3 | 2.749 | same judge flag; Gaia RUWE 1.4 (possible binary) |
| 82 | BD+02 348 | 2.557 | 2.242 +- 0.107 | 17 | 3.7 | 2.256 | saturated wing fit |
| 48 | G 254-24 | 0.614 | 0.327 +- 0.085 | 47 | 3.0 | 0.335 | only 42 exposures planned (all read); third season 5 exposures |

Failures (stay in the table):

| # | star | Gaia "/yr | SPHEREx AB | reason |
|---|---|---|---|---|
| 32 | HD 125455B | 0.643 | 11.3 | no drift fit (target S/N < 10 or < 3 exposures in < 2 seasons) |
| 33 | omi02 Eri B | 4.019 | 10.8 | no drift fit (same) |
| 46 | EGGR 536 | 1.284 | 16.7 | no drift fit (same) |
| 73 | 2MASS J05325346+8246465 | 2.631 | 16.1 | target not in the Gaia field list: Gaia DR3 has no G magnitude for this L subdwarf, so the field query's G < 19 cut leaves it out (same query at IRSA and ESA) |

## Limits (numbers)

- Cost: 9-33 MB and ~3.5 min of S3 reading per star (FLAGS rows are ~70 % of the bytes; 4 requests in flight).
- Only 54 of the ~360 exposures per star are used: errors are ~2.5x those of a full run (Barnard: 0.12"/yr here
  vs 0.05"/yr with all exposures in the targeted pipeline).
- Error-bar tail: 5 of 86 stars beyond 3 sigma (0.26 expected). Two symptoms in the v1 core, reported, not fixed:
  (a) `astrometry._fit_cells` returns two-season fits with dof = 0 for 8 of 86 stars (HD 112943, Teegarden's Star,
  omi02 Eri C, L 205-56, G 215-50, G 3-33, HD 132142, Ross 47): the permutation error cannot be calibrated with no
  residuals, and these give the two largest pulls and the largest percentage miss (HD 132142); (b) two faint stars
  (LAWD 37, Ross 578) measured ~22 % slow while their 2026 positions match Gaia to 0.2", which the judge itself flags.
- Saturated stars measured on two seasons only (the single opposite-orientation season of a wing fit only fixes its
  own offset).
- VARIANCE and ZODI are not read (synthetic, as in local/quick.py); per-exposure weights are therefore uniform.
- The sweep process grows ~250 MB per star (not in the launcher; not investigated in the frozen code).

## Two-line summary for the evidence page

EN: We measured the motion of 86 of a pre-registered list of 90 fast stars in real SPHEREx images with one fixed
method: the median difference from ESA Gaia DR3 is 7 % (5 % for the 48 fastest; 0.17"/yr).
EN: The error bars are right for the typical star (median chi2 1.40, expected 1.39) but too small for a few:
84 % agree within 2 sigma and 94 % within 3 sigma (expected 95 / 99.7 %); the 4 stars we could not measure stay in the table.

TR: Önceden kayda geçirilmiş 90 hızlı yıldızdan 86'sının hareketini gerçek SPHEREx görüntülerinde tek bir sabit
yöntemle ölçtük: ESA Gaia DR3'ten ortanca fark %7 (en hızlı 48 yıldızda %5; 0,17″/yıl).
TR: Hata çubukları tipik yıldız için doğru (ortanca χ² 1,40, beklenen 1,39) ama birkaç yıldızda küçük: %84'ü 2σ,
%94'ü 3σ içinde uyuşuyor (beklenen %95 / %99,7); ölçemediğimiz 4 yıldız tabloda duruyor.

## README paragraph (how well do our motions agree with ESA Gaia over many stars?)

Before measuring anything we wrote down a list of 90 fast-moving stars: the 50 fastest that SPHEREx saw twice from
the same angle, plus 40 picked at random across five speed ranges. We then measured every one of them in real
SPHEREx images with a single fixed method, using ESA's Gaia catalogue only to line up the other stars in each image,
never the star being measured. 86 of the 90 gave a motion; the 4 that did not are kept in the table with the reason.
The typical star agrees with Gaia to 7 % (5 % for the fastest 48), which is about 0.17 arcseconds per year. When we
deliberately started the fit from a motion that was 10 % wrong, the answer typically moved by well under 1 % of that
error, so the result comes from the images, not from Gaia. Our error bars are right for the typical star, but a few
stars miss by more than their error bars say: 94 % agree within 3 sigma, where 99.7 % would be ideal. We publish
those misses, and their likely causes in our code, instead of hiding them. The full table, the figure and every
number are in site/data/fast_sweep/ and pipeline/FAST_SWEEP.md.
