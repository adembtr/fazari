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
import { drawScale, speedOf, speedText, scaleText, significant } from "./motion_arrow.js";   // measured-motion arrow (ilk_izlenim)

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

function drawToCanvas(canvas, imageData, n, zoom) {
  const off = document.createElement("canvas");
  off.width = off.height = n;
  off.getContext("2d").putImageData(imageData, 0, 0);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const src = n / zoom, s0 = (n - src) / 2;
  ctx.drawImage(off, s0, s0, src, src, 0, 0, canvas.width, canvas.height);
  return (gx, gy) => [((gx + 0.5) - s0) * canvas.width / src, ((gy + 0.5) - s0) * canvas.height / src];
}

function drawOverlay(canvas, toCanvas, frame, zoom) {
  const ctx = canvas.getContext("2d");
  const pxPerArcsec = canvas.width / (current.n / zoom) / run.info.pixArcsec;
  ctx.lineWidth = 2;
  if ($("mark").checked && frame.gaiaXY) {
    const [x, y] = toCanvas(...frame.gaiaXY);
    ctx.strokeStyle = "#ffb347";
    ctx.beginPath(); ctx.arc(x, y, Math.max(10, 12 * pxPerArcsec), 0, 2 * Math.PI); ctx.stroke();
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
  drawMotionArrow(ctx, canvas, toCanvas);
  // scale bar (1 arcmin) and compass
  const bar = 60 * pxPerArcsec;
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
  ctx.font = `${Math.round(canvas.width / 40)}px system-ui, sans-serif`;
  const yb = canvas.height - 18;
  if (bar < canvas.width * 0.6) {
    ctx.beginPath(); ctx.moveTo(16, yb); ctx.lineTo(16 + bar, yb); ctx.stroke();
    ctx.fillText("1′", 16 + bar / 2 - 5, yb - 8);
  }
  const cx = canvas.width - 30, cy = canvas.height - 18;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 40); ctx.moveTo(cx, cy); ctx.lineTo(cx - 40, cy); ctx.stroke();
  ctx.fillText(t("sk.cN"), cx - 5, cy - 46); ctx.fillText(t("sk.cE"), cx - 58, cy + 6);
}

/** The measured motion, first season -> last season: drawn N times longer (stated on the image), from the measured
 *  first position, true end marked; label = speed ± error and direction (js/motion_arrow.js, ilk_izlenim). */
function drawMotionArrow(ctx, canvas, toCanvas) {
  const a = run && run.astro, P = a && a.positions;
  if (!current || current.preview || !P || P.length < 2 || run.pgNoArrow) return;   // pgNoArrow: bins_bar.js, the answer is too uncertain
  const A = P[0], Z = P[P.length - 1];
  const p = (a.pairs || []).find((q) => q.from === A.season && q.to === Z.season);
  if (!p || !significant(p.shift, p.err)) return;               // a shift inside its own noise is not drawn as motion
  const grid = current.n === run.info.n ? run.grid : new TanGrid(run.info.ra0, run.info.dec0, run.info.pixArcsec, current.n);
  const [ax, ay] = toCanvas(...grid.skyToPix(A.ra, A.dec)), [zx, zy] = toCanvas(...grid.skyToPix(Z.ra, Z.dec));
  const dx = zx - ax, dy = zy - ay, len = Math.hypot(dx, dy), W = canvas.width, H = canvas.height;
  if (!(len > 0.5) || ax < 0 || ay < 0 || ax > W || ay > H) return;
  const N = drawScale(len, 0.28 * Math.min(W, H)), ux = dx / len, uy = dy / len;
  const qx = ax + dx * N, qy = ay + dy * N, lw = W / 170, hl = Math.min(W / 32, len * N * 0.75), hw = W / 60;
  const bx = qx - ux * hl, by = qy - uy * hl;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const [col, w] of [["rgba(5,7,13,.85)", lw + 5], ["#ffffff", lw]]) {
    ctx.strokeStyle = col; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(bx - uy * hw, by + ux * hw); ctx.lineTo(bx + uy * hw, by - ux * hw); ctx.closePath();
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(5,7,13,.85)"; ctx.stroke(); ctx.fillStyle = "#ffffff"; ctx.fill();
  const ring = (x, y, col) => { ctx.lineWidth = 6; ctx.strokeStyle = "rgba(5,7,13,.85)"; ctx.beginPath(); ctx.arc(x, y, W / 90, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke(); };
  ring(ax, ay, "#5aa9ff");                     // first season (measured)
  if (N > 1) ring(zx, zy, "#ff6b6b");          // true end (last season)
  const sp = speedOf(null, { s: p.shift, e: p.err, dt: p.dtYears, pa: p.pa });
  const l1 = speedText(sp), l2 = scaleText(N), f1 = Math.round(W / 26), f2 = Math.round(W / 34);
  ctx.font = `700 ${f1}px system-ui, sans-serif`;
  const bw = Math.max(ctx.measureText(l1).width, (ctx.font = `700 ${f2}px system-ui, sans-serif`, ctx.measureText(l2).width)), bh = f1 + f2 + 8;
  const clampX = (x0) => Math.min(Math.max(x0, 8), W - 8 - bw);
  const mx = (ax + qx) / 2, top = Math.min(ay, qy) - 14 - bh, bot = Math.max(ay, qy) + 14;
  const y0 = top >= 8 ? top : bot + bh <= H - 40 ? bot : Math.max(8, top);
  const cx = clampX(mx - bw / 2) + bw / 2;
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
  const fr = current.frames[frameIdx % current.frames.length];
  const zoom = Number($("zoom").value);
  const cv = $("blink");
  const toCanvas = drawToCanvas(cv, grayImageData(fr.norm, current.n), current.n, zoom);
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
  const toCanvas = drawToCanvas(cv, divergingImageData(current.diff, current.n, 0.6), current.n, zoom);
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
  if (a.pairs.length) {
    const p = a.pairs.find((q) => q.from === a.positions[0].season && q.to === a.positions[a.positions.length - 1].season);
    // grafikler: the headline is the speed per year = shift ÷ time, from the same-orientation pair closest to a year
    // (there the yearly parallax wobble nearly cancels); the shift itself follows as a second line
    const q = a.pairs.filter((x) => x.sameOrientation && x.dtYears > 0.3).sort((x, y) => Math.abs(x.dtYears - 1) - Math.abs(y.dtYears - 1))[0] || (p && p.dtYears > 0.3 ? p : null);
    const sp = q ? { v: q.shift / q.dtYears, e: q.err / q.dtYears, p: q.gaiaShift != null ? q.gaiaShift / q.dtYears : null } : null;
    if (sp) {
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
            + `<p class="small">${t("gr.sk.catAt", { src: c.src === "SIMBAD" ? "SIMBAD" : "ESA Gaia DR3", p: GR.rateTxt(c.v, sp.e), d: num(c.sep, 1) })}</p>`;
        });
      }
    }
    html += `<p${sp ? "" : ' class="big"'}>${t("sk.m.shift", { who, from: p.from, to: p.to, shift: fmtArc(p.shift), pa: num(p.pa, 1), err: num(p.err, 2) })}`;
    if (p.gaiaShift != null) html += t("sk.m.cat", { shift: fmtArc(p.gaiaShift), pa: num(p.gaiaPa, 1) });
    html += "</p>";
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
async function showSpectrum() {
  const box = $("spectrum");
  if (!box || !run || !run.engine || run.engine.closed || typeof run.engine.spectrum !== "function") return;
  const myRun = run;
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
        },
        show(um) { if (!run.results[um]) return; current = run.results[um]; frameIdx = 0; $("viewer").hidden = false; showFrame(); showDiff(); startBlink(); showMotion(); },
        redraw() { if (current) showFrame(); },
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
