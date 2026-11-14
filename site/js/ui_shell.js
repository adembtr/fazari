// Fazari UI layer, step 2 of 2 (module). Re-organises the existing page at runtime, without changing any
// existing script: collapsible sections (state kept per browser), a Simple / Detailed switch, the answer card
// of the result viewer, a hide/show for the explorer's panels. js/ui_boot.js sets html.ui first; with
// ?ui=classic (html.ui-classic) this module does nothing.
// Rule: a missing or renamed element means "skip that step", never an exception.

const H = document.documentElement;
const ON = H.classList.contains("ui") && !H.classList.contains("ui-classic");

// ---- i18n (falls back to English if the module is missing) ----------------------------------------------
let I = { t: (k, p, f) => fill(f || k, p), lang: () => "en", onLang: () => {} };
function fill(s, p) { return p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? p[k] : m)) : String(s); }
const EN = {
  "ui.mode.label": "View", "ui.mode.simple": "Simple", "ui.mode.detailed": "Detailed",
  "ui.mode.tip": "Simple shows the answer and the blink; Detailed opens every measurement and control.",
  "ui.hide": "Hide", "ui.show": "Show",
  "ui.ans.kicker": "The answer", "ui.ans.sure": "How sure are we",
  "ui.ans.confirmed": "Confirmed: {n} independent checks agree", "ui.ans.notConfirmed": "Candidate: not confirmed yet",
  "ui.ans.finder": "Candidate finder", "ui.ans.blink": "See it yourself: the blink",
  "ui.ans.sureNone": "No catalogue to compare with here; the numbers below show the measurement and its error.",
  "ui.tg.btn": "Other examples",
  "ui.side.view": "View settings", "ui.side.adv": "Advanced: faint objects and flagged pixels",
  "ui.what.diff": "Last season minus first. Still stars cancel out; a moving star leaves a blue (before) and red (after) pair.",
  "ui.what.measure": "The numbers behind the answer: position in each season against Gaia DR3, with 1σ errors.",
  "ui.what.spectrum": "Brightness against wavelength (0.75–5 µm), one point per exposure; colours are seasons.",
  "ui.what.cand": "Everything the automatic finder flagged here, sorted into known objects, candidates and artifacts.",
  "ui.what.faint": "How faint we can see: noise and 5σ limits of the deep stacks, and a search for faint movers.",
  "ui.ex.lead": "Pick any point on the sky. We show real SPHEREx images of it from different seasons and tell you whether something moved.",
  "ui.ex.hidePanel": "Hide this panel", "ui.ex.layers": "Star layers",
  "ui.ex.min": "Minimize the result panel", "ui.ex.tab": "Result",
  "ui.pg.collapseAll": "Collapse all", "ui.pg.expandAll": "Expand all",
  "u3.ans.prelim": "Preliminary answer", "u3.card.opts": "Options",
  "ts.ex.ready": "Show the result (ready)",
};
const T = (k, p) => { try { const v = I.t(k, p, EN[k] || k); return v && v !== k ? v : fill(EN[k] || k, p); } catch (e) { return fill(EN[k] || k, p); } };

// ---- storage (every access wrapped) --------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* blocked */ } },
};
const FOLD_KEY = "fz-ui-fold";
let folds = {};
try { folds = JSON.parse(store.get(FOLD_KEY, "{}")) || {}; } catch (e) { folds = {}; }
const saveFold = (id, open) => { folds[id] = open; store.set(FOLD_KEY, JSON.stringify(folds)); };
const mode = () => (H.getAttribute("data-ui-mode") === "detailed" ? "detailed" : "simple");
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, html) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (html != null) e.innerHTML = html; return e; };
const safe = (name, f) => { try { return f(); } catch (e) { console.warn("ui_shell:", name, e); } };
const CHEV = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---- collapsible sections --------------------------------------------------------------------------------
// A "fold" is an existing element whose first heading stays visible; a button opens/closes the rest.
// def: "open" | "closed" | "simple-closed" (closed in Simple mode, open in Detailed).
const FOLDS = new Map();     // id -> { find: () => element, head: (e) => heading, def, what }
function defaultOpen(def) { return def === "open" || (def === "simple-closed" && mode() === "detailed"); }
function isOpen(id, def) { return id in folds ? !!folds[id] : defaultOpen(def); }
function registerFold(id, spec) { FOLDS.set(id, spec); }
function ensureFolds() {
  for (const [id, sp] of FOLDS) safe("fold " + id, () => {
    const box = sp.find();
    if (!box) return;
    const head = sp.head ? sp.head(box) : box.querySelector(":scope > h2, :scope > h3");
    if (!head) return;
    if (!box.classList.contains("ui-fold")) box.classList.add("ui-fold");
    box.dataset.uiFold = id;
    if (!head.classList.contains("ui-fold-head")) {
      head.classList.add("ui-fold-head");
      head.addEventListener("click", (e) => { if (e.target.closest("a,button,input,select,label")) return; toggleFold(id); });
    }
    let btn = box.querySelector(":scope > .ui-fold-btn");
    if (!btn) {
      btn = el("button", { type: "button", class: "ui-fold-btn" });
      btn.addEventListener("click", () => toggleFold(id));
      head.after(btn);
    }
    if (sp.what && !box.querySelector(":scope > .ui-what")) {
      const w = el("p", { class: "ui-what" });
      w.dataset.k = sp.what;
      w.textContent = T(sp.what);
      btn.after(w);
    }
    paintFold(id, box);
  });
}
function paintFold(id, box) {
  const sp = FOLDS.get(id);
  if (!box || !sp) return;
  const open = isOpen(id, sp.def);
  box.classList.toggle("ui-shut", !open);
  const btn = box.querySelector(":scope > .ui-fold-btn");
  if (btn) {
    const word = open ? T("ui.hide") : T("ui.show");
    if (btn.dataset.st !== word) { btn.dataset.st = word; btn.innerHTML = `${CHEV}<span>${word}</span>`; }
    if (btn.getAttribute("aria-expanded") !== String(open)) btn.setAttribute("aria-expanded", String(open));
    const head = box.querySelector(".ui-fold-head");
    const lbl = (open ? T("ui.hide") : T("ui.show")) + ": " + (head ? head.textContent.trim().slice(0, 80) : "");
    if (btn.getAttribute("aria-label") !== lbl) btn.setAttribute("aria-label", lbl);
  }
}
function toggleFold(id, force) {
  const sp = FOLDS.get(id);
  if (!sp) return;
  const open = force != null ? force : !isOpen(id, sp.def);
  saveFold(id, open);
  paintFold(id, sp.find());
  document.dispatchEvent(new CustomEvent("fazari:ui-fold", { detail: { id, open } }));
}

// Boxes the shell creates itself (a header button + a body around existing nodes).
function makeBox(id, titleKey, nodes, def, extraClass = "") {
  const nodesOk = nodes.filter(Boolean);
  if (!nodesOk.length) return null;
  if ($("uiBox-" + id)) return $("uiBox-" + id);
  const box = el("section", { class: "ui-box " + extraClass, id: "uiBox-" + id });
  const head = el("h2", { class: "ui-box-h" });
  head.dataset.k = titleKey;
  head.textContent = T(titleKey);
  box.append(head);
  const body = el("div", { class: "ui-box-body" });
  nodesOk[0].before(box);
  for (const n of nodesOk) body.append(n);
  box.append(body);
  registerFold(id, { find: () => $("uiBox-" + id), head: (b) => b.querySelector(":scope > .ui-box-h"), def });
  return box;
}

// ---- Simple / Detailed switch -----------------------------------------------------------------------------
function modeSwitch(extraClass = "") {
  const w = el("div", { class: "ui-mode " + extraClass, role: "group" });
  const paint = () => {
    w.setAttribute("aria-label", T("ui.mode.label"));
    w.title = T("ui.mode.tip");
    w.innerHTML = `<span class="ui-mode-l">${T("ui.mode.label")}</span>` + ["simple", "detailed"].map((m) =>
      `<button type="button" data-m="${m}" aria-pressed="${mode() === m}">${T("ui.mode." + m)}</button>`).join("");
  };
  paint();
  w.addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (b) setMode(b.dataset.m); });
  document.addEventListener("fazari:ui-mode", paint);
  document.addEventListener("fazari:lang", paint);
  return w;
}
function setMode(m, { save = true, fromOutside = false } = {}) {
  if (m !== "simple") return;                         // one state (site_sade): there is no Detailed mode any more
  H.setAttribute("data-ui-mode", m);
  if (save) store.set("fz-ui-mode", m);
  // a mode switch resets the remembered fold choices to that mode's defaults
  for (const id of FOLDS.keys()) delete folds[id];
  store.set(FOLD_KEY, JSON.stringify(folds));
  for (const [id, sp] of FOLDS) safe("mode " + id, () => paintFold(id, sp.find()));
  document.dispatchEvent(new CustomEvent("fazari:ui-mode", { detail: { mode: m } }));
  if (!fromOutside) safe("frames", () => {          // tell a result panel inside this page / the page around it
    for (const f of document.querySelectorAll("iframe")) try { f.contentWindow.postMessage({ type: "fazari-ui-mode", mode: m }, location.origin); } catch (e) { /* ignore */ }
    if (window.parent !== window) window.parent.postMessage({ type: "fazari-ui-mode", mode: m }, location.origin);
  });
}
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "fazari-ui-mode") return;
  if (e.data.mode !== mode()) setMode(e.data.mode, { save: false, fromOutside: true });
});
window.addEventListener("storage", (e) => { if (e.key === "fz-ui-mode" && e.newValue && e.newValue !== mode()) setMode(e.newValue, { save: false, fromOutside: true }); });

// re-translate the shell's own text
function relabel() {
  for (const n of document.querySelectorAll("[data-k]")) {
    if (!n.closest(".ui-fold, .ui-box, .ui-answer, .ui-shell-own")) continue;
    if (n.classList.contains("ui-what") || n.classList.contains("ui-box-h") || n.classList.contains("ui-t")) n.textContent = T(n.dataset.k);
  }
  for (const n of document.querySelectorAll("[data-k-title]")) n.title = T(n.dataset.kTitle);
  for (const n of document.querySelectorAll("[data-k-aria]")) n.setAttribute("aria-label", T(n.dataset.kAria));
  for (const [id, sp] of FOLDS) safe("relabel " + id, () => paintFold(id, sp.find()));
}

// ---- watch the page: other scripts rebuild parts of it (innerHTML), re-apply idempotently ----------------
let pending = false;
const pageHooks = [];
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; ensureFolds(); for (const f of pageHooks) safe("hook", f); });
}

// =============================================================================================================
// Result viewer (ornek.html)
// =============================================================================================================
function setupViewer() {
  const app = document.querySelector(".app"), viewer = document.querySelector(".viewer");
  if (!app || !viewer || !$("stage")) return;
  H.classList.add("ui-page-viewer");

  // header: Simple/Detailed + "Other examples" (the five target shortcuts, closed by default)
  safe("header", () => {
    const top = document.querySelector("header.top");
    const tg = $("targets");
    if (!top) return;
    const tools = el("div", { class: "ui-top-tools ui-shell-own" });
    if (tg) {
      const b = el("button", { type: "button", class: "ui-pill", id: "uiTargetsBtn", "aria-controls": "targets" });
      const paint = () => {
        const open = isOpen("targets", "closed");
        tg.classList.toggle("ui-tg-shut", !open);
        b.setAttribute("aria-expanded", String(open));
        b.innerHTML = `<span class="ui-t" data-k="ui.tg.btn">${T("ui.tg.btn")}</span>${CHEV}`;
      };
      b.addEventListener("click", () => { saveFold("targets", !isOpen("targets", "closed")); paint(); });
      document.addEventListener("fazari:lang", paint);
      paint();
      tools.append(b);
    }
    top.append(tools);
  });

  // the answer card: plain sentence, then what we measured / what the catalogue says / how sure
  safe("answer", () => {
    const lead = document.querySelector(".viewer .lead"), result = $("result"), verdict = $("verdict");
    if (!lead || !result) return;
    const ans = el("section", { class: "ui-answer ui-shell-own", id: "uiAnswer", "aria-label": T("ui.ans.kicker") });
    ans.innerHTML = `<p class="ui-kicker"><span class="ui-t" data-k="ui.ans.kicker">${T("ui.ans.kicker")}</span></p>`;
    viewer.before(ans);
    ans.append(lead);
    const facts = el("div", { class: "ui-facts" });
    ans.append(facts);
    facts.append(result);
    const sure = el("div", { class: "ui-sure", id: "uiSure" });
    sure.innerHTML = `<span class="k ui-t" data-k="ui.ans.sure">${T("ui.ans.sure")}</span><b id="uiSurePct" hidden></b>` +
      `<span id="uiSureConf" class="ui-conf" hidden></span><p id="uiSureTxt" class="ui-sure-txt" hidden></p>`;
    facts.append(sure);
    if (verdict) sure.append(verdict);
    const fin = el("p", { class: "ui-finder", id: "uiFinder", hidden: "" });
    ans.append(fin);
    const extra = el("div", { class: "ui-answer-extra", id: "uiAnswerExtra" });
    ans.append(extra);
    // other plug-ins add notes after #verdict (e.g. the exoplanet-host note): keep them in the answer card,
    // below the three facts, not inside "How sure"
    const own = new Set(["uiSurePct", "uiSureConf", "uiSureTxt", "verdict", "vdSure"]);   // vdSure: js/verdict_strip.js (Simple mode line)
    const tidy = () => {
      // a tile without a value ("Measured: –", "Compared with: –") adds nothing: hidden (viewer.js marks .empty too)
      for (const tl of document.querySelectorAll("#tiles > .tile")) { const b = tl.querySelector("b"); tl.classList.toggle("ui-empty", !!b && /^[–-]?$/.test(b.textContent.trim())); }
      for (const n of [...sure.children]) if (!n.classList.contains("k") && !own.has(n.id)) extra.append(n);
      // "How sure" without anything in it, and the whole facts row when nothing in it is visible: hidden
      const filled = (id) => { const e = $(id); return !!e && !e.hidden && !!e.textContent.trim(); };
      sure.classList.toggle("ui-empty", !(filled("uiSurePct") || filled("uiSureConf") || filled("uiSureTxt") || filled("verdict")));
      requestAnimationFrame(() => safe("facts", () => {
        facts.classList.remove("ui-none");                 // measure with the row shown, then hide it if nothing in it is visible
        const any = [...facts.querySelectorAll(".tile, .ui-sure, #pairNote, .badges")].some((e) => e.getClientRects().length && e.offsetHeight > 0);
        facts.classList.toggle("ui-none", !any);
      }));
      // a preview: the answer is preliminary (one honest word in the kicker, no repeat elsewhere)
      const sb = $("stagebar"), kick = ans.querySelector(".ui-kicker .ui-t");
      const pre = !!(sb && !sb.hidden && sb.classList.contains("preview"));
      if (kick && kick.dataset.k !== (pre ? "u3.ans.prelim" : "ui.ans.kicker")) { kick.dataset.k = pre ? "u3.ans.prelim" : "ui.ans.kicker"; kick.textContent = T(kick.dataset.k); }
    };
    pageHooks.push(tidy);
    document.addEventListener("fazari:ui-mode", () => safe("tidy", tidy));
    // the explorer's quick decision ("does the clicked object move?", preliminary) while a preview is on screen:
    // it becomes the answer's sentence (shown once), the numbers go to Detailed mode
    const quick = el("div", { class: "ui-quick", id: "uiQuick", hidden: "" });
    quick.innerHTML = `<p class="ui-quick-t"></p><p class="ui-quick-s"></p><p class="ui-quick-n"></p>`;
    lead.prepend(quick);
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (e.origin !== location.origin || !d || d.type !== "fazari-quick" || e.source !== window.parent) return;
      safe("quick", () => {
        quick.querySelector(".ui-quick-t").textContent = String(d.text || "");
        quick.querySelector(".ui-quick-s").textContent = String(d.sure || "");
        quick.querySelector(".ui-quick-n").textContent = String(d.line2 || "");
        quick.hidden = !d.text;
        ans.classList.toggle("ui-has-quick", !!d.text);
      });
    });
    loadFinder();
  });

  // side panel: view settings (open), advanced controls (closed in Simple mode)
  safe("side", () => {
    const ctr = document.querySelector(".side > .controls");
    if (ctr) makeBox("view", "ui.side.view", [ctr], "simple-closed", "ui-side-box");
    const fc = $("faintControls"), flc = $("flagControls");
    if (fc || flc) makeBox("adv", "ui.side.adv", [fc, flc], "simple-closed", "ui-side-box");
  });

  // lower cards: each with its heading as the toggle and one line saying what it shows
  registerFold("strip", { find: () => null });   // the "What you are seeing" strip is already a <details>
  registerFold("diff", { find: () => document.querySelector(".lower > .card.diff"), def: "simple-closed", what: "ui.what.diff" });
  registerFold("measure", { find: () => ($("measure") || {}).parentElement, def: "simple-closed", what: "ui.what.measure" });
  registerFold("spectrum", { find: () => $("spectrum"), def: "simple-closed", what: "ui.what.spectrum" });
  registerFold("cand", { find: () => document.querySelector("#candidateList > .card"), def: "simple-closed", what: "ui.what.cand" });
  registerFold("faint", { find: () => $("faintcard"), def: "simple-closed", what: "ui.what.faint" });
  FOLDS.delete("strip");
  pageHooks.push(() => {
    const d = document.querySelector("#explainStrip > details");
    if (!d || d.dataset.uiSeen) return;
    d.dataset.uiSeen = "1";
    if (mode() === "simple" && !("strip" in folds)) d.open = false;
    d.addEventListener("toggle", () => { if (d.dataset.uiSet !== "1") saveFold("strip", d.open); d.dataset.uiSet = ""; });
  });
  document.addEventListener("fazari:ui-mode", () => {
    const d = document.querySelector("#explainStrip > details");
    if (d) { d.dataset.uiSet = "1"; d.open = mode() === "detailed"; }
  });
}

// candidates.json: verdict.text, best candidate's confidence and confirmation (new fields; null = not shown)
let finderDoc = null;
async function loadFinder() {
  let base = null;
  try { base = new URLSearchParams(location.search).get("data"); } catch (e) { /* ignore */ }
  if (!base) return;
  if (!/\/$/.test(base)) base += "/";
  try {
    const r = await fetch(base + "candidates.json", { cache: "no-cache" });
    if (!r.ok) return;
    finderDoc = await r.json();
  } catch (e) { return; }
  paintFinder();
  document.addEventListener("fazari:post", () => setTimeout(() => { finderDoc = null; loadFinder(); }, 300), { once: true });
}
function paintFinder() {
  safe("finder", () => {
    const d = finderDoc;
    const pct = $("uiSurePct"), conf = $("uiSureConf"), txt = $("uiSureTxt"), fin = $("uiFinder");
    if (!d || !pct) return;
    const v = d.verdict && typeof d.verdict === "object" ? d.verdict : null;
    const list = Array.isArray(d.candidates) ? d.candidates : [];
    const best = v && v.best != null ? list.find((c) => c && c.id === v.best) : null;
    const c = best && best.confidence && typeof best.confidence === "object" ? best.confidence : null;
    const p = c && typeof c.percent === "number" && isFinite(c.percent) ? c.percent : null;
    pct.hidden = p == null;
    if (p != null) {
      const s = p >= 99.95 ? ">99.9" : p >= 99 ? p.toFixed(1) : String(Math.round(p));
      pct.textContent = (I.lang() === "tr" ? "%" + s.replace(".", ",") : s + " %");
    }
    txt.hidden = !(c && c.sentence);
    if (c && c.sentence) txt.textContent = c.sentence;
    if (best && typeof best.confirmed === "boolean") {
      const n = best.confirmation && best.confirmation.n_independent;
      conf.hidden = false;
      conf.className = "ui-conf " + (best.confirmed ? "yes" : "no");
      conf.textContent = best.confirmed ? T("ui.ans.confirmed", { n: n != null ? n : "≥2" }) : T("ui.ans.notConfirmed");
    } else conf.hidden = true;
    fin.hidden = !(v && v.text);
    if (v && v.text) fin.innerHTML = `<b class="ui-t" data-k="ui.ans.finder">${T("ui.ans.finder")}</b> ${String(v.text).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch])}`;
  });
}

// The explorer's stage badge while the result panel loads wavelength by wavelength: the panel (js/verdict_strip.js)
// reports loaded / all wavelengths and the image count ("fazari-vd-stage"); the badge says that, then
// "Full result (N images)" at the end, instead of keeping "Preview (8 images)" from before the run.
function stageBadge() {
  const fr = $("blinkFrame");
  if (!fr) return;
  let last = null;
  const sfx = (n) => { const d = n % 10, z = n % 100; return n === 0 ? "'ı" : d === 0 ? ({ 10: "'u", 20: "'si", 30: "'u", 40: "'ı", 50: "'si", 60: "'ı", 70: "'i", 80: "'i", 90: "'ı" })[z] || "'ı" : ["", "'i", "'si", "'ü", "'ü", "'i", "'sı", "'si", "'i", "'u"][d]; };
  const paint = () => {
    const b = $("blinkStage"), d = last;
    if (!b || !d || fr.contentWindow == null) return;
    let src = ""; try { src = fr.contentWindow.location.href; } catch (e) { /* other origin */ }
    if (src && d.src && src !== d.src) return;            // a message from a page that is no longer in the panel
    const tr = I.lang() === "tr";
    const of = T("vd.of", { n: d.k, m: d.m, sfx: tr ? sfx(d.k) : "" });
    const txt = d.complete ? T("vd.badge.full", { n: d.n }) : T("vd.badge.run", { of, n: d.n });
    b.hidden = false;
    b.className = "stage-badge " + (d.complete ? "full" : "preview");
    if (b.textContent !== txt) b.textContent = txt;
  };
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.origin !== location.origin || !d) return;
    if (d.type === "fazari-vd-stage" && e.source === fr.contentWindow) { last = d; paint(); }
    else if (d.type === "fazari-stage") setTimeout(paint, 0);   // the page's own badge message comes first, then ours
  });
  document.addEventListener("fazari:lang", () => setTimeout(paint, 60));
  // a new panel page: forget the old numbers (the page's own badge takes over until the new page reports)
  try { new MutationObserver(() => { last = null; }).observe(fr, { attributes: true, attributeFilter: ["src"] }); } catch (e) { /* ignore */ }
  // main.js sets the badge itself when a job ends ("Full result"): keep ours when it would say the same thing
  try { const b = $("blinkStage"); if (b) new MutationObserver(() => { if (last && last.complete === false) setTimeout(paint, 0); }).observe(b, { childList: true, characterData: true, subtree: true }); } catch (e) { /* ignore */ }
}

// =============================================================================================================
// Sky Explorer (explore.html)
// =============================================================================================================
function setupExplore() {
  const panel = $("panel");
  if (!panel || !$("sky")) return;
  H.classList.add("ui-page-explore");
  safe("stageBadge", stageBadge);
  const body = $("panelBody");

  // one-line "what is this" at the top of the panel
  safe("lead", () => {
    const title = panel.querySelector(".panel-title");
    if (!title || $("uiExLead")) return;
    const p = el("p", { class: "ui-ex-lead ui-shell-own", id: "uiExLead" });
    p.innerHTML = `<span class="ui-t" data-k="ui.ex.lead">${T("ui.ex.lead")}</span>`;
    title.after(p);
  });

  // One state, nothing to open or close (site_sade): the left panel, the star layers and the Finds list are simply
  // there; no Simple / Detailed switch.
  // The place card: title, one line, ONE main button; the coordinates, the field size and the two small actions
  // (Zoom in, Copy link) sit on one quiet line under it. Only the parents change; main.js / fov_ui.js find them by id.
  safe("card", () => {
    const card = $("card"), acts = card && card.querySelector(".actions");
    if (!acts || $("tsCardMore")) return;
    const more = el("div", { class: "ts-card-more ui-shell-own", id: "tsCardMore" });
    for (const n of [card.querySelector(".coords"), card.querySelector(".fov-row"), $("btnZoom"), $("btnShare")]) if (n) more.append(n);
    acts.after(more);
    const look = $("btnLook"), gal = $("btnGallery");
    if (gal) gal.removeAttribute("data-i18n");               // its words here: "Show the result (ready)"
    const paintGal = () => { if (gal) { const s = T("ts.ex.ready"); if (gal.textContent !== s) gal.textContent = s; } };
    const missing = new Set();
    let timer = null;
    const sync = () => {
      let sel = null;
      try { sel = window.__explore.state.selected; } catch (e) { /* not started yet */ }
      card.classList.toggle("ts-manual", !!(sel && sel.manual));
      card.classList.toggle("ts-place", !!(sel && !sel.manual));
      // the five targets have a finished result (main.js shows #btnGallery once it has checked the files): that is
      // the main button, and fetching the images live becomes the small link on the details line. Decided from the
      // place itself, so the card does not jump while the check runs; taken back if the result is not there.
      const ready = !!(gal && sel && sel.challenge && sel.gallery && !missing.has(sel.id));
      clearTimeout(timer);
      if (ready && gal.hidden) timer = setTimeout(() => { let now = null; try { now = window.__explore.state.selected; } catch (e) { /* ignore */ } if (gal.hidden && now && now.id === sel.id) { missing.add(sel.id); sync(); } }, 2500);
      if (look && card.classList.contains("ts-ready") !== ready) {
        card.classList.toggle("ts-ready", ready);
        if (ready) { more.insertBefore(look, $("btnZoom")); gal.setAttribute("data-tour", "fetch-button"); look.removeAttribute("data-tour"); }
        else { acts.prepend(look); look.setAttribute("data-tour", "fetch-button"); if (gal) gal.removeAttribute("data-tour"); }
      }
      paintGal();
    };
    try { new MutationObserver(sync).observe(card, { attributes: true, attributeFilter: ["hidden"], subtree: true, childList: true, characterData: true }); } catch (e) { /* ignore */ }
    document.addEventListener("fazari:lang", () => setTimeout(paintGal, 40));
    sync();
  });

  // result panel: minimize to a tab on the right edge, reopen from the tab
  safe("blink", () => {
    const bl = $("blink"), close = $("blinkClose");
    if (!bl || !close) return;
    const min = el("button", { type: "button", class: "ui-blink-min ui-shell-own", id: "uiBlinkMin" });
    min.dataset.kAria = "ui.ex.min"; min.dataset.kTitle = "ui.ex.min";
    min.setAttribute("aria-label", T("ui.ex.min")); min.title = T("ui.ex.min");
    min.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    close.before(min);
    const tab = el("button", { type: "button", class: "ui-blink-tab ui-shell-own", id: "uiBlinkTab", hidden: "" });
    tab.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="ui-t" data-k="ui.ex.tab">${T("ui.ex.tab")}</span>`;
    document.body.append(tab);
    const sync = () => {
      const shown = !bl.hidden && bl.classList.contains("in");
      if (!shown && bl.classList.contains("ui-min")) bl.classList.remove("ui-min");
      tab.hidden = !(shown && bl.classList.contains("ui-min"));
      document.body.classList.toggle("ui-blink-minimized", !tab.hidden);
    };
    min.addEventListener("click", () => { bl.classList.add("ui-min"); sync(); tab.focus(); });
    tab.addEventListener("click", () => { bl.classList.remove("ui-min"); sync(); min.focus(); });
    new MutationObserver(sync).observe(bl, { attributes: true, attributeFilter: ["class", "hidden"] });
    const fr = $("blinkFrame");             // a new result opens the panel again
    if (fr) new MutationObserver(() => { bl.classList.remove("ui-min"); sync(); }).observe(fr, { attributes: true, attributeFilter: ["src"] });
    sync();
  });
}

// =============================================================================================================
// Reading pages (verify, story, planetx, asteroids, comets): one navigation, nothing to open or close (site_sade).
// Every section stays open (the folds and the "collapse all" bar of the earlier layer are gone).
// =============================================================================================================
// The pages of the site, in the same order and with the same words as the result page's own row (ornek.html #tsNav).
const NAV = [
  ["explore.html?hero=0", "ts.nav.sky", "Sky map", "explore.html"], ["ornek.html?data=data/barnard/", "ts.nav.targets", "Five targets", "ornek.html"],
  ["verify.html", "ts.nav.evidence", "Evidence", "verify.html"], ["planetx.html", "px.nav", "Planet X", "planetx.html"],
  ["asteroids.html", "ts.nav.ast", "Asteroids", "asteroids.html"], ["comets.html", "ts.nav.comets", "Comets", "comets.html"],
  ["story.html", "ts.nav.story", "Story", "story.html"], ["vr.html", "ts.nav.vr", "Inside the sky (VR)", "vr.html"],
];
/** Make the page's navigation the common one (static markup already has it on most pages; planetx.html gets it here). */
function commonNav(pg) {
  let nav = document.querySelector("header .pg-nav");
  if (!nav) {                                            // pages with a plain ".top" header: the row after the brand
    const brand = document.querySelector("header.top > .brand");
    if (!brand) return;
    nav = el("nav", { class: "pg-nav ui-pgnav", "aria-label": "Pages", "data-i18n-attr": "aria-label:ts.nav.aria" });
    brand.after(nav);
  }
  const want = NAV.map((x) => x[0]).join("|");
  if ([...nav.querySelectorAll(":scope > a")].map((a) => a.getAttribute("href")).join("|") !== want) {
    const keep = [...nav.children].filter((c) => c.tagName !== "A");          // anything else in it (buttons) stays, after the links
    nav.textContent = "";
    for (const [href, key, en] of NAV) nav.append(el("a", { href, "data-i18n": key }, en));
    for (const c of keep) nav.append(c);
    try { if (I.apply) I.apply(nav); } catch (e) { /* English stays */ }
  }
  for (const a of nav.querySelectorAll(":scope > a")) {
    const here = NAV.find((x) => x[0] === a.getAttribute("href"));
    if (here && here[3] === pg) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}
function setupReading(pg) {
  H.classList.add("ui-page-reading");
  commonNav(pg);
}

// =============================================================================================================
async function main() {
  if (!ON) return;
  try { I = await import("./i18n.js"); } catch (e) { console.warn("ui_shell: i18n.js missing, English only", e); }
  const pg = (location.pathname.split("/").pop() || "").toLowerCase();
  // single-column result layout (site_sade): js/ts_flow.js has already built ornek.html / sky.html, one state,
  // nothing folds. The older answer-card layout below only runs if that script did not load.
  if (H.classList.contains("ts-on")) { /* nothing to re-organise */ }
  else if ($("stage") && $("tiles")) safe("viewer", setupViewer);
  else if ($("panel") && $("sky")) safe("explore", setupExplore);
  else if ($("bins") && $("cancel") && $("viewer")) safe("sky", () => { H.classList.add("ui-page-sky"); });      // sky.html (in-browser engine)
  else if (/^(verify|story|asteroids|comets|planetx)\.html$/.test(pg) || document.querySelector("main section.blk")) safe("reading", () => setupReading(pg));
  ensureFolds();
  try { I.onLang(() => { relabel(); paintFinder(); }); } catch (e) { /* ignore */ }
  document.addEventListener("fazari:lang", () => setTimeout(relabel, 30));
  // other modules rebuild cards (language switch, post-steps arriving): put the fold buttons back
  try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
  H.classList.add("ui-ready");
}
main();
