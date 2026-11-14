# Candidate finder: what moved, what changed (finder 1.1)

Code: `pipeline/detect/` (package), launcher `pipeline/find_candidates.py`.
Output: `candidates.json` next to the blink products of a target or job. The record format is
documented at the top of [`detect/schema.py`](detect/schema.py); fields are only ever added.

**Language.** Everything reported here is a *candidate*, never a "discovery". *Confirmed* means
only that a record passed the fixed rule of section 4.3.

## 1. What the data forces

| Property of SPHEREx | Consequence |
|---|---|
| 6.15" pixels, undersampled PSF | positions come from fits of the calibrated EPSF, never from centroids; a small motion is a mean over many exposures with a measured systematic floor |
| one wavelength per exposure, six detectors (0.75 to 5 um) | brightness is compared inside one detector at matched wavelengths; positions get one free offset per detector, the motion is common to all |
| seasons half a year apart, telescope rolled by 180 deg in between | PSF asymmetry, ghosts and wing-fit bias flip with the roll: a real change must also show in a pair of seasons with the same orientation (one year apart) |
| bright stars saturate | their position comes from a fit of the wings; a zone around every saturated core is closed for other sources |
| cosmic rays | one detection in one exposure is never a candidate on its own |

## 2. Steps

```
exposures (IMAGE, FLAGS, VARIANCE, ZODI, EPSF)                         data.py
  -> registration on Gaia DR3 stars                                     calib.py
  -> detectors A, B, D, V, C, P (one record format)                     run.py DETECTORS
  -> merge: one object, one record                                      schema.py
  -> vetting: records along a mover's track, single-exposure events     vet.py
  -> known asteroids (IMCCE SkyBoT)                                     sso.py
  -> nature, confidence, confirmed, one-line verdict                    nature.py
  -> what would have been seen in this field                            sensitivity.py
```

A detector is a module with `NAME` and `run(ctx) -> records` (`schema.new_candidate`), listed in
`run.DETECTORS`. The distant-body search (`detect/distant.py`, detector P) has its own document
([`PLANETX.md`](PLANETX.md)); it is registered last in `run.DETECTORS` (15 Nov 2026: +1.6-2.1 s and 0 records on two null fields).

**The Gaia list** (`run.fetch_gaia`; DR3, G < 19, 0.15 deg radius) is asked at IRSA and, when IRSA
does not answer, at the ESA Gaia archive (the same table). A catalogue that cannot be reached is
never recorded as "no stars": nothing is written, the document says
`field.registration.gaia_list.status = "unavailable"`, and **nothing that moves is a candidate in
that run**. Without the list a position change cannot be told from a known star, or from two known
stars that the 6" pixels show as one source. Such a record is kept as rejected with the text "not
checked against the star catalogue", and the verdict asks to run the field again. An empty list
found on disk is asked again instead of being believed.

**Search area.** The full run searches the central 0.2 x 0.2 deg (`field.searched_deg`). That is
the whole cutout of a standard job (117 px). A job cut at 0.4 deg (234 px) is searched in its
central quarter only: the outer part is not searched (section 8).

## 3. Detectors

**A, difference images** (`diffimg.py`; fast movers, appearing and disappearing sources; needs no
catalogue). Per wavelength bin every season is stacked on a 3"/px grid and seasons are subtracted.
A motion is a negative and a positive lobe: each >= 4 sigma, together >= 6.5 sigma, fluxes within a
factor 2.5, 2" to 60"/yr x dt apart. A lone peak >= 5 sigma is an appearing or disappearing source.
A record needs two independent wavelength bins or two season pairs. Every motion is then measured
again in the native pixels of every exposure along its track and must be >= 5 sigma there.

**B, Gaia stars** (`gaia_astrom.py`). Every Gaia DR3 star (G < 19) is measured at the place Gaia
predicts. Total motion >= 5 sigma and equal to Gaia: `gaia-known` (the measured vector is
reported next to Gaia's). Motion relative to Gaia >= 5 sigma: `candidate`, if every check of 4.1
passes.

**D, sources that are not in Gaia** (`deep_astrom.py`; brown dwarfs, red or faint objects). The
sources are the peaks of the deep stack of each detector (>= 5 x the confusion noise, or formal
S/N >= 50), not within 3.1" of a Gaia star. They are measured like the Gaia stars; a drift above
0.4"/yr is measured again along its own track, an accepted mover a third time until no season
position moves by more than 0.02".

**V, brightness changes** (`variab.py`). EPSF photometry of every source in every exposure (wing
photometry for saturated stars). Per source and detector: one level per season plus one slope with
wavelength. Candidate when the detectors together show a change >= 5 sigma and >= 3 %, still
>= 3 sigma without the strongest detector, and >= 2 detectors agree in sign. A colour change
(brighter in the blue, fainter in the red) cancels in that sum: it is a candidate when >= 2
detectors changed by >= 5 sigma each with both signs. List entries closer than 3.1" are one
unresolved source and are measured as one. A change seen only between opposite orientations,
while a same-orientation pair exists and does not show it, is rejected.

**C, single-exposure events** (`fast.py`, written by the asteroid work): PSF-shaped peaks in one
exposure against the median of its detector and season. The finder only vets them (4.2).

## 4. Decision rules

### 4.1 Checks every motion must pass

| Check | Number | Why |
|---|---|---|
| significance after the error calibration | >= 5 sigma | errors come from the source's own residuals |
| the fit has a degree of freedom | dof >= 1 | two positions always lie on a line: such a fit is flagged "unchecked" and is never a candidate |
| wavelength halves agree | D1-D3 vs D4-D6 within 3.5 sigma | a motion has no colour; a blend's photocentre has |
| same-orientation seasons show it | >= 3 sigma and within 3 sigma of the all-season fit (skipped when the seasons have one orientation only) | everything that flips with the roll cancels in that pair |
| straight line, or line plus positive parallax | fit probability >= 0.001 | one object has one track |
| not blended | no source with >= 30 % of its S/N within 8" | 6.15" pixels cannot separate them |
| not the photocentre of a variable blend | shift < 1 px together with a flux change >= 5 % at >= 5 sigma is rejected | an unresolved pair with a variable member "moves" |
| outside the zone of a saturated star | 2.5 x core radius + 15" | the wings pull positions (the star itself is measured on its wings) |
| a mover leaves its old place empty | < 30 % of the flux left behind | two variable stars 10" apart are not a motion |
| the parallax is possible | fitted parallax not more than 3 sigma above 768 mas (Proxima Centauri) | the parallax term takes up any jump of the one season that is seen from the other side of the orbit; a larger value is two sources or a blend, not a distance |
| the light moved (D) | flux at the first position in the last season, and at the last position in the first season, each as a fraction of the source's own flux there. A source that moved d leaves at most R = exp(-d^2 / 4 sigma_PSF^2) (measured: 0.36 and 0.62 for Luhman 16 against R = 0.92; 0.46 to 0.71 for four injected AB 18 movers 5" away against 0.74 to 0.78); two static sources leave 1. Rejected when both fractions lie more than 2 sigma above (1 + R) / 2, 1 - R is at least 6 errors, and the other listed sources add less than 30 % of its own light at its positions (a model mover of S/N 10 to 30 beside a star 30 to 100 times brighter, 10" to 22" away, gives fractions above the middle too, `sim_static_neighbour.log`: such a record stays a candidate that cannot be confirmed) | two sources a few arcsec apart, whose light the fit shares differently from season to season, give a position change without any light moving |

### 4.2 Vetting (`vet.py`)

Records within 9" of a mover's track belong to that mover and are attached to it. A motion is
rejected as crowded when a mover at least 1.5 times brighter was inside its measurement stamp
(21.5") in one of the seasons: the brighter one pulls the position. At similar brightness both
records stay, because brightness cannot tell which depends on which. Two tracks that cross while
the sources were never in one stamp at the same time are not crowded. A motion that detector A
alone saw in a single season pair (of a field with more seasons) is what two unrelated changes
look like, one source fading and another brightening: it is reported, but it neither rejects
another motion nor takes other records as its own. A single-exposure event is rejected when the
source under it is as bright at that wavelength in other visits (a spectral feature), when it
repeats at the same place, or when another exposure of the same visit shows less than half of it
(cosmic ray); seen twice in a visit it goes to the asteroid check.

### 4.3 Nature, confidence, confirmed (`nature.py`)

*Nature.* A body bound to the Sun that moves mu must be closer than (sqrt(2) x 1296000"/mu)^(2/3) AU
and swing by its parallax between seasons (Barnard's Star's 10.4"/yr: at least 131"). A source that
stays on one track is therefore outside the Solar System: a star or brown dwarf, with a distance
from the fitted parallax. If even the 3 sigma upper limit of the parallax would make it faster than
800 km/s (Galactic escape), no known kind of object moves like that: the record keeps its measured
motion, says so in `nature.text`, and can never be confirmed. Labels: `catalogued-star`,
`catalogued-star-anomalous`, `nearby-star-or-brown-dwarf-candidate`,
`distant-solar-system-candidate`, `solar-system-known`, `solar-system-candidate`,
`variable-star-candidate`, `transient-or-moving-candidate`, `single-exposure-event`, `artifact`
(with `reason`).

*Confidence.* A catalogued mover: agreement of the measured vector with Gaia, in percent and in
sigma. An uncatalogued mover: 100 x (1 - FAP), FAP = N x p(z) x K, with N the sources tested in the
field, p(z) the Gaussian tail of the calibrated significance and K = 236, the factor by which the
tail could still be heavier than Gaussian without the first date-shuffle null test (0 false movers
in 22,200 source trials) having seen it. Brightness changes get no percentage.

*Confirmed* (rule `confirm-v1`): significance >= 7 sigma; confidence >= 99.9 % (catalogued movers:
within 3 sigma of Gaia); no caution flag; physically possible; for an uncatalogued source that
moved 2" or more: the images show that the light moved (detector A found it in the difference
images, or both fractions of the test in 4.1 lie more than 2 sigma below (1 + R) / 2 with 1 - R at
least 3 errors); and at least 2 of 4 independent confirmations: the same-orientation pair shows it,
both wavelength halves (or two single detectors) show it, >= 3 seasons fit the model, found by A
and by B or D. Brightness changes are never confirmed (their null test is not built into the rule
yet). A record that did not pass the rule is never called found: the summary line of a document
reads "N confirmed moving object(s) here: ... k candidate(s) (m not confirmed)", and the verdict
says "a candidate, not confirmed yet" with the reason.

## 5. Error model (`astrometry.py`)

For source j, season s, detector d: position(s, d) = a_d + b (t_s - 2026) [+ parallax] + noise.
One offset a_d per detector, one motion b for all, solved by generalised least squares.

1. **Season floor.** The scatter of the reference stars' season positions about their Gaia motion,
   per field: between 0.005" (the lowest value allowed) and 0.016" in the 12 test fields; 0.015"
   when fewer than 5 reference stars are usable (2 of the 12 fields).
2. **Residual permutation.** The source's residuals are reassigned 200 times inside each detector
   and the fit repeated; the scatter of the refitted motions replaces the formal error when larger.
3. **Confusion** (tracks of detector A). The same track is laid on up to 16 empty places 45" and
   60" away; what the background does there is added to the floor (WISE 0855: 0.21" per season).
4. **Stars beside a track.** A listed star within 12.3" (two pixels) of a mover's track is not
   fitted per exposure: its flux is one straight line in wavelength per detector from all
   exposures together, and that model is subtracted.
5. **Saturated stars.** Fitted on their wings, with one extra offset per detector and orientation.
   A partly saturated star has two kinds of position cells (EPSF fits of unsaturated exposures,
   wing fits of saturated ones). The fit uses the EPSF cells alone unless they leave no degree of
   freedom or an error more than twice that of all cells together; then it uses all cells.

## 6. Quick stage (`run.quick_verdict`)

The same detectors (A, B, D) on the 31 x 31 px boxes that the local engine cuts around a clicked
point. These boxes have no EPSF extension: the EPSF table is read from the engine's cache
(`cache/local/epsf/<calibration id>.fits`), and the document says so (`psf`). A box holds too few
reference stars to register, so the exposures keep their own WCS and the season floor is 0.10"
(the worst of the season x detector registration offsets of 10 fields, measured for v1). The Gaia
list is asked with a 12 s limit per try; when it cannot be reached the quick answer reports no
moving object and says why (section 2). A source whose stamp can leave the box is flagged and not
confirmed there. When no exposure can be read the answer carries `no_data` and the
engine falls back to its own rough answer.

## 7. Tests

<!-- status:begin (generated from site/data/verify/tests.json, not typed by hand) -->
**Independent test round** (`site/data/verify/tests.json`: 11 tests of the code state "TEST-READY v1
16:58", generated 2026-11-14T14:42:32Z, last edited 2026-11-14 21:58): **7 pass, 3 fail, 1 limit**.
Failing: V4 (WISE 0855-0714 (coldest known brown dwarf)); V6 (Injection recovery (fake movers added
to real images)); V11 (Blind recovery of the known brightness changes). Limit: V8 (Known asteroids).
<!-- status:end -->

That round tested finder 1.0. The round for 1.1 is run by the independent tester and replaces
`tests.json`; until then everything below is the author's own test of 1.1 (14 Nov 2026, logs in
`ajan_durumu/algoritma_v11/log/`, results in `.../out/`), not an independent result.

**Known objects, found blind in the full 12-field run** (`v9_all.log`; the two fields with an
uncatalogued mover again after the last change, `v10_two.log`):

| Object | Measured | Reference | Difference |
|---|---|---|---|
| Eps Indi B (Gaia star) | 4.678 +- 0.020 "/yr, PA 121.6 +- 0.2 | 4.684, 121.8 | -0.3 sigma, -0.9 sigma |
| Barnard's Star (saturated) | 10.361 +- 0.051 "/yr, PA 355.4 +- 0.3 | 10.393, 355.6 | -0.6 sigma, -0.6 sigma |
| WISE 0855-0714 (not in Gaia) | 8.187 +- 0.567 "/yr, PA 277.6 +- 3.8 | 8.152, 274.7 | +0.1 sigma, +0.8 sigma |
| Luhman 16 (not in Gaia) | 2.816 +- 0.057 "/yr, PA 275.8 +- 1.4, parallax 468 +- 26 mas | 2.790, 277.4, 502 mas | +0.5, -1.1, -1.3 sigma |
| R Dra (variable) | -44 %, 25 sigma | known Mira variable | found |
| RW Aur (variable) | colour change, 19.5 sigma in the strongest detector | known young variable | found |

All four movers are `confirmed`. **Empty fields:** 0 moving candidates in the 8 fields without a
known mover. The 12 fields together give 13 variable candidates (none confirmed, by rule) and 7
unmatched single-exposure events (the asteroid catalogue was not asked in this run).

**A field that finder 1.0 got wrong** (`captain326_final.log`, `captain326_rules4.log`; job
`field-326.640n23.090-c6-b63-s0.4`, 100 exposures, 3 seasons). Finder 1.0 reported two moving
objects there: 5.11 +- 0.95 "/yr with a fitted parallax of 1.58", and 2.45 +- 0.45 "/yr. That job
had run while the Gaia service was down, without any star list. The first position lies between
two Gaia stars, 5.7" from each (G 18.4 and 18.2); the second is 3.0" from a Gaia star (G 19.0)
with another 8.2" away (G 18.4): catalogued stars that the pixels show as one source.

| Run | Moving candidates | The two places |
|---|---|---|
| 1.0, no star list (the job as it ran) | 2 | reported as moving objects |
| 1.1, catalogue reached (498 stars, ESA archive) | 0 | no record within 10" of either |
| 1.1, both catalogue services unreachable | 0 | first: rejected, "fitted parallax 1.58 arcsec is larger than that of the nearest star"; second: no significant motion; the verdict says that the catalogue was not reached |
| 1.1, catalogue not asked, parallax rule switched off | 0 | first: rejected by the light-moved test (0.991 +- 0.018 and 0.999 +- 0.019 of the light stay; a mover would leave 0.505) |

A run of the Groombridge 1830 box with both services unreachable (`test_gaia_outage_final.log`)
reports no moving object and one unchecked position change; with the catalogue back the star is
`gaia-known` and confirmed.

**Five more fields where an earlier finder showed movers** (`post_publish4.log`,
`post_publish5.log`). The 20 `candidates.json` files in the local engine's cache were read; five
more jobs on random fields, all run with the Gaia list, held uncatalogued "moving objects" of
finder 1.0 or of the version before it. Finder 1.1 on the same cutouts:

| Job | Earlier | 1.1 |
|---|---|---|
| field-225.000n5.000 (0.4 deg) | 1: detector D, 3.80 +- 0.56 "/yr (1.0) | 0 (below 5 sigma after the error calibration) |
| field-214.499n35.509 (0.4 deg) | 1: detector D, 1.69 +- 0.27 "/yr (1.0) | 0 (below 5 sigma after the error calibration) |
| field-89.899n25.093 | 1: a Gaia star, 3.29 +- 0.57 "/yr (before 1.0) | 0 |
| field-269.018s25.508 (Galactic bulge) | 1: detector A at a saturated star, 12.6 +- 1.1 "/yr (1.0) | 0 |
| field-271.125s22.235 (Galactic bulge) | 2: detector A at saturated stars, 5.7 and 10.0 "/yr (before 1.0) | 0 |

The set of fields without a known mover is now 14 (8 of the 12-field run, the field above, these
five): **0 moving candidates**, where the earlier versions showed 8 in six of them. The five were
run once, after the rules of 1.1 were fixed; none of them was used to set a threshold.

**Single-exposure events** (`rate_single.log`). Detector C passes 185 events >= 7 sigma in the
2404 exposures it searched in the 12 fields: 0.077 per exposure (0 to 0.13 per field). Of the 168
that are not part of another record, 94 are refuted by another exposure of the same visit (cosmic
rays), 45 are spectral features of steady sources, 22 cannot be checked (no second exposure covers
the place) and 7 are seen in more than one exposure; only those 7 stay candidates. The field that
1.0 got wrong has 7 events in 92 exposures (0.076 per exposure): 2 refuted, 5 not checkable, none
kept. The five further fields have 0, 0, 0.10, 0.19 and 0.38 per exposure (35 events in 91
exposures in the last one: 18 refuted, 13 not checkable, 4 spectral features), none kept: the
rate differs from field to field by more than counting noise, and nothing is reported from it.

**Null tests.**
* Exposure dates shuffled (motion decision of B and D; `s4_all.log`): 12 fields x 100 shuffles,
  17,392 sources per round = 1.74 million source trials: **0 false movers**.
* Seasons of a same-orientation pair permuted exposure by exposure (brightness decision of V;
  `w3_vnull.log`): 240 permutations, 152,100 source trials: **0 false changes** in the permuted
  pair. In one field (three seasons, the third with 4 exposures) 17 hits appeared in pairs with the
  unpermuted season: its real variable (11) and an unresolved triple (6); all carry the caution
  "no same-orientation season pair".

**14 known fast stars from 54-exposure cutouts** (`h3_all14.log`): 13 within 2.3 sigma of Gaia on
both axes (errors 55 to 460 mas/yr per axis); 61 Cyg A, saturated with an equally bright saturated
companion 30" away, is 3.2 sigma off. HD 112943 (partly saturated): the EPSF cells alone gave
-1139, +64 +- 757, 414 mas/yr with no degree of freedom; all cells give -1026, +115 +- 106, 107
(dof 8; Gaia -807, +7).

**Quick stage on real engine boxes** (end to end through `local/quick.py` on a private cache,
`e2e_quick_final.log`): Groombridge 1830 found by A and B, 6.95 +- 0.06 "/yr, PA 145.8 +- 0.5 (Gaia
7.06, 145.5), `gaia-known`, confirmed; a box without a mover: "Nothing moving found here". 43 s
for the empty box and 150 s for the saturated star on a loaded machine (four boxes on a machine
that was not loaded, `q11_engine_boxes_gaia.log`: 13 to 23 s per empty box, about 60 s for the
star).

**Injected sources** (synthetic point sources in real exposures, `tests/injection.py`, seed 1,
48 movers and 16 brightness sources per run). Independent round of v1
(`ajan_durumu/test_sonuclari.md`): movers >= 0.3"/yr at AB 12 to 14: 97.8 % (Eps Indi B field),
91.4 % (WISE 0855 field), 75.0 % (Barnard field, crowded); at AB 18, >= 1"/yr: 67 %, 63 %, 20 %; 88
false candidates in 20 runs. Six of those runs repeated with finder 1.1 (`inj_final3_*.log`;
recovered sources, 1.1 / 1.0, the 1.0 numbers from `site/data/verify/evidence/injection.csv`):

| Field, AB | Movers | Brightness sources | False candidates |
|---|---|---|---|
| Eps Indi B, 12 | 37 / 37 | 10 / 10 | 7 / 11 |
| Eps Indi B, 13 | 34 / 34 | 13 / 13 | 9 / 10 |
| Eps Indi B, 14 | 35 / 35 | 10 / 11 | 3 / 10 |
| WISE 0855, 14 | 33 / 33 | 9 / 9 | 0 / 0 |
| WISE 0855, 18 | 16 / 15 | 4 / 4 | 2 / 1 |
| WISE 0855, 19 | 3 / 3 | 0 / 0 | 1 / 1 |

In the WISE 0855 field at AB 18 and 19 one of the "false" candidates is WISE 0855 itself (a real
mover that was not injected). The other one at AB 18 is a real source 21" from an injected 40"/yr
mover that was not found: 0.82 "/yr at 6.1 sigma, not confirmed. The brightness source lost at AB
14 appears 21" from Eps Indi B's track and is attached to that record. Movers >= 0.3"/yr at AB 12
to 14 in the Eps Indi B field: 89 of 91, as in v1 (97.8 %). These six runs were made before the
parallax, light-moved and catalogue rules of 4.1. With those rules, run from the published tree
(`inj_tree_wise_m18.log`), the WISE 0855 AB 18 run gives the same 16, 4 and 2 and none of the
rules rejects an injected mover; the other five were not repeated (machine load on 14 Nov).

## 8. Limits (measured) and what is not solved

* **Slowest motion.** Every `candidates.json` carries the limit of its own field (`sensitivity`,
  `verdict.limit`), computed from the field's measured noise, floor and exposure count: 5 sigma
  for an AB 16 source at 0.10"/yr (458 exposures) to 0.9"/yr (36 exposures) in 11 of the 12
  fields, and 1.07"/yr at AB 14 in the most crowded one. This number is not yet calibrated with
  injections. Injected movers of 0.05"/yr at AB 12 to 14 were not found (v1 round: 0 of 30), of
  0.1"/yr only in two of three fields (10 of 26).
* **Faint limit.** At AB 19 almost nothing is found (v1 round: 4 of 70 injected movers), at AB 18
  33 of 119.
* **A faint mover on top of an unlisted source is measured too slow.** An AB 18 mover injected at
  20"/yr on a real source of about its own brightness that is below the listing threshold came out
  at 13.6 "/yr (A) and 9.0 "/yr (D), with errors of 0.4 to 0.7 "/yr that do not cover the
  difference (`x1_fastmover.log`, `x2_whatsthere.log`). The same source injected at AB 14:
  19.82 +- 0.04. Not solved: the positions would have to be measured on difference images.
* **Blends.** Two sources closer than 8" are never a motion candidate; closer than 3.1" they are
  one source. Two sources that are both missing from the Gaia list (G > 19) and blend into one
  deep-stack source are the case that is left: the light-moved test (4.1) rejects such a record
  only when the position change is large enough to measure in the season stacks (1 - R at least 6
  errors: for the AB 18 sources of the injection test at 10", not at 5"), below that it only keeps
  the record from being confirmed (from 2"). The test was tried on one real case (section 7) and on injected movers; a
  real mover beside a much brighter star was only simulated.
* **Search area.** A job cut at 0.4 deg is searched in its central 0.2 x 0.2 deg only
  (`field.searched_deg`). Searching the whole cutout needs a Gaia list of the same size and four
  times the run time; it is not done and not tested.
* **Motion of Gaia stars relative to Gaia** (detector B) is not covered by the light-moved test.
* **Parallax.** A parallax from seasons half a year apart is degenerate with any offset that flips
  with the roll (Luhman 16: 468 +- 26 mas measured, 502 true).
* **Motion test for objects without parallax.** Straight tracks of 5 to 40 "/yr without parallax
  (what the injection test puts in) are measured correctly at AB 14 (4.99 to 5.05, 9.98 to 10.06,
  19.94 to 20.03, 40.00 to 40.16 "/yr for 5, 10, 20, 40 injected) but are not physical; they stay
  unconfirmed candidates (4.3).
* **Run time.** 5 to 72 s per field and 202 s for the Barnard field on a lightly loaded machine
  (`v1_frozen.log`); 57 % of the Barnard run is the Gaussian wing fit of saturated cores
  (`p1_barnard_profile.log`: 2506 fits of 0.12 s). Not optimised. A run with dozens of movers
  (the injection test) takes about twice as long as with v1, because every accepted mover is
  measured again until it converges.
* **Brightness changes** are never confirmed; their false-alarm rate is measured (above) but not
  yet part of the rule.

## 9. Running it

    uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow \
        python -I -u pipeline/find_candidates.py <target> --out <folder>      # challenge target
    ... pipeline/find_candidates.py --job <job id> --out <folder>             # engine job

Tests: `pipeline/detect/tests/{blind,injection,shuffle}.py`, `run_round.sh` (run by an independent
tester; results in `site/data/verify/` and at the top of [`ACCURACY.md`](ACCURACY.md)).
