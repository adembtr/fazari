// S3 reader test: rows read from the full files on S3 with HTTP Range (IMAGE, RICE-compressed
// FLAGS, ZODI) must equal the pixels of the local IRSA cutouts of the same exposures.
//   node site/js/tests/s3_reader_test.mjs [n_files]
import { readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SpherexFile } from "../fits.js";
import { s3Source, stats } from "../net.js";
import { fileSource } from "./wcs_test_lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DATA = process.env.FAZARI_DATA || resolve(ROOT, "../veri/real_spherex");
const N = Number(process.argv[2] || 4);

const picks = [];
for (const col of ["dr1", "qr3"]) {
  const dir = resolve(DATA, "barnard", col);
  if (!existsSync(dir)) continue;
  const fs = readdirSync(dir).filter((f) => f.endsWith(".fits")).sort();
  for (let i = 0; i < N / 2; i++) picks.push([col, fs[Math.floor((i + 0.5) * fs.length / (N / 2))]]);
}

function keyFor(col, file) {
  // level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits -> <col>/level2/2025W33_2C/l2b-v27-2026-228/6/<file>
  const m = /^level2_(\d{4}W\d{2}_\w{2})_\d+_\d+D(\d)_spx_(l2b-[\w-]+)\.fits$/.exec(file);
  return `${col}/level2/${m[1]}/${m[3]}/${m[2]}/${file}`;
}

let ok = true;
const t0 = Date.now();
for (const [col, file] of picks) {
  const local = await new SpherexFile(fileSource(resolve(DATA, "barnard", col, file))).open();
  await local.openLayers();
  const h = local.header;
  const nx = h.num("NAXIS1"), ny = h.num("NAXIS2");
  const x0 = Math.round(1 - h.num("CRPIX1A")), y0 = Math.round(1 - h.num("CRPIX2A"));
  const cut = await local.readRegion(0, ny - 1);
  const remote = await new SpherexFile(s3Source(keyFor(col, file))).open();
  const b0 = stats.bytes;
  const reg = await remote.readRegion(y0, y0 + ny - 1);
  const bytes = stats.bytes - b0;
  let bad = { image: 0, flags: 0, zodi: 0 };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * nx + i, b = j * reg.nx + x0 + i;
      const same = (u, v) => (Number.isNaN(u) && Number.isNaN(v)) || u === v;
      if (!same(cut.image[a], reg.image[b])) bad.image++;
      if (cut.flags[a] !== reg.flags[b]) bad.flags++;
      if (!same(cut.zodi[a], reg.zodi[b])) bad.zodi++;
    }
  }
  const pass = !bad.image && !bad.flags && !bad.zodi;
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${col}/${file}: ${nx}x${ny} px at (${x0},${y0}); mismatches`
    + ` image ${bad.image}, flags ${bad.flags}, zodi ${bad.zodi}; region read ${(bytes / 1e6).toFixed(2)} MB`
    + ` (IMAGE hdr ${remote.image.headerLength} B, FLAGS heap rows RICE-decoded)`);
}
console.log(`total ${(stats.bytes / 1e6).toFixed(2)} MB in ${stats.requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
