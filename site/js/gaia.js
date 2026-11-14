// High-proper-motion Gaia DR3 stars in the field, from VizieR (catalogue I/355/gaiadr3).
// Tested 2026-11-14 with an Origin header: the CDS VizieR mirror at IDIA sends
// Access-Control-Allow-Origin: *; vizier.cds.unistra.fr was down ("Page unavailable");
// the ESA Gaia archive TAP sends no CORS header (unusable from a browser).

const MIRRORS = [
  "https://vizier.idia.ac.za/viz-bin/asu-tsv",
  "https://vizier.cds.unistra.fr/viz-bin/asu-tsv",
];

const cache = new Map();   // query string -> Promise<stars>

/** Stars with total proper motion > pmMin (mas/yr) within radius (deg). Gaia DR3 epoch 2016.0.
 * Returns [{source_id, ra, dec, epoch, pmra, pmdec, plx, gmag, pm}]. Throws if no mirror answers. */
export function highPmStars(ra, dec, radiusDeg, pmMin = 100, { signal } = {}) {
  return gaiaStars(ra, dec, radiusDeg, { pmMin, max: 200, signal });
}

/** Gaia DR3 stars within radius (deg), optionally G < gmax and/or PM > pmMin. Cached in memory.
 * Stars without a 5-parameter solution come back with pmra = pmdec = plx = 0 and has5p = false. */
export function gaiaStars(ra, dec, radiusDeg, { gmax = null, pmMin = null, max = 5000, signal } = {}) {
  const q = new URLSearchParams({
    "-source": "I/355/gaiadr3",
    "-c": `${ra.toFixed(6)} ${dec >= 0 ? "+" : ""}${dec.toFixed(6)}`,
    "-c.rd": radiusDeg.toFixed(4),
    "-out": "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,Gmag,PM,RUWE",
    "-out.max": String(max),
  });
  if (pmMin != null) q.set("PM", `>${pmMin}`);
  if (gmax != null) q.set("Gmag", `<${gmax}`);
  const key = q.toString();
  if (!cache.has(key)) {
    const p = queryMirrors(q, signal);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

async function queryMirrors(q, signal) {
  let lastErr;
  for (const base of MIRRORS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    if (signal) signal.addEventListener("abort", () => ctl.abort(), { once: true });
    try {
      const res = await fetch(`${base}?${q}`, { signal: ctl.signal });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const text = await res.text();
      const rows = text.split("\n").filter((l) => l && !l.startsWith("#"));
      const head = rows[0] ? rows[0].split("\t").map((s) => s.trim()) : [];
      const ix = (n) => head.indexOf(n);
      if (ix("RA_ICRS") < 0) { lastErr = new Error("unexpected VizieR answer"); continue; }
      const out = [];
      for (const line of rows.slice(1)) {
        const f = line.split("\t");
        const v = (n) => Number(f[ix(n)]);
        if (!Number.isFinite(v("RA_ICRS")) || !/\d/.test(f[ix("Source")] || "")) continue;   // units / dashes rows
        const has5p = f[ix("pmRA")].trim() !== "" && Number.isFinite(v("pmRA"));
        out.push({ source_id: f[ix("Source")].trim(), ra: v("RA_ICRS"), dec: v("DE_ICRS"), epoch: 2016.0,
                   pmra: has5p ? v("pmRA") : 0, pmdec: has5p ? v("pmDE") : 0,
                   plx: has5p && Number.isFinite(v("Plx")) ? v("Plx") : 0,
                   gmag: v("Gmag"), pm: has5p ? v("PM") : 0, has5p,
                   ruwe: ix("RUWE") >= 0 && Number.isFinite(v("RUWE")) ? v("RUWE") : null });
      }
      return out;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Gaia query unavailable (${lastErr ? lastErr.message : "no answer"})`);
}

/** Tycho-2 stars brighter than vmax within radius (deg), for saturated reference stars (the Gaia
 * DR3 cone search is too slow over degrees on VizieR). Positions at J2000 with proper motion
 * (~60 mas error in 2026). Cached. Returns [{id, ra, dec, epoch, pmra, pmdec, plx, mag}]. */
export function tychoStars(ra, dec, radiusDeg, vmax = 10.5, { signal } = {}) {
  const q = new URLSearchParams({
    "-source": "I/259/tyc2",
    "-c": `${ra.toFixed(6)} ${dec >= 0 ? "+" : ""}${dec.toFixed(6)}`,
    "-c.rd": radiusDeg.toFixed(3),
    "-out": "TYC1,TYC2,TYC3,RAmdeg,DEmdeg,pmRA,pmDE,VTmag",
    "-out.max": "20000",
    VTmag: `<${vmax}`,
  });
  const key = q.toString();
  if (!cache.has(key)) {
    const p = (async () => {
      let lastErr;
      for (const base of MIRRORS) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 30000);
        if (signal) signal.addEventListener("abort", () => ctl.abort(), { once: true });
        try {
          const res = await fetch(`${base}?${q}`, { signal: ctl.signal });
          if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
          const rows = (await res.text()).split("\n").filter((l) => l && !l.startsWith("#"));
          const head = rows[0] ? rows[0].split("\t").map((x) => x.trim()) : [];
          const ix = (n) => head.indexOf(n);
          if (ix("RAmdeg") < 0) { lastErr = new Error("unexpected VizieR answer"); continue; }
          const out = [];
          for (const line of rows.slice(1)) {
            const f = line.split("\t");
            const v = (n) => Number(f[ix(n)]);
            if (!Number.isFinite(v("RAmdeg")) || f[ix("RAmdeg")].trim() === "" || !/\d/.test(f[ix("TYC1")])) continue;
            out.push({ id: `TYC ${f[ix("TYC1")].trim()}-${f[ix("TYC2")].trim()}-${f[ix("TYC3")].trim()}`,
                       ra: v("RAmdeg"), dec: v("DEmdeg"), epoch: 2000.0,
                       pmra: Number.isFinite(v("pmRA")) ? v("pmRA") : 0, pmdec: Number.isFinite(v("pmDE")) ? v("pmDE") : 0,
                       plx: 0, mag: v("VTmag") });
          }
          return out;
        } catch (e) {
          if (signal && signal.aborted) throw e;
          lastErr = e;
        } finally { clearTimeout(timer); }
      }
      throw new Error(`Tycho-2 query unavailable (${lastErr ? lastErr.message : "no answer"})`);
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return cache.get(key);
}
