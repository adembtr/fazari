// Verdict strip: one clear verdict at the top of the answer, the same weight for every result class.
//   none   (not_detected, not_moving)                         "No moving object found here." + what was looked at,
//                                                              the limit, what it means, two actions
//   unsure (too_uncertain, no_measurement, one_season, guards) the engine's own reason sentence
//   moves  (moving, moving_as_predicted, ..._unlike_prediction) the speed + whether a catalogue star matches it
//   wait   while wavelengths are still loading: an interim verdict that says it is interim
// Reads only: the result's meta.json and candidates.json, the local engine's job status (?job=, progressive
// answer), the browser engine's worker events (sky.html), and existing page events. Rewrites no renderer.
// Hooks: ornek.html and sky.html, one <script type="module" src="js/verdict_strip.js"> each.
// Every number comes from the result data; nothing is typed by hand. Words: i18n "vd.*" (English fallback here).
import { t, lang, loc, month, onLang } from "./i18n.js";
import * as GR from "./gr.js";
import { plainSentence } from "./explain.js";
import { answerText } from "./bins_bar.js";

const $ = (id) => document.getElementById(id);
const H = document.documentElement;
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const L = (k, en, p) => t(k, p, en);
const plural = (k, n, en1, enN, p = {}) => L(k + (n === 1 ? ".one" : ".other"), n === 1 ? en1 : enN, { n: loc(String(n)), ...p });
/** Turkish case ending after a number: "6 dalga boyundan 2'si". */
function trSfx(n) {
  const d = Math.abs(n) % 10, tens = Math.abs(n) % 100;
  if (n === 0) return "'ı";
  if (d === 0) return tens === 0 ? "'ü" : ({ 10: "'u", 20: "'si", 30: "'u", 40: "'ı", 50: "'si", 60: "'ı", 70: "'i", 80: "'i", 90: "'ı" })[tens] || "'ı";
  return ["", "'i", "'si", "'ü", "'ü", "'i", "'sı", "'si", "'i", "'u"][d];
}
const ofM = (n, m) => L("vd.of", "{n} of {m} wavelengths", { n, m, sfx: lang() === "tr" ? trSfx(n) : "" });
const yr = () => L("gr.yr", "yr");
const dec = (v, e) => (Math.abs(v) < 1 || (ok(e) && e > 0 && e < 0.095) ? 2 : 1);
const speedTxt = (v, e) => loc((+v).toFixed(dec(v, e))) + (ok(e) ? " ± " + loc((+e).toFixed(dec(v, e))) : "") + "″/" + yr();

const ICON = {
  none: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  unsure: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="18.5" r="1.8" fill="currentColor"/></svg>',
  moves: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wait: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
};
const KIND = { not_detected: "none", not_moving: "none", moving: "moves", moving_as_predicted: "moves", moving_unlike_prediction: "moves",
  too_uncertain: "unsure", no_measurement: "unsure", one_season: "unsure" };

let cssDone = false;
function ensureCss() {
  if (cssDone || document.querySelector("link[data-vd-css]")) return;
  cssDone = true;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = new URL("../css/verdict_strip.css", import.meta.url).href; l.dataset.vdCss = "1";
  document.head.appendChild(l);
}

// ---- classification of a finished result (meta.json), the engine's rule (local/job_worker.py answer_from_meta) ----
/** { code, reason, text } of a meta.json; text only for a guarded result (explain.js's sentence). null for a preview. */
export function classify(meta) {
  if (!meta || meta.preview) return null;
  const ms = meta.measured || {};
  const st = ms.status || (ms.detection || {}).status;
  if (ms.photometry || st === "brightness") return { code: "brightness" };
  if (st === "not_detected") return { code: "not_detected" };
  if (st === "detected_one_season") return { code: "one_season" };
  if (!ok(ms.shift_arcsec)) return { code: "no_measurement" };
  const ps = plainSentence(meta, { lang: lang() });
  if (ps && ps.reason) return { code: ps.reason === "degenerate" ? "no_measurement" : "too_uncertain", reason: ps.reason, text: ps.text };
  const s = +ms.shift_arcsec, e = ok(ms.shift_err_arcsec) && +ms.shift_err_arcsec > 0 ? +ms.shift_err_arcsec : null;
  const eu = e ?? Math.max(0.1, 0.05 * s), g = meta.gaia || {};
  const p = (+g.pmra_mas_yr || +g.pmdec_mas_yr) && ok(ms.gaia_predicted_arcsec) ? +ms.gaia_predicted_arcsec : null;
  const sig = s > Math.max(3 * eu, 0.2), psig = p != null && p > Math.max(3 * eu, 0.2);
  if (sig && psig) return { code: Math.abs(s - p) <= Math.max(3 * eu, 0.1 + 0.05 * p) ? "moving_as_predicted" : "moving_unlike_prediction" };
  if (sig) return { code: "moving" };
  if (psig) return { code: "too_uncertain" };
  return { code: "not_moving" };
}
/** Speed per year of a meta.json: the joint fit (as the tiles), else shift / time. */
function speedOf(meta) {
  const ms = (meta && meta.measured) || {};
  const sf = GR.speedFit(ms, true);
  if (sf) return { v: sf.v, e: sf.e };
  const dt = ok(ms.dt_years) && +ms.dt_years > 0 ? +ms.dt_years : null;
  if (!dt || !ok(ms.shift_arcsec)) return null;
  return { v: +ms.shift_arcsec / dt, e: ok(ms.shift_err_arcsec) && +ms.shift_err_arcsec > 0 ? +ms.shift_err_arcsec / dt : null };
}
const speedOfAnswer = (a) => {
  if (!a) return null;
  const pm = a.pm_mas_yr, pe = a.pm_err_mas_yr;
  if (Array.isArray(pm) && ok(pm[0]) && ok(pm[1])) {
    const v = Math.hypot(pm[0], pm[1]) / 1000;
    const e = Array.isArray(pe) && ok(pe[0]) && ok(pe[1]) ? (v > 0 ? Math.hypot(pm[0] * pe[0], pm[1] * pe[1]) / (v * 1000) / 1000 : Math.max(pe[0], pe[1]) / 1000) : null;
    return { v, e };
  }
  return ok(a.speed_arcsec_yr) ? { v: +a.speed_arcsec_yr, e: ok(a.speed_err_arcsec_yr) ? +a.speed_err_arcsec_yr : null } : null;
};
/** A measured shift whose error came out as zero (e.g. a saturated star's wings): no error bar, so neither "moves"
 *  nor "did not move" can be stated (the engine keeps a floor instead; noted in ajan_durumu/hukum.md). */
const noErrorBar = (meta) => { const ms = (meta && meta.measured) || {}; return ok(ms.shift_arcsec) && !(+ms.shift_err_arcsec > 0); };
const NO_ERR = () => L("vd.noErr", "No usable error bar came out of this measurement (the position errors are zero), so whether it moves cannot be stated: too uncertain so far.");
const imagesOf = (meta) => (meta.preview ? meta.preview.n_images
  : (meta.wavelength_bins || []).reduce((a, b) => a + (b.frames || []).reduce((s, f) => s + (f.n_images || 0), 0), 0)) || (ok(meta.n_cutouts) ? +meta.n_cutouts : 0);
const catName = (meta) => (/simbad/i.test(String(((meta && meta.gaia) || {}).reference || "")) ? "SIMBAD" : "Gaia DR3");

// ---- the strip --------------------------------------------------------------------------------------------
function makeStrip() {
  const el = document.createElement("section");
  el.id = "vdStrip"; el.className = "vd"; el.hidden = true;
  el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
  el.innerHTML = `<span class="vd-ic"></span><div class="vd-body"><p class="vd-t"></p><p class="vd-l vd-what"></p><p class="vd-l vd-cat"></p>` +
    `<p class="vd-l vd-field"></p><p class="vd-l vd-lim"></p><p class="vd-l vd-mean"></p><p class="vd-act"></p></div>`;
  return el;
}
/** v = { kind, title, tag, what, cat, lim, mean, actions: html, field: html } */
function paint(el, v) {
  if (!el) return;
  if (!v) { el.hidden = true; H.classList.remove("vd-on", "vd-k-none", "vd-k-unsure", "vd-k-moves", "vd-k-wait"); return; }
  el.hidden = false;
  el.className = "vd vd-" + v.kind;
  el.setAttribute("aria-label", L("vd.aria", "Verdict"));
  for (const k of ["none", "unsure", "moves", "wait"]) H.classList.toggle("vd-k-" + k, v.kind === k);
  H.classList.add("vd-on");
  const set = (sel, html) => { const n = el.querySelector(sel); if (n.innerHTML !== html) n.innerHTML = html; };
  set(".vd-ic", ICON[v.kind] || "");
  set(".vd-t", esc(v.title) + (v.tag ? ` <span class="vd-tag">${esc(v.tag)}</span>` : ""));
  set(".vd-what", esc(v.what || ""));
  set(".vd-cat", esc(v.cat || ""));
  set(".vd-lim", esc(v.lim || ""));
  set(".vd-mean", esc(v.mean || ""));
  set(".vd-act", v.actions || "");
  set(".vd-field", v.field || "");
}
const MEAN = () => L("vd.mean", "This is the result for most of the sky; moving objects are rare. A planet, an asteroid or a fast star would change place between the images.");
function infoTxt(n, s, ep) {
  const parts = [];
  if (ok(n) && n > 0) parts.push(plural("vd.img", +n, "{n} image", "{n} images"));
  if (ok(s) && s > 0) parts.push(plural("vd.sea", +s, "{n} season", "{n} seasons"));
  if (ep && ep.length > 1) parts.push(`${month(ep[0], true)} – ${month(ep[ep.length - 1], true)}`);
  return parts.join(", ");
}
function noneWhat(code, k, m, info, sp) {
  const paren = info ? ` (${info})` : "";
  if (code === "not_moving") {
    return sp ? L("vd.still", "The source at the centre did not move (measured {v}, within the error{info}).", { v: speedTxt(sp.v, sp.e), info: info ? "; " + info : "" })
      : L("vd.stillNoV", "The source at the centre did not move{info}.", { info: paren });
  }
  return k >= m ? L("vd.noneAll", "No source shows at this point in any of the {m} wavelengths{info}.", { m, info: paren })
    : L("vd.noneSome", "No source shows at this point in the {k} wavelengths loaded{info}.", { k, info: paren });
}
/** The limit line from the run's own numbers (candidates.json sensitivity, else field-star scatter); "" if none. */
function limitTxt(cand, meta) {
  let lim = GR.limitFromSensitivity(cand && cand.sensitivity);
  const rate = (v) => loc(v >= 1 ? v.toFixed(1) : v.toFixed(2)) + "″/" + yr();
  if (lim && lim.bright) {
    return L("vd.lim", "An object of AB magnitude {m} or brighter moving faster than {v} would have shown here{faint}; a fainter or slower one can be missed.",
      { m: loc(String(lim.bright.mag)), v: rate(lim.bright.v), faint: lim.faint ? L("vd.limFaint", " (at AB {m}: {v})", { m: loc(String(lim.faint.mag)), v: rate(lim.faint.v) }) : "" });
  }
  const ms = (meta && meta.measured) || {};
  const cells = ((ms.field_calibration || {}).cells || []).filter((c) => Array.isArray(c.star_rms_arcsec));
  if (!cells.length) return "";
  const rms = cells.map((c) => (c.star_rms_arcsec[0] + c.star_rms_arcsec[1]) / 2).sort((a, b) => a - b)[cells.length >> 1];
  const eps = ((meta && meta.epochs) || []).map((e) => /^(\d{4})-(\d{2})/.exec(e)).filter(Boolean).map((x) => +x[1] + (+x[2] - 1) / 12);
  const v = eps.length > 1 ? GR.limitFromField(rms, eps[eps.length - 1] - eps[0]) : null;
  return v ? limitField(v) : "";
}
const limitField = (v) => L("vd.limField", "Anything moving faster than about {v} would have shown here; a slower or fainter one can be missed.",
  { v: loc(v >= 1 ? v.toFixed(1) : v.toFixed(2)) + "″/" + yr() });
function fieldHtml(cand) {
  const s = cand && cand.summary;
  if (!s) return "";
  // finder v1.1: n_moving_unconfirmed = candidates that did not pass the confirmation rule (n_moving_candidates
  // counts confirmed ones too); results made before v1.1 only have n_moving_candidates
  const n = ok(s.n_moving_unconfirmed) ? +s.n_moving_unconfirmed : ok(s.n_moving_candidates) ? +s.n_moving_candidates : null;
  if (n == null) return "";
  const confirmed = ok(s.n_moving_unconfirmed) && ok(s.n_moving_candidates) ? +s.n_moving_candidates - n : 0;
  if (!n) return confirmed > 0 ? "" : esc(L("vd.field.none", "No moving candidate in the whole field either."));
  return esc(plural("vd.field.some", n, "{n} moving candidate in the field (unconfirmed).", "{n} moving candidates in the field (unconfirmed).")) +
    ` <button type="button" class="vd-linkbtn" data-vd-list>${esc(L("vd.field.list", "See the list"))}</button>`;
}

// ---- actions ----------------------------------------------------------------------------------------------
const withLang = (u) => (lang() === "tr" ? u + (u.includes("?") ? "&" : "?") + "lang=tr" : u);
function actionsHtml(page, pos) {
  const ex = `<a class="vd-pri" href="${esc(withLang("ornek.html?data=data/barnard/"))}" data-vd-ex>${esc(L("vd.act.example", "See a moving example (Barnard's Star)"))}</a>`;
  const embedded = window.parent !== window;
  let other;
  if (page === "sky") other = `<button type="button" data-vd-other>${esc(L("vd.act.other", "Pick another point"))}</button>`;
  else if (embedded) other = `<button type="button" data-vd-other>${esc(L("vd.act.other", "Pick another point"))}</button>`;
  else other = `<a href="${esc(withLang("explore.html" + (pos ? `?ra=${pos.ra.toFixed(4)}&dec=${pos.dec.toFixed(4)}&fov=1` : "")))}">${esc(L("vd.act.other", "Pick another point"))}</a>`;
  return ex + other;
}
function wireActions(el, page) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-vd-other],[data-vd-list]");
    if (!b) return;
    e.preventDefault();
    if (b.hasAttribute("data-vd-list")) {
      const box = document.querySelector("#candidateList > .card") || $("candidateList");
      if (box) {
        if (box.classList.contains("ui-shut")) { const fb = box.querySelector(":scope > .ui-fold-btn"); if (fb) fb.click(); }
        box.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
    if (page === "sky") { const q = $("q"); if (q) { q.scrollIntoView({ block: "center" }); q.focus(); q.select && q.select(); } return; }
    try {                                                   // inside the explorer: close this panel (back to the sky map)
      const c = window.parent.document.getElementById("blinkClose");
      if (c) { c.click(); return; }
    } catch (_) { /* other origin */ }
    location.href = withLang("explore.html");
  });
}

// ---- "How sure" in Simple mode (ornek.html): one plain sentence instead of 5σ / S/N / detector ----------------
function sureSimple(meta, code) {
  const vEl = $("verdict");
  let p = $("vdSure");
  if (code !== "not_detected" || !vEl) { if (vEl) vEl.classList.remove("vd-tech"); if (p) p.remove(); return; }
  const cells = (((meta.measured || {}).detection || {}).cells || []).filter((c) => ok(c.snr));
  const best = cells.length ? Math.max(...cells.map((c) => +c.snr)) : null;
  vEl.classList.add("vd-tech");
  if (!p) { p = document.createElement("p"); p.id = "vdSure"; }
  if (p.previousElementSibling !== vEl) vEl.after(p);
  p.textContent = best != null && best >= 3 ? L("vd.sure.weak", "Even the strongest trace is too weak to count as a detection.")
    : L("vd.sure.below", "Even the strongest trace is below the noise.");
}

// ---- catalogue match for "it moves" -------------------------------------------------------------------------
const catMemo = new Map();
/** "known" | "knownDiff" | "new" | null (still checking); label = the catalogue's name. Uses only the result's own
 *  catalogue fields (prediction, gaia_compare) or gr.js catalogueAt (the star at a free point). */
function catalogueMatch(meta, base, code, sp, onDone) {
  if (code === "moving_as_predicted") return { k: "known", label: catName(meta) };
  if (code === "moving_unlike_prediction") return { k: "knownDiff", label: catName(meta) };
  const gc = ((meta.measured || {}).snap || {}).gaia_compare;
  if (gc && ok(gc.sigma)) return { k: +gc.sigma <= 3 ? "known" : "knownDiff", label: "Gaia DR3" };
  const key = base + "|" + (meta.generated || "");
  if (catMemo.has(key)) return catMemo.get(key);
  catMemo.set(key, null);
  GR.catalogueAt(meta, base).then((c) => {
    let r = { k: "new" };
    if (c && ok(c.v)) {
      const e = sp && ok(sp.e) ? sp.e : 0.1;
      r = { k: !sp || Math.abs(sp.v - c.v) <= Math.max(3 * e, 0.1 + 0.05 * c.v) ? "known" : "knownDiff", label: c.src || "Gaia DR3" };
    }
    catMemo.set(key, r); onDone();
  }).catch(() => { catMemo.set(key, { k: "unknown" }); onDone(); });
  return null;
}
function catLine(m) {
  if (!m) return L("vd.moves.checking", "Checking the star catalogues…");
  if (m.k === "known") return L("vd.moves.known", "Known star, matches the catalogue ({cat}).", { cat: m.label });
  if (m.k === "knownDiff") return L("vd.moves.knownDiff", "Known star ({cat}), but the catalogue predicts a different motion.", { cat: m.label });
  if (m.k === "new") return L("vd.moves.new", "Not in the catalogue: candidate (unconfirmed).");
  return "";
}

/** Our four-level confidence label: "measured" (motion or no motion, with an error bar), "borderline" (2–3σ),
 *  "not sure" (guarded or no measurement), "no source here". "" when none applies (no error bar). */
function confTag(code, sp) {
  if (code === "not_detected") return L("vd.conf.nosrc", "No source here");
  if (KIND[code] === "unsure") return L("vd.conf.unsure", "Not sure");
  if (!sp || !ok(sp.e) || !(sp.e > 0)) return "";
  const z = Math.abs(sp.v) / sp.e;
  return z >= 2 && z < 3 ? L("vd.conf.border", "Borderline") : L("vd.conf.measured", "Measured");
}
/** A very slow object: "too slow to measure with these data: slower than X/yr", X = 3 × the measured error. */
const slowLine = (sp) => (sp && ok(sp.e) && 3 * sp.e >= 0.005 ? L("vd.slow", "Too slow to measure with these data: slower than {x}.", { x: speedTxt(3 * sp.e, null) }) : "");

/** The final strip of one class. d = { code, reason, text, meta, base, k, m, n, seasons, epochs, sp, cand, page, pos } */
function finalView(d, repaint) {
  const kind = KIND[d.code];
  if (!kind) return null;
  const info = infoTxt(d.n, d.seasons, d.epochs);
  if (kind === "none") {
    return { kind, tag: confTag(d.code, d.sp), title: L("vd.none.t", "No moving object found here."), what: noneWhat(d.code, d.k, d.m, info, d.sp),
      cat: d.code === "not_moving" ? slowLine(d.sp) : "", lim: d.lim || "", mean: MEAN(), actions: actionsHtml(d.page, d.pos), field: fieldHtml(d.cand) };
  }
  if (kind === "unsure") {
    // the title is the confidence level here (no tag)
    return { kind, title: L("vd.unsure.t", "Not sure yet."), what: d.text || "", mean: info ? L("vd.based", "Based on {info}.", { info }) : "", field: fieldHtml(d.cand) };
  }
  const m = d.meta ? catalogueMatch(d.meta, d.base, d.code, d.sp, repaint) : d.catm || null;
  return { kind, tag: confTag(d.code, d.sp), title: d.sp ? L("vd.moves.t", "It moves: {v}.", { v: speedTxt(d.sp.v, d.sp.e) }) : L("vd.moves.t0", "It moves."),
    cat: catLine(m), field: fieldHtml(d.cand) };
}
/** An interim strip while wavelengths load. a = the running answer (or null), k/m = loaded / all wavelengths. */
function waitView(a, k, m, n, page = "ornek") {
  const of = ofM(k, m), kind = a ? KIND[a.code] : null, sp = a ? speedOfAnswer(a) : null;
  const tag = L("vd.interim", "Interim");
  const info = n ? plural("vd.img", +n, "{n} image", "{n} images") : "";
  if (kind === "none") return { kind: "wait", tag, title: L("vd.wait.none", "Nothing moving so far ({of})", { of }), what: info ? L("vd.wait.so", "So far {info}; the answer is updated with every wavelength.", { info }) : "", mean: MEAN(), actions: actionsHtml(page, null) };
  if (kind === "moves") return { kind: "wait", tag, title: sp ? L("vd.wait.moves", "So far: it moves, {v} ({of})", { v: speedTxt(sp.v, sp.e), of }) : L("vd.wait.moves0", "So far: it moves ({of})", { of }), what: info ? L("vd.wait.so", "So far {info}; the answer is updated with every wavelength.", { info }) : "" };
  if (kind === "unsure") return { kind: "wait", tag, title: L("vd.wait.unsure", "Not sure so far ({of})", { of }), what: answerText(a) };
  return { kind: "wait", tag, title: L("vd.wait.start", "Looking… the first answer comes with the first wavelength ({of})", { of }), what: "" };
}

// ---- ornek.html (precomputed results and the local engine) ---------------------------------------------------
async function getJson(url, cache = "no-store") {
  try { const r = await fetch(url, { cache }); return r.ok ? await r.json() : null; } catch (_) { return null; }
}
async function mountOrnek() {
  const lead = document.querySelector(".viewer .lead") || document.querySelector(".lead");
  if (!lead) return;
  ensureCss();
  const Q = new URLSearchParams(location.search);
  let base = Q.get("data") || "data/barnard/";
  if (!/\/$/.test(base)) base += "/";
  const job = Q.get("job");
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const el = makeStrip();
  const place = () => { const l = document.querySelector(".lead"); if (l && el.nextElementSibling !== l) l.before(el); };
  place();
  wireActions(el, "ornek");
  const S = { meta: null, metaUrl: null, job: null, cand: null, candBase: null, view: null, minH: 0 };
  const repaint = () => render();
  async function loadMeta(url) {
    if (S.metaUrl === url && S.meta) return S.meta;
    const m = await getJson(url + "meta.json");
    if (m) { S.meta = m; S.metaUrl = url; }
    return S.meta;
  }
  async function loadCand(url) {
    const c = await getJson(url + "candidates.json");
    S.cand = c; S.candBase = url;
  }
  function stagePost(k, m, n, complete) {
    try { if (window.parent !== window) window.parent.postMessage({ type: "fazari-vd-stage", k, m, n, complete, src: location.href }, location.origin); } catch (_) { /* ignore */ }
  }
  function render() {
    place();
    const j = S.job, p = j && j.progressive;
    const running = !!(p && j.state && !/^(done|error|cancelled)$/.test(j.state));
    if (running) {
      const m = p.bins.length, k = p.bins.filter((b) => b.state === "done").length;
      const a = p.answer || null;
      const n = a && ok(a.n_images) ? +a.n_images : p.bins.filter((b) => b.state === "done").reduce((s, b) => s + (b.images_done | 0), 0);
      S.view = waitView(a, k, m, n);
      paint(el, S.view);
      stagePost(k, m, n, false);
      const h = el.offsetHeight;                           // no layout jumps: the strip never shrinks during a run
      if (h > S.minH) { S.minH = h; el.style.minHeight = h + "px"; }
      sureSimple(S.meta || {}, a && S.metaUrl && a.meta_url && a.meta_url.startsWith(S.metaUrl) ? a.code : null);
      return;
    }
    el.style.minHeight = "";
    const meta = S.meta;
    if (!meta) { paint(el, null); return; }
    let c = classify(meta);
    const a = p && p.answer;
    if (a && a.code && j.state === "done") c = { code: a.code, reason: a.reason || null, text: a.reason ? answerText(a) : "" };
    if (c && KIND[c.code] === "unsure" && !c.text) c.text = a && j.state === "done" ? answerText(a) : (plainSentence(meta, { lang: lang() }) || {}).text || "";
    if (!c || !KIND[c.code]) { paint(el, null); sureSimple(meta, null); return; }
    if (/^(not_moving|moving)/.test(c.code) && noErrorBar(meta)) c = { code: "too_uncertain", reason: "no_error", text: NO_ERR() };
    const m = p ? p.bins.length : (meta.wavelength_bins || []).length;
    const k = a && Array.isArray(a.bins_used) && j.state === "done" ? a.bins_used.length : (meta.wavelength_bins || []).length;
    const n = imagesOf(meta);
    const sp = KIND[c.code] === "unsure" ? null : (speedOf(meta) || speedOfAnswer(a));
    const free = !!(meta.gaia && !meta.gaia.source_id && /requested position/i.test(meta.gaia.label || ""));
    S.view = finalView({ ...c, meta, base: S.metaUrl, k, m, n, seasons: (meta.epochs || []).length, epochs: meta.epochs || [], sp,
      cand: S.cand, lim: limitTxt(S.cand, meta), page: "ornek", pos: free && ok(meta.ra) ? { ra: +meta.ra, dec: +meta.dec } : null }, repaint);
    paint(el, S.view);
    sureSimple(meta, c.code);
    if (j) stagePost(k, m, n, true);
  }
  // the result on screen: ?data= (a stage folder during a run: the final folder replaces it at the end)
  await loadMeta(base);
  if (S.meta && !S.meta.preview) loadCand(base).then(render);
  render();
  onLang(() => render());
  document.addEventListener("fazari:ui-mode", () => render());
  document.addEventListener("fazari:post", (e) => { if (((e.detail || {}).step || "") === "candidates" || !S.cand) loadCand(S.metaUrl || base).then(render); });
  // the explorer re-renders the panel (viewer.js renderResult) on a language switch: keep "How sure" in step
  try { const r = $("result"); if (r) new MutationObserver(() => { if (S.meta && !$("vdSure") && S.view && S.view.kind === "none") sureSimple(S.meta, classify(S.meta)?.code); }).observe(r, { childList: true, subtree: true }); } catch (_) { /* ignore */ }
  if (!job || !local) return;
  // local engine: follow the job (as bins_bar.js does) until it is done; the final folder's meta for the numbers
  let delay = 1500;
  for (;;) {
    const j = await getJson(`/api/jobs/${encodeURIComponent(job)}`);
    if (j) {
      S.job = j;
      const done = /^(done|error|cancelled)$/.test(j.state || "");
      if (done) {
        const fin = (j.progressive && j.progressive.final_url) || j.result_url;
        if (fin && j.state === "done") { await loadMeta(fin); await loadCand(fin); }
        render();
        return;
      }
      const mu = j.progressive && j.progressive.answer && j.progressive.answer.meta_url;   // the stage on screen: its numbers for "How sure"
      if (mu && /meta\.json$/.test(mu)) await loadMeta(mu.replace(/meta\.json$/, ""));
      render();
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(3000, delay + 250);
  }
}

// ---- sky.html (browser engine) ----------------------------------------------------------------------------
function mountSky() {
  ensureCss();
  const el = makeStrip();
  wireActions(el, "sky");
  const S = { engine: null, answer: null, astro: null, bins: [], complete: false, runRef: null };
  const place = () => {
    const card = $("pgCard");
    if (card && el.nextElementSibling !== card) card.before(el);
    return !!card;
  };
  const sky = () => { try { return window.__fzSky ? window.__fzSky() : null; } catch (_) { return null; } };
  function render() {
    const has = place();
    const x = sky(), run = x && x.run;
    if (!has || !run || run !== S.runRef) { paint(el, null); H.classList.remove("vd-guarded"); return; }
    const m = S.bins.length || ((run.info && run.info.bins) || []).length;
    const k = S.bins.filter((b) => b.state === "done").length;
    const res = Object.values(run.results || {});
    const n = res.reduce((a, r) => a + (r.frames || []).reduce((s, f) => s + (f.n || 0), 0), 0);
    const a = S.answer;
    H.classList.toggle("vd-guarded", !!(a && a.reason));
    const complete = !!run.complete;
    if (!complete) { paint(el, waitView(noSource(a) ? { ...a, code: "not_detected" } : a, k, m, n, "sky")); post(k, m, n, false); return; }
    if (!a) { paint(el, null); return; }
    const code = noSource(a) ? "not_detected" : a.code;
    const kind = KIND[code];
    if (!kind) { paint(el, null); return; }
    const seasons = Math.max(0, ...res.map((r) => (r.frames || []).length));
    const fr = (x.current && x.current.frames) || [];
    const sp = kind === "unsure" ? null : speedOfAnswer(a);
    let lim = "";
    const cal = run.astro && run.astro.calibration;
    const dt = fr.length > 1 && fr[0].mjdMean && fr[fr.length - 1].mjdMean ? (fr[fr.length - 1].mjdMean - fr[0].mjdMean) / 365.25 : null;
    const v = cal ? GR.limitFromField(cal.rms, dt) : null;
    if (v && kind === "none") lim = limitField(v);
    const ep = fr.length > 1 ? [fr[0].season, fr[fr.length - 1].season].filter(Boolean) : [];
    const catm = kind === "moves" ? (a.code === "moving_as_predicted" ? { k: "known", label: "Gaia DR3" } : a.code === "moving_unlike_prediction" ? { k: "knownDiff", label: "Gaia DR3" } : skyCat(run, sp)) : null;
    paint(el, finalView({ code, reason: a.reason, text: answerText(a), k, m, n, seasons, epochs: ep.length > 1 ? ep : [], sp, lim, catm, page: "sky" }, render));
    post(k, m, n, true);
  }
  const catState = { key: null, val: null };
  function skyCat(run, sp) {                             // a free point: the catalogued star at the measured position
    if (run.target) return { k: "known", label: "Gaia DR3" };
    const pos = ((run.astro && run.astro.positions) || []).map((q) => ({ ra: q.ra, dec: q.dec, mjd: q.mjd }));
    const key = pos.map((q) => q.ra.toFixed(5)).join(",");
    if (!pos.length) return { k: "unknown" };
    if (catState.key === key) return catState.val;
    catState.key = key; catState.val = null;
    GR.catalogueAt({ measured: { positions: pos } }, "").then((c) => {
      const e = sp && ok(sp.e) ? sp.e : 0.1;
      catState.val = c && ok(c.v) ? { k: !sp || Math.abs(sp.v - c.v) <= Math.max(3 * e, 0.1 + 0.05 * c.v) ? "known" : "knownDiff", label: c.src || "Gaia DR3" } : { k: "new" };
      render();
    }).catch(() => { catState.val = { k: "unknown" }; render(); });
    return null;
  }
  const noSource = (a) => !!(a && a.code === "no_measurement" && S.astro && S.astro.centre && S.astro.centre.status === "not_detected");
  function post(k, m, n, complete) {
    try { if (window.parent !== window) window.parent.postMessage({ type: "fazari-vd-stage", k, m, n, complete, src: location.href }, location.origin); } catch (_) { /* ignore */ }
  }
  function onMsg(ev) {
    const d = ev.data;
    if (!d || !d.type) return;
    if (Array.isArray(d.bins)) S.bins = d.bins.map((b) => ({ um: +b.um, state: b.state }));
    if (d.type === "bin" && d.answer) { S.answer = d.answer; if (d.astrometry) S.astro = d.astrometry; }
    // "result" also ends each single-bin load (preview, first look): the run is complete only when app.js says so
    if (d.type === "result" && d.result && d.result.answer) { S.answer = d.result.answer; if (d.astrometry) S.astro = d.astrometry; }
    render();
  }
  // follow the run: a new run (new engine) resets; the worker's events are read with a second listener
  setInterval(() => {
    const x = sky(), run = x && x.run;
    if (run !== S.runRef) { S.runRef = run; S.answer = null; S.astro = null; S.bins = []; S.complete = false; S.engine = null; render(); }
    const eng = run && run.engine;
    if (eng && eng !== S.engine) { S.engine = eng; try { eng.worker && eng.worker.addEventListener("message", (ev) => { if (S.engine === eng) onMsg(ev); }); } catch (_) { /* no worker */ } }
    if (run && run.complete && !S.complete) { S.complete = true; setTimeout(render, 300); }
  }, 700);
  onLang(() => render());
}

// ---- start --------------------------------------------------------------------------------------------------
try {
  if ($("stage") && $("tiles")) mountOrnek().catch((e) => console.warn("verdict_strip", e));
  else if ($("blink") && $("form")) mountSky();
} catch (e) { console.warn("verdict_strip", e); }
