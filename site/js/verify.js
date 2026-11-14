// verify.html: the verification table, the naive-centroid comparison, the no-change control and the
// open questions. Everything comes from JSON written by the pipeline:
//   data/verify/table.json          pipeline/verify_table.py (from every target's meta.json)
//   data/verify/naive_barnard.json  pipeline/naive_centroid.py (naive methods on the same Barnard exposures)
//   data/verify/null_barnard.json   pipeline/naive_centroid.py --null (field stars that should not move)
// A section whose JSON is missing stays hidden.

import { t, apply, onLang, lang, langButton } from "./fz_i18n.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const sgn = (v, d) => (v > 0 ? "+" : v < 0 ? "−" : "") + num(Math.abs(v), d);
function num(v, d) {                                   // locale decimal separator
  const s = Number(v).toFixed(d);
  return lang() === "tr" ? s.replace(".", ",") : s;
}
function month(ep) {
  const [y, m] = String(ep).split("-").map(Number);
  if (!y || !m) return ep;
  try { return new Intl.DateTimeFormat(lang() === "tr" ? "tr-TR" : "en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(Date.UTC(y, m - 1, 15)); }
  catch (e) { return ep; }
}
const fmtA = (v, d = 2) => `${num(v, d)}″`;
const fmtS = (v, d = 2) => `${sgn(v, d).replace(".", lang() === "tr" ? "," : ".")}″`;

let TABLE = null, NAIVE = null, NULLT = null;

// ------------------------------------------------------------------------------------------ table
function motionRow(r) {
  const m = r.measured, ref = r.reference, d = r.diff;
  const tag = r.challenge ? `<span class="tag ch">${esc(t("v.tag.challenge"))}</span>` : `<span class="tag">${esc(t("v.tag.extra"))}</span>`;
  const bins = r.detection === "partial" && r.detected_bins_um ? `<small>${esc(t("v.onlyBins", { bins: r.detected_bins_um.map((b) => num(b, 1)).join(", ") }))}</small>` : "";
  const pm = r.proper_motion;
  const pmTxt = pm && pm.measured_mas_yr[0] != null ? `<small>${esc(t("v.pm", {
    m1: sgn(pm.measured_mas_yr[0], 0), m2: sgn(pm.measured_mas_yr[1], 0), e: Math.round(pm.err_mas_yr[0]),
    r1: sgn(pm.reference_mas_yr[0], 0), r2: sgn(pm.reference_mas_yr[1], 0), s1: num(pm.diff_sigma[0], 1), s2: num(pm.diff_sigma[1], 1) }))}</small>` : "";
  const refName = r.id === "luhman16" ? t("v.ref.simbad") : r.id === "wise0855" ? t("v.ref.kirk") : t("v.ref.gaia");
  const extra = r.id === "luhman16" ? `<small>${esc(t("v.luhmanRef", { p: num(r.reference.parallax_residual_max_arcsec, 2) }))}</small>` : "";
  const res = (r.status === "pass" ? `<span class="res pass">✓ ${esc(t("v.pass"))}</span>` : `<span class="res fail">✗ ${esc(t("v.fail"))}</span>`)
    + absLine(r.id);
  const view = r.local_job ? `<small>${esc(t("v.localJob"))}</small>` : `<small><a href="${esc(r.viewer)}">${esc(t("v.open"))} →</a></small>`;
  return `<tr>
    <td data-h="${esc(t("v.col.target"))}"><span class="nm">${esc(r.name)}</span><br>${tag}${view}</td>
    <td data-h="${esc(t("v.col.what"))}">${esc(t("v.what", { from: month(m.from), to: month(m.to), dt: num(m.dt_years, 2) }))}
      <small>${esc(t("v.images", { n: r.n_images, s: (r.seasons || []).length }))}</small>${bins}${pmTxt}</td>
    <td class="num" data-h="${esc(t("v.col.measured"))}"><b class="me">${fmtA(m.shift_arcsec)} ± ${fmtA(m.err_arcsec)}</b><small>PA ${num(m.pa_deg, 1)}°</small></td>
    <td class="num" data-h="${esc(t("v.col.ref"))}"><b class="ref">${fmtA(ref.shift_arcsec)}</b><small>PA ${num(ref.pa_deg, 1)}° · ${esc(refName)}</small>${extra}</td>
    <td class="num" data-h="${esc(t("v.col.diff"))}">${fmtS(d.shift_arcsec)} <span class="fine">(${sgn(d.percent, 1).replace(".", lang() === "tr" ? "," : ".")} %)</span>
      <small>${esc(t("v.sigma", { s: num(d.sigma, 1), v: num(d.vector_arcsec, 2) }))}</small></td>
    <td data-h="${esc(t("v.col.result"))}">${res}</td>
  </tr>`;
}

/** Absolute position against the reference, from accuracy.json (pipeline/accuracy.py). */
function absLine(id) {
  const a = TABLE?.accuracy?.targets?.find((x) => x.key === id);
  if (!a) return "";
  if (a.absolute_position === "reference_not_suitable") return `<small>${esc(t("v.abs.na"))}</small>`;
  const ss = a.seasons || [];
  if (!ss.length) return "";
  const smax = Math.max(...ss.map((x) => Math.max(x.sig_E ?? 0, x.sig_N ?? 0)));
  const mean = (k) => ss.reduce((q, x) => q + x[k], 0) / ss.length;
  if (smax <= 2) return `<small>${esc(t("v.abs.ok", { s: num(smax, 1) }))}</small>`;
  return `<small>${esc(t("v.abs.off", { e: sgn(mean("dE"), 2), n: sgn(mean("dN"), 2), s: num(smax, 0) }))}</small>`;
}

function brightRow(r, bestErr) {
  const b = (r.brightness_bins || []).slice(-1)[0];
  const last = b ? b.ratio.length - 1 : -1;
  const br = b ? `<small>${esc(t("v.bright", { um: num(b.wavelength_um, 1), r: num(b.ratio[last], 2), e: num(b.err[last], 2), from: month(b.seasons[0]), to: month(b.seasons[last]) }))}</small>` : "";
  return `<tr class="na">
    <td data-h="${esc(t("v.col.target"))}"><span class="nm">${esc(r.name)}</span><br><span class="tag ch">${esc(t("v.tag.challenge"))}</span>
      <small><a href="${esc(r.viewer)}">${esc(t("v.open"))} →</a></small></td>
    <td data-h="${esc(t("v.col.what"))}">${esc(t("v.motionOnly"))}<small>${esc(t("v.images", { n: r.n_images, s: (r.seasons || []).length }))}</small>${br}</td>
    <td class="num" data-h="${esc(t("v.col.measured"))}">—</td>
    <td class="num" data-h="${esc(t("v.col.ref"))}"><b class="ref">${fmtA(r.expected_motion_arcsec_yr, 3)}</b><small>${esc(t("v.perYear"))} · ${esc(t("v.ref.gaia"))}</small></td>
    <td class="num" data-h="${esc(t("v.col.diff"))}">—</td>
    <td data-h="${esc(t("v.col.result"))}"><span class="res na">${esc(t("v.na"))}</span><small>${esc(t("v.naWhy", { lo: num(bestErr[0], 2), hi: num(bestErr[1], 2) }))}</small></td>
  </tr>`;
}

function renderTable() {
  const rows = TABLE.rows;
  const errs = rows.filter((r) => r.kind === "motion" && r.measured && r.astrometry_path === "bright").map((r) => r.measured.err_arcsec);
  const bestErr = [Math.min(...errs), Math.max(...errs)];
  $("vtBox").innerHTML = `<table class="vt">
    <caption class="sr-only">${esc(t("v.table.cap"))}</caption>
    <thead><tr><th scope="col">${esc(t("v.col.target"))}</th><th scope="col">${esc(t("v.col.what"))}</th><th scope="col">${esc(t("v.col.measured"))}</th>
      <th scope="col">${esc(t("v.col.ref"))}</th><th scope="col">${esc(t("v.col.diff"))}</th><th scope="col">${esc(t("v.col.result"))}</th></tr></thead>
    <tbody>${rows.map((r) => (r.kind === "brightness" ? brightRow(r, bestErr) : r.measured ? motionRow(r) : "")).join("")}</tbody></table>`;
  $("crit").textContent = t("v.crit", { n: TABLE.criterion.n_sigma });
  $("tableSrc").innerHTML = esc(t("v.src", { date: TABLE.generated.slice(0, 10) }))
    + (TABLE.accuracy ? ` ${esc(t("v.src.acc"))} <a href="https://github.com/adembtr/fazari/blob/dev/pipeline/ACCURACY.md">pipeline/ACCURACY.md</a>.` : "");
}

// ------------------------------------------------------------------------------------- open questions
function renderOpen() {
  const by = Object.fromEntries(TABLE.rows.map((r) => [r.id, r]));
  const items = [];
  const b = by.barnard;
  if (b?.season_minus_reference_arcsec?.length) {
    const ns = b.season_minus_reference_arcsec.map((s) => s.north), es = b.season_minus_reference_arcsec.map((s) => s.east);
    const err = Math.max(...b.season_minus_reference_arcsec.map((s) => s.err_north));
    const acc = TABLE.accuracy?.targets?.find((x) => x.key === "barnard");
    const sg = acc ? acc.seasons.map((x) => x.sig_N).filter((x) => x != null) : [];
    items.push(t(sg.length ? "v.open.barnard2" : "v.open.barnard", { lo: num(Math.min(...ns), 2), hi: num(Math.max(...ns), 2), e: num(Math.max(...es.map(Math.abs)), 2), err: num(err, 2),
      slo: sg.length ? num(Math.min(...sg), 1) : "", shi: sg.length ? num(Math.max(...sg), 1) : "" }));
  }
  const e = by.eps_indi_b;
  if (e?.position_minus_reference_2026_arcsec) {
    const [ee, nn] = e.position_minus_reference_2026_arcsec;
    items.push(t("v.open.eps", { e: num(Math.abs(ee), 2), ew: t(ee >= 0 ? "dir.east" : "dir.west"), n: num(Math.abs(nn), 2), ns: t(nn >= 0 ? "dir.north" : "dir.south") }));
  }
  const w = by.wise0855;
  if (w?.measured) items.push(t("v.open.wise", { err: num(w.measured.err_arcsec, 2), k: num(w.measured.err_arcsec / (b?.measured?.err_arcsec || 1), 0), bins: (w.detected_bins_um || []).map((x) => num(x, 1)).join(", ") }));
  const l = by.luhman16;
  if (l?.position_minus_reference_2026_arcsec) {
    const [le, ln] = l.position_minus_reference_2026_arcsec;
    items.push(t("v.open.luhman", { e: num(Math.hypot(le, ln), 1), dir: t(Math.abs(le) >= Math.abs(ln) ? (le >= 0 ? "dir.east" : "dir.west") : (ln >= 0 ? "dir.north" : "dir.south")) }));
  }
  items.push(t("v.open.bright"));
  $("openList").innerHTML = items.map((s) => `<li>${s}</li>`).join("");   // dictionary text (trusted) with numbers
}

// ------------------------------------------------------------------------------------- trust (naive)
function renderTrust() {
  if (!NAIVE) return;
  // filled in by renderTrustSection (below), kept separate so the table renders even if this fails
  $("trust").hidden = false;
  $("trustBox").innerHTML = trustHtml(NAIVE, TABLE?.rows?.find((r) => r.id === "barnard"));
}

function trustHtml(n, b) {
  if (!n || !n.methods) return "";
  const ours = b?.measured, ref = b?.reference;
  const gaia = ref?.shift_arcsec ?? n.gaia_arcsec;
  const tile = (cls, val, lbl) => `<li class="${cls}"><b>${val}</b><small>${lbl}</small></li>`;
  const order = ["moment", "brightest"];
  const meths = order.map((id) => n.methods.find((m) => m.id === id)).filter(Boolean);
  const tiles = meths.map((m) => tile("bad", `${fmtA(m.shift_arcsec)}<span class="fine"> ± ${fmtA(m.err_arcsec)}</span>`,
      esc(t(`v.naive.${m.id}`)) + `<br>${esc(t("v.naive.off", { d: fmtS(m.shift_arcsec - gaia), p: sgn(100 * (m.shift_arcsec / gaia - 1), 1).replace(".", lang() === "tr" ? "," : ".") }))}`)).join("")
    + (ours ? tile("me", `${fmtA(ours.shift_arcsec)}<span class="fine"> ± ${fmtA(ours.err_arcsec)}</span>`, esc(t("v.naive.ours"))) : "")
    + tile("ref", fmtA(gaia), esc(t("v.naive.gaia")));
  const nm = meths[0];
  // every pair of seasons: length and direction
  const pairs = nm.pairs.map((p, k) => {
    const bp = meths[1]?.pairs?.[k];
    const cell = (s, pa) => `${fmtA(s)} <span class="fine">${num(pa, 1)}°</span>`;
    return `<tr><td data-h="${esc(t("v.pairs.pair"))}">${esc(month(p.from))} → ${esc(month(p.to))}<small>${esc(t(p.same_orientation ? "v.pairs.same" : "v.pairs.turned"))}</small></td>
      <td class="num" data-h="${esc(t("v.pairs.gaia"))}"><b class="ref">${cell(p.gaia_arcsec, p.gaia_pa_deg)}</b></td>
      <td class="num" data-h="${esc(t("v.pairs.ours"))}"><b class="me">${cell(p.ours_arcsec, p.ours_pa_deg)}</b></td>
      <td class="num" data-h="${esc(t("v.naive.moment"))}">${cell(p.shift_arcsec, p.pa_deg)}</td>
      ${bp ? `<td class="num" data-h="${esc(t("v.naive.brightest"))}">${cell(bp.shift_arcsec, bp.pa_deg)}</td>` : ""}</tr>`;
  }).join("");
  const turned = nm.pairs.filter((p) => !p.same_orientation);
  const worst = turned.length ? Math.max(...turned.map((p) => Math.abs(((p.pa_deg - p.gaia_pa_deg + 540) % 360) - 180))) : null;
  const oursWorst = turned.length ? Math.max(...turned.map((p) => Math.abs(((p.ours_pa_deg - p.gaia_pa_deg + 540) % 360) - 180))) : null;
  return `<div class="duo">
      <figure class="svgbox">${coreSvg(n.core)}<figcaption>${esc(t("v.core.cap", { date: n.core?.date || "", det: n.core?.detector || "", um: num(n.core?.wavelength_um ?? 0, 2) }))}</figcaption></figure>
      <div>
        <p>${t("v.trust.p1", { sat: n.core?.n_saturated ?? "?", fit: n.core?.n_fit_pixels ?? "?" })}</p>
        <p>${t("v.trust.p2", { naive: fmtA(nm.shift_arcsec), ours: ours ? fmtA(ours.shift_arcsec) : "?", gaia: fmtA(gaia) })}</p>
        <ul class="tiles">${tiles}</ul>
      </div>
    </div>
    <h3 class="pairs-h">${esc(t("v.pairs.h"))}</h3>
    <table class="vt pairs"><thead><tr><th scope="col">${esc(t("v.pairs.pair"))}</th><th scope="col">${esc(t("v.pairs.gaia"))}</th><th scope="col">${esc(t("v.pairs.ours"))}</th>
      <th scope="col">${esc(t("v.naive.moment"))}</th>${meths[1] ? `<th scope="col">${esc(t("v.naive.brightest"))}</th>` : ""}</tr></thead><tbody>${pairs}</tbody></table>
    ${worst != null ? `<p class="crit">${esc(t("v.pairs.note", { d: num(worst, 0), o: num(oursWorst, 1) }))}</p>` : ""}
    <p class="fine">${esc(t("v.trust.how", { n1: n.n_exposures?.[0] ?? "?", n2: n.n_exposures?.[1] ?? "?", from: month(n.from), to: month(n.to),
      v7: (() => { const m7 = n.methods.find((m) => m.id === "moment7"); return m7 ? fmtA(m7.shift_arcsec) : "?"; })() }))}</p>`;
}

/** The saturated core of one Barnard exposure with the pixels our wing fit uses. */
function coreSvg(c) {
  if (!c || !c.pixels) return "";
  const N = c.box, S = 20;                              // cell size in SVG units
  let cells = "";
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = c.pixels[y][x];                           // 0..255, null = missing
    const sat = c.saturated[y][x], fit = c.fit[y][x];
    const col = v == null ? "#300" : `rgb(${v},${v},${v})`;
    cells += `<rect x="${x * S}" y="${(N - 1 - y) * S}" width="${S}" height="${S}" fill="${sat ? "#fff" : col}"/>`;
    if (fit && !sat) cells += `<rect class="fitpx" x="${x * S + 1.5}" y="${(N - 1 - y) * S + 1.5}" width="${S - 3}" height="${S - 3}" fill="none" stroke="#ffc94d" stroke-width="1.4" opacity=".8"/>`;
    if (sat) cells += `<line x1="${x * S + 4}" y1="${(N - 1 - y) * S + 4}" x2="${x * S + S - 4}" y2="${(N - 1 - y) * S + S - 4}" stroke="#d33" stroke-width="1.6" opacity=".55"/>`;
  }
  const mk = (p, color, shape) => {
    if (!p) return "";
    const X = (p[0] + 0.5) * S, Y = (N - 1 - p[1] + 0.5) * S;
    if (shape === "+") return `<path d="M${X - 9} ${Y}H${X + 9}M${X} ${Y - 9}V${Y + 9}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
    return shape === "x" ? `<path d="M${X - 7} ${Y - 7}L${X + 7} ${Y + 7}M${X - 7} ${Y + 7}L${X + 7} ${Y - 7}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`
      : `<circle cx="${X}" cy="${Y}" r="8" fill="none" stroke="${color}" stroke-width="3"/>`;
  };
  const W = N * S;
  return `<svg viewBox="0 0 ${W} ${W}" role="img" aria-label="${esc(t("v.core.alt"))}">
    <g>${cells}</g>${mk(c.xy_fit, "#ffc94d", "+")}</svg>
    <ul class="legend">
      <li><i class="sw sat"></i>${esc(t("v.core.sat"))}</li>
      <li><i class="sw fit"></i>${esc(t("v.core.fit"))}</li>
      <li><i class="sw plus">+</i>${esc(t("v.core.ours"))}</li>
    </ul>`;
}

// ----------------------------------------------------------------------------------- control (null)
function renderControl() {
  if (!NULLT || !NULLT.slow) return;
  $("control").hidden = false;
  const n = NULLT, sl = n.slow;
  const tile = (cls, val, lbl) => `<li class="${cls}"><b>${val}</b><small>${lbl}</small></li>`;
  const ratio = Math.round(n.barnard_shift_arcsec / Math.max(sl.scatter_arcsec, 1e-3));
  $("controlBox").innerHTML = `<div class="duo">
      <figure class="svgbox">${nullSvg(n)}<figcaption>${esc(t("v.ctrl.cap", { n: sl.n_stars, from: month(n.from), to: month(n.to) }))}
        ${esc(t("v.ctrl.off", { s: fmtA(n.barnard_shift_arcsec, 2), w: Math.round(n.barnard_shift_arcsec / 0.6) }))}${nullOut(n) ? ` ${esc(t("v.ctrl.outside", { k: nullOut(n) }))}` : ""}</figcaption></figure>
      <div>
        <p>${t("v.ctrl.p1", { n: sl.n_stars, from: month(n.from), to: month(n.to), pm: num(n.pm_max_mas_yr, 0) })}</p>
        <ul class="tiles">
          ${tile("me", fmtA(sl.median_arcsec, 3), esc(t("v.ctrl.median", { e: num(Math.hypot(...sl.median_vector_err_arcsec), 3) })))}
          ${tile("", fmtA(sl.scatter_arcsec, 2), esc(t("v.ctrl.scatter")))}
          ${tile("", `${num(sl.frac_within_3sigma * 100, 0)} %`, esc(t("v.ctrl.within")))}
          ${tile("ref", fmtA(n.barnard_shift_arcsec, 2), esc(t("v.ctrl.barnard", { k: ratio })))}
        </ul>
        <p class="fine">${esc(t("v.ctrl.how", { g: `${num(sl.g_range[0], 1)}–${num(sl.g_range[1], 1)}` }))}</p>
      </div>
    </div>`;
}

const nullOut = (n) => (n.stars || []).filter((s) => s.pm_mas_yr < n.pm_max_mas_yr && !(Math.abs(s.de) < 0.3 && Math.abs(s.dn) < 0.3)).length;

/** False motion of each slow field star (east, north), with a 0.1" circle. */
function nullSvg(n) {
  const R = 0.3, S = 300, c = S / 2, k = (S / 2 - 18) / R;          // arcsec -> px
  const pts = (n.stars || []).filter((s) => s.pm_mas_yr < n.pm_max_mas_yr && Math.abs(s.de) < R && Math.abs(s.dn) < R)
    .map((s) => `<circle cx="${(c - s.de * k).toFixed(1)}" cy="${(c - s.dn * k).toFixed(1)}" r="3.6" fill="#7fd4ff" fill-opacity=".75" stroke="#05070d" stroke-width=".8"/>`).join("");
  return `<svg viewBox="0 0 ${S} ${S}" role="img" aria-label="${esc(t("v.ctrl.alt"))}">
    <rect width="${S}" height="${S}" fill="#070a14"/>
    <circle cx="${c}" cy="${c}" r="${0.1 * k}" fill="none" stroke="#5cf0a0" stroke-dasharray="4 3" stroke-width="1.4"/>
    <circle cx="${c}" cy="${c}" r="${0.2 * k}" fill="none" stroke="rgba(160,180,230,.25)" stroke-width="1"/>
    <path d="M${c} 10V${S - 10}M10 ${c}H${S - 10}" stroke="rgba(160,180,230,.3)" stroke-width="1"/>
    ${pts}
    <g font-family="system-ui, sans-serif" font-size="11.5" fill="#a9b3c9">
      <text x="${c + 4}" y="20">N</text><text x="14" y="${c - 5}">E</text>
      <text x="${c + 0.1 * k * 0.72 + 3}" y="${c - 0.1 * k * 0.72 - 3}" fill="#5cf0a0">0.1″</text>
      <text x="${c + 0.2 * k * 0.72 + 3}" y="${c - 0.2 * k * 0.72 - 3}">0.2″</text>
    </g></svg>`;
}

// ------------------------------------------------------------------------------------------- boot
function renderAll() {
  apply(document);
  document.title = t("v.title");
  if (TABLE) { renderTable(); renderOpen(); }
  renderTrust();
  renderControl();
}

$("langSlot").appendChild(langButton("fz-lang"));
onLang(() => { document.documentElement.lang = lang(); renderAll(); });
document.documentElement.lang = lang();
const [tb, nv, nl] = await Promise.all([get("data/verify/table.json"), get("data/verify/naive_barnard.json"), get("data/verify/null_barnard.json")]);
TABLE = tb; NAIVE = nv; NULLT = nl;
if (!TABLE) $("vtBox").innerHTML = `<p class="fine">${esc(t("v.noData"))}</p>`;
renderAll();
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
