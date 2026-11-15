# Parallax of the fast-star sweep stars (test V13)

Code: `pipeline/parallax_sweep.py` (reads only the sweep's result files and `site/data/fast_stars.json.gz`; no new data,
about 1 s). Outputs: `site/data/fast_sweep/parallax.csv` (every one of the 86 measured stars),
`site/data/fast_sweep/parallax_summary.json`.

```
uv run --no-project --with numpy,astropy python -I pipeline/parallax_sweep.py
```

## Rule first, then the fit

- The rule (sample, model, errors, scale, decision) is `pipeline/PARALLAX_SWEEP_RULE.md`. It was committed alone as
  `6549d13` (commit time 2026-11-15 10:10:57 +03) and pushed to GitHub at **2026-11-15T07:11:04Z** (10:11:04 +03; GitHub
  activity API `repos/adembtr/fazari/activity`). The fit code did not exist then; it was written and run after the push.
- Correction: the rule file says "Written 2026-11-15 ~10:25 +03". That time was a wrong estimate typed into the file;
  the file was committed at 10:10:57. The rule file is left unchanged, as it promises.
- What was seen before the rule: the format of one result file (G 249-36), the code that makes the season positions,
  and counts of the selection fields. No parallax had been fitted (listed in the rule file).
- No change to the rule was made after the fit.

## Method (short; full text in the rule file)

- Data: the season positions of the fast-star sweep (`cache/fast_sweep/results/B0.12_K3/*.json`, `seasons[]`):
  per season the mean time, RA/Dec registered on the other Gaia stars of the 0.12 deg box, errors.
- Model per star: position (E, N) + proper motion (E, N) + parallax, 5 parameters, weighted least squares in the tangent
  plane. Parallax factors from the Earth's barycentric position (astropy) at each season's mean time; SPHEREx's
  low-Earth-orbit offset from the Earth's centre (4.6e-5 AU) is < 0.03 mas for every star here and is ignored.
- Errors per season and axis: sqrt((e * error_inflation)^2 + floor^2), with the sweep's own `error_inflation` (bootstrap /
  formal ratio of its motion fit) and `floor` (per-season systematic of the field). Gaia DR3 parallax errors are not in
  the local files; for these nearby stars they are about 1 mas or less, against our median 41 mas, and are taken as 0.
- **Degrees of freedom: 3 seasons give 6 numbers for 5 parameters, dof = 1 (25 of the 29 primary stars); 4 seasons, dof = 3
  (4 stars).** With dof = 1 a star's fit cannot check itself: its parallax rests on the one season of the other telescope
  orientation.
- Primary sample (decides V13): judge-clean stars with >= 3 seasons, both orientations, a Gaia parallax and **no
  saturated season**: 29 stars. Saturated seasons are wing fits whose bias flips with the 180 deg turn of the telescope,
  which happens every half year in step with the parallax; the rule therefore left these 51 stars out of the decision
  and reports them separately.
- Scale s: fit of measured = s x Gaia, weights 1/sigma^2; its error is enlarged by sqrt(chi2/(N-1)) when that is > 1.
- Decision (fixed in the rule): fail if |s - 1| > 3 sigma_s or fewer than 95 % of the stars within 3 sigma; limit if
  sigma_s > 0.20 or N < 10; else pass.

## Result

**Primary sample, 29 stars: scale s = 0.88 +- 0.10** (0.8827; error 0.0976 after the chi2 enlargement, formal 0.0702;
chi2 = 54.1 for 28 dof, 1.93 per dof). |s - 1| = 1.2 sigma_s. **28 of 29 stars within 3 sigma** (96.6 %), 26 within
2 sigma, 14 within 1 sigma (correct errors: about 28.9, 27.7, 19.8). Median parallax error 41 mas. Outside 3 sigma:
PM J12445-1306N (Gaia 10.7 mas, measured -150 +- 46 mas, z = -3.5).

**V13: pass** by the rule (|s - 1| <= 3 sigma_s, 96.6 % >= 95 % within 3 sigma, sigma_s = 0.098 <= 0.20).

What the pass does and does not say:

- The SPHEREx season positions carry the yearly parallax wobble at about the right size: for the 29 unsaturated stars it is
  88 % +- 10 % of Gaia's. The nearest ones are measured individually: Epsilon Indi B 258 +- 54 mas (Gaia 271),
  SCR J1845-6357 286 +- 44 (250), Van Maanen's Star 280 +- 39 (232), HL 4 160 +- 28 (155).
- Signs of a small systematic, not part of the decision: the weighted mean of (measured - Gaia) is -23 +- 7 mas
  (3.4 sigma), the scale scatter is 1.93 times what the errors allow, and 14 of 29 stars are within 1 sigma where about
  20 are expected. At the same time the per-star fits have a median chi2 of 0.15 for dof = 1 (expected 0.45): the
  season positions agree with a smooth track better than their errors say, but the parallax still scatters around Gaia
  by more than its error. That pattern fits an error that flips with the telescope orientation (it moves the parallax
  and nothing else), at the level of a few tens of mas for unsaturated stars.
- With the formal errors only (no `error_inflation`, a secondary number): s = 0.88 +- 0.10 again (formal 0.050,
  chi2/dof 3.9), but only 25 of 29 within 3 sigma, which would fail the 95 % rule. The decision uses the inflated errors
  because the rule fixed them before the fit.
- 4-season stars alone (4 stars, dof 3 each): s = 0.77 +- 0.36; 3-season stars alone (25): s = 0.91 +- 0.10.

### Saturated stars (51; secondary, not part of the decision)

Scale s = 3.39 +- 0.28, chi2/dof 44, 5 of 51 within 3 sigma. Every one of the 51 comes out larger than Gaia; the median
excess is +751 mas (median ratio 4.8). This is the wing-fit bias that flips with the telescope orientation, which the rule
named as the reason to keep these stars out: with SPHEREx's half-yearly turn it is indistinguishable from a parallax.
**The season positions of saturated stars cannot measure a parallax.** Their proper motions (V12) are not affected in the
same way: the sweep fits one offset per orientation and uses same-orientation season pairs.

| star (saturated) | Gaia DR3 (mas) | SPHEREx (mas) | z |
|---|---|---|---|
| Proxima Centauri | 768.1 | 959 ± 73 | +2.6 |
| Barnard's Star | 547.0 | 1553 ± 73 | +13.7 |
| Wolf 359 | 415.2 | 1412 ± 53 | +18.7 |
| HD 95735 | 392.8 | 999 ± 94 | +6.5 |
| G 272-61B | 373.8 | 1227 ± 57 | +15.0 |
| G 272-61A | 367.7 | 1227 ± 57 | +15.1 |
| Lacaille 9352 | 304.1 | 953 ± 91 | +7.2 |
| 61 Cyg B | 286.0 | 1275 ± 314 | +3.2 |

All 80 judge-clean stars together: s = 2.71 +- 0.23 (dominated by the saturated stars).

### Primary sample, every star (sorted by Gaia parallax)

z = (SPHEREx - Gaia) / error. Errors include the sweep's error inflation and floor.

| star | seasons | Gaia DR3 (mas) | SPHEREx (mas) | z | fit chi2 / dof |
|---|---|---|---|---|---|
| Epsilon Indi B | 4 | 270.7 | 258 ± 54 | -0.23 | 2.46 / 3 |
| SCR J1845-6357 | 3 | 249.7 | 286 ± 44 | +0.82 | 0.01 / 1 |
| Van Maanen's Star | 3 | 231.8 | 280 ± 39 | +1.23 | 0.00 / 1 |
| HL 4 | 3 | 155.2 | 160 ± 28 | +0.16 | 0.00 / 1 |
| LAWD 26 | 3 | 122.4 | 69 ± 41 | -1.32 | 0.01 / 1 |
| Wolf 489 | 3 | 119.8 | 58 ± 77 | -0.80 | 0.01 / 1 |
| EGGR 453 | 3 | 117.1 | 61 ± 39 | -1.43 | 0.15 / 1 |
| LEHPM 3396 | 3 | 112.6 | 80 ± 20 | -1.60 | 0.43 / 1 |
| LSR J1826+3014 | 4 | 90.1 | 37 ± 28 | -1.90 | 3.17 / 3 |
| LP 801-9 | 3 | 75.2 | 134 ± 73 | +0.81 | 0.51 / 1 |
| EGGR 199 | 3 | 61.2 | 11 ± 34 | -1.47 | 0.06 / 1 |
| DENIS J125310.8-570924 | 3 | 60.0 | -24 ± 43 | -1.97 | 0.06 / 1 |
| LP 651-7 | 3 | 59.8 | -16 ± 35 | -2.20 | 0.24 / 1 |
| SSSPM J1444-2019 | 3 | 58.1 | 11 ± 41 | -1.14 | 0.33 / 1 |
| PM 13391-3400 | 3 | 48.1 | 99 ± 645 | +0.08 | 0.09 / 1 |
| G 275-92 | 3 | 34.4 | 81 ± 25 | +1.90 | 0.08 / 1 |
| CD-24 17814 | 3 | 34.4 | 63 ± 36 | +0.79 | 1.13 / 1 |
| LP 927-37 | 4 | 33.6 | 24 ± 27 | -0.37 | 0.48 / 3 |
| SCR J1053-3858 | 3 | 31.6 | 18 ± 30 | -0.44 | 0.81 / 1 |
| 2MASS J03060140-0330438 | 3 | 24.7 | -14 ± 63 | -0.62 | 0.11 / 1 |
| GRH 2208-20 | 3 | 23.4 | -50 ± 37 | -1.97 | 0.32 / 1 |
| G 198-58 | 3 | 20.9 | 27 ± 64 | +0.09 | 0.29 / 1 |
| LSR J0609+2319 | 3 | 20.6 | 31 ± 56 | +0.19 | 0.07 / 1 |
| LP 737-32 | 3 | 19.1 | -76 ± 39 | -2.44 | 0.17 / 1 |
| L 716-108 | 3 | 17.4 | 19 ± 41 | +0.04 | 0.17 / 1 |
| L 219-53 | 3 | 11.0 | -27 ± 29 | -1.31 | 0.15 / 1 |
| PM J12445-1306N | 4 | 10.7 | -150 ± 46 | -3.48 | 0.81 / 3 |
| LP 824-3 | 3 | 9.0 | 11 ± 54 | +0.03 | 0.27 / 1 |
| LP 586-57 | 3 | 6.7 | 110 ± 63 | +1.62 | 0.31 / 1 |

PM 13391-3400 has a parallax error of 645 mas (the sweep's error inflation for this star is 7.2) and carries almost no weight.

### Not judge-clean (6; in `parallax.csv`, in no statistic)

G 254-24, G 215-50, Ross 578, LAWD 37, L 205-56, LP 409-28 (judge flags in the CSV). Two of them (G 215-50, Ross 578)
have saturated seasons.

## Limits

- dof = 1 for 25 of 29 stars: a single bad season moves a star's parallax without any sign in its own fit. Only the
  comparison with Gaia over many stars tests it, which is what V13 does.
- The parallax signal and any orientation-dependent position error cannot be separated with SPHEREx's scan (the
  telescope turns by 180 deg every half year, as the parallax wobble reverses). For saturated stars this error dominates
  (above); for unsaturated stars a small one is suggested (mean difference -23 +- 7 mas, chi2/dof 1.9).
- Season positions are pooled over all detectors (the sweep's motion fit uses one offset per detector instead); a change
  in the detector mix between seasons can move a pooled position.
- Parallax factors at the mean season time, not averaged over the exposures (exposure times are not stored); < 2 % of the
  parallax for exposures within ~10 days of the mean.
- Only 54 of the ~360 exposures per star (the sweep's K = 3 per season and detector): a full run would give smaller errors.
- The scale's error is enlarged by sqrt(chi2/dof) = 1.39 and is still a statistical error.
