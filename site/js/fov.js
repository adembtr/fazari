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
// The estimate is rough, from timing runs on the team's computer (November 2026):
//   local, 0.2 deg: ~3.6 MB per exposure (only the rows of the field are read, so the bytes grow
//     with the field width), ~95 exposures per point, 1.0-1.4 MB/s from the archive, blink.py
//     ~0.5-1 min (grows with the area); 0.4 deg measured at ~7.2 MB per exposure.
//   browser, 0.15 deg: 155-203 MB for 72 exposures (2.2-2.8 MB each), full result in 2.5-3 min
//     when the network is free; the first wavelength after ~40 s.
import { t, num } from "./i18n.js";

export const FOV_CHOICES = { local: [0.2, 0.3, 0.4, 0.5, 0.6], browser: [0.15, 0.2, 0.3, 0.4, 0.5, 0.6] };
export const FOV_DEFAULT = { local: 0.4, browser: 0.15 };
export const FOV_PHONE_MAX = 0.3;
export const PREVIEW_FOV = 0.1;

const LOCAL = { mbPerImage02: 3.6, images: 95, rate: [0.8, 1.4], blinkMin02: 0.75 };
const BROWSER = { mbPerImage015: 2.5, images: 72, rate: [0.8, 1.4], cpuMin015: 0.3 };

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

/** Rough cost of a full result: {mb, min: [lo, hi], first: [lo, hi] (minutes to the first full blink)}. */
export function fovEstimate(kind, fov, { phone = false, saved = false } = {}) {
  if (kind === "local") {
    const area = (fov / 0.2) ** 2;
    const blink = LOCAL.blinkMin02 * area;
    if (saved) return { mb: 0, min: [3, 6], saved: true };       // Barnard, 358 saved cutouts: blink in ~4 min
    const mb = LOCAL.mbPerImage02 * (fov / 0.2) * LOCAL.images;
    const dl = [mb / LOCAL.rate[1] / 60, mb / LOCAL.rate[0] / 60];
    return { mb, min: [dl[0] + blink, dl[1] + blink * 1.5] };
  }
  const k = fov / 0.15;
  const n = phone ? BROWSER.images / 6 : BROWSER.images;            // phones load one wavelength
  const mb = BROWSER.mbPerImage015 * k * n;
  const cpu = BROWSER.cpuMin015 * k * k * (n / BROWSER.images);
  return { mb, min: [mb / BROWSER.rate[1] / 60 + cpu, mb / BROWSER.rate[0] / 60 + cpu * 2] };
}

const roundMin = (m) => (m < 1 ? 1 : m < 10 ? Math.round(m) : Math.round(m / 5) * 5);
const roundMb = (mb) => (mb < 100 ? Math.round(mb / 10) * 10 : Math.round(mb / 50) * 50);

/** One honest line for the chosen field, e.g. "Rough guess: about 700 MB, 10-15 min (your connection decides)". */
export function fovEstimateText(kind, fov, opts = {}) {
  const e = fovEstimate(kind, fov, opts);
  const lo = roundMin(e.min[0]), hi = Math.max(roundMin(e.min[1]), lo + 1);
  if (e.saved) return t("pg.fov.estSaved", { lo, hi });
  const mb = roundMb(e.mb);
  const size = mb >= 1000 ? t("pg.fov.gb", { v: num(mb / 1000, 1) }) : t("pg.fov.mb", { v: mb });
  return t(kind === "local" ? "pg.fov.estLocal" : opts.phone ? "pg.fov.estPhone" : "pg.fov.estBrowser", { size, lo, hi });
}

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
