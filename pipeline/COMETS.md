# Comets in SPHEREx images (showcase)

Page: `site/comets.html` (+ `site/comets.js`, data `site/data/comets/`).
Code: `pipeline/detect/comet_select.py` (selection), `pipeline/detect/comets.py` (boxes, references,
position, photometry), `pipeline/detect/comet_products.py` (blink, stack, coma test, spectrum, site files),
launcher `pipeline/find_comets.py`.

These are **known** objects. Where each comet is at a given time comes from JPL Horizons. What is ours: the
selection over all public SPHEREx images, the pixels read, the tracking, the co-moving stacks and every
measurement (position, motion, coma size, brightness per wavelength). Nothing here is a discovery.

## Selection rule (from data, not from memory)

1. **All comets.** JPL SBDB query (`sb-kind=c`): 4088 comets with osculating elements and total-magnitude
   parameters M1, K1.
2. **Coarse, two-body.** Heliocentric two-body orbit of every comet on a 0.5-day grid over the SPHEREx span
   (MJD 60789–61319), Earth from astropy, total magnitude T = M1 + 5 log Δ + K1 log r. Kept: comets that reach
   T ≤ 17 (92 comets).
3. **Time-matched footprints.** For each of the 1,307,849 L2 images of the sky index (DR1 + QR3), the comet
   position at that image's own mid time (start + 57.6 s) is tested against the image footprint (IRSA
   `s_region` polygon). Coarse margin 1° (two-body error), then:
4. **Horizons.** 38 comets (T ≤ 16.5 in the coarse pass; lost "D/" comets and named fragments dropped) get one
   JPL Horizons request each: geocentric astrometric RA/Dec, Δ, r, T-mag, rates every 2 h (CAP;NOFRAG
   apparition), interpolated to every image mid time; the footprint test is repeated with margin 0. Result:
   `cache/comets/precise_summary.json` (every image that contains each comet, with predicted T).
5. **Pixels decide.** Small boxes are read for the brightest predicted images of the leading candidates; a
   comet is shown when it is clearly detected (aperture S/N ≥ 5 in most images, fitted within 30″ of the
   prediction). Pluto (Horizons body 999) is added as a labelled bonus through the same code path.

## What is read per image

- Exposure header (PRIMARY + IMAGE, 28.8 kB, cached): WCS with SIP, MJD-AVG, spacecraft position X_SC/Y_SC/Z_SC.
- The Horizons position is interpolated to MJD-AVG and moved from the geocentre to SPHEREx
  (`ssoephem.topocentric`, parallax up to ~20″ for a comet 0.3 AU away).
- IMAGE box 49 × 49 px (5.0′) around the predicted pixel, VARIANCE box 13 × 13 px; one HTTP Range request per
  row (box columns only), at most 4 requests in flight with exponential backoff; never a full file.
- Up to 3 references: the same detector over the same sky, taken when the comet had moved at least
  ~10′ away (time from the Horizons rate, ≥ 0.5 d), one per visit, closest in wavelength; each resampled onto
  the target pixels and registered (`asteroids.resample_ref`, `asteroids.register`), median → star image R.
- Difference D = T − R, minus the median of D farther than 18 px from the comet; single-pixel spikes within
  6 px of the comet (≥ 6σ and ≥ 6 × the side-neighbour mean; a centred point source reaches ~4×) replaced.

## Measurements

- **Position**: SPHEREx EPSF fit (asteroids.fit_psf) at the smoothed peak within 2.5 px of the prediction;
  offset = fitted minus Horizons (SPHEREx-centric) in arcsec. For a comet this is the photocentre of the inner
  coma, not the nucleus.
- **Motion**: pairs of detections 0.5–30 h apart; measured speed and direction vs the ephemeris over the
  same pairs.
- **Photometry**: 12.3″-radius aperture (2 px) on D at the fitted centre (at the prediction when the fit is not
  a clear detection); error = robust scatter of 40 empty apertures in the same difference box ⊕ pixel variance.
  Wavelength: the exposure's own WCS-WAVE value at the comet pixel.
- **Coma test**: F(r < 24.6″) / F(r < 9.2″) of the comet (D, fitted centre) vs the same ratio of bright isolated
  stars in the reference image of the same boxes; significance from the scatter over images.
- **Co-moving stack**: every D box resampled onto a north-up 3″ grid centred on the comet's predicted position
  at that image's time; 4σ-clipped mean.
- **Blink**: images of one detector over a short window (comet moves 6–40 px), each re-read over the whole
  blink area and resampled onto one fixed north-up sky grid, so stars stay put; each frame is stretched on its
  own percentiles (each is at a different wavelength).
- **Spectrum**: aperture fluxes of the season with most images, scaled to that season's median geometry
  (F × r² Δ for a coma in a fixed angular aperture; r² Δ² for Pluto), divided by a 5778 K blackbody for the Sun,
  normalised to 1 at 1.0–1.6 µm, 5 % systematic per point. Continuum: linear reflectance fitted at
  λ < 2.55 µm plus a dust blackbody at 1.1 × 278 K / √r scaled on λ ≥ 3 µm points (outside the feature
  windows). Feature windows (H2O gas 2.58–2.85, water ice 2.90–3.20, C–H 3.30–3.52, CO2 4.18–4.34,
  CO 4.56–4.76 µm; Pluto: CH4 ice 1.64–1.80 and 2.20–2.45 µm): weighted mean residual / error, errors scaled
  by √(χ²ᵣ) of the continuum. A feature is **labelled only if |σ| ≥ 5 with ≥ 2 images in the window**.

## Results (site data of 2026-11-14 18:05)

| object | exposures (detected) | dates | JPL T-mag | r / Δ (AU) | S/N median | offset median / p90 | rate JPL → measured (same image pairs, moves ≥ 61″) | coma | spectral bands named (σ) |
|---|---|---|---|---|---|---|---|---|---|
| 3I/ATLAS (C/2025 N1) | 58 (58) | 2025-12-08–2025-12-14 (58) | 15.3–15.6 | 1.98 / 1.81 | 80 | 1.29″ / 2.40″ | 169.0″/h → 169.0″/h (-0.002 %) | yes (51.2σ) | H2O gas (2.7 µm) 30, water ice (3.0 µm) -10, C-H organics (3.4 µm) 13, CO2 gas (4.26 µm) 74, CO gas (4.67 µm) 27 |
| C/2025 R2 (SWAN) | 20 (20) | 2025-10-27–2025-10-28 (20) | 11.7–11.8 | 1.09 / 0.30 | 40 | 2.48″ / 4.54″ | 521.5″/h → 521.5″/h (+0.001 %) | yes (37.3σ) | none |
| C/2025 A6 (Lemmon) | 40 (38) | 2026-02-22–2026-03-03 (40) | 14.6–14.8 | 2.06 / 1.93 | 19 | 1.45″ / 2.69″ | 83.6″/h → 83.6″/h (+0.003 %) | yes (40.7σ) | CO2 gas (4.26 µm) 27 |
| Pluto | 39 (17) | 2025-04-25–2025-04-25 (1); 2025-09-25–2025-10-11 (28); 2026-04-25–2026-05-02 (10) | 14.5–14.6 | 35.25 / 34.85 | 4 | 0.39″ / 3.84″ | 0.9″/h → 0.9″/h (-0.127 %) | no (-2.1σ) | CH4 ice (1.7–1.8 µm) -9 |

S3 data read (byte ranges, payload): 38.9 MB in 51811 requests; Horizons answers during the runs: 0.0 MB.

Not on the page tonight (data read, not solid enough or not finished): C/2023 A3 (Tsuchinshan-ATLAS): 38 exposures
Apr–May 2025, 23 detected, median S/N 6, no blink window; C/2025 K1 (ATLAS): run stopped at 15/44 exposures for the
deadline; 24P and the 10-exposure probes of 210P, 10P, 220P, C/2024 T5, P/2010 H2, 169P: not yet read.
Selection-stage Horizons traffic: 39 requests, ~38 MB (2-h grids, cached in cache/comets/eph/).

Limits (numbers): positions are coma photocentres (median 1.3–2.5″ from Horizons, 0.2–0.4 px); fluxes are a fixed
12.3″ aperture, not total magnitudes; the spectrum uses one season and is scaled by r²Δ; the solar spectrum is a 5778 K
blackbody (5 % per point; Pluto 10 %); single-image bands (SWAN 2.61 µm, 15σ, round coma) are reported but not named.

