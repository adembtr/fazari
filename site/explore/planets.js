// Stars with known planets (NASA Exoplanet Archive), for the Sky Explorer. Loaded by main.js next to the other
// star layers; a failure here never breaks the sky.
//
// - Layer "Stars with known planets" (off by default): a violet ring at each host's 2026.0 position (moved from
//   the archive epoch with its proper motion). Clicking one selects it; the usual SPHEREx flow works on it.
// - Card: when the selected place is a planet host (archive name, Gaia DR3 id, or position at 2026.0), the card
//   says how many planets are known, links the archive's page, and says plainly that SPHEREx sees the star move,
//   not the planets.
// Data and matching: js/exohosts.js. Styles: explore/planets.css.

import { loadHosts, matchHost, hostAt, gaiaIdOf, hostHtml } from "../js/exohosts.js";
import { t as T, tn, num, onLang } from "../js/i18n.js";
import { plainType } from "./lookup.js";

const COLOR = "#c9a2ff";
let ext = null, on = false, btn = null, slot = null, cat = null, H = null;

function loadCss() {
  if (document.querySelector('link[data-fz="planets"]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "explore/planets.css"; l.dataset.fz = "planets";
  document.head.appendChild(l);
}

async function hosts() {
  if (!H) H = await loadHosts();
  return H;
}

// ---------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------
let sprite = null;
function ring() {
  if (sprite) return sprite;
  const s = 18, cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d");
  g.strokeStyle = COLOR; g.lineWidth = 2;
  g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 3, 0, 2 * Math.PI); g.stroke();
  g.fillStyle = "#fff"; g.beginPath(); g.arc(s / 2 + 5.3, s / 2 - 5.3, 2, 0, 2 * Math.PI); g.fill();   // a "planet" on the ring
  sprite = cv;
  return cv;
}

/** The place to select for a host: our own named point if one is this host, else a new "nea:" point. */
function pointFor(h) {
  const st = ext.state;
  for (const p of st.points || []) if (p.exo_host === h.host) return p;
  const key = "nea:" + h.host;
  if (!st.byId.has(key)) {
    const now = hostAt(h, 2026.0);
    const pm = num(h.pm / 1000, 2);
    st.byId.set(key, {
      id: null, name: h.host, ra: h.ra, dec: h.dec, epoch: h.epoch, ra_2026: now.ra, dec_2026: now.dec,
      pmra: h.pmra, pmdec: h.pmdec, parallax: h.plx > 0 ? h.plx : undefined, pmEpoch: 2026.0, cat: null,
      exo_host: h.host, fov: h.pm > 500 ? 0.3 : 0.5, type: plainType("star") || "star",
      note: `A star with ${h.n} known planet${h.n === 1 ? "" : "s"}.`,
      noteFn: () => tn("ex.pl.note", h.n, { pm }),
    });
  }
  return st.byId.get(key);
}

async function ensureLayer() {
  const { state } = ext;
  if (cat || !state.al || !state.A) return cat;
  const d = await hosts();
  if (cat) return cat;
  cat = state.A.catalog({ name: "Stars with known planets (NASA Exoplanet Archive)", shape: ring, sourceSize: 18, color: COLOR });
  state.al.addCatalog(cat);
  cat.addSources(d.hosts.map((h) => {
    const p = pointFor(h), pid = p.id || "nea:" + h.host, q = hostAt(h, 2026.0);
    return state.A.source(q.ra, q.dec, { name: h.host, pid });
  }));
  return cat;
}

export async function setPlanetsOn(v) {
  on = v;
  btn?.setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("planets-on", on);
  if (!on) { cat?.hide(); return; }
  try {
    const c = await ensureLayer();
    if (on) c?.show();
  } catch (e) {
    ext?.toast?.(T("ex.pl.loadFail"), true);
    console.warn(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------------------------
let shown = null;
async function renderCard(p) {
  if (!slot) return;
  shown = p;
  slot.hidden = true; slot.innerHTML = "";
  if (!p) return;
  let d;
  try { d = await hosts(); } catch { return; }
  if (shown !== p) return;                                         // another place was picked meanwhile
  // main.js passes state.selected, whose pos is where the marker sits (2026.0 for moving stars)
  const pos = p.pos || (p.ra_2026 != null ? { ra: p.ra_2026, dec: p.dec_2026 } : { ra: p.ra, dec: p.dec });
  const fs = p.fast ? String(p.fast) : null;
  const h = matchHost(d, { host: p.exo_host, gaia: fs || gaiaIdOf(p), ra: pos?.ra, dec: pos?.dec, year: 2026.0 });
  if (!h) return;
  slot.innerHTML = hostHtml(h, p.name);
  slot.hidden = false;
}

// ---------------------------------------------------------------------------------------------
export function initPlanets(e) {
  ext = e;
  loadCss();
  // Chip in the star layers group, after "Fast stars" (explore.html stays as it is).
  const tools = document.getElementById("starTools");
  if (tools && !document.getElementById("tgPlanets")) {
    btn = document.createElement("button");
    btn.type = "button"; btn.id = "tgPlanets"; btn.className = "chip"; btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = `<i aria-hidden="true"></i><span></span><small></small>`;
    const legend = document.getElementById("fastLegend");
    tools.insertBefore(btn, legend && legend.parentNode === tools ? legend : null);
    btn.addEventListener("click", () => setPlanetsOn(!on));
  }
  // Block in the place card, after the fast-star block.
  const fast = document.getElementById("cardFast");
  if (fast && !document.getElementById("cardPlanets")) {
    slot = document.createElement("div");
    slot.id = "cardPlanets"; slot.className = "exo-info"; slot.hidden = true; slot.setAttribute("aria-live", "polite");
    fast.after(slot);
  }
  const label = () => {
    if (!btn) return;
    btn.querySelector("span").textContent = T("ex.pl.name");
    btn.querySelector("small").textContent = T("ex.pl.sub");
    btn.title = T("ex.pl.title");
  };
  label();
  onLang(() => { label(); if (ext.state.selected) renderCard(ext.state.selected); });
  e.hooks.card.push(renderCard);
  if (ext.state.selected) renderCard(ext.state.selected);
  if (new URLSearchParams(location.search).get("planets") === "1") setPlanetsOn(true);
  return { setPlanetsOn, isOn: () => on };
}
