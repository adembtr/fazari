// story.html: the "New here?" box, one plain-language card per target (with a small blink of real
// SPHEREx frames), "How SPHEREx works" (inline SVG) and where the name comes from.
// Numbers: data/verify/table.json (pipeline/verify_table.py) and each target's meta.json (frames, markers).

import { t, apply, onLang, lang, langButton } from "./fz_i18n.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LY_PER_PC = 3.26156;
const NEW_KEY = "fz-newhere-closed";

function num(v, d) { const s = Number(v).toFixed(d); return lang() === "tr" ? s.replace(".", ",") : s; }
function big(v) { return Math.round(v).toLocaleString(lang() === "tr" ? "tr-TR" : "en-US"); }
const fmtA = (v, d = 2) => `${num(v, d)}″`;
function month(ep) {
  const [y, m] = String(ep).split("-").map(Number);
  if (!y || !m) return ep;
  try { return new Intl.DateTimeFormat(lang() === "tr" ? "tr-TR" : "en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(Date.UTC(y, m - 1, 15)); }
  catch (e) { return ep; }
}

// Which frames each card blinks: wavelength bin and crop (PNG pixels, 0.75″ each).
const CARDS = [
  { id: "barnard", bin: 2.0, crop: 200 },
  { id: "eps_indi_b", bin: 2.0, crop: 110 },
  { id: "wise0855", bin: 4.6, crop: 120 },
  { id: "luhman16" },
  { id: "rw_aur", bin: 4.6, crop: 170 },
  { id: "r_dra", bin: 4.6, crop: 260 },
];

let TABLE = null;
const META = {};

// ------------------------------------------------------------------------------------ New here?
function newHere() {
  const box = $("newHere");
  let closed = false;
  try { closed = localStorage.getItem(NEW_KEY) === "1"; } catch (e) { /* storage blocked */ }
  box.hidden = closed;
  $("newHereClose").addEventListener("click", () => {
    box.hidden = true;
    try { localStorage.setItem(NEW_KEY, "1"); } catch (e) { /* this visit only */ }
    $("targetsTitle").focus?.();
  });
}

// ------------------------------------------------------------------------------------- cards
function miniBlink(meta, c, motion) {
  const bin = (meta.wavelength_bins || []).find((b) => b.wavelength_um === c.bin);
  if (!bin) return "";
  const m = meta.measured || {};
  const eps = motion && m.from_epoch ? [m.from_epoch, m.to_epoch] : [bin.frames[0]?.epoch, bin.frames[bin.frames.length - 1]?.epoch];
  const fr = eps.map((e) => bin.frames.find((f) => f.epoch === e));
  if (!fr[0] || !fr[1]) return "";
  const mk = eps.map((e) => (meta.markers || []).find((k) => k.epoch === e)?.png_xy);
  const [W, H] = meta.grid?.png_px || [720, 770];
  const cx = mk[0] && mk[1] ? (mk[0][0] + mk[1][0]) / 2 : W / 2, cy = mk[0] && mk[1] ? (mk[0][1] + mk[1][1]) / 2 : (H + (meta.grid?.label_strip_px || 0)) / 2;
  const C = c.crop, x0 = cx - C / 2, y0 = cy - C / 2;
  const base = `data/${c.id}/`;
  const ring = (xy, cls) => (motion && xy ? `<circle class="rg ${cls}" cx="${xy[0]}" cy="${xy[1]}" r="${Math.max(5, C * 0.06)}"/>` : "");
  const fs = C * 0.055;
  return `<button type="button" class="mb" aria-label="${esc(t("s.blinkBtn"))}">
    <svg viewBox="${x0.toFixed(1)} ${y0.toFixed(1)} ${C} ${C}" aria-hidden="true">
      <image href="${base + fr[0].file}" width="${W}" height="${H}"/>
      <image class="fb" href="${base + fr[1].file}" width="${W}" height="${H}"/>
      ${ring(mk[0], "a")}${ring(mk[1], "b")}
      <text class="la" x="${x0 + C * 0.04}" y="${y0 + C - C * 0.05}" font-size="${fs}">${esc(month(eps[0]))}</text>
      <text class="lb" x="${x0 + C * 0.04}" y="${y0 + C - C * 0.05}" font-size="${fs}">${esc(month(eps[1]))}</text>
    </svg></button>
    <p class="fine mbcap">${esc(t("s.blinkCap", { um: num(c.bin, 1), box: num(C * (meta.grid?.pixel_arcsec || 3) / (meta.grid?.upscale || 4) / 60, 1) }))}</p>`;
}

function ly(plx) { return plx ? big(1000 / plx * LY_PER_PC) : null; }

function cardHtml(c) {
  const r = TABLE?.rows?.find((x) => x.id === c.id);
  const meta = META[c.id];
  const motion = r?.kind === "motion";
  const v = { ly: ly(r?.reference?.parallax_mas) };
  if (motion && r.measured) {
    Object.assign(v, { shift: fmtA(r.measured.shift_arcsec), err: fmtA(r.measured.err_arcsec), ref: fmtA(r.reference.shift_arcsec),
      dt: num(r.measured.dt_years, 2), from: month(r.measured.from), to: month(r.measured.to),
      pm: num((r.reference.pm_total_mas_yr || 0) / 1000, 1), bins: (r.detected_bins_um || []).map((b) => num(b, 1)).join(", ") });
  }
  if (r?.kind === "brightness") {
    const b = (r.brightness_bins || []).find((x) => x.wavelength_um === 4.6) || (r.brightness_bins || []).slice(-1)[0];
    if (b) {
      const k = b.ratio.length - 1;
      const lo = Math.min(...b.ratio);
      Object.assign(v, { um: num(b.wavelength_um, 1), r: num(b.ratio[k], 2), e: num(b.err[k], 2), from: month(b.seasons[0]), to: month(b.seasons[k]), lo: num(lo, 2) });
    }
    const b1 = (r.brightness_bins || []).find((x) => x.wavelength_um === 1.0);
    if (b1) v.r1 = num(b1.ratio[b1.ratio.length - 1], 2);
  }
  const img = meta && c.bin ? miniBlink(meta, c, motion) : "";
  const link = c.id === "luhman16" ? `<a href="explore.html?p=luhman16">${esc(t("s.onSky"))} →</a>`
    : `<a href="ornek.html?data=data/${c.id}/">${esc(t("s.openBlink"))} →</a><a href="explore.html?p=${c.id}">${esc(t("s.onSky"))} →</a>`;
  return `<article class="scard" id="t-${c.id}">
    ${img}
    <span class="lbl">${esc(t(`s.${c.id}.tag`))}</span>
    <h3>${esc(r?.name || c.id)}</h3>
    <p><b>${esc(t("s.what"))}</b> ${esc(t(`s.${c.id}.what`, v))}</p>
    <p><b>${esc(t("s.why"))}</b> ${esc(t(`s.${c.id}.why`, v))}</p>
    <p><b>${esc(t("s.shows"))}</b> ${esc(t(`s.${c.id}.shows`, v))}</p>
    <div class="go">${link}</div>
  </article>`;
}

function renderCards() {
  $("cards").innerHTML = CARDS.map(cardHtml).join("");
  for (const b of document.querySelectorAll(".scard .mb")) {
    const s = b.querySelector("svg");
    b.addEventListener("click", () => { b.dataset.manual = "1"; s.classList.toggle("b"); });
  }
  if (!reduceMotion && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => {
      for (const e of es) e.target.dataset.vis = e.isIntersecting ? "1" : "";
    }, { threshold: 0.4 });
    for (const b of document.querySelectorAll(".scard .mb")) io.observe(b);
  }
}
setInterval(() => {
  if (reduceMotion || document.hidden) return;
  for (const b of document.querySelectorAll('.scard .mb[data-vis="1"]:not([data-manual])')) b.querySelector("svg").classList.toggle("b");
}, 900);

// --------------------------------------------------------------------------- How SPHEREx works
// Facts: Crill et al. 2020 (SPIE; arXiv:2404.11017): 20 cm telescope, two 1x3 mosaics of H2RG
// detectors behind a dichroic beam splitter (reflects < 2.42 µm), 3.5° x 3.5° per detector, 3.5° x 11.3°
// per mosaic, 0.75-5 µm. One linear variable filter per detector, 17 channels each, 102 in all
// (SPHEREx spectral response paper, arXiv:2602.09139). Full sky every ~6 months, four times in the
// 2-year mission (NASA/JPL). Pixel 6.15″ (pipeline value; often rounded to 6.2″).
const BANDS = ["#5b3fd6", "#2f6fe0", "#1fa3c9", "#2fc48a", "#c9b52b", "#e0603a"];   // false colours D1..D6

function svgSplit() {
  const det = (x, y, i) => `<rect x="${x}" y="${y}" width="44" height="44" rx="4" fill="${BANDS[i]}" fill-opacity=".85" stroke="#05070d"/>
    <text x="${x + 22}" y="${y + 27}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">D${i + 1}</text>`;
  return `<svg viewBox="0 0 320 210" role="img" aria-label="${esc(t("how.a.alt"))}">
    <rect width="320" height="210" fill="#070a14"/>
    <g fill="none" stroke="#a9b3c9" stroke-width="2"><path d="M14 105h40l14 -16v32l-14 -16"/><rect x="68" y="85" width="30" height="40" rx="4"/></g>
    <text x="12" y="146" font-size="11" fill="#a9b3c9">${esc(t("how.a.tel"))}</text>
    <path d="M98 105H146" stroke="#eef1f8" stroke-width="3"/>
    <line x1="136" y1="92" x2="160" y2="118" stroke="#7fd4ff" stroke-width="4"/>
    <text x="144" y="80" font-size="11" fill="#7fd4ff" text-anchor="end">${esc(t("how.a.dich"))}</text>
    <path d="M148 101V42H170" stroke="#2f6fe0" stroke-width="3" fill="none"/>
    <path d="M152 109V168H170" stroke="#e0603a" stroke-width="3" fill="none"/>
    ${[0, 1, 2].map((i) => det(174 + i * 46, 20, i)).join("")}
    ${[3, 4, 5].map((i) => det(174 + (i - 3) * 46, 146, i)).join("")}
    <text x="174" y="80" font-size="11.5" fill="#eef1f8">0.75–2.42 µm</text>
    <text x="174" y="206" font-size="11.5" fill="#eef1f8">2.42–5.0 µm</text>
  </svg>`;
}

function svgLvf() {
  const stripes = Array.from({ length: 17 }, (_, i) => `<rect x="${20 + i * 16}" y="40" width="16" height="96" fill="hsl(${265 - i * 14} 70% ${42 + i}%)"/>`).join("");
  return `<svg viewBox="0 0 320 210" role="img" aria-label="${esc(t("how.b.alt"))}">
    <rect width="320" height="210" fill="#070a14"/>
    <text x="20" y="28" font-size="12" fill="#eef1f8" font-weight="700">${esc(t("how.b.det"))}</text>
    ${stripes}
    <rect x="20" y="40" width="272" height="96" fill="none" stroke="#eef1f8" stroke-width="1.5"/>
    <path d="M24 156H288" stroke="#eef1f8" stroke-width="1.6"/><path d="M280 151l8 5-8 5" fill="none" stroke="#eef1f8" stroke-width="1.6"/>
    <text x="20" y="176" font-size="11.5" fill="#a9b3c9">${esc(t("how.b.short"))}</text>
    <text x="292" y="176" font-size="11.5" fill="#a9b3c9" text-anchor="end">${esc(t("how.b.long"))}</text>
    <text x="156" y="200" font-size="12" fill="#ffc94d" text-anchor="middle" font-weight="700">${esc(t("how.b.count"))}</text>
  </svg>`;
}

function svgStep() {
  const K = 9, w = 15, X = 170;                              // stripes, stripe width, star x (fixed on the sky)
  const row = (y, dx, i) => {
    const stripes = Array.from({ length: K }, (_, k) => `<rect x="${dx + k * w}" y="${y}" width="${w}" height="36" fill="hsl(${265 - k * 26} 70% ${44 + k}%)"/>`).join("");
    const k = Math.floor((X - dx) / w);
    return `${stripes}<rect x="${dx}" y="${y}" width="${K * w}" height="36" fill="none" stroke="#eef1f8"/>
      <circle cx="${X}" cy="${y + 18}" r="6" fill="#fff" stroke="#05070d" stroke-width="2"/>
      <text x="${dx - 6}" y="${y + 23}" font-size="11.5" fill="#a9b3c9" text-anchor="end">${esc(t("how.c.exp", { n: i + 1 }))}</text>
      <rect x="${dx + K * w + 8}" y="${y + 9}" width="18" height="18" rx="3" fill="hsl(${265 - k * 26} 70% ${44 + k}%)" stroke="#eef1f8"/>`;
  };
  return `<svg viewBox="0 0 320 210" role="img" aria-label="${esc(t("how.c.alt"))}">
    <rect width="320" height="210" fill="#070a14"/>
    <path d="M${X} 30V182" stroke="#ffc94d" stroke-dasharray="3 4" stroke-width="1.4"/>
    <text x="${X}" y="22" font-size="11.5" fill="#ffc94d" text-anchor="middle">${esc(t("how.c.star"))}</text>
    ${row(36, 140, 0)}${row(86, 110, 1)}${row(136, 80, 2)}
    <text x="${X}" y="202" font-size="11.5" fill="#a9b3c9" text-anchor="middle">${esc(t("how.c.foot"))}</text>
  </svg>`;
}

function svgPixels(shift, pix) {
  const n = 6, S = 34, x0 = 60, y0 = 26;
  const grid = Array.from({ length: n * n }, (_, k) => `<rect x="${x0 + (k % n) * S}" y="${y0 + Math.floor(k / n) * S}" width="${S}" height="${S}" fill="#0d1428" stroke="#2a3350"/>`).join("");
  const L = shift / pix * S;                                  // shift in drawing units
  const cx = x0 + 3 * S, cyA = y0 + 4.6 * S;
  return `<svg viewBox="0 0 320 250" role="img" aria-label="${esc(t("how.d.alt", { s: fmtA(shift, 1), p: num(shift / pix, 1) }))}">
    <rect width="320" height="250" fill="#070a14"/>${grid}
    <circle cx="${cx}" cy="${cyA}" r="9" fill="#7fd4ff"/><circle cx="${cx}" cy="${cyA - L}" r="9" fill="#ffc94d"/>
    <path d="M${cx + 16} ${cyA}V${cyA - L + 4}" stroke="#fff" stroke-width="2"/><path d="M${cx + 11} ${cyA - L + 10}l5 -7 5 7" fill="none" stroke="#fff" stroke-width="2"/>
    <text x="${cx + 24}" y="${cyA - L / 2 + 4}" font-size="12" fill="#fff" font-weight="700">${esc(fmtA(shift, 1))}</text>
    <text x="${x0}" y="18" font-size="11.5" fill="#a9b3c9">${esc(t("how.d.px", { p: num(pix, 2) }))}</text>
    <text x="${x0}" y="${y0 + n * S + 18}" font-size="11.5" fill="#7fd4ff">● ${esc(t("how.d.a"))}</text>
    <text x="${x0 + 110}" y="${y0 + n * S + 18}" font-size="11.5" fill="#ffc94d">● ${esc(t("how.d.b"))}</text>
  </svg>`;
}

function renderHow() {
  const b = TABLE?.rows?.find((r) => r.id === "barnard");
  const pix = 6.15;
  const shift = b?.measured?.shift_arcsec ?? 10;
  const n = b?.n_images, s = (b?.seasons || []).length;
  const coin = Math.round(0.025 / (pix / 206264.806) / 10) * 10;                // metres: 2.5 cm coin seen as one pixel
  const fig = (svg, h, p) => `<figure class="how"><div class="svgbox">${svg}</div><figcaption><b>${esc(h)}</b> ${p}</figcaption></figure>`;
  $("howBox").innerHTML = `<p class="sub">${esc(t("how.lead"))}</p><div class="hows">
    ${fig(svgSplit(), t("how.a.h"), esc(t("how.a.p")))}
    ${fig(svgLvf(), t("how.b.h"), esc(t("how.b.p")))}
    ${fig(svgStep(), t("how.c.h"), esc(t("how.c.p")))}
    ${fig(svgPixels(shift, pix), t("how.d.h"), esc(t("how.d.p", { p: num(pix, 2), coin: big(coin), s: fmtA(shift, 1), k: num(shift / pix, 1), n: n ?? "?", ns: s || "?", per: n && s ? Math.round(n / s) : "?" })))}
  </div>`;
}

// ------------------------------------------------------------------------------------------ boot
function renderAll() {
  apply(document);
  document.title = t("s.title");
  $("nameText").innerHTML = t("name.p");
  renderCards();
  renderHow();
}

$("langSlot").appendChild(langButton("fz-lang"));
onLang(() => { document.documentElement.lang = lang(); renderAll(); });
document.documentElement.lang = lang();
newHere();
TABLE = await get("data/verify/table.json");
await Promise.all(CARDS.filter((c) => c.bin).map(async (c) => { META[c.id] = await get(`data/${c.id}/meta.json`); }));
renderAll();
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
