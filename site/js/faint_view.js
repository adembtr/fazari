// Fazari faint-object view for ornek.html: client-side stretch of the float frames written by
// pipeline/faint.py (<data>/faint/faint.json + float16 planes), an S/N view, the per-season deep
// stacks, and the depth / shift-and-stack results.
//
// Hook: <script src="js/faint_view.js"></script> in ornek.html. Nothing changes until the user
// picks a display option: the published PNG stays the default view. If the result has no
// faint/faint.json the module adds nothing. Controls go into #faintControls (else after .controls).
//
// It follows the frame on screen through the viewer's "fazari:frame" event and #frame's src
// (<data>/frames/<season>_<bin>um.png; the data folder is taken from that src). URL options (for
// links and screenshots): fv=linear|log|asinh, fsn=pix|psf, fimg=deep, flo=<sigma>, fhi=<sigma>.
(function () {
  "use strict";
  let BASE = null;
  const Q = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  // i18n: Turkish from site/i18n/tr.json ("fv.*") once js/i18n.js is on the page; English otherwise
  const T = (key, en, p) => {
    const I = window.__fzI18n, s = I && I.lang() === "tr" ? I.t(key, null, en) : en;
    return p ? s.replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : s;
  };
  const locN = s => { const I = window.__fzI18n; return I && I.lang() === "tr" ? I.loc(s) : String(s); };
  const P = s => { const I = window.__fzI18n; return I && I.ptext ? I.ptext(s) : String(s ?? ""); };   // pipeline sentences
  const frameImg = $("frame"), zoomer = $("zoomer");
  if (!frameImg || !zoomer) return;

  let fj = null;                       // faint.json
  const bufs = {};                     // file -> Promise<Float32Array>
  const st = {
    mode: Q.get("fv") || "png",        // png | linear | log | asinh
    sn: Q.get("fsn") || "off",         // off | pix | psf
    img: Q.get("fimg") === "deep" ? "deep" : "frame",
    lo: null, hi: null,                // sigma units relative to the reference median
    exact: true,                       // still the published limits (asinh = PNG look)
  };
  let cur = { epoch: null, bin: null };

  // ---- float16 decoding (lookup table, little endian) ----------------------------------------
  const F16 = new Float32Array(65536);
  (function () {
    for (let h = 0; h < 65536; h++) {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      F16[h] = e === 0 ? s * Math.pow(2, -14) * (f / 1024)
        : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
    }
  })();
  function load(file) {
    if (!bufs[file]) {
      bufs[file] = fetch(BASE + "faint/" + file).then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.arrayBuffer();
      }).then(ab => {
        const u = new Uint16Array(ab), out = new Float32Array(u.length);
        for (let i = 0; i < u.length; i++) out[i] = F16[u[i]];
        return out;
      });
    }
    return bufs[file];
  }

  // ---- UI ------------------------------------------------------------------------------------
  function css() {
    const s = document.createElement("style");
    s.textContent = `
      .faintbar { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; background:var(--card,#151925);
                  padding:8px 12px; border-radius:8px; margin:-4px 0 10px; font-size:.9rem; }
      .faintbar b { color:var(--acc,#ffb347); font-weight:600; }
      .faintbar input[type=range] { width:110px; vertical-align:middle; }
      .faintbar .val { color:var(--mut,#9aa3b2); font-variant-numeric:tabular-nums; min-width:4.2em; display:inline-block; }
      #faintcv { position:absolute; left:0; width:100%; image-rendering:pixelated; display:none; }
      #faintcard table td, #faintcard table th { font-variant-numeric: tabular-nums; }
      #faintcard .tw { overflow-x:auto; }
      #faintcard img { width:100%; image-rendering:pixelated; border-radius:6px; background:#000; }
      #faintcard .two { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      #faintcard .two figure { margin:0; } #faintcard figcaption { color:var(--mut,#9aa3b2); font-size:.85rem; }
      .faintnote { color:var(--mut,#9aa3b2); font-size:.85rem; }`;
    document.head.appendChild(s);
  }
  function ui() {
    css();
    const bar = document.createElement("div");
    bar.className = "faintbar";
    bar.id = "faintbar";
    bar.innerHTML = `<b data-i18n="fv.title">Faint objects</b>
      <label><span data-i18n="fv.stretch">Stretch</span> <select id="fv-mode">
        <option value="png" data-i18n="fv.png">Published (PNG)</option><option value="linear" data-i18n="fv.linear">Linear</option>
        <option value="log">Log</option><option value="asinh">Asinh</option></select></label>
      <label><span data-i18n="fv.show">Show</span> <select id="fv-sn"><option value="off" data-i18n="fv.bright">Brightness</option>
        <option value="pix" data-i18n="fv.snPix">S/N per pixel</option><option value="psf" data-i18n="fv.snPsf">S/N, point-source filtered</option></select></label>
      <label><span data-i18n="fv.image">Image</span> <select id="fv-img"><option value="frame" data-i18n="fv.thisWl">This wavelength</option>
        <option value="deep" data-i18n="fv.deep">Deep stack, all wavelengths</option></select></label>
      <label><span data-i18n="fv.min">Min</span> <input id="fv-lo" type="range" min="-100" max="200" step="1"> <span class="val" id="fv-lov"></span></label>
      <label><span data-i18n="fv.max">Max</span> <input id="fv-hi" type="range" min="0" max="450" step="1"> <span class="val" id="fv-hiv"></span></label>
      <button id="fv-reset" title="Back to the published PNG" data-i18n="fv.reset" data-i18n-attr="title:fv.resetTip">Reset</button>
      <span class="faintnote" id="fv-note"></span>`;
    const mount = $("faintControls");
    if (mount) mount.appendChild(bar);
    else { const ctr = document.querySelector(".controls"); ctr.parentNode.insertBefore(bar, ctr.nextSibling); }
    const cv = document.createElement("canvas");
    cv.id = "faintcv";
    zoomer.insertBefore(cv, frameImg.nextSibling);
    $("fv-mode").value = st.mode; $("fv-sn").value = st.sn; $("fv-img").value = st.img;
    $("fv-mode").onchange = e => { st.mode = e.target.value; if (st.mode === "png") { st.sn = "off"; st.img = "frame"; resetLimits(); } sync(); };
    $("fv-sn").onchange = e => { st.sn = e.target.value; if (st.mode === "png") st.mode = "asinh"; resetLimits(); sync(); };
    $("fv-img").onchange = e => { st.img = e.target.value; if (st.mode === "png") st.mode = "asinh"; resetLimits(); sync(); };
    $("fv-lo").oninput = e => { st.lo = +e.target.value / 10; st.exact = false; if (st.mode === "png") st.mode = "asinh"; sync(); };
    $("fv-hi").oninput = e => { st.hi = Math.pow(10, +e.target.value / 100); st.exact = false; if (st.mode === "png") st.mode = "asinh"; sync(); };
    $("fv-reset").onclick = () => { st.mode = "png"; st.sn = "off"; st.img = "frame"; resetLimits(); sync(); };
    if (Q.get("flo")) { st.lo = +Q.get("flo"); st.exact = false; }
    if (Q.get("fhi")) { st.hi = +Q.get("fhi"); st.exact = false; }
  }
  function resetLimits() { st.lo = st.hi = null; st.exact = true; }
  function sync() {
    $("fv-mode").value = st.mode; $("fv-sn").value = st.sn; $("fv-img").value = st.img;
    render();
  }

  // ---- which data is on screen -----------------------------------------------------------------
  function parseFrame() {
    const m = /^(.*?)frames\/([^/]+?)_([0-9.]+)um\.png/.exec(frameImg.getAttribute("src") || "");
    if (m) { cur = { epoch: m[2], bin: (+m[3]).toFixed(1) }; if (BASE == null) BASE = m[1]; }
  }
  function source() {
    // -> {file, offset, ref:{median, sigma}, stretch, label} or null
    if (!fj || !cur.bin) return null;
    if (st.img === "deep") {
      const d = (fj.deep || []).find(x => x.epoch === cur.epoch);
      if (!d) return null;
      return { file: d.file, offset: 0, ref: { median: d.median_mjysr, sigma: d.pixel_sigma_mjysr }, stretch: d.stretch || null,
               label: T("fv.deepLabel", "Deep stack {ep}: {n} exposures, {det}, {lo}–{hi} µm",
                        { ep: d.epoch, n: d.n_exposures, det: d.detectors.join("+"), lo: locN(d.lam_um[0].toFixed(2)), hi: locN(d.lam_um[1].toFixed(2)) }) };
    }
    const b = (fj.frames || {})[cur.bin];
    if (!b) return null;
    const fr = b.frames.find(x => x && x.epoch === cur.epoch);
    if (!fr) return null;
    // reference median/sigma pooled over the seasons of the bin: one scale for the whole blink
    const fs = b.frames.filter(Boolean);
    const med = a => { const s = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
    return { file: b.file, offset: fr.offset, ref: { median: med(fs.map(x => x.median_mjysr)), sigma: med(fs.map(x => x.pixel_sigma_mjysr)) },
             stretch: b.stretch, label: T("fv.frameLabel", "{um} µm frame {ep}: median of {n} images", { um: locN(cur.bin), ep: cur.epoch, n: fr.n_images }) };
  }

  // ---- rendering --------------------------------------------------------------------------------
  let token = 0;
  async function render() {
    const cv = $("faintcv");
    if (!cv) return;
    const my = ++token;
    if (st.mode === "png" && st.sn === "off" && st.img === "frame") {
      cv.style.display = "none"; label(""); limitsUI(null); return;
    }
    const src = source();
    if (!src) { cv.style.display = "none"; label(st.img === "deep" ? T("fv.noDeep", "No deep stack for this season.") : ""); return; }
    let all;
    try { all = await load(src.file); } catch (e) { label(T("fv.loadErr", "Could not load {f}", { f: src.file })); return; }
    if (my !== token) return;
    const n = fj.grid.size_px[0], N = n * n, o = src.offset / 2;
    const val = all.subarray(o, o + N), sig = all.subarray(o + N, o + 2 * N), psf = all.subarray(o + 2 * N, o + 3 * N);
    // values to display and the reference (median, sigma) for the slider units
    let v, ref, soft;
    if (st.sn === "pix") { v = new Float32Array(N); for (let i = 0; i < N; i++) v[i] = val[i] / sig[i]; ref = { median: 0, sigma: 1 }; soft = 3; }
    else if (st.sn === "psf") { v = psf; ref = { median: 0, sigma: 1 }; soft = 3; }
    else { v = val; ref = src.ref; soft = src.stretch ? src.stretch.soft : 3 * ref.sigma; }
    if (!(ref.sigma > 0)) ref.sigma = 1;
    // limits: published (frame, brightness) or defaults; sliders are in sigma units
    let lo, hi;
    const pub = st.sn === "off" && src.stretch;
    if (st.lo == null || st.hi == null) {
      if (pub) { st.lo = (src.stretch.lo - ref.median) / ref.sigma; st.hi = (src.stretch.hi - ref.median) / ref.sigma; }
      else if (st.sn !== "off") { st.lo = -3; st.hi = 1000; }
      else { st.lo = -1.5; st.hi = 300; }
    }
    if (pub && st.exact) { lo = src.stretch.lo; hi = src.stretch.hi; }
    else { lo = ref.median + st.lo * ref.sigma; hi = ref.median + st.hi * ref.sigma; }
    if (!(hi > lo)) hi = lo + ref.sigma;
    limitsUI(ref, lo, hi);
    const mode = st.mode === "png" ? "asinh" : st.mode;
    const t = new Float32Array(N);
    const aden = Math.asinh((hi - lo) / soft), lden = Math.log10(1001);
    for (let i = 0; i < N; i++) {
      const x = v[i];
      if (x === Infinity) { t[i] = 1; continue; }
      if (x !== x || x === -Infinity) { t[i] = NaN; continue; }
      let y;
      if (mode === "asinh") y = Math.asinh((x - lo) / soft) / aden;
      else if (mode === "log") { const u = Math.min(Math.max((x - lo) / (hi - lo), 0), 1); y = Math.log10(1 + 1000 * u) / lden; }
      else y = (x - lo) / (hi - lo);
      t[i] = y < 0 ? 0 : y > 1 ? 1 : y;
    }
    fillNaN(t, n);
    cv.width = n; cv.height = n;
    const ctx = cv.getContext("2d");
    const im = ctx.createImageData(n, n);
    for (let i = 0; i < N; i++) {
      const g = (t[i] * 255) | 0;
      im.data[4 * i] = im.data[4 * i + 1] = im.data[4 * i + 2] = g; im.data[4 * i + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    const [W, H] = (fj.grid.png_px || [n * fj.grid.png_upscale, n * fj.grid.png_upscale + fj.grid.png_label_strip_px]);
    cv.style.top = (100 * fj.grid.png_label_strip_px / H) + "%";
    cv.style.height = (100 * n * fj.grid.png_upscale / H) + "%";
    cv.style.display = "block";
    label(src.label + (st.sn === "pix" ? T("fv.lblPix", " · S/N per pixel (noise measured)") : st.sn === "psf" ? T("fv.lblPsf", " · point-source S/N (PSF filter)") : "") +
          ` · ${mode}`);
  }
  function fillNaN(a, n) {           // display only, like blink.py fill_nan: mean of valid neighbours
    for (let it = 0; it < 20; it++) {
      let any = false;
      const b = a.slice();
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (a[i] === a[i]) continue;
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= n || xx < 0 || xx >= n) continue;
          const w = a[yy * n + xx];
          if (w === w) { s += w; c++; }
        }
        if (c) b[i] = s / c; else any = true;
      }
      a.set(b);
      if (!any) break;
    }
    for (let i = 0; i < a.length; i++) if (a[i] !== a[i]) a[i] = 0;
  }
  function limitsUI(ref, lo, hi) {
    const l = $("fv-lo"), h = $("fv-hi");
    if (!ref) { $("fv-lov").textContent = ""; $("fv-hiv").textContent = ""; l.disabled = h.disabled = true; return; }
    l.disabled = h.disabled = false;
    l.value = Math.round(st.lo * 10); h.value = Math.round(100 * Math.log10(Math.max(st.hi, 1)));
    const u = st.sn === "off" ? " MJy/sr" : "σ";
    const f = x => Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3);
    $("fv-lov").textContent = st.sn === "off" ? `${st.lo.toFixed(1)}σ` : `${f(lo)}σ`;
    $("fv-hiv").textContent = st.sn === "off" ? `${st.hi.toFixed(st.hi < 10 ? 1 : 0)}σ` : `${f(hi)}σ`;
    l.title = `min = ${f(lo)}${u}`; h.title = `max = ${f(hi)}${u}`;
  }
  function label(s) { const n = $("fv-note"); if (n) n.textContent = s; }

  // ---- results card -----------------------------------------------------------------------------
  const fx = (v, d = 1) => (v == null || !isFinite(v)) ? "–" : locN((+v).toFixed(d));
  let cardSS = null;
  function card(ss) {
    const c = $("faintcard") || document.createElement("div");
    const isNew = !c.id;
    cardSS = ss;
    c.className = "card";
    c.id = "faintcard";
    let h = `<h2>${T("fv.cardTitle", "Faint objects: deep stacks and shift-and-stack")}</h2>`;
    const dp = fj.depth;
    if (dp && dp.single && dp.single.all) {
      const s1 = dp.single.all;
      const rows = (dp.deep || []).filter(r => r.range === "all");
      const sep = window.__fzI18n && window.__fzI18n.lang() === "tr" ? "; " : ", ";
      h += `<p>` + T("fv.one", "One exposure reaches <b>{u} µJy</b> (AB {ab}) at 5σ for a point source. ", { u: fx(s1.limit5_ujy, 0), ab: fx(s1.limit5_ab, 1) }) +
        (rows.length ? T("fv.stackTo", "Stacking all exposures of a season (all wavelengths) goes to <b>{u} µJy</b> (AB {ab}).",
          { u: rows.map(r => fx(r.limit5_ujy, 0)).join(sep), ab: rows.map(r => fx(r.limit5_ab, 1)).join(sep) })
          : T("fv.stackDeeper", "Stacking all exposures of a season (all wavelengths) goes deeper.")) + `</p>`;
      h += `<div class="tw"><table><tr><th>${T("fv.th.image", "Image")}</th><th>${T("fv.th.exp", "Exposures")}</th><th>${T("fv.th.noise", "Noise (µJy, 1σ)")}</th><th>${T("fv.th.limit", "5σ limit")}</th><th>${T("fv.th.blind", "Blind scatter")}</th></tr>` +
        `<tr><td>${T("fv.single", "Single exposure (median)")}</td><td>1</td><td>${fx(s1.flux_sigma_ujy)}</td><td>${fx(s1.limit5_ujy, 0)} µJy · AB ${fx(s1.limit5_ab, 2)}</td><td>${fx(s1.blind_flux_sigma_ujy, 0)}</td></tr>` +
        (dp.deep || []).map(r => `<tr><td>${T("fv.deepRow", "Deep {ep} ({range})", { ep: r.epoch, range: r.range })}</td><td>${r.n_exposures}</td><td>${fx(r.flux_sigma_ujy, 2)}</td>` +
          `<td>${fx(r.limit5_ujy, 0)} µJy · AB ${fx(r.limit5_ab, 2)}</td><td>${fx(r.blind_flux_sigma_ujy, 0)}</td></tr>`).join("") + `</table></div>` +
        `<p class="faintnote">` + T("fv.noiseNote", "Noise measured from difference images (static stars cancel). \"Blind scatter\" is the scatter of the " +
        "image itself; when it is much larger than the noise, faint stars fill the field (source confusion) and only " +
        "difference images reach the deep limit.") + `</p>`;
    }
    if ((fj.deep || []).length) {
      h += `<p class="faintnote">${T("fv.deepHint", "Deep stacks: pick “Image: Deep stack” above; it blinks season by season like the frames.")}</p>`;
    }
    if (ss) h += shiftCard(ss);
    c.innerHTML = h;
    if (!isNew) return;
    const after = document.querySelector(".lower") || document.querySelector(".card.diff") || $("measure").parentNode;
    after.insertAdjacentElement("afterend", c);
  }
  function shiftCard(ss) {
    let h = `<h2 style="margin-top:12px">${T("fv.ssTitle", "Shift-and-stack search")}</h2>`;
    for (const r of (ss.runs || [])) {
      h += `<p>${P(r.summary || "")}</p>`;
      if (r.peak_map_png) {
        h += `<div class="two"><figure><img src="${BASE}faint/${r.peak_map_png}" alt="${T("fv.peakAlt", "shift-and-stack peak map")}"><figcaption>` +
          T("fv.peakCap", "Best S/N over all trial motions at each position ({n} trial motions{unit}). Circles: peaks ≥ {thr}σ.",
            { n: r.n_velocities, unit: r.unit ? ", " + r.unit : "", thr: fx(r.threshold, 1) }) + `</figcaption></figure>`;
        if (r.vmap_png) h += `<figure><img src="${BASE}faint/${r.vmap_png}" alt="${T("fv.vmapAlt", "S/N against motion at the best peak")}"><figcaption>` +
          `${T("fv.vmapCap", "S/N against trial motion at the best peak.")}</figcaption></figure>`;
        h += `</div>`;
      }
      const pk = (r.peaks || []).slice(0, 8);
      if (pk.length) {
        const known = p => p.match && (p.match.target || p.match.gaia_dr3) ?
          T("fv.known", "known: {name}", { name: (p.match.target && p.match.target.name) || "Gaia DR3 " + p.match.gaia_dr3.source_id }) : "";
        h += `<div class="tw"><table><tr><th>#</th><th>S/N</th><th>${T("fv.th.motion", "Motion")}</th><th>${T("fv.th.pos", "Position (RA, Dec)")}</th><th>${T("fv.th.flux", "Flux")}</th><th>${T("fv.th.class", "Class")}</th><th>${T("fv.th.note", "Note")}</th></tr>` +
          pk.map((p, i) => `<tr><td>${i + 1}</td><td>${fx(p.snr)}</td><td>${P(p.motion_text || "")}</td>` +
            `<td>${fx(p.ra, 5)}, ${fx(p.dec, 5)}</td><td>${fx(p.flux_ujy, 0)} µJy</td><td>${P(p.class || "")}</td>` +
            `<td><small>${[known(p)].concat((p.flags || []).map(P)).filter(Boolean).join("; ")}</small></td></tr>`).join("") +
          `</table></div>`;
      }
    }
    if (ss.note) h += `<p class="faintnote">${P(ss.note)}</p>`;
    return h;
  }

  // ---- start: once the first frame is on screen (its src gives the data folder) ------------------
  let started = false;
  function start() {
    parseFrame();
    if (started || BASE == null) return;
    started = true;
    fetch(BASE + "faint/faint.json").then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !j.grid) return;
      fj = j;
      ui();
      parseFrame();
      fetch(BASE + "faint/shiftstack.json").then(r => r.ok ? r.json() : null).catch(() => null).then(ss => card(ss));
      render();
    }).catch(() => {});
  }
  const onFrame = () => { start(); if (fj) { parseFrame(); render(); } };
  new MutationObserver(onFrame).observe(frameImg, { attributes: true, attributeFilter: ["src"] });
  document.addEventListener("fazari:frame", onFrame);
  // local engine: faint/ is written by a post-step after the result is on screen (js/post_watch.js)
  document.addEventListener("fazari:post", (ev) => { if (!fj && (ev.detail || {}).step === "faint") { started = false; start(); } });
  document.addEventListener("fazari:lang", () => { if (!fj) return; render(); if ($("faintcard")) card(cardSS); });
  start();
})();
