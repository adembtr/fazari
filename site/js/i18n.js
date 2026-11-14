// Fazari i18n: English / Turkish for every page. How to add text: site/i18n/README.md.
//
// Text lives in site/i18n/en.json and site/i18n/tr.json (flat { "key": "text with {param}" }).
// A key missing in tr.json falls back to English; if a JSON file cannot be loaded nothing breaks
// (static text stays as written in the page, t() falls back to its third argument or the key).
//
// Static HTML:   <span data-i18n="key">English</span>             text (English stays in the page)
//                <p data-i18n-html="key">English <b>markup</b></p>  trusted markup from the JSON files
//                <input data-i18n-attr="placeholder:key;title:key2">  attributes
//                <span data-i18n-toggle></span>                       the EN | TR switch is put here
// JavaScript:    import { t, tn, lang, num, loc, month, field, onLang } from "./i18n.js";
//                t("ex.found", { name })   num(10.24, 1) -> "10.2" / "10,2"   field(cat, "name") -> name_tr in TR
//                tname("Barnard's Star") -> "Barnard Yıldızı" in TR (tr.json key "tname.Barnard's Star")
//                onLang((l) => rerender())  or  document.addEventListener("fazari:lang", ...)
// Classic scripts and modules that must also run in Node (explain.js) use globalThis.__fzI18n.
//
// Language: ?lang=tr|en, else the saved choice (localStorage "fz-lang"), else the parent page's
// (iframes), else English. The choice is saved, kept in the URL (?lang=tr) and added to links to
// other pages of the site when they are clicked.

const KEY = "fz-lang";
const LANGS = ["en", "tr"];
const BASE = new URL("../i18n/", import.meta.url);
const listeners = new Set();
const original = new WeakMap();      // element -> { text, html, attrs } in English
const missing = new Set();           // keys asked for in Turkish that tr.json does not have yet

let cur = detect();
let EN = {}, TR = null;

/** One language file, or null if it cannot be loaded (tried 3 times; a file being rewritten can fail once). */
async function load(l) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(new URL(l + ".json", BASE), { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j && typeof j === "object") return j;
    } catch (e) {
      if (i === 2) console.warn(`i18n: ${l}.json not loaded`, e);
    }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  return null;
}

function detect() {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (LANGS.includes(q)) { try { localStorage.setItem(KEY, q); } catch (e) { /* storage blocked */ } return q; }
  } catch (e) { /* no location */ }
  // A page inside a frame of the site (the explorer's result panel) follows the page around it.
  try {
    const p = window.parent !== window && window.parent.__fzI18n && window.parent.__fzI18n.lang();
    if (LANGS.includes(p)) return p;
  } catch (e) { /* other origin */ }
  try {
    const s = localStorage.getItem(KEY);
    if (LANGS.includes(s)) return s;
  } catch (e) { /* storage blocked */ }
  return "en";
}

{
  const [en, tr] = await Promise.all([load("en"), cur === "tr" ? load("tr") : null]);
  EN = en || {}; TR = tr;
  if (!en || (cur === "tr" && !tr)) setTimeout(reload, 2000);
}
/** A language file failed at start: try again in the background, then redraw the page and tell the modules. */
async function reload(n = 0) {
  if (!Object.keys(EN).length) { const en = await load("en"); if (en) { EN = en; exact = null; } }
  if (cur === "tr" && !TR) TR = await load("tr");
  const ok = Object.keys(EN).length && (cur !== "tr" || TR);
  if (ok) { apply(document); notify(); } else if (n < 5) setTimeout(() => reload(n + 1), 3000 * (n + 1));
}

export function lang() { return cur; }

/** Text for key in the current language; {name} placeholders filled from params. */
export function t(key, params, fallback) {
  let s;
  if (cur === "tr" && TR && TR[key] != null) s = TR[key];
  else {
    if (cur === "tr") missing.add(key);
    s = EN[key] != null ? EN[key] : fallback != null ? fallback : key;
  }
  s = String(s);
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m)) : s;
}

/** Counted text: key.one / key.other ({n} is the count). Turkish needs only key.other. */
export function tn(key, n, params = {}) {
  const p = { n: num(n), ...params };
  const k = `${key}.${n === 1 ? "one" : "other"}`;
  if (cur === "tr" && TR && TR[k] == null && TR[key + ".other"] != null) return t(key + ".other", p);
  return t(k, p);
}

/** True when the key has text in the current language (Turkish: in tr.json). */
export function has(key) { return cur === "tr" ? !!TR && TR[key] != null : EN[key] != null; }

/** A number for display: fixed digits (optional), decimal comma in Turkish. Never use for input boxes. */
export function num(v, digits) {
  const x = Number(v);
  if (v == null || v === "" || !Number.isFinite(x)) return String(v ?? "");
  const s = digits == null ? String(x) : x.toFixed(digits);
  return cur === "tr" ? s.replace(".", ",") : s;
}

/** Decimal points inside a display string become commas in Turkish ("10.2″" -> "10,2″"). */
export function loc(s) { return cur === "tr" ? String(s ?? "").replace(/(\d)\.(\d)/g, "$1,$2") : String(s ?? ""); }

/** "2025-09" -> "Sep 2025" / "Eyl 2025" (long: "September 2025" / "Eylül 2025"). */
export function month(ep, long = false) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ep || ""));
  if (!m) return String(ep ?? "");
  try {
    return new Intl.DateTimeFormat(cur === "tr" ? "tr-TR" : "en-US", { month: long ? "long" : "short", year: "numeric", timeZone: "UTC" })
      .format(Date.UTC(+m[1], +m[2] - 1, 15));
  } catch (e) { return String(ep); }
}

/** A data field in the current language: obj.name_tr in Turkish when present, else obj.name. */
export function field(obj, name) {
  if (!obj) return "";
  if (cur === "tr" && obj[name + "_tr"] != null && obj[name + "_tr"] !== "") return obj[name + "_tr"];
  return obj[name] ?? "";
}

/** A sky object's name in the current language: tr.json "tname.<English name>" ("Barnard's Star" -> "Barnard Yıldızı"). */
export function tname(s) {
  if (s == null) return "";
  if (cur !== "tr" || !TR) return String(s);
  const v = TR["tname." + String(s).trim()];
  return v != null ? v : String(s);
}

// Sentences the pipeline writes into meta.json / faint.json (English only). In Turkish they are shown from
// tr.json: exact sentences are "pl.x.*" keys whose en.json text is the pipeline sentence itself; sentences
// with numbers match a pattern below ({0}, {1}, ... = the numbers, shown with a decimal comma).
const PIPE = [
  [/^Detected at (.+?) µm only \(≥5σ in single-season stacks, detectors (.+?)\); not detected at (.+?) µm\.$/, "pl.detSome"],
  [/^Proper motion \((.+?)\): (\d+) trial motions up to ([\d.]+) arcsec\/yr; (\d+) peak\(s\) at S\/N >= ([\d.]+), (\d+) matched to known movers, (\d+) candidate\(s\) for follow-up\.$/, "pl.ssRun"],
  [/^([\d.]+)"\/yr toward PA (\d+)°$/, "pl.motion"],
  [/^seen in one season only \(S\/N without the strongest season ([\d.]+)\)$/, "pl.oneSeason"],
  [/^static star on the path \((\d+) uJy\): probably its residual$/, "pl.staticStar"],
  [/^Preview: (\d+) images at ([\d.]+) µm in (\d+) seasons\. A quick look, not a measurement; the full result \(all wavelengths, Gaia-calibrated motion with error bars\) follows\.$/, "pl.preview"],
  [/^Not detected above (\d+σ) in single-season stacks \(best S\/N (-?[\d.]+), (\S+) (\S+)\)\.$/, "pl.notDetBest"],
  [/^Not detected above (\d+σ) in single-season stacks\.$/, "pl.notDet"],
  [/^Detected above (\d+σ) in every wavelength bin; some season x detector stacks are below (\d+σ) \(fitted only where detected\)\.$/, "pl.detBins"],
  [/^Detected at (.+?) µm \(≥(\d+σ)\) in season (\S+) only: no motion measurement\.$/, "pl.detOneAt"],
  [/^Detected in (.+?) \(≥(\d+σ)\) in season (\S+) only: no motion measurement\.$/, "pl.detOneIn"],
  [/^Detected at (.+?) µm only \(≥(\d+σ) in single-season stacks, detectors (.+?)\)\.$/, "pl.detAtOnly"],
  [/^Detected in (.+?) only \(≥(\d+σ) in single-season stacks, detectors (.+?)\); not detected at (.+?) µm\.$/, "pl.detInSome"],
  [/^Detected in (.+?) only \(≥(\d+σ) in single-season stacks, detectors (.+?)\)\.$/, "pl.detInOnly"],
  [/^preview: (\d+) images at ([\d.]+) um, (\d+) seasons$/, "pl.job.preview"],
  [/^reading and aligning exposure (\d+) of (\d+)$/, "pl.job.reading"],
  [/^post-step: (.+)$/, "pl.job.post"],
  [/^(\d+) cutouts ready, (\d+) skipped$/, "pl.job.cutoutsSkip"],
  [/^(\d+) cutouts ready$/, "pl.job.cutouts"],
  [/^(\d+) seasons, (\d+) wavelength bin\(s\)$/, "pl.job.seasons"],
  [/^(\d+) of (\d+) regions ready$/, "pl.job.regions"],
  [/^first look ready \((\d+) images\); (\d+) more regions coming$/, "pl.job.first"],
  [/^local server error: (.+)$/, "pl.job.serverErr"],
  [/^the job stopped \(exit code (-?\d+)\); see (.+)$/, "pl.job.stopped"],
  [/^Lost contact with the local engine \((.+)\)\.$/, "pl.job.lost"],
  [/^seasons sample different wavelengths within the bin \(([\d.]+)-([\d.]+) um\)$/, "pl.binSample"],
  [/^known object \(field target (.+?), not in Gaia DR3\)$/, "pl.knownField"],
  [/^not seen in the other telescope orientation \(expected S\/N ([\d.]+), measured ([\d.]+)\): probably a detector artifact$/, "pl.otherOrient"],
];
let exact = null;
function pipeOne(s) {
  if (!exact) exact = new Map(Object.entries(EN).filter(([k]) => k.startsWith("pl.x.")).map(([k, v]) => [v, k]));
  const k = exact.get(s);
  if (k && TR[k] != null) return TR[k];
  for (const [re, key] of PIPE) {
    const m = re.exec(s);
    if (m && TR[key] != null) {
      return TR[key].replace(/\{(\d)\}/g, (x, i) => {
        const v = m[+i + 1] ?? "";
        return v === "all wavelengths" ? t("pl.allWl", null, v) : loc(v.replace(/(\d) um$/, "$1 µm"));
      });
    }
  }
  return null;
}
/** A pipeline sentence (or "; "-joined list of them) in the current language; unknown text stays English. */
export function ptext(s) {
  if (s == null) return "";
  s = String(s);
  if (cur !== "tr" || !TR) return s;
  const whole = pipeOne(s.trim());
  if (whole != null) return whole;
  return s.split("; ").map((part) => pipeOne(part.trim()) ?? part).join("; ");
}

/** Translate data-i18n / data-i18n-html / data-i18n-attr elements under root. */
export function apply(root = document, { pageText = false } = {}) {
  if (!root || !root.querySelectorAll) return;
  const els = [...root.querySelectorAll("[data-i18n],[data-i18n-html],[data-i18n-attr]")];
  if (root.nodeType === 1 && root.matches("[data-i18n],[data-i18n-html],[data-i18n-attr]")) els.unshift(root);
  const tr = cur === "tr" && TR;
  for (const el of els) {
    let o = original.get(el);
    if (!o) {
      // English: what the page says (first sight in English, or the page as parsed); an element that
      // appears while Turkish is on may already hold Turkish, so take English from en.json then.
      const ds = el.dataset, fromPage = pageText || cur === "en";
      o = { attrs: {} };
      if (ds.i18n) o.text = !fromPage && EN[ds.i18n] != null ? EN[ds.i18n] : el.textContent;
      if (ds.i18nHtml) o.html = !fromPage && EN[ds.i18nHtml] != null ? EN[ds.i18nHtml] : el.innerHTML;
      for (const [a, k] of attrPairs(el)) o.attrs[a] = !fromPage && EN[k] != null ? EN[k] : el.getAttribute(a);
      original.set(el, o);
    }
    const ds = el.dataset;
    if (ds.i18n) {
      const v = tr && TR[ds.i18n] != null ? TR[ds.i18n] : o.text;
      if (tr && TR[ds.i18n] == null) missing.add(ds.i18n);
      if (el.textContent !== v) el.textContent = v;
    }
    if (ds.i18nHtml) {
      const v = tr && TR[ds.i18nHtml] != null ? TR[ds.i18nHtml] : o.html;
      if (tr && TR[ds.i18nHtml] == null) missing.add(ds.i18nHtml);
      if (el.innerHTML !== v) el.innerHTML = v;
    }
    for (const [a, k] of attrPairs(el)) {
      const v = tr && TR[k] != null ? TR[k] : o.attrs[a];
      if (tr && TR[k] == null) missing.add(k);
      if (v != null && el.getAttribute(a) !== v) el.setAttribute(a, v);
    }
  }
}

function attrPairs(el) {
  return (el.dataset.i18nAttr || "").split(";").map((p) => p.split(":").map((s) => s.trim())).filter((p) => p[0] && p[1]);
}

/** Listen for language changes (also: document event "fazari:lang", detail { lang }). Returns an unsubscribe. */
export function onLang(f) { listeners.add(f); return () => listeners.delete(f); }

/** Switch the language: saves it, updates the URL, the page, the toggles and same-site frames. */
export async function setLang(l, { save = true } = {}) {
  l = l === "tr" ? "tr" : "en";
  if (save) { try { localStorage.setItem(KEY, l); } catch (e) { /* storage blocked: this page only */ } }
  if (l === cur) { paintToggles(); return; }
  cur = l;                                     // at once, so a second call (frame, storage, message) is a no-op
  document.documentElement.lang = l;
  paintToggles();
  syncFrames(l);                               // the page around this frame and the frames inside it switch too
  if (l === "tr" && !TR) { TR = await load("tr"); if (!TR) setTimeout(reload, 2000); }
  if (cur !== l) return;                       // switched back while tr.json was loading
  try { origReplace(history.state, "", withLang(location.href)); } catch (e) { /* ignore */ }
  apply(document);
  notify();
}

function notify() {
  paintToggles();
  for (const f of [...listeners]) { try { f(cur); } catch (e) { console.warn("i18n listener", e); } }
  document.dispatchEvent(new CustomEvent("fazari:lang", { bubbles: true, detail: { lang: cur } }));
}

/** Tell same-site frames (inside and around this page) the language: a direct call, plus postMessage. */
function syncFrames(l, only) {
  const msg = { type: "fazari-lang", lang: l };
  const wins = [];
  for (const fr of document.querySelectorAll("iframe")) if (fr.contentWindow) wins.push(fr.contentWindow);
  if (window.parent !== window) wins.push(window.parent);
  for (const w of only ? [only] : wins) {
    try { if (w.__fzI18n && w.__fzI18n.lang() !== l) w.__fzI18n.setLang(l, { save: false }); } catch (e) { /* other origin */ }
    try { w.postMessage(msg, location.origin); } catch (e) { /* closed */ }
  }
}

/** A same-site page URL with ?lang=tr when Turkish is on (and without lang when English is). */
export function withLang(url, l = cur) {
  let u;
  try { u = new URL(String(url), location.href); } catch (e) { return url; }
  if (u.origin !== location.origin) return url;
  const parts = u.search.replace(/^\?/, "").split("&").filter((p) => p && !/^lang=/.test(p));
  if (l === "tr") parts.push("lang=tr");
  const search = parts.length ? "?" + parts.join("&") : "";
  if (search === u.search) return url;
  return u.pathname + search + u.hash;
}

/** The EN | TR switch (a group of two buttons). */
export function langButton(className = "fz-lang") {
  addStyle();
  const g = document.createElement("span");
  g.className = `${className} fz-langsw`;
  g.setAttribute("role", "group");
  g.setAttribute("aria-label", "Language / Dil");
  g.innerHTML = `<button type="button" data-l="en" lang="en" title="English">EN</button><span aria-hidden="true">|</span>` +
    `<button type="button" data-l="tr" lang="tr" title="Türkçe">TR</button>`;
  for (const b of g.querySelectorAll("button")) b.addEventListener("click", () => setLang(b.dataset.l));
  paintToggle(g);
  return g;
}

function paintToggle(g) {
  for (const b of g.querySelectorAll("button[data-l]")) b.setAttribute("aria-pressed", String(b.dataset.l === cur));
}
function paintToggles() { for (const g of document.querySelectorAll(".fz-langsw")) paintToggle(g); }

function mountToggles(root = document) {
  for (const slot of root.querySelectorAll("[data-i18n-toggle]")) {
    if (!slot.querySelector(".fz-langsw")) slot.appendChild(langButton(slot.dataset.i18nToggle || "fz-lang"));
  }
}

function addStyle() {
  if (document.getElementById("fz-i18n-style")) return;
  const st = document.createElement("style");
  st.id = "fz-i18n-style";
  st.textContent = `
.fz-langsw.fz-langsw { display:inline-flex; align-items:center; gap:1px; flex:none; white-space:nowrap; padding:2px; margin:0;
  font:700 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing:.04em; color:#cfd8ef;
  border:1px solid rgba(160,180,230,.35); border-radius:999px; background:rgba(8,12,24,.72); cursor:default; }
.fz-langsw > span { opacity:.4; padding:0 1px; }
.fz-langsw button { all:unset; box-sizing:border-box; cursor:pointer; padding:5px 8px; min-width:30px; text-align:center; border-radius:999px; opacity:.72; }
.fz-langsw button:hover { opacity:1; }
.fz-langsw button[aria-pressed="true"] { opacity:1; background:#7fd4ff; color:#021018; }
.fz-langsw button:focus-visible { outline:2px solid #7fd4ff; outline-offset:1px; }`;
  document.head.appendChild(st);
}

// ---------------------------------------------------------------------------------------------- boot
const origReplace = history.replaceState.bind(history);
// Pages rewrite their own URL (e.g. the explorer's ?p=); keep ?lang=tr in it while Turkish is on.
for (const m of ["replaceState", "pushState"]) {
  const orig = history[m].bind(history);
  history[m] = function (state, title, url) {
    if (url != null && cur === "tr") { try { url = withLang(url); } catch (e) { /* keep url */ } }
    return orig(state, title, url);
  };
}

// Links to other pages of the site carry the language (rewritten at click time, so page code is untouched).
function fixLink(e) {
  const a = e.target && e.target.closest && e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("#") || /^(mailto|javascript|data|blob):/i.test(href)) return;
  let u;
  try { u = new URL(href, location.href); } catch (err) { return; }
  if (u.origin !== location.origin || !/(\.html|\/)$/.test(u.pathname)) return;
  const next = withLang(href);
  if (next !== href) a.setAttribute("href", next);
}
for (const ev of ["click", "auxclick", "contextmenu"]) document.addEventListener(ev, fixLink, true);

// Another tab or frame changed the language.
addEventListener("storage", (e) => { if (e.key === KEY && LANGS.includes(e.newValue) && e.newValue !== cur) setLang(e.newValue, { save: false }); });
// A frame of the site (or the page around it) switched: follow it.
addEventListener("message", (e) => {
  const d = e.data;
  if (e.origin !== location.origin || !d || d.type !== "fazari-lang" || !LANGS.includes(d.lang) || d.lang === cur) return;
  setLang(d.lang, { save: false });
});
// A frame of the site finished loading (e.g. a new result in the explorer's panel): give it this page's language.
document.addEventListener("load", (e) => { if (e.target && e.target.tagName === "IFRAME" && e.target.contentWindow) syncFrames(cur, e.target.contentWindow); }, true);

// Elements added later with data-i18n (Turkish only needs work; English is already in the markup).
try {
  new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches("[data-i18n-toggle]") || n.querySelector("[data-i18n-toggle]")) mountToggles(n.parentNode || document);
        if (cur === "tr" && (n.matches("[data-i18n],[data-i18n-html],[data-i18n-attr]") || n.querySelector("[data-i18n],[data-i18n-html],[data-i18n-attr]"))) apply(n);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
} catch (e) { /* old browser: pages still call apply() themselves */ }

globalThis.__fzI18n = { t, tn, has, lang, num, loc, month, field, tname, ptext, apply, setLang, onLang, withLang, missing };
document.documentElement.lang = cur;
if (cur === "tr") { try { origReplace(history.state, "", withLang(location.href)); } catch (e) { /* ignore */ } }
apply(document, { pageText: true });
mountToggles();
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { apply(document, { pageText: true }); mountToggles(); });
