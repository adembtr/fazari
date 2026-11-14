// "Stars now (Gaia 2026)": Gaia DR3 stars of the visible field, drawn where they are at epoch 2026.0.
//
// The background maps are old (DSS2 plates 1950s-1990s, 2MASS ~1999, PanSTARRS ~2012), so a star with a
// large proper motion sits off its image; the rings of this layer show where Gaia DR3 puts it in 2026.0.
//
// - Shown only when the field of view is below ~1 deg (wider fields hold too many stars to be useful).
// - The sky is cut into HEALPix nested tiles: order 7 (0.46 deg) for fields of 0.25-1 deg, G < 18; order 8
//   (0.23 deg) for 0.08-0.25 deg, G < 20; order 9 (0.11 deg) below, all stars. Each tile is one VizieR cone
//   search around the tile (I/355/gaiadr3, brightest first, at most 3000 rows), filtered to the tile and cached
//   in memory (80 tiles). Queries start once the view has been still for 350 ms; at most 2 run at once,
//   nearest tile first. At most 3000 stars (brightest first) are drawn.
// - Positions: Gaia DR3 (ICRS, epoch 2016.0) moved by linear proper motion to 2026.0 in float64. Barycentric:
//   no parallax (a star's position changes by at most its parallax over the year, < 0.8").
// - Ring size from G, colour from BP-RP (same colour ramp as desktop/sky_render.py).
// Credit: ESA/Gaia/DPAC, Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023), via CDS VizieR.

import { ang2pixNest } from "../js/skyindex.js";

const MIRRORS = [                   // VizieR mirrors that answer with CORS (see site/js/gaia.js)
  "https://vizier.idia.ac.za/viz-bin/asu-tsv",
  "https://vizier.cds.unistra.fr/viz-bin/asu-tsv",
];
export const EPOCH = 2026.0;
const GAIA_EPOCH = 2016.0;
const FOV_MAX = 1.05;               // deg (view width): "about 1 deg", so the usual 1 deg fly-to view shows it
const MAX_STARS = 3000;
const LODS = [                      // first one whose fovMin <= fov
  { fovMin: 0.25, order: 7, gmax: 18 },
  { fovMin: 0.08, order: 8, gmax: 20 },
  { fovMin: 0, order: 9, gmax: null },
];
// The VizieR mirror queues parallel requests (4 at once took 6-25 s each), so 2 at a time.
const DEBOUNCE_MS = 350, MAX_INFLIGHT = 2, TIMEOUT_MS = 40000;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// HEALPix (nested): pixel centre and corners, the inverse of ang2pixNest in site/js/skyindex.js
// ---------------------------------------------------------------------------------------------
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
function compact(v) {              // every other bit of v, packed
  let out = 0;
  for (let b = 0; b < 16; b++) out |= ((v >>> (2 * b)) & 1) << b;
  return out;
}
/** Face coordinates (x, y in [0, 1]) of face f -> [ra, dec] degrees (healpix_base xyf2loc). */
function xyf2radec(x, y, f) {
  const jr = JRLL[f] - x - y;
  let nr, z;
  if (jr < 1) { nr = jr; z = 1 - nr * nr / 3; }
  else if (jr > 3) { nr = 4 - jr; z = nr * nr / 3 - 1; }
  else { nr = 1; z = (2 - jr) * 2 / 3; }
  let t = JPLL[f] * nr + x - y;
  if (t < 0) t += 8;
  if (t >= 8) t -= 8;
  const phi = nr < 1e-15 ? 0 : (Math.PI / 4 * t) / nr;
  return [((phi / D2R) % 360 + 360) % 360, Math.asin(Math.max(-1, Math.min(1, z))) / D2R];
}
/** Centre and the 4 corners of a nested pixel: {centre: [ra, dec], corners: [[ra, dec] x 4]}. */
export function pixGeometry(order, pix) {
  const nside = 1 << order, npface = nside * nside;
  const f = Math.floor(pix / npface), ipf = pix - f * npface;
  const ix = compact(ipf), iy = compact(ipf >>> 1);
  const xc = (ix + 0.5) / nside, yc = (iy + 0.5) / nside, d = 0.5 / nside;
  return {
    centre: xyf2radec(xc, yc, f),
    corners: [[xc + d, yc + d], [xc - d, yc + d], [xc - d, yc - d], [xc + d, yc - d]].map(([x, y]) => xyf2radec(x, y, f)),
  };
}

function sepDeg(ra1, dec1, ra2, dec2) {
  const s = Math.sin((dec2 - dec1) * D2R / 2) ** 2 + Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / D2R;
}

/** Linear proper motion (mas/yr, pmra includes cos dec) from Gaia's 2016.0 to `epoch`, float64. */
export function moveTo(ra, dec, pmra, pmdec, epoch = EPOCH) {
  const dt = epoch - GAIA_EPOCH;
  const d = dec + pmdec * dt / 3.6e6;
  const r = ra + pmra * dt / 3.6e6 / Math.max(Math.cos(dec * D2R), 1e-9);
  return [((r % 360) + 360) % 360, Math.max(-90, Math.min(90, d))];
}

// ---------------------------------------------------------------------------------------------
// Catalogue tiles
// ---------------------------------------------------------------------------------------------
const tiles = new Map();           // "order/pix" -> {stars, promise, error, ms}
let inflight = 0;
const queue = [];

async function fetchTile(order, pix, gmax) {
  const g = pixGeometry(order, pix);
  const [ra, dec] = g.centre;
  const radius = Math.max(...g.corners.map((c) => sepDeg(ra, dec, c[0], c[1]))) * 1.02 + 2 / 3600;
  const q = new URLSearchParams({
    "-source": "I/355/gaiadr3",
    "-c": `${ra.toFixed(6)} ${dec >= 0 ? "+" : ""}${dec.toFixed(6)}`,
    "-c.rd": radius.toFixed(4),
    "-out": "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,Gmag,BP-RP",
    "-out.max": String(MAX_STARS),
    "-sort": "Gmag",
  });
  if (gmax != null) q.set("Gmag", `<${gmax}`);
  let lastErr;
  for (const base of MIRRORS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}?${q}`, { signal: ctl.signal });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const lines = (await res.text()).split("\n").filter((l) => l && !l.startsWith("#"));
      const head = lines[0] ? lines[0].split("\t").map((s) => s.trim()) : [];
      const ix = Object.fromEntries(head.map((h, i) => [h, i]));
      if (ix.RA_ICRS == null || ix.Gmag == null) { lastErr = new Error("unexpected VizieR answer"); continue; }
      const out = [];
      for (const line of lines.slice(1)) {
        const f = line.split("\t");
        const ra0 = Number(f[ix.RA_ICRS]), dec0 = Number(f[ix.DE_ICRS]);
        if (!/\d/.test(f[ix.Source] || "") || !Number.isFinite(ra0) || f[ix.RA_ICRS].trim() === "") continue;  // units / dashes
        if (ang2pixNest(order, ra0, dec0) !== pix) continue;              // the cone is larger than the tile
        const num = (k) => { const s = (f[ix[k]] || "").trim(); return s === "" ? NaN : Number(s); };
        const pmra = num("pmRA"), pmdec = num("pmDE");
        const has = Number.isFinite(pmra) && Number.isFinite(pmdec);
        const [r26, d26] = has ? moveTo(ra0, dec0, pmra, pmdec) : [ra0, dec0];
        out.push({ sid: f[ix.Source].trim(), ra: r26, dec: d26, g: num("Gmag"), c: num("BP-RP"),
                   pm: has ? Math.hypot(pmra, pmdec) : null, plx: num("Plx") });
      }
      return out;
    } catch (e) {
      lastErr = e;
    } finally { clearTimeout(timer); }
  }
  throw new Error(`Gaia query unavailable (${lastErr ? lastErr.message : "no answer"})`);
}

let current = null;                // what the view wants now: {lod, pixes, keys}
let failures = 0, retryTimer = 0;
function wantTile(order, pix, gmax) {
  const key = `${order}/${pix}`;
  let t = tiles.get(key);
  if (t) return t;
  t = { key, stars: null, error: null, ms: 0 };
  tiles.set(key, t);
  t.run = () => {
    const t0 = performance.now();
    inflight++;
    fetchTile(order, pix, gmax)
      .then((s) => { t.stars = s; t.ms = performance.now() - t0; stats.queries.push(Math.round(t.ms)); failures = 0; evict(); })
      .catch((e) => {                                              // retried a few times, then on the next view change
        t.error = e; tiles.delete(key); failures++;
        console.warn("Gaia tile", key, e.message);
        if (on && failures <= 3) { clearTimeout(retryTimer); retryTimer = setTimeout(refresh, 4000); }
      })
      .finally(() => { inflight--; pump(); if (on && current) draw(current.lod, current.pixes); });
  };
  queue.push(t);
  return t;
}
const MAX_TILES = 80;              // memory cache: oldest loaded tiles out of view go first
function evict() {
  for (const [k, t] of tiles) {
    if (tiles.size <= MAX_TILES) break;
    if (t.stars && !(current && current.keys.has(k))) tiles.delete(k);
  }
}
function pump() {
  while (inflight < MAX_INFLIGHT && queue.length) {
    const t = queue.shift();
    if (!current || !current.keys.has(t.key)) { tiles.delete(t.key); continue; }   // the view moved on
    t.run();
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing: one sprite per (ring size, colour) bucket, shared by all sources
// ---------------------------------------------------------------------------------------------
function starColor(c) {             // BP-RP -> rgb, ramp of desktop/sky_render.py (star_color)
  if (!Number.isFinite(c)) c = 0.82;                       // no colour: Sun-like
  c = Math.max(-0.4, Math.min(3.5, c));
  // more saturated than the desktop ramp, so thin rings stay visible on top of white star images
  const S = [[-0.4, [0.45, 0.62, 1.00]], [0.2, [0.68, 0.80, 1.00]], [0.8, [1.00, 0.95, 0.72]],
             [1.3, [1.00, 0.80, 0.45]], [2.2, [1.00, 0.60, 0.30]], [3.5, [1.00, 0.42, 0.25]]];
  let k = 0;
  while (k < S.length - 2 && c > S[k + 1][0]) k++;
  const [c0, a] = S[k], [c1, b] = S[k + 1];
  const t = (c - c0) / (c1 - c0);
  return a.map((v, i) => Math.round(255 * (v + (b[i] - v) * t)));
}
/** Ring radius (px) from G: bright stars get bigger rings. */
export const ringRadius = (g) => Math.max(2.2, Math.min(11, 2 + 0.42 * (20.5 - (Number.isFinite(g) ? g : 20))));
/** Zoom factor for the rings: star images grow as you zoom in, so the rings grow too (steps, to share sprites). */
const zoomStep = (fov) => [1, 1.25, 1.6, 2, 2.5, 3][Math.max(0, Math.min(5, Math.floor(Math.log2(0.5 / Math.max(fov, 1e-4)) * 1.2)))];

const sprites = new Map();
function sprite(g, c, k = 1) {
  const r = Math.round(ringRadius(g) * k * 2) / 2;
  const cb = Number.isFinite(c) ? Math.round(Math.max(-0.4, Math.min(3.5, c)) * 4) / 4 : 0.82;
  const key = `${r}|${cb}`;
  let cv = sprites.get(key);
  if (cv) return cv;
  const size = Math.ceil(2 * r + 6);
  cv = document.createElement("canvas");
  cv.width = cv.height = size;                // drawn 1:1 in CSS px by Aladin
  const ctx = cv.getContext("2d");
  const [R, G, B] = starColor(cb);
  const m = size / 2;
  ctx.lineWidth = r > 4 ? 3.4 : 2.6;
  ctx.strokeStyle = "rgba(0,0,0,.6)";
  ctx.beginPath(); ctx.arc(m, m, r, 0, 2 * Math.PI); ctx.stroke();
  ctx.lineWidth = r > 4 ? 1.7 : 1.2;
  ctx.strokeStyle = `rgb(${R},${G},${B})`;
  ctx.beginPath(); ctx.arc(m, m, r, 0, 2 * Math.PI); ctx.stroke();
  ctx.fillStyle = `rgb(${R},${G},${B})`;
  ctx.fillRect(m - 0.5, m - 0.5, 1, 1);
  sprites.set(key, cv);
  return cv;
}

// ---------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------
const stats = { queries: [], drawn: 0, tiles: 0 };
let ext = null, cat = null, on = false, timer = 0, view = null, shownKey = "", btn = null, sub = null;

export function initStarsNow(e) {
  ext = e;
  const { state } = e;
  if (!state.al || !state.A) return null;
  cat = state.A.catalog({ name: "Gaia DR3 stars at 2026.0", shape: (s) => sprite(s.data.g, s.data.c, s.data.k), sourceSize: 14, color: "#ffffff" });
  state.al.addCatalog(cat);
  cat.hide();
  e.hooks.view.push((ra, dec, fov) => { view = { ra, dec, fov }; if (on) schedule(); });
  btn = document.getElementById("tgStarsNow");
  sub = btn?.querySelector("small");
  btn?.addEventListener("click", () => setOn(!on));
  if (startParams().get("gaia") === "1") setOn(true);
  return api;
}

function setOn(v) {
  on = v;
  btn?.setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("gaia-now", on);
  syncCredit();
  if (!on) { cat?.hide(); status("zoom in below 1°"); return; }
  if (!view && ext?.state.al) { const [ra, dec] = ext.state.al.getRaDec(); view = { ra, dec, fov: ext.state.al.getFov()[0] }; }
  schedule(0);
}

function syncCredit() {
  const el = document.getElementById("creditGaia");
  if (el) el.hidden = !(on || document.body.classList.contains("fast-on"));
}

function status(text) { if (sub) sub.textContent = text; }

function schedule(ms = DEBOUNCE_MS) {
  clearTimeout(timer);
  if (view && view.fov >= FOV_MAX) { cat?.hide(); status("zoom in below 1°"); return; }
  timer = setTimeout(refresh, ms);
}

/** Tiles of `order` that the current view touches (sampled on a grid of screen points). */
function viewTiles(order) {
  const al = ext.state.al;
  const el = document.getElementById("sky");
  const w = el.clientWidth, h = el.clientHeight;
  const set = new Set();
  const nx = 12, ny = 9;
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      let p;
      try { p = al.pix2world(w * i / nx, h * j / ny); } catch { p = null; }
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) set.add(ang2pixNest(order, p[0], p[1]));
    }
  }
  return [...set];
}

function refresh() {
  if (!on || !view || !ext) return;
  if (view.fov >= FOV_MAX) { cat.hide(); status("zoom in below 1°"); return; }
  const lod = LODS.find((l) => view.fov >= l.fovMin);
  // nearest tiles first, so the middle of the screen fills in first
  const pixes = viewTiles(lod.order).map((p) => [p, pixGeometry(lod.order, p).centre])
    .sort((a, b) => sepDeg(view.ra, view.dec, ...a[1]) - sepDeg(view.ra, view.dec, ...b[1])).map((x) => x[0]);
  current = { lod, pixes, keys: new Set(pixes.map((p) => `${lod.order}/${p}`)) };
  const want = pixes.map((p) => wantTile(lod.order, p, lod.gmax));
  pump();
  draw(lod, pixes);
  const pending = want.filter((t) => !t.stars).length;
  if (pending) status(`loading Gaia stars… (${want.length - pending}/${want.length})`);
}

function draw(lod, pixes) {
  const ready = pixes.map((p) => tiles.get(`${lod.order}/${p}`)).filter((t) => t && t.stars);
  const pending = pixes.length - ready.length;
  const k = zoomStep(view.fov);
  const key = k + ":" + ready.map((t) => t.key).sort().join(",");
  if (!ready.length) {                                    // keep what is shown until the first tile arrives
    if (failures > 3) status("Gaia server not answering; move to retry");
    return;
  }
  if (key !== shownKey) {
    shownKey = key;
    let all = ready.flatMap((t) => t.stars);
    if (all.length > MAX_STARS) all = all.sort((a, b) => (a.g || 99) - (b.g || 99)).slice(0, MAX_STARS);
    const A = ext.state.A;
    cat.removeAll();
    cat.addSources(all.map((s) => A.source(s.ra, s.dec, { sid: s.sid, g: s.g, c: s.c, k })));
    stats.drawn = all.length; stats.tiles = ready.length;
  }
  cat.show();
  status(pending ? (failures > 3 ? "Gaia server not answering; move to retry" : `loading Gaia stars… (${ready.length}/${pixes.length})`)
    : `${stats.drawn.toLocaleString("en")} stars at 2026.0 · Gaia DR3 (ESA)`);
}

const api = {
  setOn, isOn: () => on, stats,
  /** For tests: the drawn source nearest to (ra, dec): {sid, ra, dec, g, sep_arcsec}. */
  nearest(ra, dec) {
    let best = null;
    for (const s of cat?.getSources?.() || []) {
      const d = sepDeg(ra, dec, s.ra, s.dec) * 3600;
      if (!best || d < best.sep_arcsec) best = { sid: s.data.sid, ra: s.ra, dec: s.dec, g: s.data.g, sep_arcsec: d };
    }
    return best;
  },
};

/** The page's query string as it was loaded (main.js rewrites the address bar when a spot is picked). */
function startParams() {
  try { return new URL(performance.getEntriesByType("navigation")[0]?.name || location.href).searchParams; }
  catch { return new URLSearchParams(location.search); }
}
