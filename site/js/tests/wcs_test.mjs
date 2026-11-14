// WCS test: JS TAN-SIP + wavelength lookup vs astropy (reference numbers in wcs_ref.json,
// made by make_wcs_ref.py). Reads the local IRSA cutouts and, for two full-size files, only
// the header bytes from S3.
//   node site/js/tests/wcs_test.mjs
// Env FAZARI_DATA = folder with <target>/{dr1,qr3}/*.fits (default ../veri/real_spherex).
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SpherexFile } from "../fits.js";
import { SipWcs, WaveWcs } from "../wcs.js";
import { s3Source } from "../net.js";
import { fileSource } from "./wcs_test_lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DATA = process.env.FAZARI_DATA || resolve(ROOT, "../veri/real_spherex");
const ref = JSON.parse(readFileSync(resolve(HERE, "wcs_ref.json"), "utf8"));

function check(name, f, r) {
  const wcs = new SipWcs(f.header);
  const wave = new WaveWcs(f.header, f.waveTable);
  let maxSky = 0, maxPix = 0, maxPixAst = 0, maxLam = 0, maxBw = 0, nLam = 0, nOff = 0;
  for (let i = 0; i < r.x.length; i++) {
    const [ra, dec] = wcs.pixToSky(r.x[i], r.y[i]);
    const dra = ((ra - r.ra[i] + 540) % 360 - 180) * Math.cos(dec * Math.PI / 180);
    maxSky = Math.max(maxSky, Math.hypot(dra, dec - r.dec[i]) * 3600);
    // sky -> pixel of astropy's sky position must give back the original pixel
    const [x, y] = wcs.skyToPix(r.ra[i], r.dec[i]);
    maxPix = Math.max(maxPix, Math.hypot(x - r.x[i], y - r.y[i]));
    maxPixAst = Math.max(maxPixAst, Math.hypot(x - r.x_back[i], y - r.y_back[i]));
    // astropy gives NaN (null) off the lookup table, i.e. outside the 2040x2040 detector
    if (r.lam[i] == null) { nOff++; continue; }
    const [lam, bw] = wave.at(r.x[i], r.y[i]);
    maxLam = Math.max(maxLam, Math.abs(lam - r.lam[i]));
    maxBw = Math.max(maxBw, Math.abs(bw - r.bw[i]));
    nLam++;
  }
  const ok = maxSky < 0.01 * 6.15 && maxPix < 0.01 && maxPixAst < 0.01 && maxLam < 1e-4;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${r.x.length} px | pix->sky max ${(maxSky * 1000).toExponential(2)} mas`
    + ` | sky->pix max ${maxPix.toExponential(2)} px (vs astropy all_world2pix ${maxPixAst.toExponential(2)} px)`
    + ` | wavelength (${nLam} px, ${nOff} off-detector skipped) max ${maxLam.toExponential(2)} um, bandwidth ${maxBw.toExponential(2)} um`);
  return { ok, maxSky, maxPix, maxPixAst, maxLam };
}

let all = true;
const worst = { sky: 0, pix: 0, lam: 0 };
for (const r of ref.cutouts) {
  const p = resolve(DATA, r.file);
  if (!existsSync(p)) { console.log("SKIP (missing)", r.file); continue; }
  const f = await new SpherexFile(fileSource(p)).open();
  const c = check(`cutout D${r.detector} ${r.file.split("/").pop()}`, f, r);
  all &&= c.ok;
  worst.sky = Math.max(worst.sky, c.maxSky); worst.pix = Math.max(worst.pix, c.maxPix, c.maxPixAst); worst.lam = Math.max(worst.lam, c.maxLam);
}
if (!process.env.NO_NET) {
  for (const r of ref.s3) {
    const f = await new SpherexFile(s3Source(r.key)).open();
    const c = check(`S3 full ${r.key.split("/").pop()}`, f, r);
    all &&= c.ok;
    worst.sky = Math.max(worst.sky, c.maxSky); worst.pix = Math.max(worst.pix, c.maxPix, c.maxPixAst); worst.lam = Math.max(worst.lam, c.maxLam);
  }
}
console.log(`worst: pix->sky ${(worst.sky * 1000).toExponential(2)} mas, sky->pix ${worst.pix.toExponential(2)} px, wavelength ${worst.lam.toExponential(2)} um`);
console.log(all ? "ALL PASS" : "SOME FAILED");
process.exit(all ? 0 : 1);
