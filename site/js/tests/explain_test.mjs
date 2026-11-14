// Plain-language sentences (js/explain.js) and the pixel <-> sky grid of manual marks (js/marking.js).
//   node site/js/tests/explain_test.mjs [jobs_base_url]
// Uses the five site/data targets; with a URL (e.g. http://127.0.0.1:8765) also every finished job
// listed by GET /api/jobs. Checks: a sentence for every result, no "discover", the expected words
// for the five targets, and that meta.markers' (ra, dec) map to their png_xy within 0.15 px and
// back within 0.01″. Exits 1 on any failure.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { plainSentence } from "../explain.js";
import { explainResult } from "../explain.js";
import { gridOf } from "../marking.js";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };

const EXPECT = {
  barnard: [/^Barnard's Star moved 10\.2″ north in one year, as Gaia predicts\.$/],
  eps_indi_b: [/^Epsilon Indi B moved 4\.5″ south-east in one year, as Gaia predicts\.$/],
  wise0855: [/moved 8\.4″ west in one year \(seen only at 4–5 µm\)/, /Spitzer/],
  rw_aur: [/^RW Aurigae got about half as bright at 4–5 µm between September 2025 and September 2026\.$/],
  r_dra: [/^R Draconis got about half as bright .*between June 2025 and June 2026\.$/],
};

function gridCheck(name, m) {
  const g = gridOf(m);
  check(g, `${name}: no grid`);
  if (!g) return;
  for (const mk of m.markers || []) {
    const [x, y] = g.toPng(mk.ra, mk.dec);
    check(Math.hypot(x - mk.png_xy[0], y - mk.png_xy[1]) < 0.15, `${name} ${mk.epoch}: toPng ${x.toFixed(2)},${y.toFixed(2)} vs ${mk.png_xy}`);
    const [ra, dec] = g.toSky(x, y);
    const d = Math.hypot((ra - mk.ra) * Math.cos(mk.dec * Math.PI / 180), dec - mk.dec) * 3600;
    check(d < 0.01, `${name} ${mk.epoch}: round trip ${d.toFixed(4)}″`);
  }
  // the image centre is the grid centre
  const [W, H] = g.size, L = m.grid.label_strip_px || 0;
  const [ra, dec] = g.toSky(W / 2, L + (H - L) / 2);
  check(Math.hypot((ra - m.ra) * Math.cos(m.dec * Math.PI / 180), dec - m.dec) * 3600 < 0.01, `${name}: centre`);
}

for (const t of Object.keys(EXPECT)) {
  const m = JSON.parse(readFileSync(`${SITE}/data/${t}/meta.json`, "utf8"));
  const s = plainSentence(m);
  console.log(`${t}: ${s && s.text}${s && s.note ? `  [${s.note}]` : ""}`);
  check(s && s.text, `${t}: no sentence`);
  for (const re of EXPECT[t]) check(s && re.test(s.text), `${t}: "${s && s.text}" !~ ${re}`);
  check(!/discover/i.test(JSON.stringify(s)), `${t}: says discover`);
  gridCheck(t, m);
}

// synthetic and partial metas: never throw, never empty
const base = JSON.parse(readFileSync(`${SITE}/data/barnard/meta.json`, "utf8"));
const synth = {
  empty: {},
  no_measured: { target: "X", wavelength_bins: [] },
  preview: { ...base, preview: { bin_um: 2.0, n_images: 12, seasons: 3 },
    measured: { status: "preview", message: "Preview", preliminary: { from_epoch: "2025-08", to_epoch: "2026-08", shift_arcsec: 10.4, pa_deg: 356, catalogue_shift_arcsec: 10.2, catalogue_pa_deg: 355.7 } } },
  preview_plain: { ...base, preview: { bin_um: 2.0 }, measured: { status: "preview", message: "Preview" } },
  field_candidate: { ...base, target: null, gaia: { label: "requested position" },
    measured: { status: "detected", shift_arcsec: 1.2, shift_err_arcsec: 0.2, pa_deg: 90, dt_years: 0.5, gaia_predicted_arcsec: 0 } },
  one_season: { ...base, measured: { status: "detected_one_season", detection: { detected_bins_um: [4.6] } } },
  phot_flat: { ...base, target: "V", measured: { status: "brightness", photometry: { bins: [{ wavelength_um: 2, seasons: [
    { epoch: "2025-09", ratio_to_first: 1, ratio_err: 0 }, { epoch: "2026-03", ratio_to_first: 1.02, ratio_err: 0.05 }] }] } } },
  phot_none: { ...base, measured: { status: "brightness", photometry: { bins: [{ wavelength_um: 4, seasons: [], flags: ["no photometry"] }] } } },
};
for (const [k, m] of Object.entries(synth)) {
  let s;
  try { s = plainSentence(m); } catch (e) { fails.push(`${k}: threw ${e}`); continue; }
  console.log(`(synthetic) ${k}: ${s ? s.text : "null"}${s && s.note ? `  [${s.note}]` : ""}`);
  if (k !== "empty" && k !== "no_measured") check(s && s.text, `${k}: no sentence`);
  check(!/discover/i.test(JSON.stringify(s)), `${k}: says discover`);
}
check(/candidate/.test(plainSentence(synth.field_candidate).text), "field_candidate: no 'candidate'");

// Turkish (plainSentence(meta, { lang: "tr" }); on the page the language comes from js/i18n.js)
const EXPECT_TR = {
  barnard: [/^Barnard Yıldızı bir yılda 10,2″ kuzeye kaydı; Gaia'nın tahminiyle aynı\.$/],
  eps_indi_b: [/^Epsilon Indi B bir yılda 4,5″ güneydoğuya kaydı; Gaia'nın tahminiyle aynı\.$/],
  wise0855: [/bir yılda 8,4″ batıya kaydı \(yalnızca 4–5 µm'de görüldü\)/, /Spitzer/],
  rw_aur: [/^RW Aurigae, Eylül 2025 ile Eylül 2026 arasında 4–5 µm'de yaklaşık yarı yarıya sönükleşti\.$/],
  r_dra: [/^R Draconis, Haziran 2025 ile Haziran 2026 arasında .*sönükleşti\.$/],
};
const noDiscover = (k, s) => check(!/discover|keşif|keşf/i.test(JSON.stringify(s)), `${k} (tr): says discover / keşif`);
const commaOnly = (k, txt) => check(!/\d\.\d/.test(txt || ""), `${k} (tr): decimal point instead of comma: "${txt}"`);
for (const t of Object.keys(EXPECT_TR)) {
  const m = JSON.parse(readFileSync(`${SITE}/data/${t}/meta.json`, "utf8"));
  const s = plainSentence(m, { lang: "tr" });
  console.log(`${t} (tr): ${s && s.text}${s && s.note ? `  [${s.note}]` : ""}`);
  check(s && s.text, `${t} (tr): no sentence`);
  for (const re of EXPECT_TR[t]) check(s && re.test(s.text), `${t} (tr): "${s && s.text}" !~ ${re}`);
  noDiscover(t, s); commaOnly(t, s && s.text); commaOnly(t, s && s.note);
  const r = explainResult(m, { spectrum: true, cands: true }, { lang: "tr" });
  check(r.sentence === (s && s.text), `${t} (tr): explainResult sentence differs`);
  for (const it of r.items) {
    check(it.name && it.ask && !/^(Ring|Arrow|Difference image|Light curve|Spectrum|Candidate rings)$/.test(it.name), `${t} (tr): strip item ${it.key} not Turkish`);
    commaOnly(`${t} strip ${it.key}`, it.text);
  }
  noDiscover(`${t} strip`, r.items);
}
for (const [k, m] of Object.entries(synth)) {
  let s;
  try { s = plainSentence(m, { lang: "tr" }); explainResult(m, {}, { lang: "tr" }); } catch (e) { fails.push(`${k} (tr): threw ${e}`); continue; }
  console.log(`(synthetic, tr) ${k}: ${s ? s.text : "null"}${s && s.note ? `  [${s.note}]` : ""}`);
  if (k !== "empty" && k !== "no_measured") check(s && s.text, `${k} (tr): no sentence`);
  noDiscover(k, s); commaOnly(k, s && s.text); commaOnly(k, s && s.note);
}
check(/aday/.test(plainSentence(synth.field_candidate, { lang: "tr" }).text), "field_candidate (tr): no 'aday'");
// the page's language (globalThis.__fzI18n from js/i18n.js) is the default
{
  const bm = JSON.parse(readFileSync(`${SITE}/data/barnard/meta.json`, "utf8"));
  globalThis.__fzI18n = { lang: () => "tr", tname: (n) => (n === "Barnard's Star" ? "Barnard Yıldızı" : n) };
  check(/^Barnard Yıldızı bir yılda/.test((plainSentence(bm) || {}).text || ""), "global tr: not Turkish");
  globalThis.__fzI18n = { lang: () => "en" };
  check(/^Barnard's Star moved 10\.2″ north/.test((plainSentence(bm) || {}).text || ""), "global en: not English");
  delete globalThis.__fzI18n;
}

const url = process.argv[2];
if (url) {
  const jobs = (await (await fetch(url + "/api/jobs")).json()).jobs.filter((j) => j.state === "done");
  for (const j of jobs) {
    const m = await (await fetch(url + j.result_url + "meta.json")).json();
    const s = plainSentence(m);
    console.log(`job ${j.id}: ${s && s.text}`);
    check(s && s.text, `job ${j.id}: no sentence`);
    check(!/discover/i.test(JSON.stringify(s)), `job ${j.id}: says discover`);
    gridCheck(`job ${j.id}`, m);
  }
}
if (fails.length) { console.error("FAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("OK");
