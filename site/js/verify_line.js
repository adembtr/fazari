// One short "how we checked this method" line, linked to verify.html, wherever a page has a place for it:
//   result page (ornek.html, sky.html, the explorer's result panel): the end of the Verdict tab (#tsPane-vd of
//     js/ts_flow.js's "C+" layout); loaded by js/verdict_strip.js. Not shown in the classic layout (?ui=classic).
//   explorer (explore.html): a full-width line right under the "Evidence" card of "Start here" (#tsNav);
//     loaded by explore/hero.js, which also puts the short form on the opening card (fillLine).
// Every number is read at load time, nothing is typed by hand:
//   data/fast_sweep/summary.json   stars measured and median difference from Gaia (test V12's sweep)
//   data/verify/tests.json          the number of tests and their status split; Barnard's Star from the first
//                                   Barnard test (V1: the blind finder run of the Python pipeline, not this page's run)
// If a file is missing, its part of the line is left out; with nothing to say, no line. Words: i18n "vl.*".
import { t, num, onLang } from "./i18n.js";

const BASE = new URL("../", import.meta.url);
const SWEEP = new URL("data/fast_sweep/summary.json", BASE).href;
const TESTS = new URL("data/verify/tests.json", BASE).href;
const PAGE = new URL("verify.html", BASE).href;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fin = (v) => v != null && v !== "" && Number.isFinite(+v);

let dataP = null;
async function getJson(url) {
  try { const r = await fetch(url, { cache: "no-cache" }); return r.ok ? await r.json() : null; } catch (e) { return null; }
}
/** { sweep: {n, pct}, barnard: {id, v, e, ref}, tests: {n, pass, fail, limit, other} }, parts null when unknown. */
export function loadVerify() {
  dataP ||= Promise.all([getJson(SWEEP), getJson(TESTS)]).then(([s, tj]) => {
    const all = s && s.all;
    const sweep = all && fin(all.n) && fin(all.median_abs_diff_pct) ? { n: +all.n, pct: +all.median_abs_diff_pct } : null;
    const list = tj && Array.isArray(tj.tests) ? tj.tests : [];
    let tests = null, barnard = null;
    if (list.length) {
      tests = { n: list.length, pass: 0, fail: 0, limit: 0, other: 0 };
      for (const x of list) tests[x && ["pass", "fail", "limit"].includes(x.status) ? x.status : "other"]++;
      const b = list.find((x) => /barnard/i.test(x?.title?.en || "") && fin(x?.numbers?.speed_arcsec_yr) && fin(x?.numbers?.err_speed));
      if (b) barnard = { id: b.id, v: +b.numbers.speed_arcsec_yr, e: +b.numbers.err_speed, ref: fin(b.numbers.ref_speed) ? +b.numbers.ref_speed : null };
    }
    return { sweep, barnard, tests };
  });
  return dataP;
}

/** The line as plain text; form "full" (sweep · Barnard · tests) or "short" (sweep · tests). "" if nothing is known. */
export function lineText(d, form = "full") {
  if (!d) return "";
  const parts = [];
  if (d.sweep) parts.push(t("vl.sweep", { n: num(d.sweep.n), pct: num(d.sweep.pct, 0) }));
  if (form === "full" && d.barnard) {
    const b = d.barnard;
    parts.push(t(b.ref != null ? "vl.barnard" : "vl.barnardNoRef", { id: b.id, v: num(b.v, 2), e: num(b.e, 2), ref: b.ref != null ? num(b.ref, 2) : "", yr: t("gr.yr") }));
  }
  if (d.tests) {
    const c = d.tests;
    const split = [t("vf.cnt.pass", { n: num(c.pass) }), t("vf.cnt.fail", { n: num(c.fail) })];
    if (c.limit) split.push(t("vf.cnt.limit", { n: num(c.limit) }));
    if (c.other) split.push(t("vf.cnt.other", { n: num(c.other) }));
    parts.push(t("vl.tests", { n: num(c.n), split: split.join(", ") }));
  }
  if (!parts.length) return "";
  return (d.sweep ? "" : t("vl.lead") + " ") + parts.join(" · ");
}

/** Fill one element with the linked line (and keep it in the page's language). */
export function fillLine(el, form = "full") {
  if (!el) return;
  style();
  const paint = (d) => {
    const s = lineText(d, form);
    el.hidden = !s;
    const html = s ? `<a href="${esc(PAGE)}" class="vl-a">${esc(s)} <span aria-hidden="true">→</span></a>` : "";
    if (el.innerHTML !== html) el.innerHTML = html;
  };
  el.hidden = true;
  loadVerify().then((d) => {
    paint(d);
    if (el.__vlLang) return;
    el.__vlLang = true;
    const off = onLang(() => { if (el.isConnected) paint(d); else off(); });    // a re-rendered card drops its old line
  });
}

// ------------------------------------------------------------------------------------------------ style
function style() {
  if (document.getElementById("vlStyle")) return;
  const s = document.createElement("style");
  s.id = "vlStyle";
  s.textContent = `
.vl-line { margin: 12px 0 0; font-size: 13px; line-height: 1.45; }
.vl-line[hidden] { display: none; }
.vl-line .vl-a { color: var(--ts-soft, #b8c2d6); text-decoration: none; display: block; padding: 8px 11px; border-radius: 10px;
  border: 1px solid var(--ts-line, rgba(160, 180, 230, .22)); background: rgba(255, 255, 255, .03); overflow-wrap: anywhere; }
.vl-line .vl-a:hover, .vl-line .vl-a:focus-visible { color: #fff; border-color: rgba(160, 180, 230, .5); }
.fz-ver.vl-line { margin: 12px 0 16px; }
html.ui.ui-page-explore .ex-nav a.xn-ver { grid-column: 1 / -1; display: block; font-size: 11px; line-height: 1.35; color: var(--ui-mut, #a9b3c9);
  padding: 4px 8px 5px; min-height: 0; }
html.ui.ui-page-explore .ex-nav a.xn-ver:hover { color: var(--ui-fg, #eef1f8); }
html.ui.ui-page-explore .ex-nav a.xn-ver[hidden] { display: none; }
`;
  document.head.append(s);
}

// ------------------------------------------------------------------------------------------------ places
function mountResult() {
  const pane = document.getElementById("tsPane-vd");
  if (!pane || document.getElementById("vlResult")) return;
  const p = document.createElement("p");
  p.id = "vlResult";
  p.className = "vl-line";
  pane.appendChild(p);
  fillLine(p, "full");
}
function mountExplore() {
  const card = document.querySelector('#tsNav a[href="verify.html"]');
  if (!card || document.getElementById("vlExplore")) return;
  const a = document.createElement("a");
  a.id = "vlExplore";
  a.className = "xn-ver";
  a.href = "verify.html";
  a.hidden = true;
  card.after(a);
  style();
  const paint = (d) => {
    const s = lineText(d, "full");
    a.hidden = !s;
    if (a.textContent !== s) a.textContent = s;
  };
  loadVerify().then((d) => { paint(d); onLang(() => paint(d)); });
}
mountResult();
mountExplore();
