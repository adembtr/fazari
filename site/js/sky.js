// Blink pipeline in the browser (same method as pipeline/blink.py, with the fixes noted below):
//  1. images covering the point (sky index) -> observing seasons (gap > 30 days)
//  2. wavelength bins, each from ONE detector (blink.py's +-6 % bins mixed D4+D5 at 4.0 um and
//     D5+D6 at 4.6 um; not here), exposure kept if the wavelength AT THE TARGET is within the
//     tolerance; at most `cap` exposures per season and bin (closest to the bin centre first)
//  3. per exposure: IMAGE - ZODI, bad FLAGS masked, bilinear reprojection onto one north-up
//     TAN grid centred on the target; per season the median; one asinh stretch per bin
//  4. centroid of the target per exposure (Gaussian on the unsaturated wings, native pixels),
//     season means, shift first -> last season vs the catalogue (Gaia) prediction.

import { SpherexFile, flagBits } from "./fits.js";
import { SipWcs, WaveWcs, TanGrid } from "./wcs.js";
import { s3Source } from "./net.js";
import { gaiaStars, tychoStars } from "./gaia.js";
import { CALIB, prepareStars, calibrateExposure, calibrateSaturated, poolCells, fieldStarTable } from "./calib.js";
import { propagate, offsetArcsec, mjdToDate, mjdToMonth, median, percentile, gaussCentroid, jyearToMjd } from "./astro.js";

export const CONFIG = {
  pixArcsec: 3.0,          // output grid (half the native 6.15" pixel)
  fovDeg: 0.15,            // 180 x 180 output pixels
  gapDays: 30,             // gap that separates observing seasons
  // bin centre (um) -> the one detector whose band contains it (checked against the index)
  bins: [[1.0, 1], [1.5, 2], [2.0, 3], [3.0, 4], [4.0, 5], [4.6, 6]],
  tol: 0.06,               // |lambda_target / centre - 1| <= tol (as blink.py)
  prefilter: 0.03,         // extra margin for the index's approximate wavelength
  cap: 4,                  // exposures per season and bin (downloads ~2.5 MB each)
  minSeasons: 2,
  edgePx: 6,               // target this far from the detector edge
  epochCenter: 2026.0,     // grid centre = target at 2026.0 (proper motion only), as blink.py
  calibrate: true,         // relative astrometry against Gaia DR3 field stars (calib.js)
  brightRadius: 3.0,       // deg: Tycho-2 stars for saturated targets (the rows span the detector)
  brightVmax: 10.5,
  satCal: true,            // saturated target: calibrate with saturated Tycho-2 stars
  satMaskMatch: false,
  satMinRefs: 10,          // saturated reference stars per detector for a bias estimate
  // FLAGS: masked (set to NaN). SOURCE and OUTLIER are NOT masked (they mark real stars).
  badFlags: ["TRANSIENT", "SUR_ERROR", "NONFUNC", "HOT", "COLD", "MISSING_DATA"],
  // saturated star core: drawn white (as blink.py), excluded from the centroid fit
  satFlags: ["OVERFLOW", "SUR_ERROR", "NONLINEAR"],
};

const DEFAULT_BITS = { TRANSIENT: 1, OVERFLOW: 2, SUR_ERROR: 4, NONFUNC: 64, MISSING_DATA: 512, HOT: 1024, COLD: 2048, NONLINEAR: 32768 };
const NDET = 2040;

/** Group dates into seasons separated by > gapDays. Returns [{label, mjd0, mjd1, mjdMid}]. */
export function splitSeasons(mjds, gapDays = CONFIG.gapDays) {
  const s = [...new Set(mjds)].sort((a, b) => a - b);
  const groups = [];
  for (const m of s) {
    const g = groups[groups.length - 1];
    if (g && m - g[g.length - 1] <= gapDays) g.push(m); else groups.push([m]);
  }
  return groups.map((g) => ({ label: mjdToMonth(median(g)), mjd0: g[0], mjd1: g[g.length - 1], mjdMid: median(g) }));
}

function seasonOf(seasons, mjd) {
  return seasons.find((s) => mjd >= s.mjd0 - 1e-6 && mjd <= s.mjd1 + 1e-6) || null;
}

/** For each bin centre, the detector whose band (median lam_min..lam_max in the index) holds it. */
function binDetectors(images) {
  const band = {};
  for (const d of [1, 2, 3, 4, 5, 6]) {
    const im = images.filter((i) => i.detector === d);
    if (im.length) band[d] = [median(im.map((i) => i.lam_min_um)), median(im.map((i) => i.lam_max_um))];
  }
  return CONFIG.bins.map(([c, d0]) => {
    let best = d0, score = -Infinity;
    for (const [d, [lo, hi]] of Object.entries(band)) {
      const sc = Math.min(Math.log(c / lo), Math.log(hi / c));   // distance to the band edges
      if (sc > score) { score = sc; best = Number(d); }
    }
    return { um: c, det: score > 0 ? best : d0 };
  });
}

export class SkySession {
  /**
   * @param o.ra, o.dec  position (deg); for a target with proper motion: its position at 2026.0
   * @param o.target     {name, ra, dec, epoch, pmra, pmdec, plx} or null (fixed point)
   * @param o.images     sky index result
   */
  constructor({ ra, dec, target = null, images, config = {}, signal = null, onEvent = () => {} }) {
    this.cfg = { ...CONFIG, ...config };
    this.target = target;
    this.signal = signal;
    this.emit = onEvent;
    if (target) [this.ra0, this.dec0] = propagate(target, jyearToMjd(this.cfg.epochCenter), false);
    else [this.ra0, this.dec0] = [ra, dec];
    Object.assign(this, makeGrid(this.ra0, this.dec0, this.cfg.pixArcsec, this.cfg.fovDeg));   // n, grid, gridRa, gridDec
    this.images = images;
    this.seasons = splitSeasons(images.map((i) => i.mjd), this.cfg.gapDays);
    for (const im of images) im.season = (seasonOf(this.seasons, im.mjd) || {}).label;
    this.bins = binDetectors(images).map((b) => {
      const cands = images.filter((i) => i.detector === b.det && (i.approx_lam_um == null
        || Math.abs(i.approx_lam_um / b.um - 1) <= this.cfg.tol + this.cfg.prefilter));
      const bySeason = {};
      for (const s of this.seasons) {
        bySeason[s.label] = cands.filter((i) => i.season === s.label)
          .sort((a, c) => (a.approx_lam_um == null ? 0 : Math.abs(a.approx_lam_um / b.um - 1))
            - (c.approx_lam_um == null ? 0 : Math.abs(c.approx_lam_um / b.um - 1)));
      }
      const nSeasons = Object.values(bySeason).filter((a) => a.length).length;
      return { ...b, candidates: bySeason, nSeasons, available: nSeasons >= this.cfg.minSeasons };
    });
    // Gaia DR3 field stars for the astrometric calibration: fetched once, on first use (not during the
    // quick preview, which does not calibrate and needs the network for the images)
    this._calStars = null;
    this.exposures = [];      // processed exposures (all bins)
    this.results = {};        // bin um -> result
    this.headerChecks = 0;
  }

  /** Promise of the Gaia DR3 field stars ({ok, nGaia, cal}); the query starts on first use. */
  get calStars() {
    this._calStars ||= !this.cfg.calibrate ? Promise.resolve(null)
      : gaiaStars(this.ra0, this.dec0, CALIB.maxFieldRadius + 0.01, { gmax: CALIB.gmaxQuery, signal: this.signal })
        .then((stars) => ({ ok: true, nGaia: stars.length, cal: prepareStars(stars, this.ra0, this.dec0) }))
        .catch((e) => ({ ok: false, error: e.message, cal: [] }));
    return this._calStars;
  }

  /** Target position at `mjd` (with parallax), or the fixed point. */
  posAt(mjd, withParallax = true) {
    return this.target ? propagate(this.target, mjd, withParallax) : [this.ra0, this.dec0];
  }

  /** Header stage: wavelength and pixel of the target in one exposure. */
  async inspect(img, um) {
    const f = new SpherexFile(s3Source(img.url, { signal: this.signal }));
    await f.open();
    this.headerChecks++;
    const h = f.header;
    const wcs = new SipWcs(h);
    const mjd = h.num("MJD-AVG", h.num("MJD-OBS", img.mjd));
    const [ra, dec] = this.posAt(mjd);
    const [x, y] = wcs.skyToPix(ra, dec);
    const nx = h.num("NAXIS1", NDET), ny = h.num("NAXIS2", NDET);
    const e = this.cfg.edgePx;
    const inside = x >= e && x <= nx - 1 - e && y >= e && y <= ny - 1 - e;
    let lam = NaN, bw = NaN;
    if (inside) [lam, bw] = new WaveWcs(h, f.waveTable).at(x, y);
    const ok = inside && Math.abs(lam / um - 1) <= this.cfg.tol;
    return { f, wcs, img, mjd, x, y, lam, bw, inside, ok, detector: h.num("DETECTOR", img.detector),
             orient: wcs.orientation(), ra_pred: ra, dec_pred: dec };
  }

  /** Data stage: read the rows, clean, reproject, centroid. G: output grid (default the session's);
   * zodi: false reads no ZODI (the frame median removes the level); calibrate: Gaia field stars. */
  async process(ex, { G = this, zodi = true, calibrate = this.cfg.calibrate } = {}) {
    const { f, wcs } = ex;
    const N = G.n * G.n;
    const px = new Float32Array(N), py = new Float32Array(N);
    let ymin = Infinity, ymax = -Infinity;
    // G.disk: only the rows of the grid's inscribed circle are read (preview: fewer bytes; the
    // corners stay empty and are filled for display)
    const c = (G.n - 1) / 2, r2 = G.disk ? (G.n / 2) ** 2 : Infinity;
    for (let k = 0; k < N; k++) {
      const [x, y] = wcs.skyToPix(G.gridRa[k], G.gridDec[k]);
      px[k] = x; py[k] = y;
      if (r2 !== Infinity && ((k % G.n) - c) ** 2 + (Math.floor(k / G.n) - c) ** 2 > r2) continue;
      if (x > -2 && x < NDET + 1 && y > -2 && y < NDET + 1) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    }
    ymin = Math.min(ymin, ex.y - 7); ymax = Math.max(ymax, ex.y + 7);
    const y0 = Math.max(0, Math.floor(ymin) - 1), y1 = Math.min(NDET - 1, Math.ceil(ymax) + 1);
    const reg = await f.readRegion(y0, y1, { zodi });
    const bits = { ...DEFAULT_BITS, ...flagBits(f.flags.header) };
    const badMask = this.cfg.badFlags.reduce((m, n) => m | (bits[n] || 0), 0);
    const satMask = this.cfg.satFlags.reduce((m, n) => m | (bits[n] || 0), 0);
    const W = reg.nx, H = y1 - y0 + 1;
    const data = new Float32Array(W * H), sat = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) {
      const fl = reg.flags[k];
      sat[k] = (fl & satMask) ? 1 : 0;
      data[k] = (fl & badMask) && !sat[k] ? NaN : reg.image[k] - (reg.zodi ? reg.zodi[k] : 0);
    }
    // noise (for the centroid weights) from a box around the target
    const box = [];
    for (let j = Math.max(0, Math.round(ex.y) - y0 - 20); j <= Math.min(H - 1, Math.round(ex.y) - y0 + 20); j++)
      for (let i = Math.max(0, Math.round(ex.x) - 20); i <= Math.min(W - 1, Math.round(ex.x) + 20); i++) {
        const v = data[j * W + i];
        if (Number.isFinite(v) && !sat[j * W + i]) box.push(v);
      }
    const med = median(box);
    const sigma0 = 1.4826 * median(box.map((v) => Math.abs(v - med))) || 0.05;
    // plain coordinate (no catalogue motion): start the fit at the brightest pixel (or the middle of
    // the saturated core) within 3 native pixels of the point, i.e. the source nearest the centre
    let gx = ex.x, gy = ex.y - y0;
    if (!this.target) {
      let best = -Infinity, sx = 0, sy = 0, ns = 0;
      for (let j = Math.round(gy) - 3; j <= Math.round(gy) + 3; j++) for (let i = Math.round(gx) - 3; i <= Math.round(gx) + 3; i++) {
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const k = j * W + i;
        if (sat[k]) { sx += i; sy += j; ns++; continue; }
        if (Number.isFinite(data[k]) && data[k] > best) { best = data[k]; if (!ns) { gx = i; gy = j; } }
      }
      if (ns) { gx = sx / ns; gy = sy / ns; }
    }
    const fit = gaussCentroid(data, W, H, (i, j) => !sat[j * W + i], gx, gy, sigma0);
    if (fit) {
      ex.x_fit = fit.x; ex.y_fit = fit.y + y0;
      [ex.ra_fit, ex.dec_fit] = wcs.pixToSky(ex.x_fit, ex.y_fit);
      ex.fit = fit;
      if (calibrate) await this.calibrate(ex, { data, sat, W, H, y0, wcs, sigma0, gx, gy });
    }
    // bilinear reprojection (NaN if any neighbour is NaN, like reproject_interp order=1)
    const out = new Float32Array(N), satOut = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      const x = px[k], y = py[k] - y0;
      const i0 = Math.floor(x), j0 = Math.floor(y);
      if (!(i0 >= 0 && j0 >= 0 && i0 + 1 < W && j0 + 1 < H)) { out[k] = NaN; continue; }
      const tx = x - i0, ty = y - j0, a = j0 * W + i0;
      out[k] = (1 - tx) * (1 - ty) * data[a] + tx * (1 - ty) * data[a + 1]
        + (1 - tx) * ty * data[a + W] + tx * ty * data[a + W + 1];
      const s = (1 - tx) * (1 - ty) * sat[a] + tx * (1 - ty) * sat[a + 1] + (1 - tx) * ty * sat[a + W] + tx * ty * sat[a + W + 1];
      satOut[k] = s > 0.5 ? 1 : 0;
    }
    // residual offset: median of the frame (crowded fields: median, as blink.py)
    const fin = [];
    for (let k = 0; k < N; k++) if (Number.isFinite(out[k]) && !satOut[k]) fin.push(out[k]);
    const off = median(fin);
    if (Number.isFinite(off)) for (let k = 0; k < N; k++) out[k] -= off;
    ex.bytesRows = H;
    ex.reproj = out; ex.sat = satOut;
    ex.coverage = fin.length / N;
    ex.f = null;   // drop the file object (headers stay cached in net.js)
    return ex;
  }

  /** Relative astrometry for one exposure (calib.js). The target's pixels that the fit could not
   * use (saturated core) decide the method: a saturated target is calibrated with saturated
   * catalogue stars in the same rows (same bias), an unsaturated one with Gaia field stars. */
  async calibrate(ex, { data, sat, W, H, y0, wcs, sigma0, gx, gy }) {
    let nmask = 0, ncore = 0;
    const ci = Math.round(gx), cj = Math.round(gy);
    for (let j = cj - 5; j <= cj + 5; j++) for (let i = ci - 5; i <= ci + 5; i++) {
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const k = j * W + i;
      if (sat[k] || !Number.isFinite(data[k])) nmask++;
      if (sat[k] && Math.abs(i - ci) <= 1 && Math.abs(j - cj) <= 1) ncore++;   // saturation flags, not bad pixels
    }
    ex.maskPx = nmask;
    ex.saturated = ncore > 0;
    const target = [ex.ra_fit, ex.dec_fit];
    let sc = null;
    if (ex.saturated && this.cfg.satCal) {
      if (!this.brightStars) {
        this.brightStars = tychoStars(this.ra0, this.dec0, this.cfg.brightRadius, this.cfg.brightVmax, { signal: this.signal })
          .catch((e) => ({ error: e.message }));
      }
      const bright = await this.brightStars;
      sc = Array.isArray(bright)
        ? calibrateSaturated({ bright, data, sat, W, H, y0, wcs, mjd: ex.mjd, sigma0, target, targetMask: this.cfg.satMaskMatch ? nmask : 0 })
        : { ok: false, reason: bright.error };
      ex.satRefs = (sc.pts || []).map((p) => ({ nmask: p.nmask, rE: p.rE, rN: p.rN, mag: p.mag }));
      delete sc.pts;
    }
    const field = await this.calStars;          // getter: starts the Gaia query on first use
    const fc = field && field.cal.length
      ? calibrateExposure({ cal: field.cal, data, sat, W, H, y0, wcs, mjd: ex.mjd, target, sigma0, file: ex.f })
      : { ok: false, reason: field && !field.ok ? field.error : "no Gaia stars" };
    const cosd = Math.cos(ex.dec_fit * Math.PI / 180);
    const apply = (c) => (c && c.ok ? [ex.ra_fit - c.corrE / 3600 / cosd, ex.dec_fit - c.corrN / 3600] : null);
    ex.fieldPts = fc.pts || null; delete fc.pts;
    ex.calibField = fc; ex.posField = apply(fc);
    // local Jacobian d(east, north)/d(x, y), arcsec per native pixel, at the target
    const [r1, d1] = wcs.pixToSky(ex.x_fit + 1, ex.y_fit), [r2, d2] = wcs.pixToSky(ex.x_fit, ex.y_fit + 1);
    const jx = offsetArcsec(ex.ra_fit, ex.dec_fit, r1, d1), jy = offsetArcsec(ex.ra_fit, ex.dec_fit, r2, d2);
    ex.jac = [[jx[0], jy[0]], [jx[1], jy[1]]];
    ex.calibSat = sc; ex.posSat = apply(sc);
    const c = sc && sc.ok ? sc : fc;
    ex.calib = c;
    if (c.ok) [ex.ra_cal, ex.dec_cal] = apply(c);
  }

  /** Select, download and stack one wavelength bin. */
  async loadBin(um, onProgress = () => {}) {
    if (this.results[um]) return this.results[um];
    const bin = this.bins.find((b) => b.um === um);
    if (!bin || !bin.available) throw new Error(`no SPHEREx images for ${um} um here`);
    const perSeason = await this._collect(bin, um, this.cfg.cap, {}, onProgress);
    for (const { season, exposures } of perSeason) {
      for (const ex of exposures) { ex.bin = um; ex.season = season.label; }
      this.exposures.push(...exposures);
    }
    const result = this._stack(perSeason, um, bin, this);
    result.rejected = perSeason.flatMap((p) => p.rejected.filter((r) => r.lam).map((r) => ({ obs: r.img.obs_id, lam: r.lam, inside: r.inside })));
    this.results[um] = result;
    return result;
  }

  /**
   * Quick preview of one bin: `perSeason` exposures per season (default 2..4, `total` in all),
   * small regions (a north-up grid of `fovDeg`, IMAGE + FLAGS rows only, no ZODI), no Gaia
   * calibration. Not a measurement: the exposures are not added to the session's astrometry.
   * For a catalogue target, result.prelim is a raw-WCS first -> last season shift.
   */
  async loadPreview(um, { perSeason = 0, total = 12, fovDeg = 0.1 } = {}, onProgress = () => {}) {
    const bin = this.bins.find((b) => b.um === um);
    if (!bin || !bin.available) throw new Error(`no SPHEREx images for ${um} um here`);
    const nS = this.seasons.filter((s) => bin.candidates[s.label].length).length;
    const cap = perSeason || Math.max(2, Math.min(4, Math.floor(total / Math.max(nS, 1))));
    if (!this.previewGrid || this.previewGrid.fovDeg !== fovDeg) {
      this.previewGrid = { ...makeGrid(this.ra0, this.dec0, this.cfg.pixArcsec, fovDeg), fovDeg, disk: true };
    }
    const G = this.previewGrid;
    const perS = await this._collect(bin, um, cap, { G, zodi: false, calibrate: false }, onProgress);
    for (const { season, exposures } of perS) for (const ex of exposures) { ex.bin = um; ex.season = season.label; }
    const result = this._stack(perS, um, bin, G);
    const n = result.frames.reduce((a, f) => a + f.n, 0);
    result.preview = { perSeason: cap, nImages: n, fovDeg, zodi: false, calibrated: false };
    result.prelim = this.preliminary(perS);
    return result;
  }

  /** First -> last season shift of a catalogue target from raw WCS centroids (preview only). */
  preliminary(perSeason) {
    if (!this.target) return null;
    const pos = [];
    for (const { season, exposures } of perSeason) {
      const f = exposures.filter((e) => e.ra_fit != null);
      if (!f.length) continue;
      const m = (get) => f.reduce((s, e) => s + get(e), 0) / f.length;
      const g = f.map((e) => this.posAt(e.mjd));
      pos.push({ season: season.label, n: f.length, ra: m((e) => e.ra_fit), dec: m((e) => e.dec_fit),
                 gra: g.reduce((s, p) => s + p[0], 0) / g.length, gdec: g.reduce((s, p) => s + p[1], 0) / g.length });
    }
    if (pos.length < 2) return null;
    const A = pos[0], Z = pos[pos.length - 1];
    const o = offsetArcsec(A.ra, A.dec, Z.ra, Z.dec), g = offsetArcsec(A.gra, A.gdec, Z.gra, Z.gdec);
    return { from: A.season, to: Z.season, shift: o[2], pa: o[3], gaiaShift: g[2], gaiaPa: g[3],
             n: pos.reduce((a, p) => a + p.n, 0), method: "raw SPHEREx WCS centroids, no Gaia field-star calibration, no error bars" };
  }

  /** Per season: inspect candidates (closest to the bin centre first) until `cap` are accepted,
   * process each accepted one with `popt` (see process). Returns [{season, exposures, rejected}]. */
  async _collect(bin, um, cap, popt, onProgress) {
    const progress = { checked: 0, accepted: 0, done: 0, planned: 0 };
    const tick = () => onProgress({ ...progress });
    return Promise.all(this.seasons.map(async (s) => {
      const queue = bin.candidates[s.label].slice();
      const accepted = [];
      const jobs = [];
      const rejected = [];
      while (accepted.length < cap && queue.length) {
        const batch = queue.splice(0, Math.min(4, cap - accepted.length + 1));
        const res = await Promise.all(batch.map((img) => this.inspect(img, um).catch((e) => {
          if (e.name === "AbortError") throw e;
          return { img, ok: false, error: e.message };
        })));
        progress.checked += batch.length; tick();
        res.sort((a, b) => Math.abs((a.lam || 99) / um - 1) - Math.abs((b.lam || 99) / um - 1));
        for (const ex of res) {
          if (ex.ok && accepted.length < cap) {
            accepted.push(ex);
            progress.accepted++; tick();
            jobs.push(this.process(ex, popt).then((r) => { progress.done++; tick(); return r; }, (e) => {
              if (e.name === "AbortError") throw e;
              ex.error = e.message; progress.done++; tick(); return null;
            }));
          } else rejected.push(ex);
        }
      }
      const done = (await Promise.all(jobs)).filter(Boolean);
      return { season: s, exposures: done, rejected };
    }));
  }

  /** Median per season on grid G, one asinh stretch for all seasons (as blink.py), last minus first. */
  _stack(perSeason, um, bin, G) {
    const N = G.n * G.n;
    const frames = [];
    for (const { season, exposures } of perSeason) {
      if (!exposures.length) continue;
      const img = new Float32Array(N), satm = new Uint8Array(N);
      const vals = new Float64Array(exposures.length);
      for (let k = 0; k < N; k++) {
        let m = 0, ns = 0;
        for (const ex of exposures) { const v = ex.reproj[k]; if (Number.isFinite(v)) vals[m++] = v; ns += ex.sat[k]; }
        if (m === 0) img[k] = NaN;
        else {
          const a = vals.subarray(0, m).sort();
          img[k] = m % 2 ? a[m >> 1] : 0.5 * (a[(m >> 1) - 1] + a[m >> 1]);
        }
        satm[k] = ns / exposures.length > 0.5 ? 1 : 0;
      }
      dropSmallBlobs(satm, G.n, 4);
      const mjds = exposures.map((e) => e.mjd);
      const mjdMean = mjds.reduce((a, b) => a + b, 0) / mjds.length;
      frames.push({
        season: season.label, img, sat: satm, n: exposures.length,
        detectors: [...new Set(exposures.map((e) => `D${e.detector}`))].sort(),
        lam: median(exposures.map((e) => e.lam)),
        lams: exposures.map((e) => +e.lam.toFixed(4)),
        mjdMean, date: mjdToDate(mjdMean),
        dateFirst: mjdToDate(Math.min(...mjds)), dateLast: mjdToDate(Math.max(...mjds)),
        obs: exposures.map((e) => e.img.obs_id + "D" + e.detector),
        gaiaXY: this.target ? G.grid.skyToPix(...propagate(this.target, mjdMean)) : null,
      });
    }
    if (frames.length < this.cfg.minSeasons) {
      throw new Error(`only ${frames.length} season(s) with usable ${um} um images at this position`);
    }
    const all = [];
    for (const fr of frames) for (const v of fr.img) if (Number.isFinite(v)) all.push(v);
    const sorted = Float64Array.from(all).sort();
    const med = percentile(sorted, 50);
    const mad = 1.4826 * median(all.map((v) => Math.abs(v - med)));
    const st = { lo: med - 1.5 * mad, hi: percentile(sorted, 99.97), soft: 3 * mad || 1e-3 };
    const den = Math.asinh((st.hi - st.lo) / st.soft);
    for (const fr of frames) {
      fr.norm = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        const v = fr.img[k];
        fr.norm[k] = fr.sat[k] ? 1 : Number.isFinite(v) ? Math.min(1, Math.max(0, Math.asinh((v - st.lo) / st.soft) / den)) : NaN;
      }
      softCore(fr.norm, fr.sat, G.n);                 // bright star: graded core, not a flat white disc
      fillNaN(fr.norm, G.n);
    }
    const first = frames[0], last = frames[frames.length - 1];
    const diff = new Float32Array(N);
    for (let k = 0; k < N; k++) diff[k] = last.norm[k] - first.norm[k];
    return { um, det: bin.det, frames, diff, stretch: st, n: G.n };
  }

  /** Centroid bias of saturated stars per detector, in detector pixels: the offsets (measured
   * minus catalogue, after the exposure's field-star WCS correction) of all saturated Tycho-2
   * stars in all downloaded exposures of that detector, turned into detector axes with each
   * exposure's Jacobian, 3-sigma clipped mean. Same-detector stars share the bias whatever the
   * spacecraft orientation, so March and August exposures pool. */
  /** Field-star correction per season x detector cell (calib.js poolCells). */
  fieldCells() {
    return poolCells(this.exposures.filter((e) => e.ra_fit != null && e.season));
  }

  saturatedBias(cells = this.fieldCells()) {
    const per = {};
    for (const e of this.exposures) {
      if (!e.satRefs || !e.satRefs.length || !e.jac) continue;
      const cc = cells.get(`${e.season}|${e.detector}`);
      const f = cc && cc.ok ? [cc.corrE, cc.corrN] : [0, 0];
      const [[a, b], [c, d]] = e.jac, det = a * d - b * c;
      for (const r of e.satRefs) {
        const vE = r.rE - f[0], vN = r.rN - f[1];
        (per[e.detector] ||= []).push([(d * vE - b * vN) / det, (-c * vE + a * vN) / det]);
      }
    }
    const out = {};
    for (const [det, pts] of Object.entries(per)) {
      let use = pts.map(() => true), mx = 0, my = 0;
      for (let it = 0; it < 6; it++) {
        const P = pts.filter((_, i) => use[i]);
        mx = median(P.map((p) => p[0])); my = median(P.map((p) => p[1]));
        const rr = pts.map((p) => Math.hypot(p[0] - mx, p[1] - my));
        const sig = Math.max(median(rr.filter((_, i) => use[i])) / 1.1774, 0.005);
        const next = rr.map((r) => r < 3 * sig);
        if (next.every((v, i) => v === use[i])) break;
        use = next;
      }
      const P = pts.filter((_, i) => use[i]);
      if (P.length < this.cfg.satMinRefs) { out[det] = { ok: false, n: P.length, reason: `only ${P.length} saturated reference star(s)` }; continue; }
      const m = (k) => P.reduce((s, p) => s + p[k], 0) / P.length;
      const dx = m(0), dy = m(1);
      const sx = Math.sqrt(P.reduce((s, p) => s + (p[0] - dx) ** 2, 0) / (P.length - 1));
      const sy = Math.sqrt(P.reduce((s, p) => s + (p[1] - dy) ** 2, 0) / (P.length - 1));
      out[det] = { ok: true, n: P.length, nAll: pts.length, dx, dy, errX: sx / Math.sqrt(P.length), errY: sy / Math.sqrt(P.length) };
    }
    return out;
  }

  /** Per-season target positions from the centroids of all processed exposures, and pairs.
   * Uses the Gaia-calibrated positions (calib.js) where an exposure could be calibrated;
   * a season with no calibrated exposure falls back to the raw centroids ("uncalibrated"). */
  astrometry({ calibrated = true, mode = null } = {}) {
    const ex = this.exposures.filter((e) => e.ra_fit != null);
    const bySeason = new Map();
    for (const e of ex) { if (!bySeason.has(e.season)) bySeason.set(e.season, []); bySeason.get(e.season).push(e); }
    const cosd = Math.cos(this.dec0 * Math.PI / 180);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const cells = this.fieldCells();
    const satBias = this.saturatedBias(cells);
    for (const e of ex) {
      const cc = cells.get(`${e.season}|${e.detector}`);
      e.cell = cc || null;
      const f = cc && cc.ok ? [cc.corrE, cc.corrN] : null;
      e.posCell = f ? [e.ra_fit - f[0] / 3600 / Math.cos(e.dec_fit * Math.PI / 180), e.dec_fit - f[1] / 3600] : null;
      const b = e.saturated ? satBias[e.detector] : null;
      e.posPool = null;
      if (e.saturated && !(b && b.ok)) continue;            // saturated, no bias estimate: uncalibrated
      if (!f && !b) continue;
      const fe = f || [0, 0];
      const be = b ? [e.jac[0][0] * b.dx + e.jac[0][1] * b.dy, e.jac[1][0] * b.dx + e.jac[1][1] * b.dy] : [0, 0];
      const c = Math.cos(e.dec_fit * Math.PI / 180);
      e.posPool = [e.ra_fit - (fe[0] + be[0]) / 3600 / c, e.dec_fit - (fe[1] + be[1]) / 3600];
      e.poolCorr = [fe[0] + be[0], fe[1] + be[1]];
    }
    const seasonPos = (list, get) => {
      const P = list.map(get);
      const mra = median(P.map((p) => p[0])), mdec = median(P.map((p) => p[1]));
      const r = P.map((p) => Math.hypot((p[0] - mra) * cosd, p[1] - mdec) * 3600);
      const lim = Math.max(3 * 1.4826 * median(r), 0.5);
      const keep = list.filter((e, k) => r[k] <= lim), KP = P.filter((_, k) => r[k] <= lim);
      const ra = mean(KP.map((p) => p[0])), dec = mean(KP.map((p) => p[1]));
      const sd = (a) => Math.sqrt(mean(a.map((v) => v * v)) / Math.max(a.length - 1, 1));
      // with < 3 exposures the scatter says little: use a single-exposure sigma of 0.35" (typical)
      const few = KP.length < 3;
      const errEast = few ? 0.35 / Math.sqrt(KP.length) : sd(KP.map((p) => (p[0] - ra) * cosd * 3600));
      const errNorth = few ? 0.35 / Math.sqrt(KP.length) : sd(KP.map((p) => (p[1] - dec) * 3600));
      return { ra, dec, keep, errEast, errNorth, nRejected: list.length - keep.length };
    };
    const positions = [];
    for (const s of this.seasons) {
      const list = bySeason.get(s.label);
      if (!list || !list.length) continue;
      const getCal = mode === "field" ? (e) => e.posField : mode === "sat" ? (e) => e.posSat : mode === "cells" ? (e) => e.posCell : (e) => e.posPool;
      const cal = list.filter((e) => getCal(e));
      const useCal = calibrated && cal.length > 0;
      const P = useCal ? seasonPos(cal, getCal) : seasonPos(list, (e) => [e.ra_fit, e.dec_fit]);
      const raw = seasonPos(list, (e) => [e.ra_fit, e.dec_fit]);
      const keep = P.keep;
      const mjd = mean(keep.map((e) => e.mjd));
      const gaia = this.target ? [mean(keep.map((e) => this.posAt(e.mjd)[0])), mean(keep.map((e) => this.posAt(e.mjd)[1]))] : null;
      const gaiaRaw = this.target ? [mean(raw.keep.map((e) => this.posAt(e.mjd)[0])), mean(raw.keep.map((e) => this.posAt(e.mjd)[1]))] : null;
      const ori = Math.atan2(mean(keep.map((e) => Math.sin(e.orient * Math.PI / 180))), mean(keep.map((e) => Math.cos(e.orient * Math.PI / 180)))) * 180 / Math.PI;
      const ckf = keep.filter((e) => e.cell && e.cell.ok);
      // systematic part of the error: the saturated-star bias estimate, common to a detector
      let sysE = 0, sysN = 0;
      if (useCal && satBias) {
        const dets = keep.filter((e) => e.saturated && satBias[e.detector] && satBias[e.detector].ok);
        if (dets.length) {
          const pe = dets.map((e) => { const b = satBias[e.detector]; return [Math.hypot(e.jac[0][0] * b.errX, e.jac[0][1] * b.errY), Math.hypot(e.jac[1][0] * b.errX, e.jac[1][1] * b.errY)]; });
          sysE = mean(pe.map((p) => p[0])) / Math.sqrt(new Set(dets.map((e) => e.detector)).size);
          sysN = mean(pe.map((p) => p[1])) / Math.sqrt(new Set(dets.map((e) => e.detector)).size);
        }
      }
      // plus the field-star cell errors (common to the exposures of a cell)
      const cl = [...new Map(keep.filter((e) => e.cell && e.cell.ok).map((e) => [e.detector, e.cell])).values()];
      if (useCal && cl.length) {
        sysE = Math.hypot(sysE, mean(cl.map((c) => c.errE)) / Math.sqrt(cl.length));
        sysN = Math.hypot(sysN, mean(cl.map((c) => c.errN)) / Math.sqrt(cl.length));
      }
      P.errEast = Math.hypot(P.errEast, sysE); P.errNorth = Math.hypot(P.errNorth, sysN);
      positions.push({ season: s.label, ra: P.ra, dec: P.dec, mjd, date: mjdToDate(mjd), n: keep.length, nRejected: P.nRejected,
                       errEast: P.errEast, errNorth: P.errNorth, orient: (ori + 360) % 360, gaia,
                       calibrated: useCal, nExposures: list.length, nCalibrated: cal.length,
                       calStars: ckf.length ? median(ckf.map((e) => e.cell.nStars)) : 0,
                       calRms: ckf.length ? median(ckf.map((e) => e.cell.rms)) : NaN,
                       calModel: ckf.length ? ckf[0].cell.model : null,
                       raw: { ra: raw.ra, dec: raw.dec, n: raw.keep.length, gaia: gaiaRaw,
                              minusGaia: gaiaRaw ? offsetArcsec(gaiaRaw[0], gaiaRaw[1], raw.ra, raw.dec).slice(0, 2) : null },
                       minusGaia: gaia ? offsetArcsec(gaia[0], gaia[1], P.ra, P.dec).slice(0, 2) : null,
                       bins: [...new Set(keep.map((e) => e.bin))].sort((a, b) => a - b),
                       grid: this.grid.skyToPix(P.ra, P.dec) });
    }
    const pairs = [];
    for (let a = 0; a < positions.length; a++) for (let z = a + 1; z < positions.length; z++) {
      const A = positions[a], Z = positions[z];
      const m = offsetArcsec(A.ra, A.dec, Z.ra, Z.dec);
      const m0 = offsetArcsec(A.raw.ra, A.raw.dec, Z.raw.ra, Z.raw.dec);
      const g = A.gaia ? offsetArcsec(A.gaia[0], A.gaia[1], Z.gaia[0], Z.gaia[1]) : null;
      const sameOrient = Math.abs(((A.orient - Z.orient + 540) % 360) - 180) < 20;
      pairs.push({ from: A.season, to: Z.season, dtYears: (Z.mjd - A.mjd) / 365.25, shift: m[2], pa: m[3], east: m[0], north: m[1],
                   err: Math.hypot(A.errEast, A.errNorth, Z.errEast, Z.errNorth),
                   rawShift: m0[2], rawPa: m0[3], calibrated: A.calibrated && Z.calibrated,
                   gaiaShift: g ? g[2] : null, gaiaPa: g ? g[3] : null, sameOrientation: sameOrient });
    }
    const calEx = ex.filter((e) => e.posPool && e.cell && e.cell.ok);
    return { positions, pairs, nFits: ex.length, nExposures: this.exposures.length,
             fieldStars: fieldStarTable(this.exposures, cells),   // per star x exposure, columns of field_stars.csv
             calibration: { nCalibrated: calEx.length, nFits: ex.length,
                            stars: calEx.length ? median(calEx.map((e) => e.cell.nStars)) : 0,
                            rms: calEx.length ? median(calEx.map((e) => e.cell.rms)) : NaN,
                            cells: [...cells.entries()].map(([k, c]) => ({ cell: k, ok: c.ok, source: c.source, model: c.model, nStars: c.nStars,
                              nMeas: c.nMeas, corrE: c.corrE, corrN: c.corrN, errE: c.errE, errN: c.errN, rms: c.rms, reason: c.reason })),
                            satRefs: Object.values(satBias).filter((b) => b.ok).reduce((a, b) => a + b.n, 0),
                            nCalibratedTarget: ex.filter((e) => e.posPool).length,
                            saturatedTarget: ex.some((e) => e.saturated),
                            saturatedBias: satBias,
                            reasons: [...new Set(ex.filter((e) => !e.posPool).map((e) => (e.saturated && !(satBias[e.detector] || {}).ok
                              ? `saturated target, ${(satBias[e.detector] || {}).reason || "no saturated reference stars"}`
                              : (e.cell ? e.cell.reason : "off"))))] } };
  }
}

/** Output grid: n x n pixels of pixArcsec around (ra0, dec0) and the sky position of every pixel. */
function makeGrid(ra0, dec0, pixArcsec, fovDeg) {
  const n = Math.round(fovDeg * 3600 / pixArcsec);
  const grid = new TanGrid(ra0, dec0, pixArcsec, n);
  const gridRa = new Float64Array(n * n), gridDec = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [a, d] = grid.pixToSky(i, j);
    gridRa[j * n + i] = a; gridDec[j * n + i] = d;
  }
  return { n, grid, gridRa, gridDec };
}

/** Remove connected blobs (4-neighbour) smaller than minPx from a 0/1 mask (n x n). */
function dropSmallBlobs(m, n, minPx) {
  const seen = new Uint8Array(m.length);
  const stack = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    const blob = [];
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const k = stack.pop(); blob.push(k);
      const i = k % n, j = (k / n) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const q = jj * n + ii;
        if (m[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (blob.length < minPx) for (const k of blob) m[k] = 0;
  }
}

/** Saturated cores for display (as blink.py soft_core): each core (4-neighbour blob of sat) rises
 * linearly from the median level of the 2-pixel ring around it to white at its centre, instead of
 * a flat white disc. norm: stretched 0..1 values (NaN = missing), changed in place. */
function softCore(norm, sat, n) {
  const N = n * n, d = new Float32Array(N), R2 = Math.SQRT2;
  for (let k = 0; k < N; k++) d[k] = sat[k] ? 1e9 : 0;
  for (let pass = 0; pass < 2; pass++) {               // chamfer distance to the nearest unsaturated pixel
    const nb = pass ? [[1, 0, 1], [-1, 1, R2], [0, 1, 1], [1, 1, R2]] : [[-1, 0, 1], [-1, -1, R2], [0, -1, 1], [1, -1, R2]];
    for (let t = 0; t < N; t++) {
      const k = pass ? N - 1 - t : t;
      if (!d[k]) continue;
      const i = k % n, j = (k / n) | 0;
      for (const [di, dj, w] of nb) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < n && jj < n) d[k] = Math.min(d[k], d[jj * n + ii] + w);
      }
    }
  }
  const seen = new Uint8Array(N), stack = [];
  for (let s = 0; s < N; s++) {
    if (!sat[s] || seen[s]) continue;
    const blob = [];
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const k = stack.pop(); blob.push(k);
      const i = k % n, j = (k / n) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj, q = jj * n + ii;
        if (ii >= 0 && jj >= 0 && ii < n && jj < n && sat[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    const ring = new Set();
    for (const k of blob) {
      const i = k % n, j = (k / n) | 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj, q = jj * n + ii;
        if (Math.abs(di) + Math.abs(dj) <= 2 && ii >= 0 && jj >= 0 && ii < n && jj < n && !sat[q] && Number.isFinite(norm[q])) ring.add(q);
      }
    }
    const rv = [...ring].map((q) => norm[q]);
    const edge = rv.length ? Math.min(1, Math.max(0, median(rv))) : 0.8;
    let dm = 1;
    for (const k of blob) dm = Math.max(dm, d[k]);
    for (const k of blob) norm[k] = edge + (1 - edge) * d[k] / dm;
  }
}

/** Fill NaNs (display only) from the mean of valid 3x3 neighbours, repeatedly; rest -> 0. */
export function fillNaN(a, n, iters = 20) {
  for (let it = 0; it < iters; it++) {
    const todo = [];
    for (let k = 0; k < a.length; k++) {
      if (Number.isFinite(a[k])) continue;
      const i = k % n, j = (k / n) | 0;
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const v = a[jj * n + ii];
        if (Number.isFinite(v)) { s += v; c++; }
      }
      if (c) todo.push([k, s / c]);
    }
    if (!todo.length) break;
    for (const [k, v] of todo) a[k] = v;
  }
  for (let k = 0; k < a.length; k++) if (!Number.isFinite(a[k])) a[k] = 0;
}
