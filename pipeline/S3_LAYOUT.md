# SPHEREx Level 2 files on S3: byte layout and region reading

Status: verified. Headers of DR1 and QR3 files were read with HTTP Range requests; no whole file was downloaded.
`pipeline/fetch_region.py` (Python reference) reproduces IRSA cutouts bit for bit
(17/17 images: IMAGE, FLAGS, ZODI, VARIANCE and headers identical; the geometry rule matches 1924/1924 local cutouts).
Tests: `pipeline/test_fetch_region.py`. This note is the guide for the browser (JS) reader.

## Access

- URL: `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/<key>`
  (key = `dr1/level2/...fits` or `qr3/level2/...fits`, the same path as after `ibe/data/spherex/` in the IRSA URL).
- Anonymous `GET` with `Range: bytes=a-b` returns `206`. S3 does **not** support multi-range (`bytes=a-b,c-d`).
- Suffix ranges work (`Range: bytes=-5760` = the last 5760 bytes).
- **CORS:** `Access-Control-Allow-Origin: *`, `Allow-Headers: range`, but `Access-Control-Expose-Headers: ETag, x-amz-meta-custom-header`.
  **`Content-Range` is not readable from browser JS**, so the browser does not learn the file size from a ranged GET.
  Nothing below needs the size. (A `Range` of the form `bytes=a-b` is CORS-safelisted; `bytes=-n` is not and
  costs a preflight per URL. Avoid the suffix read in the browser, see "WCS-WAVE" below.)
- Files are about 61-65 MB. Never read a whole file.
- Latency measured from Turkey: about 0.5-0.6 s to first byte on a new connection, about 0.7-1 MB/s per stream.

## HDU order (all files seen)

FITS = 2880-byte blocks. Every header and every data unit is padded to a multiple of 2880.
A header ends at the 80-char card `END`; header length = ceil((index_of_END_card + 80) / 2880) * 2880.

| # | EXTNAME  | type | header length seen | data |
|---|----------|------|--------------------|------|
| 0 | PRIMARY  | no data (NAXIS=0) | 2880 | none |
| 1 | IMAGE    | IMAGE, BITPIX=-32 (float32, big-endian), 2040x2040, MJy/sr | **23040 or 25920 (varies)** | 16,646,400 bytes (= 2040*2040*4, a multiple of 2880, no padding) |
| 2 | FLAGS    | **tile-compressed** int32 image in a BINTABLE (`ZIMAGE=T`, `ZCMPTYPE='RICE_1'`) | 17280 | 2040*8 descriptor table + heap (**PCOUNT varies**, ~7-11 MB) |
| 3 | VARIANCE | IMAGE, float32, 2040x2040, MJy2/sr2 | 11520 | 16,646,400 |
| 4 | ZODI     | IMAGE, float32, 2040x2040, MJy/sr | 11520 | 16,646,400 |
| 5 | EPSF     | BINTABLE (PSF models), ~3.9 MB, NAXIS1 varies | 5760 | varies |
| 6 | WCS-WAVE | BINTABLE, 1 row of 720-2212 bytes (by detector) | 2880 | < 2880 -> padded 2880 |

Example (`dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits`, 64,952,640 bytes):

| HDU | header offset | header len | data offset | data size (unpadded) |
|-----|---------------|-----------|-------------|-----------|
| PRIMARY | 0 | 2880 | 2880 | 0 |
| IMAGE | 2880 | 23040 | 25920 | 16,646,400 |
| FLAGS | 16,672,320 | 17280 | 16,689,600 | 16,320 table + 11,056,032 heap |
| VARIANCE | 27,763,200 | 11520 | 27,774,720 | 16,646,400 |
| ZODI | 44,421,120 | 11520 | 44,432,640 | 16,646,400 |
| EPSF | 61,079,040 | 5760 | 61,084,800 | 3,859,632 |
| WCS-WAVE | 64,946,880 | 2880 | 64,949,760 | 720 |

**Do not hard-code offsets.** The IMAGE header length and the FLAGS heap size change from file to file, so every
HDU after IMAGE moves. Walk the headers, or guess and verify (request plan below):
`next_hdu = data_offset + ceil(datasize / 2880) * 2880`, `datasize = |BITPIX|/8 * GCOUNT * (PCOUNT + NAXIS1*NAXIS2)`.

## Image layers (IMAGE, VARIANCE, ZODI)

Plain, uncompressed, big-endian float32, row-major. FITS row y (0-based) starts at `data_offset + y * 8160`
(one row = 2040 * 4 bytes). No BSCALE/BZERO. NaN marks bad pixels.

Rows y0..y1 (inclusive): one range `[data_offset + y0*8160, data_offset + (y1+1)*8160)`, then columns x0..x1 of each row.
JS: `DataView.getFloat32(off, false)` (big-endian), or byte-swap into a Float32Array.

## FLAGS (tile-compressed, RICE_1)

Header keywords (identical in all files seen):
```
XTENSION='BINTABLE' NAXIS1=8 NAXIS2=2040 PCOUNT=<heap bytes> TFIELDS=1
TTYPE1='COMPRESSED_DATA' TFORM1='1PB(<max>)'
ZIMAGE=T ZBITPIX=32 ZNAXIS1=2040 ZNAXIS2=2040 ZTILE1=2040 ZTILE2=1 ZCMPTYPE='RICE_1'
ZNAME1='BLOCKSIZE' ZVAL1=32   ZNAME2='BYTEPIX' ZVAL2=4
```
No ZSCALE/ZZERO/ZBLANK/ZQUANTIZ/THEAP: the values are exact int32 bitmasks (lossless). Highest bit used is 28, so all values are >= 0.
Mask names: `MSKNnnnn` (name), `MSKMnnnn` (= 1 << n), `MSKDnnnn` (description) in the FLAGS header.

- **One tile = one image row** (ZTILE = 2040 x 1). Tile k (0-based) = image row k.
- Descriptor table at `flags_data_offset`: 2040 x 8 bytes; row k = two big-endian int32 `(nbytes, heap_offset)` (`1PB` = 32-bit P descriptor).
- Heap starts at `flags_data_offset + 8*2040` (THEAP absent).
- The heap is in row order and contiguous (`offset[k+1] = offset[k] + nbytes[k]`, verified). A row compresses to 4-6 KB (raw 8160).
- Rows y0..y1: (1) descriptors `[flags_data_offset + 8*y0, flags_data_offset + 8*(y1+1))` (or the whole 16,320-byte table
  together with the FLAGS header), (2) one heap range `[heap + offset[y0], heap + offset[y1] + nbytes[y1])`,
  (3) Rice-decode each row (2040 int32), then take columns x0..x1. A row can only be decoded whole.

### RICE_1 decoding (cfitsio `fits_rdecomp`, 32-bit pixels, blocksize 32)

```
bytes 0..3: first pixel value, big-endian (this is also the initial "lastpix")
then a bit stream, MSB first:
for each block of 32 pixels (the last block may be shorter):
    fs = read 5 bits - 1
    if fs < 0:      all pixels in block = lastpix             (low-entropy block)
    elif fs == 25:  each pixel: diff = read 32 raw bits        (high-entropy block)
    else:           each pixel: nzero = count 0 bits until a 1 bit (consume the 1),
                                diff  = (nzero << fs) | read fs bits
    per pixel:  diff = (diff & 1) ? ~(diff >> 1) : (diff >> 1)   # unsigned 32-bit math
                pixel = (diff + lastpix) mod 2^32 -> as int32;  lastpix = pixel
```
JS: `<<` and `~` work on int32, so keep values unsigned with `>>> 0` after each step (`(nzero << fs) >>> 0` etc.);
`| 0` gives the int32 at the end. `fetch_region.rice_decode` is a line-by-line Python version, checked against astropy's C codec.

## WCS

Celestial WCS (primary key ' ', identical in the IMAGE, FLAGS, VARIANCE, ZODI headers):
`CRPIX1/2, CRVAL1/2, PC1_1, PC1_2, PC2_1, PC2_2, CDELT1/2 (=1.0), CTYPE1/2 = 'RA---TAN-SIP'/'DEC--TAN-SIP', LONPOLE=180,
LATPOLE, RADESYS='ICRS', A_ORDER=3, A_p_q, B_ORDER=3, B_p_q, AP_ORDER=3, AP_p_q, BP_ORDER=3, BP_p_q (p+q <= 3)`.
- Pixel -> sky: u = x - CRPIX1, v = y - CRPIX2 (1-based FITS pixels); x' = u + A(u,v), y' = v + B(u,v);
  [xi, eta] = CDELT*PC @ [x', y'] (deg); TAN deprojection around CRVAL.
- **A_0_0, A_0_1, A_1_0 (constant and linear SIP terms) exist and are not zero** (A_0_0 ~ -0.37 px). Include every term.
- Sky -> pixel: AP/BP alone is off by up to 0.018 px (median 0.003). That changes the IRSA rounding (below) in about
  0.6 % of images (10 of 1732 tested). **Refine with Newton/fixed-point iteration on the forward A/B model** (to ~1e-8 px),
  as astropy `all_world2pix` does. With the exact inverse, 1924/1924 cutouts match.
- CRPIX is not always 1020.5: images from `l2b_retry-...` folders have e.g. CRPIX = (1023.8, 1135.6).

Alternate WCS 'A' (`CRPIX1A, CRPIX2A, CRVAL1A = CRVAL2A = 0, CDELT = 1, CTYPE = 'LINEAR'`, `WCSNAMEA = '0-based active
pixel coordinates'`): full file CRPIX1A = CRPIX2A = 1, so cutout pixel 1 is detector pixel `1 - CRPIX1A` (0-based).

Alternate WCS 'W' (`CTYPE1W = CTYPE2W = 'WAVE-TAB'`): see "Wavelength".

## Wavelength (WCS 'W', table HDU WCS-WAVE)

Keywords in the image headers: `CRPIX1W=1, CRPIX2W=1, CRVAL1W=1, CRVAL2W=1, CDELT1W=1, CDELT2W=1, CUNIT='um',
PV1_3W=1, PV2_3W=2, PS1_0W='WCS-WAVE', PS1_1W='VALUES', PS1_2W='X', PS2_2W='Y'`.
Table: 1 row, big-endian, columns `X` nJ, `Y` mJ, `VALUES` (2*n*m)E with TDIM (2,n,m). **The grid size depends on the
detector** (read TFORM/TDIM, do not assume 9x9):

| det | n (X) x m (Y) | row bytes | note |
|-----|---------------|-----------|------|
| D1, D6 | 9 x 9 | 720 | X = Y = 1, 256, 511, ..., 2040 |
| D2, D5 | 11 x 11 | 968 | 1, 205, 409, ..., 2040 |
| D3 | 9 x 14 | 1100 | Y has a seam: ..., 140, 141, ... |
| D4 | 13 x 20 | 2212 | Y has a seam: ..., 1800, 1801, ... |

- X, Y = control points in 1-based detector pixels (not uniform; the seams are filter boundaries).
- VALUES in C order = `values[iy][ix][m]` (shape m x n x 2): m=0 central wavelength (um), m=1 bandwidth (um).
- Wavelength at 0-based pixel (x, y): psi_x = CRVAL1W + CDELT1W * (x + 1 - CRPIX1W), same for y (= 1-based detector pixel
  in a full file); find the fractional index of psi_x in X and psi_y in Y (piecewise linear), then bilinear interpolation
  of values[.][.][m]. Matches astropy/wcslib -TAB to 1e-6 um.
- astropy pitfall: `WCS(header, key='W', fobj=hdul)` wrongly applies the celestial SIP terms; delete the A_/B_/AP_/BP_ keys first.
- **The table is the same for all files of one detector** (one `[CALIB] spectral_wcs <id>` HISTORY card per detector in the
  IMAGE header; checked on ~1900 cutouts). `pipeline/wcs_wave_tables.json` holds the 6 tables with their calib_id
  (made with `fetch_region.py --target barnard --collection all --dump-wave-tables pipeline/wcs_wave_tables.json`).
  The browser can use it and skip the tail read; fall back to reading the file's own table if the calib_id is unknown.
- In a file, WCS-WAVE is the last 5760 bytes (header + data block). Without the file size (browser) use `bytes=-5760`
  (preflight) or walk from ZODI past EPSF.

Wavelength range per detector (from the tables): D1 0.74-1.13, D2 1.09-1.67, D3 1.62-2.44, D4 2.40-3.86, D5 3.80-4.44,
D6 4.40-5.03 um. It changes along the detector y axis (linear variable filter): about 0.02-0.06 um across a 117 px region.

## IRSA cutout geometry (`<ibe access_url>?center=ra,dec&size=S`)

Inferred from the cutouts and verified on all 1924 local cutouts of 5 targets:
- (px, py) = 0-based pixel of (ra, dec) in the full image with the **full SIP WCS, exact inverse**.
- Size per axis: `nx = round(S / sx)`, `ny = round(S / sy)`, S in degrees,
  `sx = sqrt(CD1_1^2 + CD2_1^2)`, `sy = sqrt(CD1_2^2 + CD2_2^2)` (CD = CDELT*PC; column norms; no SIP).
  For S = 0.2 this gives 115-119 px, mostly 117 (1805 of 1924), not always 117.
- First pixel: `x0 = round(px - (nx - 1) / 2)`, `y0 = round(py - (ny - 1) / 2)`; round = floor(v + 0.5) (= JS `Math.round`).
- At the border IRSA **clips** (no padding): columns `max(0, x0) .. min(2039, x0 + nx - 1)`, rows likewise.
- Cutout header = the full header with NAXIS1/2 replaced and CRPIX shifted by the clipped (x0, y0):
  `CRPIXn_new = CRPIXn - shift` rounded to 15 significant digits (IRSA writes 692.6, not 692.5999999999999), and every
  alternate `CRPIXn{A,W}` shifted by `CRPIXn - CRPIXn_new` (so CRPIX2A can be -441.9999999999999). Nothing else changes.
  FLAGS becomes a plain int32 IMAGE HDU (Z* keywords and TFIELDS/TTYPE1/TFORM1 dropped; XTENSION, BITPIX, NAXISn, PCOUNT=0, GCOUNT=1).
  EPSF and WCS-WAVE are copied unchanged.

## Request plan (2 round trips, what fetch_region.py does)

Round 1, in parallel:
1. `bytes=0-34559` (12 blocks): PRIMARY + IMAGE header (END is within 25920/28800). WCS, target pixel, rows needed.
2. FLAGS header + descriptor table, guessed: FLAGS starts at 2880 + IMAGE header length + 16,646,400, i.e. at
   16,672,320 or 16,675,200. One range `[16,672,320, 16,708,800)` covers both cases (FLAGS header 17280 + table 16320).
   Verify `XTENSION= 'BINTABLE'` / `EXTNAME = 'FLAGS'` at the real offset; else read it again.
3. (Python only) WCS-WAVE tail `bytes=-5760`. The browser should use `wcs_wave_tables.json` instead.

Round 2, in parallel:
4. IMAGE rows.
5. FLAGS heap for the rows (offsets from the table).
6. ZODI header at the predicted offset `flags_next = flags_data_offset + pad2880(16320 + PCOUNT)`;
   `zodi_hdr = flags_next + 11520 + 16,646,400` (VARIANCE header 11520 + VARIANCE data). Read 11520 bytes and check
   `EXTNAME = 'ZODI'` and header length 11520.
7. ZODI rows at the predicted `zodi_hdr + 11520`, in the same round. If step 6 shows a different layout, read again.
(VARIANCE: header at `flags_next`, rows at `flags_next + 11520`, checked the same way.)

## Cost (measured, 117 x 117 region, cold cache)

| layer | bytes |
|-------|-------|
| IMAGE rows | 117 * 8160 = 954,720 |
| ZODI rows | 954,720 |
| VARIANCE rows (optional) | 954,720 |
| FLAGS descriptors + heap | about 0.45-0.75 MB |
| headers (round 1 + ZODI header) + WCS-WAVE tail | about 90 KB |

IMAGE + FLAGS + ZODI: **2.1-2.7 MB (mean 2.47 MB) and 7 requests per image; about 2.4 s per image** from a home
connection in Turkey (Python, keep-alive, 2 round trips; 4.5 s with the plain sequential header walk).
IMAGE only: about 1.0 MB, 3 requests. Column slicing happens after the download (117 separate 468-byte row pieces
would be 117 requests).
