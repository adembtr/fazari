// "How to read this": three small cards in the result viewer (ornek.html, also inside the explorer's result panel).
//   1. the blink (two real SPHEREx seasons of Barnard's Star, flipping)
//   2. the ring and the dot (the same real frame with the Gaia ring and our measured position, from meta.json)
//   3. the answer card (our number, Gaia's number, how far apart: read from meta.json)
// Every picture and number comes from data/barnard/ (pipeline output); nothing is drawn or invented.
// Shown once, right under the blink, never as a modal; "Got it" hides it for good
// (localStorage "fz-fi-howto", every access in try/catch). A small "How to read this" link brings it back.
// ?howto=1 always shows the cards, ?howto=0 never. Hook in ornek.html: <script type="module" src="js/howto_read.js">.

import { t, lang, onLang, loc, month } from "./i18n.js";

const KEY = "fz-fi-howto";
const DATA = "data/barnard/";
const BIN_UM = 4.6;                 // compact, unsaturated core: the jump is easy to see
const CROP = 150;                   // PNG pixels (0.75″ each) around the star
const RING = 34;                    // same ring radius as the viewer (js/viewer.js)

const q = new URLSearchParams(location.search).get("howto");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const T = (k, p) => t("fi." + k, p);
const arc = (v, d = 2) => loc((+v).toFixed(d)) + "″";
const mon = (ep) => month(ep, lang() === "tr");     // Turkish short months read as English ("May"): long there

function seen() { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
function remember() { try { localStorage.setItem(KEY, "1"); } catch (e) { /* storage blocked: shown again next time */ } }

let box = null, link = null, meta = null, timer = null;

function loadCss() {
  if (document.querySelector("link[data-fi-howto]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "css/howto_read.css"; l.dataset.fiHowto = "";
  document.head.appendChild(l);
}

/** Everything the cards show, from Barnard's meta.json. */
function numbers(m) {
  const ms = m.measured || {};
  const bin = (m.wavelength_bins || []).find((b) => Math.abs(b.wavelength_um - BIN_UM) < 0.05);
  const fr = (ep) => bin && bin.frames.find((f) => f.epoch === ep);
  const pos = (ep) => (ms.positions || []).find((p) => p.epoch === ep);
  const ring = (ep) => ((m.markers || []).find((k) => k.epoch === ep) || {}).png_xy;
  const A = pos(ms.from_epoch), B = pos(ms.to_epoch);
  if (!bin || !fr(ms.from_epoch) || !fr(ms.to_epoch) || !A || !B || !ring(ms.to_epoch)) return null;
  return { um: bin.wavelength_um, from: ms.from_epoch, to: ms.to_epoch, fA: fr(ms.from_epoch).file, fB: fr(ms.to_epoch).file,
    a: A.png_xy_measured, b: B.png_xy_measured, ring: ring(ms.to_epoch), png: (m.grid && m.grid.png_px) || [720, 770],
    shift: ms.shift_arcsec, err: ms.shift_err_arcsec, gaia: ms.gaia_predicted_arcsec };
}

function frameSvg(n, inner, cls = "") {
  const [W, H] = n.png;
  const cx = (n.a[0] + n.b[0]) / 2, cy = (n.a[1] + n.b[1]) / 2;
  const x0 = (cx - CROP / 2).toFixed(1), y0 = (cy - CROP / 2).toFixed(1);
  return `<svg class="${cls}" viewBox="${x0} ${y0} ${CROP} ${CROP}" aria-hidden="true">` +
    `<image href="${DATA + n.fA}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>` + inner + `</svg>`;
}

function cards(n) {
  const [W, H] = n.png;
  const x0 = (n.a[0] + n.b[0]) / 2 - CROP / 2, y0 = (n.a[1] + n.b[1]) / 2 - CROP / 2;
  const lab = (txt, c, cls) => `<text class="${cls}" x="${(x0 + 5).toFixed(1)}" y="${(y0 + CROP - 7).toFixed(1)}" fill="${c}">${esc(txt)}</text>`;
  // 1: the blink (frame B over frame A, toggled by the .b class)
  const blink = frameSvg(n, `<image class="fb" href="${DATA + n.fB}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>` +
    lab(mon(n.from), "#8cc4ff", "la") + lab(mon(n.to), "#ff8f8a", "lb"), "fi-blink");
  // 2: ring (Gaia, this season) and dot (measured, this season) on the later frame
  const [rx, ry] = n.ring, [mx, my] = n.b;
  const cross = `M${rx - 6} ${ry}H${rx + 6}M${rx} ${ry - 6}V${ry + 6}`;
  const ring = `<image href="${DATA + n.fB}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>` +
    `<circle cx="${rx}" cy="${ry}" r="${RING}" fill="none" stroke="#05070d" stroke-opacity=".7" stroke-width="5"/>` +
    `<circle cx="${rx}" cy="${ry}" r="${RING}" fill="none" stroke="#ffb347" stroke-width="2.6"/>` +
    `<path d="${cross}" stroke="#05070d" stroke-width="4"/><path d="${cross}" stroke="#ffb347" stroke-width="2"/>` +
    `<circle cx="${mx}" cy="${my}" r="4" fill="#5dd39e" stroke="#05070d" stroke-width="1.6"/>` + lab(mon(n.to), "#ff8f8a", "lc");
  const ringSvg = frameSvg(n, ring, "fi-ring");
  // 3: the answer card in small, with the real numbers
  const d = Math.abs(n.shift - n.gaia);
  const mini = `<div class="fi-mini" aria-hidden="true">
      <div class="m"><small>${esc(T("c3.we"))}</small><b>${esc(arc(n.shift))}</b><i>± ${esc(arc(n.err))}</i></div>
      <div class="g"><small>${esc(T("c3.gaia"))}</small><b>${esc(arc(n.gaia))}</b></div>
      <div class="s"><small>${esc(T("c3.sure"))}</small><span>${esc(T("c3.apart", { d: arc(d), e: arc(n.err) }))}</span></div>
    </div>`;
  const src = esc(T("src", { um: loc(n.um.toFixed(1)) }));
  const card = (i, pic, src2) => `<li class="fi-card"><div class="fi-pic">${pic}</div><div class="fi-txt">` +
    `<h3><span class="fi-n">${i}</span>${esc(T(`c${i}.h`))}</h3><p>${esc(T(`c${i}.p`))}</p><small>${src2}</small></div></li>`;
  return card(1, blink, src) + card(2, ringSvg, src) + card(3, mini, esc(T("c3.src")));
}

function stopAnim() { clearInterval(timer); timer = null; }
function startAnim() {
  stopAnim();
  const s = box && box.querySelector(".fi-blink");
  if (!s || reduceMotion || box.hidden) return;
  timer = setInterval(() => { if (document.hidden) return; s.classList.toggle("b"); }, 900);
}

function render() {
  if (!box || !meta) return;
  const n = numbers(meta);
  if (!n) { box.hidden = true; return; }
  box.setAttribute("aria-label", T("title"));
  box.innerHTML = `<div class="fi-head"><h2>${esc(T("title"))}</h2>` +
    `<button type="button" class="fi-close">${esc(T("gotIt"))}</button></div>` +
    `<ol class="fi-cards">${cards(n)}</ol>`;
  box.querySelector(".fi-close").addEventListener("click", () => { remember(); setOpen(false); link && link.focus({ preventScroll: true }); });
  const s = box.querySelector(".fi-blink");
  s.addEventListener("click", () => { stopAnim(); s.classList.toggle("b"); });
  startAnim();
}

function paintLink() { if (link) link.textContent = T("open"); }

function setOpen(on) {
  if (!box) return;
  box.hidden = !on;
  if (link) { link.hidden = on; link.setAttribute("aria-expanded", String(on)); }
  if (on) { render(); } else stopAnim();
}

async function init() {
  const viewer = document.querySelector(".viewer");
  if (!viewer || q === "0") return;
  // single-column layout (js/ts_flow.js): no separate card; each section says in one sentence what it shows
  if (document.documentElement.classList.contains("ts-on")) return;
  loadCss();
  try { meta = await fetch(DATA + "meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)); } catch (e) { meta = null; }
  if (!meta || !numbers(meta)) return;                        // no example data: nothing to explain with
  box = document.createElement("section");
  box.className = "fi-howto";
  box.id = "fiHowto";
  box.hidden = true;
  link = document.createElement("button");
  link.type = "button";
  link.className = "fi-howto-open";
  link.hidden = true;
  link.addEventListener("click", () => { setOpen(true); box.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" }); });
  const row = document.createElement("div");
  row.className = "fi-howto-row";
  row.append(link);
  // right under the blink and its controls: the answer and the blink stay first on screen
  viewer.after(row, box);
  paintLink();
  setOpen(q === "1" || !seen());
  onLang(() => { paintLink(); if (!box.hidden) render(); });
  window.__fzHowto = { open: () => setOpen(true), close: () => setOpen(false), seen };
}

// after the answer card is in place (ui_shell.js runs before this module), and never before the page has a body
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init());
else init();
