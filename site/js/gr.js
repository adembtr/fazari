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

import { t, lang, loc } from "./i18n.js";
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
      `<text x="${ml - 6}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#9aa3b2">${esc(loc(v.toFixed(step < 0.1 ? 2 : 1)))}</text>`;
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
async function simbadAt(w, rMax) {
  const q = `SELECT TOP 200 main_id, ra, dec, pmra, pmdec FROM basic ` +
    `WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${w.ra.toFixed(6)}, ${w.dec.toFixed(6)}, ${(120 / 3600).toFixed(5)})) = 1 ` +
    `AND pmra IS NOT NULL AND pmdec IS NOT NULL`;
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
    if (hit && hit.s.has5p !== false) {
      const s = hit.s;
      return { src: "Gaia DR3", id: s.source_id, pmra: s.pmra, pmdec: s.pmdec, v: Math.hypot(s.pmra, s.pmdec) / 1000,
        pa: (Math.atan2(s.pmra, s.pmdec) / D2R + 360) % 360, sep: hit.sep, gmag: ok(s.gmag) ? +s.gmag : null };
    }
    return simbadAt(w, R);
  })().catch(() => null);
  catCache.set(key, p);
  return p;
}

// ------------------------------------------------------------------------------------------------ limits
const candCache = new Map();
export function candidates(base) {
  if (!base) return Promise.resolve(null);
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
