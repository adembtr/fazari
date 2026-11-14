# Relative astrometry against Gaia DR3 field stars

Reference implementation: `pipeline/blink.py` (`reference_stars`, `calibrate_exposure`,
`field_calibration`). The constants below are the ones in the code (`CAL_*`).

## Purpose

Every SPHEREx exposure is tied to Gaia DR3 with the field stars in the same exposure. The
target position measured in that exposure is then corrected by the field-star offset. The
result is that target positions are on the Gaia frame, not just on the SPHEREx L2 WCS.

## Catalogue and propagation

- Gaia DR3 stars within 0.15 deg of the target (at 2026.0) with G < 19. They are cached in
  `site/data/<target>/gaia_field.json`. For wider cutouts the radius grows to the farthest cutout
  corner (0.4 deg cutouts: ~0.29 deg; `footprint_radius`), and a cache with a smaller query radius
  is not used. Columns: source_id, ra, dec, pmra, pmdec, parallax,
  phot_g_mean_mag, ruwe. Reference epoch J2016.0.
- Each star is propagated to the exposure mid-time (`MJD-AVG`) with the same function as the
  target:
  - `dt = jyear(MJD) - 2016.0`
  - `dRA* = pmra*dt / (1 + mu_r*dt)` and `dDec = pmdec*dt / (1 + mu_r*dt)`, with
    `mu_r = rv*plx/4.740470446/206264806.247` per yr (rv = 0 when unknown)
  - Annual parallax uses the Earth's barycentric position (X, Y, Z in AU):
    - `dRA* += plx*(X sin a - Y cos a)`
    - `dDec += plx*(X cos a sin d + Y sin a sin d - Z cos d)`
  - Then `RA = ra + dRA*/cos(dec)` and `Dec = dec + dDec` (mas converted to deg).

## Reference-star selection (per target)

- 10 <= G <= 17.5. The star needs a 5- or 6-parameter solution (pmra and parallax present)
  and RUWE <= 1.4.
- Isolated: no other Gaia star (G < 19) within 12 arcsec.
- The target itself (`gaia_dr3` id) is excluded.

## Per exposure

1. Skip stars within 40 arcsec of the target's predicted position.
2. Compute the predicted pixel with the exposure's WCS (`all_world2pix`, origin 0). Keep the
   star only if:
   - it is >= 7 px from the cutout edge;
   - no saturated or missing pixel lies within the 5x5 box around it (FLAGS OVERFLOW,
     SUR_ERROR or NONLINEAR, or NaN);
   - its forced-photometry S/N is >= 20 (EPSF flux at the predicted position).
3. Centroid the star with the same estimator as the target:
   - Bright-target path: a pixel-integrated circular Gaussian fitted to an 11x11 native-pixel
     box. Variance comes from the VARIANCE layer plus a 5 % model error. Bad pixels are
     masked.
   - Faint-target path: a free-position EPSF fit (flux, x, y, constant background) on the
     11x11 box.
4. Residual = measured - Gaia, as tangent-plane offsets (east, north) in arcsec. Reject the
   star as a mismatch if |residual| > 2.0 arcsec. Keep the star's lever arm `xE, xN` (offset
   from the target, degrees) and its source_id.

## Per season x detector cell (pooling)

Single exposures have only ~5-25 usable stars (D5/D6 often < 5). All star residuals of one
season and one detector are pooled, i.e. same pointing pattern, same orientation and same
detector.

1. Fit model:
   - Default is shift only: `a = mean dE` and `b = mean dN`.
   - Shift + rotation + scale (`dE = a + s*xE - r*xN`, `dN = b + r*xE + s*xN`) is used only
     when the cell has >= 12 DISTINCT stars that surround the target:
     `|mean lever arm| < 0.3 * rms spread of the lever arms`.
   - With few distinct stars, (a, b) at the target would be an extrapolation. This was seen
     in tests: tens of arcsec from 2-3 stars.
   - The correction at the target is (a, b).
2. Clipping: residual length `rr = hypot(resE, resN)`.
   `sigma = max(1.4826*median(rr)/1.1774, 0.05")` (median of a 2D Rayleigh = 1.1774 sigma).
   Keep `rr < 3 sigma`. Iterate up to 5 times, or until the kept set stops changing.
3. Error: `err_E = std(resE_kept, ddof=1)/sqrt(min(N_kept, N_distinct))`, and the same for N.
   Repeated measurements of one star share its catalogue and blend error, so the number of
   independent points is the number of distinct stars.
4. Accept the cell if it has >= 5 distinct stars, >= 20 kept measurements, and
   err_E, err_N <= 0.08 arcsec. Otherwise use the median (a, b) of the accepted cells of the
   same season. All six detectors observe simultaneously, and their offsets agree to
   ~0.03 arcsec in the tested fields. If the season has no accepted cell, apply no correction
   (flagged in `meta.json`).
5. Apply the correction to every exposure of the cell:
   - Bright path: `RA_corr = RA_meas - a/3600/cos(Dec)` and `Dec_corr = Dec_meas - b/3600`.
   - Faint path: a source at true offset `o` from the prediction sits at WCS offset `o + (a, b)`,
     so the trial positions of the season EPSF fit are shifted by (a, b).

Per-exposure fits are also computed, but only as a diagnostic: `per_exposure_chi2r` is the
scatter of single-exposure offsets about the cell value, in units of their errors.

## Field-star neighbours of a bright target (bright path only)

Before the calibration, the saturated target's wing fit is redone with nearby bright Gaia DR3
stars modelled.

- Stars with G < 17 and more than 2.5 native px (15 arcsec) from the target are moved to the
  exposure epoch (proper motion) and placed with the WCS.
- Each is fitted as an extra pixel-integrated Gaussian with the same width as the target, at
  its fixed position, with a free flux.
- Fainter or closer stars are left out. A free flux right next to a saturated core soaks up
  wing light: when all G < 19 stars were fitted, Barnard's proper motion moved by -250 mas/yr.

Barnard's Star shows why this matters.

- A G = 15.0 star 35 arcsec to the NE sits in the corner of the 11x11 px fit box.
- Without it modelled, the joint-fit position offset grew with the box size: 0.26, 0.41 and
  0.48 arcsec (total) for 11, 15 and 19 px boxes. It always pointed NE, in both orientations.

## After calibration

- Bright path (saturated or high S/N targets): the joint fit stays as before. It fits
  position, free proper motion, fixed parallax and one detector-fixed centroid bias per
  detector, with 3.5 sigma clipping.
- Faint path: season positions come from the EPSF chi2 grid search, followed by a weighted
  linear fit.
- Per season, `measured - predicted` is reported in `meta.json`
  (`measured.positions[].minus_gaia_*`). The per-exposure corrections are written to
  `images.csv` (`calib_east_arcsec`, `calib_north_arcsec`, `calib_nstars`).

## Diagnostics (2026-11-14)

- Field stars measured with the Gaussian centroid agree with Gaia DR3 to 0.0-0.25 arcsec per
  detector and orientation. The sign flips with the telescope orientation, so this is a small
  detector-fixed centroid bias, not a sky-fixed WCS error. The SPHEREx L2 WCS is on the Gaia
  frame at the <~0.1 arcsec level.
- Barnard's Star: Gaia DR3 RV = -110.47 km/s. Perspective acceleration adds +0.064 arcsec
  along the proper motion over 2016 -> 2026 and is included. The propagation (proper motion,
  perspective, parallax from the Earth's barycentric position at MJD-AVG) agrees with astropy
  `SkyCoord.apply_space_motion` plus a topocentric parallax to < 1 mas.
- Barnard's Star, measured - Gaia per season (E, N; +-0.04 arcsec):
  - without the neighbour model: (+0.17, +0.22), (+0.19, +0.15), (+0.20, +0.10);
  - with the neighbour model: (-0.05, +0.15), (-0.05, +0.13), (-0.05, +0.11).
- The remaining ~+0.13 arcsec N is not understood.
  - Candidates: fainter (G > 17) neighbours to the N, and the saturation-dependent wing bias
    in D1/D2. In those detectors the core covers 40-50 % of the fit box, and the
    per-detector offsets there are 0.2-0.4 arcsec, against <= 0.1 arcsec in D3-D6.
  - Adding terms for saturation size, wavelength or detector position to the bias model did
    not change the common offset.
  - Saturated Gaia reference stars cannot calibrate it in these cutouts: only 6 measurements
    of saturated, isolated stars exist in the 0.2 deg Barnard cutouts.
- Epsilon Indi B: the Gaia DR3 solution (6412596012146801152) has RUWE 4.30, astrometric
  excess noise 5.8 mas (significance 425) and ipd_frac_multi_peak 8 (Ba+Bb are not resolved
  in that solution). The measured - Gaia offset of about +0.25 arcsec E, -0.5 arcsec N is the
  same before and after the field-star calibration.

## Per-star export: field_stars.csv

Format final (2026-11-14). Column names and meanings below are fixed; new columns are only
ever appended at the end.

- One row per reference star x exposure: every reference star (selection above) whose Gaia
  position falls on the exposure, used by the calibration or not (`status` says why not).
  Other Gaia stars (G > 17.5, RUWE > 1.4, not isolated, 2-parameter) are not measured.
- Only an export. The calibration does not change: `meta.json` and `images.csv` are identical
  with and without it.
- Python: `field_calibration()` writes `<out>/<target>/field_stars.csv` next to `images.csv`.
  - On by default when the products do not go to the repo's `site/data`, i.e. local engine
    jobs and runs with `FAZARI_OUT`. Off for the site data.
  - `FAZARI_FIELD_STARS=1` / `0` forces it on / off.
  - Written only when the field calibration runs: motion targets detected in >= 2 seasons.
  - Cost (Barnard's Star): +3 s on a 2 min run (2.5 %), of which 1.4 s is the CSV write, and
    +90 MB peak memory. With the export off the run time is unchanged.
  - Size. Barnard's Star: 52 369 rows, 165 stars, 358 exposures, 17 MB. Eps Indi B: 21 120
    rows, 50 stars, 458 exposures, 7 MB.
- Browser: `SkySession.astrometry().fieldStars = {columns, rows}` (`calib.js`
  `fieldStarTable`), with the same columns. Rows are arrays in column order, and null means
  empty. `fieldStarsCsv(table)` gives the same CSV text.
- Empty cell = not measured / not available.

| column | meaning |
|---|---|
| `source_id` | Gaia DR3 source_id |
| `gaia_g` | Gaia G (phot_g_mean_mag) |
| `gaia_bp_rp` | Gaia BP-RP. Empty for now: not in `gaia_field.json` or the browser query |
| `gaia_ruwe`, `gaia_pmra`, `gaia_pmdec`, `gaia_parallax` | Gaia DR3 (mas/yr, mas) |
| `file` | image file name (Python: the cutout; browser: the S3 file) |
| `obs_id`, `collection` | IRSA obs_id; `dr1` / `qr3` |
| `mjd` | exposure mid-time `MJD-AVG`, the epoch of the Gaia prediction |
| `season` | season label `YYYY-MM` (`epoch` in `images.csv`) |
| `detector` | `D1` .. `D6` |
| `wavelength_um` | wavelength at the star's predicted pixel (the LVF wavelength changes by ~0.035 um across a cutout). Browser: the exposure's wavelength at the target, until `sky.js` passes `file` to `calibrateExposure` |
| `bin_um` | blink wavelength bin of the exposure; empty if it is in none |
| `orient_deg` | sky angle of the detector x axis, `atan2(PC2_1, PC1_1)`. The two orientations are ~180 deg apart, which flips any detector-fixed bias on the sky |
| `ra_gaia`, `dec_gaia` | Gaia position at `mjd` (proper motion + parallax, as for the target), deg |
| `x_pred`, `y_pred` | that position in 0-based pixels (Python: cutout pixels; browser: pixels of the full image) |
| `lever_east_arcsec`, `lever_north_arcsec` | star minus target, tangent plane (Python: target's predicted position; browser: target's measured position) |
| `x_meas`, `y_meas` | centroid, px |
| `ra_meas`, `dec_meas` | centroid through the exposure's own WCS (no field correction applied), deg |
| `east_arcsec`, `north_arcsec` | measured minus Gaia, tangent plane E / N, arcsec, raw WCS |
| `east_err_arcsec`, `north_err_arcsec` | centroid error in E / N: formal covariance of the fit x `fit_chi2r`, through the local WCS Jacobian |
| `centroid_method` | `gauss` (bright path, browser) or `epsf` (faint path) |
| `psf_sigma_px` | width of the Gaussian fit, px; empty for `epsf` |
| `fit_npix`, `fit_chi2r` | pixels in the centroid fit, its reduced chi2 (`err / sqrt(fit_chi2r)` = unscaled formal error) |
| `flux_ujy`, `flux_err_ujy` | flux in uJy (see `flux_method`) |
| `snr` | S/N of the selection cut (Python: forced-photometry flux / error; browser: Gaussian peak / pixel noise) |
| `flux_method` | `epsf_forced`: EPSF at the predicted position (Python); `gauss_fit`: Gaussian fit flux (browser, ~0.9 x the EPSF flux) |
| `status` | `used`, or why not: `near_target`, `edge`, `saturated_or_missing`, `no_photometry`, `low_snr`, `centroid_failed`, `bad_width` (browser), `mismatch` (> 2 arcsec) |
| `cell_kept` | 1 / 0: kept / clipped in its season x detector cell fit; empty if not used or the cell had < 5 stars |
| `cell_resid_east_arcsec`, `cell_resid_north_arcsec` | `east/north_arcsec` minus the cell model (WCS - Gaia) at this star |
| `calib_east_arcsec`, `calib_north_arcsec` | correction applied to the exposure (cell or season median, WCS - Gaia at the target); empty if none |

- Measured columns are filled for `used` and `mismatch` (browser also `low_snr`, `bad_width`).
  The flux is filled from `low_snr` on (browser: whenever a fit exists).
- Offset on the Gaia frame: `east_arcsec - calib_east_arcsec` (same for north), or
  `cell_resid_*` (also removes the rotation/scale of the cell model).
- Error check (2026-11-14): one star measured >= 5 times in one season x detector cell. The
  scatter of its offsets is 0.8-1.3 x `east/north_err_arcsec` when `fit_chi2r` < 5. It is
  0.4-0.65 x when `fit_chi2r` > 5 (bright stars; most of the Barnard field). The errors are
  about right or conservative. The scatter also contains the per-exposure WCS jitter.
- Browser vs Python on the same cutouts (5 exposures, Barnard + Eps Indi B):
  - Gaia position: < 0.1 mas. Predicted pixel: < 1e-4 px. Wavelength at the star: < 1e-5 um.
  - Centroids: 0.01-0.03 px median, 0.1 px max (different noise weights and bad-pixel masks).
  - The selection differs: different S/N definition, and the browser has the `bad_width` cut.
