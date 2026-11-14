// Candidate finder results in the web pages: the list, rings and magnified motion arrows of
// <result>/candidates.json, written by the finder (pipeline/detect/run.py; schema "fazari-candidates/1",
// records described in pipeline/detect/schema.py, the "sensitivity" card in pipeline/detect/sensitivity.py).
// Shared by both pages; every fetch failure is quiet (no file: nothing is shown).
//
//   ornek.html    mountCandidates(v)          v = the viewer api of js/viewer.js (startViewer()):
//     #candidateList   "N moving objects found here", one entry per object that is not an artifact
//                      (class, speed ± error, PA, detectors, magnitude, brightness change), "Show rejected (N)"
//                      with the artifacts and their flags, and the sensitivity card. The list sits in the
//                      side column (moved there, before .actions, when the page has it elsewhere).
//     <svg id="candLayer">  a ring per object (one colour per class; artifacts only when shown) and, for
//                      movers, the 1-year displacement × M as an arrow labelled "×M", M picked so the arrow
//                      reaches ~40 screen px past the ring at the zoom on screen. Ticks mark each mover's
//                      measured position in the season on screen ("fazari:frame"; Blink and Step only).
//                      Hidden during "Find the mover"; ring clicks pass through while "Mark something" is on.
//     Click a ring or an entry: it is highlighted and a mini-blink opens on the image (the top or bottom
//                      corner that covers least of it): a crop of the frames around it (38 PNG px = 29″ on a
//                      desktop, 18 px on a phone) shown 8× with image-rendering: pixelated, cycling the seasons
//                      of the wavelength on screen. An entry outside the zoomed view zooms the image out
//                      (the page's own #zoom control) until it shows. Esc closes the mini-blink.
//     -> Promise<{ doc, select(id), redraw() } | null>
//   explore.html  showOnSky(state, src)       src = the blink panel's page; "ornek.html?data=<result>/" draws
//     the same rings and arrows (and the field's outline) on the Aladin sphere (state.A, state.al) with a
//     chip and key in #starTools; any other src, or a result without candidates.json, clears them.
//
//   loadCandidates(base) -> Promise<doc | null>     baseFromSrc(src) -> absolute result URL "…/" | null
//   pickMag(pxPerYear, minPx = 40) -> M (1, 2, 5, 10, 20, 50, …) | null     CLASSES, KINDS (labels, colours)
//
// Language: these are candidates for follow-up, never discoveries.

import { t, num, ptext, onLang, month } from "../js/i18n.js";
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// nature labels of the core (pipeline/detect, nature.label) + the old-core classes of the fallback rule
const LABELS = {
  "catalogued-star": "Known star", "catalogued-star-anomalous": "Known star, unusual motion",
  "nearby-star-or-brown-dwarf-candidate": "Nearby star or brown dwarf candidate",
  "distant-solar-system-candidate": "Distant Solar System candidate", "solar-system-known": "Known Solar System object",
  "solar-system-candidate": "Solar System candidate", "variable-star-candidate": "Variable star candidate",
  "transient-or-moving-candidate": "Transient or moving candidate", "single-exposure-event": "Single-exposure event",
  "artifact": "Artifact", "gaia-known": "Known star (Gaia)", "catalogue-known": "Known star (catalogue)",
};
export const natureLabel = (label) => (label ? t("ex.nat." + label, null, LABELS[label] || String(label)) : "");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const seasonText = (ep) => {
  const m = /^(\d{4})-(\d{2})/.exec(ep || "");
  if (!(m && +m[2] >= 1 && +m[2] <= 12)) return String(ep || "");
  try { return month(`${m[1]}-${m[2]}`); } catch (_) { return `${MON[+m[2] - 1]} ${m[1]}`; }
};
const reduceMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };

/** One colour per class (dark backgrounds; apart from the viewer's orange ring, white arrow and blue marks). */
export const CLASSES = {
  "candidate": { label: "Candidate", color: "#ff5ccf" },
  "gaia-known": { label: "Known (Gaia)", color: "#a3e635" },
  "variable": { label: "Variable candidate", color: "#ffd23f" },
  "asteroid-known": { label: "Known asteroid", color: "#c4a1ff" },
  "artifact": { label: "Rejected", color: "#8b95a8" },
};
export const KINDS = { motion: "moving", appearing: "appears", disappearing: "disappears", variable: "brightness change", transient: "transient" };
const cls = (c) => CLASSES[c && c.class] || CLASSES.candidate;
// UI text (en.json / tr.json "ex.cz.*"; the English here is the fallback)
const CZ = (k, p, f) => t("ex.cz." + k, p, f);
export const clsLabel = (k) => CZ("cls." + k, null, (CLASSES[k] || CLASSES.candidate).label);
// hover hint on an unconfirmed candidate's label: a mark to check, not a find (" title=…" or "")
const clsHint = (c) => (c && c.confirmed !== true && (!CLASSES[c.class] || c.class === "candidate" || c.class === "variable")
  ? ` title="${esc(t("ts.cz.hint", null, "This is not a discovery; it is a mark that needs checking."))}"` : "");
const kindText = (k) => (k ? CZ("kind." + k, null, KINDS[k] || k) : "");
const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
const MIN_ARROW_PX = 40;

/** Smallest "nice" magnification M that makes a pxPerYear-long 1-year arrow at least minPx long. */
export function pickMag(pxPerYear, minPx = MIN_ARROW_PX) {
  if (!(pxPerYear > 0)) return null;
  return NICE.find((m) => pxPerYear * m >= minPx) || NICE[NICE.length - 1];
}

/** <base>candidates.json, or null (missing file, HTTP error, bad JSON). Never throws. */
export async function loadCandidates(base) {
  if (/^(\.\/)?data\//.test(String(base))) return null;   // static target folders (data/<target>/) have no candidates.json: no 404
  try {
    const r = await fetch(base + "candidates.json", { cache: "no-cache" });
    if (!r.ok) return null;
    const d = await r.json();
    return d && Array.isArray(d.candidates) ? d : null;
  } catch (_) { return null; }
}
async function loadJson(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch (_) { return null; }
}

/** The result folder of a blink panel page: "ornek.html?data=<folder>" (or ?t=<target>) -> absolute URL "…/". */
export function baseFromSrc(src) {
  try {
    const u = new URL(String(src || ""), location.href);
    if (!/(^|\/)ornek\.html$/.test(u.pathname)) return null;
    let d = u.searchParams.get("data");
    const t = u.searchParams.get("t") || u.searchParams.get("target");
    if (!d && t && /^[\w-]+$/.test(t)) d = `data/${t}/`;
    if (!d) return null;
    return new URL(/\/$/.test(d) ? d : d + "/", u).href;
  } catch (_) { return null; }
}

// --- text pieces shared by the list and the sky key -------------------------------------------------
const dec2 = (v) => (Math.abs(v) >= 10 ? 1 : 2);
function speedText(m) {
  if (!m || !ok(m.speed_arcsec_yr)) return "";
  const s = +m.speed_arcsec_yr, d = dec2(s);
  return num(+s.toFixed(d), d) + (ok(m.err_speed_arcsec_yr) ? ` ± ${num(+(+m.err_speed_arcsec_yr).toFixed(d), d)}` : "") + CZ("perYr", null, "″/yr");
}
function paText(m) {
  if (!m || !ok(m.pa_deg)) return "";
  return `PA ${Math.round(+m.pa_deg)}°${ok(m.err_pa_deg) ? ` ± ${Math.round(+m.err_pa_deg)}°` : ""}`;
}
function changeText(c) {
  const b = c && c.brightness;
  if (!b) return "";
  const sig = ok(b.max_sigma) ? ` (${Math.abs(+b.max_sigma).toFixed(1)}σ)` : "";
  if (ok(b.max_change_frac)) {
    const p = Math.round(100 * +b.max_change_frac);
    return CZ("brightPct", { p: `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}`, sig }, "{p} % brightness{sig}");
  }
  return ok(b.max_sigma) ? (+b.max_sigma > 0 ? CZ("rise", { sig }, "brightness rise{sig}") : CZ("drop", { sig }, "brightness drop{sig}")) : "";
}
const isMover = (c) => !!(c && c.motion && ok(c.motion.pmra_mas_yr) && ok(c.motion.pmdec_mas_yr) && Math.hypot(+c.motion.pmra_mas_yr, +c.motion.pmdec_mas_yr) > 0);
function movingCount(doc) {
  const s = doc.summary || {};
  if (ok(s.n_moving)) return +s.n_moving;
  return doc.candidates.filter((c) => c.kind === "motion" && (c.class === "candidate" || c.class === "gaia-known")).length;
}
const headingText = (n) => (n === 1 ? CZ("head.one", { n }, "1 moving object found here") : CZ("head.other", { n }, "{n} moving objects found here"));
const headingShort = (n) => (n === 1 ? CZ("short.one", { n }, "1 moving object") : CZ("short.other", { n }, "{n} moving objects"));

// =====================================================================================================
// ornek.html: list, image layer, mini-blink
// =====================================================================================================
const CSS = `
.side > #candidateList { margin-top:0; }
#candidateList .cz { display:flex; flex-direction:column; gap:8px; }
.cz h2 { font-size:1.02rem; margin:0; }
.cz .cz-sum { margin:0; font-size:.82rem; color:var(--mut, #9aa3b2); line-height:1.35; }
.cz .cz-note { margin:0; font-size:.78rem; color:#7f8aa0; }
.cz .cz-bar { display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; font-size:.85rem; }
.cz .cz-bar label { display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:var(--mut, #9aa3b2); }
.cz .cz-bar input { accent-color:#ff5ccf; width:15px; height:15px; }
.cz .cz-bar button { font-size:.82rem; padding:3px 10px; }
.cz .cz-bar button[aria-pressed="true"] { background:#2f3a55; border-color:#55607a; }
.cz ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; max-height:80vh; overflow-y:auto; overscroll-behavior:contain; }
.cz ul.cz-rej { max-height:60vh; }
.cz ul[hidden] { display:none; }
.cz li { flex:none; }
.cz li > button { width:100%; text-align:left; display:block; padding:7px 9px; background:var(--card2, #1b2131); border:1px solid transparent;
  border-left:4px solid var(--cz); border-radius:8px; color:var(--fg, #e8eaf0); font:inherit; cursor:pointer; }
.cz li > button:hover { border-color:#3a4560; border-left-color:var(--cz); }
.cz li > button.on { border-color:var(--cz); background:#232a3d; box-shadow:0 0 0 1px var(--cz) inset; }
.cz .cz-l1 { display:flex; align-items:baseline; gap:8px; font-size:.9rem; }
.cz .cz-l1 b { color:var(--cz); font-weight:700; }
.cz .cz-l1 .cz-id { font-variant-numeric:tabular-nums; color:var(--mut, #9aa3b2); font-size:.8rem; }
.cz .cz-l1 .cz-mag { margin-left:auto; font-size:.8rem; color:var(--mut, #9aa3b2); white-space:nowrap; font-variant-numeric:tabular-nums; }
.cz .cz-l2 { display:block; font-size:.95rem; font-weight:600; font-variant-numeric:tabular-nums; margin-top:1px; }
.cz .cz-l3 { display:block; font-size:.78rem; color:var(--mut, #9aa3b2); margin-top:2px; line-height:1.35; }
.cz .cz-l3 abbr { text-decoration:none; border-bottom:1px dotted #55607a; cursor:help; }
.cz .cz-flags { display:block; font-size:.76rem; color:#c9b27a; margin-top:2px; line-height:1.3; }
.cz .cz-nat, .cz .cz-conf { display:block; font-size:.8rem; color:#d5dbea; margin-top:3px; line-height:1.35; }
.cz .cz-ok { color:#7ee2a8; font-weight:600; }
.cz .cz-chk { display:flex; flex-direction:column; gap:1px; font-size:.74rem; color:var(--mut, #9aa3b2); margin-top:3px; }
.cz .cz-chk .pass { color:#7ee2a8; } .cz .cz-chk .fail { color:#d9a6a6; }
.cz .cz-rej li > button { opacity:.88; }
.cz .cz-rej .cz-flags { color:#d9a6a6; }
.cz .cz-empty { font-size:.85rem; color:var(--mut, #9aa3b2); margin:0; }
.cz .cz-key { display:flex; flex-wrap:wrap; gap:2px 12px; font-size:.78rem; color:var(--mut, #9aa3b2); }
.cz .cz-key span { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
.cz .cz-key i { width:11px; height:11px; border-radius:50%; border:2px solid var(--cz); display:inline-block; }
.cz .cz-key i.dash { border-style:dashed; }
#czMini { position:absolute; top:10px; right:10px; z-index:12; display:flex; flex-direction:column; gap:5px; padding:6px;
  background:rgba(8,10,16,.94); border:1px solid var(--cz, #3a4560); border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,.55); }
#czMini.left { right:auto; left:10px; }
#czMini.bottom { top:auto; bottom:46px; }
#czMini[hidden], .stage.game #czMini { display:none; }
#czMini .cz-mini-h { display:flex; align-items:center; gap:6px; font-size:.82rem; line-height:1.2; min-width:0; }
#czMini .cz-mini-h b { color:var(--cz); }
#czMini .cz-mini-h span { color:var(--mut, #9aa3b2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
#czMini .cz-mini-h button { flex:none; padding:1px 8px; font-size:.78rem; border-radius:6px; }
#czMini .cz-mini-h button:first-of-type { margin-left:auto; }
#czMini canvas { display:block; image-rendering:pixelated; image-rendering:crisp-edges; background:#000; border-radius:6px; }
#czMini small { font-size:.72rem; color:var(--mut, #9aa3b2); text-align:center; line-height:1.2; }
@media (max-width: 560px) { #czMini { top:6px; right:6px; padding:4px; } #czMini.left { left:6px; } #czMini small { display:none; } }
.cz details { font-size:.82rem; }
.cz details summary { margin:0; }
.cz .cz-sens { border-top:1px solid var(--line, #2a3246); padding-top:8px; }
.cz .cz-sens h3 { font-size:.85rem; margin:0 0 3px; color:var(--fg, #e8eaf0); }
.cz .cz-sens p { margin:0 0 4px; font-size:.8rem; color:var(--mut, #9aa3b2); line-height:1.35; }
.cz .cz-sens table { font-size:.76rem; margin-top:4px; }
.cz .cz-sens td, .cz .cz-sens th { padding:2px 5px; text-align:right; font-variant-numeric:tabular-nums; }
.cz .cz-sens th { color:var(--mut, #9aa3b2); font-weight:600; }
.cz .cz-sens td:first-child, .cz .cz-sens th:first-child { text-align:left; }
#candLayer .cz-hit { fill:transparent; stroke:none; pointer-events:all; cursor:pointer; }
.stage.game #candLayer { display:none; }
.stage.fzm-on #candLayer .cz-hit, #candLayer.cz-off .cz-hit { pointer-events:none; }
`;

const MINI_X = 8;         // mini-blink: a crop of the frames shown 8x (38 PNG px = 29″ on a desktop, less on a phone)
const MINI_MS = 700;

/** ornek.html plug-in: v = startViewer() api. Resolves null (and shows nothing) without candidates.json. */
export async function mountCandidates(v) {
  if (!v || !v.meta) return null;
  const doc = await loadCandidates(v.base);
  const box = document.getElementById("candidateList"), layer = document.getElementById("candLayer");
  if (!doc || !box) return null;
  if (box.__cz) return box.__cz;                         // once per page
  const meta = v.meta, grid = meta.grid || {};
  const [W, H] = grid.png_px || [720, 720];
  const L = +grid.label_strip_px || 0;
  const pngArcsec = grid.pixel_arcsec > 0 && grid.upscale > 0 ? grid.pixel_arcsec / grid.upscale : null;
  const zoomer = document.getElementById("zoomer"), stage = document.getElementById("stage");
  if (!document.getElementById("cz-style")) {
    const st = document.createElement("style"); st.id = "cz-style"; st.textContent = CSS; document.head.appendChild(st);
  }
  // records without png_xy (older files): place them from RA/Dec with the frame grid
  const all = doc.candidates.filter((c) => c && typeof c === "object");
  if (all.some((c) => !Array.isArray(c.png_xy) && ok(c.ra) && ok(c.dec))) {
    try {
      const { gridOf } = await import("../js/marking.js");
      const g = gridOf(meta);
      if (g) all.forEach((c) => { if (!Array.isArray(c.png_xy) && ok(c.ra) && ok(c.dec)) c.png_xy = g.toPng(+c.ra, +c.dec); });
    } catch (_) {}
  }
  const inside = (xy) => Array.isArray(xy) && ok(xy[0]) && ok(xy[1]) && xy[0] >= 0 && xy[0] <= W && xy[1] >= L && xy[1] <= H;
  const shown = all.filter((c) => c.class !== "artifact");
  const rejected = all.filter((c) => c.class === "artifact");
  const S = { sel: null, rejected: false, rings: true, frame: null, mini: null };

  // the list goes into the side column, next to the image (the page keeps its own place when it has none)
  const side = document.querySelector(".viewer .side");
  if (side && !side.contains(box)) side.insertBefore(box, side.querySelector(":scope > .actions") || null);

  // 1-year displacement in PNG px: from the proper motion on a north-up east-left grid, else a straight
  // line through the per-season PNG positions
  function perYear(c) {
    if (!isMover(c)) return null;
    if (pngArcsec && grid.north_up_east_left !== false) {
      return [-(+c.motion.pmra_mas_yr) / 1000 / pngArcsec, -(+c.motion.pmdec_mas_yr) / 1000 / pngArcsec];
    }
    const p = (c.positions || []).filter((q) => Array.isArray(q.png_xy) && ok(q.jyear));
    if (p.length < 2) return null;
    const tm = p.reduce((a, q) => a + +q.jyear, 0) / p.length;
    const st = p.reduce((a, q) => a + (q.jyear - tm) ** 2, 0);
    if (!(st > 0)) return null;
    return [0, 1].map((k) => p.reduce((a, q) => a + (q.jyear - tm) * q.png_xy[k], 0) / st);
  }
  const zoomK = () => {                       // screen px per PNG px (the zoom box: translate(..) scale(k))
    const m = /scale\(([\d.eE+-]+)\)/.exec((zoomer && zoomer.style.transform) || "");
    if (m && +m[1] > 0) return +m[1];
    const r = zoomer && zoomer.getBoundingClientRect();
    return r && r.width ? r.width / W : 1;
  };

  const ringR = (k) => Math.max(13 / k, 10);              // ring radius (PNG px): 13 screen px, at least ~7.5″ (PSF core)
  /** The magnified 1-year arrow in PNG px: { M, ux, uy, len, tip, label } | null (k: screen px per PNG px). */
  function arrowOf(c, k, R) {
    const py = perYear(c);
    if (!py) return null;
    const L1 = Math.hypot(py[0], py[1]), M = pickMag(L1 * k, R * k + MIN_ARROW_PX);        // reaches past the ring
    if (!M) return null;
    const ux = py[0] / L1, uy = py[1] / L1, [x, y] = c.png_xy;
    const tip = [x + py[0] * M, y + py[1] * M];
    return { M, ux, uy, len: L1 * M, tip, label: [tip[0] + ux * 13 / k, tip[1] + uy * 13 / k] };
  }

  // --- the list -------------------------------------------------------------------------------------
  const detName = (k) => ((doc.detectors || {})[k] || {}).name || "";
  function entry(c) {
    const k = cls(c), m = c.motion;
    const l2 = [];
    if (isMover(c)) l2.push(esc(speedText(m)), esc(paText(m)));
    const ch = changeText(c);
    if (ch) l2.push(esc(ch));
    if (!l2.length) {                                   // appears / disappears / transient: where and when
      const fc = (c.flux_changes || [])[0] || {}, sp = (c.season_pairs || [])[0] || [];
      const unit = fc.unit || (c.bins || [])[0], from = fc.from || sp[0], to = fc.to || sp[1];
      l2.push(esc([kindText(c.kind), unit ? CZ("at", { u: unit }, "at {u}") : "", from && to ? `${seasonText(from)} → ${seasonText(to)}` : ""].filter(Boolean).join(" ")));
    }
    const l3 = [];
    const dets = (c.detectors || []).map((d) => `<abbr title="${esc(d + ": " + detName(d))}">${esc(d)}</abbr>`).join(" ");
    if (dets) l3.push(((c.detectors || []).length > 1 ? CZ("dets", null, "detectors") : CZ("det", null, "detector")) + " " + dets);
    if (m && ok(m.significance_sigma)) l3.push(`${num(+m.significance_sigma, 1)}σ`);
    const g = (c.match || {}).gaia_dr3;
    if (g && ok(g.G)) l3.push(`Gaia G ${num(+g.G, 1)}` + (ok(g.sep_arcsec) ? ", " + CZ("away", { d: num(+g.sep_arcsec, 1) }, "{d}″ away") : ""));
    const sso = (c.match || {}).sso;
    if (sso && (sso.name || sso.designation)) l3.push(esc(sso.name || sso.designation));
    if (!inside(c.png_xy)) l3.push(esc(CZ("outside", null, "outside the image")));
    const flags = (c.flags || []).filter(Boolean);
    const mag = ok(c.mag_ab) ? `AB ${num(+c.mag_ab, 1)}` : "";
    // core v1 fields (null-safe: older files have none of them)
    const nat = c.nature || {}, conf = c.confidence || {}, cf = c.confirmation || {};
    const natLine = nat.text || nat.label ? `<span class="cz-nat">${nat.label ? `<b>${esc(natureLabel(nat.label))}</b>${nat.text ? ": " : ""}` : ""}${esc(nat.text || "")}</span>` : "";
    const confLine = ok(conf.percent) || conf.sentence ? `<span class="cz-conf">` +
      (c.confirmed === true ? `<span class="cz-ok">${esc(t("ex.cz.confirmed", null, "Confirmed"))}</span> · ` : "") +
      (ok(conf.percent) ? `${esc(t("ex.fd.pct", { p: num(+conf.percent) }, `${conf.percent}% confidence`))}${conf.sentence ? " · " : ""}` : "") +
      `${esc(conf.sentence || "")}</span>` : c.confirmed === true ? `<span class="cz-conf cz-ok">${esc(t("ex.cz.confirmed", null, "Confirmed"))}</span>` : "";
    const checks = Array.isArray(cf.checks) ? cf.checks.filter((x) => x && x.name) : [];
    const chk = checks.length ? `<span class="cz-chk" aria-label="${esc(t("ex.cz.checks", null, "Confirmation checks"))}">` + checks.map((x) =>
      `<span class="${x.pass ? "pass" : "fail"}">${x.pass ? "✓" : "✗"} ${esc(x.name)}${ok(x.value) ? ` ${esc(num(+x.value))}` : ""}` +
      `${ok(x.need) ? ` (≥ ${esc(num(+x.need))})` : x.need != null && typeof x.need !== "object" ? ` (${esc(x.need)})` : ""}</span>`).join("") +
      (cf.sentence ? `<span>${esc(cf.sentence)}</span>` : "") + `</span>` : "";
    return `<li><button type="button" data-cid="${esc(c.id)}" style="--cz:${k.color}" aria-pressed="false">` +
      `<span class="cz-l1"><b${clsHint(c)}>${esc(clsLabel(c.class))}</b><span class="cz-id">${esc(c.id)} · ${esc(kindText(c.kind))}</span>` +
      (mag ? `<span class="cz-mag">${mag}</span>` : "") + `</span>` +
      `<span class="cz-l2">${l2.filter(Boolean).join(" · ")}</span>` +
      (l3.length ? `<span class="cz-l3">${l3.join(" · ")}</span>` : "") + natLine + confLine + chk +
      (flags.length ? `<span class="cz-flags">${flags.map(esc).join("; ")}</span>` : "") +
      `</button></li>`;
  }
  function sensHtml() {
    const s = doc.sensitivity;
    if (!s || typeof s !== "object") return "";
    if (s.error || !(s.text || (s.motion || []).length || (s.brightness || []).length)) {
      return `<section class="cz-sens"><p>${esc(CZ("sens.none", null, "What this field can detect: no estimate for this result."))}</p></section>`;
    }
    const mo = Array.isArray(s.motion) ? s.motion : [], br = Array.isArray(s.brightness) ? s.brightness : [];
    const mags = [...new Set([...mo, ...br].map((r) => r && r.mag_ab).filter(ok).map(Number))].sort((a, b) => a - b);
    let table = "";
    if (mags.length) {
      const rowM = (mg) => mo.find((r) => +r.mag_ab === mg) || {}, rowB = (mg) => br.find((r) => +r.mag_ab === mg) || {};
      table = `<div class="tw"><table><thead><tr><th>AB mag</th>${mo.length ? `<th title="${esc(CZ("th.snrT", null, "Signal to noise of one season"))}">S/N</th>` +
        `<th title="${esc(CZ("th.pmT", null, "Error of the proper motion"))}">${esc(CZ("th.pm", null, "motion error"))}</th><th title="${esc(CZ("th.slowT", null, "Slowest motion found at this brightness (injection tests)"))}">${esc(CZ("th.slow", null, "slowest motion"))}</th>` : ""}` +
        `${br.length ? `<th title="${esc(CZ("th.chT", null, "Smallest brightness change found at this brightness"))}">${esc(CZ("th.ch", null, "smallest change"))}</th>` : ""}</tr></thead><tbody>` +
        mags.map((mg) => {
          const a = rowM(mg), b = rowB(mg);
          return `<tr><td>${mg}</td>` + (mo.length ? `<td>${ok(a.season_snr) ? Math.round(+a.season_snr) : "–"}</td>` +
            `<td>${ok(a.pm_err_arcsec_yr) ? num(+a.pm_err_arcsec_yr, 2) + CZ("perYr", null, "″/yr") : "–"}</td>` +
            `<td>${ok(a.min_speed_arcsec_yr) ? num(+a.min_speed_arcsec_yr, 2) + CZ("perYr", null, "″/yr") : "–"}</td>` : "") +
            (br.length ? `<td>${ok(b.min_change_frac) ? Math.round(100 * +b.min_change_frac) + " %" + (b.detector ? ` <small>${esc(b.detector)}</small>` : "") : "–"}</td>` : "") + `</tr>`;
        }).join("") + `</tbody></table></div>`;
    }
    const dep = s.diff_depth_ab_5sigma && typeof s.diff_depth_ab_5sigma === "object" ? Object.entries(s.diff_depth_ab_5sigma).filter(([, x]) => ok(x)) : [];
    const depth = dep.length ? `<p>${esc(CZ("depth", null, "Difference images (fast movers), 5σ depth:"))} ${dep.map(([u, x]) => `${esc(u)} AB ${num(+x, 1)}`).join(", ")}.</p>` : "";
    const facts = [ok(s.n_seasons) ? CZ("nSeasons", { n: s.n_seasons }, "{n} seasons") : "", ok(s.span_yr) ? CZ("nYr", { n: num(+s.span_yr, 2) }, "{n} yr") : "",
      ok(s.n_exposures) ? CZ("nExp", { n: s.n_exposures }, "{n} exposures") : ""].filter(Boolean).join(" · ");
    return `<section class="cz-sens"><h3>${esc(CZ("sens.h", null, "What this field can detect"))}</h3>` + (s.text ? `<p>${esc(ptext(String(s.text)).replace(/>=/g, "≥"))}</p>` : facts ? `<p>${esc(facts)}</p>` : "") +
      (table || depth ? `<details><summary>${esc(CZ("sens.lim", null, "Limits by brightness"))}</summary>${table}${depth}</details>` : "") + `</section>`;
  }
  const n = movingCount(doc);
  // the summary sentence without its first words (the heading says them)
  let sumText = String((doc.summary || {}).text || "").replace(/^\s*\d+ moving object\(s\) found here:\s*/i, "");
  sumText = sumText.charAt(0).toUpperCase() + sumText.slice(1);
  const rejTxt = () => (S.rejected ? CZ("rejHide", { n: rejected.length }, "Hide rejected ({n})") : CZ("rejShow", { n: rejected.length }, "Show rejected ({n})"));
  const keyClasses = Object.keys(CLASSES).filter((k) => k !== "artifact" && all.some((c) => c.class === k));
  const paintCard = () => {
    box.innerHTML = `<div class="card cz" data-fz-candidates>` +
    `<h2>${esc((doc.verdict && doc.verdict.text && ptext(doc.verdict.text)) || headingText(n))}</h2>` +
    (sumText ? `<p class="cz-sum">${esc(ptext(sumText))}</p>` : "") +
    `<p class="cz-note">${esc(CZ("note", null, "Candidates for follow-up, not discoveries."))} ${esc(CZ("arrows", null, "Arrows: 1-year motion, magnified ×M."))}</p>` +
    (shown.length ? `<ul class="cz-list">${shown.map(entry).join("")}</ul>` : `<p class="cz-empty">${esc(CZ("empty", null, "Nothing but rejected detections in this field."))}</p>`) +
    `<div class="cz-bar"><label><input type="checkbox" id="czRings"${S.rings ? " checked" : ""}> ${esc(CZ("rings", null, "Rings on the image"))}</label>` +
    (rejected.length ? `<button type="button" id="czRej" aria-pressed="${S.rejected}">${esc(rejTxt())}</button>` : "") + `</div>` +
    `<ul class="cz-list cz-rej" id="czRejList"${S.rejected ? "" : " hidden"}>${rejected.map(entry).join("")}</ul>` +
    `<p class="cz-key">${keyClasses.concat(rejected.length ? ["artifact"] : []).map((k) =>
      `<span style="--cz:${CLASSES[k].color}"><i${k === "artifact" ? ` class="dash"` : ""}></i>${esc(clsLabel(k))}</span>`).join("")}</p>` +
    sensHtml() + `</div>`;
    bindCard();
  };

  const $ = (id) => document.getElementById(id);
  box.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-cid]");
    if (b && box.contains(b)) select(b.dataset.cid === S.sel ? null : b.dataset.cid, true);
  });
  function bindCard() {
    $("czRings").onchange = (e) => { S.rings = e.target.checked; draw(); };
    if ($("czRej")) $("czRej").onclick = () => {
      S.rejected = !S.rejected;
      $("czRej").setAttribute("aria-pressed", String(S.rejected));
      $("czRej").textContent = rejTxt();
      $("czRejList").hidden = !S.rejected;
      if (!S.rejected && S.sel && (all.find((c) => c.id === S.sel) || {}).class === "artifact") select(null);
      else draw();
    };
    box.querySelectorAll("button[data-cid]").forEach((b) => {
      const on = b.dataset.cid === S.sel;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
  paintCard();
  try { onLang(() => { try { paintCard(); } catch (e) { console.warn("candidates: language switch", e); } }); } catch (_) {}

  // --- the image layer ----------------------------------------------------------------------------------
  const drawn = () => all.filter((c) => inside(c.png_xy) && (c.class !== "artifact" || S.rejected || c.id === S.sel));
  function ringsSvg() {
    const k = zoomK(), u = 1 / k;
    const R = ringR(k);
    const f1 = (x) => (+x).toFixed(1), f2 = (x) => (+x).toFixed(2);
    let s = "", hits = "";
    for (const c of drawn()) {
      const col = cls(c).color, [x, y] = c.png_xy, on = c.id === S.sel, art = c.class === "artifact";
      const sw = (on ? 3.2 : 2.2) * u, dash = art ? ` stroke-dasharray="${f2(4 * u)} ${f2(3 * u)}"` : "";
      if (on) s += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f2(R + 5 * u)}" fill="none" stroke="#ffffff" stroke-width="${f2(1.6 * u)}" stroke-opacity=".9"/>`;
      s += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f2(R)}" fill="none" stroke="#05070d" stroke-opacity=".75" stroke-width="${f2(sw + 2.6 * u)}"/>` +
        `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f2(R)}" fill="none" stroke="${col}" stroke-width="${f2(sw)}"${dash}/>`;
      if (c.class === "candidate") {                      // a candidate also gets four ticks
        const a = R + 2 * u, b = R + 7 * u;
        const d = `M${f1(x - b)} ${f1(y)}H${f1(x - a)}M${f1(x + a)} ${f1(y)}H${f1(x + b)}M${f1(x)} ${f1(y - b)}V${f1(y - a)}M${f1(x)} ${f1(y + a)}V${f1(y + b)}`;
        s += `<path d="${d}" stroke="#05070d" stroke-opacity=".75" stroke-width="${f2(4.4 * u)}"/><path d="${d}" stroke="${col}" stroke-width="${f2(2 * u)}"/>`;
      }
      const ar = arrowOf(c, k, R);
      if (ar) {
        const { M, ux, uy, len } = ar, [x1, y1] = ar.tip;
        const x0 = x + ux * Math.min(R, len * 0.5), y0 = y + uy * Math.min(R, len * 0.5);
        const hl = Math.min(10 * u, len * 0.5), hw = 5 * u, bx = x1 - ux * hl, by = y1 - uy * hl;
        const line = `M${f2(x0)} ${f2(y0)}L${f2(bx)} ${f2(by)}`;
        const head = `M${f2(x1)} ${f2(y1)}L${f2(bx - uy * hw)} ${f2(by + ux * hw)}L${f2(bx + uy * hw)} ${f2(by - ux * hw)}Z`;
        s += `<path d="${line}" stroke="#05070d" stroke-opacity=".8" stroke-width="${f2(5.5 * u)}" stroke-linecap="round"/>` +
          `<path d="${head}" fill="#05070d" fill-opacity=".8" stroke="#05070d" stroke-opacity=".8" stroke-width="${f2(2.5 * u)}" stroke-linejoin="round"/>` +
          `<path d="${line}" stroke="${col}" stroke-width="${f2(2.2 * u)}" stroke-linecap="round"${dash}/><path d="${head}" fill="${col}"/>`;
        const [tx, ty] = ar.label;
        s += `<text x="${f1(tx)}" y="${f1(ty)}" fill="${col}" font-size="${f2(12 * u)}" font-weight="700" text-anchor="middle" dominant-baseline="middle" ` +
          `stroke="#05070d" stroke-width="${f2(3 * u)}" paint-order="stroke" font-family="system-ui, sans-serif">×${M}</text>`;
      }
      if (!art || on) {
        s += `<text x="${f1(x + R * 0.75 + 3 * u)}" y="${f1(y - R * 0.75 - 3 * u)}" fill="${col}" font-size="${f2(11 * u)}" font-weight="700" ` +
          `stroke="#05070d" stroke-width="${f2(3 * u)}" paint-order="stroke" font-family="system-ui, sans-serif">${esc(c.id)}</text>`;
      }
      hits += `<circle class="cz-hit" data-cid="${esc(c.id)}" cx="${f1(x)}" cy="${f1(y)}" r="${f2(R + 6 * u)}"/>`;
    }
    return s + `<g class="cz-season"></g>` + hits;
  }
  function seasonTicks() {
    const g = layer && layer.querySelector(".cz-season");
    if (!g) return;
    const f = S.frame;
    if (!f || !f.epoch || (f.mode && f.mode !== "blink" && f.mode !== "step")) { g.innerHTML = ""; return; }
    const u = 1 / zoomK();
    let s = "";
    for (const c of drawn()) {
      if (!isMover(c)) continue;
      const p = (c.positions || []).find((q) => q.season === f.epoch && Array.isArray(q.png_xy));
      if (!p || !inside(p.png_xy)) continue;
      const [x, y] = p.png_xy, a = 3 * u, b = 7.5 * u, col = cls(c).color;
      const d = `M${(x - b).toFixed(2)} ${y}H${(x - a).toFixed(2)}M${(x + a).toFixed(2)} ${y}H${(x + b).toFixed(2)}M${x} ${(y - b).toFixed(2)}V${(y - a).toFixed(2)}M${x} ${(y + a).toFixed(2)}V${(y + b).toFixed(2)}`;
      s += `<path d="${d}" stroke="#05070d" stroke-opacity=".8" stroke-width="${(3.6 * u).toFixed(2)}"/><path d="${d}" stroke="${col}" stroke-width="${(1.6 * u).toFixed(2)}"/>`;
    }
    g.innerHTML = s;
  }
  function draw() {
    if (!layer) return;
    layer.setAttribute("viewBox", `0 0 ${W} ${H}`);
    layer.classList.toggle("cz-off", !S.rings);
    layer.innerHTML = S.rings ? ringsSvg() : "";
    seasonTicks();
    placeMini();
  }
  if (layer) {
    layer.addEventListener("click", (e) => {
      const h = e.target.closest && e.target.closest(".cz-hit");
      if (!h) return;
      e.stopPropagation();
      select(h.dataset.cid === S.sel ? null : h.dataset.cid);
    });
    layer.addEventListener("pointerdown", (e) => { if (e.target.closest && e.target.closest(".cz-hit")) e.stopPropagation(); });
  }
  let raf = 0;
  const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  if (zoomer) try { new MutationObserver(later).observe(zoomer, { attributes: true, attributeFilter: ["style"] }); } catch (_) {}
  window.addEventListener("resize", later);
  document.addEventListener("fazari:frame", (e) => {
    const d = (e && e.detail) || {};
    const binChanged = S.frame && Math.abs((S.frame.bin_um || 0) - (d.bin_um || 0)) > 0.01;
    S.frame = d;
    seasonTicks();
    if (binChanged && S.mini) startMini();
  });
  try { const cur = v.current(); if (cur && cur.frame) S.frame = { epoch: cur.frame.epoch, bin_um: cur.bin_um, file: cur.frame.file, mode: "blink" }; } catch (_) {}

  // --- selection and the 8x mini-blink ------------------------------------------------------------------
  // the zoom box placement: translate(tx, ty) scale(k), set by the viewer
  const place = () => {
    const m = /translate\(\s*([\d.eE+-]+)px,\s*([\d.eE+-]+)px\)/.exec((zoomer && zoomer.style.transform) || "");
    return { tx: m ? +m[1] : 0, ty: m ? +m[2] : 0, k: zoomK() };
  };
  const onScreen = (c, pad = 24) => {
    if (!stage || !inside(c.png_xy)) return false;
    const { tx, ty, k } = place(), X = tx + c.png_xy[0] * k, Y = ty + c.png_xy[1] * k;
    return X >= pad && X <= stage.clientWidth - pad && Y >= pad && Y <= stage.clientHeight - pad;
  };
  /** A list pick outside the zoomed view: step the page's own zoom control out until it shows. */
  function showOnImage(c) {
    const z = document.getElementById("zoom");
    if (!z || !inside(c.png_xy) || onScreen(c)) return;
    const levels = [...z.options].map((o) => +o.value).filter((x) => x < +z.value).sort((p, q) => q - p);
    for (const lv of levels) {
      z.value = String(lv);
      z.dispatchEvent(new Event("change"));
      if (onScreen(c)) break;
    }
  }
  function select(id, fromList) {
    const c = id ? all.find((q) => q.id === id) : null;
    S.sel = c ? c.id : null;
    if (c && c.class === "artifact" && !S.rejected && $("czRej")) $("czRej").click();
    box.querySelectorAll("button[data-cid]").forEach((b) => {
      const on = b.dataset.cid === S.sel;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (c && fromList) showOnImage(c);
    if (c && inside(c.png_xy)) openMini(c); else closeMini();
    draw();
  }
  const imgs = new Map();
  const imgFor = (file) => {
    const url = v.base + file;
    let im = imgs.get(url);
    if (!im) { im = new Image(); im.decoding = "async"; im.src = url; imgs.set(url, im); }
    return im;
  };
  function binFrames() {
    const bins = meta.wavelength_bins || [];
    let um = S.frame && ok(S.frame.bin_um) ? +S.frame.bin_um : null;
    if (um == null) try { um = +v.current().bin_um; } catch (_) {}
    const b = bins.find((x) => Math.abs(x.wavelength_um - um) < 0.05) || bins[0];
    return b ? { um: b.wavelength_um, frames: (b.frames || []).filter((f) => f && f.file) } : { um: null, frames: [] };
  }
  // the mini-blink is a small box on the image, in the top corner away from the object
  let mini = null;
  if (stage) {
    mini = document.createElement("div");
    mini.id = "czMini"; mini.hidden = true;
    mini.setAttribute("role", "group");
    for (const t of ["pointerdown", "click", "dblclick"]) mini.addEventListener(t, (e) => e.stopPropagation());
    stage.appendChild(mini);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.mini) select(null); });
  }
  /** Put the box in the corner that covers least of the picked object (its ring, arrow and label). */
  function placeMini() {
    if (!mini || !S.mini || !stage) return;
    const c = S.mini.c, { tx, ty, k } = place(), R = ringR(k);
    const pts = [c.png_xy];
    const a = arrowOf(c, k, R);
    if (a) pts.push(a.tip, a.label);
    const xs = pts.map((p) => tx + p[0] * k), ys = pts.map((p) => ty + p[1] * k), pad = R * k + 18;
    const obj = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    const Sw = stage.clientWidth, Sh = stage.clientHeight, w = mini.offsetWidth || 320, h = mini.offsetHeight || 360;
    const m = Sw < 560 ? 6 : 10, bot = 46;
    const corners = [["", Sw - m - w, m], ["left", m, m], ["bottom", Sw - m - w, Sh - bot - h], ["left bottom", m, Sh - bot - h]];
    const cover = ([, x, y]) => Math.max(0, Math.min(x + w, obj[2]) - Math.max(x, obj[0])) * Math.max(0, Math.min(y + h, obj[3]) - Math.max(y, obj[1]));
    let best = corners[0], bc = cover(best);
    for (const q of corners.slice(1)) { const v = cover(q); if (v < bc - 1) { best = q; bc = v; } }
    mini.classList.toggle("left", best[0].includes("left"));
    mini.classList.toggle("bottom", best[0].includes("bottom"));
  }
  function openMini(c) {
    if (!mini) return;
    const k = cls(c);
    const sw = stage.clientWidth || 800;
    let C = Math.round(Math.min(304, Math.max(144, sw * 0.36)) / MINI_X);
    C -= C % 2;                                          // crop in PNG px; shown at C x 8 CSS px
    const dpr = Math.min(2, window.devicePixelRatio || 1), css = C * MINI_X, px = Math.round(css * dpr);
    mini.style.setProperty("--cz", k.color);
    mini.setAttribute("aria-label", CZ("mini.aria", { x: MINI_X, id: c.id }, "{x}× close-up of {id}"));
    mini.hidden = false;
    mini.innerHTML = `<div class="cz-mini-h" style="max-width:${css}px"><b>${esc(c.id)}</b><span${clsHint(c)}>${esc(clsLabel(c.class))}` +
      `${isMover(c) ? " · " + esc(speedText(c.motion)) : changeText(c) ? " · " + esc(changeText(c)) : ""}</span>` +
      `<button type="button" id="czMiniPlay" aria-pressed="false">${esc(CZ("pause", null, "Pause"))}</button><button type="button" id="czMiniClose" aria-label="${esc(CZ("miniClose", null, "Close the close-up"))}">×</button></div>` +
      `<canvas id="czMiniCv" width="${px}" height="${px}" style="width:${css}px; height:${css}px" role="img" ` +
      `aria-label="${esc(CZ("mini.cv", { x: MINI_X, id: c.id }, "{x}× close-up of {id}, the seasons one after the other"))}"></canvas>` +
      `<small id="czMiniCap" style="max-width:${css}px"></small>`;
    if (S.mini) clearInterval(S.mini.timer);
    S.mini = { c, C, dpr, i: 0, timer: 0, playing: !reduceMotion(), crops: [], lohi: undefined, um: null,
      ox: Math.round(c.png_xy[0] - C / 2), oy: Math.round(c.png_xy[1] - C / 2) };
    $("czMiniClose").onclick = () => select(null);
    $("czMiniPlay").onclick = () => { if (!S.mini) return; S.mini.playing = !S.mini.playing; startMini(true); };
    startMini();
    placeMini();
  }
  function closeMini() {
    if (S.mini) clearInterval(S.mini.timer);
    S.mini = null;
    if (mini) { mini.hidden = true; mini.innerHTML = ""; }
  }
  function startMini(keepIndex) {
    const m = S.mini;
    if (!m) return;
    clearInterval(m.timer);
    const bf = binFrames();
    if (m.um !== bf.um) { m.crops = []; m.lohi = undefined; }
    m.frames = bf.frames; m.um = bf.um;
    if (!keepIndex) {
      const i = S.frame ? m.frames.findIndex((f) => f.epoch === S.frame.epoch) : -1;
      m.i = i >= 0 ? i : 0;
    }
    m.frames.forEach((f) => {                            // preload; redraw when the last season arrives (stretch)
      const im = imgFor(f.file);
      if (!im.complete) im.addEventListener("load", () => { if (S.mini === m) miniDraw(); }, { once: true });
    });
    const pb = $("czMiniPlay");
    if (pb) { pb.textContent = m.playing ? CZ("pause", null, "Pause") : CZ("play", null, "Play"); pb.setAttribute("aria-pressed", String(!m.playing)); pb.disabled = m.frames.length < 2; }
    miniDraw();
    if (m.playing && m.frames.length > 1) m.timer = setInterval(() => { m.i = (m.i + 1) % m.frames.length; miniDraw(); }, MINI_MS);
  }
  /** Frame i cut to the C x C box around the object (a canvas, 1 PNG px per pixel); null until loaded. */
  function cropOf(m, i) {
    if (m.crops[i]) return m.crops[i];
    const im = imgFor(m.frames[i].file);
    if (!im.complete || !im.naturalWidth) return null;
    const C = m.C, oc = document.createElement("canvas");
    oc.width = C; oc.height = C;
    const g = oc.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, C, C);
    const iw = im.naturalWidth, ih = im.naturalHeight;
    const x0 = Math.max(0, m.ox), y0 = Math.max(L, m.oy), x1 = Math.min(iw, m.ox + C), y1 = Math.min(ih, m.oy + C);
    if (x1 > x0 && y1 > y0) g.drawImage(im, x0, y0, x1 - x0, y1 - y0, x0 - m.ox, y0 - m.oy, x1 - x0, y1 - y0);
    oc.box = [x0 - m.ox, y0 - m.oy, x1 - m.ox, y1 - m.oy];          // the part that is sky
    m.crops[i] = oc;
    return oc;
  }
  /** Contrast of the box: one linear stretch (2 % .. 99.8 % of the box's pixels in every season of the
   *  bin) for all seasons, so faint objects show and the blink still compares like with like. */
  function stretchMini(m) {
    if (m.lohi !== undefined) return;
    const crops = m.frames.map((_, i) => cropOf(m, i));
    if (crops.some((x) => !x)) return;                   // wait for every season
    m.lohi = null;
    try {
      const C = m.C, data = crops.map((oc) => oc.getContext("2d").getImageData(0, 0, C, C)), vals = [];
      data.forEach((im, k) => {
        const [a, b, c2, d2] = crops[k].box, p = im.data;
        for (let y = b; y < d2; y++) for (let x = a; x < c2; x++) { const j = 4 * (y * C + x); vals.push((p[j] + p[j + 1] + p[j + 2]) / 3); }
      });
      if (vals.length < 20) return;
      vals.sort((p, q) => p - q);
      const lo = vals[Math.floor(0.02 * (vals.length - 1))], hi = vals[Math.floor(0.998 * (vals.length - 1))];
      if (!(hi - lo >= 6)) return;
      data.forEach((im, k) => {
        const p = im.data;
        for (let j = 0; j < p.length; j += 4) for (let q = 0; q < 3; q++) p[j + q] = Math.max(0, Math.min(255, Math.round((p[j + q] - lo) * 255 / (hi - lo))));
        crops[k].getContext("2d").putImageData(im, 0, 0);
      });
      m.lohi = [lo, hi];
    } catch (_) { m.lohi = null; }                       // an unreadable canvas: keep the page's own stretch
  }
  function miniDraw() {
    const m = S.mini, cv = $("czMiniCv");
    if (!m || !cv || !m.frames.length) return;
    const f = m.frames[m.i], oc = cropOf(m, m.i);
    if (!oc) return;                                     // drawn again when the image arrives
    stretchMini(m);
    const ctx = cv.getContext("2d"), C = m.C, s = cv.width / C, d = m.dpr;
    const c = m.c, [cx, cy] = c.png_xy, sx = m.ox, sy = m.oy;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(oc, 0, 0, C, C, 0, 0, cv.width, cv.height);
    const col = cls(c).color, px = (x) => (x - sx) * s, py = (y) => (y - sy) * s;
    const line = (w, st, fn) => { ctx.lineWidth = w * d; ctx.strokeStyle = st; ctx.beginPath(); fn(); ctx.stroke(); };
    // the ring at the 2026.0 position, as on the big image (10 PNG px, smaller in a small crop)
    const R = Math.min(10, 0.3 * C) * s;
    line(5, "rgba(5,7,13,.7)", () => ctx.arc(px(cx), py(cy), R, 0, 2 * Math.PI));
    line(2.4, col, () => ctx.arc(px(cx), py(cy), R, 0, 2 * Math.PI));
    // ticks at this season's measured position
    const p = (c.positions || []).find((q) => q.season === f.epoch && Array.isArray(q.png_xy));
    if (p) {
      const X = px(p.png_xy[0]), Y = py(p.png_xy[1]), a = 2.2 * s, b = 4.6 * s;
      const ticks = () => { ctx.moveTo(X - b, Y); ctx.lineTo(X - a, Y); ctx.moveTo(X + a, Y); ctx.lineTo(X + b, Y);
        ctx.moveTo(X, Y - b); ctx.lineTo(X, Y - a); ctx.moveTo(X, Y + a); ctx.lineTo(X, Y + b); };
      line(5, "rgba(5,7,13,.75)", ticks);
      line(2.2, "#ffffff", ticks);
    }
    // season label
    const fs = Math.round(Math.max(11, Math.min(16, cv.width / d * 0.055)) * d);
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    const label = seasonText(f.epoch);
    ctx.lineWidth = fs * 0.28; ctx.strokeStyle = "rgba(5,7,13,.9)"; ctx.strokeText(label, fs * 0.5, fs * 0.45);
    ctx.fillStyle = "#ffffff"; ctx.fillText(label, fs * 0.5, fs * 0.45);
    const cap = $("czMiniCap");
    if (cap) cap.textContent = `${MINI_X}× close-up, ${pngArcsec ? Math.round(C * pngArcsec) + "″ box" : C + " px box"}` +
      `${ok(m.um) ? `, ${(+m.um).toFixed(1)} µm` : ""}, season ${m.i + 1} of ${m.frames.length}` +
      `${m.lohi ? ", contrast set for this box" : ""}` + (p ? "; ticks: measured position." : ".");
  }

  draw();
  box.__cz = { doc, select, redraw: draw };
  return box.__cz;
}

// =====================================================================================================
// explore.html: the same rings and arrows on the Aladin sphere
// =====================================================================================================
const SKY_CSS = `
#czChip { --c:#ff5ccf; }
.cz-sky-key { display:flex; flex-direction:column; gap:3px; font-size:12px; }
.cz-sky-key .fl-row i.dash { border-style:dashed; }
.cz-sky-key label { display:flex; align-items:center; gap:6px; color:#dfe6f7; cursor:pointer; }
.cz-sky-key input { accent-color:#ff5ccf; }
`;
const sky = { run: 0, state: null, cat: null, box: null, doc: null, label: "", on: true, rejected: false, chip: null, key: null };

/** explore.html: draw the candidates of the result shown in the blink panel (src) on the sphere. */
export async function showOnSky(state, src) {
  const run = ++sky.run;
  const base = baseFromSrc(src);
  if (!base || !state || !state.A || !state.al) { clearSky(); return; }
  const [doc, meta] = await Promise.all([loadCandidates(base), loadJson(base + "meta.json")]);
  if (run !== sky.run) return;
  if (!doc) { clearSky(); return; }
  try {
    sky.state = state;
    sky.doc = doc;
    const { A, al } = state;
    if (!sky.cat) {
      sky.cat = A.catalog({ name: "Finder candidates", shape: skyShape, sourceSize: 26, color: "#ff5ccf" });
      al.addCatalog(sky.cat);
      sky.box = A.graphicOverlay({ name: "Finder field", color: "#ff5ccf", lineWidth: 1.2, lineDash: [5, 5] });
      al.addOverlay(sky.box);
    }
    sky.cat.removeAll();
    sky.box.removeAll();
    const recs = doc.candidates.filter((c) => c && ok(c.ra) && ok(c.dec));
    sky.cat.addSources(recs.map((c) => A.source(+c.ra, +c.dec, { cz: c, name: c.id })));
    const outline = fieldOutline(meta, doc);
    if (outline) sky.box.add(A.polygon(outline, { color: "#ff5ccf", lineWidth: 1.2 }));
    sky.label = (doc.field && (doc.field.label || doc.field.name)) || (meta && meta.target) || "this field";
    skyKey();
    setSkyOn(sky.on);
  } catch (e) {
    console.warn("candidates on the sky", e);
  }
}

/** Remove the candidates from the sphere (and their chip). */
export function clearSky() {
  sky.doc = null;
  try { if (sky.cat) sky.cat.removeAll(); if (sky.box) sky.box.removeAll(); } catch (_) {}
  if (sky.chip) sky.chip.hidden = true;
  if (sky.key) sky.key.hidden = true;
}

function setSkyOn(on) {
  sky.on = !!on;
  try {
    if (sky.cat) sky.on ? sky.cat.show() : sky.cat.hide();
    if (sky.box) sky.on ? sky.box.show() : sky.box.hide();
  } catch (_) {}
  if (sky.chip) sky.chip.setAttribute("aria-pressed", String(sky.on));
  if (sky.key) sky.key.hidden = !sky.on || !sky.doc;
}

/** The result's frame on the sky: the PNG grid (meta.grid, north-up TAN around meta.ra/dec). */
function fieldOutline(meta, doc) {
  const g = (meta && meta.grid) || {};
  const ra0 = ok(meta && meta.ra) ? +meta.ra : doc.field && ok(doc.field.ra) ? +doc.field.ra : null;
  const de0 = ok(meta && meta.dec) ? +meta.dec : doc.field && ok(doc.field.dec) ? +doc.field.dec : null;
  const [ny, nx] = g.size_px || [];
  if (ra0 == null || de0 == null || !(g.pixel_arcsec > 0) || !(nx > 0) || !(ny > 0)) return null;
  const hx = nx * g.pixel_arcsec / 7200 * Math.PI / 180, hy = ny * g.pixel_arcsec / 7200 * Math.PI / 180;
  const a0 = ra0 * Math.PI / 180, d0 = de0 * Math.PI / 180;
  const toSky = (xi, eta) => {                  // gnomonic (TAN) inverse; xi to the east, eta to the north
    const den = Math.cos(d0) - eta * Math.sin(d0);
    const ra = a0 + Math.atan2(xi, den);
    const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den));
    return [((ra * 180 / Math.PI) % 360 + 360) % 360, dec * 180 / Math.PI];
  };
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => toSky(x, y));
}

function skyKey() {
  const tools = document.getElementById("starTools");
  if (!document.getElementById("cz-sky-style")) {
    const st = document.createElement("style"); st.id = "cz-sky-style"; st.textContent = SKY_CSS; document.head.appendChild(st);
  }
  if (!sky.chip) {
    const b = document.createElement("button");
    b.type = "button"; b.id = "czChip"; b.className = "chip";
    b.title = CZ("sky.tip", null, "Rings: what the candidate finder reported in the last result you opened. Arrows: the motion in one year, magnified ×M.");
    b.onclick = () => setSkyOn(!sky.on);
    const k = document.createElement("div");
    k.className = "fast-legend cz-sky-key"; k.id = "czSkyKey";
    if (tools) { tools.appendChild(b); tools.appendChild(k); }
    else {                                       // no star tools on this page: a small box of its own
      const w = document.createElement("div");
      w.style.cssText = "position:fixed; z-index:10; top:104px; right:10px; display:flex; flex-direction:column; align-items:flex-end; gap:6px;";
      w.append(b, k); document.body.appendChild(w);
    }
    sky.chip = b; sky.key = k;
    k.addEventListener("change", (e) => {
      if (e.target && e.target.id === "czSkyRej") { sky.rejected = e.target.checked; redrawSky(); }
    });
  }
  const doc = sky.doc, all = doc.candidates;
  const n = movingCount(doc);
  const nRej = all.filter((c) => c.class === "artifact").length;
  sky.chip.hidden = false;
  sky.chip.innerHTML = `<i aria-hidden="true"></i><span>${esc(CZ("sky.chip", null, "Finder candidates"))}</span><small>${esc(sky.label)}: ${esc(headingShort(n))}</small>`;
  const present = Object.keys(CLASSES).filter((k) => k !== "artifact" && all.some((c) => c.class === k));
  sky.key.innerHTML = `<p class="fl-title">${esc(CZ("sky.title", { l: sky.label }, "Candidate finder: {l}"))}</p>` +
    present.map((k) => `<div class="fl-row"><i style="border:2px solid ${CLASSES[k].color}; background:transparent"></i>${esc(clsLabel(k))}` +
      `<small>${all.filter((c) => c.class === k).length}</small></div>`).join("") +
    `<p class="fl-src">${esc(CZ("sky.src", null, "Arrows: motion in one year, magnified ×M so it shows. Candidates for follow-up, not discoveries."))}</p>` +
    (nRej ? `<label><input type="checkbox" id="czSkyRej"${sky.rejected ? " checked" : ""}> ${esc(CZ("rejShow", { n: nRej }, "Show rejected ({n})"))}</label>` : "");
}

function redrawSky() {
  try { if (sky.state && sky.state.al) sky.state.al.view.requestRedraw(); } catch (_) {}
  try { if (sky.cat) { sky.cat.hide(); if (sky.on) sky.cat.show(); } } catch (_) {}
}

/** Aladin catalog shape: ring, magnified 1-year arrow "×M" and id, in screen px (source.x/y). */
function skyShape(s, ctx) {
  const c = s && s.data && s.data.cz, al = sky.state && sky.state.al;
  if (!c || !al || (c.class === "artifact" && !sky.rejected)) return;
  const x = s.x, y = s.y;
  let q;
  try { q = al.world2pix(+c.ra, Math.max(-90, Math.min(90, +c.dec + (c.dec < 89 ? 1 : -1) * 10 / 3600))); } catch (_) { return; }
  if (!q || !ok(q[0])) return;
  const pxPerArcsec = Math.hypot(q[0] - x, q[1] - y) / 10;
  if (pxPerArcsec < 0.12) return;                   // too far out: the field is a few px wide
  const col = cls(c).color, art = c.class === "artifact", R = 9;
  ctx.save();
  ctx.setLineDash(art ? [4, 3] : []);
  ctx.lineWidth = 4.2; ctx.strokeStyle = "rgba(5,7,13,.7)";
  ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = col;
  ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.stroke();
  ctx.setLineDash([]);
  if (isMover(c)) {
    const m = c.motion, cosd = Math.max(1e-6, Math.cos(+c.dec * Math.PI / 180));
    let p;
    try { p = al.world2pix(+c.ra + (+m.pmra_mas_yr) / 3.6e6 / cosd, +c.dec + (+m.pmdec_mas_yr) / 3.6e6); } catch (_) { p = null; }
    if (p && ok(p[0])) {
      const dx = p[0] - x, dy = p[1] - y, L1 = Math.hypot(dx, dy), M = pickMag(L1, 34);
      if (M) {
        const ux = dx / L1, uy = dy / L1, x1 = x + dx * M, y1 = y + dy * M, hl = 8, hw = 4.5;
        const bx = x1 - ux * hl, by = y1 - uy * hl;
        const path = () => { ctx.beginPath(); ctx.moveTo(x + ux * R, y + uy * R); ctx.lineTo(bx, by); };
        const head = () => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(bx - uy * hw, by + ux * hw); ctx.lineTo(bx + uy * hw, by - ux * hw); ctx.closePath(); };
        ctx.lineCap = "round";
        ctx.lineWidth = 4.5; ctx.strokeStyle = "rgba(5,7,13,.7)"; path(); ctx.stroke();
        ctx.lineWidth = 2; ctx.strokeStyle = col; if (art) ctx.setLineDash([4, 3]); path(); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col; head(); ctx.fill();
        ctx.font = "700 11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const tx = x1 + ux * 11, ty = y1 + uy * 11;
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(5,7,13,.85)"; ctx.strokeText(`×${M}`, tx, ty);
        ctx.fillStyle = col; ctx.fillText(`×${M}`, tx, ty);
      }
    }
  }
  if (!art && pxPerArcsec > 0.2) {
    ctx.font = "700 10.5px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(5,7,13,.85)"; ctx.strokeText(String(c.id || ""), x + R - 1, y - R + 1);
    ctx.fillStyle = col; ctx.fillText(String(c.id || ""), x + R - 1, y - R + 1);
  }
  ctx.restore();
}
