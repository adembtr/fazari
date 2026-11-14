// On-the-fly spectrum in the browser: the same measurement and output format as
// pipeline/spectrum.py ("fazari-spectrum/1": spectrum.json points / binned / summary and the
// spectrum.csv columns), for the exposures a SkySession has loaded.
//
// Per exposure (SPHEREx sees the source at ONE wavelength in each): the catalogue position moved
// to the exposure time; wavelength and bandwidth at that pixel (WCS-WAVE); forced fit of the
// SPHEREx empirical PSF (EPSF extension, nearest entry on the detector, cubic B-spline as
// scipy.ndimage.map_coordinates) at that fixed position, flux free, constant background, Gaia DR3
// stars within 75" fitted at their fixed positions; 11 x 11 px stamp of IMAGE - ZODI with the
// FLAGS-masked pixels left out, weights from VARIANCE; flux = MJy/sr x pixel solid angle (uJy);
// noise_scale from the same fit at 24 random positions of the same rows; saturated core ->
// "saturated (wing estimate)" from the unsaturated wing pixels, or no estimate.
// Extra bytes per exposure on top of the blink: the 11 stamp rows of IMAGE, FLAGS, VARIANCE and
// ZODI (~0.3 MB from S3) and one EPSF table row (8.8 kB).

import { SpherexFile, readHduAt, flagBits, BLOCK } from "./fits.js";
import { SipWcs, WaveWcs } from "./wcs.js";
import { offsetArcsec, mjdToDate, median, gaussCentroid } from "./astro.js";

export const FORMAT = "fazari-spectrum/1";
export const SPEC = {                     // = pipeline/spectrum.py (and blink.py) constants
  R: 5, edgePx: 6, nbMargin: 2, blendPx: 0.5, nBlank: 24, snrDet: 3.0, nsigUL: 3.0, coreR: 1.5,
  minPsfFrac: 0.5, posCheckSnr: 20.0, posMaxPx: 1.0, wingMinFrac: 0.03, wingMinPix: 12, gaiaNbArcsec: 75.0, binsPerDet: 6, epochCenter: 2026.0,
  detRanges: { D1: [0.75, 1.09], D2: [1.10, 1.62], D3: [1.63, 2.41], D4: [2.42, 3.82], D5: [3.83, 4.41], D6: [4.42, 5.00] },
};
const BITS = { TRANSIENT: 1, OVERFLOW: 2, SUR_ERROR: 4, NONFUNC: 64, DICHROIC: 128, MISSING_DATA: 512, HOT: 1024, COLD: 2048,
               NONLINEAR: 32768, PERSIST: 131072, OUTLIER: 524288, STREAK: 33554432, BLOOM: 67108864, SNOWBALL: 134217728 };
export const COLUMNS = ["season", "date", "mjd", "file", "obs_id", "collection", "detector", "wavelength_um",
  "bandwidth_um", "x_pix", "y_pix", "pos_offset_px", "flux_ujy", "flux_err_ujy", "snr", "ab_mag", "ab_mag_err",
  "upper_limit_ujy", "ab_mag_limit", "status", "method", "saturated", "sat_core_px", "sat_radius_px", "psf_frac_used",
  "n_pix", "chi2r", "noise_scale", "flux_err_var_ujy", "flags_at_target", "flag_names",
  "blended", "pixel_area_arcsec2"];
export const STATUS_LABELS = {
  detection: "detection (S/N ≥ 3)", nondetection: "non-detection (3σ upper limit)",
  saturated_wing: "saturated (wing estimate)", saturated: "saturated (no estimate)",
  flagged: "flagged (bad pixels or source off its predicted position; not binned)", no_fit: "no fit",
};
const METHOD = "Forced fit of the SPHEREx empirical PSF (EPSF extension, nearest entry on the detector) at the "
  + "catalogue position moved to each exposure (proper motion, parallax), flux free, constant background, Gaia DR3 "
  + "field stars fitted at fixed positions; 11x11 native-pixel stamp of IMAGE - ZODI, FLAGS-masked pixels left out, "
  + "weights from VARIANCE. Flux = MJy/sr x pixel solid angle at the target (WCS) -> uJy (total flux of the normalised "
  + "EPSF). Errors from VARIANCE x noise_scale (robust S/N scatter of the same fit at "
  + "24 random positions of the same detector rows, per season and detector, >= 1). Wavelength and bandwidth at the "
  + "target pixel from the spectral WCS (WCS-WAVE). Saturated cores: PSF fitted to the unsaturated wing pixels only "
  + "(saturated_wing, a rough estimate). In-browser engine: only the exposures loaded for the blink (a few per season "
  + "and wavelength bin).";

const g6 = (v, n = 6) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(n)));
const r6 = (v, d) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const abMag = (f) => (f > 0 ? 23.9 - 2.5 * Math.log10(f) : null);
function robustSigma(a) {
  const v = a.filter(Number.isFinite);
  if (!v.length) return NaN;
  const m = median(v);
  return 1.4826 * median(v.map((x) => Math.abs(x - m)));
}

// ---- EPSF: one table row, cubic B-spline (scipy spline_filter mode="mirror" + map_coordinates order 3)
function splineFilter1d(c, n, stride, off) {
  const z = Math.sqrt(3) - 2;
  for (let k = 0; k < n; k++) c[off + k * stride] *= 6;
  // causal init, mirror boundary (Unser / scipy _init_causal_mirror)
  const zn = z ** (n - 1);
  let sum = c[off] + zn * c[off + (n - 1) * stride];
  const z2n = zn * zn;
  let zk = z;
  for (let k = 1; k < n - 1; k++) { sum += (zk + z2n / zk) * c[off + k * stride]; zk *= z; }
  c[off] = sum / (1 - z2n);
  for (let k = 1; k < n; k++) c[off + k * stride] += z * c[off + (k - 1) * stride];
  c[off + (n - 1) * stride] = (z / (z * z - 1)) * (c[off + (n - 1) * stride] + z * c[off + (n - 2) * stride]);
  for (let k = n - 2; k >= 0; k--) c[off + k * stride] = z * (c[off + (k + 1) * stride] - c[off + k * stride]);
}
export function prepPsf(psf, n) {
  const c = Float64Array.from(psf);
  for (let j = 0; j < n; j++) splineFilter1d(c, n, 1, j * n);     // along x (fast axis)
  for (let i = 0; i < n; i++) splineFilter1d(c, n, n, i);         // along y
  return { c, n };
}
function bsw(t) {   // cubic B-spline weights for the 4 coefficients floor(u)-1 .. floor(u)+2
  const t2 = t * t, t3 = t2 * t;
  return [(1 - t) ** 3 / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6];
}
const mirror = (i, n) => { if (n === 1) return 0; const p = 2 * (n - 1); i = ((i % p) + p) % p; return i < n ? i : p - i; };
/** Spline value at (u, v) (oversampled pixel coordinates, u along x); 0 outside the table. */
function psfAt(P, u, v) {
  const n = P.n;
  if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return 0;
  const iu = Math.floor(u), iv = Math.floor(v);
  const wu = bsw(u - iu), wv = bsw(v - iv);
  let s = 0;
  for (let b = 0; b < 4; b++) {
    const row = mirror(iv - 1 + b, n) * n;
    let r = 0;
    for (let a = 0; a < 4; a++) r += wu[a] * P.c[row + mirror(iu - 1 + a, n)];
    s += wv[b] * r;
  }
  return s;
}
/** EPSF on the (2R+1)^2 stamp for a source at offset (dx, dy) from the centre pixel (= blink.epsf_kernels). */
export function epsfKernel(P, ovs, dx, dy, R = SPEC.R) {
  const c = (P.n - 1) / 2, out = new Float64Array((2 * R + 1) ** 2);
  let k = 0;
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) out[k++] = psfAt(P, c + ovs * (x - dx), c + ovs * (y - dy)) * ovs * ovs;
  return out;
}

function tformInfo(h) {
  const size = { L: 1, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8 };
  const cols = {};
  let off = 0;
  for (let i = 1; i <= h.num("TFIELDS"); i++) {
    const m = /^\s*(\d*)([LBIJKAED])/.exec(h.str(`TFORM${i}`));
    const rep = m && m[1] ? Number(m[1]) : 1;
    cols[h.str(`TTYPE${i}`)] = { off, code: m ? m[2] : "?", rep };
    off += rep * (m ? size[m[2]] : 0);
  }
  return cols;
}
const epsfGrid = new Map();       // "D3|451" -> {nbx, nby, x0, dx, y0, dy}
/** The EPSF table row nearest to detector pixel (X, Y): {psf (prefiltered), ovs, row, xc, yc}. */
async function epsfRow(f, X, Y, det) {
  await f.openLayers();
  const hdu = await readHduAt(f.src, f.zodi.nextOffset, 2 * BLOCK);
  if (hdu.name !== "EPSF") throw new Error(`expected EPSF after ZODI, found ${hdu.name}`);
  const hh = hdu.header, cols = tformInfo(hh), rowLen = hh.num("NAXIS1"), nrow = hh.num("NAXIS2");
  const ovs = hh.num("OVSMPX", 5);
  const rd = async (r0, r1) => {
    const b = await f.src.read(hdu.dataOffset + r0 * rowLen, hdu.dataOffset + (r1 + 1) * rowLen);
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  };
  const f32 = (dv, r, name) => dv.getFloat32(r * rowLen + cols[name].off, false);
  const key = `${det}|${nrow}`;
  let G = epsfGrid.get(key);
  if (!G) {                                 // uniform tiling, x fast then y (EPSF header ORDERING)
    const dv = await rd(0, 1);
    // tile centres at (k + 0.5) * size - 0.5 (0-based detector pixels)
    const x0 = f32(dv, 0, "XCENTER"), dx = f32(dv, 1, "XCENTER") - x0, y0 = f32(dv, 0, "YCENTER");
    const nbx = Math.max(1, Math.round(2 * (x0 + 0.5) / dx));
    G = { nbx, nby: Math.max(1, Math.round(nrow / nbx)), x0, dx, y0, dy: 2 * (y0 + 0.5) };
    epsfGrid.set(key, G);
  }
  const cl = (v, n) => Math.max(0, Math.min(n - 1, v));
  let row = cl(Math.round((Y - G.y0) / G.dy), G.nby) * G.nbx + cl(Math.round((X - G.x0) / G.dx), G.nbx);
  let dv = await rd(row, row);
  let xc = f32(dv, 0, "XCENTER"), yc = f32(dv, 0, "YCENTER");
  if (Math.abs(xc - X) > G.dx / 2 + 1 || Math.abs(yc - Y) > G.dy / 2 + 1) {
    // not the uniform tiling assumed: read the centre columns of every row (whole table, rare)
    const all = await rd(0, nrow - 1);
    let best = Infinity;
    for (let r = 0; r < nrow; r++) {
      const d = (f32(all, r, "XCENTER") - X) ** 2 + (f32(all, r, "YCENTER") - Y) ** 2;
      if (d < best) { best = d; row = r; }
    }
    dv = await rd(row, row);
    xc = f32(dv, 0, "XCENTER"); yc = f32(dv, 0, "YCENTER");
  }
  const ec = cols.EPSF, n = Math.round(Math.sqrt(ec.rep));
  const psf = new Float64Array(ec.rep);
  for (let k = 0; k < ec.rep; k++) psf[k] = ec.code === "D" ? dv.getFloat64(ec.off + 8 * k, false) : dv.getFloat32(ec.off + 4 * k, false);
  return { P: prepPsf(psf, n), ovs, row, xc, yc };
}

// ---- forced photometry -----------------------------------------------------------------------
function solveSym(A, b) {     // small dense Gauss-Jordan (normal equations); returns {x, inv00} or null
  const n = b.length, M = A.map((r, i) => [...r, b[i], ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let k = c; k < M[c].length; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c || !M[r][c]) continue;
      const f = M[r][c];
      for (let k = c; k < M[r].length; k++) M[r][k] -= f * M[c][k];
    }
  }
  return { x: M.map((r) => r[n]), inv00: M[0][n + 1] };
}

/** Forced EPSF fit at (x0, y0) on strip data (rows y0s.., width W): {flux, err, chi2r, blended, psfFrac, nPix} or null.
 * S = {clean, var (Infinity = unusable), good (Uint8), extraBad?, W, H, ys}; nb = neighbour pixel positions. */
export function fitPsf(S, E, x0, y0, nb = [], { extraBad = null, R = SPEC.R } = {}) {
  const ix = Math.round(x0), iy = Math.round(y0);
  const j0 = iy - R - S.ys;
  if (ix < R || ix >= S.W - R || j0 < 0 || j0 + 2 * R >= S.H) return null;
  const n = (2 * R + 1) ** 2;
  const d = new Float64Array(n), w = new Float64Array(n), g = new Uint8Array(n);
  let k = 0;
  for (let j = 0; j <= 2 * R; j++) for (let i = -R; i <= R; i++, k++) {
    const q = (j0 + j) * S.W + ix + i;
    d[k] = S.clean[q]; w[k] = 1 / Math.sqrt(S.var[q]);
    g[k] = S.good[q] && !(extraBad && extraBad[q]) ? 1 : 0;
  }
  const cols = [epsfKernel(E.P, E.ovs, x0 - ix, y0 - iy, R)];
  let blended = false;
  for (const [nx, ny] of nb) {
    if (Math.abs(nx - ix) > R + SPEC.nbMargin || Math.abs(ny - iy) > R + SPEC.nbMargin) continue;
    if (Math.hypot(nx - x0, ny - y0) < SPEC.blendPx) { blended = true; continue; }
    cols.push(epsfKernel(E.P, E.ovs, nx - ix, ny - iy, R));
  }
  cols.push(new Float64Array(n).fill(1));
  const m = cols.length;
  let nGood = 0, psfFrac = 0;
  for (let q = 0; q < n; q++) if (g[q]) { nGood++; psfFrac += cols[0][q]; }
  if (nGood < m + 3) return null;
  const A = Array.from({ length: m }, () => new Array(m).fill(0)), bv = new Array(m).fill(0);
  for (let q = 0; q < n; q++) {
    if (!g[q]) continue;
    const wq = w[q] * w[q];
    for (let a = 0; a < m; a++) {
      bv[a] += cols[a][q] * d[q] * wq;
      for (let b = a; b < m; b++) A[a][b] += cols[a][q] * cols[b][q] * wq;
    }
  }
  for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
  const s = solveSym(A, bv);
  if (!s) return null;
  let chi = 0;
  for (let q = 0; q < n; q++) {
    if (!g[q]) continue;
    let mod = 0;
    for (let a = 0; a < m; a++) mod += s.x[a] * cols[a][q];
    chi += ((d[q] - mod) * w[q]) ** 2;
  }
  return { flux: s.x[0], err: Math.sqrt(Math.max(s.inv00, 0)), chi2r: chi / Math.max(nGood - m, 1), blended, psfFrac, nPix: nGood };
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

/**
 * Measure the source in one SPHEREx file.
 * @param f        SpherexFile (opened or not); works on S3 files (net.js source) and local cutouts (tests)
 * @param posAt    mjd -> [ra, dec] of the source (with parallax)
 * @param o.nbSky  [{ra, dec, pmra, pmdec}] fixed-position neighbours (Gaia DR3 at 2016.0; catalogue: pm 0)
 * @param o.meta   {file, obs_id, collection, season}
 * Returns an info object (rows via finishRows/toRow), or {inside: false}.
 */
export async function measureFile(f, posAt, { nbSky = [], meta = {} } = {}) {
  if (!f.header) await f.open();
  const h = f.header, wcs = new SipWcs(h);
  const nx = h.num("NAXIS1"), ny = h.num("NAXIS2");
  const mjd = h.num("MJD-AVG", h.num("MJD-OBS"));
  const [ra, dec] = posAt(mjd);
  const [x, y] = wcs.skyToPix(ra, dec);
  const e = SPEC.edgePx, R = SPEC.R;
  const info = { file: meta.file || "", obs_id: meta.obs_id || "", collection: meta.collection || "", season: meta.season || "",
                 mjd, date: mjdToDate(mjd), detector: `D${h.num("DETECTOR")}`, x, y, ra_pred: ra, dec_pred: dec,
                 inside: x >= e && x <= nx - 1 - e && y >= e && y <= ny - 1 - e };
  if (!info.inside) return info;
  [info.wavelength_um, info.bandwidth_um] = new WaveWcs(h, f.waveTable).at(x, y);
  // stamp rows of the four layers
  await f.openLayers();
  const ys = Math.max(0, Math.round(y) - R), ye = Math.min(ny - 1, Math.round(y) + R);
  const varHdu = await readHduAt(f.src, f.flags.nextOffset, 4 * BLOCK);
  if (varHdu.name !== "VARIANCE") throw new Error(`expected VARIANCE after FLAGS, found ${varHdu.name}`);
  const det_off = [1 - h.num("CRPIX1A", 1), 1 - h.num("CRPIX2A", 1)];
  const [reg, vr, E] = await Promise.all([
    f.readRegion(ys, ye), f.readFloatRows(varHdu, ys, ye),
    epsfRow(f, x + det_off[0], y + det_off[1], info.detector),
  ]);
  const W = reg.nx, H = ye - ys + 1, N = W * H;
  const b = { ...BITS, ...flagBits(f.flags.header) };
  const SAT = b.OVERFLOW | b.SUR_ERROR | b.NONLINEAR;
  const BAD = b.TRANSIENT | b.NONFUNC | b.MISSING_DATA | b.HOT | b.COLD | b.PERSIST | b.OUTLIER | b.STREAK | b.SNOWBALL;
  const DEFECT = b.NONFUNC | b.HOT | b.COLD | b.MISSING_DATA;
  const S = { clean: new Float64Array(N), var: new Float64Array(N), good: new Uint8Array(N), over: new Uint8Array(N),
              unus: new Uint8Array(N), bloom: new Uint8Array(N), W, H, ys };
  for (let q = 0; q < N; q++) {
    const fl = reg.flags[q], img = reg.image[q], sat = (fl & SAT) !== 0, bad = (fl & BAD) !== 0 && !sat;
    const c = bad ? NaN : img - reg.zodi[q];
    const v = vr[q];
    const good = !bad && !sat && Number.isFinite(c) && Number.isFinite(v) && v > 0;
    S.clean[q] = c; S.good[q] = good ? 1 : 0; S.var[q] = good ? v : Infinity;
    S.over[q] = ((fl & b.OVERFLOW) || !Number.isFinite(img)) && !(fl & DEFECT) ? 1 : 0;
    S.unus[q] = ((fl & SAT) || !Number.isFinite(img)) && !(fl & DEFECT) ? 1 : 0;      // for the saturated radius
    S.bloom[q] = (fl & b.BLOOM) ? 1 : 0;
  }
  const ix = Math.round(x), iy = Math.round(y);
  info.flags_at_target = reg.flags[(iy - ys) * W + ix];
  let ncore = 0;
  for (let j = 0; j < H; j++) for (let i = Math.max(0, ix - 2); i <= Math.min(W - 1, ix + 2); i++) {
    if (Math.hypot(i - x, j + ys - y) <= SPEC.coreR && S.over[j * W + i]) ncore++;
  }
  info.sat_core_px = ncore;
  info.saturated = ncore > 0;
  // pixel solid angle at the target
  const [r0, d0] = wcs.pixToSky(x, y), [r1, d1] = wcs.pixToSky(x + 1, y), [r2, d2] = wcs.pixToSky(x, y + 1);
  const jx = offsetArcsec(r0, d0, r1, d1), jy = offsetArcsec(r0, d0, r2, d2);
  info.pixel_area_arcsec2 = Math.abs(jx[0] * jy[1] - jx[1] * jy[0]);
  const toUjy = 1e12 * info.pixel_area_arcsec2 / 206264.806 ** 2;
  // neighbours (= blink.neighbour_pixels): moved to the exposure epoch; a Gaia star within 2" of the
  // source is the source itself, one within 1.5" of a catalogue neighbour is that neighbour
  const dt = (mjd - 51544.5) / 365.25 + 2000 - 2016;
  const cat = nbSky.filter((s) => !s.gaia).map((s) => [s.ra, s.dec]);
  const sky = cat.slice();
  for (const s of nbSky) {
    if (!s.gaia) continue;
    const cd = Math.cos(s.dec * Math.PI / 180);
    const a = s.ra + (s.pmra || 0) * dt / 3.6e6 / cd, dd = s.dec + (s.pmdec || 0) * dt / 3.6e6;
    if (offsetArcsec(a, dd, ra, dec)[2] < 2.0) continue;
    if (cat.some(([ca, cdd]) => offsetArcsec(a, dd, ca, cdd)[2] < 1.5)) continue;
    sky.push([a, dd]);
  }
  const nb = sky.map(([a, dd]) => wcs.skyToPix(a, dd));
  let r, method = "psf", status;
  if (info.saturated) {
    r = fitPsf(S, E, x, y, nb, { extraBad: S.bloom });
    info.sat_radius_px = satRadius(S, x, y);
    method = "psf_wing";
    status = r && r.err > 0 && r.flux > 0 && r.psfFrac >= SPEC.wingMinFrac && r.nPix >= SPEC.wingMinPix ? "saturated_wing" : "saturated";
  } else {
    r = fitPsf(S, E, x, y, nb);
    status = !r || !(r.err > 0) ? "no_fit" : r.psfFrac < SPEC.minPsfFrac ? "flagged" : "measured";
  }
  // position check (= spectrum.py): a bright or saturated source must sit at the predicted position
  if (info.saturated || (r && r.err > 0 && r.flux >= SPEC.posCheckSnr * r.err)) {
    const v = []; for (let q = 0; q < N; q++) if (S.good[q]) v.push(S.clean[q]);
    const sig0 = robustSigma(v) || 0.05;
    const c = gaussCentroid(S.clean, W, H, (i2, j2) => S.good[j2 * W + i2] === 1, x, y - ys, sig0);
    if (c) {
      info.pos_offset_px = Math.hypot(c.x - x, c.y + ys - y);
      if (info.pos_offset_px > SPEC.posMaxPx && (status === "measured" || status === "saturated_wing")) status = "flagged";
    }
  }
  info.status = status;
  info.method = status === "saturated" || status === "no_fit" ? "" : method;
  if (r && r.err > 0 && status !== "saturated") {
    Object.assign(info, { flux_ujy: r.flux * toUjy, flux_err_var_ujy: r.err * toUjy, chi2r: r.chi2r, blended: r.blended,
                          psf_frac_used: r.psfFrac, n_pix: r.nPix });
  } else if (r) Object.assign(info, { psf_frac_used: r.psfFrac, n_pix: r.nPix });
  if (!info.saturated) {               // noise reference: the same fit at random positions of these rows
    const rnd = mulberry32(hashStr(info.file || String(mjd)));
    const out = [];
    for (let tries = 0; out.length < SPEC.nBlank && tries < 4 * SPEC.nBlank; tries++) {
      const bx = R + rnd() * (W - 1 - 2 * R);
      if (Math.abs(bx - x) < 3) continue;
      const q = fitPsf(S, E, bx, y);
      if (q && q.err > 0 && q.nPix >= 0.6 * (2 * R + 1) ** 2) out.push(q.flux / q.err);
    }
    info._blank = out;
  }
  info.epsf_row = E.row;
  return info;
}

/** Radius of the connected saturated region touching the core (capped by the stamp rows). */
function satRadius(S, x, y) {
  const { W, H, ys } = S, seen = new Uint8Array(W * H), st = [];
  for (let j = 0; j < H; j++) for (let i = Math.max(0, Math.round(x) - 2); i <= Math.min(W - 1, Math.round(x) + 2); i++) {
    const q = j * W + i;
    if (S.unus[q] && Math.hypot(i - x, j + ys - y) <= SPEC.coreR) { seen[q] = 1; st.push(q); }
  }
  let rmax = -1;
  while (st.length) {
    const q = st.pop(), i = q % W, j = (q / W) | 0;
    rmax = Math.max(rmax, Math.hypot(i - x, j + ys - y));
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
      const p = jj * W + ii;
      if (S.unus[p] && !seen[p]) { seen[p] = 1; st.push(p); }
    }
  }
  return rmax < 0 ? 0 : rmax + 0.5;
}

// ---- rows, bins, summary (= pipeline/spectrum.py finish_rows / binned / summary / build) ----------
export function finishRows(infos) {
  const cells = new Map();
  for (const i of infos) {
    const k = `${i.season}|${i.detector}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(...(i._blank || []));
  }
  for (const i of infos) {
    const s = robustSigma(cells.get(`${i.season}|${i.detector}`) || []);
    i.noise_scale = Number.isFinite(s) ? Math.max(1, s) : 1;
    if (i.flux_ujy == null) continue;
    i.flux_err_ujy = i.flux_err_var_ujy * i.noise_scale;
    i.snr = i.flux_ujy / i.flux_err_ujy;
    if (i.status === "measured") i.status = i.snr >= SPEC.snrDet ? "detection" : "nondetection";
    if (i.status === "nondetection") {
      i.upper_limit_ujy = Math.max(i.flux_ujy, 0) + SPEC.nsigUL * i.flux_err_ujy;
      i.ab_mag_limit = abMag(i.upper_limit_ujy);
    } else if (i.flux_ujy > 0) {
      i.ab_mag = abMag(i.flux_ujy);
      i.ab_mag_err = 1.0857 * i.flux_err_ujy / i.flux_ujy;
    }
  }
}

const FLAG_NAMES = Object.entries(BITS).sort((a, b) => a[1] - b[1]);
export function toRow(i) {
  const fl = i.flags_at_target;
  return {
    season: i.season || "", date: i.date, mjd: r6(i.mjd, 6), file: i.file, obs_id: i.obs_id, collection: i.collection,
    detector: i.detector, wavelength_um: r6(i.wavelength_um, 5), bandwidth_um: r6(i.bandwidth_um, 5),
    x_pix: r6(i.x, 3), y_pix: r6(i.y, 3), pos_offset_px: g6(i.pos_offset_px, 3), flux_ujy: g6(i.flux_ujy), flux_err_ujy: g6(i.flux_err_ujy), snr: g6(i.snr, 4),
    ab_mag: g6(i.ab_mag, 5), ab_mag_err: g6(i.ab_mag_err, 3), upper_limit_ujy: g6(i.upper_limit_ujy), ab_mag_limit: g6(i.ab_mag_limit, 5),
    status: i.status, method: i.method || "", saturated: !!i.saturated, sat_core_px: i.sat_core_px, sat_radius_px: g6(i.sat_radius_px, 3),
    psf_frac_used: g6(i.psf_frac_used, 3), n_pix: i.n_pix ?? null, chi2r: g6(i.chi2r, 4), noise_scale: g6(i.noise_scale, 3),
    flux_err_var_ujy: g6(i.flux_err_var_ujy), flags_at_target: fl,
    flag_names: FLAG_NAMES.filter(([, v]) => fl >= 0 && (fl & v)).map(([n]) => n).join("|"),
    blended: !!i.blended, pixel_area_arcsec2: g6(i.pixel_area_arcsec2, 5),
  };
}

function detBins(det) {
  const [lo, hi] = SPEC.detRanges[det], n = SPEC.binsPerDet, e = [];
  for (let k = 0; k <= n; k++) e.push(Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * k / n));
  return e.slice(0, -1).map((a, k) => [a, e[k + 1]]);
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

export function binned(rows) {
  const out = [];
  const seasons = [...new Set(rows.map((r) => r.season).filter(Boolean))].sort();
  for (const s of seasons) {
    for (const det of Object.keys(SPEC.detRanges)) {
      const rs = rows.filter((r) => r.season === s && r.detector === det);
      if (!rs.length) continue;
      const edges = detBins(det);
      edges.forEach(([lo, hi], k) => {
        const sel = rs.filter((r) => (r.wavelength_um >= lo && r.wavelength_um < hi) || (k === 0 && r.wavelength_um < lo)
          || (k === edges.length - 1 && r.wavelength_um >= hi));
        if (!sel.length) return;
        const meas = sel.filter((r) => r.status === "detection" || r.status === "nondetection");
        const wing = sel.filter((r) => r.status === "saturated_wing");
        const e = { season: s, detector: det, lam_lo_um: g6(lo, 4), lam_hi_um: g6(hi, 4), n: 0, n_saturated: sel.filter((r) => r.saturated).length };
        if (meas.length) {
          const w = meas.map((r) => 1 / r.flux_err_ujy ** 2), sw = w.reduce((a, b) => a + b, 0);
          const m = meas.reduce((a, r, k2) => a + w[k2] * r.flux_ujy, 0) / sw;
          let err = 1 / Math.sqrt(sw);
          const chi = meas.length > 1 ? meas.reduce((a, r, k2) => a + w[k2] * (r.flux_ujy - m) ** 2, 0) / (meas.length - 1) : 1;
          err *= Math.sqrt(Math.max(1, chi));
          const snr = m / err;
          Object.assign(e, { kind: "measured", n: meas.length, wavelength_um: g6(mean(meas.map((r) => r.wavelength_um)), 5),
                             flux_ujy: g6(m), flux_err_ujy: g6(err), snr: g6(snr, 4), chi2r: g6(chi, 4), detected: snr >= SPEC.snrDet });
          if (snr >= SPEC.snrDet) Object.assign(e, { ab_mag: g6(abMag(m), 5), ab_mag_err: g6(1.0857 / snr, 3) });
          else {
            const ul = Math.max(m, 0) + SPEC.nsigUL * err;
            Object.assign(e, { upper_limit_ujy: g6(ul), ab_mag_limit: g6(abMag(ul), 5) });
          }
        } else if (wing.length) {
          const f = wing.map((r) => r.flux_ujy), m = median(f);
          let err = f.length >= 3 ? 1.2533 * robustSigma(f) / Math.sqrt(f.length)
            : f.length === 2 ? Math.abs(f[0] - f[1]) / Math.SQRT2 / Math.SQRT2 : wing[0].flux_err_ujy;
          err = Math.max(err, median(wing.map((r) => r.flux_err_ujy)) / Math.sqrt(f.length));
          Object.assign(e, { kind: "saturated_wing", n: wing.length, wavelength_um: g6(mean(wing.map((r) => r.wavelength_um)), 5),
                             flux_ujy: g6(m), flux_err_ujy: g6(err), snr: err > 0 ? g6(m / err, 4) : null, detected: true,
                             ab_mag: g6(abMag(m), 5), ab_mag_err: m > 0 ? g6(1.0857 * err / m, 3) : null });
        } else {
          Object.assign(e, { kind: "none", wavelength_um: g6(mean(sel.map((r) => r.wavelength_um)), 5) });
        }
        out.push(e);
      });
    }
  }
  return out;
}

export function summary(rows, bins, nOutside) {
  const seasons = [...new Set(rows.map((r) => r.season).filter(Boolean))].sort();
  const cnt = (rs, st) => rs.filter((r) => r.status === st).length;
  const per = seasons.map((s) => {
    const rs = rows.filter((r) => r.season === s);
    return { season: s, n: rs.length, n_detection: cnt(rs, "detection"), n_nondetection: cnt(rs, "nondetection"),
             n_saturated: rs.filter((r) => r.saturated).length, n_saturated_wing: cnt(rs, "saturated_wing"),
             n_flagged: cnt(rs, "flagged") + cnt(rs, "no_fit"),
             lam_min_um: g6(Math.min(...rs.map((r) => r.wavelength_um)), 4), lam_max_um: g6(Math.max(...rs.map((r) => r.wavelength_um)), 4) };
  });
  const det = bins.filter((b) => b.kind === "measured" && b.detected);
  const sat = rows.filter((r) => r.saturated);
  const byDet = {};
  for (const r of rows) { const d = (byDet[r.detector] ||= { n: 0, saturated: 0 }); d.n++; d.saturated += r.saturated ? 1 : 0; }
  return {
    n_exposures: rows.length, n_outside: nOutside, seasons: per,
    n_detection: cnt(rows, "detection"), n_nondetection: cnt(rows, "nondetection"), n_saturated: sat.length,
    n_saturated_wing: cnt(rows, "saturated_wing"), n_flagged: cnt(rows, "flagged") + cnt(rows, "no_fit"),
    saturated_by_detector: Object.fromEntries(Object.entries(byDet).sort()),
    saturated_range_um: sat.length ? [g6(Math.min(...sat.map((r) => r.wavelength_um)), 4), g6(Math.max(...sat.map((r) => r.wavelength_um)), 4)] : null,
    detected_range_um: det.length ? [Math.min(...det.map((b) => b.lam_lo_um)), Math.max(...det.map((b) => b.lam_hi_um))] : null,
    detected_detectors: [...new Set(det.map((b) => b.detector))].sort(),
    n_bins_detected: det.length, n_bins_measured: bins.filter((b) => b.kind === "measured").length,
  };
}

export function build({ target, ra, dec, rows, nOutside = 0, extra = {} }) {
  rows = rows.slice().sort((a, b) => (a.season < b.season ? -1 : a.season > b.season ? 1 : 0) || a.wavelength_um - b.wavelength_um || a.mjd - b.mjd);
  const bins = binned(rows);
  return {
    format: FORMAT, engine: "browser", target, ra, dec, generated: new Date().toISOString().slice(0, 19) + "Z",
    units: { flux: "uJy", wavelength: "um", ab_mag: "AB = 23.9 - 2.5 log10(flux/uJy)" },
    seasons: [...new Set(rows.map((r) => r.season).filter(Boolean))].sort(),
    method: METHOD, status_labels: STATUS_LABELS,
    parameters: { snr_detection: SPEC.snrDet, upper_limit_sigma: SPEC.nsigUL, stamp_px: 2 * SPEC.R + 1,
                  position_check_snr: SPEC.posCheckSnr, position_max_offset_px: SPEC.posMaxPx, core_radius_px: SPEC.coreR,
                  min_psf_frac: SPEC.minPsfFrac, wing_min_psf_frac: SPEC.wingMinFrac, bins_per_detector: SPEC.binsPerDet,
                  detector_ranges_um: SPEC.detRanges },
    caveats: ["Flux check: two unsaturated Gaia field stars (eps_indi_b cutouts) agree with 2MASS J/H/Ks and AllWISE W1/W2 to 0.93-1.06 (mean ratio 1.00).",
              "Saturated points (saturated_wing) come from the PSF wings only. On unsaturated stars with the core masked, the estimate recovers 0.88 +- 0.12 of the flux for a 1.5 px core and 0.60 +- 0.19 for a 2 px core; larger saturated cores can be off by a factor of 2. They are never plotted as normal points.",
              "Each exposure sees the source through a narrow band (bandwidth_um) at one time: a variable source mixes time and wavelength within a season.",
              "In-browser engine: only the exposures loaded for the blink (a few per season close to each bin centre)."],
    summary: summary(rows, bins, nOutside), columns: COLUMNS, points: rows, binned: bins, ...extra,
  };
}

/** spectrum.csv text (the columns of pipeline/spectrum.py; booleans as Python writes them). */
export function toCsv(spec) {
  const cell = (v) => (v == null ? "" : v === true ? "True" : v === false ? "False"
    : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [COLUMNS.join(","), ...spec.points.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/**
 * Spectrum of a SkySession's source from the exposures it has processed (all loaded bins).
 * Gaia DR3 neighbours come from the session's cached Gaia query (gaia.js).
 */
export async function spectrumForSession(session, { onProgress = () => {}, limit = 4 } = {}) {
  const [{ SpherexFile: SF }, { s3Source, mapLimit }, { gaiaStars }, { CALIB }] = await Promise.all([
    import("./fits.js"), import("./net.js"), import("./gaia.js"), import("./calib.js")]);
  const seen = new Set();
  const list = session.exposures.filter((e) => e.img && e.img.url && !seen.has(e.img.url) && seen.add(e.img.url));
  let nbSky = [];
  try {
    const stars = await gaiaStars(session.ra0, session.dec0, CALIB.maxFieldRadius + 0.01, { gmax: CALIB.gmaxQuery, signal: session.signal });
    const cd = Math.cos(session.dec0 * Math.PI / 180);
    nbSky = stars.filter((s) => Math.hypot((s.ra - session.ra0) * cd, s.dec - session.dec0) * 3600 < SPEC.gaiaNbArcsec)
      .map((s) => ({ ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, gaia: true }));
  } catch (_) { /* no neighbours */ }
  let done = 0;
  const infos = (await mapLimit(list, limit, async (ex) => {
    try {
      const f = new SF(s3Source(ex.img.url, { signal: session.signal }));
      const i = await measureFile(f, (mjd) => session.posAt(mjd), {
        nbSky, meta: { file: ex.img.url.split("/").pop(), obs_id: ex.img.obs_id, collection: ex.img.collection, season: ex.season } });
      return i;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return null;
    } finally { onProgress({ done: ++done, total: list.length }); }
  })).filter(Boolean);
  const inside = infos.filter((i) => i.inside && Number.isFinite(i.wavelength_um));
  finishRows(inside);
  const t = session.target;
  return build({ target: t ? t.name : `RA ${session.ra0.toFixed(5)} Dec ${session.dec0.toFixed(5)}`, ra: session.ra0, dec: session.dec0,
                 rows: inside.map(toRow), nOutside: infos.length - inside.length,
                 extra: { neighbours: { gaia_dr3: nbSky.length, catalogue: 0 }, n_files: list.length } });
}
