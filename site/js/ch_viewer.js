// Challenge-item tools on the result viewer (ornek.html: precomputed results and the local engine's results):
//   frame information under the image (dates and times, detector, wavelength range, images stacked, flagged
//   pixels and which flags; reuses the FLAGS layer of js/flags_view.js), "Is there new data?" next to Share,
//   and a Deep image (sum of the selected seasons) next to the difference image.
// Plug-in: ornek.html calls mountChallenge(v) with the viewer api (js/viewer.js). Reads only files of the
// result folder: meta.json, images.csv, flags/flags.json, faint/faint.json + faint/frames_<bin>um.bin.
import { T, esc, L, css, onLang, rangeText, dayText, pct, um as fmtUm, plainFlag, drawGray } from "./ch_common.js";
import { mountNewData } from "./ch_newdata.js";

const $ = (id) => document.getElementById(id);
// FLAGS bits of SPHEREx L2 images (FLAGS header of a DR1 file)
const BITS = { TRANSIENT: 1, OVERFLOW: 2, SUR_ERROR: 4, NONFUNC: 64, DICHROIC: 128, MISSING_DATA: 512, HOT: 1024, COLD: 2048,
  FULLSAMPLE: 4096, PHANMISS: 16384, NONLINEAR: 32768, PERSIST: 131072, OUTLIER: 524288, CROSSTALK: 1048576, SOURCE: 2097152,
  GHOST: 4194304, GHOST_FPA: 8388608, GHOST_EXT: 16777216, STREAK: 33554432, BLOOM: 67108864, SNOWBALL: 134217728, HALO: 268435456 };
const bitNames = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Object.entries(BITS).filter(([, b]) => n & b).map(([k]) => k) : []; };
const TARGET_IDS = ["barnard", "eps_indi_b", "wise0855", "rw_aur", "r_dra"];

export function mountChallenge(v) {
  if (!v || !v.meta) return null;
  css();
  const st = { v, base: v.base, meta: v.meta, epoch: null, bin: null, rows: null, rowsP: null, flags: null, flagsP: null,
               faint: null, faintP: null, bufs: new Map(), mode: "diff" };
  window.__chViewer = st;
  const binOf = (um) => (st.meta.wavelength_bins || []).find((b) => Math.abs(+b.wavelength_um - +um) < 0.05) || null;

  // ---- data files (each optional) ------------------------------------------------------------------------
  const loadRows = () => (st.rowsP ||= fetch(st.base + "images.csv").then((r) => (r.ok ? r.text() : null)).then((t) => {
    if (!t) return null;
    const lines = t.trim().split(/\r?\n/), head = lines[0].split(",");
    const out = {};
    for (const l of lines.slice(1)) { const c = l.split(","), o = {}; head.forEach((h, i) => { o[h] = c[i]; }); if (o.file) out[o.file] = o; }
    return (st.rows = out);
  }).catch(() => null));
  const loadFlags = (force = false) => { if (force) st.flagsP = null; return (st.flagsP ||= fetch(st.base + "flags/flags.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => (st.flags = j && j.bins ? j : null)).catch(() => null)); };
  const loadFaint = (force = false) => { if (force) st.faintP = null; return (st.faintP ||= fetch(st.base + "faint/faint.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => (st.faint = j && j.frames ? j : null)).catch(() => null)); };

  // ---- frame information block ---------------------------------------------------------------------------
  const box = document.createElement("div");
  box.id = "chFrame"; box.className = "ch-box";
  const info = document.querySelector(".main > .info") || $("detail")?.parentElement;
  if (info) info.after(box);
  let tok = 0;
  async function paintInfo() {
    const cur = v.current(), f = cur.frame;
    if (!f) { box.innerHTML = ""; return; }
    const my = ++tok;
    const [rows, flags] = await Promise.all([loadRows(), loadFlags()]);
    if (my !== tok) return;
    const files = (f.files || []).map((n) => ({ name: n, r: rows && rows[n] }));
    const mjds = files.map((x) => x.r && +x.r.mjd).filter(Number.isFinite);
    const when = mjds.length ? rangeText(Math.min(...mjds), Math.max(...mjds))
      : (f.date_first && f.date_last && f.date_first !== f.date_last ? `${dayText(f.date_first)} – ${dayText(f.date_last)}` : dayText(f.date || f.date_first));
    const lam = files.filter((x) => x.r && +x.r.wavelength_um > 0).map((x) => [+x.r.wavelength_um, +x.r.bandwidth_um || 0]);
    const lo = lam.length ? Math.min(...lam.map(([l, b]) => l - b / 2)) : +f.wavelength_um, hi = lam.length ? Math.max(...lam.map(([l, b]) => l + b / 2)) : +f.wavelength_um;
    const n = f.n_images || files.length;
    let h = `<p class="ch-line">${esc(T("ch.fi.line", "This frame: {n} images stacked · {when} · detector {det} · {lo}–{hi} µm",
      { n, when, det: (f.detectors || []).join("+"), lo: fmtUm(lo), hi: fmtUm(hi) }))}.</p>`;
    const fb = flags && flags.bins ? flags.bins[(+cur.bin_um).toFixed(1)] : null;
    const fe = fb ? (fb.frames || []).find((x) => x.epoch === f.epoch) : null;
    let fl, anyF = 0;
    if (!fe || !fe.available || !fe.share) fl = T("ch.fi.flagsNa", "Flagged pixels: not available for this frame.");
    else {
      const s = fe.share, any = Math.min(1, (s.saturated || 0) + (s.masked || 0) + (s.other || 0));
      const parts = [];
      if (s.saturated > 0.0005) parts.push(T("ch.fi.gSat", "saturated {p}", { p: pct(s.saturated) }));
      if (s.masked > 0.0005) parts.push(T("ch.fi.gMask", "masked or no data {p}", { p: pct(s.masked) }));
      if (s.other > 0.0005) parts.push(T("ch.fi.gOther", "ghost, halo or other {p}", { p: pct(s.other) }));
      anyF = any;
      fl = any < 0.0005 ? T("ch.fi.flags0", "Flagged pixels in the box: none (below 0.05 %).")
        : T("ch.fi.flagsMost", "Flagged pixels in the box: {p} ({g}), counted where most images of the frame are flagged.", { p: pct(any), g: parts.join(", ") });
    }
    h += `<p class="ch-line">${esc(fl)}${fe && fe.available && anyF >= 0.0005 && $("fl-on") ? ` <button type="button" class="ch-btn" id="chFlShow">${esc($("fl-on").checked ? T("ch.fi.hide", "Hide them on the image") : T("ch.fi.show", "Show them on the image"))}</button>` : ""}</p>`;
    // Detailed: every image of the frame, its time, wavelength and the flags at the target pixel; the flag groups
    h += `<details class="ch-only-d"><summary>${esc(T("ch.fi.more", "All images and flags of this frame"))}</summary><div class="ch-tw"><table><tr><th>obs_id</th>`
      + `<th>${esc(T("ch.fi.th.time", "Start (UTC)"))}</th><th>${esc(T("ch.fi.th.det", "Detector"))}</th><th>${esc(T("ch.fi.th.lam", "λ at the point (µm)"))}</th>`
      + `<th>${esc(T("ch.fi.th.atTarget", "Flags at the target pixel"))}</th></tr>`
      + files.map(({ name, r }) => {
        const m = /level2_(.+?)D(\d)_spx/.exec(name) || [];
        const nm = r ? bitNames(r.flags_at_target) : [];
        return `<tr title="${esc(name)}"><td>${esc(r ? r.obs_id : m[1] || name)}</td><td>${esc(r && +r.mjd ? rangeText(+r.mjd, +r.mjd).replace(" UTC", "") : (r && r.date) || "")}</td>`
          + `<td>${esc(r ? r.detector : m[2] ? "D" + m[2] : "")}</td><td>${r && +r.wavelength_um ? esc(fmtUm(+r.wavelength_um, 3)) + (+r.bandwidth_um ? " ± " + esc(fmtUm(+r.bandwidth_um / 2, 3)) : "") : "–"}</td>`
          + `<td>${nm.length ? nm.map((k) => `<span title="${esc(plainFlag(k))}">${esc(k)}</span>`).join(" ") : "–"}</td></tr>`;
      }).join("") + "</table></div>";
    if (flags && flags.groups) {
      const gname = { saturated: T("ch.fi.grSat", "saturated"), masked: T("ch.fi.grMask", "masked or no data"), other: T("ch.fi.grOther", "other flags (kept)") };
      h += `<p class="ch-line">${esc(T("ch.fi.groups", "Flag groups in the box (pipeline/flags.py):"))} ` + flags.groups.map((g) => `<b>${esc(gname[g.key] || g.key)}</b> ${esc(fe && fe.share ? pct(fe.share[g.key]) : "–")}: ${esc(g.flags.join(", "))}`).join("; ") + "</p>";
    }
    if (!rows) h += `<p class="ch-line">${esc(T("ch.fi.noCsv", "images.csv not found: times and wavelengths of single images are not shown."))}</p>`;
    h += "</details>";
    box.innerHTML = h;
    const b = $("chFlShow");
    if (b) b.onclick = () => { const c = $("fl-on"); if (!c || c.disabled) return; c.checked = !c.checked; c.dispatchEvent(new Event("change")); paintInfo(); };
    window.__chFrame = { epoch: f.epoch, bin: cur.bin_um, n, when, lam: [lo, hi], share: fe ? fe.share : null };
  }

  // ---- deep image (sum of the selected seasons) next to the difference ---------------------------------------
  const diffCard = document.querySelector(".lower > .card.diff") || ($("diff") && $("diff").closest(".card"));
  let seg = null, cv = null, cap = null;
  if (diffCard) {
    seg = document.createElement("div");
    seg.className = "ch-seg"; seg.id = "chDeepSeg"; seg.setAttribute("role", "group");
    seg.innerHTML = `<button type="button" data-m="diff" class="on"></button><button type="button" data-m="deep"></button>`;
    const key = $("diffKey");
    if (key) key.before(seg); else diffCard.appendChild(seg);
    cv = document.createElement("canvas"); cv.id = "chDeep"; cv.className = "ch-deep"; cv.style.display = "none";
    cap = document.createElement("p"); cap.id = "chDeepCap"; cap.className = "ch-cap"; cap.hidden = true;
    ($("diffView") || seg).after(cv); cv.after(cap);
    seg.querySelectorAll("button").forEach((b) => { b.onclick = () => { st.mode = b.dataset.m; showMode(); }; });
  }
  function paintSeg() {
    if (!seg) return;
    const [a, b] = seg.querySelectorAll("button");
    a.textContent = T("ch.dp.diff", "Difference (subtract)");
    b.textContent = T("ch.dp.deep", "Deep image (add)");
    b.title = st.faint === null && st.faintP ? T("ch.dp.noFaint", "Needs the float frames of the faint-object step (faint/), not in this result.")
      : T("ch.dp.tip2", "Add the selected seasons together: fainter objects show, motion is hidden.");
    a.classList.toggle("on", st.mode === "diff"); b.classList.toggle("on", st.mode === "deep");
    a.setAttribute("aria-pressed", String(st.mode === "diff")); b.setAttribute("aria-pressed", String(st.mode === "deep"));
  }
  const F16 = (() => { const t = new Float32Array(65536); for (let h = 0; h < 65536; h++) { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); } return t; })();
  const loadBuf = (file) => {
    if (!st.bufs.has(file)) st.bufs.set(file, fetch(st.base + "faint/" + file).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }));
    return st.bufs.get(file);
  };
  const selected = () => [...document.querySelectorAll("#seasons .chip.on")].map((c) => +c.dataset.i);
  let dtok = 0;
  async function showMode() {
    paintSeg();
    if (!cv) return;
    const deep = st.mode === "deep";
    for (const id of ["diffView", "diffKey", "diffCap", "diffSat"]) if ($(id)) $(id).style.display = deep ? "none" : "";
    cv.style.display = deep ? "block" : "none"; cap.hidden = !deep;
    if (!deep) return;
    const my = ++dtok;
    cap.textContent = T("ch.dp.busy", "Adding the images…");
    const fj = await loadFaint();
    if (my !== dtok) return;
    paintSeg();
    const cur = v.current(), bin = binOf(cur.bin_um);
    const ff = fj && fj.frames ? fj.frames[(+cur.bin_um).toFixed(1)] : null;
    if (!fj || !ff || !bin) { cv.style.display = "none"; cap.textContent = T("ch.dp.noFaint", "Needs the float frames of the faint-object step (faint/), not in this result."); return; }
    const idx = selected();
    const eps = (idx.length ? idx : bin.frames.map((_, i) => i)).map((i) => bin.frames[i]).filter(Boolean);
    const use = eps.map((f) => ({ f, q: ff.frames.find((x) => x.epoch === f.epoch) })).filter((x) => x.q);
    if (use.length < 2) { cv.style.display = "none"; cap.textContent = T("ch.dp.two", "Select at least two seasons to add."); return; }
    let buf;
    try { buf = await loadBuf(ff.file); } catch (e) { cap.textContent = T("ch.dp.fail", "Could not build the deep image ({msg}).", { msg: e.message }); return; }
    if (my !== dtok) return;
    const [nx, ny] = fj.grid.size_px, N = nx * ny, u16 = new Uint16Array(buf);
    const acc = new Float64Array(N), wsum = new Float64Array(N), sat = new Uint8Array(N);
    for (const { q } of use) {
      const w = 1 / Math.max(q.pixel_sigma_mjysr || 1, 1e-6) ** 2, o = q.offset / 2;
      for (let k = 0; k < N; k++) {
        const x = F16[u16[o + k]];
        if (x === Infinity) { sat[k] = 1; continue; }
        if (Number.isFinite(x)) { acc[k] += w * x; wsum[k] += w; }
      }
    }
    const img = new Float32Array(N);
    const fin = [];
    for (let k = 0; k < N; k++) { img[k] = wsum[k] > 0 ? acc[k] / wsum[k] : NaN; if (Number.isFinite(img[k]) && !sat[k]) fin.push(img[k]); }
    const srt = Float64Array.from(fin).sort(), q = (p) => srt[Math.min(srt.length - 1, Math.max(0, Math.round(p / 100 * (srt.length - 1))))];
    const med = q(50), mad = 1.4826 * (() => { const d = fin.map((x) => Math.abs(x - med)).sort((a, b) => a - b); return d[d.length >> 1]; })();
    const lo = med - 1.5 * mad, hi = q(99.97), soft = 3 * mad || 1e-3, den = Math.asinh((hi - lo) / soft);
    const norm = new Float32Array(N);
    for (let k = 0; k < N; k++) norm[k] = sat[k] ? 1 : Number.isFinite(img[k]) ? Math.min(1, Math.max(0, Math.asinh((img[k] - lo) / soft) / den)) : 0;
    cv.width = nx; cv.height = ny;
    drawGray(cv, norm, nx, 1);
    const sig1 = Math.min(...use.map((x) => x.q.pixel_sigma_mjysr || Infinity)), sigD = 1 / Math.sqrt(use.reduce((a, x) => a + 1 / (x.q.pixel_sigma_mjysr || Infinity) ** 2, 0));
    const nExp = use.reduce((a, x) => a + (x.f.n_images || x.q.n_images || 0), 0);
    const gain = Number.isFinite(sig1 / sigD) ? sig1 / sigD : null;
    cap.textContent = T("ch.dp.cap2", "Deep image at {um} µm: {n} images from {s} seasons ({a} – {b}) added together, aligned on the same grid.",
      { um: L((+cur.bin_um).toFixed(1)), n: nExp, s: use.length, a: dayText(use[0].f.date_first || use[0].f.date), b: dayText(use[use.length - 1].f.date_last || use[use.length - 1].f.date) })
      + (gain && gain > 1.05 ? " " + T("ch.dp.gain2", "Noise {g}× lower than the best single season, so fainter objects show.", { g: L(gain.toFixed(1)) }) : "")
      + " " + T("ch.dp.hide", "A moving object is smeared or doubled here: this view hides motion; the difference shows it.")
      + (idx.length && idx.length < bin.frames.length ? " " + T("ch.dp.sel", "Seasons: the ones selected above.") : "");
    window.__chDeep = { um: cur.bin_um, nExp, seasons: use.map((x) => x.f.epoch), gain };
  }

  // ---- new data ------------------------------------------------------------------------------------------------
  const host = document.querySelector(".side > .actions") || document.querySelector(".actions");
  const tid = (/(?:^|\/)data\/([\w-]+)\/$/.exec(st.base.replace(/^\.?\//, "")) || [])[1];
  const nd = host ? mountNewData(host, () => {
    const m = st.meta;
    if (!Number.isFinite(+m.ra) || !Number.isFinite(+m.dec)) return null;
    const dates = (m.wavelength_bins || []).flatMap((b) => (b.frames || []).map((f) => f.date_last || f.date)).filter(Boolean).sort();
    if (!dates.length) return null;
    const addHref = TARGET_IDS.includes(tid) ? `sky.html?target=${tid}` : `sky.html?ra=${(+m.ra).toFixed(5)}&dec=${(+m.dec).toFixed(5)}`;
    return { ra: +m.ra, dec: +m.dec, lastDate: dates[dates.length - 1], addHref };
  }) : null;

  // ---- wiring --------------------------------------------------------------------------------------------------
  let last = "";
  const onFrame = () => {
    const c = v.current(), key = `${c.bin_um}|${c.frame && c.frame.epoch}`;
    if (key === last) return;
    const binChanged = last.split("|")[0] !== String(c.bin_um);
    last = key;
    paintInfo();
    if (binChanged && st.mode === "deep") showMode();
  };
  document.addEventListener("fazari:frame", onFrame);
  const seasons = $("seasons");
  if (seasons) new MutationObserver(() => { if (st.mode === "deep") showMode(); }).observe(seasons, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  document.addEventListener("change", (e) => { if (e.target && e.target.id === "fl-on") paintInfo(); });   // the FLAGS layer (flags_view.js)
  document.addEventListener("fazari:post", (ev) => {
    const step = (ev.detail || {}).step;
    if (step === "flags") loadFlags(true).then(paintInfo);
    if (step === "faint") loadFaint(true).then(() => { paintSeg(); if (st.mode === "deep") showMode(); });
  });
  onLang(() => { paintInfo(); paintSeg(); if (st.mode === "deep") showMode(); if (nd) nd.paint(); });
  paintSeg(); onFrame();
  loadFaint().then(paintSeg);
  return st;
}
