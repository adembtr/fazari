// UI of sky.html: input -> sky index -> Engine (SkySession in a Web Worker) -> blink,
// difference, motion. The main thread only resolves the input, draws and reacts.
// Order: a quick preview first (one wavelength, 2 then up to 4 exposures per season, small
// regions, no calibration; labelled "Preview (N images)"), then the full result in the
// background (all wavelengths, Gaia calibration; "Full result (N images)"). ?preview=0 = old flow.
// Inside the explorer (iframe) the stage is also posted to the parent ({type: "fazari-stage"}).
import { CONFIG } from "./sky.js";
import { Engine, workersSupported } from "./engine.js";
import { TanGrid } from "./wcs.js";
import { TARGETS } from "./targets.js";
import { parseCoords, matchTarget, sesame } from "./resolve.js";
import { highPmStars } from "./gaia.js";
import { propagate, offsetArcsec, jyearToMjd } from "./astro.js";
import { t, tn, num, loc, lang, tname, onLang } from "./i18n.js";
import { fovFromUrl, fovFor, fillFovSelect, fovEstimateText, setFovInUrl } from "./fov.js";
import * as GR from "./gr.js";   // speed per year, number line, catalogue at a free point, limit line (grafikler)
import { speedOf, speedText, scaleText, significant } from "./motion_arrow.js";   // measured-motion arrow, drawn at true length (ilk_izlenim, goruntu_tur)
import * as FR from "./fz_frames.js";            // display processing shared with the result viewer: sky match, alignment, one scale, smooth drawing (goruntu_tur)
import { progressInfo as pictureProgress } from "./fz_view.js";    // the one progress line on the picture, read from the wavelength buttons

// Sky index: the real module (skyindex.js) when it is there, else the dev stand-in.
// To switch for good, change this one line.
const INDEX_MODULES = ["./skyindex.js", "./skyindex_dev.js"];

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// Device profile: phones / low memory get a lighter default (fewer exposures, smaller cache).
const small = typeof matchMedia === "function" && matchMedia("(max-width: 640px), (pointer: coarse) and (max-width: 900px)").matches;
const lowMem = typeof navigator !== "undefined" && navigator.deviceMemory && navigator.deviceMemory <= 4;
export const PROFILE = (small || lowMem || params.get("profile") === "phone") && params.get("profile") !== "desktop"
  ? { name: "phone", cap: 2, cacheBytes: 48 * 1024 * 1024 }
  : { name: "desktop", cap: 4, cacheBytes: 192 * 1024 * 1024 };
const WORKER = params.get("worker") !== "0" && workersSupported();
let netStats = { bytes: 0, requests: 0, retries: 0 };

let indexMod = null, indexName = "";
async function loadIndex() {
  if (indexMod) return indexMod;
  const list = params.get("index") === "dev" ? ["./skyindex_dev.js"] : INDEX_MODULES;
  for (const m of list) {
    try { indexMod = await import(m); indexName = m.replace("./", ""); return indexMod; } catch (_) { /* next */ }
  }
  throw new Error("no sky index module could be loaded");
}

// ---- state ---------------------------------------------------------------------------------
let run = null;            // {ctl, engine, info, results, astro, target, ...}
let current = null;        // displayed bin result
let frameIdx = 0, timer = null, playing = true;
let fieldStars = [];       // Gaia high-PM stars (other coordinates)
window.__fzSky = () => ({ run, current, frameIdx, fieldStars });   // read-only view for the challenge tools (ch_sky.js)
// the result layout (js/ts_flow.js season strip, js/cp_save.js PNG / GIF): show season i; Go also pauses the film
window.__fzSkyShow = (i) => { if (current && i >= 0 && i < current.frames.length) { frameIdx = i; showFrame(); } };
window.__fzSkyGo = (i) => { if (!current || !(i >= 0 && i < current.frames.length)) return; playing = false; startBlink(); frameIdx = i; showFrame(); };
const t0 = { start: 0 };

let lastStatus = null;     // [msg, kind]; msg may be a function, re-run when the language changes
function setStatus(msg, kind = "") {
  lastStatus = [msg, kind];
  const el = $("status");
  el.textContent = typeof msg === "function" ? msg() : msg;
  el.className = "status " + kind;
}
// Text that follows the language switch: element id -> function that builds it (cleared per run).
const live = new Map();
function setLive(id, fn) { live.set(id, fn); $(id).textContent = fn(); }
function fmtMB(b) { return (b / 1e6).toFixed(1) + " MB"; }

let progressInfo = { checked: 0, accepted: 0, done: 0 };
let rafPending = false;
// One bar for the whole run (u3): each step covers [base, base + span] of it (preview 0-15 %, then the
// wavelengths in equal parts); it never goes backwards. 0 while the images are still being looked up
// (the striped "busy" bar = honestly unknown). Time left only once the full result has made progress.
let prog = { base: 0, span: 0, f: 0, tFull: 0 };
function progStep(base, span) { prog.base = base; prog.span = span; if (base >= 0.15 && !prog.tFull) prog.tFull = performance.now(); }
function waitText(s) { return s >= 90 ? t("ex.eng.min", { n: Math.round(s / 60) }) : t("ex.eng.sec", { n: Math.max(5, Math.round(s / 5) * 5) }); }
function renderProgress() {
  rafPending = false;
  if (!run) return;
  const sec = ((performance.now() - t0.start) / 1000).toFixed(1);
  $("progress").textContent = t("sk.progress", { done: progressInfo.done, accepted: progressInfo.accepted, checked: progressInfo.checked,
    mb: loc(fmtMB(netStats.bytes)), req: netStats.requests })
    + (netStats.retries ? t("sk.progress.retries", { n: netStats.retries }) : "") + ` · ${loc(sec)} s`;
  const p = progressInfo.accepted ? Math.min(1, progressInfo.done / progressInfo.accepted) : 0;
  prog.f = run.complete ? 1 : Math.max(prog.f, Math.min(0.99, prog.base + prog.span * p));
  $("bar").style.width = `${(prog.f * 100).toFixed(1)}%`;
  $("bar").parentElement.setAttribute("aria-valuenow", String(Math.round(prog.f * 100)));
  let eta = "";
  if (!run.finished && prog.tFull && prog.f > 0.2) {
    const el = (performance.now() - prog.tFull) / 1000, rate = (prog.f - 0.15) / el;
    if (rate > 0) eta = " · " + waitText((1 - prog.f) / rate);
  }
  $("eta").textContent = run.finished || !prog.f ? "" : `${Math.round(prog.f * 100)} %` + eta;
}
function queueProgress() { if (!rafPending) { rafPending = true; requestAnimationFrame(renderProgress); } }
function onNet(st) { netStats = st; queueProgress(); }
function onStatus(msg) { if (run && !run.finished) setStatus(msg, "warn"); }
function busy(on) { $("cancel").hidden = !on; $("bar").parentElement.classList.toggle("busy", on); }

// ---- rendering --------------------------------------------------------------------------------
function grayImageData(norm, n) {
  const id = new ImageData(n, n);
  for (let k = 0; k < n * n; k++) {
    const g = Math.round(Math.min(1, Math.max(0, norm[k])) * 255);
    id.data[4 * k] = id.data[4 * k + 1] = id.data[4 * k + 2] = g; id.data[4 * k + 3] = 255;
  }
  return id;
}
// blue - white - red (like matplotlib RdBu_r)
const RDBU = [[5, 48, 97], [33, 102, 172], [67, 147, 195], [146, 197, 222], [209, 229, 240], [247, 247, 247],
              [253, 219, 199], [244, 165, 130], [214, 96, 77], [178, 24, 43], [103, 0, 31]];
function divergingImageData(d, n, lim) {
  const id = new ImageData(n, n);
  for (let k = 0; k < n * n; k++) {
    let c = [128, 128, 128];
    if (Number.isFinite(d[k])) {
      const v = Math.min(1, Math.max(0, (d[k] / lim + 1) / 2)) * (RDBU.length - 1);
      const i = Math.min(RDBU.length - 2, Math.floor(v)), t = v - i;
      c = RDBU[i].map((x, j) => x + (RDBU[i + 1][j] - x) * t);
    }
    id.data[4 * k] = c[0]; id.data[4 * k + 1] = c[1]; id.data[4 * k + 2] = c[2]; id.data[4 * k + 3] = 255;
  }
  return id;
}

// ---- the picture (goruntu_tur): the seasons of the bin on screen through js/fz_frames.js -----------------------
// Display only: every season gets the same brightness scale, its own sky level is taken out, the seasons are lined
// up on the field stars and drawn smooth. The measured numbers come from the engine and are not touched.
// "Raw pixels" (a switch added next to the other picture switches) shows the engine's own frame as squares.
const VISIT_COLOURS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#9085e9", "#e66767"];   // one per visit, as in the result viewer and the charts
const visitColour = (i) => VISIT_COLOURS[((i % VISIT_COLOURS.length) + VISIT_COLOURS.length) % VISIT_COLOURS.length];
const fz = { of: null, refs: null, set: null, tiles: new Map(), up: 1, img: null, off: null, raw: false, zoomFor: null };
const fzUp = (n) => Math.max(1, Math.min(6, Math.round(900 / n)));
/** The processed frames of `current` (made once per bin; again when its frames change), or null (then the engine's frame is shown). */
function fzSet() {
  const refs = current.frames.map((f) => f.norm);
  if (fz.of === current && fz.refs && fz.refs.length === refs.length && fz.refs.every((r, i) => r === refs[i])) return fz.set;
  fz.of = current; fz.refs = refs; fz.set = null; fz.tiles.clear();
  try {
    const n = current.n, g = current.frames[0] && current.frames[0].gaiaXY, st = current.stretch;
    if (current.frames.length && current.frames.every((f) => f.norm && f.norm.length === n * n)) {
      fz.set = FR.prepare(current.frames.map((f) => ({ g: f.norm })), { nx: n, ny: n, cellArcsec: run.info.pixArcsec, centre: g || [n / 2, n / 2],
        targets: current.frames.map((f) => f.gaiaXY).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1])),   // a faint target sets the scale
        stretch: st && st.soft > 0 && st.hi > st.lo ? { type: "asinh", lo: st.lo, hi: st.hi, soft: st.soft } : null });
      fz.up = fzUp(n);
    }
  } catch (e) { console.warn("picture processing", e); fz.set = null; }
  return fz.set;
}
/** Frame i (or "d": last minus first) as picture pixels on the finer grid: { id: ImageData, up } or null. */
function fzPicture(i) {
  const set = fzSet();
  if (!set) return null;
  const n = current.n, up = fz.raw ? 1 : fz.up, W = n * up, key = (fz.raw ? "r" : "s") + up;
  const tile = (k) => { const q = key + k; if (!fz.tiles.has(q)) fz.tiles.set(q, FR.frameFloat(set, k, up, fz.raw)); return fz.tiles.get(q); };
  if (!fz.img || fz.img.width !== W) fz.img = new ImageData(W, W);
  if (i === "d") {
    FR.diffRgba(tile(0), tile(set.n - 1), fz.img.data);
    // saturated cores are not data (the engine marks them in its own difference): grey, as before
    const d = current.diff, px = fz.img.data;
    if (d) for (let k = 0; k < n * n; k++) {
      if (Number.isFinite(d[k])) continue;
      const x0 = (k % n) * up, y0 = ((k / n) | 0) * up;
      for (let b = 0; b < up; b++) for (let a = 0; a < up; a++) { const o = 4 * ((y0 + b) * W + x0 + a); px[o] = px[o + 1] = px[o + 2] = 128; }
    }
  } else FR.greyRgba(tile(i), fz.img.data, fz.raw ? 1 : set.disp.gamma);
  return { id: fz.img, up };
}
/** The "Raw pixels" switch and its one-line note: added once, next to the page's own picture switches. */
function fzSwitch() {
  if ($("fzRawSky") || !$("cent")) return;
  const lab = document.createElement("label");
  lab.innerHTML = `<input id="fzRawSky" type="checkbox"> <span></span>`;
  ($("cent").closest("label") || $("cent")).after(lab);
  const note = document.createElement("span");
  note.id = "fzRawNote"; note.className = "small";
  const cap = $("fieldnote");
  if (cap) cap.after(" ", note);
  const paint = () => {
    lab.querySelector("span").textContent = t("fz.zoom.raw", null, "Raw pixels (no smoothing)");
    const set = fz.set, a = run && run.info ? run.info.pixArcsec : 3;
    note.textContent = fz.raw ? t("fz.note.raw", { c: loc(String(a)) }, "Raw pixels: the stacked frame as it is, on its {c}″ grid, no smoothing. One SPHEREx detector pixel is 6.15″.")
      : set ? t("fz.note.smooth", null, "Picture: one brightness scale for every visit, sky level matched, drawn smooth") +
        (set.aligned ? t("fz.note.aligned", { n: Math.max(0, ...set.reg.slice(1).map((r) => r.n || 0)), s: loc((Math.max(0, ...set.shift.map((s) => Math.hypot(s[0], s[1]))) * a).toFixed(2)) }, ", visits lined up on {n} field stars (moved by up to {s}″)") : "") +
        (set.disp && set.disp.targetPeak != null ? t("fz.note.target", null, ", brightness set by the faint target so that it shows") : "") +
        (set.disp && (set.disp.noisy || []).some(Boolean) ? t("fz.note.noisy", null, ", the faint speckle of the noisier visit cut a little more") : "") +
        t("fz.note.tail", null, ". One SPHEREx pixel is 6.15″. The measured numbers are not changed by this.") : "";
  };
  $("fzRawSky").onchange = (e) => { fz.raw = e.target.checked; paint(); showFrame(); showDiff(); };
  fz.paintNote = paint;
  onLang(paint);
  paint();
}

function drawToCanvas(canvas, imageData, n, zoom, up = 1, smooth = false) {
  if (!fz.off) fz.off = document.createElement("canvas");            // one working canvas, reused (not one per frame)
  const off = fz.off;
  if (off.width !== imageData.width || off.height !== imageData.height) { off.width = imageData.width; off.height = imageData.height; }
  off.getContext("2d").putImageData(imageData, 0, 0);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = "high";
  const src = n / zoom, s0 = (n - src) / 2;
  ctx.drawImage(off, s0 * up, s0 * up, src * up, src * up, 0, 0, canvas.width, canvas.height);
  return (gx, gy) => [((gx + 0.5) - s0) * canvas.width / src, ((gy + 0.5) - s0) * canvas.height / src];
}

function drawOverlay(canvas, toCanvas, frame, zoom) {
  const ctx = canvas.getContext("2d");
  const pxPerArcsec = canvas.width / (current.n / zoom) / run.info.pixArcsec;
  ctx.lineWidth = 2;
  if ($("mark").checked && frame.gaiaXY) {
    // a thin ring where the catalogue puts the object in this season, and a fainter one around it
    const [x, y] = toCanvas(...frame.gaiaXY), r = Math.min(Math.max(13, 11 * pxPerArcsec), 60);
    ctx.lineWidth = 3.4; ctx.strokeStyle = "rgba(5,7,13,.6)"; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = "#ffb347"; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 1.1; ctx.strokeStyle = "rgba(255,179,71,.38)"; ctx.beginPath(); ctx.arc(x, y, 2 * r, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 2;
  }
  if ($("mark").checked && fieldStars.length && run) {
    ctx.strokeStyle = "#5ad1ff";
    const grid = current.n === run.info.n ? run.grid : new TanGrid(run.info.ra0, run.info.dec0, run.info.pixArcsec, current.n);
    for (const s of fieldStars) {
      const [gx, gy] = grid.skyToPix(...propagate(s, frame.mjdMean));
      if (gx < -5 || gy < -5 || gx > current.n + 5 || gy > current.n + 5) continue;
      const [x, y] = toCanvas(gx, gy);
      const r = Math.max(8, 9 * pxPerArcsec);
      ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
    }
  }
  if ($("cent").checked && run && !current.preview) {
    const pos = run.astro && run.astro.positions.find((p) => p.season === frame.season);
    if (pos) {
      const [x, y] = toCanvas(...pos.grid);
      ctx.strokeStyle = "#7CFC00"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke();
    }
  }
  drawMotionArrow(ctx, canvas, toCanvas, frame);
  skyStatusLine(ctx, canvas);
  // scale bar (a round length that fits) and compass
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
  // the one progress line, inside the bottom edge of the picture (what the wavelength buttons say is loading)
  const pg = pictureProgress(), pfs = Math.round(canvas.width / 44), lift = pg ? pfs + 14 : 0;
  if (pg) {
    const y0 = canvas.height - lift;
    ctx.fillStyle = "rgba(5,7,13,.78)"; ctx.fillRect(0, y0, canvas.width, lift);
    ctx.fillStyle = "#ffb347"; ctx.fillRect(0, canvas.height - 2, canvas.width * Math.min(1, pg.frac), 2);
    ctx.fillStyle = "#dfe5f2"; ctx.font = `${pfs}px system-ui, sans-serif`; ctx.textBaseline = "top"; ctx.fillText(pg.text, 10, y0 + 5); ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff";
  }
  ctx.font = `${Math.round(canvas.width / 40)}px system-ui, sans-serif`;
  const yb = canvas.height - 18 - lift;
  const pick = [5, 10, 20, 30, 60, 120, 300].find((v) => v * pxPerArcsec >= canvas.width / 9) || 300, bar = pick * pxPerArcsec;
  if (bar < canvas.width * 0.6) {
    ctx.beginPath(); ctx.moveTo(16, yb); ctx.lineTo(16 + bar, yb); ctx.stroke();
    ctx.fillText(pick >= 60 ? pick / 60 + "′" : pick + "″", 16 + bar / 2 - 5, yb - 8);
  }
  const cx = canvas.width - 30, cy = canvas.height - 18 - lift;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 40); ctx.moveTo(cx, cy); ctx.lineTo(cx - 40, cy); ctx.stroke();
  ctx.fillText(t("sk.cN"), cx - 5, cy - 46); ctx.fillText(t("sk.cE"), cx - 58, cy + 6);
}

/** The verdict strip's own headline (js/verdict_strip.js) when nothing moved or the answer is not sure yet: written on
 *  the picture too, as on the result page, so the picture is never left with an empty ring and no word. Its short form
 *  (data-cap) when the strip gives one. The strip marks its kind and short form on <html>; a change redraws the frame. */
function skyStatus() {
  const H = document.documentElement.classList, kind = H.contains("vd-k-none") ? "none" : H.contains("vd-k-unsure") ? "unsure" : "";
  const vs = kind && $("vdStrip") && !$("vdStrip").hidden ? $("vdStrip") : null, el = vs ? vs.querySelector(".vd-t") : null;
  const txt = vs && vs.dataset.cap ? vs.dataset.cap : el ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim() : "";
  return txt ? { kind, txt } : null;
}
function skyStatusLine(ctx, canvas) {
  if (!fz.vdObs) {
    fz.vdObs = true;
    try {
      new MutationObserver(() => { const s = skyStatus(), k = s ? s.kind + s.txt : ""; if (k !== fz.vdLast && current) { fz.vdLast = k; showFrame(); } })
        .observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-vd-cap"] });
    } catch (_) { /* no observer: the line follows on the next frame */ }
  }
  const s = skyStatus();
  fz.vdLast = s ? s.kind + s.txt : "";
  // the result layout puts the date over the picture's top-left corner (css/cplus.css .ts-pic > #date): it moves
  // under this line. The line's bottom as a fraction of the picture's height, so it holds at any displayed size.
  const box = canvas.parentElement;
  if (!s) { if (box) { box.classList.remove("fz-cap"); box.style.removeProperty("--fz-cap-b"); } return; }
  const fs = Math.round(canvas.width / 32), pad = Math.round(fs * 0.55), maxW = canvas.width - 24 - 2 * pad;
  ctx.save();
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  let lines = [s.txt];                                   // too long for the picture: two lines, split at the space nearest the middle
  if (ctx.measureText(s.txt).width > maxW) {
    const sp = [...s.txt.matchAll(/ /g)].map((m) => m.index), mid = s.txt.length / 2;
    if (sp.length) { const k = sp.reduce((q, i) => (Math.abs(i - mid) < Math.abs(q - mid) ? i : q)); lines = [s.txt.slice(0, k), s.txt.slice(k + 1)]; }
  }
  const lh = Math.round(fs * 1.25), tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const w = Math.min(canvas.width - 24, tw + 2 * pad), h = fs + 2 * pad + lh * (lines.length - 1);
  if (box) { box.classList.add("fz-cap"); box.style.setProperty("--fz-cap-b", ((12 + h) / canvas.height).toFixed(4)); }
  ctx.fillStyle = "rgba(5,7,13,.82)"; ctx.fillRect(12, 12, w, h);
  ctx.fillStyle = s.kind === "none" ? "#9be7b5" : "#ffd98a"; ctx.fillRect(12, 12, 4, h);
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, 12 + pad, 12 + pad + fs / 2 + i * lh + 1, w - 2 * pad));
  ctx.restore();
}

/** The measured motion (goruntu_tur): where the object was in every season (one small mark per visit, in the visit's
 *  colour, a thin line through them), and an arrow from the first to the last season at its TRUE length, drawn beside
 *  the track so that it never covers the object. Label = speed ± error and direction (js/motion_arrow.js). Nothing is
 *  drawn for a shift inside its own noise, or while the answer is too uncertain (run.pgNoArrow, bins_bar.js). */
function drawMotionArrow(ctx, canvas, toCanvas, frame) {
  const a = run && run.astro, P = a && a.positions;
  if (!current || current.preview || !P || P.length < 2 || run.pgNoArrow) return;   // pgNoArrow: bins_bar.js, the answer is too uncertain
  if (satWaiting()) return;                                     // a saturated source while wavelengths load: no interim speed
  const A = P[0], Z = P[P.length - 1];
  const p = (a.pairs || []).find((q) => q.from === A.season && q.to === Z.season);
  if (!p || !significant(p.shift, p.err)) return;               // a shift inside its own noise is not drawn as motion
  const grid = current.n === run.info.n ? run.grid : new TanGrid(run.info.ra0, run.info.dec0, run.info.pixArcsec, current.n);
  const pts = P.map((q) => ({ season: q.season, xy: toCanvas(...grid.skyToPix(q.ra, q.dec)) }));
  const [ax, ay] = pts[0].xy, [zx, zy] = pts[pts.length - 1].xy;
  const dx = zx - ax, dy = zy - ay, len = Math.hypot(dx, dy), W = canvas.width, H = canvas.height;
  if (!(len > 0.5) || ax < 0 || ay < 0 || ax > W || ay > H) return;
  const ux = dx / len, uy = dy / len;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const visit = (s) => Math.max(0, P.findIndex((q) => q.season === s));
  // the track and one mark per visit (two short bars across the track; the visit on screen is the strong one)
  if (len >= 12) {
    for (const [col, w] of [["rgba(5,7,13,.8)", 3], ["rgba(232,234,240,.6)", 1.2]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(...q.xy) : ctx.moveTo(...q.xy)));
      ctx.stroke();
    }
    for (const q of pts) {
      const on = frame && q.season === frame.season, g = 4.5, l = on ? 10 : 6, [x, y] = q.xy;
      for (const [col, w] of [["rgba(5,7,13,.85)", (on ? 2.6 : 1.8) + 2.4], [visitColour(visit(q.season)), on ? 2.6 : 1.8]]) {
        ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
        for (const sgn of [-1, 1]) { ctx.moveTo(x - sgn * uy * g, y + sgn * ux * g); ctx.lineTo(x - sgn * uy * (g + l), y + sgn * ux * (g + l)); }
        ctx.stroke();
      }
    }
  }
  // the arrow at true length, 26 px beside the track (the side with more room)
  let px = -uy, py = ux;
  if (px < 0 || (Math.abs(px) < 0.3 && py > 0)) { px = -px; py = -py; }
  if ((ax + zx) / 2 > W * 0.62) { px = -px; py = -py; }
  const drawn = len >= 16, o = drawn ? 26 : 0, sx = ax + px * o, sy = ay + py * o, qx = zx + px * o, qy = zy + py * o;
  if (drawn) {
    const lw = 2.6, hl = Math.min(12, len * 0.6), hw = Math.min(6.5, len * 0.33), bx = qx - ux * hl, by = qy - uy * hl;
    ctx.strokeStyle = "rgba(232,234,240,.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(sx, sy); ctx.moveTo(zx, zy); ctx.lineTo(qx, qy); ctx.stroke();
    for (const [col, w] of [["rgba(5,7,13,.85)", lw + 3.4], ["#ffffff", lw]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(bx - uy * hw, by + ux * hw); ctx.lineTo(bx + uy * hw, by - ux * hw); ctx.closePath();
    ctx.lineWidth = 3.2; ctx.strokeStyle = "rgba(5,7,13,.85)"; ctx.stroke(); ctx.fillStyle = "#ffffff"; ctx.fill();
  }
  const sp = speedOf(null, { s: p.shift, e: p.err, dt: p.dtYears, pa: p.pa });
  // while wavelengths load the second line says the speed is interim (the scale note returns with the final result)
  const l1 = speedText(sp), l2 = !run.complete ? t("ts.t.interim", null, "interim estimate, not final") : drawn ? scaleText(1) : t("fz.arw.small", null, "too small to draw at this zoom"), f1 = Math.round(W / 34), f2 = Math.round(W / 44);
  ctx.font = `700 ${f1}px system-ui, sans-serif`;
  const bw = Math.max(ctx.measureText(l1).width, (ctx.font = `700 ${f2}px system-ui, sans-serif`, ctx.measureText(l2).width)), bh = f1 + f2 + 8;
  const clampX = (x0) => Math.min(Math.max(x0, 8), W - 8 - bw);
  // the label sits on the arrow's outer side, clear of the object's own positions
  const mx = (sx + qx) / 2, my = (sy + qy) / 2, side = Math.abs(px) >= Math.abs(py);
  const top = Math.min(sy, qy, ay, zy) - 14 - bh, bot = Math.max(sy, qy, ay, zy) + 14;
  let y0 = side ? my - bh / 2 : py < 0 ? top : bot;
  if (y0 < 8 || y0 + bh > H - 40) y0 = top >= 8 ? top : bot + bh <= H - 40 ? bot : Math.max(8, top);
  const cx = side ? (px > 0 ? Math.min(W - 8 - bw, Math.max(sx, qx) + 14) : Math.max(8, Math.min(sx, qx) - 14 - bw)) + bw / 2 : clampX(mx - bw / 2) + bw / 2;
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.lineWidth = Math.max(3, W / 160); ctx.strokeStyle = "#05070d";
  ctx.font = `700 ${f1}px system-ui, sans-serif`; ctx.fillStyle = "#ffffff";
  if (l1) { ctx.strokeText(l1, cx, y0); ctx.fillText(l1, cx, y0); }
  ctx.font = `700 ${f2}px system-ui, sans-serif`; ctx.fillStyle = "#ffd08a";
  ctx.strokeText(l2, cx, y0 + f1 + 6); ctx.fillText(l2, cx, y0 + f1 + 6);
  ctx.restore();
}

// ---- stage label: "Preview (N images)" -> "Full result (N images)" ------------------------------
function setStage(kind, n, note = "") {
  const el = $("stage");
  if (el) {
    el.hidden = !kind;
    el.className = "stagebadge " + (kind || "");
    el.textContent = kind === "preview" ? t("sk.stage.preview", { n }) : kind === "full" ? t("sk.stage.full", { n }) : "";
    el.title = note;
  }
  if (run) run.stage = { kind, n, note };
  if (kind) {
    const t = (window.__fzTimes ||= {});
    t[kind + "Shown"] ||= Date.now();
    t[kind + "N"] = n;
  }
  if (window.parent !== window) {
    try { window.parent.postMessage({ type: "fazari-stage", stage: kind, n, note }, location.origin); } catch (_) { /* ignore */ }
  }
}
const imagesIn = (r) => r.frames.reduce((a, f) => a + f.n, 0);
const fullCount = () => Object.values(run.results).reduce((a, r) => a + imagesIn(r), 0);

function showFrame() {
  if (!current) return;
  if (!window.__firstFrameMs) window.__firstFrameMs = performance.now() - t0.start;   // for the headless checks
  const fi = frameIdx % current.frames.length, fr = current.frames[fi];
  fzSwitch();
  // the picture opens as a close-up of about 3 arcmin around the target (the nearest zoom step the page offers),
  // for the preview's small region and for the full field alike, until the visitor picks a zoom
  const zs = $("zoom");
  if (run && (fz.zoomFor !== run || fz.zoomN !== current.n)) {
    fz.zoomFor = run; fz.zoomN = current.n;
    if (!zs.dataset.fzBound) { zs.dataset.fzBound = "1"; zs.addEventListener("input", () => { zs.dataset.fzUser = "1"; }); }
    if (!zs.dataset.fzUser) {
      const want = current.n * run.info.pixArcsec / 180, opts = [...zs.options].map((o) => +o.value).filter((v) => v > 0);
      if (opts.length) zs.value = String(opts.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)));
    }
  }
  const zoom = Number(zs.value);
  const cv = $("blink");
  const pic = fzPicture(fi);
  if (fz.paintNote) fz.paintNote();
  const toCanvas = pic ? drawToCanvas(cv, pic.id, current.n, zoom, pic.up, !fz.raw) : drawToCanvas(cv, grayImageData(fr.norm, current.n), current.n, zoom);
  drawOverlay(cv, toCanvas, fr, zoom);
  $("date").textContent = `${fr.season}  (${fr.dateFirst === fr.dateLast ? fr.dateFirst : t("sk.dateRange", { a: fr.dateFirst, b: fr.dateLast })})`;
  $("detail").textContent = `${num(fr.lam, 2)} µm · SPHEREx ${fr.detectors.join("+")} · ${tn("sk.exposures", fr.n)}`
    + (current.preview ? t("sk.detail.preview") : "")
    + (fr.satAtTarget ? " · " + t("u3.sk.coreHere") : "");      // the object's own core is saturated: display fill, not data
  document.dispatchEvent(new CustomEvent("fazari:skyframe", { detail: { season: fr.season, um: current.um, zoom } }));   // ch_sky.js
}

function showDiff() {
  const cv = $("diff");
  const zoom = Number($("zoom").value);
  const pic = current.frames.length > 1 && !fz.raw ? fzPicture("d") : null;      // the same matched, lined-up frames as the film
  const toCanvas = pic ? drawToCanvas(cv, pic.id, current.n, zoom, pic.up, true) : drawToCanvas(cv, divergingImageData(current.diff, current.n, 0.6), current.n, zoom);
  const first = current.frames[0], last = current.frames[current.frames.length - 1];
  $("diffcap").textContent = t("sk.diffcap", { last: last.season, first: first.season, um: num(current.um, 1) })
    + (current.frames.some((f) => f.softCorePx) ? " " + t("u3.sk.diffGrey") : "");
  if ($("mark").checked && first.gaiaXY) {
    const ctx = cv.getContext("2d");
    ctx.lineWidth = 2;
    for (const [fr, col] of [[first, "#2a6fdb"], [last, "#d9342b"]]) {
      const [x, y] = toCanvas(...fr.gaiaXY);
      ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(x, y, 16, 0, 2 * Math.PI); ctx.stroke();
    }
  }
}

function startBlink() {
  clearInterval(timer);
  if (playing && current && current.frames.length > 1) {
    timer = setInterval(() => { frameIdx = (frameIdx + 1) % current.frames.length; showFrame(); }, Number($("speed").value));
  }
  $("play").textContent = playing ? t("sk.pause") : t("sk.play");
}

// ---- motion card -------------------------------------------------------------------------------
function fmtArc(v) { return `${num(v, 2)}″`; }
/** Motion card while only the preview is there: never presented as a measurement. */
function showPreliminary(r) {
  const p = r.prelim;
  let html = `<p class="status warn">${t("sk.pre.head", { n: imagesIn(r), um: num(r.um, 1), s: r.frames.length })}</p>`;
  if (p) {
    html += `<p>${t("sk.pre.body", { from: p.from, to: p.to, shift: num(p.shift, 1), pa: p.pa.toFixed(0), gs: num(p.gaiaShift, 1), gpa: p.gaiaPa.toFixed(0) })}`
      + ` <span class="small">${t("sk.pre.small", { n: p.n })}</span></p>`;
  }
  $("measure").innerHTML = html;
}
/** The measured source is saturated (the engine's flag, js/sky.js calibration.saturatedTarget) and wavelengths are still
 *  loading: no interim speed anywhere (verdict strip, tiles, arrow, this card); the final result shows it as before. */
function satWaiting() {
  const c = run && run.astro && run.astro.calibration;
  return !!(run && !run.complete && c && c.saturatedTarget);
}

function showMotion() {
  const el = $("measure");
  const a = run.astro;
  GR.ensureStyle();
  if (!a || !a.positions.length) {
    // grafikler: nothing measured at the point: the honest limit from this run's field stars and seasons
    const c = a && a.calibration, fr = current && current.frames;
    const dt = fr && fr.length > 1 && fr[0].mjdMean && fr[fr.length - 1].mjdMean ? (fr[fr.length - 1].mjdMean - fr[0].mjdMean) / 365.25 : null;
    const v = c ? GR.limitFromField(c.rms, dt) : null;
    el.innerHTML = `<p>${t("sk.m.none")}</p>` + (v ? GR.limitHtml({ v }, t("gr.lim.tipField", { r: num(c.rms, 2) }), true) : "");
    return;
  }
  const who = run.target ? tname(run.target.name) : t("sk.m.who");
  let html = "";
  // a free point: the fit may have settled on a bright neighbour of the point picked (gr.js offPoint)
  const off = run.target ? null : GR.offPoint(a.positions, run.info.ra0, run.info.dec0);
  if (off) html += `<p class="status warn">${t("vd.off", { off: GR.offTxt(off) })}</p>`;
  if (a.pairs.length) {
    const p = a.pairs.find((q) => q.from === a.positions[0].season && q.to === a.positions[a.positions.length - 1].season);
    // grafikler: the headline is the speed per year = shift ÷ time, from the same-orientation pair closest to a year
    // (there the yearly parallax wobble nearly cancels); the shift itself follows as a second line
    const q = a.pairs.filter((x) => x.sameOrientation && x.dtYears > 0.3).sort((x, y) => Math.abs(x.dtYears - 1) - Math.abs(y.dtYears - 1))[0] || (p && p.dtYears > 0.3 ? p : null);
    const sp = q ? { v: q.shift / q.dtYears, e: q.err / q.dtYears, p: q.gaiaShift != null ? q.gaiaShift / q.dtYears : null } : null;
    if (satWaiting()) html += `<p class="big">${t("vd.wait.measuring0")}</p>`;
    else if (sp) {
      html += `<p class="big">${t(sp.v < 3 * sp.e ? "gr.sk.noClear" : "gr.sk.speed", { who, v: GR.rateTxt(sp.v, sp.e), e: GR.rateTxt(sp.e, sp.e) })}${sp.p != null ? t("gr.sk.cat", { p: GR.rateTxt(sp.p, sp.e) }) : ""}</p>`
        + `<div id="grSkyNl">${GR.numberLine({ v: sp.v, e: sp.e, p: sp.p, refLabel: t("gr.sk.catLabel"), unit: t("gr.unit") })}</div>`
        + `<p class="small">${t("gr.sk.how", { from: q.from, to: q.to, dt: num(q.dtYears, 2) })}</p>`;
      if (sp.v < 3 * sp.e) html += GR.limitHtml({ v: 3 * sp.e }, t("gr.sk.limTip", { dt: num(q.dtYears, 2) }), true);
      if (!run.target) {                               // a free point: the catalogued star there (Gaia DR3, else SIMBAD)
        const myA = a;
        GR.catalogueAt({ measured: { positions: a.positions.map((x) => ({ ra: x.ra, dec: x.dec, mjd: x.mjd })) } }, "").then((c) => {
          const box = $("grSkyNl");
          if (!c || run.astro !== myA || !box) return;
          box.innerHTML = GR.numberLine({ v: sp.v, e: sp.e, p: c.v, refLabel: c.src, unit: t("gr.unit") })
            + `<p class="small">${t(off ? "gr.sk.catAtOff" : "gr.sk.catAt", { src: c.src === "SIMBAD" ? "SIMBAD" : "ESA Gaia DR3", p: GR.rateTxt(c.v, sp.e), d: num(c.sep, 1), off: off ? GR.offTxt(off) : "" })}</p>`;
        });
      }
    }
    if (!satWaiting()) {                               // a saturated source while wavelengths load: not even the shift yet
      html += `<p${sp ? "" : ' class="big"'}>${t("sk.m.shift", { who, from: p.from, to: p.to, shift: fmtArc(p.shift), pa: num(p.pa, 1), err: num(p.err, 2) })}`;
      if (p.gaiaShift != null) html += t("sk.m.cat", { shift: fmtArc(p.gaiaShift), pa: num(p.gaiaPa, 1) });
      html += "</p>";
    }
  }
  html += `<table><tr><th>${t("sk.m.th.season")}</th><th>${t("sk.m.th.date")}</th><th>N</th><th>${t("sk.m.th.angle")}</th>`
    + (run.target ? `<th>${t("sk.m.th.vsCat")}</th>` : `<th>${t("sk.m.th.vsCentre")}</th>`) + "</tr>";
  for (const p of a.positions) {
    const ref = p.gaia || [run.info.ra0, run.info.dec0];
    const o = offsetArcsec(ref[0], ref[1], p.ra, p.dec);
    html += `<tr><td>${p.season}</td><td>${p.date}</td><td>${p.n}${p.calibrated ? "" : "*"}</td><td>${p.orient.toFixed(0)}°</td>`
      + `<td>${num(o[0], 2)}″${lang() === "tr" ? ";" : ","} ${num(o[1], 2)}″ <span class="small">± ${num(p.errEast, 2)}${lang() === "tr" ? ";" : ","} ${num(p.errNorth, 2)}</span></td></tr>`;
  }
  html += "</table>";
  const c = a.calibration;
  if (c && c.nCalibratedTarget) {
    html += `<p class="small">${t("sk.m.cal", { stars: Math.round(c.stars), rms: num(c.rms, 2), n: c.nCalibratedTarget, m: c.nFits })}`
      + (c.saturatedTarget && c.satRefs ? t("sk.m.calSat", { n: c.satRefs }) : "")
      + (c.nCalibratedTarget < c.nFits ? t("sk.m.calPart", { reasons: c.reasons.join("; ") }) : "") + ".</p>";
  } else {
    html += `<p class="small">${t("sk.m.uncal", { why: (c && c.reasons.join("; ")) || t("sk.m.noGaia") })}</p>`;
  }
  if (a.pairs.length > 1) {
    const sep = lang() === "tr" ? "; " : ", ";
    html += `<table class="pairs"><tr><th>${t("sk.m.th.pair")}</th><th>${t("sk.m.th.measured")}</th><th>${t("sk.m.th.cat")}</th><th>${t("sk.m.th.same")}</th></tr>`;
    for (const p of a.pairs) {
      html += `<tr><td>${p.from} → ${p.to}</td><td>${fmtArc(p.shift)}${sep}${num(p.pa, 1)}°</td>`
        + `<td>${p.gaiaShift != null ? fmtArc(p.gaiaShift) + sep + num(p.gaiaPa, 1) + "°" : "–"}</td><td>${p.sameOrientation ? t("sk.yes") : t("sk.no")}</td></tr>`;
    }
    html += "</table>";
  }
  html += `<p class="small">${t("sk.m.method", { fits: a.nFits, exp: a.nExposures,
    bins: Object.keys(run.results).map(Number).sort((a, b) => a - b).map((u) => num(u, 1)).join(lang() === "tr" ? "; " : ", ") })}</p>`;
  el.innerHTML = html;
}

// ---- spectrum of the loaded exposures (spectrum.js in the worker, chart: spectrum_chart.js) -----------
// It reads every exposure again (headers, the rows at the point, one PSF row): two to three minutes for 70 exposures
// when it waits for the end of the run. So the run calls it after every loaded wavelength too: each call measures
// only the new exposures (spectrum.js keeps the others), and the curve grows while the run goes on.
async function showSpectrum() {
  const box = $("spectrum");
  if (!box || !run || !run.engine || run.engine.closed || typeof run.engine.spectrum !== "function") return;
  const myRun = run;
  if (myRun.specBusy) { myRun.specAgain = true; return; }       // one at a time; the latest call runs after it
  myRun.specBusy = true;
  try {
    const { result } = await run.engine.spectrum();
    if (run !== myRun) return;
    const [{ renderSpectrum }, { toCsv }] = await Promise.all([import("./spectrum_chart.js"), import("./spectrum.js")]);
    if (run.spectrumUrl) URL.revokeObjectURL(run.spectrumUrl);
    run.spectrumUrl = URL.createObjectURL(new Blob([toCsv(result)], { type: "text/csv" }));
    run.spectrum = result;
    box.dataset.n = result.summary.n_exposures;
    renderSpectrum(box, result, { csvUrl: run.spectrumUrl, csvName: `${String(result.target || "source").replace(/[^A-Za-z0-9]+/g, "_")}_spectrum.csv` });
  } catch (e) { if (e.name !== "AbortError") console.warn("spectrum failed:", e); }
  finally {
    myRun.specBusy = false;
    if (myRun.specAgain && run === myRun) { myRun.specAgain = false; showSpectrum(); }
  }
}

// ---- result for headless checks -----------------------------------------------------------------
function writeResult(state, extra = {}) {
  const s = run && run.info;
  const res = {
    state, input: run ? run.input : null, index: indexName, profile: PROFILE.name, worker: run && run.engine ? run.engine.useWorker : WORKER,
    cap: s ? s.cap : null,
    target: run && run.target ? run.target.name : null,
    ra: s ? s.ra0 : null, dec: s ? s.dec0 : null,
    n_index_images: s ? s.nImages : 0,
    seasons: s ? s.seasons.map((x) => x.label) : [],
    bins: s ? s.bins.map((b) => ({ um: b.um, detector: b.det, seasons_with_candidates: b.nSeasons, available: b.available })) : [],
    loaded: s ? Object.values(run.results).sort((a, b) => a.um - b.um).map((r) => ({ um: r.um, detector: r.det,
      frames: r.frames.map((f) => ({ season: f.season, n: f.n, detectors: f.detectors, lam_um: +f.lam.toFixed(4), lams: f.lams,
                                     date_first: f.dateFirst, date_last: f.dateLast, soft_core_px: f.softCorePx || 0 })) })) : [],
    stage: run && run.stage ? run.stage : null,
    times_ms: run && run.times ? run.times : null,
    preview: run && run.preview ? { n_images: imagesIn(run.preview), um: run.preview.um, per_season: run.preview.preview.perSeason,
                                    fov_deg: run.preview.preview.fovDeg, prelim: run.preview.prelim || null } : null,
    astrometry: run && run.astro ? { pairs: run.astro.pairs, calibration: run.astro.calibration,
                                     positions: run.astro.positions.map((p) => ({ ...p, grid: undefined })) } : null,
    gaia_field: run ? run.gaiaField : null,
    bytes: netStats.bytes, requests: netStats.requests, retries: netStats.retries,
    seconds: +((performance.now() - t0.start) / 1000).toFixed(2),
    ...extra,
  };
  const el = $("result");
  el.textContent = JSON.stringify(res, null, 1);
  el.dataset.state = state;
}

// ---- main flow -------------------------------------------------------------------------------
async function resolveInput(text) {
  const key = matchTarget(text);
  if (key) {
    const t = TARGETS[key];
    return { key, target: { ...t }, label: () => tname(t.name) };
  }
  const c = parseCoords(text);
  if (c) return { key: null, target: null, ra: c[0], dec: c[1], label: () => `RA ${num(c[0], 5)}°, Dec ${num(c[1], 5)}°` };
  setStatus(() => t("sk.resolving", { text }));
  const r = await sesame(text, { signal: run.ctl.signal });
  if (!r) throw new Error(t("sk.err.unknown", { text }));
  const moving = Math.hypot(r.pmra, r.pmdec) > 0;
  return { key: null, target: moving ? r : null, ra: r.ra, dec: r.dec, label: () => `${tname(r.name)} (${r.source})`, resolved: r };
}

function updateUrl(q) {
  const u = new URL(location.href);
  for (const k of ["target", "ra", "dec", "q"]) u.searchParams.delete(k);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  history.replaceState(null, "", u);
  $("share").href = u.toString();
  $("share").textContent = t("sk.share");
}

async function loadBin(um, { show = true, background = false } = {}) {
  const myRun = run;
  const b = run.info.bins.find((x) => x.um === um);
  if (show) for (const btn of document.querySelectorAll("#bins button")) btn.classList.toggle("on", Number(btn.dataset.um) === um);
  let r = run.results[um];
  if (!r) {
    if (!background) { setStatus(() => t("sk.st.download", { um: num(um, 1), det: b.det })); prog = { base: 0, span: 1, f: 0, tFull: performance.now() }; run.complete = false; }
    progressInfo = { checked: 0, accepted: 0, done: 0 };
    busy(true);
    run.pending ||= {};
    try {
      run.pending[um] ||= run.engine.loadBin(um, (p) => { if (run === myRun) { progressInfo = p; queueProgress(); } });
      const out = await run.pending[um];
      if (run !== myRun) return;
      r = run.results[um] = out.result;
      if (!background) run.complete = true;
      run.astro = out.astrometry;
      const btn = document.querySelector(`#bins button[data-um="${um}"]`);
      if (btn) btn.classList.add("loaded");
    } finally { if (run === myRun && !background) busy(false); }
  }
  if (!show) {                         // background: refresh the motion card unless the preview is on screen
    if (current && !current.preview) showMotion();
    return;
  }
  current = r; frameIdx = 0;
  $("viewer").hidden = false;
  showFrame(); showDiff(); startBlink();
  showMotion();
  renderProgress();
}

/** Show a preview result (first look / preview) of bin um. */
function showPreview(r) {
  run.preview = r;
  if (current && !current.preview) return;                 // the user already looks at a full result
  for (const btn of document.querySelectorAll("#bins button")) btn.classList.toggle("on", Number(btn.dataset.um) === r.um);
  current = r; frameIdx = 0;
  $("viewer").hidden = false;
  showFrame(); showDiff(); startBlink();
  showPreliminary(r);
}

/** Quick preview first, then the full result in the background (desktop: every wavelength). */
async function previewThenFull(first, avail, myRun) {
  run.times = {};
  const ms = () => Math.round(performance.now() - t0.start);
  const nSeasons = run.info.bins.find((x) => x.um === first).nSeasons;
  for (const k of [2, 0]) {                                 // 2 per season, then 2..4 (12 in all)
    if (k === 0 && run.preview && run.preview.preview.perSeason >= Math.max(2, Math.min(4, Math.floor(12 / Math.max(nSeasons, 1))))) break;
    setStatus(() => (k ? t("sk.st.quick", { um: num(first, 1), k }) : t("sk.st.more", { um: num(first, 1) })), "warn");
    progStep(k ? 0 : 0.08, k ? 0.08 : 0.07);
    progressInfo = { checked: 0, accepted: 0, done: 0 };
    let out;
    try {
      out = await run.engine.loadPreview(first, { perSeason: k, total: 12, fovDeg: 0.1 }, (p) => { if (run === myRun) { progressInfo = p; queueProgress(); } });
    } catch (e) {
      if (e.name === "AbortError" || run !== myRun) throw e;
      console.warn("preview failed, going on with the full result:", e);
      break;
    }
    if (run !== myRun) return;
    const r = out.result;
    if (!run.preview || imagesIn(r) > imagesIn(run.preview)) {
      showPreview(r);
      run.times[k ? "firstLook" : "preview"] = ms();
      window.__fzPreviewAt ||= Date.now();
      setStage("preview", imagesIn(r), t("sk.stage.previewNote"));
      writeResult("preview");
    }
  }
  const bins = [first, ...(PROFILE.name === "phone" ? [] : avail.map((b) => b.um).filter((u) => u !== first))];
  for (let i = 0; i < bins.length; i++) {
    const um = bins[i];
    const onScreen = !!(current && current.preview);
    setStatus(() => (onScreen ? t("sk.st.onScreen") : "") + t("sk.st.full", { um: num(um, 1), i: i + 1, n: bins.length }), "warn");
    progStep(0.15 + 0.85 * i / bins.length, 0.85 / bins.length);
    await loadBin(um, { show: um === first && (!current || current.preview), background: true });
    if (run !== myRun) return;
    if (i === 0) run.times.firstFull = ms();
    setStage("full", fullCount(), i < bins.length - 1 ? t("sk.stage.more") : t("sk.stage.all"));
  }
  run.times.full = ms();
  window.__fzFullAt = Date.now();
}

function stopRun() {
  if (!run) return;
  run.ctl.abort(); run.finished = true;
  if (run.engine) run.engine.cancel();
  busy(false);
}

async function go(text, opts = {}) {
  stopRun();
  clearInterval(timer);
  current = null; fieldStars = [];
  setStage(null);
  $("viewer").hidden = true; $("bins").innerHTML = ""; $("measure").innerHTML = ""; $("fieldnote").textContent = ""; live.clear();
  import("./bins_bar.js").then((m) => m.resetSky()).catch(() => {});   // the previous run's wavelength bar
  if ($("spectrum")) $("spectrum").hidden = true;
  run = { ctl: new AbortController(), input: text, finished: false, gaiaField: null, results: {} };
  prog = { base: 0, span: 0, f: 0, tFull: 0 };
  const myRun = run;
  t0.start = performance.now();
  netStats = { bytes: 0, requests: 0, retries: 0 };
  busy(true);
  writeResult("running");
  try {
    const r = await resolveInput(text);
    run.target = r.target;
    const [ra, dec] = r.target ? propagate(r.target, jyearToMjd(CONFIG.epochCenter), false) : [r.ra, r.dec];
    updateUrl(r.key ? { target: r.key } : r.resolved ? { q: text } : { ra: ra.toFixed(6), dec: dec.toFixed(6) });
    setLive("what", () => r.label() + (r.target && (r.target.pmra || r.target.pmdec)
      ? t("sk.pm", { pm: Math.hypot(r.target.pmra, r.target.pmdec).toFixed(0) }) : ""));
    setStatus(() => t("sk.st.index"));
    let idx = await loadIndex();
    let images;
    try {
      images = await idx.findImages(ra, dec, { target: r.key || undefined });
    } catch (e) {
      if (indexName === "skyindex_dev.js") throw e;
      console.warn("sky index failed, using the dev index:", e);
      idx = indexMod = await import("./skyindex_dev.js"); indexName = "skyindex_dev.js";
      images = await idx.findImages(ra, dec, { target: r.key || undefined });
    }
    if (myRun !== run) return;
    if (!images || !images.length) {
      const devNote = indexName === "skyindex_dev.js" ? t("sk.err.devIndex") : "";
      throw new Error(t("sk.err.none", { dev: devNote }));
    }
    const cfg = { cap: Number($("cap").value) || PROFILE.cap };
    cfg.fovDeg = skyFov();                                   // the Field selector / ?fov= (default 0.15 deg)
    if (params.get("calib") === "0") cfg.calibrate = false;
    run.engine = new Engine({ useWorker: WORKER, onNet: (st) => { if (run === myRun) onNet(st); }, onStatus: (m) => { if (run === myRun) onStatus(m); } });
    const session = await run.engine.init({ ra, dec, target: r.target, images, config: cfg, cacheBytes: PROFILE.cacheBytes });
    if (myRun !== run) return;
    run.info = session;
    run.grid = new TanGrid(session.ra0, session.dec0, session.pixArcsec, session.n);
    const avail = session.bins.filter((b) => b.available);
    setLive("found", () => t("sk.found", { n: images.length, s: session.seasons.length, list: session.seasons.map((x) => x.label).join(", ") }));
    if (!avail.length) throw new Error(t("sk.err.twoSeasons"));
    for (const b of session.bins) {
      const btn = document.createElement("button");
      binLabel(btn, b);
      btn.dataset.um = b.um;
      btn.disabled = !b.available;
      btn.onclick = () => loadBin(b.um).catch(fail);
      $("bins").appendChild(btn);
    }
    // Gaia high-proper-motion stars in the field, only for positions that are not one of the 5 targets
    if (!r.key) {
      highPmStars(session.ra0, session.dec0, (cfg.fovDeg || CONFIG.fovDeg) * 0.75, 100, { signal: run.ctl.signal }).then((stars) => {
        if (myRun !== run) return;
        fieldStars = stars;
        run.gaiaField = { ok: true, n: stars.length, stars: stars.map((s) => ({ id: s.source_id, pm: s.pm, gmag: s.gmag })) };
        setLive("fieldnote", () => (stars.length ? t("sk.field.some", { n: stars.length }) : t("sk.field.none")));
        if (current) { showFrame(); showDiff(); }
      }).catch((e) => {
        if (myRun !== run) return;
        run.gaiaField = { ok: false, error: e.message };
        setLive("fieldnote", () => t("sk.field.err", { msg: e.message }));
      });
    }
    let first = Number(params.get("bin")) || 2.0;
    if (!avail.some((b) => b.um === first)) first = avail[0].um;
    if (params.get("pg") !== "0" && typeof run.engine.loadAll === "function") {   // wavelength by wavelength: js/bins_bar.js (?pg=0: old flow)
      const PG = await import("./bins_bar.js");
      setStatus(() => t("pg.bb.skyRun"), "warn");
      await PG.runSky({ engine: run.engine, bins: avail, canvas: $("blink"), alive: () => run === myRun,
        stored(um, r, astro) {
          run.results[um] = r; run.astro = astro;
          const btn = document.querySelector(`#bins button[data-um="${um}"]`);
          if (btn) btn.classList.add("loaded");
          setStage("full", fullCount(), t("sk.stage.more"));
          setStatus(() => t("pg.bb.skyRun"), "warn");            // a wavelength arrived: an old "S3 busy" warning is over
          if (current && !current.preview) showMotion();
          showSpectrum();                                            // the spectrum grows with every wavelength
        },
        show(um) { if (!run.results[um]) return; current = run.results[um]; frameIdx = 0; $("viewer").hidden = false; showFrame(); showDiff(); startBlink(); showMotion(); },
        redraw() { if (current) showFrame(); },
        // the image counter of the technical details: the sum over the wavelengths of loadAll's plan / eta events
        progress(bins) {
          if (run !== myRun) return;
          const sum = (f) => bins.reduce((a, b) => a + (Number(b[f]) || 0), 0);
          progressInfo = { done: sum("done"), accepted: sum("accepted"), checked: sum("checked") };
          queueProgress();
        },
        setArrow(on) { run.pgNoArrow = !on; } });
    } else if (params.get("preview") !== "0") {
      await previewThenFull(first, avail, myRun);
    } else {
      await loadBin(first);
      if (opts.all || params.get("all") === "1") {
        for (const b of avail) if (b.um !== first) { await loadBin(b.um); }
        await loadBin(first);
      }
      setStage("full", fullCount());
    }
    if (myRun !== run) return;
    run.finished = true; run.complete = true;
    if (current && !current.preview) { showMotion(); showFrame(); }   // the final numbers (a saturated source's speed waits for them)
    busy(false);
    const nb = Object.keys(run.results).length;
    const imgs = fullCount(), ns = current.frames.length, more = nb < avail.length;
    setStatus(() => (nb > 1 ? t("sk.done.other", { imgs, n: nb, s: ns }) : t("sk.done.one", { imgs, n: nb, s: ns }))
      + (more ? t("sk.done.pick") : ""), "ok");
    renderProgress();
    writeResult("done");
    showSpectrum();
  } catch (e) {
    if (myRun !== run) return;
    if (e.name === "AbortError") { busy(false); return; }
    fail(e);
  }
}

function fail(e) {
  console.error(e);
  if (run) run.finished = true;
  busy(false);
  renderProgress();
  const msg = /Failed to fetch|NetworkError|did not answer/.test(e.message)
    ? t("sk.err.net", { msg: e.message }) : e.message;
  setStatus(msg, "err");
  writeResult("error", { error: msg });
}

// ---- wiring --------------------------------------------------------------------------------------
$("form").addEventListener("submit", (ev) => { ev.preventDefault(); const v = $("q").value.trim(); if (v) go(v); });
$("play").onclick = () => { playing = !playing; startBlink(); };
$("speed").oninput = () => { $("speedv").textContent = `${$("speed").value} ms`; startBlink(); };
$("prev").onclick = () => { if (current) { playing = false; startBlink(); frameIdx = (frameIdx - 1 + current.frames.length) % current.frames.length; showFrame(); } };
$("next").onclick = () => { if (current) { playing = false; startBlink(); frameIdx = (frameIdx + 1) % current.frames.length; showFrame(); } };
for (const id of ["zoom", "mark", "cent"]) $(id).onchange = () => { if (current) { showFrame(); showDiff(); } };
$("cancel").onclick = () => {
  if (!run || run.finished) return;
  const loaded = Object.keys(run.results).length;
  stopRun();
  setStatus(() => (loaded ? t("sk.st.cancelledKeep") : t("sk.st.cancelled")), "warn");
  writeResult("cancelled");
};
$("cap").onchange = () => { const v = $("q").value.trim(); if (v && run) go(v); };
$("allbins").onclick = async () => {
  if (!run || !run.info || !run.engine || run.engine.closed) return;
  try {
    for (const b of run.info.bins.filter((x) => x.available)) await loadBin(b.um);
    setStatus(() => t("sk.st.allBins"), "ok");
    writeResult("done");
    showSpectrum();
  } catch (e) { fail(e); }
};
for (const a of document.querySelectorAll("[data-q]")) a.onclick = (ev) => { ev.preventDefault(); $("q").value = a.dataset.q; go(a.dataset.q); };

// field selector (js/fov.js): ?fov= or the default 0.15 deg; phones at most 0.3 deg. A change keeps the
// choice in the address bar and runs the point again, like the exposures selector.
let fovChoice = fovFromUrl();
function skyFov() { return fovFor("browser", fovChoice, { phone: PROFILE.name === "phone" }); }
function renderFov() {
  const ph = PROFILE.name === "phone";
  fillFovSelect($("fov"), "browser", skyFov(), { phone: ph });
  $("fovEst").textContent = fovEstimateText("browser", skyFov(), { phone: ph }) + (ph ? " " + t("pg.fov.phoneMax") : "");
}
renderFov();
onLang(renderFov);
$("fov").onchange = () => {
  fovChoice = Number($("fov").value);
  setFovInUrl(fovChoice);
  renderFov();
  const v = $("q").value.trim();
  if (v && run) go(v);
};

// exposures-per-season selector: profile default, ?cap= overrides
{
  const want = params.get("cap") ? Math.max(1, Math.min(12, Number(params.get("cap")))) : PROFILE.cap;
  const sel = $("cap");
  if (![...sel.options].some((o) => Number(o.value) === want)) sel.add(new Option(String(want), String(want)));
  sel.value = String(want);
  const prof = () => (PROFILE.name === "phone" ? t("sk.phone", { n: want }) : "") + (WORKER ? "" : t("sk.noWorker"));
  $("profile").textContent = prof();
  onLang(() => { $("profile").textContent = prof(); });
}

const start = params.get("target") ? (TARGETS[params.get("target")] || {}).name || params.get("target")
  : params.get("ra") && params.get("dec") ? `${params.get("ra")} ${params.get("dec")}` : params.get("q");
if (start) { $("q").value = start; go(start); }
else setStatus(() => t("sk.st.enter"));

// ---- language switch: re-render text only (run, frames, wavelength, season and input stay) ----------
function binLabel(btn, b) {
  btn.textContent = `${num(b.um, 1)} µm`;
  btn.title = t("sk.bin.title", { det: b.det, n: b.nSeasons });
}
onLang(() => {
  if (lastStatus && typeof lastStatus[0] === "function") setStatus(...lastStatus);
  for (const [id, fn] of live) $(id).textContent = fn();
  if (run && run.info) for (const btn of document.querySelectorAll("#bins button")) {
    const b = run.info.bins.find((x) => x.um === Number(btn.dataset.um));
    if (b) binLabel(btn, b);
  }
  if (run && run.stage && run.stage.kind) {
    const el = $("stage");
    el.textContent = t(run.stage.kind === "preview" ? "sk.stage.preview" : "sk.stage.full", { n: run.stage.n });
  }
  $("play").textContent = playing ? t("sk.pause") : t("sk.play");
  if ($("share").getAttribute("href") !== "#") $("share").textContent = t("sk.share");
  renderProgress();
  if (current) {
    showFrame(); showDiff();
    if (current.preview) showPreliminary(current); else showMotion();
  }
});
