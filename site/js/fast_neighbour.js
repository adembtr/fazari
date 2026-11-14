// Fast star next to a free sky point (tarayici_olcum, 14 Nov 2026). A free point is measured where the user
// clicked; a star with a large proper motion may have left that point since the catalogue epoch (Gaia DR3 =
// 2016.0; e.g. Barnard's Star is ~99" north of its Gaia position in 2025.5), or moved into it. Then the page
// would measure empty sky (or the edge of the star's glow) without saying why. This module finds such a star
// (Gaia DR3 through gaia.js, moved with astro.js propagate() to the SPHEREx epoch) and, separately, a prepared
// target (targets.js) whose track passes near the point between 2000 and today. It only returns facts and one
// line of text for the caller to show with a link; it measures nothing.
//
//   fastNeighbour(ra, dec, { mjd?, signal?, stars? }) -> Promise<{
//     star: null | { source_id, gmag, pm_arcsec_yr, kind: "moved_away" | "moved_here",
//                    ra_now, dec_now, epoch_now, sep_now_arcsec, sep_catalogue_arcsec, link },
//     target: null | { key, name, sep_arcsec, when_jyear, link },
//     lines: [{ kind, text_en, text_tr, link }],        // one per finding, in the order star, target
//     error: null | str }>                                // Gaia not reachable: star unknown (never "none")
//   prepared target only (no network): nearTarget(ra, dec, { nowJyear? })
import { highPmStars } from "./gaia.js";
import { propagate, offsetArcsec, jyearToMjd, mjdToJyear } from "./astro.js";
import { TARGETS } from "./targets.js";

export const FAST = {
  pmMinMasYr: 500,      // slower stars move < 5" in 10 years: they stay inside the centre box
  nearArcsec: 15,       // "at the point": within 15" (the centre search box is 3 native px = 18")
  queryDeg: 0.04,       // 144": the fastest star (10.4"/yr) moves ~100" from 2016 to 2026
  epochJyear: 2025.5,   // SPHEREx (seasons 2025-04 .. 2026-09); the caller may pass the seasons' mean MJD
  targetArcsec: 60,     // a prepared target's track passes within 60" of the point
  targetFromJyear: 2000,
};

const r1 = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
const fmt = (v, L) => { const s = String(r1(v)); return L === "tr" ? s.replace(".", ",") : s; };
const fmt1 = (v, L) => { const s = v.toFixed(1); return L === "tr" ? s.replace(".", ",") : s; };   // speed: one decimal
const link = (ra, dec) => `sky.html?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`;

/** Text through js/i18n.js (bm.* keys) when the page has it, else the built-in English / Turkish. */
function tx(L, key, en, tr, p) {
  try {
    const g = globalThis.__fzI18n;
    if (g && g.t && g.lang && g.lang() === L && (!g.has || g.has(key))) { const v = g.t(key, p); if (v && v !== key) return v; }
  } catch (_) {}
  return (L === "tr" ? tr : en).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m));
}

/** Pick the fast star that matters at (ra, dec) from a Gaia list (pure; tests call it directly). */
export function pickFastStar(ra, dec, stars, mjdNow) {
  let best = null;
  for (const s of stars || []) {
    const pm = Math.hypot(s.pmra || 0, s.pmdec || 0);
    if (!(pm >= FAST.pmMinMasYr)) continue;
    const t = { ra: s.ra, dec: s.dec, epoch: s.epoch || 2016.0, pmra: s.pmra, pmdec: s.pmdec, plx: s.plx || 0 };
    const [ran, decn] = propagate(t, mjdNow, false);           // proper motion only: where it is "now"
    const sepNow = offsetArcsec(ra, dec, ran, decn)[2];
    const sepCat = offsetArcsec(ra, dec, s.ra, s.dec)[2];
    let kind = null;
    if (sepCat <= FAST.nearArcsec && sepNow > FAST.nearArcsec) kind = "moved_away";
    else if (sepNow <= FAST.nearArcsec && sepCat > FAST.nearArcsec) kind = "moved_here";
    if (!kind) continue;
    const key = kind === "moved_away" ? sepCat : sepNow;      // the one closest to the point wins
    if (!best || key < best._key) {
      best = { _key: key, source_id: s.source_id, gmag: s.gmag, pm_arcsec_yr: pm / 1000, kind,
               ra_now: ran, dec_now: decn, epoch_now: +mjdToJyear(mjdNow).toFixed(2),
               sep_now_arcsec: +sepNow.toFixed(1), sep_catalogue_arcsec: +sepCat.toFixed(1), link: link(ran, decn) };
    }
  }
  if (best) delete best._key;
  return best;
}

/** A prepared target whose track (proper motion, no parallax) passes within FAST.targetArcsec of the point
 * between 2000 and now. Returns the closest {key, name, sep_arcsec, when_jyear, link} or null. */
export function nearTarget(ra, dec, { nowJyear = mjdToJyear(Date.now() / 86400000 + 40587) } = {}) {
  let best = null;
  for (const [key, t] of Object.entries(TARGETS)) {
    for (let jy = FAST.targetFromJyear; jy <= nowJyear + 1e-9; jy += 0.25) {
      const [a, d] = propagate(t, jyearToMjd(jy), false);
      const sep = offsetArcsec(ra, dec, a, d)[2];
      if (sep <= FAST.targetArcsec && (!best || sep < best.sep_arcsec)) {
        best = { key, name: t.name, sep_arcsec: +sep.toFixed(1), when_jyear: +jy.toFixed(2), link: `sky.html?target=${key}` };
      }
    }
  }
  return best;
}

/** The lines to show (both languages) for a fastNeighbour() finding. */
export function linesFor(star, target) {
  const lines = [];
  if (star && star.kind === "moved_away") {
    const p = (L) => ({ pm: fmt1(star.pm_arcsec_yr, L), sep: fmt(star.sep_now_arcsec, L) });
    lines.push({ kind: "moved_away", link: star.link,
      text_en: tx("en", "bm.fast.away", "A star that Gaia says moves {pm}″/yr is now {sep}″ from this point: go to where it is now.",
        "Gaia'ya göre yılda {pm}″ kayan bir yıldız şimdi bu noktadan {sep}″ uzakta: şimdi olduğu yere git.", p("en")),
      text_tr: tx("tr", "bm.fast.away", "A star that Gaia says moves {pm}″/yr is now {sep}″ from this point: go to where it is now.",
        "Gaia'ya göre yılda {pm}″ kayan bir yıldız şimdi bu noktadan {sep}″ uzakta: şimdi olduğu yere git.", p("tr")) });
  } else if (star && star.kind === "moved_here") {
    const p = (L) => ({ pm: fmt1(star.pm_arcsec_yr, L), sep: fmt(star.sep_catalogue_arcsec, L) });
    lines.push({ kind: "moved_here", link: null,
      text_en: tx("en", "bm.fast.here", "A star that Gaia says moves {pm}″/yr is at this point now; in the Gaia catalogue (2016) it was {sep}″ away.",
        "Gaia'ya göre yılda {pm}″ kayan bir yıldız şimdi bu noktada; Gaia kataloğunda (2016) {sep}″ uzaktaydı.", p("en")),
      text_tr: tx("tr", "bm.fast.here", "A star that Gaia says moves {pm}″/yr is at this point now; in the Gaia catalogue (2016) it was {sep}″ away.",
        "Gaia'ya göre yılda {pm}″ kayan bir yıldız şimdi bu noktada; Gaia kataloğunda (2016) {sep}″ uzaktaydı.", p("tr")) });
  }
  if (target) {
    const p = { name: target.name };
    lines.push({ kind: "prepared_target", link: target.link,
      text_en: tx("en", "bm.target.near", "{name}, one of the prepared targets, passes close to this point: see its prepared result.",
        "Hazır hedeflerden {name} bu noktanın yakınından geçiyor: hazır sonucuna bak.", p),
      text_tr: tx("tr", "bm.target.near", "{name}, one of the prepared targets, passes close to this point: see its prepared result.",
        "Hazır hedeflerden {name} bu noktanın yakınından geçiyor: hazır sonucuna bak.", p) });
  }
  return lines;
}

/** Fast star and prepared target near a free point. mjd: the SPHEREx epoch to move the stars to (default
 * FAST.epochJyear). stars: a Gaia list to use instead of the query (tests). A failed Gaia query is reported
 * as error (star unknown), never as "no fast star". */
export async function fastNeighbour(ra, dec, { mjd = jyearToMjd(FAST.epochJyear), signal = null, stars = null } = {}) {
  const target = nearTarget(ra, dec);
  let star = null, error = null;
  try {
    const list = stars || await highPmStars(ra, dec, FAST.queryDeg, FAST.pmMinMasYr, { signal });
    star = pickFastStar(ra, dec, list, mjd);
  } catch (e) {
    if (signal && signal.aborted) throw e;
    error = e.message || String(e);
  }
  return { star, target, lines: linesFor(star, target), error };
}
