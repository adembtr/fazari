// Fast stars: Gaia DR3 stars that move more than 0.5"/yr and that SPHEREx should see, from
// data/fast_stars.json.gz (gzipped JSON built by pipeline/fast_stars.py; cuts and sources are documented there).
//
// - Layer: glowing dots at their epoch-2026.0 positions, coloured by speed, with a legend.
// - Card: clicking a dot selects the star; the card gets its Gaia id, proper motion, the shift expected
//   between the SPHEREx seasons that cover it, and "visible in SPHEREx?" with the reason. The usual
//   "Fetch SPHEREx images here" flow works on it (position at 2026.0 plus proper motion).
// - "Surprise me": a fast star (motion guaranteed) or a truly random spot of the sky SPHEREx has seen.
// Credit: ESA/Gaia/DPAC, Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023).

import { propagate, offsetArcsec, mjdToMonth } from "../js/astro.js";
import { randomSky } from "./coords.js";
import { plainType } from "./lookup.js";

const DATA_URL = "data/fast_stars.json.gz";
const EPOCH = 2026.0;
const PIXEL = 6.2;                  // SPHEREx pixel, arcsec
const BINS = [                      // slowest first (drawn first, so the fastest end up on top)
  { min: 500, color: "#7fd4ff", label: "0.5–1″ per year", size: 11 },
  { min: 1000, color: "#ffe66d", label: "1–2″ per year", size: 15 },
  { min: 2000, color: "#ffad5c", label: "2–4″ per year", size: 19 },
  { min: 4000, color: "#ff5c8a", label: "over 4″ per year", size: 25 },
];
const BAND = {
  j: "2MASS J, 1.2 µm", h: "2MASS H, 1.6 µm", ks: "2MASS Ks, 2.2 µm", w1: "WISE W1, 3.4 µm",
  gaia_est: "estimated from Gaia G and BP−RP", gaia_g: "estimated from Gaia G",
};

let ext = null, data = null, dataP = null, cat = null, on = false, btn = null, legend = null;
const bySid = new Map(), byPid = new Map();

const binOf = (pm) => { let k = 0; while (k < BINS.length - 1 && pm >= BINS[k + 1].min) k++; return k; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (x, n = 1) => x.toLocaleString("en", { minimumFractionDigits: n, maximumFractionDigits: n });
const D2R = Math.PI / 180;

/** The fast-star list (cached). Each star: {sid, name, label, otype, pid, ra, dec (2016.0), pmra, pmdec, plx,
 * rv, g, bprp, m_spx, m_src, vis, why, seasons: [[mean MJD, images]], pm, r26, d26, bin}. */
export function loadFastStars() {
  if (!dataP) {
    dataP = fetch(DATA_URL).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let u8 = new Uint8Array(await r.arrayBuffer());
      // GitHub Pages and the local server send the .gz bytes as they are; a server may also have removed the layer.
      if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
      return JSON.parse(new TextDecoder().decode(u8));
    }).then((doc) => {
      const ix = Object.fromEntries(doc.fields.map((f, i) => [f, i]));
      const stars = doc.stars.map((row) => {
        const s = Object.fromEntries(doc.fields.map((f) => [f, row[ix[f]]]));
        const sp = s.seasons, mjd0 = doc.season_mjd0 ?? 60000;           // flat (MJD - mjd0, images) pairs
        s.seasons = [];
        for (let k = 0; k + 1 < sp.length; k += 2) s.seasons.push([sp[k] + mjd0, sp[k + 1]]);
        s.pm = Math.hypot(s.pmra, s.pmdec);
        const dt = EPOCH - doc.epoch;
        s.d26 = s.dec + s.pmdec * dt / 3.6e6;
        s.r26 = ((s.ra + s.pmra * dt / 3.6e6 / Math.cos(s.dec * D2R)) % 360 + 360) % 360;
        s.bin = binOf(s.pm);
        s.label = s.name || `Gaia DR3 ${s.sid}`;
        bySid.set(s.sid, s);
        if (s.pid) byPid.set(s.pid, s);
        return s;
      });
      data = { ...doc, stars };
      return data;
    });
    dataP.catch(() => { dataP = null; });
  }
  return dataP;
}

/** The selection object for a star: our own named point when it is one, else a new point. */
function pointFor(s) {
  const st = ext.state;
  if (s.pid && st.byId.has(s.pid)) return st.byId.get(s.pid);
  const key = "gaia:" + s.sid;
  if (!st.byId.has(key)) {
    st.byId.set(key, {
      id: null, name: s.label, ra: s.ra, dec: s.dec, epoch: 2016.0, ra_2026: s.r26, dec_2026: s.d26,
      pmra: s.pmra, pmdec: s.pmdec, parallax: s.plx, pmEpoch: EPOCH, cat: null, fast: s.sid, fov: 0.3,
      type: plainType(s.otype) || "fast-moving star",
      note: `Moves ${fmt(s.pm / 1000, 2)}″ every year. The dot shows where Gaia DR3 puts it in 2026.0.`,
    });
  }
  return st.byId.get(key);
}

// ---------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------
const sprites = [];
function glow(k) {
  if (sprites[k]) return sprites[k];
  const { color, size } = BINS[k];
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d"), m = size / 2;
  const g = ctx.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.16, "rgba(255,255,255,.95)");
  g.addColorStop(0.3, color);
  g.addColorStop(0.55, color + "66");
  g.addColorStop(1, color + "00");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  sprites[k] = cv;
  return cv;
}

async function ensureLayer() {
  const { state } = ext;
  if (cat || !state.al || !state.A) return cat;
  const d = await loadFastStars();
  if (cat) return cat;
  cat = state.A.catalog({ name: "Fast stars (Gaia DR3, > 0.5″/yr)", shape: (src) => glow(src.data.k), sourceSize: 16, color: "#ffffff" });
  state.al.addCatalog(cat);
  const order = [...d.stars].sort((a, b) => a.pm - b.pm);
  // main.js selects a clicked source through state.byId[data.pid]: our named points keep their own entry,
  // the other stars get a "gaia:<source_id>" entry (pointFor).
  cat.addSources(order.map((s) => {
    pointFor(s);
    const pid = s.pid && state.byId.has(s.pid) ? s.pid : "gaia:" + s.sid;
    return state.A.source(s.r26, s.d26, { name: s.label, pid, k: s.bin });
  }));
  return cat;
}

export async function setFastOn(v) {
  on = v;
  btn?.setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("fast-on", on);
  const cr = document.getElementById("creditGaia");
  if (cr) cr.hidden = !(on || document.body.classList.contains("gaia-now"));
  if (legend) legend.hidden = !on;
  if (!on) { cat?.hide(); return; }
  try {
    const d = await loadFastStars();
    renderLegend(d);
    const c = await ensureLayer();
    if (on) c?.show();
  } catch (e) {
    toastErr("The fast-star list could not be loaded.");
    console.warn(e);
  }
}

function toastErr(t) { ext?.toast?.(t, true); }

function renderLegend(d) {
  if (!legend) return;
  const n = BINS.map(() => 0);
  for (const s of d.stars) n[s.bin]++;
  legend.innerHTML = `<p class="fl-title">${d.stars.length.toLocaleString("en")} stars moving over 0.5″ a year</p>` +
    BINS.map((b, k) => `<span class="fl-row"><i style="--c:${b.color}"></i>${b.label}<small>${n[k].toLocaleString("en")}</small></span>`).reverse().join("") +
    `<p class="fl-src">Gaia DR3 (ESA), bright enough for SPHEREx, 2+ SPHEREx seasons</p>`;
}

// ---------------------------------------------------------------------------------------------
// Card: what this star does between the SPHEREx seasons
// ---------------------------------------------------------------------------------------------
/** Shifts (arcsec) from the first season to each later one: proper motion + parallax (+ perspective with rv). */
export function seasonShifts(s) {
  const t = { ra: s.ra, dec: s.dec, epoch: 2016.0, pmra: s.pmra, pmdec: s.pmdec, plx: s.plx > 0 ? s.plx : 0,
              rv: s.rv != null && s.plx > 0 ? s.rv : undefined };
  const pos = s.seasons.map(([mjd]) => propagate(t, mjd, true));
  const rows = s.seasons.slice(1).map(([mjd], i) => {
    const o = offsetArcsec(pos[0][0], pos[0][1], pos[i + 1][0], pos[i + 1][1]);
    return { from: s.seasons[0][0], to: mjd, arcsec: o[2], pa: o[3] };
  });
  let max = 0;
  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) max = Math.max(max, offsetArcsec(pos[i][0], pos[i][1], pos[j][0], pos[j][1])[2]);
  }
  return { rows, max };
}

function visText(s) {
  const m = `≈${fmt(s.m_spx, 1)} AB (${BAND[s.m_src] || s.m_src})`;
  const [why, d, who] = String(s.why).split(":");
  const verdict = { yes: "Yes", maybe: "Maybe", no: "No" }[s.vis] || s.vis;
  let reason;
  if (why === "saturated") reason = `very bright, ${m}. Its core is probably saturated; the position then comes from the wings, as for Barnard's Star.`;
  else if (why === "bright") reason = `bright enough: ${m}. One SPHEREx exposure reaches about 17.5 AB at 1–2 µm.`;
  else if (why === "faint") reason = `${m}, close to the ~17.5 AB limit of one SPHEREx exposure. It may show only at some wavelengths, or when a season's images are stacked.`;
  else if (why === "plane") reason = `${m}, in a crowded Milky Way field: neighbours can blend with it in 6.2″ pixels.`;
  else if (why === "near") reason = `${m}, but a brighter fast star (${esc(who)}) is only ${d}″ away. SPHEREx pixels are 6.2″, so the two may blend.`;
  else if (why === "blend") reason = `it is ${d}″ from the much brighter ${esc(who)}. In 6.2″ SPHEREx pixels the two blend into one dot.`;
  else reason = m;
  return `<span class="vis ${esc(s.vis)}">${verdict}</span> ${reason}`;
}

function blinkText(max) {
  if (max >= PIXEL) return `Easy to see in a blink: it moves more than one SPHEREx pixel (${PIXEL}″).`;
  if (max >= 2) return `Small: ${fmt(max / PIXEL, 1)} of a ${PIXEL}″ SPHEREx pixel. Look closely, or zoom into the blink.`;
  return `Too small to see by eye in a blink (under a third of a ${PIXEL}″ pixel). Only careful centroid measurements can show it.`;
}

function starFor(p) {
  if (!p) return null;
  if (p.fast) return bySid.get(p.fast) || null;
  if (p.id && byPid.has(p.id)) return byPid.get(p.id);
  return null;
}

function renderCardInfo(p) {
  const el = document.getElementById("cardFast");
  if (!el) return;
  const s = starFor(p);
  if (!s) { el.hidden = true; el.innerHTML = ""; return; }
  const sh = seasonShifts(s);
  const pa = ((Math.atan2(s.pmra, s.pmdec) / D2R) + 360) % 360;
  const dir = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(pa / 45) % 8];
  const seasons = s.seasons.map(([mjd, n]) => `${mjdToMonth(mjd)} <small>(${n})</small>`).join(" · ");
  const shifts = sh.rows.map((r) => `${mjdToMonth(r.from)} → ${mjdToMonth(r.to)}: <b>${fmt(r.arcsec, 1)}″</b>`).join(" · ");
  el.innerHTML =
    `<p class="fs-head"><i style="--c:${BINS[s.bin].color}" aria-hidden="true"></i><b>Fast star</b> · Gaia DR3 ${esc(s.sid)}` +
    (s.name && s.name !== p.name ? ` · ${esc(s.name)}` : "") + `</p>` +
    `<dl class="fs-grid">` +
    `<div><dt>Proper motion</dt><dd><b>${fmt(s.pm / 1000, 2)}″ per year</b> toward the ${dir} <small>(μα* ${fmt(s.pmra, 1)}, μδ ${fmt(s.pmdec, 1)} mas/yr${s.plx > 0 ? `; parallax ${fmt(s.plx, 1)} mas` : ""})</small></dd></div>` +
    `<div><dt>SPHEREx seasons</dt><dd>${seasons}</dd></div>` +
    `<div><dt>Expected shift</dt><dd>${shifts || "–"} <small>(largest ${fmt(sh.max, 1)}″ = ${fmt(sh.max / PIXEL, 2)} pixels)</small></dd></div>` +
    `<div><dt>Visible in SPHEREx?</dt><dd>${visText(s)}</dd></div>` +
    `</dl><p class="fine">${blinkText(sh.max)}</p>`;
  el.hidden = false;
}

// ---------------------------------------------------------------------------------------------
// Surprise me: two options
// ---------------------------------------------------------------------------------------------
export function openSurprise() {
  const { state } = ext;
  state.activeCat = "surprise";
  for (const b of document.querySelectorAll(".cat")) b.setAttribute("aria-pressed", String(b.dataset.cat === "surprise"));
  const det = document.getElementById("catDetail");
  det.hidden = false;
  det.style.setProperty("--c", "#ff8a5c");
  document.getElementById("catTitle").innerHTML = `<span aria-hidden="true">🎲</span> Surprise me`;
  document.getElementById("catDesc").textContent = "Pick the kind of surprise.";
  const disc = document.getElementById("catDisclaimer");
  disc.hidden = true; disc.innerHTML = "";
  const ul = document.getElementById("points");
  ul.innerHTML = "";
  const opts = [
    { k: "fast", name: "🏃 Fast star", desc: "A random star from our Gaia list of stars that move more than 0.5″ a year, picked among those that shift enough to notice between SPHEREx seasons. Motion guaranteed." },
    { k: "random", name: "🎯 Random sky", desc: "A truly random spot that SPHEREx has seen. Honest warning: most places on the sky show nothing moving." },
  ];
  for (const o of opts) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button"; b.className = "pt"; b.dataset.surprise = o.k;
    b.innerHTML = `<span class="pn">${o.name}</span><span class="pd">${esc(o.desc)}</span>`;
    b.onclick = () => (o.k === "fast" ? surpriseFast() : surpriseRandom());
    li.appendChild(b); ul.appendChild(li);
  }
  ext.syncCatalogs?.();
  document.body.classList.add("cat-open");
  if (ext.isPhone?.()) ext.setSheet?.("open");
}

export async function surpriseFast() {
  let d;
  try { d = await loadFastStars(); } catch { toastErr("The fast-star list could not be loaded."); return null; }
  // Motion guaranteed, and big enough to notice: SPHEREx sees the star and it shifts by at least a third of a
  // pixel (2") between its seasons (about 1 in 10 stars of the list).
  if (!d.blinkable) d.blinkable = d.stars.filter((s) => s.vis === "yes" && seasonShifts(s).max >= 2);
  const pool = d.blinkable.length ? d.blinkable : d.stars;
  const s = pool[Math.floor(Math.random() * pool.length)];
  if (!on) setFastOn(true);
  showAboveCard(pointFor(s), 0.3);
  return s;
}

/** Select p and fly so that it ends up in the free sky above the card, not hidden behind it. */
function showAboveCard(p, fov) {
  ext.select(p, { fly: false });
  const al = ext.state.al;
  const sky = document.getElementById("sky"), card = document.getElementById("card");
  if (!al || !sky || !card || card.hidden) { ext.select(p, { fly: true, fov }); return; }
  const H = sky.clientHeight, W = sky.clientWidth;
  const top = card.getBoundingClientRect().top - sky.getBoundingClientRect().top;
  const px = Math.max(0, H / 2 - Math.max(120, top) / 2);                 // centre of the free band above the card
  const ddec = px * fov / Math.max(1, W);                                   // Aladin's fov is the width
  const pos = p.ra_2026 != null ? { ra: p.ra_2026, dec: p.dec_2026 } : { ra: p.ra, dec: p.dec };
  ext.flyTo(pos.ra, Math.max(-89.9, pos.dec - ddec), fov);
}

export function surpriseRandom() {
  // Uniform on the sphere, kept only where the sky index lists 2+ SPHEREx seasons (rejection sampling keeps
  // it uniform over that area).
  let q = null;
  for (let i = 0; i < 2000; i++) {
    const r = randomSky();
    const cv = ext.coverageAt(r.ra, r.dec);
    if (!cv || cv.seasons >= 2) { q = r; break; }
  }
  q = q || randomSky();
  const p = {
    id: null, name: "Random sky spot", ra: q.ra, dec: q.dec, cat: null, type: "Random sky",
    note: "Most places on the sky show nothing moving. This spot was picked at random, evenly over the whole sky that SPHEREx has seen in 2 or more seasons.",
  };
  showAboveCard(p, 1);
  return p;
}

// ---------------------------------------------------------------------------------------------
export function initFastStars(e) {
  ext = e;
  btn = document.getElementById("tgFast");
  legend = document.getElementById("fastLegend");
  btn?.addEventListener("click", () => setFastOn(!on));
  e.hooks.card.push(renderCardInfo);
  // Card info for our own named points (Barnard's Star, ...) even when the layer is off.
  loadFastStars().then(() => { if (ext.state.selected) renderCardInfo(ext.state.selected); }).catch(() => {});
  if (startParams().get("fast") === "1") setFastOn(true);
  return { setFastOn, surpriseFast, surpriseRandom, openSurprise, isOn: () => on, loadFastStars, seasonShifts, bySid };
}

/** The page's query string as it was loaded (main.js rewrites the address bar when a spot is picked). */
function startParams() {
  try { return new URL(performance.getEntriesByType("navigation")[0]?.name || location.href).searchParams; }
  catch { return new URLSearchParams(location.search); }
}
