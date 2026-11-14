// Input resolution: coordinates (degrees or sexagesimal), the 5 challenge targets, or any
// name via the CDS Sesame resolver (SIMBAD; CORS-enabled, tested 2026-11-14), which also
// gives proper motion and parallax when SIMBAD has them.

import { TARGETS, ALIASES } from "./targets.js";

const SESAME = [
  "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?",       // redirects to a mirror, CORS *
  "https://vizier.idia.ac.za/viz-bin/nph-sesame/-oxp/SNV?",    // CDS mirror (IDIA), CORS *
];

const norm = (s) => s.toLowerCase().replace(/['’`]/g, " ").replace(/[^a-z0-9+\-. ]/g, " ").replace(/\s+/g, " ").trim();

/** Parse "RA Dec": degrees ("269.45 4.69", "269.45, +4.69") or sexagesimal
 * ("17:57:48.5 +04:41:36", "17h57m48.5s +4d41m36s", "17 57 48.5 +04 41 36"). Returns [ra, dec] or null. */
export function parseCoords(text) {
  const s = text.trim().replace(/[,;]/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  const num = "[+-]?\\d+(?:\\.\\d*)?|[+-]?\\.\\d+";
  let m = new RegExp(`^(${num})(?:\\s*(?:d|deg|°))?\\s+(${num})(?:\\s*(?:d|deg|°))?$`, "i").exec(s);
  if (m) {
    const ra = Number(m[1]), dec = Number(m[2]);
    return ra >= 0 && ra < 360 && Math.abs(dec) <= 90 ? [ra, dec] : null;
  }
  // sexagesimal: split into RA part and Dec part at the sign or after 3 RA fields
  const t = s.replace(/[hmsdms:°'"]/gi, " ").replace(/\s+/g, " ").trim().split(" ");
  let raF, decF;
  const signIdx = t.findIndex((x, i) => i > 0 && /^[+-]/.test(x));
  if (signIdx > 0) { raF = t.slice(0, signIdx); decF = t.slice(signIdx); }
  else if (t.length === 6) { raF = t.slice(0, 3); decF = t.slice(3); }
  else if (t.length === 4) { raF = t.slice(0, 2); decF = t.slice(2); }
  else return null;
  if (raF.length < 1 || raF.length > 3 || decF.length < 1 || decF.length > 3) return null;
  if (![...raF, ...decF].every((x) => new RegExp(`^(${num})$`).test(x))) return null;
  const sex = (f) => f.reduce((acc, v, i) => acc + Math.abs(Number(v)) / 60 ** i, 0);
  const ra = sex(raF) * 15;
  const sign = decF[0].startsWith("-") ? -1 : 1;
  const dec = sign * sex(decF);
  return ra >= 0 && ra < 360 && Math.abs(dec) <= 90 ? [ra, dec] : null;
}

/** One of the 5 challenge targets by key, name or alias. */
export function matchTarget(text) {
  const q = norm(text);
  if (TARGETS[q.replace(/ /g, "_")]) return q.replace(/ /g, "_");
  for (const [k, t] of Object.entries(TARGETS)) {
    if (norm(t.name) === q) return k;
    if ((ALIASES[k] || []).some((a) => norm(a) === q)) return k;
  }
  return null;
}

/** Resolve a name with Sesame. Returns {name, ra, dec, epoch, pmra, pmdec, plx, source} or null. */
export async function sesame(name, { signal } = {}) {
  let lastErr = null;
  for (const base of SESAME) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      if (signal) signal.addEventListener("abort", () => ctl.abort(), { once: true });
      const res = await fetch(base + encodeURIComponent(name), { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const get = (tag, src = xml) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(src); return m ? m[1].trim() : null; };
      const ra = get("jradeg"), dec = get("jdedeg");
      if (ra == null || dec == null) return null;
      const pmBlock = /<pm>([\s\S]*?)<\/pm>/.exec(xml);
      const plxBlock = /<plx>([\s\S]*?)<\/plx>/.exec(xml);
      return {
        name: (get("oname") || name).replace(/^NAME /, ""),
        ra: Number(ra), dec: Number(dec), epoch: 2000.0,    // SIMBAD positions are ICRS at J2000
        pmra: pmBlock ? Number(get("pmRA", pmBlock[1]) || 0) : 0,
        pmdec: pmBlock ? Number(get("pmDE", pmBlock[1]) || 0) : 0,
        plx: plxBlock ? Number(get("v", plxBlock[1]) || 0) : 0,
        source: "SIMBAD via CDS Sesame",
      };
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
    }
  }
  throw new Error(`name resolver unavailable (${lastErr ? lastErr.message : "no answer"})`);
}
