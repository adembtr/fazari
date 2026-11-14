// Development stand-in for skyindex.js: same signature and fields, but it only knows the
// images around the 5 challenge targets (site/data/dev/images_<target>.json, built from the
// IRSA SIA listings by tests/make_dev_index.mjs). For any other position it returns [].
//
//   findImages(ra, dec, opts) -> [{obs_id, collection, detector, mjd, mjd_end, s3_key, url,
//                                 lam_min_um, lam_max_um, approx_lam_um}]
// Only images whose footprint polygon contains (ra, dec) are returned.

import { TARGETS } from "./targets.js";
import { S3_BASE } from "./net.js";

const D2R = Math.PI / 180;
const BASE = new URL("../data/dev/", import.meta.url);
const loaded = new Map();

function sep(ra1, dec1, ra2, dec2) {
  const a = Math.sin(dec1 * D2R) * Math.sin(dec2 * D2R)
    + Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.cos((ra1 - ra2) * D2R);
  return Math.acos(Math.max(-1, Math.min(1, a))) / D2R;
}

async function load(name) {
  if (!loaded.has(name)) {
    loaded.set(name, fetch(new URL(`images_${name}.json`, BASE)).then((r) => {
      if (!r.ok) throw new Error(`dev index for ${name}: HTTP ${r.status}`);
      return r.json();
    }).catch((e) => { loaded.delete(name); throw e; }));
  }
  return loaded.get(name);
}

/** Detector-frame position (u, v in 0..1) of (ra, dec) inside the footprint quadrilateral
 * (corners in detector order (0,0) (1,0) (1,1) (0,1)), by inverting the bilinear map. */
export function footprintUV(poly, ra, dec) {
  const c = Math.cos(dec * D2R);
  const P = [0, 1, 2, 3].map((k) => [(((poly[2 * k] - ra + 540) % 360) - 180) * c, poly[2 * k + 1] - dec]);
  const [p0, p1, p2, p3] = P;
  const e = [p1[0] - p0[0], p1[1] - p0[1]], f = [p3[0] - p0[0], p3[1] - p0[1]];
  const g = [p0[0] - p1[0] + p2[0] - p3[0], p0[1] - p1[1] + p2[1] - p3[1]];
  let u = 0.5, v = 0.5;
  for (let it = 0; it < 30; it++) {
    const fx = p0[0] + u * e[0] + v * f[0] + u * v * g[0];
    const fy = p0[1] + u * e[1] + v * f[1] + u * v * g[1];
    const a = e[0] + v * g[0], b = f[0] + u * g[0], cc = e[1] + v * g[1], d = f[1] + u * g[1];
    const det = a * d - b * cc;
    if (!det) break;
    const du = (d * fx - b * fy) / det, dv = (-cc * fx + a * fy) / det;
    u -= du; v -= dv;
    if (Math.abs(du) + Math.abs(dv) < 1e-12) break;
  }
  return [u, v];
}

/** Approximate wavelength at (u, v): SPHEREx's linear variable filter runs along detector y,
 * log-linear from lam_max (y = 0) to lam_min (y = 2039). Within ~2 % (checked on Barnard). */
export function approxLambda(img, u, v) {
  const lmax = Math.log(img.lam_max_um), lmin = Math.log(img.lam_min_um);
  return Math.exp(lmax - (lmax - lmin) * Math.min(1, Math.max(0, v)));
}

export async function findImages(ra, dec, opts = {}) {
  let name = opts.target && TARGETS[opts.target] ? opts.target : null;
  if (!name) {
    for (const [k, t] of Object.entries(TARGETS)) {
      if (sep(ra, dec, t.ra, t.dec) < 0.5) { name = k; break; }
    }
  }
  if (!name) return [];
  const data = await load(name);
  const out = [];
  for (const img of data.images) {
    const [u, v] = footprintUV(img.poly, ra, dec);
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) continue;
    out.push({
      obs_id: img.obs_id, collection: img.collection, detector: img.detector,
      mjd: img.mjd, mjd_end: img.mjd_end, s3_key: img.s3_key, url: S3_BASE + img.s3_key,
      lam_min_um: img.lam_min_um, lam_max_um: img.lam_max_um,
      approx_lam_um: Math.round(approxLambda(img, u, v) * 1e4) / 1e4,
    });
  }
  return out;
}
