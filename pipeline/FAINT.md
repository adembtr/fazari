# Faint-object mode

Code: `pipeline/faint.py` (float frames, deep stacks, depth), `pipeline/detect/shift_stack.py`
(shift-and-stack, detector `S` of the candidate finder), `site/js/faint_view.js` (viewer).
Numbers below come from the runs of 2026-11-14 on the 0.2° IRSA cutouts in
`../veri/real_spherex/<target>/` (DR1 + QR3). Language: candidates, never discoveries.

## What it adds

1. **Viewer controls** (`ornek.html`, one `<script>` hook): stretch (published PNG, linear, log,
   asinh), min / max sliders in units of the noise σ, an S/N view (value / σ per pixel, or the
   point-source S/N after PSF filtering), and the per-season deep stack instead of the
   single-wavelength frame. The published PNG stays the default view; the module only draws on
   a canvas over it after a control is touched. URL options: `fv=linear|log|asinh`,
   `fsn=pix|psf`, `fimg=deep`, `flo=<σ>`, `fhi=<σ>`.
2. **Deep stacks**: every exposure of a season (all wavelengths, or a chosen range) in one
   image, with measured depth.
3. **Shift-and-stack**: exposures shifted along trial motions and added, to reveal a moving
   source that is invisible in single exposures; proper motions ("/yr, across seasons) and
   fast movers ("/h, within hours).

## Outputs (all new files, in `<result>/faint/`)

| file | content |
|---|---|
| `faint.json` | index: grid, frames, deep stacks, depth table (`schema: fazari-faint/1`) |
| `frames_<lam>um.bin` | the blink frames of one wavelength bin as float data: per season frame (meta.json order) 3 planes |
| `deep_<season>.bin`, `deep_<season>.png` | per-season deep stack (all wavelengths), same 3 planes; quick-look PNG |
| `shiftstack.json` | shift-and-stack runs, peaks, candidate records (`schema: fazari-shiftstack/1`) |
| `shiftstack_<mode>.png`, `shiftstack_pm_v.png` | peak map (best S/N over all trial motions); S/N against motion at the best peak |

Planes: float16 little endian, 180 × 180 (the blink.py grid: TAN, 3"/px, 0.15°, centred on the
target at 2026.0), PNG order (row 0 = north, column 0 = east): `value` (MJy/sr, ZODI
subtracted; NaN = no data, +inf = saturated core), `sigma` (MJy/sr), `psf_snr`. One frame =
3 × 64 800 bytes. Site targets: written once into `site/data/<target>/faint/`; nothing else in
`site/data` changes (meta.json and all existing files byte-identical, checked with md5).
Engine jobs: post-step `faint` in `local/job_worker.py` (`faint.post_step`), files in
`cache/jobs/<id>/faint/` (frames, deep stacks, proper-motion shift-and-stack; no depth table).

Run: `uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib
--with pillow python -I pipeline/faint.py <target> [--out DIR] [--shiftstack]`. The output folder
is `$FAZARI_OUT/<target>/faint`, else `site/data/<target>/faint`; existing files there are never
overwritten unless `--overwrite`.

## Method

### Reading and resampling

Each cutout is cleaned as in blink.py: ZODI subtracted, FLAGS bad bits → NaN, saturated pixels
(OVERFLOW, SUR_ERROR, NONLINEAR) kept apart, the residual median offset removed. It is resampled
to the grid bilinearly with reproject's edge rule (`faint.resample`). Check: the median of the
files that meta.json lists for a frame, stretched with the published limits, reproduces the
published PNG exactly (Barnard 2.0 µm, three seasons: max difference 1 grey level in 1 pixel
of 32 400).

### Point-source flux: effective PSF on the grid

For every exposure, a 1 µJy point source is put at the centre of grid pixel (90, 90) with that
exposure's own EPSF (`blink.epsf_kernels`, the EPSF row nearest the field) and WCS, and
resampled exactly like the data. This kernel K (21 × 21 grid px) includes the pixel
integration, the undersampling and the resampling blur. The matched filter

    F = corr(I / V, K) / corr(1 / V, K²),   formal error 1 / sqrt(corr(1 / V, K²))

after a 45" mesh background (3σ-clipped block medians) is then the EPSF flux in µJy, on the same
scale as blink.py's forced photometry (EPSF footprint ±3.3 native px; far wings not included).
Deep stacks use the inverse-variance weighted mean kernel of their exposures.

### Noise: measured, instrumental vs blind

Formal errors from VARIANCE are wrong on a resampled grid (neighbouring pixels share native
pixels; the bilinear variance overestimates per pixel and the point-source error is
underestimated by about 2×). So the noise is always measured:

- **Instrumental**: scatter (1.4826 MAD) of the PSF flux at blank positions (3-px lattice,
  ≥ 10 px inside the data, ≥ 6 px from saturated cores) in a difference image where static
  sources cancel. Single exposure: minus a partner exposure (same detector and season, another
  visit, nearest wavelength). Deep stack: the two interleaved halves of the stack. The ratio
  measured / formal is applied to the full image.
- **Blind**: the same scatter in the image itself. It includes source confusion: in a crowded
  field every position has some faint star within the PSF.

The `sigma` and `psf_snr` planes of the viewer use the instrumental scaling (S/N in units of
the noise, not of the confusion).

### Deep stacks

All exposures of a season inside a wavelength range (`all`, `short` 0.70–2.42 µm, `long`
2.42–5.10 µm, `1-3um`). Per detector, a 5σ clip about the median (tolerance
sqrt(var + (0.05 × median)²)), because a star's flux differs between detectors; then an
inverse-variance mean over all detectors. A source with a flat spectrum in µJy is measured at
its inverse-variance mean flux; a red source (a brown dwarf) is diluted by the short
wavelengths, so `long` is the better stack for it.

### Shift-and-stack

1. **Templates** (static sky) that do not contain the exposure's own epoch, at nearly the same
   wavelength (|ln λ ratio| ≤ 0.03, ~1 spectral element; widened until ≥ 4 exposures):
   - `pm` (proper motion, "/yr): same detector, the other seasons (leave one season out);
   - `sso` (fast movers, "/h): same detector and season, the visits outside the search window.
2. **Residual** R = I − T with variance V + V_T + (ε T)². ε is measured: the PSF flux of stars
   in R is 18–24 % of their template flux across seasons (Barnard, ≥ 300 µJy stars), so
   ε = 0.20 (`pm`) and 0.15 (`sso`, same orientation). A wavelength-matched template lowers it
   only from ~24 % to ~19 %: the rest is the undersampled PSF at different pixel phases and
   the 180° turn of the PSF between seasons. Saturated template cores (+3 px) are masked.
3. **Matched filter** per exposure: psi = corr(R / V_R, K), phi = corr(1 / V_R, K²), summed per
   visit (`pm`) or per pointing (`sso`) with the mean time.
4. **`pm` statistic: self-subtraction aware.** The leave-one-season-out template of season s
   contains the mover itself at its positions p_k in the other seasons (weight w_sk = share of
   season k in that template), so the residual of season s holds +F at p_s and −w_sk F at every
   p_k. For a slow mover these overlap and the plain shifted sum both loses the source and pushes
   its motion outward (tested: Eps Indi B came out at (10, −10)"/yr, WISE 0855 at the grid
   edge). The statistic matches the whole pattern m = K(p_s) − Σ_k w_sk K(p_k):

       A_s = Psi_s(p_s) − Σ_k w_sk Psi_s(p_k),   D_s = Phi_s(p_s) |m_s|²
       |m_s|² = 1 − 2 Σ_k w_sk ρ(p_s − p_k) + Σ_kj w_sk w_sj ρ(p_k − p_j)
       Z = Σ_s A_s / sqrt(Σ_s D_s),   flux = Σ A_s / Σ D_s  (the true flux of the mover)

   with Psi_s, Phi_s the season sums of psi, phi and ρ the normalised autocorrelation of the
   effective PSF. Season-level shifts (motion within a season, ≤ 1.8" at 12"/yr, is ignored);
   integer-pixel shifts in the search (≤ 2.1" error for a ~10" PSF), bilinear reads in the
   refinement. Trial motions: −12…+12"/yr in both axes, step 1"/yr (625 motions); motions with
   mean |m|² < 0.08 (the source cancels itself) are skipped.
   A bright mover is different: the per-detector 5σ clip of the templates removes it from the
   other seasons, so it leaves no negative copies. The plain model (w = 0) is therefore evaluated
   beside the aware one and the larger Z that passes step 7 is kept; the peak record says which
   (`model`).
5. **`sso` statistic**: the template excludes the whole window, so there is no
   self-subtraction; plain sum Z(p, v) = Σ psi_g(p + v Δt_g) / sqrt(Σ phi_g(p + v Δt_g)) over the
   pointings of the window.
6. **Noise units**: Z is divided by its robust scatter over the field at random trial motions.
7. **Epoch consistency**: per position and motion, the fluxes of the epochs (seasons for `pm`,
   visits for `sso`) must agree, χ² ≤ the p = 0.001 value for N−1 degrees of freedom, and ≥ 2
   epochs must cover the position. Each epoch's variance includes a fractional term (τ F)², τ =
   0.25 (`pm`) and 0.5 (`sso`): epochs mix wavelengths differently, and a brown dwarf or an
   asteroid changes a lot with wavelength (without it Eps Indi B itself failed the test). A residual present in one epoch only (a star residual, a
   ghost) cannot make a peak. (Tested and rejected: dropping the brightest epoch costs too much
   S/N with only 3–4 seasons.)
8. **Peaks**: local maxima of max_v Z ≥ threshold (6 for `pm`, 6.5 for `sso`), refined on a 4×
   finer motion grid and half-pixel positions; the motion error comes from the curvature of Z²
   (Δχ² = 1, statistical only); peaks within 4 px are merged (one object: its Z is flat along
   the speed, see the tests).
9. **Vetting** (flags; class in the candidate record): one epoch only → `artifact`; a static star
   on the path with > 10× the peak flux → `artifact` (probably its residual: the PSF turns 180°
   between seasons and leaves dipoles that mimic ~10"/yr motions); the field's target (within
   10" of its position at the reference epoch) or a Gaia DR3 star with |μ| > 0.5"/yr within 8"
   and 6"/yr → `gaia-known` (a target without Gaia id is flagged as known). The motion
   tolerance is wide because measured motions are biased by several "/yr (tests below). A field
   target without a Gaia id also gets class `gaia-known` (the schema's class for known movers), with
   the flag "known object (field target …, not in Gaia DR3)".
10. **`sso` trial motions**: 4–60"/h, directions within 35° of the ecliptic (both senses);
    windows of visits within 12 h; motion step = 3" / (half the window span), coarsened until
    ≤ 15 000 motions.

Candidate records follow `pipeline/detect/schema.py` (`new_candidate`): `pm` → kind `motion`
with `motion` in mas/yr; `sso` → kind `transient` with `rate` {"ra_arcsec_h", "dec_arcsec_h"};
the extra key `shiftstack` holds the per-epoch fluxes and the search settings. Detector API:
`detect.shift_stack.run(ctx)` (NAME `S`, modes from `ctx.opts["shift_stack_modes"]`, default
`["pm"]`); `run(field_or_FieldRun, mode=...)` and `run_field(...)` (also writes the files) work
outside the finder. It is not registered in `detect/run.py` DETECTORS yet (that file belongs to
the finder); add `shift_stack` there to merge its records into candidates.json.

## Results (2026-11-14)

All numbers are measured on the site cutouts; tests ran into a temporary folder, the site products
were written once into `site/data/<target>/faint/` (84 new files, 22 MB; md5 check: no existing
file in `site/data` changed, every `meta.json` byte-identical).

### Depth: single exposure vs deep stack

5σ point-source limit (EPSF flux), instrumental noise. Single = median over exposures; deep =
one season, all wavelengths. "Blind 5σ" = scatter in the image itself (includes faint stars).

| target | single 5σ | deep 5σ (best / worst season) | gain | blind 5σ deep | exposures per deep stack |
|---|---|---|---|---|---|
| Barnard's Star | 268 µJy, AB 17.83 | 26.9 µJy AB 20.33 / 34.9 µJy AB 20.04 | 2.2–2.5 mag | ~1000 µJy (confusion, Galactic plane) | 118–121 |
| Eps Indi B | 204 µJy, AB 18.13 | 22.8 µJy AB 20.50 / 33.6 µJy AB 20.08 | 2.0–2.4 mag | ~160 µJy | 74–146 |
| WISE 0855 | 198 µJy, AB 18.16 | 18.2 µJy AB 20.75 / 46.7 µJy AB 19.73 | 1.6–2.6 mag | ~160 µJy | 30–128 |
| RW Aur | 255 µJy, AB 17.89 | 26.3 µJy AB 20.35 / 29.0 µJy AB 20.24 | 2.4–2.5 mag | ~660 µJy | 109–114 |
| R Dra | 442 µJy, AB 17.29 | 38.3 µJy AB 19.94 / 70.2 µJy AB 19.28 | 2.0–2.7 mag | ~410–560 µJy | 153–212 |

Per detector the single-exposure limit runs from ~140 µJy (D4, ~2.5 µm) to ~650 µJy (D6,
~4.7 µm). The measured deep noise is 1.0–1.5× the ideal value (single noise / sqrt(N)); the
formal VARIANCE-based error underestimates the point-source noise by 2–3× (correlated noise
after resampling). In Barnard's and RW Aur's fields the image is confusion-limited: faint stars
everywhere, so the depth is only reached in difference images (shift-and-stack), not by eye.
`short` (0.7–2.4 µm) and `long` (2.4–5.1 µm) stacks: AB 19.3–20.5 (table in `faint.json`).

### Shift-and-stack, proper motion: injected movers

Six synthetic point sources (flat spectrum, 3–10"/yr, positions where the static flux along the
path is < 400 µJy) added to every exposure with its own EPSF and WCS, then the blind search
(`Search.pm`, threshold 6). Recovered = a peak within 9" of the true position.

| field (seasons) | 15 µJy | 20 | 30 | 45 | 70 | 100 | 150 |
|---|---|---|---|---|---|---|---|
| Eps Indi B (4) | 0/6 | 1/6 | 1/6 | 5/6 | 5/6 | | |
| Barnard (3) | | | 0/6 | 1/6 | 4/6 | 5/6 | 6/6 |

- Smallest recovered: 20 µJy (AB 21.1) in Eps Indi B's field, 45 µJy (AB 20.3) in Barnard's,
  both for the 8"/yr source; 50 % completeness at ~40 µJy (Eps Indi B) and ~65 µJy (Barnard).
  The single-exposure 5σ limits there are 204 and 268 µJy: shift-and-stack finds movers that
  are 5–10× fainter than anything visible in one exposure (1.7–2.5 mag).
- Noise for a fast mover (8–10"/yr): 1σ ≈ 3.4–4 µJy (Eps Indi B, 4 seasons) and 6.4–9 µJy
  (Barnard, 3 seasons, crowded); slow movers lose signal to self-subtraction (the source sits
  in its own templates): S/N per µJy at 3–5"/yr is 30–60 % of that at 8"/yr.
- Motion: |measured − true| median 1.6"/yr (Eps Indi B), 2.8"/yr (Barnard), max 8.4"/yr; the
  quoted statistical error (median 0.8–0.9"/yr) underestimates it ~2–3×. With three or four
  seasons over one year and a ~6" PSF, S/N is flat along the speed: the method finds the
  mover's position reliably, the motion only roughly.
- Flux: recovered / injected median 0.90 (Eps Indi B), 0.65 (Barnard; range 0.33–1.28).
- No injected source that was recovered was rejected by the vetting.
- Field peaks without an injected source (the same at every level): 10 (Eps Indi B), 12–13
  (Barnard). After vetting: Eps Indi B itself (known), 2 candidates, the rest artifacts;
  Barnard 3 candidates, all with the best motion at the edge of the trial grid (low
  confidence).

### Real movers

- **Eps Indi B** (control, bright, 4.0"/yr): found at S/N 210, 1.6" from the predicted
  position, class `gaia-known`; motion (10.3, −4.5)"/yr vs (3.98, −2.47): a bright slow mover
  overlaps its own copies in the templates (partly clipped), so its motion is badly biased. Use
  the blink astrometry for bright movers; shift-and-stack is for the faint ones.
- **WISE 0855−0714, 3.8–5.1 µm** (blind, 94 exposures; median single-exposure S/N of the
  object is 3.5 at 4.6 µm): the top peak of the field, S/N 15.2, 1.4" from the true position,
  per season S/N 7.2 / 6.6 / 11.8, flux 249 µJy, motion (−10.0, 0.0)"/yr vs (−8.12, +0.67)
  (Δ 2.0"/yr); class `gaia-known` (field target). Of the other 7 peaks, 5 are vetted artifacts
  (including a feature at 133.789, −7.195 seen only in the two May seasons:
  "not seen in the other telescope orientation") and 2 remain low-S/N candidates (7.4, 6.9σ).
- **WISE 0855−0714, 1–3 µm**: not detected. Blind search: not among the 25 peaks (21 artifacts).
  Forced photometry along the known track (Kirkpatrick et al. 2021 motion, blink neighbour
  model, all seasons, 119 exposures): −8.7 ± 4.4 µJy, **5σ upper limit 22 µJy (AB 20.5)**, vs
  AB ~17.9 for a single exposure. Sub-ranges: 1.6–2.4 µm −4.7 ± 6.7, 2.4–3.0 µm 13 ± 12,
  3.0–3.8 µm 9 ± 12 µJy (5σ < 67 µJy); control 3.8–5.0 µm 321 ± 12 µJy (S/N 27). 1.0–1.6 µm
  gives −21 ± 7 µJy (−3.1σ, a systematic from the neighbour fit; treat as < 20 µJy).

### Fast movers ("/h)

- **Known asteroids, RW Aur field** (ecliptic latitude +7.5°): IMCCE SkyBoT, one cone per
  observing day (35 queries, cached in `cache/asteroids/skybot`), positions made topocentric for
  SPHEREx (spacecraft X/Y/Z_SC). 90 known objects cross the grid in some exposure (V 19.3–32.5,
  23 in ≥ 2 visits). **None is detected**: highest single-exposure S/N 4.3; known-track stack S/N
  3.7 for the brightest (1999 RL139, V = 19.3: 123 ± 33 µJy, about the flux expected for V =
  19.3 at 1–2 µm), but the known-track S/N of all 90 objects scatters by 1.5 (not 1), so no
  object stands out. The blind search on the windows of the 4 brightest multi-visit objects
  did not recover any of them (expected at these fluxes); those windows show 10 peaks ≥ 5σ each
  (best 6.3–10.4): in a crowded field the fast-mover threshold 6.5 is not clean.
- **Injected fast mover**, Eps Indi B field, 25"/h along the ecliptic, flat spectrum, two
  windows of 19 exposures: 40, 60, 90 µJy not recovered; 130 µJy recovered in window 0 (3
  visits, 5 h: S/N 8.2, rate (23.0, 7.0) vs (23.8, 7.6)"/h), not in window 1 (7 visits over
  9.7 h; not investigated). No false peak ≥ 6.5 in either window. 130 µJy is below the
  single-exposure 5σ limit (204 µJy) but only ~1.6× below it.

### Site targets: shift-and-stack summary (`shiftstack.json`)

| target | run | peaks ≥ 6σ | known | candidates | artifacts |
|---|---|---|---|---|---|
| Barnard's Star | pm, all λ | 12 | 0 (Barnard's Star saturated, masked) | 3 (all at the grid edge) | 9 |
| Eps Indi B | pm, all λ | 10 | 1 (Eps Indi B) | 2 (at the grid edge) | 7 |
| WISE 0855 | pm, all λ | 25 (list cap) | 0 | 5 (4 at the grid edge) | 20 |
| WISE 0855 | pm, 3.8–5.1 µm | 8 | 1 (WISE 0855, top peak) | 2 (1 at the grid edge) | 5 |
| RW Aur | pm, all λ | 25 (list cap) | 0 | 0 | 25 |
| R Dra | pm, all λ | 7 | 0 | 1 (at the grid edge) | 6 |

The remaining candidates are weak (6–10σ) and most sit at the edge of the trial motions; the
injection tests give ~0.5–1 such field peak per 0.15° field that is not a static residual. They
are listed for follow-up only.

### WISE 0855−0714: SPHEREx flux against AllWISE W2 (added 2026-11-15, after the tests)

A brightness check of the faint target with data already in the repository: the binned spectrum of
`pipeline/spectrum.py` (`site/data/wise0855/spectrum.json`), no new download or fit.
`python3 -I pipeline/extra_checks.py w2` -> `site/data/wise0855/w2_check.json`.

- Band: the W2 response (~4.0–5.2 µm) is replaced by a flat band over the SPHEREx bins inside
  4.0–5.0 µm (SPHEREx stops at 5.0 µm; the 4.41–4.42 µm gap between D5 and D6 is left out). The three
  seasons are pooled per bin (inverse-variance mean, error × sqrt(chi2r) when they disagree): 11 bins (the
  3.92–4.01 µm bin only with its part above 4.0 µm), 144–629 µJy, peak at 4.5 µm.
- W2-equivalent flux: the flux density at λ_iso = 4.6028 µm of a ν^-2 source that gives the same
  photon count, F = Σ F_i ln(b_i/a_i) / Σ (b_i² − a_i²) / (2 λ_iso²); W2 = −2.5 log10(F / 171.787 Jy)
  (zero point and λ_iso: Wright et al. 2010; Jarrett et al. 2011). Energy-counting weights change F by
  < 1 % (495 instead of 493 µJy).
- SPHEREx: **493 ± 23 µJy, W2 = 13.86 ± 0.05** (statistical only).
- AllWISE Source Catalog (Cutri et al. 2013), J085510.74−071442.5, the only source within 15″ of the
  2010 position (IRSA Gator, 2026-11-15): **W2 = 13.704 ± 0.033** (567 µJy), ph_qual A, cc_flags 0, nb 1,
  mean W2 epoch MJD 55412 (2010).
- Difference: SPHEREx is **0.15 ± 0.06 mag fainter** (13 % less flux, 2.5σ on the statistical errors).
  Not included: the ±6 % flux scale of the spectrum (two field stars agree with 2MASS and AllWISE to
  0.93–1.06; within that the difference is ~1.7σ), the flat-band approximation, the unseen 5.0–5.2 µm
  part of W2, and 15 years between the two epochs for an object reported to vary by a few per cent at
  4.5 µm. We do not explain the 13 % yet.

## Limits and open issues

- **Motion accuracy**: positions are found reliably, motions only to ~2–3"/yr (faint) and up to
  ~6"/yr (bright slow movers, e.g. Eps Indi B). The quoted motion errors are statistical only.
- **Slow movers** (< 5"/yr) lose 40–70 % of their S/N to self-subtraction (leave-one-season-out
  templates); a static-sky template from other data (or a fit of the static sky together with the
  mover) would fix it.
- **Crowded fields** (Barnard, RW Aur): the blind scatter is ~5× the instrumental noise; the
  shift-and-stack noise is ~2× worse than in Eps Indi B's field.
- **Detector artifacts**: the PSF turns 180° between seasons and leaves dipoles that mimic
  ~10"/yr motions; ghosts appear only in one telescope orientation. Both are vetted (static star
  on the path, other orientation, one season only), but the vetting is heuristic.
- **WISE 0855 field**: a feature near 133.789, −7.195 (seen in May 2025 and May 2026 only) is
  vetted as an artifact in the 3.8–5.1 µm run but remains a weak candidate in the all-λ run.
- **Fast movers**: the threshold 6.5 is not clean in crowded fields; one of two injection windows
  failed at 130 µJy (not investigated).
- **Viewer**: in deep-stack mode the frame label printed in the published PNG (dates, detector)
  still shows the single frame; the card states the deep stack.
- `shift_stack` is not registered in `detect/run.py` DETECTORS (the finder's file); the engine
  runs it through the `faint` post-step instead (proper motion only).
