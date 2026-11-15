// The save row under the picture of the result layout (js/ts_flow.js, "C+"), also driven by the explorer's
// "Download / Share" menu (explore.html, through window.__tsSave of the page in its result panel):
//   PNG    the frame on screen, with its date, a scale bar and the north / east arrows;
//   GIF    every season of the wavelength on screen, with the marks of the page (ring, track, arrow, speed label);
//   video  the same blink recorded from a canvas (MediaRecorder: WebM, or MP4 where only that is offered);
//   PDF    a one-page report (js/pdf_min.js): position, date, verdict, speed, catalogue, seasons, charts, link, credits;
//   the position (sexagesimal and decimal degrees) and a link that opens the same view (a phone's share sheet if any).
// Everything is made in the browser from the frames already in memory:
//   sky.html   the blink canvas of js/app.js, one season at a time (window.__fzSkyShow), with its rings and arrow;
//   ornek.html the processed frames of the viewer (js/viewer.js api.frames(), drawn as js/fz_view.js does) and the
//              viewer's own marks (api.overlayNode), cut to the part of the picture on screen; else the frame images
//              of the result folder.
// Nothing is offered before the measurement is done ("Not finished yet"). GIF encoder: js/gif_enc.js (written for
// this site). Texts: i18n "cp.*" (English fallback here).
import * as FR from "./fz_frames.js";
import { encodeGif } from "./gif_enc.js";

const $ = (id) => document.getElementById(id);
const T = (k, en, p) => {
  const i = globalThis.__fzI18n;
  try { return i ? i.t(k, p, en) : p ? en.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? String(p[x]) : m)) : en; } catch (_) { return en; }
};
const loc = (s) => { const i = globalThis.__fzI18n; return i ? i.loc(s) : String(s); };
const lang = () => { const i = globalThis.__fzI18n; return i ? i.lang() : "en"; };
const GIF_MAX = 480;                                  // GIF side in pixels (file size stays small)
const VID_MAX = 720, PNG_MAX = 1400, THUMB_MAX = 360;
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);

function download(blob, name) {
  const u = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = u; a.download = name; a.rel = "noopener"; a.hidden = true;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
const slug = (s) => String(s || "point").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase() || "point";

/** A label on the picture (season, days, wavelength). at: "left" / "right" (top corners) or "bottom" (bottom middle,
 *  between the scale bar and the compass: sky.html writes its verdict line in the top-left corner). */
function stamp(ctx, text, W, at = "left") {
  if (!text) return;
  const f = Math.max(11, Math.round(W / (at === "bottom" ? 40 : 34)));
  ctx.save();
  ctx.font = `700 ${f}px system-ui, sans-serif`; ctx.textBaseline = "top";
  const p = Math.round(f * 0.45), w = Math.min(ctx.measureText(text).width, W - 4 * p);
  const x = at === "right" ? W - w - 3 * p : at === "bottom" ? (W - w) / 2 - p : p, y = at === "bottom" ? ctx.canvas.height - f - 3 * p - 6 : p;
  ctx.fillStyle = "rgba(5,7,13,.72)"; ctx.fillRect(x, y, w + 2 * p, f + 2 * p);
  ctx.fillStyle = "#ffc94d"; ctx.fillText(text, x + p, y + p, w);
  ctx.restore();
}
function canvasOf(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
const toBlob = (c, type, q) => new Promise((res, rej) => { try { c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), type, q); } catch (e) { rej(e); } });
const loadImg = (u) => new Promise((res, no) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => no(new Error("image " + u)); i.src = u; });

/** "29 Aug – 1 Oct 2025": the days the exposures of a visit were taken (UTC). */
function days(d0, d1) {
  const a = Date.parse(String(d0 || "").slice(0, 10) + "T00:00:00Z"), b = Date.parse(String(d1 || "").slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(a)) return "";
  const f = (v, o) => { try { return new Intl.DateTimeFormat(lang() === "tr" ? "tr-TR" : "en-GB", { timeZone: "UTC", ...o }).format(v); } catch (_) { return new Date(v).toISOString().slice(0, 10); } };
  const dmy = { day: "numeric", month: "short", year: "numeric" };
  if (!Number.isFinite(b) || b === a) return f(a, dmy);
  const A = new Date(a), B = new Date(b);
  if (A.getUTCFullYear() !== B.getUTCFullYear()) return `${f(a, dmy)} – ${f(b, dmy)}`;
  if (A.getUTCMonth() !== B.getUTCMonth()) return `${f(a, { day: "numeric", month: "short" })} – ${f(b, dmy)}`;
  return `${A.getUTCDate()}–${f(b, dmy)}`;
}
const umTxt = (um) => (Number.isFinite(um) ? loc(um.toFixed(1)) + " µm" : "");
const join = (a) => a.filter(Boolean).join(" · ");

/** Scale bar (bottom left) and north / east arrows (bottom right) on an exported picture; arc = arcsec per pixel. */
function scaleCompass(x, W, H, arc, ne) {
  const fs = Math.max(11, Math.round(W / 40)), yb = H - 18;
  x.save();
  x.font = `700 ${fs}px system-ui, sans-serif`; x.lineCap = "round";
  const both = (draw) => { for (const [c, w] of [["rgba(5,7,13,.85)", 4.5], ["#ffffff", 2]]) { x.strokeStyle = c; x.lineWidth = w; draw(); } };
  const label = (s, tx, ty) => { x.lineWidth = 3.5; x.strokeStyle = "rgba(5,7,13,.85)"; x.strokeText(s, tx, ty); x.fillStyle = "#ffffff"; x.fillText(s, tx, ty); };
  if (arc > 0) {
    const pick = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600].find((v) => v / arc >= W / 8) || 600, bar = pick / arc;
    if (bar < W * 0.6) {
      both(() => { x.beginPath(); x.moveTo(16, yb); x.lineTo(16 + bar, yb); x.stroke(); });
      x.textAlign = "center"; label(pick >= 60 ? pick / 60 + "′" : pick + "″", 16 + bar / 2, yb - 8);
    }
  }
  if (ne) {
    const cx = W - 30, cy = yb, L = Math.max(28, Math.round(W / 18));
    both(() => { x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx, cy - L); x.moveTo(cx, cy); x.lineTo(cx - L, cy); x.stroke(); });
    x.textAlign = "center"; label(T("sk.cN", "N"), cx, cy - L - 6); x.textAlign = "right"; label(T("sk.cE", "E"), cx - L - 5, cy + fs * 0.35);
  }
  x.restore();
}

// ---- is the measurement done? ------------------------------------------------------------------------------------
const onSky = () => !!($("blink") && $("form"));
/** "none" (nothing on screen), "busy" (still measuring) or "done". whole: the whole run (the report); else the wavelength on screen. */
function state(whole) {
  if (onSky()) {
    const s = sky();
    if (!s || !s.run) return "none";
    const cur = s.current;
    if (!cur || !cur.frames || !cur.frames.length) return s.run.finished ? "none" : "busy";
    if (cur.preview) return "busy";
    if (s.run.finished) return "done";
    if (whole) return "busy";
    return Object.keys(s.run.results || {}).some((k) => s.run.results[k] === cur) ? "done" : "busy";
  }
  const v = viewer();
  if (!v || !v.meta) return "none";
  if (v.meta.preview || document.documentElement.classList.contains("pg-live")) return "busy";
  return "done";
}
const NOT_DONE = () => ({ ok: false, msg: T("cp.notDone", "Not finished yet: the measurement is still running") });
const NOTHING = () => ({ ok: false, msg: T("cp.notYet", "Not ready yet") });
function notReady(whole) { const s = state(whole); return s === "done" ? null : s === "busy" ? NOT_DONE() : NOTHING(); }

/** Where the point is and what the card says about it (js/ts_flow.js), else the page's own numbers. */
function point() {
  try { const p = window.__tsFlow && typeof window.__tsFlow.point === "function" ? window.__tsFlow.point() : null; if (p) return p; } catch (_) { /* below */ }
  if (onSky()) { const s = sky(), i = s && s.run && s.run.info; return i && ok(i.ra0) ? { ra: +i.ra0, dec: +i.dec0, free: !(s.run.target) } : null; }
  const v = viewer(), m = v && v.meta;
  return m && ok(m.ra) && ok(m.dec) ? { ra: +m.ra, dec: +m.dec, free: true } : null;
}
/** fazari_[target_]ra_dec[_2.0um]: the file names of this point. */
function fileBase(um) {
  const p = point(), parts = ["fazari"];
  let nm = "";
  if (onSky()) { const s = sky(), tg = s && s.run && s.run.target; nm = new URLSearchParams(location.search).get("target") || (tg && tg.kind ? tg.name : ""); }
  else if (p && !p.free) nm = viewName(viewer());
  if (nm) parts.push(slug(nm));
  if (p) parts.push(p.ra.toFixed(4), p.dec.toFixed(4));
  if (Number.isFinite(um)) parts.push(um.toFixed(1) + "um");
  return parts.join("_");
}

// ---- sky.html ---------------------------------------------------------------------------------------------------
const sky = () => { try { return window.__fzSky ? window.__fzSky() : null; } catch (_) { return null; } };
const skyLabel = (s, fr) => join([fr.season, days(fr.dateFirst, fr.dateLast), umTxt(+s.current.um)]);
/** The blink canvas as it is (rings, arrow, scale bar, compass are drawn on it), with the date. */
function skyPng() {
  const s = sky(), cv = $("blink");
  if (!s || !s.current || !cv) return null;
  const fr = s.current.frames[s.frameIdx % s.current.frames.length];
  const c = canvasOf(cv.width, cv.height), x = c.getContext("2d");
  x.drawImage(cv, 0, 0); stamp(x, skyLabel(s, fr), c.width, "bottom");
  return { c, name: `${fileBase(+s.current.um)}_${fr.season}.png` };
}
/** Every season of the wavelength on screen, as the page draws it, at most `max` pixels across. */
function skyPics(max) {
  const s = sky(), cv = $("blink");
  if (!s || !s.current || !cv || typeof window.__fzSkyShow !== "function") return null;
  const n = s.current.frames.length, keep = s.frameIdx % n;
  const k = Math.min(1, max / Math.max(cv.width, cv.height)), W = Math.round(cv.width * k), Hh = Math.round(cv.height * k);
  const pics = [], labels = [];
  try {
    for (let i = 0; i < n; i++) {                     // synchronous: the page never shows the in-between frames
      window.__fzSkyShow(i);
      const c = canvasOf(W, Hh), x = c.getContext("2d", { willReadFrequently: true });
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
      x.drawImage(cv, 0, 0, W, Hh);
      const fr = s.current.frames[i];
      stamp(x, skyLabel(s, fr), W, "bottom");
      pics.push(c); labels.push(join([fr.season, days(fr.dateFirst, fr.dateLast)]));
    }
  } finally { window.__fzSkyShow(keep); }
  return { pics, labels, um: +s.current.um };
}

// ---- ornek.html -------------------------------------------------------------------------------------------------
const viewer = () => window.__fzViewer || null;
function viewName(v) {
  const m = (v && v.meta) || {}, b = String((v && v.base) || "").match(/data\/([\w-]+)\/?$/);
  return b ? b[1] : slug(m.target || "result");
}
function viewUm(v) { try { return +v.current().bin_um; } catch (_) { return NaN; } }
function viewBin(v) { const um = viewUm(v); return ((v.meta && v.meta.wavelength_bins) || []).find((b) => Math.abs(+b.wavelength_um - um) < 0.05) || null; }
/** The part of the picture on screen, in picture (PNG) pixels, and the picture's grid. */
function viewGeom(v) {
  const g = (v.meta && v.meta.grid) || {}, P = g.png_px || [720, 720], W = P[0], Hh = P[1], strip = g.label_strip_px || 0;
  let x0 = 0, y0 = strip, x1 = W, y1 = Hh;
  const st = $("stage");
  let z = null; try { z = typeof v.zoomState === "function" ? v.zoomState() : null; } catch (_) { z = null; }
  if (z && z.k > 0 && ok(z.tx) && ok(z.ty) && st && st.clientWidth > 0) {
    x0 = Math.max(0, -z.tx / z.k); y0 = Math.max(strip, -z.ty / z.k);
    x1 = Math.min(W, (st.clientWidth - z.tx) / z.k); y1 = Math.min(Hh, (st.clientHeight - z.ty) / z.k);
    if (!(x1 - x0 > 4 && y1 - y0 > 4)) { x0 = 0; y0 = strip; x1 = W; y1 = Hh; }
  }
  return { W, H: Hh, strip, up: g.upscale || 4, arc: g.pixel_arcsec && g.upscale ? g.pixel_arcsec / g.upscale : 0,
    ne: g.north_up_east_left !== false, x0, y0, w: x1 - x0, h: y1 - y0 };
}
/** The viewer's marks for visit i (undefined: the one on screen) as a picture over the cut gm, ow x oh pixels. */
async function marksOf(v, i, gm, ow, oh) {
  if (typeof v.overlayNode !== "function") return null;
  let url = "";
  try {
    const node = v.overlayNode(i);
    if (!node || !node.childElementCount) return null;
    node.setAttribute("viewBox", `${gm.x0} ${gm.y0} ${gm.w} ${gm.h}`);
    node.setAttribute("width", ow); node.setAttribute("height", oh);
    node.setAttribute("preserveAspectRatio", "none");
    ["id", "class", "style", "aria-hidden"].forEach((a) => node.removeAttribute(a));
    const css = document.createElementNS("http://www.w3.org/2000/svg", "style");
    css.textContent = "text{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}";
    node.insertBefore(css, node.firstChild);
    url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(node)], { type: "image/svg+xml" }));
    return await loadImg(url);
  } catch (e) { console.warn("cp_save: marks", e); return null; }
  finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
/** One finished picture of the viewer: base (drawn by drawBase(ctx, ow, oh)), its marks, scale, compass, label. */
async function viewPicture(v, gm, max, i, drawBase, label) {
  const s = max / Math.max(gm.w, gm.h), ow = Math.max(2, Math.round(gm.w * s)), oh = Math.max(2, Math.round(gm.h * s));
  const c = canvasOf(ow, oh), x = c.getContext("2d", { willReadFrequently: true });
  x.fillStyle = "#000"; x.fillRect(0, 0, ow, oh);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
  drawBase(x, ow, oh);
  const marks = await marksOf(v, i, gm, ow, oh);
  if (marks) x.drawImage(marks, 0, 0, ow, oh);
  scaleCompass(x, ow, oh, gm.arc ? gm.arc / s : 0, gm.ne);
  stamp(x, label, ow, "right");
  return c;
}
const viewLabel = (f, um) => join([f && f.epoch, f && days(f.date_first, f.date_last), umTxt(um)]);
async function viewPng() {
  const v = viewer();
  if (!v) return null;
  const gm = viewGeom(v), fv = $("fzView"), img = $("frame");
  const useFv = fv && !fv.hidden && fv.width > 1 && parseFloat(fv.style.width) > 0;
  if (!useFv && !(img && img.naturalWidth)) return null;
  let f = null; try { f = v.current().frame; } catch (_) { /* none */ }
  const um = viewUm(v);
  const c = await viewPicture(v, gm, Math.min(PNG_MAX, Math.max(720, Math.round(Math.max(gm.w, gm.h) * 3))), undefined, (x, ow, oh) => {
    if (useFv) { const r = fv.width / parseFloat(fv.style.width); x.drawImage(fv, gm.x0 * r, (gm.y0 - gm.strip) * r, gm.w * r, gm.h * r, 0, 0, ow, oh); }
    else { const r = img.naturalWidth / gm.W; x.drawImage(img, gm.x0 * r, gm.y0 * r, gm.w * r, gm.h * r, 0, 0, ow, oh); }
  }, viewLabel(f, um));
  return { c, name: `${fileBase(um)}_${(f && f.epoch) || "frame"}.png` };
}
/** Every season of the wavelength on screen: the processed frames (else the frame images), with the viewer's marks. */
async function viewPics(max) {
  const v = viewer();
  if (!v || !v.meta) return null;
  const um = viewUm(v), bin = viewBin(v), gm = viewGeom(v);
  const frs = (bin && bin.frames) || [];
  const set = typeof v.frames === "function" ? v.frames() : null;
  const pics = [], labels = [];
  const lab = (i) => join([frs[i] && frs[i].epoch, frs[i] && days(frs[i].date_first, frs[i].date_last)]);
  if (set && set.n > 1) {                              // the processed frames (one scale, matched sky, lined up)
    const s = max / Math.max(gm.w, gm.h), kk = Math.max(1, Math.min(8, Math.round(s * gm.up))), r = kk / gm.up;
    const gc = canvasOf(set.nx * kk, set.ny * kk), gx = gc.getContext("2d", { willReadFrequently: true }), id = gx.createImageData(gc.width, gc.height);
    for (let i = 0; i < set.n; i++) {
      FR.greyRgba(FR.frameFloat(set, i, kk, false), id.data, set.disp.gamma);
      gx.putImageData(id, 0, 0);
      pics.push(await viewPicture(v, gm, max, i, (x, ow, oh) => x.drawImage(gc, gm.x0 * r, (gm.y0 - gm.strip) * r, gm.w * r, gm.h * r, 0, 0, ow, oh), viewLabel(frs[i], um)));
      labels.push(lab(i));
      await new Promise((res) => setTimeout(res, 0));
    }
  } else if (frs.length) {                             // the frame images of the result folder
    const ims = await Promise.all(frs.map((f) => loadImg(v.base + f.file)));
    for (let i = 0; i < ims.length; i++) {
      const im = ims[i], r = im.naturalWidth / gm.W;
      pics.push(await viewPicture(v, gm, max, i, (x, ow, oh) => x.drawImage(im, gm.x0 * r, gm.y0 * r, gm.w * r, gm.h * r, 0, 0, ow, oh), viewLabel(frs[i], um)));
      labels.push(lab(i));
    }
  }
  return pics.length ? { pics, labels, um } : null;
}
const seasonPics = (max) => (onSky() ? Promise.resolve(skyPics(max)) : viewPics(max));
const frameTime = () => { const sp = $("speed"); return Math.max(150, Math.min(3000, sp ? Number(sp.value) || 800 : 800)); };

// ---- video ------------------------------------------------------------------------------------------------------
const VID_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4;codecs=avc1", "video/mp4"];
/** The recording format this browser offers ("" = none: the video button stays hidden). */
export function videoType() {
  if (typeof MediaRecorder !== "function" || typeof HTMLCanvasElement === "undefined" || !HTMLCanvasElement.prototype.captureStream) return "";
  try { return VID_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || ""; } catch (_) { return ""; }
}
/** WebM from MediaRecorder has no duration in its header (players then show no length): write it in (ms). */
async function webmDuration(blob, ms) {
  try {
    const b = new Uint8Array(await blob.arrayBuffer());
    const vint = (p) => {
      let n = 1, m = 0x80;
      while (n <= 8 && !(b[p] & m)) { n++; m >>= 1; }
      let v = b[p] & (m - 1), all = v === m - 1;
      for (let k = 1; k < n; k++) { v = v * 256 + b[p + k]; all = all && b[p + k] === 255; }
      return { n, v, unknown: all };
    };
    const find = (id, from, to) => { for (let p = from; p < to - id.length; p++) if (id.every((x, k) => b[p + k] === x)) return p; return -1; };
    const seg = find([0x18, 0x53, 0x80, 0x67], 0, Math.min(b.length, 64));
    if (seg < 0 || !vint(seg + 4).unknown) return blob;               // a segment of known size would need more work
    const info = find([0x15, 0x49, 0xa9, 0x66], seg, Math.min(b.length, 400));
    if (info < 0) return blob;
    const sz = vint(info + 4), body = info + 4 + sz.n, end = body + sz.v;
    let scale = 1e6;
    for (let p = body; p < end;) {                                    // the children: a duration already there wins
      const idLen = b[p] & 0x80 ? 1 : b[p] & 0x40 ? 2 : b[p] & 0x20 ? 3 : 4, s = vint(p + idLen), d = p + idLen + s.n;
      if (idLen === 2 && b[p] === 0x44 && b[p + 1] === 0x89) return blob;
      if (idLen === 3 && b[p] === 0x2a && b[p + 1] === 0xd7 && b[p + 2] === 0xb1) { scale = 0; for (let k = 0; k < s.v; k++) scale = scale * 256 + b[d + k]; }
      p = d + s.v;
    }
    const dur = new Uint8Array(11); dur.set([0x44, 0x89, 0x88]); new DataView(dur.buffer).setFloat64(3, ms * 1e6 / (scale || 1e6));
    const head = new Uint8Array(12); head.set([0x15, 0x49, 0xa9, 0x66, 0x01]);
    let r = sz.v + dur.length; for (let k = 11; k >= 5; k--) { head[k] = r & 255; r = Math.floor(r / 256); }
    return new Blob([b.subarray(0, info), head, b.subarray(body, end), dur, b.subarray(end)], { type: blob.type });
  } catch (e) { console.warn("cp_save: webm duration", e); return blob; }
}
async function recordVideo(pics, per) {
  const type = videoType();
  if (!type) throw new Error("no video recorder");
  const W = pics[0].width & ~1, Hh = pics[0].height & ~1;          // even sides (video coders want them)
  const c = canvasOf(W, Hh), x = c.getContext("2d");
  const n = pics.length, loops = Math.max(2, Math.ceil(6000 / (per * n))), total = per * n * loops;
  const draw = (i) => { x.fillStyle = "#000"; x.fillRect(0, 0, W, Hh); x.drawImage(pics[i], 0, 0, W, Hh); };
  draw(0);
  const stream = c.captureStream(30), rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2500000 }), chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });
  rec.start(250);
  const t0 = performance.now();
  await new Promise((done) => {
    const tick = () => {
      const t = performance.now() - t0;
      if (t >= total) { done(); return; }
      draw(Math.floor(t / per) % n);                  // drawn again every tick: the stream keeps getting frames
      setTimeout(tick, 33);
    };
    tick();
  });
  rec.stop(); await stopped;
  stream.getTracks().forEach((tr) => tr.stop());
  const mp4 = /mp4/.test(type);
  let blob = new Blob(chunks, { type: mp4 ? "video/mp4" : "video/webm" });
  if (!mp4) blob = await webmDuration(blob, performance.now() - t0);
  return { blob, ext: mp4 ? "mp4" : "webm" };
}

// ---- the report (PDF) -------------------------------------------------------------------------------------------
const textOf = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const plainText = (html) => { const d = document.createElement("div"); d.innerHTML = String(html || ""); return textOf(d); };   // the page's own markup text (pg.ai)
const shown = (el) => !!(el && !el.hidden);
/** The verdict as the page says it: headline and its longer lines (js/verdict_strip.js), else the viewer's sentence. */
function verdictText() {
  const vs = $("vdStrip");
  const t = vs && !vs.hidden ? vs.querySelector(".vd-t") : null;
  if (t && textOf(t)) {
    const tag = textOf(t.querySelector(".vd-tag")), head = [...t.childNodes].filter((n) => !(n.classList && n.classList.contains("vd-tag"))).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();
    return { head: head + (tag ? ` (${tag})` : ""), lines: [".vd-what", ".vd-cat", ".vd-lim", ".vd-mean"].map((s) => textOf(vs.querySelector(s))).filter(Boolean) };
  }
  const v = $("verdict"), ex = $("explainSentence");
  return { head: textOf(ex) || textOf(v), lines: textOf(ex) && textOf(v) ? [textOf(v)] : [] };
}
/** The speed tiles: "Measured by us: 10.4″ per year ± 0.1″", "Gaia DR3 predicts: …". */
function tileLines() {
  const box = onSky() ? $("tsTiles") : $("tiles");
  if (!shown(box)) return [];
  return [...box.querySelectorAll(".tile")].filter((t) => !t.classList.contains("empty") && textOf(t.querySelector("b")))
    .map((t) => textOf(t.querySelector(".k")) + ": " + join([textOf(t.querySelector("b")), textOf(t.querySelector("small"))])).slice(0, 4);
}
/** The largest chart inside el (an inline SVG) as a canvas, its colours copied from the page (dark card behind). */
const SVG_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "opacity", "font-size",
  "font-weight", "font-family", "font-style", "text-anchor", "dominant-baseline", "visibility"];
async function chartPicture(el) {
  if (!el || el.hidden) return null;
  const svgs = [...el.querySelectorAll("svg")].map((s) => ({ s, vb: s.viewBox && s.viewBox.baseVal })).filter((o) => o.vb && o.vb.width >= 200 && o.vb.height >= 80);
  if (!svgs.length) return null;
  const { s: svg, vb } = svgs.sort((a, b) => b.vb.width * b.vb.height - a.vb.width * a.vb.height)[0];
  const clone = svg.cloneNode(true), src = [svg, ...svg.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
  src.forEach((e, k) => {
    const cs = getComputedStyle(e);
    let st = "";
    for (const p of SVG_PROPS) { const val = cs.getPropertyValue(p); if (val) st += `${p}:${val};`; }
    if (k && cs.display === "none") st += "display:none;";
    dst[k].setAttribute("style", st);
  });
  ["id", "class", "role", "aria-label", "tabindex"].forEach((a) => clone.removeAttribute(a));
  clone.querySelectorAll("title").forEach((t) => t.remove());
  const w = vb.width, h = vb.height, k = 2;
  clone.setAttribute("width", w); clone.setAttribute("height", h);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const im = await loadImg(url), c = canvasOf(Math.round(w * k), Math.round(h * k)), x = c.getContext("2d");
    x.fillStyle = "#151925"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(im, 0, 0, c.width, c.height);
    return c;
  } catch (e) { console.warn("cp_save: chart", e); return null; }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function jpegOf(c, q = 0.86) {
  let src = c;
  if (c.width > 1600) { src = canvasOf(1600, Math.round(c.height * 1600 / c.width)); const x = src.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(c, 0, 0, src.width, src.height); }
  return { bytes: new Uint8Array(await (await toBlob(src, "image/jpeg", q)).arrayBuffer()), w: src.width, h: src.height };
}
function sexa(ra, dec) {
  const h = ((ra % 360) + 360) % 360 / 15;
  let hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = +(((h - hh) * 60 - mm) * 60).toFixed(2);
  if (ss >= 60) { ss = 0; mm += 1; } if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
  const a = Math.abs(dec);
  let dd = Math.floor(a), dm = Math.floor((a - dd) * 60), ds = +(((a - dd) * 60 - dm) * 60).toFixed(1);
  if (ds >= 60) { ds = 0; dm += 1; } if (dm >= 60) { dm = 0; dd += 1; }
  const p2 = (n) => String(n).padStart(2, "0"), s2 = (v, d) => (v < 10 ? "0" : "") + v.toFixed(d);
  return { ra: `${p2(hh)}h ${p2(mm)}m ${s2(ss, 2)}s`, dec: `${dec < 0 ? "−" : "+"}${p2(dd)}° ${p2(dm)}′ ${s2(ds, 1)}″` };
}
function nowText() {
  const d = new Date();
  try {
    return new Intl.DateTimeFormat(lang() === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(d);
  } catch (_) { return d.toISOString().slice(0, 16).replace("T", " ") + " UTC"; }
}
async function makePdf() {
  const P = await import("./pdf_min.js");
  const pt = point(), vd = verdictText(), tiles = tileLines(), lg = lang(), I = globalThis.__fzI18n;
  const got = await seasonPics(THUMB_MAX);
  const spec = await chartPicture($("tsE")), bright = await chartPicture($("tsF"));
  const um = got ? got.um : NaN, link = linkUrl();
  const name = (pt && pt.name) || (pt && pt.free ? T("ts.a.kickPoint", "The point you picked") : T("cp.pdf.result", "Result"));
  const d = P.pdfPage({ title: T("cp.pdf.title", "Fazari result: {name}", { name }), subject: T("cp.pdf.band", "SPHEREx sky explorer · result report"), lang: lg });
  const M = 40, CW = d.w - 2 * M, INK = "#111827", MUT = "#5b6475";
  // the band on top
  d.rect(0, 0, d.w, 30, "#0b1020");
  d.text(M, 19.5, "FAZARI", { size: 11, bold: true, color: "#ffc94d" });
  d.text(M + 54, 19.5, T("cp.pdf.band", "SPHEREx sky explorer · result report"), { size: 9, color: "#dfe5f2" });
  d.text(d.w - M, 19.5, "NASA Space Apps 2026", { size: 8.5, color: "#9aa3b2", align: "right" });
  let y = 70;
  if (pt && pt.kick && pt.kick !== name) d.text(M, 52, pt.kick, { size: 8.5, bold: true, color: "#a16207" });
  y = d.para(M, y, name, CW, { size: 17, bold: true, color: INK, lead: 1.15 }) + 2;
  // facts: label in the left column, value on the right
  const row = (label, value) => {
    if (!value) return;
    d.text(M, y, label, { size: 8.5, bold: true, color: MUT });
    y = d.para(M + 104, y, value, CW - 104, { size: 9.5, color: INK, lead: 1.3 }) + 3;
  };
  if (pt) {
    const sx = sexa(pt.ra, pt.dec);
    row(T("cp.pdf.pos", "Position (ICRS)"), `RA ${sx.ra}, Dec ${sx.dec}\nRA ${loc(pt.ra.toFixed(5))}°, Dec ${pt.dec < 0 ? "−" : "+"}${loc(Math.abs(pt.dec).toFixed(5))}°`);
  }
  const eps = (pt && pt.eps) || [], mon = (e) => (I ? I.month(e) : e);
  row(T("cp.pdf.imgs", "Images used"), pt && pt.n ? T("cp.pdf.imgN", "{n} SPHEREx images in {v} visits", { n: pt.n, v: eps.length }) +
    (eps.length ? ` (${mon(eps[0])}${eps.length > 1 ? " – " + mon(eps[eps.length - 1]) : ""})` : "") + (Number.isFinite(um) ? " · " + T("cp.pdf.um", "pictures at {um}", { um: umTxt(um) }) : "") : "");
  row(T("cp.pdf.cat", "Gaia comparison"), pt ? join([pt.cat, pt.off]) : "");
  row(T("cp.pdf.when", "Report made"), nowText());
  y += 4;
  // the verdict box: headline, its longer lines, the speed tiles
  const vLines = [...vd.lines, ...tiles], IN = CW - 22;
  const hHead = P.wrap(vd.head || "–", 11.5, IN, true).length * 11.5 * 1.25;
  const hBody = vLines.reduce((a, l, i) => a + P.wrap(l, 9.3, IN, i >= vd.lines.length).length * 9.3 * 1.3 + 1, 0);
  const boxH = 30 + hHead + (vLines.length ? 2 + hBody : 0);
  d.rect(M, y, CW, boxH, "#fff6dc"); d.rect(M, y, 3.5, boxH, "#c98500");
  d.text(M + 11, y + 13, T("cp.pdf.verdict", "Verdict").toUpperCase(), { size: 7.5, bold: true, color: "#a16207" });
  let yy = d.para(M + 11, y + 27, vd.head || T("cp.pdf.noVerdict", "No verdict on screen"), IN, { size: 11.5, bold: true, color: INK, lead: 1.25 }) + 2;
  vLines.forEach((l, i) => { const t = i >= vd.lines.length; yy = d.para(M + 11, yy, l, IN, { size: 9.3, color: t ? "#7c2d12" : "#374151", bold: t, lead: 1.3 }) + 1; });
  y += boxH + 14;
  // the footer (kept at the bottom): candidate line, link, credits, use of AI
  const foot = [
    { s: T("cp.pdf.cand", "A moving object found here is a candidate, not a discovery: it needs checking in other images and by experts before anyone can call it new."), size: 8.6, bold: true, color: "#7c2d12" },
    { s: T("cp.pdf.link", "Permanent link (opens this point with the same settings):"), size: 8.2, bold: true, color: MUT },
    { s: link, size: 8.2, color: "#1d4ed8", link: true },
    { s: T("cp.pdf.credits", "Data: SPHEREx images from the NASA/IPAC Infrared Science Archive (IRSA); star positions and motions from ESA Gaia DR3 (ESA/Gaia/DPAC). Fazari, NASA Space Apps Challenge 2026; not endorsed by NASA."), size: 7.6, color: MUT },
    { s: plainText(T("pg.ai", "<b>Use of AI</b>: the code and text of this site were written with help from Anthropic's Claude (Claude Code). Team Fazari designed the project and checked and tested the results. The sky images and measurements come from the data sources credited here, not from an AI model.")), size: 7.2, color: MUT },
  ];
  const footH = foot.reduce((a, f) => a + P.wrap(f.s, f.size, CW, f.bold).length * f.size * 1.3 + 3, 0);
  const footY = d.h - 26 - footH;
  // the seasons: one row (two when there are more than six)
  const pics = got ? got.pics : [];
  if (pics.length) {
    d.text(M, y, T("cp.pdf.seasons", "The seasons at {um}: the same patch of sky, months apart", { um: umTxt(um) }), { size: 9.5, bold: true, color: INK });
    y += 7;
    const per = Math.min(6, pics.length), rows = Math.ceil(pics.length / per), gap = 6, tw = (CW - gap * (per - 1)) / per;
    const th = Math.max(40, Math.min(tw, (footY - y - 170) / rows - 14));
    let rowH = 0;
    for (let i = 0; i < pics.length; i++) {
      const r = Math.floor(i / per), x0 = M + (i % per) * (tw + gap);
      const j = await jpegOf(pics[i], 0.85), sw = Math.min(tw, th * pics[i].width / pics[i].height), sh = sw * pics[i].height / pics[i].width;
      const y0 = y + r * (th + 16);
      d.image(j.bytes, j.w, j.h, x0 + (tw - sw) / 2, y0, sw, sh);
      d.text(x0 + tw / 2, y0 + sh + 9.5, String(got.labels[i] || "").split(" · ")[0], { size: 7.8, bold: true, color: INK, align: "center" });
      rowH = Math.max(rowH, sh);
    }
    y += (rows - 1) * (th + 16) + rowH + 22;
  }
  // the charts: side by side, or one under the other when that makes them larger; as large as the room left allows
  const charts = [[spec, T("cp.tab.spec", "Spectrum")], [bright, T("cp.tab.bright", "Brightness")]].filter((c) => c[0]);
  if (charts.length) {
    const gap = 12, room = footY - y - 14, fit = (c, w, h) => { const k = Math.min(w / c.width, h / c.height); return [c.width * k, c.height * k]; };
    const two = charts.length > 1, side = (CW - gap) / 2;
    const besideH = two ? Math.min(room - 8, Math.max(...charts.map(([c]) => side * c.height / c.width))) : room - 8;
    const stackH = two ? (room - 2 * 16 - 8) / 2 : 0;
    const stack = two && fit(charts[0][0], CW, stackH)[0] * fit(charts[0][0], CW, stackH)[1] > fit(charts[0][0], side, besideH)[0] * fit(charts[0][0], side, besideH)[1] * 1.15;
    let cy = y;
    for (let i = 0; i < charts.length; i++) {
      const [c, title] = charts[i], x0 = stack || !two ? M : M + i * (side + gap);
      const [w, h] = stack ? fit(c, CW, stackH) : fit(c, two ? side : CW, besideH);
      if (h < 40) continue;
      d.text(x0, cy, title, { size: 9.5, bold: true, color: INK });
      const j = await jpegOf(c, 0.9);
      d.image(j.bytes, j.w, j.h, x0, cy + 6, w, h);
      if (stack) cy += h + 24;
    }
  }
  // footer
  let fy = footY;
  d.line(M, fy - 6, d.w - M, fy - 6, "#d1d5db", 0.6);
  for (const f of foot) {
    const top = fy;
    fy = d.para(M, fy + f.size, f.s, CW, { size: f.size, bold: f.bold, color: f.color, lead: 1.3 }) - f.size + 3;
    if (f.link) d.link(M, top, Math.min(CW, P.textWidth(f.s, f.size)), fy - top, f.s);
  }
  return { blob: new Blob([d.bytes()], { type: "application/pdf" }), name: `${fileBase(um)}_report.pdf` };
}

// ---- position and link ----------------------------------------------------------------------------------------
/** The position in both forms, ready to paste: sexagesimal and decimal degrees (ICRS). */
export function positionText(ra, dec) {
  const s = sexa(ra, dec);
  return `RA ${s.ra}, Dec ${s.dec.replace("−", "-")} (ICRS)\nRA ${ra.toFixed(5)}°, Dec ${dec < 0 ? "-" : "+"}${Math.abs(dec).toFixed(5)}°`;
}
/** A link that opens the same point with the same settings (sky.html: also the wavelength and the exposures per season). */
function linkUrl() {
  const u = new URL(location.href);
  if (onSky()) {
    const s = sky(), cap = $("cap");
    if (s && s.current && ok(s.current.um)) u.searchParams.set("bin", String(+s.current.um));
    if (cap && cap.value) u.searchParams.set("cap", cap.value);
  }
  return u.toString();
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) {
    try {
      const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select(); const r = document.execCommand("copy"); t.remove(); return r;
    } catch (e) { return false; }
  }
}
const phoneShare = () => !!(navigator.share && window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

// ---- the buttons ------------------------------------------------------------------------------------------------
function flash(btn, msg) {
  if (!btn || !msg) return;
  if (btn.__cpT) clearTimeout(btn.__cpT); else btn.__cpWas = btn.textContent;
  btn.textContent = msg;
  btn.__cpT = setTimeout(() => { btn.textContent = btn.__cpWas; btn.__cpT = null; }, 2600);
}
let busy = false;
const BUSY = { gif: ["cp.gif.busy", "Making the GIF…"], video: ["cp.vid.busy", "Recording the video…"], pdf: ["cp.pdf.busy", "Making the report…"] };
/** One action of the save row: png | gif | video | pdf | pos | link. Resolves to { ok, msg } (msg: what to tell). */
export async function act(what, btn) {
  if (busy && BUSY[what]) return { ok: false, msg: "" };
  const label = btn ? (btn.__cpT ? btn.__cpWas : btn.textContent) : "";
  if (BUSY[what]) {
    busy = true;
    if (btn) { if (btn.__cpT) { clearTimeout(btn.__cpT); btn.__cpT = null; } btn.disabled = true; btn.textContent = T(BUSY[what][0], BUSY[what][1]); }
    await new Promise((res) => setTimeout(res, 30));
  }
  let r;
  try { r = await run(what); } catch (e) { console.warn("cp_save:", what, e); r = { ok: false, msg: T("cp.fail", "Could not make the file in this browser") }; }
  if (BUSY[what]) { busy = false; if (btn) { btn.disabled = false; btn.textContent = label; } }
  if (btn && r && r.msg) flash(btn, r.msg);
  return r;
}
async function run(what) {
  if (what === "pos") {
    const p = point();
    if (!p) return NOTHING();
    return (await copyText(positionText(p.ra, p.dec))) ? { ok: true, msg: T("cp.pos.ok", "Position copied") } : { ok: false, msg: T("cp.link.fail", "Could not copy; use the address bar") };
  }
  if (what === "link") {
    const u = linkUrl();
    if (phoneShare()) {
      try { await navigator.share({ title: document.title, url: u }); return { ok: true, msg: "" }; }
      catch (e) { if (e && e.name === "AbortError") return { ok: true, msg: "" }; }
    }
    return (await copyText(u)) ? { ok: true, msg: T("cp.link.ok", "Link copied") } : { ok: false, msg: T("cp.link.fail", "Could not copy; use the address bar") };
  }
  const nr = notReady(what === "pdf");
  if (nr) return nr;
  if (what === "png") {
    const got = onSky() ? skyPng() : await viewPng();
    if (!got) return NOTHING();
    download(await toBlob(got.c, "image/png"), got.name);
    return { ok: true, msg: "" };
  }
  if (what === "gif" || what === "video") {
    const got = await seasonPics(what === "gif" ? GIF_MAX : VID_MAX);
    if (!got || got.pics.length < 2) return { ok: false, msg: what === "gif" ? T("cp.gif.fail", "No GIF: fewer than two seasons in memory") : T("cp.vid.fail", "No video: fewer than two seasons in memory") };
    if (what === "gif") {
      const frames = got.pics.map((c) => ({ rgba: c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }));
      download(new Blob([encodeGif(frames, { delayMs: frameTime() })], { type: "image/gif" }), `${fileBase(got.um)}.gif`);
      return { ok: true, msg: "" };
    }
    const v = await recordVideo(got.pics, frameTime());
    download(v.blob, `${fileBase(got.um)}.${v.ext}`);
    return { ok: true, msg: "" };
  }
  if (what === "pdf") {
    const r = await makePdf();
    download(r.blob, r.name);
    return { ok: true, msg: "" };
  }
  return { ok: false, msg: "" };
}
// the first buttons of the row, by their old names
export const savePng = (btn) => act("png", btn);
export const saveGif = (btn) => act("gif", btn);
export const copyLink = (btn) => act("link", btn);
