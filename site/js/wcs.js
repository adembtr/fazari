// World coordinate systems for SPHEREx L2 images, in plain JS.
//  - SipWcs: RA---TAN-SIP with CRPIX/CRVAL/PC/CDELT (or CD), SIP A/B forward and AP/BP inverse.
//    pixToSky: forward SIP, then TAN.  skyToPix: inverse TAN, AP/BP, then Newton on the forward model.
//  - TanGrid: a north-up, east-left TAN grid centred on a point (the output frame of the viewer).
//  - WaveWcs: the per-pixel wavelength lookup table (alternate WCS 'W', CTYPE WAVE-TAB).
// Pixel coordinates here are 0-based (FITS pixel = x + 1), like astropy's origin=0.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

function sipPoly(h, prefix) {
  const order = h.num(`${prefix}_ORDER`, 0);
  const terms = [];
  for (let p = 0; p <= order; p++) {
    for (let q = 0; p + q <= order; q++) {
      const c = h.num(`${prefix}_${p}_${q}`, 0);
      if (c) terms.push([p, q, c]);
    }
  }
  return terms;
}

function evalPoly(terms, u, v) {
  let s = 0;
  for (const [p, q, c] of terms) s += c * u ** p * v ** q;
  return s;
}
function evalPolyDeriv(terms, u, v) {
  let du = 0, dv = 0;
  for (const [p, q, c] of terms) {
    if (p) du += c * p * u ** (p - 1) * v ** q;
    if (q) dv += c * q * u ** p * v ** (q - 1);
  }
  return [du, dv];
}

/** Native spherical (phi, theta) of a TAN projection plane point (x, y) in degrees. */
function tanDeproject(x, y) {
  const r = Math.hypot(x, y);
  const phi = r === 0 ? 0 : Math.atan2(x, -y);
  const theta = Math.atan2(R2D, r);
  return [phi, theta];   // radians
}

/** Celestial (ra, dec) [deg] from native (phi, theta) [rad] for a zenithal projection. */
function nativeToCelestial(phi, theta, ra0, dec0, phiP) {
  const dp = dec0 * D2R;
  const dphi = phi - phiP * D2R;
  const ct = Math.cos(theta), st = Math.sin(theta);
  const ra = ra0 * D2R + Math.atan2(-ct * Math.sin(dphi), st * Math.cos(dp) - ct * Math.sin(dp) * Math.cos(dphi));
  const dec = Math.asin(Math.max(-1, Math.min(1, st * Math.sin(dp) + ct * Math.cos(dp) * Math.cos(dphi))));
  return [((ra * R2D) % 360 + 360) % 360, dec * R2D];
}

/** TAN projection plane (x, y) [deg] of (ra, dec) for reference (ra0, dec0), LONPOLE phiP. */
function celestialToTan(ra, dec, ra0, dec0, phiP) {
  const a = ra * D2R, d = dec * D2R, dp = dec0 * D2R;
  const da = a - ra0 * D2R;
  const phi = phiP * D2R + Math.atan2(-Math.cos(d) * Math.sin(da),
    Math.sin(d) * Math.cos(dp) - Math.cos(d) * Math.sin(dp) * Math.cos(da));
  const st = Math.sin(d) * Math.sin(dp) + Math.cos(d) * Math.cos(dp) * Math.cos(da);
  if (st <= 0) return [NaN, NaN];          // other hemisphere
  const theta = Math.asin(Math.min(1, st));
  const r = R2D * Math.cos(theta) / Math.sin(theta);
  return [r * Math.sin(phi), -r * Math.cos(phi)];
}

export class SipWcs {
  /** @param h Header (fits.js) of the IMAGE HDU. */
  constructor(h) {
    this.crpix = [h.num("CRPIX1"), h.num("CRPIX2")];
    this.crval = [h.num("CRVAL1"), h.num("CRVAL2")];
    const ct1 = h.str("CTYPE1");
    if (!/^RA---TAN/.test(ct1)) throw new Error(`unsupported CTYPE1 ${ct1}`);
    this.phiP = h.num("LONPOLE", 180);
    let cd;
    if (h.has("CD1_1")) {
      cd = [[h.num("CD1_1"), h.num("CD1_2", 0)], [h.num("CD2_1", 0), h.num("CD2_2")]];
    } else {
      const c1 = h.num("CDELT1", 1), c2 = h.num("CDELT2", 1);
      cd = [[c1 * h.num("PC1_1", 1), c1 * h.num("PC1_2", 0)], [c2 * h.num("PC2_1", 0), c2 * h.num("PC2_2", 1)]];
    }
    this.cd = cd;
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    this.cdi = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];
    const sip = /-SIP/.test(ct1);
    this.A = sip ? sipPoly(h, "A") : [];
    this.B = sip ? sipPoly(h, "B") : [];
    this.AP = sip ? sipPoly(h, "AP") : [];
    this.BP = sip ? sipPoly(h, "BP") : [];
  }

  /** 0-based pixel -> [ra, dec] degrees. */
  pixToSky(x, y) {
    const u = x + 1 - this.crpix[0], v = y + 1 - this.crpix[1];
    const U = u + evalPoly(this.A, u, v), V = v + evalPoly(this.B, u, v);
    const px = this.cd[0][0] * U + this.cd[0][1] * V;
    const py = this.cd[1][0] * U + this.cd[1][1] * V;
    const [phi, theta] = tanDeproject(px, py);
    return nativeToCelestial(phi, theta, this.crval[0], this.crval[1], this.phiP);
  }

  /** [ra, dec] degrees -> 0-based pixel [x, y]. AP/BP start, then Newton (<= 1e-8 px). */
  skyToPix(ra, dec) {
    const [px, py] = celestialToTan(ra, dec, this.crval[0], this.crval[1], this.phiP);
    if (!Number.isFinite(px)) return [NaN, NaN];
    const U = this.cdi[0][0] * px + this.cdi[0][1] * py;
    const V = this.cdi[1][0] * px + this.cdi[1][1] * py;
    let u = U + evalPoly(this.AP, U, V), v = V + evalPoly(this.BP, U, V);
    if (this.A.length || this.B.length) {
      for (let it = 0; it < 20; it++) {
        const fu = u + evalPoly(this.A, u, v) - U;
        const fv = v + evalPoly(this.B, u, v) - V;
        if (Math.abs(fu) < 1e-10 && Math.abs(fv) < 1e-10) break;
        const [au, av] = evalPolyDeriv(this.A, u, v);
        const [bu, bv] = evalPolyDeriv(this.B, u, v);
        const j11 = 1 + au, j12 = av, j21 = bu, j22 = 1 + bv;
        const det = j11 * j22 - j12 * j21;
        const du = (j22 * fu - j12 * fv) / det, dv = (-j21 * fu + j11 * fv) / det;
        u -= du; v -= dv;
        if (Math.abs(du) < 1e-10 && Math.abs(dv) < 1e-10) break;
      }
    }
    return [u + this.crpix[0] - 1, v + this.crpix[1] - 1];
  }

  /** Sky angle (deg, E of N... as in blink.py: atan2(PC2_1, PC1_1)) of the detector x axis. */
  orientation() {
    return ((Math.atan2(this.cd[1][0], this.cd[0][0]) * R2D) % 360 + 360) % 360;
  }
}

/** North-up, east-left TAN grid of n x n pixels of `pixArcsec`, centred on (ra0, dec0).
 * Pixel (i, j): i = column from the left, j = row from the TOP (display order). */
export class TanGrid {
  constructor(ra0, dec0, pixArcsec, n) {
    this.ra0 = ra0; this.dec0 = dec0; this.n = n;
    this.scale = pixArcsec / 3600;
    this.c = (n - 1) / 2;
  }
  pixToSky(i, j) {
    const x = -(i - this.c) * this.scale, y = (this.c - j) * this.scale;
    const [phi, theta] = tanDeproject(x, y);
    return nativeToCelestial(phi, theta, this.ra0, this.dec0, 180);
  }
  skyToPix(ra, dec) {
    const [x, y] = celestialToTan(ra, dec, this.ra0, this.dec0, 180);
    return [this.c - x / this.scale, this.c - y / this.scale];
  }
}

/** Wavelength lookup (alternate WCS 'W', WAVE-TAB) for SPHEREx images.
 * table = readBinTable(WCS-WAVE) with columns X, Y (index vectors, FITS pixel coordinates)
 * and VALUES (TDIM (2, nx, ny): [wavelength, bandwidth] at each control point). */
export class WaveWcs {
  constructor(h, table) {
    const ax = (k) => ({
      crpix: h.num(`CRPIX${k}W`, 1), crval: h.num(`CRVAL${k}W`, 1), cdelt: h.num(`CDELT${k}W`, 1),
      m: h.num(`PV${k}_3W`, k), col: h.str(`PS${k}_2W`, k === 1 ? "X" : "Y"),
    });
    this.ax = [ax(1), ax(2)];
    if (h.str("CTYPE1W") !== "WAVE-TAB") throw new Error("no WAVE-TAB wavelength WCS");
    this.valCol = h.str("PS1_1W", "VALUES");
    this.X = table[this.ax[0].col][0];
    this.Y = table[this.ax[1].col][0];
    this.V = table[this.valCol][0];
    this.nx = this.X.length; this.ny = this.Y.length;
    this.M = Math.round(this.V.length / (this.nx * this.ny));   // values per control point (2)
  }
  static fractionalIndex(vec, psi) {
    const n = vec.length;
    let k = 0;
    while (k < n - 2 && psi > vec[k + 1]) k++;
    return k + (psi - vec[k]) / (vec[k + 1] - vec[k]);   // linear beyond the ends
  }
  /** 0-based pixel (x, y) -> [wavelength_um, bandwidth_um]. */
  at(x, y) {
    const psi = [x, y].map((p, i) => this.ax[i].crval + this.ax[i].cdelt * (p + 1 - this.ax[i].crpix));
    const fx = WaveWcs.fractionalIndex(this.X, psi[0]);
    const fy = WaveWcs.fractionalIndex(this.Y, psi[1]);
    const ix = Math.max(0, Math.min(this.nx - 2, Math.floor(fx))), iy = Math.max(0, Math.min(this.ny - 2, Math.floor(fy)));
    const tx = fx - ix, ty = fy - iy;
    const val = (m, jx, jy) => this.V[(jy * this.nx + jx) * this.M + m];
    const out = [];
    for (const m of [this.ax[0].m - 1, this.ax[1].m - 1]) {
      out.push((1 - tx) * (1 - ty) * val(m, ix, iy) + tx * (1 - ty) * val(m, ix + 1, iy)
        + (1 - tx) * ty * val(m, ix, iy + 1) + tx * ty * val(m, ix + 1, iy + 1));
    }
    return out;
  }
}
