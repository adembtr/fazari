// Known-asteroid recovery page (site/asteroids.html, this module: site/asteroids.js): summary numbers, per-field table and a small
// blink of one recovered asteroid. Data: data/asteroids/summary.json and data/asteroids/<name>/blink.json
// (written by pipeline/find_asteroids.py report / blink).
const BASE = "data/asteroids/";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? "-" : Number(v).toFixed(d));

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

function stats(s) {
  const t = s.totals || {};
  const o = s.offset_px || {};
  const a = s.offset_arcsec || {};
  const tr = s.tracklets || {};
  const by = [17, 18, 19, 20].map((v) => `<div class="stat"><span>found / known, V &lt; ${v}</span><b>${t["found_v" + v] ?? "-"} / ${t["known_v" + v] ?? "-"}</b></div>`).join("");
  const mb = (s.bytes && s.bytes.s3) ? (s.bytes.s3 / 1e6).toFixed(1) + " MB" : "-";
  $("stats").innerHTML = `
    <div class="stat"><span>fields (ecliptic, |&beta;| &lt; 2&deg;)</span><b>${s.n_fields_ok} / ${s.n_fields}</b></div>
    ${by}
    <div class="stat"><span>single-exposure detections matched</span><b>${s.n_detections}</b></div>
    <div class="stat"><span>offset median / 90 % / worst</span><b>${fmt(o.median)} / ${fmt(o.p90)} / ${fmt(o.max)} px</b></div>
    <div class="stat"><span>&nbsp;&nbsp;in arcsec</span><b>${fmt(a.median, 1)}" / ${fmt(a.p90, 1)}" / ${fmt(a.max, 1)}"</b></div>
    <div class="stat"><span>detections within 1 px</span><b>${fmt(100 * (o.frac_within_1px ?? NaN), 1)} %</b></div>
    <div class="stat"><span>false detections (all fields)</span><b>${s.false_per_field ? s.false_per_field.total : "-"}</b></div>
    <div class="stat"><span>tracklets linked / tried (wrong links)</span><b>${tr.linked ?? "-"} / ${tr.tried ?? "-"} (${(tr.wrong_links || []).length})</b></div>
    <div class="stat"><span>rate vs ephemeris (median)</span><b>${tr.rate_diff_frac_median != null ? fmt(100 * tr.rate_diff_frac_median, 1) + " %" : "-"}, PA ${fmt(tr.pa_diff_deg_median, 1)}&deg;</b></div>
    <div class="stat"><span>data read from S3 (byte ranges)</span><b>${mb}</b></div>`;
  $("gen").textContent = s.generated ? `generated ${s.generated}` : "";
}

function fieldsTable(s) {
  const head = `<tr><th>Field</th><th class="l">Date (UTC)</th><th>Det</th><th>&lambda;<sub>ecl</sub></th><th>&beta;</th><th>b</th>
    <th>V&lt;17</th><th>V&lt;18</th><th>V&lt;19</th><th>V&lt;20</th><th title="visit stack, V&lt;20">stack</th><th>offset med / max px</th><th>false</th><th class="l">faintest recovered</th><th>tracklets</th></tr>`;
  const rows = (s.fields || []).map((r) => {
    if (r.error) return `<tr><td>${esc(r.id)}</td><td class="l" colspan="14">error: ${esc(r.error)}</td></tr>`;
    const fz = r.faintest ? `<span title="H ${fmt(r.faintest.H, 1)}, ${fmt(r.faintest.flux_ujy, 0)} &micro;Jy at ${fmt(r.faintest.lam_um, 2)} &micro;m">${esc(r.faintest.name)} V ${fmt(r.faintest.V, 1)}, ${fmt(r.faintest.flux_ujy, 0)} &micro;Jy</span>` : "-";
    const v = (k) => `${r["found_v" + k]} / ${r["known_v" + k]}`;
    const crowd = r.crowding && r.crowding > 3 ? ` title="crowded field: noise ${fmt(r.crowding, 1)}x the median field"` : "";
    return `<tr${crowd}><td>${esc(r.id)}${crowd ? " *" : ""}</td><td class="l">${esc(r.date)}</td><td>${esc(r.detector)}</td><td>${fmt(r.lam, 0)}&deg;</td><td>${fmt(r.beta, 1)}&deg;</td><td>${fmt(r.gal_b, 0)}&deg;</td>
      <td>${v(17)}</td><td>${v(18)}</td><td>${v(19)}</td><td>${v(20)}</td><td>${r.stack_v20 ?? "-"}</td>
      <td>${fmt(r.off_px_median)} / ${fmt(r.off_px_max)}</td><td>${r.n_false ?? "-"}</td><td class="l">${fz}</td><td>${r.n_tracklets} / ${r.n_tracklet_tried}</td></tr>`;
  }).join("");
  $("fields").innerHTML = head + rows;
  const miss = (s.missed || []).filter((m) => m.V < 19).sort((a, b) => a.V - b.V);
  $("missed").innerHTML = `<tr><th>Field</th><th class="l">Object</th><th>V</th><th>H</th><th class="l">Reason</th></tr>` +
    miss.map((m) => `<tr><td>${esc(m.field)}</td><td class="l">${esc((m.number ? m.number + " " : "") + m.name)}</td><td>${fmt(m.V, 1)}</td><td>${fmt(m.H, 1)}</td><td class="l">${esc(m.reason)}</td></tr>`).join("");
}

let blink = null, idx = 0, timer = null, playing = true;

function draw() {
  if (!blink) return;
  const f = blink.frames[idx];
  const n = blink.grid.size_px * blink.grid.upscale;
  $("frame").src = blink._base + f.file;
  const ov = $("ov");
  ov.setAttribute("viewBox", `0 0 ${n} ${n}`);
  let s = "";
  if ($("marks").checked) {
    if (f.ephemeris_xy) s += `<circle cx="${f.ephemeris_xy[0]}" cy="${f.ephemeris_xy[1]}" r="${2.2 * blink.grid.upscale * 6.15 / blink.grid.pixel_arcsec / 2}" fill="none" stroke="#ffb347" stroke-width="1.5"/>`;
    if (f.detected_xy) {
      const [x, y] = f.detected_xy, d = 1.2 * blink.grid.upscale * 6.15 / blink.grid.pixel_arcsec;
      s += `<path d="M${x - d} ${y}h${d * 0.6}M${x + d * 0.4} ${y}h${d * 0.6}M${x} ${y - d}v${d * 0.6}M${x} ${y + d * 0.4}v${d * 0.6}" stroke="#5dd3ff" stroke-width="1.5"/>`;
    }
  }
  ov.innerHTML = s;
  $("hud").innerHTML = `<b>${esc(f.label)}</b><br>${f.utc ? esc(f.utc) + " UTC" : "asteroid absent"}${f.lam_um ? ` &middot; ${fmt(f.lam_um, 3)} &micro;m` : ""}${f.snr ? ` &middot; S/N ${fmt(f.snr, 0)}` : ""}`;
}

function step(d) { idx = (idx + d + blink.frames.length) % blink.frames.length; draw(); }
function schedule() {
  clearInterval(timer);
  if (playing) timer = setInterval(() => step(1), Number($("speed").value));
}

async function loadBlink(name, start = 0) {
  const b = await getJSON(BASE + encodeURIComponent(name) + "/blink.json");
  b._base = BASE + encodeURIComponent(name) + "/";
  blink = b; idx = Math.min(Math.max(0, start), b.frames.length - 1);
  const g = b.grid;
  const r = b.rate_measured, e = b.rate_ephem;
  $("cap").innerHTML = `${esc((b.number ? b.number + " " : "") + b.name)} (V ${fmt(b.V, 1)}, H ${fmt(b.H, 1)}), field ${esc(b.field)}, detector D${esc(b.detector)}. `
    + `North up, east left, ${fmt(g.pixel_arcsec, 0)}"/px grid (SPHEREx pixel 6.15"). `
    + (r && e ? `Rate measured ${fmt(r.speed, 1)}"/h at PA ${fmt(r.pa, 1)}&deg;, ephemeris ${fmt(e.speed, 1)}"/h at PA ${fmt(e.pa, 1)}&deg;.` : "");
  for (const f of b.frames) { const im = new Image(); im.src = b._base + f.file; }
  draw(); schedule();
}

async function main() {
  try {
    const s = await getJSON(BASE + "summary.json");
    stats(s); fieldsTable(s);
    const names = s.blinks || [];
    $("pick").innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join("");
    $("pick").hidden = names.length < 2;
    const qs = new URLSearchParams(location.search);
    const q = qs.get("a");
    const first = names.includes(q) ? q : names[0];
    // ?f=<frame> opens that frame paused (used for screenshots)
    if (qs.has("f")) { playing = false; $("play").textContent = "Play"; }
    if (first) { $("pick").value = first; await loadBlink(first, Number(qs.get("f")) || 0); }
    else $("cap").textContent = "No blink example yet.";
  } catch (e) {
    $("stats").textContent = "Could not load the results: " + e.message;
  }
}

$("play").onclick = () => { playing = !playing; $("play").textContent = playing ? "Pause" : "Play"; schedule(); };
$("prev").onclick = () => { playing = false; $("play").textContent = "Play"; schedule(); step(-1); };
$("next").onclick = () => { playing = false; $("play").textContent = "Play"; schedule(); step(1); };
$("speed").onchange = schedule;
$("marks").onchange = draw;
$("pick").onchange = () => loadBlink($("pick").value);
main();
