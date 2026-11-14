// Shared bits of the challenge-item tools (ch_sky.js on sky.html, ch_viewer.js on ornek.html):
// text (English in the code, Turkish in site/i18n/tr.json under "ch.*"), dates, the small CSS, drawing.
import { t, lang, loc, onLang } from "./i18n.js";

export { onLang, lang };
export const T = (key, en, p) => (lang() === "tr" ? t(key, p, en) : p ? en.replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : en);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const L = (s) => loc(s);
export const isDetailed = () => document.documentElement.getAttribute("data-ui-mode") === "detailed"
  || !document.documentElement.classList.contains("ui") || document.documentElement.classList.contains("ui-classic");

const MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_TR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
/** MJD -> Date (UTC). */
export const mjdDate = (mjd) => new Date((mjd - 40587) * 864e5);
/** "19 Mar 2026" / "19 Mart 2026" */
export function dayText(mjdOrIso) {
  const d = typeof mjdOrIso === "number" ? mjdDate(mjdOrIso) : new Date(String(mjdOrIso).slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(d.getTime())) return String(mjdOrIso || "");
  const m = (lang() === "tr" ? MON_TR : MON_EN)[d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
}
/** "19 Mar 2026 03:12" (UTC) */
export function timeText(mjd) {
  const d = mjdDate(mjd);
  return `${dayText(mjd)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/** Two dates, same day / same month collapse. */
export function rangeText(m0, m1) {
  if (Math.abs(m1 - m0) < 1 / 1440) return timeText(m0) + " UTC";
  if (dayText(m0) === dayText(m1)) return `${timeText(m0)}–${timeText(m1).split(" ").pop()} UTC`;
  return `${timeText(m0)} – ${timeText(m1)} UTC`;
}
export const pct = (v) => { if (v == null || !Number.isFinite(v)) return "–"; const s = L((100 * v).toFixed(v > 0 && v < 0.001 ? 2 : v < 0.1 ? 1 : 0)); return lang() === "tr" ? "%" + s : s + " %"; };
export const um = (v, d = 2) => L((+v).toFixed(d));

// plain words for the flag names (Simple mode), the full SPHEREx names in Detailed mode
const PLAIN = {
  OVERFLOW: ["saturated", "doymuş"], SUR_ERROR: ["saturated", "doymuş"], NONLINEAR: ["saturated", "doymuş"],
  TRANSIENT: ["cosmic ray", "kozmik ışın"], OUTLIER: ["outlier", "aykırı değer"], HOT: ["hot pixel", "sıcak piksel"],
  COLD: ["cold pixel", "soğuk piksel"], NONFUNC: ["dead pixel", "ölü piksel"], MISSING_DATA: ["no data", "veri yok"],
  PERSIST: ["afterglow of an earlier bright star", "önceki parlak yıldızın izi"], STREAK: ["satellite streak", "uydu izi"],
  SNOWBALL: ["snowball (charge burst)", "kar topu (yük patlaması)"], GHOST: ["ghost", "hayalet yansıma"],
  GHOST_FPA: ["ghost", "hayalet yansıma"], GHOST_EXT: ["ghost", "hayalet yansıma"], HALO: ["halo", "hale"],
  BLOOM: ["bloom (charge spill)", "taşma (yük sızması)"], CROSSTALK: ["crosstalk", "karışma"], DICHROIC: ["dichroic edge", "dikroik kenar"],
  PHANMISS: ["missing phase", "eksik faz"], SOURCE: ["star (not a defect)", "yıldız (kusur değil)"],
};
export const plainFlag = (n) => (PLAIN[n] ? PLAIN[n][lang() === "tr" ? 1 : 0] : n.toLowerCase().replace(/_/g, " "));

let cssDone = false;
export function css() {
  if (cssDone) return;
  cssDone = true;
  const s = document.createElement("style");
  s.textContent = `
  .ch-box { font-size:.86rem; color:var(--mut,#9aa3b2); margin:6px 0 4px; line-height:1.45; }
  .ch-box b { color:var(--fg,#e8eaf0); font-weight:600; }
  .ch-box .ch-line { margin:2px 0; }
  .ch-box details { margin-top:4px; }
  .ch-box summary { cursor:pointer; color:var(--fg,#e8eaf0); }
  .ch-box .ch-tw { overflow-x:auto; max-height:260px; overflow-y:auto; margin-top:4px; }
  .ch-box table { border-collapse:collapse; width:100%; font-size:.78rem; font-variant-numeric:tabular-nums; }
  .ch-box th, .ch-box td { text-align:left; padding:2px 8px 2px 0; white-space:nowrap; border:0; }
  .ch-only-d { display:none; }
  html[data-ui-mode="detailed"] .ch-only-d, html.ui-classic .ch-only-d, html:not(.ui) .ch-only-d { display:block; }
  html[data-ui-mode="detailed"] .ch-only-s, html.ui-classic .ch-only-s, html:not(.ui) .ch-only-s { display:none; }
  .ch-btn { font:inherit; font-size:.86rem; background:#222838; color:var(--fg,#e8eaf0); border:1px solid #333b50; border-radius:6px; padding:4px 10px; cursor:pointer; }
  .ch-btn:disabled { opacity:.5; cursor:default; }
  .ch-new { margin:8px 0 0; font-size:.88rem; }
  .ch-new .ch-idx { display:block; color:var(--mut,#9aa3b2); font-size:.84rem; margin:0 0 4px; }
  .ch-new .ch-msg { display:block; margin-top:4px; color:var(--mut,#9aa3b2); }
  .ch-new .ch-msg b { color:var(--fg,#e8eaf0); }
  .ch-seg { display:inline-flex; border:1px solid #333b50; border-radius:6px; overflow:hidden; margin:0 0 6px; vertical-align:middle; }
  .ch-seg button { font:inherit; font-size:.84rem; border:0; border-radius:0; padding:4px 10px; background:#1b2030; color:var(--mut,#9aa3b2); cursor:pointer; }
  .ch-seg button.on { background:#2a3146; color:var(--fg,#e8eaf0); }
  .ch-seg button:disabled { opacity:.45; cursor:default; }
  .ch-deep { width:100%; max-width:560px; height:auto; aspect-ratio:1; display:block; background:#000; border-radius:6px; image-rendering:pixelated; }
  .ch-cap { font-size:.82rem; color:var(--mut,#9aa3b2); margin:4px 0 0; }
  .ch-ring { position:absolute; pointer-events:none; border:2px solid #5ad1ff; border-radius:50%; box-shadow:0 0 0 1px #0008; display:none; }
  .ch-hint { font-size:.84rem; color:var(--mut,#9aa3b2); margin:4px 0 0; }
  .ch-spec .spx-links { display:none; }`;
  document.head.appendChild(s);
}

/** Draw a 0..1 image (n x n, row 0 = north) on a canvas, centre-cropped by zoom. */
export function drawGray(canvas, norm, n, zoom = 1) {
  const id = new ImageData(n, n);
  for (let k = 0; k < n * n; k++) {
    const v = Math.round(Math.min(1, Math.max(0, norm[k])) * 255);
    id.data[4 * k] = id.data[4 * k + 1] = id.data[4 * k + 2] = v; id.data[4 * k + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = off.height = n;
  off.getContext("2d").putImageData(id, 0, 0);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const src = n / zoom, s0 = (n - src) / 2;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, s0, s0, src, src, 0, 0, canvas.width, canvas.height);
}
