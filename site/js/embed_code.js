// "Embed": the <iframe> code of embed.html for the result or the place on screen, copied to the clipboard.
//   Result pages (ornek.html, sky.html): the "Embed" button of the save row (js/ts_flow.js) -> copyFromPage(btn)
//   explore.html: the "Embed" item of the place card's "Download / Share" menu -> copyEmbed(placeOptions(p), say)
// A ready result (data/<name>/, the five targets) is embedded as ?target=<name>; anything else as ?ra=..&dec=.. (the
// card shows where it is and links to the full page that measures it). The address comes from this page's own
// location, so the code points at the site it was copied from. Texts: i18n "cp.embed*" (English fallback here).
import { TARGETS } from "./targets.js";

const T = (k, en, p) => { const i = globalThis.__fzI18n; try { return i ? i.t(k, p, en) : en.replace(/\{(\w+)\}/g, (m, x) => (p && p[x] != null ? p[x] : m)); } catch (_) { return en; } };
const lang = () => { try { return globalThis.__fzI18n ? globalThis.__fzI18n.lang() : document.documentElement.lang || "en"; } catch (_) { return "en"; } };
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const attr = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tname = (n) => { try { return globalThis.__fzI18n && globalThis.__fzI18n.tname ? globalThis.__fzI18n.tname(n) : n; } catch (_) { return n; } };
const degTxt = (ra, dec) => `${(+ra).toFixed(4)}°, ${dec < 0 ? "−" : "+"}${Math.abs(dec).toFixed(4)}°`;

/** o = { target } or { ra, dec }, plus { bin, lang, name } -> the embed.html address (absolute, from `base`). */
export function embedUrl(o, base = location.href) {
  const u = new URL("embed.html", base);
  u.search = "";
  if (o.target) u.searchParams.set("target", o.target);
  else { u.searchParams.set("ra", (+o.ra).toFixed(5)); u.searchParams.set("dec", (+o.dec).toFixed(5)); }
  if (ok(o.bin)) u.searchParams.set("bin", (+o.bin).toFixed(1));
  if (o.lang === "tr") u.searchParams.set("lang", "tr");
  u.hash = "";
  return u.href;
}
/** The code to paste: 480 x 400, no border, loaded when scrolled into view. */
export function embedSnippet(o, base = location.href) {
  const what = o.name || (o.target ? tname((TARGETS[o.target] || {}).name || o.target) : T("cp.embed.point", "a sky point ({pos})", { pos: degTxt(o.ra, o.dec) }));
  const title = T("cp.embed.title", "Fazari: SPHEREx blink of {name}", { name: what });
  return `<iframe src="${attr(embedUrl(o, base))}" width="480" height="400" style="border:0" loading="lazy" title="${attr(title)}"></iframe>`;
}

/** What is on this result page: the ready target of ornek.html / sky.html, else the point; the wavelength on screen. */
export function pageOptions() {
  const q = new URLSearchParams(location.search), o = { lang: lang() };
  let v = null, s = null;
  try { v = window.__fzViewer || null; } catch (_) { v = null; }
  try { s = window.__fzSky ? window.__fzSky() : null; } catch (_) { s = null; }
  const m = /(?:^|\/)data\/([\w-]+)\/?$/.exec(String((v && v.base) || q.get("data") || ""));
  if (m && TARGETS[m[1]]) o.target = m[1];
  else if (!v && TARGETS[q.get("target")]) o.target = q.get("target");
  try { if (v && v.current) o.bin = +v.current().bin_um; } catch (_) { /* no bin */ }
  if (s && s.current && ok(s.current.um)) o.bin = +s.current.um;
  if (!o.target) {
    let p = null;
    try { p = window.__tsFlow && window.__tsFlow.point ? window.__tsFlow.point() : null; } catch (_) { p = null; }
    if (p && ok(p.ra) && ok(p.dec)) { o.ra = +p.ra; o.dec = +p.dec; if (!p.free && p.name) o.name = p.name; }
    else if (s && s.run && s.run.info && ok(s.run.info.ra0)) { o.ra = +s.run.info.ra0; o.dec = +s.run.info.dec0; }
    else if (v && v.meta && ok(v.meta.ra)) { o.ra = +v.meta.ra; o.dec = +v.meta.dec; }
    else if (ok(q.get("ra")) && ok(q.get("dec"))) { o.ra = +q.get("ra"); o.dec = +q.get("dec"); }
    else return null;
  }
  return o;
}
/** A place of the explorer: a challenge target with a prepared result, else its position. */
export function placeOptions(p, name = "") {
  if (!p || !p.pos) return null;
  const g = /(?:^|\/)data\/([\w-]+)\/?$/.exec(String(p.gallery || ""));
  if (p.challenge && g && TARGETS[g[1]]) return { target: g[1], lang: lang() };
  return { ra: p.pos.ra, dec: p.pos.dec, name: p.manual ? "" : name, lang: lang() };   // "Your spot": its position instead
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) {
    try {
      const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select(); const r = document.execCommand("copy"); t.remove(); return r;
    } catch (e) { return false; }
  }
}
/** A small note at the bottom of the page (the result pages have no toast of their own). With `code`: the snippet in
 *  a selected box, for copying by hand when the clipboard is blocked. */
function toast(msg, code = "") {
  let el = document.getElementById("fzEmbedToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "fzEmbedToast"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
    el.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;max-width:min(92vw,560px);" +
      "background:#0e1220;color:#eef1f8;border:1px solid rgba(127,212,255,.45);border-radius:12px;padding:9px 14px;" +
      "font:14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  if (code) {
    const box = document.createElement("input");
    box.readOnly = true; box.value = code; box.setAttribute("aria-label", msg);
    box.style.cssText = "display:block;width:100%;margin-top:6px;font:12px/1.3 ui-monospace,monospace;background:#05070d;color:#eef1f8;border:1px solid #333b50;border-radius:6px;padding:5px 7px";
    el.appendChild(box);
    box.focus(); box.select();
  }
  el.hidden = false;
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.hidden = true; }, code ? 12000 : 2600);
}

/** Copy the code for o. say(msg, isError) tells the result (default: a toast of this module). Resolves to { ok, code }. */
export async function copyEmbed(o, say = null) {
  if (!o) { (say || toast)(T("cp.notYet", "Not ready yet"), true); return { ok: false, code: "" }; }
  const code = embedSnippet(o);
  if (await copyText(code)) { (say || toast)(T("cp.embed.ok", "Embed code copied: paste it into your page"), false); return { ok: true, code }; }
  toast(T("cp.embed.fail", "Could not copy; select the code below and copy it"), code);
  return { ok: false, code };
}
/** The save row's "Embed" button of a result page. */
export function copyFromPage() { return copyEmbed(pageOptions()); }
