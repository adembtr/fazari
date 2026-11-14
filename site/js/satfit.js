// Saturated star in the browser (tarayici_olcum, 14 Nov 2026): position from the unsaturated wings, and the
// per-detector centroid bias from a joint fit over both spacecraft orientations (port of pipeline/blink.py
// joint_fit). Used by sky.js for a plain coordinate only.
//
// 1. symmetryCentre(): a very bright star (core of >= SAT.bigCorePx saturated pixels, e.g. a G = 4.6 star) leaves
//    too few pixels in the 11 x 11 box of the Gaussian fit, and a Gaussian of width 0.6 px started on the edge
//    of a 5 px core sees no light at all: the fit never leaves its start (astro.js gaussCentroid, and blink.py
//    centroid, the same). Instead: the point about which the ring of unsaturated pixels around the core is most
//    symmetric (each pixel compared with the bilinear value at its mirror image through the centre). No PSF
//    model; a PSF asymmetry gives a bias fixed to the detector, which step 2 removes.
// 2. jointBias(): meas_i = P0 + pm (t_i - t0) + J_i b_det over all saturated exposures (field-star corrected
//    positions, east / north arcsec), b_det in detector pixels for each detector that saw the star in both
//    orientations (J_i flips sign when SPHEREx turns 180 deg). pm is free (a measurement), parallax ignored
//    (a plain coordinate has none). 3.5 sigma clipping on the residual length, as blink.py. A detector whose
//    bias the data cannot separate from the motion (error > SAT.maxBiasErrPx) gets no bias.

export const SAT = {
  bigCorePx: 80,        // own saturated core at least this big: symmetry centre instead of the Gaussian
  midCorePx: 20,        // smaller cores: symmetry centre only when the Gaussian fit did not move from its start
  ringWidth: 6,         // px of unsaturated ring used outside the core
  search: 2.0,          // px around the start
  maxFromCore: 1.5,     // px: the centre must stay this close to the core's centroid
  minPairs: 40,
  maxBiasErrPx: 0.25,   // px (1.5"): above this the bias is not determined
  minSpanYr: 0.1,
  minSeasons: 3,        // seasons (exposure groups > 30 d apart) the joint fit needs
  maxPmErr: 0.6,        // "/yr: the fit's own motion error above this = bias and motion not separated
};

const bil = (data, ok, W, H, x, y) => {
  const i = Math.floor(x), j = Math.floor(y);
  if (i < 0 || j < 0 || i + 1 >= W || j + 1 >= H) return NaN;
  const a = j * W + i;
  if (!ok[a] || !ok[a + 1] || !ok[a + W] || !ok[a + W + 1]) return NaN;
  const tx = x - i, ty = y - j;
  return (1 - tx) * (1 - ty) * data[a] + tx * (1 - ty) * data[a + 1] + (1 - tx) * ty * data[a + W] + tx * ty * data[a + W + 1];
};

/** The saturated blob (8-neighbour) that holds the saturated pixel nearest to (x, y) within 3 px. */
export function ownCore(sat, W, H, x, y, lim = 40) {
  let s = -1, best = Infinity;
  for (let j = Math.round(y) - 3; j <= Math.round(y) + 3; j++) for (let i = Math.round(x) - 3; i <= Math.round(x) + 3; i++) {
    if (i < 0 || j < 0 || i >= W || j >= H || !sat[j * W + i]) continue;
    const d = Math.hypot(i - x, j - y);
    if (d < best) { best = d; s = j * W + i; }
  }
  if (s < 0) return null;
  const seen = new Set([s]), st = [s];
  let n = 0, sx = 0, sy = 0, rmax = 0;
  const x0 = s % W, y0 = (s / W) | 0;
  while (st.length) {
    const k = st.pop(), i = k % W, j = (k / W) | 0;
    n++; sx += i; sy += j;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= W || b >= H || Math.abs(a - x0) > lim || Math.abs(b - y0) > lim) continue;
      const q = b * W + a;
      if (sat[q] && !seen.has(q)) { seen.add(q); st.push(q); }
    }
  }
  const cx = sx / n, cy = sy / n;
  for (const k of seen) rmax = Math.max(rmax, Math.hypot((k % W) - cx, ((k / W) | 0) - cy));
  return { n, cx, cy, r: Math.sqrt(n / Math.PI), rmax };
}

/**
 * Symmetry centre of a saturated star. data: region (NaN = bad), sat: 0/1, start: core centroid. Returns
 * {x, y, amp, sigma, bg, npix, chi2, method, rCore, nPairs} (fields of a gaussCentroid result, so sky.js can use
 * it in place: amp = sum of the ring above the background, sigma = null) or null.
 */
export function symmetryCentre(data, sat, W, H, core, sigma0) {
  const ok = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) ok[k] = !sat[k] && Number.isFinite(data[k]) ? 1 : 0;
  const r0 = core.rmax + 1.0, r1 = core.rmax + 1.0 + SAT.ringWidth;
  const P = [];
  for (let j = Math.floor(core.cy - r1 - 1); j <= Math.ceil(core.cy + r1 + 1); j++)
    for (let i = Math.floor(core.cx - r1 - 1); i <= Math.ceil(core.cx + r1 + 1); i++) {
      if (i < 0 || j < 0 || i >= W || j >= H || !ok[j * W + i]) continue;
      const r = Math.hypot(i - core.cx, j - core.cy);
      if (r >= r0 && r <= r1) P.push([i, j, data[j * W + i]]);
    }
  if (P.length < SAT.minPairs) return null;
  const bg = P.map((p) => p[2]).sort((a, b) => a - b)[Math.floor(P.length * 0.1)];
  const w = P.map((p) => 1 / (sigma0 * sigma0 + (0.05 * Math.abs(p[2] - bg)) ** 2));
  const cost = (cx, cy) => {
    let s = 0, n = 0;
    for (let k = 0; k < P.length; k++) {
      const v = bil(data, ok, W, H, 2 * cx - P[k][0], 2 * cy - P[k][1]);
      if (!Number.isFinite(v)) continue;
      s += w[k] * (P[k][2] - v) ** 2; n++;
    }
    return n >= SAT.minPairs ? [s / n, n] : [Infinity, n];
  };
  let best = [Infinity, 0, core.cx, core.cy];
  for (let dy = -SAT.search; dy <= SAT.search + 1e-9; dy += 0.1) for (let dx = -SAT.search; dx <= SAT.search + 1e-9; dx += 0.1) {
    const [c, n] = cost(core.cx + dx, core.cy + dy);
    if (c < best[0]) best = [c, n, core.cx + dx, core.cy + dy];
  }
  if (!Number.isFinite(best[0])) return null;
  const xg = best[2], yg = best[3];
  for (let dy = -0.1; dy <= 0.1 + 1e-9; dy += 0.01) for (let dx = -0.1; dx <= 0.1 + 1e-9; dx += 0.01) {
    const [c, n] = cost(xg + dx, yg + dy);
    if (c < best[0]) best = [c, n, xg + dx, yg + dy];
  }
  const [c, nPairs, x, y] = best;
  if (Math.hypot(x - core.cx, y - core.cy) > SAT.maxFromCore) return null;
  if (Math.abs(x - core.cx) > SAT.search - 0.15 || Math.abs(y - core.cy) > SAT.search - 0.15) return null;   // at the edge
  const amp = P.reduce((a, p) => a + p[2] - bg, 0);
  return { x, y, amp, sigma: null, bg, npix: P.length, chi2: c, method: "symmetry", rCore: core.r, nPairs };
}

// ---- joint fit (blink.py joint_fit) ---------------------------------------------------------------
function solveSym(A, b) {     // Gauss-Jordan; returns [x, inverse] or null
  const n = b.length, M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)), b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-10) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let k = 0; k <= 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let k = 0; k <= 2 * n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M.map((r) => r[2 * n]), M.map((r) => r.slice(n, 2 * n))];
}

/**
 * exps: [{mjd, detector, orient (deg), jac [[dE/dx, dE/dy], [dN/dx, dN/dy]] (arcsec/px), E, N (arcsec, field-star
 * corrected offset from a fixed point)}]. Returns {ok, bias: {det: {dx, dy, errX, errY, n}}, pm: [E, N] "/yr,
 * pmErr, rms, nUsed, nClipped, dets, use: [bool per exposure]} or {ok: false, reason}.
 */
export function jointBias(exps) {
  if (exps.length < 6) return { ok: false, reason: "fewer than 6 saturated exposures" };
  const t = exps.map((e) => (e.mjd - 51544.5) / 365.25);
  const tm = t.reduce((a, b) => a + b, 0) / t.length;
  if (Math.max(...t) - Math.min(...t) < SAT.minSpanYr) return { ok: false, reason: "time span too short" };
  let dets = [];
  const byDet = new Map();
  exps.forEach((e) => { if (!byDet.has(e.detector)) byDet.set(e.detector, []); byDet.get(e.detector).push(e.orient * Math.PI / 180); });
  for (const [d, o] of byDet) {
    const c = o.reduce((a, v) => a + Math.cos(v), 0) / o.length, s = o.reduce((a, v) => a + Math.sin(v), 0) / o.length;
    if (Math.hypot(c, s) < 0.7) dets.push(d);           // both orientations
  }
  const fit = (dets, use) => {
    const np = 4 + 2 * dets.length;
    const A = Array.from({ length: np }, () => new Array(np).fill(0)), y = new Array(np).fill(0);
    const row = (e, k, comp) => {
      const r = new Array(np).fill(0);
      r[comp] = 1; r[2 + comp] = t[k] - tm;
      const di = dets.indexOf(e.detector);
      if (di >= 0) { r[4 + 2 * di] = e.jac[comp][0]; r[5 + 2 * di] = e.jac[comp][1]; }
      return r;
    };
    exps.forEach((e, k) => {
      if (!use[k]) return;
      for (const comp of [0, 1]) {
        const r = row(e, k, comp), v = comp ? e.N : e.E;
        for (let a = 0; a < np; a++) { y[a] += r[a] * v; for (let b = 0; b < np; b++) A[a][b] += r[a] * r[b]; }
      }
    });
    const s = solveSym(A, y);
    if (!s) return null;
    const [p, inv] = s;
    const res = exps.map((e, k) => { const rE = row(e, k, 0), rN = row(e, k, 1);
      return [e.E - rE.reduce((a, v, i) => a + v * p[i], 0), e.N - rN.reduce((a, v, i) => a + v * p[i], 0)]; });
    return { p, inv, res, np };
  };
  let use = exps.map(() => true), F = null;
  for (let pass = 0; pass < 8; pass++) {
    for (let it = 0; it < 4; it++) {
      F = fit(dets, use);
      if (!F) break;
      const rr = F.res.map(([a, b]) => Math.hypot(a, b));
      const ru = rr.filter((_, k) => use[k]).sort((a, b) => a - b);
      const sig = Math.max(1.4826 * ru[ru.length >> 1] / 1.1774, 0.02);
      const next = rr.map((r) => r < 3.5 * sig);
      if (next.every((v, k) => v === use[k]) || next.filter(Boolean).length < 6) break;
      use = next;
    }
    if (!F) {                                   // singular: the bias of some detector is not separable
      if (!dets.length) return { ok: false, reason: "singular fit" };
      dets = dets.slice(0, -1); use = exps.map(() => true); continue;
    }
    const nU = use.filter(Boolean).length, dof = Math.max(2 * nU - F.np, 1);
    const s2 = F.res.reduce((a, [x, y], k) => a + (use[k] ? x * x + y * y : 0), 0) / dof;
    F.s2 = s2; F.err = F.inv.map((r, i) => Math.sqrt(Math.max(r[i] * s2, 0)));
    const errB = dets.map((d, i) => Math.max(F.err[4 + 2 * i], F.err[5 + 2 * i]));
    const worst = errB.length ? errB.indexOf(Math.max(...errB)) : -1;
    if (worst >= 0 && errB[worst] > SAT.maxBiasErrPx) { dets = dets.filter((_, i) => i !== worst); use = exps.map(() => true); continue; }
    break;
  }
  if (!F || !F.err) return { ok: false, reason: "fit failed" };
  // two seasons only (opposite orientations): a detector's bias flips sign between them just as a motion would,
  // so the two cannot be told apart (seen: a 0.012"/yr star came out 3.1 +- 1.0"/yr; pm error 1.3"/yr)
  const ts = exps.filter((e, k) => use[k]).map((e) => e.mjd).sort((a, b) => a - b);
  const nSeasons = ts.filter((m, i) => !i || m - ts[i - 1] > 30).length;
  if (nSeasons < SAT.minSeasons) return { ok: false, reason: `${nSeasons} seasons: the detector bias and the motion cannot be told apart`, nSeasons };
  if (Math.max(F.err[2], F.err[3]) > SAT.maxPmErr)
    return { ok: false, reason: `bias and motion not separated (motion error ${(Math.max(F.err[2], F.err[3]) * 1000).toFixed(0)} mas/yr)`, nSeasons };
  const bias = {};
  dets.forEach((d, i) => {
    bias[d] = { ok: true, source: "joint fit", n: exps.filter((e, k) => use[k] && e.detector === d).length,
                dx: F.p[4 + 2 * i], dy: F.p[5 + 2 * i], errX: F.err[4 + 2 * i], errY: F.err[5 + 2 * i] };
  });
  return { ok: dets.length > 0, reason: dets.length ? null : "no detector saw the star in both orientations with enough seasons",
           bias, dets, pm: [F.p[2], F.p[3]], pmErr: [F.err[2], F.err[3]], rms: Math.sqrt(F.s2),
           nUsed: use.filter(Boolean).length, nClipped: use.filter((u) => !u).length, use };
}
