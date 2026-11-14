// Stars with known planets: data/exoplanet_hosts.json (NASA Exoplanet Archive, pscomppars; built by
// pipeline/exoplanet_hosts.py). Shared by the explorer (explore/planets.js) and the result viewer (js/planet_note.js).
//
// Matching moves each host from its catalogue epoch to the observation epoch with its proper motion first:
// Barnard's Star moves 10.4" a year, so its 2015.5 archive position is 109" from where it is in 2026.
// Rows with a Gaia DR2 position (epoch 2015.5) match within 4"; the few rows near J2000 without Gaia get a
// wider radius (their epoch is only known to about 2 years).
// Credit: NASA Exoplanet Archive (Caltech/IPAC, NASA Exoplanet Exploration Program).

import { t, tn } from "./i18n.js";

const DATA = "data/exoplanet_hosts.json";
const OVERVIEW = "https://exoplanetarchive.ipac.caltech.edu/overview/{host}";
const D2R = Math.PI / 180;

let P = null;

/** {doc, hosts: [{host, ra, dec, pmra, pmdec, epoch, n, plx, dist_pc, gaia_dr3, tol}], byName, byGaia} (cached). */
export function loadHosts(base = "") {
  if (!P) {
    P = fetch(base + DATA).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((doc) => {
      const ix = Object.fromEntries(doc.fields.map((f, i) => [f, i]));
      const hosts = [], byName = new Map(), byGaia = new Map();
      for (const row of doc.hosts) {
        const h = Object.fromEntries(doc.fields.map((f) => [f, row[ix[f]]]));
        if (typeof h.host !== "string" || !Number.isFinite(h.ra) || !Number.isFinite(h.dec) || !(h.n >= 1)) continue;
        h.pmra = Number.isFinite(h.pmra) ? h.pmra : 0;
        h.pmdec = Number.isFinite(h.pmdec) ? h.pmdec : 0;
        h.pm = Math.hypot(h.pmra, h.pmdec);                       // mas/yr
        h.tol = h.epoch === 2015.5 ? 4 : 4 + 2 * h.pm / 1000;     // arcsec
        hosts.push(h);
        byName.set(h.host.toLowerCase(), h);
        if (h.gaia_dr3) byGaia.set(String(h.gaia_dr3), h);
      }
      return { doc, hosts, byName, byGaia };
    });
    P.catch(() => { P = null; });
  }
  return P;
}

/** Position of a host at a Julian year (linear proper motion, like the rest of the site). */
export function hostAt(h, year = 2026.0) {
  const dt = year - h.epoch;
  const dec = h.dec + h.pmdec * dt / 3.6e6;
  const ra = (((h.ra + h.pmra * dt / 3.6e6 / Math.cos(h.dec * D2R)) % 360) + 360) % 360;
  return { ra, dec };
}

function sep(ra1, dec1, ra2, dec2) {                              // arcsec, small angles
  const dx = ((ra1 - ra2 + 540) % 360 - 180) * Math.cos(((dec1 + dec2) / 2) * D2R);
  return Math.hypot(dx, dec1 - dec2) * 3600;
}

/**
 * The host for a place, or null. q: {host (archive name), gaia (Gaia DR3 source_id), ra, dec (degrees at year),
 * year (default 2026.0)}. Name and Gaia id win; else the nearest host within its radius after moving it to year.
 */
export function matchHost(H, q) {
  if (!H || !q) return null;
  if (q.host && H.byName.has(String(q.host).toLowerCase())) return H.byName.get(String(q.host).toLowerCase());
  if (q.gaia && H.byGaia.has(String(q.gaia))) return H.byGaia.get(String(q.gaia));
  if (!Number.isFinite(q.ra) || !Number.isFinite(q.dec)) return null;
  const year = q.year ?? 2026.0;
  let best = null, bd = Infinity;
  for (const h of H.hosts) {
    const reach = (h.tol + h.pm / 1000 * Math.abs(year - h.epoch) + 60) / 3600;   // cheap declination cut
    if (Math.abs(h.dec - q.dec) > reach) continue;
    const p = hostAt(h, year), d = sep(p.ra, p.dec, q.ra, q.dec);
    if (d <= h.tol && d < bd) { best = h; bd = d; }
  }
  return best;
}

/** A Gaia DR3 source_id written in a place's fields ("Gaia DR3 4472832130942575872 (...)"), or null. */
export function gaiaIdOf(p) {
  if (!p) return null;
  for (const v of [p.gaia_dr3, p.parallax_source, p.source]) {
    const m = /Gaia DR3 (\d{6,20})/.exec(String(v ?? ""));
    if (m) return m[1];
  }
  return null;
}

export const overviewUrl = (h) => OVERVIEW.replace("{host}", encodeURIComponent(h.host).replace(/'/g, "%27"));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Card block (HTML): N known planets + archive link + the honesty sentence. shownName: the name on the card. */
export function hostHtml(h, shownName = "") {
  const same = String(shownName).toLowerCase().replace(/[^a-z0-9]/g, "") === h.host.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `<p class="exo-head"><span class="exo-ico" aria-hidden="true">🪐</span><b>${esc(tn("pg.exo.has", h.n))}</b></p>` +
    `<p class="exo-link"><a href="${esc(overviewUrl(h))}" target="_blank" rel="noopener">${esc(t("pg.exo.link"))} ↗</a>` +
    (same ? "" : ` <small>${esc(t("pg.exo.as", { host: h.host }))}</small>`) + `</p>` +
    `<p class="exo-honest">${esc(t("pg.exo.honest"))}</p>`;
}
