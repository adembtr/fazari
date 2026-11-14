// Builds site/data/dev/images_<target>.json (the stand-in sky index read by skyindex_dev.js)
// from the IRSA SIA listings <data>/<target>/liste_{dr1,qr3}.csv.
//   node site/js/tests/make_dev_index.mjs [target ...]
// <data> = env FAZARI_DATA, default ../veri/real_spherex next to the repo.
// The listing's cloud_access column is unquoted JSON (it contains commas), so the S3 key is
// taken with a regex and the other columns by position (none of them contains a comma).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DATA = process.env.FAZARI_DATA || resolve(ROOT, "../veri/real_spherex");
const OUT = resolve(ROOT, "site/data/dev");
const targets = process.argv.slice(2).length ? process.argv.slice(2)
  : ["barnard", "eps_indi_b", "wise0855", "rw_aur", "r_dra"];

const r5 = (v) => Math.round(v * 1e5) / 1e5;
for (const t of targets) {
  const images = [];
  for (const col of ["dr1", "qr3"]) {
    const p = resolve(DATA, t, `liste_${col}.csv`);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    const head = lines[0].split(",");
    const ix = (n) => head.indexOf(n);
    for (const line of lines.slice(1)) {
      const f = line.split(",");
      const key = /"key"\s*:\s*"([^"]+)"/.exec(line);
      const poly = /POLYGON ICRS ([-0-9.eE ]+)/.exec(line);
      if (!key || !poly) continue;
      const det = /SPHEREx-D(\d)/.exec(f[ix("energy_bandpassname")]);
      const pts = poly[1].trim().split(/\s+/).map(Number).slice(0, 8).map(r5);
      images.push({
        obs_id: f[ix("obs_id")], collection: col, detector: det ? Number(det[1]) : null,
        mjd: Number(f[ix("t_min")]), mjd_end: Number(f[ix("t_max")]), s3_key: key[1],
        lam_min_um: r5(Number(f[ix("em_min")]) * 1e6), lam_max_um: r5(Number(f[ix("em_max")]) * 1e6),
        poly: pts,
      });
    }
  }
  images.sort((a, b) => a.mjd - b.mjd || a.detector - b.detector);
  const out = { _note: `Dev stand-in for the sky index: IRSA SIA listing around ${t} (DR1 + QR3). `
    + "poly = footprint corners (ra, dec) x4, in detector order (0,0) (2039,0) (2039,2039) (0,2039).", target: t, images };
  const path = resolve(OUT, `images_${t}.json`);
  const text = JSON.stringify(out);
  writeFileSync(path, text);
  console.log(`${t}: ${images.length} images -> ${path} (${(text.length / 1024).toFixed(0)} KB)`);
}
