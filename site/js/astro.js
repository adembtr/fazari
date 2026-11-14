// Small astronomy helpers: times, proper motion + parallax, offsets, and a Gaussian centroid.
// Same conventions as pipeline/blink.py.

const D2R = Math.PI / 180;

export const mjdToJyear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
export const jyearToMjd = (jy) => 51544.5 + (jy - 2000) * 365.25;
export function mjdToDate(mjd) {
  return new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);
}
export function mjdToMonth(mjd) { return mjdToDate(mjd).slice(0, 7); }

/** Earth's position (AU, ICRS equatorial axes) relative to the Sun. Low-precision solar
 * formula (Astronomical Almanac), good to ~0.01 deg / 1e-4 AU; the Sun-barycentre offset
 * (<0.01 AU) is ignored: < 6 mas even for a 547 mas parallax. */
export function earthPosition(mjd) {
  const n = mjd + 2400000.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * D2R;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  const eps = (23.439 - 0.0000004 * n) * D2R;
  // Sun seen from Earth, then negate
  return [-R * Math.cos(lam), -R * Math.cos(eps) * Math.sin(lam), -R * Math.sin(eps) * Math.sin(lam)];
}

/** Catalogue position moved to `mjd`: linear proper motion (+ annual parallax), as blink.py.
 * t = {ra, dec, epoch (Julian yr), pmra (mas/yr, includes cos dec), pmdec, plx (mas)}. */
export function propagate(t, mjd, withParallax = true) {
  const dt = mjdToJyear(mjd) - t.epoch;
  const cosd = Math.cos(t.dec * D2R);
  let dra = (t.pmra || 0) * dt, ddec = (t.pmdec || 0) * dt;
  if (withParallax && t.plx) {
    const e = earthPosition(mjd);
    const a = t.ra * D2R, d = t.dec * D2R;
    dra += t.plx * (e[0] * Math.sin(a) - e[1] * Math.cos(a));
    ddec += t.plx * (e[0] * Math.cos(a) * Math.sin(d) + e[1] * Math.sin(a) * Math.sin(d) - e[2] * Math.cos(d));
  }
  return [((t.ra + dra / 3.6e6 / cosd) % 360 + 360) % 360, t.dec + ddec / 3.6e6];
}

/** Small-angle offset from 1 to 2: [east, north, total] arcsec and PA (deg E of N). */
export function offsetArcsec(ra1, dec1, ra2, dec2) {
  const dra = ((ra2 - ra1 + 540) % 360) - 180;
  const de = dra * Math.cos(0.5 * (dec1 + dec2) * D2R) * 3600;
  const dn = (dec2 - dec1) * 3600;
  return [de, dn, Math.hypot(de, dn), ((Math.atan2(de, dn) / D2R) % 360 + 360) % 360];
}

// ---- statistics ----------------------------------------------------------------------------
export function median(arr) {
  const a = Float64Array.from(arr).filter((v) => Number.isFinite(v)).sort();
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const k = (sorted.length - 1) * p / 100, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

// ---- centroid: pixel-integrated circular Gaussian fit (as blink.py `centroid`) -----------------
function erf(x) {     // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function gauss(p, x, y) {
  const [amp, x0, y0, s, bg] = p;
  const r2 = Math.SQRT2 * s;
  const fx = 0.5 * (erf((x + 0.5 - x0) / r2) - erf((x - 0.5 - x0) / r2));
  const fy = 0.5 * (erf((y + 0.5 - y0) / r2) - erf((y - 0.5 - y0) / r2));
  return amp * fx * fy + bg;
}

function solve(A, b) {   // small dense Gauss-Jordan with partial pivoting
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Fit the star near (x0, y0) in native pixels. img: Float32Array (w x h, row-major),
 * ok(i, j) -> bool tells which pixels may be used (not flagged, not saturated), sigma0 = noise
 * per pixel. The saturated core is excluded, so the symmetric model is pinned by the wings.
 * Returns {x, y, sigma, npix} or null.
 */
export function gaussCentroid(img, w, h, ok, x0, y0, sigma0, half = 5) {
  const ix = Math.round(x0), iy = Math.round(y0);
  const xs = [], ys = [], ds = [], ws = [];
  let nsat = 0, dmax = -Infinity;
  for (let j = iy - half; j <= iy + half; j++) {
    for (let i = ix - half; i <= ix + half; i++) {
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const v = img[j * w + i];
      if (!Number.isFinite(v)) { nsat++; continue; }
      if (!ok(i, j)) { nsat++; continue; }
      xs.push(i); ys.push(j); ds.push(v);
      dmax = Math.max(dmax, v);
    }
  }
  const n = ds.length;
  if (n < 25) return null;
  for (let k = 0; k < n; k++) ws.push(1 / Math.sqrt(sigma0 * sigma0 + (0.05 * ds[k]) ** 2));
  const bg0 = median(ds);
  let p = [Math.max(dmax, 1) * (nsat ? 6 : 2), x0, y0, 0.6, bg0];
  const lo = [0, x0 - 2.5, y0 - 2.5, 0.25, -Infinity], hi = [Infinity, x0 + 2.5, y0 + 2.5, 3.0, Infinity];
  const resid = (q) => ds.map((d, k) => (gauss(q, xs[k], ys[k]) - d) * ws[k]);
  let r = resid(p), cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3;
  for (let it = 0; it < 100; it++) {
    // numeric Jacobian
    const J = [];
    for (let a = 0; a < 5; a++) {
      const h = a === 0 ? Math.max(1e-6, Math.abs(p[0]) * 1e-6) : a === 4 ? Math.max(1e-6, Math.abs(p[4]) * 1e-6) : 1e-6;
      const q = p.slice(); q[a] += h;
      const rq = resid(q);
      J.push(rq.map((v, k) => (v - r[k]) / h));
    }
    const JTJ = Array.from({ length: 5 }, (_, a) => Array.from({ length: 5 }, (_, b) => J[a].reduce((s, v, k) => s + v * J[b][k], 0)));
    const JTr = J.map((col) => col.reduce((s, v, k) => s + v * r[k], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JTJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const step = solve(A, JTr.map((v) => -v));
      if (!step) { lambda *= 10; continue; }
      const q = p.map((v, a) => Math.min(hi[a], Math.max(lo[a], v + step[a])));
      const rq = resid(q);
      const cq = rq.reduce((s, v) => s + v * v, 0);
      if (cq < cost) {
        const rel = (cost - cq) / cost;
        p = q; r = rq; cost = cq; lambda = Math.max(lambda / 10, 1e-9); improved = true;
        if (rel < 1e-10) it = 1000;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  const atBound = [1, 2].some((a) => Math.abs(p[a] - lo[a]) < 1e-6 || Math.abs(p[a] - hi[a]) < 1e-6);
  if (atBound || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return null;
  return { x: p[1], y: p[2], sigma: p[3], npix: n, chi2: cost / Math.max(n - 5, 1) };
}
