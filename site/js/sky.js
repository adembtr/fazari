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
    this.n = Math.round(this.cfg.fovDeg * 3600 / this.cfg.pixArcsec);
    this.grid = new TanGrid(this.ra0, this.dec0, this.cfg.pixArcsec, this.n);
    const N = this.n * this.n;
    this.gridRa = new Float64Array(N); this.gridDec = new Float64Array(N);
    for (let j = 0; j < this.n; j++) for (let i = 0; i < this.n; i++) {
      const [a, d] = this.grid.pixToSky(i, j);
      this.gridRa[j * this.n + i] = a; this.gridDec[j * this.n + i] = d;
    }
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
    this.exposures = [];      // processed exposures (all bins)
    this.results = {};        // bin um -> result
    this.headerChecks = 0;
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

  /** Data stage: read the rows, clean, reproject, centroid. */
  async process(ex) {
    const { f, wcs } = ex;
    const N = this.n * this.n;
    const px = new Float32Array(N), py = new Float32Array(N);
    let ymin = Infinity, ymax = -Infinity;
    for (let k = 0; k < N; k++) {
      const [x, y] = wcs.skyToPix(this.gridRa[k], this.gridDec[k]);
      px[k] = x; py[k] = y;
      if (x > -2 && x < NDET + 1 && y > -2 && y < NDET + 1) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    }
    ymin = Math.min(ymin, ex.y - 7); ymax = Math.max(ymax, ex.y + 7);
    const y0 = Math.max(0, Math.floor(ymin) - 1), y1 = Math.min(NDET - 1, Math.ceil(ymax) + 1);
    const reg = await f.readRegion(y0, y1);
    const bits = { ...DEFAULT_BITS, ...flagBits(f.flags.header) };
    const badMask = this.cfg.badFlags.reduce((m, n) => m | (bits[n] || 0), 0);
    const satMask = this.cfg.satFlags.reduce((m, n) => m | (bits[n] || 0), 0);
    const W = reg.nx, H = y1 - y0 + 1;
    const data = new Float32Array(W * H), sat = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) {
      const fl = reg.flags[k];
      sat[k] = (fl & satMask) ? 1 : 0;
      data[k] = (fl & badMask) && !sat[k] ? NaN : reg.image[k] - reg.zodi[k];
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

  /** Select, download and stack one wavelength bin. */
  async loadBin(um, onProgress = () => {}) {
    if (this.results[um]) return this.results[um];
    const bin = this.bins.find((b) => b.um === um);
    if (!bin || !bin.available) throw new Error(`no SPHEREx images for ${um} um here`);
    const cap = this.cfg.cap;
    const progress = { checked: 0, accepted: 0, done: 0, planned: 0 };
    const tick = () => onProgress({ ...progress });
    const perSeason = await Promise.all(this.seasons.map(async (s) => {
      const queue = bin.candidates[s.label].slice();
      const accepted = [];
      const jobs = [];
      const rejected = [];
      while (accepted.length < cap && queue.length) {
        const batch = queue.splice(0, Math.min(4, cap - accepted.length + 1));
        progress.planned += 0;
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
            jobs.push(this.process(ex).then((r) => { progress.done++; tick(); return r; }, (e) => {
              if (e.name === "AbortError") throw e;
              ex.error = e.message; progress.done++; tick(); return null;
            }));
          } else rejected.push(ex);
        }
      }
      const done = (await Promise.all(jobs)).filter(Boolean);
      return { season: s, exposures: done, rejected };
    }));
    // stack per season
    const N = this.n * this.n;
    const frames = [];
    for (const { season, exposures } of perSeason) {
      if (!exposures.length) continue;
      for (const ex of exposures) { ex.bin = um; ex.season = season.label; }
      this.exposures.push(...exposures);
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
      dropSmallBlobs(satm, this.n, 4);
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
        gaiaXY: this.target ? this.grid.skyToPix(...propagate(this.target, mjdMean)) : null,
      });
    }
    if (frames.length < this.cfg.minSeasons) {
      throw new Error(`only ${frames.length} season(s) with usable ${um} um images at this position`);
    }
    // one asinh stretch for all seasons of the bin (as blink.py)
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
      fillNaN(fr.norm, this.n);
    }
    const first = frames[0], last = frames[frames.length - 1];
    const diff = new Float32Array(N);
    for (let k = 0; k < N; k++) diff[k] = last.norm[k] - first.norm[k];
    const result = { um, det: bin.det, frames, diff, stretch: st, n: this.n,
                     rejected: perSeason.flatMap((p) => p.rejected.filter((r) => r.lam).map((r) => ({ obs: r.img.obs_id, lam: r.lam, inside: r.inside }))) };
    this.results[um] = result;
    return result;
  }

  /** Per-season target positions from the centroids of all processed exposures, and pairs. */
  astrometry() {
    const ex = this.exposures.filter((e) => e.ra_fit != null);
    const bySeason = new Map();
    for (const e of ex) { if (!bySeason.has(e.season)) bySeason.set(e.season, []); bySeason.get(e.season).push(e); }
    const cosd = Math.cos(this.dec0 * Math.PI / 180);
    const positions = [];
    for (const s of this.seasons) {
      const list = bySeason.get(s.label);
      if (!list || !list.length) continue;
      const mra = median(list.map((e) => e.ra_fit)), mdec = median(list.map((e) => e.dec_fit));
      const r = list.map((e) => Math.hypot((e.ra_fit - mra) * cosd, e.dec_fit - mdec) * 3600);
      const lim = Math.max(3 * 1.4826 * median(r), 0.5);
      const keep = list.filter((e, k) => r[k] <= lim);
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const ra = mean(keep.map((e) => e.ra_fit)), dec = mean(keep.map((e) => e.dec_fit));
      const de = keep.map((e) => (e.ra_fit - ra) * cosd * 3600), dn = keep.map((e) => (e.dec_fit - dec) * 3600);
      const sd = (a) => Math.sqrt(mean(a.map((v) => v * v)) / a.length);
      const mjd = mean(keep.map((e) => e.mjd));
      const gaia = this.target ? [mean(keep.map((e) => this.posAt(e.mjd)[0])), mean(keep.map((e) => this.posAt(e.mjd)[1]))] : null;
      const ori = Math.atan2(mean(keep.map((e) => Math.sin(e.orient * Math.PI / 180))), mean(keep.map((e) => Math.cos(e.orient * Math.PI / 180)))) * 180 / Math.PI;
      positions.push({ season: s.label, ra, dec, mjd, date: mjdToDate(mjd), n: keep.length, nRejected: list.length - keep.length,
                       errEast: sd(de), errNorth: sd(dn), orient: (ori + 360) % 360, gaia,
                       bins: [...new Set(keep.map((e) => e.bin))].sort((a, b) => a - b),
                       grid: this.grid.skyToPix(ra, dec) });
    }
    const pairs = [];
    for (let a = 0; a < positions.length; a++) for (let z = a + 1; z < positions.length; z++) {
      const A = positions[a], Z = positions[z];
      const m = offsetArcsec(A.ra, A.dec, Z.ra, Z.dec);
      const g = A.gaia ? offsetArcsec(A.gaia[0], A.gaia[1], Z.gaia[0], Z.gaia[1]) : null;
      const sameOrient = Math.abs(((A.orient - Z.orient + 540) % 360) - 180) < 20;
      pairs.push({ from: A.season, to: Z.season, dtYears: (Z.mjd - A.mjd) / 365.25, shift: m[2], pa: m[3], east: m[0], north: m[1],
                   err: Math.hypot(A.errEast, A.errNorth, Z.errEast, Z.errNorth),
                   gaiaShift: g ? g[2] : null, gaiaPa: g ? g[3] : null, sameOrientation: sameOrient });
    }
    return { positions, pairs, nFits: ex.length, nExposures: this.exposures.length };
  }
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
