// planetx.html: "Could SPHEREx see Planet X?" One JSON, written by the pipeline:
//   data/planetx/summary.json   pipeline/find_distant.py results, assembled after the search
//   (prediction, the five searched strips, candidates and their checks, injection-recovery limits).
// Run 2: data/planetx/run2.json (pipeline/planetx_run2_summary.py), one line whose EN/TR text is in that file.
// 10,400-body injection test (added after the run 2 pre-registration): data/planetx/inject10k.json, its own EN/TR text.
// Run 3: data/planetx/run3.json (pipeline/planetx_run3_summary.py), one line; its "all_runs" block (runs 1-3 together) feeds the answer and tiles.
// Static page: relative paths only. Text: i18n keys px.* (site/i18n/en.json, tr.json).

import { t, apply, onLang, lang, langButton } from "./js/i18n.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
function num(v, d = 0) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "–";
  const s = Number(v).toFixed(d);
  return lang() === "tr" ? s.replace(".", ",") : s;
}
const C = { hi: "#ffc94d", mid: "#ffa45c", lo: "#ff7a6b", lim: "#7fd4ff", band: "rgba(127, 212, 255, .10)", band2: "rgba(127, 212, 255, .05)" };
let S = null;
let R3 = null;                                        // run 3; R3.all_runs = runs 1-3 together (answer and tiles)
const allRuns = () => (R3 && R3.all_runs) || null;
const count = (n) => Number(n).toLocaleString(lang() === "tr" ? "tr-TR" : "en-US");
const compact = () => window.innerWidth < 600;      // phone: charts are drawn narrower, with fewer ticks, so the text stays readable

const pooled = (d = 0) => (S.limits.pooled || []).find((q) => q.d === d) || null;
const vExp = (H, d) => H + 10 * Math.log10(d);
const shortName = (n) => String(n).split("-")[0];

// ------------------------------------------------------------------------------------------- answer + tiles
function renderAnswer() {
  const all = pooled(0);
  const hi = S.expected.cases.find((c) => c.key === "hi"), mid = S.expected.cases.find((c) => c.key === "mid");
  if (!all || all.m50 == null) { $("pxAnswer").textContent = t("px.noLimit"); return; }
  const A = allRuns();
  if (A) {
    $("pxAnswer").innerHTML = t("px.answer", { m50: num(A.m50, 2), dhi: num(A.reach_au["0.75"], 0), n: A.n_strips, q: S.prediction.q_au[0], Q: S.prediction.Q_au[0] });
    return;
  }
  $("pxAnswer").innerHTML = t("px.answer", {
    m50: num(all.m50, 1), dhi: num(hi.d_reach_m50_au, 0), dmid: num(mid.d_reach_m50_au, 0),
    n: S.totals.n_fields, q: S.prediction.q_au[0], Q: S.prediction.Q_au[0],
  });
}

function renderTiles() {
  const all = pooled(0), T = S.totals, FP = S.first_pass;
  const hi = S.expected.cases.find((c) => c.key === "hi");
  const A = allRuns();                                 // runs 1-3 together when run3.json is there, else run 1
  const area = A ? A.area_deg2 : T.area_eff_deg2 ? T.area_eff_deg2["350"] : null;
  const frac = A ? 100 * A.band_fraction : T.band_fraction ? 100 * T.band_fraction["350"] : null;
  const reach = A ? A.reach_au["0.75"] : hi.d_reach_m50_au;
  const li = [
    ["me", A ? "V " + num(A.m50, 2) : all && all.m50 != null ? "V " + num(all.m50, 1) : "–", t("px.tile.m50", { n: count(A ? A.n_bodies : S.limits.n_bodies) })],
    ["", reach != null ? num(reach, 0) + " AU" : "–", t("px.tile.reach", { q: S.prediction.q_au[0], Q: S.prediction.Q_au[0] })],
    ["", area != null ? num(area, A ? 2 : 1) + " deg²" : "–", t("px.tile.area", { n: A ? A.n_strips : T.n_fields, pct: num(frac, A ? 3 : 2) })],
    ["", count(A ? A.exposures : T.n_strips), t("px.tile.data", { mb: count(Math.round((A ? A.bytes_read : T.bytes_read) / 1e6)) })],
    FP ? ["", `${FP.n_candidates} / ${FP.n_confirmed}`, t("px.tile.cand2", { c2: T.n_candidates })]
      : [T.n_confirmed ? "me" : "", `${T.n_candidates} / ${T.n_confirmed}`, t("px.tile.cand")],
  ];
  $("pxTiles").innerHTML = li.map(([cls, b, s]) => `<li class="${cls}"><b>${esc(b)}</b><small>${esc(s)}</small></li>`).join("");
}

// ------------------------------------------------------------------------------------------- the parallax jump
function renderJump() {
  const J = S.parallax;
  if (!J || !J.rows) { $("jump").hidden = true; return; }
  const th = ["px.jump.d", "px.jump.jump", "px.jump.px", "px.jump.orbit"].map((k) => `<th>${esc(t(k))}</th>`).join("");
  const rows = J.rows.map((r) => `<tr><td>${r.d}</td><td><b>${num(r.jump_arcsec, 0)}″</b> (${num(r.jump_arcsec / 60, 0)}′)</td>
    <td>${num(r.jump_px, 0)}</td><td>${num(r.orbit_arcsec_yr, 0)}″</td></tr>`).join("");
  $("pxJump").innerHTML = `<tr>${th}</tr>${rows}`;
  const F = J.factor_arcsec_au;
  $("pxJumpNote").textContent = t("px.jump.note", {
    lo: num(F.min / 1000, 0), hi: num(F.max / 1000, 0), max: num(F.largest_possible / 1000, 0), px: num(J.pixel_arcsec, 1), n: F.n,
  });
  const all = pooled(0), P = S.prediction;
  const mid = S.expected.cases.find((c) => c.key === "mid"), hi = S.expected.cases.find((c) => c.key === "hi");
  const len = S.fields.map((f) => f.grid_deg[0]);
  $("pxJumpMeans").textContent = t("px.jump.means", {
    l1: num(Math.min(...len), 1), l2: num(Math.max(...len), 1), m50: all && all.m50 != null ? num(all.m50, 1) : "–",
    r: num(P.radius_re, 2), v40: num(vExp(mid.H, 500), 1), v75: num(vExp(hi.H, 500), 1),
  });
}

// ------------------------------------------------------------------------------------------- chart
function renderChart() {
  const cp = compact();
  const W = cp ? 400 : 760, H = cp ? 400 : 440, L = cp ? 46 : 54, R = cp ? 12 : 96, T = 18, B = 46;
  const d0 = 200, d1 = 800, v0 = 17.5, v1 = 24.6;
  const X = (d) => L + (d - d0) / (d1 - d0) * (W - L - R);
  const Y = (v) => T + (v - v0) / (v1 - v0) * (H - T - B);
  const P = S.prediction;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("px.chart.aria"))}">`;
  // predicted distance: 1-sigma range of perihelion..aphelion (light), median orbit (stronger)
  const lo = P.q_au[0] - P.q_au[2], hi = Math.min(P.Q_au[0] + P.Q_au[1], d1);
  s += `<rect x="${X(lo)}" y="${T}" width="${X(hi) - X(lo)}" height="${H - T - B}" fill="${C.band2}"/>`;
  s += `<rect x="${X(P.q_au[0])}" y="${T}" width="${X(P.Q_au[0]) - X(P.q_au[0])}" height="${H - T - B}" fill="${C.band}"/>`;
  for (let v = 18; v <= 24; v += 1) s += `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let d = 200; d <= 800; d += cp ? 200 : 100) s += `<line class="gr" y1="${T}" y2="${H - B}" x1="${X(d)}" x2="${X(d)}"/><text x="${X(d)}" y="${H - B + 17}" text-anchor="middle">${d}</text>`;
  s += `<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/><line class="ax" x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle">${esc(t("px.chart.x"))}</text>`;
  s += `<text transform="translate(${cp ? 11 : 14} ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${esc(t("px.chart.y"))}</text>`;
  s += `<text x="${X(P.q_au[0]) + 5}" y="${T + 14}">${esc(t("px.chart.pred"))}</text>`;
  // expected brightness
  for (const c of S.expected.cases) {
    let p = "";
    for (let d = d0; d <= d1; d += 10) { const v = vExp(c.H, d); if (v >= v0 && v <= v1) p += `${p ? "L" : "M"}${X(d).toFixed(1)} ${Y(v).toFixed(1)}`; }
    s += `<path d="${p}" fill="none" stroke="${C[c.key]}" stroke-width="2.4"/>`;
    const ve = Math.min(vExp(c.H, d1), v1 - 0.1);
    s += cp ? `<text x="${W - R - 4}" y="${Y(ve) + 15}" text-anchor="end" style="fill:${C[c.key]}">${esc(t("px.chart.alb", { p: num(100 * c.albedo, 0) }))}</text>`
      : `<text x="${W - R + 6}" y="${Y(ve) + 4}" style="fill:${C[c.key]}">${esc(t("px.chart.alb", { p: num(100 * c.albedo, 0) }))}</text>`;
  }
  // the first pass was tested over a wider range of distances: thin line, open dots (drawn first, underneath)
  const rng = S.limits.distance_range_au || [250, 1000];
  const FL = S.first_pass && S.first_pass.limits;
  const firstShown = !!(FL && FL.m50 != null && FL.distance_range_au);
  if (firstShown) {
    const a = X(Math.max(d0, FL.distance_range_au[0])), b = X(Math.min(d1, FL.distance_range_au[1]));
    s += `<line x1="${a}" x2="${b}" y1="${Y(FL.m50)}" y2="${Y(FL.m50)}" stroke="${C.lim}" stroke-width="1.3" opacity=".65"/>`;
    for (const q of (FL.pooled || []).filter((q) => q.d > 0 && q.d >= d0 && q.d <= d1 && q.m50 != null)) {
      s += `<circle cx="${X(q.d)}" cy="${Y(q.m50)}" r="3.4" fill="#070a13" stroke="${C.lim}" stroke-width="1.3" opacity=".85"><title>${esc(t("px.key.first"))}: ${q.d} AU, V ${num(q.m50, 2)}</title></circle>`;
    }
  }
  // our limits (pooled over the strips, per distance)
  const rows = (S.limits.pooled || []).filter((q) => q.d > 0 && q.d >= d0 && q.d <= d1).sort((a, b) => a.d - b.d);
  for (const [key, dash] of [["m50", ""], ["m90", "6 5"]]) {
    const all = pooled(0);
    if (!all || all[key] == null) continue;             // a level that all distances together do not reach is not drawn
    const pts = rows.filter((q) => q[key] != null);
    if (!pts.length) continue;
    const x0 = X(Math.max(d0, rng[0])), x1 = X(Math.min(d1, rng[1]));
    // level from all distances pooled (the limit does not depend on distance within the errors), dots = each distance
    if (all && all[key] != null) s += `<line x1="${x0}" x2="${x1}" y1="${Y(all[key])}" y2="${Y(all[key])}" stroke="${C.lim}" stroke-width="2.4" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`;
    for (const q of pts) s += `<circle cx="${X(q.d)}" cy="${Y(q[key])}" r="4.2" fill="${dash ? "#070a13" : C.lim}" stroke="${C.lim}" stroke-width="2"><title>${q.d} AU: V ${num(q[key], 2)}</title></circle>`;
  }
  const all = pooled(0);
  if (all && all.m50 != null) {
    s += `<text class="lbl" x="${W - R - 6}" y="${Y(all.m50) - (firstShown ? 16 : 9)}" text-anchor="end" style="fill:${C.lim}">${esc(t("px.chart.found"))}</text>`;
    s += `<text x="${W - R - 6}" y="${Y(all.m50) + 18}" text-anchor="end">${esc(t("px.chart.missed"))}</text>`;
  }
  // predicted distance of each searched strip
  for (const f of S.fields) s += `<path d="M${X(f.r_au)} ${H - B} l-5 -9 h10 z" fill="#eef1f8" opacity=".8"><title>${esc(f.name)}: ${num(f.r_au, 0)} AU</title></path>`;
  s += "</svg>";
  $("pxChart").innerHTML = s;
  $("pxChartKey").innerHTML = [
    `<li><i style="border-color:${C.hi}"></i>${esc(t("px.key.hi"))}</li>`,
    `<li><i style="border-color:${C.mid}"></i>${esc(t("px.key.mid"))}</li>`,
    `<li><i style="border-color:${C.lo}"></i>${esc(t("px.key.lo"))}</li>`,
    `<li><i style="border-color:${C.lim}"></i>${esc(t("px.key.m50"))}</li>`,
    all && all.m90 != null ? `<li><i class="dash" style="border-color:${C.lim}"></i>${esc(t("px.key.m90"))}</li>` : "",
    firstShown ? `<li><i style="border-color:${C.lim};border-top-width:1px;opacity:.7"></i>${esc(t("px.key.first"))}</li>` : "",
    `<li><i class="band" style="background:rgba(127,212,255,.25)"></i>${esc(t("px.key.pred"))}</li>`,
  ].join("");
  const pl = S.limits.plateau;
  $("pxChartCap").textContent = (all && all.m90 != null
    ? t("px.chart.cap", { m50: num(all.m50, 1), m90: num(all.m90, 1), n: S.limits.n_bodies, f: S.totals.n_fields })
    : t("px.chart.cap50", { m50: all ? num(all.m50, 1) : "–", n: S.limits.n_bodies, f: S.totals.n_fields,
      pl: pl ? num(100 * pl.found / Math.max(pl.n, 1), 0) : "–", pm: pl ? num(pl.mag, 1) : "–" }))
    + (firstShown ? " " + t("px.chart.capFirst", { m50: num(FL.m50, 1), n: FL.n_bodies, d1: FL.distance_range_au[0], d2: FL.distance_range_au[1] }) : "");
}

// ------------------------------------------------------------------------------------------- map
function renderMap() {
  const cp = compact();
  const W = cp ? 400 : 760, H = cp ? 300 : 330, L = cp ? 38 : 60, R = 14, T = 14, B = 40;
  const X = (lon) => L + lon / 360 * (W - L - R);
  const Y = (lat) => T + (45 - lat) / 90 * (H - T - B);
  const hw = S.prediction.band_half_width_deg;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("px.map.aria"))}">`;
  for (let lat = -30; lat <= 30; lat += 15) s += `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(lat)}" y2="${Y(lat)}"/><text x="${L - 7}" y="${Y(lat) + 4}" text-anchor="end">${lat > 0 ? "+" : ""}${lat}°</text>`;
  for (let lon = 0; lon <= 360; lon += cp ? 120 : 60) s += `<line class="gr" y1="${T}" y2="${H - B}" x1="${X(lon)}" x2="${X(lon)}"/><text x="${X(lon)}" y="${H - B + 16}" text-anchor="middle">${lon}°</text>`;
  s += `<line class="ax" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>`;
  const tr = [...S.orbit_track].sort((a, b) => a[0] - b[0]);
  const up = tr.map((p) => `${X(p[0]).toFixed(1)} ${Y(Math.min(p[1] + hw, 45)).toFixed(1)}`);
  const dn = tr.map((p) => `${X(p[0]).toFixed(1)} ${Y(Math.max(p[1] - hw, -45)).toFixed(1)}`).reverse();
  s += `<path d="M${up.join("L")}L${dn.join("L")}Z" fill="rgba(255, 201, 77, .10)"/>`;
  s += `<path d="M${tr.map((p) => `${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join("L")}" fill="none" stroke="${C.hi}" stroke-width="2"/>`;
  // galactic plane (split where it wraps)
  let seg = [], gp = "";
  const flush = () => { if (seg.length > 1) gp += "M" + seg.join("L"); seg = []; };
  let last = null;
  for (const p of S.galactic_plane) {
    if (last !== null && Math.abs(p[0] - last) > 180) flush();
    if (Math.abs(p[1]) <= 45) seg.push(`${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`); else flush();
    last = p[0];
  }
  flush();
  s += `<path d="${gp}" fill="none" stroke="#a9b3c9" stroke-width="1.2" stroke-dasharray="3 5" opacity=".7"/>`;
  // perihelion / aphelion of the median orbit
  const byR = [...S.orbit_track].sort((a, b) => a[2] - b[2]);
  const peri = byR[0], aph = byR[byR.length - 1];
  s += `<text x="${X(peri[0])}" y="${Y(peri[1] + hw) - 6}" text-anchor="middle">${esc(t("px.map.peri", { r: num(peri[2], 0) }))}</text>`;
  s += `<text x="${Math.max(X(aph[0]), L + 62)}" y="${Y(aph[1] - hw) + 15}" text-anchor="middle">${esc(t("px.map.aph", { r: num(aph[2], 0) }))}</text>`;
  for (const f of S.fields) {
    const x = X(f.ecl_lon), y = Y(f.ecl_lat);
    // a neighbour close on the right: this label goes to the lower left instead of the upper right
    const crowded = S.fields.some((g) => g !== f && X(g.ecl_lon) > x && X(g.ecl_lon) - x < 40);
    s += `<circle cx="${x}" cy="${y}" r="6.5" fill="none" stroke="${C.lim}" stroke-width="2.4"><title>${esc(f.name)}: ${num(f.r_au, 0)} AU</title></circle>`;
    s += crowded ? `<text class="lbl" x="${x - 9}" y="${y + 20}" text-anchor="end">${esc(shortName(f.name))}</text>`
      : `<text class="lbl" x="${x + 10}" y="${y - 8}">${esc(shortName(f.name))}</text>`;
  }
  s += `<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">${esc(t("px.map.x"))}</text>`;
  if (!cp) s += `<text transform="translate(12 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${esc(t("px.map.y"))}</text>`;
  s += "</svg>";
  $("pxMap").innerHTML = s;
  $("pxMapKey").innerHTML = [
    `<li><i style="border-color:${C.hi}"></i>${esc(t("px.mapkey.orbit"))}</li>`,
    `<li><i class="band" style="background:rgba(255,201,77,.3)"></i>${esc(t("px.mapkey.band"))}</li>`,
    `<li><i style="border-color:${C.lim}"></i>${esc(t("px.mapkey.field"))}</li>`,
    `<li><i class="dash" style="border-color:#a9b3c9"></i>${esc(t("px.mapkey.gal"))}</li>`,
  ].join("");
  const T2 = S.totals;
  $("pxMapCap").textContent = t("px.map.cap", {
    area: T2.area_eff_deg2 ? num(T2.area_eff_deg2["350"], 1) : "–", band: num(S.prediction.band_area_deg2, 0),
    pct: T2.band_fraction ? num(100 * T2.band_fraction["350"], 2) : "–",
  });
}

function renderFields() {
  const th = (k) => `<th title="${esc(t(k + ".tip"))}">${esc(t(k))}</th>`;
  const head = `<tr>${["px.f.field", "px.f.r", "px.f.pos", "px.f.exp", "px.f.area", "px.f.depth", "px.f.orph", "px.f.links", "px.f.cand"].map(th).join("")}</tr>`;
  const fp = (S.first_pass && S.first_pass.fields) || [];
  const two = (f, k) => { const a = fp.find((q) => q.name === f.name); return a ? `${a[k]} → ${f[k]}` : `${f[k]}`; };
  const cand = (f) => { const a = fp.find((q) => q.name === f.name); return (a ? `${a.n_candidates} / ${a.n_confirmed} → ` : "") + `${f.n_candidates} / ${f.n_confirmed}`; };
  const rows = S.fields.map((f) => `<tr><td>${esc(f.name)}</td><td>${num(f.r_au, 0)}</td>
    <td>${num(f.ra, 2)}°, ${f.dec >= 0 ? "+" : "−"}${num(Math.abs(f.dec), 2)}°</td><td>${f.n_exposures.join(" / ")}</td>
    <td>${f.area_eff_deg2 ? num(f.area_eff_deg2["350"], 2) : "–"}</td><td>${f.depth_ab.map((v) => num(v, 1)).join(" / ")}</td>
    <td>${f.n_orphans.join(" / ")}</td><td>${two(f, "n_links")}</td><td>${cand(f)}</td></tr>`).join("");
  $("pxFields").innerHTML = head + rows;
  $("pxFieldsNote").textContent = t("px.f.note") + (fp.length ? " " + t("px.f.note2") : "");
}

// ------------------------------------------------------------------------------------------- result
function candHtml(c) {
  const snr = c.positions.map((p) => num(p.snr, 1)).join(" / ");
  let h = `<div class="px-cand"><h3>${esc(shortName(c.field))}: ${num(c.distance_au, 0)} AU<span class="px-tag">${esc(t(c.confirmed ? "px.cand.conf" : "px.cand.notconf"))}</span></h3>`;
  h += `<p>${esc(t("px.cand.what", { d: num(c.distance_au, 1), e: num(c.err_distance_au, 1), snr, fap: num(c.false_link_probability, 3), mag: num(c.mag_ab, 1) }))}</p>`;
  const why = [];
  const tt = c.tests, ts = c.tests_seasons || [];
  if (c.snr_on_track_total != null && (!tt || tt.v1_one_track === false)) why.push(t("px.cand.v1", { a: num(c.snr_on_track_total, 1), b: num(c.snr_expected_one_body, 0) }));
  if (tt && tt.v2_moves === false) why.push(t("px.cand.v2", { mu: num(c.motion_arcsec_yr, 0), e: num(c.err_motion_arcsec_yr, 0), circ: num(c.circular_arcsec_yr, 0) }));
  if (tt && tt.v3_persistent === false) {
    const w = ts.filter((q) => q.snr_without_two_best_visits != null && q.snr_without_two_best_visits < 0.5 * q.snr)[0];
    if (w) why.push(t("px.cand.v3", { season: w.season, a: num(w.snr, 1), b: num(w.snr_without_two_best_visits, 1) }));
  }
  if (!tt && c.failed_checks && c.failed_checks.length) why.push(t("px.cand.rule", { n: c.failed_checks.length }));
  const cat = c.catalogues || [];
  if (cat.length) {
    const checked = cat.every((q) => ["gaia_dr3", "2mass", "allwise", "catwise2020"].every((k) => q.nearest_arcsec[k + "_checked"]));
    const near = cat.map((q) => Math.min(...["gaia_dr3", "2mass", "allwise", "catwise2020"].map((k) => (q.nearest_arcsec[k] == null ? 1e9 : q.nearest_arcsec[k]))));
    const nNear = near.filter((v) => v < 15).length;
    if (checked) why.push(t(nNear ? "px.cand.catSome" : "px.cand.catNone", { n: nNear, m: cat.length, r: num(Math.min(...near), 0) }));
    else why.push(t("px.cand.catOpen"));
    if (cat.every((q) => q.skybot_checked)) {
      const sb = Math.min(...cat.map((q) => (q.skybot_nearest_arcsec == null ? 1e9 : q.skybot_nearest_arcsec)));
      why.push(t("px.cand.sso", { r: sb > 1e8 ? "–" : num(sb, 0) }));
    }
  }
  h += `<p><b>${esc(t("px.cand.why"))}</b> ${why.map(esc).join(" ")}</p></div>`;
  return h;
}

// a candidate of the second pass: reported as it is, with the checks it still fails
function candHtml2(c) {
  const snr = c.positions.map((p) => num(p.snr, 1)).join(" / ");
  let h = `<div class="px-cand"><h3>${esc(shortName(c.field))}: ${num(c.distance_au, 0)} AU<span class="px-tag">${esc(t(c.confirmed ? "px.cand.conf" : "px.cand.notconf"))}</span></h3>`;
  h += `<p>${esc(t("px.cand.what", { d: num(c.distance_au, 1), e: num(c.err_distance_au, 1), snr, fap: num(c.false_link_probability, 3), mag: num(c.mag_ab, 1) }))}</p>`;
  const why = [];
  const tt = c.tests, ts = c.tests_seasons || [];
  if (tt && tt.v3_persistent === false) {
    const w = ts.filter((q) => q.snr_without_two_best_visits != null && q.snr_without_two_best_visits < 0.5 * q.snr)[0];
    if (w) why.push(t("px.cand.v3", { season: w.season, a: num(w.snr, 1), b: num(w.snr_without_two_best_visits, 1) }));
  }
  if (c.failed_checks && c.failed_checks.length) why.push(t("px.cand.rule", { n: c.failed_checks.length }));
  h += `<p>${why.map(esc).join(" ")}</p></div>`;
  return h;
}

function renderResult() {
  const T = S.totals, FP = S.first_pass;
  const R1 = FP || T;                                   // the pass whose rules were fixed before the search
  const pass = R1.n_candidates_passing_vetting || 0;
  $("pxResult").textContent = (FP ? t("px.res.p1") + " " : "") + t(R1.n_candidates ? "px.res.text" : "px.res.none", {
    f: T.n_fields, links: R1.n_links, c: R1.n_candidates, conf: R1.n_confirmed, pass, n: S.detector.n_randomised,
  });
  let cands = (FP ? FP.candidates : S.candidates).map(candHtml).join("");
  if (R1.n_candidates > 1) cands += `<p class="fine" style="margin:12px 0 0">${esc(t("px.res.note"))}</p>`;
  if (FP && S.candidates.length) cands += `<p style="margin:14px 0 0">${esc(t("px.res.p2.some", { links: T.n_links, c: T.n_candidates, f: T.n_fields }))}</p>` + S.candidates.map(candHtml2).join("");
  $("pxCands").innerHTML = cands;
  const ti = S.vetting_tests_on_injected || [];
  let note = FP && !S.candidates.length ? t(T.n_links ? "px.res.p2.none" : "px.res.p2.none0", {
    links: T.n_links, f: T.n_fields, p: ti.reduce((a, q) => a + q.pass_all, 0), n: ti.reduce((a, q) => a + q.n_linked, 0),
    exp: num(T.chance_links_expected, 1), links1: FP.n_links, exp1: num(FP.chance_links_expected, 1),
  }) : "";
  // links that are not candidates are shown as they are
  if (note) for (const q of S.links_not_candidates || []) {
    note += " " + t("px.res.p2.link", {
      field: shortName(q.field), d: num(q.distance_au, 0), e: num(q.err_distance_au, 0), snr: q.snr.map((v) => num(v, 1)).join(" / "),
      mag: num(q.mag_ab, 1), pct: num(100 * q.false_link_probability, 0),
    });
  }
  // the second look at that link (new strip centred on it; test and decision written down before the data were read)
  const FU = S.followup;
  if (note && FU) {
    const j = (a) => a.map((v) => num(v, 1)).join(" / ");
    note += " " + t("px.fu." + FU.decision, {
      n: FU.n_strips, mb: num(FU.bytes / 1e6, 0), e1: j(FU.all.expected_snr_if_real), f1: j(FU.all.forced_snr),
      ni: FU.independent.n_exposures.reduce((a, b) => a + b, 0), f2: j(FU.independent.forced_snr), e2: j(FU.independent.expected_snr_if_real),
      pct: num(100 * FU.independent.p_combined, 0),
    });
  }
  $("pxResNote").textContent = note;
  const all = pooled(0);
  const area = T.area_eff_deg2 ? T.area_eff_deg2["350"] : null;
  const pl = S.limits.plateau;
  const rng = S.limits.distance_range_au || [250, 1000];
  let up = all && all.m50 != null ? t(all.m90 != null ? "px.upper" : "px.upper50", {
    m50: num(all.m50, 1), m90: num(all.m90, 1), d1: rng[0], d2: rng[1], f: T.n_fields, area: num(area, 1),
    pl: pl ? num(100 * pl.found / Math.max(pl.n, 1), 0) : "–",
  }) : "";
  const FL = FP && FP.limits;
  if (up && FL && FL.m50 != null && FL.distance_range_au) {
    up += " " + t("px.upper.first", {
      m50: num(FL.m50, 1), d1: FL.distance_range_au[0], d2: FL.distance_range_au[1], n: FL.n_bodies,
      pl: FL.plateau ? num(100 * FL.plateau.found / Math.max(FL.plateau.n, 1), 0) : "–",
    });
  }
  $("pxUpper").textContent = up;
}

// ------------------------------------------------------------------------------------------- injections
function renderInj() {
  const cells = S.injections || [];
  const fields = S.fields.map((f) => f.name);
  const keys = [...new Set(cells.map((c) => `${c.d}|${c.mag}`))].map((k) => k.split("|").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let h = `<tr><th>${esc(t("px.i.d"))}</th><th>${esc(t("px.i.mag"))}</th>${fields.map((f) => `<th>${esc(shortName(f))}</th>`).join("")}<th>${esc(t("px.i.all"))}</th><th>${esc(t("px.i.conf"))}</th></tr>`;
  for (const [d, m] of keys) {
    let rec = 0, n = 0, conf = 0;
    const tds = fields.map((f) => {
      const c = cells.find((q) => q.field === f && q.d === d && q.mag === m);
      if (!c) return "<td>–</td>";
      rec += c.recovered; n += c.n; conf += c.confirmed;
      return `<td>${c.recovered}/${c.n}</td>`;
    }).join("");
    h += `<tr><td>${d}</td><td>${num(m, 1)}</td>${tds}<td><b>${rec}/${n}</b> (${num(100 * rec / Math.max(n, 1), 0)} %)</td><td>${conf}/${n}</td></tr>`;
  }
  $("pxInj").innerHTML = h;
  const L = S.limits, fl = (L.flat || []).find((q) => q.field === "ALL" && q.d === 0);
  const ol = L.other_links || {};
  const FP = S.first_pass;
  if (FP) {
    const FL = FP.limits || {}, SC = FP.same_cells || {};
    const only = (FL.distances_one_strip || []).concat(FL.distances_all_strips || []).filter((d) => !cells.some((c) => c.d === d)).sort((a, b) => a - b);
    const m1 = only.map((d) => { const q = (FL.pooled || []).find((x) => x.d === d); return q && q.m50 != null ? num(q.m50, 1) : "–"; });
    const parts = [
      t("px.inj.n2", { n: L.n_bodies, cells: L.n_cells, da: (L.distances_all_strips || []).join(", "), f: S.totals.n_fields }),
      (L.distances_one_strip || []).length ? t("px.inj.one", { d1: L.distances_one_strip.join(", ") }) : "",
      t("px.inj.other", { mixed: ol.mixed ?? "–", bg: ol.background_only ?? "–", derr: num(L.distance_err_median_au, 1) }),
      SC.n_cells ? t("px.inj.same", { cc: SC.n_cells, cb: SC.n_bodies, b2: SC.found_second, b1: SC.found_first, cw: SC.cells_second_worse }) : "",
      only.length ? t("px.inj.firstonly", { d1: only.join(", "), m1: m1.join(" / ") }) : "",
      t("px.inj.flat", { flat: FL.flat_m50 != null ? num(FL.flat_m50, 1) : "–", before: num(S.before.m50_ab_flat, 1) }),
    ];
    $("pxInjNote").textContent = parts.filter(Boolean).join(" ");
    return;
  }
  $("pxInjNote").textContent = t("px.inj.note", {
    n: L.n_bodies, cells: L.n_cells, other: L.other_candidates_in_injected_runs, f: S.totals.n_fields,
    known: ol.known_real ?? "–", mixed: ol.mixed ?? "–", bg: ol.background_only ?? "–",
    da: (L.distances_all_strips || []).join(", "), d1: (L.distances_one_strip || []).join(", "),
    derr: num(L.distance_err_median_au, 1), flat: fl && fl.m50 != null ? num(fl.m50, 1) : "–", before: num(S.before.m50_ab_flat, 1),
  });
}

// ------------------------------------------------------------------------------------------- run 2 (one line; EN/TR text lives in data/planetx/run2.json)
let R2 = null;
function renderRun2() {
  const L = R2 && R2.site_line;
  let el = $("pxRun2");
  if (!L) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement("p"); el.id = "pxRun2"; el.className = "crit"; $("pxUpper").after(el); }
  const links = L.links || {};
  el.innerHTML = esc(L[lang()] || L.en).replace(/\{(\w+)\}/g, (m, k) => (links[k] ? `<a href="${esc(links[k].url)}" rel="noopener">${esc(links[k].label)}</a>` : m));
}

// ------------------------------------------------------------------------------------------- 10,400-body injection test
// Added after the run 2 pre-registration (data/planetx/inject10k.json, pipeline/planetx_inject10k_summary.py; EN/TR text in that file).
let I10 = null;
function i10Links(s) {
  const links = (I10 && I10.links) || {};
  return esc(s).replace(/\{(\w+)\}/g, (m, k) => (links[k] ? `<a href="${esc(links[k].url)}" rel="noopener">${esc(links[k].label)}</a>` : ""));
}
function renderI10() {
  const sec = $("inj10k");
  const T = I10 && I10.site_text && (I10.site_text[lang()] || I10.site_text.en);
  let line = $("pxI10Line");
  if (!T || !sec) { if (sec) sec.hidden = true; if (line) line.remove(); return; }
  sec.hidden = false;
  $("i10Title").innerHTML = `${esc(T.h)}<span class="px-tag">${esc(T.tag)}</span>`;
  $("pxI10Sub").innerHTML = i10Links(T.sub);
  if (!line) { line = document.createElement("p"); line.id = "pxI10Line"; line.className = "crit"; ($("pxRun2") || $("pxUpper")).after(line); }
  line.innerHTML = i10Links(T.line + " " + (I10.links && I10.links.res ? T.line_links : T.line_links_plan));
  // completeness curve: found fraction per V, this test against the 1128 bodies of runs 1 and 2
  const cp = compact();
  const W = cp ? 400 : 760, H = cp ? 320 : 360, L = cp ? 44 : 54, R = cp ? 12 : 24, Tp = 16, B = 48;
  const v0 = 17.3, v1 = 20.45;
  const X = (v) => L + (v - v0) / (v1 - v0) * (W - L - R);
  const Y = (f) => Tp + (1 - f) * (H - Tp - B);
  const old = "#a9b3c9";
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(T.h)}">`;
  for (let f = 0; f <= 1.0001; f += 0.25) s += `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(f)}" y2="${Y(f)}"/><text x="${L - 7}" y="${Y(f) + 4}" text-anchor="end">${num(100 * f, 0)} %</text>`;
  for (let v = 17.5; v <= 20.01; v += cp ? 1 : 0.5) s += `<line class="gr" y1="${Tp}" y2="${H - B}" x1="${X(v)}" x2="${X(v)}"/><text x="${X(v)}" y="${H - B + 17}" text-anchor="middle">${num(v, 1)}</text>`;
  s += `<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/><line class="ax" x1="${L}" x2="${L}" y1="${Tp}" y2="${H - B}"/>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle">${esc(T.x)}</text>`;
  s += `<text transform="translate(${cp ? 11 : 14} ${(Tp + H - B) / 2}) rotate(-90)" text-anchor="middle">${esc(T.y)}</text>`;
  for (const lv of [0.5, 0.9]) s += `<line x1="${L}" x2="${W - R}" y1="${Y(lv)}" y2="${Y(lv)}" stroke="${C.lim}" stroke-width="1" stroke-dasharray="4 4" opacity=".55"/>`;
  const A = I10.limits.inject10k.all;
  for (const [key, lv] of [["m50", 0.5], ["m90", 0.9]]) {
    if (A[key] == null) continue;
    s += `<line x1="${X(A[key])}" x2="${X(A[key])}" y1="${Y(lv)}" y2="${H - B}" stroke="${C.lim}" stroke-width="1.2" opacity=".7"/>`;
    s += `<text class="lbl" x="${X(A[key]) + (key === "m50" ? 6 : -6)}" y="${Y(lv) - 7}" text-anchor="${key === "m50" ? "start" : "end"}" style="fill:${C.lim}">V ${num(A[key], 2)}</text>`;
  }
  const path = (pts) => pts.filter((p) => p.frac != null).map((p, i) => `${i ? "L" : "M"}${X(p.v).toFixed(1)} ${Y(p.frac).toFixed(1)}`).join("");
  s += `<path d="${path(I10.curve_before)}" fill="none" stroke="${old}" stroke-width="1.3" opacity=".7"/>`;
  for (const p of I10.curve_before) {
    s += `<line x1="${X(p.v)}" x2="${X(p.v)}" y1="${Y(p.lo68)}" y2="${Y(p.hi68)}" stroke="${old}" stroke-width="1.2" opacity=".7"/>`;
    s += `<circle cx="${X(p.v)}" cy="${Y(p.frac)}" r="3.6" fill="#070a13" stroke="${old}" stroke-width="1.4"><title>V ${num(p.v, 2)}: ${p.found}/${p.n}</title></circle>`;
  }
  s += `<path d="${path(I10.curve)}" fill="none" stroke="${C.lim}" stroke-width="2.2"/>`;
  for (const p of I10.curve) {
    s += `<line x1="${X(p.v)}" x2="${X(p.v)}" y1="${Y(p.lo68)}" y2="${Y(p.hi68)}" stroke="${C.lim}" stroke-width="2"/>`;
    s += `<circle cx="${X(p.v)}" cy="${Y(p.frac)}" r="4" fill="${C.lim}"><title>V ${num(p.v, 2)}: ${p.found}/${p.n}</title></circle>`;
  }
  s += "</svg>";
  $("pxI10Chart").innerHTML = s;
  $("pxI10Key").innerHTML = [
    `<li><i style="border-color:${C.lim}"></i>${esc(T.k_new)}</li>`,
    `<li><i style="border-color:${old};border-top-width:1px"></i>${esc(T.k_old)}</li>`,
    `<li><i class="dash" style="border-color:${C.lim};border-top-width:1px"></i>${esc(T.k_lvl)}</li>`,
  ].join("");
  $("pxI10Cap").textContent = T.cap;
}

// ------------------------------------------------------------------------------------------- honest notes, sources
function renderHonest() {
  const T = S.totals, P = S.prediction;
  const hi = S.expected.cases.find((c) => c.key === "hi");
  const items = [
    t("px.hon.measured", { n: S.limits.n_bodies, strips: T.n_strips, mb: num(T.bytes_read / 1e6, 0) })
      + (S.followup ? " " + t("px.hon.fu", { mb2: num(S.followup.bytes / 1e6, 0), n2: S.followup.n_strips, tot: num(T.bytes_all / 1e6, 0), cap: num(T.budget_bytes / 1e6, 0) }) : ""),
    t("px.hon.radius", { m: num(P.mass_earth[0], 1), r: num(P.radius_re, 2) }),
    t("px.hon.albedo"),
    t("px.hon.methane"),
    t("px.hon.area", { area: T.area_eff_deg2 ? num(T.area_eff_deg2["350"], 1) : "–", pct: T.band_fraction ? num(100 * T.band_fraction["350"], 2) : "–" }),
    t("px.hon.depth"),
    t("px.hon.seasons"),
    t("px.hon.cand"),
    ...(S.first_pass ? [t("px.hon.second")] : []),
    t("px.hon.git"),
    t("px.hon.old", { before: num(S.before.m50_ab_flat, 1), n: S.before.exposures_per_season, d: hi.d_reach_m50_au != null ? num(hi.d_reach_m50_au, 0) : "–" }),
  ];
  $("pxHonest").innerHTML = items.map((x) => `<li>${esc(x)}</li>`).join("");
  const src = ["px.src.bb21", "px.src.b19", "px.src.f16", "px.src.wl13", "px.src.w18", "px.src.spherex", "px.src.cats", "px.src.skybot", "px.src.code"];
  $("pxSources").innerHTML = src.map((k) => `<li>${t(k)}</li>`).join("");
}

// ------------------------------------------------------------------------------------------- boot
function renderAll() {
  apply(document);
  document.title = t("px.title");
  if (!S) { $("pxAnswer").textContent = t("px.noData"); return; }
  renderAnswer(); renderTiles(); renderJump(); renderChart(); renderMap(); renderFields(); renderResult(); renderRun2(); renderI10(); renderRun3(); renderInj(); renderHonest();
}

$("langSlot").appendChild(langButton("fz-lang"));
let wasCompact = compact();
window.addEventListener("resize", () => { if (S && compact() !== wasCompact) { wasCompact = compact(); renderChart(); renderMap(); renderI10(); } });
onLang(() => { document.documentElement.lang = lang(); renderAll(); });
document.documentElement.lang = lang();
// The 10,400-body test shows only with ?extra=1 until the team lead has read it (15 Nov 2026); drop the condition to show it.
const I10_ON = new URLSearchParams(location.search).get("extra") === "1";
[S, R2, I10, R3] = await Promise.all([get("data/planetx/summary.json"), get("data/planetx/run2.json"), I10_ON ? get("data/planetx/inject10k.json") : null,
  get("data/planetx/run3.json")]);
renderAll();
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();

// ------------------------------------------------------------------------------------------- run 3 (one line under the run-2 line)
// data/planetx/run3.json (pipeline/planetx_run3_summary.py); its EN/TR text lives in that file. Shown to everyone since
// 15 Nov 2026 (team lead's decision); it is called from renderAll().
function renderRun3() {
  const L = R3 && R3.site_line;
  let el = $("pxRun3");
  if (!L || !S) { if (el) el.remove(); return; }
  const prev = $("pxRun2") || $("pxUpper");
  if (!el) { el = document.createElement("p"); el.id = "pxRun3"; el.className = "crit"; }
  if (el.previousElementSibling !== prev) prev.after(el);
  const links = L.links || {};
  el.innerHTML = esc(L[lang()] || L.en).replace(/\{(\w+)\}/g, (m, k) => (links[k] ? `<a href="${esc(links[k].url)}" rel="noopener">${esc(links[k].label)}</a>` : m));
}
