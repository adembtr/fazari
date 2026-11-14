// Fazari result viewer (site/ornek.html): the SPHEREx season frames of one result as Blink, Step,
// Swipe or Trail, with the measured motion drawn on the image, the result card (measured vs the
// catalogue, images, seasons), the difference image with its colour key, and the measurement
// details. Reads <data>/meta.json written by pipeline/blink.py or the local engine (/jobs/<id>/).
//
//   startViewer() -> Promise<api | null>
//     api = { meta, base, current(), setMarking(markingApi), fallbackSentence(), on(fn) }
//     current() -> { frame, bin_um } (the frame on screen; what js/marking.js stores with a mark)
//
// URL (a link reopens the same view; ?data= stays the main parameter):
//   data=<folder>/   result folder: data/<target>/ or /jobs/<id>/  (t=<target id> is a shortcut)
//   um=<µm>          wavelength bin (bin=<µm> from the explorer is also read)
//   mode=blink|step|swipe|trail   s=<season>,<season>   z=<zoom>
//
// Plug-ins (other modules) find: #explainSentence, #explainStrip, #markingPanel, .controls,
// #faintControls, #spectrumPanel, #candidateList, <svg id="candLayer"> (PNG pixel coordinates, inside
// the zoomed box), #frame / #zoomer (the frame image and the zoomed box: the whole PNG, no
// letterboxing). Every frame change fires document event "fazari:frame" ({ epoch, bin_um, file }).

import { t, lang, loc, month, tname, onLang, ptext } from "./i18n.js";
import * as GR from "./gr.js";   // answer card: speed per year, number line, ratio chart, catalogue at a free point, limits (grafikler)
import { speedOf, speedText, scaleText, significant } from "./motion_arrow.js";   // measured-motion arrow: speed label; the arrow is drawn at true length (ilk_izlenim, goruntu_tur)
import { findNeighbours, neighbourLayout, neighbourSvg } from "./neighbours.js";   // static catalogue stars near the track (ilk_izlenim)
import * as FV from "./fz_view.js";               // picture area: processed frames on a canvas, view tabs, zoom and pan (goruntu_tur)
import { gridOf } from "./marking.js";            // PNG pixel <-> sky of a result's grid (rings on the catalogue stars)

const $ = (id) => document.getElementById(id);
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const fx = (v, d = 2) => (ok(v) ? loc((+v).toFixed(d)) : "–");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// i18n: English from the code (unchanged), Turkish from site/i18n/tr.json (keys "vw.*")
const L = (key, en, p) => (lang() === "tr" ? t(key, p, en) : p ? en.replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : en);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];
const season = (ep, long) => {
  if (lang() === "tr") return month(ep, true);          // Turkish short months ("May", "Mar") read as English: always long
  const m = /^(\d{4})-(\d{2})/.exec(ep || "");
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${(long ? MONTHS : MON)[+m[2] - 1]} ${m[1]}` : String(ep || "");
};
const dayNum = (d) => { const t = Date.parse(String(d || "").slice(0, 10) + "T00:00:00Z"); return Number.isFinite(t) ? t / 864e5 : NaN; };
const daysApart = (a, b) => Math.round(Math.abs(dayNum(b.date) - dayNum(a.date)));
const arcsec = (v, err) => loc((+v).toFixed(Math.abs(v) < 1 || (ok(err) && err > 0 ? err < 0.095 : Math.abs(v) < 3) ? 2 : 1) + "″");
const span = (dt) => {
  if (!ok(dt) || dt <= 0) return "";
  const y = Math.round(dt);
  if (y >= 1 && Math.abs(dt - y) < 0.12) return y === 1 ? L("vw.in1y", "in 1 year") : L("vw.inNy", "in {n} years", { n: y });
  const mo = Math.max(1, Math.round(dt * 12));
  return mo === 1 ? L("vw.in1m", "in 1 month") : L("vw.inNm", "in {n} months", { n: mo });
};

// The five challenge targets: a short tag and whether the challenge tests motion or brightness.
export const TARGETS = [
  { id: "barnard", name: "Barnard's Star", kind: "moves", tag: "speed record",
    why: "The fastest-moving star in our sky." },
  { id: "eps_indi_b", name: "Epsilon Indi B", kind: "moves", tag: "cold brown dwarfs",
    why: "A pair of cold brown dwarfs, 12 light years away." },
  { id: "wise0855", name: "WISE 0855-0714", kind: "moves", tag: "Planet X analog",
    why: "The coldest brown dwarf known: dark in visible light, seen only in the infrared, like a Planet X would be." },
  { id: "rw_aur", name: "RW Aurigae", kind: "varies", tag: "young star",
    why: "A young star whose brightness changes irregularly." },
  { id: "r_dra", name: "R Draconis", kind: "varies", tag: "pulsating giant",
    why: "A giant star that brightens and fades every 8 months or so." },
];
const KIND_TEXT = { moves: "moves", varies: "varies" };
const KIND_TIP = { moves: "The challenge tests this target for motion.", varies: "The challenge tests this target for brightness change." };

const S = {                 // viewer state
  meta: null, base: "", bins: [], bi: 0, bin: null, sel: [], idx: 0, mode: "blink", playing: true, timer: 0,
  zoom: 3, k: 1, tx: 0, ty: 0, game: null, trailKey: null, gif: new Map(), marking: null, ex: {}, listeners: [],
  ref: null, info: null, defaultZoom: 3,
  // picture area (goruntu_tur): view tab, the visitor's own zoom / pan (user, cx, cy), processed frames (fv), field stars
  view: "film", user: false, cx: null, cy: null, fv: null, ui: null, tabs: null, stars: null, starKey: "",
};
const Q = new URLSearchParams(location.search);

function baseFromUrl() {
  let b = Q.get("data");
  const t = Q.get("t") || Q.get("target");
  if (!b && t && /^[\w-]+$/.test(t)) b = `data/${t}/`;
  b = b || "data/barnard/";
  return /\/$/.test(b) ? b : b + "/";
}
const targetIdOf = (base) => { const m = /(?:^|\/)data\/([\w-]+)\/$/.exec(base.replace(/^\.?\//, "")); return m ? m[1] : null; };
const pngSize = () => (S.meta && S.meta.grid && S.meta.grid.png_px) || [720, 720];
const labelStrip = () => (S.meta && S.meta.grid && S.meta.grid.label_strip_px) || 0;
const pngArcsec = () => { const g = (S.meta && S.meta.grid) || {}; return g.pixel_arcsec && g.upscale ? g.pixel_arcsec / g.upscale : null; };

function refInfo(m) {
  const label = ((m && m.gaia) || {}).label || "Gaia DR3";
  const none = /requested position/i.test(label);
  const short = label.split(" (")[0];
  return {
    label, none, short, Short: short.charAt(0).toUpperCase() + short.slice(1),
    who: none ? null : /gaia/i.test(label) ? "Gaia" : /spitzer/i.test(label) ? "Spitzer" : "The catalogue",
  };
}

// --- positions in PNG pixels ------------------------------------------------------------------
function markerXY(epoch) {        // catalogue prediction for a season
  const mk = (S.meta.markers || []).find((q) => q.epoch === epoch);
  if (mk) return mk.png_xy;
  const p = ((S.meta.measured || {}).positions || []).find((q) => q.epoch === epoch);
  return p ? p.png_xy_gaia : null;
}
function measuredPos(epoch) { return ((S.meta.measured || {}).positions || []).find((q) => q.epoch === epoch && q.png_xy_measured) || null; }
function centreXY() {
  const ps = (S.meta.markers && S.meta.markers.length) ? S.meta.markers.map((m) => m.png_xy)
    : ((S.meta.measured || {}).positions || []).map((p) => p.png_xy_gaia).filter(Boolean);
  const [W, H] = pngSize();
  if (!ps.length) return [W / 2, (H + labelStrip()) / 2];
  return [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length];
}
const selFrames = () => S.sel.map((i) => S.bin.frames[i]);

// --- zoom: the zoomed box is the whole PNG (W x H CSS px), placed with translate + scale ------------
// One mechanism (goruntu_tur): S.zoom = scale relative to "the whole field fits", S.cx / S.cy = the PNG pixel in the
// middle of the stage (null: the target). The default is a close-up around the target (closeUpZoom); the wheel,
// two fingers, dragging and the buttons on the picture change it (S.user); "close-up" goes back to the default.
const CLOSE_ARCSEC = 180;            // default close-up: about 3 arcmin across the smaller side of the stage
function fitScale(wrap) { const [W, H] = pngSize(); return Math.min(wrap.clientWidth / W, wrap.clientHeight / (H - labelStrip())) || 0; }
/** PNG pixels between the first and last season of the headline pair (measured, else the catalogue's), or null. */
function headShiftPng() {
  const h = headEpochs(S.bin || S.bins[0] || null);
  if (!h) return null;
  const a = (measuredPos(h[0]) || {}).png_xy_measured || markerXY(h[0]), b = (measuredPos(h[1]) || {}).png_xy_measured || markerXY(h[1]);
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null;
}
/** The default view: ~3 arcmin across; closer when a mover's jump would otherwise be under ~40 screen px. */
function closeUpZoom() {
  const st = $("stage"), k1 = fitScale(st), a = pngArcsec();
  if (!(k1 > 0) || !a) return Math.max(1, S.zoom || 3);
  if (S.holdScale > 0) return Math.max(1, a / S.holdScale / k1);               // a run in progress: the scale on screen stays (swapData)
  const m = Math.min(st.clientWidth, st.clientHeight);
  let k = m * a / ((S.meta.measured || {}).photometry ? 300 : CLOSE_ARCSEC);   // brightness targets: the comparison stars stay in view
  const d = headShiftPng();
  if (d != null && d * a >= 2) k = Math.max(k, 40 / d);
  k = Math.min(k, m * a / 40);                                               // never closer than 40″ across by default
  return Math.max(1, k / k1);
}
/** Closest zoom: about 20″ across the smaller side (three SPHEREx detector pixels). */
function zoomMax() { const st = $("stage"), k1 = fitScale(st); return k1 > 0 ? Math.max(1, Math.min(st.clientWidth, st.clientHeight) * (pngArcsec() || 0.75) / 20 / k1) : 60; }
function place(box, wrap, zoom, c) {
  const Sw = wrap.clientWidth, Sh = wrap.clientHeight;
  if (!Sw || !Sh) return null;
  const [W, H] = pngSize(), L = labelStrip();
  const k = Math.min(Sw / W, Sh / (H - L)) * zoom;
  const [cx, cy] = c || centreXY();
  let tx = Sw / 2 - cx * k, ty = Sh / 2 - cy * k;
  const sw = W * k, sh = (H - L) * k;
  tx = sw >= Sw ? Math.min(0, Math.max(Sw - sw, tx)) : (Sw - sw) / 2;
  ty = sh >= Sh ? Math.min(-L * k, Math.max(Sh - sh - L * k, ty)) : (Sh - sh) / 2 - L * k;     // the label strip stays hidden
  box.style.width = W + "px"; box.style.height = H + "px";
  box.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${k.toFixed(5)})`;
  return { k, tx, ty };
}
function layout() {
  if (!S.meta) return;
  const st = $("stage");
  if (!S.user) { S.zoom = closeUpZoom(); S.cx = S.cy = null; }
  S.zoom = Math.max(1, Math.min(zoomMax(), S.zoom));
  const p = place($("zoomer"), st, S.zoom, S.cx != null ? [S.cx, S.cy] : null);
  if (p) {
    Object.assign(S, p);
    if (S.user) { S.cx = (st.clientWidth / 2 - S.tx) / S.k; S.cy = (st.clientHeight / 2 - S.ty) / S.k; }   // as placed (edges clamp)
  }
  const dz = $("diffZoom"), dv = $("diffView");
  if (dz && dv && dv.offsetParent) place(dz, dv, Math.max(1, Math.min(S.zoom, 4) * 0.75));
  if (S.mode === "swipe") applySwipe();
  drawOverlay();
  scaleBar();
  zoomUi();
  if (S.marking && S.marking.redraw) { try { S.marking.redraw(); } catch (_) {} }
}
/** Zoom by factor f keeping the picture point under stage pixel (x, y) where it is. */
function zoomAt(f, x, y, smooth) {
  const st = $("stage"), k1 = fitScale(st);
  if (!(k1 > 0) || !S.k) return;
  const z = Math.max(1, Math.min(zoomMax(), S.zoom * f)), k = k1 * z;
  const px = (x - S.tx) / S.k, py = (y - S.ty) / S.k;
  S.zoom = z; S.user = true;
  S.cx = (st.clientWidth / 2 - (x - px * k)) / k; S.cy = (st.clientHeight / 2 - (y - py * k)) / k;
  if (!smooth) liveZoom();
  layout(); urlSoon();
}
function panBy(dx, dy) {
  const st = $("stage");
  if (!S.k) return;
  S.user = true;
  S.cx = (st.clientWidth / 2 - S.tx - dx) / S.k; S.cy = (st.clientHeight / 2 - S.ty - dy) / S.k;
  liveZoom(); layout(); urlSoon();
}
let liveT = 0, urlT = 0;
function liveZoom() { const st = $("stage"); st.classList.add("fz-live"); clearTimeout(liveT); liveT = setTimeout(() => st.classList.remove("fz-live"), 260); }   // no CSS transition while the hand moves
function urlSoon() { clearTimeout(urlT); urlT = setTimeout(writeUrl, 400); }
function closeUp() { S.user = false; S.holdScale = 0; S.cx = S.cy = null; layout(); writeUrl(); }
/** New numbers arrived (a later stage of a run): the marks fade in at their new places instead of jumping. */
function softUpdate() { const ov = $("ov"); if (!ov) return; ov.classList.remove("fz-upd"); void ov.getBoundingClientRect(); ov.classList.add("fz-upd"); }
function wholeField() { S.user = true; S.zoom = 1; S.cx = S.cy = null; layout(); writeUrl(); }
/** Button states, cursor, touch rule, and the old zoom selector kept in step (a hidden control: candidates.js steps it). */
function zoomUi() {
  const st = $("stage"), zm = zoomMax();
  const closer = S.user && S.zoom > closeUpZoom() * 1.05;             // zoomed in by the visitor: one finger moves the picture
  st.classList.toggle("fz-pan", S.zoom > 1.001 && S.mode !== "swipe" && !(S.game && !S.game.revealed));
  st.style.touchAction = S.mode === "swipe" || !closer ? "pan-y" : "none";
  if (S.ui) S.ui.paint({ atMin: S.zoom <= 1.001, atMax: S.zoom >= zm * 0.999, raw: !!(S.fv && S.fv.raw), isClose: !S.user, isWhole: S.zoom <= 1.001, rawOk: !!(S.fv && S.fv.ready) });
  const z = $("zoom");
  if (z && z.options.length) {
    const up = [...z.options].map((o) => +o.value).filter((v) => v >= S.zoom - 0.01).sort((a, b) => a - b)[0];
    z.value = String(up != null ? up : z.options[z.options.length - 1].value);
  }
  const a = pngArcsec();
  try { document.dispatchEvent(new CustomEvent("fazari:zoom", { detail: { k: S.k, zoom: S.zoom, user: S.user, fov_arcmin: a && S.k ? [st.clientWidth * a / S.k / 60, st.clientHeight * a / S.k / 60] : null } })); } catch (_) {}
}

function scaleBar() {
  const a = pngArcsec(), el = $("hudScale");
  if (!a || !S.k) { el.hidden = true; return; }
  const perPx = a / S.k;                    // arcsec per screen pixel
  const pick = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600].find((v) => v / perPx >= 48) || 600;
  const px = pick / perPx;
  el.hidden = false;
  const ne = !(S.meta.grid && S.meta.grid.north_up_east_left === false);
  el.innerHTML = (ne ? `<svg class="compass" viewBox="0 0 34 34" width="34" height="34" aria-label="${esc(L("vw.compass", "North up, east left"))}">` +
    `<path d="M24 26V9M24 26H7" stroke="currentColor" stroke-width="1.6" fill="none"/>` +
    `<path d="M20.5 12L24 7l3.5 5M10 22.5L5 26l5 3.5" stroke="currentColor" stroke-width="1.6" fill="none"/>` +
    `<text x="24" y="5.5" font-size="7" text-anchor="middle" fill="currentColor">${L("vw.N", "N")}</text>` +
    `<text x="3" y="23" font-size="7" text-anchor="middle" fill="currentColor">${L("vw.E", "E")}</text></svg>` : "") +
    `<span class="bar" style="width:${px.toFixed(0)}px"></span><span>${pick >= 60 ? pick / 60 + "′" : pick + "″"}</span>`;
}

// --- the season pair: the arrow, the result card, Before/After and the compare line all use it ---------
const idxIn = (bin, ep) => (bin ? bin.frames.findIndex((f) => f.epoch === ep) : -1);
/** The result's headline pair [from, to] (epochs): the pipeline's same-orientation pair for motion,
 *  the preview's rough pair, or the strongest brightness change (in `bin` only). */
function headEpochs(bin = S.bin) {
  const ms = (S.meta && S.meta.measured) || {};
  if (ok(ms.shift_arcsec) && ms.from_epoch && ms.to_epoch) return [ms.from_epoch, ms.to_epoch];
  const pre = ms.preliminary;
  if (pre && pre.from_epoch && pre.to_epoch) return [pre.from_epoch, pre.to_epoch];
  if (ms.photometry && bin) {
    const c = bestChange(ms.photometry);
    if (c && c.main && Math.abs(c.main.b.wavelength_um - bin.wavelength_um) < 0.05) return [c.from, c.to];
  }
  return null;
}
function headIdx(bin = S.bin) {
  const h = headEpochs(bin);
  if (!h) return null;
  const a = idxIn(bin, h[0]), b = idxIn(bin, h[1]);
  return a >= 0 && b > a ? [a, b] : null;
}
/** Seasons shown on opening a bin: the headline pair when this bin has it, else the two most distant. */
function defaultSel(bin = S.bin) { const n = bin.frames.length; return headIdx(bin) || (n > 1 ? [0, n - 1] : [0]); }
/** The pair on screen [iA, iB] (frame indices): the two selected seasons; with more selected, the
 *  headline pair if it is among them, else the first and last selected. */
function pairIdx() {
  if (!S.bin || S.sel.length < 2) return null;
  if (S.sel.length === 2) return S.sel.slice();
  const h = headIdx();
  if (h && S.sel.includes(h[0]) && S.sel.includes(h[1])) return h;
  return [S.sel[0], S.sel[S.sel.length - 1]];
}
const pairEpochs = () => { const p = pairIdx(); return p ? [S.bin.frames[p[0]].epoch, S.bin.frames[p[1]].epoch] : null; };
/** Measured motion between two seasons: the pipeline's value for that pair (meta.measured.pairs, or
 *  the headline), else from the per-season positions. { s, e, p, pa, ppa, dt, headline, same } | null */
function motionPair(ea, eb) {
  const ms = (S.meta && S.meta.measured) || {};
  const num = (v) => (ok(v) ? +v : null);
  if (ms.from_epoch === ea && ms.to_epoch === eb && ok(ms.shift_arcsec))
    return { s: +ms.shift_arcsec, e: num(ms.shift_err_arcsec), p: num(ms.gaia_predicted_arcsec), pa: num(ms.pa_deg), ppa: num(ms.gaia_pa_deg),
      dt: num(ms.dt_years), headline: true, same: ms.same_orientation };
  const q = (ms.pairs || []).find((x) => x.from === ea && x.to === eb && ok(x.shift_arcsec));
  if (q) return { s: +q.shift_arcsec, e: num(q.shift_err_arcsec), p: num(q.gaia_predicted_arcsec), pa: num(q.pa_deg), ppa: num(q.gaia_pa_deg),
    dt: num(q.dt_years), headline: !!q.headline, same: q.same_orientation };
  const pos = ms.positions || [];
  const A = pos.find((x) => x.epoch === ea), B = pos.find((x) => x.epoch === eb);
  if (!A || !B || !ok(A.ra) || !ok(B.ra)) return null;
  const cosd = Math.cos(((+A.dec + +B.dec) / 2) * Math.PI / 180);
  const vec = (ra0, de0, ra1, de1) => { const dE = (ra1 - ra0) * cosd * 3600, dN = (de1 - de0) * 3600;
    return { s: Math.hypot(dE, dN), pa: ((Math.atan2(dE, dN) * 180 / Math.PI) + 360) % 360, dE, dN }; };
  const m = vec(+A.ra, +A.dec, +B.ra, +B.dec);
  const sq = (v) => (ok(v) ? v * v : 0);
  const e = m.s > 0 ? Math.sqrt((m.dE / m.s) ** 2 * (sq(A.err_east_arcsec) + sq(B.err_east_arcsec)) + (m.dN / m.s) ** 2 * (sq(A.err_north_arcsec) + sq(B.err_north_arcsec))) : null;
  const g = ok(A.gaia_ra) && ok(B.gaia_ra) && !S.ref.none ? vec(+A.gaia_ra, +A.gaia_dec, +B.gaia_ra, +B.gaia_dec) : null;
  const od = ok(A.orient_deg) && ok(B.orient_deg) ? Math.abs(((B.orient_deg - A.orient_deg) % 360 + 540) % 360 - 180) : null;
  return { s: m.s, e, p: g ? g.s : null, pa: m.pa, ppa: g ? g.pa : null, dt: ok(A.mjd) && ok(B.mjd) ? (B.mjd - A.mjd) / 365.25 : null,
    headline: false, same: od == null ? null : od < 90, fromPositions: true };
}
/** Brightness change between two seasons in the bin on screen: { r, er, n, main } | { none, why } */
function brightPair(ea, eb) {
  const ph = ((S.meta && S.meta.measured) || {}).photometry;
  const pb = ph && (ph.bins || []).find((b) => Math.abs(b.wavelength_um - S.bin.wavelength_um) < 0.05);
  if (!pb || !(pb.seasons || []).length) return { none: true, why: ptext(((pb && pb.flags) || []).join("; ")) || L("vw.why.noPhotWl", "no photometry at this wavelength") };
  const A = pb.seasons.find((x) => x.epoch === ea), B = pb.seasons.find((x) => x.epoch === eb);
  if (!A || !B || !(+A.ratio_to_first > 0) || !ok(B.ratio_to_first)) return { none: true, why: L("vw.why.noPhotPair", "no photometry for this pair of seasons") };
  const rA = +A.ratio_to_first, rB = +B.ratio_to_first, r = rB / rA;
  const er = r * Math.hypot((+A.ratio_err || 0) / rA, (+B.ratio_err || 0) / rB);
  const c = bestChange(ph);
  return { r, er, n: pb.n_comparison, main: !!(c && c.main && c.main.b === pb && c.from === ea && c.to === eb) };
}

// --- overlay: season marks, track, true-length arrow, catalogue ring, field stars, game click ---------------------
const visitIdx = (ep) => Math.max(0, ((S.meta && S.meta.epochs) || []).indexOf(ep));
const visitCol = (ep) => FV.visitColour(visitIdx(ep));
/** Where the object was in every season that has a position of this kind: [{ ep, xy }] in time order. */
function seasonTrack(measured) {
  return (S.meta.epochs || []).map((ep) => {
    const p = measured ? measuredPos(ep) : null, xy = measured ? p && p.png_xy_measured : markerXY(ep);
    return xy ? { ep, xy } : null;
  }).filter(Boolean);
}
function motionPoints() {
  const pe = pairEpochs();
  if (!pe) return null;
  const [ea, eb] = pe;
  const eps = selFrames().map((f) => f.epoch);
  const mA = measuredPos(ea), mB = measuredPos(eb);
  if (mA && mB) return { kind: "measured", ea, eb, a: mA.png_xy_measured, b: mB.png_xy_measured, all: seasonTrack(true),
    path: eps.map((e) => measuredPos(e)).filter(Boolean).map((p) => p.png_xy_measured) };
  if (S.ref.none) return null;
  const cA = markerXY(ea), cB = markerXY(eb);
  if (cA && cB && Math.hypot(cB[0] - cA[0], cB[1] - cA[1]) > 1) return { kind: "predicted", ea, eb, a: cA, b: cB, all: seasonTrack(false), path: eps.map((e) => markerXY(e)).filter(Boolean) };
  return null;
}
/** A small cross with an open middle at a measured position (the object itself stays visible), in the visit's colour.
 *  gapPx: the open middle in screen px (at least the old 4.5 / 6.5; wider when the object's light is wider). */
function tickSvg(x, y, col, u, strong, dir, gapPx = 0) {
  const g = Math.max(dir ? 4.5 : 6.5, gapPx) * u, l = (dir ? (strong ? 10 : 6) : 6) * u, w = (strong ? 2.6 : 1.8) * u;
  // along a track (dir): two short bars across it, like the marks of a ruler; a lone position: a cross with an open middle
  const seg = (ax, ay) => `M${(x + ax * g).toFixed(2)} ${(y + ay * g).toFixed(2)}L${(x + ax * (g + l)).toFixed(2)} ${(y + ay * (g + l)).toFixed(2)}`;
  const d = dir ? seg(-dir[1], dir[0]) + seg(dir[1], -dir[0]) : seg(-1, 0) + seg(1, 0) + seg(0, -1) + seg(0, 1);
  return `<path d="${d}" fill="none" stroke="#05070d" stroke-opacity=".85" stroke-width="${w + 2.4 * u}" stroke-linecap="round"/>` +
    `<path class="fz-tick" d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round"${strong ? "" : ' stroke-opacity=".78"'}/>`;
}
/** The arrow's label: the same number the result card shows for this pair. */
function arrowText(mp) {
  if (mp.kind === "measured") {
    const v = motionPair(mp.ea, mp.eb);
    return v ? { long: arcsec(v.s, v.e) + (v.dt ? " " + span(v.dt) : ""), short: arcsec(v.s, v.e) } : null;
  }
  const pre = ((S.meta.measured || {}).preliminary) || {};
  let s = pre.from_epoch === mp.ea && pre.to_epoch === mp.eb && ok(pre.catalogue_shift_arcsec) ? +pre.catalogue_shift_arcsec : null;
  if (s == null && pngArcsec()) s = Math.hypot(mp.b[0] - mp.a[0], mp.b[1] - mp.a[1]) * pngArcsec();
  if (s == null) return null;
  const fa = S.bin.frames.find((f) => f.epoch === mp.ea), fb = S.bin.frames.find((f) => f.epoch === mp.eb);
  const dt = fa && fb ? daysApart(fa, fb) / 365.25 : null;
  return { long: `≈${arcsec(s)}${dt ? " " + span(dt) : ""} (${L("vw.predOf", "{who} prediction", { who: S.ref.short })})`, short: "≈" + arcsec(s) };
}
const RING = 15;                  // ring radius in PNG px (about 11″ on the sky)
const ringR = (u) => Math.min(Math.max(RING, 13 * u), 60 * u);     // never under 13 screen px, never over 60 (a close zoom)
let arrowLabel = "";              // the arrow's speed label, added after the ring so nothing covers it
let ticksDrawn = false;           // the season marks are on the picture (the single "we measured" dot is then not needed)
function motionSvg(u, legend) {
  const mp = motionPoints();
  if (!mp) return "";
  const a = mp.a, b = mp.b;
  const halo = (d, w) => `<path d="${d}" fill="none" stroke="#05070d" stroke-opacity=".8" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  let s = "";
  // where the object was in every season: a thin line through the positions and one small mark per visit, in the
  // visit's colour (measured positions exactly as in meta.json); the mark of the season on screen is the strong one.
  // They stay put while the film plays: the object jumps from mark to mark.
  const cur = S.bin.frames[S.idx].epoch, measured = mp.kind === "measured", plain = S.view === "tcol" || S.view === "diff";
  // colour of a visit's mark: its own colour in the film; in "time as colour" the two colours of that picture; else neutral
  const markCol = (ep) => (S.view === "tcol" && fvOn() ? (ep === mp.ea ? FV.TIME_FIRST : ep === mp.eb ? FV.TIME_LAST : "#e8eaf0") : plain ? "#e8eaf0" : visitCol(ep));
  const ext = mp.all.length > 1 ? Math.max(...mp.all.map((q) => Math.hypot(q.xy[0] - mp.all[0].xy[0], q.xy[1] - mp.all[0].xy[1]))) : 0;
  // the object's own light on screen (the field stars' width, measured on these frames): the marks stay outside it,
  // so they never cover what they mark. The line through the positions is left out while it would run through that light.
  const fset = fvOn() ? S.fv.set : null, upP = (S.meta.grid || {}).upscale || 4;
  const blob = Math.min(70, Math.max(8, ((fset && fset.fwhm) || 3.5) * 1.1 * upP * S.k)), gapPx = 0.5 * blob;
  if (ext * S.k >= Math.max(12, 2.2 * blob)) {
    const d = "M" + mp.all.map((q) => q.xy.map((v) => v.toFixed(1)).join(" ")).join("L");
    s += halo(d, 3 * u) + `<path d="${d}" fill="none" stroke="#e8eaf0" stroke-opacity=".6" stroke-width="${1.2 * u}"${measured ? "" : ` stroke-dasharray="${4 * u} ${3 * u}"`}/>`;
  }
  if (measured) {
    const far = ext * S.k >= 12, p0 = mp.all[0].xy, p1 = mp.all[mp.all.length - 1].xy, pl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
    const dir = far ? [(p1[0] - p0[0]) / pl, (p1[1] - p0[1]) / pl] : null;
    const live = S.view === "film" && S.mode !== "trail" && S.mode !== "swipe", q = mp.all.find((x) => x.ep === cur);
    // apart on screen: one mark per visit; all on one spot (nothing moved): only the mark of the visit on screen
    if (far) mp.all.forEach((x) => { if (x !== q || !live) s += tickSvg(x.xy[0], x.xy[1], markCol(x.ep), u, false, dir, gapPx); });
    if (q && live) s += tickSvg(q.xy[0], q.xy[1], visitCol(q.ep), u, true, dir, gapPx);
    else if (q && !far) s += tickSvg(q.xy[0], q.xy[1], "#e8eaf0", u, false, null, gapPx);
    ticksDrawn = true;
  }
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  let drawn = false, speedLg = "";
  if (len > 0.2) {
    const ux = dx / len, uy = dy / len;
    // the arrow: TRUE length (first to last season of the pair, nothing magnified), drawn beside the track so it
    // never covers the object; only for a shift outside its own noise, and only when it is long enough to see
    const Sw = $("stage").clientWidth, Sh = $("stage").clientHeight;
    const mv = measured ? motionPair(mp.ea, mp.eb) : null;
    const sig = !measured || !!(mv && significant(mv.s, mv.e));
    drawn = sig && len * S.k >= 16;
    let px = -uy, py = ux;
    if (px < 0 || (Math.abs(px) < 0.3 && py > 0)) { px = -px; py = -py; }
    if (S.tx + (a[0] + b[0]) / 2 * S.k > Sw * 0.62) { px = -px; py = -py; }        // close to the right edge: the other side
    const o = drawn ? Math.max(26, gapPx + 16) * u : 0;
    if (drawn && S.nbBoxes && S.nbBoxes.length) {             // a catalogue star's label on that side (WISE 0855): the other side when it is free
      const hit = (sg) => {
        const xs = [a[0], b[0]].map((v) => S.tx + (v + sg * px * o) * S.k), ys = [a[1], b[1]].map((v) => S.ty + (v + sg * py * o) * S.k);
        const x0 = Math.min(...xs) - 8, x1 = Math.max(...xs) + 8, y0 = Math.min(...ys) - 8, y1 = Math.max(...ys) + 8;
        return S.nbBoxes.some((q) => x0 < q[2] && x1 > q[0] && y0 < q[3] && y1 > q[1]);
      };
      if (hit(1) && !hit(-1)) { px = -px; py = -py; }
    }
    const a2 = [a[0] + px * o, a[1] + py * o], tip = [b[0] + px * o, b[1] + py * o], tl = len;
    const hl = Math.min(12 * u, tl * 0.6), hw = Math.min(6.5 * u, tl * 0.33);
    const bx = tip[0] - ux * hl, by = tip[1] - uy * hl;
    const head = `M${tip[0].toFixed(2)} ${tip[1].toFixed(2)}L${(bx - uy * hw).toFixed(2)} ${(by + ux * hw).toFixed(2)}L${(bx + uy * hw).toFixed(2)} ${(by - ux * hw).toFixed(2)}Z`;
    const line = `M${a2[0].toFixed(2)} ${a2[1].toFixed(2)}L${bx.toFixed(2)} ${by.toFixed(2)}`;
    const col = measured ? "#ffffff" : "#ffd08a";
    const sw = 2.6;
    if (drawn) {
      const l0 = Math.min(o, (gapPx + 6) * u), la = [a[0] + px * l0, a[1] + py * l0], lb = [b[0] + px * l0, b[1] + py * l0];   // from outside the object's light
      const lead = `M${la[0].toFixed(2)} ${la[1].toFixed(2)}L${a2[0].toFixed(2)} ${a2[1].toFixed(2)}M${lb[0].toFixed(2)} ${lb[1].toFixed(2)}L${tip[0].toFixed(2)} ${tip[1].toFixed(2)}`;
      s += `<path d="${lead}" fill="none" stroke="#e8eaf0" stroke-opacity=".5" stroke-width="${1 * u}"/>` +
        halo(line, (sw + 3.4) * u) + halo(head, 3.2 * u) +
        `<path class="fz-arrow" d="${line}" stroke="${col}" stroke-width="${sw * u}" stroke-linecap="round"${measured ? "" : ` stroke-dasharray="${5 * u} ${3 * u}"`}/>` +
        `<path d="${head}" fill="${col}"/>`;
    }
    // labels: the first season behind the start, the last ahead of the end, the speed beside the arrow
    const lab = (x, y, t, c, anchor = "middle", size = 13) =>
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${c}" font-size="${size * u}" font-weight="700" text-anchor="${anchor}" ` +
      `dominant-baseline="middle" stroke="#05070d" stroke-width="${3.2 * u}" paint-order="stroke" font-family="system-ui, sans-serif">${esc(t)}</text>`;
    const off = ringR(u) + (11 + 30 * Math.abs(ux)) * u;       // clear of the ring, also for sideways motion
    const seasonBoxes = [];                                   // where the two season labels sit on screen (the speed label keeps clear)
    if (len * S.k >= 10 && Sw >= 440) {                       // a narrow picture: the coloured marks and the visit buttons say it
      [[a[0] - ux * off, a[1] - uy * off, mp.ea], [b[0] + ux * off, b[1] + uy * off, mp.eb]].forEach(([x, y, ep]) => {
        const txt = season(ep), X = S.tx + x * S.k, Y = S.ty + y * S.k, w = txt.length * 13 * 0.6;
        s += lab(x, y, txt, markCol(ep));
        seasonBoxes.push([X - w / 2, Y - 9, X + w / 2, Y + 9]);
      });
    }
    let sp = measured && sig ? speedOf((S.meta.measured || {}).fit, motionPair(mp.ea, mp.eb)) : null;
    if (sp && !(sp.e > 0)) sp = null;                         // a speed without an error bar of its own is not stated
    if (sp) {
      // speed ± error and direction, and "true length", beside the arrow; kept inside the stage
      const l1 = speedText(sp), l2 = drawn ? scaleText(1) : L("fz.arw.small", "too small to draw at this zoom"), side = Math.abs(ux) > 0.55;
      const P = (x, y) => [S.tx + x * S.k, S.ty + y * S.k];
      const [ax, ay] = P(a2[0], a2[1]), [qx, qy] = P(tip[0], tip[1]), mx = (ax + qx) / 2, my = (ay + qy) / 2;
      const lg = $("hudLegend"), legH = lg && !lg.hidden ? lg.offsetHeight + 10 : 10;
      const bw = Math.max(l1.length * 15, l2.length * 12.5) * 0.56, bh = 36;       // label box in screen px (estimate)
      const hx = (x0) => Math.min(Math.max(x0, 6), Sw - 6 - bw);                  // above / below the arrow: slide sideways freely
      // never over the object itself: the box of all its positions on screen (with room for the marks) is kept free
      const tx0 = mp.all.map((q) => S.tx + q.xy[0] * S.k), ty0 = mp.all.map((q) => S.ty + q.xy[1] * S.k);
      const pad = Math.max(18, gapPx + 10), own = [Math.min(...tx0) - pad, Math.min(...ty0) - pad, Math.max(...tx0) + pad, Math.max(...ty0) + pad];
      const clear = (x0, y0) => ![own, ...seasonBoxes, ...(S.nbBoxes || [])].some((b) => x0 < b[2] + 4 && x0 + bw > b[0] - 4 && y0 < b[3] + 4 && y0 + bh > b[1] - 4);
      const fits = (bottom) => ([x0, y0]) => x0 >= 6 && y0 >= 70 && x0 + bw <= Sw - 50 && y0 + bh <= Sh - bottom && clear(x0, y0);   // clear of the caption (top) and the zoom buttons (right)
      const out = Math.abs(px) >= Math.abs(py) ? (px > 0 ? [Math.max(ax, qx) + 14, my - bh / 2] : [Math.min(ax, qx) - 14 - bw, my - bh / 2])
        : [hx(mx - bw / 2), py < 0 ? Math.min(ay, qy) - 14 - bh : Math.max(ay, qy) + 14];              // the arrow's outer side first
      const cands = [out, side ? (ux > 0 ? [qx + 12, qy - bh / 2] : [qx - 12 - bw, qy - bh / 2]) : [qx - bw / 2, uy < 0 ? qy - 12 - bh : qy + 12],
        [hx(mx - bw / 2), Math.min(ay, qy) - 14 - bh], [hx(mx - bw / 2), Math.max(ay, qy) + 14],
        [Math.max(ax, qx) + 14, my - bh / 2], [Math.min(ax, qx) - 14 - bw, my - bh / 2]];
      // no free place (a small picture): the number goes into the legend line instead of over the object
      const box = cands.find(fits(legH)) || cands.find(fits(6)) || null;
      if (box) {
        const lx = (box[0] + bw / 2 - S.tx) / S.k, ly = (box[1] + 10 - S.ty) / S.k;
        arrowLabel = lab(lx, ly, l1, "#ffffff", "middle", 15) + lab(lx, ly + 17 * u, l2, "#ffd08a", "middle", 12);   // drawn last (over the ring)
      } else speedLg = l1;
    }
    const at = mp.kind === "measured" ? null : arrowText(mp);
    if (at) {
      const t = at.long, short = at.short;
      // beside the ring, on the side with room on screen (right, else left, else below)
      let px = -uy, py = ux;
      if (px < 0 || (Math.abs(px) < 0.3 && py < 0)) { px = -px; py = -py; }
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, d = ringR(u) + (30 + 14 * Math.abs(py)) * u;
      const Sw = $("stage").clientWidth, scr = (x) => S.tx + x * S.k;
      const width = (str) => str.length * 15 * 0.56;                       // text width in screen px (estimate)
      let pick = null;
      for (const str of [t, short]) {
        if (px <= 0.3) { pick = { str, x: cx + px * d, y: cy + py * d, anchor: "middle" }; break; }
        if (scr(cx + px * d) + width(str) < Sw - 6) { pick = { str, x: cx + px * d, y: cy + py * d, anchor: "start" }; break; }
        if (scr(cx - px * d) - width(str) > 6) { pick = { str, x: cx - px * d, y: cy - py * d, anchor: "end" }; break; }
      }
      if (!pick) pick = { str: short, x: cx + px * d, y: cy + py * d, anchor: "middle" };
      s += lab(pick.x, pick.y, pick.str, "#ffffff", pick.anchor, 15);
    }
  }
  if (drawn || speedLg) legend.push(measured ? `<span><i class="lg arrow"></i>${esc(L("fz.lg.arrow", "measured motion, true length"))}${speedLg ? ": " + esc(speedLg) : ""}</span>`
    : `<span><i class="lg arrow dash"></i>${esc(L("vw.lg.predPath", "{who} predicted path", { who: S.ref.short }))}</span>`);
  return s;
}
function ringSvg(u, legend) {
  const f = S.bin.frames[S.idx];
  const xy = markerXY(f.epoch);
  if (!xy) return "";
  const [x, y] = xy, r = ringR(u);
  // a thin ring where the catalogue puts the object in the season on screen (a picked point: the point itself),
  // and a fainter one around it
  let s = `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#05070d" stroke-opacity=".6" stroke-width="${3.4 * u}"/>` +
    `<circle class="fz-ring" cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#ffb347" stroke-width="${1.5 * u}"/>` +
    `<circle cx="${x}" cy="${y}" r="${2 * r}" fill="none" stroke="#ffb347" stroke-opacity=".38" stroke-width="${1.1 * u}"/>`;
  const sn = (S.meta.measured || {}).snap;
  legend.push(`<span><i class="lg fz-thin"></i>${S.ref.none ? esc(sn ? L("vw.lg.snapped", "source we measured") : L("vw.lg.picked", "position you picked")) : esc(L("vw.lg.predicts", "{who} predicts", { who: S.ref.short }))}</span>`);
  if (sn && sn.clicked && sn.clicked.png_xy) {          // moved to the nearest source: the clicked point stays as a small mark
    const [cx, cy] = sn.clicked.png_xy, r = 4.5 * u;
    s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#05070d" stroke-width="${3.4 * u}"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#7fd4ff" stroke-width="${1.6 * u}"/>`;
    legend.push(`<span><i class="lg clicked" style="border:2px solid #7fd4ff;border-radius:50%;width:8px;height:8px;display:inline-block"></i>${esc(L("vw.lg.clicked", "where you clicked"))}</span>`);
  }
  const p = measuredPos(f.epoch);
  if (p) {
    const [mx, my] = p.png_xy_measured;
    if (!ticksDrawn) s += `<circle cx="${mx}" cy="${my}" r="${3.6 * u}" fill="#5dd39e" stroke="#05070d" stroke-width="${1.6 * u}"/>`;
    const d = Math.hypot(+p.minus_gaia_east_arcsec || 0, +p.minus_gaia_north_arcsec || 0);
    legend.push(`<span>${ticksDrawn ? `<i class="lg fz-tick" style="color:${visitCol(f.epoch)}"></i>` : `<i class="lg dot"></i>`}${esc(ticksDrawn ? L("fz.lg.meas", "we measured, one colour per visit") : L("vw.lg.we", "we measured"))}${ok(p.minus_gaia_east_arcsec) && !S.ref.none ? " " + esc(L("vw.lg.apart", "({d}″ apart)", { d: loc(d.toFixed(2)) })) : ""}</span>`);
  }
  return s;
}
// --- catalogue stars of the field (the result's own gaia_field.json): faint thin rings at each star's place on the
// date of the frame on screen (proper motion applied). They show that the picture and the sky grid agree.
function loadStars() {
  const key = S.base, m = S.meta;
  if (S.starKey === key) return;
  S.starKey = key; S.stars = null;
  if (m.preview || !gridOf(m)) return;                                   // a preview has no star list
  const fc = (m.measured || {}).field_calibration;                       // no catalogue stars in the measurement (R Dra, RW Aur, a job whose
  if (!fc || !(+fc.n_reference_stars > 0)) return;                       // Gaia query timed out): no gaia_field.json either, so no request
  fetch(S.base + "gaia_field.json").then((r) => (r.ok ? r.text() : null)).then((txt) => {
    if (!txt || S.starKey !== key) return;
    const gf = JSON.parse(txt.replace(/\[(\d{16,20}),/g, '["$1",'));     // keep the 19-digit source_id exact
    const col = (n) => (gf.columns || []).indexOf(n);
    const [iI, iR, iD, iA, iP, iG] = ["source_id", "ra", "dec", "pmra", "pmdec", "phot_g_mean_mag"].map(col);
    if (iR < 0 || iD < 0) return;
    const own = String((m.gaia || {}).source_id || "");
    const list = (gf.stars || []).filter((s) => ok(s[iR]) && ok(s[iD]) && !(own && iI >= 0 && String(s[iI]) === own))
      .map((s) => ({ ra: +s[iR], dec: +s[iD], pmra: iA >= 0 && ok(s[iA]) ? +s[iA] : 0, pmdec: iP >= 0 && ok(s[iP]) ? +s[iP] : 0, g: iG >= 0 && ok(s[iG]) ? +s[iG] : 99 }))
      .sort((a, b) => a.g - b.g);
    S.stars = { ref: ok(gf.ref_epoch) ? +gf.ref_epoch : 2016, list, at: new Map() };
    drawOverlay();
  }).catch(() => {});
}
function starsAt(f) {
  const st = S.stars, g = st && gridOf(S.meta);
  if (!st || !g || !f) return [];
  if (!st.at.has(f.epoch)) {
    const dt = 2000 + (dayNum(f.date) - 10957.5) / 365.25 - st.ref, [W, H] = pngSize(), top = labelStrip(), out = [];
    for (const s of st.list) {
      const cd = Math.cos(s.dec * Math.PI / 180) || 1;
      const [x, y] = g.toPng(s.ra + (Number.isFinite(dt) ? s.pmra * dt / 3.6e6 / cd : 0), s.dec + (Number.isFinite(dt) ? s.pmdec * dt / 3.6e6 : 0));
      if (x > 3 && y > top + 3 && x < W - 3 && y < H - 3) out.push([x, y, s.g]);
      if (out.length >= 600) break;
    }
    st.at.set(f.epoch, out);
  }
  return st.at.get(f.epoch);
}
function starSvg(u, legend) {
  const set = fvOn() ? S.fv.set : null, pts = set ? starsAt(S.bin.frames[S.idx]) : [];
  if (!pts.length) return "";
  const Sw = $("stage").clientWidth, Sh = $("stage").clientHeight, r = Math.min(Math.max(4.5, 9 * u), 18 * u);   // 9 to 18 screen px
  // only stars this wavelength really shows in the visit on screen (a few times the noise at the star's place):
  // a ring on empty sky would say nothing
  const up = (S.meta.grid || {}).upscale || 4, top = labelStrip(), lin = set.lin[S.idx], lim = 5 * set.sigmaLin[S.idx], nx = set.nx, ny = set.ny;
  const RING8 = [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, 4], [4, -4], [-4, -4]];
  const seen = (x, y) => {          // a peak at the star's place that stands above its own surroundings (not just a bright star's glow)
    const i = Math.round((x - up / 2) / up), j = Math.round((y - top - up / 2) / up);
    if (i < 6 || j < 6 || i >= nx - 6 || j >= ny - 6) return false;
    let mx = -Infinity;
    for (let b = j - 1; b <= j + 1; b++) for (let a = i - 1; a <= i + 1; a++) if (lin[b * nx + a] > mx) mx = lin[b * nx + a];
    const around = RING8.map(([a, b]) => lin[(j + b) * nx + i + a]).sort((p, q) => p - q);
    return mx - (around[3] + around[4]) / 2 >= lim;
  };
  let s = "", n = 0;
  for (const [x, y, g] of pts) {                                           // brightest first; only what is on screen
    const X = S.tx + x * S.k, Y = S.ty + y * S.k;
    if (X < -10 || Y < -10 || X > Sw + 10 || Y > Sh + 10 || g > 19 || !seen(x, y)) continue;
    s += `<circle class="fz-star" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="none" stroke="#9fb4d8" stroke-opacity=".6" stroke-width="${1 * u}"/>`;
    if (++n >= 40) break;
  }
  if (n) legend.push(`<span><i class="lg fz-star"></i>${esc(L("fz.lg.stars", "catalogue stars (Gaia)"))}</span>`);
  return s;
}
function drawOverlay() {
  if (!S.meta || !S.bin) return;
  const ov = $("ov"), [W, H] = pngSize();
  ov.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const u = 1 / (S.k || 1);
  const hide = S.game && !S.game.revealed;
  const legend = [];
  let s = "";
  // static catalogue stars near the track: labelled first, so the arrow's label can keep clear of them
  const nbItems = !hide && $("mark").checked && S.nb && S.nb.length ? neighbourLayout(S.nb, S.meta,
    ((S.meta.measured || {}).positions || []).map((p) => p.png_xy_measured).filter(Boolean),
    { tx: S.tx, ty: S.ty, k: S.k, Sw: $("stage").clientWidth, Sh: $("stage").clientHeight }) : [];
  S.nbBoxes = nbItems.map((it) => it.box);
  ticksDrawn = false;
  const lgStars = [], lgMotion = [];
  if (S.view === "diff" && fvOn() && S.satMark && S.satMark.html) s += S.satMark.html;   // Difference tab: the saturated core is not data
  if (!hide && $("mark").checked) s += starSvg(u, lgStars);                   // faint rings on the catalogue stars, under everything else
  if (!hide && $("arrowOn").checked && !S.noArrow) s += motionSvg(u, lgMotion);   // S.noArrow: bins_bar.js, an answer that is too uncertain
  if (!hide && $("mark").checked) s += ringSvg(u, legend);
  legend.push(...lgMotion, ...lgStars);
  if (nbItems.length) s += neighbourSvg(nbItems, u, legend);
  s += arrowLabel; arrowLabel = "";
  if (S.game && S.game.click) {
    const [x, y] = S.game.click, c = S.game.hit ? "#5dd39e" : "#7fd4ff";
    const d = `M${x - 9 * u} ${y - 9 * u}L${x + 9 * u} ${y + 9 * u}M${x + 9 * u} ${y - 9 * u}L${x - 9 * u} ${y + 9 * u}`;
    s += `<path d="${d}" stroke="#05070d" stroke-width="${6 * u}"/><path d="${d}" stroke="${c}" stroke-width="${3 * u}"/>`;
  }
  ov.innerHTML = s;
  const lg = $("hudLegend"), html = legend.join("");
  if (lg.innerHTML !== html) lg.innerHTML = html;
  lg.hidden = !legend.length;
  const lg2 = $("fzLegend");            // the same legend under the picture: narrow screens show this one (css/fz_stage.css)
  if (lg2) { if (lg2.innerHTML !== html) lg2.innerHTML = html; lg2.hidden = !legend.length; }
}

// --- frames, modes, seasons ------------------------------------------------------------------
function setSrc(img, url) { if (img.getAttribute("src") !== url) img.setAttribute("src", url); }
function roleOf(i) {
  const p = pairIdx();
  return !p ? "" : i === p[0] ? "before" : i === p[1] ? "after" : "";
}
// --- the picture itself: the processed frames on the canvas (js/fz_view.js), the caption as real text ---------------
const fvKey = () => `${S.base}|${S.bi}|${S.bin ? S.bin.frames.map((f) => f.file + ":" + (f.n_images || 0)).join(",") : ""}`;
const fvOn = () => !!(S.fv && S.fv.ready && S.fv.key === fvKey());
const swipeX = () => Math.max(0, Math.min(1, (($("stage").clientWidth * +$("swipe").value / 100 - S.tx) / (S.k || 1)) / pngSize()[0]));
/** What the canvas shows for the view tab and the mode on screen. */
function viewSpec() {
  const pr = pairIdx() || [S.sel[0], S.sel[S.sel.length - 1]], two = pr[0] !== pr[1];
  if (S.view === "tcol" && two) return { kind: "tcol", a: pr[0], b: pr[1] };
  if (S.view === "diff" && two) return { kind: "diff", a: pr[0], b: pr[1] };
  if (S.view === "deep") return { kind: "deep", idx: S.bin.frames.map((_, i) => i) };
  if (S.view === "film" && S.mode === "swipe" && two) return { kind: "swipe", a: pr[0], b: pr[1], x: swipeX() };
  if (S.view === "film" && S.mode === "trail") return { kind: "trail", idx: S.sel.slice() };
  return { kind: "frame", i: S.idx };
}
let holdT = 0;
function paintStage() {
  const fv = S.fv;
  if (!fv || !S.bin) return;
  let on = false;
  if (fvOn()) on = fv.paint(viewSpec());
  else if (fv.ready && performance.now() < (S.fvHold || 0)) {
    // another wavelength is being prepared: the last picture stays for a moment (no flash of the unprocessed frame)
    clearTimeout(holdT); holdT = setTimeout(paintStage, Math.max(30, S.fvHold - performance.now() + 10));
    return;
  } else fv.hide();
  const film = S.view === "film";
  $("frameB").hidden = on || !(film && S.mode === "swipe");
  $("trail").hidden = on || !(film && S.mode === "trail");
  $("stage").classList.toggle("fz-on", on);
}
/** The target's place in every visit (measured, else the catalogue's), in cells of the frames' grid: a faint target
 *  sets the brightness scale of the picture (js/fz_frames.js prepare; display only). */
function targetCells(up, strip) {
  const eps = (S.meta.epochs || []).length ? S.meta.epochs : S.bin.frames.map((f) => f.epoch);
  return eps.map((ep) => { const m = measuredPos(ep); return (m && m.png_xy_measured) || markerXY(ep); })
    .filter((p) => p && ok(p[0]) && ok(p[1])).map(([x, y]) => [x / up - 0.5, (y - strip) / up - 0.5]);
}
/** Frames of the bin on screen into the canvas view (decode, sky match, alignment: js/fz_frames.js). */
function loadFrames() {
  if (!S.fv || !S.bin) return;
  const g = S.meta.grid || {}, key = fvKey(), bin = S.bin, up = g.upscale || 4, strip = labelStrip(), c = centreXY();
  if (S.fv.key === key && S.fv.ready) { paintStage(); return; }
  S.fvHold = performance.now() + 450;
  S.fv.load({ key, urls: bin.frames.map((f) => S.base + f.file), up, strip, stretch: bin.stretch || null,
    cellArcsec: g.pixel_arcsec || null, centre: [c[0] / up, (c[1] - strip) / up], targets: targetCells(up, strip) }).then(() => {
    if (S.bin !== bin || fvKey() !== key) return;
    if (!viewOk(S.view)) S.view = "film";
    viewUi(); paintStage(); caption(); zoomUi(); drawOverlay();
  });
}
const viewOk = (v) => v === "film" || (FV.VIEWS.includes(v) && fvOn() && S.bin.frames.length > 1 && (v === "deep" || S.sel.length > 1));
/** "24–30 Apr 2026", "29 Aug – 1 Oct 2025": the days the exposures of a visit were taken. */
function dateRange(d0, d1) {
  const a = Date.parse(String(d0 || "").slice(0, 10) + "T00:00:00Z"), b = Date.parse(String(d1 || "").slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(a)) return "";
  const f = (v, o) => new Intl.DateTimeFormat(lang() === "tr" ? "tr-TR" : "en-GB", { timeZone: "UTC", ...o }).format(v);
  const dmy = { day: "numeric", month: "short", year: "numeric" };
  if (!Number.isFinite(b) || b === a) return f(a, dmy);
  const A = new Date(a), B = new Date(b);
  if (A.getUTCFullYear() !== B.getUTCFullYear()) return `${f(a, dmy)} – ${f(b, dmy)}`;
  if (A.getUTCMonth() !== B.getUTCMonth()) return `${f(a, { day: "numeric", month: "short" })} – ${f(b, dmy)}`;
  return `${A.getUTCDate()}–${f(b, dmy)}`;
}
const expTxt = (n) => (+n === 1 ? L("fz.cap.exp1", "1 exposure") : L("fz.cap.expN", "{n} exposures", { n: n ?? "?" }));
/** The verdict strip's own headline (js/verdict_strip.js), repeated on the picture when nothing moved or the answer
 *  is not sure: the picture must not be left with an empty ring and no word. */
function statusLine() {
  const H = document.documentElement.classList, kind = H.contains("vd-k-none") ? "none" : H.contains("vd-k-unsure") ? "unsure" : "";
  const tEl = kind && $("vdStrip") && !$("vdStrip").hidden ? $("vdStrip").querySelector(".vd-t") : null;
  if (!tEl) return "";
  const txt = [...tEl.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
  return txt ? `<span class="st ${kind}">${esc(txt)}</span>` : "";
}
/** Caption on the picture: which visit, when, wavelength and detector, how many exposures over which days. */
function caption() {
  const hd = $("hudDate");
  if (!hd || !S.bin) return;
  const f = S.bin.frames[S.idx], fs = selFrames(), pr = pairIdx() || [S.sel[0], S.sel[S.sel.length - 1]];
  const A = S.bin.frames[pr[0]], B = S.bin.frames[pr[1]], n = (S.meta.epochs || []).length || S.bin.frames.length;
  const um = loc(S.bin.wavelength_um.toFixed(1)) + " µm", det = (fr) => ((fr.detectors || []).length ? " · " + L("fz.cap.det", "detector {d}", { d: fr.detectors.join("+") }) : "");
  const sw = (c) => `<i class="fz-dot" style="background:${c}"></i>`;
  let spec = viewSpec();
  if (!fvOn() && /^(tcol|diff|deep)$/.test(spec.kind)) spec = { kind: "frame" };   // those need the processed frames: until then the plain frame is on screen
  let c1, c2, c3, col = "#4a5368";
  if (spec.kind === "tcol") {
    c1 = esc(L("fz.tab.tcol", "Time as colour"));
    c2 = `${sw(FV.TIME_FIRST)}${esc(season(A.epoch))} &nbsp; ${sw(FV.TIME_LAST)}${esc(season(B.epoch))}`;
    c3 = esc(um);
  } else if (spec.kind === "diff") {
    c1 = esc(L("fz.tab.diff", "Difference"));
    c2 = esc(L("fz.cap.minus", "{b} minus {a}", { a: season(A.epoch), b: season(B.epoch) }));
    c3 = esc(um);
  } else if (spec.kind === "deep") {
    const all = S.bin.frames, tot = all.reduce((a, x) => a + (x.n_images || 0), 0);
    c1 = esc(L("fz.cap.deep", "All {n} visits added", { n: all.length }));
    c2 = esc(um + det(f));
    c3 = esc(expTxt(tot) + " · " + season(all[0].epoch) + " – " + season(all[all.length - 1].epoch));
  } else if (spec.kind === "swipe") {
    c1 = `<span style="color:${visitCol(A.epoch)}">${esc(season(A.epoch))}</span> | <span style="color:${visitCol(B.epoch)}">${esc(season(B.epoch))}</span>`;
    c2 = esc(um + det(A)); c3 = "";
  } else if (spec.kind === "trail") {
    c1 = esc(L("vw.trail", "Trail")) + " · " + fs.map((x) => `<span style="color:${visitCol(x.epoch)}">${esc(season(x.epoch))}</span>`).join(" + ");
    c2 = esc(um + det(f)); c3 = "";
  } else {
    col = visitCol(f.epoch);
    c1 = `<b>${esc(L("fz.cap.visit", "Visit {i} of {n}", { i: visitIdx(f.epoch) + 1, n }))}</b> · ${esc(season(f.epoch))}`;
    c2 = esc(um + det(f));
    c3 = esc(expTxt(f.n_images) + (f.date_first || f.date ? " · " + dateRange(f.date_first || f.date, f.date_last || f.date) : ""));
  }
  hd.className = "hud-date fz-cap";
  hd.style.borderLeftColor = col;
  const html = `<span class="c1">${c1}</span><span class="c2">${c2}</span>${c3 ? `<span class="c3">${c3}</span>` : ""}${statusLine()}`;
  if (hd.innerHTML !== html) hd.innerHTML = html;
}
/** One sentence under the picture for the view on screen, and one small line that says what was done to the picture. */
function viewSay() {
  const el = $("fzViewSay");
  if (!el || !S.bin) return;
  const pr = pairIdx() || [S.sel[0], S.sel[S.sel.length - 1]], A = S.bin.frames[pr[0]], B = S.bin.frames[pr[1]];
  const sw = (c) => `<i class="sw" style="background:${c}"></i>`;
  let say = "";
  if (S.view === "tcol") say = L("fz.say.tcol", "{sa}{a} is drawn in blue, {sb}{b} in orange. What stayed the same comes out white or grey. Something that moved shows twice: a blue spot where it was, an orange spot where it went.",
    { sa: sw(FV.TIME_FIRST), sb: sw(FV.TIME_LAST), a: esc(season(A.epoch, true)), b: esc(season(B.epoch, true)) });
  else if (S.view === "diff") say = L("fz.say.diff", "{b} minus {a}. {s1}brighter before · {s2}no change · {s3}brighter after. Stars that stay the same cancel out; a mover leaves blue where it was and red where it went.",
    { a: esc(season(A.epoch, true)), b: esc(season(B.epoch, true)), s1: sw("#2166ac"), s2: sw("#f7f7f7"), s3: sw("#b2182b") }) +
    (S.satMark && S.satMark.text ? " " + esc(S.satMark.text) : "");
  else if (S.view === "deep") say = L("fz.say.deep", "All {n} visits added together: fainter stars appear. Something that moved is smeared or shows more than once here; use Film to see it jump.", { n: S.bin.frames.length });
  let note = "";
  const set = fvOn() ? S.fv.set : null, cell = (S.meta.grid || {}).pixel_arcsec || 3;
  if (set && S.fv.raw) note = L("fz.note.raw", "Raw pixels: the stacked frame as it is, on its {c}″ grid, no smoothing. One SPHEREx detector pixel is 6.15″.", { c: loc(String(cell)) });
  else if (set) {
    const mx = Math.max(0, ...set.shift.map((s) => Math.hypot(s[0], s[1]))) * cell, nst = Math.max(0, ...set.reg.slice(1).map((r) => r.n || 0));
    note = L("fz.note.smooth", "Picture: one brightness scale for every visit, sky level matched, drawn smooth") +
      (set.aligned ? L("fz.note.aligned", ", visits lined up on {n} field stars (moved by up to {s}″)", { n: nst, s: loc(mx.toFixed(2)) }) : "") +
      (set.disp && set.disp.targetPeak != null ? L("fz.note.target", ", brightness set by the faint target so that it shows") : "") +
      (set.disp && (set.disp.noisy || []).some(Boolean) ? L("fz.note.noisy", ", the faint speckle of the noisier visit cut a little more") : "") +
      L("fz.note.tail", ". One SPHEREx pixel is 6.15″. The measured numbers are not changed by this.");
  }
  const html = (say ? `<span>${say}</span>` : "") + (note ? `<small class="fz-note">${esc(note)}</small>` : "");
  if (el.innerHTML !== html) el.innerHTML = html;
  el.hidden = !html;
}
/** Tabs, and which controls belong to the view on screen. */
function viewUi() {
  const film = S.view === "film";
  if (S.tabs) {
    S.tabs.set(S.view);
    S.tabs.el.querySelectorAll("button").forEach((b) => { b.disabled = !viewOk(b.dataset.view); });
  }
  const md = $("modes"); if (md) md.hidden = !film;
  const mh = $("modeHint"); if (mh) mh.hidden = !film;
  $("swipeUi").hidden = !(film && S.mode === "swipe");
  $("stage").dataset.view = S.view;
  // the processed difference is a tab on the picture: the old block below is shown only while that is not available
  const on = fvOn(), old = $("tsDiff") || document.querySelector(".card.diff");
  if (old) old.hidden = on;
  const pb = $("fzPlay"); if (pb) pb.hidden = !(S.poster && !film);
  viewSay();
}
function setView(v, quiet) {
  if (!viewOk(v)) v = "film";
  if (S.game && v !== "film") endGame();
  const was = S.view;
  S.view = v;
  if (v === "film" && S.poster) { S.poster = false; }
  viewUi(); show(); restart(); layout();
  if (!quiet) writeUrl();
  if (was !== v) { try { document.dispatchEvent(new CustomEvent("fazari:view", { detail: { view: v, raw: !!(S.fv && S.fv.raw) } })); } catch (_) {} }
}
function show() {
  if (!S.bin) return;
  const f = S.bin.frames[S.idx];
  setSrc($("frame"), S.base + f.file);
  const fs = selFrames(), pr = pairIdx() || [S.sel[0], S.sel[S.sel.length - 1]];
  const A = S.bin.frames[pr[0]], B = S.bin.frames[pr[1]];
  if (S.mode === "swipe") setSrc($("frameB"), S.base + B.file);
  paintStage();
  caption();
  $("date").textContent = S.mode === "trail" ? L("vw.dateTrail", "Trail of {n} seasons (brightest value of each pixel)", { n: fs.length })
    : L("vw.dateSeason", "Season {ep} · mean date {date}", { ep: f.epoch, date: f.date });
  $("detail").textContent = L("vw.detail", "SPHEREx {det} · {um} µm · {n} images stacked", { det: (f.detectors || []).join("+"), um: fx(f.wavelength_um), n: f.n_images });
  document.querySelectorAll("#seasons .chip").forEach((c) => c.classList.toggle("cur", +c.dataset.i === S.idx && S.mode !== "trail"));
  drawOverlay();
  // the object's own core saturated in this frame? (flags_view.js shows its "core saturated" line only then)
  try { document.body.dataset.objSat = satHere(S.meta.measured || {}, S.bin, [f.epoch]) ? "1" : ""; } catch (_) {}
  try { document.dispatchEvent(new CustomEvent("fazari:frame", { detail: { epoch: f.epoch, bin_um: S.bin.wavelength_um, file: f.file, mode: S.mode } })); } catch (_) {}
  S.listeners.forEach((fn) => { try { fn(f); } catch (_) {} });
}
function tick() {
  const k = S.sel.indexOf(S.idx);
  S.idx = S.sel[(k + 1) % S.sel.length];
  show();
}
function restart() {
  clearInterval(S.timer);
  S.timer = 0;
  const run = S.view === "film" && S.mode === "blink" && S.playing && S.sel.length > 1;
  if (run) S.timer = setInterval(tick, +$("speed").value);
  $("play").textContent = run ? L("vw.pause", "Pause") : L("vw.play", "Play");
  $("play").setAttribute("aria-pressed", String(!run));
}
function step(d) {
  if (S.view !== "film") setView("film", true);
  if (S.mode === "swipe" || S.mode === "trail") setMode("step");
  if (S.mode === "blink") S.playing = false;
  const k = S.sel.indexOf(S.idx);
  S.idx = S.sel[((k < 0 ? 0 : k) + d + S.sel.length) % S.sel.length];
  show(); restart();
}
function setMode(md, quiet) {
  if (!["blink", "step", "swipe", "trail"].includes(md)) md = "blink";
  if (S.game && md !== "blink") endGame();
  S.mode = md;
  document.querySelectorAll("#modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === md)));
  $("stage").dataset.mode = md;
  $("swipeUi").hidden = md !== "swipe" || S.view !== "film";
  $("play").disabled = false;
  if (md === "swipe") S.idx = (pairIdx() || S.sel)[0];
  if (md === "trail") { S.idx = S.sel[S.sel.length - 1]; if (!fvOn()) buildTrail(); }
  if (md === "blink" && !quiet) S.playing = true;
  if (md === "swipe") applySwipe();
  $("modeHint").textContent = L("vw.hint." + md, {
    blink: "Blink: the compared seasons, one after the other.",
    step: "Step: one season at a time (← → keys).",
    swipe: "Swipe: drag the slider to compare the two seasons of the pair.",
    trail: "Trail: the brightest value of each pixel over the seasons; a mover leaves a streak.",
  }[md]);
  show(); restart(); zoomUi();
  if (!quiet) writeUrl();
}
function applySwipe() {
  const st = $("stage"), v = +$("swipe").value / 100, Sw = st.clientWidth, W = pngSize()[0];
  const xs = Sw * v, xp = (xs - S.tx) / (S.k || 1);
  $("frameB").style.clipPath = `inset(0 0 0 ${Math.max(0, Math.min(W, xp)).toFixed(1)}px)`;
  $("swipeLine").style.left = xs.toFixed(1) + "px";
  if (fvOn() && S.view === "film" && S.mode === "swipe") paintStage();
}
function loadImg(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("load " + url)); im.src = url; });
}
async function buildTrail() {
  const key = S.bi + "|" + S.sel.join(",");
  if (S.trailKey === key) return;
  S.trailKey = key;
  const cv = $("trail");
  try {
    const imgs = await Promise.all(selFrames().map((f) => loadImg(S.base + f.file)));
    if (S.trailKey !== key) return;
    const W = imgs[0].naturalWidth, H = imgs[0].naturalHeight;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    let acc = null;
    for (const im of imgs) {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(im, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      if (!acc) acc = d; else for (let i = 0; i < d.length; i++) if (d[i] > acc[i]) acc[i] = d[i];
    }
    ctx.putImageData(new ImageData(acc, W, H), 0, 0);
  } catch (e) { console.warn("trail", e); S.trailKey = null; }
}

function renderSeasons() {
  const fr = S.bin.frames;
  let h = "";
  fr.forEach((f, i) => {
    if (i) h += `<span class="gap" aria-hidden="true">${esc(L("vw.days", "{n} days", { n: daysApart(fr[i - 1], f) }))}</span>`;
    const on = S.sel.includes(i), r = roleOf(i);
    h += `<button type="button" class="chip${on ? " on" : ""}${r ? " " + r : ""}" data-i="${i}" data-ep="${esc(f.epoch)}" aria-pressed="${on}" style="--fz-c:${visitCol(f.epoch)}" ` +
      `title="${esc(on ? L("vw.chip.remove", "Remove from the comparison ({n} images, mean date {date})", { n: f.n_images, date: f.date })
        : L("vw.chip.add", "Add to the comparison ({n} images, mean date {date})", { n: f.n_images, date: f.date }))}">` +
      `<b><i class="fz-dot" style="background:${visitCol(f.epoch)}"></i>${esc(season(f.epoch))}</b><small>${esc(L("vw.chip.img", "{n} img", { n: f.n_images }))}</small></button>`;
  });
  $("seasons").innerHTML = h;
  $("seasons").querySelectorAll(".chip").forEach((c) => { c.onclick = () => toggleSeason(+c.dataset.i); });
  const all = S.sel.length === fr.length, hi = headIdx();
  $("allSeasons").hidden = fr.length < 3;
  $("allSeasons").textContent = all ? (hi ? L("vw.all.head", "Headline pair only") : L("vw.all.firstLast", "First and last only")) : L("vw.all.all", "All seasons");
  const pr = pairIdx();
  let line = esc(L("vw.cmp.one", "One season selected: add another to compare."));
  if (pr) {
    const A = fr[pr[0]], B = fr[pr[1]], ms = S.meta.measured || {};
    const isHead = !!(hi && hi[0] === pr[0] && hi[1] === pr[1]);
    let what = "";
    if (ok(ms.shift_arcsec)) {
      const v = motionPair(A.epoch, B.epoch);
      what = isHead ? L("vw.cmp.headSame", "headline pair, same spacecraft orientation") : v && v.same === false ? L("vw.cmp.diffOrient", "different spacecraft orientation")
        : v && v.same ? L("vw.cmp.sameOrient", "same spacecraft orientation") : "";
    } else if (ms.photometry && isHead) what = L("vw.cmp.strongest", "strongest brightness change");
    else if (pr[0] === 0 && pr[1] === fr.length - 1 && fr.length > 2) what = L("vw.cmp.distant", "most distant seasons");
    line = `<b class="before" style="color:${visitCol(A.epoch)}">${esc(season(A.epoch))}</b> ↔ <b class="after" style="color:${visitCol(B.epoch)}">${esc(season(B.epoch))}</b>: ` +
      `<b>${esc(L("vw.cmp.apart", "{n} days apart", { n: daysApart(A, B) }))}</b>${what ? ` (${what})` : ""}`;
    if (S.sel.length > 2) line = esc(L("vw.cmp.many", "{n} seasons in the blink; {what}: ", { n: S.sel.length, what: ok(ms.shift_arcsec) ? L("vw.cmp.arrowResult", "arrow and result") : L("vw.cmp.result", "result") })) + line;
  }
  $("compareLine").innerHTML = line;
  fairBadge();
}
function toggleSeason(i) {
  const s = new Set(S.sel);
  if (s.has(i)) { if (s.size > 1) s.delete(i); } else s.add(i);
  S.sel = [...s].sort((a, b) => a - b);
  if (!S.sel.includes(S.idx)) S.idx = S.sel[0];
  afterSelection();
}
function afterSelection() {
  renderSeasons();
  if (S.mode === "trail") { if (!fvOn()) buildTrail(); S.idx = S.sel[S.sel.length - 1]; }
  if (S.mode === "swipe") S.idx = (pairIdx() || S.sel)[0];
  renderResult(); pairDiff(); watchHint();
  if (!viewOk(S.view)) S.view = "film";
  viewUi();
  show(); restart(); writeUrl();
}
function fairBadge() {
  const pr = pairIdx(), el = $("fairBadge");
  const fs = pr ? pr.map((i) => S.bin.frames[i]) : [];
  if (fs.length < 2) { el.hidden = true; return; }
  const dets = [...new Set(fs.flatMap((f) => f.detectors || []))];
  const lam = fs.map((f) => +f.wavelength_um).filter(ok);
  const lo = Math.min(...lam), hi = Math.max(...lam);
  const spread = (hi - lo) / S.bin.wavelength_um;
  const fair = dets.length === 1 && spread <= 0.06;
  el.hidden = false;
  el.className = "badge " + (fair ? "fair" : "warn");
  el.innerHTML = fair
    ? `<span aria-hidden="true">✓</span> ${esc(L("vw.fair.yes", "Fair comparison: same detector {det}, same colour {lo}–{hi} µm", { det: dets[0], lo: loc(lo.toFixed(2)), hi: loc(hi.toFixed(2)) }))}`
    : `<span aria-hidden="true">!</span> ${esc(L("vw.fair.no", "Not like for like:"))} ${dets.length > 1 ? esc(L("vw.fair.dets", "detectors {d}", { d: dets.join(", ") })) : ""}${dets.length > 1 && spread > 0.06 ? "; " : ""}${spread > 0.06 ? esc(L("vw.fair.cols", "colours {lo}–{hi} µm", { lo: loc(lo.toFixed(2)), hi: loc(hi.toFixed(2)) })) : ""}`;
  el.title = L("vw.fair.tip", "SPHEREx sees every point in a slightly different colour each time. Frames are compared only within one detector and one narrow wavelength bin (±6 %), so a still star looks the same in every season.");
}

// --- wavelength bins -----------------------------------------------------------------------------
async function gifUrl(bin) {
  if (!bin.gif) return null;
  const url = S.base + bin.gif;
  if (!S.gif.has(url)) S.gif.set(url, fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false));
  return (await S.gif.get(url)) ? url : null;
}
function selectBin(i, sel, ep) {
  S.bi = i; S.bin = S.bins[i];
  const n = S.bin.frames.length;
  S.sel = sel && sel.length ? sel : defaultSel();
  const keepIdx = ep ? S.bin.frames.findIndex((f) => f.epoch === ep) : -1;     // swapData: the visit on screen stays
  S.idx = keepIdx >= 0 && S.sel.includes(keepIdx) ? keepIdx : S.sel[0];
  S.trailKey = null;
  S.bin.frames.forEach((f) => { const im = new Image(); im.src = S.base + f.file; });   // smooth blinking
  loadFrames(); loadStars();
  if (S.bin.diff) setSrc($("diff"), S.base + S.bin.diff);
  const g = $("saveGif");
  g.hidden = true;
  gifUrl(S.bin).then((u) => {
    if (!u || S.bin !== S.bins[i]) return;
    g.href = u;
    g.download = `fazari_${(targetIdOf(S.base) || String(S.meta.target || "result").replace(/\W+/g, "_")).toLowerCase()}_${S.bin.wavelength_um.toFixed(1)}um.gif`;
    g.hidden = false;
  });
  renderSeasons();
  renderResult();
  pairDiff();
  watchHint();
  if (!viewOk(S.view) && !(S.fv && !S.fv.failed && S.view !== "film" && S.bin.frames.length > 1)) S.view = "film";   // a tab stays while its frames are prepared
  viewUi();
  setMode(S.mode, true);
  layout();
  writeUrl();
}

// --- difference image of the pair on screen ----------------------------------------------------------
// blink.py writes last-minus-first-season (diverging_rgb: RdBu_r, +-0.6 of the stretched range). For
// any other pair the same is computed here from the two frame PNGs (their grey = the stretched value).
const RDBU_R = ["#053061", "#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b", "#67001f"]
  .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
let diffToken = 0;
async function pairDiff() {
  if (!S.bin) return;
  const fr = S.bin.frames, pr = pairIdx() || [0, fr.length - 1];
  const A = fr[pr[0]], B = fr[pr[1]];
  const own = pr[0] === 0 && pr[1] === fr.length - 1;          // the pipeline's own difference image
  const ms = S.meta.measured || {};
  const sat = satHere(ms, S.bin, [A.epoch, B.epoch]);
  // colour key on one line (the seasons are in the caption below)
  const key = (cls, txt, tip) => `<span class="k"${tip ? ` title="${esc(tip)}"` : ""}><i class="sw ${cls}"></i>${esc(txt)}</span>`;
  $("diffKey").innerHTML = key("blue", L("u3.diff.blue", "brighter before"), L("vw.diff.brighterIn", "brighter in {s}", { s: season(A.epoch) })) +
    key("white", L("u3.diff.white", "no change")) +
    key("red", L("u3.diff.red", "brighter after"), L("vw.diff.brighterIn", "brighter in {s}", { s: season(B.epoch) })) +
    (sat ? key("grey", L("u3.diff.grey", "saturated, not measured")) : "");
  diffSaturation(sat, A, B, ms);
  $("diffCap").textContent = L("vw.diff.cap", "{b} minus {a} at {um} µm", { b: season(B.epoch), a: season(A.epoch), um: loc(S.bin.wavelength_um.toFixed(1)) }) +
    (own ? L("vw.diff.own", " (made by the pipeline). ") : L("vw.diff.browser", " (computed in your browser from these two frames, the same way as the pipeline). ")) +
    L("vw.diff.explain", "Stars that stay the same cancel out. A star that moved leaves blue where it was and red where it went; " +
    "a star that got brighter turns red, one that got fainter turns blue.");
  const cv = $("diffPair"), my = ++diffToken;
  if (own) { cv.hidden = true; return; }
  try {
    const [ia, ib] = await Promise.all([loadImg(S.base + A.file), loadImg(S.base + B.file)]);
    if (my !== diffToken) return;
    const W = ia.naturalWidth, H = ia.naturalHeight;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, W, H).data;
    ctx.drawImage(ib, 0, 0); const out = ctx.getImageData(0, 0, W, H), db = out.data;
    for (let i = 0; i < db.length; i += 4) {
      const v = Math.min(1, Math.max(0, ((db[i] - da[i]) / 255 / 0.6 + 1) / 2)) * 10;
      const k = Math.min(9, Math.floor(v)), t = v - k, c0 = RDBU_R[k], c1 = RDBU_R[k + 1];
      db[i] = c0[0] + (c1[0] - c0[0]) * t; db[i + 1] = c0[1] + (c1[1] - c0[1]) * t; db[i + 2] = c0[2] + (c1[2] - c0[2]) * t; db[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    cv.hidden = false;
  } catch (e) { console.warn("pair difference", e); cv.hidden = true; }
}

// A saturated star at the centre: its white core is masked (not data) and the coloured ring around it is
// only its outer glow differing between seasons. Draw the core as grey "saturated, not measured" and grey
// the ring too, unless the measurement found real motion or a real brightness change (then the ring is
// that signal: Barnard's Star shows a red/blue pair). Other stars in the frame are not touched.
const satRadiusCache = new Map();
function satRadius(fa, fb, xy, diffUrl) {
  const key = `${S.base}|${fa.file}|${fb.file}|${xy.map((v) => Math.round(v)).join(",")}|${diffUrl || ""}`;
  if (!satRadiusCache.has(key)) satRadiusCache.set(key, (async () => {
    const ims = await Promise.all([loadImg(S.base + fa.file), loadImg(S.base + fb.file)]);
    const R = 140, cv = document.createElement("canvas");
    cv.width = cv.height = 2 * R;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    let r0 = 0;
    const px = [];
    for (const im of ims) {                                  // radius of the white core (mean of each 1-px annulus >= 245)
      cx.clearRect(0, 0, 2 * R, 2 * R);
      cx.drawImage(im, xy[0] - R, xy[1] - R, 2 * R, 2 * R, 0, 0, 2 * R, 2 * R);
      const d = cx.getImageData(0, 0, 2 * R, 2 * R).data, sum = new Float64Array(R), n = new Float64Array(R);
      px.push(d);
      for (let y = 0; y < 2 * R; y++) for (let x = 0; x < 2 * R; x++) {
        const r = Math.floor(Math.hypot(x - R + 0.5, y - R + 0.5));
        if (r < R && d[4 * (y * 2 * R + x) + 3]) { sum[r] += d[4 * (y * 2 * R + x)]; n[r]++; }
      }
      let r = 0;
      while (r < R && n[r] && sum[r] / n[r] >= 245) r++;
      r0 = Math.max(r0, r);
    }
    if (r0 < 3) return null;
    // outer edge of the ring: where the mean |difference| of the 1-px annuli falls back near the background
    const dev = new Float64Array(R), nd = new Float64Array(R), [da, db] = px;
    for (let y = 0; y < 2 * R; y++) for (let x = 0; x < 2 * R; x++) {
      const r = Math.floor(Math.hypot(x - R + 0.5, y - R + 0.5)), i = 4 * (y * 2 * R + x);
      if (r < R && da[i + 3] && db[i + 3]) { dev[r] += Math.abs(db[i] - da[i]); nd[r]++; }
    }
    const m = (r) => (nd[r] ? dev[r] / nd[r] : 0);
    const bg = [...Array(20).keys()].map((k) => m(R - 1 - k)).sort((a, b) => a - b)[10] || 0;
    let peak = r0, pv = 0;
    for (let r = r0; r < Math.min(R, r0 * 4 + 40); r++) if (m(r) > pv) { pv = m(r); peak = r; }
    const thr = bg + Math.max(3, 0.2 * (pv - bg));
    let r1 = peak, rc = 0;
    while (r1 < R - 1 && m(r1) > thr) r1++;
    while (rc < peak && m(rc) <= thr) rc++;               // the masked core: no difference until the ring starts
    let core = Math.max(r0, rc - 1);
    if (diffUrl) {                                         // the pipeline's own difference: its masked core is a white disc
      try {
        const di = await loadImg(diffUrl);
        cx.clearRect(0, 0, 2 * R, 2 * R);
        cx.drawImage(di, xy[0] - R, xy[1] - R, 2 * R, 2 * R, 0, 0, 2 * R, 2 * R);
        const d = cx.getImageData(0, 0, 2 * R, 2 * R).data, wh = new Float64Array(R), nw = new Float64Array(R);
        for (let y = 0; y < 2 * R; y++) for (let x = 0; x < 2 * R; x++) {
          const r = Math.floor(Math.hypot(x - R + 0.5, y - R + 0.5)), i = 4 * (y * 2 * R + x);
          if (r < R && d[i + 3]) { nw[r]++; if (d[i] > 238 && d[i + 1] > 238 && d[i + 2] > 238) wh[r]++; }
        }
        let rw = 0;
        while (rw < R && nw[rw] && wh[rw] / nw[rw] >= 0.5) rw++;
        core = Math.max(core, rw);
      } catch (_) { /* keep the frame estimate */ }
    }
    return { r0: core, r1: Math.max(r1 + 5, Math.round(core * 1.5)) };
  })().catch(() => null));
  return satRadiusCache.get(key);
}
let satToken = 0;
async function diffSaturation(sat, A, B, ms) {
  const my = ++satToken;
  let ov = $("diffSatOv"), note = $("diffSat");
  if (!ov) {
    $("diffZoom").insertAdjacentHTML("beforeend", `<svg id="diffSatOv" aria-hidden="true" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible"></svg>`);
    ov = $("diffSatOv");
  }
  if (!note) {
    $("diffKey").insertAdjacentHTML("afterend", `<p id="diffSat" class="diffsat" hidden></p>`);
    note = $("diffSat");
  }
  ov.innerHTML = ""; note.hidden = true;
  const onTab = () => { if (S.view === "diff") { drawOverlay(); viewSay(); } };       // the same marking on the Difference tab
  S.satMark = null;
  if (!sat) { onTab(); return; }
  const xy = (measuredPos(B.epoch) || measuredPos(A.epoch) || {}).png_xy_measured || markerXY(B.epoch) || markerXY(A.epoch) || centreXY();
  const fr = S.bin.frames, own = A === fr[0] && B === fr[fr.length - 1];
  const rr = await satRadius(A, B, xy, own && S.bin.diff ? S.base + S.bin.diff : null);
  if (my !== satToken) return;
  const moved = ok(ms.shift_arcsec) && ok(ms.shift_err_arcsec) && +ms.shift_arcsec > Math.max(1, 3 * ms.shift_err_arcsec);
  const varies = !!(ms.photometry && (bestChange(ms.photometry) || {}).main);
  const real = moved || varies;
  note.hidden = false;
  note.textContent = real
    ? (moved ? L("u3.diff.satMove", "The star in the middle is saturated here: its core (grey) is not measured. The red and blue pair around it is its motion, measured from the wings.")
      : L("u3.diff.satVar", "The star in the middle is saturated here: its core (grey) is not measured. The colour around it is its brightness change, measured in a ring around the core."))
    : L("u3.diff.satRing", "The star in the middle is saturated here: its core is not measured, and the ring around it is only its outer glow differing between the seasons, not a real change. Both are greyed.");
  S.satMark = { text: note.textContent, html: "" };
  if (!rr) { onTab(); return; }
  const [W, H] = pngSize(), [x, y] = xy, { r0, r1 } = rr;
  ov.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const mark = (id) => `<defs><pattern id="${id}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="7" height="7" fill="#4a5163"/><path d="M0 0V7" stroke="#7d8698" stroke-width="2.6"/></pattern></defs>` +
    (real ? "" : `<circle cx="${x}" cy="${y}" r="${r1}" fill="#5f6678" fill-opacity=".96" stroke="#05070d" stroke-opacity=".5" stroke-width="1"/>`) +
    `<circle cx="${x}" cy="${y}" r="${r0 + 1}" fill="url(#${id})" stroke="#dfe5f2" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  ov.innerHTML = mark("satHatch");
  S.satMark.html = mark("satHatchTab");
  onTab();
}

// --- URL -----------------------------------------------------------------------------------------
function writeUrl() {
  if (!S.bin) return;
  const p = new URLSearchParams(location.search);
  ["t", "target", "bin"].forEach((k) => p.delete(k));
  p.set("data", S.base);
  p.set("um", S.bin.wavelength_um.toFixed(1));
  if (S.mode !== "blink") p.set("mode", S.mode); else p.delete("mode");
  const n = S.bin.frames.length, ds = defaultSel();
  const dflt = n > 1 ? S.sel.length === ds.length && S.sel.every((v, k) => v === ds[k]) : true;
  if (dflt) p.delete("s"); else p.set("s", selFrames().map((f) => f.epoch).join(","));
  // the visitor's own zoom and picture point (the default close-up needs neither), the view tab, raw pixels
  if (S.user && S.zoom > 0) p.set("z", String(+S.zoom.toFixed(2))); else p.delete("z");
  if (S.user && S.cx != null) p.set("c", `${Math.round(S.cx)},${Math.round(S.cy)}`); else p.delete("c");
  if (S.view !== "film" && !S.poster) p.set("view", S.view); else p.delete("view");
  if (S.fv && S.fv.raw) p.set("raw", "1"); else p.delete("raw");
  const q = p.toString().replace(/%2F/gi, "/").replace(/%2C/gi, ",");
  try { history.replaceState(null, "", location.pathname + "?" + q + location.hash); } catch (_) {}
}

// --- result card -----------------------------------------------------------------------------------
function bestChange(ph) {
  if (S.ex.brightnessChange) { try { return S.ex.brightnessChange(ph); } catch (_) {} }
  const c = [];
  (ph.bins || []).forEach((b) => (b.seasons || []).slice(1).forEach((s) => {
    if (ok(s.ratio_to_first) && s.ratio_err > 0) c.push({ b, ref: b.seasons[0].epoch, to: s.epoch, r: +s.ratio_to_first, er: +s.ratio_err, z: Math.abs(s.ratio_to_first - 1) / s.ratio_err });
  }));
  const sig = c.filter((x) => x.z >= 3 && Math.abs(x.r - 1) >= 0.1).sort((a, b) => b.z - a.z);
  return sig.length ? { main: sig[0], from: sig[0].ref, to: sig[0].to } : c.length ? { flat: true } : null;
}
// a tile without a value ("–") is marked .empty (the UI layer hides it)
const tile = (k, b, small, cls = "") => `<div class="tile ${cls}${b === "–" ? " empty" : ""}"><span class="k">${k}</span><b>${b}</b><small>${small}</small></div>`;
/** The result's name: a challenge/catalogue name (Turkish from tr.json), or "Sky field RA … Dec …" in the page language. */
function targetName(m) {
  const tg = m && m.target;
  if (!tg || /^(none|null)$/i.test(tg)) return L("vw.skyField", "Sky field");
  const f = /^Sky field RA ([\d.]+) Dec ([+\-−]?[\d.]+)$/.exec(String(tg).trim());
  if (f) return L("u3.vw.skyAt", "Sky field RA {ra}° Dec {dec}°", { ra: loc(f[1]), dec: loc(f[2]) });
  return tname(tg);
}
/** Saturation of the object this result is about: { bins: [µm], where: "target"|"point"|"snap", sep } or null.
 *  Only cells where we measured that object (detected) count; a free point counts only when the measured
 *  position is at the picked point (within 6″) or when the measurement moved to a named nearby source (snap). */
function satOfObject(ms) {
  const bins = new Set();
  ((ms.detection || {}).bins || []).forEach((c) => { if (c.detected && c.saturated_frac > 0.5) bins.add(c.wavelength_um); });
  ((ms.photometry || {}).bins || []).forEach((b) => { if (b.saturated) bins.add(b.wavelength_um); });
  if (!bins.size || ms.status === "not_detected") return null;
  const list = [...bins].sort((a, b) => a - b);
  if (ms.snap && ms.snap.source) return { bins: list, where: "snap", sep: ms.snap.sep_arcsec };
  if (!S.ref.none) return { bins: list, where: "target" };
  // a picked sky position: the measured position must be the picked point itself
  const off = (ms.positions || []).map((p) => (p.png_xy_measured && p.png_xy_gaia && pngArcsec()
    ? Math.hypot(p.png_xy_measured[0] - p.png_xy_gaia[0], p.png_xy_measured[1] - p.png_xy_gaia[1]) * pngArcsec() : null)).filter((v) => v != null);
  if (!off.length) return null;
  const med = off.sort((a, b) => a - b)[off.length >> 1];
  return med <= 6 ? { bins: list, where: "point" } : null;
}
/** Is the measured object saturated in this bin and season pair? (difference panel) */
function satHere(ms, bin, eps) {
  const o = satOfObject(ms);
  if (!o || !bin || !o.bins.some((u) => Math.abs(u - bin.wavelength_um) < 0.05)) return false;
  const cells = ((ms.detection || {}).bins || []).filter((c) => Math.abs(c.wavelength_um - bin.wavelength_um) < 0.05);
  if (!cells.length) return true;                                       // photometry flag only
  return cells.some((c) => c.saturated_frac > 0.5 && (!eps || eps.includes(c.epoch)));
}
// --- grafikler: number line, shift line, ratio chart, limit line (js/gr.js) under the result tiles ---------
let grCatState = { base: null, val: undefined };
/** The catalogued star at a free point (Gaia DR3, else SIMBAD), or null; asks once per result and repaints. */
function grCat(m) {
  if (grCatState.base !== S.base) {
    const my = grCatState = { base: S.base, val: undefined };
    GR.catalogueAt(m, S.base).then((c) => { my.val = c || null; if (c && S.meta === m && grCatState === my) renderResult(); });
  }
  return grCatState.val || null;
}
let grToken = 0;
/** The catalogue's name for people: "SIMBAD" rather than a file path in the label. */
function grRefName(m) {
  const R = S.ref, ref = String(((m && m.gaia) || {}).reference || "");
  if (/[\/]|\.json/.test(R.label)) return /simbad/i.test(ref) ? "SIMBAD" : R.Short;
  return R.label;
}
function grPaint(g, m, ms) {
  GR.ensureStyle();
  let box = $("grBox");
  if (!box) { $("tiles").insertAdjacentHTML("afterend", `<div id="grBox" class="gr-box" hidden></div>`); box = $("grBox"); }
  const my = ++grToken;
  let html = "";
  if (g && g.speed) {
    html += GR.numberLine({ v: g.speed.v, e: g.speed.e, p: g.ref ? g.ref.v : null, refLabel: g.ref ? g.ref.label : "",
      unit: L("gr.unit", "arcseconds per year (″/yr)") });
    const sh = g.shift;
    if (sh && ok(sh.s) && sh.pair) {
      html += `<p class="gr-line gr-det">` + L("gr.shift", "Shift you see in the blink, {pair}{dt}: <b>{s}</b>{e}{p}. It is not exactly speed × time: Earth's yearly orbit adds a small wobble (parallax).", {
        pair: `${esc(season(sh.pair[0]))} → ${esc(season(sh.pair[1]))}`, dt: ok(sh.dt) ? ` (${loc((+sh.dt).toFixed(2))} ${L("gr.yr", "yr")})` : "",
        s: arcsec(sh.s, sh.e), e: ok(sh.e) ? ` ± ${arcsec(sh.e, sh.e)}` : "",
        p: ok(sh.p) ? L("gr.shiftPred", " ({who}: {p})", { who: esc(grRefName(m)), p: arcsec(sh.p, sh.e) }) : "" }) + `</p>`;
    }
  }
  box.innerHTML = html;
  box.hidden = !html;
  // the ratio chart sits under the blink (after the "how to read" strip), not in the answer card: the blink stays
  // the first thing on screen
  let rbox = $("grRatio");
  const rc = g && g.ratio ? GR.ratioChart(g.ratio, m.epochs, (ep) => season(ep)) : "";
  if (!rbox && rc) { $("explainStrip").insertAdjacentHTML("afterend", `<section id="grRatio" class="gr-box gr-ratio" hidden></section>`); rbox = $("grRatio"); }
  if (rbox) { rbox.innerHTML = rc; rbox.hidden = !rc; }
  if (g && g.empty) {                                       // nothing measured at a free point: the honest limit, from this run's data
    GR.candidates(S.base).then((doc) => {
      if (my !== grToken) return;
      let lim = GR.limitFromSensitivity(doc && doc.sensitivity), how = "";
      if (!lim) {
        const cells = ((ms.field_calibration || {}).cells || []).filter((c) => Array.isArray(c.star_rms_arcsec));
        const rms = cells.map((c) => (c.star_rms_arcsec[0] + c.star_rms_arcsec[1]) / 2).sort((a, b) => a - b)[cells.length >> 1];
        const eps = (m.epochs || []).map((e) => /^(\d{4})-(\d{2})/.exec(e)).filter(Boolean).map((x) => +x[1] + (+x[2] - 1) / 12);
        const v = eps.length > 1 ? GR.limitFromField(rms, eps[eps.length - 1] - eps[0]) : null;
        if (v) { lim = { v }; how = L("gr.lim.tipField", "Three times the scatter of single field-star positions ({r}″, √2 for two seasons), divided by the time between the first and last season. A season averages many images, so the real limit is lower: this is a safe upper value.", { r: loc(rms.toFixed(2)) }); }
      }
      const found = !!(doc && doc.summary && doc.summary.n_moving > 0);
      const line = GR.limitHtml(lim, how, found);
      if (line) { box.insertAdjacentHTML("beforeend", line); box.hidden = false; }
    });
  }
}

function renderResult() {
  const m = S.meta, ms = m.measured || {}, pv = m.preview, R = S.ref;
  const nImg = pv ? pv.n_images : ok(m.n_cutouts) ? m.n_cutouts : S.bins.reduce((a, b) => a + b.frames.reduce((s, f) => s + (f.n_images || 0), 0), 0);
  const eps = m.epochs || [];
  const tImg = tile(esc(L("vw.t.images", "SPHEREx images")), String(nImg), esc(S.bins.length === 1 ? L("vw.t.bins.one", "{n} wavelength bin", { n: 1 }) : L("vw.t.bins.other", "{n} wavelength bins", { n: S.bins.length })) + (pv ? esc(L("vw.t.previewSfx", " (preview)")) : ""));
  const tSea = tile(esc(L("vw.t.seasons", "Seasons")), String(eps.length), eps.length ? `${esc(season(eps[0]))} – ${esc(season(eps[eps.length - 1]))}` : "");
  // the card describes the pair on screen (the arrow's pair); without one (a single season), the headline
  const pe = (S.bin && pairEpochs()) || headEpochs() || null;
  const pairTxt = pe ? `${esc(season(pe[0]))} → ${esc(season(pe[1]))}` : "";
  const back = `<button type="button" class="linkbtn" data-headline>${esc(L("vw.r.showHead", "Show the headline pair"))}</button>`;
  let tMeas, tRef, verdict = "", note = "", mainNote = false, grc = null;
  const tMeasured = esc(L("vw.t.measured", "Measured by us")), tPredicts = esc(L("vw.t.predicts", "{who} predicts", { who: R.Short }));
  const headTxt = () => L("vw.r.headlineIs", "Headline: {v} ({a} → {b}).", { v: arcsec(ms.shift_arcsec, ms.shift_err_arcsec), a: esc(season(ms.from_epoch)), b: esc(season(ms.to_epoch)) });
  if (ok(ms.shift_arcsec)) {
    const v = pe ? motionPair(pe[0], pe[1]) : null;
    if (!v) {
      tMeas = tile(tMeasured, "–", L("vw.t.notMeasured", "not measured between {pair}", { pair: pairTxt }), "hero");
      tRef = tile(tPredicts, "–", "", "ref");
      verdict = esc(L("vw.r.notBoth", "The target was not measured in both of these seasons."));
      note = `<b>${pairTxt}</b>. ${headTxt()} ${back}`;
    } else {
      const s = v.s, e = v.e, p = v.p;
      tMeas = tile(tMeasured, arcsec(s, e), `${e != null ? `± ${arcsec(e, e)}` : ""}<span class="x">${e != null ? " · " : ""}${pairTxt}</span>`, "hero");
      if (R.none || p == null) {
        tRef = tile(esc(L("vw.t.compared", "Compared with")), "–", esc(R.none ? L("vw.t.nothingPicked", "nothing: a picked sky position has no catalogue motion") : L("vw.t.noPred", "no prediction for this result")));
        verdict = esc(L("vw.r.measuredFrom", "Measured by us from SPHEREx images") + (R.none ? L("vw.r.noCatMotion", "; there is no catalogue motion to compare with") : "")) + ".";
      } else {
        const dirTxt = ok(v.ppa) ? L("vw.t.toward", "toward {dir}(PA {pa}°", { dir: S.ex.compass ? L("vw.dir." + S.ex.compass(v.ppa), S.ex.compass(v.ppa)) + " " : "", pa: fx(v.ppa, 0) }) +
          (ok(v.pa) ? L("vw.t.weDeg", "; we {pa}°)", { pa: fx(v.pa, 0) }) : ")") : "";
        tRef = tile(tPredicts, arcsec(p, e), dirTxt, "ref");
        const d = Math.abs(s - p), pct = p > 0 ? 100 * d / p : null;
        const agree = e != null ? (d <= 2 * e ? L("vw.r.within", ", within the error") : L("vw.r.times", ", {k} times the error", { k: loc((d / e).toFixed(1)) })) : "";
        verdict = L("vw.r.cmp", "<b>Measured by us from SPHEREx images</b>, compared with {ref}: {d} apart", { ref: esc(R.label), d: arcsec(d, e) }) +
          (pct != null ? ` (${pct < 1 ? loc(pct.toFixed(1)) : Math.round(pct)} %)` : "") + `${agree}.`;
      }
      const gc = (ms.snap || {}).gaia_compare;           // moved to a Gaia DR3 star: its proper motion against ours
      if (gc) {
        const pmS = (a) => (a >= 0 ? "+" : "−") + loc(Math.abs(a).toFixed(0));
        tRef = tile(esc(L("vw.t.compared", "Compared with")), `${loc(Math.hypot(gc.gaia_pmra_mas_yr, gc.gaia_pmdec_mas_yr).toFixed(0))} mas/yr`,
          esc(L("vw.t.gaiaPm", "Gaia DR3 {v} mas/yr; ours {a}, {b} ± {e}: {k}σ", { v: `${pmS(gc.gaia_pmra_mas_yr)}, ${pmS(gc.gaia_pmdec_mas_yr)}`,
            a: pmS(gc.pmra_mas_yr), b: pmS(gc.pmdec_mas_yr), e: loc(Math.max(gc.pmra_err_mas_yr, gc.pmdec_err_mas_yr).toFixed(0)), k: loc((+gc.sigma).toFixed(1)) })), "ref");
      }
      // grafikler: the speed per year (joint fit of every exposure) is the headline; the shift of the pair on screen
      // becomes a second line (it also holds the yearly parallax wobble, so it is not exactly speed x time)
      const sp = GR.speedFit(ms, R.none);
      grc = { shift: { s, e, p: R.none ? null : p, dt: v.dt, pair: pe }, speed: sp, ref: null };
      if (sp) {
        tMeas = tile(tMeasured, GR.rateTxt(sp.v, sp.e), `${sp.e != null ? `± ${GR.rateTxt(sp.e, sp.e)}` : ""}<span class="x"> · ${esc(L("gr.t.speed", "speed per year"))}</span>`, "hero");
        let ref = null;
        if (gc) ref = { v: Math.hypot(gc.gaia_pmra_mas_yr, gc.gaia_pmdec_mas_yr) / 1000, label: "Gaia DR3", head: esc(L("vw.t.compared", "Compared with")), sub: esc(L("gr.t.gcSub", "Gaia DR3: the star we measured")) };
        else if (!R.none && sp.p != null) {
          const dirTxt = ok(sp.ppa) ? L("vw.t.toward", "toward {dir}(PA {pa}°", { dir: S.ex.compass ? L("vw.dir." + S.ex.compass(sp.ppa), S.ex.compass(sp.ppa)) + " " : "", pa: fx(sp.ppa, 0) }) +
            L("vw.t.weDeg", "; we {pa}°)", { pa: fx(sp.pa, 0) }) : "";
          const rn = grRefName(m);
          ref = { v: sp.p, label: rn, head: rn === R.label ? tPredicts : esc(L("vw.t.predicts", "{who} predicts", { who: rn })), sub: dirTxt };
        } else if (R.none) {
          const c = grCat(m);                                // the catalogued star at a free point (async; repaints when known)
          if (c) ref = { v: c.v, label: c.src, head: esc(c.src === "SIMBAD" ? L("gr.t.simbad", "SIMBAD catalogue") : L("gr.t.gaia", "ESA Gaia DR3 catalogue")),
            sub: esc(L("gr.t.catSub", "the star at this point ({d}″ away)", { d: loc(c.sep.toFixed(1)) })) };
        }
        if (ref) {
          grc.ref = ref;
          tRef = tile(ref.head, GR.rateTxt(ref.v, sp.e), ref.sub, "ref");
          const d = Math.abs(sp.v - ref.v), pct = ref.v > 0.05 ? 100 * d / ref.v : null;
          const agree = sp.e != null ? (d <= 2 * sp.e ? L("vw.r.within", ", within the error") : L("vw.r.times", ", {k} times the error", { k: loc((d / sp.e).toFixed(1)) })) : "";
          verdict = L("vw.r.cmp", "<b>Measured by us from SPHEREx images</b>, compared with {ref}: {d} apart", { ref: esc(ref.label), d: GR.rateTxt(d, sp.e) }) +
            (pct != null ? ` (${pct < 1 ? loc(pct.toFixed(1)) : Math.round(pct)} %)` : "") + `${agree}.`;
        }
      }
      mainNote = !!v.headline;
      note = v.headline
        ? `<b>${pairTxt}</b>: ${esc(L("vw.r.isHead", "the headline pair (same spacecraft orientation, where detector offsets cancel)."))}`
        : `<b>${pairTxt}</b> (${esc(v.same === false ? L("vw.r.diffOrient", "different spacecraft orientation; headline uses same-orientation seasons")
            : v.same ? L("vw.r.sameNotHead", "same spacecraft orientation, but not the headline pair") : L("vw.r.notHead", "not the headline pair"))}` +
          `${v.fromPositions ? esc(L("vw.r.fromPos", "; from the per-season positions")) : ""}). ` +
          `${headTxt()} ${back}`;
    }
  } else if (ms.photometry) {
    const c = bestChange(ms.photometry);
    const v = pe && S.bin ? brightPair(pe[0], pe[1]) : null;
    const um = S.bin ? loc(S.bin.wavelength_um.toFixed(1)) : "";
    if (v && !v.none) {
      const pc = Math.round(100 * (v.r - 1)), pce = Math.max(1, Math.round(100 * v.er));
      tMeas = tile(esc(L("vw.t.bright", "Brightness change")), `${pc > 0 ? "+" : pc < 0 ? "−" : "±"}${Math.abs(pc)} %`, `± ${pce} %<span class="x"> · ${um} µm · ${pairTxt}</span>`, "hero");
      tRef = tile(esc(L("vw.t.compared", "Compared with")), String(v.n || "–"), esc(L("vw.t.starsSame", "stars in the same images")), "ref");
    } else {
      tMeas = tile(esc(L("vw.t.bright", "Brightness change")), "–", v ? esc(v.why) : esc(L("vw.t.selectTwo", "select two seasons")), "hero");
      tRef = tile(esc(L("vw.t.compared", "Compared with")), "–", esc(L("vw.t.starsSame", "stars in the same images")), "ref");
    }
    verdict = L("vw.r.brightVerdict", "<b>Measured by us from SPHEREx images</b>: the target's brightness relative to comparison stars in the same images.");
    grc = { ratio: ms.photometry };
    if (c && c.main) {
      const mpc = Math.round(100 * (c.main.r - 1));
      mainNote = !!(v && v.main);
      note = v && v.main ? `<b>${um} µm, ${pairTxt}</b>: ${esc(L("vw.r.strongestHere", "the strongest change in this result."))}`
        : `<b>${um} µm, ${pairTxt}</b>. ` + L("vw.r.strongest", "Strongest change: {c} % at {um} µm ({a} → {b}).", { c: `${mpc > 0 ? "+" : "−"}${Math.abs(mpc)}`, um: loc(c.main.b.wavelength_um.toFixed(1)), a: esc(season(c.from)), b: esc(season(c.to)) }) +
          ` <button type="button" class="linkbtn" data-headline>${esc(L("vw.r.showIt", "Show it"))}</button>`;
    }
  } else if (ms.preliminary && ok(ms.preliminary.shift_arcsec)) {
    const pre = ms.preliminary;
    tMeas = tile(esc(L("vw.t.rough", "Rough first look")), "≈" + arcsec(pre.shift_arcsec), L("vw.t.noErr", "{a} → {b}, no error bars", { a: esc(season(pre.from_epoch)), b: esc(season(pre.to_epoch)) }), "hero");
    tRef = tile(tPredicts, ok(pre.catalogue_shift_arcsec) ? arcsec(pre.catalogue_shift_arcsec) : "–", esc(L("vw.t.sameSeasons", "same seasons")), "ref");
    verdict = esc(L("vw.r.previewVerdict", "A quick preview from a few SPHEREx images, not a measurement. The full result follows."));
  } else {
    const st = ms.status || "";
    tMeas = tile(esc(L("vw.t.measuredPlain", "Measured")), "–", st === "not_detected" ? esc(L("vw.t.notDet", "not detected above the noise")) : st === "preview" ? esc(L("vw.t.fullFollows", "full result follows")) : esc(ptext(ms.message) || L("vw.t.noMeas", "no measurement")), "hero");
    tRef = tile(R.none ? esc(L("vw.t.compared", "Compared with")) : tPredicts, "–", esc(R.none ? L("vw.t.nothingPicked", "nothing: a picked sky position has no catalogue motion") : L("vw.t.noPred", "no prediction for this result")), "ref");
    verdict = pv ? "" : esc(ptext(ms.message || ""));       // a preview: the stage line says it once (no repeat here)
    if (!pv && st !== "preview" && R.none) grc = { empty: true };
  }
  $("tiles").innerHTML = tMeas + tRef + tImg + tSea;
  grPaint(grc, m, ms);
  $("verdict").innerHTML = verdict;
  const pn = $("pairNote");
  pn.hidden = !note;
  pn.className = "pairnote" + (note && !(mainNote || /headline pair \(same|strongest change in this/.test(note)) ? " alt" : "");
  pn.innerHTML = note;
  const hb = pn.querySelector("[data-headline]");
  if (hb) hb.onclick = goHeadline;
  // badge: saturated core, measured from the wings -- only when it is true for the object this result is
  // about (the target, the star at the picked point, or the nearby star the measurement moved to)
  const so = satOfObject(ms);
  const sb = $("satBadge");
  sb.hidden = !so;
  if (so) {
    const name = so.where === "target" ? targetName(m) : "";
    sb.innerHTML = esc(so.where === "snap" ? L("u3.sat.snap", "The star we measured ({d}″ from your point) is saturated: measured from its wings", { d: loc((+so.sep || 0).toFixed(0)) })
      : so.where === "point" ? L("u3.sat.point", "The star at your point is saturated: measured from its wings")
        : L("u3.sat.target", "{name}: core saturated, measured from the wings", { name }));
    sb.title = L("vw.sat.tip", "The star is so bright that its centre fills the detector pixels to the top (the white core) at {um} µm. ",
      { um: so.bins.map((v) => loc(v.toFixed(1))).join(lang() === "tr" ? "; " : ", ") }) +
      (ms.photometry ? L("vw.sat.phot", "Its brightness is measured in a ring around the core.") : L("vw.sat.pos", "Its position is fitted to the unsaturated outer glow (the wings) only."));
  }
}

/** Back to the headline pair (motion) or the strongest change (brightness), switching bins if needed. */
function goHeadline() {
  const ms = S.meta.measured || {};
  let k = S.bi;
  if (ms.photometry) {
    const c = bestChange(ms.photometry);
    const j = c && c.main ? S.bins.findIndex((b) => Math.abs(b.wavelength_um - c.main.b.wavelength_um) < 0.05) : -1;
    if (j >= 0) k = j;
  } else if (!headIdx(S.bins[k])) {
    const j = S.bins.findIndex((b) => headIdx(b));
    if (j >= 0) k = j;
  }
  const h = headIdx(S.bins[k]);
  if (!h) return;
  if (k !== S.bi) { $("wl").value = k; selectBin(k, h); return; }
  S.sel = h;
  if (!S.sel.includes(S.idx)) S.idx = S.sel[0];
  afterSelection();
}

function renderHeader() {
  const m = S.meta, ms = m.measured || {};
  const name = targetName(m);
  $("title").textContent = name;
  document.title = L("vw.docTitle", "{name} · Fazari SPHEREx blink", { name });
  const kind = ms.photometry ? "varies" : (ok(ms.shift_arcsec) || ms.preliminary) && !S.ref.none ? "moves" : S.info ? S.info.kind : null;
  const kb = $("kindBadge");
  kb.hidden = !kind;
  if (kind) { kb.textContent = L("vw.kind." + kind, KIND_TEXT[kind]); kb.className = "badge kind " + kind; kb.title = L("vw.kindTip." + kind, KIND_TIP[kind]); }
  const tg = $("tagList");
  tg.innerHTML = S.info ? `<span class="tag" title="${esc(L(`vw.tgt.${S.info.id}.why`, S.info.why))}">${esc(L(`vw.tgt.${S.info.id}.tag`, S.info.tag))}</span>` : "";
  $("why").textContent = S.info ? L(`vw.tgt.${S.info.id}.why`, S.info.why) : "";
  $("why").hidden = !S.info;
}

function buildTargets() {
  const cur = targetIdOf(S.base);
  const box = $("targets");
  box.innerHTML = "";
  TARGETS.forEach((t) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tgt" + (cur === t.id ? " on" : "");
    b.setAttribute("aria-current", cur === t.id ? "page" : "false");
    b.innerHTML = tgtHtml(t);
    b.title = L(`vw.tgt.${t.id}.why`, t.why);
    b.disabled = true;
    b.onclick = () => {
      const p = new URLSearchParams();
      p.set("data", `data/${t.id}/`);
      if (S.mode !== "blink") p.set("mode", S.mode);
      location.search = "?" + p.toString().replace(/%2F/gi, "/");
    };
    box.appendChild(b);
    fetch(`data/${t.id}/meta.json`, { method: "HEAD" })
      .then((r) => { if (r.ok) b.disabled = false; else { b.dataset.soon = "1"; b.title = L("vw.soon", "Coming soon"); } })
      .catch(() => { b.dataset.soon = "1"; b.title = L("vw.soon", "Coming soon"); });
  });
}
const tgtHtml = (t) => `<b>${esc(tname(t.name))}</b><small><span class="dot ${t.kind}"></span>${esc(L("vw.kind." + t.kind, KIND_TEXT[t.kind]))} · ${esc(L(`vw.tgt.${t.id}.tag`, t.tag))}</small>`;
/** Language switch: relabel the target buttons (no new requests). */
function paintTargets() {
  document.querySelectorAll("#targets .tgt").forEach((b, i) => {
    const tg = TARGETS[i];
    if (!tg) return;
    b.innerHTML = tgtHtml(tg);
    b.title = b.dataset.soon ? L("vw.soon", "Coming soon") : L(`vw.tgt.${tg.id}.why`, tg.why);
  });
}

// --- measurement details (the full table, as before) -------------------------------------------------
function renderMeasure() {
  const m = S.meta, ms = m.measured || {}, ref = S.ref.none ? L("u3.vw.reqPos", "the picked position") : S.ref.label;
  let html = "";
  if (ms.message) html += `<p class="status ${ms.status || ""}">${ptext(ms.message)}</p>`;
  const pre = ms.preliminary;
  if (pre) {
    html += `<p>` + L("vw.m.pre", "<b>Preliminary</b> (preview, not a measurement): {a} → {b} roughly {s}\" toward PA {pa}°; {ref} predicts {p}\" toward PA {ppa}°. <small>{n} images; raw SPHEREx WCS, no Gaia field-star calibration, no error bars.</small>",
      { a: pre.from_epoch, b: pre.to_epoch, s: fx(pre.shift_arcsec, 1), pa: fx(pre.pa_deg, 0), ref, p: fx(pre.catalogue_shift_arcsec, 1), ppa: fx(pre.catalogue_pa_deg, 0), n: pre.n_used }) + `</p>`;
  }
  if (ms.shift_arcsec != null) {
    html += `<p>` + L("vw.m.moved", "{a} → {b}: moved <b>{s}\"</b>", { a: ms.from_epoch, b: ms.to_epoch, s: fx(ms.shift_arcsec) }) +
      (ms.shift_err_arcsec ? ` ± ${fx(ms.shift_err_arcsec)}"` : "") + L("vw.m.towardPa", " toward PA {pa}°. ", { pa: fx(ms.pa_deg, 0) }) +
      L("vw.m.predicts", "{ref} predicts <b>{p}\"</b> toward PA {pa}°.", { ref, p: fx(ms.gaia_predicted_arcsec), pa: fx(ms.gaia_pa_deg, 0) }) +
      (ms.same_orientation === false ? ` <small>${L("vw.m.turned", "(seasons seen with the telescope turned 180°)")}</small>` : "") + `</p>`;
  }
  if (ms.fit) {
    html += `<p><small>` + L("vw.m.fit", "Proper motion from {n} images: {a} ± {ae}, {d} ± {de} mas/yr ({ref}: {ga}, {gd}).",
      { n: ms.fit.n_used, a: fx(ms.fit.pmra_mas_yr, 0), ae: fx(ms.fit.pmra_err_mas_yr, 0), d: fx(ms.fit.pmdec_mas_yr, 0), de: fx(ms.fit.pmdec_err_mas_yr, 0),
        ref, ga: fx(ms.fit.gaia_pmra_mas_yr, 0), gd: fx(ms.fit.gaia_pmdec_mas_yr, 0) }) + `</small></p>`;
  }
  const rows = (ms.positions || []).map((p) =>
    `<tr><td>${p.epoch}</td><td>${p.date}</td><td>${p.n_images}</td>` +
    `<td class="num">${fx(p.minus_gaia_east_arcsec)}", ${fx(p.minus_gaia_north_arcsec)}"</td>` +
    `<td class="num">${fx(p.err_east_arcsec)}", ${fx(p.err_north_arcsec)}"</td></tr>`).join("");
  if (rows) html += `<div class="tw"><table><tr><th>${L("vw.m.th.season", "Season")}</th><th>${L("vw.m.th.date", "Mean date")}</th><th>${L("vw.m.th.images", "Images")}</th><th>${L("vw.m.th.minus", "Measured − {ref} (E, N)", { ref: ref.split(" (")[0] })}</th><th>${L("vw.m.th.err", "± (E, N)")}</th></tr>${rows}</table></div>`;
  const fc = ms.field_calibration;
  if (fc && fc.applied && fc.n_exposures_calibrated > 0)
    html += `<small>` + L("vw.m.cal", "Positions are tied to Gaia DR3 with the field stars of the same images ({n} exposures calibrated).", { n: fc.n_exposures_calibrated }) + `</small> `;
  else if (fc && fc.applied)
    html += `<small>${L("vw.m.noCal", "Field-star calibration not applied: too few Gaia stars at these wavelengths; positions use the SPHEREx WCS.")}</small> `;
  if (rows && ms.positions.some((p) => p.bias_corrected) && ms.same_orientation === true)
    html += `<small>` + L("vw.m.bias", "Positions corrected for a small detector-fixed centroid bias (fitted per detector); " +
      "the main result above uses two seasons seen in the same orientation, where that bias cancels.") + `</small>`;
  const det = ms.detection;
  if (det && det.bins && det.bins.length) {
    const eps = m.epochs;
    const bl = [...new Set(det.bins.map((c) => c.wavelength_um))];
    let t = `<tr><th>${L("vw.m.th.bin", "Bin")}</th>${eps.map((e) => `<th>${e}</th>`).join("")}</tr>`;
    bl.forEach((b) => {
      t += `<tr><td>${loc(b.toFixed(1))} µm (${det.bins.find((c) => c.wavelength_um === b).detector})</td>` + eps.map((e) => {
        const c = det.bins.find((q) => q.wavelength_um === b && q.epoch === e);
        if (!c) return "<td>–</td>";
        const v = c.saturated_frac > 0.5 ? L("vw.m.sat", "sat.") : fx(c.snr, 1);
        return `<td class="num ${c.detected ? "det" : ""}">${v} <small>(${c.n})</small></td>`;
      }).join("") + "</tr>";
    });
    html += `<details${ms.status === "detected" ? "" : " open"}><summary>` + L("vw.m.detSum", "Detection check: S/N at the predicted position " +
      "(single-season stacks, ≥{thr}σ in green; number of images in brackets)", { thr: det.threshold_snr }) + `</summary><div class="tw"><table>${t}</table></div>` +
      (det.blend_note ? `<small>${ptext(det.blend_note)}</small>` : "") +
      ((det.blend_check || []).length ? `<small>` + L("vw.m.nearest", "Nearest catalogue source to the predicted position: {list} (fitted together with the target).",
        { list: det.blend_check.map((b) => `${b.epoch} ${fx(b.nearest_arcsec, 1)}"`).join(lang() === "tr" ? "; " : ", ") }) + `</small>` : "") +
      `</details>`;
  }
  const ph = ms.photometry;
  if (ph) {
    $("mtitle").textContent = L("vw.m.brightTitle", "Brightness change (relative photometry)");
    const eps = m.epochs;
    let t = `<tr><th>${L("vw.m.th.bin", "Bin")}</th>${eps.map((e) => `<th>${e}</th>`).join("")}<th>${L("vw.m.th.note", "Note")}</th></tr>`;
    ph.bins.forEach((b) => {
      t += `<tr><td>${loc(b.wavelength_um.toFixed(1))} µm</td>` + eps.map((e) => {
        const s = (b.seasons || []).find((q) => q.epoch === e);
        if (!s) return "<td>–</td>";
        return s.ratio_err ? `<td class="num">${fx(s.ratio_to_first)} ± ${fx(s.ratio_err)}</td>` : `<td class="num">${L("vw.m.ref1", "1 (ref.)")}</td>`;
      }).join("") + `<td><small>${ptext((b.flags || []).join("; ")) || (b.method === "psf" ? L("vw.m.psf", "PSF flux") : "")}` +
      (b.n_comparison ? L("vw.m.compStars", " · {n} comparison stars", { n: b.n_comparison }) : "") + `</small></td></tr>`;
    });
    html += `<p>` + L("vw.m.photP", "Target flux relative to comparison stars in the same images, as a ratio to the first season " +
      "(1.20 = 20 % brighter).") + `</p><div class="tw"><table>${t}</table></div><p><small>${ptext(ph.method || "")} ${(ph.caveats || []).map(ptext).join(" ")}</small></p>`;
  }
  if (ms.finding) html += `<p><small><b>${L("vw.m.finding", "Finding:")}</b> ${ptext(ms.finding)}</small></p>`;
  if (ms.note) html += `<p><small>${ptext(ms.note)}</small></p>`;
  $("measure").innerHTML = html;
  if (!ph) $("mtitle").textContent = L("vw.m.title", "Measurement details");
}

function renderStagebar() {
  const m = S.meta, pv = m.preview;
  if (!(pv || /^\/jobs\//.test(S.base))) return;
  const n = pv ? pv.n_images : S.bins.reduce((a, b) => a + b.frames.reduce((s, f) => s + f.n_images, 0), 0);
  const st = $("stagebar");
  st.hidden = false;
  st.className = "stagebar " + (pv ? "preview" : "full");
  st.innerHTML = pv
    ? L("vw.stage.preview", "<b>Preview ({n} images)</b> · {um} µm only ({det}), {s} seasons, small regions. A quick look, not a measurement.",
      { n, um: loc((+pv.bin_um).toFixed(1)), det: pv.detector, s: pv.seasons })
    : L("vw.stage.full", "<b>Full result ({n} images)</b> · {b} wavelength bin(s), {s} seasons.", { n, b: S.bins.length, s: (m.epochs || []).length });
}

function watchHint() {
  const pe = S.bin ? pairEpochs() : null;
  const ms = S.meta.measured || {};
  if (!pe) { $("watch").textContent = ""; return; }
  const A = season(pe[0], true), B = season(pe[1], true);
  const tail = ms.photometry ? L("vw.watch.bright", "the star in the ring changes brightness.")
    : (ok(ms.shift_arcsec) || ms.preliminary) && !S.ref.none ? L("vw.watch.arrow", "the arrow shows where it went.") : L("vw.watch.jump", "anything that jumps has moved.");
  $("watch").innerHTML = `<b>${esc(L("vw.watch.title", "Watch it."))}</b><span class="x"> ${esc(S.sel.length > 2
    ? L("vw.watch.many", "The image steps through {n} seasons; the pair is {a} and {b}; {tail}", { n: S.sel.length, a: A, b: B, tail })
    : L("vw.watch.two", "The image switches between {a} and {b}; {tail}", { a: A, b: B, tail }))}</span>`;
}

// --- "Find the mover" game ---------------------------------------------------------------------------
function answers() {
  const pts = [];
  S.sel.forEach((i) => {
    const e = S.bin.frames[i].epoch, p = measuredPos(e);
    const xy = p ? p.png_xy_measured : markerXY(e);
    if (xy) pts.push(xy);
  });
  if (!pts.length && S.ref.none) pts.push(centreXY());
  return pts;
}
function canPlay() {
  const ms = S.meta.measured || {};
  return ms.status !== "not_detected" && (ok(ms.shift_arcsec) || !!ms.photometry) && answers().length > 0;
}
function startGame() {
  if (!canPlay()) return;
  if (S.marking && S.marking.setOn) S.marking.setOn(false);
  if (S.mode !== "blink") setMode("blink");
  S.playing = true; restart();
  S.game = { revealed: false, click: null, hit: false };
  $("stage").classList.add("game");
  const vary = !!(S.meta.measured || {}).photometry;
  gameMsg(esc(vary ? L("vw.g.askBright", "Find the star that changes brightness: watch the blink, then click it.")
    : L("vw.g.askMove", "Find the mover: watch the blink, then click the thing that moves.")), "ask");
  $("gameBtn").textContent = L("vw.g.showMe", "Show me");
  drawOverlay();
}
function gameMsg(html, cls) {
  const g = $("gameMsg");
  g.hidden = !html;
  g.className = "game-msg " + (cls || "");
  g.innerHTML = html || "";
}
function reveal(hit) {
  S.game.revealed = true;
  S.game.hit = hit;
  const m = S.meta, ms = m.measured || {}, name = esc(m.target ? targetName(m) : L("vw.g.theTarget", "the target"));
  let msg;
  if (ms.photometry) {
    const pe = pairEpochs(), v = pe ? brightPair(pe[0], pe[1]) : null;
    const what = v && !v.none ? " " + esc(L("vw.g.ourBright", "Our measurement: {p} % {dir} at {um} µm, {a} → {b}.", { p: Math.abs(Math.round(100 * (v.r - 1))),
      dir: v.r < 1 ? L("vw.g.fainter", "fainter") : L("vw.g.brighter", "brighter"), um: loc(S.bin.wavelength_um.toFixed(1)), a: season(pe[0]), b: season(pe[1]) })) : "";
    msg = hit ? L("vw.g.correct", "<b>Correct!</b> That is {name}.", { name }) + what : L("vw.g.missRing", "<b>Not quite: here it is</b> (in the orange ring).") + what;
  } else {
    const who = S.ref.who === "The catalogue" ? L("vw.g.catalogue", "The catalogue") : S.ref.who;
    const pe = pairEpochs(), v = pe ? motionPair(pe[0], pe[1]) : null;
    const nums = v ? " " + esc(L("vw.g.nums", "{a} → {b}: we measured {s}", { a: season(pe[0]), b: season(pe[1]), s: arcsec(v.s, v.e) }) +
      (who && v.p != null ? L("vw.g.numsPred", "; {who} predicts {p}.", { who, p: arcsec(v.p, v.e) }) : ".")) : "";
    msg = hit ? `<b>${esc(who ? L("vw.g.confirms", "{who} confirms!", { who }) : L("vw.g.yes", "Yes!"))}</b> ${L("vw.g.found", "You found {name}.", { name })}${nums}`
      : L("vw.g.missArrow", "<b>Not quite: here it is</b> (follow the arrow).") + nums;
  }
  gameMsg(msg + ` <button type="button" id="gameAgain">${esc(L("vw.g.again", "Play again"))}</button>`, hit ? "hit" : "miss");
  $("gameAgain").onclick = () => { endGame(); startGame(); };
  $("gameBtn").textContent = L("vw.g.find", "Find the mover");
  $("stage").classList.remove("game");
  drawOverlay();
}
function endGame() {
  S.game = null;
  $("stage").classList.remove("game");
  gameMsg("");
  $("gameBtn").textContent = L("vw.g.find", "Find the mover");
  drawOverlay();
}
function onStageClick(ev) {
  if (!S.game || S.game.revealed) return;
  if (ev.target && ev.target.closest && ev.target.closest("#gameMsg, #swipeUi, button, input")) return;
  if ($("fzmToggle") && $("fzmToggle").getAttribute("aria-pressed") === "true") { endGame(); return; }
  const r = $("frame").getBoundingClientRect();
  if (!r.width) return;
  const [W, H] = pngSize();
  const x = (ev.clientX - r.left) / r.width * W, y = (ev.clientY - r.top) / r.height * H;
  const tol = Math.max(30, 26 / (S.k || 1));
  const d = Math.min(...answers().map((p) => Math.hypot(p[0] - x, p[1] - y)));
  S.game.click = [x, y];
  reveal(d <= tol);
}

// --- copy link ---------------------------------------------------------------------------------------
async function copyLink() {
  const b = $("copyLink"), url = location.href;
  let done = false;
  try { await navigator.clipboard.writeText(url); done = true; } catch (_) {}
  if (!done) {
    const i = $("linkOut");
    i.hidden = false; i.value = url; i.focus(); i.select();
    try { done = document.execCommand("copy"); } catch (_) {}
  }
  b.textContent = done ? L("vw.copied", "Link copied") : L("vw.copyBelow", "Copy the link below");
  setTimeout(() => { b.textContent = L("vw.copy", "Copy link"); }, 2200);
}

// --- start ---------------------------------------------------------------------------------------------
function stageMsg(t) { const el = $("stageMsg"); el.hidden = !t; el.textContent = t || ""; }

export async function startViewer() {
  S.base = baseFromUrl();
  S.ex = await import("./explain.js").catch((e) => { console.warn("explain.js", e); return {}; });
  buildTargets();
  stageMsg(L("vw.loading", "Loading…"));
  let m;
  try {
    const r = await fetch(S.base + "meta.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    m = await r.json();
  } catch (e) {
    stageMsg(L("vw.loadErr", "Could not load {f} ({e}).", { f: S.base + "meta.json", e: e.message || e }));
    $("explainSentence").textContent = L("vw.loadErr2", "This result could not be loaded. Pick a target above.");
    return null;
  }
  S.meta = m;
  S.nb = [];
  findNeighbours(S.base, m).then((nb) => { S.nb = nb; if (nb.length && S.bin) drawOverlay(); }).catch(() => {});
  S.bins = m.wavelength_bins || [];
  S.ref = refInfo(m);
  const tid = targetIdOf(S.base);
  S.info = TARGETS.find((t) => t.id === tid) || TARGETS.find((t) => t.name === m.target) || null;
  if (!S.bins.length) { stageMsg(L("vw.noFrames", "This result has no SPHEREx frames.")); return null; }
  stageMsg("");
  renderHeader();
  renderStagebar();
  renderResult();
  renderMeasure();
  const paintFixed = () => {
    $("marklabel").textContent = S.ref.none ? L("vw.ring.centre", "Centre ring") : L("vw.ring.of", "{who} ring", { who: S.ref.Short });
    $("subtitle").textContent = L("vw.sub", "Centre RA {ra}°, Dec {dec}° (epoch {ep}).", { ra: fx(m.ra, 4), dec: fx(m.dec, 4), ep: loc(m.epoch_center) });
    $("src").textContent = L("vw.src", "Data: {ds}. Generated {gen}.", { ds: m.data_source || "SPHEREx", gen: m.generated || "" });
    $("realNote").textContent = L("vw.realNote", "All frames are real SPHEREx images ({ds}), stacked per season; nothing is simulated.", { ds: m.data_source || "NASA/IPAC IRSA" });
    [...$("wl").options].forEach((o, i) => { const b = m.wavelength_bins[i]; if (b) o.textContent = L("vw.wlOpt", "{um} µm ({n} seasons)", { um: loc(b.wavelength_um.toFixed(1)), n: b.frames.length }); });
  };
  m.wavelength_bins.forEach((b, i) => {
    const o = document.createElement("option");
    o.value = i;
    $("wl").appendChild(o);
  });
  paintFixed();

  // zoom: the default is a close-up around the target (closeUpZoom). ?z= (a shared link; the old 1..6 links too) and
  // ?c=x,y (the picture point in the middle) bring back a view the visitor chose
  const zq = parseFloat(Q.get("z"));
  if (Number.isFinite(zq) && zq >= 1) {
    S.user = true; S.zoom = Math.min(zq, 400);
    const cq = (Q.get("c") || "").split(",").map(Number);
    if (cq.length === 2 && cq.every(Number.isFinite)) { S.cx = cq[0]; S.cy = cq[1]; }
  }
  S.mode = ["blink", "step", "swipe", "trail"].includes(Q.get("mode")) ? Q.get("mode") : "blink";
  S.view = FV.VIEWS.includes(Q.get("view")) ? Q.get("view") : "film";
  // reduced motion: the film does not start by itself; the still "time as colour" picture is the poster, with a Play button
  let calm = false;
  try { calm = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}
  if (calm) { S.playing = false; if (!Q.get("view") && !Q.get("mode")) { S.poster = true; S.view = "tcol"; } }

  // start bin: ?um= (a shared link) wins; then a detected bin for faint targets (WISE 0855: 4.6 µm);
  // then ?bin= (the explorer's preview wavelength); then, for brightness targets, the bin of the
  // strongest change (the one the sentence talks about)
  const ms = m.measured || {};
  const find = (v) => (v ? S.bins.findIndex((b) => Math.abs(b.wavelength_um - v) < 0.05) : -1);
  const db = (ms.detection || {}).detected_bins_um || [];
  let start = 0;
  const ku = find(+Q.get("um")), kb = find(+Q.get("bin"));
  if (ku >= 0) start = ku;
  else if (db.length && ms.status !== "detected" && !ok(ms.shift_arcsec) && find(db[db.length - 1]) >= 0) start = find(db[db.length - 1]);
  else if (kb >= 0 && (ms.status === "detected" || !db.length || db.some((w) => Math.abs(w - +Q.get("bin")) < 0.05))) start = kb;
  else if (db.length && ok(ms.shift_arcsec)) {
    // a detected bin with the most images in its thinnest season; ties -> the longest wavelength
    // (Barnard's Star: 4.6 µm, the smallest saturated core)
    let best = -1;
    db.forEach((w) => {
      const k = find(w);
      if (k < 0) return;
      const n = Math.min(...S.bins[k].frames.map((f) => f.n_images || 0));
      if (best < 0 || n >= Math.min(...S.bins[best].frames.map((f) => f.n_images || 0))) best = k;
    });
    if (best >= 0) start = best;
  }
  else if (ms.photometry) {
    const c = bestChange(ms.photometry);
    if (c && c.main && find(c.main.b.wavelength_um) >= 0) start = find(c.main.b.wavelength_um);
  }
  $("wl").value = start;
  let sel = null;
  if (Q.get("s")) {
    const want = Q.get("s").split(",");
    sel = S.bins[start].frames.map((f, i) => (want.includes(f.epoch) ? i : -1)).filter((i) => i >= 0);
  }

  // controls
  $("wl").onchange = (e) => { selectBin(+e.target.value); watchHint(); };
  $("play").onclick = () => {
    if (S.view !== "film") { S.playing = true; setView("film"); if (S.mode !== "blink") setMode("blink"); }
    else if (S.mode !== "blink") setMode("blink"); else { S.playing = !S.playing; restart(); }
  };
  $("prev").onclick = () => step(-1);
  $("next").onclick = () => step(1);
  $("speed").oninput = (e) => { $("speedv").textContent = e.target.value + " ms"; restart(); };
  $("mark").onchange = () => drawOverlay();
  $("arrowOn").onchange = () => drawOverlay();
  $("zoom").onchange = (e) => { S.user = true; S.zoom = +e.target.value; layout(); writeUrl(); };   // the hidden control (explore/candidates.js steps it)
  document.querySelectorAll("#modes button").forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  $("allSeasons").onclick = () => {
    const n = S.bin.frames.length;
    S.sel = S.sel.length === n ? defaultSel() : S.bin.frames.map((_, i) => i);
    if (!S.sel.includes(S.idx)) S.idx = S.sel[0];
    afterSelection();
  };
  $("swipe").oninput = applySwipe;
  $("copyLink").onclick = copyLink;
  $("gameBtn").hidden = !canPlay();
  $("gameBtn").onclick = () => { if (S.game && !S.game.revealed) reveal(false); else { endGame(); startGame(); } };
  const st = $("stage");
  // picture area (goruntu_tur): processed frames on a canvas over the frame image, view tabs above the picture, one
  // sentence below it, zoom buttons / wheel / pinch / drag on the picture, one quiet progress line at its bottom edge
  FV.ensureCss();
  const zl = $("zoom").closest("label");
  if (zl) zl.hidden = true;                                     // one zoom mechanism: on the picture
  S.fv = FV.createView({ zoomer: $("zoomer"), frame: $("frame") });
  S.fv.raw = Q.get("raw") === "1";
  S.tabs = FV.buildTabs(st, (v) => setView(v));                // under the picture: legend (phones), tabs, one sentence
  st.insertAdjacentHTML("afterend", `<div id="fzLegend" class="fz-legend" hidden></div>`);
  S.tabs.el.insertAdjacentHTML("afterend", `<p id="fzViewSay" class="fz-say" hidden></p>`);
  const setRaw = (on) => {
    S.fv.raw = !!on; zoomUi(); viewSay(); writeUrl();
    try { document.dispatchEvent(new CustomEvent("fazari:view", { detail: { view: S.view, raw: S.fv.raw } })); } catch (_) {}
  };
  const mid = () => [st.clientWidth / 2, st.clientHeight / 2];
  S.ui = FV.buildZoomUi(st, { zoom: (f) => zoomAt(f, ...mid(), true), closeUp, whole: wholeField, raw: setRaw });
  const hint = FV.hintLine(st);
  FV.attachGestures(st, {
    zoomAt: (f, x, y) => zoomAt(f, x, y),
    panBy,
    canZoom: (f) => (f > 1 ? S.zoom < zoomMax() * 0.999 : S.zoom > 1.001),
    // dragging moves the picture when it is zoomed in (a finger: only once the visitor zoomed in, else it scrolls the page)
    canDrag: (ev) => S.zoom > 1.001 && S.mode !== "swipe" && (ev.pointerType === "mouse" || st.style.touchAction === "none"),
    settle: () => {},
    hint: () => hint(L("fz.hint.wheel", "Click the picture, then the wheel zooms")),
    key: (name) => {
      const d = 70;
      if (name === "in") zoomAt(1.5, ...mid(), true);
      else if (name === "out") zoomAt(1 / 1.5, ...mid(), true);
      else if (name === "close") closeUp();
      else panBy(name === "left" ? d : name === "right" ? -d : 0, name === "up" ? d : name === "down" ? -d : 0);
    },
  });
  FV.progressLine(st);
  st.insertAdjacentHTML("beforeend", `<button type="button" id="fzPlay" class="fz-play" hidden></button>`);
  $("fzPlay").onclick = () => { S.playing = true; setView("film"); if (S.mode !== "blink") setMode("blink"); };
  const paintPlay = () => { $("fzPlay").innerHTML = `<span aria-hidden="true">▶</span> ${esc(L("fz.play", "Play the film"))}`; };
  paintPlay();
  // the verdict strip (js/verdict_strip.js) marks its kind on <html>: its headline is repeated on the picture
  try { new MutationObserver(() => caption()).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); } catch (_) {}
  st.addEventListener("click", onStageClick);
  // swipe: drag on the image as well as the slider
  let drag = false;
  const dragTo = (ev) => { const r = st.getBoundingClientRect(); $("swipe").value = String(Math.max(0, Math.min(100, 100 * (ev.clientX - r.left) / r.width))); applySwipe(); };
  st.addEventListener("pointerdown", (ev) => {
    if (S.mode !== "swipe" || ev.target === $("swipe") || ($("fzmToggle") && $("fzmToggle").getAttribute("aria-pressed") === "true")) return;
    drag = true; try { st.setPointerCapture(ev.pointerId); } catch (_) {}
    dragTo(ev);
  });
  st.addEventListener("pointermove", (ev) => { if (drag) dragTo(ev); });
  const stop = () => { drag = false; };
  st.addEventListener("pointerup", stop); st.addEventListener("pointercancel", stop);
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || "")) return;
    if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
    else if (e.key === " " && (e.target === document.body || e.target === st)) { $("play").click(); e.preventDefault(); }
    else if (e.key === "Escape" && S.game) endGame();
  });
  try { new ResizeObserver(() => layout()).observe(st); } catch (_) { window.addEventListener("resize", layout); }

  selectBin(start, sel && sel.length ? sel : null);
  watchHint();
  // language switch: new text only; bin, seasons, frame, mode, zoom, game and marks stay as they are
  onLang(() => {
    try {
      renderHeader(); paintTargets(); paintFixed(); renderStagebar(); renderMeasure(); renderResult(); renderSeasons(); pairDiff(); watchHint();
      $("modeHint").textContent = t("vw.hint." + S.mode);
      show(); scaleBar();
      if (S.tabs) S.tabs.paint();
      paintPlay(); viewUi(); zoomUi(); restart();
      if (S.game && S.game.revealed) reveal(S.game.hit);
      else if (S.game) { gameMsg(esc((S.meta.measured || {}).photometry ? t("vw.g.askBright") : t("vw.g.askMove")), "ask"); $("gameBtn").textContent = L("vw.g.showMe", "Show me"); }
      else $("gameBtn").textContent = L("vw.g.find", "Find the mover");
    } catch (e) { console.warn("viewer language switch", e); }
  });
  const pickBin = (k) => { if (k >= 0 && k !== S.bi) { $("wl").value = k; $("wl").dispatchEvent(new Event("change")); } };
  const api = {
    meta: m, base: S.base, stage: st,
    // --- picture area (goruntu_tur): what the guided tour (js/tour.js) and the charts (js/ts_flow.js) drive ---
    play() { S.playing = true; if (S.view !== "film") setView("film", true); if (S.mode !== "blink") setMode("blink", true); restart(); },
    pause() { S.playing = false; restart(); },
    playing: () => !!S.timer,
    setView(v) { setView(v); return S.view; },
    view: () => S.view,
    ready: () => fvOn(),                                 // the processed frames are on screen (not the fallback image)
    bins: () => S.bins.map((b) => b.wavelength_um),
    setBin(um) { pickBin(S.bins.findIndex((b) => Math.abs(b.wavelength_um - um) < 0.05)); return S.bin ? S.bin.wavelength_um : null; },
    seasons: () => (S.bin ? S.bin.frames.map((f) => f.epoch) : []),
    /** Show one visit (season "2026-04"; the nearest one this wavelength has) at the wavelength nearest to bin_um; the film pauses, the zoom stays. */
    goTo({ season: ep, bin_um } = {}) {
      if (ok(bin_um) && S.bins.length) pickBin(S.bins.map((b, i) => [Math.abs(b.wavelength_um - bin_um), i]).sort((a, b) => a[0] - b[0])[0][1]);
      if (!S.bin) return null;
      const mo = (e) => { const x = /^(\d{4})-(\d{2})/.exec(String(e || "")); return x ? +x[1] * 12 + +x[2] : NaN; };
      let j = ep ? S.bin.frames.findIndex((f) => f.epoch === ep) : S.idx;
      if (j < 0 && Number.isFinite(mo(ep))) j = S.bin.frames.map((f, i) => [Math.abs(mo(f.epoch) - mo(ep)), i]).sort((a, b) => a[0] - b[0])[0][1];
      if (!(j >= 0)) return null;
      if (S.view !== "film") setView("film", true);
      if (S.mode === "swipe" || S.mode === "trail") setMode("step", true);
      S.playing = false;
      if (!S.sel.includes(j)) { S.sel = [...S.sel, j].sort((a, b) => a - b); S.idx = j; afterSelection(); }
      else { S.idx = j; show(); restart(); }
      return { season: S.bin.frames[j].epoch, bin_um: S.bin.wavelength_um };
    },
    /** fov_arcmin: sky across the smaller side of the picture; or k: screen pixels per picture pixel; x, y: picture pixel in the middle. */
    zoomTo({ fov_arcmin, k, x, y } = {}) {
      const k1 = fitScale(st), a = pngArcsec();
      if (!(k1 > 0)) return null;
      S.user = true;
      if (ok(k)) S.zoom = +k / k1; else if (ok(fov_arcmin) && a) S.zoom = Math.min(st.clientWidth, st.clientHeight) * a / (+fov_arcmin * 60) / k1;
      if (ok(x) && ok(y)) { S.cx = +x; S.cy = +y; }
      layout(); writeUrl();
      return api.zoomState();
    },
    closeUp, wholeField,
    zoomState() {
      const a = pngArcsec(), k1 = fitScale(st);
      return { k: S.k, zoom: S.zoom, user: S.user, tx: S.tx, ty: S.ty, zoom_min: 1, zoom_max: zoomMax(), zoom_closeup: closeUpZoom(), fit_k: k1,
        fov_arcmin: a && S.k ? [st.clientWidth * a / S.k / 60, st.clientHeight * a / S.k / 60] : null,
        fov_arcmin_min: a && k1 ? Math.min(st.clientWidth, st.clientHeight) * a / (k1 * zoomMax()) / 60 : null,
        fov_arcmin_max: a && k1 ? Math.min(st.clientWidth, st.clientHeight) * a / k1 / 60 : null };
    },
    setRaw, raw: () => !!S.fv.raw,
    frames: () => (fvOn() ? S.fv.set : null),             // the processed frame set (shifts, sky levels: for checks)
    current: () => ({ frame: S.bin && S.bin.frames[S.idx], bin_um: S.bin && S.bin.wavelength_um }),
    setMarking(api) { S.marking = api || null; },
    fallbackSentence() {
      const box = $("explainSentence");
      if (box.textContent.trim()) return;
      const t = ok(ms.shift_arcsec) ? L("vw.fb.moved", "{name} moved {s} between {a} and {b}.", { name: targetName(m), s: arcsec(ms.shift_arcsec, ms.shift_err_arcsec), a: season(ms.from_epoch, true), b: season(ms.to_epoch, true) })
        : ms.photometry ? L("vw.fb.bright", "{name} changes brightness between the SPHEREx seasons.", { name: targetName(m) }) : ptext(ms.message || "");
      box.innerHTML = t ? `<p>${esc(t)}</p>` : "";
    },
    on(fn) { if (typeof fn === "function") S.listeners.push(fn); },
    setArrow(on) { if (S.noArrow === !on) return; S.noArrow = !on; drawOverlay(); },   // bins_bar.js: no motion arrow while the answer is too uncertain
    // wavelength-by-wavelength run (js/bins_bar.js): the next stage folder in place, at wavelength um (else the same one)
    async swapData(base, { meta, um } = {}) {
      const nm = meta || await fetch(base + "meta.json", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
      if (!(nm.wavelength_bins || []).length) return null;
      const keep = um ?? (S.bin && S.bin.wavelength_um);
      // what the visitor is looking at stays (goruntu_tur): the sky scale and the point in the middle, the chosen visits,
      // the visit on screen, playing or paused, the view tab. The stage folders of one run may have different grids.
      const was = S.bin ? { a: pngArcsec(), k: S.k, size: pngSize(), strip: labelStrip(), cx: S.cx, cy: S.cy, user: S.user, um: S.bin.wavelength_um,
        sel: selFrames().map((f) => f.epoch), ep: (S.bin.frames[S.idx] || {}).epoch,
        dflt: (() => { const d = defaultSel(); return d.length === S.sel.length && d.every((v, i) => v === S.sel[i]); })() } : null;
      m = nm; S.base = base; S.meta = nm; S.bins = nm.wavelength_bins; S.ref = refInfo(nm); api.meta = nm; api.base = base;
      $("wl").replaceChildren(...nm.wavelength_bins.map((b, i) => { const o = document.createElement("option"); o.value = i; return o; }));
      paintFixed(); renderHeader(); renderStagebar(); renderMeasure();
      const k = Math.max(0, S.bins.findIndex((b) => Math.abs(b.wavelength_um - keep) < 0.05));
      $("wl").value = k;
      let sel = null;
      if (was && was.a && was.k) {
        const a = pngArcsec(), k1 = fitScale(st), [W, H] = pngSize(), strip = labelStrip();
        if (was.user && a && k1 > 0) {
          S.zoom = (was.k / was.a) * a / k1;
          if (was.cx != null) { S.cx = W / 2 + (was.cx - was.size[0] / 2) * was.a / a; S.cy = (H + strip) / 2 + (was.cy - (was.size[1] + was.strip) / 2) * was.a / a; }
        } else if (!was.user) S.holdScale = was.a / was.k;           // the default close-up keeps its sky scale while the run goes on
        if (!was.dflt && Math.abs(was.um - S.bins[k].wavelength_um) < 0.05) {
          sel = S.bins[k].frames.map((f, i) => (was.sel.includes(f.epoch) ? i : -1)).filter((i) => i >= 0);
          if (sel.length < Math.min(2, S.bins[k].frames.length)) sel = null;
        }
      }
      selectBin(k, sel, was && was.ep);
      softUpdate();
      $("gameBtn").hidden = !canPlay();
      findNeighbours(base, nm).then((nb) => { if (S.meta === nm) { S.nb = nb; if (nb.length && S.bin) drawOverlay(); } }).catch(() => {});
      return nm;
    },
  };
  window.__fzViewer = api;        // the result on screen, for the tour and the charts (ornek.html sets the same object)
  return api;
}
