// Embeddable mini blink viewer (embed.html): one small card meant to live in an <iframe> on other sites.
//   embed.html?target=<name>   a ready result in data/<name>/ (the five challenge targets): its prebuilt season frames
//                              shown in turn, the catalogue ring, north/east, a scale bar and one verdict line, all
//                              from that folder's meta.json
//   embed.html?ra=..&dec=..    a free point (degrees): where it is on the SPHEREx all-sky map, a link that measures it
//                              on the full site, and "Quick look here", which runs the browser engine (js/engine.js) for
//                              one wavelength on click only
//   &bin=2.0                   wavelength in µm (default: the one the full viewer opens with)
//   &lang=tr                   Turkish (default English)
// Light on purpose: no sky-map library and no site i18n files (150 KB each); its own short EN/TR word list below.
// js/explain.js (the site's rules for a brightness change and for a shift that must not be stated) and the engine
// load only when needed. Every number comes from the result's own files; nothing is typed by hand.

const Q = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const LANG = Q.get("lang") === "tr" ? "tr" : "en";
const $ = (id) => document.getElementById(id);
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const VISIT = ["#3987e5", "#d95926", "#199e70", "#c98500", "#9085e9", "#e66767"];   // one colour per visit, as on the site
const visitColour = (i) => VISIT[((i % VISIT.length) + VISIT.length) % VISIT.length];
const FRAME_MS = 800;                                   // time per season (the full viewer's default)

const WORDS = {
  en: {
    loading: "Loading…",
    open: "Open in Fazari ↗",
    openTip: "The full result on the Fazari site (opens a new tab)",
    openPoint: "Measure this point on the Fazari site (opens a new tab)",
    pause: "Pause the blink", play: "Play the blink",
    visit: "Visit {i} of {n}: {date}",
    visits: "Visits",
    stage: "SPHEREx images of {name} at {um}, one per visit, shown in turn",
    alt: "SPHEREx image of {name}, {date}, {um}",
    ringTip: "Ring: where {cat} puts the object at each visit",
    ringPoint: "Ring: the point in the link",
    compass: "North up, east left", N: "N", E: "E", yr: "yr",
    movesPred: "<b>Moves {v}</b>, matching {cat}.",
    movesDiff: "<b>Moves {v}</b>; {cat} gives a different motion.",
    movesNew: "<b>Moves {v}</b>. Not in the catalogue: a candidate, not confirmed.",
    still: "<b>No motion measured</b> (slower than {x}).",
    unsure: "<b>Not sure yet</b>: the measurement is too uncertain to say whether it moves.",
    noSrc: "<b>No source detected</b> at this point.",
    up: "<b>Got brighter: {pc}</b> at {um}, {a} → {b}.",
    down: "<b>Got fainter: {pc}</b> at {um}, {a} → {b}.",
    flat: "<b>No brightness change</b> beyond the errors ({e}), {a} → {b}.",
    few: "Too few comparison stars here to measure a brightness change.",
    measuredTip: "Measured by Fazari from NASA SPHEREx images",
    data: "NASA SPHEREx (IRSA)",
    ring: "ring: {cat}",
    ai: "AI-assisted code",
    aiTip: "The code of this card was written with help from Anthropic's Claude (Claude Code) and checked by Team Fazari. The images and numbers come from NASA SPHEREx data, not from an AI model.",
    point: "Sky point",
    pointVd: "<b>Not measured yet.</b> Open this point in Fazari to measure it.",
    quick: "Quick look here",
    quickTip: "Fetch a few SPHEREx images of this point now (one wavelength, about 10–30 MB)",
    quickBusy: "Fetching SPHEREx images…",
    quickVd: "<b>Quick look</b> from {n} SPHEREx images: not a measurement. Open in Fazari to measure it.",
    quickNone: "No SPHEREx images of this point in two seasons yet.",
    quickFail: "The quick look did not work here ({msg}). Open in Fazari to try the full engine.",
    mapAlt: "SPHEREx all-sky map with this point marked",
    map: "Map: NASA SPHEREx all-sky (IRSA)",
    notFound: "No ready result named “{id}”.",
    bad: "Add ?target=<name> or ?ra=..&dec=.. to the link.",
    failMeta: "This result could not be loaded.",
    noFrames: "This result has no SPHEREx frames.",
  },
  tr: {
    loading: "Yükleniyor…",
    open: "Fazari'de aç ↗",
    openTip: "Fazari sitesindeki tam sonuç (yeni sekmede açılır)",
    openPoint: "Bu noktayı Fazari sitesinde ölçün (yeni sekmede açılır)",
    pause: "Blink'i durdur", play: "Blink'i oynat",
    visit: "Ziyaret {i}/{n}: {date}",
    visits: "Ziyaretler",
    stage: "{name} için {um} SPHEREx görüntüleri: her ziyaretten bir kare, sırayla",
    alt: "{name}, {date}, {um} SPHEREx görüntüsü",
    ringTip: "Halka: {cat} kaynağına göre cismin her ziyaretteki yeri",
    ringPoint: "Halka: bağlantıdaki nokta",
    compass: "Kuzey yukarıda, doğu solda", N: "K", E: "D", yr: "yıl",
    movesPred: "<b>Hareket ediyor: {v}</b>; {cat} ile uyumlu.",
    movesDiff: "<b>Hareket ediyor: {v}</b>; {cat} başka bir hareket veriyor.",
    movesNew: "<b>Hareket ediyor: {v}</b>. Katalogda yok: aday, doğrulanmadı.",
    still: "<b>Hareket ölçülmedi</b> ({x} değerinden yavaş).",
    unsure: "<b>Henüz emin değiliz</b>: ölçüm, hareket edip etmediğini söylemek için fazla belirsiz.",
    noSrc: "<b>Bu noktada kaynak görülmedi.</b>",
    up: "<b>Parlaklaştı: {pc}</b> ({um}; {a} → {b}).",
    down: "<b>Sönükleşti: {pc}</b> ({um}; {a} → {b}).",
    flat: "<b>Parlaklık değişmedi</b>: fark hata payının içinde ({e}; {a} → {b}).",
    few: "Burada karşılaştırma yıldızı çok az; parlaklık değişimi ölçülemiyor.",
    measuredTip: "Fazari tarafından NASA SPHEREx görüntülerinden ölçüldü",
    data: "NASA SPHEREx (IRSA)",
    ring: "halka: {cat}",
    ai: "Yapay zekâ destekli kod",
    aiTip: "Bu kartın kodu Anthropic'in Claude (Claude Code) aracının yardımıyla yazıldı ve Fazari ekibi tarafından kontrol edildi. Görüntüler ve sayılar NASA SPHEREx verisinden gelir, bir yapay zekâ modelinden değil.",
    point: "Gökyüzünde bir nokta",
    pointVd: "<b>Henüz ölçülmedi.</b> Ölçmek için bu noktayı Fazari'de açın.",
    quick: "Burada hızlı bak",
    quickTip: "Bu noktanın birkaç SPHEREx görüntüsünü şimdi getir (tek dalga boyu, yaklaşık 10–30 MB)",
    quickBusy: "SPHEREx görüntüleri getiriliyor…",
    quickVd: "<b>Hızlı bakış</b>: {n} SPHEREx görüntüsü, ölçüm değil. Ölçmek için Fazari'de açın.",
    quickNone: "Bu noktanın henüz iki sezonluk SPHEREx görüntüsü yok.",
    quickFail: "Hızlı bakış burada olmadı ({msg}). Tam motoru denemek için Fazari'de açın.",
    mapAlt: "Bu noktanın işaretli olduğu SPHEREx tüm gökyüzü haritası",
    map: "Harita: NASA SPHEREx tüm gökyüzü (IRSA)",
    notFound: "“{id}” adında hazır bir sonuç yok.",
    bad: "Bağlantıya ?target=<ad> ya da ?ra=..&dec=.. ekleyin.",
    failMeta: "Bu sonuç yüklenemedi.",
    noFrames: "Bu sonucun SPHEREx karesi yok.",
  },
};
const NAMES_TR = { "Barnard's Star": "Barnard Yıldızı" };
export const T = (k, p = {}, lang = LANG) => String((WORDS[lang] || WORDS.en)[k] ?? WORDS.en[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? String(p[x]) : m));
export const loc = (s, lang = LANG) => (lang === "tr" ? String(s).replace(/(\d)\.(\d)/g, "$1,$2") : String(s));
const tname = (n) => (LANG === "tr" && NAMES_TR[n]) || n;
const umTxt = (um) => loc((+um).toFixed(1)) + " µm";
/** "2025-08" -> "Aug 2025" / "Ağu 2025". */
export function monthTxt(ep, lang = LANG) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ep || ""));
  if (!m) return String(ep || "");
  try { return new Intl.DateTimeFormat(lang, { month: "short", year: "numeric", timeZone: "UTC" }).format(Date.UTC(+m[1], +m[2] - 1, 15)); }
  catch (_) { return `${m[1]}-${m[2]}`; }
}
const dec = (v, e) => (Math.abs(v) < 1 || (ok(e) && e > 0 && e < 0.095) ? 2 : 1);
export const speedTxt = (v, e, lang = LANG) => loc((+v).toFixed(dec(v, e)), lang) + (ok(e) ? " ± " + loc((+e).toFixed(dec(v, e)), lang) : "") + "″/" + T("yr", {}, lang);
const pctTxt = (x, lang = LANG) => (lang === "tr" ? `%${x}` : `${x} %`);

// ---- the verdict line of a ready result ----------------------------------------------------------------------------
/** Yearly speed ± error from the joint fit of every exposure (as js/gr.js speedFit), else shift / time. */
export function speedOf(ms) {
  const f = ms && ms.fit;
  if (f && ok(f.pmra_mas_yr) && ok(f.pmdec_mas_yr)) {
    const a = +f.pmra_mas_yr, d = +f.pmdec_mas_yr, v = Math.hypot(a, d) / 1000;
    const ea = ok(f.pmra_err_mas_yr) ? +f.pmra_err_mas_yr : null, ed = ok(f.pmdec_err_mas_yr) ? +f.pmdec_err_mas_yr : null;
    const e = ea != null && ed != null ? (v > 0 ? Math.hypot(a * ea, d * ed) / (v * 1000) / 1000 : Math.max(ea, ed) / 1000) : null;
    return { v, e };
  }
  const dt = ok(ms && ms.dt_years) && +ms.dt_years > 0 ? +ms.dt_years : null;
  if (!dt || !ok(ms.shift_arcsec)) return null;
  return { v: +ms.shift_arcsec / dt, e: ok(ms.shift_err_arcsec) && +ms.shift_err_arcsec > 0 ? +ms.shift_err_arcsec / dt : null };
}
/** The catalogue behind the ring and the prediction: { short, tiny, full } ("Gaia DR3"; "Spitzer (Kirkpatrick et al. 2021)",
 *  "Spitzer"). */
export function refOf(meta) {
  const g = (meta && meta.gaia) || {}, label = String(g.label || "");
  if (!label || /requested position/i.test(label)) return null;
  const m = /^(.*?)\s*\((.+)\)$/.exec(label);           // "Kirkpatrick et al. 2021 (Spitzer)" -> "Spitzer (Kirkpatrick et al. 2021)"
  return { short: m ? `${m[2]} (${m[1]})` : label, tiny: m ? m[2] : label, full: String(g.reference || label) };
}
/** The class of a motion result, by the rule of js/verdict_strip.js classify (the engine's answer_from_meta). */
export function motionClass(meta, X) {
  const ms = (meta && meta.measured) || {};
  const st = ms.status || (ms.detection || {}).status;
  if (st === "not_detected") return "not_detected";
  if (!ok(ms.shift_arcsec) || !(+ms.shift_err_arcsec > 0)) return "too_uncertain";
  if (X && X.answerGuard && X.answerGuard(meta)) return "too_uncertain";
  const s = +ms.shift_arcsec, e = +ms.shift_err_arcsec, g = meta.gaia || {};
  const p = (+g.pmra_mas_yr || +g.pmdec_mas_yr) && ok(ms.gaia_predicted_arcsec) ? +ms.gaia_predicted_arcsec : null;
  const sig = s > Math.max(3 * e, 0.2), psig = p != null && p > Math.max(3 * e, 0.2);
  if (sig && psig) return Math.abs(s - p) <= Math.max(3 * e, 0.1 + 0.05 * p) ? "moving_as_predicted" : "moving_unlike_prediction";
  if (sig) return "moving";
  if (psig) return "too_uncertain";
  return "not_moving";
}
/** One line (trusted HTML from the word list, numbers escaped) for a ready meta.json. X = js/explain.js. */
export function verdictHtml(meta, X, lang = LANG) {
  const ms = (meta && meta.measured) || {};
  const L = (k, p) => T(k, p, lang), mo = (ep) => esc(monthTxt(ep, lang));
  if (ms.photometry || ms.status === "brightness") {
    if (!X || !X.brightnessChange) return "";          // the site's rule did not load: no line rather than a wrong one
    const c = X.brightnessChange(ms.photometry);
    if (!c) return esc(L("few"));
    if (c.flat) return L("flat", { e: ok(c.err) ? "± " + pctTxt(Math.max(1, Math.round(100 * c.err)), lang) : "", a: mo(c.from), b: mo(c.to) }).replace(" ()", "").replace("(; ", "(");
    const m = c.main, pc = Math.round(100 * Math.abs(m.r - 1)), pe = Math.max(1, Math.round(100 * m.er));
    return L(m.r >= 1 ? "up" : "down", { pc: `${pctTxt(pc, lang)} ± ${pctTxt(pe, lang)}`, um: esc(loc((+m.b.wavelength_um).toFixed(1), lang) + " µm"), a: mo(c.from), b: mo(c.to) });
  }
  const code = motionClass(meta, X), sp = speedOf(ms), ref = refOf(meta);
  if (code === "not_detected") return L("noSrc");
  if (code === "too_uncertain" || !sp) return L("unsure");
  if (code === "not_moving") return L("still", { x: esc(speedTxt(Math.max(3 * (sp.e || 0), 0.01), null, lang)) });
  const v = esc(speedTxt(sp.v, sp.e, lang)), cat = esc(ref ? ref.short : "");
  if (code === "moving_as_predicted" && ref) return L("movesPred", { v, cat });
  if (code === "moving_unlike_prediction" && ref) return L("movesDiff", { v, cat });
  return L("movesNew", { v });
}

// ---- the picture: a box of W x H picture pixels placed in the stage with translate + scale -------------------------
const P = { W: 0, H: 0, strip: 0, arcsec: 0, centre: [0, 0], jump: null, wide: false, k: 1, ringAt: () => null };
let frames = [];                                       // [{ el, epoch, label }]
let idx = 0, playing = true, timer = 0, pic = null, ov = null;

function svgEl(tag, attrs) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
/** Close-up, a little wider than the full viewer's (a small card needs the field stars around the target): about 2.5′
 *  across (5′ for a brightness target), closer when a mover's jump would be under ~18 screen px, never closer than 1′
 *  across, never smaller than the whole field. */
function layout() {
  const st = $("stage");
  if (!pic || !st) return;
  const Sw = st.clientWidth, Sh = st.clientHeight;
  if (!Sw || !Sh) return;
  const { W, H, strip: Ls, arcsec: a } = P;
  const k1 = Math.min(Sw / W, Sh / (H - Ls)), m = Math.min(Sw, Sh);
  let k = a ? m * a / (P.wide ? 300 : 150) : k1;
  if (a && P.jump != null && P.jump * a >= 2) k = Math.max(k, 18 / P.jump);
  if (a) k = Math.min(k, m * a / 60);
  k = Math.max(k, k1);
  const [cx, cy] = P.centre;
  let tx = Sw / 2 - cx * k, ty = Sh / 2 - cy * k;
  const sw = W * k, sh = (H - Ls) * k;
  tx = sw >= Sw ? Math.min(0, Math.max(Sw - sw, tx)) : (Sw - sw) / 2;
  ty = sh >= Sh ? Math.min(-Ls * k, Math.max(Sh - sh - Ls * k, ty)) : (Sh - sh) / 2 - Ls * k;     // the label strip stays hidden
  pic.style.width = W + "px"; pic.style.height = H + "px";
  pic.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${k.toFixed(5)})`;
  P.k = k;
  ring();
  scaleBar();
}
function ring() {
  if (!ov) return;
  ov.textContent = "";
  const f = frames[idx], xy = f && P.ringAt(f.epoch);
  if (!xy) return;
  // as the full viewer: about 11″ on the sky, never under 13 screen px, never over 60
  const u = 1 / P.k, r = Math.min(Math.max(P.arcsec ? 11 / P.arcsec : 15, 13 * u), 60 * u);
  ov.append(svgEl("circle", { cx: xy[0], cy: xy[1], r, fill: "none", stroke: "#05070d", "stroke-opacity": ".6", "stroke-width": 3.4 * u }),
    svgEl("circle", { cx: xy[0], cy: xy[1], r, fill: "none", stroke: "#ffb347", "stroke-width": 1.5 * u }),
    svgEl("circle", { cx: xy[0], cy: xy[1], r: 2 * r, fill: "none", stroke: "#ffb347", "stroke-opacity": ".38", "stroke-width": 1.1 * u }));
}
function scaleBar() {
  const el = $("hud");
  if (!el) return;
  if (!P.arcsec || !P.k) { el.hidden = true; return; }
  const perPx = P.arcsec / P.k;                          // arcsec per screen pixel
  const st = $("stage"), maxPx = Math.max(30, Math.min(70, st.clientWidth * 0.22));
  const pick = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600].filter((v) => v / perPx <= maxPx).pop() || 1;
  const px = pick / perPx;
  el.hidden = false;
  el.innerHTML = `<svg viewBox="0 0 34 34" width="26" height="26" role="img" aria-label="${esc(T("compass"))}">` +
    `<path d="M24 26V9M24 26H7" stroke="currentColor" stroke-width="1.8" fill="none"/>` +
    `<path d="M20.5 12L24 7l3.5 5M10 22.5L5 26l5 3.5" stroke="currentColor" stroke-width="1.8" fill="none"/>` +
    `<text x="24" y="5.5" font-size="8" text-anchor="middle" fill="currentColor">${esc(T("N"))}</text>` +
    `<text x="3" y="22" font-size="8" text-anchor="middle" fill="currentColor">${esc(T("E"))}</text></svg>` +
    `<span class="bar" style="width:${px.toFixed(0)}px"></span><span>${pick >= 60 ? loc(String(pick / 60)) + "′" : pick + "″"}</span>`;
}

// ---- the blink ------------------------------------------------------------------------------------------------------
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function show(i) {
  if (!frames.length) return;
  idx = ((i % frames.length) + frames.length) % frames.length;
  frames.forEach((f, j) => f.el.classList.toggle("on", j === idx));
  const f = frames[idx], tag = $("tag");
  if (tag) {
    tag.style.setProperty("--v", visitColour(idx));
    tag.innerHTML = `<span>${esc(f.label)}</span><small>${idx + 1}/${frames.length}</small>`;
  }
  document.querySelectorAll(".dot").forEach((d, j) => d.setAttribute("aria-current", j === idx ? "true" : "false"));
  ring();
}
function schedule() {
  clearTimeout(timer);
  if (!playing || frames.length < 2 || document.hidden || !inView) return;
  timer = setTimeout(() => { show(idx + 1); schedule(); }, FRAME_MS);
}
function setPlaying(on) {
  playing = !!on && frames.length > 1;
  const b = $("pp");
  if (b) {
    b.setAttribute("aria-label", T(playing ? "pause" : "play"));
    b.title = T(playing ? "pause" : "play");
    b.innerHTML = playing
      ? '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="1.5" width="3.2" height="11" rx="1" fill="currentColor"/><rect x="8.3" y="1.5" width="3.2" height="11" rx="1" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 1.8v10.4L12 7z" fill="currentColor"/></svg>';
  }
  schedule();
}
let inView = true;
function watchVisibility() {
  document.addEventListener("visibilitychange", schedule);
  if (typeof IntersectionObserver === "function") {     // an embed scrolled out of sight stops blinking
    new IntersectionObserver((es) => { inView = es.some((e) => e.isIntersecting); schedule(); }).observe($("stage"));
  }
}
/** The picture box, its frames (img or canvas elements), the ring layer, the date tag, the dots, the button. */
function mountBlink(els, labels, epochs, name, um) {
  const st = $("stage");
  st.textContent = "";
  st.setAttribute("aria-label", T("stage", { name, um }));
  pic = document.createElement("div");
  pic.className = "pic";
  frames = els.map((el, i) => { pic.append(el); return { el, epoch: epochs[i], label: labels[i] }; });
  ov = svgEl("svg", { viewBox: `0 0 ${P.W} ${P.H}`, "aria-hidden": "true", preserveAspectRatio: "none" });
  pic.append(ov);
  const tag = document.createElement("div");
  tag.className = "tag"; tag.id = "tag"; tag.setAttribute("aria-hidden", "true");
  const hud = document.createElement("div");
  hud.className = "hud"; hud.id = "hud"; hud.hidden = true;
  const ctl = document.createElement("div");
  ctl.className = "ctl";
  if (frames.length > 1) {
    const dots = document.createElement("div");
    dots.className = "dots"; dots.setAttribute("role", "group"); dots.setAttribute("aria-label", T("visits"));
    frames.forEach((f, i) => {
      const d = document.createElement("button");
      d.type = "button"; d.className = "dot"; d.style.setProperty("--v", visitColour(i));
      d.setAttribute("aria-label", T("visit", { i: i + 1, n: frames.length, date: f.label }));
      d.onclick = () => { setPlaying(false); show(i); };
      dots.append(d);
    });
    const pp = document.createElement("button");
    pp.type = "button"; pp.className = "pp"; pp.id = "pp";
    pp.onclick = () => setPlaying(!playing);
    ctl.append(dots, pp);
  }
  st.append(pic, tag, hud, ctl);
  st.tabIndex = 0;
  st.onkeydown = (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); show(idx + (e.key === "ArrowRight" ? 1 : -1)); }
    else if ((e.key === " " || e.key === "k") && e.target === st) { e.preventDefault(); setPlaying(!playing); }
  };
  show(0);
  layout();
  setPlaying(!reduced());
  if (typeof ResizeObserver === "function") new ResizeObserver(layout).observe(st); else addEventListener("resize", layout);
  watchVisibility();
}

// ---- links and credits ----------------------------------------------------------------------------------------------
const withLang = (u) => (LANG === "tr" ? u + (u.includes("?") ? "&" : "?") + "lang=tr" : u);
function setOpen(href, tip) {
  const a = $("open");
  a.href = new URL(withLang(href), location.href).href;
  a.textContent = T("open");
  a.title = tip;
}
function setFine(parts) {
  const el = $("fine");
  el.innerHTML = parts.filter(Boolean).join(" · ") + ` · <abbr title="${esc(T("aiTip"))}">${esc(T("ai"))}</abbr>`;
  el.title = el.textContent;
}
function message(text, href) {
  const st = $("stage");
  st.innerHTML = `<div class="msg">${esc(text)}</div>`;
  if (href) setOpen(href, T("openTip"));
}

// ---- a ready result (data/<name>/) ----------------------------------------------------------------------------------
/** The start wavelength, as the full viewer: ?bin= when that bin has the object; a detected bin for a faint target;
 *  for a mover the detected bin with the most images in its thinnest season (ties: the longest wavelength); for a
 *  brightness target the bin of the strongest change. */
function startBin(meta, X, want) {
  const bins = meta.wavelength_bins || [], ms = meta.measured || {};
  const find = (v) => (v ? bins.findIndex((b) => Math.abs(b.wavelength_um - v) < 0.05) : -1);
  const db = (ms.detection || {}).detected_bins_um || [];
  const kb = find(want);
  if (kb >= 0 && (ms.status === "detected" || !db.length || db.some((w) => Math.abs(w - want) < 0.05))) return kb;
  if (db.length && ms.status !== "detected" && !ok(ms.shift_arcsec) && find(db[db.length - 1]) >= 0) return find(db[db.length - 1]);
  if (db.length && ok(ms.shift_arcsec)) {
    let best = -1;
    const thin = (k) => Math.min(...bins[k].frames.map((f) => f.n_images || 0));
    db.forEach((w) => { const k = find(w); if (k >= 0 && (best < 0 || thin(k) >= thin(best))) best = k; });
    if (best >= 0) return best;
  }
  if (ms.photometry && X && X.brightnessChange) {
    const c = X.brightnessChange(ms.photometry);
    if (c && c.main && find(c.main.b.wavelength_um) >= 0) return find(c.main.b.wavelength_um);
  }
  return kb >= 0 ? kb : 0;
}
async function readyTarget(id) {
  const base = `data/${id}/`;
  setOpen(`ornek.html?data=${base}`, T("openTip"));
  let meta = null;
  try {
    const r = await fetch(base + "meta.json");
    if (r.ok) meta = await r.json();
    else { message(T(r.status === 404 ? "notFound" : "failMeta", { id }), "explore.html"); return; }
  } catch (_) { message(T("failMeta"), "explore.html"); return; }
  const bins = meta.wavelength_bins || [];
  if (!bins.length) { message(T("noFrames")); return; }
  const X = await import("./explain.js").catch(() => null);   // the site's rules (brightness change, guards); small and cached
  const bin = bins[startBin(meta, X, parseFloat(Q.get("bin")))];
  const name = tname(meta.target || id), um = umTxt(bin.wavelength_um);
  document.title = `${name} · Fazari`;
  $("name").textContent = name;
  const kind = $("kind");
  kind.hidden = false; kind.textContent = um;
  kind.style.setProperty("--k", meta.measured && meta.measured.photometry ? "#c48bff" : "#5aa9ff");
  setOpen(`ornek.html?data=${base}&um=${bin.wavelength_um.toFixed(1)}`, T("openTip"));
  // picture geometry from meta.grid (720 x 770 PNGs with a 50 px label strip on top, 0.75″ per PNG pixel)
  const g = meta.grid || {};
  [P.W, P.H] = g.png_px || [720, 720];
  P.strip = g.label_strip_px || 0;
  P.arcsec = g.pixel_arcsec && g.upscale ? g.pixel_arcsec / g.upscale : 0;
  P.wide = !!(meta.measured && meta.measured.photometry);
  const mk = new Map((meta.markers || []).map((m) => [m.epoch, m.png_xy]));
  const pos = ((meta.measured || {}).positions || []);
  const xyOf = (ep) => mk.get(ep) || (pos.find((p) => p.epoch === ep) || {}).png_xy_gaia || null;
  const pts = [...mk.values()];
  P.centre = pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : [P.W / 2, (P.H + P.strip) / 2];
  P.ringAt = xyOf;
  const ms = meta.measured || {};
  if (ok(ms.shift_arcsec) && ms.from_epoch && ms.to_epoch) {   // the headline jump in picture pixels (measured, else the catalogue's)
    const at = (ep) => (pos.find((p) => p.epoch === ep && p.png_xy_measured) || {}).png_xy_measured || xyOf(ep);
    const a = at(ms.from_epoch), b = at(ms.to_epoch);
    P.jump = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null;
  }
  const ref = refOf(meta);
  const els = bin.frames.map((f) => {
    const im = new Image();
    im.decoding = "async"; im.draggable = false;
    im.alt = T("alt", { name, date: monthTxt(f.epoch), um });
    im.src = base + f.file;
    return im;
  });
  mountBlink(els, bin.frames.map((f) => monthTxt(f.epoch)), bin.frames.map((f) => f.epoch), name, um);
  if (ref) $("stage").title = T("ringTip", { cat: ref.short });
  const vd = $("vd");
  vd.innerHTML = verdictHtml(meta, X);
  vd.title = T("measuredTip");
  setFine([esc(T("data")), ref ? `<span title="${esc(ref.full)}">${esc(T("ring", { cat: ref.tiny }))}</span>` : ""]);
}

// ---- a free point ---------------------------------------------------------------------------------------------------
const pad = (v, n = 2) => String(v).padStart(n, "0");
function hms(ra) {
  let s = (((ra % 360) + 360) % 360) / 15 * 3600;
  s = Math.round(s * 10) / 10;
  const h = Math.floor(s / 3600) % 24, m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(1);
  return `${pad(h)}h ${pad(m)}m ${loc(x.padStart(4, "0"))}s`;
}
function dms(d) {
  const sg = d < 0 ? "−" : "+";
  let s = Math.round(Math.abs(d) * 3600);
  const D = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${sg}${pad(D)}° ${pad(m)}′ ${pad(x)}″`;
}
const degTxt = (ra, de) => loc(`${ra.toFixed(4)}°`) + (LANG === "tr" ? "; " : ", ") + loc(`${de >= 0 ? "+" : "−"}${Math.abs(de).toFixed(4)}°`);
function freePoint(ra, de) {
  ra = ((ra % 360) + 360) % 360;
  const name = T("point");
  document.title = `${name} · Fazari`;
  $("name").textContent = name;
  const kind = $("kind");
  kind.hidden = false; kind.textContent = degTxt(ra, de);
  const q = `ra=${ra.toFixed(5)}&dec=${de.toFixed(5)}`;
  setOpen(`sky.html?${q}`, T("openPoint"));
  const st = $("stage");
  // the SPHEREx all-sky map of the site (data/vr/sky_2k.jpg): equirectangular, RA 180° at the left edge, RA growing
  // to the left, Dec +90° at the top
  const x = ((180 - ra + 360) % 360) / 360 * 100, y = (90 - de) / 180 * 100;
  st.innerHTML = `<div class="sky"><div class="map"><img src="data/vr/sky_2k.jpg" alt="${esc(T("mapAlt"))}" decoding="async">` +
    `<svg viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true"></svg></div></div>` +
    `<div class="pos"><span>RA ${esc(hms(ra))}</span><span>Dec ${esc(dms(de))}</span></div>` +
    `<button type="button" class="go" id="go" title="${esc(T("quickTip"))}">${esc(T("quick"))}</button>` +
    `<div class="prog" id="prog" hidden><i></i></div>`;
  const svg = st.querySelector(".map svg");
  const cx = x, cy = y / 2;
  svg.innerHTML = `<g fill="none" stroke-linecap="round" vector-effect="non-scaling-stroke">` +
    `<line x1="${cx}" y1="${cy - 7}" x2="${cx}" y2="${cy - 2.2}" stroke="#ffc94d" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
    `<line x1="${cx}" y1="${cy + 2.2}" x2="${cx}" y2="${cy + 7}" stroke="#ffc94d" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
    `<line x1="${cx - 3.5}" y1="${cy}" x2="${cx - 1.1}" y2="${cy}" stroke="#ffc94d" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
    `<line x1="${cx + 1.1}" y1="${cy}" x2="${cx + 3.5}" y2="${cy}" stroke="#ffc94d" stroke-width="2" vector-effect="non-scaling-stroke"/></g>`;
  st.setAttribute("aria-label", T("mapAlt"));
  $("vd").innerHTML = T("pointVd");
  setFine([esc(T("map"))]);
  $("go").onclick = () => quickLook(ra, de, q);
}
/** The browser engine in a compact run: the sky index, then one quick-look stack of one wavelength (no measurement). */
async function quickLook(ra, de, q) {
  const go = $("go"), prog = $("prog"), bar = prog && prog.firstElementChild;
  go.disabled = true; go.textContent = T("quickBusy");
  prog.hidden = false;
  const step = (f) => { if (bar) bar.style.width = Math.round(100 * Math.min(1, f)) + "%"; };
  step(0.04);
  let engine = null;
  try {
    const idx = await import("./skyindex.js");
    const images = await idx.findImages(ra, de);
    if (!images || !images.length) throw Object.assign(new Error("none"), { none: true });
    step(0.1);
    const { Engine } = await import("./engine.js");
    engine = new Engine({});
    const s = await engine.init({ ra, dec: de, target: null, images, config: { cap: 2, fovDeg: 0.1 }, cacheBytes: 48 * 1024 * 1024 });
    const avail = s.bins.filter((b) => b.available);
    if (!avail.length) throw Object.assign(new Error("none"), { none: true });
    const want = parseFloat(Q.get("bin"));
    const um = (avail.find((b) => Math.abs(b.um - want) < 0.05) || avail.find((b) => b.um === 2.0) || avail[0]).um;
    step(0.15);
    const out = await engine.loadPreview(um, { perSeason: 2, total: 8, fovDeg: 0.1 }, (p) => {
      if (p && p.planned) step(0.15 + 0.85 * (p.done || 0) / p.planned);
      else if (p && ok(p.done)) step(0.15 + 0.85 * Math.min(1, (p.done || 0) / 8));
    });
    const r = out.result, n = r.n;
    if (!r.frames || r.frames.length < 2) throw Object.assign(new Error("none"), { none: true });
    const els = r.frames.map((f) => {
      const c = document.createElement("canvas");
      c.width = n; c.height = n;
      const ctx = c.getContext("2d"), id = ctx.createImageData(n, n);
      for (let k = 0; k < n * n; k++) {
        const v = Number.isFinite(f.norm[k]) ? Math.round(255 * Math.min(1, Math.max(0, f.norm[k]))) : 0;
        id.data[4 * k] = id.data[4 * k + 1] = id.data[4 * k + 2] = v; id.data[4 * k + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      c.setAttribute("role", "img");
      c.setAttribute("aria-label", T("alt", { name: T("point"), date: monthTxt(f.season), um: umTxt(um) }));
      return c;
    });
    Object.assign(P, { W: n, H: n, strip: 0, arcsec: s.pixArcsec || 3, wide: false, jump: null, centre: [(n - 1) / 2 + 0.5, (n - 1) / 2 + 0.5] });
    P.ringAt = () => [(n - 1) / 2 + 0.5, (n - 1) / 2 + 0.5];
    $("kind").textContent = `${umTxt(um)} · ${degTxt(ra, de)}`;
    mountBlink(els, r.frames.map((f) => monthTxt(f.season)), r.frames.map((f) => f.season), T("point"), umTxt(um));
    const nImg = r.frames.reduce((a, f) => a + (f.n || 0), 0);
    $("stage").title = T("ringPoint");
    $("vd").innerHTML = T("quickVd", { n: nImg });
    setFine([esc(T("data"))]);
    setOpen(`sky.html?${q}&bin=${um.toFixed(1)}`, T("openPoint"));
  } catch (e) {
    console.warn("embed: quick look", e);
    prog.hidden = true;
    go.disabled = false; go.textContent = T("quick");
    $("vd").innerHTML = e && e.none ? esc(T("quickNone")) : esc(T("quickFail", { msg: (e && e.message) || "error" }));
  } finally {
    if (engine) engine.cancel().catch(() => {});       // the frames are copied out: the worker and its cache can go
  }
}

// ---- start ----------------------------------------------------------------------------------------------------------
function boot() {
  document.documentElement.lang = LANG;
  $("msg").textContent = T("loading");
  $("open").textContent = T("open");
  setFine([esc(T("data"))]);
  const id = String(Q.get("target") || Q.get("t") || "").trim().toLowerCase();
  const ra = parseFloat(Q.get("ra")), de = parseFloat(Q.get("dec"));
  if (id && /^[\w-]+$/.test(id)) readyTarget(id).catch((e) => { console.warn("embed", e); message(T("failMeta")); });
  else if (Number.isFinite(ra) && Number.isFinite(de) && Math.abs(de) <= 90) freePoint(ra, de);
  else message(T(id ? "notFound" : "bad", { id }), "explore.html");
}
if (typeof document !== "undefined" && $("card")) boot();
