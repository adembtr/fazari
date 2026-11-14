// Relative astrometry: calibrate each exposure against Gaia DR3 field stars.
// For every exposure: centroid unsaturated, isolated Gaia stars in native pixels (the same
// Gaussian fit as the target), compare with Gaia moved to the exposure date (proper motion +
// parallax), fit the residual field (shift, plus rotation/scale/shear when there are enough
// stars) with sigma clipping, and evaluate it at the target. The target's centroid minus that
// correction is its calibrated position. Parameters below; the Python pipeline
// (pipeline/ASTROMETRY.md) uses the same method.

import { propagate, offsetArcsec, gaussCentroid, median } from "./astro.js";

export const CALIB = {          // as pipeline/ASTROMETRY.md (CAL_* in blink.py)
  gmaxQuery: 19.0,      // Gaia stars fetched (also used for the isolation test)
  gminCal: 10.0,        // reference stars: 10 <= G <= 17.5, 5/6-parameter solution, RUWE <= 1.4
  gmaxCal: 17.5,
  maxRuwe: 1.4,
  isolation: 12,        // arcsec: no other Gaia star (G < 19) this close
  minTargetSep: 40,     // arcsec from the target's predicted position
  maxFieldRadius: 0.15, // deg from the grid centre
  edge: 7,              // native px from the region edge
  mismatch: 2.0,        // arcsec: |measured - Gaia| above this = mismatch
  minSnr: 20,           // peak S/N of the star (Gaussian fit) per exposure
  clip: 3.0,            // sigma clipping of residual lengths, sigma >= 0.05"
  // pooling per season x detector cell
  cellMinStars: 5, cellMinMeas: 20, cellMaxErr: 0.05, affineMinStars: 12, surround: 0.3,
  minStarsShift: 3,     // single-exposure diagnostic fit
  minStarsAffine: 12,
};

/** Reference stars for a field, from a Gaia star list (G < 19 within the field). */
export function prepareStars(stars, ra0, dec0) {
  const cosd = Math.cos(dec0 * Math.PI / 180);
  const xy = stars.map((s) => [((s.ra - ra0 + 540) % 360 - 180) * cosd * 3600, (s.dec - dec0) * 3600]);
  const cal = [];
  stars.forEach((s, k) => {
    if (!(s.gmag >= CALIB.gminCal && s.gmag <= CALIB.gmaxCal) || !s.has5p) return;
    if (s.ruwe != null && s.ruwe > CALIB.maxRuwe) return;
    if (Math.hypot(xy[k][0], xy[k][1]) > CALIB.maxFieldRadius * 3600) return;
    for (let q = 0; q < stars.length; q++) {
      if (q !== k && Math.hypot(xy[q][0] - xy[k][0], xy[q][1] - xy[k][1]) < CALIB.isolation) return;
    }
    cal.push(s);
  });
  return cal;
}

/**
 * Measure the reference stars in one exposure (same Gaussian estimator as the target).
 * Returns {pts: [{id, x, y (arcsec from the target), rE, rN}], ...single-exposure fit (diagnostic)}.
 */
export function calibrateExposure({ cal, data, sat, W, H, y0, wcs, mjd, target, sigma0, mask = null }) {
  const [tra, tdec] = target;
  const cosd = Math.cos(tdec * Math.PI / 180);
  const pts = [];
  for (const s of cal) {
    const [ra, dec] = propagate(s, mjd, true);
    const dE = ((ra - tra + 540) % 360 - 180) * cosd * 3600, dN = (dec - tdec) * 3600;
    if (Math.hypot(dE, dN) < CALIB.minTargetSep) continue;
    const [x, y] = wcs.skyToPix(ra, dec);
    const yl = y - y0;
    if (!(x >= CALIB.edge && x <= W - 1 - CALIB.edge && yl >= CALIB.edge && yl <= H - 1 - CALIB.edge)) continue;
    let bad = false;     // no saturated or missing pixel in the 5x5 box
    for (let j = Math.round(yl) - 2; j <= Math.round(yl) + 2 && !bad; j++)
      for (let i = Math.round(x) - 2; i <= Math.round(x) + 2; i++) {
        const k = j * W + i;
        if (sat[k] || !Number.isFinite(data[k])) { bad = true; break; }
      }
    if (bad) continue;
    const ci = Math.round(x), cj = Math.round(yl);
    const ok = mask ? (i, j) => !sat[j * W + i] && !mask.has((i - ci) * 1000 + (j - cj)) : (i, j) => !sat[j * W + i];
    const fit = gaussCentroid(data, W, H, ok, x, yl, sigma0);
    if (!fit) continue;
    const peak = fit.amp / (2 * Math.PI * Math.max(fit.sigma, 0.3) ** 2);
    if (peak / sigma0 < CALIB.minSnr || fit.sigma < 0.3 || fit.sigma > 2.0) continue;
    const [mra, mdec] = wcs.pixToSky(fit.x, fit.y + y0);
    const o = offsetArcsec(ra, dec, mra, mdec);
    if (Math.hypot(o[0], o[1]) > CALIB.mismatch) continue;
    pts.push({ id: s.source_id, x: dE, y: dN, rE: o[0], rN: o[1] });
  }
  const r = fitResiduals(pts);
  r.pts = pts;
  return r;
}

/**
 * Pool the reference-star residuals per season x detector cell (ASTROMETRY.md "pooling").
 * exps: [{season, detector, fieldPts}]. Returns Map "season|det" -> {ok, corrE, corrN, errE,
 * errN, nStars, nMeas, rms, model, source: "cell" | "season median" | "none"}.
 */
export function poolCells(exps) {
  const cells = new Map();
  for (const e of exps) {
    if (!e.fieldPts) continue;
    const k = `${e.season}|${e.detector}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(...e.fieldPts);
  }
  const out = new Map();
  for (const [k, pts] of cells) out.set(k, fitCell(pts));
  // cells that fail: median (a, b) of the accepted cells of the same season
  const seasons = new Set(exps.map((e) => e.season));
  for (const season of seasons) {
    const acc = [...out.entries()].filter(([k, c]) => k.startsWith(season + "|") && c.ok);
    for (const e of exps) {
      const k = `${e.season}|${e.detector}`;
      if (e.season !== season) continue;
      const c = out.get(k);
      if (c && c.ok) continue;
      if (acc.length) {
        out.set(k, { ...(c || {}), ok: true, source: "season median", corrE: median(acc.map(([, x]) => x.corrE)),
                     corrN: median(acc.map(([, x]) => x.corrN)), errE: median(acc.map(([, x]) => x.errE)),
                     errN: median(acc.map(([, x]) => x.errN)), nStars: c ? c.nStars : 0, rms: c ? c.rms : NaN });
      } else {
        out.set(k, { ...(c || {}), ok: false, source: "none", reason: c && c.reason ? c.reason : "no reference stars" });
      }
    }
  }
  return out;
}

function fitCell(pts) {
  const distinct = (P) => new Set(P.map((p) => p.id)).size;
  if (!pts.length) return { ok: false, reason: "no reference stars", nStars: 0, nMeas: 0 };
  let use = pts.map(() => true), res;
  const model = (P) => {
    if (distinct(P) < CALIB.affineMinStars) return "shift";
    // stars must surround the target: |mean lever arm| < 0.3 * rms spread
    const mx = P.reduce((a, p) => a + p.x, 0) / P.length, my = P.reduce((a, p) => a + p.y, 0) / P.length;
    const sp = Math.sqrt(P.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / P.length);
    return Math.hypot(mx, my) < CALIB.surround * sp ? "similarity" : "shift";
  };
  for (let it = 0; it < 5; it++) {
    const P = pts.filter((_, i) => use[i]);
    res = fitModel(P, model(P));
    const rr = pts.map((p) => Math.hypot(p.rE - res.eE(p.x, p.y), p.rN - res.eN(p.x, p.y)));
    const sig = Math.max(1.4826 * median(rr.filter((_, i) => use[i])) / 1.1774, 0.05);
    const next = rr.map((r) => r < CALIB.clip * sig);
    if (next.every((v, i) => v === use[i]) || next.filter(Boolean).length < 3) break;
    use = next;
  }
  const P = pts.filter((_, i) => use[i]);
  const m = model(P);
  res = fitModel(P, m);
  const rE = P.map((p) => p.rE - res.eE(p.x, p.y)), rN = P.map((p) => p.rN - res.eN(p.x, p.y));
  const sd = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(a.length - 1, 1));
  const errE = sd(rE) / Math.sqrt(P.length), errN = sd(rN) / Math.sqrt(P.length);
  const nStars = distinct(P);
  const ok = nStars >= CALIB.cellMinStars && P.length >= CALIB.cellMinMeas && errE <= CALIB.cellMaxErr && errN <= CALIB.cellMaxErr;
  return { ok, source: ok ? "cell" : undefined, model: m, corrE: res.a, corrN: res.b, errE, errN, nStars, nMeas: P.length,
           rms: Math.sqrt((sd(rE) ** 2 + sd(rN) ** 2) / 2),
           reason: ok ? undefined : `${nStars} stars, ${P.length} measurements, error ${Math.max(errE, errN).toFixed(2)}″` };
}

/** dE = a + s*x - r*y, dN = b + r*x + s*y (similarity) or dE = a, dN = b (shift); x, y arcsec. */
function fitModel(P, kind) {
  if (kind === "shift" || P.length < 4) {
    const a = P.reduce((s, p) => s + p.rE, 0) / P.length, b = P.reduce((s, p) => s + p.rN, 0) / P.length;
    return { a, b, eE: () => a, eN: () => b };
  }
  // linear least squares in (a, b, s, r), lever arms in degrees for conditioning
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], y = [0, 0, 0, 0];
  const add = (row, v) => { for (let i = 0; i < 4; i++) { y[i] += row[i] * v; for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; } };
  for (const p of P) {
    const x = p.x / 3600, yy = p.y / 3600;
    add([1, 0, x, -yy], p.rE);
    add([0, 1, yy, x], p.rN);
  }
  const inv = invert(A);
  const c = inv.map((row) => row.reduce((s, v, i) => s + v * y[i], 0));
  const [a, b, sc, r] = c;
  return { a, b, eE: (x, yy) => a + sc * x / 3600 - r * yy / 3600, eN: (x, yy) => b + r * x / 3600 + sc * yy / 3600 };
}

/** Least squares of rE, rN on [1, x, y] (affine) or [1] (shift), 3-sigma clipped. x, y in arcsec from the target. */
export function fitResiduals(pts) {
  const n0 = pts.length;
  if (n0 < CALIB.minStarsShift) return { ok: false, n: n0, reason: n0 ? `only ${n0} usable Gaia star(s)` : "no usable Gaia stars" };
  let use = pts.map(() => true);
  let res;
  for (let it = 0; it < 6; it++) {
    const P = pts.filter((_, k) => use[k]);
    const affine = P.length >= CALIB.minStarsAffine;
    res = solve(P, affine);
    const rr = pts.map((p) => Math.hypot(p.rE - res.evalE(p.x, p.y), p.rN - res.evalN(p.x, p.y)));
    // per-axis sigma from the median of a 2D Rayleigh (median = 1.1774 sigma)
    const sig = Math.max(median(rr.filter((_, k) => use[k])) / 1.1774, 0.02);
    const next = rr.map((r) => r < CALIB.clip * sig);
    if (next.filter(Boolean).length < CALIB.minStarsShift) break;
    if (next.every((v, k) => v === use[k])) break;
    use = next;
  }
  const P = pts.filter((_, k) => use[k]);
  const affine = P.length >= CALIB.minStarsAffine;
  res = solve(P, affine);
  const npar = affine ? 3 : 1;
  const rE = P.map((p) => p.rE - res.evalE(p.x, p.y)), rN = P.map((p) => p.rN - res.evalN(p.x, p.y));
  const dof = Math.max(P.length - npar, 1);
  const sE = Math.sqrt(rE.reduce((a, v) => a + v * v, 0) / dof), sN = Math.sqrt(rN.reduce((a, v) => a + v * v, 0) / dof);
  // error of the model at the target (x = y = 0): sigma * sqrt((A^T A)^-1 [0,0])
  const c00 = res.c00;
  return {
    ok: true, n: n0, nUsed: P.length, model: affine ? "affine" : "shift",
    corrE: res.evalE(0, 0), corrN: res.evalN(0, 0),
    errE: sE * Math.sqrt(c00), errN: sN * Math.sqrt(c00),
    rms: Math.sqrt((sE * sE + sN * sN) / 2),
    coefE: res.cE, coefN: res.cN,
  };
}

function solve(P, affine) {
  const rows = P.map((p) => (affine ? [1, p.x / 3600, p.y / 3600] : [1]));   // x, y in degrees: better conditioned
  const m = rows[0].length;
  const ATA = Array.from({ length: m }, () => new Array(m).fill(0));
  const bE = new Array(m).fill(0), bN = new Array(m).fill(0);
  rows.forEach((r, k) => {
    for (let a = 0; a < m; a++) {
      bE[a] += r[a] * P[k].rE; bN[a] += r[a] * P[k].rN;
      for (let b = 0; b < m; b++) ATA[a][b] += r[a] * r[b];
    }
  });
  const inv = invert(ATA);
  const mul = (b) => inv.map((row) => row.reduce((s, v, i) => s + v * b[i], 0));
  const cE = mul(bE), cN = mul(bN);
  const ev = (c) => (x, y) => (affine ? c[0] + c[1] * x / 3600 + c[2] * y / 3600 : c[0]);
  return { cE, cN, evalE: ev(cE), evalN: ev(cN), c00: inv[0][0] };
}

function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row.slice(n));
}

// ---- saturated reference stars (bias of the wing-only centroid of a saturated star) -------------
// A saturated star's centroid comes from its wings only; with SPHEREx's asymmetric PSF that is
// biased by ~0.5" in a direction fixed to the detector. Bright catalogue stars in the SAME
// exposure and the SAME detector rows (same wavelength along the LVF) are saturated too: they
// are measured exactly like the target and their offsets from the catalogue give the bias.
export const SATCAL = {
  isolation: 30,        // arcsec to any other bright catalogue star
  edge: 7,
  maxOffsetPx: 2.0,
  minStars: 3,
  clip: 3.0,
  maskRatio: 3.0,       // reference star's masked-pixel count within x3 of the target's
};

/** Measure saturated catalogue stars in the region. bright: [{ra, dec, epoch, pmra, pmdec, plx, mag}].
 * targetMask: number of unusable pixels in the target's 11x11 fit box. Returns residual stats. */
export function calibrateSaturated({ bright, data, sat, W, H, y0, wcs, mjd, sigma0, target, targetMask }) {
  const pts = [];
  const pos = bright.map((s) => propagate(s, mjd, true));
  const [tra, tdec] = target;
  const cosd = Math.cos(tdec * Math.PI / 180);
  for (let k = 0; k < bright.length; k++) {
    const [ra, dec] = pos[k];
    if (Math.hypot(((ra - tra + 540) % 360 - 180) * cosd, dec - tdec) * 3600 < 30) continue;   // the target itself
    const [x, y] = wcs.skyToPix(ra, dec);
    const yl = y - y0;
    if (!(x >= SATCAL.edge && x <= W - 1 - SATCAL.edge && yl >= SATCAL.edge && yl <= H - 1 - SATCAL.edge)) continue;
    let crowded = false;
    const cd = Math.cos(dec * Math.PI / 180);
    for (let q = 0; q < bright.length && !crowded; q++) {
      if (q !== k && Math.hypot((pos[q][0] - ra) * cd, pos[q][1] - dec) * 3600 < SATCAL.isolation) crowded = true;
    }
    if (crowded) continue;
    const ci = Math.round(x), cj = Math.round(yl);
    let nmask = 0, ncore = 0;
    for (let j = cj - 5; j <= cj + 5; j++) for (let i = ci - 5; i <= ci + 5; i++) {
      const kk = j * W + i;
      const bad = sat[kk] || !Number.isFinite(data[kk]);
      if (bad) nmask++;
      if (sat[kk] && Math.abs(i - ci) <= 1 && Math.abs(j - cj) <= 1) ncore++;
    }
    if (!ncore) continue;                                   // not saturated
    if (targetMask && (nmask > targetMask * SATCAL.maskRatio || nmask * SATCAL.maskRatio < targetMask)) continue;
    const fit = gaussCentroid(data, W, H, (i, j) => !sat[j * W + i], x, yl, sigma0);
    if (!fit || Math.hypot(fit.x - x, fit.y - yl) > SATCAL.maxOffsetPx) continue;
    const [mra, mdec] = wcs.pixToSky(fit.x, fit.y + y0);
    const o = offsetArcsec(ra, dec, mra, mdec);
    pts.push({ rE: o[0], rN: o[1], nmask, mag: bright[k].mag, x: fit.x, y: fit.y + y0 });
  }
  if (pts.length < SATCAL.minStars) return { ok: false, n: pts.length, reason: `only ${pts.length} saturated reference star(s)`, pts };
  let use = pts.map(() => true);
  let mE = 0, mN = 0;
  for (let it = 0; it < 6; it++) {
    const P = pts.filter((_, i) => use[i]);
    mE = median(P.map((p) => p.rE)); mN = median(P.map((p) => p.rN));
    const rr = pts.map((p) => Math.hypot(p.rE - mE, p.rN - mN));
    const sig = Math.max(median(rr.filter((_, i) => use[i])) / 1.1774, 0.05);
    const next = rr.map((r) => r < SATCAL.clip * sig);
    if (next.filter(Boolean).length < SATCAL.minStars || next.every((v, i) => v === use[i])) break;
    use = next;
  }
  const P = pts.filter((_, i) => use[i]);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const corrE = mean(P.map((p) => p.rE)), corrN = mean(P.map((p) => p.rN));
  const sE = Math.sqrt(mean(P.map((p) => (p.rE - corrE) ** 2)) * P.length / Math.max(P.length - 1, 1));
  const sN = Math.sqrt(mean(P.map((p) => (p.rN - corrN) ** 2)) * P.length / Math.max(P.length - 1, 1));
  return { ok: true, n: pts.length, nUsed: P.length, corrE, corrN, errE: sE / Math.sqrt(P.length), errN: sN / Math.sqrt(P.length),
           rms: Math.sqrt((sE * sE + sN * sN) / 2), model: "saturated stars", pts };
}
