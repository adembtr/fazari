// verify.html, section "#tests": the numbered validation tests (V1, V2, ...), drawn at load time from
//   data/verify/tests.json            written by the test round (id, title/result EN+TR, numbers, status, evidence)
//   data/verify/evidence/*.csv        the evidence tables (old | new version side by side)
// Nothing here is hard-coded per test: a new tests.json after a re-test updates the page with no code change.
// A field missing from tests.json is simply not shown. Labels: site/i18n/{en,tr}.json keys "vf.*".

import { t, lang, num, onLang, apply } from "./i18n.js";

const BOX_ID = "vfBox";
const SRC = "data/verify/tests.json";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tx = (o) => (o && typeof o === "object" ? (lang() === "tr" && o.tr ? o.tr : o.en ?? o.tr ?? "") : o ?? "");
const STATUS = { pass: "pass", fail: "fail", limit: "limit" };
const MARK = { pass: "✓", fail: "✗", limit: "–" };

let DATA = null;
const csvCache = new Map();

// ------------------------------------------------------------------------------------------------ style
function style() {
  if (document.getElementById("vfStyle")) return;
  const s = document.createElement("style");
  s.id = "vfStyle";
  s.textContent = `
#tests .vf-sum { margin: 0 0 6px; font-size: 17px; line-height: 1.5; }
#tests .vf-sum .res { margin-right: 6px; }
#tests .vf-meta { margin: 0 0 4px; }
#tests .vf-legend { margin: 0 0 14px; }
#tests .vf-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
#tests .vf-item { border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 12px; padding: 12px 14px; background: var(--card); min-width: 0; }
#tests .vf-item.pass { border-left-color: var(--good); }
#tests .vf-item.fail { border-left-color: var(--bad); }
#tests .vf-item.limit { border-left-color: var(--warn); }
#tests .vf-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
#tests .vf-id { font-weight: 800; color: var(--blue); font-variant-numeric: tabular-nums; min-width: 2.4em; }
#tests .vf-title { font-weight: 700; flex: 1 1 14em; min-width: 0; }
#tests .vf-res { margin: 6px 0 0; color: var(--soft); overflow-wrap: anywhere; }
#tests .vf-mean { margin: 6px 0 0; font-size: 14.5px; color: var(--fg); }
#tests .vf-mean b { color: var(--bad); }
#tests .vf-foot { margin: 8px 0 0; display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline; font-size: 13.5px; }
#tests .vf-mt { border: 0; background: none; padding: 0; font: inherit; color: var(--mut); cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
#tests .vf-mt:hover { color: var(--fg); }
#tests .vf-mt::before { content: "▸ "; }
#tests .vf-mt[aria-expanded="true"]::before { content: "▾ "; }
#tests .vf-more[hidden], #tests .vf-csvwrap[hidden] { display: none; }
#tests .vf-nums { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 2px 18px; margin: 8px 0 0; font-size: 13.5px; }
#tests .vf-nums > div { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; border-bottom: 1px dotted var(--line); min-width: 0; }
#tests .vf-nums dt { color: var(--mut); min-width: 0; }
#tests .vf-nums dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
#tests .vf-nums dd small { color: var(--mut); }
#tests .vf-bars { display: grid; gap: 6px; margin: 10px 0 0; font-size: 13.5px; }
#tests .vf-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: baseline; }
#tests .vf-bar .tr { grid-column: 1 / -1; height: 6px; border-radius: 3px; background: rgba(160, 180, 230, .14); overflow: hidden; }
#tests .vf-bar .tr i { display: block; height: 100%; background: var(--blue); border-radius: 3px; }
#tests .vf-bar span { color: var(--mut); }
#tests .vf-bar b { font-variant-numeric: tabular-nums; font-weight: 650; }
#tests .vf-csv { margin: 10px 0 0; overflow-x: auto; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; }
#tests .vf-csv table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
#tests .vf-csv th, #tests .vf-csv td { padding: 3px 8px; border-bottom: 1px solid var(--line); text-align: left; }
#tests .vf-csv th { color: var(--mut); font-weight: 600; }
#tests .res.limit { background: rgba(255, 179, 107, .12); color: var(--warn); border: 1px solid rgba(255, 179, 107, .5); }
#tests .vf-item.fail { border-left-color: #ff9a5a; }
#tests .res.fail { background: rgba(255, 154, 90, .12); color: #ff9a5a; border: 1px solid rgba(255, 154, 90, .5); }
#tests .vf-short { margin: 6px 0 0; font-size: 15px; line-height: 1.45; color: var(--fg); }
#tests .vf-short b { color: #ff9a5a; font-weight: 700; }
#tests .vf-item.fail .vf-mean b { color: #ff9a5a; }
#tests .res.other { background: rgba(169, 179, 201, .08); color: var(--soft); border: 1px solid var(--line); }
`;
  document.head.append(s);
}

// ------------------------------------------------------------------------------------------------ helpers
const isDetailed = () => document.documentElement.getAttribute("data-ui-mode") === "detailed";
const stKey = (s) => STATUS[s] || "other";
function badge(s) {
  const k = stKey(s);
  const label = k === "other" ? String(s ?? "") : t("vf.st." + k);
  return `<span class="res ${k === "other" ? "other" : k}">${MARK[k] ? MARK[k] + " " : ""}${esc(label)}</span>`;
}
/** Label for a key in tests.json "numbers": vf.k.<key>, else the key with spaces. */
/** Text for key if en.json/tr.json has it, else null. */
const opt = (key) => { const s = t(key, null, ""); return s && s !== key ? s : null; };
const label = (k) => opt("vf.k." + k) ?? k.replace(/_/g, " ");
function val(k, v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return esc(num(v));
  if (typeof v === "boolean") return esc(t(v ? "vf.yes" : "vf.no"));
  if (Array.isArray(v)) return v.every((x) => typeof x === "number") ? esc(v.map((x) => num(x)).join(" · ")) : null;
  if (typeof v === "string") {
    const tv = opt("vf.v." + k + "." + v);
    if (tv) return esc(tv);
    // a free-text English sentence from the data is shown in English only (no invented translation)
    if (lang() === "tr" && / /.test(v) && /[a-z]{3}/.test(v) && !/^\d{4}-\d\d-\d\d/.test(v)) return null;
    return esc(v);
  }
  return null;
}
/** Count pairs in "numbers" drawn as bars: x_recovered / x_injected, found_x / known_x, x_found / x_known. */
function pairs(n) {
  const out = [], used = new Set();
  for (const k of Object.keys(n)) {
    let m, other, stem;
    if ((m = /^(.+)_recovered$/.exec(k))) { other = m[1] + "_injected"; stem = m[1]; }
    else if ((m = /^found_(.+)$/.exec(k))) { other = "known_" + m[1]; stem = m[1]; }
    else if ((m = /^(.+)_found$/.exec(k))) { other = m[1] + "_known"; stem = m[1]; }
    if (!m || typeof n[k] !== "number" || typeof n[other] !== "number" || n[other] <= 0) continue;
    out.push({ stem, a: n[k], b: n[other], ka: k, kb: other });
    used.add(k); used.add(other);
  }
  return { out, used };
}

// ------------------------------------------------------------------------------------------------ plain words (grafikler)
/** The finder's labels in a result sentence -> plain words (the sentence itself comes from tests.json). */
function plain(s) {
  return String(s || "")
    .replace(/^Found blind as gaia-known \([^)]*\):/, t("gr.vf.known"))
    .replace(/^Found blind as candidate \([^)]*\):/, t("gr.vf.cand"))
    .replace(/^Konum verilmeden bilinen Gaia hareketlisi olarak bulundu \([^)]*\):/, t("gr.vf.known"))
    .replace(/^Konum verilmeden aday olarak bulundu \([^)]*\):/, t("gr.vf.cand"))
    .replace(/(\d)"\/(yr|yıl)/g, "$1″/$2").replace(/(\d)"(?=[ ,;.)]|$)/g, "$1″")
    .replace(/ sigma\b/g, "σ");
}
/** A test that did not pass: what it tested and how far it fell short, from its own numbers; null if unknown. */
function shortfall(x) {
  const n = x.numbers || {}, f = (v, d = 1) => num(+(+v).toFixed(d));
  const crit = n.criterion_sigma;
  if (crit != null && (n.d_pa_sigma != null || n.d_speed_sigma != null)) {
    const off = [];
    if (Math.abs(n.d_speed_sigma) > crit) off.push(t("gr.vf.offSpeed", { s: f(Math.abs(n.d_speed_sigma)), c: crit }));
    if (Math.abs(n.d_pa_sigma) > crit) off.push(t("gr.vf.offDir", { s: f(Math.abs(n.d_pa_sigma)), c: crit }));
    return off.length ? { what: t("gr.vf.wSpeed"), short: off.join("; ") } : null;
  }
  if (n.best_bin_percent != null && n.target_percent != null) return { what: t("gr.vf.wInject"), short: t("gr.vf.sInject", { a: f(n.best_bin_percent), b: f(n.target_percent, 0) }) };
  if (n.fake_movers != null && n.criterion_fake_movers != null) return { what: t("gr.vf.wShuffle"), short: t("gr.vf.sShuffle", { a: f(n.fake_movers, 0), n: f(n.field_shuffles ?? 0, 0), b: f(n.criterion_fake_movers, 0) }) };
  if (n.brightness_found != null && n.brightness_targets != null) return { what: t("gr.vf.wBright"), short: t("gr.vf.sBright", { a: f(n.brightness_found, 0), b: f(n.brightness_targets, 0) }) };
  return null;
}

// ------------------------------------------------------------------------------------------------ one test
function item(x) {
  const k = stKey(x.status);
  const n = x.numbers && typeof x.numbers === "object" ? x.numbers : {};
  const v0 = x.v0 && typeof x.v0 === "object" ? x.v0 : null;
  const title = tx(x.title), res = plain(tx(x.result));
  const sf = k === "fail" ? shortfall(x) : null;

  // what a failed test means for someone using the tool (per test if written, else the general sentence)
  let mean = "";
  if (k === "fail") {
    const s = opt("vf.mean." + x.id) ?? t("vf.mean.fail");
    mean = `<p class="vf-mean"><b>${esc(t("vf.meanLead"))}</b> ${esc(s)}</p>`;
  }

  // key numbers: bars for counts, then the rest
  const { out: bars, used } = pairs(n);
  const v0of = (key) => (v0 && v0[key] != null && typeof v0[key] !== "object" ? v0[key] : null);
  const barsHtml = bars.length ? `<div class="vf-bars">${bars.map((p) => {
    const w = Math.max(0, Math.min(100, (100 * p.a) / p.b));
    const old = v0of(p.ka) != null && v0of(p.kb) != null ? ` <small>(${esc(t("vf.v0"))} ${esc(num(v0of(p.ka)))} / ${esc(num(v0of(p.kb)))})</small>` : "";
    return `<div class="vf-bar"><span>${esc(opt("vf.p." + p.stem) ?? p.stem.replace(/_/g, " "))}</span><b>${esc(num(p.a))} / ${esc(num(p.b))}${old}</b><div class="tr"><i style="width:${w.toFixed(1)}%"></i></div></div>`;
  }).join("")}</div>` : "";
  const rows = [];
  for (const [key, v] of Object.entries(n)) {
    if (used.has(key)) continue;
    const s = val(key, v);
    if (s == null) continue;
    const o = v0of(key);
    const old = o != null && typeof o !== "string" ? ` <small>(${esc(t("vf.v0"))} ${esc(num(o))})</small>` : "";
    rows.push(`<div><dt>${esc(label(key))}</dt><dd>${s}${old}</dd></div>`);
  }
  const v0note = v0 && v0.note && lang() === "en" ? `<p class="fine">${esc(t("vf.v0"))}: ${esc(v0.note)}</p>` : "";
  const ev = typeof x.evidence === "string" && x.evidence ? x.evidence : "";
  const evName = ev.split("/").pop();
  const more = rows.length || bars.length || ev
    ? `<div class="vf-more" id="vfm-${esc(x.id)}" data-ev="${esc(ev)}"${isDetailed() ? "" : " hidden"}>
        ${barsHtml}${rows.length ? `<dl class="vf-nums">${rows.join("")}</dl>` : ""}${v0note}
        ${ev ? `<p class="fine" style="margin:10px 0 0"><button type="button" class="vf-mt vf-csvbtn" data-ev="${esc(ev)}" aria-expanded="false">${esc(t("vf.showFile", { f: evName }))}</button></p><div class="vf-csvwrap" hidden></div>` : ""}</div>` : "";

  return `<li class="vf-item ${k}" id="vf-${esc(x.id)}">
    <div class="vf-head"><span class="vf-id">${esc(x.id)}</span><span class="vf-title">${esc(title)}</span>${badge(x.status)}</div>
    ${sf ? `<p class="vf-short">${esc(t("gr.vf.tested"))} ${esc(sf.what)} · <b>${esc(t("gr.vf.short"))}</b> ${esc(sf.short)}</p>` : ""}
    ${res ? `<p class="vf-res">${esc(res)}</p>` : ""}
    ${mean}
    ${ev || more ? `<p class="vf-foot">${ev ? `<a href="${esc(ev)}" download="${esc(evName)}">${esc(t("vf.evidence"))}: ${esc(evName)} ↓</a>` : ""}${more ? `<button type="button" class="vf-mt" aria-controls="vfm-${esc(x.id)}" aria-expanded="${isDetailed()}">${esc(t("vf.more"))}</button>` : ""}</p>` : ""}
    ${more}
  </li>`;
}

// ------------------------------------------------------------------------------------------------ evidence preview
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { cells.push(cur); cur = ""; } else cur += c;
    }
    cells.push(cur); rows.push(cells);
  }
  return rows;
}
const SMALL = 13;   // a file with up to this many data rows is shown whole, a longer one by its first 5 rows
async function preview(btn) {
  const ev = btn.dataset.ev, wrap = btn.parentElement.nextElementSibling;
  if (!ev || !wrap) return;
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  wrap.hidden = !open;
  if (!open || wrap.dataset.done) return;
  wrap.dataset.done = "1";
  if (!csvCache.has(ev)) csvCache.set(ev, fetch(ev, { cache: "no-cache" }).then((r) => (r.ok ? r.text() : null)).catch(() => null));
  const text = await csvCache.get(ev);
  if (!text) { wrap.innerHTML = `<p class="fine">${esc(t("vf.noFile"))}</p>`; return; }
  const rows = parseCsv(text);
  if (rows.length < 2) return;
  const total = rows.length - 1, n = total <= SMALL ? total : 5;
  const head = rows[0], body = rows.slice(1, 1 + n);
  wrap.innerHTML = `<p class="fine" style="margin:8px 0 0">${esc(n === total ? t("vf.previewAll", { total: num(total) }) : t("vf.preview", { n: num(n), total: num(total) }))}</p>
    <div class="vf-csv"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${body.map((r) => `<tr>${head.map((_, i) => `<td>${esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/** Open / close one test's numbers panel (button aria-expanded + panel hidden). */
function show(btn, open) {
  const d = document.getElementById(btn.getAttribute("aria-controls"));
  if (!d) return;
  btn.setAttribute("aria-expanded", String(open));
  d.hidden = !open;
}

// ------------------------------------------------------------------------------------------------ page
function fmtTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return "";
  try {
    return new Intl.DateTimeFormat(lang() === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(d) + " UTC";
  } catch (e) { return iso; }
}
function render() {
  const box = document.getElementById(BOX_ID);
  if (!box) return;
  if (!DATA || !Array.isArray(DATA.tests) || !DATA.tests.length) {
    box.innerHTML = `<p class="fine">${esc(t("vf.missing"))}</p>`;
    return;
  }
  const tests = DATA.tests;
  const c = { pass: 0, fail: 0, limit: 0, other: 0 };
  for (const x of tests) c[stKey(x.status)]++;
  const parts = [`<span class="res pass">${MARK.pass} ${esc(t("vf.cnt.pass", { n: num(c.pass) }))}</span>`,
    `<span class="res fail">${MARK.fail} ${esc(t("vf.cnt.fail", { n: num(c.fail) }))}</span>`,
    `<span class="res limit">${MARK.limit} ${esc(t("vf.cnt.limit", { n: num(c.limit) }))}</span>`];
  if (c.other) parts.push(`<span class="res other">${esc(t("vf.cnt.other", { n: num(c.other) }))}</span>`);

  const meta = [];
  const cv = typeof DATA.code_version === "string" ? DATA.code_version : "";
  if (cv) meta.push(`${esc(t("vf.code"))} <code title="${esc(cv)}">${esc(cv.split(/\s+\+\s+|\s/)[0])}</code>`);
  const fr = typeof DATA.thresholds_frozen === "string" ? DATA.thresholds_frozen.replace(/\s*\([^)]*\)\s*$/, "") : "";
  if (fr) meta.push(`${esc(t("vf.frozen"))} <b title="${esc(DATA.thresholds_frozen)}">${esc(fr)}</b>`);
  const gen = fmtTime(DATA.generated);
  if (gen) meta.push(`${esc(t("vf.generated"))} ${esc(gen)}`);

  box.innerHTML = `
    <p class="vf-sum">${esc(t("vf.of", { n: num(tests.length) }))} ${parts.join("")}</p>
    ${meta.length ? `<p class="fine vf-meta">${meta.join(" · ")}</p>` : ""}
    <p class="fine vf-legend">${esc(t("vf.legend"))}</p>
    <ol class="vf-list">${tests.map(item).join("")}</ol>
    <p class="fine" style="margin-top:12px">${esc(t("vf.src"))} <a href="${SRC}" download="tests.json">tests.json ↓</a></p>`;
  for (const b of box.querySelectorAll("button.vf-mt:not(.vf-csvbtn)")) b.addEventListener("click", () => show(b, b.getAttribute("aria-expanded") !== "true"));
  for (const b of box.querySelectorAll("button.vf-csvbtn")) b.addEventListener("click", () => preview(b));
}

async function main() {
  style();
  try {
    const r = await fetch(SRC, { cache: "no-cache" });
    DATA = r.ok ? await r.json() : null;
  } catch (e) { DATA = null; }
  render();
  onLang(() => render());
  document.addEventListener("fazari:ui-mode", () => {
    for (const b of document.querySelectorAll(`#${BOX_ID} button.vf-mt:not(.vf-csvbtn)`)) show(b, isDetailed());
  });
  try { apply(document.getElementById("tests")); } catch (e) { /* static English stays */ }
}
main();
