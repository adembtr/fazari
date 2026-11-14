// UI of sky.html: input -> sky index -> SkySession (sky.js) -> blink, difference, motion.
import { stats, events } from "./net.js";
import { SkySession, CONFIG } from "./sky.js";
import { TARGETS } from "./targets.js";
import { parseCoords, matchTarget, sesame } from "./resolve.js";
import { highPmStars } from "./gaia.js";
import { propagate, offsetArcsec, jyearToMjd } from "./astro.js";

// Sky index: the real module (skyindex.js) when it is there, else the dev stand-in.
// To switch for good, change this one line.
const INDEX_MODULES = ["./skyindex.js", "./skyindex_dev.js"];

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SCALE = 4;            // display pixels per grid pixel (180 -> 720)

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
let run = null;            // {ctl, session, target, ...}
let current = null;        // displayed bin result
let frameIdx = 0, timer = null, playing = true;
let fieldStars = [];       // Gaia high-PM stars (other coordinates)
const t0 = { start: 0 };

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}
function fmtMB(b) { return (b / 1e6).toFixed(1) + " MB"; }

let progressInfo = { checked: 0, accepted: 0, done: 0 };
let rafPending = false;
function renderProgress() {
  rafPending = false;
  if (!run) return;
  const sec = ((performance.now() - t0.start) / 1000).toFixed(1);
  $("progress").textContent = `Images: ${progressInfo.done} downloaded of ${progressInfo.accepted} selected`
    + ` (${progressInfo.checked} headers checked) · ${fmtMB(stats.bytes)} in ${stats.requests} requests`
    + (stats.retries ? ` · ${stats.retries} retries` : "") + ` · ${sec} s`;
  const p = progressInfo.accepted ? progressInfo.done / progressInfo.accepted : 0;
  $("bar").style.width = `${Math.round(p * 100)}%`;
}
function queueProgress() { if (!rafPending) { rafPending = true; requestAnimationFrame(renderProgress); } }
events.addEventListener("progress", queueProgress);
events.addEventListener("status", (e) => { if (run && !run.finished) setStatus(e.detail.message, "warn"); });

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
  const pxPerArcsec = canvas.width / (current.n / zoom) / CONFIG.pixArcsec;
  ctx.lineWidth = 2;
  if ($("mark").checked && frame.gaiaXY) {
    const [x, y] = toCanvas(...frame.gaiaXY);
    ctx.strokeStyle = "#ffb347";
    ctx.beginPath(); ctx.arc(x, y, Math.max(10, 12 * pxPerArcsec), 0, 2 * Math.PI); ctx.stroke();
  }
  if ($("mark").checked && fieldStars.length && run) {
    ctx.strokeStyle = "#5ad1ff";
    for (const s of fieldStars) {
      const [gx, gy] = run.session.grid.skyToPix(...propagate(s, frame.mjdMean));
      if (gx < -5 || gy < -5 || gx > current.n + 5 || gy > current.n + 5) continue;
      const [x, y] = toCanvas(gx, gy);
      const r = Math.max(8, 9 * pxPerArcsec);
      ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
    }
  }
  if ($("cent").checked && run) {
    const pos = run.astro && run.astro.positions.find((p) => p.season === frame.season);
    if (pos) {
      const [x, y] = toCanvas(...pos.grid);
      ctx.strokeStyle = "#7CFC00"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke();
    }
  }
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
  ctx.fillText("N", cx - 5, cy - 46); ctx.fillText("E", cx - 58, cy + 6);
}

function showFrame() {
  if (!current) return;
  const fr = current.frames[frameIdx % current.frames.length];
  const zoom = Number($("zoom").value);
  const cv = $("blink");
  const toCanvas = drawToCanvas(cv, grayImageData(fr.norm, current.n), current.n, zoom);
  drawOverlay(cv, toCanvas, fr, zoom);
  $("date").textContent = `${fr.season}  (${fr.dateFirst === fr.dateLast ? fr.dateFirst : fr.dateFirst + " to " + fr.dateLast})`;
  $("detail").textContent = `${fr.lam.toFixed(2)} µm · SPHEREx ${fr.detectors.join("+")} · ${fr.n} exposure${fr.n > 1 ? "s" : ""} (median)`;
}

function showDiff() {
  const cv = $("diff");
  const zoom = Number($("zoom").value);
  const toCanvas = drawToCanvas(cv, divergingImageData(current.diff, current.n, 0.6), current.n, zoom);
  const first = current.frames[0], last = current.frames[current.frames.length - 1];
  $("diffcap").textContent = `${last.season} minus ${first.season} at ${current.um.toFixed(1)} µm. Red = later, blue = earlier. Stars that do not move cancel out.`;
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
  $("play").textContent = playing ? "Pause" : "Play";
}

// ---- motion card -------------------------------------------------------------------------------
function fmtArc(v) { return `${v.toFixed(2)}″`; }
function showMotion() {
  const el = $("measure");
  const a = run.session.astrometry();
  run.astro = a;
  if (!a.positions.length) {
    el.innerHTML = "<p>No centroid could be fitted (no point source at the centre, or it is too faint).</p>";
    return;
  }
  const who = run.target ? run.target.name : "the source at the centre";
  let html = "";
  if (a.pairs.length) {
    const p = a.pairs.find((q) => q.from === a.positions[0].season && q.to === a.positions[a.positions.length - 1].season);
    html += `<p class="big">Shift of ${who}, ${p.from} → ${p.to}: <b>${fmtArc(p.shift)}</b> at PA <b>${p.pa.toFixed(1)}°</b>`
      + ` (± ${p.err.toFixed(2)}″)`;
    if (p.gaiaShift != null) html += `<br>Catalogue prediction (proper motion + parallax): ${fmtArc(p.gaiaShift)} at PA ${p.gaiaPa.toFixed(1)}°`;
    html += "</p>";
  }
  html += `<table><tr><th>Season</th><th>Mean date</th><th>N</th><th>Detector angle</th>`
    + (run.target ? "<th>Measured − catalogue (E, N)</th>" : "<th>Offset from centre (E, N)</th>") + "</tr>";
  for (const p of a.positions) {
    const ref = p.gaia || [run.session.ra0, run.session.dec0];
    const o = offsetArcsec(ref[0], ref[1], p.ra, p.dec);
    html += `<tr><td>${p.season}</td><td>${p.date}</td><td>${p.n}</td><td>${p.orient.toFixed(0)}°</td>`
      + `<td>${o[0].toFixed(2)}″, ${o[1].toFixed(2)}″</td></tr>`;
  }
  html += "</table>";
  if (a.pairs.length > 1) {
    html += `<table class="pairs"><tr><th>Pair</th><th>Measured</th><th>Catalogue</th><th>Same orientation</th></tr>`;
    for (const p of a.pairs) {
      html += `<tr><td>${p.from} → ${p.to}</td><td>${fmtArc(p.shift)}, ${p.pa.toFixed(1)}°</td>`
        + `<td>${p.gaiaShift != null ? fmtArc(p.gaiaShift) + ", " + p.gaiaPa.toFixed(1) + "°" : "–"}</td><td>${p.sameOrientation ? "yes" : "no"}</td></tr>`;
    }
    html += "</table>";
  }
  html += `<p class="small">Centroid: Gaussian fit to the unsaturated wings in native 6.15″ pixels, per exposure, `
    + `converted with each exposure's SIP WCS; season = mean after clipping. ${a.nFits} of ${a.nExposures} downloaded exposures fitted `
    + `(bins loaded so far: ${Object.keys(run.session.results).map(Number).sort((a, b) => a - b).map((u) => u.toFixed(1)).join(", ")} µm). `
    + `SPHEREx turns ~180° between the August and March seasons; a small centroid bias fixed to the detector `
    + `then changes sign, so pairs with the same orientation are the cleanest comparison.</p>`;
  el.innerHTML = html;
}

// ---- result for headless checks -----------------------------------------------------------------
function writeResult(state, extra = {}) {
  const s = run && run.session;
  const res = {
    state, input: run ? run.input : null, index: indexName,
    target: run && run.target ? run.target.name : null,
    ra: s ? s.ra0 : null, dec: s ? s.dec0 : null,
    n_index_images: s ? s.images.length : 0,
    seasons: s ? s.seasons.map((x) => x.label) : [],
    bins: s ? s.bins.map((b) => ({ um: b.um, detector: b.det, seasons_with_candidates: b.nSeasons, available: b.available })) : [],
    loaded: s ? Object.values(s.results).sort((a, b) => a.um - b.um).map((r) => ({ um: r.um, detector: r.det,
      frames: r.frames.map((f) => ({ season: f.season, n: f.n, detectors: f.detectors, lam_um: +f.lam.toFixed(4), lams: f.lams,
                                     date_first: f.dateFirst, date_last: f.dateLast })) })) : [],
    astrometry: run && run.astro ? { pairs: run.astro.pairs, positions: run.astro.positions.map((p) => ({ ...p, grid: undefined })) } : null,
    gaia_field: run ? run.gaiaField : null,
    header_checks: s ? s.headerChecks : 0,
    bytes: stats.bytes, requests: stats.requests, retries: stats.retries,
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
    return { key, target: { ...t }, label: t.name };
  }
  const c = parseCoords(text);
  if (c) return { key: null, target: null, ra: c[0], dec: c[1], label: `RA ${c[0].toFixed(5)}°, Dec ${c[1].toFixed(5)}°` };
  setStatus(`Resolving “${text}” with CDS Sesame (SIMBAD)...`);
  const r = await sesame(text, { signal: run.ctl.signal });
  if (!r) throw new Error(`“${text}” is not a coordinate and the name resolver does not know it`);
  const moving = Math.hypot(r.pmra, r.pmdec) > 0;
  return { key: null, target: moving ? r : null, ra: r.ra, dec: r.dec, label: `${r.name} (${r.source})`, resolved: r };
}

function updateUrl(q) {
  const u = new URL(location.href);
  for (const k of ["target", "ra", "dec", "q"]) u.searchParams.delete(k);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  history.replaceState(null, "", u);
  $("share").href = u.toString();
  $("share").textContent = "Link to this view";
}

async function loadBin(um) {
  const s = run.session;
  const b = s.bins.find((x) => x.um === um);
  for (const btn of document.querySelectorAll("#bins button")) btn.classList.toggle("on", Number(btn.dataset.um) === um);
  if (!s.results[um]) setStatus(`Downloading ${um.toFixed(1)} µm images (detector D${b.det}) from S3...`);
  progressInfo = { checked: 0, accepted: 0, done: 0 };
  const r = await s.loadBin(um, (p) => { progressInfo = p; queueProgress(); });
  if (run.session !== s) return;
  current = r; frameIdx = 0;
  $("viewer").hidden = false;
  showFrame(); showDiff(); startBlink();
  showMotion();
  renderProgress();
}

async function go(text, opts = {}) {
  if (run) { run.ctl.abort(); run.finished = true; }
  clearInterval(timer);
  current = null; fieldStars = [];
  $("viewer").hidden = true; $("bins").innerHTML = ""; $("measure").innerHTML = ""; $("fieldnote").textContent = "";
  run = { ctl: new AbortController(), input: text, finished: false, gaiaField: null };
  const myRun = run;
  t0.start = performance.now();
  stats.bytes = 0; stats.requests = 0; stats.retries = 0;
  writeResult("running");
  try {
    const r = await resolveInput(text);
    run.target = r.target;
    const [ra, dec] = r.target ? propagate(r.target, jyearToMjd(CONFIG.epochCenter), false) : [r.ra, r.dec];
    updateUrl(r.key ? { target: r.key } : r.resolved ? { q: text } : { ra: ra.toFixed(6), dec: dec.toFixed(6) });
    $("what").textContent = r.label + (r.target && (r.target.pmra || r.target.pmdec)
      ? ` · proper motion ${Math.hypot(r.target.pmra, r.target.pmdec).toFixed(0)} mas/yr` : "");
    setStatus("Searching the SPHEREx sky index...");
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
      const devNote = indexName === "skyindex_dev.js" ? " (development index: it only knows the 5 challenge targets)" : "";
      throw new Error(`No SPHEREx images here${devNote}.`);
    }
    const cfg = {};
    if (params.get("cap")) cfg.cap = Math.max(1, Math.min(12, Number(params.get("cap"))));
    if (params.get("fov")) cfg.fovDeg = Math.max(0.05, Math.min(0.3, Number(params.get("fov"))));
    if (opts.cap) cfg.cap = opts.cap;
    const session = new SkySession({ ra, dec, target: r.target, images, config: cfg, signal: run.ctl.signal });
    run.session = session;
    const avail = session.bins.filter((b) => b.available);
    $("found").textContent = `${images.length} SPHEREx exposures cover this point, in ${session.seasons.length} season(s): `
      + session.seasons.map((x) => x.label).join(", ") + ".";
    if (!avail.length) throw new Error("No SPHEREx images here with at least two seasons in one wavelength bin.");
    for (const b of session.bins) {
      const btn = document.createElement("button");
      btn.textContent = `${b.um.toFixed(1)} µm`;
      btn.title = `detector D${b.det}; ${b.nSeasons} season(s) with images`;
      btn.dataset.um = b.um;
      btn.disabled = !b.available;
      btn.onclick = () => loadBin(b.um).catch(fail);
      $("bins").appendChild(btn);
    }
    // Gaia high-proper-motion stars in the field, only for positions that are not one of the 5 targets
    if (!r.key) {
      highPmStars(session.ra0, session.dec0, CONFIG.fovDeg * 0.75, 100, { signal: run.ctl.signal }).then((stars) => {
        if (myRun !== run) return;
        fieldStars = stars;
        run.gaiaField = { ok: true, n: stars.length, stars: stars.map((s) => ({ id: s.source_id, pm: s.pm, gmag: s.gmag })) };
        $("fieldnote").textContent = stars.length
          ? `Blue squares: ${stars.length} Gaia DR3 star(s) with proper motion > 100 mas/yr, moved to each season's date (VizieR).`
          : "Gaia DR3 (VizieR): no star with proper motion > 100 mas/yr in this field.";
        if (current) { showFrame(); showDiff(); }
      }).catch((e) => {
        if (myRun !== run) return;
        run.gaiaField = { ok: false, error: e.message };
        $("fieldnote").textContent = `Gaia field stars not shown: ${e.message}.`;
      });
    }
    let first = Number(params.get("bin")) || 2.0;
    if (!avail.some((b) => b.um === first)) first = avail[0].um;
    await loadBin(first);
    if (opts.all || params.get("all") === "1") {
      for (const b of avail) if (b.um !== first) { await loadBin(b.um); }
      await loadBin(first);
    }
    if (myRun !== run) return;
    run.finished = true;
    setStatus(`Done. ${current.frames.length} seasons at ${current.um.toFixed(1)} µm. Pick another wavelength above to download it.`, "ok");
    renderProgress();
    writeResult("done");
  } catch (e) {
    if (myRun !== run || e.name === "AbortError") return;
    fail(e);
  }
}

function fail(e) {
  console.error(e);
  if (run) run.finished = true;
  const msg = /Failed to fetch|NetworkError|did not answer/.test(e.message)
    ? `Network problem: ${e.message}. S3 or your connection may be busy; try again in a minute.` : e.message;
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
$("allbins").onclick = async () => {
  if (!run || !run.session) return;
  try {
    for (const b of run.session.bins.filter((x) => x.available)) await loadBin(b.um);
    setStatus("All wavelength bins loaded.", "ok");
    writeResult("done");
  } catch (e) { fail(e); }
};
for (const a of document.querySelectorAll("[data-q]")) a.onclick = (ev) => { ev.preventDefault(); $("q").value = a.dataset.q; go(a.dataset.q); };

const start = params.get("target") ? (TARGETS[params.get("target")] || {}).name || params.get("target")
  : params.get("ra") && params.get("dec") ? `${params.get("ra")} ${params.get("dec")}` : params.get("q");
if (start) { $("q").value = start; go(start); }
else setStatus("Enter a name or a coordinate, or pick an example.");
