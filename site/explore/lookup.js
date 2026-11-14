// Name lookup: first our own named points, then CDS Sesame (SIMBAD, NED, VizieR).
// Sesame answers with CORS headers (tested Nov 2026), so this works from a static page.

import { applyPM, nowYear } from "./coords.js";

const SESAME = [
  "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?",
  "https://vizier.cds.unistra.fr/viz-bin/nph-sesame/-oxp/SNV?",
];

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Find one of our named points by (part of) its name or id. */
export function findLocal(points, text) {
  const q = norm(text);
  if (q.length < 2) return null;
  let best = null, bestScore = 0;
  for (const p of points) {
    const names = [p.name, p.id, ...(p.aliases || [])].map(norm);
    for (const n of names) {
      let score = 0;
      if (n === q) score = 3;
      else if (n.startsWith(q) && q.length >= 3) score = 2;
      else if (q.length >= 4 && n.includes(q)) score = 1;
      if (score > bestScore) { best = p; bestScore = score; }
    }
  }
  return best;
}

/** Resolve a name with Sesame. Returns {name, ra, dec, pmra, pmdec, type} (position moved to today). */
export async function sesame(text, { timeout = 8000 } = {}) {
  let lastErr;
  for (const base of SESAME) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(base + encodeURIComponent(text.trim()), { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = new DOMParser().parseFromString(await r.text(), "text/xml");
      const res = [...xml.querySelectorAll("Resolver")].find((el) => el.querySelector("jradeg"));
      if (!res) return null;                                  // answered, but unknown name
      const val = (sel) => res.querySelector(sel)?.textContent?.trim();
      let ra = Number(val("jradeg")), dec = Number(val("jdedeg"));
      const pmra = Number(val("pm > pmRA") || 0), pmdec = Number(val("pm > pmDE") || 0);
      // SIMBAD positions are at epoch J2000; move fast stars to today.
      let moved = false;
      if (Math.hypot(pmra, pmdec) > 50 && /simbad/i.test(res.getAttribute("name") || "")) {
        ({ ra, dec } = applyPM(ra, dec, pmra, pmdec, nowYear() - 2000));
        moved = true;
      }
      return {
        name: (val("oname") || text).replace(/^NAME\s+/, "").replace(/^\*\s+/, "").replace(/^V\*\s+/, ""),
        ra, dec, pmra, pmdec, moved, type: val("otype") || "",
      };
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("Name service unavailable");
}

// Plain-English names for the SIMBAD object types people will meet most often.
const OTYPES = {
  "*": "star", "PM*": "high-proper-motion star", "BD*": "brown dwarf", "BY*": "variable star (spotted)",
  "Mi*": "Mira variable star", "V*": "variable star", "TT*": "young T Tauri star", "WD*": "white dwarf",
  "G": "galaxy", "GiG": "galaxy in a group", "Sy2": "active galaxy", "Sy1": "active galaxy", "AGN": "active galaxy",
  "SyG": "active galaxy", "LIN": "galaxy", "BLL": "active galaxy", "QSO": "quasar", "HII": "glowing gas cloud (H II region)",
  "PN": "planetary nebula", "SNR": "supernova remnant", "OpC": "star cluster", "GlC": "globular cluster",
  "Cl*": "star cluster", "DNe": "dark nebula", "RNe": "reflection nebula", "SFR": "star-forming region",
  "MoC": "molecular cloud", "Cld": "cloud", "LM*": "low-mass star", "s*r": "red supergiant", "C*": "carbon star",
  "S*": "S-type star", "Pe*": "peculiar star", "**": "double star", "X": "X-ray source", "reg": "sky region",
  "As*": "star group", "Psr": "pulsar", "Em*": "emission-line star", "Be*": "Be star", "dS*": "pulsating star", "RR*": "pulsating star",
  "Ce*": "Cepheid variable star", "EB*": "eclipsing double star", "SB*": "double star", "HS*": "hot star", "RG*": "red giant",
  "AB*": "giant star", "Y*O": "young star", "MS*": "star", "SN*": "supernova", "Neb": "nebula", "ISM": "gas cloud",
};
export const plainType = (t) => OTYPES[t] || "";
