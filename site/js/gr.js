// gr.js: the plain pictures and numbers of the answer card (ornek.html through js/viewer.js; sky.html
// through js/app.js). Inline SVG, no library. Strings: English here, Turkish from site/i18n/tr.json "gr.*".
//
//   speedFit(ms, refNone)        yearly speed (″/yr) ± error from meta.measured.fit (the joint fit of
//                                every exposure), and the catalogue's speed; null without a fit
//   numberLine(o)                one horizontal line: our value with its error bar (dot) and the
//                                catalogue value (open diamond); agreement visible at a glance
//   ratioChart(ph)               brightness ratio (later season / first season) against wavelength,
//                                error bars, a dashed line at 1 = "no change", grey = comparison stars
//   catalogueAt(meta, base)      the catalogued star at a free point: Gaia DR3 (VizieR), else SIMBAD;
//                                null when there is none
//   limitText(...)               "anything moving slower than X″/yr would not show here", from the run's
//                                own numbers (candidates.json sensitivity, else field-star scatter)
// Every number comes from the result's own files; nothing is measured or invented here.

import { t, lang, loc, month as monthName } from "./i18n.js";
import { gaiaStars } from "./gaia.js";

const L = (key, en, p) => (lang() === "tr" ? t(key, p, en) : p ? en.replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : en);
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** "10.37″/yr" (two decimals when the error is small or the value is below 1). */
export const rateTxt = (v, e) => loc((+v).toFixed(Math.abs(v) < 1 || (ok(e) && e > 0 && e < 0.095) ? 2 : 1)) + "″/" + L("gr.yr", "yr");
const D2R = Math.PI / 180;

// ------------------------------------------------------------------------------------------------ style
const CSS = `
.gr-box { margin:8px 0 2px; display:grid; gap:6px; min-width:0; max-width:760px; }
.gr-box[hidden] { display:none !important; }
html.ui .ui-facts .gr-box { order:4; flex:1 1 100%; margin:0; }
.gr-line { font-size:.8rem; line-height:1.35; color:var(--mut, #9aa3b2); margin:0; }
.gr-line b { color:var(--fg, #e8eaf0); font-weight:650; }
.gr-nl { background:rgba(5, 8, 16, .55); border:1px solid rgba(160, 180, 230, .14); border-radius:12px; padding:3px 12px 2px; }
/* Simple mode: the thin number line only (colours = the tiles above: yellow ours, blue the catalogue); the key and
   the shift line are Detailed-mode extras, so the blink stays above the fold */
html.ui:not([data-ui-mode="detailed"]) .gr-det { display:none; }
.gr-ratio { margin:10px auto 4px; }
.gr-nl > svg, .gr-rc > svg { display:block; width:100%; height:auto; overflow:visible; }
.gr-cap { font-size:.76rem; line-height:1.35; color:var(--mut, #9aa3b2); margin:2px 0 0; display:flex; flex-wrap:wrap; gap:2px 14px; align-items:center; }
.gr-cap svg { display:inline-block; vertical-align:-1px; width:12px; height:12px; }
.gr-cap i { font-style:normal; color:var(--fg, #e8eaf0); }
.gr-rc { background:rgba(5, 8, 16, .55); border:1px solid rgba(160, 180, 230, .14); border-radius:12px; padding:8px 12px 8px; }
.gr-rc h4 { margin:0 0 2px; font-size:.8rem; font-weight:650; color:var(--fg, #e8eaf0); }
.gr-limit { font-size:.86rem; line-height:1.4; margin:0; color:var(--fg, #e8eaf0); }
.gr-limit abbr { text-decoration:underline dotted; text-underline-offset:3px; cursor:help; color:var(--mut, #9aa3b2); font-size:.78rem; }
`;
export function ensureStyle() {
  if (typeof document === "undefined" || document.getElementById("gr-style")) return;
  const s = document.createElement("style");
  s.id = "gr-style"; s.textContent = CSS;
  document.head.append(s);
}

// ------------------------------------------------------------------------------------------------ numbers
/** Speed per year from the joint fit: { v, e, pa, p, ppa } in ″/yr and degrees (p = catalogue). */
export function speedFit(ms, refNone = false) {
  const f = ms && ms.fit;
  if (!f || !ok(f.pmra_mas_yr) || !ok(f.pmdec_mas_yr)) return null;
  const a = +f.pmra_mas_yr, d = +f.pmdec_mas_yr;
  const v = Math.hypot(a, d) / 1000;
  const ea = ok(f.pmra_err_mas_yr) ? +f.pmra_err_mas_yr : null, ed = ok(f.pmdec_err_mas_yr) ? +f.pmdec_err_mas_yr : null;
  // error of the length of the motion vector (each axis' error projected on the direction of motion)
  const e = ea != null && ed != null ? (v > 0 ? Math.hypot(a * ea, d * ed) / (v * 1000) / 1000 : Math.max(ea, ed) / 1000) : null;
  const pa = (Math.atan2(a, d) / D2R + 360) % 360;
  let p = null, ppa = null;
  if (!refNone && ok(f.gaia_pmra_mas_yr) && ok(f.gaia_pmdec_mas_yr) && (+f.gaia_pmra_mas_yr || +f.gaia_pmdec_mas_yr)) {
    p = Math.hypot(+f.gaia_pmra_mas_yr, +f.gaia_pmdec_mas_yr) / 1000;
    ppa = (Math.atan2(+f.gaia_pmra_mas_yr, +f.gaia_pmdec_mas_yr) / D2R + 360) % 360;
  }
  return { v, e, pa, p, ppa };
}

// ------------------------------------------------------------------------------------------------ number line
function niceStep(span, n) {
  const s0 = span / n, m = 10 ** Math.floor(Math.log10(s0));
  return [1, 2, 2.5, 5, 10].map((k) => k * m).find((s) => s >= s0) || 10 * m;
}
/** Decimals an axis step needs: a 0.25 step is labelled 0.75 / 1.00 / 1.25 (never "0.8" / "1.3" for 0.75 / 1.25). */
function stepDec(step) {
  const e10 = Math.floor(Math.log10(step));
  return Math.max(1, Math.min(3, Math.ceil(-Math.log10(step) - 1e-9) + (Math.abs(step / 10 ** e10 - 2.5) < 1e-9 ? 1 : 0)));
}
/** o = { v, e, p, unit: "″/yr", meLabel, refLabel, W } -> HTML (a .gr-nl block) */
/** Drawing width of a chart: narrower on a phone so the 11-unit labels stay readable once scaled to the screen. */
const chartW = () => (typeof innerWidth === "number" && innerWidth < 600 ? 380 : 560);
export function numberLine(o) {
  const { v, e } = o, p = ok(o.p) ? +o.p : null;
  if (!ok(v)) return "";
  const err = ok(e) && e > 0 ? +e : 0;
  // a window around both values: wide enough for 3 error bars and the gap between them, and 0 when it is near
  const c = p != null ? (v + p) / 2 : v;
  let half = Math.max(2.2 * err, p != null ? Math.abs(v - p) * 0.9 + err : 0, 0.015 * Math.abs(c), 0.02);
  let lo = c - half, hi = c + half;
  if (lo < 0 && v - 2 * err < 0.6 * hi) lo = 0;                     // a slow object: start the line at zero
  if (lo < 0) { hi -= lo; lo = 0; }
  const W = chartW(), H = 34, ml = 14, mr = 14, y = 14;           // thin: ~45 px high on a laptop
  const sx = (x) => ml + (x - lo) / (hi - lo) * (W - ml - mr);
  const step = niceStep(hi - lo, 5);
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  let s = `<line x1="${ml}" x2="${W - mr}" y1="${y}" y2="${y}" stroke="#4a5368" stroke-width="1.2"/>`;
  for (let x = Math.ceil(lo / step) * step; x <= hi + 1e-9; x += step) {
    const X = sx(x).toFixed(1);
    s += `<line x1="${X}" x2="${X}" y1="${y - 4}" y2="${y + 4}" stroke="#4a5368"/>` +
      `<text x="${X}" y="${y + 18}" text-anchor="middle" font-size="11" fill="#9aa3b2">${esc(loc(x.toFixed(dec)) + "″")}</text>`;
  }
  // our error bar (1σ) and value
  const X = sx(v);
  if (err > 0) {
    const a = sx(Math.max(lo, v - err)), b = sx(Math.min(hi, v + err));
    s += `<line x1="${a.toFixed(1)}" x2="${b.toFixed(1)}" y1="${y - 9}" y2="${y - 9}" stroke="#ffc94d" stroke-width="2.4"/>` +
      `<line x1="${a.toFixed(1)}" x2="${a.toFixed(1)}" y1="${y - 14}" y2="${y - 4}" stroke="#ffc94d" stroke-width="1.6"/>` +
      `<line x1="${b.toFixed(1)}" x2="${b.toFixed(1)}" y1="${y - 14}" y2="${y - 4}" stroke="#ffc94d" stroke-width="1.6"/>`;
  }
  s += `<circle cx="${X.toFixed(1)}" cy="${y - 9}" r="5" fill="#ffc94d" stroke="#05070d" stroke-width="1.2"/>`;
  if (p != null) {
    const P = sx(p).toFixed(1);
    s += `<path d="M${P} ${y - 3}l6.5 6.5l-6.5 6.5l-6.5 -6.5z" fill="#0b0e16" stroke="#7fd4ff" stroke-width="2"/>`;
  }
  const aria = L("gr.nl.aria", "Number line: our value {v} ± {e}; {who} {p}", { v: loc((+v).toFixed(2)), e: loc(err.toFixed(2)), who: o.refLabel || "", p: p != null ? loc(p.toFixed(2)) : "–" });
  const cap = `<span><svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true"><line x1="0" x2="12" y1="5" y2="5" stroke="#ffc94d" stroke-width="2"/><circle cx="6" cy="5" r="3.6" fill="#ffc94d"/></svg> ` +
    `<i>${esc(o.meLabel || L("gr.nl.me", "measured by us"))}</i> ${esc(L("gr.nl.bar", "(bar: our uncertainty)"))}</span>` +
    `<span>${esc(o.unit || "″/yr")}</span>` +
    (p != null ? `<span><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 5l-5 5l-5 -5z" fill="none" stroke="#7fd4ff" stroke-width="1.8"/></svg> <i>${esc(o.refLabel || "")}</i></span>` : "") +
    (p != null ? `<span>${esc(L("gr.nl.read", "Diamond inside the bar = agreement."))}</span>` : "");
  return `<div class="gr-nl"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${s}</svg><p class="gr-cap gr-det">${cap}</p></div>`;
}

// ------------------------------------------------------------------------------------------------ ratio chart
const SEASON_COL = ["#3987e5", "#d95926", "#199e70", "#c98500"];
const SEASON_SHAPE = ["circle", "square", "triangle", "diamond"];
function mark(shape, x, y, r, col) {
  if (shape === "square") return `<rect x="${(x - r * 0.9).toFixed(1)}" y="${(y - r * 0.9).toFixed(1)}" width="${(r * 1.8).toFixed(1)}" height="${(r * 1.8).toFixed(1)}" fill="${col}" stroke="#05070d"/>`;
  if (shape === "triangle") return `<path d="M${x.toFixed(1)} ${(y - r * 1.15).toFixed(1)}l${(r * 1.05).toFixed(1)} ${(r * 1.9).toFixed(1)}h${(-r * 2.1).toFixed(1)}z" fill="${col}" stroke="#05070d"/>`;
  if (shape === "diamond") return `<path d="M${x.toFixed(1)} ${(y - r * 1.2).toFixed(1)}l${(r * 1.1).toFixed(1)} ${(r * 1.2).toFixed(1)}l${(-r * 1.1).toFixed(1)} ${(r * 1.2).toFixed(1)}l${(-r * 1.1).toFixed(1)} ${(-r * 1.2).toFixed(1)}z" fill="${col}" stroke="#05070d"/>`;
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${col}" stroke="#05070d"/>`;
}
/** ph = meta.measured.photometry; epochs = meta.epochs (season order, for colours); month(ep) -> label */
export function ratioChart(ph, epochs, month) {
  const bins = ((ph && ph.bins) || []).filter((b) => (b.seasons || []).length > 1 && ok(b.wavelength_um));
  if (!bins.length) return "";
  const first = bins[0].seasons[0].epoch;
  const later = [...new Set(bins.flatMap((b) => b.seasons.slice(1).map((s) => s.epoch)))].sort();
  const pts = [];
  for (const b of bins) {
    b.seasons.slice(1).forEach((s) => { if (ok(s.ratio_to_first)) pts.push({ x: +b.wavelength_um, y: +s.ratio_to_first, e: ok(s.ratio_err) ? +s.ratio_err : 0, ep: s.epoch }); });
  }
  if (!pts.length) return "";
  const ys = pts.flatMap((q) => [q.y - q.e, q.y + q.e]).concat(bins.map((b) => 1 - (+b.comparison_scatter_frac || 0)), bins.map((b) => 1 + (+b.comparison_scatter_frac || 0)), [1]);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = 0.08 * (y1 - y0 || 1); y0 = Math.max(0, y0 - pad); y1 += pad;
  const W = chartW(), H = W < 560 ? 190 : 176, ml = 40, mr = 12, mt = 8, mb = 32;
  const X0 = 0.7, X1 = 5.0;
  const sx = (x) => ml + (x - X0) / (X1 - X0) * (W - ml - mr);
  const sy = (y) => H - mb - (y - y0) / (y1 - y0) * (H - mt - mb);
  let s = "";
  const step = niceStep(y1 - y0, 4);
  for (let v = Math.ceil(y0 / step) * step; v <= y1 + 1e-9; v += step) {
    s += `<line x1="${ml}" x2="${W - mr}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}" stroke="#262c3c"/>` +
      `<text x="${ml - 6}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#9aa3b2">${esc(loc(v.toFixed(stepDec(step))))}</text>`;
  }
  // how much the comparison stars themselves scatter, per bin (grey)
  for (const b of bins) {
    const f = +b.comparison_scatter_frac;
    if (!(f > 0)) continue;
    const xa = sx(+b.wavelength_um - 0.17), xb = sx(+b.wavelength_um + 0.17);
    s += `<rect x="${xa.toFixed(1)}" y="${sy(1 + f).toFixed(1)}" width="${(xb - xa).toFixed(1)}" height="${(sy(1 - f) - sy(1 + f)).toFixed(1)}" fill="#9aa3b2" fill-opacity=".16"/>`;
  }
  s += `<line x1="${ml}" x2="${W - mr}" y1="${sy(1).toFixed(1)}" y2="${sy(1).toFixed(1)}" stroke="#c9d2e3" stroke-width="1.3" stroke-dasharray="5 4"/>` +
    `<text x="${W - mr}" y="${(sy(1) - 5).toFixed(1)}" text-anchor="end" font-size="11" fill="#c9d2e3">${esc(L("gr.rc.same", "1 = no change"))}</text>`;
  s += `<line x1="${ml}" x2="${W - mr}" y1="${H - mb}" y2="${H - mb}" stroke="#4a5368"/>`;
  for (const v of [1, 1.5, 2, 3, 4, 4.6]) {
    s += `<line x1="${sx(v).toFixed(1)}" x2="${sx(v).toFixed(1)}" y1="${H - mb}" y2="${H - mb + 4}" stroke="#4a5368"/>` +
      `<text x="${sx(v).toFixed(1)}" y="${H - mb + 16}" text-anchor="middle" font-size="11" fill="#9aa3b2">${esc(loc(String(v)))}</text>`;
  }
  s += `<text x="${(ml + W - mr) / 2}" y="${H - 3}" text-anchor="middle" font-size="11" fill="#9aa3b2">${esc(L("gr.rc.x", "Wavelength (µm): bluer ← → redder infrared"))}</text>`;
  const n = later.length;
  pts.forEach((q) => {
    const k = later.indexOf(q.ep), si = Math.max(1, (epochs || []).indexOf(q.ep));
    const col = SEASON_COL[si % SEASON_COL.length], shp = SEASON_SHAPE[si % SEASON_SHAPE.length];
    const x = sx(q.x) + (k - (n - 1) / 2) * 9, y = sy(q.y);
    if (q.e > 0) s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${sy(Math.min(y1, q.y + q.e)).toFixed(1)}" y2="${sy(Math.max(y0, q.y - q.e)).toFixed(1)}" stroke="${col}" stroke-width="1.6"/>`;
    s += mark(shp, x, y, 4.2, col);
  });
  const mon = (ep) => (month ? month(ep) : ep);
  const leg = later.map((ep) => {
    const si = Math.max(1, (epochs || []).indexOf(ep));
    return `<span><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${mark(SEASON_SHAPE[si % SEASON_SHAPE.length], 6, 6.5, 4, SEASON_COL[si % SEASON_COL.length])}</svg> <i>${esc(L("gr.rc.pair", "{b} ÷ {a}", { a: mon(first), b: mon(ep) }))}</i></span>`;
  }).join("") + `<span><svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true"><rect width="14" height="10" fill="#9aa3b2" fill-opacity=".3"/></svg> ${esc(L("gr.rc.grey", "how much the comparison stars vary"))}</span>`;
  const aria = L("gr.rc.aria", "Brightness ratio against wavelength; 1 means no change");
  return `<div class="gr-rc"><h4>${esc(L("gr.rc.h", "Brightness now ÷ brightness in {a}, at each wavelength", { a: mon(first) }))}</h4>` +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${s}</svg><p class="gr-cap">${leg}</p>` +
    `<p class="gr-cap">${esc(L("gr.rc.read", "Above the line: brighter than in {a}; below: fainter. Bars: our uncertainty.", { a: mon(first) }))}</p></div>`;
}

// ------------------------------------------------------------------------------------------------ catalogue at a point
const catCache = new Map();
const getJson = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
/** Where the measured object is (the last season's measured position; else the requested point). */
function whereMeasured(meta) {
  const pos = ((meta.measured || {}).positions || []).filter((p) => ok(p.ra) && ok(p.dec));
  const p = pos[pos.length - 1];
  if (p) return { ra: +p.ra, dec: +p.dec, jyear: ok(p.mjd) ? 2000 + (p.mjd - 51544.5) / 365.25 : 2026 };
  return ok(meta.ra) ? { ra: +meta.ra, dec: +meta.dec, jyear: 2026 } : null;
}
/** Nearest star to `w` among [{ra, dec, pmra, pmdec, epoch}], moved to w's date; { s, sep } within rMax (″). */
function nearest(stars, w, rMax) {
  let best = null;
  const cd = Math.cos(w.dec * D2R);
  for (const s of stars) {
    const dt = w.jyear - (s.epoch || 2016);
    const ra = s.ra + (s.pmra || 0) / 3.6e6 * dt / Math.max(1e-6, Math.cos(s.dec * D2R)), dec = s.dec + (s.pmdec || 0) / 3.6e6 * dt;
    const sep = Math.hypot((ra - w.ra) * cd, dec - w.dec) * 3600;
    if (sep <= rMax && (!best || sep < best.sep)) best = { s, sep };
  }
  return best;
}
/** SIMBAD (TAP) for objects Gaia does not have: the object with a proper motion that lies at `w` once moved to its date.
 *  SIMBAD positions are for J2000, so a fast object sits far from where we measured it: ask 120″ around (4.6″/yr
 *  over 26 years), then move every object with its own motion and keep the nearest within rMax. */
async function simbadAt(w, rMax, radius = 120, pmMin = null) {
  const q = `SELECT TOP 200 main_id, ra, dec, pmra, pmdec FROM basic ` +
    `WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${w.ra.toFixed(6)}, ${w.dec.toFixed(6)}, ${(radius / 3600).toFixed(5)})) = 1 ` +
    `AND pmra IS NOT NULL AND pmdec IS NOT NULL` + (pmMin ? ` AND pmra * pmra + pmdec * pmdec > ${pmMin * pmMin}` : "");
  // SIMBAD's mirror at Harvard sends Access-Control-Allow-Origin: * (tested 2026-11-14 from a page, 4 of 4 answered;
  // simbad.cds.unistra.fr answered 404 that night). Any failure: no SIMBAD value, nothing shown.
  const u = "https://simbad.harvard.edu/simbad/sim-tap/sync?" + new URLSearchParams({ request: "doQuery", lang: "adql", format: "json", query: q });
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const rows = (j.data || []).filter((x) => [1, 2, 3, 4].every((k) => ok(x[k])))
      .map(([id, ra, dec, pmra, pmdec]) => ({ id, ra: +ra, dec: +dec, pmra: +pmra, pmdec: +pmdec, epoch: 2000 }));
    const hit = nearest(rows, w, rMax);
    if (!hit) return null;
    const { id, pmra, pmdec } = hit.s;
    return { src: "SIMBAD", id: String(id).replace(/\s+/g, " ").trim(), pmra, pmdec, v: Math.hypot(pmra, pmdec) / 1000,
      pa: (Math.atan2(pmra, pmdec) / D2R + 360) % 360, sep: hit.sep, gmag: null };
  } catch (e) { return null; } finally { clearTimeout(tm); }
}
/** The catalogued star at a free point: { src: "Gaia DR3" | "SIMBAD", id, v (″/yr), pa, sep (″), gmag } | null.
 *  Gaia DR3 from VizieR; SIMBAD when Gaia has none. */
export function catalogueAt(meta, base) {
  const w = whereMeasured(meta);
  if (!w) return Promise.resolve(null);
  const key = `${base}|${w.ra.toFixed(5)}|${w.dec.toFixed(5)}`;
  if (catCache.has(key)) return catCache.get(key);
  const R = 3;                                                // ″: a star at the measured position (SPHEREx pixels are 6″)
  const p = (async () => {
    // only the five challenge targets ship a gaia_field.json, and they are never free points (asking for it
    // here only gave a 404 in the console), so a free point asks Gaia DR3 through VizieR directly
    let hit = null;
    try { hit = nearest(await gaiaStars(w.ra, w.dec, 20 / 3600, { max: 50 }), w, R); } catch (e) { hit = null; }
    // a fast star has left that circle since Gaia's epoch 2016 (Kapteyn's Star, 8.7″/yr: about 90″ by 2026), so the
    // fast stars (over 1″/yr) of a wider circle are asked too and moved to the date the same way (150″: up to ~14″/yr)
    if (!hit) { try { hit = nearest(await gaiaStars(w.ra, w.dec, 150 / 3600, { pmMin: 1000, max: 50 }), w, R); } catch (e) { hit = null; } }
    if (hit && hit.s.has5p !== false) {
      const s = hit.s;
      return { src: "Gaia DR3", id: s.source_id, pmra: s.pmra, pmdec: s.pmdec, v: Math.hypot(s.pmra, s.pmdec) / 1000,
        pa: (Math.atan2(s.pmra, s.pmdec) / D2R + 360) % 360, sep: hit.sep, gmag: ok(s.gmag) ? +s.gmag : null };
    }
    // SIMBAD positions are for J2000: an object faster than ~4.6″/yr is outside 120″ by now (WISE 0855-0714, 8.2″/yr:
    // about 215″), so the fast objects (over 1″/yr) of 330″ around are asked when the first answer has none
    return (await simbadAt(w, R)) || simbadAt(w, R, 330, 1000);
  })().catch(() => null);
  catCache.set(key, p);
  return p;
}

// ------------------------------------------------------------------------------------------------ limits
const candCache = new Map();
export function candidates(base) {
  if (!base || /^(\.\/)?data\//.test(base)) return Promise.resolve(null);   // static target folders (data/<target>/) have no candidates.json: no 404
  if (!candCache.has(base)) candCache.set(base, getJson(base + "candidates.json"));
  return candCache.get(base);
}
/** From candidates.json "sensitivity" (the finder's own estimate): [{ mag, v }] for a bright and a faint star. */
export function limitFromSensitivity(sens) {
  const rows = ((sens && sens.motion) || []).filter((r) => ok(r.mag_ab) && ok(r.min_speed_arcsec_yr));
  if (!rows.length) return null;
  const pick = (m) => rows.reduce((a, r) => (Math.abs(r.mag_ab - m) < Math.abs(a.mag_ab - m) ? r : a));
  const b = pick(14), f = rows[rows.length - 1];
  return { bright: { mag: b.mag_ab, v: +b.min_speed_arcsec_yr }, faint: f !== b ? { mag: f.mag_ab, v: +f.min_speed_arcsec_yr } : null,
    span: ok(sens.span_yr) ? +sens.span_yr : null };
}
/** Conservative limit when the engine gives none: 3 × √2 × (single-exposure scatter of the field stars) ÷ (time
 *  between the first and last season). A real season position averages many exposures, so the true limit is lower. */
export function limitFromField(rms, dtYears) {
  return ok(rms) && rms > 0 && ok(dtYears) && dtYears > 0.1 ? 3 * Math.SQRT2 * rms / dtYears : null;
}
const rate = (v) => loc(v >= 1 ? v.toFixed(1) : v.toFixed(2));
/** The one honest line (HTML) for "nothing moving here". */
export function limitHtml(lim, how, foundMovers = false) {
  if (!lim) return "";
  const lead = foundMovers ? "" : esc(L("gr.lim.none", "Nothing moving was found here.")) + " ";
  if (lim.bright) {
    const tip = L("gr.lim.tipSens", "From this run's own sensitivity estimate (candidates.json): how precisely the field stars' positions were measured in each season and the time between the seasons ({y} yr), checked with fake moving stars added to real images.", { y: lim.span ? loc(lim.span.toFixed(1)) : "–" });
    return `<p class="gr-limit">${lead}${esc(L("gr.lim.sens", "A star of magnitude {m1} moving slower than {v1}″/yr would not show here", { m1: lim.bright.mag, v1: rate(lim.bright.v) }))}` +
      (lim.faint ? esc(L("gr.lim.sensFaint", "; for a faint star (magnitude {m2}) the limit is {v2}″/yr", { m2: lim.faint.mag, v2: rate(lim.faint.v) })) : "") +
      `. <abbr title="${esc(tip)}">${esc(L("gr.lim.how", "How we know"))}</abbr></p>`;
  }
  const tip = how || "";
  return `<p class="gr-limit">${lead}${esc(L("gr.lim.field", "Anything moving slower than about {v}″/yr would not show here.", { v: rate(lim.v) }))}` +
    (tip ? ` <abbr title="${esc(tip)}">${esc(L("gr.lim.how", "How we know"))}</abbr>` : "") + `</p>`;
}

// ------------------------------------------------------------------------------------------------ brightness over time
// For any result with a spectrum file (spectrum.json, "fazari-spectrum/1"): every exposure's flux divided by the
// spot's own average spectrum at that wavelength, against the date. A steady source stays near 1 whatever its
// colour; a source that fades or brightens between visits leaves 1. Shown for the wavelength button on screen
// (the exposures of that button's detector band). Where the result has a ring-photometry measurement against
// comparison stars (meta.measured.photometry: the two variable stars), the visit as a whole is that measurement,
// put on the same scale (divided by its own average over the visits), and the comparison stars' scatter is the
// grey band; without it there is no band (spectrum.json "neighbours" holds counts only, no per-exposure values).
// Thresholds, as in the result card (js/viewer.js bestChange): a change counts when it is larger than 10 % and
// more than three times its uncertainty; for rough wing estimates of a saturated star only a factor of two counts.
export const SEASON_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#9085e9", "#e66767"];   // = js/spectrum_chart.js COLORS
// How well one visit's brightness scale is known without comparison stars: the spectrum's own flux check (field
// stars against 2MASS and AllWISE: 0.93-1.06, spectrum.json "caveats"; the chart's note says "within ±7 %").
const TS_SCALE = 0.07;
const TS_CSS = `
.gr-tc { background:rgba(5, 8, 16, .55); border:1px solid rgba(160, 180, 230, .14); border-radius:12px; padding:10px 12px 10px; min-width:0; }
.gr-tc > svg { display:block; width:100%; height:auto; overflow:visible; }
.gr-tc h4 { margin:0 0 4px; font-size:.92rem; font-weight:650; color:var(--fg, #e8eaf0); }
.gr-tc .gr-cap { font-size:.8rem; gap:3px 14px; margin-top:4px; }
.gr-tv { margin:10px 0 0; font-size:1.05rem; line-height:1.4; font-weight:650; color:var(--fg, #e8eaf0); }
.gr-tv small { display:block; margin-top:3px; font-size:.84rem; font-weight:400; color:var(--mut, #9aa3b2); }
.gr-tt { margin:10px 0 0; width:auto; min-width:min(100%, 420px); border-collapse:collapse; font-size:.9rem; font-variant-numeric:tabular-nums; }
.gr-tt th { text-align:left; font-weight:600; color:var(--mut, #9aa3b2); padding:4px 14px 4px 0; border-bottom:1px solid #2a3246; }
.gr-tt td { padding:5px 14px 5px 0; border-bottom:1px solid #1d2333; color:var(--fg, #e8eaf0); }
.gr-tt td small { color:var(--mut, #9aa3b2); }
.gr-tt i { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:7px; vertical-align:-1px; }
.gr-tn { margin:8px 0 0; font-size:.86rem; line-height:1.4; color:var(--mut, #9aa3b2); }
.gr-tb { font:inherit; font-size:.86rem; font-weight:600; color:#ffc94d; background:none; border:1px solid rgba(255, 201, 77, .45); border-radius:999px; padding:3px 11px; margin:2px 4px 2px 0; cursor:pointer; min-height:30px; }
.gr-tgo { cursor:pointer; outline:none; }
.gr-tgo:hover, .gr-tgo:focus-visible { fill:rgba(127, 212, 255, .07); stroke:#7fd4ff; stroke-width:1.5; }
`;
function tsStyle() {
  ensureStyle();
  if (typeof document === "undefined" || document.getElementById("gr-ts-style")) return;
  const s = document.createElement("style");
  s.id = "gr-ts-style"; s.textContent = TS_CSS;
  document.head.append(s);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
/** The spot's own average spectrum over all visits: [{ x: µm, s: µJy }] from the season bins (each visit's bin counts
 *  once). Kept: bins whose average is at least three times its uncertainty, and wing estimates of a saturated star. */
function meanSpectrum(spec) {
  const g = new Map();
  for (const b of spec.binned || []) {
    if (!(b.kind === "measured" || b.kind === "saturated_wing") || !ok(b.flux_ujy) || !ok(b.wavelength_um)) continue;
    const k = b.detector + "|" + b.lam_lo_um;
    const o = g.get(k) || { x: 0, s: 0, v: 0, n: 0, wing: 0 };
    o.x += +b.wavelength_um; o.s += +b.flux_ujy; o.v += ok(b.flux_err_ujy) ? (+b.flux_err_ujy) ** 2 : 0; o.n++;
    if (b.kind === "saturated_wing") o.wing++;
    g.set(k, o);
  }
  return [...g.values()].map((o) => ({ x: o.x / o.n, s: o.s / o.n, e: Math.sqrt(o.v) / o.n, wing: o.wing > 0 }))
    .filter((o) => o.s > 0 && (o.wing || o.s > 3 * o.e)).sort((a, b) => a.x - b.x);
}
function specAt(nodes, x) {
  if (!nodes.length) return null;
  const A = nodes[0], Z = nodes[nodes.length - 1];
  if (x <= A.x) return x >= A.x - 0.06 ? A.s : null;
  if (x >= Z.x) return x <= Z.x + 0.06 ? Z.s : null;
  let i = 1; while (nodes[i].x < x) i++;
  const a = nodes[i - 1], b = nodes[i];
  if (b.x - a.x > 0.35) return Math.min(x - a.x, b.x - x) <= 0.06 ? (x - a.x < b.x - x ? a.s : b.s) : null;   // a stretch without an average: no ratio there
  return a.s + (b.s - a.s) * (x - a.x) / (b.x - a.x);
}
/** One visit as a whole from its exposures: the median and its robust uncertainty (few exposures: the mean). */
function visitStat(P) {
  const n = P.length;
  if (!n) return null;
  const ys = P.map((p) => p.y), es = P.map((p) => p.e || 0);
  if (n >= 4) {
    const m = median(ys), sr = 1.4826 * median(ys.map((y) => Math.abs(y - m)));
    return { y: m, e: Math.max(1.2533 * sr / Math.sqrt(n), (median(es) || 0) / Math.sqrt(n)), n };
  }
  return { y: ys.reduce((a, b) => a + b, 0) / n, e: Math.sqrt(es.reduce((a, b) => a + b * b, 0)) / n || null, n };
}
const mjdOf = (iso) => { const d = Date.parse(String(iso || "").slice(0, 10) + "T00:00:00Z"); return Number.isFinite(d) ? d / 864e5 + 40587 : null; };
const isoOf = (mjd) => new Date((mjd - 40587) * 864e5).toISOString().slice(0, 10);

/** The numbers of the chart for one wavelength button: { um, dets, seasons, pts, visits, src, cmp, change }. */
export function timeSeries({ spec, meta, um }) {
  const bins = (meta && meta.wavelength_bins) || [];
  const bin = ok(um) ? bins.find((b) => Math.abs(b.wavelength_um - um) < 0.05) : null;
  const dets = bin ? [...new Set((bin.frames || []).flatMap((f) => f.detectors || []))] : [];
  const seasons = (spec && spec.seasons && spec.seasons.length ? spec.seasons : (meta && meta.epochs) || []).slice();
  const out = { um: bin ? +bin.wavelength_um : null, dets, seasons, pts: [], visits: [], src: null, cmp: null, ncmp: null, change: null };
  if (spec && Array.isArray(spec.points)) {
    const nodes = meanSpectrum(spec);
    for (const p of spec.points) {
      if (dets.length && !dets.includes(p.detector)) continue;
      if (!ok(p.mjd) || !ok(p.wavelength_um)) continue;
      const S = specAt(nodes, +p.wavelength_um);
      if (!(S > 0)) continue;
      const base = { t: +p.mjd, season: p.season, lam: +p.wavelength_um, file: p.file || "" };
      if ((p.status === "detection" || p.status === "saturated_wing") && ok(p.flux_ujy)) {
        out.pts.push({ ...base, y: p.flux_ujy / S, e: ok(p.flux_err_ujy) ? p.flux_err_ujy / S : 0, kind: p.status === "detection" ? "det" : "wing" });
      } else if (p.status === "nondetection" && ok(p.upper_limit_ujy)) out.pts.push({ ...base, y: p.upper_limit_ujy / S, e: 0, kind: "ul" });
    }
  }
  const tOf = (s) => {
    const P = out.pts.filter((p) => p.season === s);
    if (P.length) return { t: P.reduce((a, p) => a + p.t, 0) / P.length, t0: Math.min(...P.map((p) => p.t)), t1: Math.max(...P.map((p) => p.t)) };
    const f = bin && (bin.frames || []).find((x) => x.epoch === s);
    const a = f && mjdOf(f.date_first || f.date), b = f && mjdOf(f.date_last || f.date);
    return a != null ? { t: (a + (b ?? a)) / 2, t0: a, t1: b ?? a } : null;
  };
  const pb = (((meta || {}).measured || {}).photometry || {}).bins || [];
  const ph = bin ? pb.find((b) => Math.abs(b.wavelength_um - bin.wavelength_um) < 0.05 && (b.seasons || []).filter((s) => ok(s.ratio_to_first)).length > 1) : null;
  if (ph) {
    const ss = ph.seasons.filter((s) => ok(s.ratio_to_first));
    const mean = ss.reduce((a, s) => a + +s.ratio_to_first, 0) / ss.length;
    out.visits = ss.map((s, i) => ({ season: s.epoch, y: s.ratio_to_first / mean, e: i && ok(s.ratio_err) ? s.ratio_err / mean : null, n: s.n_images, kind: "phot",
      r: +s.ratio_to_first, re: +s.ratio_err || 0, ...(tOf(s.epoch) || {}) })).filter((v) => ok(v.t));
    out.src = "phot"; out.cmp = ok(ph.comparison_scatter_frac) ? +ph.comparison_scatter_frac : null; out.ncmp = ok(ph.n_comparison) ? +ph.n_comparison : null;
  } else {
    for (const s of seasons) {
      const det = out.pts.filter((p) => p.season === s && p.kind === "det"), wing = out.pts.filter((p) => p.season === s && p.kind === "wing");
      const use = det.length >= 2 || !wing.length ? det : wing;
      const st = visitStat(use), tt = tOf(s);
      if (st && tt) out.visits.push({ season: s, ...st, kind: use === det ? "median" : "wing", ...tt });
    }
    if (out.visits.length) out.src = "spec";
  }
  // the change between the first visit and each later one: the most significant
  const v0 = out.visits[0];
  if (v0 && out.visits.length > 1) {
    for (const v of out.visits.slice(1)) {
      const r = out.src === "phot" ? v.r / v0.r : v.y / v0.y;
      // ring photometry is measured against comparison stars in the same images (the scale cancels); the exposures of
      // the spectrum are not, so each visit also carries the brightness scale's own uncertainty (TS_SCALE)
      const e = out.src === "phot" ? v.re : r * Math.hypot((v.e || 0) / v.y, (v0.e || 0) / v0.y, Math.SQRT2 * TS_SCALE);
      const z = e > 0 ? Math.abs(r - 1) / e : 0, rough = v.kind === "wing" || v0.kind === "wing";
      const sig = rough ? z >= 3 && (r >= 2 || r <= 0.5) : z >= 3 && Math.abs(r - 1) >= 0.1;
      const c = { r, e, z, sig, rough, scale: out.src !== "phot", from: v0.season, to: v.season, um: out.um };
      if (!out.change || (c.sig && !out.change.sig) || (c.sig === out.change.sig && c.z > out.change.z)) out.change = c;
    }
  }
  return out;
}
const xr = (v, e) => "×" + loc((+v).toFixed(2)) + (ok(e) && e > 0 ? " ± " + loc((+e).toFixed(2)) : "");
function changeText(c) {
  const mon = (ep) => monthName(ep, true);
  if (!c) return "";
  if (!c.sig) {
    return c.rough ? L("ts.f.vRough", "No change that can be trusted between the visits at this colour.")
      : L("ts.f.vSteady", "No significant change between the visits at this colour.");
  }
  const p = { a: mon(c.from), b: mon(c.to), r: xr(c.r, c.e), pc: String(Math.round(100 * Math.abs(c.r - 1))), x: loc(c.r.toFixed(1)) };
  if (c.r < 1) return c.r >= 0.4 && c.r <= 0.6 ? L("ts.f.vHalf", "Faded to about half between {a} and {b} ({r}).", p) : L("ts.f.vFaded", "Faded by about {pc} % between {a} and {b} ({r}).", p);
  return c.r >= 1.8 ? L("ts.f.vTimes", "Became about {x} times brighter between {a} and {b} ({r}).", p) : L("ts.f.vBright", "Brightened by about {pc} % between {a} and {b} ({r}).", p);
}
const ruleText = (c) => (c.rough
  ? L("ts.f.ruleRough", "The star is too bright for the camera at this colour: these are rough estimates from its faint outer glow, so only a change by more than a factor of two would count.")
  : c.scale ? L("ts.f.ruleScale", "A change counts when it is more than three times its uncertainty. Without comparison stars the brightness scale of a visit is good to about {p} % (our check against 2MASS and WISE), so that means a change of about a third or more.", { p: Math.round(100 * TS_SCALE) })
    : L("ts.f.rule", "A change counts when it is larger than 10 % and more than three times its uncertainty; the comparison is against ordinary stars in the same images."));

/** HTML of the "brightness over time" block: chart, key, the visits as a small table, one plain verdict. "" = nothing to show.
 *  jump: the page can show a visit in its image (ornek.html): each visit's panel is then a button (data-ts-go = its season). */
export function timeChart({ spec, meta, um, jump = false }) {
  const bins = (meta && meta.wavelength_bins) || [];
  if (!bins.length || (!spec && !(((meta.measured || {}).photometry || {}).bins || []).length)) return "";
  tsStyle();
  const mon = (ep) => monthName(ep, true);
  const umTxt = (u) => loc((+u).toFixed(1)) + " µm";
  const all = bins.map((b) => timeSeries({ spec, meta, um: b.wavelength_um }));
  const cur = all.find((s) => ok(um) && Math.abs(s.um - um) < 0.05) || all.find((s) => s.visits.length) || all[0];
  const withData = all.filter((s) => s.visits.length);
  const others = (list) => list.map((s) => `<button type="button" class="gr-tb" data-ts-um="${s.um}">${esc(umTxt(s.um))}</button>`).join("");
  if (!withData.length) {
    return `<div class="gr-tc"><p class="gr-tn" style="margin:0">${esc(L("ts.f.none", "Nothing to plot here: no source is bright enough at this spot in any infrared colour, so there is no brightness to follow from visit to visit."))}</p></div>`;
  }
  if (!cur.visits.length) {
    return `<div class="gr-tc"><p class="gr-tn" style="margin:0 0 6px">${esc(L("ts.f.noBand", "No brightness measurement at {um}: the source is either too bright for the camera or not seen at this colour. Colours with measurements:", { um: umTxt(cur.um) }))}</p><p style="margin:0">${others(withData)}</p></div>`;
  }
  // ---- chart: one panel per visit (dates inside a visit are real; the months between visits are cut out) ----
  const V = cur.visits, n = V.length;
  const W = chartW(), H = W < 560 ? 250 : 240, ml = 46, mr = 10, mt = 14, mb = 44, gap = W < 560 ? 16 : 26;
  const pw = (W - ml - mr - gap * (n - 1)) / n;
  const P = cur.pts;
  const ys = P.flatMap((p) => (p.kind === "ul" ? [p.y] : [p.y - p.e, p.y + p.e])).concat(V.flatMap((v) => [v.y - (v.e || 0), v.y + (v.e || 0)]), [1, 1 - (cur.cmp || 0), 1 + (cur.cmp || 0)]);
  const sorted = ys.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const qv = (f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(f * (sorted.length - 1))))];
  let y0 = Math.min(qv(0.02), ...V.map((v) => v.y - (v.e || 0)), 0.9), y1 = Math.max(qv(0.98), ...V.map((v) => v.y + (v.e || 0)), 1.1);
  const pad = 0.1 * (y1 - y0); y0 = Math.max(0, y0 - pad); y1 += pad;
  const sy = (y) => H - mb - (Math.min(y1, Math.max(y0, y)) - y0) / (y1 - y0) * (H - mt - mb);
  const col = (s) => SEASON_COLORS[Math.max(0, cur.seasons.indexOf(s)) % SEASON_COLORS.length];
  let s = "";
  const step = niceStep(y1 - y0, 4);
  let near1 = false;                                 // is "×1" (the dashed line) already a labelled tick, or too close to one?
  const dec = stepDec(step);
  for (let v = Math.ceil(y0 / step) * step; v <= y1 + 1e-9; v += step) {
    if (Math.abs(sy(v) - sy(1)) < 13) near1 = true;
    s += `<line x1="${ml}" x2="${W - mr}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}" stroke="#222838"/>` +
      `<text x="${ml - 6}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#9aa3b2">×${esc(loc(v.toFixed(dec)))}</text>`;
  }
  if (!near1) s += `<text x="${ml - 6}" y="${(sy(1) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#c9d2e3">×1</text>`;
  if (cur.cmp > 0) s += `<rect x="${ml}" y="${sy(1 + cur.cmp).toFixed(1)}" width="${W - ml - mr}" height="${(sy(1 - cur.cmp) - sy(1 + cur.cmp)).toFixed(1)}" fill="#9aa3b2" fill-opacity=".2"/>`;
  s += `<line x1="${ml}" x2="${W - mr}" y1="${sy(1).toFixed(1)}" y2="${sy(1).toFixed(1)}" stroke="#c9d2e3" stroke-width="1.3" stroke-dasharray="5 4"/>`;
  V.forEach((v, k) => {
    const x0 = ml + k * (pw + gap), c = col(v.season);
    const span = Math.max(v.t1 - v.t0, 0.5), ta = v.t0 - 0.12 * span - 0.3, tb = v.t1 + 0.12 * span + 0.3;
    const sx = (t) => x0 + 8 + (t - ta) / (tb - ta) * (pw - 16);
    s += `<rect x="${x0.toFixed(1)}" y="${mt}" width="${pw.toFixed(1)}" height="${H - mt - mb}" fill="#ffffff" fill-opacity=".025"/>` +
      `<line x1="${x0.toFixed(1)}" x2="${(x0 + pw).toFixed(1)}" y1="${H - mb}" y2="${H - mb}" stroke="#4a5368"/>`;
    for (const p of P) {
      if (p.season !== v.season) continue;
      const X = sx(p.t).toFixed(1), Y = sy(p.y);
      if (p.kind === "ul") { s += `<path d="M${X} ${(Y + 4).toFixed(1)}l-3.6 -6.4h7.2z" fill="none" stroke="${c}" stroke-width="1.2" opacity=".75"/>`; continue; }
      if (p.e > 0) s += `<line x1="${X}" x2="${X}" y1="${sy(p.y + p.e).toFixed(1)}" y2="${sy(p.y - p.e).toFixed(1)}" stroke="${c}" stroke-width="1" opacity=".45"${p.kind === "wing" ? ' stroke-dasharray="2 2"' : ""}/>`;
      s += p.kind === "wing" ? `<circle cx="${X}" cy="${Y.toFixed(1)}" r="2.9" fill="#0b0e16" stroke="${c}" stroke-width="1.3"/>` : `<circle cx="${X}" cy="${Y.toFixed(1)}" r="2.7" fill="${c}" opacity=".9"/>`;
    }
    // the visit as a whole: a wide bar at its value, its uncertainty as a band
    const Yv = sy(v.y);
    if (v.e > 0) s += `<rect x="${(x0 + 3).toFixed(1)}" y="${sy(v.y + v.e).toFixed(1)}" width="${(pw - 6).toFixed(1)}" height="${Math.max(1, sy(v.y - v.e) - sy(v.y + v.e)).toFixed(1)}" fill="${c}" fill-opacity=".22"/>`;
    s += `<line x1="${(x0 + 3).toFixed(1)}" x2="${(x0 + pw - 3).toFixed(1)}" y1="${Yv.toFixed(1)}" y2="${Yv.toFixed(1)}" stroke="${c}" stroke-width="2.6"${v.kind === "wing" ? ' stroke-dasharray="7 4"' : ""}/>` +
      `<text x="${(x0 + pw / 2).toFixed(1)}" y="${(Yv - 7 < mt + 10 ? Yv + 16 : Yv - 7).toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="700" fill="#f1f4fa" stroke="#05070d" stroke-width="3" paint-order="stroke">${esc(xr(v.y))}</text>` +
      `<text x="${(x0 + pw / 2).toFixed(1)}" y="${H - mb + 16}" text-anchor="middle" font-size="12" font-weight="600" fill="${c}">${esc(mon(v.season))}</text>` +
      `<text x="${(x0 + pw / 2).toFixed(1)}" y="${H - mb + 31}" text-anchor="middle" font-size="10.5" fill="#9aa3b2">${esc(v.t1 - v.t0 >= 1 ? L("ts.f.days", "{n} days", { n: Math.round(v.t1 - v.t0) + 1 }) : loc(isoOf(v.t)))}</text>`;
    if (jump) {                                    // the whole panel: "show this visit in the image above"
      s += `<rect class="gr-tgo" data-ts-go="${esc(v.season)}" data-ts-go-um="${cur.um}" x="${x0.toFixed(1)}" y="${mt}" width="${pw.toFixed(1)}" height="${H - mt - mb}" rx="4" fill="transparent" tabindex="0" role="button" ` +
        `aria-label="${esc(L("ts.f.goAria", "Show the visit of {m} in the image", { m: mon(v.season) }))}"><title>${esc(L("ts.f.goAria", "Show the visit of {m} in the image", { m: mon(v.season) }))}</title></rect>`;
    }
    if (k < n - 1) {
      const gd = Math.round(V[k + 1].t0 - v.t1);
      s += `<text x="${(x0 + pw + gap / 2).toFixed(1)}" y="${(mt + (H - mt - mb) / 2).toFixed(1)}" text-anchor="middle" font-size="10" fill="#6f7a90" transform="rotate(-90 ${(x0 + pw + gap / 2).toFixed(1)} ${(mt + (H - mt - mb) / 2).toFixed(1)})">${esc(L("ts.f.gap", "{n} days later", { n: gd }))}</text>`;
    }
  });
  const has = (k) => P.some((p) => p.kind === k);
  const dot = (inner) => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${inner}</svg>`;
  const key = [
    `<span><svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true"><line x1="0" x2="18" y1="6" y2="6" stroke="#c9d2e3" stroke-width="1.5" stroke-dasharray="5 4"/></svg> ${esc(L("ts.f.one", "×1 = this spot's own average"))}</span>`,
    has("det") ? `<span>${dot('<circle cx="6" cy="6" r="3.2" fill="#9aa3b2"/>')} ${esc(L("ts.f.kDet", "one exposure"))}</span>` : "",
    has("wing") ? `<span>${dot('<circle cx="6" cy="6" r="3.4" fill="none" stroke="#9aa3b2" stroke-width="1.5"/>')} ${esc(L("ts.f.kWing", "one exposure, rough: too bright for the camera here, measured from the faint outer glow"))}</span>` : "",
    has("ul") ? `<span>${dot('<path d="M6 10l-4 -7h8z" fill="none" stroke="#9aa3b2" stroke-width="1.4"/>')} ${esc(L("ts.f.kUl", "not seen in that exposure: fainter than this"))}</span>` : "",
    `<span><svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true"><rect y="3" width="16" height="6" fill="#9aa3b2" fill-opacity=".3"/><line x1="0" x2="16" y1="6" y2="6" stroke="#c9d2e3" stroke-width="2.2"/></svg> ${esc(cur.src === "phot" ? L("ts.f.kVisitPhot", "the visit as a whole, measured against ordinary stars in the same images") : L("ts.f.kVisit", "the visit as a whole (middle value of its exposures) and its uncertainty"))}</span>`,
    cur.cmp > 0 ? `<span><svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true"><rect width="14" height="10" fill="#9aa3b2" fill-opacity=".3"/></svg> ${esc(L("ts.f.kGrey", "how much ordinary stars in the same images vary"))}</span>` : "",
  ].join("");
  // ---- the visits as a table ----
  const cmpTxt = cur.cmp > 0 ? L("ts.f.within", "within {p} %", { p: loc((100 * cur.cmp).toFixed(cur.cmp < 0.1 ? 1 : 0)) }) : "";
  const rows = V.map((v) => `<tr><td><i style="background:${col(v.season)}"></i>${esc(mon(v.season))}${ok(v.n) ? ` <small>· ${esc(L(v.n === 1 ? "ts.f.exp.one" : "ts.f.exp.other", v.n === 1 ? "{n} exposure" : "{n} exposures", { n: v.n }))}</small>` : ""}</td>` +
    `<td>${esc(xr(v.y, v.e))}${v.kind === "wing" ? ` <small>${esc(L("ts.f.rough", "rough"))}</small>` : ""}</td>${cmpTxt ? `<td>${esc(cmpTxt)}</td>` : ""}</tr>`).join("");
  const table = `<table class="gr-tt"><thead><tr><th>${esc(L("ts.f.thVisit", "Visit"))}</th><th>${esc(L("ts.f.thSpot", "This spot"))}</th>${cmpTxt ? `<th>${esc(L("ts.f.thStars", "Ordinary stars"))}</th>` : ""}</tr></thead><tbody>${rows}</tbody></table>`;
  // ---- one plain verdict; the strongest change at another colour, if this one is not it ----
  const c = cur.change;
  const best = all.filter((x) => x.change && x.change.sig).sort((a, b) => b.change.z - a.change.z)[0];
  let verdict = c ? `<p class="gr-tv">${esc(changeText(c))}<small>${esc(ruleText(c))}</small></p>`
    : `<p class="gr-tv">${esc(L("ts.f.vOne", "Only one visit has a measurement at this colour, so there is nothing to compare yet."))}</p>`;
  if (best && best !== cur && (!c || !c.sig || best.change.z > 1.5 * c.z)) {
    verdict += `<p class="gr-tn">${esc(L("ts.f.elsewhere", "Strongest change of this object, at {um}:", { um: umTxt(best.um) }))} ${esc(changeText(best.change))} <button type="button" class="gr-tb" data-ts-um="${best.um}">${esc(L("ts.f.show", "Show {um}", { um: umTxt(best.um) }))}</button></p>`;
  }
  const rest = withData.filter((x) => x !== cur);
  const aria = L("ts.f.aria", "Brightness of this spot divided by its own average, visit by visit, at {um}", { um: umTxt(cur.um) });
  return `<div class="gr-tc"><h4>${esc(L("ts.f.at", "At {um} (the colour button selected above)", { um: umTxt(cur.um) }))}</h4>` +
    `<svg viewBox="0 0 ${W} ${H}" role="${jump ? "group" : "img"}" aria-label="${esc(aria)}">${s}</svg><p class="gr-cap">${key}</p>` +
    (jump ? `<p class="gr-tn" style="margin-top:4px">${esc(L("ts.f.goHint", "Click a visit in the chart to see it in the image above."))}</p>` : "") + `</div>` + verdict + table +
    (rest.length ? `<p class="gr-tn">${esc(L("ts.f.other", "Other colours:"))} ${others(rest)}</p>` : "");
}
