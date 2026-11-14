# Known asteroids in single SPHEREx exposures (detector C, known-object mode)

Code: `pipeline/detect/asteroids.py` (method), `pipeline/detect/s3box.py` (S3 byte ranges),
`pipeline/detect/ssoephem.py` (SkyBoT + SPHEREx parallax), `pipeline/detect/asteroid_report.py`
(tables, site files, blink). Launcher: `pipeline/find_asteroids.py`.
Page: `site/asteroids.html` (data in `site/data/asteroids/`).

These are **recovered known asteroids**, used to test the moving-object detection. Nothing here is
a discovery. Unmatched detections are listed as candidates for follow-up (most are artifacts).

## Reproduce

```
uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow \
    python -I pipeline/find_asteroids.py select          # 24 fields -> cache/asteroids/fields.json
... python -I pipeline/find_asteroids.py run             # per field -> cache/asteroids/runs/F01.json ...
... python -I pipeline/find_asteroids.py report --site   # site/data/asteroids/summary.json, candidates.json
... python -I pipeline/find_asteroids.py blink --field F07 --name "..." --site
```

Everything downloaded is cached under `cache/asteroids/` (gitignored); a second run reads nothing
from the network. `cache/asteroids/bytes_ledger.json` keeps the running total of bytes read.

## Method

1. **Fields.** From the static sky index catalogue (`cache/sky_index/catalog.csv.gz`, 1.31 M images), all
   SPHEREx visits on detectors D2 (1.1-1.65 µm) and D3 (1.63-2.43 µm) whose four sub-exposures have their
   centre within 2° of the ecliptic. A visit is 4 sub-exposures taken 2.1 min apart; the pointing steps
   0.2° (117 px) between them, so the wavelength at a sky point steps by about 2.5 %. The mission span
   (DR1 + QR3, 2025-05 to 2026-09) is cut into 24 equal time bins and the visit nearest each bin centre is
   taken, alternating D2 and D3, if it has at least 3 reference visits (below). Dates and ecliptic
   longitudes are therefore spread over the whole sky. D1 (airglow) and D4-D6 (asteroids are faint in
   reflected light beyond 2.5 µm) are not used as targets.
2. **Known objects.** One IMCCE SkyBoT cone search per field (radius 1.5°, at the first sub-exposure's
   mid-time, geocentre, `-output obs`): every known asteroid and comet with its astrometric J2000
   position, V, position uncertainty, rates (dRA·cosδ, dDec), geocentric and heliocentric distance and
   phase angle. H is recovered from V, the distances and the phase angle (H-G, G = 0.15).
   Each position is moved to each sub-exposure's mid-time with the rates and then **from the geocentre
   to SPHEREx**: the exposure header gives the spacecraft position (`X_SC, Y_SC, Z_SC`, km, geocentric
   equatorial, mid-exposure). The direction is recomputed as `dg·u − r_sc`. SPHEREx is ~7000 km from the
   geocentre, so this parallax is ~4" for a main-belt asteroid at 2.5 AU and ~10" at 1 AU, i.e. up to
   1.6 px; without it a 1-px test would fail for the nearer objects.
3. **What is read from S3.** Every known object with V ≤ 20.5 that falls ≥ 8 px inside the detector gets
   a 33 × 33 native-pixel box (3.4' × 3.4') centred on its predicted pixel, in each sub-exposure. Only
   the IMAGE pixels of the box are read: the IMAGE layer is plain float32, so each box row is one HTTP
   Range request of 132 bytes (`s3box.py`). Each exposure costs one 28.8 kB request for the PRIMARY +
   IMAGE header (WCS with SIP, time, spacecraft position, PSF FWHM). FLAGS, VARIANCE and ZODI are not
   read (see 5).
4. **Static reference.** For each object, 3 reference exposures of the same detector that cover the same
   sky ≥ 1 day before or after the visit (the asteroid has moved ≥ 5' by then), one per visit, with the
   wavelength at that sky point closest to the target visit's (sky-index wavelength model). One patch
   per reference covers the boxes of all 4 sub-exposures. Each reference is resampled onto the target
   box pixels with the two WCS (cubic spline), shifted and scaled to the target by a linear least-squares
   fit on the bright pixels (removes residual misregistration and the colour/throughput difference), and
   background subtracted. The reference is the pixel median of the 3.
5. **Blind detection** (the ephemeris is not used inside the box):
   - difference D = target − reference;
   - noise: robust scatter of D plus a floor of 10 % of the reference brightness (undersampled stars do
     not subtract perfectly: the pixel phase differs between exposures);
   - matched filter with the SPHEREx EPSF of the detector (from the exposure's EPSF calibration file
     when it is cached locally, otherwise a Gaussian of the header PSF_FWHM), Z renormalised by its
     robust scatter in the box;
   - every local maximum with Z ≥ 4 at least 4 px from the box edge is fitted with the EPSF (flux,
     sub-pixel position, background; Gauss-Newton) on a 7 × 7 native-pixel stamp of D;
   - static-source residuals are rejected: reference flux / excess flux in the 3 × 3 core > 1 (the
     excess sits on a star of the reference), < −0.5 (a hole in the reference), or reduced χ² of the EPSF
     fit > 3 × (1 + (S/N / 25)²) (dipoles are not PSF-shaped; the allowance grows for bright sources
     because the EPSF is not perfect). This S/N is the one before the fit errors are scaled by √χ²:
     the scaled S/N of a bright source shrinks as its χ² grows and would reject the brightest
     asteroids;
   - flux in µJy = EPSF flux (MJy/sr × pixel) × 0.889 µJy (one native pixel of 1 MJy/sr).
6. **Confirmation within the visit.** Detections in different sub-exposures closer than 2 px on the sky
   are linked. An object is **detected** when it is seen in ≥ 2 sub-exposures with one of them at
   Z ≥ 5, or in ≥ 3 sub-exposures. Cosmic rays, hot pixels and persistence are fixed on the detector or
   present in one exposure only, while the pointing moves 117 px between sub-exposures, so they do not
   link. This replaces the FLAGS layer (which would cost ~5 kB per row).
7. **Visit stack (second, deeper mode).** The 4 differences are resampled onto the first box and
   averaged with inverse-variance weights (a main-belt asteroid moves < 0.5 px during the 6.3 min visit).
   Peaks with Z ≥ 5 are fitted on the stack and then again in each sub-exposure's own pixels (positions
   reported per exposure). Same residual cuts (χ² allowance 6 because of the resampling), plus a
   flux-consistency test across the sub-exposures (one sub-exposure carrying all the flux = cosmic ray).
8. **Matching.** Detected objects are matched to all known objects of the cone (any V) within 2 px; a
   recovered asteroid is the known object matched by a detected object. Detected objects without a match
   are counted as **false detections** (static-star residuals that passed the cuts, unknown movers or
   objects missing from the catalogue; they are not checked further). The offset detection − ephemeris
   is reported per sub-exposure.
9. **Tracklets across visits.** For each recovered object, the nearest other visit of the same detector
   within 1 day (1.6 h to 20 h later or earlier) that covers it is processed the same way (fresh SkyBoT
   cone at that time). Detections there are linked **without the ephemeris**: the position predicted
   from the first visit's own detections and measured motion, then a refit through the closest
   candidate; ≥ 2 detections of the second visit within 2 px of the refined track are required. The
   rate over the long arc is compared with the ephemeris rate (difference of the two predicted
   SPHEREx-centric positions divided by the time).
10. **Missed objects** get a reason, in this order: outside the detector, no references, ephemeris
   uncertainty > 2 px, masked pixels at the position (saturated star core / bad pixels), seen in one
   sub-exposure only (not confirmed), found at the position but rejected by the residual cuts (static
   source under it, not PSF-shaped, or a hole in the reference), a bright static source under it, and
   otherwise the forced EPSF
   photometry at the predicted position combined over the sub-exposures: "too faint" below S/N 5, or
   "below the per-exposure threshold" when the combined S/N is ≥ 5 but no single exposure reaches it,
   or "bad subtraction" when it is ≤ −5 (a star residual or a reference artefact at the position). In
   fields whose median difference noise is > 3 × the median field, the faint misses are marked
   "crowded field".

## Results

Generated 2026-11-14T13:41:58Z by `find_asteroids.py report` from `cache/asteroids/runs/`; the same numbers are in `site/data/asteroids/summary.json`.

- **24 fields**, 217 different known asteroids recovered blind in single exposures (741 single-exposure detections matched to the ephemeris).
- Recovered / known, by brightness: V < 17: **47 / 53**, V < 18: **101 / 132**, V < 19: **205 / 451**, V < 20: **217 / 1400**. Visit stack: V < 17: 48, V < 18: 98, V < 19: 192, V < 20: 208; either mode: V < 17: 48, V < 18: 102, V < 19: 217, V < 20: 238.
- Position offset detection − ephemeris (per exposure): median **0.111 px (0.68")**, 90 % 0.337 px (2.07"), worst 2.006 px (12.34"); **99.2 %** within 1 px.
- Without the move from the geocentre to SPHEREx the same detections are off by median 0.301 px, 90 % 0.58 px, worst 2.37 px.
- False detections (confirmed objects matching no known object): 96 in all, median 4 per field (per field: column 'False').
- Tracklets across visits: of 240 recovered objects (single exposures or visit stack), 135 had another visit of the same detector within 1 day; **47** were linked blindly there and confirmed by the ephemeris (every second-visit detection ≤ 2 px from it); wrong links: 1 (F21 1989 CU8: 11 px from the ephemeris). Measured rate − ephemeris rate (confirmed links): median 0.36 % of the rate, direction median 0.14°.
- Data read: **155.2 MB** of S3 byte ranges (744215 Range requests; with the measured 502-byte response headers 528.8 MB on the wire) and 21.1 MB from SkyBoT (218 cone searches), counting everything in `cache/asteroids/` including the development runs; the production runs alone (ledger) read 130.5 MB from S3 in 617036 requests. No whole file was downloaded.

### Per field

single = single-exposure detections confirmed within the visit, stack = visit stack, known = SkyBoT objects of that brightness inside the detector (≥ 8 px from the edge) in the 1.5° cone. b = Galactic latitude.

| Field | Date (UTC) | Det | λ_ecl | β | b | V<17 single / stack / known | V<18 | V<19 | V<20 | Offset median / worst (px) | ≤ 1 px | False single / stack | Faintest recovered single-exposure (V, H, µJy @ µm) | Tracklets linked / tried, rate diff |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F01 | 2025-05-06 21:12 | D2 | 320° | -1.3° | -42° | 1 / 1 / 1 | 1 / 1 / 2 | 6 / 6 / 19 | 7 / 6 / 47 | 0.16 / 0.38 | 100 % | 5 / 6 | Ashida: V 19.0, H 13.2, 374 µJy @ 1.44 | 4 / 7, 0.3 %, PA 0.1° |
| F02 | 2025-05-27 01:34 | D3 | 336° | -0.2° | -53° | 4 / 4 / 4 | 7 / 7 / 8 | 10 / 11 / 25 | 10 / 11 / 67 | 0.11 / 0.74 | 100 % | 4 / 4 | Grunewald: V 18.7, H 13.7, 272 µJy @ 1.65 | 6 / 11, 0.4 %, PA 0.2° |
| F03 | 2025-06-18 15:38 | D2 | 200° | -1.1° | +54° | 3 / 3 / 3 | 6 / 6 / 7 | 16 / 15 / 19 | 19 / 18 / 65 | 0.12 / 1.06 | 98 % | 6 / 1 | Lully: V 19.1, H 13.3, 220 µJy @ 1.33 | 0 / 0 |
| F04 | 2025-07-10 14:16 | D3 | 221° | -1.0° | +41° | 3 / 3 / 4 | 7 / 6 / 8 | 11 / 13 / 30 | 12 / 14 / 72 | 0.12 / 0.58 | 100 % | 8 / 2 | 1998 UW8: V 19.4, H 14.0, 162 µJy @ 1.77 | 1 / 2, 2.0 %, PA 0.9° |
| F05 | 2025-08-02 06:04 | D2 | 43° | -1.3° | -40° | 3 / 3 / 3 | 8 / 8 / 8 | 14 / 14 / 15 | 15 / 17 / 55 | 0.12 / 0.60 | 100 % | 2 / 3 | 1999 EN12: V 19.1, H 14.6, 288 µJy @ 1.44 | 3 / 5, 1.8 %, PA 0.7° |
| F06 | 2025-08-23 14:45 | D3 | 264° | -1.2° | +5° | 0 / 0 / 1 | 0 / 0 / 3 | 0 / 0 / 17 | 0 / 0 / 54 | - | - | 1 / 1 | - | 0 / 0 |
| F07 | 2025-09-14 05:09 | D2 | 283° | -0.9° | -12° | 2 / 2 / 3 | 2 / 2 / 6 | 2 / 2 / 23 | 2 / 2 / 77 | 0.10 / 0.33 | 100 % | 1 / 1 | Delvaux: V 16.0, H 11.1, 2772 µJy @ 1.30 | 0 / 1 |
| F08 | 2025-10-06 15:58 | D3 | 103° | -1.2° | +10° | 2 / 2 / 2 | 4 / 4 / 5 | 6 / 5 / 18 | 6 / 5 / 51 | 0.11 / 0.48 | 100 % | 2 / 1 | Anjandersen: V 18.6, H 14.1, 242 µJy @ 1.98 | 2 / 6, 2.3 %, PA 0.8° |
| F09 | 2025-10-28 19:15 | D2 | 127° | +0.7° | +32° | 2 / 2 / 2 | 5 / 5 / 6 | 11 / 11 / 16 | 13 / 13 / 50 | 0.09 / 0.64 | 100 % | 6 / 7 | 4612 P-L: V 19.5, H 15.6, 276 µJy @ 1.37 | 4 / 14, 0.5 %, PA 0.2° |
| F10 | 2025-11-19 16:48 | D3 | 347° | +1.1° | -57° | 1 / 1 / 2 | 4 / 4 / 6 | 12 / 10 / 24 | 12 / 11 / 71 | 0.13 / 1.86 | 97 % | 4 / 4 | 1991 UB4: V 18.5, H 13.3, 295 µJy @ 1.78 | 0 / 0 |
| F11 | 2025-12-11 11:57 | D2 | 357° | -0.1° | -60° | 0 / 0 / 0 | 4 / 4 / 4 | 8 / 8 / 14 | 8 / 8 / 57 | 0.14 / 0.67 | 100 % | 2 / 2 | Terryjones: V 18.9, H 15.0, 240 µJy @ 1.52 | 1 / 2, 0.7 %, PA 0.1° |
| F12 | 2026-01-02 06:21 | D3 | 186° | +1.2° | +61° | 2 / 2 / 2 | 6 / 6 / 6 | 13 / 11 / 15 | 15 / 12 / 50 | 0.12 / 1.09 | 98 % | 7 / 2 | Davidminton: V 19.7, H 14.2, 356 µJy @ 2.11 | 0 / 0 |
| F13 | 2026-01-24 14:27 | D2 | 213° | -0.5° | +46° | 0 / 0 / 0 | 0 / 0 / 0 | 6 / 4 / 9 | 6 / 5 / 42 | 0.23 / 0.57 | 100 % | 2 / 2 | 1999 GN21: V 18.9, H 14.0, 301 µJy @ 1.43 | 2 / 6, 0.3 %, PA 0.1° |
| F14 | 2026-02-15 06:14 | D3 | 226° | +1.2° | +38° | 1 / 1 / 1 | 2 / 2 / 2 | 4 / 2 / 13 | 4 / 3 / 49 | 0.13 / 0.92 | 100 % | 6 / 5 | Dedeyn: V 18.7, H 13.3, 233 µJy @ 1.67 | 0 / 1 |
| F15 | 2026-03-09 05:15 | D2 | 83° | -0.3° | -6° | 2 / 3 / 3 | 3 / 4 / 6 | 4 / 5 / 21 | 4 / 5 / 58 | 0.06 / 0.41 | 100 % | 4 / 2 | 1990 KC1: V 18.0, H 13.3, 391 µJy @ 1.17 | 0 / 3 |
| F16 | 2026-03-30 22:42 | D3 | 107° | -1.2° | +14° | 1 / 1 / 1 | 1 / 1 / 2 | 5 / 4 / 11 | 5 / 4 / 48 | 0.07 / 0.51 | 100 % | 2 / 2 | Vishnureddy: V 18.5, H 13.7, 247 µJy @ 1.79 | 0 / 0 |
| F17 | 2026-04-22 03:24 | D2 | 133° | +0.5° | +37° | 3 / 3 / 3 | 5 / 5 / 5 | 7 / 7 / 14 | 8 / 8 / 57 | 0.10 / 0.80 | 100 % | 2 / 1 | Jennanncsele: V 19.6, H 15.0, 312 µJy @ 1.19 | 0 / 2 |
| F18 | 2026-05-13 19:10 | D3 | 161° | -0.5° | +54° | 3 / 3 / 3 | 5 / 5 / 5 | 13 / 12 / 20 | 13 / 12 / 57 | 0.11 / 0.57 | 100 % | 9 / 3 | Batalov: V 18.4, H 12.8, 186 µJy @ 2.05 | 0 / 13 |
| F19 | 2026-06-05 04:05 | D2 | 347° | +1.4° | -56° | 2 / 2 / 2 | 5 / 5 / 5 | 10 / 10 / 17 | 11 / 11 / 52 | 0.15 / 1.67 | 98 % | 4 / 2 | Cureau: V 19.0, H 13.8, 240 µJy @ 1.30 | 5 / 12, 0.2 %, PA 0.1° |
| F20 | 2026-06-27 06:21 | D3 | 214° | +1.2° | +47° | 2 / 2 / 2 | 8 / 8 / 10 | 13 / 13 / 26 | 13 / 13 / 74 | 0.11 / 2.01 | 95 % | 5 / 4 | Clanga: V 18.5, H 14.8, 191 µJy @ 1.92 | 4 / 14, 3.7 %, PA 0.6° |
| F21 | 2026-07-18 21:20 | D2 | 23° | +0.4° | -52° | 2 / 2 / 2 | 3 / 3 / 3 | 13 / 12 / 19 | 13 / 13 / 51 | 0.13 / 0.63 | 100 % | 3 / 2 | 1989 SZ9: V 18.9, H 13.8, 227 µJy @ 1.37 | 7 / 14 (+1 wrong), 0.2 %, PA 0.1° |
| F22 | 2026-08-10 02:48 | D3 | 254° | -0.6° | +14° | 3 / 3 / 4 | 4 / 3 / 9 | 4 / 3 / 28 | 4 / 3 / 79 | 0.05 / 0.11 | 100 % | 2 / 1 | Etiennemarey: V 17.4, H 13.7, 491 µJy @ 1.93 | 1 / 4, 0.1 %, PA 0.1° |
| F23 | 2026-08-30 22:11 | D2 | 70° | +0.6° | -17° | 3 / 3 / 3 | 7 / 6 / 9 | 11 / 9 / 19 | 11 / 9 / 59 | 0.11 / 0.48 | 100 % | 3 / 2 | 1989 UK1: V 18.7, H 14.7, 250 µJy @ 1.50 | 5 / 12, 0.5 %, PA 0.2° |
| F24 | 2026-09-22 17:33 | D3 | 90° | -1.1° | -1° | 2 / 2 / 2 | 4 / 3 / 7 | 6 / 5 / 19 | 6 / 5 / 58 | 0.08 / 0.23 | 100 % | 6 / 8 | Caldeira: V 18.4, H 13.4, 230 µJy @ 2.05 | 2 / 6, 3.0 %, PA 0.5° |
| **Total** | | | | | | **47 / 48 / 53** | **101 / 98 / 132** | **205 / 192 / 451** | **217 / 208 / 1400** | | | | | |

### Tracklets (second visit linked without the ephemeris)

Δt = second visit − first visit. Offsets: second-visit detections − ephemeris. A link with an offset > 2 px is a wrong link (marked).

| Field | Object | Δt (h) | det. 2nd visit | offsets 2nd visit (px) | measured rate ("/h, PA) | ephemeris rate ("/h, PA) | Δrate | ΔPA |
|---|---|---|---|---|---|---|---|---|
| F01 | 1996 BA2 | -11.27 | 2 | 0.32, 0.29 | 56.64, 79.8° | 56.73, 79.7° | 0.26 % | +0.12° |
| F01 | 1998 KX48 | -11.30 | 3 | 0.15, 0.25, 0.04 | 34.96, 82.4° | 34.88, 82.2° | 0.32 % | +0.13° |
| F01 | Richardspalding | -11.30 | 3 | 0.40, 0.03, 0.23 | 36.07, 74.8° | 36.10, 75.0° | 0.33 % | -0.18° |
| F01 | Yanai | -11.30 | 3 | 0.03, 0.05, 0.09 | 32.61, 76.3° | 32.59, 76.3° | 0.12 % | -0.05° |
| F02 | 1997 GD20 | +19.55 | 3 | 0.14, 0.23, 0.18 | 48.04, 69.8° | 48.05, 69.7° | 0.23 % | +0.13° |
| F02 | 1998 GN7 | -1.66 | 3 | 0.10, 0.10, 0.10 | 49.97, 83.1° | 50.02, 82.8° | 0.55 % | +0.31° |
| F02 | Dolgorukij | -1.66 | 3 | 0.07, 0.21, 0.25 | 57.88, 67.7° | 58.35, 66.8° | 1.80 % | +0.93° |
| F02 | Galle | +19.55 | 3 | 0.09, 0.14, 0.21 | 45.35, 64.5° | 45.35, 64.5° | 0.09 % | -0.05° |
| F02 | Lilium | -1.66 | 3 | 0.13, 0.12, 0.04 | 33.77, 62.4° | 34.02, 62.1° | 0.88 % | +0.30° |
| F02 | Sersic | +19.55 | 3 | 0.17, 0.12, 0.08 | 47.20, 64.9° | 47.15, 64.9° | 0.12 % | -0.04° |
| F04 | Nagasaki | -8.09 | 2 | 0.22, 0.35 | 11.43, 106.9° | 11.56, 106.0° | 2.00 % | +0.92° |
| F05 | Gaffey | -1.55 | 2 | 0.10, 0.04 | 32.81, 72.5° | 32.97, 71.5° | 1.82 % | +1.01° |
| F05 | Neruda | -1.55 | 2 | 0.06, 0.15 | 36.19, 88.0° | 35.53, 87.5° | 2.01 % | +0.45° |
| F05 | Toshitsumita | -1.62 | 4 | 0.13, 0.15, 0.22, 0.05 | 61.11, 78.5° | 60.63, 77.8° | 1.47 % | +0.70° |
| F08 | Maury | -1.67 | 4 | 0.13, 0.16, 0.14, 0.35 | 26.39, 98.9° | 27.08, 98.4° | 2.73 % | +0.53° |
| F08 | Sollenberger | -1.59 | 2 | 0.07, 0.12 | 30.89, 110.8° | 30.69, 109.8° | 1.82 % | +0.97° |
| F09 | Bec-Borsenberger | -3.24 | 2 | 0.02, 0.19 | 31.57, 113.3° | 31.83, 113.0° | 0.94 % | +0.27° |
| F09 | Kiev | -3.24 | 2 | 0.14, 0.14 | 33.12, 96.8° | 33.22, 96.5° | 0.63 % | +0.32° |
| F09 | Plesetsk | -3.24 | 2 | 0.15, 0.21 | 33.96, 87.9° | 33.85, 88.0° | 0.31 % | -0.02° |
| F09 | Vasishtha | -3.24 | 2 | 0.14, 0.10 | 28.95, 117.1° | 29.02, 117.0° | 0.34 % | +0.14° |
| F11 | Terryjones | +3.32 | 2 | 0.15, 0.28 | 41.47, 77.0° | 41.77, 76.9° | 0.73 % | +0.10° |
| F13 | Kawaguchi | -17.91 | 2 | 0.27, 0.20 | 49.64, 106.1° | 49.66, 106.0° | 0.18 % | +0.10° |
| F13 | Yurilvovia | -13.02 | 2 | 0.21, 0.12 | 25.97, 104.6° | 25.89, 104.4° | 0.41 % | +0.15° |
| F19 | 1998 WU9 | -11.39 | 4 | 0.19, 0.27, 0.27, 0.09 | 69.14, 52.5° | 69.15, 52.5° | 0.12 % | +0.07° |
| F19 | 2000 ON21 | -11.39 | 4 | 0.30, 0.20, 0.06, 0.05 | 47.85, 83.5° | 47.90, 83.5° | 0.14 % | +0.04° |
| F19 | Kreisau | -11.32 | 2 | 0.03, 0.21 | 52.80, 61.2° | 52.85, 61.1° | 0.32 % | +0.17° |
| F19 | Murom | -11.39 | 4 | 0.09, 0.14, 0.08, 0.58 | 64.43, 66.3° | 64.34, 66.3° | 0.16 % | -0.05° |
| F19 | Taufiq | -11.39 | 4 | 0.07, 0.13, 0.02, 0.34 | 43.35, 77.5° | 43.40, 77.4° | 0.16 % | +0.05° |
| F20 | 1991 TQ | +22.82 | 4 | 0.26, 0.60, 0.14, 0.25 | 7.60, 162.3° | 7.69, 162.7° | 1.29 % | -0.35° |
| F20 | 1998 HE38 | +3.32 | 4 | 0.11, 0.64, 0.07, 0.10 | 18.43, 93.3° | 18.74, 94.0° | 1.99 % | -0.67° |
| F20 | Froeschle | +3.32 | 4 | 0.05, 0.02, 0.08, 0.63 | 8.48, 27.8° | 8.05, 27.3° | 5.47 % | +0.55° |
| F20 | Morihisa | +3.32 | 3 | 0.50, 0.08, 0.03 | 3.79, 191.3° | 3.56, 184.1° | 14.31 % | +7.14° |
| F21 | 1981 TP | -13.03 | 3 | 0.05, 0.12, 0.19 | 38.48, 68.0° | 38.53, 68.0° | 0.16 % | +0.03° |
| F21 | 1989 CU8 (**wrong link**) | -13.03 | 3 | 11.40, 11.45, 11.53 | 27.84, 77.6° | 28.75, 67.0° | 18.47 % | +10.61° |
| F21 | 1993 FG8 | -13.06 | 4 | 0.26, 0.35, 0.32, 0.53 | 62.55, 83.6° | 62.45, 83.6° | 0.16 % | +0.02° |
| F21 | 1998 QW34 | -13.03 | 3 | 0.57, 0.13, 0.17 | 38.68, 88.1° | 38.79, 88.2° | 0.36 % | -0.13° |
| F21 | Brassens | -13.06 | 4 | 0.02, 0.10, 0.09, 0.04 | 42.96, 61.9° | 42.98, 62.0° | 0.14 % | -0.08° |
| F21 | Iitatemura | -13.03 | 3 | 0.04, 0.06, 0.12 | 44.74, 60.9° | 44.80, 60.9° | 0.13 % | +0.01° |
| F21 | Rauthgundis | -13.06 | 4 | 0.10, 0.55, 0.10, 0.12 | 42.40, 59.7° | 42.34, 60.1° | 0.60 % | -0.33° |
| F21 | Shunda | -13.03 | 3 | 0.12, 0.25, 0.20 | 62.12, 61.2° | 62.20, 61.3° | 0.21 % | -0.10° |
| F22 | Etiennemarey | +21.16 | 4 | 0.18, 0.09, 0.16, 0.08 | 20.58, 100.4° | 20.57, 100.3° | 0.11 % | +0.06° |
| F23 | 1989 UK1 | +6.41 | 2 | 0.08, 0.27 | 64.90, 93.6° | 65.06, 93.7° | 0.27 % | -0.06° |
| F23 | Abehiroshi | +6.54 | 2 | 0.13, 0.11 | 38.03, 77.2° | 38.19, 77.3° | 0.48 % | -0.13° |
| F23 | Makio | +6.54 | 2 | 0.11, 0.26 | 46.15, 90.9° | 46.06, 91.4° | 0.91 % | -0.51° |
| F23 | Merta | +6.54 | 2 | 0.04, 0.03 | 31.29, 78.6° | 31.17, 78.8° | 0.49 % | -0.19° |
| F23 | Ralpharvey | +6.54 | 2 | 0.12, 0.25 | 47.61, 75.8° | 47.50, 76.0° | 0.46 % | -0.22° |
| F24 | Dares | +1.66 | 2 | 0.13, 0.32 | 12.83, 101.6° | 13.60, 102.5° | 5.84 % | -0.91° |
| F24 | Kaneko | +8.22 | 2 | 0.15, 0.02 | 25.52, 79.3° | 25.49, 79.3° | 0.12 % | +0.00° |

### Faintest recoveries

| Field | Object | V | H | flux (µJy) | λ (µm) | fit S/N (best exposure) | exposures |
|---|---|---|---|---|---|---|---|
| F12 | 11470 Davidminton | 19.7 | 14.18 | 356 | 2.06 | 7.2 | 2 |
| F17 | 28924 Jennanncsele | 19.6 | 14.98 | 312 | 1.19 | 6.6 | 2 |
| F09 | 23344 4612 P-L | 19.5 | 15.58 | 276 | 1.37 | 7.6 | 2 |
| F04 | 22748 1998 UW8 | 19.4 | 14.01 | 162 | 1.73 | 4.1 | 3 |
| F03 | 8676 Lully | 19.1 | 13.29 | 220 | 1.33 | 4.2 | 2 |
| F05 | 155500 1999 EN12 | 19.1 | 14.58 | 288 | 1.44 | 5.9 | 2 |
| F01 | 9227 Ashida | 19.0 | 13.16 | 374 | 1.44 | 7.0 | 3 |
| F03 | 103621 2000 CA25 | 19.0 | 15.81 | 244 | 1.40 | 4.8 | 4 |

### Missed known objects

Reasons, V < 19: blended with a static star: 62, too faint (S/N < 5 over the visit): 56, seen in 1 exposure only / not confirmed: 54, S/N 5-15 over the visit, < 5 per exposure: 34, bad subtraction (star residual): 18, not PSF-shaped (EPSF chi2 cut): 13, crowded field (star residuals): 9.
Reasons, V < 20: too faint (S/N < 5 over the visit): 622, blended with a static star: 212, seen in 1 exposure only / not confirmed: 117, S/N 5-15 over the visit, < 5 per exposure: 101, bad subtraction (star residual): 78, crowded field (star residuals): 31, not PSF-shaped (EPSF chi2 cut): 22.

Every missed object with V < 18:

| Field | Object | V | H | Reason |
|---|---|---|---|---|
| F07 | 861 Aida | 14.8 | 9.77 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) |
| F10 | 1946 Walraven | 15.0 | 12.05 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 4 sub-exposure(s) |
| F15 | 1269 Rollandia | 15.0 | 8.64 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) |
| F22 | 2713 Luxembourg | 16.3 | 11.42 | on a bright static source: its excess was rejected as a static-source residual in 2 sub-exposure(s) |
| F06 | 3876 Quaide | 16.6 | 11.67 | on a bright static source: its excess was rejected as a static-source residual in 1 sub-exposure(s) |
| F04 | 3978 Klepesta | 16.9 | 11.81 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 4 sub-exposure(s) |
| F03 | 1726 Hoffmeister | 17.1 | 12.18 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) |
| F07 | 1091 Spiraea | 17.1 | 10.96 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) |
| F22 | 2268 Szmytowna | 17.2 | 11.72 | on a bright static source: its excess was rejected as a static-source residual in 3 sub-exposure(s) |
| F15 | P/1999 XN120 | 17.3 | 11.34 | bad subtraction at the position (no excess in 4 sub-exposure(s)) |
| F22 | 5598 Carlmurray | 17.3 | 13.04 | on a bright static source: its excess was rejected as a static-source residual in 1 sub-exposure(s) |
| F01 | 3813 Fortov | 17.4 | 13.68 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) |
| F07 | 8782 Bakhrakh | 17.5 | 14.0 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 2 sub-exposure(s) |
| F08 | 3165 Mikawa | 17.5 | 12.95 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) |
| F10 | 3097 Tacitus | 17.5 | 12.35 | on a bright static source: its excess was rejected as a static-source residual in 4 sub-exposure(s) |
| F20 | 2652 Yabuuti | 17.5 | 12.72 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 4 sub-exposure(s) |
| F22 | 2597 Arthur | 17.5 | 11.99 | forced S/N 5.7 over the sub-exposures, below the per-exposure detection threshold |
| F06 | 4312 Knacke | 17.6 | 13.49 | crowded field (b = +4.7°, noise 24.4x the median field): bad subtraction at the position (no excess in 2 sub-exposure(s)) |
| F07 | 3999 Aristarchus | 17.6 | 12.74 | too faint (forced S/N 4.2) |
| F20 | 4187 Shulnazaria | 17.6 | 12.78 | on a bright static source: its excess was rejected as a static-source residual in 3 sub-exposure(s) |
| F06 | 36238 1999 VX19 | 17.7 | 13.78 | crowded field (b = +4.7°, noise 24.4x the median field): too faint (forced S/N -0.4) |
| F16 | 5394 Jurgens | 17.7 | 13.86 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) |
| F22 | 13360 1998 UD8 | 17.7 | 12.86 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) |
| F02 | 6301 Bohumilruprecht | 17.8 | 12.36 | on a bright static source: its excess was rejected as a static-source residual in 3 sub-exposure(s) |
| F09 | 3170 Dzhanibekov | 17.8 | 12.62 | not PSF-shaped: found but rejected by the EPSF chi2 cut in 3 sub-exposure(s) |
| F23 | 3832 Shapiro | 17.8 | 12.64 | on a bright static source: its excess was rejected as a static-source residual in 2 sub-exposure(s) |
| F24 | 5512 1988 VD7 | 17.8 | 13.52 | bad subtraction at the position (no excess in 2 sub-exposure(s)) |
| F24 | 2709 Sagan | 17.8 | 13.26 | on a bright static source: its excess was rejected as a static-source residual in 3 sub-exposure(s) |
| F15 | 23127 2000 AV97 | 17.9 | 14.02 | forced S/N 5.8 over the sub-exposures, below the per-exposure detection threshold |
| F23 | 2528 Mohler | 17.9 | 12.43 | too faint (forced S/N 4.7) |
| F24 | 7024 1992 PA4 | 17.9 | 12.55 | seen in one sub-exposure only, or not confirmed (needs 2, one at Z >= 5, or 3) |

The full list (V ≤ 20.5) with reasons is in `site/data/asteroids/summary.json` (`missed`).

## Limits

- **Detection depth.** One SPHEREx exposure (114 s) reaches a known asteroid of V ≈ 18-19 at 1.1-2.4 µm
  (S/N 5). Most V 19-20 objects of the SkyBoT list are below that; they are counted as missed, with
  their forced S/N. The visit stack adds little because the 4 sub-exposures are only 6 min apart and the
  residuals of the stars add up too.
- **Undersampled stars.** SPHEREx pixels (6.15") undersample the PSF (FWHM ≈ 1.2 px); resampled
  references do not remove stars perfectly. An asteroid on top of a star is lost ("blended with a static
  star"), and in the Galactic bulge (field F06, b = +4°) the residuals of the crowded stars dominate the
  noise everywhere ("crowded field").
- **Fast movers.** Linking within a visit allows 2 px (12") between sub-exposures 2.1 min apart, i.e.
  up to ~6'/h. Faster near-Earth objects would not be linked. The fastest boxed object was the Amor
  2011 GA62 (172"/h, V 20.3, too faint); the recovered objects move 3.8-71"/h.
- **Slow movers / stationary points.** References are ≥ 1 day away; an object moving < ~2"/h (near its
  stationary point) can partly subtract itself. 12 boxed objects were that slow (9 in F20, 3 in F22);
  none of them was recovered.
- **Ephemeris.** SkyBoT positions are geocentric; they are moved to SPHEREx with the header position.
  Objects with a SkyBoT uncertainty > 2 px are flagged; one boxed object was (2010 FX101 in F06, a lost
  object with an uncertainty of degrees).
- **False detections** are linked detections that match no known object. They were not inspected one
  by one; most are star residuals that passed the cuts. They are listed in `candidates.json` as
  `candidate` (never as discoveries).
- **What was not used.** FLAGS, VARIANCE and ZODI layers (linking replaces the flags; the noise is
  measured in the difference image), detectors D1 and D4-D6, and the second season of the same sky.
