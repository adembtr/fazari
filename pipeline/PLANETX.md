# Could SPHEREx see Planet X?

Night run of 14 Nov 2026. Detector `pipeline/detect/distant.py` (`distant-v3b`), driver `pipeline/find_distant.py`, page `site/planetx.html`.
Every number here is generated from `site/data/planetx/summary.json` (2026-11-15 00:06 +0300) and the run folders.

## Answer

Only a near and bright one. In 5 strips on the predicted orbit the search finds 50 % of injected bodies down to **V 19.39**; 90 % is not reached at any brightness (V 18.5: 107 of 120 found) (528 injected bodies, grey body with the Sun's colours).
A planet of 2.07 Earth radii is that bright out to 360 AU if it reflects 75 %, 308 AU for 40 %, 259 AU for 20 %; the prediction is q = 300 (+85/-60) AU, Q = 460 (+200/-110) AU.
Search result: first pass (rules frozen before the search, `distant-v3`) 8 links, 2 candidates, 0 confirmed; both candidates fail the follow-up checks. Second pass (`distant-v3b`, those checks built into the search and its null): 1 link, 0 candidates; that link was looked at again with a new strip centred on it and is not supported by deeper and independent data. No body found.
Area searched: 2.08 deg^2 = 0.024 % of the predicted band (8640 deg^2).

## Method

- Detector P: per season, residuals (exposure minus a template of the other seasons, same detector, matched wavelength) are shifted
  along the parallax trail for trial distances and stacked; peaks seen in one season only ("orphans", >= 5 sigma) of 3 seasons are linked
  if they fit one bound orbit; the false-link probability comes from the same field with each season's orphan list shuffled (N = 2000).
  v3 (this run) added: turned rectangular grid (strips), outlier rejection inside a visit, trial drifts inside a season, template from
  every other season, link strength = the weakest of the three strongest seasons.
- v3b (same night, after the first pass): the per-season distance estimates leave the orbit fit (they are biased where a body's own
  motion inside a season is comparable to its parallax trail and rejected true bright bodies). Instead: ONE TRACK (every linked season
  keeps >= 0.6 of its S/N when stacked with the link's distance and motion) and IT MOVES (fitted motion + 2 sigma >= 0.3 x circular
  speed). The fixed-artifact test also asks for >= 0.5 of the detection's flux. All rules apply to the shuffled lists too.
- Data: detector rows run along ecliptic longitude within 1-4 deg, the parallax direction. Per exposure ONE byte range: 110 rows x 2040
  columns of the IMAGE layer (0.19 x 3.5 deg, 0.9 MB instead of 71 MB), detectors 1-3 (0.75-2.4 um), all ~56 exposures per season
  (job cutouts: 30 over six detectors). Background = block median; variance = c0 + c1 x IMAGE, fitted per detector (5-15 %).
- Budget: 827.4 MB in 1791 range requests for the five strips (cap 1000 MB), <= 4 in flight, ledger `cache/planetx/ledger.json`; follow-up strip 152.8 MB: 980.2 MB in 1967 requests in all.
- Pre-registration (`ajan_durumu/uzak_cisim.md`): 20:48 prediction, five points on the median orbit of Brown & Batygin 2021, decision
  rule, byte budget, before any pixel was read; 21:53 freeze of v3 (md5 5b482cb2f98c75e30f454296f7188ce8) before the first unsealed run; 23:05
  addendum and freeze of v3b (md5 14dd135e1ec5f00771fcf26784a40f92) before it touched the real strips. The v3b pass is declared and NOT blind.
- What git shows: the times above come from our working notes, which are not in this repository. This file and the search code
  (`pipeline/detect/distant.py`, `pipeline/find_distant.py`) were first committed on 2026-11-15 00:16 +03 (`630fca7`), after the
  search. The v3 file was never committed, so its md5 cannot be checked; the md5 of v3b matches `pipeline/detect/distant.py` as
  committed.

## Fields already on disk (cutouts of 0.2 / 0.4 deg; flat spectrum, test orbits in every direction)

| test | v2d | v3 | v3b |
|---|---|---|---|
| purity, 18 fields: links / candidates | 0 / 0 | 0 / 0; shuffled lists: 0.005 chance links per field in one field, 0 in 17 | 0 / 0; shuffled lists: chance links in 1 of 18 fields (max 0.005) |
| field-74, 800 / 1500 / 3000 AU, AB 17, 18, 18.5, 18.75, 19 (6 bodies each) | 800: 5,4,5,2,0; 1500: 6,4,5,5,1; 3000: 6,5,4,3,1 | 800: 5,4,5,2,0; 1500: 6,4,5,5,1; 3000: 6,5,4,3,1 | 800: 4,3,3,2,0; 1500: 6,4,5,5,1; 3000: 6,5,4,3,1 |
| field-53 (0.4 deg), 300-1500 AU, AB 17, 18, 18.5, 18.75, 19, 19.5 | 300: 2,2,0,1,0,0; 500: 6,4,2,3,1,0; 800: 3,4,1,1,0,0; 1500: 5,4,2,3,0,0 | 300: 2,2,1,2,0,0; 500: 6,4,2,3,1,0; 800: 3,4,2,1,0,0; 1500: 5,4,2,3,0,0 | 300: 2,0,1,0,0,0; 500: 6,3,2,2,1,0; 800: 4,4,2,1,0,0; 1500: 5,5,3,3,0,0 |
| eps_indi_b, 800-3000 AU, AB 18, 19, 19.5, 19.75, 20, 20.5 | 800: 3,2,1,1,1,0; 1500: 4,2,3,2,0,0; 3000: 5,2,3,2,1,0 | 800: 4,2,1,1,1,0; 1500: 4,2,3,2,1,0; 3000: 5,2,4,3,1,0 | 800: 4,2,1,1,1,0; 1500: 5,3,3,2,1,0; 3000: 6,3,4,3,1,0 |
| single body per run, field-74, 800 AU, 24 seeds; AB 17, 17.5, 18, 18.4, 18.7, 19, 19.3 | - | 19,20,21,16,14,1,1 | 20,18,20,13,14,2,1 |

Totals: v3 139 of 322 bodies, 0 other candidates; v3b 136 of 322, 3 other candidates (3 of them contain detections of injected bodies). Run time per field: 0.8-19.7 s (median 3.3 s).
Single-body runs: the 50 % point is AB 18.75 (flat spectrum); 90 % is not reached. Measured cause at AB 17 (`out/X_diag`): 3 of 24 bodies lie on
a brighter star in one of the three seasons (static-source veto; field at b = -9 deg), 2 were injected on nearly radial orbits.
v3b against v3, the same 490 bodies: 17 found by v3 are not found by v3b, every one of them moving across the sky at 0.05-0.24 x circular speed (rule IT MOVES: such a test body cannot be told from a fixed source); 10 missed by v3 are found by v3b (bright slow bodies are no longer taken for fixed artifacts; no biased distance rows).

## The strip search

| strip | r on median orbit (AU) | RA, Dec | exposures per season | area (deg^2, 350 AU) | 5-sigma depth per season (AB) | orphans per season | links | candidates / confirmed | chance links per shuffled strip | s |
|---|---|---|---|---|---|---|---|---|---|---|
| F3-perihelion | 300 | 247.1364, -13.9067 | 114/56/56 | 0.36 | 19.98/19.46/19.82 | 71/42/30 | 3 -> 0 | 0 / 0 -> 0 / 0 | 0.6805 -> 0.155 | 77 |
| F4-nu-75 | 344 | 178.0113, +17.2906 | 56/55/54 | 0.51 | 19.63/19.51/19.58 | 32/33/39 | 1 -> 0 | 0 / 0 -> 0 / 0 | 1.4535 -> 0.035 | 58 |
| F5-nu+75 | 357 | 337.5836, -23.0562 | 67/56/45 | 0.40 | 19.73/19.75/19.69 | 41/52/14 | 3 -> 0 | 1 / 0 -> 0 / 0 | 0.636 -> 0.04 | 47 |
| F1-aphelion | 460 | 67.1364, +13.9067 | 54/56/56 | 0.40 | 19.65/19.63/19.67 | 22/60/17 | 1 -> 0 | 1 / 0 -> 0 / 0 | 0.973 -> 0.34 | 45 |
| F2-ra45 | 450 | 45.0000, +3.9034 | 55/54/59 | 0.42 | 19.62/19.45/19.63 | 10/43/40 | 0 -> 1 | 0 / 0 -> 0 / 0 | 0.27 -> 0.1035 | 53 |

"a -> b": first pass (v3, pre-registered) -> second pass (v3b). 893 exposures in all.

**First pass, F5-nu+75, 163.6 +- 0.2 AU** (S/N 6.4 / 5.6 / 5.6, false-link probability 0.0300, about AB 19.6; failed rule checks: seen in >= 2 detectors (combined S/N >= 3 each); false-link probability (randomised orphan lists of this fiel). Positions: 2025-05 RA 336.68969 Dec -23.36601; 2025-11 RA 335.93602 Dec -23.71281; 2026-05 RA 336.55541 Dec -23.52698.
Checks: one track FAIL, moves pass, persistent pass. All exposures stacked on the fitted track: S/N 0.8 (one body: ~10); fitted motion 724.8 +- 2.6 "/yr (circular: 619). Per season (S/N, on the link's track, without the two strongest visits): 2025-05 6.4, 2.1, 5.7; 2025-11 5.6, -1.0, 3.7; 2026-05 5.6, 0.2, 3.6.
Catalogues within 15" (Gaia DR3 / 2MASS / AllWISE / CatWISE2020; nearest in arcsec, - = none): 2025-05 11.6/-/11.6/-; 2025-11 -/-/-/-; 2026-05 9.9/-/9.1/-. SkyBoT (0.25 deg, first/middle/last exposure of each season): nearest known object 71" away, all V > 20.5 and moving 9-58 "/h.

**First pass, F1-aphelion, 187.4 +- 0.2 AU** (S/N 8.3 / 9.9 / 13.3, false-link probability 0.0045, about AB 18.8; failed rule checks: false-link probability (randomised orphan lists of this fiel). Positions: 2025-08 RA 65.86166 Dec +13.69585; 2026-02 RA 65.24935 Dec +13.58728; 2026-08 RA 65.85904 Dec +13.69539.
Checks: one track FAIL, moves FAIL, persistent FAIL. All exposures stacked on the fitted track: S/N 11.3 (one body: ~18); fitted motion 11.1 +- 2.3 "/yr (circular: 505). Per season (S/N, on the link's track, without the two strongest visits): 2025-08 8.3, 7.0, 6.5; 2026-02 9.9, 3.5, 3.9; 2026-08 13.3, 8.4, 11.0.
Catalogues within 15" (Gaia DR3 / 2MASS / AllWISE / CatWISE2020; nearest in arcsec, - = none): 2025-08 -/-/-/-; 2026-02 11.5/-/9.1/-; 2026-08 -/-/-/-. SkyBoT (0.25 deg, first/middle/last exposure of each season): nearest known object 73" away, all V > 20.5 and moving 9-58 "/h.

Neither is one distant body. The F5 link is three unrelated season peaks (nothing on the fitted track). The F1 link is a source at one
fixed place in both August seasons (2025-08 73 +- 22 uJy, 2026-08 110 +- 28 uJy in the raw images; absent in February, -32 +- 13;
no catalogue counterpart; not a moving body) plus a February detection that comes from the first two visits of that season. What the
fixed source is, is NOT established: a J = 8.45 star lies 262" away along the detector rows, but a mirrored ghost of it is not seen.
Two candidates are more than the shuffling predicts for five strips (~0.25): shuffling each season independently cannot reproduce a
fixed source present in two seasons. The three checks were written down at 22:12, before they were applied to injected bodies: V1 forced
S/N on the link's track >= 0.6 x the season's own S/N; V2 fitted motion >= 0.3 x circular; V3 S/N without the two strongest visits >= 0.5.
On injected bodies (v3 links): 39 of 39 pass all three (F1 350 AU V 19.0, F1 500 AU V 18.5, F5 350 AU V 19.0, F5 500 AU V 19.4).

**Second pass (v3b):** V1 and V2 are link rules, for the real and the shuffled lists alike: 1 link and no candidate in the five strips.
The link: F2-ra45, 420.4 +- 1.0 AU, S/N 6.6 / 5.0 / 5.7, false-link probability 0.098 (> 0.05: links like it turn up in that fraction of the shuffled copies of the strip), so it is not a candidate. Positions: 2025-08 RA 44.57656 Dec +3.69494; 2026-01 RA 44.30581 Dec +3.61203; 2026-08 RA 44.55299 Dec +3.69301; about AB 19.4; motion 82.4 "/yr (circular 150).
It passes one track, moves and persistent (`out/VET3b/tests_plain_F2-ra45.json`); a Gaia G 16.0 star lies 14" from its 2025-08 position and a
G 19.0 star 13" from its 2026-08 position, nothing within 15" in 2026-01; nearest known asteroid 85" (V 22.7) (`out/VET3b/cats_F2-ra45.json`).

**Follow-up of that link** (`ajan_durumu/uzak_cisim_yedek/night/followup_f2.py`; tests and decision rule written into the state file at 00:00 on 15 Nov, before the data were read). Its three positions lay
3-17 rows from the edge of the F2 strips (37 / 35 / 38 exposures covered them). One new strip centred on the link (RA 44.4785, Dec +3.6667):
171 exposures (56/56/59), 152.8 MB in 176 requests.
- T1, all exposures, blind search: 0 links (0.075 chance links per shuffled strip); the link is NOT found again. Forced S/N at its positions (best of 5 x 5 pixels) 4.3 / 3.0 / 4.3; a real body: about 8.1 / 6.3 / 7.1; before: 6.6 / 5.0 / 5.7.
- T2, only the exposures that had not covered the positions (19/21/21; independent data): forced S/N 0.9 / 1.5 / 2.3; a real body: about 4.7 / 3.9 / 4.2; against 300 random places of the same stacks p = 0.631 / 0.362 / 0.066, combined (Fisher) 0.212.
Decision by the rule: a chance link, not supported by deeper and independent data. No candidate remains.

## Limits (injection-recovery in the same strips)

Bodies on exact 3-D tracks (prograde, within 25 deg of the ecliptic, 0.75-1.2 x circular speed), real EPSF, Poisson noise of the added signal;
V of a grey body with the Sun's colours (AB = V - 0.3 at 0.9 um, V + 0.3 at 2.2 um; Willmer 2018). Found = linked in three seasons AND
false-link probability <= 0.05 against the shuffled orphan lists of that strip without the injected bodies (N = 1000).
Second pass (v3b): 350, 500 AU: all five strips.
First pass (v3): 350, 500 AU in all five strips, 250, 700, 1000 AU in strip F4; 250, 700, 1000 AU and the flat spectrum were NOT repeated with v3b (one heavy process at a time was allowed that night).

| distance (AU) | found / injected by V | 50 % | 90 % |
|---|---|---|---|
| all | 18.5: 107/120, 19: 94/120, 19.4: 59/120, 19.7: 23/120, 20: 2/24, 20.3: 0/24 | 19.39 | - |
| 350 | 18.5: 54/60, 19: 47/60, 19.4: 26/60, 19.7: 13/60, 20: 1/12, 20.3: 0/12 | 19.32 | 18.50 |
| 500 | 18.5: 53/60, 19: 47/60, 19.4: 33/60, 19.7: 10/60, 20: 1/12, 20.3: 0/12 | 19.44 | - |

First pass (v3), 900 bodies in 75 runs: 50 % at V 19.31; 18.5: 98/120, 19: 118/156, 19.4: 67/156, 19.7: 25/156, 20: 1/156, 20.3: 0/156; by distance: 250 AU V 19.50, 350 AU V 19.30, 500 AU V 19.27, 700 AU V 19.33, 1000 AU V 19.40.
The 44 runs both passes share (528 bodies, the same bodies): v3b finds 285, v3 251; v3b finds fewer in 0 runs and more in 21.
Linked at all (any false-link probability): 18.5: 107/120, 19: 94/120, 19.4: 64/120, 19.7: 30/120, 20: 2/24, 20.3: 0/24: faint bodies are lost at the detection
in the weakest of the three seasons, not at the false-link test.
Confirmed by the full rule (false-link probability <= 0.001 and every other check): 50 % at V 19.11.
Middle third of the strips only: 50 % at V 19.47 (the ends are covered by fewer exposures).
Flat spectrum (F4, 400 AU, first pass only): 50 % at AB 19.30. v2d on small cutouts: AB 18.8.
Links that are not an injected body in the 44 injected runs (false-link probability <= 0.05): 0 x a link of the real data found again, 8 x a mix that contains detections of injected bodies (12 bodies share one strip), 0 made of background only. Median distance error of a found body: 1.2 AU.

Why bright bodies are missed (measured, F1, 350 AU, V 18.5, 12 bodies; `out/diag_link_F1*.log`): 2 lie on a brighter star in one of the three
seasons (static-source veto), 1 has a star >= 10 x brighter at the midpoint of two detections (orientation-ghost veto, a chance
coincidence), 1 was rejected by v3's orbit fit because of a biased per-season distance estimate (fixed in v3b: linked).
The static-source and ghost vetoes are a real loss of area next to stars; that is why 90 % is not reached.

Effective area (reference positions whose three season positions are all covered), all strips: 250 AU 1.95 deg^2, 350 AU 2.08 deg^2, 500 AU 2.18 deg^2, 700 AU 2.23 deg^2, 1000 AU 2.27 deg^2.

**Upper limit:** no body brighter than V 19.39 (50 % completeness; 89 % at V 18.5, 90 % not reached) between 350 and 500 AU in 5 strips covering 2.08 deg^2 (rules of distant-v3b). It says nothing about the rest of the band.
With the first-pass rules (v3; its two candidates fail the checks): V 19.31 at 50 % between 250 and 1000 AU (82 % at V 18.5).
Chance links expected from the shuffled copies, five strips together: v3 4.01 (found: 8 links), distant-v3b 0.67 (found: 1).

## Run 2 (15 Nov 2026, registered in git before the data were read)

Five more strips on the same median orbit (nu +170, +145, +135, +125, +115; time-weighted next to aphelion, >= 6 deg from
every strip above), distant-v3b unchanged. Rules, plan, file hashes and injection plan: `pipeline/PLANETX_RUN2_PREREG.md`,
pushed to GitHub 10:03:55 +03 (commit 1efa576); first image byte read 10:04:12. Result: `pipeline/PLANETX_RUN2.md`.
- 884.8 MB in 1913 requests; 1 link (2117 AU, false-link probability 0.12), 0 candidates.
- Run 2 alone: 50 % at V 19.55, 90 % at V 18.67 (600 bodies), 2.41 deg^2 at 350 AU.
- Both runs: **no body brighter than V 19.49 (50 %; 90 %: V 18.57) between 350 and 500 AU in 4.49 deg^2** (0.052 % of the band).

<!-- inject10k: written by pipeline/planetx_inject10k_summary.py -->
## 10,400-body injection test (15 Nov 2026, added after the run 2 pre-registration)

Added after the run 2 pre-registration (1efa576), at Adem's request. Detection rules unchanged. Plan
`pipeline/PLANETX_INJECT10K_PLAN.md` (pushed 11:07:12 +03, before the test ran; amendment 36ed43d at 12:09: run until all
20 blocks are done); result `pipeline/PLANETX_INJECT10K.md`.
- The same strips (F1-F5, R2 x 5), the same body model, 52 bodies per run, V 17.5-20 in 10 steps, 350 / 500 AU:
  10,400 bodies in 20 complete blocks (10 strips). The candidate lists do not change.
- 50 % found down to **V 19.44** (16-84 %: 19.43-19.45; 1128 bodies: V 19.49); 90 %: V 18.08 (1128 bodies: V 18.57).
- **No body brighter than V 19.44 between 350 and 500 AU in 4.49 deg^2** (0.052 % of the band).
- Density check: 52 bodies per run against 12 per run, found at V 18.5: 86 % against 92 % (z -2.34); V 19: 77 % against 80 % (z -0.94); V 19.4: 55 % against 60 % (z -1.39); V 19.7: 25 % against 24 % (z 0.31); V 20: 2 % against 5 % (z -2.0).
<!-- /inject10k -->

## Run 3 (15 Nov 2026, registered in git before the data were read)

Five more strips on the same median orbit (nu +105, -95, +95, -65, -55; run 2's selection rule with the run-2 strips added),
distant-v3b unchanged. Rules, plan, file hashes and injection plan: `pipeline/PLANETX_RUN3_PREREG.md`, pushed to GitHub
12:15:32 +03 (commit 09bd296); first image byte read 16:07:36 (after E2). Result: `pipeline/PLANETX_RUN3.md`.
- 856.1 MB in 1853 requests; 0 links, 0 candidates (0.40 chance links expected).
- Run 3 alone: 50 % at V 19.56, 90 % at V 19.00 (600 bodies), 2.58 deg^2 at 350 AU.
- All three runs (old ten strips with E2's 10,400 bodies, plus run 3's 600): **no body brighter than V 19.45 (50 %; 90 %:
  V 18.10) between 350 and 500 AU in 7.07 deg^2** (0.082 % of the band). 12 bodies per cell only (1728 bodies): V 19.51 / 18.64.

## Measured, assumed, not verified

- Measured: everything in the tables; distances of found bodies are right to ~1 AU.
- Assumed: radius 2.07 R_earth from 6.2 M_earth (Brown & Batygin 2021: r = (m / 3 M_earth) R_earth, Wu & Lithwick 2013), albedo
  0.2-0.75 (0.75: Fortney et al. 2016), and a GREY reflector: the same reflectivity at 0.75-2.4 um as in V. Uranus and Neptune are several
  times darker there (methane); if Planet X is, SPHEREx sees it 1-2 mag fainter than the chart and the reach shrinks accordingly.
- Checked (14 Nov 23:24, C. Willmer's online table of the Sun's absolute magnitudes, read by an automated page reader): the solar colours
  used to turn V into AB at 0.6-2.2 um (r, i, z, J, H, Ks) agree to 0.00 mag. The W1 / W2 values in the code are 0.01-0.02 mag off; they
  lie outside detectors 1-3 and change nothing here.
- Not verified: the nature of the F1 fixed source. SkyBoT was asked for the geocentre, not for SPHEREx's position (a few arcsec for
  main-belt objects, irrelevant at 70"+).
- Driver in the tree (`pipeline/find_distant.py`): with distant-v3b, `search` on F2 (1 link, 0 candidates, 68 s) and `inject` + `limits` on one cell (F5, 350 AU, V 19.0: 9 of 12 found) reproduce the harness numbers; `plan` and `fetch` ran in the first pass and were not repeated; `inject` needs the reproject package in the environment; the detector was NOT run through `detect/run.py` `find()` (that file changed during the night and is not ours).
- Limits of v3b's two rules, measured: IT MOVES rejects test bodies that cross the sky slower than 0.3 x circular speed (near-radial orbits;
  bound orbits with e > 0.91 near aphelion): that is every body v3 found and v3b lost in the fields on disk. Beyond ~1000 AU the same rule
  has no power (0.3 x circular speed is below 2 sigma of the fitted motion): in one injected run a source at a fixed place in both
  August seasons of F3 was linked with one injected detection at 2438 AU. A candidate that far out needs the per-visit and same-place checks by hand.
- v3b was changed after the first pass had been unsealed: its result is a second, declared pass, not a blind one.
- The limits are area averages: strip ends are covered by ~40 % of the exposures of the middle. Only three seasons exist, so a link has one
  redundant coordinate; a fourth season would make chance links hundreds of times rarer.

## What more data would buy

- Same strips, every exposure that touches them (about 2x the bytes, ~1.6 GB): the depth of the strip middle everywhere, about +0.08 mag on the 50 % limit (middle third now: V 19.47).
- The whole predicted band at this depth: the IMAGE layer of every D1-D3 exposure over 8640 deg^2, about 2 TB
  (we read 0.83 GB = 0.024 % of the band).
- A fourth season (data taken from Nov 2026 on): confirmation at the 5.5-sigma level instead of ~8, and far fewer chance links.

## Commands

```
U="uv run --no-project --with astropy --with reproject --with numpy --with scipy --with pillow python -I"   # reproject: needed by inject
$U pipeline/find_distant.py plan                       # refuses to overwrite cache/planetx/plan_prereg.json
$U pipeline/find_distant.py fetch                      # 893 strips, restartable, ledger in cache/planetx/ledger.json
$U pipeline/find_distant.py search --field F4-nu-75    # -> cache/planetx/results/plain_strip_F4-nu-75.json
$U pipeline/find_distant.py inject --field F4-nu-75 --dists 350,500 --mags 18.5,19,19.4,19.7,20,20.3
$U pipeline/find_distant.py limits cache/planetx/injections
```

Registering the detector in `pipeline/detect/run.py` (not done here; that file has another owner): append `distant` to the
`from . import diffimg, gaia_astrom, ...` line (line 27 on 15 Nov 00:10) and to `DETECTORS = [diffimg, gaia_astrom, deep_astrom, variab, fast]`
(line 33), which becomes `[..., fast, distant]`. `find()` already keeps the records of detector "P" apart from the position merge. It needs >= 3 seasons; 0.8-19.7 s per field on the 18 fields on disk (median 3.3 s).
A candidate is never a discovery: look at the per-visit signal, the catalogues and known asteroids first.

## Sources

Brown & Batygin 2021, AJ 162, 219 (arXiv:2108.09868). Batygin, Adams, Brown & Becker 2019, Phys. Rep. 805, 1. Fortney et al. 2016, ApJL 824, L25.
Wu & Lithwick 2013, ApJ 772, 74. Willmer 2018, ApJS 236, 47. SPHEREx Level 2 images: NASA/JPL-Caltech, IRSA (public S3). Gaia DR3, 2MASS,
AllWISE, CatWISE2020 via VizieR (CDS). IMCCE SkyBoT (Berthier et al. 2006).
