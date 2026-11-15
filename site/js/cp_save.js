// The save row under the picture of the result layout (js/ts_flow.js, "C+"): this frame as PNG, a GIF that loops the
// seasons, the link of this view. Everything is made in the browser from the frames already in memory:
//   sky.html   the blink canvas of js/app.js, one season at a time (window.__fzSkyShow), with its rings and arrow;
//   ornek.html the processed frames of the viewer (js/viewer.js api.frames(), drawn as js/fz_view.js does),
//              else the frame images of the result folder.
// GIF encoder: js/gif_enc.js (written for this site). Texts: i18n "cp.*" (English fallback here).
import * as FR from "./fz_frames.js";
import { encodeGif } from "./gif_enc.js";

const $ = (id) => document.getElementById(id);
const T = (k, en, p) => { const i = globalThis.__fzI18n; try { return i ? i.t(k, p, en) : en; } catch (_) { return en; } };
const loc = (s) => { const i = globalThis.__fzI18n; return i ? i.loc(s) : String(s); };
const GIF_MAX = 480;                                  // GIF side in pixels (file size stays small)

function download(blob, name) {
  const u = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = u; a.download = name; a.rel = "noopener"; a.hidden = true;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
const slug = (s) => String(s || "point").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase() || "point";

/** A label in the top-left corner (season, wavelength), as on the page's picture. */
function stamp(ctx, text, W) {
  if (!text) return;
  const f = Math.max(11, Math.round(W / 34));
  ctx.save();
  ctx.font = `700 ${f}px system-ui, sans-serif`; ctx.textBaseline = "top";
  const w = ctx.measureText(text).width, p = Math.round(f * 0.45);
  ctx.fillStyle = "rgba(5,7,13,.72)"; ctx.fillRect(p, p, w + 2 * p, f + 2 * p);
  ctx.fillStyle = "#ffc94d"; ctx.fillText(text, 2 * p, 2 * p);
  ctx.restore();
}
function canvasOf(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

// ---- sky.html ---------------------------------------------------------------------------------------------------
const sky = () => { try { return window.__fzSky ? window.__fzSky() : null; } catch (_) { return null; } };
function skyName(s) {
  const r = s.run, tg = r && r.target;
  return tg && tg.name ? slug(tg.name) : r && r.info ? `ra${r.info.ra0.toFixed(4)}_dec${r.info.dec0.toFixed(4)}`.replace(/\./g, "p").replace(/-/g, "m") : "point";
}
const skyLabel = (s, fr) => `${fr.season} · ${loc((+s.current.um).toFixed(1))} µm`;
function skyPng() {
  const s = sky(), cv = $("blink");
  if (!s || !s.current || !cv) return false;
  const fr = s.current.frames[s.frameIdx % s.current.frames.length];
  const c = canvasOf(cv.width, cv.height), x = c.getContext("2d");
  x.drawImage(cv, 0, 0); stamp(x, skyLabel(s, fr), c.width);
  c.toBlob((b) => b && download(b, `fazari_${skyName(s)}_${(+s.current.um).toFixed(1)}um_${fr.season}.png`), "image/png");
  return true;
}
function skyFrames() {
  const s = sky(), cv = $("blink");
  if (!s || !s.current || !cv || typeof window.__fzSkyShow !== "function") return null;
  const n = s.current.frames.length, keep = s.frameIdx % n;
  const W = Math.min(GIF_MAX, cv.width), Hh = Math.round(W * cv.height / cv.width);
  const c = canvasOf(W, Hh), x = c.getContext("2d", { willReadFrequently: true });
  const out = [];
  try {
    for (let i = 0; i < n; i++) {                     // synchronous: the page never shows the in-between frames
      window.__fzSkyShow(i);
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
      x.drawImage(cv, 0, 0, W, Hh);
      stamp(x, skyLabel(s, s.current.frames[i]), W);
      out.push({ rgba: x.getImageData(0, 0, W, Hh).data, w: W, h: Hh });
    }
  } finally { window.__fzSkyShow(keep); }
  return { frames: out, name: `fazari_${skyName(s)}_${(+s.current.um).toFixed(1)}um.gif` };
}

// ---- ornek.html -------------------------------------------------------------------------------------------------
const viewer = () => window.__fzViewer || null;
function viewName(v) {
  const m = (v && v.meta) || {}, b = String((v && v.base) || "").match(/data\/([\w-]+)\/?$/);
  return b ? b[1] : slug(m.target || "result");
}
function viewUm(v) { try { return +v.current().bin_um; } catch (_) { return NaN; } }
function viewPng() {
  const v = viewer();
  if (!v) return false;
  const fv = $("fzView"), img = $("frame");
  const src = fv && !fv.hidden && fv.width > 1 ? fv : img && img.naturalWidth ? img : null;
  if (!src) return false;
  const w = src.width && src === fv ? src.width : src.naturalWidth, h = src === fv ? src.height : src.naturalHeight;
  const c = canvasOf(w, h), x = c.getContext("2d");
  x.drawImage(src, 0, 0, w, h);
  let ep = ""; try { ep = v.current().frame.epoch; } catch (_) { /* none */ }
  const um = viewUm(v);
  stamp(x, [ep, Number.isFinite(um) ? loc(um.toFixed(1)) + " µm" : ""].filter(Boolean).join(" · "), w);
  try { c.toBlob((b) => b && download(b, `fazari_${viewName(v)}_${Number.isFinite(um) ? um.toFixed(1) + "um_" : ""}${ep || "frame"}.png`), "image/png"); }
  catch (e) { return false; }                          // a picture from another origin cannot be read back
  return true;
}
const loadImg = (u) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("image " + u)); i.src = u; });
async function viewFrames() {
  const v = viewer();
  if (!v || !v.meta) return null;
  const um = viewUm(v), eps = typeof v.seasons === "function" ? v.seasons() : [];
  const lab = (i) => [eps[i], Number.isFinite(um) ? loc(um.toFixed(1)) + " µm" : ""].filter(Boolean).join(" · ");
  const out = [];
  const set = typeof v.frames === "function" ? v.frames() : null;
  if (set && set.n > 1) {                              // the processed frames (one scale, matched sky, lined up)
    const up = Math.max(1, Math.min(8, Math.round(GIF_MAX / Math.max(set.nx, set.ny))));
    const w = set.nx * up, h = set.ny * up, c = canvasOf(w, h), x = c.getContext("2d", { willReadFrequently: true });
    const id = x.createImageData(w, h);
    for (let i = 0; i < set.n; i++) {
      FR.greyRgba(FR.frameFloat(set, i, up, false), id.data, set.disp.gamma);
      x.putImageData(id, 0, 0); stamp(x, lab(i), w);
      out.push({ rgba: x.getImageData(0, 0, w, h).data, w, h });
      await new Promise((r) => setTimeout(r, 0));
    }
  } else {                                             // the frame images of the result folder
    const bin = (v.meta.wavelength_bins || []).find((b) => Math.abs(+b.wavelength_um - um) < 0.05);
    if (!bin || !bin.frames || bin.frames.length < 2) return null;
    const ims = await Promise.all(bin.frames.map((f) => loadImg(v.base + f.file)));
    const k = Math.min(1, GIF_MAX / Math.max(ims[0].naturalWidth, ims[0].naturalHeight));
    const w = Math.round(ims[0].naturalWidth * k), h = Math.round(ims[0].naturalHeight * k);
    const c = canvasOf(w, h), x = c.getContext("2d", { willReadFrequently: true });
    ims.forEach((im, i) => { x.drawImage(im, 0, 0, w, h); stamp(x, bin.frames[i].epoch, w); out.push({ rgba: x.getImageData(0, 0, w, h).data, w, h }); });
  }
  return { frames: out, name: `fazari_${viewName(v)}_${Number.isFinite(um) ? um.toFixed(1) + "um" : "seasons"}.gif` };
}

// ---- the buttons ------------------------------------------------------------------------------------------------
function flash(btn, key, en) {
  if (!btn) return;
  if (btn.__cpT) clearTimeout(btn.__cpT); else btn.__cpWas = btn.textContent;
  btn.textContent = T(key, en);
  btn.__cpT = setTimeout(() => { btn.textContent = btn.__cpWas; btn.__cpT = null; }, 2200);
}
export function savePng(btn) {
  const ok = $("blink") && $("form") ? skyPng() : viewPng();
  if (!ok) flash(btn, "cp.notYet", "Not ready yet");
}
let busy = false;
export async function saveGif(btn) {
  if (busy) return;
  busy = true;
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = T("cp.gif.busy", "Making the GIF…"); }
  await new Promise((r) => setTimeout(r, 30));
  let fail = false;
  try {
    const got = $("blink") && $("form") ? skyFrames() : await viewFrames();
    if (!got || got.frames.length < 2) fail = true;
    else {
      const sp = $("speed"), ms = sp ? Number(sp.value) || 800 : 800;
      download(new Blob([encodeGif(got.frames, { delayMs: ms })], { type: "image/gif" }), got.name);
    }
  } catch (e) { console.warn("cp_save: gif", e); fail = true; }
  busy = false;
  if (btn) { btn.disabled = false; btn.textContent = label; }
  if (fail) flash(btn, "cp.gif.fail", "No GIF: fewer than two seasons in memory");
}
export async function copyLink(btn) {
  const u = location.href;
  let ok = false;
  try { await navigator.clipboard.writeText(u); ok = true; } catch (_) {
    try { const t = document.createElement("textarea"); t.value = u; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select(); ok = document.execCommand("copy"); t.remove(); } catch (e) { ok = false; }
  }
  flash(btn, ok ? "cp.link.ok" : "cp.link.fail", ok ? "Link copied" : "Could not copy; use the address bar");
}
