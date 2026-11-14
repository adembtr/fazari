// Guided tour: a short walk through one prepared result (Barnard's Star) and then the sky map.
// One thing is lit at a time; a small box with an arrow says one or two short sentences about it.
//
//   window.FazariTour = { start(), stop(), active() }
//   Every [data-tour-start] element on the page starts it (their `hidden` is removed when this module loads).
//   ?tour=1 starts it when the page has loaded.
//
// Where it runs: on explore.html the result opens in the explorer's own result panel (an iframe of ornek.html, same
// origin); on ornek.html it runs on the page itself (another result first goes to the Barnard one). The tour finds
// its targets through data-tour="..." attributes and a few ids of the picture area; a target that is missing or
// hidden makes that step drop out, never an error. The viewer is driven through its api (window.__fzViewer:
// play, pause, goTo, setBin), not by simulated clicks. The opening demo (explore/demo.js) is stopped first: the
// two never run together. Text: site/i18n (keys "tour.*").

import { t, loc, month, tname, withLang } from "./i18n.js";

const DATA = "data/barnard/";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calm = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
const onExplorer = () => !!($("blinkFrame") && $("search"));
const onResult = () => !!($("stage") && $("frame") && $("seasons"));

let cssDone = false;
function ensureCss() {
  if (cssDone || document.querySelector("link[data-fz-tour]")) return;
  cssDone = true;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = new URL("../css/tour.css", import.meta.url).href; l.dataset.fzTour = "1";
  document.head.appendChild(l);
}

// ---- the result viewer the tour talks about: the page itself, or the explorer's result panel ---------------------
function viewerCtx() {
  if (onExplorer()) {
    const fr = $("blinkFrame");
    try { if (fr.contentWindow && fr.contentDocument) return { win: fr.contentWindow, doc: fr.contentDocument, frame: fr }; } catch (_) { /* not loaded */ }
    return { win: null, doc: null, frame: fr };
  }
  return { win: window, doc: document, frame: null };
}
const viewer = () => { const c = viewerCtx(); try { return (c.win && c.win.__fzViewer) || null; } catch (_) { return null; } };
const isBarnard = (v) => !!(v && /(^|\/)data\/barnard\/$/.test(String(v.base || "")));
const panelOpen = () => { const p = $("blink"); return !!(p && !p.hidden); };
async function showPanel(on) {
  const X = window.__explore;
  if (!onExplorer() || !X) return;
  if (on) {
    const fr = $("blinkFrame"), src = "ornek.html?data=" + DATA;
    if (!panelOpen() || !String(fr.getAttribute("src") || "").startsWith(src)) X.openBlink(src, () => t("ex.blink.prepared", { name: tname("Barnard's Star") }, "Prepared blink: {name}"));
    for (let i = 0; i < 80 && !isBarnard(viewer()); i++) await sleep(150);      // the panel's page loads
    await sleep(calm() ? 50 : 320);
  } else if (panelOpen()) { X.closeBlink(); await sleep(calm() ? 60 : 320); }
}

// ---- the steps ----------------------------------------------------------------------------------------------
const first = (doc, sels) => { for (const s of sels) { const e = doc && doc.querySelector(s); if (e) return e; } return null; };
const shown = (el) => !!(el && !el.closest("[hidden]") && el.getClientRects().length && el.getBoundingClientRect().width > 4);
/** Numbers for step 4, straight from the result's meta.json (the joint fit the page's own tiles use). */
function motionText(v) {
  const ms = (v && v.meta && v.meta.measured) || {}, f = ms.fit || {};
  const num = (x) => x != null && x !== "" && Number.isFinite(+x);
  if (!num(f.pmra_mas_yr) || !num(f.pmdec_mas_yr)) return null;
  const sp = Math.hypot(+f.pmra_mas_yr, +f.pmdec_mas_yr) / 1000;
  const e = num(f.pmra_err_mas_yr) && num(f.pmdec_err_mas_yr) && sp > 0 ? Math.hypot(+f.pmra_mas_yr * +f.pmra_err_mas_yr, +f.pmdec_mas_yr * +f.pmdec_err_mas_yr) / (sp * 1000) / 1000 : null;
  const p = num(f.gaia_pmra_mas_yr) && num(f.gaia_pmdec_mas_yr) && (+f.gaia_pmra_mas_yr || +f.gaia_pmdec_mas_yr) ? Math.hypot(+f.gaia_pmra_mas_yr, +f.gaia_pmdec_mas_yr) / 1000 : null;
  const a = (x) => `<b>${esc(loc(x.toFixed(2)))}″</b>`;
  if (p == null || e == null) return t("tour.s4.b0", { v: a(sp) }, "The white arrow is the motion we measured: {v} per year, drawn at its true length. The orange ring is where the catalogue puts the star.");
  const agree = Math.abs(sp - p) <= Math.max(3 * e, 0.02 * p);
  return t(agree ? "tour.s4.b" : "tour.s4.bDiff", { v: a(sp), e: a(e), p: a(p) },
    agree ? "The white arrow is the motion we measured: {v} per year, give or take {e}. The orange ring is where ESA's Gaia catalogue says the star is: it gives {p} per year. The two agree."
      : "The white arrow is the motion we measured: {v} per year, give or take {e}. The orange ring is where ESA's Gaia catalogue says the star is: it gives {p} per year.");
}
/** All steps in order. where: "viewer" (inside the result) or "top" (this page). enter(v): what the tour does on arriving. */
function plan() {
  const S = [
    { id: "s1", where: "viewer", sel: ["#stage", '[data-tour="stage"]'],
      enter(v) { v.setView("film"); v.closeUp(); v.pause(); v.goTo({ season: v.seasons()[0] }); },
      body(v) { const ep = v.seasons()[0], name = tname((v.meta && v.meta.target) || "Barnard's Star");
        return t("tour.s1.b", { name: `<b>${esc(name)}</b>`, date: `<b>${esc(month(ep, true))}</b>` }, "This is {name} as NASA's SPHEREx telescope saw it in {date}. Nothing here is simulated."); } },
    { id: "s2", where: "viewer", sel: ["#play", "#stage"], go: "tour.s2.go", goEn: "Play",
      enter(v) { v.pause(); }, leave(v, fwd) { if (fwd) v.play(); } },
    { id: "s3", where: "viewer", sel: ["#stage", '[data-tour="stage"]'], enter(v) { v.setView("film"); v.play(); } },
    { id: "s4", where: "viewer", sel: ["#stage", '[data-tour="stage"]'],
      enter(v) { const s = v.seasons(); v.pause(); v.goTo({ season: s[s.length - 1] }); }, body: (v) => motionText(v) },
    { id: "s5", where: "viewer", sel: ['[data-tour="wavelengths"] .pg-row', '[data-tour="wavelengths"]', "#pgBins"],
      enter(v) { const b = v.bins(), cur = v.current().bin_um, other = b.find((u) => Math.abs(u - 2.0) < 0.05 && Math.abs(u - cur) > 0.05) ?? b.find((u) => Math.abs(u - cur) > 0.05); if (other != null) v.setBin(other); v.play(); } },
    { id: "s6", where: "viewer", sel: ["#vdStrip", '[data-tour="verdict"]', "#explainSentence"], enter(v) { v.pause(); } },
  ];
  if (!onExplorer()) {                                     // a result page on its own: the map steps become one closing step with a link
    S.push({ id: "end", where: "none", go: "tour.end.go", goEn: "Open the sky map", link: "explore.html?hero=0" });
    return S;
  }
  // The sky map's own steps. The point card is opened for Barnard's Star through the explorer's own select()
  // (what a click on the star does), so the big button can be shown; without the place list that step is left out.
  const X = window.__explore;
  const star = () => { try { return (X && X.select && X.state.byId.get("barnard")) || null; } catch (_) { return null; } };
  const picked = () => { try { return X.state.selected || null; } catch (_) { return null; } };
  S.push(
    { id: "s7", where: "top", sel: ['[data-tour="search"]'] },
    { id: "s7b", where: "top", sel: ['[data-tour="fetch-button"]', '[data-tour="point-card"]'], can: () => !!(star() || picked()),
      prep() { const p = star(); if (p && !picked()) X.select(p, { fly: false, fill: false }); } },
    { id: "s8", where: "top", sel: ['[data-tour="layers"]', '[data-tour="map-layers"]'] },
  );
  // steps that cannot be shown on this page are left out before the first one, so "Step 3 of 9" stays true
  return S.filter((st) => st.where !== "top" || (st.sel.some((s) => document.querySelector(s)) && (!st.can || st.can())));
}
const EN = {
  s1: ["A real picture from space", ""], s2: ["Play the film", "SPHEREx came back to the same spot months later. Press Play to see the visits one after the other."],
  s3: ["The star jumps", "The other stars stay where they are. This one changes place from visit to visit: it is moving across the sky."],
  s4: ["Our measurement and the catalogue", ""],
  s5: ["Other colours of light", "SPHEREx takes every picture in many infrared colours. These buttons switch the wavelength; the star moves the same way in each of them."],
  s6: ["The answer in one sentence", "Here the page says plainly what it found, how sure it is, and how small a motion it could still have seen at this spot."],
  s7: ["Now pick your own spot", "Type a name or coordinates here, or click anywhere on the sky map. A card opens for that spot; its big button gets the SPHEREx pictures."],
  s7b: ["The big button", "A card like this opens for the spot you pick. Its big button gets the SPHEREx pictures of that spot and plays them like the film you just saw."],
  s8: ["The rings on the map", "These rings are known catalogue stars; we use them to check that the tool measures correctly. What we look for is something with no ring that still moves between pictures: a candidate to check, nothing more."],
  end: ["Your turn", "Open the sky map, pick any spot and watch what moves there."],
};

// ---- the overlay --------------------------------------------------------------------------------------------
const T = { on: false, steps: [], i: 0, block: null, hole: null, box: null, timer: 0, from: null, target: null, frameDoc: null, busy: false };
function build() {
  ensureCss();
  T.block = document.createElement("div"); T.block.className = "fzt-block"; T.block.setAttribute("aria-hidden", "true");
  T.hole = document.createElement("div"); T.hole.className = "fzt-hole fzt-none"; T.hole.setAttribute("aria-hidden", "true");
  T.box = document.createElement("div"); T.box.className = "fzt-box"; T.box.tabIndex = -1;
  T.box.setAttribute("role", "dialog"); T.box.setAttribute("aria-modal", "true"); T.box.setAttribute("aria-labelledby", "fztTitle"); T.box.setAttribute("aria-describedby", "fztBody");
  T.box.innerHTML = `<span class="fzt-arrow" aria-hidden="true"></span><button type="button" class="fzt-x" data-act="stop"></button>` +
    `<p class="fzt-count" id="fztCount"></p><h2 class="fzt-title" id="fztTitle"></h2><p class="fzt-body" id="fztBody"></p>` +
    `<div class="fzt-row"><button type="button" class="fzt-btn fzt-link" data-act="stop" id="fztSkip"></button><span class="fzt-sp"></span>` +
    `<button type="button" class="fzt-btn" data-act="back" id="fztBack"></button><button type="button" class="fzt-btn fzt-go" data-act="next" id="fztNext"></button></div>` +
    `<span class="fzt-live" aria-live="polite" id="fztLive"></span>`;
  document.body.append(T.block, T.hole, T.box);
  T.box.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (!b) return; e.stopPropagation(); if (b.dataset.act === "stop") stop(); else go(b.dataset.act === "back" ? -1 : 1); });
  T.block.addEventListener("click", (e) => { e.stopPropagation(); T.box.focus({ preventScroll: true }); });
}
function onKey(e) {
  if (!T.on) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stop(); return; }
  const inBox = T.box.contains(document.activeElement) || document.activeElement === document.body || e.target === T.box;
  if (e.key === "Tab") {                                   // focus stays in the box
    const f = [...T.box.querySelectorAll("button:not([disabled]):not([hidden]), a[href]")];
    if (!f.length) return;
    const k = f.indexOf(document.activeElement);
    e.preventDefault(); e.stopPropagation();
    f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  } else if (inBox && (e.key === "ArrowRight" || e.key === "ArrowLeft") && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); e.stopPropagation(); go(e.key === "ArrowRight" ? 1 : -1);
  }
}
/** The lit rectangle of the step's target in this window's coordinates (a target inside the panel's frame: clipped to the frame). */
function rectOf(st) {
  const el = st.el;
  if (!el || !el.isConnected) return null;
  let r = el.getBoundingClientRect(), x = r.left, y = r.top, w = r.width, h = r.height;
  if (st.where === "viewer") {
    const c = viewerCtx();
    if (c.frame) {
      const f = c.frame.getBoundingClientRect();
      const x0 = Math.max(f.left, f.left + x), y0 = Math.max(f.top, f.top + y), x1 = Math.min(f.right, f.left + x + w), y1 = Math.min(f.bottom, f.top + y + h);
      x = x0; y = y0; w = x1 - x0; h = y1 - y0;
    }
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  const x0 = Math.max(4, x - 6), y0 = Math.max(4, y - 6), x1 = Math.min(vw - 4, x + w + 6), y1 = Math.min(vh - 4, y + h + 6);
  return x1 - x0 > 8 && y1 - y0 > 8 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
function place() {
  if (!T.on) return;
  const st = T.steps[T.i], r = st && st.el ? rectOf(st) : null, vw = window.innerWidth, vh = window.innerHeight;
  const bw = T.box.offsetWidth, bh = T.box.offsetHeight, m = 8;
  if (!r) {                                                // nothing to point at: the box in the middle
    T.hole.classList.add("fzt-none");
    Object.assign(T.hole.style, { left: vw / 2 + "px", top: vh / 2 + "px" });
    T.box.dataset.side = "none";
    Object.assign(T.box.style, { left: Math.max(m, (vw - bw) / 2) + "px", top: Math.max(m, (vh - bh) / 2) + "px" });
    return;
  }
  T.hole.classList.remove("fzt-none");
  Object.assign(T.hole.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
  const below = vh - (r.y + r.h), above = r.y;
  let side, top;
  if (below >= bh + 18) { side = "below"; top = r.y + r.h + 12; }
  else if (above >= bh + 18) { side = "above"; top = r.y - bh - 12; }
  else { side = "none"; top = r.y + r.h / 2 < vh / 2 ? vh - bh - m : m; }       // a big target: the box at the far edge of the screen
  const cx = r.x + r.w / 2, left = Math.min(Math.max(m, cx - bw / 2), vw - bw - m);
  T.box.dataset.side = side;
  Object.assign(T.box.style, { left: left + "px", top: Math.min(Math.max(m, top), vh - bh - m) + "px" });
  const ar = T.box.querySelector(".fzt-arrow");
  ar.style.left = Math.min(Math.max(16, cx - left - 7), bw - 30) + "px";
}
/** Scroll the step's target into view. A small one (a button, a row) goes just above where the box will sit, so the
 *  picture over it stays on screen; a tall one (the picture) is centred. */
function intoView(st) {
  const el = st.el;
  if (!el) return;
  try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" }); } catch (_) {}
  try {
    const c = viewerCtx(), off = st.where === "viewer" && c.frame ? c.frame.getBoundingClientRect().top : 0;
    const r = el.getBoundingClientRect(), vh = window.innerHeight, bh = T.box.offsetHeight;
    let d = off + r.bottom - (vh - bh - 30);
    if (r.height >= vh * 0.4) {        // the picture: centred; when the box then fits on neither side (a 320 px phone) but would
      const top = off + r.top, want = Math.max(off + 6, 12);                // fit under it, the picture goes up to the top instead
      const fits = Math.max(top - 6, vh - (top + r.height + 6)) >= bh + 18;
      d = !fits && want + r.height + 6 + 12 + bh + 8 <= vh ? top - want : 0;
    }
    if (Math.abs(d) > 4) el.ownerDocument.defaultView.scrollBy(0, d);
  } catch (_) {}
}
function paint() {
  const st = T.steps[T.i], v = viewer(), n = T.steps.length, e = EN[st.id] || ["", ""];
  $("fztCount").textContent = t("tour.step", { i: T.i + 1, n }, "Step {i} of {n}");
  $("fztTitle").textContent = t(`tour.${st.id}.t`, null, e[0]);
  let body = null;
  try { body = st.body && v ? st.body(v) : null; } catch (_) { body = null; }
  $("fztBody").innerHTML = body || esc(t(`tour.${st.id}.b`, null, e[1]));
  $("fztSkip").textContent = t("tour.skip", null, "Skip tour");
  $("fztBack").textContent = t("tour.back", null, "Back");
  $("fztBack").disabled = T.i === 0;
  $("fztNext").textContent = st.go ? t(st.go, null, st.goEn) : T.i === n - 1 ? t("tour.done", null, "Finish") : t("tour.next", null, "Next");
  T.box.querySelector(".fzt-x").setAttribute("aria-label", t("tour.close", null, "Close the tour"));
  T.box.querySelector(".fzt-x").textContent = "×";
  $("fztLive").textContent = `${$("fztCount").textContent}. ${$("fztTitle").textContent}. ${$("fztBody").textContent}`;
  place();
}
/** Show step k (dir: +1 / -1 = the way to keep going when a target is missing). */
async function show(k, dir = 1) {
  if (T.busy) return;
  T.busy = true;
  try {
    while (T.on) {
      if (k < 0) { k = 0; dir = 1; }
      if (k >= T.steps.length) { T.busy = false; stop(); return; }
      const st = T.steps[k];
      if (st.where === "viewer") await showPanel(true); else if (st.where === "top") await showPanel(false);
      if (!T.on) return;
      if (st.prep && !st.prepped) { st.prepped = true; try { st.prep(); } catch (e) { console.warn("tour step", st.id, e); } await sleep(calm() ? 80 : 350); if (!T.on) return; }
      const v = viewer(), c = viewerCtx();
      const doc = st.where === "viewer" ? (isBarnard(v) ? c.doc : null) : st.where === "top" ? document : null;
      st.el = doc && st.sel ? st.sel.map((s) => doc.querySelector(s)).find(shown) || null : null;      // the first of its targets that is on the page and visible
      if (st.where !== "none" && !shown(st.el)) {          // missing or hidden target: this step drops out
        T.steps.splice(k, 1);
        if (dir < 0) k -= 1;
        if (!T.steps.length) { T.busy = false; stop(); return; }
        continue;
      }
      T.i = k;
      if (st.where === "viewer" && v && st.enter) { try { st.enter(v); } catch (e) { console.warn("tour step", st.id, e); } }
      if (st.where === "viewer" && c.frame && c.doc !== T.frameDoc) {       // keys typed inside the panel's page reach the tour too
        T.frameDoc = c.doc;
        try { c.doc.addEventListener("keydown", (e) => { if (T.on && e.key === "Escape") stop(); }, true); } catch (_) {}
      }
      paint();
      intoView(st);
      for (const ms of [450, 1100]) setTimeout(() => { if (T.on && T.steps[T.i] === st) { intoView(st); place(); } }, ms);      // the result page may still be settling (a wavelength just changed)
      await sleep(30);
      place();
      (document.getElementById("fztNext") || T.box).focus({ preventScroll: true });
      return;
    }
  } catch (e) { console.warn("tour", e); stop(); } finally { T.busy = false; }
}
function go(d) {
  if (!T.on || T.busy) return;
  const st = T.steps[T.i], v = viewer();
  if (st && st.leave && v) { try { st.leave(v, d > 0); } catch (_) {} }
  if (d > 0 && st && st.link) { stop(); location.href = withLang(st.link); return; }
  show(T.i + d, d);
}

export async function start(from) {
  if (T.on) return;
  // a result page inside the explorer's panel: the explorer's own tour runs (one tour, one overlay)
  try { if (window.parent !== window && window.parent.FazariTour && window.parent.document.getElementById("blinkFrame")) { window.parent.FazariTour.start(); return; } } catch (_) {}
  if (!onExplorer() && !onResult()) { location.href = withLang("explore.html?hero=0&tour=1"); return; }
  if (onResult() && !onExplorer()) {
    for (let i = 0; i < 60 && !viewer(); i++) await sleep(150);
    if (!isBarnard(viewer())) { location.href = withLang("ornek.html?data=" + DATA + "&tour=1"); return; }
  }
  // the opening demo and the hero card never run together with the tour
  try { const h = window.__fzHero; if (h) { h.stop && h.stop(); h.close && h.close(); } } catch (_) {}
  T.on = true; T.from = from || document.activeElement; T.steps = plan(); T.i = 0;
  if (!T.box) build();
  for (const el of [T.block, T.hole, T.box]) el.hidden = false;
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  T.timer = setInterval(place, 400);                       // the page under the box may still be settling
  document.documentElement.classList.add("fzt-on");
  await show(0, 1);
}
export function stop() {
  if (!T.on) return;
  T.on = false;
  clearInterval(T.timer);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", place, true);
  for (const el of [T.block, T.hole, T.box]) if (el) el.hidden = true;
  document.documentElement.classList.remove("fzt-on");
  const v = viewer();
  try {                                                    // back to how the page starts: the film playing, or (reduced motion) the still "time as colour"
    if (v && isBarnard(v)) { if (calm()) { v.pause(); v.setView("tcol"); v.closeUp(); } else { v.setView("film"); v.closeUp(); v.play(); } }
  } catch (_) {}
  try { if (T.from && T.from.isConnected && T.from.focus) T.from.focus({ preventScroll: true }); } catch (_) {}
}

// ---- wiring: the buttons other modules put on the page ---------------------------------------------------------
function reveal() { document.querySelectorAll("[data-tour-start][hidden]").forEach((b) => { b.hidden = false; }); }
window.FazariTour = { start, stop, active: () => T.on };
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest && e.target.closest("[data-tour-start]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  start(b);
}, true);
reveal();
try { new MutationObserver(reveal).observe(document.body, { childList: true }); } catch (_) {}       // the hero card is added later
document.addEventListener("fazari:lang", () => { reveal(); if (T.on) paint(); });
[600, 2000, 5000].forEach((ms) => setTimeout(reveal, ms));
try { if (new URLSearchParams(location.search).get("tour") === "1") setTimeout(() => start(), 400); } catch (_) {}
