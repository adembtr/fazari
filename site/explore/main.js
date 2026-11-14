// Fazari Sky Explorer: an easy, immersive all-sky view built on Aladin Lite v3.
// Pick a category or any spot on the sky, then open the SPHEREx blink panel (sky.html) there.

import {
  parseCoords, looksLikeCoords, formatRA, formatDec, formatFov, applyPM, nowYear,
  randomSky, eclToEq, galToEq, separation,
} from "./coords.js";
import { SURVEYS, SPHEREX_SLICES, surveyUrl } from "./surveys.js";
import { findLocal, sesame, plainType } from "./lookup.js";
import { detectEngine, engineLabel, runLocalJob, stateText, resultSummary, isLocalHost } from "./engine.js";

// Aladin Lite v3 (CDS, GPL-3). Pinned. The npm build on jsDelivr is the same code CDS publishes;
// the CDS host is the fallback (its /api/v3/<version>/ path returned 404 in Nov 2026).
const ALADIN_VERSION = "3.8.2";
const ALADIN_ESM = `https://cdn.jsdelivr.net/npm/aladin-lite@${ALADIN_VERSION}/dist/aladin.js`;
const ALADIN_CDS = `https://aladin.cds.unistra.fr/AladinLite/api/v3/${ALADIN_VERSION}/aladin.js`;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isPhone = () => matchMedia("(max-width: 720px)").matches;

const CAT_COLORS = {
  challenge: "#ffc94d", fast_stars: "#ff8a5c", brown_dwarfs: "#d49a6a", variable_stars: "#ffe066",
  planet_nine: "#ff7ad9", milky_way: "#b9a4ff", nebulae: "#6fe0c9", galaxies: "#8fb8ff",
  ecliptic: "#ffd36e", deep_fields: "#5cf0a0",
};
// Field of view (degrees) used when flying to a point.
const CAT_FOV = {
  challenge: 1, fast_stars: 1, brown_dwarfs: 1, variable_stars: 1, planet_nine: 30,
  milky_way: 3, nebulae: 1.5, galaxies: 0.8, ecliptic: 6, deep_fields: 3,
};
const POINT_FOV = {
  m31: 3.5, lmc: 12, smc: 6, m33: 1.2, m42: 1.5, carina: 3, rho_oph: 3, cygnus_x: 8, sgr_a: 2,
  baade: 2, gal_anticenter: 20, m8: 1.2, m17: 1, m16: 1, helix: 0.6, m1: 0.3, m57: 0.15,
  horsehead: 0.6, cen_a: 0.6, m81: 0.6, m82: 0.4, betelgeuse: 1, p9_galactic_crossing: 30,
};
const SPHEREX_FADE = [3.0, 0.8];
// Planetarium rule: we stand at the centre of the sphere, so the whole sky never fits on one screen.
const MAX_FOV = 120;   // fov (deg) where the SPHEREx layer starts / finishes fading in

const state = {
  A: null, al: null, cats: [], points: [], byId: new Map(), activeCat: null, selected: null,
  bg: "visible", autoSpx: true, slice: 42, hips: {}, spxOverlay: null, spxReady: false, catalogs: {},
  selCat: null, overlays: {}, coverage: null, ang2pix: null, objectClickedAt: 0, step: 1, flat: null, engine: { kind: "browser" }, job: null,
};

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
const catsReady = loadCategories();
function setEngine(e) {
  state.engine = e;
  document.body.classList.toggle("engine-local", e.kind === "local");
  $("engineTag").textContent = engineLabel(e) + (e.kind === "local" ? " (this computer does the work)" : " (your browser does the work)");
  $("stEngine").textContent = engineLabel(e);
  return e;
}
const engineReady = detectEngine({ force: params.get("engine") }).then((e) => {
  performance.mark("fz-engine");
  setEngine(e);
  // On this computer but no answer yet (server starting or busy)? Keep asking for a minute.
  if (e.kind === "browser" && isLocalHost() && !params.get("engine")) {
    let tries = 0;
    const again = setInterval(async () => {
      const e2 = await detectEngine({ timeout: 8000 });
      if (e2.kind === "local") { setEngine(e2); clearInterval(again); toast("Local Python engine found: Fetch now runs on this computer."); }
      if (++tries >= 6) clearInterval(again);
    }, 10000);
  }
  return e;
});
const skyReady = startSky();
loadCoverage();
wireUi();

async function loadCategories() {
  try {
    const r = await fetch("data/categories.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    state.cats = json.categories;
    for (const c of state.cats) {
      for (const p of c.points) {
        if (!state.byId.has(p.id)) { state.byId.set(p.id, { ...p, cat: c.id }); state.points.push(state.byId.get(p.id)); }
      }
    }
    renderCategories();
    performance.mark("fz-ui");
  } catch (e) {
    $("cats").innerHTML = `<p class="warn">Could not load the categories (${esc(e.message)}). You can still search or tap the sky.</p>`;
  }
}

async function loadAladin() {
  try {
    const mod = await import(ALADIN_ESM);
    return mod.default;
  } catch (e) {
    console.warn("Aladin from jsDelivr failed, trying the CDS host", e);
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = ALADIN_CDS; s.charset = "utf-8"; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return window.A;
  }
}

function hasWebGL2() {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

async function startFlat(reason) {
  console.info("Using the flat sky map:", reason);
  document.body.classList.add("flat-mode");
  for (const b of document.querySelectorAll("#bgSwitch button")) { b.disabled = true; b.title = "Needs the 3D sky"; }
  $("btnLayers").disabled = true;
  $("intro")?.remove();
  await catsReady;
  const { startFlatMap } = await import("./flatmap.js");
  const sv = startView();
  state.flat = startFlatMap($("sky"), {
    points: state.points, colors: CAT_COLORS, ra: sv.ra, dec: sv.dec, fov: sv.fov,
    onPick: (q) => select({ id: null, name: "Your spot", ra: q.ra, dec: q.dec, cat: null, manual: true }),
    onView: (v) => { showView(v.ra, v.dec, v.fov); setCompass(0, -90); },
  });
  performance.mark("fz-sky");
  const sp = startView().point;
  if (sp) select(sp.id ? state.byId.get(sp.id) || sp : sp);
}

async function startSky() {
  const intro = $("intro");
  if (params.has("flat") || !hasWebGL2()) return startFlat(params.has("flat") ? "?flat" : "no WebGL2");
  try {
    const [A, baseUrl] = await Promise.all([loadAladin(), surveyUrl("visible")]);
    await A.init;
    state.A = A;
    const start = startView();
    const al = A.aladin("#sky", {
      survey: A.imageHiPS(baseUrl, { name: SURVEYS.visible.title, imgFormat: "jpeg" }),
      // STG = the view from the centre of the sphere (conformal, like a planetarium); never the
      // "globe seen from outside" SIN look and never an all-sky ellipse.
      projection: "STG", cooFrame: "ICRS", fov: Math.min(start.fov0, maxWidthFov()), target: `${start.ra} ${start.dec}`,
      showReticle: false, showCooGrid: false, showCooGridControl: false, showSimbadPointerControl: false,
      showFullscreenControl: false, showLayersControl: false, showGotoControl: false, showZoomControl: false,
      showProjectionControl: false, showFrame: false, showCooLocation: false, showFov: false,
      showSettingsControl: false, showShareControl: false, showStatusBar: false, showContextMenu: false,
      log: false, samp: false, realFullscreen: false, backgroundColor: "rgb(4,6,12)",
    });
    state.al = al;
    applyFovLimit();                                     // wheel / pinch can never zoom out past 120°
    addEventListener("resize", applyFovLimit);
    state.hips.visible = al.getBaseImageLayer();
    setupOverlays();
    al.on("zoomChanged", () => onViewChange());
    al.on("positionChanged", () => onViewChange());
    al.on("objectClicked", (obj) => onObjectClicked(obj));
    al.on("click", (e) => onSkyClick(e));
    // A two-finger pinch is never a tap, even when it ends without moving the view (e.g. at the zoom limit).
    const noteMulti = (e) => { if (e.touches.length > 1 || (e.type === "touchend" && e.touches.length)) state.multiTouchAt = performance.now(); };
    for (const t of ["touchstart", "touchmove", "touchend"]) $("sky").addEventListener(t, noteMulti, { capture: true, passive: true });
    onViewChange();
    performance.mark("fz-sky");
    intro.classList.add("gone");
    setTimeout(() => intro.remove(), 900);
    // The "fly into the sphere" opening: start wide, then glide in.
    if (start.point) {
      await catsReady;
      const p = start.point.id ? state.byId.get(start.point.id) || start.point : start.point;
      select(p, { fly: true });
    } else if (!reduceMotion) {
      setTimeout(() => zoomTo(start.fov, 3.2), 350);
    } else al.setFoV(start.fov);
    preloadSpherex();
  } catch (e) {
    console.warn("3D sky failed, switching to the flat map", e);
    if (state.al) return;              // the sky is up; a later step failed, keep it
    $("sky").innerHTML = "";
    startFlat(String(e.message || e));
  }
}

function startView() {
  // ?p=<point id> | ?ra=&dec=[&fov=] | default: Orion, seen from far away first.
  const ra = Number(params.get("ra")), dec = Number(params.get("dec"));
  const fov = Number(params.get("fov")) || null;
  if (params.get("p")) return { ra: 83.8, dec: -1, fov0: MAX_FOV, fov: 60, point: { id: params.get("p") } };
  if (Number.isFinite(ra) && Number.isFinite(dec) && params.has("ra") && params.has("dec")) {
    return { ra, dec, fov0: MAX_FOV, fov: fov || 1, point: { id: null, name: "Shared spot", ra, dec, cat: null, manual: true, fov: fov || 1 } };
  }
  return { ra: 83.8, dec: -1.0, fov0: MAX_FOV, fov: 70 };
}

// ---------------------------------------------------------------------------------------------
// Overlays: category markers, selection marker, lines, SPHEREx coverage
// ---------------------------------------------------------------------------------------------
function drawRing(color, size, challenge) {
  return (source, ctx) => {
    const r = size;
    ctx.save();
    ctx.lineWidth = challenge ? 2.2 : 1.6;
    ctx.strokeStyle = "rgba(0,0,0,.65)";
    ctx.beginPath(); ctx.arc(source.x, source.y, r + 1.2, 0, 2 * Math.PI); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(source.x, source.y, r, 0, 2 * Math.PI); ctx.stroke();
    if (challenge) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.beginPath();
        ctx.moveTo(source.x + dx * (r + 2), source.y + dy * (r + 2));
        ctx.lineTo(source.x + dx * (r + 7), source.y + dy * (r + 7));
        ctx.stroke();
      }
    }
    ctx.restore();
  };
}

function drawSelection(source, ctx) {
  const r = 16;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,.7)";
  ctx.beginPath(); ctx.arc(source.x, source.y, r + 1.5, 0, 2 * Math.PI); ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(source.x, source.y, r, 0, 2 * Math.PI); ctx.stroke();
  ctx.strokeStyle = "#7fd4ff";
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath();
    ctx.moveTo(source.x + dx * (r + 4), source.y + dy * (r + 4));
    ctx.lineTo(source.x + dx * (r + 12), source.y + dy * (r + 12));
    ctx.stroke();
  }
  ctx.restore();
}

function markerPos(p) {
  // Fast movers: draw them where they are now-ish (2026), not at their catalogue epoch.
  if (p.ra_2026 != null) return { ra: p.ra_2026, dec: p.dec_2026 };
  return { ra: p.ra, dec: p.dec };
}

function setupOverlays() {
  const { A, al } = state;
  // Lines first so markers draw on top.
  const ecl = A.graphicOverlay({ name: "Ecliptic (asteroid lane)", color: "#ffd36e", lineWidth: 1.5, lineDash: [6, 6] });
  al.addOverlay(ecl);
  ecl.add(A.polyline(range(0, 360, 2).map((l) => { const q = eclToEq(l, 0); return [q.ra, q.dec]; }), { color: "#ffd36e" }));
  const gal = A.graphicOverlay({ name: "Milky Way plane", color: "#9fc8ff", lineWidth: 1.5, lineDash: [2, 6] });
  al.addOverlay(gal);
  gal.add(A.polyline(range(0, 360, 2).map((l) => { const q = galToEq(l, 0); return [q.ra, q.dec]; }), { color: "#9fc8ff" }));
  const p9 = A.graphicOverlay({ name: "Planet Nine predicted band", color: "#ff7ad9", lineWidth: 2 });
  al.addOverlay(p9);
  for (const [beta, dash] of [[0, null], [12, [8, 6]], [-12, [8, 6]]]) {
    const pts = p9Band(beta).map((q) => [q.ra, q.dec]);
    p9.add(A.polyline(pts, { color: "#ff7ad9", lineWidth: beta ? 1.2 : 2, lineDash: dash || undefined }));
  }
  p9.hide();
  state.overlays = { ecl, gal, p9 };
  syncLineToggles();
  // Markers come with the categories.
  catsReady.then(() => { buildCatalogs(); });
  state.selCat = A.catalog({ name: "Your pick", shape: drawSelection, sourceSize: 40, color: "#ffffff" });
  al.addCatalog(state.selCat);
}

/** Planet Nine predicted path (Brown & Batygin 2021: i = 16°, Ω = 97°) and its ±12° band edges. */
function p9Band(beta) {
  const r = Math.PI / 180, inc = 16 * r, node = 97 * r;
  const P = [Math.cos(node), Math.sin(node), 0];                                // ascending node
  const N = [Math.sin(inc) * Math.sin(node), -Math.sin(inc) * Math.cos(node), Math.cos(inc)]; // orbit pole
  const Q = [N[1] * P[2] - N[2] * P[1], N[2] * P[0] - N[0] * P[2], N[0] * P[1] - N[1] * P[0]];
  return range(0, 361, 3).map((u) => {
    const cu = Math.cos(u * r), su = Math.sin(u * r), cb = Math.cos(beta * r), sb = Math.sin(beta * r);
    const v = [0, 1, 2].map((k) => cb * (cu * P[k] + su * Q[k]) + sb * N[k]);
    const lon = Math.atan2(v[1], v[0]) / r, lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / r;
    return eclToEq(lon, lat);
  });
}

function buildCatalogs() {
  const { A, al } = state;
  for (const c of state.cats) {
    if (!c.points.length) continue;
    const color = CAT_COLORS[c.id] || "#ffffff";
    const isCh = c.id === "challenge";
    const mk = (labels) => A.catalog({
      name: c.name + (labels ? "" : " (dots)"),
      shape: drawRing(color, isCh ? 9 : 6, isCh), sourceSize: isCh ? 34 : 18, color,
      displayLabel: labels, labelColumn: "name", labelColor: color, labelFont: "600 13px system-ui, sans-serif",
    });
    const dots = mk(false), labeled = mk(true);
    const srcs = () => c.points
      .filter((p) => isCh || !p.challenge)     // challenge targets are drawn once, by their own layer
      .map((p) => { const q = markerPos(p); return A.source(q.ra, q.dec, { name: p.name, pid: p.id }); });
    al.addCatalog(dots); dots.addSources(srcs());
    al.addCatalog(labeled); labeled.addSources(srcs());
    state.catalogs[c.id] = { dots, labeled };
  }
  syncCatalogs();
}

function syncCatalogs() {
  const show = $("tgMarkers").checked;
  for (const [id, { dots, labeled }] of Object.entries(state.catalogs)) {
    const labels = id === "challenge" || id === state.activeCat;
    if (!show) { dots.hide(); labeled.hide(); continue; }
    if (labels) { labeled.show(); dots.hide(); } else { dots.show(); labeled.hide(); }
  }
}

function syncLineToggles() {
  const o = state.overlays;
  if (!o.ecl) return;
  $("tgEcliptic").checked || state.activeCat === "ecliptic" ? o.ecl.show() : o.ecl.hide();
  $("tgGalactic").checked || state.activeCat === "milky_way" ? o.gal.show() : o.gal.hide();
  state.activeCat === "planet_nine" || $("tgP9").checked ? o.p9.show() : o.p9.hide();
}

async function loadCoverage() {
  try {
    const [r, mod] = await Promise.all([fetch("index/coverage.json"), import("../js/skyindex.js")]);
    if (!r.ok || typeof mod.ang2pixNest !== "function") return;
    const cov = await r.json();
    if (!Array.isArray(cov.seasons) || cov.scheme !== "nested") return;
    state.coverage = cov; state.ang2pix = mod.ang2pixNest;
    $("covRow").hidden = false;
    if (state.selected) renderCard();
  } catch { /* the sky index is optional */ }
}

function coverageAt(ra, dec) {
  const c = state.coverage;
  if (!c) return null;
  const pix = state.ang2pix(c.order, ra, dec);
  return { images: c.images?.[pix] ?? null, seasons: c.seasons[pix] ?? 0 };
}

async function toggleCoverageLayer(on) {
  const { A, al, coverage } = state;
  if (!al || !coverage) return;
  if (!state.overlays.cov && on) {
    // Almost the whole sky has 3 seasons, so show what stands out: extra visits and thin spots.
    const rich = [], thin = [];
    coverage.seasons.forEach((s, i) => { if (s >= 4) rich.push(i); else if (s <= 1) thin.push(i); });
    const mk = (list, color, op, name) => {
      const moc = A.MOCFromJSON({ [coverage.order]: list }, { name, color, fillColor: color, opacity: op, lineWidth: 0, fill: true, perimeter: false });
      al.addMOC(moc); return moc;
    };
    state.overlays.cov = [mk(rich, "#38e0a0", 0.35, "SPHEREx: 4+ seasons"), mk(thin, "#ff9a4d", 0.45, "SPHEREx: 1 season")];
  }
  for (const m of state.overlays.cov || []) on ? m.show() : m.hide();
}

// ---------------------------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------------------------
function range(a, b, step) { const out = []; for (let x = a; x <= b + 1e-9; x += step) out.push(x); return out; }

// Aladin's field of view is the width; on a tall (portrait) screen the height would be wider still,
// so cap the width so that neither side ever shows more than MAX_FOV.
function maxWidthFov() {
  const el = $("sky");
  const w = el.clientWidth || innerWidth, h = el.clientHeight || innerHeight;
  return MAX_FOV * Math.min(1, w / Math.max(1, h));
}
function applyFovLimit() {
  const al = state.al;
  if (!al) return;
  const m = maxWidthFov();
  al.setFoVRange(undefined, m);
  if (al.getFov()[0] > m) al.setFoV(m);
}

function zoomTo(fov, secs = 1.2) {
  fov = Math.min(fov, state.al ? maxWidthFov() : MAX_FOV);
  return new Promise((res) => {
    const al = state.al;
    if (!al) {
      if (state.flat) { const v = state.flat.getView(); state.flat.goTo(v.ra, v.dec, fov); }
      return res();
    }
    if (reduceMotion) { al.setFoV(fov); return res(); }
    let done = false; const fin = () => { if (!done) { done = true; res(); } };
    al.zoomToFoV(fov, secs, fin);
    setTimeout(fin, secs * 1000 + 400);
  });
}

function panTo(ra, dec, secs = 1.5) {
  return new Promise((res) => {
    const al = state.al;
    if (!al) return res();
    if (reduceMotion) { al.gotoRaDec(ra, dec); return res(); }
    let done = false; const fin = () => { if (!done) { done = true; res(); } };
    al.animateToRaDec(ra, dec, secs, fin);
    setTimeout(fin, secs * 1000 + 400);
  });
}

let flight = 0;
async function flyTo(ra, dec, fov) {
  const al = state.al;
  fov = Math.min(fov, al ? maxWidthFov() : MAX_FOV);
  if (!al) { state.flat?.goTo(ra, dec, fov); return; }
  const id = ++flight;
  const [cra, cdec] = al.getRaDec();
  const cur = al.getFov()[0];
  const sep = separation(cra, cdec, ra, dec);
  if (reduceMotion) { al.gotoRaDec(ra, dec); al.setFoV(fov); return; }
  if (sep > cur * 0.45 && sep > 2) {
    await zoomTo(Math.min(Math.max(cur, Math.min(sep * 1.6, MAX_FOV), 50), MAX_FOV), 0.8);   // pull back
    if (id !== flight) return;
  }
  await panTo(ra, dec, Math.max(0.6, Math.min(2.2, sep / 50)));
  if (id !== flight) return;
  await zoomTo(fov, fov < 2 ? 2.2 : 1.4);
}

let viewRaf = 0;
function onViewChange() {
  if (viewRaf) return;
  viewRaf = requestAnimationFrame(() => {
    viewRaf = 0;
    const al = state.al;
    if (!al) return;
    const [ra, dec] = al.getRaDec();
    const fov = al.getFov()[0];
    showView(ra, dec, fov);
    updateCompass(ra, dec, fov);
    updateSpherexFade(fov);
  });
}

function showView(ra, dec, fov) {
  $("stRa").textContent = formatRA(ra);
  $("stDec").textContent = formatDec(dec);
  $("stFov").textContent = formatFov(fov);
}

// Compass: where north and east point on the screen right now (they turn as you look around,
// e.g. near the poles). Measured by projecting two nearby sky points with Aladin itself.
function updateCompass(ra, dec, fov) {
  const al = state.al;
  try {
    const d = Math.max(fov * 0.02, 1e-4);
    const c = al.world2pix(ra, dec);
    const north = dec + d <= 90 ? al.world2pix(ra, dec + d) : null;
    const south = al.world2pix(ra, dec - d);
    const east = al.world2pix((ra + d / Math.max(0.02, Math.cos(dec * Math.PI / 180))) % 360, dec);
    if (!c || !east || !(north || south)) return;
    const n = north ? [north[0] - c[0], north[1] - c[1]] : [c[0] - south[0], c[1] - south[1]];
    const e = [east[0] - c[0], east[1] - c[1]];
    setCompass(Math.atan2(n[0], -n[1]) * 180 / Math.PI, Math.atan2(e[0], -e[1]) * 180 / Math.PI);
  } catch { /* view not ready */ }
}

/** Angles in degrees, clockwise from screen-up. North-up sky seen from inside: (0, -90). */
function setCompass(nDeg, eDeg) {
  $("cmpN").setAttribute("transform", `rotate(${nDeg.toFixed(1)})`);
  $("cmpE").setAttribute("transform", `rotate(${eDeg.toFixed(1)})`);
  // Letters stay upright; they just move round the dial.
  for (const [id, deg] of [["cmpNt", nDeg], ["cmpEt", eDeg]]) {
    const r = deg * Math.PI / 180;
    $(id).setAttribute("x", (31 * Math.sin(r)).toFixed(1));
    $(id).setAttribute("y", (-31 * Math.cos(r)).toFixed(1));
  }
}

// ---------------------------------------------------------------------------------------------
// Backgrounds and the "zoom in until SPHEREx appears" fade
// ---------------------------------------------------------------------------------------------
async function makeHips(key) {
  const url = await surveyUrl(key);
  const s = SURVEYS[key];
  const opts = { name: s.title, imgFormat: s.fmt };
  // Cube: pick our wavelength the moment the layer is added (the default middle frame is a blank one).
  if (s.cube) opts.successCallback = (layer) => setSlice(layer);
  const h = state.A.imageHiPS(url, opts);
  if (key === "spherex") {
    setSlice(h);
    // The PNG tiles are already stretched to 0..255; just colour them.
    h.setColormap("inferno", { stretch: "linear" });
  }
  return h;
}

async function getHips(key) {
  if (!state.hips[key]) state.hips[key] = await makeHips(key);
  return state.hips[key];
}

function setSlice(h) {
  // Aladin 3.8.2 maps setSliceNumber(n) to a wavelength linearly, but its renderer then picks the
  // frame linearly in *frequency*, so setSliceNumber(42) shows frame 17. Invert that so we get the
  // cube frame we asked for (checked against the tile URLs it requests: Npix..._<frame>.png).
  try {
    const k = state.slice, D = h.cubeDepth, lo = h.emMin, hi = h.emMax;
    if (!(D && lo && hi)) { h.setSliceNumber(k); return; }
    const c = 299792458, fmin = c / hi, fmax = c / lo;
    const f = fmin + (k + 0.5) / D * (fmax - fmin);
    h.setSliceNumber((c / f - lo) * D / (hi - lo));
  } catch (e) { console.warn(e); }
}

async function preloadSpherex() {
  // Find a working SPHEREx map server early; the layer itself is only added once you zoom in.
  try {
    await surveyUrl("spherex");
    state.spxReady = true;
    onViewChange();
  } catch (e) {
    console.warn("SPHEREx HiPS unavailable", e);
    $("bg-spherex").disabled = true;
    $("bg-spherex").title = "The SPHEREx map server is not answering right now.";
  }
}

let spxBusy = false;
async function ensureSpherexOverlay(want) {
  const al = state.al;
  if (spxBusy || !al) return;
  if (want && !state.spxOverlay) {
    spxBusy = true;
    try {
      const h = await makeHips("spherex");
      al.setOverlayImageLayer(h, "spherex");
      setSlice(h);
      state.spxOverlay = h;
    } catch (e) { console.warn(e); } finally { spxBusy = false; }
    onViewChange();
  } else if (!want && state.spxOverlay) {
    try { al.removeImageLayer("spherex"); } catch (e) { console.warn(e); }
    state.spxOverlay = null;
  }
}

function updateSpherexFade(fov) {
  const auto = state.spxReady && state.autoSpx && state.bg !== "spherex";
  const [a, b] = SPHEREX_FADE;
  // Add the layer a bit before it starts to show, drop it again well after (hysteresis).
  if (auto && fov < a * 1.25 && !state.spxOverlay) ensureSpherexOverlay(true);
  else if ((!auto || fov > a * 1.8) && state.spxOverlay) ensureSpherexOverlay(false);
  const h = state.spxOverlay;
  let op = 0;
  if (h && auto) {
    const t = Math.max(0, Math.min(1, (a - fov) / (a - b)));
    op = t * t * (3 - 2 * t);
  }
  if (h) { try { h.setOpacity(op); } catch { /* not ready yet */ } }
  const showing = state.bg === "spherex" || op > 0.5;
  const badge = $("spxBadge");
  badge.hidden = !showing;
  if (showing) {
    const sl = SPHEREX_SLICES.find((s) => s.slice === state.slice);
    badge.querySelector("span").textContent = `SPHEREx infrared map${sl ? " · " + sl.label : ""}`;
  }
  $("creditSurvey").textContent = showing && state.bg !== "spherex"
    ? `${SURVEYS[state.bg].credit}; ${SURVEYS.spherex.credit}` : SURVEYS[state.bg].credit;
}

async function setBackground(key) {
  if (!state.al) return;
  const btn = $("bg-" + key);
  for (const b of document.querySelectorAll("#bgSwitch button")) b.setAttribute("aria-checked", String(b === btn));
  const prev = state.bg;
  state.bg = key;
  try {
    btn.classList.add("loading");
    const h = await getHips(key);
    if (key === "spherex") setSlice(h);
    if (state.bg !== key) return;
    state.al.setBaseImageLayer(h);
    toast(`${SURVEYS[key].title}: ${SURVEYS[key].blurb}`);
  } catch (e) {
    state.bg = prev;
    for (const b of document.querySelectorAll("#bgSwitch button")) b.setAttribute("aria-checked", String(b.id === "bg-" + prev));
    toast(e.message || "That sky map is not available right now.", true);
  } finally {
    btn.classList.remove("loading");
    $("sliceRow").hidden = false;
    onViewChange();
  }
}

// ---------------------------------------------------------------------------------------------
// Categories panel
// ---------------------------------------------------------------------------------------------
function renderCategories() {
  const wrap = $("cats");
  wrap.innerHTML = "";
  for (const c of state.cats) {
    const b = document.createElement("button");
    b.className = "cat" + (c.highlight ? " hl" : "");
    b.type = "button";
    b.dataset.cat = c.id;
    b.style.setProperty("--c", CAT_COLORS[c.id] || "#9fb4ff");
    b.setAttribute("aria-pressed", "false");
    b.innerHTML = `<span class="ico" aria-hidden="true">${c.icon}</span><span class="nm">${esc(c.name)}</span>` +
      (c.points.length ? `<span class="ct">${c.points.length}</span>` : "");
    b.onclick = () => (c.random ? surprise() : openCategory(c.id, { fly: true }));
    wrap.appendChild(b);
  }
}

function openCategory(id, { fly = false } = {}) {
  const c = state.cats.find((x) => x.id === id);
  if (!c) return;
  state.activeCat = id;
  for (const b of document.querySelectorAll(".cat")) {
    b.setAttribute("aria-pressed", String(b.dataset.cat === id));
    if (b.dataset.cat === id) b.scrollIntoView({ block: "nearest", inline: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }
  const det = $("catDetail");
  det.hidden = false;
  det.style.setProperty("--c", CAT_COLORS[id] || "#9fb4ff");
  $("catTitle").innerHTML = `<span aria-hidden="true">${c.icon}</span> ${esc(c.name)}`;
  $("catDesc").textContent = c.description;
  const disc = $("catDisclaimer");
  disc.hidden = !c.disclaimer;
  disc.innerHTML = c.disclaimer ? `${esc(c.disclaimer)}${c.citation ? `<br><small>Source: ${esc(c.citation)}</small>` : ""}` : "";
  const ul = $("points");
  ul.innerHTML = "";
  for (const p of c.points) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pt" + (p.challenge ? " ch" : "");
    b.dataset.pid = p.id;
    b.innerHTML = `<span class="pn">${esc(p.name)}${p.challenge ? ' <span class="tag">Challenge</span>' : ""}</span>` +
      `<span class="pd">${esc(p.note || "")}</span>`;
    b.onclick = () => select({ ...state.byId.get(p.id), cat: id }, { fly: true });
    li.appendChild(b);
    ul.appendChild(li);
  }
  syncCatalogs();
  syncLineToggles();
  document.body.classList.add("cat-open");
  if (isPhone()) setSheet("open");
  if (fly && state.al && c.points.length) {
    // Show the whole category: fly to the middle of its points, wide enough to see them.
    const pts = c.points.map(markerPos);
    const centre = meanPos(pts);
    const spread = Math.max(...pts.map((q) => separation(centre.ra, centre.dec, q.ra, q.dec)));
    if (id === "planet_nine") flyTo(55, 10, 110);
    else if (spread < 60) flyTo(centre.ra, centre.dec, Math.min(MAX_FOV, Math.max(CAT_FOV[id] * 4, spread * 2.6)));
    else zoomTo(MAX_FOV, 1.5);
  }
}

function meanPos(pts) {
  let x = 0, y = 0, z = 0;
  const r = Math.PI / 180;
  for (const q of pts) { x += Math.cos(q.dec * r) * Math.cos(q.ra * r); y += Math.cos(q.dec * r) * Math.sin(q.ra * r); z += Math.sin(q.dec * r); }
  const n = Math.hypot(x, y, z) || 1;
  return { ra: ((Math.atan2(y, x) / r) + 360) % 360, dec: Math.asin(z / n) / r };
}

// ---------------------------------------------------------------------------------------------
// Selection card
// ---------------------------------------------------------------------------------------------
function select(p, { fly = false, fov, fill = true } = {}) {
  const pos = markerPos(p);
  state.selected = { ...p, pos };
  // Step 2 of the flow: the coordinate box fills in with the spot you picked.
  if (fill) $("q").value = `${pos.ra.toFixed(5)} ${pos.dec >= 0 ? "+" : ""}${pos.dec.toFixed(5)}`;
  state.flat?.setSelection(pos);
  if (state.step < 3) setStep(3);
  if (isPhone()) setSheet("peek");
  drawFootprints();
  state.selCat?.removeAll();
  if (state.A && state.selCat) state.selCat.addSources([state.A.source(pos.ra, pos.dec, { name: p.name })]);
  for (const b of document.querySelectorAll(".pt")) b.classList.toggle("on", b.dataset.pid === p.id);
  renderCard();
  const f = fov || p.fov || POINT_FOV[p.id] || CAT_FOV[p.cat] || 1;
  if (fly) flyTo(pos.ra, pos.dec, f);
  const q = new URLSearchParams();
  if (p.id && !p.manual) q.set("p", p.id);
  else { q.set("ra", pos.ra.toFixed(5)); q.set("dec", pos.dec.toFixed(5)); }
  history.replaceState(null, "", "?" + q.toString());
}

function catName(id) { return state.cats.find((c) => c.id === id)?.name || ""; }

function renderCard() {
  const p = state.selected;
  const card = $("card");
  if (!p) { card.hidden = true; document.body.classList.remove("card-open"); return; }
  card.hidden = false;
  document.body.classList.add("card-open");
  card.style.setProperty("--c", CAT_COLORS[p.cat] || "#7fd4ff");
  const kick = [];
  if (p.challenge) kick.push("Challenge target");
  if (p.cat && p.cat !== "challenge") kick.push(catName(p.cat));
  if (p.manual) kick.push("Your pick");
  if (p.type) kick.push(p.type);
  $("cardKicker").textContent = kick.join(" · ");
  $("cardTitle").textContent = p.name;
  $("cardNote").textContent = p.note || (p.manual ? "A spot you picked. Every place on the sky has something in it, even if it looks empty here." : "");
  $("cardRa").textContent = formatRA(p.pos.ra);
  $("cardDec").textContent = formatDec(p.pos.dec);
  $("cardDeg").textContent = `${p.pos.ra.toFixed(4)}°, ${p.pos.dec >= 0 ? "+" : ""}${p.pos.dec.toFixed(4)}°`;
  $("cardMoved").hidden = !(p.ra_2026 != null || p.moved);
  const cov = coverageAt(p.pos.ra, p.pos.dec);
  const covEl = $("cardCov");
  if (cov) {
    covEl.hidden = false;
    covEl.className = "cov " + (cov.seasons >= 2 ? "good" : "thin");
    covEl.textContent = cov.seasons >= 2
      ? `SPHEREx looked here in ${cov.seasons} seasons: good for a blink.`
      : cov.seasons === 1
        ? "SPHEREx has only one season here so far, so a blink may not show change yet."
        : "No SPHEREx images listed here yet.";
  } else covEl.hidden = true;
  const g = $("btnGallery");
  g.hidden = true;
  if (p.challenge && p.gallery) {
    fetch(p.gallery + "meta.json", { method: "HEAD" }).then((r) => {
      if (r.ok && state.selected?.id === p.id) { g.hidden = false; g.dataset.src = `ornek.html?data=${p.gallery}`; }
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// SPHEREx footprints of the selected spot, straight from the static sky index (all ICRS degrees):
// lets the eye check that the archive's image positions sit where the sphere says they should.
// ---------------------------------------------------------------------------------------------
const SEASON_COLORS = ["#ffc94d", "#5cf0a0", "#7fd4ff", "#ff7ad9", "#ff8a5c", "#b9a4ff", "#e8f080"];
let fpRun = 0;
async function drawFootprints() {
  const { A, al } = state;
  const legend = $("cardFoot");
  const run = ++fpRun;
  if (!al) { legend.hidden = true; return; }
  if (!state.overlays.fp) {
    state.overlays.fp = A.graphicOverlay({ name: "SPHEREx image footprints", lineWidth: 1.2 });
    al.addOverlay(state.overlays.fp);
  }
  const ov = state.overlays.fp;
  ov.removeAll();
  const p = state.selected;
  if (!$("tgFoot").checked || !p) { legend.hidden = true; return; }
  legend.hidden = false;
  legend.textContent = "Looking up SPHEREx images of this spot…";
  let imgs;
  try {
    const { findImages } = await import("../js/skyindex.js");
    imgs = await findImages(p.pos.ra, p.pos.dec);
  } catch (e) {
    if (run === fpRun) legend.textContent = "The sky index is not available here, so footprints cannot be drawn.";
    return;
  }
  if (run !== fpRun) return;
  // Seasons: groups of observing dates separated by more than 30 days.
  const seasons = [];
  let prev = -1e9;
  for (const im of imgs) {
    if (im.mjd - prev > 30) seasons.push({ start: im.mjd, n: 0, color: SEASON_COLORS[seasons.length % SEASON_COLORS.length] });
    const s = seasons[seasons.length - 1];
    s.n++; im._color = s.color; prev = im.mjd;
  }
  for (const im of imgs) ov.add(A.polygon(im.corners.map((c) => [c[0], c[1]]), { color: im._color, lineWidth: 1 }));
  const ym = (mjd) => new Date((mjd - 40587) * 86400e3).toISOString().slice(0, 7);
  legend.innerHTML = imgs.length
    ? `<b>${imgs.length}</b> SPHEREx images cover this spot: ` + seasons.map((s) =>
      `<span class="sea"><i style="background:${s.color}"></i>${ym(s.start)} (${s.n})</span>`).join(" ")
    : "No SPHEREx images in the sky index for this spot.";
}

function blinkUrl(p) {
  if (p.challenge && p.id) return `sky.html?target=${encodeURIComponent(p.id)}`;
  return `sky.html?ra=${p.pos.ra.toFixed(5)}&dec=${p.pos.dec.toFixed(5)}`;
}

// ---------------------------------------------------------------------------------------------
// Blink panel (sky.html / ornek.html in an iframe)
// ---------------------------------------------------------------------------------------------
let lastFocus = null;
function showPanel(title) {
  const panel = $("blink");
  if (panel.hidden) lastFocus = document.activeElement;
  $("blinkTitle").textContent = title;
  panel.hidden = false;
  setStep(4);
  requestAnimationFrame(() => panel.classList.add("in"));
  document.body.classList.add("blink-open");
  $("blinkClose").focus();
}

function loadFrame(src) {
  $("job").hidden = true;
  $("blinkNew").href = src;
  $("blinkNew").hidden = false;
  const fr = $("blinkFrame");
  if (fr.getAttribute("src") !== src) {
    $("blinkLoading").hidden = false;
    fr.setAttribute("src", src);
  }
}

function openBlink(src, title) {
  stopJob();
  $("resultBar").hidden = true;
  showPanel(title);
  loadFrame(src);
}

// Local Python engine: run a job, show progress, then open the products in ornek.html.
function stopJob() {
  if (state.job) { state.job.cancel(); state.job = null; }
}

function startLocalJob(p) {
  stopJob();
  showPanel(`SPHEREx blink: ${p.name}`);
  const fr = $("blinkFrame");
  fr.removeAttribute("src");
  $("blinkLoading").hidden = true;
  $("blinkNew").hidden = true;
  $("job").hidden = false;
  $("jobState").textContent = "Sending the job to the local engine…";
  $("jobDetail").textContent = `RA ${p.pos.ra.toFixed(5)}°, Dec ${p.pos.dec.toFixed(5)}°`;
  $("jobMsg").textContent = ""; $("jobMsg").className = "job-msg";
  $("jobCancel").hidden = false; $("jobBrowser").hidden = true;
  const bar = $("jobBar").parentElement;
  bar.classList.add("indet");
  $("resultBar").hidden = true;
  const t0 = performance.now();
  const req = { ra: +p.pos.ra.toFixed(6), dec: +p.pos.dec.toFixed(6), name: p.manual && !p.pmra ? undefined : p.name };
  if (p.manual && p.pmra != null && Math.hypot(p.pmra, p.pmdec || 0) > 0) {
    Object.assign(req, { pmra: p.pmra, pmdec: p.pmdec || 0, epoch: +(p.moved ? nowYear() : 2000).toFixed(3) });
  }
  if (params.get("force") === "1") req.force = true;          // testing: ignore the engine's result cache
  const job = runLocalJob(req, (j) => {
    if (state.job !== job) return;
    $("jobState").textContent = stateText(j.state);
    const pr = j.progress || {};
    // Only the download has a real count; the other stages show a moving bar.
    const pct = j.state === "downloading" && pr.total ? Math.round(100 * (pr.done || 0) / pr.total) : null;
    bar.classList.toggle("indet", pct == null);
    $("jobBar").style.width = pct == null ? "" : pct + "%";
    bar.setAttribute("aria-valuenow", pct == null ? "" : String(pct));
    const bits = [];
    if (pr.total) bits.push(`${pr.done || 0} of ${pr.total} images`);
    if (pr.bytes) bits.push(`${(pr.bytes / 1048576).toFixed(1)} MB`);
    const el = Math.round((performance.now() - t0) / 1000);
    bits.push(`${Math.floor(el / 60)}:${String(el % 60).padStart(2, "0")} elapsed`);
    $("jobDetail").textContent = bits.join(" · ") || $("jobDetail").textContent;
    if (j.message) $("jobMsg").textContent = j.message;
  });
  state.job = job;
  job.promise.then((j) => {
    if (state.job !== job) return;
    state.job = null;
    if (j.state === "done" && j.result_url) {
      loadFrame(`ornek.html?data=${j.result_url}`);
      const secs = (performance.now() - t0) / 1000;
      performance.mark("fz-result");
      resultSummary(j.result_url).then((r) => {
        if (state.job || $("job").hidden === false) return;
        const bar = $("resultBar");
        bar.hidden = false;
        bar.querySelector("b").textContent = r ? r.text : (j.message || "Done.");
        bar.querySelector("small").textContent = `Local Python engine · ${secs < 2 ? "cached result" : `ready in ${secs.toFixed(0)} s`}`;
      });
    } else if (j.state !== "cancelled") {
      jobFailed(p, j.message || "The local engine could not finish this job.");
    }
  }).catch((e) => { if (state.job === job) { state.job = null; jobFailed(p, e.message); } });
}

function jobFailed(p, message) {
  $("jobState").textContent = stateText("error");
  $("jobMsg").textContent = message; $("jobMsg").className = "job-msg err";
  $("jobBar").parentElement.classList.remove("indet");
  $("jobCancel").hidden = true;
  const b = $("jobBrowser");
  b.hidden = false;
  b.onclick = () => openBlink(blinkUrl(p), `SPHEREx blink: ${p.name}`);
}

function closeBlink() {
  const panel = $("blink");
  panel.classList.remove("in");
  document.body.classList.remove("blink-open");
  setTimeout(() => { panel.hidden = true; }, 260);
  lastFocus?.focus?.();
}

// ---------------------------------------------------------------------------------------------
// Sky clicks, search, surprise
// ---------------------------------------------------------------------------------------------
function onObjectClicked(obj) {
  const pid = obj?.data?.pid;
  if (!pid) return;
  state.objectClickedAt = performance.now();
  const p = state.byId.get(pid);
  if (p) select(p, { fly: false });
}

function onSkyClick(e) {
  if (!e || e.isDragging || !Number.isFinite(e.ra)) return;
  if (performance.now() - state.objectClickedAt < 250) return;
  if (performance.now() - (state.multiTouchAt || 0) < 600) return;
  select({ id: null, name: "Your spot", ra: e.ra, dec: e.dec, cat: null, manual: true });
}

async function runSearch(text) {
  const msg = $("searchMsg");
  const t = text.trim();
  if (!t) return;
  msg.className = "msg"; msg.hidden = false;
  const c = parseCoords(t);
  if (c) {
    msg.textContent = `Going to RA ${formatRA(c.ra)}, Dec ${formatDec(c.dec)} (${c.format === "decimal" ? "read as decimal degrees" : "read as hours and degrees"}).`;
    select({ id: null, name: "Your coordinates", ra: c.ra, dec: c.dec, cat: null, manual: true }, { fly: true, fov: 1, fill: false });
    return;
  }
  if (looksLikeCoords(t)) {
    msg.className = "msg err";
    msg.innerHTML = "That looks like a coordinate, but I could not read it. Try <b>269.45 +4.69</b> (degrees) or <b>17 57 48 +04 41 36</b> (hours and degrees).";
    return;
  }
  const local = findLocal(state.points, t);
  if (local) {
    msg.textContent = `Found ${local.name} in “${catName(local.cat)}”.`;
    openCategory(local.cat);
    select(local, { fly: true, fill: false });
    return;
  }
  msg.textContent = `Looking up “${t}”…`;
  try {
    const r = await sesame(t);
    if (!r) {
      msg.className = "msg err";
      msg.innerHTML = `No object called “${esc(t)}” was found. Try a catalogue name like <b>M 31</b>, <b>NGC 7000</b> or <b>Vega</b>.`;
      return;
    }
    const same = r.name.toLowerCase().replace(/\W/g, "") === t.toLowerCase().replace(/\W/g, "");
    const shown = same ? r.name : `${t} (${r.name})`;
    const kind = plainType(r.type);
    msg.textContent = `Found ${shown}${kind ? `: ${kind}` : ""}.`;
    select({ id: null, name: shown, ra: r.ra, dec: r.dec, cat: null, manual: true, moved: r.moved, type: kind, pmra: r.pmra, pmdec: r.pmdec }, { fly: true, fov: 1, fill: false });
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = "The name service did not answer. Check your connection, or type coordinates instead.";
  }
}

function surprise() {
  const pick = Math.random();
  let target;
  if (state.coverage && pick < 0.5) {
    for (let i = 0; i < 400; i++) {
      const q = randomSky();
      const cv = coverageAt(q.ra, q.dec);
      if (cv && cv.seasons >= 4) { target = { id: null, name: "A random spot SPHEREx visited often", ra: q.ra, dec: q.dec, cat: null, manual: true }; break; }
    }
  }
  if (!target && pick < 0.25) {
    const q = randomSky();
    target = { id: null, name: "A random spot on the sky", ra: q.ra, dec: q.dec, cat: null, manual: true };
  }
  if (!target && state.points.length) {
    target = state.points[Math.floor(Math.random() * state.points.length)];
    openCategory(target.cat);
  }
  if (target) select(target, { fly: true, fov: target.manual ? 1 : undefined });
}

// ---------------------------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------------------------
function setStep(n) {
  state.step = n;
  for (const li of document.querySelectorAll("#steps li")) {
    const k = Number(li.dataset.step);
    li.classList.toggle("on", k === n);
    li.classList.toggle("done", k < n);
  }
}

function setSheet(mode) {
  document.body.dataset.sheet = mode;
  $("sheetToggle").setAttribute("aria-expanded", String(mode === "open"));
}

function toast(text, err = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = "toast"; }, 4200);
}

function wireUi() {
  $("search").addEventListener("submit", (e) => { e.preventDefault(); runSearch($("q").value); $("q").blur(); });
  for (const ex of document.querySelectorAll("[data-example]")) {
    ex.addEventListener("click", () => { $("q").value = ex.dataset.example; runSearch(ex.dataset.example); });
  }
  for (const key of Object.keys(SURVEYS)) $("bg-" + key).addEventListener("click", () => setBackground(key));
  $("btnLayers").addEventListener("click", () => {
    const pop = $("layers"), open = pop.hidden;
    pop.hidden = !open;
    $("btnLayers").setAttribute("aria-expanded", String(open));
  });
  for (const id of ["tgMarkers"]) $(id).addEventListener("change", syncCatalogs);
  for (const id of ["tgEcliptic", "tgGalactic", "tgP9"]) $(id).addEventListener("change", syncLineToggles);
  $("tgCoverage").addEventListener("change", (e) => toggleCoverageLayer(e.target.checked));
  $("tgFoot").addEventListener("change", () => drawFootprints());
  $("tgAuto").addEventListener("change", (e) => { state.autoSpx = e.target.checked; onViewChange(); });
  const sel = $("slice");
  for (const s of SPHEREX_SLICES) sel.add(new Option(s.label, s.slice, s.slice === state.slice, s.slice === state.slice));
  sel.addEventListener("change", () => {
    state.slice = Number(sel.value);
    for (const h of [state.hips.spherex, state.spxOverlay]) if (h) setSlice(h);
    onViewChange();
  });
  $("btnGuide").addEventListener("click", () => openDialog("guide"));
  $("btnGuide2").addEventListener("click", () => openDialog("guide"));
  for (const b of document.querySelectorAll("[data-open-about]")) b.addEventListener("click", () => openDialog("about"));
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });     // click outside closes
    for (const b of d.querySelectorAll("[data-close]")) b.addEventListener("click", () => d.close());
  }
  $("cardClose").addEventListener("click", () => {
    state.selected = null; state.selCat?.removeAll(); renderCard(); drawFootprints();
    for (const b of document.querySelectorAll(".pt")) b.classList.remove("on");
  });
  $("btnLook").addEventListener("click", () => {
    const p = state.selected;
    if (!p) return;
    // Wait for the engine check (at most ~1.5 s) so an early click still goes to the right engine.
    engineReady.then(() => {
      if (state.engine.kind === "local") startLocalJob(p);
      else openBlink(blinkUrl(p), `SPHEREx blink: ${p.name}`);
    });
  });
  $("jobCancel").addEventListener("click", () => {
    stopJob();
    $("jobState").textContent = stateText("cancelled");
    $("jobMsg").textContent = "The job was stopped. Pick a spot and press Fetch again any time.";
    $("jobBar").parentElement.classList.remove("indet");
    $("jobCancel").hidden = true;
  });
  $("btnGallery").addEventListener("click", () => {
    const p = state.selected;
    if (p) openBlink($("btnGallery").dataset.src, `Prepared blink: ${p.name}`);
  });
  $("btnZoom").addEventListener("click", () => {
    const p = state.selected;
    if (!p) return;
    const fov = state.al ? state.al.getFov()[0] : 1;
    flyTo(p.pos.ra, p.pos.dec, Math.max(0.12, Math.min(fov / 4, 0.5)));
  });
  $("btnShare").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied. Anyone who opens it lands on this spot."); }
    catch { toast(location.href); }
  });
  $("blinkClose").addEventListener("click", closeBlink);
  $("blinkFrame").addEventListener("load", () => { $("blinkLoading").hidden = true; });
  $("sheetToggle").addEventListener("click", () => setSheet(document.body.dataset.sheet === "open" ? "peek" : "open"));
  setSheet("peek");

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if (e.key === "Escape") {
      if (!$("blink").hidden) { closeBlink(); return; }
      if (!$("layers").hidden) { $("layers").hidden = true; $("btnLayers").setAttribute("aria-expanded", "false"); return; }
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]") || !$("blink").hidden) return;
    if (e.key === "/") { e.preventDefault(); $("q").focus(); return; }
    const al = state.al;
    if (!al) return;
    const onSky = document.activeElement === document.body || $("sky").contains(document.activeElement);
    if (!onSky) return;
    const fov = al.getFov()[0];
    const [ra, dec] = al.getRaDec();
    const step = fov / 8;
    const k = e.key;
    if (k === "+" || k === "=") { zoomTo(Math.max(fov / 1.6, 0.02), 0.35); e.preventDefault(); }
    else if (k === "-" || k === "_") { zoomTo(Math.min(fov * 1.6, MAX_FOV), 0.35); e.preventDefault(); }
    else if (k.startsWith("Arrow")) {
      e.preventDefault();
      const cosd = Math.max(0.1, Math.cos(dec * Math.PI / 180));
      if (k === "ArrowLeft") al.gotoRaDec((ra + step / cosd + 360) % 360, dec);
      if (k === "ArrowRight") al.gotoRaDec((ra - step / cosd + 360) % 360, dec);
      if (k === "ArrowUp") al.gotoRaDec(ra, Math.min(90, dec + step));
      if (k === "ArrowDown") al.gotoRaDec(ra, Math.max(-90, dec - step));
    } else if (k === "Enter" && document.activeElement === $("sky")) {
      select({ id: null, name: "Your spot", ra, dec, cat: null, manual: true });
    }
  });

  // Step 1 -> 2 as soon as the person moves the sky themselves.
  $("sky").addEventListener("pointerdown", () => { if (state.step < 2) setStep(2); }, { passive: true });
  $("sky").addEventListener("wheel", () => { if (state.step < 2) setStep(2); }, { passive: true });
}

function openDialog(id) {
  const d = $(id);
  if (!d.open) d.showModal();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// For tests: window.__explore exposes state and a few actions.
window.__explore = { MAX_FOV, state, openCategory, select, flyTo, runSearch, surprise, setBackground, openBlink, closeBlink, startLocalJob };
