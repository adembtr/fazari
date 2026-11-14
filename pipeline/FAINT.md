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
5. **`sso` statistic**: the template excludes the whole window, so there is no
   self-subtraction; plain sum Z(p, v) = Σ psi_g(p + v Δt_g) / sqrt(Σ phi_g(p + v Δt_g)) over the
   pointings of the window.
6. **Noise units**: Z is divided by its robust scatter over the field at random trial motions.
7. **Epoch consistency**: per position and motion, the fluxes of the epochs (seasons for `pm`,
   visits for `sso`) must agree, χ² ≤ the p = 0.001 value for N−1 degrees of freedom, and ≥ 2
   epochs must cover the position. A residual present in one epoch only (a star residual, a
   ghost) cannot make a peak. (Tested and rejected: dropping the brightest epoch costs too much
   S/N with only 3–4 seasons.)
8. **Peaks**: local maxima of max_v Z ≥ threshold (6 for `pm`, 6.5 for `sso`), refined on a 4×
   finer motion grid and half-pixel positions; the motion error comes from the curvature of Z²
   (Δχ² = 1); peaks of one object are merged.
9. **Vetting** (flags; class in the candidate record): one epoch only → `artifact`; a static star
   on the path with > 10× the peak flux → `artifact` (probably its residual: the PSF turns 180°
   between seasons and leaves dipoles that mimic ~10"/yr motions); the field's target or a Gaia
   DR3 star with |μ| > 0.5"/yr within 8" and 3"/yr → `gaia-known` (a target without Gaia id is
   flagged as known).
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
