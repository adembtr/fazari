# SPHEREx sky index — format

Static index of every SPHEREx Level 2 spectral image (one detector per image) of the public
collections **`spherex_dr1`** and **`spherex_qr3`**, so that a browser (no server) can find the
images that cover any sky position and then read them from the public S3 bucket
`nasa-irsa-spherex` with HTTP Range requests. Built by `pipeline/sky_index.py`; read by
`site/js/skyindex.js` (browser) and `sky_index.find_images()` (Python).

## Summary (build of 2026-11-14)

| | |
|---|---|
| collections | `spherex_dr1`: 945,725 images, MJD 60789.75–61174.49 (2025-04-24 → 2026-05-14); `spherex_qr3`: 362,124 images, MJD 61174.51–61318.00 (2026-05-14 → 2026-10-05) |
| total | 1,307,849 images (= IRSA TAP counts), all 6 detectors |
| sky coverage | 100 % of HEALPix order-6 cell centres are inside at least one image; up to 1445 images and 6 seasons per cell |
| tiling | HEALPix nested, base order 2 (192 cells of ~29°), adaptive split of tiles > 190 KB → 222 leaf tiles (182 at order 2, 40 at order 3) |
| size | 25.3 MB of tiles + `manifest.json` 23 KB + `coverage.json` 295 KB = 25.7 MB, 225 files |
| tiles | gzip size 58–185 KB (median 114 KB); 2,745,746 image records (each image is stored in 2.1 tiles on average) |
| per lookup | `manifest.json` (once, 23 KB, ~6 KB gzip-encoded by the server) + 1 tile (~60–185 KB) |
| footprint accuracy | corners within 0.18″ of the IRSA `s_region` polygons |

## Files

| file | content |
|---|---|
| `manifest.json` | metadata, dictionaries, footprint templates, list of tiles (read once per page) |
| `t/<order>/<pix>.bin.gz` | one tile: all images whose footprint touches that HEALPix cell |
| `coverage.json` | coverage map for display: images and seasons per HEALPix order-6 cell |
| `FORMAT.md` | this file |

## Lookup (one tile request per point)

1. Fetch `manifest.json` (cached for the page).
2. `manifest.tiles` maps HEALPix order → sorted list of nested pixel numbers. The tiles are the
   leaves of an adaptive quadtree: the whole sky starts at `healpix.base_order`, and a tile whose
   gzip size is above ~190 KB is split into its 4 children (down to `healpix.max_order`). Every
   point of the sky lies in exactly one leaf. Start at the deepest order, compute
   `ang2pix_nest(order, ra, dec)`, and take the first order whose list contains the pixel.
3. Fetch `t/<order>/<pix>.bin.gz` and gunzip it. GitHub Pages serves `.gz` files without
   `Content-Encoding`, so the client decompresses (`DecompressionStream('gzip')`); if the bytes do
   not start with `1f 8b`, the server already removed the gzip layer.
4. Test the point against each image footprint in the tile (below).

Every image is written into **every** leaf tile its footprint (grown by 0.02°) touches
(HEALPix `query_polygon`, inclusive mode), so one tile is enough for any point and any
query margin up to `max_margin` = 0.01°.

## Tile layout (after gunzip, little-endian)

`E` = number of exposures, `N` = number of images in the tile. "shuffled" columns store all byte 0s
of the column, then all byte 1s, ... (byte planes; this makes gzip much more effective).

| field | type | meaning |
|---|---|---|
| magic | 4 bytes | `SXT1` |
| E, N | uint32 ×2 | counts |
| dt | E × uint32, shuffled | exposure start time, delta-coded: `t_min = t_zero + t_unit × cumsum(dt)` (MJD; `t_unit` = 1e-6 day). Exposures are sorted by time |
| plan | E × uint8 (`plan_width` bytes) | index into `manifest.plans` |
| seq | E × uint16, shuffled | observation number (`0321` in `2025W33_2C_0321_1`) |
| sub | E × uint8 | exposure number in the observation (`1` in `..._0321_1`) |
| detmask | E × uint8 | bit d−1 set = detector Dd of this exposure is in this tile |
| retrymask | E × uint8 | bit d−1 set = that image lives in the plan's `retry_ver` folder |
| ra | N × uint32, shuffled | footprint centre RA / `pos_unit` (1e-4°) |
| dec | N × int32, shuffled | footprint centre Dec / `pos_unit` |
| ang | N × uint16, shuffled | footprint rotation, units of 2π/65536 |
| res | 8 × N × int16, shuffled | corner residuals, 8 columns x0 y0 x1 y1 x2 y2 x3 y3, units of `res_unit` (1e-4°) |

Images are listed exposure by exposure, and inside an exposure by increasing detector number
(the set bits of `detmask`).

### Image record → fields

- `obs_id = plan.plan + "_" + zero-pad(seq, 4) + "_" + sub`, e.g. `2025W33_2C_0321_1`.
- `collection = plan.rel` (`dr1` or `qr3`).
- `ver = retry ? plan.retry_ver : plan.ver`
- `s3_key = {rel}/level2/{plan}/{ver}/{det}/level2_{obs_id}D{det}_spx_{ver}.fits`;
  `url = s3_base + s3_key` (`https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/`).
- `mjd` = exposure start (`t_min`), `mjd_end = mjd + exposure_days` (every image has
  `t_max − t_min` = 0.00133238 d = 115.1 s in TAP).
- `lam_min_um`, `lam_max_um` = `manifest.lam_um[det]` (fixed per detector, identical in DR1 and QR3:
  D1 0.7455–1.1167, D2 1.1033–1.6499, D3 1.6301–2.4346, D4 2.4027–3.8473, D5 3.8113–4.4300,
  D6 4.4115–5.0096 µm).
- `approx_lam_um`: wavelength at the point, from the point's position inside the footprint
  (corners are detector pixels (0,0), (1,0), (1,1), (0,1) in that order) and the per-detector
  WCS-WAVE control grid `manifest.wave[det]` (`x`, `y` in 1-based detector pixels, `lam[iy][ix]`,
  bilinear). Good to about 1 %; read the image's own spectral WCS for exact values.

### Footprint model (4 corners, accurate to 0.18″)

Each footprint is the IRSA `s_region` quadrilateral. It is stored as:

- the centre (normalised mean of the 4 corner unit vectors), quantised to 1e-4°;
- in the gnomonic (TAN) tangent plane at that quantised centre, x to the east and y to the north
  (degrees), corner k is

  `x_k + i·y_k = e^{i·ang} · (Tx[det][k] + i·Ty[det][k]) + (res_xk + i·res_yk) · res_unit`

  where `T = manifest.templates[det]` is a fixed per-detector shape (median over all images).
  The residuals absorb the real shape differences and all quantisation, so the stored corners
  equal the IRSA corners to ≤ 0.18″ (rounding of the residual).

Point test: project the point onto the same tangent plane (`w = p·c`, `x = deg(p·e / w)`,
`y = deg(p·n / w)`; images with `w ≤ 0.5` are skipped). Great circles are straight lines in the
gnomonic projection, so the spherical quadrilateral becomes a plane convex quadrilateral. The
point matches if it is inside, or within `margin` of an edge. Default `margin` = 0.001° (3.6″),
the radius of the IRSA SIA `CIRCLE` search used for the reference lists, so results reproduce
SIA `POS=CIRCLE ra dec 0.001`.

## coverage.json

`{"scheme": "nested", "order": 6, "images": [...49152], "seasons": [...49152]}`: for each HEALPix
order-6 cell (~0.92°), the number of DR1+QR3 images whose footprint contains the cell centre, and
the number of "seasons" among them (groups of observing dates separated by more than 30 days).
Useful for a coverage display or to pick an interesting random field.

## Full catalog (Python only, not published)

`build` also writes `cache/sky_index/catalog.csv.gz` (gitignored): one row per image with
`obs_id, collection, detector, t_min, t_max, em_min_um, em_max_um, ra_center, dec_center,
ra1, dec1, …, ra4, dec4, s3_key` (corners exactly as IRSA `s_region`; `t_max = t_min + 0.0013323785`).

## Python API

```python
import sys; sys.path.insert(0, "pipeline")
from sky_index import find_images            # needs numpy only
rows = find_images(269.44627, 4.76820)       # margin=0.001, index="site/index"
# each row: obs_id, collection, detector, mjd, mjd_end, s3_key, url, lam_min_um, lam_max_um,
#           approx_lam_um, ra_center, dec_center, corners [[ra, dec] x 4]
```

## Data source

- IRSA TAP `spherex.obscore`, `obs_collection in ('spherex_dr1','spherex_qr3') and calib_level = 2`:
  `obs_id, obs_collection, energy_bandpassname, t_min, s_region`, downloaded in 5-day `t_min` chunks.
- IRSA TAP `spherex.artifact`: the URIs of the images stored in an `l2b_retry-…` folder (about 0.8 %).
  All other images live in the plan's single `l2b-…` folder.
- Anonymous S3 `ListObjectsV2` of `dr1/level2/` and `qr3/level2/`: plan → processing folders.
- The key rule was checked against the `cloud_access` keys of the 1948 SIA rows of the 5 test targets.

Not included: `spherex_dr1_deep`, `spherex_qr3_deep` (deep-field images; 233681 + 86700 images),
calibration products, and Level 3 spectra.

## Rebuild

```
cd fazari
uv run --no-project --with numpy --with healpy python -I pipeline/sky_index.py fetch   # ~45 min, resumable
uv run --no-project --with numpy --with healpy python -I pipeline/sky_index.py build
uv run --no-project --with numpy python -I pipeline/sky_index.py check                 # tests
uv run --no-project --with numpy python -I pipeline/sky_index.py query --ra 269.44627 --dec 4.76820
```

Cache: `cache/sky_index/` (gitignored): `obscore_<mjd>.csv.gz` (one per 5-day chunk),
`obscore_counts.csv`, `retry_uris.csv`, `s3_level2_folders.json`, `images.npz` (parsed arrays)
and `catalog.csv.gz`. `build` warns about tile files left over from an older build (they are
not deleted).

To pick up a new data release (e.g. QR4): add it to `COLLECTIONS`/`RELEASES` and extend
`T_STOP` in `sky_index.py`; move away the cached `images.npz`, `obscore_counts.csv`,
`retry_uris.csv`, `s3_level2_folders.json` and the time chunks that overlap the new dates
(older chunks are reused); then run `build`.

## Tests (`check`)

- The index result for the 5 challenge targets at their 2026.0 positions equals the IRSA SIA
  lists (`POS=CIRCLE ra dec 0.001`, collections `spherex_dr1` + `spherex_qr3`) image by image:
  Barnard's Star 358, Eps Indi B 458, WISE 0855-0714 258, RW Aur 335, R Dra 539.
- 3000 random and near-corner points: the index result always lies between the exact
  polygon test at margin 0.0005° and at 0.0015° (no missing or extra image beyond the
  quantisation).
- `site/js/skyindex.js` returns the same images, keys and times as Python (806 points,
  322,432 matches).

## Limits

- Only images that IRSA lists in `spherex.obscore` on the fetch date (2026-11-14). The index is
  a snapshot; rebuild it after new releases or reprocessing (a reprocessed image gets a new
  S3 folder, so old keys would then fail).
- `approx_lam_um` uses one WCS-WAVE table per detector (`pipeline/wcs_wave_tables.json`), checked
  against the exact per-image spectral WCS for Barnard's Star: median error 0.13 %, max 0.22 %.
- Points within ~0.2″ of an image edge (plus margin) may differ from SIA because of the
  footprint quantisation.
