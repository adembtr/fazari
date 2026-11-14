// Fazari flag layer for ornek.html: an on/off overlay of the pixels that SPHEREx flagged in the
// blink frame on screen (saturated / masked / other flags), built by pipeline/flags.py into
// <data>/flags/flags.json + flags_<bin>um.png (R/G/B = saturated/masked/other, frames stacked in meta.json order),
// and the list of the images behind the blink (meta.json frames + images.csv: obs_id, date,
// detector, wavelength).
//
// Hook: <script src="js/flags_view.js"></script> in ornek.html; controls go into #flagControls (else
// after #faintControls). It follows the frame through the "fazari:frame" event and #frame's src
// (<data>/frames/<season>_<bin>um.png). The overlay follows the blink frame; in Swipe and Trail
// (two seasons at once) it is hidden. URL options: flags=1 (overlay on), fsrc=1 (image list open).
// Also the note under the image when the frame's saturated core is a display fill (#coreNote).
(function () {
  "use strict";
  const Q = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  // i18n: Turkish from site/i18n/tr.json ("vw.fl.*", "vw.src.*") once js/i18n.js is on the page
  const T = (key, en, p) => {
    const I = window.__fzI18n, s = I && I.lang() === "tr" ? I.t(key, null, en) : en;
    return p ? s.replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : s;
  };
  const locN = s => { const I = window.__fzI18n; return I && I.lang() === "tr" ? I.loc(s) : String(s); };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const frameImg = $("frame"), zoomer = $("zoomer");
  if (!frameImg || !zoomer) return;

  // bit -> colour (RGB) and label; drawn in this order of priority (one colour per pixel)
  const GROUPS = [
    { bit: 1, key: "saturated", rgb: [255, 45, 85], label: () => T("vw.fl.sat", "saturated") },
    { bit: 2, key: "masked", rgb: [46, 197, 255], label: () => T("vw.fl.mask", "masked / no data") },
    { bit: 4, key: "other", rgb: [255, 204, 0], label: () => T("vw.fl.other", "other flags") },
  ];
  let BASE = null, fl = null, flState = "wait";      // flags.json; "wait" | "ok" | "none"
  let meta = null, rows = null, rowsState = "wait";  // meta.json; images.csv rows by file name
  let cur = { epoch: null, bin: null };
  let on = Q.get("flags") === "1";
  const masks = {};                                  // png file -> Promise<Uint8Array>

  // ---- UI ----------------------------------------------------------------------------------------
  function css() {
    const s = document.createElement("style");
    s.textContent = `
      .flagbar { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; background:var(--card,#151925);
                 padding:8px 12px; border-radius:8px; margin:0 0 10px; font-size:.9rem; }
      .flagbar b { color:var(--acc,#ffb347); font-weight:600; }
      #fl-legend { display:flex; flex-wrap:wrap; gap:4px 12px; flex-basis:100%; }
      .flagbar .fl-lg { display:inline-flex; align-items:center; gap:5px; color:var(--mut,#9aa3b2); font-size:.85rem; white-space:nowrap; }
      .flagbar .fl-sw { width:11px; height:11px; border-radius:2px; display:inline-block; }
      .flagbar .fl-note { color:var(--mut,#9aa3b2); font-size:.82rem; flex-basis:100%; }
      #flagcv { position:absolute; left:0; width:100%; image-rendering:pixelated; pointer-events:none; display:none; z-index:4; }   /* ornek.html: frame 1, faint 2, frameB/trail 3, candLayer 5 */
      .framesrc { background:var(--card,#151925); border-radius:8px; padding:6px 12px; margin:0 0 10px; font-size:.88rem; }
      .framesrc summary { cursor:pointer; color:var(--fg,#e6e9ef); }
      .framesrc .tw { overflow-x:auto; max-height:320px; overflow-y:auto; margin-top:6px; }
      .framesrc table { border-collapse:collapse; width:100%; font-size:.8rem; font-variant-numeric:tabular-nums; }
      .framesrc th, .framesrc td { text-align:left; padding:2px 6px 2px 0; white-space:nowrap; }
      .framesrc tr.ep td { color:var(--mut,#9aa3b2); padding-top:6px; white-space:normal; }
      .framesrc tr.on td { color:var(--acc,#ffb347); }
      .framesrc .src-note { color:var(--mut,#9aa3b2); font-size:.8rem; margin:4px 0 0; }
      .corenote { margin:6px 0 0; font-size:.82rem; color:var(--acc,#ffb347); }`;
    document.head.appendChild(s);
  }
  function ui() {
    css();
    let mount = $("flagControls");
    if (!mount) {
      mount = document.createElement("div");
      mount.id = "flagControls";
      const after = $("faintControls") || document.querySelector(".controls");
      after.parentNode.insertBefore(mount, after.nextSibling);
    }
    const bar = document.createElement("div");
    bar.className = "flagbar";
    bar.id = "flagbar";
    bar.innerHTML = `<label><input type="checkbox" id="fl-on"> <b id="fl-title"></b></label>
      <span id="fl-legend"></span><span class="fl-note" id="fl-note"></span>`;
    mount.appendChild(bar);
    const det = document.createElement("details");
    det.className = "framesrc";
    det.id = "frameSrc";
    det.innerHTML = `<summary id="src-sum"></summary><div id="src-body"></div>`;
    mount.appendChild(det);
    det.addEventListener("toggle", () => { if (det.open) loadRows().then(table); });
    if (Q.get("fsrc") === "1") det.open = true;
    const cv = document.createElement("canvas");
    cv.id = "flagcv";
    zoomer.insertBefore(cv, $("candLayer") || null);       // above the frame, below the markers
    $("fl-on").checked = on;
    $("fl-on").onchange = e => { on = e.target.checked; render(); };
    const cn = document.createElement("p");            // saturated core note, right under the image
    cn.id = "coreNote"; cn.className = "corenote"; cn.hidden = true;
    const stage = $("stage");
    if (stage) stage.parentNode.insertBefore(cn, stage.nextSibling); else mount.appendChild(cn);
    texts();
  }
  function texts() {
    $("fl-title").textContent = T("vw.fl.title", "Flagged pixels");
    $("fl-on").parentNode.title = T("vw.fl.tip", "Pixels that SPHEREx flagged in most images of this frame (FLAGS extension). " +
      "Saturated = the saturation mask of the frame (white or bright core); masked = removed before stacking or no data; other = kept but " +
      "flagged (ghost, halo, bloom, crosstalk).");
    summary();
  }

  // ---- which frame is on screen ---------------------------------------------------------------------
  function parseFrame() {
    const m = /^(.*?)frames\/([^/]+?)_([0-9.]+)um\.png/.exec(frameImg.getAttribute("src") || "");
    if (m) { cur = { epoch: m[2], bin: (+m[3]).toFixed(1) }; if (BASE == null) BASE = m[1]; }
  }
  const twoSeasons = () => { const b = $("frameB"), t = $("trail"); return (b && !b.hidden) || (t && !t.hidden); };

  // ---- flag overlay ------------------------------------------------------------------------------------
  function loadMask(file) {
    if (!masks[file]) {
      masks[file] = new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => {
          const c = document.createElement("canvas");
          c.width = im.naturalWidth; c.height = im.naturalHeight;
          const x = c.getContext("2d", { willReadFrequently: true });
          x.drawImage(im, 0, 0);
          // one channel per group, 0 or 255 (R saturated, G masked, B other): threshold, not exact values
          const d = x.getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
          for (let i = 0; i < out.length; i++) out[i] = (d[4 * i] > 127 ? 1 : 0) | (d[4 * i + 1] > 127 ? 2 : 0) | (d[4 * i + 2] > 127 ? 4 : 0);
          res(out);
        };
        im.onerror = () => rej(new Error(file));
        im.src = BASE + "flags/" + file;
      });
    }
    return masks[file];
  }
  function frameEntry() {
    const b = fl && fl.bins ? fl.bins[cur.bin] : null;
    if (!b) return null;
    const i = b.frames.findIndex(f => f.epoch === cur.epoch);
    return i < 0 ? null : { b, i, f: b.frames[i] };
  }
  function legend(share) {
    const pct = v => v == null ? "" : " " + locN((100 * v).toFixed(v >= 0.1 ? 0 : 1)) + " %";
    $("fl-legend").innerHTML = GROUPS.map(g => `<span class="fl-lg"><span class="fl-sw" style="background:rgb(${g.rgb.join(",")})"></span>` +
      `${esc(g.label())}${share ? esc(pct(share[g.key])) : ""}</span>`).join("");
  }
  function note(s) { $("fl-note").textContent = s || ""; }
  // The saturated core of a frame is a display fill, not data: blink.py / preview.py record per frame
  // how many pixels soft_core smoothed (meta.json frames[].soft_core_px); older frames (no record,
  // e.g. the published site targets) drew it flat white: inferred from the flag layer's saturated share.
  function coreNote() {
    const el = $("coreNote");
    if (!el) return;
    const b = bin(), mf = b ? (b.frames || []).find(f => f.epoch === cur.epoch) : null;
    let key = null;
    if (mf && typeof mf.soft_core_px === "number") key = mf.soft_core_px > 0 ? "smoothed" : null;
    else { const e = flState === "ok" ? frameEntry() : null; if (e && e.f.available && e.f.share && e.f.share.saturated > 0) key = "white"; }
    if (document.body.dataset.objSat !== "1") key = null;   // only for the object this result is about (viewer.js), not any star in the field
    el.hidden = !key;
    el.textContent = key === "smoothed" ? T("vw.core.smoothed", "Core saturated: shown smoothed, not measured data.")
      : key === "white" ? T("vw.core.white", "Core saturated: shown white, not measured data.") : "";
  }
  let tok = 0;
  async function render() {
    const cv = $("flagcv"), box = $("fl-on");
    if (!cv) return;
    coreNote();
    const my = ++tok;
    box.disabled = flState === "none";
    if (flState === "none") { cv.style.display = "none"; legend(null); note(T("vw.fl.na", "Flags not available for this result.")); return; }
    if (flState === "wait") { cv.style.display = "none"; legend(null); note(""); return; }
    const e = frameEntry();
    legend(e && e.f.available ? e.f.share : null);
    if (!on) { cv.style.display = "none"; note(""); return; }
    if (!e || !e.f.available) { cv.style.display = "none"; note(T("vw.fl.naFrame", "No flag data for this frame.")); return; }
    if (twoSeasons()) { cv.style.display = "none"; note(T("vw.fl.blinkOnly", "The flag overlay follows the blink frame; it is hidden while two seasons are shown (Swipe, Trail).")); return; }
    let px;
    try { px = await loadMask(e.b.file); } catch (_) { note(T("vw.fl.loadErr", "Could not load the flag masks.")); return; }
    if (my !== tok) return;
    const g = fl.grid, n = g.size_px[0], N = n * n, o = e.i * N;
    cv.width = n; cv.height = n;
    const ctx = cv.getContext("2d"), im = ctx.createImageData(n, n);
    for (let k = 0; k < N; k++) {
      const v = px[o + k];
      if (!v) continue;
      const c = (v & 1) ? GROUPS[0].rgb : (v & 2) ? GROUPS[1].rgb : GROUPS[2].rgb;
      im.data[4 * k] = c[0]; im.data[4 * k + 1] = c[1]; im.data[4 * k + 2] = c[2]; im.data[4 * k + 3] = 170;
    }
    ctx.putImageData(im, 0, 0);
    const H = (g.png_px || [0, n * g.upscale + g.label_strip_px])[1];
    cv.style.top = (100 * g.label_strip_px / H) + "%";
    cv.style.height = (100 * n * g.upscale / H) + "%";
    cv.style.display = "block";
    note(T("vw.fl.frameNote", "{um} µm, {ep}: flags of {n} images (shown where most images are flagged).",
      { um: locN(cur.bin), ep: cur.epoch, n: e.f.n_read }));
  }

  // ---- images behind the blink ---------------------------------------------------------------------
  function bin() {
    return meta ? (meta.wavelength_bins || []).find(b => (+b.wavelength_um).toFixed(1) === cur.bin) : null;
  }
  function summary() {
    const b = bin(), el = $("src-sum");
    if (!el) return;
    if (!b) { el.textContent = T("vw.src.title", "Images behind this blink"); return; }
    const n = b.frames.reduce((s, f) => s + (f.files || []).length, 0);
    el.textContent = T("vw.src.sum", "Images behind this blink: {n} ({um} µm, {k} seasons)", { n, um: locN(cur.bin), k: b.frames.length });
  }
  function parseCsv(text) {               // small CSV reader (quoted fields allowed)
    const out = [], lines = text.split(/\r?\n/).filter(Boolean);
    const split = l => { const r = []; let f = "", q = false;
      for (let i = 0; i < l.length; i++) { const ch = l[i];
        if (q) { if (ch === '"') { if (l[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
        else if (ch === '"') q = true; else if (ch === ",") { r.push(f); f = ""; } else f += ch; }
      r.push(f); return r; };
    const head = split(lines[0] || "");
    for (const l of lines.slice(1)) { const v = split(l), o = {}; head.forEach((h, i) => { o[h] = v[i]; }); out.push(o); }
    return out;
  }
  function loadRows() {
    if (rowsState !== "wait") return Promise.resolve();
    rowsState = "loading";
    return fetch(BASE + "images.csv").then(r => r.ok ? r.text() : Promise.reject(r.status)).then(t => {
      rows = {};
      for (const r of parseCsv(t)) if (r.file) rows[r.file] = r;
      rowsState = "ok";
    }).catch(() => { rows = null; rowsState = "none"; });
  }
  function fromName(name) {               // fallback: obs_id and detector from the file name
    const m = /level2_(.+?)D(\d)_spx/.exec(name || "");
    return m ? { obs_id: m[1], detector: "D" + m[2] } : { obs_id: name, detector: "" };
  }
  function table() {
    const det = $("frameSrc"), body = $("src-body");
    summary();
    if (!det || !det.open || !body) return;
    const b = bin();
    if (!b) { body.innerHTML = ""; return; }
    if (rowsState === "loading") { body.innerHTML = `<p class="src-note">${esc(T("vw.src.loading", "Loading…"))}</p>`; return; }
    let h = `<div class="tw"><table><tr><th>${esc(T("vw.src.obs", "obs_id"))}</th><th>${esc(T("vw.src.date", "Date"))}</th>` +
      `<th>${esc(T("vw.src.det", "Detector"))}</th><th>${esc(T("vw.src.wl", "λ (µm)"))}</th></tr>`;
    for (const f of b.frames) {
      const files = f.files || [];
      const now = f.epoch === cur.epoch;
      h += `<tr class="ep${now ? " on" : ""}" data-ep="${esc(f.epoch)}"><td colspan="4">` +
        esc(T("vw.src.season", "Season {ep}: {n} images", { ep: f.epoch, n: files.length })) +
        (now ? " · " + esc(T("vw.src.onScreen", "on screen")) : "") + `</td></tr>`;
      for (const name of files) {
        const r = (rows && rows[name]) || fromName(name);
        const wl = r.wavelength_um ? locN((+r.wavelength_um).toFixed(3)) : "";
        h += `<tr class="${now ? "on" : ""}" data-ep="${esc(f.epoch)}" title="${esc(name)}"><td>${esc(r.obs_id)}</td><td>${esc(r.date || "")}</td>` +
          `<td>${esc(r.detector || "")}</td><td>${esc(wl)}</td></tr>`;
      }
    }
    h += `</table></div>`;
    if (rowsState === "none") h += `<p class="src-note">${esc(T("vw.src.noCsv", "images.csv not found: obs_id and detector are read from the file names."))}</p>`;
    h += `<p class="src-note">${esc(T("vw.src.note", "Each blink frame is the median of these SPHEREx images (NASA/IPAC IRSA). Hover a row for the file name."))}</p>`;
    body.innerHTML = h;
  }
  function markSeason() {                 // the season on screen, without rebuilding the table
    const det = $("frameSrc");
    if (!det || !det.open) return;
    for (const tr of det.querySelectorAll("tr[data-ep]")) tr.classList.toggle("on", tr.dataset.ep === cur.epoch);
  }

  // ---- start -----------------------------------------------------------------------------------------
  let started = false, lastBin = null;
  function start() {
    parseFrame();
    if (started || BASE == null) return;
    started = true;
    ui();
    fetch(BASE + "meta.json").then(r => r.ok ? r.json() : null).catch(() => null).then(m => { meta = m; lastBin = cur.bin; summary(); table(); coreNote(); });
    loadFlags();
  }
  function loadFlags() {
    fetch(BASE + "flags/flags.json").then(r => r.ok ? r.json() : null).catch(() => null).then(j => {
      fl = j && j.available !== false && j.bins && j.grid ? j : null;
      flState = fl ? "ok" : "none";
      render();
    });
  }
  const onFrame = () => {
    start();
    if (!started) return;
    parseFrame();
    if (cur.bin !== lastBin) { lastBin = cur.bin; table(); } else markSeason();
    render();
  };
  new MutationObserver(onFrame).observe(frameImg, { attributes: true, attributeFilter: ["src"] });
  for (const id of ["frameB", "trail"]) { const el = $(id); if (el) new MutationObserver(() => render()).observe(el, { attributes: true, attributeFilter: ["hidden"] }); }
  document.addEventListener("fazari:frame", onFrame);
  // local engine: flags/ is written by a post-step after the result is on screen (js/post_watch.js)
  document.addEventListener("fazari:post", ev => { if (started && (ev.detail || {}).step === "flags" && flState !== "ok") loadFlags(); });
  document.addEventListener("fazari:lang", () => { if (!started) return; texts(); table(); render(); });
  start();
})();
