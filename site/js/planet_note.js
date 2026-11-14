// Result viewer (ornek.html) plug-in: when the result's target is a star with known planets (NASA Exoplanet
// Archive), the "Our result" box says so, links the archive page and says that SPHEREx sees the star move, not
// the planets. Match: Gaia DR3 id of the target, else its position at the grid epoch (js/exohosts.js).

import { loadHosts, matchHost, hostHtml } from "./exohosts.js";
import { onLang } from "./i18n.js";

export async function mountPlanetNote(meta) {
  if (!meta) return null;
  const H = await loadHosts();
  const g = meta.gaia || {};
  const h = matchHost(H, { gaia: g.source_id, ra: meta.ra, dec: meta.dec, year: meta.epoch_center ?? 2026.0 });
  if (!h) return null;
  if (!document.querySelector('link[data-fz="planets"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "explore/planets.css"; l.dataset.fz = "planets";
    document.head.appendChild(l);
  }
  let el = document.getElementById("planetNote");
  if (!el) {
    el = document.createElement("div");
    el.id = "planetNote"; el.className = "exo-info";
    const at = document.getElementById("verdict") || document.getElementById("tiles");
    if (at) at.after(el); else document.getElementById("result")?.appendChild(el);
  }
  const render = () => { el.innerHTML = hostHtml(h, meta.target || ""); };
  render();
  onLang(render);
  return h;
}
