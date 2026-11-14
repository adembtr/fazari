// Browser spectrum (site/js/spectrum.js) against pipeline/spectrum.py on the local IRSA cutouts:
// the same exposures measured by both engines must give the same wavelength, flux and status.
//   node site/js/tests/spectrum_test.mjs <target> <python spectrum.json> [every_nth_file]
// Exit code 1 if the median |JS/Python - 1| of the fluxes (S/N > 10) is above 2 %, or the median
// |JS - Python| of the fluxes with S/N <= 10 above 0.1 sigma.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SpherexFile } from "../fits.js";
import { propagate, jyearToMjd } from "../astro.js";
import { measureFile, finishRows, toRow, build, toCsv, SPEC } from "../spectrum.js";
import { fileSource } from "./wcs_test_lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DATA = process.env.FAZARI_DATA || resolve(ROOT, "../veri/real_spherex");
const [name, pyPath, nth = "3"] = process.argv.slice(2);
const cat = JSON.parse(readFileSync(resolve(ROOT, "pipeline/targets.json"), "utf8"));
const extra = JSON.parse(readFileSync(resolve(ROOT, "pipeline/targets_extra.json"), "utf8"));
const t = { ...cat[name], ...(extra[name] || {}) };
const py = JSON.parse(readFileSync(pyPath, "utf8"));
const pyRows = new Map(py.points.map((p) => [p.file, p]));

const [rc, dc] = propagate({ ...t, rv: undefined }, jyearToMjd(SPEC.epochCenter), false);
const nbSky = [];
const gpath = resolve(ROOT, "site/data", name, "gaia_field.json");
const gpath2 = resolve(dirname(pyPath), "gaia_field.json");
const gf = existsSync(gpath) ? gpath : existsSync(gpath2) ? gpath2 : null;
if (gf) {
  const cd = Math.cos(dc * Math.PI / 180);
  for (const s of JSON.parse(readFileSync(gf, "utf8")).stars) {
    if (Math.hypot((s[1] - rc) * cd, s[2] - dc) * 3600 < SPEC.gaiaNbArcsec) nbSky.push({ ra: s[1], dec: s[2], pmra: s[3], pmdec: s[4], gaia: true });
  }
}
for (const n of (t.neighbors || {}).list || []) nbSky.push({ ra: n[0], dec: n[1], pmra: 0, pmdec: 0, gaia: false });

const files = [...pyRows.values()].filter((_, k) => k % Number(nth) === 0);
const t0 = Date.now();
const infos = [];
for (const p of files) {
  const f = new SpherexFile(fileSource(resolve(DATA, name, p.collection, p.file)));
  infos.push(await measureFile(f, (mjd) => propagate(t, mjd), { nbSky, meta: { file: p.file, collection: p.collection, season: p.season } }));
}
const inside = infos.filter((i) => i.inside);
finishRows(inside);
const rows = inside.map(toRow);
const spec = build({ target: t.name, ra: rc, dec: dc, rows });
const csv = toCsv(spec);
const ms = (Date.now() - t0) / inside.length;

let dl = [], df = [], de = [], dz = [], same = 0, cmp = 0;
const statusPairs = {};
for (const r of rows) {
  const p = pyRows.get(r.file);
  if (!p) continue;
  cmp++;
  dl.push(Math.abs(r.wavelength_um - p.wavelength_um));
  const key = `${p.status}->${r.status}`;
  statusPairs[key] = (statusPairs[key] || 0) + 1;
  if (p.status === r.status || (["detection", "nondetection"].includes(p.status) && ["detection", "nondetection"].includes(r.status))) same++;
  if (p.flux_ujy != null && r.flux_ujy != null && !(p.snr > 10)) dz.push(Math.abs(r.flux_ujy - p.flux_ujy) / p.flux_err_var_ujy);
  if (p.flux_ujy != null && r.flux_ujy != null && p.snr > 10) {
    df.push(r.flux_ujy / p.flux_ujy - 1);
    de.push(r.flux_err_var_ujy / p.flux_err_var_ujy - 1);
  }
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const pct = (v) => (100 * v).toFixed(2) + " %";
console.log(`${t.name}: ${cmp} exposures compared (every ${nth}th), ${ms.toFixed(0)} ms per exposure in node; neighbours ${nbSky.length}`);
console.log(`  wavelength: max |JS - Python| ${Math.max(...dl).toExponential(2)} um`);
console.log(`  status agreement: ${same}/${cmp}; pairs ${JSON.stringify(statusPairs)}`);
if (df.length) {
  console.log(`  flux (S/N > 10, N=${df.length}): median JS/Python - 1 = ${pct(med(df))}, median |.| = ${pct(med(df.map(Math.abs)))}, max |.| = ${pct(Math.max(...df.map(Math.abs)))}`);
  console.log(`  formal error: median JS/Python - 1 = ${pct(med(de))}`);
}
if (dz.length) console.log(`  fluxes with S/N <= 10 (N=${dz.length}): median |JS - Python| = ${med(dz).toFixed(3)} sigma, max ${Math.max(...dz).toFixed(2)} sigma`);
console.log(`  csv: ${csv.split("\n").length - 2} rows, header matches Python: ${csv.split("\n")[0] === py.columns.join(",")}`);
const ok = (!df.length || med(df.map(Math.abs)) < 0.02) && (!dz.length || med(dz) < 0.1);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
