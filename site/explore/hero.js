// Opening hero of the Sky Explorer: one question and answer, a small looping blink of Barnard's Star
// one year apart, four numbers from our own measurement, and one button into the sky.
//
// Every number is read from data/barnard/meta.json (pipeline output); nothing is hard-coded.
// Shown once per viewer: dismissal is remembered in localStorage (if storage is blocked, it simply
// shows again next time). On a first visit the opening demo (explore/demo.js) runs first and ends on this
// card; with prefers-reduced-motion only the card is shown. Not shown for links that already say where to look (?ra=&dec=, ?p=, ?q=, layer
// and engine options), so shared links open straight on the sky. ?hero=1 always shows it, ?hero=0 never. The panel gets a small link to open it again.
//
// Hook in explore.html: <script type="module" src="explore/hero.js"></script>. Independent of main.js.

import { t, onLang, lang, langButton } from "../js/i18n.js";

const DATA = "data/barnard/";
const KEY = "fz-hero-dismissed";
const BIN_UM = 2.0;                 // D3: the core is saturated but the wings are clean
const CROP = 210;                   // blink crop, PNG pixels (0.75″ each: 4x upscaled 3″ grid)

const params = new URLSearchParams(location.search);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let dlg = null, timer = null, playing = !reduceMotion, metaP = null;

function seen() { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
function remember() { try { localStorage.setItem(KEY, "1"); } catch (e) { /* storage blocked */ } }

function loadCss() {
  return new Promise((res) => {
    if (document.querySelector('link[data-fz-hero]')) return res();
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "explore/hero.css"; l.dataset.fzHero = "";
    l.onload = l.onerror = () => res();
    document.head.appendChild(l);
    setTimeout(res, 1500);
  });
}

function getMeta() {
  metaP ||= fetch(DATA + "meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return metaP;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const arcsec = (v, d = 2) => `${lang() === "tr" ? Number(v).toFixed(d).replace(".", ",") : Number(v).toFixed(d)}″`;
function month(ep) {                         // "2025-08" -> "Aug 2025" / "Ağu 2025"
  const [y, m] = String(ep).split("-").map(Number);
  if (!y || !m) return ep;
  try { return new Intl.DateTimeFormat(lang() === "tr" ? "tr-TR" : "en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(Date.UTC(y, m - 1, 15)); }
  catch (e) { return ep; }
}

/** Speed per year (″/yr) ± error from meta.measured.fit, and the catalogue's; null without a fit (grafikler). */
function speedPerYear(f) {
  const ok = (v) => v != null && Number.isFinite(+v);
  if (!f || !ok(f.pmra_mas_yr) || !ok(f.pmdec_mas_yr) || !ok(f.pmra_err_mas_yr) || !ok(f.pmdec_err_mas_yr)) return null;
  const v = Math.hypot(f.pmra_mas_yr, f.pmdec_mas_yr);
  const e = v > 0 ? Math.hypot(f.pmra_mas_yr * f.pmra_err_mas_yr, f.pmdec_mas_yr * f.pmdec_err_mas_yr) / v : 0;
  const p = ok(f.gaia_pmra_mas_yr) && ok(f.gaia_pmdec_mas_yr) ? Math.hypot(f.gaia_pmra_mas_yr, f.gaia_pmdec_mas_yr) / 1000 : null;
  return { v: v / 1000, e: e / 1000, p };
}

/** Everything the hero shows, from meta.json. */
function numbers(meta) {
  const m = meta.measured || {};
  const bin = (meta.wavelength_bins || []).find((b) => b.wavelength_um === BIN_UM) || (meta.wavelength_bins || [])[0];
  const fr = (ep) => (bin?.frames || []).find((f) => f.epoch === ep);
  const mk = (ep) => (meta.markers || []).find((k) => k.epoch === ep)?.png_xy
    || (m.positions || []).find((p) => p.epoch === ep)?.png_xy_gaia;
  const eps = meta.epochs || [];
  return {
    images: meta.n_cutouts, seasons: eps.length, first: eps[0], last: eps[eps.length - 1],
    from: m.from_epoch, to: m.to_epoch, dt: m.dt_years,
    shift: m.shift_arcsec, err: m.shift_err_arcsec, gaia: m.gaia_predicted_arcsec,
    pm: speedPerYear(m.fit),                       // grafikler: the card shows the speed per year (as the result card)
    um: bin?.wavelength_um, frameA: fr(m.from_epoch), frameB: fr(m.to_epoch), xyA: mk(m.from_epoch), xyB: mk(m.to_epoch),
    png: meta.grid?.png_px || [720, 770],
  };
}

/** Width of the blink crop in arcmin (PNG pixels are grid pixels / upscale). */
function boxArcmin(meta) {
  const g = meta.grid || {};
  const v = CROP * (g.pixel_arcsec || 3) / (g.upscale || 4) / 60;
  return lang() === "tr" ? v.toFixed(1).replace(".", ",") : v.toFixed(1);
}

function blinkSvg(n) {
  if (!n.frameA || !n.frameB || !n.xyA || !n.xyB) return "";
  const [W, H] = n.png;
  const cx = (n.xyA[0] + n.xyB[0]) / 2, cy = (n.xyA[1] + n.xyB[1]) / 2;
  const x0 = cx - CROP / 2, y0 = cy - CROP / 2;
  const tick = (xy, cls) => {
    const [x, y] = xy, r0 = 29, r1 = 41;
    return `<line class="tk ${cls}" x1="${x - r1}" y1="${y}" x2="${x - r0}" y2="${y}"/><line class="tk ${cls}" x1="${x + r0}" y1="${y}" x2="${x + r1}" y2="${y}"/>`;
  };
  const ax = cx + 50, ya = n.xyA[1], yb = n.xyB[1];
  const shiftTxt = arcsec(n.shift, 1);
  return `<svg viewBox="${x0.toFixed(1)} ${y0.toFixed(1)} ${CROP} ${CROP}" role="img" aria-label="${esc(t("hero.blinkAlt", { shift: shiftTxt }))}" tabindex="0">
    <image href="${DATA + n.frameA.file}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>
    <image class="fb" href="${DATA + n.frameB.file}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>
    ${tick(n.xyA, "a")}${tick(n.xyB, "bb")}
    <path class="arr" d="M${ax} ${ya - 1} V${yb + 3} M${ax - 2.6} ${yb + 4.5} L${ax} ${yb} L${ax + 2.6} ${yb + 4.5}"/>
    <text class="arrlab" x="${ax + 4}" y="${(ya + yb) / 2 + 3}">${esc(shiftTxt)}</text>
    <text class="lab a" x="${x0 + 6}" y="${y0 + CROP - 7}">${esc(month(n.frameA.epoch))}</text>
    <text class="lab bb" x="${x0 + 6}" y="${y0 + CROP - 7}">${esc(month(n.frameB.epoch))}</text>
  </svg>`;
}

function render(meta) {
  const n = numbers(meta);
  const shiftBig = `${Math.round(n.shift)}″`;
  const title = esc(t("hero.title", { shift: "\u0000" })).replace("\u0000", `<span class="n">${esc(shiftBig)}</span>`);
  const svg = blinkSvg(n);
  dlg.innerHTML = `
    <button type="button" class="fz-x" data-close aria-label="${esc(t("hero.close"))}">×</button>
    <div class="fz-in">
      <div>
        <p class="fz-kicker" data-i18n="hero.kicker">${esc(t("hero.kicker"))}</p>
        <h1 id="fzHeroTitle">${title}</h1>
        <p class="fz-hook" data-i18n="hero.hook">${esc(t("hero.hook"))}</p>
        <ul class="fz-cards">
          <li><b>${esc(n.images)}</b><small data-i18n="hero.card.images">${esc(t("hero.card.images"))}</small></li>
          <li><b>${esc(n.seasons)}</b><small>${esc(t("hero.card.seasons", { from: month(n.first), to: month(n.last) }))}</small></li>
          <li class="me"><b>${esc(n.pm ? arcsec(n.pm.v) + "/" + t("gr.yr") : arcsec(n.shift))}</b><span class="err">± ${esc(n.pm ? arcsec(n.pm.e) + "/" + t("gr.yr") : arcsec(n.err))}</span>
            <small>${esc(t("hero.card.measured"))}, ${esc(t("hero.card.measuredSub", { from: month(n.from), to: month(n.to) }))}</small></li>
          <li class="gaia"><b>${esc(n.pm && n.pm.p != null ? arcsec(n.pm.p) + "/" + t("gr.yr") : arcsec(n.gaia))}</b><small data-i18n="hero.card.gaia">${esc(t("hero.card.gaia"))}</small></li>
        </ul>
        <div class="fz-actions">
          <button type="button" class="fz-go" data-close autofocus><span data-i18n="hero.explore">${esc(t("hero.explore"))}</span>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button type="button" class="fz-tour" data-tour-start${window.FazariTour ? "" : " hidden"} data-i18n="tour.start">${esc(t("tour.start", null, "Guided tour"))}</button>
          <span class="fz-links">
            <a href="ornek.html?data=${encodeURIComponent(DATA)}"><span data-i18n="hero.result">${esc(t("hero.result"))}</span> →</a>
            <a href="verify.html"><span data-i18n="hero.evidence">${esc(t("hero.evidence"))}</span> →</a>
            <a href="story.html"><span data-i18n="hero.story">${esc(t("hero.story"))}</span> →</a>
            <a href="planetx.html"><span data-i18n="px.nav">${esc(t("px.nav", null, "Planet X"))}</span> →</a>
            <a href="asteroids.html"><span data-i18n="ts.nav.ast">${esc(t("ts.nav.ast", null, "Asteroids"))}</span> →</a>
            <a href="comets.html"><span data-i18n="hero.comets">${esc(t("hero.comets"))}</span> →</a>
            <a href="vr.html"><span data-i18n="vr.nav">${esc(t("vr.nav"))}</span> →</a>
          </span>
        </div>
      </div>
      ${svg ? `<figure class="fz-blinkbox">${svg}
        <figcaption><span>${esc(t("hero.blinkLabel", { um: n.um, date: `${month(n.from)} ↔ ${month(n.to)}`, box: boxArcmin(meta) }))}</span>
        <button type="button" class="fz-pp" aria-pressed="${!playing}">${esc(playing ? t("hero.pause") : t("hero.play"))}</button></figcaption></figure>` : ""}
    </div>`;
  dlg.querySelector(".fz-x").after(langButton("fz-lang"));
  for (const b of dlg.querySelectorAll("[data-close]")) b.addEventListener("click", () => dlg.close("explore"));
  const s = dlg.querySelector(".fz-blinkbox svg");
  const pp = dlg.querySelector(".fz-pp");
  if (s) {
    const flip = () => s.classList.toggle("b");
    s.addEventListener("click", () => { setPlaying(false); flip(); });
    s.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setPlaying(false); flip(); } });
    pp.addEventListener("click", () => setPlaying(!playing));
  }
  setPlaying(playing);
}

function setPlaying(on) {
  playing = on;
  clearInterval(timer);
  const s = dlg?.querySelector(".fz-blinkbox svg"), pp = dlg?.querySelector(".fz-pp");
  if (pp) { pp.textContent = on ? t("hero.pause") : t("hero.play"); pp.setAttribute("aria-pressed", String(!on)); }
  if (on && s && dlg.open) timer = setInterval(() => { if (!document.hidden) s.classList.toggle("b"); }, 800);   // no blink work in a hidden tab (bellek)
}

async function open() {
  await loadCss();
  const meta = await getMeta();
  if (!meta || !meta.measured || meta.measured.shift_arcsec == null) return;   // no data: just the explorer
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "fz-hero";
    dlg.setAttribute("aria-labelledby", "fzHeroTitle");
    document.body.appendChild(dlg);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close("backdrop"); });
    dlg.addEventListener("close", () => { remember(); clearInterval(timer); setTimeout(() => document.getElementById("sky")?.focus?.({ preventScroll: true }), 0); });
    onLang(() => { dlg.lang = lang(); if (dlg.open) { render(meta); dlg.querySelector(".fz-lang")?.focus(); } paintReopen(); });
  }
  render(meta);
  dlg.lang = lang();
  if (!dlg.open) dlg.showModal();
  setPlaying(playing);
  dlg.querySelector(".fz-go")?.focus({ preventScroll: true });
  dlg.scrollTop = 0;                 // phones: the blink (on top) stays in view, not scrolled away to the button
}

// ---- opening demo (explore/demo.js): something moves at once; any click / key / "Skip demo" ends it all.
let demo = null;
async function start() {
  if (reduceMotion || want === "card") return open();      // no automatic flight for reduced motion
  if (demo || dlg?.open) return;
  loadCss();
  try {
    const { runDemo } = await import("./demo.js");
    demo = runDemo({ final: () => open(), onStop: () => { demo = null; remember(); } });
  } catch (e) {
    console.warn("demo unavailable", e);
    open();
  }
}

let reopenBtn = null;
function paintReopen() { if (reopenBtn) reopenBtn.textContent = t("hero.reopen"); }
function addReopen() {
  const howto = document.querySelector("#panelBody .howto");
  if (!howto || reopenBtn) return;
  reopenBtn = document.createElement("button");
  reopenBtn.type = "button";
  reopenBtn.className = "fz-reopen";
  paintReopen();
  reopenBtn.addEventListener("click", (e) => { e.stopPropagation(); setTimeout(start, 0); });
  howto.append(" · ", reopenBtn);
}

// Links that already say where to look (shared spot, search, layer or engine/test options) skip the hero.
const deepLink = ["ra", "dec", "p", "q", "target", "engine", "flat", "gaia", "fast"].some((k) => params.has(k));
const want = params.get("hero");
addReopen();
loadCss();
if (want === "1" || want === "card" || (want !== "0" && !deepLink && !seen())) start();

// For tests: ?hero=1 demo then card, ?hero=card the card only, ?hero=0 nothing.
window.__fzHero = { open, start, stop: () => demo?.stop(), close: () => dlg?.close(), seen };
