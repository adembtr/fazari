// Static catalogue stars close to a moving target's track, marked on the blink as "unrelated background star".
// Example: WISE 0855-0714 passes 4″ from Gaia DR3 5756956644387831296 (G = 16.3, proper motion 6 mas/yr) in 2026,
// which is easy to mistake for the target (and confused our centroid before the ePSF fit).
// Rule: a star of the result's own gaia_field.json (Gaia DR3, written by the pipeline) with proper motion below
// 100 mas/yr whose position lies within 6″ of the segments joining the measured positions. Nothing is drawn for
// results without measured motion or without gaia_field.json.

import { gridOf } from "./marking.js";
import { t } from "./i18n.js";

const MAX_SEP = 6;            // arcsec from the target's track
const STATIC_PM = 100;        // mas/yr: below this the star does not move visibly in a year of SPHEREx
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);

/** [{ id, ra, dec, g, sep }] of the static stars near the track ([] when none / no data). */
export async function findNeighbours(base, meta) {
  const ms = (meta && meta.measured) || {};
  const pos = (ms.positions || []).filter((p) => ok(p.ra) && ok(p.dec));
  if (pos.length < 2) return [];
  const d0 = (+meta.dec * Math.PI) / 180, c = Math.cos(d0);
  const off = (ra, dec) => [(ra - meta.ra) * c * 3600, (dec - meta.dec) * 3600];       // arcsec, east and north
  const tr = pos.map((p) => off(+p.ra, +p.dec));
  if (Math.hypot(tr[tr.length - 1][0] - tr[0][0], tr[tr.length - 1][1] - tr[0][1]) < 1) return [];   // not a moving target
  let gf;
  try {
    const r = await fetch(base + "gaia_field.json");
    if (!r.ok) return [];
    gf = JSON.parse((await r.text()).replace(/\[(\d{16,20}),/g, '["$1",'));   // keep the 19-digit source_id exact
  } catch (e) { return []; }
  const col = (n) => (gf.columns || []).indexOf(n);
  const [iI, iR, iD, iA, iP, iG] = ["source_id", "ra", "dec", "pmra", "pmdec", "phot_g_mean_mag"].map(col);
  if (iR < 0 || iD < 0) return [];
  const dt = (ok(meta.epoch_center) ? +meta.epoch_center : 2026) - (ok(gf.ref_epoch) ? +gf.ref_epoch : 2016);
  const seg = ([px, py], [ax, ay], [bx, by]) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, u = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    return Math.hypot(px - ax - u * dx, py - ay - u * dy);
  };
  const out = [];
  for (const s of gf.stars || []) {
    const pa = iA >= 0 && ok(s[iA]) ? +s[iA] : 0, pd = iP >= 0 && ok(s[iP]) ? +s[iP] : 0;
    if (Math.hypot(pa, pd) >= STATIC_PM) continue;
    const ra = +s[iR] + (pa / 3.6e6) * dt / c, dec = +s[iD] + (pd / 3.6e6) * dt;
    const p = off(ra, dec);
    let sep = Infinity;
    for (let i = 0; i + 1 < tr.length; i++) sep = Math.min(sep, seg(p, tr[i], tr[i + 1]));
    if (sep <= MAX_SEP) out.push({ id: iI >= 0 ? String(s[iI]) : "", ra, dec, g: iG >= 0 ? +s[iG] : null, sep });
  }
  return out;
}

/** Where each label goes, in screen px of the stage: above or below its diamond (away from the track), slid
 *  sideways to stay inside. view = { tx, ty, k, Sw, Sh } (the viewer's zoom transform and stage size). */
export function neighbourLayout(list, meta, track, view) {
  const grid = gridOf(meta);
  if (!grid || !list || !list.length || !view || !(view.k > 0)) return [];
  const txt = t("fi.nb.label"), w = txt.length * 12 * 0.56, h = 15;
  return list.map((n) => {
    const [x, y] = grid.toPng(n.ra, n.dec);
    let up = true;
    if (track && track.length) {
      const near = track.reduce((b, p) => (Math.hypot(p[0] - x, p[1] - y) < Math.hypot(b[0] - x, b[1] - y) ? p : b));
      up = y - near[1] <= 0;                                  // star north of the track: label above it
    }
    const sx = view.tx + x * view.k, sy = view.ty + y * view.k;
    const cx = Math.min(Math.max(sx, 6 + w / 2), (view.Sw || 9999) - 6 - w / 2);
    const top = up ? sy - 12 - h : sy + 12;
    return { n, x, y, txt, box: [cx - w / 2, top, cx + w / 2, top + h], lx: (cx - view.tx) / view.k, ly: (top + h / 2 - view.ty) / view.k };
  });
}

/** SVG (PNG pixel units, u = PNG px per screen px) for the overlay of js/viewer.js; adds a legend line. */
export function neighbourSvg(items, u, legend) {
  if (!items || !items.length) return "";
  const col = "#d7b3ff";
  let s = "";
  for (const it of items) {
    const { x, y } = it, r = 7 * u;
    const dia = `M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`;
    s += `<path d="${dia}" fill="none" stroke="#05070d" stroke-width="${4 * u}"/>` +
      `<path d="${dia}" fill="none" stroke="${col}" stroke-width="${2 * u}" stroke-dasharray="${3 * u} ${2 * u}"/>` +
      `<text x="${it.lx.toFixed(1)}" y="${it.ly.toFixed(1)}" fill="${col}" font-size="${12 * u}" font-weight="700" text-anchor="middle" ` +
      `dominant-baseline="middle" stroke="#05070d" stroke-width="${3 * u}" paint-order="stroke" font-family="system-ui, sans-serif">${it.txt}</text>`;
  }
  legend.push(`<span><i class="lg" style="width:9px;height:9px;border:2px dashed ${col};transform:rotate(45deg);display:inline-block"></i>${t("fi.nb.lg")}</span>`);
  return s;
}
