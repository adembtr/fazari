# Spectrum flux check against 2MASS and AllWISE: results

Rules: `pipeline/SPECTRUM_CHECK_PREREG.md`, committed and pushed before any comparison star was measured (commit 2c1cef0,
GitHub push 2026-11-15 14:02:39 UTC = 17:02:39 +03). Code: `pipeline/spectrum_check.py`. Per-star numbers:
`pipeline/spectrum_check.csv` (one row per star and band). Measurement order: `pipeline/spectrum_check_order.csv`.
A read-only check: `pipeline/spectrum.py`, `pipeline/blink.py` and `site/` were not changed; every star was measured by
the engine's own command line (`spectrum.py <id> --target-json ... --data-target <field> --out <scratch>`).

## Result

Verdict under the pre-registered rules (full-coverage tier; pass |median R - 1| <= 0.03, limit <= 0.06, fail beyond):

| band | N | median R +- error | robust scatter | floor | verdict |
|---|---|---|---|---|---|
| J | 55 | 0.986 +- 0.006 | 0.027 | 0.014 | pass |
| H | 54 | 1.009 +- 0.005 | 0.027 | 0 | pass |
| Ks | 82 | 1.027 +- 0.005 | 0.030 | 0 | pass (the 1-sigma interval reaches 1.032, over the 0.03 line) |
| W1 | 39 | 1.006 +- 0.004 | 0.025 | 0.008 | pass |
| W2 | 34 | 1.049 +- 0.004 | 0.023 | 0 | limit |

- The engine's flux scale agrees with 2MASS J/H and AllWISE W1 to about 1 % on isolated, unsaturated field stars,
  with Ks 2.7 % high and W2 4.9 % high. Star-to-star scatter is 2.3-3.0 % in every band.
- The errors the engine gives already account for that scatter: the pull width is 0.77-1.18, so the systematic floor that
  brings it to 1 is 0 (H, Ks, W2), 0.8 % (W1) and 1.4 % (J).
- The full-coverage tier comes from the five `veri/real_spherex` fields (all J/H/W1/W2 stars, 54 of the 82 Ks stars).
  The 24 local fields give the partial tier (no verdict), which agrees for Ks (1.017), W1 (0.995) and W2 (1.037) and not
  for H (0.937; see below).
- The old caveat "two field stars agree to 0.93-1.06" is consistent with this; this check narrows it to the numbers above.

## How it was measured (short)

- 435 of the 516 planned stars were measured (in the pre-registered random order, seed 20261115) between 17:42
  and 19:45 +03, with a pause from 18:49 to 19:20; the stop at 19:45 left the rest unmeasured. Because the order is random,
  the measured stars are an unbiased subset of the sample. One more star was measured at 17:04 (see "Deviations").
- 29 fields with SPHEREx cutouts already on disk; 27 contribute stars. The five `veri/real_spherex` fields (barnard,
  eps_indi_b, r_dra, rw_aur, wise0855; 258-539 cutouts, 3-4 seasons) cover the whole 0.75-5 um range, so they give the
  full-coverage (verdict) tier. The 24 local field-job cutout sets (24-110 cutouts) cover only about half of each
  detector's range (e.g. Ks 2.03-2.12 um, H 1.42-1.62 um), so their bands are mostly in the partial tier (30-80 % of the
  band covered; the flux is extrapolated to lambda_iso with a Rayleigh-Jeans shape; no verdict).
- Bands: flat top-hat synthesis of the engine's binned spectrum (the `extra_checks.py w2` method) with the Rayleigh-Jeans
  reference spectrum; J [1.154, 1.316], H [1.537, 1.788], Ks [2.028, 2.290], W1 [2.80, 3.80], W2 [4.00, 5.00] um;
  D1 not used. Catalogue fluxes: 2MASS with Cohen et al. (2003) zero points, AllWISE with Jarrett et al. (2011) zero
  points and the Wright et al. (2010) colour correction for F_nu ~ nu^2 (W1 1.0283, W2 1.0206).
- Catalogue rows: VizieR (Gaia DR3 I/355/gaiadr3 with its 2MASS / AllWISE best-neighbour identifiers, 2MASS II/246,
  AllWISE II/328), because the ESA Gaia archive was down (declared in the pre-registration before the push).

## Tables

R = SPHEREx band flux / catalogue flux. Error of the median: standard deviation over 2000 bootstrap resamples. Robust
scatter: 1.4826 MAD of R. Pull width: 1.4826 MAD of (R - median) / sigma_R with the measurement errors only; floor: the
fractional error that has to be added in quadrature so that the pull width is 1. Trends: Spearman rho (p) of R against the
catalogue magnitude in the band, J - Ks, the mean distance of the band's exposures from the detector centre, and Gaia G;
"per season" = the band synthesised from each season of a star alone (s1 = its first season). Last two columns: median R
with exactly the `w2` normalisation (nu^-2, no colour term) and with the AB offsets of `fast_stars.py` (sensitivity only).

### full coverage

| band | N | median R | +- (bootstrap) | robust scatter | pull width (no floor) | floor | verdict |
|---|---|---|---|---|---|---|---|
| J | 55 | 0.986 | 0.006 | 0.027 | 1.18 | 0.014 | pass |
| H | 54 | 1.009 | 0.005 | 0.027 | 0.90 | 0.000 | pass |
| Ks | 82 | 1.027 | 0.005 | 0.030 | 0.94 | 0.000 | pass (1-sigma interval crosses a threshold) |
| W1 | 39 | 1.006 | 0.004 | 0.025 | 1.06 | 0.008 | pass |
| W2 | 34 | 1.049 | 0.004 | 0.023 | 0.77 | 0.000 | limit |

| band | rho(mag) p | rho(J-Ks) p | rho(det. radius) p | rho(G) p | bright / faint half | per season (median R, N) | w2 normalisation | AB offsets |
|---|---|---|---|---|---|---|---|---|
| J | +0.48 (0.00025) | -0.04 (0.79) | +0.30 (0.024) | +0.37 (0.0048) | 0.977 / 0.995 | s1 0.990 (55), s2 0.989 (55), s3 0.983 (55), s4 1.000 (11) | 0.994 | 1.000 |
| H | +0.50 (0.00014) | +0.08 (0.55) | -0.14 (0.32) | +0.51 (7.1e-05) | 0.998 / 1.028 | s1 0.993 (54), s2 1.005 (54), s3 1.017 (54), s4 0.996 (11) | 1.016 | 1.024 |
| Ks | +0.03 (0.82) | -0.36 (0.00097) | -0.15 (0.17) | -0.14 (0.23) | 1.020 / 1.038 | s1 1.010 (82), s2 1.023 (82), s3 1.030 (82), s4 1.029 (11) | 1.042 | 1.036 |
| W1 | +0.67 (3.7e-06) | -0.13 (0.42) | -0.13 (0.43) | +0.56 (0.00022) | 0.991 / 1.017 | s1 1.011 (34), s2 1.008 (39), s3 0.999 (39) | 1.091 | 1.030 |
| W2 | +0.57 (0.00038) | -0.26 (0.15) | -0.00 (0.99) | +0.43 (0.011) | 1.043 / 1.061 | s1 1.026 (34), s2 1.048 (34), s3 1.046 (34), s4 1.055 (5) | 1.152 | 1.075 |

### partial coverage

| band | N | median R | +- (bootstrap) | robust scatter | pull width (no floor) | floor | verdict |
|---|---|---|---|---|---|---|---|
| J | 0 | - | - | - | - | - | - |
| H | 320 | 0.937 | 0.003 | 0.043 | 1.46 | 0.034 | no verdict (partial coverage) |
| Ks | 331 | 1.017 | 0.003 | 0.035 | 1.09 | 0.014 | no verdict (partial coverage) |
| W1 | 291 | 0.995 | 0.001 | 0.018 | 0.63 | 0.000 | no verdict (partial coverage) |
| W2 | 275 | 1.037 | 0.003 | 0.031 | 0.99 | 0.000 | no verdict (partial coverage) |

| band | rho(mag) p | rho(J-Ks) p | rho(det. radius) p | rho(G) p | bright / faint half | per season (median R, N) | w2 normalisation | AB offsets |
|---|---|---|---|---|---|---|---|---|
| H | +0.27 (6.5e-07) | -0.69 (2.1e-47) | +0.11 (0.06) | -0.17 (0.002) | 0.925 / 0.950 | s1 0.932 (292), s2 0.936 (303), s3 0.935 (280), s4 0.969 (6), s5 0.905 (1) | 1.153 | 0.951 |
| Ks | +0.10 (0.064) | -0.36 (8.6e-12) | -0.00 (0.99) | -0.13 (0.015) | 1.014 / 1.025 | s1 1.011 (277), s2 1.019 (331), s3 1.020 (317), s4 1.018 (2) | 1.201 | 1.026 |
| W1 | +0.40 (8e-13) | -0.40 (2.3e-12) | +0.08 (0.18) | +0.10 (0.1) | 0.990 / 1.003 | s1 0.992 (285), s2 0.995 (288), s3 0.998 (216) | 1.433 | 1.019 |
| W2 | +0.26 (9.1e-06) | -0.03 (0.61) | +0.04 (0.5) | +0.22 (0.00023) | 1.031 / 1.050 | s1 1.029 (237), s2 1.039 (266), s3 1.035 (259), s4 1.077 (2) | 1.223 | 1.062 |

### Cuts

| step | stars |
|---|---|
| selected: Gaia DR3 star with a 2MASS best neighbour, 9.5 <= Ks <= 13.5 (29 fields) | 11041 |
| removed, cut 2: outside the cutouts or the cached Gaia list | 6066 |
| removed, cut 3: Gaia VARIABLE, or RUWE missing / >= 1.4 | 544 |
| removed, cut 4: < 60" from the field target or < 90" from a G < 9 star | 152 |
| removed, cut 5: a comparable Gaia / 2MASS / AllWISE neighbour within 18" | 3763 |

Left after cuts 1-6: 516 stars (no duplicates between fields). Per band, among the 435 measured stars, dropped by:

| band | catalogue quality (rule 7) | no AllWISE match | no catalogue mag | saturated bin (rule 9) | coverage < 30 % |
|---|---|---|---|---|---|
| J | 5 | 0 | 1 | 1 | 373 |
| H | 4 | 0 | 0 | 16 | 41 |
| Ks | 3 | 0 | 0 | 10 | 9 |
| W1 | 96 | 1 | 0 | 0 | 8 |
| W2 | 113 | 1 | 0 | 4 | 8 |

Planned 516, measured 435, engine failed 0, no Gaia neighbour model 0; fields measured: 27.

## Reading the numbers

- Brightness: in J, H, W1 and W2 the ratio rises towards fainter stars (Spearman rho +0.48 to +0.67, p < 0.001);
  bright half vs faint half differ by 1.8-3.0 % (e.g. H 0.998 / 1.028, W1 0.991 / 1.017). Ks shows none (rho +0.03).
  Possible causes, not tested here: a small positive bias of faint fits (background or unmodelled faint neighbours) or a
  slight non-linearity near the bright end. The effect is at the level of the scatter.
- Colour: Ks has a negative trend with J - Ks (rho -0.36, p = 0.001): redder stars come out lower. Plausible cause: the
  Rayleigh-Jeans reference is a poor shape for the coolest stars (CO bands beyond 2.29 um, H- opacity peak at 1.6 um).
  J, H, W1, W2: no significant colour trend in the full tier.
- Detector position: J has a weak trend with distance from the detector centre (rho +0.30, p = 0.02); the other bands none.
- Season: within the same stars, Ks goes 1.010 / 1.023 / 1.030 over seasons 1-3 and H 0.993 / 1.005 / 1.017; J, W1, W2
  stay within 1 %. A drift of 1-2 % between seasons, or a season-dependent sampling of the band (different exposures fall
  in each bin), cannot be told apart here.
- W2 (1.049): the top-hat stops at 5.0 um (SPHEREx) while the W2 response runs to about 5.2 um, so the synthesis
  under-represents the red part of the band; with the colour correction this does not explain +5 % by itself. The partial
  tier (local fields, mostly 4.0-4.11 and 4.42-4.70 um) gives 1.037. W2 is the band to look at first.
- Partial H (0.937, strong colour trend rho -0.69): the local fields cover only 1.42-1.62 um of H, and extrapolating that
  to 1.662 um with a Rayleigh-Jeans shape is wrong for real stars (H- opacity peak near 1.6 um). This is a property of the
  extrapolation, not of the flux scale; the full-coverage H (1.009) is the measurement.
- Sensitivity: exactly the `w2` normalisation (nu^-2 reference, no colour term) gives J 0.994, H 1.016, Ks 1.042,
  W1 1.091, W2 1.152 in the full tier; this is the expected effect of the wrong reference shape for stars (+12 % for a full
  W1/W2 top-hat), and it is why the pre-registration chose the Rayleigh-Jeans reference. The AB offsets of
  `fast_stars.py` instead of the Cohen / Jarrett zero points give J 1.000, H 1.024, Ks 1.036, W1 1.030, W2 1.075
  (1.4-2.6 % higher, the known difference between the two zero-point sets).
- No star was lost to an engine failure or to a missing Gaia neighbour model (0 of 435).

## Deviations from the pre-registration

- 17:04 +03, before run 3 had ended: the loop's job check missed run 3 for a few seconds between two of its field
  processes and measured one star (rw_aur, Gaia DR3 156431268792897024, 18.9 s, pinned to CPUs 12-17). The loop was
  stopped at once and the check fixed (the run-3 driver now counts); it restarted at 17:42 when run 3 had ended. The star
  was measured by the unchanged engine, so it stays in the sample (it is rank 1 of the order).
- The temperature guard (pause at >= 90 C) first used a single sensor read, which caught the short spike right after each
  star; from 17:48 it used the median of three reads 0.5 s apart (the run-3 driver uses five 1-s reads). The loop was
  restarted between two stars for this; nothing was lost or measured twice. No measurement number depends on it.
- Measurement stopped at 19:45 +03 as planned with 435 / 516 stars.
- Changes to `pipeline/spectrum_check.py` after the pre-registration commit: the two loop-guard fixes above and the
  markdown rendering of the tables. No cut, band, normalisation, metric or verdict rule was changed.

## Not done

- The remaining 81 stars of the order (random, so the results are not biased by the cut-off).
- No full-coverage stars from the local fields beyond Ks: J, H, W1 and W2 there are partial (extrapolated).
- No check of saturated stars (saturated_wing bins are excluded by rule) and no stars brighter than Ks 9.5.
- The engine and the site caveat ("two field stars agree to 0.93-1.06") are unchanged; whether to cite this check there
  is left to the team.

## Reproduce

    W=<scratch folder outside the repository>
    uv run --no-project --with astropy --with numpy --with scipy python -I pipeline/spectrum_check.py catalog --work $W
    ... sample --work $W      # cuts 1-6 and the order (no pixels)
    ... measure --work $W     # spectrum.py per star, resumable, with the load / time guards
    ... report --work $W      # this file's tables and pipeline/spectrum_check.csv
