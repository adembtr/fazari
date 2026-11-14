// SPHEREx sky index lookup (browser ES module, no dependencies).
//
//   import { findImages } from "./js/skyindex.js";
//   const imgs = await findImages(269.44627, 4.76820);
//   -> [{obs_id, collection: "dr1"|"qr3", detector: 1..6, mjd, mjd_end, s3_key, url,
//        lam_min_um, lam_max_um, approx_lam_um, ra_center, dec_center, corners}]
//
// Only images whose footprint contains (ra, dec) (ICRS degrees), within opts.margin degrees
// (default 0.001 deg = 3.6", the radius of the IRSA SIA search used for the reference lists),
// are returned, sorted by time. The index is static: index/manifest.json plus one gzip tile
// per HEALPix cell (format: index/FORMAT.md, built by pipeline/sky_index.py). One query costs
// the manifest (once per page) and one tile (cached).
//
// Options:
//   base   index folder URL (default "./index/" relative to the page)
//   margin degrees, 0..manifest.max_margin
//   fetch  fetch function (for tests, e.g. under Node)

const D2R = Math.PI / 180;
const states = new Map();          // base URL -> { manifest: Promise, tiles: Map }

function baseUrl(base) {
  let b = base ?? "./index/";
  if (!b.endsWith("/")) b += "/";
  const ref = globalThis.document?.baseURI ?? globalThis.location?.href;
  try { return ref ? new URL(b, ref).href : new URL(b).href; } catch { return b; }
}

function state(base, fetchFn) {
  let s = states.get(base);
  if (!s) {
    s = { tiles: new Map() };
    s.manifest = fetchFn(base + "manifest.json").then((r) => {
      if (!r.ok) throw new Error(`sky index manifest: HTTP ${r.status}`);
      return r.json();
    }).then(prepare);
    s.manifest.catch(() => states.delete(base));
    states.set(base, s);
  }
  return s;
}

function prepare(m) {
  m._leaves = Object.entries(m.tiles)
    .map(([o, list]) => [Number(o), new Set(list)])
    .sort((a, b) => b[0] - a[0]);                      // deepest order first
  return m;
}

async function gunzip(buf) {
  const u8 = new Uint8Array(buf);
  // A server may already have removed the gzip layer (Content-Encoding); check the magic bytes.
  if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return u8;
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** HEALPix nested pixel index of (ra, dec) degrees at the given order (same as sky_index.py). */
export function ang2pixNest(order, ra, dec) {
  const nside = 2 ** order;
  const z = Math.sin(dec * D2R), za = Math.abs(z);
  let tt = ((((ra * D2R) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2);
  if (tt >= 4) tt = 0;
  let face, ix, iy;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt), t2 = nside * z * 0.75;
    const jp = Math.floor(t1 - t2), jm = Math.floor(t1 + t2);
    const ifp = Math.floor(jp / nside), ifm = Math.floor(jm / nside);
    face = ifp === ifm ? (ifp | 4) : (ifp < ifm ? ifp : ifm + 8);
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(nside - 1, Math.floor(tp * tmp)), jm = Math.min(nside - 1, Math.floor((1 - tp) * tmp));
    if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; } else { face = ntt + 8; ix = jp; iy = jm; }
  }
  let ipf = 0;
  for (let b = 0; b < order; b++) ipf += (((ix >> b) & 1) + 2 * ((iy >> b) & 1)) * 4 ** b;
  return face * nside * nside + ipf;
}

function tileFor(m, ra, dec) {
  for (const [o, set] of m._leaves) {
    const p = ang2pixNest(o, ra, dec);
    if (set.has(p)) return [o, p];
  }
  return null;
}

// Byte-plane ("shuffled") little-endian columns.
function planes(b, off, n, w) {
  const p = [];
  for (let k = 0; k < w; k++) p.push(b.subarray(off + k * n, off + (k + 1) * n));
  return p;
}

function decodeTile(b, planWidth) {
  if (b[0] !== 0x53 || b[1] !== 0x58 || b[2] !== 0x54 || b[3] !== 0x31) throw new Error("bad sky index tile");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const nExp = dv.getUint32(4, true), nImg = dv.getUint32(8, true);
  let off = 12;
  const t = new Float64Array(nExp);
  { const [p0, p1, p2, p3] = planes(b, off, nExp, 4); let acc = 0;
    for (let i = 0; i < nExp; i++) { acc += (p0[i] | p1[i] << 8 | p2[i] << 16) + p3[i] * 16777216; t[i] = acc; } }
  off += 4 * nExp;
  const plan = new Uint16Array(nExp);
  for (let i = 0; i < nExp; i++) plan[i] = planWidth === 1 ? b[off + i] : dv.getUint16(off + 2 * i, true);
  off += planWidth * nExp;
  const seq = new Uint16Array(nExp);
  { const [p0, p1] = planes(b, off, nExp, 2); for (let i = 0; i < nExp; i++) seq[i] = p0[i] | p1[i] << 8; }
  off += 2 * nExp;
  const sub = b.subarray(off, off + nExp); off += nExp;
  const detmask = b.subarray(off, off + nExp); off += nExp;
  const retrymask = b.subarray(off, off + nExp); off += nExp;
  const raq = new Float64Array(nImg), decq = new Float64Array(nImg), angq = new Float64Array(nImg);
  { const [p0, p1, p2, p3] = planes(b, off, nImg, 4);
    for (let i = 0; i < nImg; i++) raq[i] = (p0[i] | p1[i] << 8 | p2[i] << 16) + p3[i] * 16777216; }
  off += 4 * nImg;
  { const [p0, p1, p2, p3] = planes(b, off, nImg, 4);
    for (let i = 0; i < nImg; i++) decq[i] = p0[i] | p1[i] << 8 | p2[i] << 16 | p3[i] << 24; }
  off += 4 * nImg;
  { const [p0, p1] = planes(b, off, nImg, 2); for (let i = 0; i < nImg; i++) angq[i] = p0[i] | p1[i] << 8; }
  off += 2 * nImg;
  const res = new Int16Array(nImg * 8);                // column k (x0 y0 x1 y1 ...) at k*nImg
  { const [p0, p1] = planes(b, off, nImg * 8, 2);
    for (let i = 0; i < nImg * 8; i++) res[i] = (p0[i] | p1[i] << 8) << 16 >> 16; }
  off += 16 * nImg;
  if (off !== b.length) throw new Error("sky index tile: bad length");
  // image -> exposure, detector
  const eid = new Int32Array(nImg), det = new Uint8Array(nImg), retry = new Uint8Array(nImg);
  let j = 0;
  for (let i = 0; i < nExp; i++) {
    for (let d = 1; d <= 6; d++) {
      if ((detmask[i] >> (d - 1)) & 1) { eid[j] = i; det[j] = d; retry[j] = (retrymask[i] >> (d - 1)) & 1; j++; }
    }
  }
  if (j !== nImg) throw new Error("sky index tile: bad detector masks");
  return { nImg, t, plan, seq, sub, eid, det, retry, raq, decq, angq, res };
}

async function loadTile(s, m, base, fetchFn, o, p) {
  const key = `${o}/${p}`;
  if (!s.tiles.has(key)) {
    const url = base + m.tile_path.replace("{order}", o).replace("{pix}", p);
    const pr = fetchFn(url).then((r) => {
      if (!r.ok) throw new Error(`sky index tile ${key}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }).then(gunzip).then((b) => decodeTile(b, m.plan_width));
    pr.catch(() => s.tiles.delete(key));
    s.tiles.set(key, pr);
  }
  return s.tiles.get(key);
}

function basis(ra0, dec0) {
  const a = ra0 * D2R, d = dec0 * D2R, ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d);
  return { c: [cd * ca, cd * sa, sd], e: [-sa, ca, 0], n: [-sd * ca, -sd * sa, cd] };
}
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

// Point inside the convex quad (cx, cy) or within `margin` of one of its edges (tangent plane, degrees).
function contains(px, py, cx, cy, margin) {
  let area = 0;
  for (let k = 0; k < 4; k++) { const l = (k + 1) % 4; area += cx[k] * cy[l] - cx[l] * cy[k]; }
  const sgn = area >= 0 ? 1 : -1;
  let inside = true, best = Infinity;
  for (let k = 0; k < 4; k++) {
    const l = (k + 1) % 4, ex = cx[l] - cx[k], ey = cy[l] - cy[k];
    if ((ex * (py - cy[k]) - ey * (px - cx[k])) * sgn < 0) inside = false;
    const t = Math.min(1, Math.max(0, ((px - cx[k]) * ex + (py - cy[k]) * ey) / (ex * ex + ey * ey)));
    const dx = px - (cx[k] + t * ex), dy = py - (cy[k] + t * ey);
    best = Math.min(best, dx * dx + dy * dy);
  }
  return inside || best <= margin * margin;
}

// Detector-frame position (u, v in 0..1) inside the quad with corners at pixel (0,0) (1,0) (1,1) (0,1).
function quadUV(px, py, cx, cy) {
  const e = [cx[1] - cx[0], cy[1] - cy[0]], f = [cx[3] - cx[0], cy[3] - cy[0]];
  const g = [cx[0] - cx[1] + cx[2] - cx[3], cy[0] - cy[1] + cy[2] - cy[3]];
  let u = 0.5, v = 0.5;
  for (let it = 0; it < 30; it++) {
    const fx = cx[0] + u * e[0] + v * f[0] + u * v * g[0] - px;
    const fy = cy[0] + u * e[1] + v * f[1] + u * v * g[1] - py;
    const a = e[0] + v * g[0], b = f[0] + u * g[0], c = e[1] + v * g[1], d = f[1] + u * g[1];
    const det = a * d - b * c;
    if (!det) break;
    const du = (d * fx - b * fy) / det, dv = (-c * fx + a * fy) / det;
    u -= du; v -= dv;
    if (Math.abs(du) + Math.abs(dv) < 1e-12) break;
  }
  return [u, v];
}

// Wavelength (um) at detector-frame (u, v): bilinear in the per-detector WCS-WAVE control grid
// (manifest.wave), else log-linear along y from lam_max (y = 0) to lam_min (y = 1). The exact
// value needs the image's own spectral WCS; this agrees to about 1 %.
function approxLambda(m, det, u, v) {
  u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v));
  const w = m.wave?.[det];
  if (w) {
    const x = Math.min(w.x[w.x.length - 1], Math.max(w.x[0], 0.5 + u * m.npix));
    const y = Math.min(w.y[w.y.length - 1], Math.max(w.y[0], 0.5 + v * m.npix));
    const cell = (g, val) => {
      let i = 0;
      while (i < g.length - 2 && val > g[i + 1]) i++;
      const span = g[i + 1] - g[i];
      return [i, span ? (val - g[i]) / span : 0];
    };
    const [i, fx] = cell(w.x, x), [k, fy] = cell(w.y, y), L = w.lam;
    const lam = (1 - fy) * ((1 - fx) * L[k][i] + fx * L[k][i + 1]) + fy * ((1 - fx) * L[k + 1][i] + fx * L[k + 1][i + 1]);
    return Math.round(lam * 1e4) / 1e4;
  }
  const [lo, hi] = m.lam_um[det];
  return Math.round(Math.exp(Math.log(hi) - (Math.log(hi) - Math.log(lo)) * v) * 1e4) / 1e4;
}

function deproject(x, y, B) {
  const xr = x * D2R, yr = y * D2R;
  const v = [0, 1, 2].map((i) => B.c[i] + xr * B.e[i] + yr * B.n[i]);
  const r = Math.hypot(v[0], v[1], v[2]);
  const ra = ((Math.atan2(v[1], v[0]) / D2R) % 360 + 360) % 360;
  return [Math.round(ra * 1e6) / 1e6, Math.round(Math.asin(v[2] / r) / D2R * 1e6) / 1e6];
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

export async function findImages(ra, dec, opts = {}) {
  ra = Number(ra); dec = Number(dec);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) throw new Error("findImages: bad coordinates");
  ra = ((ra % 360) + 360) % 360;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = baseUrl(opts.base);
  const s = state(base, fetchFn);
  const m = await s.manifest;
  const margin = Math.min(m.max_margin, Math.max(0, opts.margin ?? m.default_margin));
  const tp = tileFor(m, ra, dec);
  if (!tp) return [];
  const T = await loadTile(s, m, base, fetchFn, tp[0], tp[1]);
  const pu = m.pos_unit, ru = m.res_unit, astep = (2 * Math.PI) / m.ang_steps;
  const P = [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)];
  const out = [];
  const cx = [0, 0, 0, 0], cy = [0, 0, 0, 0];
  for (let i = 0; i < T.nImg; i++) {
    const B = basis(T.raq[i] * pu, T.decq[i] * pu);
    const w = dot(P, B.c);
    if (w <= 0.5) continue;
    const px = dot(P, B.e) / w / D2R, py = dot(P, B.n) / w / D2R;
    const a = T.angq[i] * astep, ca = Math.cos(a), sa = Math.sin(a);
    const tm = m.templates[T.det[i]];
    for (let k = 0; k < 4; k++) {
      cx[k] = ca * tm[k][0] - sa * tm[k][1] + T.res[(2 * k) * T.nImg + i] * ru;
      cy[k] = sa * tm[k][0] + ca * tm[k][1] + T.res[(2 * k + 1) * T.nImg + i] * ru;
    }
    if (!contains(px, py, cx, cy, margin)) continue;
    const e = T.eid[i], d = T.det[i];
    const pl = m.plans[T.plan[e]];
    const ver = T.retry[i] ? pl.retry_ver : pl.ver;
    const obs_id = `${pl.plan}_${String(T.seq[e]).padStart(4, "0")}_${T.sub[e]}`;
    const s3_key = `${pl.rel}/level2/${pl.plan}/${ver}/${d}/level2_${obs_id}D${d}_spx_${ver}.fits`;
    const mjd = T.t[e] * m.t_unit + m.t_zero;
    const [lmin, lmax] = m.lam_um[d];
    const [u, v] = quadUV(px, py, cx, cy);
    const approx = approxLambda(m, d, u, v);
    out.push({
      obs_id, collection: pl.rel, detector: d, mjd: round6(mjd), mjd_end: round6(mjd + m.exposure_days),
      s3_key, url: m.s3_base + s3_key, lam_min_um: lmin, lam_max_um: lmax,
      approx_lam_um: approx,
      ra_center: round6(T.raq[i] * pu), dec_center: round6(T.decq[i] * pu),
      corners: [0, 1, 2, 3].map((k) => deproject(cx[k], cy[k], B)),
    });
  }
  out.sort((a, b) => a.mjd - b.mjd || a.detector - b.detector);
  return out;
}

/** The parsed manifest (collections, dates, tile list, ...). */
export async function skyIndexManifest(opts = {}) {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  return state(baseUrl(opts.base), fetchFn).manifest;
}
