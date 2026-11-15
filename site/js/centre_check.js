// Free sky point: is the fitted "centre source" a real source at the point, and the same source in every
// season? (tarayici_olcum, 14 Nov 2026; used by sky.js for a plain coordinate, never for a catalogue target.)
// Case that needed it: Barnard's Star's Gaia 2016 position. Barnard is ~99" north of it now, so nothing is at
// the point; the old fit locked onto noise, a faint star 30" away, or the edge of Barnard's glow, a different
// thing in each exposure, and the season positions jumped 18-38" (pairs 18-70"/yr).
//
// Per exposure (checkFit): the fit is used only if
//   - it moved from its start (a fit that never left its start values is no measurement),
//   - its peak is >= CENTRE.minSnr x the pixel noise,
//   - its width is a star's (CENTRE.minSigma..maxSigma native px; the bounds 0.25 / 3.0 mean a hot pixel / a slope);
//     narrower than minSigma is kept only right at the point (<= CENTRE.narrowDistPx): a faint star centred on a
//     pixel looks like one bright pixel, its wings lost in the noise (RA 270.7297 Dec -28.7739, crowded bulge field:
//     70 of 72 fits at 0.25 px, S/N 10-40, 0.1-0.3 px from the point, in every season, following the sky across
//     the detector; bright stars fit 0.35-0.7 px). Such a "narrow" fit counts in a season only when two or more
//     of them agree there (sameSource), so one unflagged hot pixel never makes a season position,
//   - it is within CENTRE.maxDistPx native px of the requested point,
//   - its fit box does not touch, and is not next to, the saturated core of ANOTHER star (a core whose centre is
//     > CENTRE.ownCorePx from the fit; "next to" = within 6 + 2 x core radius px: the glow of that star).
// Per season and across seasons (sameSource): a season is used only if its exposures agree with each other
// (median distance from the season median <= CENTRE.seasonScatter"), its brightness agrees with the other
// seasons (unsaturated fits, same wavelength bin: within a factor CENTRE.fluxFactor of the median over seasons),
// and its position is reachable from the other seasons by a star (<= 12"/yr x dt + CENTRE.reachPad").
// Nothing left -> status "not_detected" ("no source at the centre"); a motion is never computed from it.

export const CENTRE = {
  minSnr: 5,
  minSigma: 0.3, maxSigma: 2.9,
  narrowDistPx: 1.0,       // a fit narrower than minSigma counts only this close to the point (native px)
  maxDistPx: 2.5,          // 15" (native 6.15" px): the centre box the start search uses is 3 px
  ownCorePx: 2.5,
  seasonScatter: 2.0,      // arcsec, median distance of a season's exposures from their median
  fluxFactor: 3.0,
  maxSpeed: 12.0,          // "/yr (fastest known star 10.4)
  reachPad: 3.0,           // arcsec
};

/** Connected saturated blobs (8-neighbour) that have a pixel in the box |i - x|, |j - y| <= half; each grown
 * over at most `lim` px from the box. Returns [{n, cx, cy, r}]. */
export function satBlobs(sat, W, H, x, y, half, lim = 40) {
  const seen = new Set(), out = [];
  const i0 = Math.max(0, Math.round(x) - half - lim), i1 = Math.min(W - 1, Math.round(x) + half + lim);
  const j0 = Math.max(0, Math.round(y) - half - lim), j1 = Math.min(H - 1, Math.round(y) + half + lim);
  for (let j = Math.max(0, Math.round(y) - half); j <= Math.min(H - 1, Math.round(y) + half); j++)
    for (let i = Math.max(0, Math.round(x) - half); i <= Math.min(W - 1, Math.round(x) + half); i++) {
      const k0 = j * W + i;
      if (!sat[k0] || seen.has(k0)) continue;
      const st = [k0]; seen.add(k0);
      let n = 0, sx = 0, sy = 0;
      while (st.length) {
        const k = st.pop(), ii = k % W, jj = (k / W) | 0;
        n++; sx += ii; sy += jj;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const a = ii + di, b = jj + dj;
          if (a < i0 || a > i1 || b < j0 || b > j1) continue;
          const q = b * W + a;
          if (sat[q] && !seen.has(q)) { seen.add(q); st.push(q); }
        }
      }
      out.push({ n, cx: sx / n, cy: sy / n, r: Math.sqrt(n / Math.PI) });
    }
  return out;
}

/** Saturated blobs near (x, y) whose centre is more than CENTRE.ownCorePx away (other stars), searched in a
 * box of `half` + 16 px (the glow test reaches 6 + 2 r). */
function foreignCores(sat, W, H, x, y) {
  return satBlobs(sat, W, H, x, y, 21).filter((b) => b.n >= 4 && Math.hypot(b.cx - x, b.cy - y) > CENTRE.ownCorePx);   // >= 4 px: a core, not a flagged pixel
}

/**
 * Checks one exposure's centre fit. fit: gaussCentroid result (region pixel coordinates); start: [gx, gy] the
 * fit's start; point: [x, y] the requested point (region coordinates); sigma0: pixel noise; data / sat / W / H:
 * the region. Returns {ok, why, snr, distPx, sigma}.
 */
export function checkFit(fit, { start, point, sigma0, sat, W, H, half = 5 }) {
  const out = { ok: false, why: null, snr: null, distPx: null, sigma: fit ? fit.sigma : null };
  if (!fit) { out.why = "no_fit"; return out; }
  const peak = fit.amp / (2 * Math.PI * Math.max(fit.sigma, 0.3) ** 2);
  out.snr = sigma0 > 0 ? peak / sigma0 : null;
  out.distPx = Math.hypot(fit.x - point[0], fit.y - point[1]);
  const symm = fit.method === "symmetry";      // satfit.js: a big saturated core, far above the noise; no width
  if (symm) out.snr = null;
  if (!symm && Math.abs(fit.x - start[0]) < 1e-6 && Math.abs(fit.y - start[1]) < 1e-6) out.why = "fit_did_not_move";
  else if (!symm && !(out.snr >= CENTRE.minSnr)) out.why = "too_faint";
  else if (!symm && !(fit.sigma <= CENTRE.maxSigma)) out.why = "not_star_shaped";
  else if (!symm && !(fit.sigma >= CENTRE.minSigma) && !(out.distPx <= CENTRE.narrowDistPx)) out.why = "not_star_shaped";
  else if (out.distPx > CENTRE.maxDistPx) out.why = "off_centre";
  else {
    const fc = foreignCores(sat, W, H, fit.x, fit.y);
    const touch = fc.find((b) => Math.max(Math.abs(b.cx - fit.x) - b.r, Math.abs(b.cy - fit.y) - b.r) <= half);
    const glow = fc.find((b) => Math.hypot(b.cx - fit.x, b.cy - fit.y) <= 6 + 2 * b.r);
    if (touch || glow) out.why = "next_to_saturated_star";
  }
  out.ok = !out.why;
  out.narrow = out.ok && !symm && fit.sigma < CENTRE.minSigma;
  return out;
}

const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); const m = s.length >> 1; return !s.length ? NaN : s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); };

/**
 * Same source in every season. exps: exposures with an accepted fit ({season, bin, mjd, ra_fit, dec_fit,
 * saturated, fit: {amp}}). Returns {status: "ok" | "not_detected", seasons: [labels used], dropped: [{season,
 * why}], use: Set of the exposures to measure}.
 */
export function sameSource(exps, { nAll = 0 } = {}) {
  const by = new Map();
  for (const e of exps) { if (!by.has(e.season)) by.set(e.season, []); by.get(e.season).push(e); }
  const dropped = [];
  const S = [];
  for (const [season, list] of by) {
    // only narrow fits (one bright pixel, see checkFit) in a season: at least two must agree
    if (list.length < 2 && list.every((e) => e.centre && e.centre.narrow)) { dropped.push({ season, why: "single_narrow_fit" }); continue; }
    const ra = med(list.map((e) => e.ra_fit)), dec = med(list.map((e) => e.dec_fit));
    const c = Math.cos(dec * Math.PI / 180);
    const r = list.map((e) => Math.hypot((e.ra_fit - ra) * c, e.dec_fit - dec) * 3600);
    const scatter = list.length > 1 ? med(r) : 0;
    if (scatter > CENTRE.seasonScatter) { dropped.push({ season, why: "exposures_disagree", scatter: +scatter.toFixed(2) }); continue; }
    S.push({ season, list, ra, dec, mjd: list.reduce((a, e) => a + e.mjd, 0) / list.length });
  }
  // brightness: per bin, the season's median amplitude (unsaturated fits) against the median over seasons
  const flux = new Map();      // season -> bin -> median amp
  for (const s of S) {
    const m = new Map();
    for (const b of new Set(s.list.filter((e) => !e.saturated).map((e) => e.bin)))
      m.set(b, med(s.list.filter((e) => !e.saturated && e.bin === b).map((e) => e.fit.amp)));
    flux.set(s.season, m);
  }
  const bad = new Map();
  for (const b of new Set(S.flatMap((s) => [...flux.get(s.season).keys()]))) {
    const have = S.filter((s) => flux.get(s.season).has(b));
    if (have.length < 2) continue;
    const m = med(have.map((s) => flux.get(s.season).get(b)));
    for (const s of have) {
      const v = flux.get(s.season).get(b), q = bad.get(s.season) || { n: 0, off: 0 };
      q.n++; if (!(v > 0 && m > 0) || Math.abs(Math.log(v / m)) > Math.log(CENTRE.fluxFactor)) q.off++;
      bad.set(s.season, q);
    }
  }
  let keep = S.filter((s) => { const q = bad.get(s.season); if (q && q.off * 2 > q.n) { dropped.push({ season: s.season, why: "brightness_differs" }); return false; } return true; });
  // position: every pair reachable by a star
  const far = (a, b) => {
    const c = Math.cos(0.5 * (a.dec + b.dec) * Math.PI / 180);
    const d = Math.hypot((a.ra - b.ra) * c, a.dec - b.dec) * 3600;
    return d > CENTRE.maxSpeed * Math.abs(a.mjd - b.mjd) / 365.25 + CENTRE.reachPad;
  };
  for (;;) {
    const cnt = keep.map((a) => keep.filter((b) => b !== a && far(a, b)).length);
    const worst = Math.max(0, ...cnt);
    if (!worst) break;
    // with two seasons left that disagree nothing tells which one is right: drop both
    if (keep.length <= 2) { for (const s of keep) dropped.push({ season: s.season, why: "too_far_apart" }); keep = []; break; }
    const k = cnt.indexOf(worst);
    dropped.push({ season: keep[k].season, why: "too_far_apart" });
    keep = keep.filter((_, i) => i !== k);
  }
  const use = new Set(keep.flatMap((s) => s.list));
  return { status: keep.length ? "ok" : "not_detected", seasons: keep.map((s) => s.season).sort(), dropped, use,
           nFits: exps.length, nExposures: nAll };
}
