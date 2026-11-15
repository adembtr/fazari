# Spectrum flux check against 2MASS and AllWISE: pre-registration

Written 2026-11-15 16:50-17:20 +03, before any SPHEREx pixel of a comparison star was measured. This file and the
check script `pipeline/spectrum_check.py` are committed and pushed together on branch `spec-check`; the GitHub push
time is the third-party time stamp. Results go to `pipeline/SPECTRUM_CHECK.md` and `pipeline/spectrum_check.csv`
in a later commit. A read-only check: the engine and the live site are not changed.

## Question

Does the flux scale of the spectrum engine (`pipeline/spectrum.py`) agree with 2MASS J/H/Ks and AllWISE W1/W2 on
many isolated, unsaturated field stars? Until now it was checked on two stars only (0.93-1.06, eps_indi_b cutouts).

## Engine: unchanged

`pipeline/spectrum.py` and `pipeline/blink.py` as committed at 817b74b, not edited:

| file | md5 | git blob |
|---|---|---|
| `pipeline/spectrum.py` | 6537aa7711209c5f15f768ecceb2fa4c | 52f2b6bb9f31d68e679c4f5006573319bdeb8b6b |
| `pipeline/blink.py` | d331ddf16f95fb9263c4dfb2aaa7f1a3 | 74c97587efa2496236cfe1478eff568e14a06e42 |

Each star is measured by one call of the engine's own command line, default settings:
`python -I pipeline/spectrum.py sc_<gaia_source_id> --target-json '{"name","ra","dec","pmra","pmdec","plx","epoch":2016.0}'
--data-target <field> --out <scratch folder outside the repo>` (Gaia DR3 astrometry of the star). The numbers used are
the engine's `spectrum.json` "binned" entries, unchanged. Environment only: `FAZARI_DATA` = the folder holding the field's
cutouts, `FAZARI_TARGETS` = a scratch copy of the field centres (needed by `--data-target`), the field's cached Gaia
field-star list placed in `<out>/<field>/gaia_field.json` (the engine reads it from there; nothing new is fetched), and
`FAZARI_NO_GAIA_FETCH=1` (a safety switch: the engine never goes to the network, so no star waits on the
catalogue outage). With `--data-target <field>` the engine's `load_gaia` reads `<out>/<field>/gaia_field.json` (the
field's list, used for every star of the field, exactly as for the field's own target) before any fetch; the file is a
byte copy of the cached list (`site/data/<field>/`, `fazari/cache/gaia/<field>/` or `fazari/cache/jobs/<field>/`, the
blink.gaia_field format, radius 0.15-0.3 deg). Nothing is fetched per star. A star whose run raised the IOError or
warns "no Gaia field stars" (fitted without neighbours) is dropped and counted; it never enters the results.

## Fields (cutouts already on disk, nothing downloaded)

- `veri/real_spherex/`: barnard, eps_indi_b, r_dra, rw_aur, wise0855 (DR1 + QR3, 226-413 cutouts each).
- `fazari/cache/local/inputs/` (local engine field jobs, DR1 + QR3 where present, 24-110 cutouts each) with a cached
  Gaia field list in `fazari/cache/jobs/<field>/gaia_field.json`. Duplicate pointings keep one copy (the first name in
  sort order with the most cutouts): 24 fields, listed in `spectrum_check.py` (`LOCAL_FIELDS`).

## Catalogue rows (declared deviation from the task text, before any measurement)

The task asked for the Gaia DR3 best-neighbour tables on the ESA Gaia archive (as `fast_stars.py`). The ESA archive did
not answer on 2026-11-15 from 17:00 +03 (IRSA TAP also failed, and is not used). The rows therefore come from VizieR
(mirror `vizier.cfa.harvard.edu`, fallback `vizier.idia.ac.za`), one cone per field and catalogue, radius 0.15 deg
around the field centre:

- Gaia DR3 `I/355/gaiadr3` (Gmag < 19.5): Source, position, pm, parallax, G, BP-RP, RUWE, VarFlag, and the Gaia DR3
  best-neighbour identifiers `2MASS` and `AllWISE` (the same best-neighbour cross-match that the ESA tables hold).
- 2MASS PSC `II/246/out`: J/H/Ks, errors, Qflg (ph_qual), Cflg (cc_flg), Xflg, Bflg.
- AllWISE `II/328/allwise`: W1/W2, errors, qph, ccf, ex, nb.

A star's 2MASS and AllWISE rows are the ones named by its Gaia best-neighbour identifiers (no positional matching).
Rows are cached in the scratch folder and the file list is in the results.

## Sample cuts (in this order; the number removed by each cut is reported)

1. Gaia DR3 star with a 2MASS best neighbour; 9.5 <= Ks <= 13.5 (2MASS, Vega). Fixed before measurement: bright enough
   for S/N >> 10 per synthesised band, faint enough that most bands are unsaturated; saturation is handled per band (rule 9).
2. Inside the cutouts: >= 8 native px from every edge of >= 50 % of the field's cutouts (cutout WCS headers only);
   and >= 90" inside the circle of the field's cached Gaia list (the engine fits Gaia neighbours within 75" plus
   the 11 px stamp), so every star is fitted with its complete neighbour list.
3. Gaia: VarFlag not VARIABLE; RUWE present and < 1.4.
4. Not within 60" of the field's own target (position at 2026.0) and not within 90" of a Gaia star with G < 9.
5. Isolation within 18" (3 SPHEREx pixels): no other Gaia source with G < G_star + 2.5; no other 2MASS source with
   Ks < Ks_star + 2.5 (J < J_star + 2.5 when Ks is missing); no other AllWISE source with W1 < W1_star + 2.5 (W1_star
   replaced by Ks_star when the star has no AllWISE match). Comparable = within 2.5 mag (10 % of the flux).
6. Duplicates (the same Gaia source in two fields): kept once, in the field with more cutouts.

Per band (a star can enter some bands and not others):

7. 2MASS J/H/Ks: Qflg = A, Cflg = 0 in that band, Xflg = 0. AllWISE W1/W2: qph = A, ccf = 0 in that band, ex = 0, nb = 1.
8. The engine run finished with the Gaia neighbour model loaded (else the star is dropped).
9. Unsaturated only: every binned entry overlapping the band must be kind "measured" with n_saturated = 0, in every
   season (no saturated_wing bins, no bin with any saturated exposure). Otherwise the band is dropped for that star.
10. Coverage: >= 80 % of the band covered by measured bins (in ln wavelength) for the verdict tier; 30-80 % is a
    separate partial tier; < 30 % is dropped (band synthesis, item 5).

No cut on SPHEREx S/N (it would bias the ratio).

## What was done before this file was pushed

- Catalogue rows (VizieR, 87 cones, 16:52-16:59 +03) and the sample (cuts 1-6, cutout WCS headers only, no pixels):
  516 stars in 27 of the 29 fields (two Galactic-bulge fields lose every star to the isolation cut). Cut counts:
  window 11041; outside cutouts / Gaia list 6066; variable or RUWE 544; near target or G < 9 star 152; not isolated 3763.
  `sample.json` (scratch) sha256 19d6758cbe9d37e50ca29d929000ffc09912fab1ac9556fbca1aa0eac5fc2545; the measurement order
  (rank, Gaia DR3 source_id, field) is committed with this file as `pipeline/spectrum_check_order.csv`.
- One timing / path test of the engine at 17:00 +03 on a star that is NOT in the sample (Gaia DR3 1159684398766514688,
  33" from the centre of field-225.000n5.000, removed by cut 4): 4.6 s for 96 exposures. Its numbers are not used. It
  showed the half-range wavelength coverage of the local fields (coverage tiers above) and that the nu^-2 normalisation
  does not suit stars (reference spectrum above). Both rules were set from that before any sample star was measured.

## Measurement order

The stars passing cuts 1-6 are sorted by Gaia source_id and shuffled with `random.Random(20261115)`; they are measured in
that order. A sample cut short by the deadline (19:45 +03) is therefore a random subset. The number planned and the number
measured are both reported.

## Band synthesis (the flat-band method of `extra_checks.py w2`, with the stars' reference spectrum)

1. The engine's binned spectrum (per season x detector, 6 bins per detector) is pooled over the seasons per bin
   (inverse-variance mean; error x sqrt(chi2r) when the seasons scatter more than their errors), as in `w2`.
2. Top-hat band [lo, hi]; each pooled bin clipped to the band; photon-counting weights ln(b/a):
   F_band = sum(F_i ln(b_i/a_i)) / D, error the same sum in quadrature / D. D normalises to the flux density at the
   band's isophotal wavelength lambda_iso. `w2` uses a nu^-2 reference (right for WISE 0855, a very red object):
   D = sum (b_i^2 - a_i^2) / (2 lambda_iso^2). Field stars are close to Rayleigh-Jeans (F_nu ~ nu^2) at 1-5 um, and on
   them the nu^-2 normalisation is off by lambda_iso^4 / (a^2 b^2) for a full top-hat (J +0.9 %, W1 +12 %, W2 +12 %),
   so the check uses the Rayleigh-Jeans reference: D = sum lambda_iso^2 (a_i^-2 - b_i^-2) / 2, for all five bands.
3. Catalogue side, so that both sides are F_nu(lambda_iso) of a Rayleigh-Jeans star:
   F_cat = F0 10^(-0.4 m) / f_c, error 0.921 F_cat sigma_m. F0: J 1594 Jy, H 1024 Jy, Ks 666.7 Jy (Cohen et al. 2003,
   AJ 126, 1090; Vega-based isophotal fluxes, f_c = 1); W1 309.540 Jy, W2 171.787 Jy (Jarrett et al. 2011, ApJ 735, 112;
   nu^-2 convention) with the WISE colour correction for F_nu ~ nu^2, f_c = 1.0283 (W1), 1.0206 (W2) (Wright et al. 2010,
   AJ 140, 1868, Table 6).
4. Bands (lambda_iso, top-hat): J 1.235 um [1.154, 1.316]; H 1.662 [1.537, 1.788]; Ks 2.159 [2.028, 2.290]
   (lambda_iso +- half the bandwidth, Cohen et al. 2003, Table 2); W1 3.3526 [2.80, 3.80]; W2 4.6028 [4.00, 5.00]
   (W2 limits as in `w2`; SPHEREx stops at 5.0 um). D1 (0.75-1.09 um) is not used.
5. Coverage tiers (fraction of the band, in ln wavelength, covered by measured bins):
   - full: >= 80 %. Only this tier gets a verdict.
   - partial: 30-80 %. The band flux is then an extrapolation to lambda_iso with the Rayleigh-Jeans shape; reported in a
     separate table, no verdict. Below 30 % the band is dropped for that star.
   (Why: the 1-star timing test below showed that the local field-job cutouts cover only about half of each detector's
   wavelength range, e.g. Ks 2.03-2.12 um only; the five `veri/real_spherex` fields have full coverage.)
6. Sensitivity checks, not used for the verdict: (a) exactly the `w2` normalisation (nu^-2, no colour term);
   (b) the AB offsets of `fast_stars.py` (J 0.91, H 1.39, Ks 1.85, W1 2.699; W2 3.339) instead of F0.

## Metrics (per band)

- R = F_band / F_cat per star; sigma_R = R sqrt((E/F_band)^2 + (sigma_cat/F_cat)^2).
- N; median R; its error = standard deviation of the median over 2000 bootstrap resamples (seed 1).
- Robust scatter = 1.4826 MAD(R).
- Systematic floor f: the smallest f >= 0 for which the pulls (R - median) / sqrt(sigma_R^2 + (f median)^2) have
  1.4826 MAD = 1 (f = 0 if the width is already <= 1).
- Trends (Spearman rho and p): R against the catalogue magnitude in that band, J - Ks, the mean detector position of the
  band's exposures (distance from the detector centre, from x_pix/y_pix and the cutout's CRPIX1A/2A), and season (the
  band synthesised per season: median R per season number 1-4 of each star, in time order). Trends are reported, not used for the verdict.

## Verdict per band (fixed now)

- pass: |median R - 1| <= 0.03; limit: 0.03 < |median R - 1| <= 0.06; fail: > 0.06.
- A band with N < 20 gets "too few stars" and no verdict.
- The verdict uses the point value; when the bootstrap 1-sigma interval crosses a threshold the result says so.

## Load and time rules

One measurement process at a time, `nice -n 19`, `taskset -c 12-17` once the Planet X run 3 job has ended; started only
when at most one of the other science jobs is running; free memory >= 6000 MB; CPU package <= 90 C (pause), <= 95 C.
No new star starts between 18:49 and 19:20 +03. Measurement stops at 19:45 +03 whatever is done.
