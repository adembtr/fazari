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
  if (lang() === "tr") return month(ep, long);
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
function place(box, wrap, zoom) {
  const Sw = wrap.clientWidth, Sh = wrap.clientHeight;
  if (!Sw || !Sh) return null;
  const [W, H] = pngSize(), L = labelStrip();
  const k = Math.min(Sw / W, Sh / (H - L)) * zoom;
  const [cx, cy] = centreXY();
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
  const p = place($("zoomer"), $("stage"), S.zoom);
  if (p) Object.assign(S, p);
  const d = $("diffZoom") && place($("diffZoom"), $("diffView"), Math.max(1, S.zoom * 0.75));
  if (S.mode === "swipe") applySwipe();
  drawOverlay();
  scaleBar();
}

function scaleBar() {
  const a = pngArcsec(), el = $("hudScale");
  if (!a || !S.k) { el.hidden = true; return; }
  const perPx = a / S.k;                    // arcsec per screen pixel
  const pick = [5, 10, 20, 30, 60, 120, 300, 600].find((v) => v / perPx >= 48) || 600;
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

// --- overlay: motion arrow, path, catalogue ring, measured point, game click ---------------------
function motionPoints() {
  const pe = pairEpochs();
  if (!pe) return null;
  const [ea, eb] = pe;
  const eps = selFrames().map((f) => f.epoch);
  const mA = measuredPos(ea), mB = measuredPos(eb);
  if (mA && mB) return { kind: "measured", ea, eb, a: mA.png_xy_measured, b: mB.png_xy_measured,
    path: eps.map((e) => measuredPos(e)).filter(Boolean).map((p) => p.png_xy_measured) };
  if (S.ref.none) return null;
  const cA = markerXY(ea), cB = markerXY(eb);
  if (cA && cB && Math.hypot(cB[0] - cA[0], cB[1] - cA[1]) > 1) return { kind: "predicted", ea, eb, a: cA, b: cB, path: eps.map((e) => markerXY(e)).filter(Boolean) };
  return null;
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
const RING = 34;                  // ring radius in PNG px (about 25″ on the sky)
function motionSvg(u, legend) {
  const mp = motionPoints();
  if (!mp) return "";
  const a = mp.a, b = mp.b;
  const halo = (d, w) => `<path d="${d}" fill="none" stroke="#05070d" stroke-opacity=".8" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  let s = "";
  if (mp.path.length > 2) {                // path through every season in the blink
    const d = "M" + mp.path.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join("L");
    s += halo(d, 3.5 * u) + `<path d="${d}" fill="none" stroke="#e8eaf0" stroke-width="${1.4 * u}" stroke-dasharray="${4 * u} ${3 * u}"/>`;
    mp.path.filter((p) => p !== a && p !== b).forEach((p) => { s += `<circle cx="${p[0]}" cy="${p[1]}" r="${3 * u}" fill="#c9d2e3" stroke="#05070d" stroke-width="${1.2 * u}"/>`; });
  }
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len > 0.2) {
    const ux = dx / len, uy = dy / len;
    const hl = Math.min(12 * u, len * 0.75), hw = 6.5 * u;
    const bx = b[0] - ux * hl, by = b[1] - uy * hl;
    const head = `M${b[0].toFixed(2)} ${b[1].toFixed(2)}L${(bx - uy * hw).toFixed(2)} ${(by + ux * hw).toFixed(2)}L${(bx + uy * hw).toFixed(2)} ${(by - ux * hw).toFixed(2)}Z`;
    const line = `M${a[0].toFixed(2)} ${a[1].toFixed(2)}L${bx.toFixed(2)} ${by.toFixed(2)}`;
    const col = mp.kind === "measured" ? "#ffffff" : "#ffd08a";
    s += halo(line, 7 * u) + halo(head, 3.5 * u) +
      `<path d="${line}" stroke="${col}" stroke-width="${3 * u}" stroke-linecap="round"${mp.kind === "measured" ? "" : ` stroke-dasharray="${5 * u} ${3 * u}"`}/>` +
      `<path d="${head}" fill="${col}"/>`;
    // first and last position (blue = before, red = after, like the difference image)
    s += `<circle cx="${a[0]}" cy="${a[1]}" r="${5.5 * u}" fill="none" stroke="#05070d" stroke-width="${4 * u}"/>` +
      `<circle cx="${a[0]}" cy="${a[1]}" r="${5.5 * u}" fill="none" stroke="#5aa9ff" stroke-width="${2.2 * u}"/>`;
    // labels: the first season behind the start, the last ahead of the end, the size beside it
    const lab = (x, y, t, c, anchor = "middle", size = 13) =>
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${c}" font-size="${size * u}" font-weight="700" text-anchor="${anchor}" ` +
      `dominant-baseline="middle" stroke="#05070d" stroke-width="${3.2 * u}" paint-order="stroke" font-family="system-ui, sans-serif">${esc(t)}</text>`;
    const off = RING + (11 + 30 * Math.abs(ux)) * u;       // clear of the ring, also for sideways motion
    s += lab(a[0] - ux * off, a[1] - uy * off, season(mp.ea), "#8cc4ff") +
      lab(b[0] + ux * off, b[1] + uy * off, season(mp.eb), "#ff8f8a");
    const at = arrowText(mp);
    if (at) {
      const t = at.long, short = at.short;
      // beside the ring, on the side with room on screen (right, else left, else below)
      let px = -uy, py = ux;
      if (px < 0 || (Math.abs(px) < 0.3 && py < 0)) { px = -px; py = -py; }
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, d = RING + (8 + 14 * Math.abs(py)) * u;
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
  legend.push(mp.kind === "measured" ? `<span><i class="lg arrow"></i>${esc(L("vw.lg.measured", "measured motion"))}</span>`
    : `<span><i class="lg arrow dash"></i>${esc(L("vw.lg.predPath", "{who} predicted path", { who: S.ref.short }))}</span>`);
  legend.push(`<span><i class="lg first"></i>${esc(L("vw.lg.first", "first season"))}</span>`);
  return s;
}
function ringSvg(u, legend) {
  const f = S.bin.frames[S.idx];
  const xy = markerXY(f.epoch);
  if (!xy) return "";
  const [x, y] = xy;
  const ring = `<circle cx="${x}" cy="${y}" r="${RING}" fill="none" stroke="#05070d" stroke-opacity=".7" stroke-width="${5 * u}"/>` +
    `<circle cx="${x}" cy="${y}" r="${RING}" fill="none" stroke="#ffb347" stroke-width="${2.4 * u}"/>`;
  const cross = `M${x - 7 * u} ${y}H${x + 7 * u}M${x} ${y - 7 * u}V${y + 7 * u}`;
  let s = ring + `<path d="${cross}" stroke="#05070d" stroke-width="${4 * u}"/><path d="${cross}" stroke="#ffb347" stroke-width="${2 * u}"/>`;
  const sn = (S.meta.measured || {}).snap;
  legend.push(`<span><i class="lg ring"></i>${S.ref.none ? esc(sn ? L("vw.lg.snapped", "source we measured") : L("vw.lg.picked", "position you picked")) : esc(L("vw.lg.predicts", "{who} predicts", { who: S.ref.short }))}</span>`);
  if (sn && sn.clicked && sn.clicked.png_xy) {          // moved to the nearest source: the clicked point stays as a small mark
    const [cx, cy] = sn.clicked.png_xy, r = 4.5 * u;
    s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#05070d" stroke-width="${3.4 * u}"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#7fd4ff" stroke-width="${1.6 * u}"/>`;
    legend.push(`<span><i class="lg clicked" style="border:2px solid #7fd4ff;border-radius:50%;width:8px;height:8px;display:inline-block"></i>${esc(L("vw.lg.clicked", "where you clicked"))}</span>`);
  }
  const p = measuredPos(f.epoch);
  if (p) {
    const [mx, my] = p.png_xy_measured;
    s += `<circle cx="${mx}" cy="${my}" r="${3.6 * u}" fill="#5dd39e" stroke="#05070d" stroke-width="${1.6 * u}"/>`;
    const d = Math.hypot(+p.minus_gaia_east_arcsec || 0, +p.minus_gaia_north_arcsec || 0);
    legend.push(`<span><i class="lg dot"></i>${esc(L("vw.lg.we", "we measured"))}${ok(p.minus_gaia_east_arcsec) && !S.ref.none ? " " + esc(L("vw.lg.apart", "({d}″ apart)", { d: loc(d.toFixed(2)) })) : ""}</span>`);
  }
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
  if (!hide && $("arrowOn").checked) s += motionSvg(u, legend);
  if (!hide && $("mark").checked) s += ringSvg(u, legend);
  if (S.game && S.game.click) {
    const [x, y] = S.game.click, c = S.game.hit ? "#5dd39e" : "#7fd4ff";
    const d = `M${x - 9 * u} ${y - 9 * u}L${x + 9 * u} ${y + 9 * u}M${x + 9 * u} ${y - 9 * u}L${x - 9 * u} ${y + 9 * u}`;
    s += `<path d="${d}" stroke="#05070d" stroke-width="${6 * u}"/><path d="${d}" stroke="${c}" stroke-width="${3 * u}"/>`;
  }
  ov.innerHTML = s;
  const lg = $("hudLegend");
  lg.innerHTML = legend.join("");
  lg.hidden = !legend.length;
}

// --- frames, modes, seasons ------------------------------------------------------------------
function setSrc(img, url) { if (img.getAttribute("src") !== url) img.setAttribute("src", url); }
function roleOf(i) {
  const p = pairIdx();
  return !p ? "" : i === p[0] ? "before" : i === p[1] ? "after" : "";
}
function show() {
  if (!S.bin) return;
  const f = S.bin.frames[S.idx];
  setSrc($("frame"), S.base + f.file);
  const fs = selFrames(), pr = pairIdx() || [S.sel[0], S.sel[S.sel.length - 1]];
  const A = S.bin.frames[pr[0]], B = S.bin.frames[pr[1]];
  if (S.mode === "swipe") setSrc($("frameB"), S.base + B.file);
  const hd = $("hudDate");
  if (S.mode === "swipe") {
    hd.className = "hud-date";
    hd.innerHTML = `<span class="before">${esc(season(A.epoch))}</span> | <span class="after">${esc(season(B.epoch))}</span>`;
  } else if (S.mode === "trail") {
    hd.className = "hud-date";
    hd.innerHTML = `${esc(L("vw.trail", "Trail"))} · ${fs.map((x) => esc(season(x.epoch))).join(" + ")}`;
  } else {
    const r = roleOf(S.idx);
    hd.className = "hud-date " + r;
    hd.innerHTML = (r ? `<b>${r === "before" ? esc(L("vw.before", "Before")) : esc(L("vw.after", "After"))}</b> ` : "") + esc(season(f.epoch, true));
  }
  $("date").textContent = S.mode === "trail" ? L("vw.dateTrail", "Trail of {n} seasons (brightest value of each pixel)", { n: fs.length })
    : L("vw.dateSeason", "Season {ep} · mean date {date}", { ep: f.epoch, date: f.date });
  $("detail").textContent = L("vw.detail", "SPHEREx {det} · {um} µm · {n} images stacked", { det: (f.detectors || []).join("+"), um: fx(f.wavelength_um), n: f.n_images });
  document.querySelectorAll("#seasons .chip").forEach((c) => c.classList.toggle("cur", +c.dataset.i === S.idx && S.mode !== "trail"));
  drawOverlay();
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
  if (S.mode === "blink" && S.playing && S.sel.length > 1) S.timer = setInterval(tick, +$("speed").value);
  $("play").textContent = S.playing ? L("vw.pause", "Pause") : L("vw.play", "Play");
  $("play").setAttribute("aria-pressed", String(!S.playing));
}
function step(d) {
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
  $("frameB").hidden = md !== "swipe";
  $("trail").hidden = md !== "trail";
  $("swipeUi").hidden = md !== "swipe";
  $("play").disabled = md !== "blink";
  if (md === "swipe") S.idx = (pairIdx() || S.sel)[0];
  if (md === "trail") { S.idx = S.sel[S.sel.length - 1]; buildTrail(); }
  if (md === "blink") S.playing = true;
  if (md === "swipe") applySwipe();
  $("modeHint").textContent = L("vw.hint." + md, {
    blink: "Blink: the compared seasons, one after the other.",
    step: "Step: one season at a time (← → keys).",
    swipe: "Swipe: drag the slider to compare the two seasons of the pair.",
    trail: "Trail: the brightest value of each pixel over the seasons; a mover leaves a streak.",
  }[md]);
  show(); restart();
  if (!quiet) writeUrl();
}
function applySwipe() {
  const st = $("stage"), v = +$("swipe").value / 100, Sw = st.clientWidth, W = pngSize()[0];
  const xs = Sw * v, xp = (xs - S.tx) / (S.k || 1);
  $("frameB").style.clipPath = `inset(0 0 0 ${Math.max(0, Math.min(W, xp)).toFixed(1)}px)`;
  $("swipeLine").style.left = xs.toFixed(1) + "px";
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
    h += `<button type="button" class="chip${on ? " on" : ""}${r ? " " + r : ""}" data-i="${i}" aria-pressed="${on}" ` +
      `title="${esc(on ? L("vw.chip.remove", "Remove from the comparison ({n} images, mean date {date})", { n: f.n_images, date: f.date })
        : L("vw.chip.add", "Add to the comparison ({n} images, mean date {date})", { n: f.n_images, date: f.date }))}">` +
      `<b>${esc(season(f.epoch))}</b><small>${esc(L("vw.chip.img", "{n} img", { n: f.n_images }))}</small></button>`;
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
    line = `<b class="before">${esc(season(A.epoch))}</b> ↔ <b class="after">${esc(season(B.epoch))}</b>: ` +
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
  if (S.mode === "trail") { buildTrail(); S.idx = S.sel[S.sel.length - 1]; }
  if (S.mode === "swipe") S.idx = (pairIdx() || S.sel)[0];
  renderResult(); pairDiff(); watchHint();
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
function selectBin(i, sel) {
  S.bi = i; S.bin = S.bins[i];
  const n = S.bin.frames.length;
  S.sel = sel && sel.length ? sel : defaultSel();
  S.idx = S.sel[0];
  S.trailKey = null;
  S.bin.frames.forEach((f) => { const im = new Image(); im.src = S.base + f.file; });   // smooth blinking
  setSrc($("diff"), S.base + S.bin.diff);
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
  $("diffKey").innerHTML =
    `<span class="k"><i class="sw blue"></i><b>${esc(L("vw.diff.blue", "Blue = before"))}</b><small>${esc(L("vw.diff.brighterIn", "brighter in {s}", { s: season(A.epoch) }))}</small></span>` +
    `<span class="k"><i class="sw white"></i><b>${esc(L("vw.diff.white", "White"))}</b><small>${esc(L("vw.diff.noChange", "no change"))}</small></span>` +
    `<span class="k"><i class="sw red"></i><b>${esc(L("vw.diff.red", "Red = after"))}</b><small>${esc(L("vw.diff.brighterIn", "brighter in {s}", { s: season(B.epoch) }))}</small></span>`;
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
  if (S.zoom !== S.defaultZoom) p.set("z", String(S.zoom)); else p.delete("z");
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
const tile = (k, b, small, cls = "") => `<div class="tile ${cls}"><span class="k">${k}</span><b>${b}</b><small>${small}</small></div>`;
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
  let tMeas, tRef, verdict = "", note = "", mainNote = false;
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
    verdict = esc(ptext(ms.message || ""));
  }
  $("tiles").innerHTML = tMeas + tRef + tImg + tSea;
  $("verdict").innerHTML = verdict;
  const pn = $("pairNote");
  pn.hidden = !note;
  pn.className = "pairnote" + (note && !(mainNote || /headline pair \(same|strongest change in this/.test(note)) ? " alt" : "");
  pn.innerHTML = note;
  const hb = pn.querySelector("[data-headline]");
  if (hb) hb.onclick = goHeadline;
  // badge: saturated core, measured from the wings
  const det = ms.detection || {};
  const satBins = new Set();
  (det.bins || []).forEach((c) => { if (c.saturated_frac > 0.5) satBins.add(c.wavelength_um); });
  ((ms.photometry || {}).bins || []).forEach((b) => { if (b.saturated) satBins.add(b.wavelength_um); });
  const sb = $("satBadge");
  sb.hidden = !satBins.size;
  if (satBins.size) {
    sb.innerHTML = esc(L("vw.sat.badge", "Core saturated, measured from the wings"));
    sb.title = L("vw.sat.tip", "The star is so bright that its centre fills the detector pixels to the top (the white core) at {um} µm. ",
      { um: [...satBins].sort((a, b) => a - b).map((v) => loc(v.toFixed(1))).join(lang() === "tr" ? "; " : ", ") }) +
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
  const name = m.target && !/^(none|null)$/i.test(m.target) ? tname(m.target) : L("vw.skyField", "Sky field");
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
  const m = S.meta, ms = m.measured || {}, ref = S.ref.label;
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
  const m = S.meta, ms = m.measured || {}, name = esc(m.target ? tname(m.target) : L("vw.g.theTarget", "the target"));
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

  // zoom: ?z=, else 4x around the target (a preview's smaller region: 3x shows about the same sky)
  const pv = m.preview;
  S.defaultZoom = (m.measured || {}).photometry ? 2 : pv && pv.fov_deg && pv.fov_deg < 0.15 ? 3 : 4;   // brightness: show the comparison stars
  const zq = +Q.get("z");
  S.zoom = [1, 2, 3, 4, 6].includes(zq) ? zq : S.defaultZoom;
  $("zoom").value = String(S.zoom);
  S.mode = ["blink", "step", "swipe", "trail"].includes(Q.get("mode")) ? Q.get("mode") : "blink";

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
  $("play").onclick = () => { if (S.mode !== "blink") setMode("blink"); else { S.playing = !S.playing; restart(); } };
  $("prev").onclick = () => step(-1);
  $("next").onclick = () => step(1);
  $("speed").oninput = (e) => { $("speedv").textContent = e.target.value + " ms"; restart(); };
  $("mark").onchange = () => drawOverlay();
  $("arrowOn").onchange = () => drawOverlay();
  $("zoom").onchange = (e) => { S.zoom = +e.target.value; layout(); writeUrl(); };
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
      $("play").textContent = S.playing ? L("vw.pause", "Pause") : L("vw.play", "Play");
      if (S.game && S.game.revealed) reveal(S.game.hit);
      else if (S.game) { gameMsg(esc((S.meta.measured || {}).photometry ? t("vw.g.askBright") : t("vw.g.askMove")), "ask"); $("gameBtn").textContent = L("vw.g.showMe", "Show me"); }
      else $("gameBtn").textContent = L("vw.g.find", "Find the mover");
    } catch (e) { console.warn("viewer language switch", e); }
  });
  return {
    meta: m, base: S.base,
    current: () => ({ frame: S.bin && S.bin.frames[S.idx], bin_um: S.bin && S.bin.wavelength_um }),
    setMarking(api) { S.marking = api || null; },
    fallbackSentence() {
      const box = $("explainSentence");
      if (box.textContent.trim()) return;
      const t = ok(ms.shift_arcsec) ? L("vw.fb.moved", "{name} moved {s} between {a} and {b}.", { name: tname(m.target), s: arcsec(ms.shift_arcsec, ms.shift_err_arcsec), a: season(ms.from_epoch, true), b: season(ms.to_epoch, true) })
        : ms.photometry ? L("vw.fb.bright", "{name} changes brightness between the SPHEREx seasons.", { name: tname(m.target) }) : ptext(ms.message || "");
      box.innerHTML = t ? `<p>${esc(t)}</p>` : "";
    },
    on(fn) { if (typeof fn === "function") S.listeners.push(fn); },
  };
}
