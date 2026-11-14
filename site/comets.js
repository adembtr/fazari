// Comet showcase page (site/comets.html). Data: data/comets/summary.json and data/comets/<folder>/data.json
// (+ blink_NN.png, stack.png, single.png), written by pipeline/find_comets.py products --site / summary --site.
// Text: site/i18n/{en,tr}.json keys "cm.*"; per-object sentences come with the data (sentence / sentence_tr).
import { t, num, lang, field, onLang } from "./js/i18n.js";

const BASE = "data/comets/";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ok = (v) => v !== null && v !== undefined && !Number.isNaN(Number(v));
const f = (v, d = 1) => (ok(v) ? num(Number(v), d) : "-");

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

let summary = null, cur = null, idx = 0, timer = null, playing = true;
const cache = {};

function kindLabel(k) {
  const map = { "comet": t("cm.kComet", null, "comet"), "periodic comet": t("cm.kPeriodic", null, "periodic comet"),
    "interstellar comet": t("cm.kInterstellar", null, "interstellar comet"), "dwarf planet": t("cm.kDwarf", null, "dwarf planet, not a comet") };
  return map[k] || k;
}

function tabs() {
  $("tabs").innerHTML = summary.objects.map((o) =>
    `<button type="button" data-f="${esc(o.folder)}" aria-pressed="${cur && cur._folder === o.folder}">${esc(o.name)}${o.kind === "dwarf planet" ? `<span class="k">(${esc(t("cm.kDwarfShort", null, "dwarf planet"))})</span>` : ""}</button>`).join("");
  for (const b of $("tabs").querySelectorAll("button")) b.onclick = () => show(b.dataset.f);
}

function stat(label, value) { return `<div class="stat"><span>${label}</span><b>${value}</b></div>`; }

function renderStats(d) {
  const o = d.offset_arcsec || {}, m = d.motion, c = d.coma;
  const seasons = (d.seasons || []).map((s) => s.start === s.end ? s.start : `${s.start} &ndash; ${s.end}`).join("<br>");
  let s = "";
  s += stat(t("cm.sExp", null, "SPHEREx exposures used"), `${d.n_exposures}`);
  s += stat(t("cm.sDet", null, "clearly detected (S/N &ge; 5)"), `${d.n_detected}`);
  s += stat(t("cm.sSeasons", null, "dates"), seasons);
  s += stat(t("cm.sLam", null, "wavelengths covered"), d.lam_range_um ? `${f(d.lam_range_um[0], 2)}&ndash;${f(d.lam_range_um[1], 2)} &micro;m` : "-");
  s += stat(t("cm.sMag", null, "predicted magnitude (JPL, total)"), d.T_mag_horizons ? `${f(d.T_mag_horizons[0])}&ndash;${f(d.T_mag_horizons[1])}` : "-");
  s += stat(t("cm.sDist", null, "distance from Sun / from us"), `${f(d.r_au[0], 2)} / ${f(d.delta_au[0], 2)} AU`);
  s += stat(t("cm.sSnr", null, "signal-to-noise per image (median / best)"), `${f(d.snr_median, 0)} / ${f(d.snr_max, 0)}`);
  s += stat(t("cm.sOff", null, "measured minus predicted position (median)"), o.median != null ? `${f(o.median, 1)}&Prime; <small>(${f(o.median / 6.15, 2)} ${t("cm.px", null, "px")})</small>` : "-");
  s += stat(t("cm.sRate", null, "speed across the sky (JPL)"), `${f(m ? m.speed_ephem : d.rate_ephem_arcsec_h, 1)}&Prime;/h`);
  if (m) s += stat(t("cm.sRateM", null, "speed we measured / difference"), `${f(m.speed_measured, 1)}&Prime;/h / ${Math.abs(100 * m.speed_diff_frac_median) < 0.01 ? "&lt; " + num(0.01, 2) : f(100 * m.speed_diff_frac_median, 2)} %`);
  if (c) s += stat(t("cm.sComa", null, "coma wider than a star"), c.extended ? `<span class="yes">${t("cm.yes", null, "yes")}</span>, ${f(c.significance_sigma, 0)}&sigma;` : `${t("cm.no", null, "no")} (${f(c.significance_sigma, 1)}&sigma;)`);
  $("stats").innerHTML = s;
}

function drawFrame() {
  const b = cur && cur.blink;
  if (!b) return;
  const fr = b.frames[idx];
  const n = b.grid.size_px * b.grid.upscale;
  $("frame").src = cur._base + fr.file;
  const ov = $("ov");
  ov.setAttribute("viewBox", `0 0 ${n} ${n}`);
  let s = "";
  if ($("marks").checked) {
    const r = 2.2 * b.grid.upscale * 6.15 / b.grid.pixel_arcsec;
    if (fr.ephemeris_xy) s += `<circle cx="${fr.ephemeris_xy[0]}" cy="${fr.ephemeris_xy[1]}" r="${r}" fill="none" stroke="#ffb347" stroke-width="${n / 300}"/>`;
    if (fr.measured_xy) {
      const [x, y] = fr.measured_xy, dd = 1.3 * r;
      s += `<path d="M${x - dd} ${y}h${dd * 0.55}M${x + dd * 0.45} ${y}h${dd * 0.55}M${x} ${y - dd}v${dd * 0.55}M${x} ${y + dd * 0.45}v${dd * 0.55}" stroke="#5dd3ff" stroke-width="${n / 300}"/>`;
    }
  }
  ov.innerHTML = s;
  $("hud").innerHTML = `<b>${idx + 1} / ${b.frames.length}</b> &middot; ${esc(fr.utc)} UTC &middot; ${f(fr.lam_um, 2)} &micro;m &middot; D${esc(fr.detector)}`;
}

function step(dl) { const n = cur.blink.frames.length; idx = (idx + dl + n) % n; drawFrame(); }
function schedule() {
  clearInterval(timer);
  if (playing && cur && cur.blink) timer = setInterval(() => step(1), Number($("speed").value));
}

function spectrumChart(d) {
  const sp = d.spectrum, svg = $("spec");
  if (!sp) { svg.innerHTML = ""; $("specNote").textContent = t("cm.noSpec", null, "Too few wavelengths in one season for a spectrum."); $("feats").innerHTML = ""; return; }
  const W = 760, H = 320, L = 58, R = 14, T = 14, B = 42;
  const pts = sp.points;
  const vals = pts.flatMap((p) => [p.refl - p.err, p.refl + p.err, p.model]).filter((v) => v > 0);
  const big = Math.max(...vals) / Math.min(...pts.map((p) => p.refl).filter((v) => v > 0)) > 12;   // log axis for strong gas bands
  const x0 = 0.7, x1 = 5.0;
  let y0 = big ? Math.log10(Math.max(0.05, Math.min(...vals) * 0.8)) : Math.min(0, Math.min(...vals));
  let y1 = big ? Math.log10(Math.max(...vals) * 1.3) : Math.max(...vals) * 1.08;
  const tr = (v) => (big ? Math.log10(Math.max(v, 1e-3)) : v);
  const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - R);
  const Y = (v) => H - B - (tr(v) - y0) / (y1 - y0) * (H - T - B);
  let s = "";
  for (const ft of sp.features) {
    s += `<rect x="${X(ft.lo)}" y="${T}" width="${X(ft.hi) - X(ft.lo)}" height="${H - T - B}" fill="${ft.significant ? "rgba(143,209,143,.18)" : "rgba(255,255,255,.05)"}"/>`;
  }
  s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#3a4258"/><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#3a4258"/>`;
  for (let v = 1; v <= 5; v++) s += `<line x1="${X(v)}" y1="${H - B}" x2="${X(v)}" y2="${H - B + 4}" stroke="#3a4258"/><text x="${X(v)}" y="${H - B + 17}" text-anchor="middle">${v}</text>`;
  const ticks = [];
  if (big) { for (let e = Math.floor(y0); e <= y1; e++) for (const m of [1, 3]) { const v = m * 10 ** e; if (Math.log10(v) >= y0 && Math.log10(v) <= y1) ticks.push(v); } }
  else { const st = niceStep((y1 - y0) / 5); for (let v = Math.ceil(y0 / st) * st; v <= y1; v += st) ticks.push(v); }
  for (const v of ticks) s += `<line x1="${L - 4}" y1="${Y(v)}" x2="${W - R}" y2="${Y(v)}" stroke="#20263a"/><text x="${L - 7}" y="${Y(v) + 4}" text-anchor="end">${num(v, v < 1 ? 1 : 0)}</text>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">${esc(t("cm.axLam", null, "wavelength (µm)"))}</text>`;
  s += `<text transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${esc(t("cm.axRefl", null, "brightness / sunlight (1 at 1.0–1.6 µm)"))}</text>`;
  if (big) s += `<text x="${W - R - 4}" y="${T + 12}" text-anchor="end">${esc(t("cm.logAxis", null, "logarithmic scale"))}</text>`;
  const ord = [...pts].sort((a, b) => a.lam - b.lam);
  s += `<polyline fill="none" stroke="#8fd18f" stroke-width="1.5" stroke-dasharray="5 4" points="${ord.map((p) => `${X(p.lam)},${Y(p.model)}`).join(" ")}"/>`;
  for (const p of pts) {
    s += `<line x1="${X(p.lam)}" y1="${Y(Math.max(p.refl - p.err, big ? 10 ** y0 : -1e9))}" x2="${X(p.lam)}" y2="${Y(p.refl + p.err)}" stroke="#5dd3ff" stroke-width="1.2"/>`;
    s += `<circle cx="${X(p.lam)}" cy="${Y(p.refl)}" r="3.4" fill="#5dd3ff"><title>${num(p.lam, 3)} µm: ${num(p.flux_ujy / 1000, 1)} ± ${num(p.flux_err_ujy / 1000, 1)} mJy</title></circle>`;
  }
  svg.innerHTML = s;
  if (d.kind === "dwarf planet") {
    $("specNote").innerHTML = t("cm.specNotePluto", { n: sp.n, a: sp.season[0], b: sp.season[1], chi: num(sp.error_scale ?? 1, 1) },
      `${sp.n} images from ${sp.season[0]} to ${sp.season[1]}. Each blue point is one image (a 12.3″ circle, stars of other dates subtracted), divided by sunlight and set to 1 at 1.0–1.6 µm. Dashed: a straight line through the points outside the methane-ice bands. Error bars: image noise plus 5 %; feature tests widened ${num(sp.error_scale ?? 1, 1)}×.`);
  } else $("specNote").innerHTML = t("cm.specNote", { n: sp.n, a: sp.season[0], b: sp.season[1], r: num(sp.r_au, 2), chi: num(sp.error_scale ?? 1, 1) },
    `${sp.n} images from ${sp.season[0]} to ${sp.season[1]} (comet ${num(sp.r_au, 2)} AU from the Sun). Each blue point is one image, a 12.3″ circle around the comet with the stars of other dates subtracted, divided by sunlight (a 5778 K blackbody) and set to 1 at 1.0–1.6 µm. Error bars: noise of the image plus 5 %. Dashed: smooth dust model (reflected sunlight with a slope, plus warm dust above 3 µm). The points scatter ${num(sp.error_scale ?? 1, 1)}× more than their error bars around it, so every feature test below is widened by that factor.`);
  $("feats").innerHTML = sp.features.map((ft) => {
    const nm = field(ft, "name");
    if (!ft.covered) return `<li>${esc(nm)}: ${esc(t("cm.fNone", null, "no image at this wavelength"))}</li>`;
    const sig = `${num(ft.sigma, 1)}σ (${ft.n} ${esc(ft.n === 1 ? t("cm.img1", null, "image") : t("cm.imgN", null, "images"))})`;
    if (ft.significant) return `<li><span class="yes">${esc(nm)}</span>: ${esc(ft.sigma > 0 ? t("cm.fYes", null, "brighter than the dust model by") : t("cm.fAbs", null, "fainter than the smooth model (absorption) by"))} ${sig}</li>`;
    const why = Math.abs(ft.sigma) < 5 ? t("cm.fNo", null, "not significant")
      : ft.n < 2 ? t("cm.fOne", null, "a single image only: not claimed")
      : t("cm.fSide", null, "no image on one side of the band: not claimed");
    return `<li>${esc(nm)}: ${sig}, ${esc(why)}</li>`;
  }).join("");
}

function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x)); const m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }

function measTable(d) {
  const head = `<tr><th class="l">UTC</th><th class="l">${esc(t("cm.tExp", null, "exposure"))}</th><th>D</th><th>&lambda; &micro;m</th><th>${esc(t("cm.tPred", null, "JPL mag"))}</th><th>S/N</th><th>${esc(t("cm.tFlux", null, "flux mJy"))}</th><th>${esc(t("cm.tOff", null, "offset"))}</th><th>${esc(t("cm.tRef", null, "refs"))}</th></tr>`;
  $("meas").innerHTML = head + d.measurements.map((m) => `<tr><td class="l">${esc(m.utc)}</td><td class="l">${esc(m.obs_id)}</td><td>${m.det}</td><td>${f(m.lam_um, 3)}</td><td>${f(m.T, 1)}</td><td>${f(m.snr, 0)}</td>
    <td>${ok(m.flux_ujy) ? `${f(m.flux_ujy / 1000, 2)} &plusmn; ${f(m.flux_err_ujy / 1000, 2)}` : "-"}</td><td>${ok(m.off_arcsec) ? f(m.off_arcsec, 1) + "&Prime;" : "-"}</td><td>${m.n_ref ?? "-"}</td></tr>`).join("");
}

async function show(folder, frame = 0) {
  if (!cache[folder]) {
    const d = await getJSON(BASE + encodeURIComponent(folder) + "/data.json");
    d._base = BASE + encodeURIComponent(folder) + "/";
    d._folder = folder;
    cache[folder] = d;
    if (d.blink) for (const fr of d.blink.frames) { const im = new Image(); im.src = d._base + fr.file; }
  }
  cur = cache[folder];
  idx = Math.min(frame, cur.blink ? cur.blink.frames.length - 1 : 0);
  render();
  const u = new URL(location.href); u.searchParams.set("c", folder); history.replaceState(null, "", u);
}

function render() {
  if (!summary) return;
  tabs();
  if (!cur) return;
  const d = cur;
  $("obj").hidden = false;
  $("oname").innerHTML = `${esc(d.name)} <span class="kind${d.kind === "dwarf planet" ? " dwarf" : ""}">${esc(kindLabel(d.kind))}</span>`;
  $("osent").textContent = field(d, "sentence");
  renderStats(d);
  const b = d.blink;
  if (b) {
    $("cap").innerHTML = t("cm.blinkCap", { n: b.frames.length, h: num(b.span_h, b.span_h < 1 ? 2 : 1), m: num(b.moved_arcsec, 0), px: num(b.grid.pixel_arcsec, 0) },
      `${b.frames.length} SPHEREx images taken over ${num(b.span_h, b.span_h < 1 ? 2 : 1)} h, aligned on the sky: the stars stay put, the comet moves ${num(b.moved_arcsec, 0)}″. North up, east left, ${num(b.grid.pixel_arcsec, 0)}″ grid (a SPHEREx pixel is 6.15″). Each image is at its own wavelength, so star and comet brightness change from frame to frame.`);
  } else $("cap").textContent = "";
  const st = d.stack;
  $("stack").src = d._base + st.file;
  $("single").src = d._base + st.single;
  $("stackCap").innerHTML = t("cm.stackCap", { n: st.n_frames }, `${st.n_frames} images shifted to follow the comet and averaged, after subtracting the same sky on other dates (the comet was elsewhere then). Stars cancel, the comet adds up. 4′ × 4′, north up.`);
  $("singleCap").innerHTML = t("cm.singleCap", null, "The best single image, same processing and same scale.");
  const c = d.coma;
  $("comaNote").innerHTML = c ? t("cm.comaNote", { rc: num(c.ratio_comet, 2), rs: num(c.ratio_stars, 2), s: num(c.significance_sigma, 1), n: c.n_frames },
    `Coma test: light within 24.6″ divided by light within 9.2″ is ${num(c.ratio_comet, 2)} for the comet and ${num(c.ratio_stars, 2)} for stars in the same images (${c.n_frames} images); the difference is ${num(c.significance_sigma, 1)}σ.`) : "";
  spectrumChart(d);
  measTable(d);
  drawFrame();
  schedule();
  $("play").textContent = playing ? t("cm.pause", null, "Pause") : t("cm.play", null, "Play");
}

function candTable() {
  const head = `<tr><th class="l">${esc(t("cm.cName", null, "comet"))}</th><th>${esc(t("cm.cImg", null, "images that contain it"))}</th><th>${esc(t("cm.cSeas", null, "seasons"))}</th><th>${esc(t("cm.cMag", null, "brightest JPL mag"))}</th><th class="l">${esc(t("cm.cRes", null, "result"))}</th></tr>`;
  $("cands").innerHTML = head + summary.candidates.map((c) => `<tr><td class="l">${esc(c.name)}</td><td>${c.n_images}</td><td>${c.n_seasons}</td><td>${f(c.T_min, 1)}</td>
    <td class="l">${c.chosen ? `<span class="yes">${esc(t("cm.shown", null, "shown above"))}</span>` : esc(lang() === "tr" && c.reason_tr ? c.reason_tr : (c.reason || ""))}</td></tr>`).join("");
  const by = summary.bytes || {};
  $("bytes").innerHTML = t("cm.bytes", { mb: num((by.s3 || 0) / 1e6, 1), req: by.s3_requests || 0 },
    `SPHEREx data read for this page: ${num((by.s3 || 0) / 1e6, 1)} MB in ${by.s3_requests || 0} small byte-range requests (never whole files).`);
}

async function main() {
  try {
    summary = await getJSON(BASE + "summary.json");
    candTable();
    const qs = new URLSearchParams(location.search);
    if (qs.has("f")) playing = false;
    const want = qs.get("c");
    const first = summary.objects.find((o) => o.folder === want) || summary.objects[0];
    tabs();
    if (first) await show(first.folder, Number(qs.get("f")) || 0);
  } catch (e) {
    $("tabs").textContent = t("cm.err", null, "Could not load the comet data: ") + e.message;
  }
}

$("play").onclick = () => { playing = !playing; render(); };
$("prev").onclick = () => { playing = false; render(); step(-1); };
$("next").onclick = () => { playing = false; render(); step(1); };
$("speed").onchange = schedule;
$("marks").onchange = drawFrame;
onLang(() => { if (summary) { candTable(); render(); } });
main();
