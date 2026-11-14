// Display processing of the season frames of ONE wavelength bin, so that a blink shows only what really changed.
// Pure pixel code (typed arrays in, typed arrays out; no DOM): used by js/viewer.js (PNG frames of a result folder)
// and js/app.js (the browser engine's frames on sky.html), and testable in Node.
//
// What it does, in this order, on the frames' own sky grid (3″ cells for our results):
//   1. undo the pipeline's display stretch (meta.wavelength_bins[].stretch) to get back linear surface brightness;
//   2. sky level and noise of every season from its own pixels (robust: histogram quantiles, bright pixels clipped),
//      and subtract each season's sky level: all seasons then share one zero level;
//   3. measure how the field stars sit in each season relative to the first (windowed centroids of the same
//      unsaturated stars, median over the stars) and take that common shift out when drawing: stars stay put,
//      only something that really moved still jumps. One shift per season (no rotation, no scale);
//   4. ONE brightness scale for all seasons of the bin (asinh ramp; black a little above the sky so that the
//      season-to-season noise does not flicker);
//   5. draw on a finer grid with a smooth cubic kernel (the shift of step 3 is applied here, in one interpolation).
// "Raw" (opts.raw): steps 2 to 5 are skipped: the cells are drawn as squares with the pipeline's own grey values.
//
// DISPLAY ONLY. Nothing here feeds a measurement: positions, speeds and errors on the page are the engine's numbers
// (meta.json / the browser engine) exactly as they are. The shifts found in step 3 are reported (set.shift, in grid
// cells and arcsec) so the page can say what was done.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Grey values (0..255) of the sky grid from the RGBA pixels of a frame PNG: W x H pixels, a label strip of `strip`
 *  rows on top, every grid cell drawn as up x up equal pixels (pipeline/blink.py to_png). */
export function gridFromRgba(rgba, W, H, up = 4, strip = 0) {
  const nx = Math.floor(W / up), ny = Math.floor((H - strip) / up), g = new Uint8Array(nx * ny), o = up >> 1;
  for (let j = 0; j < ny; j++) {
    const row = (strip + j * up + o) * W;
    for (let i = 0; i < nx; i++) g[j * nx + i] = rgba[4 * (row + i * up + o)];
  }
  return { g, nx, ny };
}

// ---- stretch -----------------------------------------------------------------------------------------------
/** The pipeline's stretch (blink.py stretch): s = asinh((a - lo) / soft) / asinh((hi - lo) / soft), clipped to 0..1. */
function makeUnstretch(st) {
  if (!st || st.type !== "asinh" || !(st.soft > 0) || !(st.hi > st.lo)) return null;
  const A = Math.asinh((st.hi - st.lo) / st.soft);
  return (s) => st.lo + st.soft * Math.sinh(s * A);
}

// ---- robust statistics from a histogram ---------------------------------------------------------------------
/** Quantile function of values s in 0..1 from a histogram with `levels` bins (linear inside a bin: sub-level precision). */
function histogram(s, levels, skip) {
  const h = new Float64Array(levels);
  let n = 0;
  for (let k = 0; k < s.length; k++) { if (skip && skip[k]) continue; const b = Math.min(levels - 1, Math.max(0, Math.round(s[k] * (levels - 1)))); h[b]++; n++; }
  return { h, n, levels };
}
/** Value (0..1) below which `count` of the histogram's samples lie. */
function atCount(H, count) {
  let acc = 0;
  for (let b = 0; b < H.levels; b++) {
    const c = H.h[b];
    if (c > 0 && acc + c >= count) return (b - 0.5 + (count - acc) / c) / (H.levels - 1);
    acc += c;
  }
  return 1;
}
/** Number of samples at or below value v (0..1), linear inside a bin. */
function countBelow(H, v) {
  const x = v * (H.levels - 1) + 0.5, b = Math.floor(x);
  let acc = 0;
  for (let k = 0; k < Math.min(b, H.levels); k++) acc += H.h[k];
  if (b >= 0 && b < H.levels) acc += H.h[b] * (x - b);
  return acc;
}
/** Sky level and 1-sigma noise of a frame, in stretched units (0..1): the middle of the faint pixels (anything above
 *  +2 sigma is clipped, repeated), noise from the lower half only (stars cannot inflate it). */
function skyStretched(H) {
  let m = atCount(H, H.n / 2), sig = 0;
  for (let it = 0; it < 6; it++) {
    const nLow = countBelow(H, m);
    sig = Math.max(m - atCount(H, nLow * 0.3173), 0.25 / (H.levels - 1));
    const nc = countBelow(H, m + 2 * sig);
    const m2 = atCount(H, nc * 0.5116);                  // median of a Gaussian cut at +2 sigma sits at this fraction
    if (Math.abs(m2 - m) < 1e-5) { m = m2; break; }
    m = m2;
  }
  return { m, sig };
}

/** Large-scale sky of a frame on a coarse mesh: the middle of the faint pixels of every block (stars clipped as in
 *  skyStretched), in linear units when `un` is given. Cells with no data (0) are left out. { v: Float64Array, bx, by } */
function meshSky(p, nx, ny, B, levels, un) {
  const bx = Math.max(1, Math.round(nx / B)), by = Math.max(1, Math.round(ny / B)), v = new Float64Array(bx * by);
  for (let J = 0; J < by; J++) for (let I = 0; I < bx; I++) {
    const i0 = Math.floor(I * nx / bx), i1 = Math.floor((I + 1) * nx / bx), j0 = Math.floor(J * ny / by), j1 = Math.floor((J + 1) * ny / by);
    const h = new Float64Array(levels);
    let n = 0;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { const x = p[j * nx + i]; if (x <= 0) continue; h[Math.min(levels - 1, Math.round(x * (levels - 1)))]++; n++; }
    if (n < 30) { v[J * bx + I] = NaN; continue; }
    const m = skyStretched({ h, n, levels }).m;
    v[J * bx + I] = un ? un(m) : m;
  }
  return { v, bx, by };
}
/** Value of a block mesh at cell (i, j): bilinear between the block centres. */
function meshAt(m, bx, by, nx, ny, i, j) {
  const fx = clamp((i + 0.5) * bx / nx - 0.5, 0, bx - 1), fy = clamp((j + 0.5) * by / ny - 0.5, 0, by - 1);
  const I = Math.min(bx - 2 < 0 ? 0 : bx - 2, Math.floor(fx)), J = Math.min(by - 2 < 0 ? 0 : by - 2, Math.floor(fy)), tx = fx - I, ty = fy - J;
  const I1 = Math.min(bx - 1, I + 1), J1 = Math.min(by - 1, J + 1);
  return (m[J * bx + I] * (1 - tx) + m[J * bx + I1] * tx) * (1 - ty) + (m[J1 * bx + I] * (1 - tx) + m[J1 * bx + I1] * tx) * ty;
}

// ---- stars and their centroids -------------------------------------------------------------------------------
function findStars(v, nx, ny, sigma, sat, max = 90) {
  // 3x3 mean, local maxima well above the noise, away from the border and from saturated cells; brightest first;
  // a star with a brighter one within 5 cells is skipped (blends give poor centroids)
  const sm = new Float32Array(nx * ny);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    let a = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) a += v[(j + dj) * nx + i + di];
    sm[j * nx + i] = a / 9;
  }
  const thr = 5 * sigma / 3 * 2.2, B = 6, c = [];        // ~ 5 sigma of the 3x3 mean (pixels are correlated: x2.2)
  for (let j = B; j < ny - B; j++) for (let i = B; i < nx - B; i++) {
    const k = j * nx + i, x = sm[k];
    if (x < thr) continue;
    if (x < sm[k - 1] || x <= sm[k + 1] || x < sm[k - nx] || x <= sm[k + nx] || x < sm[k - nx - 1] || x <= sm[k + nx + 1] || x < sm[k - nx + 1] || x <= sm[k + nx - 1]) continue;
    let bad = false;
    for (let dj = -3; dj <= 3 && !bad; dj++) for (let di = -3; di <= 3; di++) if (sat[(j + dj) * nx + i + di]) { bad = true; break; }
    if (!bad) c.push([x, i, j]);
  }
  c.sort((a, b) => b[0] - a[0]);
  const out = [];
  for (const s of c) {
    if (out.some((o) => Math.abs(o[1] - s[1]) < 5 && Math.abs(o[2] - s[2]) < 5)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out.map(([f, x, y]) => ({ x, y, f }));
}
/** Centre of a star near (x0, y0): first moment under a Gaussian window that follows the centre (iterated). */
function centroid(v, nx, ny, x0, y0, floor) {
  const SW = 1.5, R = 3;
  let cx = x0, cy = y0;
  for (let it = 0; it < 12; it++) {
    const i0 = Math.round(cx), j0 = Math.round(cy);
    if (i0 < R || j0 < R || i0 >= nx - R || j0 >= ny - R) return null;
    let s = 0, sx = 0, sy = 0;
    for (let j = j0 - R; j <= j0 + R; j++) for (let i = i0 - R; i <= i0 + R; i++) {
      const val = v[j * nx + i] - floor;
      if (val <= 0) continue;
      const dx = i - cx, dy = j - cy, w = Math.exp(-(dx * dx + dy * dy) / (2 * SW * SW)) * val;
      s += w; sx += w * dx; sy += w * dy;
    }
    if (!(s > 0)) return null;
    const mx = 2 * sx / s, my = 2 * sy / s;              // x2: the window halves the offset of a star as wide as itself
    cx += mx; cy += my;
    if (Math.abs(cx - x0) > 2.5 || Math.abs(cy - y0) > 2.5) return null;
    if (Math.abs(mx) < 0.002 && Math.abs(my) < 0.002) break;
  }
  return [cx, cy];
}
const med = (a) => { const b = Float64Array.from(a).sort(); const n = b.length; return n ? (n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2) : NaN; };
/** Typical width (FWHM, in cells) of the field stars of a frame: second moment of the cells above 10 % of the peak
 *  around each star's centre, corrected for that cut (as for a 2-D Gaussian), median over the stars; null if fewer
 *  than 5 stars. Used only to keep the marks on the picture off the object's own light. */
function starFwhm(v, nx, ny, sigma, sat) {
  const w = [];
  for (const s of findStars(v, nx, ny, sigma, sat, 40)) {
    const P = v[s.y * nx + s.x];
    if (!(P > 15 * sigma)) continue;
    const c = centroid(v, nx, ny, s.x, s.y, 1.5 * sigma);
    if (!c) continue;
    let a = 0, r2 = 0;
    for (let j = s.y - 4; j <= s.y + 4; j++) for (let i = s.x - 4; i <= s.x + 4; i++) {
      const val = v[j * nx + i];
      if (!(val > 0.1 * P)) continue;
      a += val; r2 += val * ((i - c[0]) ** 2 + (j - c[1]) ** 2);
    }
    if (a > 0) w.push(2.3548 * Math.sqrt(r2 / a / (2 * 0.744)));
  }
  return w.length >= 5 ? med(w) : null;
}

/** Common shift of the field stars of every frame relative to frame 0, in grid cells: [{ dx, dy, n, rms }]. */
function registerFrames(lin, nx, ny, sigma, sat) {
  const stars = findStars(lin[0], nx, ny, sigma[0], sat);
  const c0 = stars.map((s) => centroid(lin[0], nx, ny, s.x, s.y, 1.5 * sigma[0]));
  const out = [{ dx: 0, dy: 0, n: stars.length, rms: 0 }];
  for (let k = 1; k < lin.length; k++) {
    const dx = [], dy = [];
    stars.forEach((s, j) => {
      if (!c0[j]) return;
      const c = centroid(lin[k], nx, ny, c0[j][0], c0[j][1], 1.5 * sigma[k]);
      if (!c) return;
      const ax = c[0] - c0[j][0], ay = c[1] - c0[j][1];
      if (Math.hypot(ax, ay) < 1.2) { dx.push(ax); dy.push(ay); }
    });
    if (dx.length < 5) { out.push({ dx: 0, dy: 0, n: dx.length, rms: null }); continue; }
    let mx = med(dx), my = med(dy);
    const r = dx.map((x, i) => Math.hypot(x - mx, dy[i] - my)), lim = Math.max(0.12, 3 * 1.4826 * med(r) / 1.1774);
    const kx = dx.filter((_, i) => r[i] <= lim), ky = dy.filter((_, i) => r[i] <= lim);
    if (kx.length >= 5) { mx = kx.reduce((a, b) => a + b, 0) / kx.length; my = ky.reduce((a, b) => a + b, 0) / ky.length; }
    const rms = Math.sqrt(kx.reduce((a, x, i) => a + (x - mx) ** 2 + (ky[i] - my) ** 2, 0) / Math.max(1, kx.length));
    out.push({ dx: mx, dy: my, n: kx.length, rms });
  }
  return out;
}

// ---- the frame set -------------------------------------------------------------------------------------------
/**
 * prepare(frames, opts) -> set
 *   frames: [{ g }]   g = Uint8Array (grey 0..255 of the frame PNG) or Float32Array (stretched 0..1), nx*ny, north up
 *   opts: { nx, ny, stretch: {type:"asinh", lo, hi, soft} | null, cellArcsec, align = true, match = true, floatLevels,
 *           centre: [x, y] (cells; the region the page looks at), targets: [[x, y]] (cells; the target's places: a faint
 *           target sets the brightness scale) }
 * set: { n, nx, ny, S: [Float32Array] (display values 0..1 per frame, level-matched, common scale; not yet shifted),
 *        P: [Float32Array] (the pipeline's own values 0..1, for "raw"), shift: [[dx, dy]] (grid cells, zero mean),
 *        reg: [{dx, dy, n, rms}], sky: [...], sigma: [...] (stretched units), skyLin, sigmaLin (linear, if the stretch
 *        is known), aligned: bool, matched: bool, disp: { black, blackF (per frame), white, soft, gamma, targetPeak, noisy } }
 */
export function prepare(frames, opts = {}) {
  const { nx, ny } = opts, N = nx * ny, n = frames.length;
  const un = makeUnstretch(opts.stretch);
  const P = [], H = [], sky = [], sigma = [], sat = new Uint8Array(N);
  for (const f of frames) {
    const g = f.g, isU8 = g instanceof Uint8Array || g instanceof Uint8ClampedArray;
    const p = new Float32Array(N);
    if (isU8) for (let k = 0; k < N; k++) { p[k] = g[k] / 255; if (g[k] >= 250) sat[k] = 1; }
    else for (let k = 0; k < N; k++) { const x = g[k]; p[k] = x > 0 ? (x < 1 ? x : 1) : 0; if (x >= 0.98) sat[k] = 1; }
    P.push(p);
    const h = histogram(p, isU8 ? 256 : (opts.floatLevels || 1024));
    H.push(h);
    const s = skyStretched(h);
    sky.push(s.m); sigma.push(s.sig);
  }
  // linear values with each season's own sky level taken out
  const lin = [], skyLin = [], sigLin = [];
  for (let f = 0; f < n; f++) {
    const p = P[f], l = new Float32Array(N);
    const s0 = un ? un(sky[f]) : sky[f], sg = un ? un(sky[f]) - un(Math.max(0, sky[f] - sigma[f])) : sigma[f];
    if (un) for (let k = 0; k < N; k++) l[k] = un(p[k]) - s0; else for (let k = 0; k < N; k++) l[k] = p[k] - s0;
    lin.push(l); skyLin.push(s0); sigLin.push(sg > 0 ? sg : 1e-6);
  }
  // large-scale background: a glow or a gradient that only one visit has would flicker in the blink. Block by block
  // (a coarse mesh) every season is brought to what the seasons have in common (their median); structure that all
  // visits share (a bright star's halo, real nebulosity) is not touched. bg[f] = largest change made, in that season's sigma.
  const bg = frames.map(() => 0);
  if (opts.match !== false && opts.mesh !== false && n > 1 && Math.min(nx, ny) >= 40) {
    const B = Math.max(10, Math.round(Math.max(nx, ny) / 6));
    const M = P.map((p, f) => meshSky(p, nx, ny, B, H[f].levels, un)), { bx, by } = M[0];
    const D = M.map((m, f) => Float64Array.from(m.v, (x) => x - skyLin[f]));           // block sky above the season's own level
    const common = Float64Array.from(D[0], (_, b) => med(D.map((d) => d[b]).filter(Number.isFinite)));
    for (let f = 0; f < n; f++) {
      const d = Float64Array.from(D[f], (x, b) => (Number.isFinite(x) && Number.isFinite(common[b]) ? clamp(x - common[b], -6 * sigLin[f], 6 * sigLin[f]) : 0));
      const l = lin[f], p = P[f];
      let big = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!(p[k] > 0)) continue;                                   // no data there: nothing to match
        const c = meshAt(d, bx, by, nx, ny, i, j);
        l[k] -= c;
        if (Math.abs(c) > big) big = Math.abs(c);
      }
      bg[f] = big / sigLin[f];
    }
  }
  // registration on the field stars
  let reg = frames.map(() => ({ dx: 0, dy: 0, n: 0, rms: null })), aligned = false;
  if (opts.align !== false && n > 1) {
    try { reg = registerFrames(lin, nx, ny, sigLin, sat); aligned = reg.slice(1).some((r) => r.rms != null); } catch (_) { /* frames stay as they are */ }
  }
  const ok = reg.map((r, i) => i === 0 || r.rms != null);
  const mx = reg.reduce((a, r, i) => a + (ok[i] ? r.dx : 0), 0) / Math.max(1, ok.filter(Boolean).length);
  const my = reg.reduce((a, r, i) => a + (ok[i] ? r.dy : 0), 0) / Math.max(1, ok.filter(Boolean).length);
  const shift = reg.map((r, i) => (aligned && ok[i] ? [r.dx - mx, r.dy - my] : [0, 0]));
  // one brightness scale for the bin: black a little above the sky (the noise of every season stays dark), an asinh
  // ramp, white at the bright end of the region the page looks at (opts.centre, in cells; else the whole frame),
  // kept between two limits so that neither the noise nor the faint stars are lost
  // (black from the noisiest season: its speckle must stay dark too; the ramp from the typical season)
  const sMax = Math.max(...sigLin), sRef = med(sigLin);
  const black = (opts.blackSigma ?? 1.0) * Math.min(sMax, (opts.blackCap ?? 1.3) * sRef), soft = (opts.softSigma ?? 3) * sRef;
  // a visit much noisier than the others (one exposure next to stacks of fifteen): its own, higher black level, so
  // that its speckle stays as dark as the others' do. The ramp above black is the same for every visit; what that
  // visit loses is only grey that its own noise could have made.
  const blackF = sigLin.map((s) => (s > 1.3 * sRef ? Math.max(black, (opts.blackSigma ?? 1.0) * Math.min(1.3 * s, 3 * sRef)) : black));
  const c = opts.centre || [nx / 2, ny / 2], hw = opts.window || 30;
  const i0 = clamp(Math.round(c[0] - hw), 0, nx - 1), i1 = clamp(Math.round(c[0] + hw), 0, nx - 1), j0 = clamp(Math.round(c[1] - hw), 0, ny - 1), j1 = clamp(Math.round(c[1] + hw), 0, ny - 1);
  let top = 0;
  for (const l of lin) {
    const w = new Float32Array((i1 - i0 + 1) * (j1 - j0 + 1));
    let q = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) w[q++] = l[j * nx + i];
    w.sort();
    top = Math.max(top, w[Math.min(w.length - 1, Math.floor(w.length * 0.999))]);      // about the peak of the brightest thing there
  }
  let white = black + clamp(top - black, soft * Math.sinh(opts.minRange ?? 4), soft * Math.sinh(opts.maxRange ?? 8));
  // a faint target (a cold brown dwarf among brighter stars) would stay a dim grey on the scale of the brightest star
  // nearby: the scale then follows the target instead (its brightest visit at ~88 % of white; brighter stars go white).
  // Only for a real source (8 sigma or more) at the target's places (opts.targets, cells); never a steeper ramp than
  // asinh 3.2, so the noise stays dark. Display only.
  let targetPeak = null;
  if (opts.targets && opts.targets.length) {
    const R = opts.targetBox ?? 2;
    let tp = -Infinity;
    for (const l of lin) for (const t of opts.targets) {
      const ti = Math.round(t[0]), tj = Math.round(t[1]);
      for (let j = Math.max(0, tj - R); j <= Math.min(ny - 1, tj + R); j++) for (let i = Math.max(0, ti - R); i <= Math.min(nx - 1, ti + R); i++) if (l[j * nx + i] > tp) tp = l[j * nx + i];
    }
    const A0 = Math.asinh((white - black) / soft);
    if (tp >= 8 * sRef) {
      const At = Math.max(opts.targetMinRange ?? 3.2, Math.asinh((tp - black) / soft) / 0.88);
      if (At < A0) { white = black + soft * Math.sinh(At); targetPeak = tp; }
    }
  }
  const A = Math.asinh((white - black) / soft);
  // a little more contrast at the top when the range is wide (a bright star keeps a core instead of a flat white disc);
  // a scale set by a faint target: a darker toe (gamma 1.5) keeps the speckle near black while the target stays bright
  const disp = { black, blackF, soft, white, gamma: opts.gamma ?? (targetPeak != null ? 1.5 : clamp(1.15 + 0.15 * (A - 4), 1.15, 1.6)), sigma: sRef, targetPeak,
    noisy: blackF.map((b) => b > black) };
  const S = lin.map((l, f) => {
    const s = new Float32Array(N), b0 = blackF[f];
    for (let k = 0; k < N; k++) { const x = (l[k] - b0) / disp.soft; s[k] = x > 0 ? Math.min(1, Math.asinh(x) / A) : 0; }
    return s;
  });
  if (opts.match === false) for (let f = 0; f < n; f++) S[f] = P[f];
  let fwhm = null;
  try { fwhm = starFwhm(lin[0], nx, ny, sigLin[0], sat); } catch (_) { /* no width: the marks use a default */ }
  return { n, nx, ny, S, P, lin, shift, reg, sky, sigma, skyLin, sigmaLin: sigLin, aligned, matched: opts.match !== false, bg, disp, sat, fwhm,
    cellArcsec: opts.cellArcsec || null, hasStretch: !!un };
}

// ---- drawing on a finer grid ---------------------------------------------------------------------------------
// cubic kernel family of Mitchell and Netravali: B = 1, C = 0 is the cubic B-spline (soft, never rings)
function kernel(B, C) {
  return (x) => {
    x = Math.abs(x);
    if (x < 1) return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
    if (x < 2) return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
    return 0;
  };
}
const SOFT = kernel(1, 0), CRISP = kernel(1 / 3, 1 / 3);
function taps(nOut, nIn, up, shift, k) {
  const idx = new Int32Array(nOut * 4), w = new Float32Array(nOut * 4);
  for (let X = 0; X < nOut; X++) {
    const s = (X + 0.5) / up - 0.5 + shift, f = Math.floor(s), t = s - f;
    let sum = 0;
    for (let a = 0; a < 4; a++) { const ww = k(t + 1 - a); w[X * 4 + a] = ww; sum += ww; idx[X * 4 + a] = clamp(f - 1 + a, 0, nIn - 1); }
    for (let a = 0; a < 4; a++) w[X * 4 + a] /= sum;
  }
  return { idx, w };
}
/** Frame `src` (nx*ny floats) drawn `up` times finer and moved by -shift: out(p) = src(p + shift). Float32Array (nx*up) x (ny*up). */
export function resample(src, nx, ny, up, shift = [0, 0], crisp = false) {
  const W = nx * up, Hh = ny * up, k = crisp ? CRISP : SOFT;
  const tx = taps(W, nx, up, shift[0], k), ty = taps(Hh, ny, up, shift[1], k);
  const tmp = new Float32Array(W * ny), out = new Float32Array(W * Hh);
  for (let j = 0; j < ny; j++) {
    const r = j * nx, o = j * W;
    for (let X = 0; X < W; X++) { const a = X * 4; tmp[o + X] = src[r + tx.idx[a]] * tx.w[a] + src[r + tx.idx[a + 1]] * tx.w[a + 1] + src[r + tx.idx[a + 2]] * tx.w[a + 2] + src[r + tx.idx[a + 3]] * tx.w[a + 3]; }
  }
  for (let Y = 0; Y < Hh; Y++) {
    const a = Y * 4, r0 = ty.idx[a] * W, r1 = ty.idx[a + 1] * W, r2 = ty.idx[a + 2] * W, r3 = ty.idx[a + 3] * W;
    const w0 = ty.w[a], w1 = ty.w[a + 1], w2 = ty.w[a + 2], w3 = ty.w[a + 3], o = Y * W;
    for (let X = 0; X < W; X++) out[o + X] = tmp[r0 + X] * w0 + tmp[r1 + X] * w1 + tmp[r2 + X] * w2 + tmp[r3 + X] * w3;
  }
  return out;
}
/** Squares: every cell repeated up x up (no interpolation, no shift). */
export function blocks(src, nx, ny, up) {
  const W = nx * up, out = new Float32Array(W * ny * up);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = src[j * nx + i];
    for (let b = 0; b < up; b++) { const o = (j * up + b) * W + i * up; for (let a = 0; a < up; a++) out[o + a] = v; }
  }
  return out;
}
/** Frame i of the set as display values 0..1 on the fine grid. raw: the pipeline's own values as squares. */
export function frameFloat(set, i, up, raw = false) {
  if (raw) return blocks(set.P[i], set.nx, set.ny, up);
  return resample(set.S[i], set.nx, set.ny, up, set.shift[i]);
}
/** Mean of several frames (aligned), as display values: "deep". The black level follows the lower noise. */
export function deepFloat(set, idx, up, raw = false) {
  const N = set.nx * set.ny, acc = new Float32Array(N);
  if (raw) {
    for (const i of idx) { const p = set.P[i]; for (let k = 0; k < N; k++) acc[k] += p[k] / idx.length; }
    return blocks(acc, set.nx, set.ny, up);
  }
  const W = set.nx * up, Hh = set.ny * up, out = new Float32Array(W * Hh);
  const d = set.disp, black = d.black / Math.sqrt(idx.length), A = Math.asinh((d.white - black) / d.soft);
  for (const i of idx) {
    const r = resample(set.lin[i], set.nx, set.ny, up, set.shift[i]);
    for (let k = 0; k < out.length; k++) out[k] += r[k];
  }
  for (let k = 0; k < out.length; k++) { const x = (out[k] / idx.length - black) / d.soft; out[k] = x > 0 ? Math.min(1, Math.asinh(x) / A) : 0; }
  return out;
}

// ---- pictures (RGBA) -----------------------------------------------------------------------------------------
const lut = (gamma) => { const t = new Uint8ClampedArray(4097); for (let k = 0; k <= 4096; k++) t[k] = Math.round(255 * Math.pow(k / 4096, gamma)); return t; };
const luts = new Map();
const lutFor = (g) => { if (!luts.has(g)) luts.set(g, lut(g)); return luts.get(g); };
/** Grey picture. */
export function greyRgba(v, out, gamma = 1) {
  const t = lutFor(gamma);
  for (let k = 0, o = 0; k < v.length; k++, o += 4) { const g = t[clamp(v[k], 0, 1) * 4096 | 0]; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
  return out;
}
// Time as colour: the first season in blue, the last in orange. The two colours add up to white, so a star that
// did not change comes out neutral grey/white and one that moved shows as a blue and an orange spot.
export const TIME_A = [0.10, 0.52, 1.0], TIME_B = [0.90, 0.48, 0.0];
export function timeColourRgba(a, b, out, gamma = 1) {
  const t = lutFor(gamma);
  for (let k = 0, o = 0; k < a.length; k++, o += 4) {
    const x = t[clamp(a[k], 0, 1) * 4096 | 0], y = t[clamp(b[k], 0, 1) * 4096 | 0];
    out[o] = x * TIME_A[0] + y * TIME_B[0]; out[o + 1] = x * TIME_A[1] + y * TIME_B[1]; out[o + 2] = x * TIME_A[2] + y * TIME_B[2]; out[o + 3] = 255;
  }
  return out;
}
// Difference (later minus earlier) on the blue - white - red scale the pipeline uses (RdBu_r, +-lim of the display range)
const RDBU = ["#053061", "#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b", "#67001f"]
  .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
export function diffRgba(a, b, out, lim = 0.6) {
  for (let k = 0, o = 0; k < a.length; k++, o += 4) {
    const v = clamp(((b[k] - a[k]) / lim + 1) / 2, 0, 1) * 10, i = Math.min(9, v | 0), t = v - i, c0 = RDBU[i], c1 = RDBU[i + 1];
    out[o] = c0[0] + (c1[0] - c0[0]) * t; out[o + 1] = c0[1] + (c1[1] - c0[1]) * t; out[o + 2] = c0[2] + (c1[2] - c0[2]) * t; out[o + 3] = 255;
  }
  return out;
}
/** Brightest value of each pixel over several frames ("trail"). */
export function maxOf(list) {
  const out = Float32Array.from(list[0]);
  for (let f = 1; f < list.length; f++) { const v = list[f]; for (let k = 0; k < out.length; k++) if (v[k] > out[k]) out[k] = v[k]; }
  return out;
}

// ---- numbers for the page and for tests ------------------------------------------------------------------------
/** rms of the season-to-season difference in the sky cells (cells below +3 sigma in both frames), in display grey levels (0..255). */
export function skyDiffRms(a, b, mask) {
  let s = 0, n = 0;
  for (let k = 0; k < a.length; k++) if (!mask || mask[k]) { const d = (b[k] - a[k]) * 255; s += d * d; n++; }
  return n ? Math.sqrt(s / n) : NaN;
}
/** Cells that are sky in every frame of the set (pipeline values below sky + 3 sigma). */
export function skyMask(set) {
  const N = set.nx * set.ny, m = new Uint8Array(N).fill(1);
  for (let f = 0; f < set.n; f++) { const p = set.P[f], lim = set.sky[f] + 3 * set.sigma[f]; for (let k = 0; k < N; k++) if (p[k] > lim) m[k] = 0; }
  return m;
}
/** Star positions per frame after the set's own shift is applied (for the "stars stay put" check): rms of the residual
 *  frame-to-frame star displacement in grid cells, before and after. */
export function wobble(set) {
  const stars = findStars(set.lin[0], set.nx, set.ny, set.sigmaLin[0], set.sat);
  const c0 = stars.map((s) => centroid(set.lin[0], set.nx, set.ny, s.x, s.y, 1.5 * set.sigmaLin[0]));
  const res = [];
  for (let k = 1; k < set.n; k++) {
    let b = 0, a = 0, n = 0;
    stars.forEach((s, j) => {
      if (!c0[j]) return;
      const c = centroid(set.lin[k], set.nx, set.ny, c0[j][0], c0[j][1], 1.5 * set.sigmaLin[k]);
      if (!c) return;
      const dx = c[0] - c0[j][0], dy = c[1] - c0[j][1];
      if (Math.hypot(dx, dy) > 1.2) return;
      const ex = dx - (set.shift[k][0] - set.shift[0][0]), ey = dy - (set.shift[k][1] - set.shift[0][1]);
      b += dx * dx + dy * dy; a += ex * ex + ey * ey; n++;
    });
    res.push({ n, before: n ? Math.sqrt(b / n) : null, after: n ? Math.sqrt(a / n) : null });
  }
  return res;
}
