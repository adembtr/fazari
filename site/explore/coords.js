// Coordinate helpers for the sky explorer (no dependencies, also runs under Node).
//
// parseCoords("269.45 +4.69")              -> {ra: 269.45, dec: 4.69}
// parseCoords("17 57 48.5 +04 41 36")      -> RA in hours, Dec in degrees (sexagesimal)
// parseCoords("17h57m48.5s +4d41m36s")     -> same
// parseCoords("17:57:48.5, +04:41:36")     -> same
// parseCoords("Barnard's Star")            -> null (not a coordinate)

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;

/** True when the text looks like it is meant to be a coordinate (digits and separators only). */
export function looksLikeCoords(text) {
  const t = clean(text);
  // starts with a number ("M 31", "M31" are names, not coordinates)
  return t.length > 0 && /^[+\-]?[\d.]/.test(t) && /^[\d\s.,:+\-hmsd°'"′″]+$/i.test(t) && /\d/.test(t);
}

function clean(text) {
  return String(text || "")
    .trim()
    .replace(/\b(ra|dec|de|alpha|delta)\s*[=:]?\s*/gi, " ")
    .replace(/[−–—]/g, "-")      // unicode minus / dashes
    .replace(/\s+/g, " ")
    .trim()
    // Turkish/European decimal commas, "269,36969 -31,26269": only when there is no dot and the two
    // numbers are separated by a space (a lone comma between two numbers stays the RA/Dec separator)
    .replace(/^([+-]?\d+),(\d+) ([+-]?\d+),(\d+)$/, "$1.$2 $3.$4");
}

/**
 * Parse a sky position typed by a person. Returns {ra, dec, format} in ICRS degrees or null.
 * Accepts decimal degrees ("10.68 41.27", "10.68, +41.27"), decimal hours with an "h"
 * ("0.712h +41.27"), and sexagesimal with spaces, colons or h/m/s d/m/s letters.
 */
export function parseCoords(text) {
  const t = clean(text);
  if (!looksLikeCoords(t)) return null;

  // Split RA / Dec. Prefer an explicit comma, then a sign that starts the Dec part.
  let raPart, decPart;
  if (t.includes(",")) {
    [raPart, decPart] = t.split(",").map((s) => s.trim());
  } else {
    const m = t.match(/^(.*?\S)\s*([+-].*)$/);           // "... +04 41 36" or "...-7.2"
    if (m && /\d/.test(m[1])) { raPart = m[1]; decPart = m[2]; }
    else {
      const parts = t.split(/[\s:]+/).filter(Boolean);
      if (t.includes(":")) {                            // "17:57:48 04:41:36"
        const sp = t.split(" ");
        if (sp.length === 2) { raPart = sp[0]; decPart = sp[1]; }
      }
      if (!raPart) {
        if (parts.length === 2) { raPart = parts[0]; decPart = parts[1]; }
        else if (parts.length === 4) { raPart = parts.slice(0, 2).join(" "); decPart = parts.slice(2).join(" "); }
        else if (parts.length === 6) { raPart = parts.slice(0, 3).join(" "); decPart = parts.slice(3).join(" "); }
        else return null;
      }
    }
  }
  if (!raPart || !decPart) return null;

  const raSexa = /[hms:]/i.test(raPart) || raPart.trim().split(/\s+/).length > 1;
  const ra = raSexa ? sexa(raPart) * 15 : Number(raPart.replace(/[d°]$/i, ""));
  const dec = sexa(decPart);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) return null;
  return { ra, dec, format: raSexa ? "sexagesimal" : "decimal" };
}

/** "17 57 48.5", "17h57m48.5s", "-04:41:36", "+4d41m36s", "41.27" -> decimal units. */
function sexa(s) {
  const str = s.trim();
  const neg = /^-/.test(str);
  const nums = str.replace(/^[+-]/, "").match(new RegExp(NUM, "g"));
  if (!nums || nums.length > 3) return NaN;
  const [a, b = 0, c = 0] = nums.map(Number);
  if (nums.length > 1 && (b >= 60 || c >= 60 || b < 0 || c < 0)) return NaN;
  const v = Math.abs(a) + b / 60 + c / 3600;
  return neg ? -v : v;
}

const pad = (n, w) => String(n).padStart(w, "0");

/** 269.452 -> "17h 57m 48.5s" */
export function formatRA(ra) {
  let s = (((ra % 360) + 360) % 360) / 15 * 3600;
  s = Math.round(s * 10) / 10;
  if (s >= 86400) s -= 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(1);
  return `${pad(h, 2)}h ${pad(m, 2)}m ${sec.padStart(4, "0")}s`;
}

/** 4.693 -> "+04° 41′ 36″" */
export function formatDec(dec) {
  const sign = dec < 0 ? "−" : "+";
  let s = Math.round(Math.abs(dec) * 3600);
  const d = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${sign}${pad(d, 2)}° ${pad(m, 2)}′ ${pad(sec, 2)}″`;
}

/** Field of view in degrees -> friendly text. */
export function formatFov(fov) {
  if (fov >= 2) return `${Math.round(fov)}°`;
  if (fov * 60 >= 2) return `${Math.round(fov * 60)}′`;
  return `${Math.round(fov * 3600)}″`;
}

/** Move a position by proper motion (mas/yr, pmra includes cos dec) over dt years. Linear, fine for decades. */
export function applyPM(ra, dec, pmra, pmdec, dt) {
  if (!pmra && !pmdec) return { ra, dec };
  const d = dec + (pmdec || 0) * dt / 3.6e6;
  const r = ra + (pmra || 0) * dt / 3.6e6 / Math.cos(dec * Math.PI / 180);
  return { ra: ((r % 360) + 360) % 360, dec: Math.max(-90, Math.min(90, d)) };
}

/** Current Julian-ish year (good enough for proper motion). */
export function nowYear(date = new Date()) {
  return 2000 + (date.getTime() - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400e3);
}

/** Uniform random point on the sphere. */
export function randomSky(rand = Math.random) {
  const ra = rand() * 360;
  const dec = Math.asin(2 * rand() - 1) * 180 / Math.PI;
  return { ra, dec };
}

/** Great-circle separation in degrees. */
export function separation(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const s = Math.sin((dec2 - dec1) * r / 2) ** 2 +
    Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin((ra2 - ra1) * r / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / r;
}

// J2000 mean obliquity, for ecliptic <-> equatorial.
const EPS = 23.4392911 * Math.PI / 180;

/** Ecliptic (lon, lat) degrees -> ICRS-ish equatorial (ra, dec) degrees (J2000 mean ecliptic). */
export function eclToEq(lon, lat) {
  const r = Math.PI / 180, l = lon * r, b = lat * r;
  const x = Math.cos(b) * Math.cos(l);
  const y = Math.cos(b) * Math.sin(l) * Math.cos(EPS) - Math.sin(b) * Math.sin(EPS);
  const z = Math.cos(b) * Math.sin(l) * Math.sin(EPS) + Math.sin(b) * Math.cos(EPS);
  return { ra: ((Math.atan2(y, x) / r) + 360) % 360, dec: Math.asin(z) / r };
}

// ICRS -> Galactic rotation (Hipparcos / Liu et al. 2011 values).
const G = [
  [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
  [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
];

/** Galactic (l, b) degrees -> equatorial (ra, dec) degrees. */
export function galToEq(l, b) {
  const r = Math.PI / 180;
  const v = [Math.cos(b * r) * Math.cos(l * r), Math.cos(b * r) * Math.sin(l * r), Math.sin(b * r)];
  const x = G[0][0] * v[0] + G[1][0] * v[1] + G[2][0] * v[2];
  const y = G[0][1] * v[0] + G[1][1] * v[1] + G[2][1] * v[2];
  const z = G[0][2] * v[0] + G[1][2] * v[1] + G[2][2] * v[2];
  return { ra: ((Math.atan2(y, x) / r) + 360) % 360, dec: Math.asin(z) / r };
}
