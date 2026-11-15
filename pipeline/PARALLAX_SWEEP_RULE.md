# Parallax of the fast-star sweep stars: rule written before any parallax is fitted

Written 2026-11-15 ~10:25 +03 and committed alone, before the fit code exists and before any parallax of these stars
is computed. Its git commit and the GitHub push time are the proof of the order; they are recorded in
`pipeline/PARALLAX_SWEEP.md` (the results file), not here, so that this file is not edited after the commit.

What was looked at before writing this: the format of one result file (G 249-36: its season positions, errors,
orientations), the code that makes the season positions (`pipeline/fast_sweep.py`, `detect/astrometry.season_table`),
and the counts of the selection below (made from the selection fields only: seasons, `sat`, judge class/flags,
Gaia parallax present). No parallax was fitted, and no measured position was compared with a Gaia parallax.

## Question

The fast-star sweep (`pipeline/FAST_SWEEP.md`, test V12) measured proper motions. Its season positions also hold the
yearly parallax wobble. Do the same positions give parallaxes that agree with Gaia DR3, for many stars at once?

## Data (nothing new is read or downloaded)

- `cache/fast_sweep/results/B0.12_K3/*.json`, the 86 stars with `ok: true`. Per season: `jyear` (mean time of the
  exposures used), `ra`, `dec` (deg; Gaia-registered on the other stars of the box, the target excluded), `eE`, `eN`
  (arcsec, statistical), `orient`, `sat`. Per star: `floor` (arcsec, the per-season systematic of the field) and
  `error_inflation` (bootstrap / formal ratio of the drift fit, >= 1).
- Gaia DR3 parallax of each star: `site/data/fast_stars.json.gz`, column `plx` (mas). Its error is not in that file;
  Gaia DR3 parallax errors of these stars are below 1 mas, far below ours, and are taken as 0.

## Sample

- **Primary sample (decides the test)**: `ok` stars with
  1. >= 3 seasons in `seasons[]`, and both telescope orientations present (needed for any parallax);
  2. judge clean: `judge_cls == "gaia-known"` and no judge flag other than "known mover confirmed";
  3. a Gaia DR3 parallax > 0;
  4. **no saturated season** (`sat` false in every season).
  Count from the selection fields: **29 stars**.
- Why point 4: a saturated season position is a wing fit, and the code documents that the wing-fit bias "is fixed in
  detector axes and flips with the 180 deg turn" (`detect/astrometry.py`, docstring point 3). SPHEREx looks at about
  90 deg from the Sun, so its orientation flips every half year, exactly in step with the parallax wobble. For a
  saturated star the orientation bias and the parallax cannot be separated, so these stars cannot test parallax.
- **Secondary (reported, not deciding)**: the 51 stars that pass 1-3 but have a saturated season; and all 80 judge-clean
  stars together. The 6 stars that fail point 2 (G 254-24, G 215-50, Ross 578, LAWD 37, L 205-56, LP 409-28) are listed
  with their numbers but take no part in any statistic.

## Model

- Tangent plane at the star's first season position. Per season k: east xi_k = (ra_k - ra_0) cos(dec_0) * 3600,
  north eta_k = (dec_k - dec_0) * 3600 (arcsec).
- xi_k = xi0 + muE * (t_k - t0) + plx * PE_k;  eta_k = eta0 + muN * (t_k - t0) + plx * PN_k.
  5 parameters (position E/N, proper motion E/N, parallax). t0 = mean of the season times.
- Parallax factors PE, PN: the observer's solar-system barycentric position at `jyear` of the season (the same function
  the pipeline uses, `detect/calib.parallax_factors`: Earth barycentric position from astropy `get_body_barycentric`).
  SPHEREx is in low Earth orbit (~700 km): its offset from the Earth's centre is 4.6e-5 AU, i.e. < 0.03 mas for any
  star (the largest Gaia parallax here is < 800 mas), so the Earth's position is used. The factor is taken at the mean
  season time, not averaged over the exposures (exposure times are not stored); for exposures within ~10 days of that
  mean this changes the factor by < 2 %.
- Errors per season and axis: sigma = sqrt((eE * error_inflation)^2 + floor^2) (same for N). Weighted least squares;
  parameter errors are the formal ones from these sigmas. They are **not** rescaled by the fit's own chi2.
- **Degrees of freedom**: 3 seasons give 6 numbers for 5 parameters, dof = 1; 4 seasons, dof = 3. With dof = 1 the fit
  cannot check itself: the parallax rests almost entirely on the one season of the other orientation. This is stated
  with every result.
- Known, untestable risk: any position error that flips with the telescope orientation (PSF asymmetry, detector-mix of
  a pooled season mean) enters the parallax one to one, as in point 4. Only the comparison with Gaia can show it.

## Comparison with Gaia DR3

- Per star: z = (plx_meas - plx_Gaia) / sigma_plx. Within 3 sigma: |z| <= 3.
- Overall scale s (fit of plx_meas = s * plx_Gaia, weights w = 1 / sigma_plx^2):
  s = sum(w * plx_meas * plx_Gaia) / sum(w * plx_Gaia^2), sigma_s = 1 / sqrt(sum(w * plx_Gaia^2)).
  chi2_s = sum(w * (plx_meas - s * plx_Gaia)^2); if chi2_s / (N - 1) > 1, sigma_s is multiplied by
  sqrt(chi2_s / (N - 1)). The decision uses this (possibly enlarged) sigma_s.
- Also reported (not deciding): the scale with formal errors only (no `error_inflation`), the weighted mean of
  plx_meas - plx_Gaia, the 4-season stars on their own, the secondary groups, the per-star fit chi2.

## Decision (test V13, primary sample only)

1. N < 10 stars: **limit** (too few to decide).
2. Else **fail** if |s - 1| > 3 * sigma_s, or fewer than 95 % of the stars are within 3 sigma (with 29 stars: 28 must be).
3. Else **limit** if sigma_s > 0.20 (the parallax scale is not measured well enough to call it right).
4. Else **pass**.

Nothing in this file is changed after the fit. Any later change would be written in `PARALLAX_SWEEP.md` as a recorded
change, with the time and what was known when it was made.
