// Wavelength-by-wavelength loading, the user-interface side (PROGRESSIVE CONTRACT v1, ajan_durumu/motor_hizi.md).
// One row of wavelength buttons right above the answer, in the engine's queue order, plus "All":
//   loaded = lit · loading = fills with images done / total · waiting = pale · failed = marked (click: try again).
// Click a loaded one: its blink. Click a waiting one: the engine loads it next and it shows when it arrives.
// The answer below the row is updated with every wavelength that arrives ("based on N of M wavelengths so far"),
// without layout jumps (its height never shrinks during a run; a short highlight when it changes). One time line
// from the engine's own estimate. "All": the engine's colour picture of the loaded wavelengths (for looking only).
//
// Driven only by contract objects:
//   local engine  : job status .progressive          -> fromLocal(job)
//   browser engine: worker events plan/bin/composite/eta -> skyModel().feed(ev)
//   no progressive object (old engine, precomputed targets): the result's own wavelengths, all loaded (staticModel)
// Page glue: mountViewer(viewerApi) for ornek.html (local engine / precomputed), runSky(ctx) for sky.html.
// Test without an engine: ornek.html?mock=1 (js/bins_bar_mock.js replays a contract event sequence; never loaded otherwise).
import { t, lang, loc, onLang } from "./i18n.js";

const L = (key, en, p) => t(key, p, en);            // English in the code as the fallback; i18n/en.json + tr.json "pg.bb.*", "pg.ans.*"
const $ = (id) => document.getElementById(id);
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const same = (a, b) => ok(a) && ok(b) && Math.abs(a - b) < 0.05;
const umTxt = (u) => loc((+u).toFixed(1));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const listSep = () => (lang() === "tr" ? "; " : ", ");   // Turkish decimals use a comma
const COMP_CAP_EN = "Colour view of the loaded wavelengths: for looking only; measurements are per wavelength.";
const COMP_CAP_TR = "Yüklenen dalga boylarının renkli görünümü: yalnızca bakmak için; ölçümler dalga boyu başınadır.";

let cssDone = null;
/** css/bins_bar.css next to this module; resolves when loaded (or after 1.5 s). */
export function ensureCss() {
  if (cssDone) return cssDone;
  cssDone = new Promise((res) => {
    if (document.querySelector('link[data-pg-css]')) return res();
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = new URL("../css/bins_bar.css", import.meta.url).href; l.dataset.pgCss = "1";
    l.onload = l.onerror = () => res();
    setTimeout(res, 1500);
    document.head.appendChild(l);
  });
  return cssDone;
}

// ---- text ---------------------------------------------------------------------------------------------------
const ANS_EN = {
  moving: "Moves about {speed} per year: a moving-object candidate, not confirmed.",
  moving_as_predicted: "Moves {speed} per year, as the catalogue predicts.",
  moving_unlike_prediction: "Moves {speed} per year; the catalogue predicts a different motion.",
  not_moving: "Not moving: {speed} per year is within the error.",
  too_uncertain: "No clear motion yet: too uncertain so far.",
  not_detected: "Nothing detected at this point so far.",
  one_season: "Seen in only one season so far: the motion cannot be measured yet.",
  brightness: "Brightness target: see the brightness result below.",
  no_measurement: "Could not measure the motion.",
};
const num = (v) => loc((+v).toFixed(Math.abs(+v) >= 10 ? 1 : 2));
/** "0.12 ± 0.03″" from an ANSWER (speed per year), or null. */
function speedOf(a) {
  const pm = a && a.pm_mas_yr, pe = a && a.pm_err_mas_yr;
  if (Array.isArray(pm) && ok(pm[0]) && ok(pm[1])) {      // the joint fit (as the answer card's tiles, js/gr.js speedFit)
    const v = Math.hypot(pm[0], pm[1]) / 1000;
    const e = Array.isArray(pe) && ok(pe[0]) && ok(pe[1]) ? (v > 0 ? Math.hypot(pm[0] * pe[0], pm[1] * pe[1]) / (v * 1000) / 1000 : Math.max(pe[0], pe[1]) / 1000) : null;
    return num(v) + (e != null ? " ± " + num(e) : "") + "″";
  }
  if (!a || !ok(a.speed_arcsec_yr)) return null;
  return num(a.speed_arcsec_yr) + (ok(a.speed_err_arcsec_yr) ? " ± " + num(a.speed_err_arcsec_yr) : "") + "″";
}
/** The answer's sentence: the engine's own text in the page language (always when it gives a reason, contract v1.2);
 *  our words (pg.ans.<code>) only when the engine sent no text. */
export function answerText(a) {
  if (!a) return "";
  let eng = String((lang() === "tr" ? a.text_tr : a.text_en) || "");
  // Turkish: the engines write decimal points ("2, 4.6 µm", "0.12 ± 0.03″"): lists with "; ", then decimal commas
  if (eng && lang() === "tr") eng = loc(eng.replace(/\d+(?:\.\d+)?(?:, \d+(?:\.\d+)?)+(?= µm)/g, (x) => x.split(", ").join("; ")));
  if (eng) return eng;
  if (a.reason && a.text_en) return String(a.text_en);
  const sp = speedOf(a);
  const needs = /^(moving|moving_as_predicted|moving_unlike_prediction|not_moving)$/.test(a.code || "");
  if (!ANS_EN[a.code] || (needs && !sp)) return String(a.text_en || "");
  return L("pg.ans." + a.code, ANS_EN[a.code], { speed: sp || "" });
}
/** No motion arrow for an answer that is not a measurement of motion (too uncertain, nothing measured). */
export const arrowAllowed = (a) => !a || !(a.reason || /^(too_uncertain|no_measurement|not_detected|one_season)$/.test(a.code || ""));
function basedText(m, withList = true) {
  const used = ((m.answer && m.answer.bins_used) || []).map(Number).sort((x, y) => x - y);
  const n = used.length, M = m.bins.length;
  if (!n) return "";
  const list = withList ? `<span class="pg-list"> (${used.map(umTxt).join(listSep())} µm)</span>` : "";   // phones: the lit buttons say which (no wrapping list)
  const refining = m.refine && (m.refine.state === "loading" || m.refine.state === "queued") && !m.complete;
  if (n >= M && refining) return L("pg.bb.basedAllRefine", "All {m} wavelengths in{list}; refining the error bar.", { m: M, list });
  if (n >= M) return L("pg.bb.basedAll", "Based on all {m} wavelengths{list}.", { m: M, list });
  return L("pg.bb.based", "Based on {n} of {m} wavelengths so far{list}.", { n, m: M, list });
}
function dur(s) {
  return s >= 90 ? L("pg.bb.min", "{n} minutes", { n: Math.max(2, Math.round(s / 60)) }) : L("pg.bb.sec", "{n} seconds", { n: Math.max(5, Math.round(s / 5) * 5) });
}
// the engine's estimate moves a little with every poll: keep a countdown and take a new estimate only when it
// differs by more than 20 % (or 15 s), so the line counts down instead of jumping around
const smooth = new Map();
function steady(key, s) {
  if (!ok(s)) { smooth.delete(key); return null; }
  const now = Date.now(), want = now + 1000 * Math.max(0, +s), prev = smooth.get(key);
  if (prev == null || Math.abs(want - prev) > Math.max(15000, 0.2 * 1000 * s)) smooth.set(key, want);
  return Math.max(0, (smooth.get(key) - now) / 1000);
}
/** One honest time line from the engine's estimate ("" when the run is over). */
export function etaText(m) {
  if (!m || m.complete || m.static || m.pending) return "";
  const e = m.eta || {};
  const left = m.bins.some((b) => b.state === "queued" || b.state === "loading") || (m.refine && /^(queued|loading)$/.test(m.refine.state || ""));
  if (!left) return L("pg.bb.finishing", "All wavelengths are in; finishing the result.");
  const a = m.answer ? null : steady("first", e.first), b = steady("all", e.all);
  if (b != null && b < 5) return L("pg.bb.almost", "Almost done.");
  if (a != null && b != null) return L("pg.bb.eta2", "First answer in about {a}, all wavelengths in about {b}.", { a: dur(a), b: dur(b) });
  if (a != null) return L("pg.bb.eta1", "First answer in about {a}.", { a: dur(a) });
  if (b != null) return L("pg.bb.etaAll", "All wavelengths in about {b}.", { b: dur(b) });
  return L("pg.bb.etaWait", "Measuring the download speed for an estimate…");
}

// ---- models (normalised contract objects) -------------------------------------------------------------------
// model = { bins: [{um, det, state, done, total, seasons, error}], order, answer, composite, eta: {first, all},
//           refine, complete, static, stageKey, stageUrl }
/** Local engine: GET /api/jobs/<id> -> model, or null when the job has no "progressive" object. */
export function fromLocal(job) {
  const p = job && job.progressive;
  if (!p || !Array.isArray(p.bins) || !p.bins.length) return null;
  const st = p.latest != null && p.stages ? p.stages[p.latest] : null;
  const e = p.eta || {};
  const base = st && st.url ? new URL(st.url, location.href) : null;
  const c = st && st.composite;
  return {
    kind: "local", version: p.version, order: (p.order || []).map(Number), priority: p.priority,
    bins: p.bins.map((b) => ({ um: +b.bin_um, det: b.detector, state: b.state, done: b.images_done | 0, total: b.images_total | 0, seasons: b.seasons, error: b.error || null })),
    answer: p.answer || null, refine: p.refine || null,
    stageKey: st ? `${st.n}:${st.url}` : null, stageUrl: st ? st.url : null, stageMeta: st && st._meta,   // _meta: mock only
    composite: c && Array.isArray(c.frames) && c.frames.length ? {
      caption_en: c.caption_en || COMP_CAP_EN, caption_tr: c.caption_tr || COMP_CAP_TR,
      frames: c.frames.map((f) => ({ epoch: f.epoch, bins: f.bins, src: base ? new URL(f.file, base).href : f.file })),
    } : null,
    eta: { first: e.first_answer_s, next: e.next_answer_s, all: e.all_s },
    complete: /^(done|error|cancelled)$/.test(job.state || "") || !!p.final_url, state: job.state, finalUrl: p.final_url || null,
  };
}
/** Browser engine: feed every worker event (plan / bin / composite / eta / result); .model is the current state. */
export function skyModel() {
  const m = { kind: "sky", bins: [], order: [], answer: null, composite: null, eta: {}, complete: false, version: 0 };
  return {
    model: m,
    feed(ev) {
      if (!ev || !ev.type) return m;
      if (ok(ev.version)) m.version = +ev.version;
      if (Array.isArray(ev.bins)) {
        const err = new Map(m.bins.map((b) => [b.um, b.error]));
        m.bins = ev.bins.map((b) => ({ um: +b.um, det: b.det, state: b.state, done: b.done | 0, total: b.total | 0, seasons: b.nSeasons, error: b.error !== undefined ? b.error : err.get(+b.um) || null }));
      }
      if (ev.type === "plan" && Array.isArray(ev.order)) m.order = ev.order.map(Number);
      if (ev.type === "bin") {
        const b = m.bins.find((x) => same(x.um, ev.um));
        if (b && ev.state) b.state = ev.state;
        if (b && ev.state === "failed") b.error = ev.error || null;
        if (ev.answer) m.answer = ev.answer;
      }
      if (ev.type === "composite" && Array.isArray(ev.seasons) && ev.seasons.length) {
        m.composite = { n: ev.n, caption_en: ev.caption_en || COMP_CAP_EN, caption_tr: ev.caption_tr || COMP_CAP_TR, seasons: ev.seasons, channels: ev.channels };
      }
      if (ev.type === "eta") m.eta = { first: ev.firstAnswerS, all: ev.allS };
      if (ev.type === "result") { m.complete = true; if (ev.result && ev.result.answer) m.answer = ev.result.answer; }
      return m;
    },
  };
}
/** A result without a progressive object: its own wavelengths, all loaded; nothing else. */
export function staticModel(meta) {
  const bins = (meta && meta.wavelength_bins) || [];
  return {
    kind: "static", static: true, complete: true, answer: null, composite: null, eta: {},
    bins: bins.map((b) => { const n = b.frames.reduce((s, f) => s + (f.n_images || 0), 0); return { um: +b.wavelength_um, state: "done", done: n, total: n, seasons: b.frames.length, det: ((b.frames[0] || {}).detectors || []).join("+") }; }),
  };
}

// ---- the bar ------------------------------------------------------------------------------------------------
/**
 * createBinsBar(host, { onShow(um), onWant(um), onAll(), etaHost, keepAnswer })
 *   onShow: show a loaded wavelength · onWant: ask the engine to load it next (also: try a failed one again)
 *   onAll: show the colour picture · etaHost: element for the time line (default: the bar's own small line;
 *   null = no time line here) · keepAnswer: keep the answer when the run is complete (sky.html)
 * returns { update(model), setShown(um | "all"), shown(), el }
 */
export function createBinsBar(host, opts = {}) {
  const S = { model: null, shown: null, want: null, wantAt: 0, retry: false, order: [], btns: new Map(), ansKey: "", minH: 0, flashT: 0 };
  host.classList.add("pg-bins");
  host.innerHTML = `<div class="pg-row" role="group"></div><p class="pg-ans" aria-live="polite" hidden></p><p class="pg-line"></p>`;
  const row = host.querySelector(".pg-row"), ans = host.querySelector(".pg-ans"), line = host.querySelector(".pg-line");
  const etaHost = opts.etaHost === undefined ? line : opts.etaHost;
  const all = document.createElement("button");
  all.type = "button"; all.className = "pg-b pg-all"; all.dataset.state = "done"; all.innerHTML = `<span class="pg-l"></span>`;
  all.onclick = () => { if (all.disabled) return; S.shown = "all"; paint(); opts.onAll && opts.onAll(); };

  const binOf = (um) => (S.model ? S.model.bins.find((b) => same(b.um, um)) : null);
  function show(um) { S.shown = um; S.want = null; S.retry = false; paint(); opts.onShow && opts.onShow(um); }
  function click(um) {
    const b = binOf(um);
    if (!b) return;
    if (b.state === "done") return show(b.um);
    S.want = b.um; S.wantAt = Date.now(); S.retry = b.state === "failed"; S.retryErr = b.error || null;
    paint();
    opts.onWant && opts.onWant(b.um);
  }
  function button(um) {
    const k = (+um).toFixed(1);
    let el = S.btns.get(k);
    if (!el) {
      el = document.createElement("button");
      el.type = "button"; el.className = "pg-b"; el.dataset.um = k;
      el.innerHTML = `<span class="pg-f"></span><span class="pg-l"></span>`;
      el.onclick = () => click(+um);
      S.btns.set(k, el);
    }
    return el;
  }
  function tip(b) {
    const u = umTxt(b.um);
    if (b.state === "done") return L("pg.bb.tip.done", "{um} µm: loaded ({n} images, {s} seasons). Click to show it.", { um: u, n: b.done || b.total, s: b.seasons ?? "–" });
    if (b.state === "loading") return L("pg.bb.tip.loading", "{um} µm: loading, {d} of {t} images.", { um: u, d: b.done, t: b.total });
    if (b.state === "failed") return L("pg.bb.tip.failed", "{um} µm: could not be loaded ({err}). Click to try again.", { um: u, err: b.error || L("pg.bb.netErr", "network error") });
    return L("pg.bb.tip.queued", "{um} µm: waiting. Click to load it next.", { um: u });
  }
  function note() {
    const m = S.model;
    if (S.shown === "all" && m && m.composite) return lang() === "tr" ? m.composite.caption_tr : m.composite.caption_en;
    if (S.want != null) {
      const b = binOf(S.want);
      if (b && b.state === "failed" && S.retry && b.error && (b.error !== S.retryErr || Date.now() - S.wantAt > 4000)) return L("pg.bb.retryWhy", "{um} µm cannot be loaded: {err}", { um: umTxt(S.want), err: b.error });   // the engine says why (no retry loop)
      if (b && b.state === "failed" && S.retry && Date.now() - S.wantAt > 10000) return L("pg.bb.retryFail", "{um} µm could not be loaded again.", { um: umTxt(S.want) });   // last resort
      if (S.retry) return L("pg.bb.retry", "Trying {um} µm again…", { um: umTxt(S.want) });
      return L("pg.bb.next", "{um} µm is next; it shows as soon as it arrives.", { um: umTxt(S.want) });
    }
    return "";
  }
  function paint() {
    const m = S.model;
    if (!m) return;
    host.classList.toggle("pg-run", !m.static && !m.complete);   // phones: the row keeps two lines' room during a run
    row.setAttribute("aria-label", L("pg.bb.aria", "Wavelength"));
    // fixed order: the engine's queue order when the run starts (a priority click must not reshuffle the row)
    for (const u of (m.order && m.order.length ? m.order : m.bins.map((b) => b.um))) if (!S.order.some((x) => same(x, u))) S.order.push(+u);
    for (const b of m.bins) if (!S.order.some((x) => same(x, b.um))) S.order.push(b.um);
    const want = [];
    for (const u of S.order) {
      const b = binOf(u);
      if (!b) continue;
      const el = button(u);
      el.dataset.state = b.state;
      el.querySelector(".pg-l").textContent = `${umTxt(u)} µm`;
      el.querySelector(".pg-f").style.width = b.state === "loading" && b.total ? `${(100 * Math.min(1, b.done / b.total)).toFixed(0)}%` : b.state === "loading" ? "4%" : "0";
      el.classList.toggle("pg-want", same(S.want, u) && b.state !== "done");
      el.setAttribute("aria-pressed", String(S.shown !== "all" && same(S.shown, u)));
      el.title = tip(b);
      el.setAttribute("aria-label", el.title);
      want.push(el);
    }
    const nDone = m.bins.filter((b) => b.state === "done").length;
    const hasAll = !m.static && m.bins.length > 1;
    if (hasAll) {
      all.disabled = !(nDone >= 2 && m.composite);
      all.setAttribute("aria-pressed", String(S.shown === "all"));
      all.querySelector(".pg-l").textContent = L("pg.bb.all", "All");
      all.title = all.disabled ? L("pg.bb.allWait", "Colour view of the loaded wavelengths: needs at least two of them.") : L("pg.bb.allTip", "Colour view of the loaded wavelengths (short blue, middle green, long red): for looking only.");
      all.setAttribute("aria-label", all.title);
      want.push(all);
    }
    const kids = [...row.children];
    if (kids.length !== want.length || kids.some((k, i) => k !== want[i])) row.replaceChildren(...want);

    // the answer: updated with every wavelength; never shrinks during a run; a short highlight on change
    const showAns = (!!m.answer || !m.complete) && (!m.complete || opts.keepAnswer) && !m.static;   // a run: the place is kept from the start
    ans.hidden = !showAns;
    if (showAns) {
      const txt = m.pending ? "\u00a0" : m.answer ? answerText(m.answer) : L("pg.bb.waitAns", "The first answer comes with the first wavelength."), based = m.pending ? "\u00a0" : m.answer ? basedText(m, !/µm/.test(txt)) : L("pg.bb.based0", "No wavelength loaded yet (0 of {m}).", { m: m.bins.length });
      const key = txt + "|" + based;
      if (key !== S.ansKey) {
        const first = !S.ansKey;
        S.ansKey = key;
        ans.innerHTML = `${esc(txt)}<span class="pg-n">${based.replace(/<(?!\/?span( class="pg-list")?>)/g, "&lt;")}</span>`;
        if (!first) {
          ans.classList.add("pg-flash");
          clearTimeout(S.flashT);
          S.flashT = setTimeout(() => ans.classList.remove("pg-flash"), 900);
        }
      }
      const h = ans.offsetHeight;
      if (h > S.minH && !m.complete) { S.minH = h; ans.style.minHeight = h + "px"; }
    }
    const n = note(), eta = etaText(m);
    line.hidden = m.static;
    if (etaHost === line) line.textContent = n || eta;
    else { line.textContent = n; if (etaHost) etaHost.textContent = eta; }
    window.__fzPgShown = S.shown;                       // for the explorer: stay at this wavelength when the final result opens
  }
  function update(model) {
    if (!model) return;
    S.model = model;
    if (S.want != null) {                                // the asked-for one arrived: show it
      const b = binOf(S.want);
      if (b && b.state === "done") { const u = S.want; S.want = null; S.retry = false; S.shown = u; paint(); opts.onShow && opts.onShow(u); return; }
      if (b && b.state !== "failed") S.retry = false;
    }
    if (S.shown === "all" && !model.composite) S.shown = null;
    if (typeof S.shown === "number" && !model.static) {  // the viewer's start wavelength is not loaded yet: wait for the first one
      const b = binOf(S.shown);
      if (!b || b.state !== "done") S.shown = null;
    }
    if (S.shown == null) {                               // the first loaded one is shown by itself
      const first = S.order.concat(model.order || []).map((u) => binOf(u)).find((b) => b && b.state === "done")
        || model.bins.find((b) => b.state === "done");
      if (first) { S.shown = first.um; paint(); opts.onShow && opts.onShow(first.um); return; }
    }

    paint();
  }
  addEventListener("resize", () => { S.minH = 0; ans.style.minHeight = ""; });
  onLang(() => { S.ansKey = ""; S.minH = 0; ans.style.minHeight = ""; paint(); });
  return { update, setShown(um) { if (S.shown !== um && !(um !== "all" && same(S.shown, um))) { S.shown = um; paint(); } }, shown: () => S.shown, el: host, get model() { return S.model; } };
}

// ---- ornek.html (result viewer: local engine and precomputed results) ----------------------------------------
const isLocal = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
/**
 * mountViewer(v): v = startViewer()'s api (meta, base, swapData). The bar replaces the viewer's wavelength
 * selector (#wl stays as the hidden control the bar drives: one place to choose). ?job=<id> (local engine):
 * the job's progressive object; each new stage folder is swapped in place (v.swapData). ?mock=1: mock events.
 */
export async function mountViewer(v) {
  const wl = $("wl"), lead = document.querySelector(".lead");
  if (!v || !v.meta || !wl || !lead) return null;
  await ensureCss();
  const Q = new URLSearchParams(location.search);
  const job = Q.get("job"), mock = Q.get("mock") === "1";
  const host = document.createElement("div");
  host.id = "pgBins";
  const keepFirst = () => {
    // placement only (site_sade): in the single-column layout the bar sits under the image, in its own slot #tsBins
    const slot = document.documentElement.classList.contains("ts-on") ? $("tsBins") : null;
    if (slot) { if (host.parentElement !== slot) slot.prepend(host); return; }
    if (lead.firstElementChild !== host) lead.prepend(host);                              // ui_shell puts its quick line first: the bar goes above
  };
  keepFirst();
  try { new MutationObserver(keepFirst).observe(lead, { childList: true }); } catch (_) { /* ignore */ }
  const wlLabel = wl.closest("label");
  if (wlLabel) wlLabel.hidden = true;

  let meta = v.meta, curUm = null, epoch = null, compOn = false, img = null, driver = null;
  const idxOf = (um) => (meta.wavelength_bins || []).findIndex((b) => same(b.wavelength_um, um));
  const compOff = () => { compOn = false; if (img) img.hidden = true; };
  const paintComp = () => {
    const c = bar.model && bar.model.composite;
    if (!compOn || !c) { compOff(); return; }
    if (!img) {
      img = document.createElement("img");
      img.id = "pgComp"; img.alt = ""; img.draggable = false;
      const z = $("zoomer"), fr = $("frame");
      if (!z || !fr) return;
      fr.after(img);
    }
    const f = c.frames.find((x) => x.epoch === epoch) || c.frames.find((x) => epoch && String(x.epoch).slice(0, 7) === String(epoch).slice(0, 7)) || c.frames[0];
    if (f && img.getAttribute("src") !== f.src) img.setAttribute("src", f.src);
    img.alt = lang() === "tr" ? c.caption_tr : c.caption_en;
    img.hidden = false;
  };
  const bar = createBinsBar(host, {
    etaHost: window.parent !== window && job ? null : undefined,     // inside the explorer its result strip has the time line
    onShow(um) {
      compOff();
      const i = idxOf(um);
      if (i < 0) return;
      if (String(wl.value) !== String(i) || !same(curUm, um)) { wl.value = String(i); wl.dispatchEvent(new Event("change")); }
    },
    onWant(um) {
      if (mock && driver) return driver.prioritize(um);
      if (job && isLocal()) fetch(`/api/jobs/${encodeURIComponent(job)}/priority`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bin_um: um }) }).catch(() => {});
    },
    onAll() { compOn = true; paintComp(); },
  });
  document.addEventListener("fazari:frame", (e) => {
    const d = e.detail || {};
    curUm = d.bin_um; epoch = d.epoch;
    if (!compOn) bar.setShown(curUm);
    else paintComp();
  });
  onLang(() => paintComp());
  const cur = v.current && v.current();
  if (cur && cur.bin_um != null) { curUm = cur.bin_um; bar.setShown(cur.bin_um); }   // the viewer's own start wavelength
  const H = document.documentElement;
  const finalOpen = () => /^\/jobs\/[^/]+\/$/.test(new URL(v.base, location.href).pathname) && !mock;   // the final result folder is on screen
  if ((job && isLocal() || mock) && !finalOpen()) {      // a run: its places (answer, time line) from the first paint, until the first poll
    H.classList.add("pg-live");
    bar.update({ ...staticModel(meta), static: false, complete: false, pending: true });
  } else bar.update(staticModel(meta));
  if (!job && !mock) return bar;

  // a progressive run: follow the job (or the mock), swap each new stage in place
  let stageKey = null, busy = null, last = null;
  const swap = async (m) => {
    stageKey = m.stageKey;
    try {
      const nm = await v.swapData(m.stageUrl, { meta: m.stageMeta, um: typeof bar.shown() === "number" ? bar.shown() : curUm });
      if (nm) meta = nm;
    } catch (e) { console.warn("bins_bar: stage", m.stageUrl, e); stageKey = null; }
  };
  const onJob = async (j) => {
    const m = fromLocal(j);
    if (!m) { H.classList.remove("pg-live"); bar.update(staticModel(meta)); return false; }
    last = m;
    const final = finalOpen();
    if (!final && m.stageUrl && m.stageKey !== stageKey && !m.complete && typeof v.swapData === "function") {
      if (!busy) { busy = swap(m); await busy; busy = null; }
    }
    const waitFinal = m.complete && !final && !mock;     // done: the final result opens in a moment; keep the run's answer until then
    H.classList.toggle("pg-live", (!m.complete || waitFinal) && !final);
    bar.update(waitFinal ? { ...m, complete: false } : m);
    if (typeof v.setArrow === "function") v.setArrow(final || arrowAllowed(m.answer));   // too uncertain: no motion arrow (it may upgrade later)
    paintComp();
    if (m.complete && m.state === "done" && m.finalUrl && !final && !mock && window.parent === window) {
      const um = bar.shown() !== "all" ? bar.shown() : curUm;   // standalone page: open the final result at this wavelength
      location.replace(`ornek.html?data=${m.finalUrl}&job=${encodeURIComponent(job)}` + (ok(um) ? `&um=${(+um).toFixed(1)}` : ""));
    }
    return !m.complete;
  };
  if (mock) {
    const M = await import("./bins_bar_mock.js");
    driver = M.mockLocal(v.meta, v.base, (j) => { onJob(j); }, { speed: +Q.get("mockspeed") || 1, fail: Q.get("mockfail"), reason: Q.get("mockreason") });
    window.__fzPgMock = driver;
    return bar;
  }
  if (!isLocal()) return bar;                          // static hosting: no /api (the bar is the wavelength choice only)
  let fails = 0;
  const poll = async () => {
    let again = true;
    try {
      const r = await fetch(`/api/jobs/${encodeURIComponent(job)}`, { cache: "no-store" });
      if (r.ok) { again = await onJob(await r.json()); fails = 0; } else fails++;
    } catch (_) { fails++; }
    if (again && fails < 600) setTimeout(poll, last && last.complete ? 3000 : 1000);
  };
  poll();
  return bar;
}

// ---- sky.html (browser engine) -------------------------------------------------------------------------------
let skyState = null;
/** A new run on sky.html: take the previous run's bar away and give the page its old controls back. */
export function resetSky() {
  if (!skyState) return;
  skyState.card.remove();
  if (skyState.eta) skyState.eta.remove();
  if (skyState.binsCard) skyState.binsCard.hidden = false;
  document.body.classList.remove("pg-run");
  document.removeEventListener("fazari:skyframe", skyState.onFrame);
  skyState = null;
}
/**
 * runSky(ctx): the whole run with Engine.loadAll (contract v1.1). ctx = {
 *   engine, alive(), stored(um, result, astrometry) (keep a loaded wavelength), show(um) (put it on screen),
 *   redraw() (draw the frame on screen again), canvas (the blink canvas), progress(bins) (optional: every event's
 *   per-wavelength done / accepted / checked counts) }. Resolves with loadAll's result.
 */
export async function runSky(ctx) {
  resetSky();
  await ensureCss();
  const viewer = $("viewer"), bins = $("bins");
  const card = document.createElement("div");
  card.className = "card pg-card"; card.id = "pgCard";
  const slot = document.documentElement.classList.contains("ts-on") ? $("tsBins") : null;   // single-column layout (js/ts_flow.js): its place is given
  if (slot) slot.prepend(card);
  else if (viewer) viewer.before(card);
  const binsCard = bins ? bins.closest(".card") : null;
  if (binsCard) binsCard.hidden = true;                // one place to choose the wavelength: the bar
  const row = document.querySelector(".progressrow");
  const eta = document.createElement("span");
  eta.className = "pg-eta";
  if (row) { row.prepend(eta); document.body.classList.add("pg-run"); }
  const acc = skyModel();
  let compOn = false;
  const drawComp = (season, zoom) => {
    const c = acc.model.composite, cv = ctx.canvas;
    if (!compOn || !c || !cv) return;
    const s = c.seasons.find((x) => x.season === season) || c.seasons[0];
    if (!s || !s.rgba) return;
    const n = c.n, off = document.createElement("canvas");
    off.width = off.height = n;
    off.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(s.rgba), n, n), 0, 0);
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    const z = Number(zoom) || 1, src = n / z, s0 = (n - src) / 2;
    g.drawImage(off, s0, s0, src, src, 0, 0, cv.width, cv.height);
  };
  const onFrame = (e) => { if (compOn) drawComp((e.detail || {}).season, (e.detail || {}).zoom); };
  document.addEventListener("fazari:skyframe", onFrame);
  const bar = createBinsBar(card, {
    etaHost: row ? eta : undefined, keepAnswer: true,
    onShow(um) { compOn = false; ctx.show(um); },
    onWant(um) { try { engine.prioritize(um); } catch (e) { console.warn("prioritize", e); } },
    onAll() { compOn = true; ctx.redraw(); },
  });
  skyState = { card, eta, binsCard, onFrame, bar };
  const engine = ctx.engine;
  const onEvent = (ev) => {
    if (!ctx.alive()) return;
    acc.feed(ev);
    if (ev.type === "bin" && ev.answer && ctx.setArrow) ctx.setArrow(arrowAllowed(ev.answer));   // before the frame is drawn again
    if (ev.type === "bin" && ev.state === "done" && ev.result) ctx.stored(ev.um, ev.result, ev.astrometry);
    if (ctx.progress && Array.isArray(ev.bins)) ctx.progress(ev.bins);
    bar.update(acc.model);
    if (ev.type === "composite" && compOn) ctx.redraw();
  };
  const out = await engine.loadAll({}, onEvent);
  const fin = out && (out.result || out);
  if (ctx.alive()) { acc.model.complete = true; if (fin && fin.answer) acc.model.answer = fin.answer; bar.update(acc.model); }
  return out;
}
