// Field of view (FOV) of a full result: the choices, the URL parameter and a rough cost estimate.
// Used by the explorer (explore/fov_ui.js) and sky.html (js/app.js).
//
//   ?fov=0.3   field width in degrees; absent = the engine's default (local 0.4, browser 0.15)
//
// Local Python engine: cutout_deg of POST /api/jobs (0.2-0.6, local/serve.py CUTOUT_CHOICES); each
// size has its own job id (-s0.3), cutout store and products, so sizes never overwrite each other.
// The 5 challenge targets always use their saved images (no download; local/serve.py job_identity).
// In-browser engine: the north-up grid of sky.html (sky.js fovDeg); phones stop at 0.3 (memory).
// The quick preview keeps its small 0.1 deg field in both engines.
//
// The estimate follows timing runs on the team's computer (14 November 2026, home connection):
//   local, 0.4 deg (default): 314 MB for 94 images, full result in 162 s (download 136 s at ~2.3 MB/s,
//     blink.py 26 s; independent test run, 14 November 22:30, sparse VARIANCE/ZODI reader; before it 541 MB,
//     ~4 min); bytes grow with the field width (only the rows of the field are read).
//   browser, 0.15 deg (default), desktop: ~100 MB (default sky.html run, sparse ZODI reader; two headless runs on the
//     evening of 14 November: 94 MB in 172 s and 112 MB in 73 s), about 2 min; before the sparse reader ~200 MB;
//   phone (one wavelength): ~25 MB, 20-40 s.
import { t, num } from "./i18n.js";

export const FOV_CHOICES = { local: [0.2, 0.3, 0.4, 0.5, 0.6], browser: [0.15, 0.2, 0.3, 0.4, 0.5, 0.6] };
export const FOV_DEFAULT = { local: 0.4, browser: 0.15 };
export const FOV_PHONE_MAX = 0.3;
export const PREVIEW_FOV = 0.1;

const LOCAL = { mb04: 314, min04: 2.7 };
const BROWSER = { mb015: 100, min015: 2, phoneMb015: 25, phoneSec015: [20, 40] };

/** ?fov= of a URL search string as a number, or null when absent/invalid. */
export function fovFromUrl(search = location.search) {
  const v = Number(new URLSearchParams(search).get("fov"));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The choice the engine will use: the nearest allowed value (phones at most 0.3 in the browser). */
export function fovFor(kind, fov, { phone = false } = {}) {
  const ch = FOV_CHOICES[kind === "local" ? "local" : "browser"].filter((x) => !(phone && kind !== "local" && x > FOV_PHONE_MAX));
  if (fov == null) return Math.min(FOV_DEFAULT[kind === "local" ? "local" : "browser"], ch[ch.length - 1]);
  return ch.reduce((a, b) => (Math.abs(b - fov) < Math.abs(a - fov) ? b : a));
}

/** Cost of a full result: {mb, min (central minutes), sec: [lo, hi] (phones)}; time grows with the bytes
 *  (width) plus a smaller part with the area (processing). */
export function fovEstimate(kind, fov, { phone = false, saved = false } = {}) {
  if (kind === "local") {
    if (saved) return { mb: 0, min: 2, saved: true };            // Barnard, 358 saved cutouts: about 2 min (113 s measured, blink.py 68 s)
    const k = fov / 0.4;
    return { mb: LOCAL.mb04 * k, min: LOCAL.min04 * (0.85 * k + 0.15 * k * k) };
  }
  const k = fov / 0.15;
  if (phone) return { mb: BROWSER.phoneMb015 * k, sec: BROWSER.phoneSec015.map((v) => v * (0.7 * k + 0.3 * k * k)) };
  return { mb: BROWSER.mb015 * k, min: BROWSER.min015 * (0.7 * k + 0.3 * k * k) };
}

const roundMb = (mb) => (mb < 100 ? Math.max(5, Math.round(mb / 5) * 5) : Math.round(mb / 10) * 10);
/** "about 4 min" / "20–40 s" in the page language. */
function timeText(e) {
  if (e.sec) {
    const lo = Math.round(e.sec[0] / 5) * 5, hi = Math.round(e.sec[1] / 5) * 5;
    return hi >= 90 ? t("u3.fov.min", { n: Math.round(e.sec[1] / 60) }) : t("u3.fov.secRange", { lo, hi });
  }
  return t("u3.fov.min", { n: Math.max(1, Math.round(e.min)) });
}

/** One line for the chosen field, from measured runs, e.g. "About 540 MB, about 4 min. A quick preview comes first." */
export function fovEstimateText(kind, fov, opts = {}) {
  const e = fovEstimate(kind, fov, opts);
  if (e.saved) return t("u3.fov.saved", { t: timeText(e) });
  const mb = roundMb(e.mb);
  const size = mb >= 1000 ? t("pg.fov.gb", { v: num(mb / 1000, 1) }) : t("pg.fov.mb", { v: mb });
  return t(kind === "local" ? "u3.fov.local" : opts.phone ? "u3.fov.phone" : "u3.fov.browser", { size, t: timeText(e) });
}
/** The time alone, short ("about 4 min"), for the big button. */
export function fovTimeText(kind, fov, opts = {}) { return timeText(fovEstimate(kind, fov, opts)); }

/** Option label: "0.4°" plus " (default)" for the engine default. */
export function fovLabel(kind, v) {
  return `${num(v, v < 0.2 ? 2 : 1)}°` + (v === FOV_DEFAULT[kind === "local" ? "local" : "browser"] ? t("pg.fov.def") : "");
}

/** Fill a <select> with the engine's choices and select `value`. */
export function fillFovSelect(sel, kind, value, { phone = false } = {}) {
  const ch = FOV_CHOICES[kind === "local" ? "local" : "browser"].filter((x) => !(phone && kind !== "local" && x > FOV_PHONE_MAX));
  sel.textContent = "";
  for (const v of ch) sel.add(new Option(fovLabel(kind, v), String(v)));
  sel.value = String(value);
}

/** Set or remove ?fov= in the address bar (other parameters stay). */
export function setFovInUrl(fov) {
  const u = new URL(location.href);
  if (fov == null) u.searchParams.delete("fov"); else u.searchParams.set("fov", String(fov));
  history.replaceState(history.state, "", u);
}
