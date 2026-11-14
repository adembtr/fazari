// Challenge-item tools on sky.html (in-browser engine), all from the exposures already in memory:
//   frame information under the blink (dates and times, detector, wavelength range, images stacked, flags);
//   "Is there new data?" in the status card; a Deep image (sum of the dates) next to the difference image;
//   tap a star in the blink -> its instant spectrum (ch_worker.js, format fazari-spectrum/1, spectrum_chart.js).
// Reads the page's state through window.__fzSky() and the "fazari:skyframe" event (both from js/app.js).
import { T, esc, L, css, onLang, rangeText, dayText, pct, um as fmtUm, plainFlag, drawGray } from "./ch_common.js";
import { mountNewData } from "./ch_newdata.js";

const $ = (id) => document.getElementById(id);
const S = () => (typeof window.__fzSky === "function" ? window.__fzSky() : {});
const st = { run: null, fi: new Map(), deep: new Map(), mode: "diff", sel: null, spec: null, specBusy: false, specErr: null, csvUrl: null };
window.__chState = st;

const full = () => { const { current } = S(); return !!(current && !current.preview); };
const engineOk = (run) => run && run.engine && !run.engine.closed && typeof run.engine.ch === "function";

function resetFor(run) {
  st.run = run; st.fi.clear(); st.deep.clear(); st.mode = "diff"; st.sel = null; st.spec = null; st.specErr = null;
  if (st.csvUrl) { URL.revokeObjectURL(st.csvUrl); st.csvUrl = null; }
  paintSpec(); paintDeepSeg(); showMode();
}

// ---- frame information ---------------------------------------------------------------------------------
let infoEl = null;
function mountInfo() {
  const info = document.querySelector("#viewer .info");
  if (!info || $("chFrame")) return;
  infoEl = document.createElement("div");
  infoEl.id = "chFrame";
  infoEl.className = "ch-box";
  info.after(infoEl);
}
async function frameInfoFor(run, um) {
  const key = `${um}|${Object.keys(run.results).length}`;
  if (!st.fi.has(key)) st.fi.set(key, run.engine.ch("frameinfo", { um }).then((o) => o.result).catch(() => null));
  return st.fi.get(key);
}
let infoTok = 0;
async function paintInfo() {
  if (!infoEl) return;
  const { run, current, frameIdx } = S();
  if (!run || !current) { infoEl.innerHTML = ""; return; }
  const fr = current.frames[frameIdx % current.frames.length];
  const my = ++infoTok;
  let si = null;
  if (!current.preview && engineOk(run)) {
    const fi = await frameInfoFor(run, current.um);
    if (my !== infoTok) return;
    si = fi && fi.seasons.find((s) => s.season === fr.season);
  }
  infoEl.innerHTML = frameHtml(fr, si, current);
  window.__chFrame = si ? { season: si.season, n: si.n, share: si.share, lam: [si.lamLo, si.lamHi], names: si.names } : { season: fr.season, n: fr.n, preview: !!current.preview };
}
function groupsText(share) {
  const parts = [];
  if (share.saturated > 0.0005) parts.push(T("ch.fi.gSat", "saturated {p}", { p: pct(share.saturated) }));
  if (share.bad > 0.0005) parts.push(T("ch.fi.gBad", "bad pixels {p}", { p: pct(share.bad) }));
  if (share.other > 0.0005) parts.push(T("ch.fi.gOther", "ghost, halo or other {p}", { p: pct(share.other) }));
  return parts.join(", ");
}
function frameHtml(fr, si, cur) {
  const lams = fr.lams && fr.lams.length ? fr.lams : [fr.lam];
  const lo = si && si.lamLo ? si.lamLo : Math.min(...lams), hi = si && si.lamHi ? si.lamHi : Math.max(...lams);
  const when = si ? rangeText(si.mjdFirst, si.mjdLast) : (fr.dateFirst === fr.dateLast ? dayText(fr.dateFirst) : `${dayText(fr.dateFirst)} – ${dayText(fr.dateLast)}`);
  const n = si ? si.n : fr.n;
  const dets = (si ? si.detectors : fr.detectors).join("+");
  let line = T("ch.fi.line", "This frame: {n} images stacked · {when} · detector {det} · {lo}–{hi} µm", { n, when, det: dets, lo: fmtUm(lo), hi: fmtUm(hi) });
  let flags;
  if (!si || !si.share) flags = cur.preview ? T("ch.fi.flagsLater", "Flagged pixels: counted when the full result is in.") : T("ch.fi.flagsNa", "Flagged pixels: not available for this frame.");
  else if (si.share.any < 0.0005) flags = T("ch.fi.flags0", "Flagged pixels in the box: none (below 0.05 %).");
  else flags = T("ch.fi.flags", "Flagged pixels in the box: {p} ({g}).", { p: pct(si.share.any), g: groupsText(si.share) });
  let h = `<p class="ch-line">${esc(line)}.</p><p class="ch-line">${esc(flags)}</p>`;
  if (si) {
    const names = Object.entries(si.names || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    h += `<details class="ch-only-d"><summary>${esc(T("ch.fi.more", "All images and flags of this frame"))}</summary>`;
    h += `<p class="ch-line">${esc(T("ch.fi.names", "SPHEREx FLAGS bits in the box (mean share per image):"))} `
      + (names.length ? names.map(([k, v]) => `<b>${esc(k)}</b> ${esc(pct(v))} (${esc(plainFlag(k))})`).join(", ") : esc(T("ch.fi.noneShort", "none"))) + "</p>";
    h += `<div class="ch-tw"><table><tr><th>obs_id</th><th>${esc(T("ch.fi.th.time", "Start (UTC)"))}</th><th>${esc(T("ch.fi.th.det", "Detector"))}</th>`
      + `<th>${esc(T("ch.fi.th.lam", "λ at the point (µm)"))}</th><th>${esc(T("ch.fi.th.flag", "Flagged"))}</th></tr>`
      + si.images.map((i) => `<tr title="${esc(i.file)}"><td>${esc(i.obs)}</td><td>${esc(rangeText(i.mjd, i.mjd).replace(" UTC", ""))}</td><td>${esc(i.det)}</td>`
        + `<td>${i.lam ? esc(fmtUm(i.lam, 3)) + (i.bw ? " ± " + esc(fmtUm(i.bw / 2, 3)) : "") : "–"}</td><td>${esc(i.share ? pct(i.share.any) : "–")}</td></tr>`).join("")
      + `</table></div><p class="ch-line">${esc(T("ch.fi.note", "Flags from the FLAGS extension of each image, over the detector pixels of this box; the blink masks bad pixels and draws saturated cores smoothed."))}</p></details>`;
  }
  return h;
}

// ---- deep image (sum of the dates) next to the difference image --------------------------------------------
let deepCv = null, deepCap = null, seg = null;
function mountDeep() {
  const diff = $("diff");
  if (!diff || $("chDeepSeg")) return;
  const card = diff.closest(".card");
  seg = document.createElement("div");
  seg.className = "ch-seg"; seg.id = "chDeepSeg"; seg.setAttribute("role", "group");
  seg.innerHTML = `<button type="button" data-m="diff" class="on"></button><button type="button" data-m="deep"></button>`;
  const h2 = card.querySelector("h2");
  (h2 || diff).after(seg);
  deepCv = document.createElement("canvas");
  deepCv.id = "chDeep"; deepCv.className = "ch-deep"; deepCv.width = deepCv.height = 720; deepCv.style.display = "none"; deepCv.style.maxWidth = "none";
  diff.after(deepCv);
  deepCap = document.createElement("p");
  deepCap.id = "chDeepCap"; deepCap.className = "ch-cap"; deepCap.hidden = true;
  ($("diffcap") || deepCv).after(deepCap);
  seg.querySelectorAll("button").forEach((b) => { b.onclick = () => { st.mode = b.dataset.m; showMode(); }; });
  paintDeepSeg();
}
function paintDeepSeg() {
  if (!seg) return;
  const [a, b] = seg.querySelectorAll("button");
  a.textContent = T("ch.dp.diff", "Difference (subtract)");
  b.textContent = T("ch.dp.deep", "Deep image (add)");
  b.title = T("ch.dp.tip", "Add all images of this wavelength together: fainter objects show, motion is hidden.");
  a.classList.toggle("on", st.mode === "diff"); b.classList.toggle("on", st.mode === "deep");
  a.setAttribute("aria-pressed", String(st.mode === "diff")); b.setAttribute("aria-pressed", String(st.mode === "deep"));
  b.disabled = !full();
}
let deepTok = 0;
async function showMode() {
  paintDeepSeg();
  if (!deepCv) return;
  const deep = st.mode === "deep" && full();
  $("diff").style.display = deep ? "none" : ""; if ($("diffcap")) $("diffcap").style.display = deep ? "none" : "";
  deepCv.style.display = deep ? "block" : "none"; deepCap.hidden = !deep;
  if (!deep) return;
  const { run, current } = S();
  if (!engineOk(run)) { deepCap.textContent = T("ch.dp.na", "The deep image needs the images in memory; run the point again."); return; }
  const my = ++deepTok, umv = current.um;
  if (!st.deep.has(umv)) {
    deepCap.textContent = T("ch.dp.busy", "Adding the images…");
    st.deep.set(umv, run.engine.ch("deep", { um: umv }).then((o) => o.result).catch((e) => ({ error: e.message })));
  }
  const d = await st.deep.get(umv);
  if (my !== deepTok || st.mode !== "deep") return;
  if (!d || d.error) { deepCap.textContent = T("ch.dp.fail", "Could not build the deep image ({msg}).", { msg: (d && d.error) || "?" }); return; }
  drawGray(deepCv, d.norm, d.n, Number(($("zoom") || {}).value || 1));
  deepCap.textContent = T("ch.dp.cap", "Deep image at {um} µm: {n} images from {s} seasons ({a} – {b}) added together, aligned on the same grid.", { um: L(umv.toFixed(1)), n: d.nExp, s: d.seasons.length, a: dayText(d.dateFirst), b: dayText(d.dateLast) })
    + (d.noiseGain > 1.05 ? " " + T("ch.dp.gain", "Noise {g}× lower than one season frame, so fainter objects show.", { g: L(d.noiseGain.toFixed(1)) }) : " " + T("ch.dp.gainNo", "Fainter objects show where the noise is lower."))
    + " " + T("ch.dp.hide", "A moving object is smeared or doubled here: this view hides motion; the difference shows it.");
  window.__chDeep = { um: umv, nExp: d.nExp, seasons: d.seasons, noiseGain: d.noiseGain };
}

// ---- instant spectrum of a tapped star ---------------------------------------------------------------------
let specCard = null, ring = null;
function mountSpec() {
  const after = $("spectrum");
  if (!after || $("chSpecCard")) return;
  specCard = document.createElement("div");
  specCard.className = "card ch-spec"; specCard.id = "chSpecCard";
  specCard.innerHTML = `<h2 id="chSpecH"></h2><p class="ch-hint" id="chSpecHint"></p><div id="chSpecChart" hidden></div><p class="ch-cap" id="chSpecNote"></p>`;
  after.after(specCard);
  const cv = $("blink");
  if (cv) {
    cv.style.cursor = "crosshair";
    const host = cv.parentElement;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    ring = document.createElement("div"); ring.className = "ch-ring"; ring.id = "chRing";
    host.appendChild(ring);
    cv.addEventListener("click", onTap);
    window.addEventListener("resize", placeRing);
  }
  paintSpec();
}
function gridFromEvent(ev) {
  const { current } = S(), cv = $("blink"), r = cv.getBoundingClientRect();
  const n = current.n, zoom = Number(($("zoom") || {}).value || 1), src = n / zoom, s0 = (n - src) / 2;
  return [(ev.clientX - r.left) / r.width * src + s0 - 0.5, (ev.clientY - r.top) / r.height * src + s0 - 0.5];
}
function placeRing() {
  if (!ring) return;
  const { current, run } = S(), cv = $("blink");
  if (!st.sel || !current || current.preview || !run || st.sel.run !== run) { ring.style.display = "none"; return; }
  const n = current.n, zoom = Number(($("zoom") || {}).value || 1), src = n / zoom, s0 = (n - src) / 2;
  const w = cv.clientWidth, h = cv.clientHeight, sx = w / src;
  const x = cv.offsetLeft + ((st.sel.gx + 0.5) - s0) * sx, y = cv.offsetTop + ((st.sel.gy + 0.5) - s0) * (h / src);
  const rad = 5 * sx;                                   // the 15" aperture (3" pixels)
  Object.assign(ring.style, { display: "block", left: `${x - rad}px`, top: `${y - rad}px`, width: `${2 * rad}px`, height: `${2 * rad}px` });
}
async function onTap(ev) {
  const { run, current, frameIdx } = S();
  if (!run || !current) return;
  if (current.preview || !full()) { st.specErr = T("ch.sp.wait", "The spectrum of a tapped star is ready when the full result is in."); paintSpec(); return; }
  if (!engineOk(run)) { st.specErr = T("ch.sp.na", "The images are no longer in memory; run the point again."); paintSpec(); return; }
  let [gx, gy] = gridFromEvent(ev);
  const fr = current.frames[frameIdx % current.frames.length], n = current.n;
  // snap to the brightest pixel within 3 pixels (9"), then a light-weighted centre (3 x 3)
  let best = -1, bx = Math.round(gx), by = Math.round(gy);
  for (let j = Math.round(gy) - 3; j <= Math.round(gy) + 3; j++) for (let i = Math.round(gx) - 3; i <= Math.round(gx) + 3; i++) {
    if (i < 1 || j < 1 || i >= n - 1 || j >= n - 1) continue;
    const v = fr.norm[j * n + i];
    if (v > best) { best = v; bx = i; by = j; }
  }
  let sw = 0, sx = 0, sy = 0;
  const bgv = fr.norm[Math.max(0, by - 6) * n + bx] || 0;
  for (let j = by - 1; j <= by + 1; j++) for (let i = bx - 1; i <= bx + 1; i++) { const w = Math.max(0, fr.norm[j * n + i] - bgv); sw += w; sx += w * i; sy += w * j; }
  [gx, gy] = sw > 0 ? [sx / sw, sy / sw] : [bx, by];
  const useTarget = !!(run.target && fr.gaiaXY && Math.hypot(fr.gaiaXY[0] - gx, fr.gaiaXY[1] - gy) <= 3);
  const [ra, dec] = run.grid.pixToSky(gx, gy);
  st.sel = { run, gx, gy, ra, dec, useTarget };
  placeRing();
  st.specBusy = true; st.specErr = null; paintSpec();
  const name = useTarget ? run.target.name : T("ch.sp.name", "Star at RA {ra}° Dec {dec}°", { ra: L(ra.toFixed(4)), dec: L(dec.toFixed(4)) });
  const t0 = performance.now();
  try {
    const { result } = await run.engine.ch("spectrum", { ra, dec, useTarget, name });
    if (st.sel.run !== run || st.sel.ra !== ra) return;
    st.spec = result; st.spec.__ms = Math.round(performance.now() - t0);
    window.__chSpec = { name, ra, dec, ms: st.spec.__ms, summary: result.summary, binned: result.binned, points: result.points.length };
  } catch (e) {
    st.specErr = T("ch.sp.fail", "Could not measure this star ({msg}).", { msg: e.message || String(e) });
  } finally { st.specBusy = false; paintSpec(); }
}
async function paintSpec() {
  if (!specCard) return;
  $("chSpecH").textContent = T("ch.sp.h", "Spectrum of any star here");
  const hint = $("chSpecHint"), chart = $("chSpecChart"), note = $("chSpecNote");
  hint.textContent = st.specBusy ? T("ch.sp.busy", "Measuring in every loaded image…")
    : st.specErr || (st.spec ? (st.spec.summary && st.spec.summary.n_exposures && st.spec.summary.n_saturated === st.spec.summary.n_exposures
      ? T("ch.sp.satAll", "Too bright: saturated in every loaded image, so the aperture gives no estimate. For a target, the spectrum card above estimates it from the PSF wings.")
      : T("ch.sp.again", "Tap another star in the blink to compare.")) : T("ch.sp.hint", "Tap a star in the blink above: its spectrum appears here at once, measured in the images already loaded (no download)."));
  if (!st.spec) { chart.hidden = true; note.textContent = ""; return; }
  const [{ renderSpectrum }, { toCsv }] = await Promise.all([import("./spectrum_chart.js"), import("./spectrum.js")]);
  if (!st.spec) return;
  if (!st.csvUrl) st.csvUrl = URL.createObjectURL(new Blob([toCsv(st.spec)], { type: "text/csv" }));
  chart.hidden = false;
  renderSpectrum(chart, st.spec, { title: T("ch.sp.title", "Instant spectrum: {name}", { name: st.spec.target }), csvUrl: st.csvUrl,
                                   csvName: `${String(st.spec.target).replace(/[^A-Za-z0-9]+/g, "_")}_instant_spectrum.csv` });
  note.innerHTML = `<a href="${esc(st.csvUrl)}" download="${esc(String(st.spec.target).replace(/[^A-Za-z0-9]+/g, "_"))}_instant_spectrum.csv">${esc(T("ch.sp.csv", "Download CSV"))}</a> · `
    + esc(T("ch.sp.method", "Aperture photometry (15″ radius, 30–45″ background ring) in each loaded image at its own wavelength, corrected for the light outside the aperture; errors from empty apertures. AB = 23.9 − 2.5 log₁₀(flux/µJy). Saturated cores are not measured; a neighbour within ~20″ adds its light."))
    + ` <span class="ch-only-d">${esc(T("ch.sp.took", "Measured in {s} s from {n} images, 0 bytes downloaded.", { s: L((st.spec.__ms / 1000).toFixed(1)), n: st.spec.n_files }))}</span>`;
}

// ---- new data -------------------------------------------------------------------------------------------
function mountNew() {
  const host = $("fovEst") ? $("fovEst").parentElement : null;
  if (!host || $("chNew")) return null;
  return mountNewData(host, () => {
    const { run } = S();
    if (!run || !run.info) return null;
    const res = Object.values(run.results || {});
    const frames = res.length ? res.flatMap((r) => r.frames) : run.preview ? run.preview.frames : [];
    if (!frames.length) return null;
    const lastDate = frames.map((f) => f.dateLast).sort().pop();
    return { ra: run.info.ra0, dec: run.info.dec0, lastDate, addHref: null };
  });
}

// ---- wiring ----------------------------------------------------------------------------------------------
css();
mountInfo(); mountDeep(); mountSpec();
const nd = mountNew();
let lastKey = "";
document.addEventListener("fazari:skyframe", () => {
  const { run, current, frameIdx } = S();
  if (run !== st.run) resetFor(run);
  const key = `${current && current.um}|${current && current.preview}|${frameIdx}|${Object.keys((run && run.results) || {}).length}|${(($("zoom") || {}).value)}`;
  if (key === lastKey) return;
  const umChanged = lastKey.split("|")[0] !== key.split("|")[0] || lastKey.split("|")[1] !== key.split("|")[1] || lastKey.split("|")[4] !== key.split("|")[4];
  lastKey = key;
  paintInfo();
  if (umChanged) { paintDeepSeg(); if (st.mode === "deep") showMode(); placeRing(); }
});
onLang(() => { paintInfo(); paintDeepSeg(); if (st.mode === "deep") showMode(); paintSpec(); if (nd) nd.paint(); });
document.addEventListener("fazari:ui-mode", () => paintInfo());
