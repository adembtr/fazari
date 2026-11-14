// High-proper-motion Gaia DR3 stars in the field, from VizieR (catalogue I/355/gaiadr3).
// Tested 2026-11-14 with an Origin header: the CDS VizieR mirror at IDIA sends
// Access-Control-Allow-Origin: *; vizier.cds.unistra.fr was down ("Page unavailable");
// the ESA Gaia archive TAP sends no CORS header (unusable from a browser).

const MIRRORS = [
  "https://vizier.idia.ac.za/viz-bin/asu-tsv",
  "https://vizier.cds.unistra.fr/viz-bin/asu-tsv",
];

/** Stars with total proper motion > pmMin (mas/yr) within radius (deg). Gaia DR3 epoch 2016.0.
 * Returns [{source_id, ra, dec, epoch, pmra, pmdec, plx, gmag, pm}]. Throws if no mirror answers. */
export async function highPmStars(ra, dec, radiusDeg, pmMin = 100, { signal } = {}) {
  const q = new URLSearchParams({
    "-source": "I/355/gaiadr3",
    "-c": `${ra.toFixed(6)} ${dec >= 0 ? "+" : ""}${dec.toFixed(6)}`,
    "-c.rd": radiusDeg.toFixed(4),
    "-out": "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,Gmag,PM",
    "-out.max": "200",
    PM: `>${pmMin}`,
  });
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
        if (!Number.isFinite(v("RA_ICRS")) || !Number.isFinite(v("pmRA"))) continue;   // units / dashes rows
        out.push({ source_id: f[ix("Source")].trim(), ra: v("RA_ICRS"), dec: v("DE_ICRS"), epoch: 2016.0,
                   pmra: v("pmRA"), pmdec: v("pmDE"), plx: Number.isFinite(v("Plx")) ? v("Plx") : 0,
                   gmag: v("Gmag"), pm: v("PM") });
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
