// Challenge-item tools that run next to the blink engine (in the Web Worker of sky.html, or on the main
// thread in the inline fallback). They only use what the SkySession already holds in memory: no download.
//   chHandle(session, "spectrum",  {ra, dec, useTarget, name})  -> fazari-spectrum/1 (instant spectrum)
//   chHandle(session, "deep",      {um, seasons})                -> deep image of a wavelength bin (sum of dates)
//   chHandle(session, "frameinfo", {um})                         -> per season: images, times, wavelengths, flags
// Hooks: worker.js ({type: "ch", id, op, args}), engine.js (Engine.ch), sky.js (ex.wave, ex.flagStats).

import { propagate, mjdToDate, median, percentile } from "./astro.js";
import { build, toRow, finishRows, STATUS_LABELS } from "./spectrum.js";
import { fillNaN } from "./sky.js";
import { GROUPS } from "./ch_flags.js";

// ---- instant spectrum: aperture photometry on the reprojected exposures --------------------------------
export const AP = {
  rArcsec: 15, annArcsec: [30, 45], nBlank: 24, satArcsec: 6, maxMissing: 0.2, snrDet: 3,
  // encircled energy of the SPHEREx EPSF inside 15" after the bilinear reprojection onto the 3" grid, with
  // the 30-45" annulus median subtracted: simulated with the EPSF tables of real images (2 files x 2 table
  // rows x 30 random offsets per detector; scatter 0.003-0.011). Same total-flux scale as the PSF fit.
  ee: { 1: 0.979, 2: 0.977, 3: 0.965, 4: 0.969, 5: 0.970, 6: 0.971 },
};
const METHOD = "Instant spectrum (in-browser engine): aperture photometry on the blink's own exposures, no extra download. "
  + "Each exposure is IMAGE - ZODI with the bad FLAGS masked, reprojected onto the 3\" north-up grid of the blink "
  + "(the same pixels as the blink frames). Flux = sum in a 15\" radius aperture minus the median of a 30-45\" annulus, "
  + "x pixel solid angle -> uJy, divided by the encircled energy of the SPHEREx EPSF in that aperture (0.965-0.979 per "
  + "detector). Error = robust scatter of the same aperture at 24 empty positions of the same exposure. Wavelength and "
  + "bandwidth at the object's own detector pixel (WCS-WAVE). Saturated core within 6\": no estimate.";
const CAVEAT0 = "Instant spectrum: aperture photometry, not the PSF fit of the target spectrum. A neighbour within ~20\" adds "
  + "its light (blend); crowded fields read high. Only the exposures loaded for the blink (a few per season near each bin centre).";

const g = (v) => (Number.isFinite(v) ? v : null);
function robustSigma(a) {
  const v = a.filter(Number.isFinite);
  if (v.length < 5) return NaN;
  const m = median(v);
  return 1.4826 * median(v.map((x) => Math.abs(x - m)));
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Aperture sum at grid position (x, y): {sum, n, missing, satCore, satAp, bg}. */
function aperture(img, sat, n, x, y, rPx, ann, satPx) {
  const R = Math.ceil(ann[1]) + 1, ix = Math.round(x), iy = Math.round(y);
  const annVals = [];
  const apIdx = [];
  let satCore = 0, satAp = 0, nAp = 0;
  for (let j = iy - R; j <= iy + R; j++) for (let i = ix - R; i <= ix + R; i++) {
    const r = Math.hypot(i - x, j - y);
    const inside = i >= 0 && j >= 0 && i < n && j < n;
    if (r <= rPx) {
      nAp++;
      if (!inside) continue;
      const k = j * n + i;
      if (sat[k]) { satAp++; if (r <= satPx) satCore++; }
      apIdx.push([k, i, j]);
    } else if (inside && r >= ann[0] && r < ann[1]) {
      const k = j * n + i, v = img[k];
      if (Number.isFinite(v) && !sat[k]) annVals.push(v);
    }
  }
  if (annVals.length < 20) return null;
  const bg = median(annVals);
  let sum = 0, missing = 0;
  for (const [k, i, j] of apIdx) {
    let v = img[k];
    if (!Number.isFinite(v) || sat[k]) {
      // missing pixel: the point-mirrored pixel through the source (same distance), else background
      const mi = Math.round(2 * x - i), mj = Math.round(2 * y - j), mk = mj * n + mi;
      const mv = mi >= 0 && mj >= 0 && mi < n && mj < n && !sat[mk] ? img[mk] : NaN;
      v = Number.isFinite(mv) ? mv : bg;
      missing++;
    }
    sum += v - bg;
  }
  missing += nAp - apIdx.length;
  return { sum, n: nAp, missing, satCore, satAp, bg };
}

export function instantSpectrum(session, { ra, dec, useTarget = false, name = null } = {}) {
  const G = session.grid, n = session.n, pix = session.cfg.pixArcsec;
  const rPx = AP.rArcsec / pix, ann = AP.annArcsec.map((a) => a / pix), satPx = AP.satArcsec / pix;
  const toUjy = 1e12 * pix * pix / 206264.806 ** 2;
  const seen = new Set();
  const list = session.exposures.filter((e) => e.reproj && e.img && !seen.has(e.img.url) && seen.add(e.img.url));
  if (!list.length) throw new Error("no full-result exposures loaded yet");
  const infos = [];
  let nOutside = 0;
  for (const ex of list) {
    const [a, d] = useTarget && session.target ? session.posAt(ex.mjd) : [ra, dec];
    const [x, y] = G.skyToPix(a, d);
    const [xn, yn] = ex.wcs ? ex.wcs.skyToPix(a, d) : [ex.x, ex.y];
    let lam = ex.lam, bw = ex.bw;
    if (ex.wave) { try { [lam, bw] = ex.wave.at(xn, yn); } catch (_) { /* keep the target's */ } }
    const info = { file: ex.img.url.split("/").pop(), obs_id: ex.img.obs_id, collection: ex.img.collection, season: ex.season,
                   mjd: ex.mjd, date: mjdToDate(ex.mjd), detector: `D${ex.detector}`, x: xn, y: yn, ra_pred: a, dec_pred: d,
                   wavelength_um: lam, bandwidth_um: bw, inside: true, _blank: [] };
    const A = x >= 0 && y >= 0 && x <= n - 1 && y <= n - 1 ? aperture(ex.reproj, ex.sat, n, x, y, rPx, ann, satPx) : null;
    if (!A || (A.missing >= 0.9 * A.n && !A.satCore) || !Number.isFinite(lam)) { nOutside++; continue; }   // off this image
    info.pixel_area_arcsec2 = pix * pix;
    info.sat_core_px = A.satCore;
    info.saturated = A.satCore > 0;
    info.n_pix = A.n - A.missing;
    info.flags_at_target = null;
    if (info.saturated) { info.status = "saturated"; info.method = ""; infos.push(info); continue; }
    if (A.missing > AP.maxMissing * A.n) { info.status = "flagged"; info.method = "aperture"; infos.push(info); continue; }
    // noise: the same aperture at empty positions of this exposure (>= 2 apertures away from the object)
    const rnd = rng(Math.round(ex.mjd * 1e5) ^ Math.round(x * 977) ^ Math.round(y * 131));
    const blanks = [];
    for (let t = 0; blanks.length < AP.nBlank && t < 6 * AP.nBlank; t++) {
      const bx = ann[1] + rnd() * (n - 1 - 2 * ann[1]), by = ann[1] + rnd() * (n - 1 - 2 * ann[1]);
      if (Math.hypot(bx - x, by - y) < 2 * ann[1]) continue;
      const B = aperture(ex.reproj, ex.sat, n, bx, by, rPx, ann, satPx);
      if (B && !B.satAp && B.missing <= 0.05 * B.n) blanks.push(B.sum);
    }
    const sig = robustSigma(blanks);
    const ee = AP.ee[ex.detector] || 0.97;
    info.flux_ujy = A.sum * toUjy / ee;
    info.flux_err_var_ujy = Number.isFinite(sig) && sig > 0 ? sig * toUjy / ee : NaN;
    info.psf_frac_used = 1 - A.missing / A.n;
    info.method = "aperture";
    info.status = Number.isFinite(info.flux_err_var_ujy) ? "measured" : "no_fit";
    if (info.status === "no_fit") delete info.flux_ujy;
    infos.push(info);
  }
  finishRows(infos);                 // S/N, detection / 3-sigma upper limit, AB magnitudes (noise_scale 1: no _blank)
  const label = name || (useTarget && session.target ? session.target.name : `RA ${ra.toFixed(5)} Dec ${dec.toFixed(5)}`);
  const spec = build({ target: label, ra: useTarget ? session.ra0 : ra, dec: useTarget ? session.dec0 : dec, rows: infos.map(toRow), nOutside,
                       extra: { n_files: list.length, instant: true } });
  spec.method = METHOD;
  spec.kind = "instant-aperture";
  spec.status_labels = { ...STATUS_LABELS, flagged: "flagged (more than 20 % of the aperture without data; not binned)" };
  spec.parameters = { ...spec.parameters, aperture_radius_arcsec: AP.rArcsec, annulus_arcsec: AP.annArcsec, encircled_energy: AP.ee,
                      empty_apertures: AP.nBlank, saturated_core_arcsec: AP.satArcsec, stamp_px: undefined, position_check_snr: undefined,
                      position_max_offset_px: undefined, min_psf_frac: undefined, wing_min_psf_frac: undefined };
  // keep the existing caveats on saturation, time and the browser engine; the first one (PSF flux check) is
  // about the PSF fit and is replaced by the aperture method's own note
  spec.caveats = [CAVEAT0, ...(spec.caveats || []).slice(1)];
  return spec;
}

// ---- deep image: the sum of the dates (all exposures of one bin, aligned on the same grid) --------------
export function deepImage(session, { um, seasons = null } = {}) {
  const r = session.results[um];
  if (!r) throw new Error(`bin ${um} um is not loaded`);
  const want = seasons && seasons.length ? new Set(seasons) : null;
  const ex = session.exposures.filter((e) => e.bin === um && e.reproj && (!want || want.has(e.season)));
  if (ex.length < 2) throw new Error("fewer than 2 exposures for a deep image");
  const n = session.n, N = n * n, img = new Float32Array(N), sat = new Uint8Array(N);
  const v = new Float64Array(ex.length);
  for (let k = 0; k < N; k++) {
    let m = 0, ns = 0;
    for (const e of ex) { const x = e.reproj[k]; if (Number.isFinite(x)) v[m++] = x; ns += e.sat[k]; }
    sat[k] = ns * 2 > ex.length ? 1 : 0;
    if (!m) { img[k] = NaN; continue; }
    // trimmed mean (drop the lowest and highest value from 5 exposures on): cosmic rays and stray pixels out
    const a = v.subarray(0, m);
    if (m >= 5) a.sort();
    const lo = m >= 5 ? 1 : 0, hi = m >= 5 ? m - 1 : m;
    let s = 0;
    for (let q = lo; q < hi; q++) s += a[q];
    img[k] = s / (hi - lo);
  }
  const stretch = (arr) => {
    const fin = [];
    for (let k = 0; k < N; k++) if (Number.isFinite(arr[k]) && !sat[k]) fin.push(arr[k]);
    const sorted = Float64Array.from(fin).sort();
    const med = percentile(sorted, 50);
    const mad = 1.4826 * median(fin.map((x) => Math.abs(x - med)));
    return { med, mad, lo: med - 1.5 * mad, hi: percentile(sorted, 99.97), soft: 3 * mad || 1e-3 };
  };
  const st = stretch(img);
  // noise of one season frame (the median per season the blink shows) against the deep image, same pixels
  const single = r.frames.map((f) => (f.img ? stretch(f.img).mad : NaN)).filter(Number.isFinite);
  const den = Math.asinh((st.hi - st.lo) / st.soft);
  const norm = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const x = img[k];
    norm[k] = sat[k] ? 1 : Number.isFinite(x) ? Math.min(1, Math.max(0, Math.asinh((x - st.lo) / st.soft) / den)) : NaN;
  }
  fillNaN(norm, n);
  const used = [...new Set(ex.map((e) => e.season))];
  const mjds = ex.map((e) => e.mjd);
  return { um, n, norm, nExp: ex.length, seasons: session.seasons.map((s) => s.label).filter((s) => used.includes(s)),
           detectors: [...new Set(ex.map((e) => `D${e.detector}`))].sort(), dateFirst: mjdToDate(Math.min(...mjds)), dateLast: mjdToDate(Math.max(...mjds)),
           noiseGain: single.length ? median(single) / st.mad : null, satPx: sat.reduce((a, b) => a + b, 0) };
}

// ---- frame information: per season of one bin -----------------------------------------------------------
export function frameInfo(session, { um } = {}) {
  const out = [];
  for (const s of session.seasons) {
    const ex = session.exposures.filter((e) => e.bin === um && e.season === s.label);
    if (!ex.length) continue;
    const imgs = ex.slice().sort((a, b) => a.mjd - b.mjd).map((e) => {
      const fs = e.flagStats || null;
      return { obs: `${e.img.obs_id}D${e.detector}`, file: e.img.url.split("/").pop(), mjd: e.mjd, det: `D${e.detector}`,
               lam: g(e.lam), bw: g(e.bw), nBox: fs ? fs.nBox : 0,
               share: fs && fs.nBox ? { saturated: fs.groups.saturated / fs.nBox, bad: fs.groups.bad / fs.nBox, other: fs.groups.other / fs.nBox, any: fs.groups.any / fs.nBox } : null,
               names: fs && fs.nBox ? Object.fromEntries(Object.entries(fs.byName).map(([k, v]) => [k, v / fs.nBox])) : null };
    });
    const withF = imgs.filter((i) => i.share);
    const mean = (f) => (withF.length ? withF.reduce((a, i) => a + f(i), 0) / withF.length : null);
    const names = {};
    for (const i of withF) for (const [k, v] of Object.entries(i.names)) names[k] = (names[k] || 0) + v / withF.length;
    const lo = Math.min(...imgs.filter((i) => i.lam).map((i) => i.lam - (i.bw || 0) / 2));
    const hi = Math.max(...imgs.filter((i) => i.lam).map((i) => i.lam + (i.bw || 0) / 2));
    out.push({ season: s.label, n: imgs.length, mjdFirst: imgs[0].mjd, mjdLast: imgs[imgs.length - 1].mjd,
               detectors: [...new Set(imgs.map((i) => i.det))].sort(), lamLo: g(lo), lamHi: g(hi),
               share: withF.length ? { saturated: mean((i) => i.share.saturated), bad: mean((i) => i.share.bad), other: mean((i) => i.share.other), any: mean((i) => i.share.any) } : null,
               names, images: imgs });
  }
  return { um, groups: GROUPS, seasons: out };
}

export async function chHandle(session, op, args = {}) {
  if (!session) throw new Error("no session");
  if (op === "spectrum") return instantSpectrum(session, args);
  if (op === "deep") return deepImage(session, args);
  if (op === "frameinfo") return frameInfo(session, args);
  throw new Error(`unknown op ${op}`);
}
