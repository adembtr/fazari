// Spectrum chart for the result viewers. Plain inline SVG, no library.
//   ornek.html: mountFromUrl(el, base) reads <base>spectrum.json (written by pipeline/spectrum.py,
//               the local engine's post-step); the card stays hidden when there is none.
//   sky.html:   renderSpectrum(el, spec, {csvUrl}) with the in-browser engine's spectrum
//               (site/js/spectrum.js, same format "fazari-spectrum/1").
// Flux against wavelength; seasons in different colours AND marker shapes; error bars;
// non-detections as 3-sigma upper limits (down arrows); saturated wing estimates as hollow
// markers, never as normal points; saturated exposures without an estimate as ticks on the axis.

import * as I18N from "./i18n.js";

const NS = "http://www.w3.org/2000/svg";
// i18n: English from the code, Turkish from site/i18n/tr.json ("sp.*")
const T = (key, en, p) => (I18N.lang() === "tr" ? I18N.t(key, p, en) : p ? en.replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : en);
const L1 = (s) => I18N.loc(s);
// season colours (validated for the dark card #151925: first three pass every CVD / normal-vision
// check all-pairs; a 4th season relies on its marker shape as well) and shapes
const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#9085e9", "#e66767"];
export const SEASON_COLORS = COLORS;       // shared: the brightness-over-time chart (js/gr.js) and the image marks use the same ones
const SHAPES = ["circle", "square", "triangle", "diamond", "circle", "square"];
const DET_EDGES = [1.095, 1.625, 2.415, 3.825, 4.415];
const DETS = [[0.75, 1.095, "D1"], [1.095, 1.625, "D2"], [1.625, 2.415, "D3"], [2.415, 3.825, "D4"], [3.825, 4.415, "D5"], [4.415, 5.0, "D6"]];

const STYLE = `
.spx { --fg:#e8eaf0; --mut:#9aa3b2; --grid:#262c3c; --axis:#4a5368; --surf:#151925; }
.spx .spx-head { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; margin:2px 0 6px; }
.spx .spx-seg { display:inline-flex; border:1px solid #333b50; border-radius:6px; overflow:hidden; }
.spx .spx-seg button { border:0; border-radius:0; min-width:0; padding:3px 9px; font-size:.85rem; background:#1b2030; color:var(--mut); white-space:nowrap; }
.spx .spx-seg button.on { background:#2a3146; color:var(--fg); }
.spx .spx-chips { display:flex; flex-wrap:wrap; gap:4px 6px; }
.spx .spx-chip { display:inline-flex; align-items:center; gap:6px; font-size:.82rem; padding:2px 8px; border-radius:999px;
                 border:1px solid #333b50; background:#1b2030; color:var(--fg); cursor:pointer; min-width:0; white-space:nowrap; }
.spx .spx-chip.off { opacity:.4; }
.spx .spx-plot { position:relative; }
.spx svg { display:block; width:100%; height:auto; overflow:visible; }
.spx .spx-tip { position:absolute; pointer-events:none; background:#0f121a; border:1px solid #333b50; border-radius:6px;
                padding:6px 8px; font-size:.8rem; line-height:1.35; color:var(--mut); white-space:nowrap; z-index:2; }
.spx .spx-tip b { color:var(--fg); font-size:.9rem; }
.spx .spx-key { font-size:.8rem; color:var(--mut); margin:4px 0 0; display:flex; flex-wrap:wrap; gap:2px 14px; align-items:center; }
.spx .spx-key svg { display:inline-block; width:14px; height:14px; vertical-align:-2px; }
.spx .spx-note { font-size:.8rem; color:var(--mut); margin:4px 0 0; }
.spx .spx-links a { color:#ffb347; font-size:.85rem; margin-right:12px; }
.spx details table { font-size:.8rem; }
.spx .spx-cmp { display:flex; flex-wrap:wrap; gap:2px 16px; font-size:.84rem; color:var(--fg); margin:2px 0 4px; }
.spx .spx-cmp span::before { content:""; display:inline-block; width:16px; height:3px; border-radius:2px; margin-right:6px; vertical-align:3px; background:var(--c); }
`;
// compare view (the result layout of sky.html, js/ch_sky.js): the point in the middle and a tapped star in one chart
const CMP_MAIN = "#ffc94d", CMP_OTHER = "#7fd4ff";

function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function h(tag, attrs = {}, text = null, parent = null) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const fin = (v) => v !== null && Number.isFinite(v);

/** "512 µJy", "12.3 mJy", "9.7 Jy". */
export function fmtFlux(v, digits = 3) {
  if (!fin(v)) return "–";
  const a = Math.abs(v);
  const p = (x) => Number(x.toPrecision(digits)).toString();
  if (a >= 1e6) return L1(p(v / 1e6)) + " Jy";
  if (a >= 1e3) return L1(p(v / 1e3)) + " mJy";
  return L1(p(v)) + " µJy";
}

function marker(g, shape, x, y, r, { fill, stroke, sw = 1.5 }) {
  let m;
  if (shape === "square") m = el("rect", { x: x - r * 0.9, y: y - r * 0.9, width: r * 1.8, height: r * 1.8 }, g);
  else if (shape === "triangle") m = el("path", { d: `M${x} ${y - r * 1.15}L${x + r * 1.05} ${y + r * 0.75}L${x - r * 1.05} ${y + r * 0.75}Z` }, g);
  else if (shape === "diamond") m = el("path", { d: `M${x} ${y - r * 1.2}L${x + r * 1.1} ${y}L${x} ${y + r * 1.2}L${x - r * 1.1} ${y}Z` }, g);
  else m = el("circle", { cx: x, cy: y, r }, g);
  m.setAttribute("fill", fill);
  m.setAttribute("stroke", stroke);
  m.setAttribute("stroke-width", sw);
  return m;
}

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * span; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Points to draw for the current view: [{x: um, y, err, ul, kind, season, row}] */
function viewPoints(spec, mode) {
  if (mode === "binned") {
    return (spec.binned || []).filter((b) => b.kind === "measured" || b.kind === "saturated_wing").map((b) => ({
      x: num(b.wavelength_um), xlo: num(b.lam_lo_um), xhi: num(b.lam_hi_um), season: b.season, row: b, bin: true,
      kind: b.kind === "saturated_wing" ? "wing" : b.detected ? "det" : "ul",
      y: num(b.flux_ujy), err: num(b.flux_err_ujy), ul: num(b.upper_limit_ujy),
    }));
  }
  return (spec.points || []).map((p) => ({
    x: num(p.wavelength_um), season: p.season, row: p,
    kind: { detection: "det", nondetection: "ul", saturated_wing: "wing", saturated: "sat", flagged: "flag" }[p.status] || "none",
    y: num(p.flux_ujy), err: num(p.flux_err_ujy), ul: num(p.upper_limit_ujy),
  })).filter((q) => q.kind !== "none");
}

/** Draw the chart into `root` (a .spx element). state: {mode, log, off: Set(season)} */
function draw(root, spec, state) {
  const plot = root.querySelector(".spx-plot");
  plot.textContent = "";
  const W = Math.max(300, Math.round(plot.clientWidth || root.clientWidth || 640));
  const H = Math.round(Math.min(400, Math.max(240, W * 0.52)));
  const small = W < 480;
  const m = { l: small ? 56 : 70, r: 12, t: 22, b: 44 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
                          "aria-label": T("sp.aria", "Spectrum of {name}: flux against wavelength", { name: spec.target ? I18N.tname(spec.target) : T("sp.theSource", "the source") }) }, plot);
  const seasons = spec.seasons || [];
  const sIdx = (s) => Math.max(0, seasons.indexOf(s));
  // saturated exposures without an estimate are not drawn as points (they are not measurements): the wavelength
  // ranges where every exposure is saturated become one grey band "too bright for the camera here"
  const cmp = state.cmp || null;
  const colOf = (p) => (cmp ? (p.cmp ? CMP_OTHER : CMP_MAIN) : COLORS[sIdx(p.season) % COLORS.length]);
  const both = (mode) => viewPoints(spec, mode).concat(cmp ? viewPoints(cmp, mode).map((p) => ({ ...p, cmp: true })) : []);
  const pts = both(state.mode).filter((p) => p.kind !== "sat" && !state.off.has(p.season) && fin(p.x));
  const satBands = (() => {
    const all = viewPoints(spec, "exposures").filter((p) => !state.off.has(p.season) && fin(p.x) && p.kind !== "flag").sort((a, b) => a.x - b.x);
    const runs = []; let cur = null;
    for (const p of all) {
      if (p.kind === "sat") { if (!cur) cur = { lo: p.x, hi: p.x, n: 0 }; cur.hi = p.x; cur.n++; }
      else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    const out = [];
    for (const b of runs) { const l = out[out.length - 1]; if (l && b.lo - l.hi < 0.03) { l.hi = b.hi; l.n += b.n; } else out.push({ ...b }); }
    return out.filter((b) => b.n >= 3);
  })();
  // y range from what is drawn
  const vals = [];
  for (const p of pts) {
    if (p.kind === "ul" && fin(p.ul)) vals.push(p.ul);
    if ((p.kind === "det" || p.kind === "wing" || p.kind === "flag") && fin(p.y)) {
      vals.push(p.y + (fin(p.err) ? p.err : 0));
      vals.push(p.y - (fin(p.err) ? p.err : 0));
    }
  }
  const pos = vals.filter((v) => v > 0);
  const logOk = state.log && pos.length > 0;
  let y0, y1;
  if (logOk) {
    y0 = Math.max(Math.min(...pos) / 1.5, Math.max(...pos) / 1e6);
    y1 = Math.max(...pos) * 1.5;
  } else {
    y0 = Math.min(0, ...vals); y1 = Math.max(1, ...vals);
    const pad = 0.06 * (y1 - y0); y0 = y0 < 0 ? y0 - pad : 0; y1 += pad;
  }
  const X0 = 0.7, X1 = 5.05;
  const sx = (x) => m.l + (x - X0) / (X1 - X0) * (W - m.l - m.r);
  const sy = logOk ? (y) => H - m.b - (Math.log10(Math.max(y, y0)) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0)) * (H - m.t - m.b)
    : (y) => H - m.b - (y - y0) / (y1 - y0) * (H - m.t - m.b);
  const clampY = (y) => Math.max(m.t - 6, Math.min(H - m.b, y));
  // grid, detector bands, axes
  const gGrid = el("g", { stroke: "var(--grid)", "stroke-width": 1 }, svg);
  const yt = logOk ? (() => {                    // decades; 1-2-5 steps when the range is short
    const t = [], few = Math.log10(y1 / y0) < 2.5;
    for (let e = Math.floor(Math.log10(y0)); e <= Math.log10(y1); e++) {
      for (const k of few ? [1, 2, 5] : [1]) { const v = k * 10 ** e; if (v >= y0 && v <= y1) t.push(v); }
    }
    return t;
  })()
    : niceTicks(y0, y1, small ? 4 : 5);
  if (!pts.length) yt.length = 0;                // nothing measured in this view (e.g. saturated everywhere): no empty flux axis
  for (const v of yt) el("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, gGrid);
  const gTxt = el("g", { fill: "var(--mut)", "font-size": small ? 11 : 12.5, "font-family": "system-ui, sans-serif" }, svg);
  for (const v of yt) {
    const t = el("text", { x: m.l - 6, y: sy(v) + 4, "text-anchor": "end" }, gTxt);
    t.textContent = fmtFlux(v, 3);
  }
  for (const e of DET_EDGES) el("line", { x1: sx(e), x2: sx(e), y1: m.t - 8, y2: H - m.b, stroke: "var(--grid)", "stroke-dasharray": "2 4" }, svg);
  for (const [a, b, d] of DETS) {
    const t = el("text", { x: sx((a + b) / 2), y: m.t - 8, "text-anchor": "middle", "font-size": small ? 10.5 : 11.5 }, gTxt);
    t.textContent = d;
  }
  if (!logOk && y0 < 0) el("line", { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0), stroke: "var(--axis)", "stroke-width": 1 }, svg);
  el("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: "var(--axis)" }, svg);
  for (const v of (small ? [1, 2, 3, 4, 5] : [0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5])) {
    el("line", { x1: sx(v), x2: sx(v), y1: H - m.b, y2: H - m.b + 4, stroke: "var(--axis)" }, svg);
    const t = el("text", { x: sx(v), y: H - m.b + 17, "text-anchor": "middle" }, gTxt);
    t.textContent = L1(String(v));
  }
  const xl = el("text", { x: (m.l + W - m.r) / 2, y: H - 6, "text-anchor": "middle" }, gTxt);
  xl.textContent = T("gr.sp.xAxis", "Wavelength of the infrared light (µm)");
  const yl = el("text", { x: 12, y: (m.t + H - m.b) / 2, "text-anchor": "middle", transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})` }, gTxt);
  yl.textContent = pts.length ? T("gr.sp.yAxis", "Brightness (flux density)") : "";
  // grey bands: too bright for the camera (saturated, no estimate)
  for (const b of satBands) {
    const xa = sx(Math.max(X0, b.lo - 0.01)), xb = sx(Math.min(X1, b.hi + 0.01));
    el("rect", { x: xa, y: m.t - 2, width: Math.max(2, xb - xa), height: H - m.b - m.t + 2, fill: "#9aa3b2", "fill-opacity": 0.13 }, svg);
    if (xb - xa > 110) {
      // the long sentence only where it fits inside the band (it ran over the chart on a phone); else the short one
      const full = T("gr.sp.band", "Too bright for the camera here (saturated): no measurement"), short = T("ts.sp.bandShort", "Too bright for the camera");
      const cw = small ? 6.3 : 7.1, label = xb - xa > full.length * cw ? full : short;
      if (xb - xa > label.length * cw) {
        const tl = el("text", { x: (xa + xb) / 2, y: (m.t + H - m.b) / 2, "text-anchor": "middle", fill: "#c9d2e3", "font-size": small ? 11.5 : 13, "font-family": "system-ui, sans-serif" }, svg);
        tl.textContent = label;
      }
    }
  }
  // marks: faint exposures behind the binned view, then the view's points
  const gData = el("g", {}, svg);
  if (state.mode === "binned") {
    for (const p of both("exposures")) {
      if (state.off.has(p.season) || p.kind !== "det" || !fin(p.y) || (logOk && p.y <= 0)) continue;
      el("circle", { cx: sx(p.x), cy: clampY(sy(p.y)), r: 1.6, fill: colOf(p), opacity: 0.3 }, gData);
    }
  }
  const hits = [];
  const r = state.mode === "binned" ? 4.5 : 3.2;
  const order = { flag: 0, sat: 0, ul: 1, wing: 2, det: 3 };
  for (const p of pts.slice().sort((a, b) => order[a.kind] - order[b.kind])) {
    const c = colOf(p), shape = SHAPES[sIdx(p.season) % SHAPES.length];
    const X = sx(p.x);
    const g = el("g", {}, gData);
    if (p.kind === "sat") {                      // saturated, no estimate: tick on the axis
      el("path", { d: `M${X} ${H - m.b - 1}l-3.5 -7h7z`, fill: "none", stroke: c, "stroke-width": 1.2, opacity: 0.8 }, g);
      hits.push({ x: X, y: H - m.b - 4, p });
      continue;
    }
    if (p.kind === "ul") {
      if (!fin(p.ul) || (logOk && p.ul <= 0)) continue;
      const Y = clampY(sy(p.ul));
      const len = state.mode === "binned" ? 14 : 9;
      el("path", { d: `M${X} ${Y}v${len}m-3.5 -4.5l3.5 4.5l3.5 -4.5M${X - 4} ${Y}h8`, fill: "none", stroke: c,
                   "stroke-width": state.mode === "binned" ? 1.8 : 1.2, opacity: state.mode === "binned" ? 0.95 : 0.55 }, g);
      hits.push({ x: X, y: Y + 4, p });
      continue;
    }
    if (!fin(p.y) || (logOk && p.y <= 0)) continue;
    const Y = clampY(sy(p.y));
    if (p.bin && fin(p.xlo) && fin(p.xhi)) el("line", { x1: sx(p.xlo), x2: sx(p.xhi), y1: Y, y2: Y, stroke: c, "stroke-width": 1, opacity: 0.6 }, g);
    if (fin(p.err) && p.err > 0) {
      const ya = clampY(sy(p.y + p.err)), yb = clampY(logOk ? sy(Math.max(p.y - p.err, y0)) : sy(p.y - p.err));
      el("line", { x1: X, x2: X, y1: ya, y2: yb, stroke: c, "stroke-width": 1.2, opacity: p.kind === "flag" ? 0.4 : 0.85,
                   ...(p.kind === "wing" ? { "stroke-dasharray": "3 2" } : {}) }, g);
    }
    if (p.kind === "flag") {
      el("path", { d: `M${X - 3} ${Y - 3}l6 6m0 -6l-6 6`, stroke: c, "stroke-width": 1.4, opacity: 0.6 }, g);
    } else if (p.kind === "wing") {
      marker(g, shape, X, Y, r + 0.5, { fill: "var(--surf)", stroke: c, sw: 1.6 });
    } else {
      marker(g, shape, X, Y, r, { fill: c, stroke: "var(--surf)", sw: 1.2 });
    }
    hits.push({ x: X, y: Y, p });
  }
  // hover: nearest mark within 14 px (the hit area is larger than the mark)
  const tip = h("div", { class: "spx-tip", hidden: "" }, null, plot);
  const ring = el("circle", { r: 8, fill: "none", stroke: "var(--fg)", "stroke-width": 1.2, visibility: "hidden" }, svg);
  const move = (ev) => {
    const b = svg.getBoundingClientRect();
    const mx = (ev.clientX - b.left) * W / b.width, my = (ev.clientY - b.top) * H / b.height;
    let best = null, bd = 14 * 14;
    for (const q of hits) { const d = (q.x - mx) ** 2 + (q.y - my) ** 2; if (d < bd) { bd = d; best = q; } }
    if (!best) { tip.hidden = true; ring.setAttribute("visibility", "hidden"); svg.style.cursor = ""; return; }
    svg.style.cursor = canJump() && best.p.season ? "pointer" : "";
    ring.setAttribute("cx", best.x); ring.setAttribute("cy", best.y); ring.setAttribute("visibility", "visible");
    fillTip(tip, best.p, spec);
    tip.hidden = false;
    const left = best.x * b.width / W, top = best.y * b.height / H;
    tip.style.left = Math.min(Math.max(4, left + 12), b.width - tip.offsetWidth - 4) + "px";
    tip.style.top = Math.max(0, top - tip.offsetHeight - 10) + "px";
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; ring.setAttribute("visibility", "hidden"); });
  // click a point: the page shows that visit at that colour in its image (js/ts_flow.js listens; ornek.html only)
  svg.addEventListener("click", (ev) => {
    if (!canJump()) return;
    const b = svg.getBoundingClientRect();
    const mx = (ev.clientX - b.left) * W / b.width, my = (ev.clientY - b.top) * H / b.height;
    let best = null, bd = 14 * 14;
    for (const q of hits) { const d = (q.x - mx) ** 2 + (q.y - my) ** 2; if (d < bd) { bd = d; best = q; } }
    if (best && best.p.season) document.dispatchEvent(new CustomEvent("fazari:chartpick", { detail: { season: best.p.season, um: best.p.x, from: "spectrum" } }));
  });
  if (!pts.length && !satBands.length) {
    const t = el("text", { x: (m.l + W - m.r) / 2, y: (m.t + H - m.b) / 2, "text-anchor": "middle" }, gTxt);
    t.textContent = T("sp.noPoints", "No measured points in this view.");
  }
}

/** Is there an image on this page that can show one visit (agent B's js/viewer.js goTo, ornek.html)? */
function canJump() { try { return !!(document.documentElement.classList.contains("ts-on") && window.__fzViewer && typeof window.__fzViewer.goTo === "function"); } catch (_) { return false; } }

function fillTip(tip, p, spec) {
  tip.textContent = "";
  const r = p.row;
  const lab = (spec.status_labels || {});
  const first = h("div", {}, null, tip);
  if (p.kind === "ul") h("b", {}, "< " + fmtFlux(p.ul), first);
  else if (p.kind === "sat") h("b", {}, T("sp.saturated", "saturated"), first);
  else h("b", {}, fmtFlux(p.y) + (fin(p.err) ? " ± " + fmtFlux(p.err, 2) : ""), first);
  const ab = num(r.ab_mag), abl = num(r.ab_mag_limit);
  if (fin(ab)) first.appendChild(document.createTextNode(`  (AB ${L1(ab.toFixed(2))})`));
  else if (fin(abl)) first.appendChild(document.createTextNode(`  (AB > ${L1(abl.toFixed(2))})`));
  const lam = p.bin ? T("sp.tipBin", "{um} µm (bin {lo}–{hi})", { um: L1(num(r.wavelength_um).toFixed(3)), lo: L1(num(r.lam_lo_um).toFixed(2)), hi: L1(num(r.lam_hi_um).toFixed(2)) })
    : T("sp.tipBand", "{um} µm, band {bw} µm", { um: L1(num(r.wavelength_um).toFixed(3)), bw: L1(num(r.bandwidth_um).toFixed(3)) });
  h("div", {}, `${lam} · ${r.detector} · ${T("sp.season", "season {s}", { s: r.season })}`, tip);
  if (p.bin) {
    h("div", {}, (r.n === 1 ? T("sp.exp.one", "{n} exposure", { n: r.n }) : T("sp.exp.other", "{n} exposures", { n: r.n })) + (r.kind === "saturated_wing" ? T("sp.tipWing", " · saturated (wing estimate)")
      : r.detected ? ` · S/N ${L1(num(r.snr).toFixed(1))}` : T("sp.tipNotDet", " · not detected (3σ upper limit)")), tip);
  } else {
    h("div", {}, T("sp.status." + r.status, lab[r.status] || r.status) + (fin(num(r.snr)) && r.status !== "saturated" ? ` · S/N ${L1(num(r.snr).toFixed(1))}` : ""), tip);
    h("div", {}, `${r.date}` + (r.file ? ` · ${String(r.file).slice(0, 34)}` : ""), tip);
  }
  if (p.season && canJump()) h("div", { style: "opacity:.8;margin-top:2px" }, T("ts.e.jump", "Click: show this visit in the image"), tip);
}

/** Render a spectrum (format fazari-spectrum/1) into container `box`. */
export function renderSpectrum(box, spec, { csvUrl = null, csvName = null, jsonUrl = null, title = "Spectrum", keep = null, compare = null, names = null } = {}) {
  if (!document.getElementById("spx-style")) {
    const st = document.createElement("style");
    st.id = "spx-style";
    st.textContent = STYLE;
    document.head.appendChild(st);
  }
  box.textContent = "";
  box.hidden = false;
  box.classList.add("spx");
  const sm = spec.summary || {};
  const seasons = spec.seasons || [];
  h("h2", {}, title === "Spectrum" ? T("sp.title", "Spectrum") : title, box);
  const dr = sm.detected_range_um;
  const nSat = sm.n_saturated || 0;
  h("p", { class: "spx-note" },
    (seasons.length === 1 ? T("ts.sp.sum.one", "Built from {n} exposures of one visit: each exposure sees this spot in a different infrared colour. ", { n: sm.n_exposures || 0, s: 1 })
      : T("ts.sp.sum.other", "Built from {n} exposures over {s} visits: each exposure sees this spot in a different infrared colour. ", { n: sm.n_exposures || 0, s: seasons.length })) +
    (dr ? T("sp.detAt", "Detected at {lo}–{hi} µm (S/N ≥ 3 in season bins). ", { lo: L1(dr[0].toFixed(2)), hi: L1(dr[1].toFixed(2)) })
      : nSat ? "" : T("sp.noDet", "No wavelength bin with S/N ≥ 3. ")) +
    (nSat ? T("gr.sp.sat", "The star is too bright for the camera in {n} of them (grey band: no measurement there)", { n: nSat }) +
      (sm.n_saturated_wing ? T("gr.sp.satWing", "; hollow markers are rough estimates from its outer glow ({n} exposures)", { n: sm.n_saturated_wing }) : "") + ". " : "") +
    (spec.engine === "browser" ? T("sp.browser", "Measured in your browser from the exposures loaded so far.") : ""), box);
  const head = h("div", { class: "spx-head" }, null, box);
  const anyBins = (spec.binned || []).some((b) => b.kind === "measured" || b.kind === "saturated_wing");
  const det = (spec.points || []).filter((p) => p.status === "detection" || p.status === "saturated_wing").map((p) => num(p.flux_ujy)).filter((v) => v > 0);
  const drawn = det.concat((spec.points || []).filter((p) => p.status === "nondetection").map((p) => num(p.upper_limit_ujy)).filter((v) => v > 0));
  const wide = drawn.length > 3 && Math.max(...drawn) / Math.min(...drawn) > 10;
  const state = keep || { mode: anyBins ? "binned" : "exposures", log: wide || (!det.length && nSat > 0), off: new Set() };
  state.cmp = compare && Array.isArray(compare.points) ? compare : null;    // a second spectrum in the same chart (blue)
  const seg = (labels, key, vals) => {
    const s = h("div", { class: "spx-seg", role: "group" }, null, head);
    labels.forEach((lab, k) => {
      const b = h("button", { type: "button" }, lab, s);
      const sync = () => [...s.children].forEach((c, j) => c.classList.toggle("on", state[key] === vals[j]));
      b.onclick = () => { state[key] = vals[k]; sync(); draw(box, spec, state); };
      sync();
    });
  };
  seg([T("sp.binned", "Season bins"), T("sp.every", "Every exposure")], "mode", ["binned", "exposures"]);
  seg([T("sp.linear", "Linear"), T("sp.log", "Log")], "log", [false, true]);
  const chips = h("div", { class: "spx-chips" }, null, head);
  seasons.forEach((s, k) => {
    const c = h("button", { type: "button", class: "spx-chip" + (state.off.has(s) ? " off" : ""), "aria-pressed": String(!state.off.has(s)), title: T("sp.chipTip", "Show or hide this season") }, null, chips);
    const ic = document.createElementNS(NS, "svg");
    ic.setAttribute("viewBox", "0 0 14 14"); ic.setAttribute("width", 14); ic.setAttribute("height", 14);
    marker(ic, SHAPES[k % SHAPES.length], 7, 7, 4, { fill: COLORS[k % COLORS.length], stroke: "none" });
    c.appendChild(ic);
    c.appendChild(document.createTextNode(s));
    c.onclick = () => {
      if (state.off.has(s)) state.off.delete(s); else state.off.add(s);
      c.classList.toggle("off", state.off.has(s));
      c.setAttribute("aria-pressed", String(!state.off.has(s)));
      draw(box, spec, state);
    };
  });
  if (state.cmp) {                               // which curve is which
    const lg = h("div", { class: "spx-cmp" }, null, box);
    h("span", { style: `--c:${CMP_MAIN}` }, (names && names[0]) || T("cp.sp.centre", "Point in the middle"), lg);
    h("span", { style: `--c:${CMP_OTHER}` }, (names && names[1]) || T("cp.sp.tap", "Star with the blue ring"), lg);
  }
  h("div", { class: "spx-plot" }, null, box);
  // key for the marker styles (identity of the seasons is in the chips above)
  const key = h("div", { class: "spx-key" }, null, box);
  const item = (txt, fn) => {
    const s = h("span", {}, null, key);
    const ic = document.createElementNS(NS, "svg");
    ic.setAttribute("viewBox", "0 0 14 14");
    fn(ic);
    s.appendChild(ic);
    s.appendChild(document.createTextNode(" " + txt));
  };
  const has = (st) => (spec.points || []).some((p) => p.status === st);
  if (has("detection")) item(T("sp.k.measured", "measured"), (g) => marker(g, "circle", 7, 7, 4, { fill: "#9aa3b2", stroke: "none" }));
  if (has("nondetection")) item(T("gr.sp.k.ul", "not seen: fainter than this"), (g) => el("path", { d: "M7 2v9m-3.5 -4.5l3.5 4.5l3.5 -4.5M3 2h8", fill: "none", stroke: "#9aa3b2", "stroke-width": 1.5 }, g));
  if (has("saturated_wing")) item(T("gr.sp.k.wing", "too bright: rough estimate from the outer glow"), (g) => marker(g, "circle", 7, 7, 4.5, { fill: "none", stroke: "#9aa3b2", sw: 1.6 }));
  if (has("saturated")) item(T("gr.sp.k.sat", "too bright for the camera (saturated): no measurement"), (g) => el("rect", { x: 1, y: 1, width: 12, height: 12, fill: "#9aa3b2", "fill-opacity": 0.35 }, g));
  if (has("flagged")) item(T("sp.k.flag", "flagged pixels"), (g) => el("path", { d: "M3 3l8 8m0 -8l-8 8", stroke: "#9aa3b2", "stroke-width": 1.5 }, g));
  const links = h("p", { class: "spx-note spx-links" }, null, box);
  if (csvUrl) h("a", { href: csvUrl, download: csvName || "spectrum.csv" }, T("sp.csv", "Download CSV"), links);
  if (jsonUrl) h("a", { href: jsonUrl, target: "_blank", rel: "noopener" }, "spectrum.json", links);
  links.appendChild(document.createTextNode(T("sp.method", "PSF-fit flux (checked against 2MASS and WISE on field stars: within ±7 %); AB = 23.9 − 2.5 log₁₀(flux/µJy). "
    + "Wing estimates of saturated exposures are rough (often 10–40 % low, up to ×2 off).")));
  // table view (same numbers as the chart's season bins)
  const det2 = h("details", {}, null, box);
  h("summary", {}, T("sp.tableSum", "Table: season bins"), det2);
  const tb = h("table", {}, null, det2);
  const hr = h("tr", {}, null, tb);
  for (const c of [T("sp.th.season", "Season"), T("sp.th.lam", "λ (µm)"), T("sp.th.det", "Detector"), "N", T("sp.th.flux", "Flux"), "±", T("sp.th.note", "Note")]) h("th", {}, c, hr);
  for (const b of spec.binned || []) {
    if (b.kind === "none") continue;
    const tr = h("tr", {}, null, tb);
    const ul = b.kind === "measured" && !b.detected;
    for (const v of [b.season, L1(num(b.wavelength_um).toFixed(3)), b.detector, String(b.n),
                     ul ? "< " + fmtFlux(num(b.upper_limit_ujy)) : fmtFlux(num(b.flux_ujy)), ul ? "" : fmtFlux(num(b.flux_err_ujy), 2),
                     b.kind === "saturated_wing" ? T("sp.k.wing", "saturated (wing estimate)") : ul ? T("sp.ul", "3σ upper limit") : `S/N ${L1(num(b.snr).toFixed(1))}`]) {
      h("td", {}, v, tr);
    }
  }
  const doDraw = () => draw(box, spec, state);
  doDraw();
  box.__spxDraw = doDraw;
  if (typeof ResizeObserver === "function" && !box.__spxRO) {
    let w0 = box.clientWidth;
    box.__spxRO = new ResizeObserver(() => { if (Math.abs(box.clientWidth - w0) > 8) { w0 = box.clientWidth; box.__spxDraw(); } });
    box.__spxRO.observe(box);
  }
  // language switch: render again with the same view (season bins / exposures, log, hidden seasons)
  box.__spxArgs = { spec, opts: { csvUrl, csvName, jsonUrl, title, keep: state, compare, names } };
  if (!box.__spxLang) {
    box.__spxLang = true;
    I18N.onLang(() => { const a = box.__spxArgs; if (a && box.isConnected) { const open = box.querySelector("details")?.open; renderSpectrum(box, a.spec, a.opts); if (open) box.querySelector("details").open = true; } });
  }
  return { redraw: doDraw, state };
}

/** ornek.html: show <base>spectrum.json if the result has one; keep `box` hidden otherwise. */
export async function mountFromUrl(box, base) {
  if (!box) return null;
  try {
    const r = await fetch(base + "spectrum.json", { cache: "no-store" });
    if (!r.ok) return null;
    const spec = await r.json();
    if (!spec || !Array.isArray(spec.points)) return null;
    // the same file feeds the brightness-over-time chart (js/ts_flow.js + js/gr.js timeChart): one download for both
    try { window.__fzSpectrum = { spec, base }; document.dispatchEvent(new CustomEvent("fazari:spectrum", { detail: { spec, base } })); } catch (_) { /* no DOM */ }
    const slug = String(spec.target || "source").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return renderSpectrum(box, spec, { csvUrl: base + "spectrum.csv", csvName: `${slug}_spectrum.csv`, jsonUrl: base + "spectrum.json" });
  } catch (_) {
    return null;
  }
}
