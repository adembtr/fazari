// Fazari Sky Explorer: an easy, immersive all-sky view built on Aladin Lite v3.
// Pick a category or any spot on the sky, then open the SPHEREx blink panel (sky.html) there.

import {
  parseCoords, looksLikeCoords, formatRA, formatDec, formatFov, applyPM, nowYear,
  randomSky, eclToEq, galToEq, separation,
} from "./coords.js";
import { SURVEYS, CLOSEUP_SURVEYS, SPHEREX_SLICES, CLOSEUP_FOV, surveyUrl, minFov } from "./surveys.js";
import { createCloseup } from "./closeup.js";
import { installTileQueue, recentFailures } from "./tilequeue.js";
import { createPrefetch } from "./prefetch.js";
import { findLocal, sesame, plainType, typeName } from "./lookup.js";
import { detectEngine, engineLabel, runLocalPreviewJob, jobLine, stateText, resultSummary, isLocalHost, quickLines, quickProgress, quickBlink, sureFor, fmtWait } from "./engine.js";
import { t as T, num as iNum, loc as iLoc, field as iField, tname as iName, onLang, ptext as iPtext } from "../js/i18n.js";

// Aladin Lite v3 (CDS, GPL-3). Pinned. The npm build on jsDelivr is the same code CDS publishes;
// the CDS host is the fallback (its /api/v3/<version>/ path returned 404 in Nov 2026).
const ALADIN_VERSION = "3.8.2";
const ALADIN_ESM = `https://cdn.jsdelivr.net/npm/aladin-lite@${ALADIN_VERSION}/dist/aladin.js`;
const ALADIN_CDS = `https://aladin.cds.unistra.fr/AladinLite/api/v3/${ALADIN_VERSION}/aladin.js`;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isPhone = () => matchMedia("(max-width: 720px)").matches;
const PANEL_KEY = "fz-ex-panel";             // localStorage: the left panel folded ("shut") or not (desktop)
const BG_KEY = "fz-ex-bg";                   // localStorage: the sky map the person picked last (Layers > Sky map)
// The sky map: a link's ?bg= always wins, then the person's own last pick, else NASA's SPHEREx map. The sky opens on the
// visible map (quick to load) and the SPHEREx map comes in over it once its tiles are there; if its server never
// answers, the visible map simply stays.
const BG_START = (() => {
  const q = params.get("bg");
  if (q && Object.hasOwn(SURVEYS, q)) return q;
  try { const s = localStorage.getItem(BG_KEY); if (s && Object.hasOwn(SURVEYS, s)) return s; } catch { /* storage blocked */ }
  return "spherex";
})();

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
// Opening view (no link target): the Milky Way between Aquila and Ophiuchus, where NASA's SPHEREx map is full and bright,
// with Barnard's Star (one of the five targets) in the picture.
const START_VIEW = { ra: 272, dec: -2, fov: 50 };

const state = {
  A: null, al: null, cats: [], points: [], byId: new Map(), activeCat: null, selected: null,
  bg: "visible", autoSpx: true, slice: 42, hips: {}, spxOverlay: null, spxReady: false, catalogs: {},
  selCat: null, overlays: {}, coverage: null, ang2pix: null, objectClickedAt: 0, flat: null, engine: { kind: "browser" }, job: null,
};

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
// Extra star layers (starsnow.js: Gaia stars at 2026.0; faststars.js: fast stars, Surprise options).
// Loaded on their own, so a failure there never breaks the sky; they listen to these hooks.
const hooks = { view: [], card: [] };
let extrasP = null;
function loadExtras() {
  extrasP ||= Promise.all([import("./starsnow.js"), import("./faststars.js")]).then(([sn, fs]) => {
    const ext = { state, hooks, select, flyTo, toast, coverageAt, setSheet, isPhone, syncCatalogs };
    state.starsNow = sn.initStarsNow(ext);
    state.fast = fs.initFastStars(ext);
    import("./planets.js").then((m) => { state.planets = m.initPlanets(ext); }).catch((e) => console.warn("Planet layer unavailable", e));   // stars with known planets
    return state.fast;
  });
  extrasP.catch((e) => console.warn("Star layers unavailable", e));
  return extrasP;
}
const catsReady = loadCategories();
function setEngine(e) {
  state.engine = e;
  document.body.classList.toggle("engine-local", e.kind === "local");
  state.engineKnown = true;
  $("engineTag").textContent = engineLabel(e) + T(e.kind === "local" ? "ex.engine.localSuffix" : "ex.engine.browserSuffix");
  $("stEngine").textContent = engineLabel(e);
  return e;
}
$("stEngine").textContent = T("ex.st.checking");
const engineReady = detectEngine({ force: params.get("engine") }).then((e) => {
  performance.mark("fz-engine");
  setEngine(e);
  // On this computer but no answer yet (server starting or busy)? Keep asking for a minute.
  if (e.kind === "browser" && isLocalHost() && !params.get("engine")) {
    let tries = 0;
    const again = setInterval(async () => {
      const e2 = await detectEngine({ timeout: 8000 });
      if (e2.kind === "local") { setEngine(e2); clearInterval(again); toast(T("ex.toast.localFound")); }
      if (++tries >= 6) clearInterval(again);
    }, 10000);
  }
  return e;
});
const skyReady = startSky();
loadCoverage();
wireUi();
onLang(relang);

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
    $("cats").innerHTML = `<p class="warn">${T("ex.cats.fail", { err: esc(e.message) })}</p>`;
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
  for (const b of document.querySelectorAll("#bgSwitch button")) { b.disabled = true; b.title = T("ex.flat.needs3d"); }
  $("btnLayers").disabled = true;
  $("intro")?.remove();
  await catsReady;
  const { startFlatMap } = await import("./flatmap.js");
  const sv = startView();
  state.closeup = createCloseup({ state, size: skySize, pix2sky: (x, y) => state.flat?.toSky(x, y) });   // scale bar only
  const onFlatView = (v) => { showView(v.ra, v.dec, v.fov); setCompass(0, -90); state.closeup.update(v.ra, v.dec, v.fov); state.closeup.render(); };
  state.flat = startFlatMap($("sky"), {
    points: state.points, colors: CAT_COLORS, ra: sv.ra, dec: sv.dec, fov: sv.fov,
    onPick: (q) => select({ id: null, name: "Your spot", nameKey: "ex.name.yourSpot", ra: q.ra, dec: q.dec, cat: null, manual: true }),
    onView: onFlatView,
  });
  onFlatView(state.flat.getView());
  loadExtras();
  performance.mark("fz-sky");
  const sp = startView().point;
  if (sp) select(sp.id ? state.byId.get(sp.id) || sp : sp);
}

async function startSky() {
  const intro = $("intro");
  if (params.has("flat") || !hasWebGL2()) return startFlat(params.has("flat") ? "?flat" : "no WebGL2");
  // Map tiles (tilequeue.js): the view a zoom ends on first, nearest the cursor first; in-between zoom levels and
  // hidden maps wait; spread over mirrors that hold the same map (not CDS alasky: 404 in Nov 2026). IRSA answered
  // 2-6x slower than ESA per tile, so it only serves the SPHEREx map, or a map whose other servers fail.
  // ?tq=0 turns this off (timing comparisons).
  if (params.get("tq") !== "0") {
    installTileQueue({
      maps: [...Object.values(SURVEYS), ...Object.values(CLOSEUP_SURVEYS)].map((s) => ({ key: s.key, mirrors: s.mirrors.filter((m) => !m.includes("alasky")) })),
      priorMs: { "irsa.ipac.caltech.edu": 2500 },
    });
  }
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
    if (params.get("idle") !== "0") import("./idleloop.js").then((m) => { state.idleLoop = m.idleAladinLoop(al); }).catch((e) => console.warn("idle loop", e));   // no frames while the sky is still
    applyFovLimit();                                    // wheel / pinch can never zoom out past 120°
    addEventListener("resize", applyFovLimit);
    state.hips.visible = al.getBaseImageLayer();
    state.closeup = createCloseup({
      A, al, state, size: skySize, onChange: () => onViewChange(), onLimits: () => applyFovLimit(),
      pix2sky: (x, y) => { try { const q = al.pix2world(x, y); return q && Number.isFinite(q[0]) ? { ra: q[0], dec: q[1] } : null; } catch { return null; } },
    });
    // Map tiles of the view a zoom or flight ends on are fetched as soon as it starts (prefetch.js).
    if (params.get("tq") !== "0") {                     // ?tq=0: old behaviour (for timing comparisons)
      state.prefetch = createPrefetch({ al, size: skySize, weights: layerWeightsAt, base: baseKey, frame: () => state.slice, minFov: minWidthFov });
      state.closeup.setPrefetch(state.prefetch);
    }
    setupOverlays();
    import("./fieldsquare.js").then((m) => { state.fieldSquare = m.initFieldSquare({ state, hooks }); }).catch((e) => console.warn("Field square unavailable", e));   // the field a result covers, on the sky
    loadExtras();
    al.on("zoomChanged", () => onViewChange());
    al.on("positionChanged", () => onViewChange());
    al.on("objectClicked", (obj) => onObjectClicked(obj));
    al.on("click", (e) => onSkyClick(e));
    // A two-finger pinch is never a tap, even when it ends without moving the view (e.g. at the zoom limit).
    const noteMulti = (e) => { if (e.touches.length > 1 || (e.type === "touchend" && e.touches.length)) state.multiTouchAt = performance.now(); };
    for (const t of ["touchstart", "touchmove", "touchend"]) $("sky").addEventListener(t, noteMulti, { capture: true, passive: true });
    // Wheel, trackpad pinch and two-finger pinch zoom toward the cursor / finger midpoint (zoomanchor.js).
    import("./zoomanchor.js").then((m) => { state.zoomAnchor = m.anchorAladinZoom(al, { limits: () => [minWidthFov(), maxWidthFov()], onTarget: (f, x, y) => state.prefetch?.toward(f, x, y) }); })
      .catch((e) => console.warn("Zoom toward the cursor unavailable", e));
    onViewChange();
    performance.mark("fz-sky");
    intro.classList.add("gone");
    setTimeout(() => intro.remove(), 900);
    // The sky opens still, on its final view (no zoom animation on opening): a shared spot opens on that spot, a
    // named point jumps to it once the categories are in, the default view shows Barnard's Star in the Milky Way.
    if (start.point) {
      await catsReady;
      const p = start.point.id ? state.byId.get(start.point.id) || start.point : start.point;
      select(p, { fly: !!start.point.id, instant: true });
    }
    preloadSpherex();
    if (BG_START !== "visible" && BG_START !== "spherex") setBackground(BG_START, { quiet: true });   // SPHEREx: preloadSpherex()
  } catch (e) {
    console.warn("3D sky failed, switching to the flat map", e);
    if (state.al) return;              // the sky is up; a later step failed, keep it
    $("sky").innerHTML = "";
    startFlat(String(e.message || e));
  }
}

function startView() {
  // ?p=<point id> | ?ra=&dec=[&fov=] | default: START_VIEW. fov0: the field the sky opens with (no zoom animation).
  const ra = Number(params.get("ra")), dec = Number(params.get("dec"));
  const fov = Number(params.get("fov")) || null;
  if (params.get("p")) return { ra: START_VIEW.ra, dec: START_VIEW.dec, fov0: START_VIEW.fov, fov: 60, point: { id: params.get("p") } };
  if (Number.isFinite(ra) && Number.isFinite(dec) && params.has("ra") && params.has("dec")) {
    return { ra, dec, fov0: fov || 1, fov: fov || 1, point: { id: null, name: "Shared spot", nameKey: "ex.name.shared", ra, dec, cat: null, manual: true, fov: fov || 1 } };
  }
  return { ra: START_VIEW.ra, dec: START_VIEW.dec, fov0: START_VIEW.fov, fov: START_VIEW.fov };
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
      .map((p) => { const q = markerPos(p); return A.source(q.ra, q.dec, { name: pname(p), pid: p.id }); });
    al.addCatalog(dots); dots.addSources(srcs());
    al.addCatalog(labeled); labeled.addSources(srcs());
    state.catalogs[c.id] = { dots, labeled, srcs };
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
// Closest zoom: where the sharpest map at this spot still shows real detail (see minFov in surveys.js).
function minWidthFov() {
  return state.closeup ? state.closeup.minFov() : minFov($("sky").clientWidth || innerWidth);
}
// Visible share (0-1) of each map at field fov near dec, by the same rules as the fades (background, SPHEREx
// layer, close-up map). The tile queue loads (nearly) hidden maps last and prefetch.js skips them.
function layerWeightsAt(fov, dec) {
  const cu = state.closeup?.weightFor(fov, dec) || { key: null, op: 0 };
  const keep = state.closeup ? state.closeup.spherexFactor(fov) : 1;
  let spx = 0, under = 0;              // SPHEREx layer, and how much of the map under it shows
  if (state.bg === "spherex") {
    // the SPHEREx map is wanted at full weight even while it waits for its tiles; the visible map under it shows
    // as much as the SPHEREx layer does not (all of it while a new part of the sky loads)
    spx = keep; under = 1 - spxGate.op * keep;
  } else {
    const auto = state.spxReady && state.autoSpx;
    const [a, b] = SPHEREX_FADE;
    const t = Math.max(0, Math.min(1, (a - fov) / (a - b)));
    spx = auto ? t * t * (3 - 2 * t) * keep : 0;
    under = 1 - spx * spxGate.op;      // its tiles not in yet (layer hidden): the map under it shows
  }
  const out = { [baseKey()]: under * (1 - (cu.shown ?? cu.op)) };   // the close-up waiting for its tiles: the map under it shows
  if (spx > 0) out.spherex = (out.spherex || 0) + spx * (1 - cu.op);
  if (cu.key) out[cu.key] = (out[cu.key] || 0) + cu.op;
  return out;
}
function skySize() {
  const el = $("sky");
  return [el.clientWidth, el.clientHeight];
}
function applyFovLimit() {
  const al = state.al;
  if (!al) return;
  const m = maxWidthFov(), lo = minWidthFov();
  al.setFoVRange(lo, m);
  if (al.getFov()[0] > m) al.setFoV(m);
  else if (al.getFov()[0] < lo) al.setFoV(lo);
}

function zoomTo(fov, secs = 1.2, { prefetch = true } = {}) {
  fov = Math.max(minWidthFov(), Math.min(fov, state.al ? maxWidthFov() : MAX_FOV));
  if (prefetch && state.al && state.prefetch) state.prefetch.view(...state.al.getRaDec(), fov, secs * 1000);   // start that view's tiles now
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
async function flyTo(ra, dec, fov, { instant = false } = {}) {
  const al = state.al;
  fov = Math.min(fov, al ? maxWidthFov() : MAX_FOV);
  if (!al) { state.flat?.goTo(ra, dec, fov); return; }
  if (instant) { ++flight; al.gotoRaDec(ra, dec); al.setFoV(Math.max(minWidthFov(), fov)); return; }   // a jump, no animation
  const id = ++flight;
  const [cra, cdec] = al.getRaDec();
  const cur = al.getFov()[0];
  const sep = separation(cra, cdec, ra, dec);
  const far = sep > cur * 0.45 && sep > 2, panS = Math.max(0.6, Math.min(2.2, sep / 50)), zoomS = fov < 2 ? 2.2 : 1.4;
  // The tiles where the flight ends, while it flies (the steps below do not replace them).
  state.prefetch?.view(ra, dec, Math.max(minWidthFov(), fov), ((far ? 0.8 : 0) + panS + zoomS) * 1000);
  if (reduceMotion) { al.gotoRaDec(ra, dec); al.setFoV(fov); return; }
  if (far) {
    await zoomTo(Math.min(Math.max(cur, Math.min(sep * 1.6, MAX_FOV), 50), MAX_FOV), 0.8, { prefetch: false });   // pull back
    if (id !== flight) return;
  }
  await panTo(ra, dec, panS);
  if (id !== flight) return;
  await zoomTo(fov, zoomS, { prefetch: false });
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
    state.closeup?.update(ra, dec, fov);
    updateSpherexFade(fov);
    state.prefetch?.viewChanged(ra, dec, fov);           // tile queue: which maps show now; pre-warm when still
    for (const f of hooks.view) f(ra, dec, fov);
  });
}

function showView(ra, dec, fov) {
  $("stRa").textContent = iLoc(formatRA(ra));
  $("stDec").textContent = iLoc(formatDec(dec));
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
  // Find a working SPHEREx map server early. As the sky map (the default) its layer goes over the visible map now;
  // otherwise it is only added once you zoom in.
  try {
    await surveyUrl("spherex");
    state.spxReady = true;
    onViewChange();
    if (BG_START === "spherex" && !state.bgPicked && state.bg === "visible") {
      // the visible map of the opening view first (IRSA's slow SPHEREx tiles would hold its downloads back: a black
      // sky for seconds on a phone), then the SPHEREx layer over it
      for (const t0 = performance.now(); performance.now() - t0 < 6000;) {
        if (state.prefetch && state.prefetch.progress("visible") >= 0.95 && !state.al.isZooming?.()) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!state.bgPicked && state.bg === "visible") setBackground("spherex", { quiet: true });
    }
  } catch (e) {
    console.warn("SPHEREx HiPS unavailable", e);
    $("bg-spherex").disabled = true;
    $("bg-spherex").title = T("ex.spx.down");
    if (state.bg === "spherex") fallBackToVisible();
    if (BG_START === "spherex" && !state.bgPicked) toast(T("ex.spx.down"), true);   // the visible map instead, and why
  }
}

/** The key of the map in Aladin's base layer: SPHEREx as the sky map is an overlay over the visible map. */
function baseKey() { return state.bg === "spherex" ? "visible" : state.bg; }

function markBg(key) {
  for (const b of document.querySelectorAll("#bgSwitch button")) b.setAttribute("aria-checked", String(b.id === "bg-" + key));
}
/** SPHEREx cannot be reached: the visible map, quietly (it is already under the SPHEREx layer). */
function fallBackToVisible() {
  state.bg = "visible";
  markBg("visible");
  ensureSpherexOverlay(false);
  onViewChange();
}

// SPHEREx as the sky map. Its tiles come from IRSA (1.5-6 s each), and where Aladin has no tile of the order it draws
// it paints the layer as a flat dark patch, even over the map below (a coarser tile does not stand in). So the layer
// shows only once Aladin has the tiles of the whole view (prefetch.js coverage), and gives way to the map under it
// while a new part of the sky loads: under GATE_HIDE of the view covered for GATE_HIDE_MS hides it, GATE_SHOW of it
// for GATE_SHOW_MS shows it. The same gate holds the SPHEREx layer that fades in on its own below 3 deg.
const GATE_SHOW_MS = 250, GATE_HIDE_MS = 500, GATE_FADE_MS = 450, GATE_HIDE = 0.9, GATE_SHOW = 0.97;
const spxGate = { op: 0, t0: 0, okSince: 0, badSince: 0, last: 0, timer: 0,
  reset(op = 0) { this.op = op; this.t0 = performance.now(); this.okSince = this.badSince = 0; this.last = 0; } };
function stepSpxGate() {
  const g = spxGate, now = performance.now();
  const cov = state.prefetch ? state.prefetch.coverage("spherex") : null;   // null: not known (?tq=0): wait a few seconds
  g.cov = cov;
  const ok = cov == null ? now - g.t0 > 4000 : cov >= GATE_SHOW;
  // Its server fails (IRSA answered 502 for a while on Nov 15 2026): the map under it stays on screen; say why (at
  // most every 2 min).
  if (!ok && state.bg === "spherex" && g.op < 0.5 && now - g.t0 > 3000 && now - (g.toldAt || -1e9) > 120000
    && recentFailures("spherex", 15000) >= 3) { g.toldAt = now; toast(T("ex.spx.down"), true); }
  const bad = cov == null ? !ok : cov < GATE_HIDE;
  if (ok) g.okSince ||= now; else g.okSince = 0;
  if (bad) g.badSince ||= now; else g.badSince = 0;
  const target = ok && now - g.okSince >= GATE_SHOW_MS ? 1 : bad && now - g.badSince >= GATE_HIDE_MS ? 0 : g.op;
  const dt = g.last ? Math.min(100, now - g.last) : 16;
  g.last = now;
  if (target !== g.op) {
    const step = dt / GATE_FADE_MS;
    g.op = Math.abs(target - g.op) <= step ? target : g.op + Math.sign(target - g.op) * step;
  }
  // look again soon while fading, while tiles are on their way, or while waiting to decide
  if (!g.timer && (g.op !== target || !ok || g.op < 1)) {
    g.timer = setTimeout(() => { g.timer = 0; if (state.al && state.spxOverlay) updateSpherexFade(state.al.getFov()[0]); }, g.op !== target ? 30 : 150);
  }
  return g.op;
}

let spxBusy = false;
async function ensureSpherexOverlay(want) {
  const al = state.al;
  if (spxBusy || !al) return;
  if (want && !state.spxOverlay) {
    spxBusy = true;
    try {
      const h = await makeHips("spherex");
      try { h.setOpacity(0); } catch { /* set on the next update */ }
      al.setOverlayImageLayer(h, "spherex");
      setSlice(h);
      state.spxOverlay = h;
      spxGate.reset();
    } catch (e) { console.warn(e); } finally { spxBusy = false; }
    onViewChange();
  } else if (!want && state.spxOverlay) {
    try { al.removeImageLayer("spherex"); } catch (e) { console.warn(e); }
    state.spxOverlay = null;
  }
}

function updateSpherexFade(fov) {
  const chosen = state.bg === "spherex";                  // SPHEREx is the sky map (an overlay over the visible map)
  const auto = state.spxReady && state.autoSpx && !chosen;
  const [a, b] = SPHEREX_FADE;
  // Closer in, the SPHEREx map (12.9" pixels) gives way to the sharp close-up map.
  const keep = state.closeup ? state.closeup.spherexFactor(fov) : 1;
  const gone = keep === 0 && fov < CLOSEUP_FOV[1] * 0.6;   // well inside the close-up
  // Add the layer a bit before it starts to show, drop it again well after (hysteresis).
  if (((chosen && !gone) || (auto && fov < a * 1.25 && keep > 0)) && !state.spxOverlay) ensureSpherexOverlay(true);
  else if ((chosen ? gone : (!auto || fov > a * 1.8 || gone)) && state.spxOverlay) ensureSpherexOverlay(false);
  const h = state.spxOverlay;
  let op = 0;
  if (h && chosen) op = stepSpxGate() * keep;
  else if (h && auto) {
    // fades in as you zoom in, and (like the chosen map) only where Aladin has its tiles: else a flat dark patch
    const t = Math.max(0, Math.min(1, (a - fov) / (a - b)));
    op = t > 0 ? t * t * (3 - 2 * t) * keep * stepSpxGate() : 0;
  }
  if (h) { try { h.setOpacity(op); } catch { /* not ready yet */ } }
  const showing = op > 0.5;
  const badge = $("spxBadge");
  badge.hidden = !showing;
  if (showing) {
    const sl = SPHEREX_SLICES.find((s) => s.slice === state.slice);
    badge.querySelector("span").textContent = `${T("ex.spx.badge")}${sl ? " · " + iLoc(sl.label) : ""}`;
  }
  const credits = [SURVEYS[chosen && op >= 0.95 ? "spherex" : baseKey()].credit];
  if (op > 0.05 && !credits.includes(SURVEYS.spherex.credit)) credits.push(SURVEYS.spherex.credit);
  const cc = state.closeup?.credit();
  if (cc && !credits.includes(cc)) credits.push(cc);
  $("creditSurvey").textContent = credits.map((c) => T("ex.credit." + String(c).split(":")[0], null, c)).join("; ");
  state.closeup?.render(op);
}

/**
 * Switch the sky map. SPHEREx goes over the visible map as an overlay (updateSpherexFade shows it once its tiles are
 * in); the other maps replace the base layer. quiet: the opening switch to the default or remembered map (no toast;
 * if it fails the visible map simply stays).
 */
async function setBackground(key, { quiet = false } = {}) {
  if (!state.al) return;
  const btn = $("bg-" + key);
  markBg(key);
  const prev = state.bg;
  state.bg = key;
  try {
    btn.classList.add("bg-loading");      // not "loading": that class is the blink panel's absolute overlay (explore.css)
    if (key === "spherex") {
      await surveyUrl("spherex");         // a server answers (else: back to the map before)
      if (state.bg !== key) return;
      // the visible map goes back under it (Aladin fails on setting the layer it already has: compared by name)
      if (state.al.getBaseImageLayer()?.name !== SURVEYS.visible.title) state.al.setBaseImageLayer(await getHips("visible"));
      if (state.spxOverlay) spxGate.reset(state.spxOverlay.getOpacity?.() || 0);
    } else {
      const h = await getHips(key);
      if (state.bg !== key) return;
      if (state.al.getBaseImageLayer()?.name !== SURVEYS[key].title) state.al.setBaseImageLayer(h);   // from SPHEREx to visible: already there
    }
    if (!quiet) toast(`${T(`ex.sv.${key}.title`, null, SURVEYS[key].title)}: ${T(`ex.sv.${key}.blurb`, null, SURVEYS[key].blurb)}`);
  } catch (e) {
    if (state.bg === key) { state.bg = prev; markBg(prev); }
    if (quiet) console.warn("Sky map unavailable, keeping the visible map", key, e);
    else toast(e.message || T("ex.bg.fail"), true);
  } finally {
    btn.classList.remove("bg-loading");
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
    b.innerHTML = `<span class="ico" aria-hidden="true">${c.icon}</span><span class="nm">${esc(iField(c, "name"))}</span>` +
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
  $("catTitle").innerHTML = `<span aria-hidden="true">${c.icon}</span> ${esc(iField(c, "name"))}`;
  $("catDesc").textContent = iField(c, "description");
  if (id === "ecliptic") $("catDesc").insertAdjacentHTML("beforeend", ` <a href="asteroids.html">${esc(T("ex.cat.astLink"))}</a> <a href="comets.html">${esc(T("ex.cat.cometLink"))}</a>`);   // detector C results page
  const disc = $("catDisclaimer");
  disc.hidden = !c.disclaimer;
  disc.innerHTML = c.disclaimer ? `${esc(iField(c, "disclaimer"))}${c.citation ? `<br><small>${T("ex.cat.source")} ${esc(c.citation)}</small>` : ""}` : "";
  const ul = $("points");
  ul.innerHTML = "";
  for (const p of c.points) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pt" + (p.challenge ? " ch" : "");
    b.dataset.pid = p.id;
    b.innerHTML = `<span class="pn">${esc(pname(p))}${p.challenge ? ` <span class="tag">${T("ex.tag.challenge")}</span>` : ""}</span>` +
      `<span class="pd">${esc(iField(p, "note"))}</span>`;
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
function select(p, { fly = false, fov, fill = true, instant = false } = {}) {
  const pos = markerPos(p);
  state.selected = { ...p, pos };
  // Step 2 of the flow: the coordinate box fills in with the spot you picked.
  if (fill) { $("q").value = `${pos.ra.toFixed(5)} ${pos.dec >= 0 ? "+" : ""}${pos.dec.toFixed(5)}`; unsay(); }
  state.flat?.setSelection(pos);
  if (isPhone()) setSheet("peek");
  drawFootprints();
  state.selCat?.removeAll();
  if (state.A && state.selCat) state.selCat.addSources([state.A.source(pos.ra, pos.dec, { name: p.name })]);
  for (const b of document.querySelectorAll(".pt")) b.classList.toggle("on", b.dataset.pid === p.id);
  renderCard();
  const f = fov || p.fov || POINT_FOV[p.id] || CAT_FOV[p.cat] || 1;
  if (fly) flyTo(pos.ra, pos.dec, f, { instant });
  const q = new URLSearchParams();
  if (p.id && !p.manual) q.set("p", p.id);
  else { q.set("ra", pos.ra.toFixed(5)); q.set("dec", pos.dec.toFixed(5)); }
  const fovQ = new URLSearchParams(location.search).get("fov");   // Field choice (fov_ui.js) stays in the link
  if (fovQ) q.set("fov", fovQ);
  const bgQ = new URLSearchParams(location.search).get("bg");      // so does a sky map named in the link
  if (bgQ) q.set("bg", bgQ);
  history.replaceState(null, "", "?" + q.toString());
}

function catName(id) { return iField(state.cats.find((c) => c.id === id), "name") || ""; }
/** A point's name in the current language (generic names such as "Your spot" carry a nameKey). */
function pname(p) { return !p ? "" : p.nameKey ? T(p.nameKey) : iName(iField(p, "name")); }

function renderCard() {
  const p = state.selected;
  const card = $("card");
  if (!p) { card.hidden = true; document.body.classList.remove("card-open"); return; }
  card.hidden = false;
  document.body.classList.add("card-open");
  card.style.setProperty("--c", CAT_COLORS[p.cat] || "#7fd4ff");
  const kick = [];
  if (p.challenge) kick.push(T("ex.kick.challenge"));
  if (p.cat && p.cat !== "challenge") kick.push(catName(p.cat));
  if (p.manual) kick.push(T("ex.kick.yourPick"));
  if (p.type) kick.push(typeName(p.type));
  $("cardKicker").textContent = kick.join(" · ");
  $("cardTitle").textContent = pname(p);
  $("cardNote").textContent = (p.noteFn ? p.noteFn() : p.noteKey ? T(p.noteKey) : iField(p, "note")) || (p.manual ? T("ex.card.manualNote") : "");
  $("cardRa").textContent = iLoc(formatRA(p.pos.ra));
  $("cardDec").textContent = iLoc(formatDec(p.pos.dec));
  $("cardDeg").textContent = iLoc(`${p.pos.ra.toFixed(4)}°, ${p.pos.dec >= 0 ? "+" : ""}${p.pos.dec.toFixed(4)}°`);
  $("cardMoved").hidden = !(p.ra_2026 != null || p.moved);
  const cov = coverageAt(p.pos.ra, p.pos.dec);
  const covEl = $("cardCov");
  if (cov) {
    covEl.hidden = false;
    covEl.className = "cov " + (cov.seasons >= 2 ? "good" : "thin");
    covEl.textContent = cov.seasons >= 2
      ? T("ex.cov.good", { n: cov.seasons })
      : cov.seasons === 1
        ? T("ex.cov.one")
        : T("ex.cov.none");
  } else covEl.hidden = true;
  const g = $("btnGallery");
  g.hidden = true;
  if (p.challenge && p.gallery) {
    fetch(p.gallery + "meta.json", { method: "HEAD" }).then((r) => {
      if (r.ok && state.selected?.id === p.id) { g.hidden = false; g.dataset.src = `ornek.html?data=${p.gallery}`; }
    }).catch(() => {});
  }
  for (const f of hooks.card) f(p);
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
  legend.textContent = T("ex.fp.looking");
  let imgs;
  try {
    const { findImages } = await import("../js/skyindex.js");
    imgs = await findImages(p.pos.ra, p.pos.dec);
  } catch (e) {
    if (run === fpRun) legend.textContent = T("ex.fp.noIndex");
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
    ? T("ex.fp.cover", { n: imgs.length }) + " " + seasons.map((s) =>
      `<span class="sea"><i style="background:${s.color}"></i>${ym(s.start)} (${s.n})</span>`).join(" ")
    : T("ex.fp.none");
}

function blinkUrl(p) {
  const fov = window.__fzFov ? window.__fzFov() : null;   // Field selector (fov_ui.js); null = engine default
  const f = fov ? `&fov=${fov}` : "";
  if (p.challenge && p.id) return `sky.html?target=${encodeURIComponent(p.id)}${f}`;
  return `sky.html?ra=${p.pos.ra.toFixed(5)}&dec=${p.pos.dec.toFixed(5)}${f}`;
}

// ---------------------------------------------------------------------------------------------
// Blink panel (sky.html / ornek.html in an iframe)
// ---------------------------------------------------------------------------------------------
let lastFocus = null, panelTitle = null;
function showPanel(title) {
  const panel = $("blink");
  if (panel.hidden) lastFocus = document.activeElement;
  panelTitle = title;                          // a string, or a function (re-run on a language switch)
  $("blinkTitle").textContent = typeof title === "function" ? title() : title;
  panel.hidden = false;
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
  import("./candidates.js").then((m) => m.showOnSky(state, src)).catch(() => {});   // finder candidates on the sphere
}

// Stage badge in the panel header: "Preview (12 images)" (amber) -> "Full result (N images)" (green),
// with real counts. The local engine sets it from its jobs; sky.html (in-browser engine) reports its
// stage with postMessage. window.__fzTimes keeps the click and stage times (Date.now) for timing runs.
function setStage(kind, n, note = "") {
  setStage.last = kind ? [kind, n, note] : null;
  const el = $("blinkStage");
  if (kind) { const t = (window.__fzTimes ||= {}); t[kind + "Shown"] ||= Date.now(); t[kind + "N"] = n; }
  if (!el) return;
  el.hidden = !kind;
  el.className = "stage-badge" + (kind ? " " + kind : "");
  el.textContent = kind === "preview" ? T("ex.stage.preview", { n }) : kind === "full" ? T("ex.stage.full", { n }) : "";
  el.title = note;
}
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (ev.origin !== location.origin || !d || d.type !== "fazari-stage" || state.job) return;
  if (ev.source !== $("blinkFrame").contentWindow) return;
  setStage(d.stage, d.n, d.note || "");
});

// Post-steps (spectrum, candidates, faint) that finish after the local result is on screen:
// ornek.html (js/post_watch.js) reports each one; update the result bar and the finder's sky marks.
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (ev.origin !== location.origin || !d || d.type !== "fazari-post" || ev.source !== $("blinkFrame").contentWindow) return;
  const rb = $("resultBar"), fz = rb._fz;
  if (fz && fz.post && fz.url && fz.url.includes(`/jobs/${d.job}/`)) {
    fz.post.left = Array.isArray(d.pending) ? d.pending : [];
    rb.querySelector("small").textContent = fz.small();
  }
  if (d.step === "candidates" && fz && fz.post) sureFor(fz.url, T, iNum).then((sv) => { if (sv) { fz.post.sure = sv; rb.querySelector("small").textContent = fz.small(); } });
  if (d.step === "candidates") import("./candidates.js").then((m) => m.showOnSky(state, $("blinkFrame").getAttribute("src"))).catch(() => {});
});

function openBlink(src, title) {
  stopJob();
  $("resultBar").hidden = true;
  showPanel(title);
  setStage(null);
  window.__fzTimes = { click: Date.now(), engine: "browser" };
  loadFrame(src);
}

// Local Python engine: a quick preview first (the engine's fast lane: one wavelength, a few images
// per season, small regions), shown as soon as it exists; the full result replaces it when done.
function stopJob() {
  let done = null;
  if (state.job) { done = state.job.cancel(); state.job = null; }
  return done;                                   // resolves when the engine has the cancel
}

// Progress of a local job as one bar (u3): count-based (images) and time-based (the engine's eta_s), never
// backwards, creeping while the engine works on a step without counts. f = null while it is honestly unknown
// (waiting in line, looking for images): the bar is then indeterminate. line: one short sentence.
function jobProgress(j, mem) {
  const pr = j.progress || {}, now = performance.now(), st = j.state;
  if (st !== "queued" && mem.tStart == null) mem.tStart = now;
  const tot = pr.total || 0, done = Math.min(pr.done || 0, tot);
  let f = null, line;
  if (st === "queued") line = j.queue && j.queue.ahead ? T("u3.pg.queue", { n: j.queue.ahead }) : T("u3.pg.start");
  else if (st === "finding") line = T("u3.pg.finding");
  else if (st === "downloading") { mem.dl = true; if (tot) f = 0.8 * done / tot; line = tot ? T("u3.pg.dl", { done, total: tot }) : T("u3.pg.dl0"); }
  else if (st === "processing") { const b = mem.dl ? 0.8 : 0; f = tot ? b + (0.9 - b) * done / tot : mem.dl ? 0.8 : null; line = T("u3.pg.meas"); }
  else line = stateText(st);
  if (j.eta_s != null && mem.tStart != null && (st === "downloading" || st === "processing")) {
    const el = (now - mem.tStart) / 1000;
    f = Math.max(f ?? 0, Math.min(0.97, el / (el + Math.max(1, j.eta_s))));
  }
  if (f != null || mem.f != null) {
    // never backwards; while the engine works without new counts, creep slowly (0.2 %/s), at most 4 % ahead
    const prev = mem.f ?? 0, est = f ?? 0, dt = mem.tLast != null ? (now - mem.tLast) / 1000 : 0;
    f = Math.max(est, prev);
    if (f <= prev && (st === "downloading" || st === "processing")) f = Math.min(Math.max(prev, est + 0.04), prev + 0.002 * dt);
    mem.f = f = Math.min(0.99, f);
  }
  mem.tLast = now;
  if (j.eta_s != null && (st === "downloading" || st === "processing")) {
    // the engine's last estimate can stay at "about 10 s" for a minute or more: then say "almost done", not a wrong time
    if (j.eta_s > 15) mem.lowSince = null; else mem.lowSince ??= now;
    line += " · " + (mem.lowSince != null && now - mem.lowSince > 20000 ? T("u3.pg.almost") : fmtWait(j.eta_s));
  }
  return { f, line };
}
function paintBar(bar, f) {
  const fill = bar.querySelector("i");
  bar.classList.toggle("indet", f == null);
  if (fill) fill.style.width = f == null ? "" : (100 * f).toFixed(1) + "%";
  if (f == null) bar.removeAttribute("aria-valuenow"); else bar.setAttribute("aria-valuenow", String(Math.round(100 * f)));
}
/** The result bar's progress row (made once): <span class="u3-bar" role="progressbar"><i></i></span> after the <b>. */
function rbarBar(rbar) {
  let bar = rbar.querySelector(".u3-bar");
  if (!bar) {
    bar = document.createElement("span");
    bar.className = "u3-bar indet";
    bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
    bar.innerHTML = "<i></i>";
    rbar.querySelector("b").after(bar);
  }
  return bar;
}

function startLocalJob(p) {
  // Fetch again on the spot whose jobs are still running: keep them (no cancel and restart)
  const key = `${p.pos.ra.toFixed(6)},${p.pos.dec.toFixed(6)},${p.name},${window.__fzFov ? window.__fzFov() : ""}`;
  if (state.job && state.job.key === key && params.get("force") !== "1") { showPanel(() => T("ex.blink.title", { name: pname(p) })); return; }
  const prevCancel = stopJob();
  showPanel(() => T("ex.blink.title", { name: pname(p) }));
  setStage(null);
  window.__fzTimes = { click: Date.now(), engine: "local" };
  const fr = $("blinkFrame");
  fr.removeAttribute("src");
  $("blinkLoading").hidden = true;
  $("blinkNew").hidden = true;
  $("job").hidden = false;
  $("jobState").textContent = T("ex.job.sending");
  $("jobDetail").textContent = iLoc(`RA ${p.pos.ra.toFixed(5)}°, Dec ${p.pos.dec.toFixed(5)}°`);
  $("jobMsg").textContent = ""; $("jobMsg").className = "job-msg";
  $("jobCancel").hidden = false; $("jobBrowser").hidden = true;
  const bar = $("jobBar").parentElement;
  bar.classList.add("indet");
  const rbar = $("resultBar");
  rbar.hidden = true; rbar.classList.remove("pending", "u3-done", "u3-fail");
  rbar.querySelector("b").hidden = false;
  const memFull = {}, memPv = {};                                 // progress bars: never backwards (jobProgress)
  const t0 = performance.now();
  const elapsed = () => { const el = Math.round((performance.now() - t0) / 1000); return T("ex.job.elapsed", { t: `${Math.floor(el / 60)}:${String(el % 60).padStart(2, "0")}` }); };
  const req = { ra: +p.pos.ra.toFixed(6), dec: +p.pos.dec.toFixed(6), name: p.manual && !p.pmra ? undefined : p.name };
  if ((p.manual || p.pmEpoch != null) && p.pmra != null && Math.hypot(p.pmra, p.pmdec || 0) > 0) {   // pmEpoch: fast stars (2026.0)
    Object.assign(req, { pmra: p.pmra, pmdec: p.pmdec || 0, epoch: +(p.pmEpoch ?? (p.moved ? nowYear() : 2000)).toFixed(3) });
  }
  if (p.parallax > 0) req.parallax = p.parallax;              // mas (category points, fast stars): annual parallax term
  if (params.get("force") === "1") req.force = true;         // testing: ignore the engine's result cache
  const shown = { url: null, n: 0 };
  const tick = ({ full: j, preview: pv, quick: qd }) => {
    if (state.job !== job) return;
    // wavelength by wavelength (js/bins_bar.js): from the first stage on, the panel shows the stages (ornek.html
    // follows the job itself and swaps each stage in place); the result strip keeps only the engine's time line
    const pgs = j.progressive, pgOn = !!(shown.pg || (pgs && pgs.latest != null && pgs.stages && pgs.stages[pgs.latest] && j.state !== "done"));   // shown.pg: never back to the preview
    rbarBar(rbar).hidden = pgOn;
    if (pgOn) {
      if (!shown.pg) { shown.pg = true; shown.url = pgs.stages[pgs.latest].url; loadFrame(`ornek.html?data=${shown.url}&job=${encodeURIComponent(j.id)}`); }
      rbar.hidden = false; rbar.classList.add("pending");
      const pgLine = PG && pgs ? PG.etaText(PG.fromLocal(j)) : "";
      if (pgLine || j.state !== "done") rbar.querySelector("b").textContent = pgLine;
      rbar.querySelector("small").textContent = elapsed();
      return;
    }
    const pvDone = pv && pv.state === "done";
    const pvUrl = pvDone ? pv.result_url : pv && pv.partial ? pv.partial.url : null;
    const pvN = pvDone ? ((pv.result || {}).n_images || (pv.images || {}).selected) : pv && pv.partial ? pv.partial.n_images : 0;
    if (j.state !== "done" && pvUrl && shown.url !== pvUrl) {          // first look, then the complete preview
      shown.url = pvUrl; shown.n = pvN; shown.bin = (pv.images || {}).bin_um || null;
      loadFrame(`ornek.html?data=${pvUrl}`);
      setStage("preview", pvN, T("ex.job.pvNote"));
      performance.mark("fz-preview");
    }
    const qb = j.state !== "done" && quickBlink(qd, shown.bin);         // e.g. 4.6 um for a cold brown dwarf
    if (qb && shown.url && shown.url !== qb.url) {
      shown.url = qb.url; shown.n = qb.n; shown.bin = qb.bin;
      loadFrame(`ornek.html?data=${qb.url}`);
      setStage("preview", qb.n, T("ex.job.pvNote"));
    }
    if (shown.url) {
      const q = quickLines(qd, T, iNum);                                  // quick decision (local/quick.py)
      rbar.hidden = false; rbar.classList.add("pending");
      // one short line + a bar that fills; the quick decision's sentence goes to the answer card in the panel
      // (postMessage below), the numbers (MB, exposures, time) to the small line (Detailed mode)
      const pg = jobProgress({ ...j, paused_for_preview: false }, memFull);
      rbar.querySelector("b").textContent = T("u3.pg.full", { line: pg.line });
      paintBar(rbarBar(rbar), pg.f);
      rbar.querySelector("small").textContent = (q ? q.line2 + " · " : quickProgress(qd, T))
        + T("ex.rb.bg", { line: jobLine({ ...j, paused_for_preview: false }) || stateText(j.state), elapsed: elapsed() });   // our preview is on screen: "paused for the preview" would be stale
      if (!q) try { $("blinkFrame").contentWindow.postMessage({ type: "fazari-quick", text: "" }, location.origin); } catch { /* not loaded */ }
      if (q) try { $("blinkFrame").contentWindow.postMessage({ type: "fazari-quick", ...q }, location.origin); } catch { /* not loaded */ }
      return;
    }
    // nothing on screen yet: progress of the preview (or of the full job when there is no preview)
    const cur = pv && !["done", "error", "cancelled"].includes(pv.state) ? pv : j;
    $("jobState").textContent = cur !== j
      ? (pv.state === "queued" ? T("ex.job.pvWait") : T("ex.job.pvBuild"))
      : stateText(j.state);
    const pr = cur.progress || {};
    const pg = jobProgress(cur, cur === j ? memFull : memPv);
    paintBar(bar, pg.f);
    $("jobDetail").textContent = pg.line;                              // one short line; the numbers below (Detailed mode)
    const bits = [];
    if (pr.bytes) bits.push(iLoc(`${(pr.bytes / 1048576).toFixed(1)} MB`));
    bits.push(elapsed());
    $("jobMsg").textContent = (cur !== j ? T("ex.job.after", { line: jobLine(j) || stateText(j.state) })
      : j.state === "queued" && j.queue ? T("ex.job.full", { line: jobLine(j) })
      : /^paused: a quick preview/.test(j.message || "") && !j.paused_for_preview ? stateText(j.state)   // the worker's message outlives the pause
      : iPtext(j.message || "")) + " · " + bits.join(" · ");
    $("jobMsg").classList.add("u3-tech");
  };
  // state.jobTick: the progress text is drawn again on a language switch (relang)
  const job = runLocalPreviewJob(req, (d) => { state.jobTick = () => tick(d); tick(d); }, { after: prevCancel });
  job.key = key;
  state.job = job;
  job.promise.then((j) => {
    if (state.job !== job) return;
    state.job = null;
    if (j.state === "done" && j.result_url) {
      const pgUm = shown.pg ? (() => { try { return $("blinkFrame").contentWindow.__fzPgShown; } catch { return null; } })() : null;   // bins_bar.js: the wavelength on screen
      loadFrame(`ornek.html?data=${j.result_url}` + (shown.pg ? `&job=${encodeURIComponent(j.id)}` + (Number.isFinite(pgUm) ? `&um=${pgUm.toFixed(1)}` : "") : shown.bin ? `&bin=${shown.bin.toFixed(1)}` : ""));   // stay at the preview's wavelength
      const secs = (performance.now() - t0) / 1000;
      performance.mark("fz-result");
      resultSummary(j.result_url).then((r) => {
        if (state.job || $("job").hidden === false) return;
        rbar.hidden = false; rbar.classList.remove("pending"); rbar.classList.add("u3-done");
        // the sentence is the answer card's (in the panel): not repeated here; only the engine line (Detailed mode)
        rbar.querySelector("b").textContent = ""; rbar.querySelector("b").hidden = true;
        const post = { left: j.post_pending ? j.post_pending.steps.slice() : [], sure: "" };   // post-steps still running
        const small = () => T("ex.rb.engine", { when: secs < 2 ? T("ex.rb.cached") : T("ex.rb.ready", { s: secs.toFixed(0) }) })
          + (post.left.length ? T("ex.rb.adding", { steps: post.left.join(", ") }) : "") + (post.sure ? " · " + post.sure : "");
        sureFor(j.result_url, T, iNum).then((sv) => { if (sv && rbar._fz && rbar._fz.post === post) { post.sure = sv; rbar.querySelector("small").textContent = small(); } });
        rbar.querySelector("small").textContent = small();
        rbar._fz = { url: j.result_url, small, post };    // re-rendered on a language switch and on "fazari-post"
        setStage("full", r ? r.n : (j.progress || {}).total, T("ex.job.fullNote"));
      });
    } else if (j.state !== "cancelled") {
      if (shown.url) {                                             // keep the preview on screen
        rbar.classList.remove("pending"); rbar.classList.add("u3-fail");
        rbar.querySelector("b").textContent = T("u3.pg.failed");
        rbar.querySelector("small").textContent = T("ex.rb.failed", { msg: iPtext(j.message) || T("ex.err.unknown") });
      } else {
        jobFailed(p, iPtext(j.message) || T("ex.job.failed"));
      }
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
  b.onclick = () => openBlink(blinkUrl(p), () => T("ex.blink.title", { name: pname(p) }));
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
  select({ id: null, name: "Your spot", nameKey: "ex.name.yourSpot", ra: e.ra, dec: e.dec, cat: null, manual: true });
}

// Search-box message: kept as a render function so a language switch redraws it in the new language;
// cleared when a spot is picked another way (map click, list), so an old warning never stays up.
function say(err, render) {
  const msg = $("searchMsg");
  state.sayMsg = { err, render };
  msg.className = err ? "msg err" : "msg"; msg.hidden = false;
  const r = render();
  if (r.html != null) msg.innerHTML = r.html; else msg.textContent = r.text;
}
function unsay() { state.sayMsg = null; const m = $("searchMsg"); if (m) { m.hidden = true; m.textContent = ""; } }

async function runSearch(text) {
  const t = text.trim();
  if (!t) return;
  say(false, () => ({ text: "" }));
  const c = parseCoords(t);
  if (c) {
    say(false, () => ({ text: T("ex.q.going", { ra: iLoc(formatRA(c.ra)), dec: iLoc(formatDec(c.dec)), how: T(c.format === "decimal" ? "ex.q.decimal" : "ex.q.sexa") }) }));
    select({ id: null, name: "Your coordinates", nameKey: "ex.name.yourCoords", ra: c.ra, dec: c.dec, cat: null, manual: true }, { fly: true, fov: 1, fill: false });
    return;
  }
  if (looksLikeCoords(t)) {
    say(true, () => ({ html: T("ex.q.bad") }));
    return;
  }
  const local = findLocal(state.points, t);
  if (local) {
    say(false, () => ({ text: T("ex.q.foundIn", { name: pname(local), cat: catName(local.cat) }) }));
    openCategory(local.cat);
    select(local, { fly: true, fill: false });
    return;
  }
  say(false, () => ({ text: T("ex.q.looking", { q: t }) }));
  try {
    const r = await sesame(t);
    if (!r) {
      say(true, () => ({ html: T("ex.q.none", { q: esc(t) }) }));
      return;
    }
    const same = r.name.toLowerCase().replace(/\W/g, "") === t.toLowerCase().replace(/\W/g, "");
    const shown = same ? r.name : `${t} (${r.name})`;
    const kind = plainType(r.type);
    say(false, () => ({ text: kind ? T("ex.q.foundKind", { name: iName(shown), kind: typeName(kind) }) : T("ex.q.found", { name: iName(shown) }) }));
    select({ id: null, name: shown, ra: r.ra, dec: r.dec, cat: null, manual: true, moved: r.moved, type: kind, pmra: r.pmra, pmdec: r.pmdec }, { fly: true, fov: 1, fill: false });
  } catch (e) {
    say(true, () => ({ text: T("ex.q.noService") }));
  }
}

// "Surprise me": two options (a fast star, or a truly random spot), from faststars.js.
function surprise() {
  (extrasP || loadExtras()).then((fs) => fs.openSurprise()).catch(() => surpriseQuick());
}

function surpriseQuick() {
  const pick = Math.random();
  let target;
  if (state.coverage && pick < 0.5) {
    for (let i = 0; i < 400; i++) {
      const q = randomSky();
      const cv = coverageAt(q.ra, q.dec);
      if (cv && cv.seasons >= 4) { target = { id: null, name: "A random spot SPHEREx visited often", nameKey: "ex.name.randomOften", ra: q.ra, dec: q.dec, cat: null, manual: true }; break; }
    }
  }
  if (!target && pick < 0.25) {
    const q = randomSky();
    target = { id: null, name: "A random spot on the sky", nameKey: "ex.name.random", ra: q.ra, dec: q.dec, cat: null, manual: true };
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
function setSheet(mode) {
  document.body.dataset.sheet = mode;
  $("sheetToggle").setAttribute("aria-expanded", String(mode === "open"));
}

// Desktop: the left panel folds down to its title bar ("Explore the sky ▸"); the choice is remembered in this browser.
// Phones keep the bottom sheet (#sheetToggle); there the fold button is not shown and the class has no effect.
function setPanelShut(shut, { save = true } = {}) {
  document.body.classList.toggle("panel-shut", shut);
  const b = $("panelFold");
  b.setAttribute("aria-expanded", String(!shut));
  b.title = T(shut ? "ex.panel.show" : "ex.panel.hide");
  if (save) { try { localStorage.setItem(PANEL_KEY, shut ? "shut" : "open"); } catch { /* storage blocked */ } }
}
function wirePanelFold() {
  let shut = false;
  try { shut = localStorage.getItem(PANEL_KEY) === "shut"; } catch { /* storage blocked */ }
  setPanelShut(shut, { save: false });
  $("panelFold").addEventListener("click", () => setPanelShut(!document.body.classList.contains("panel-shut")));
  onLang(() => setPanelShut(document.body.classList.contains("panel-shut"), { save: false }));
}
/** Show the Layers section: the panel (or the phone sheet) open, the section open (used by the guided tour). */
function openLayers() {
  if (isPhone()) setSheet("open");
  else if (document.body.classList.contains("panel-shut")) setPanelShut(false, { save: false });
  $("layersBox").open = true;
}

/** "Download / Share ▾" of the place card. Files come from the result open in the panel: its page makes them
 *  (window.__tsSave of sky.html / ornek.html, js/cp_save.js) and says "not finished yet" while it measures. The
 *  position and the link are this place's (on a phone with a share sheet: Share). */
function wireShareMenu() {
  const btn = $("btnShare"), menu = $("shareMenu");
  if (!btn || !menu) return;
  const vid = menu.querySelector('[data-sh="video"]'), lnk = menu.querySelector('[data-sh="link"]');
  if (vid) vid.hidden = !(typeof MediaRecorder === "function" && HTMLCanvasElement.prototype.captureStream);
  const phoneShare = !!(navigator.share && window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  if (phoneShare && lnk) { lnk.setAttribute("data-i18n", "ex.sh.share"); lnk.textContent = T("ex.sh.share"); }
  const place = () => {                                   // over the page, next to the button (the card scrolls on phones)
    const r = btn.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    let top = r.top - h - 6;
    if (top < 8) top = Math.min(r.bottom + 6, innerHeight - h - 8);
    menu.style.left = left + "px"; menu.style.top = Math.max(8, top) + "px";
  };
  const open = (on, keys = false) => {
    menu.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
    if (on) { place(); if (keys) menu.querySelector("button:not([hidden])")?.focus({ preventScroll: true }); }   // from the keyboard: on the first item
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); open(menu.hidden, e.detail === 0); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) open(false); });
  document.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "Escape") { e.stopImmediatePropagation(); open(false); btn.focus(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {          // arrow keys move along the items
      const its = [...menu.querySelectorAll("button:not([hidden])")], i = its.indexOf(document.activeElement);
      its[(i + (e.key === "ArrowDown" ? 1 : its.length - 1)) % its.length]?.focus();
      e.preventDefault();
    }
  }, true);
  window.addEventListener("resize", () => { if (!menu.hidden) open(false); });
  menu.addEventListener("click", async (e) => {
    const it = e.target.closest("[data-sh]");
    if (!it) return;
    open(false);
    const what = it.dataset.sh, p = state.selected;
    if (what === "embed") {                                 // the <iframe> code of embed.html for this place (js/embed_code.js)
      const em = await import("../js/embed_code.js");
      await em.copyEmbed(em.placeOptions(p, pname(p)), (msg, err) => toast(msg, err));
      return;
    }
    if (what === "pos" || what === "link") {
      const cp = await import("../js/cp_save.js");
      if (what === "pos") {
        if (!p) return;
        toast((await cp.copyText(cp.positionText(p.pos.ra, p.pos.dec))) ? T("cp.pos.ok") : T("cp.link.fail"));
        return;
      }
      if (phoneShare) {
        try { await navigator.share({ title: document.title, url: location.href }); return; }
        catch (x) { if (x && x.name === "AbortError") return; }
      }
      if (await cp.copyText(location.href)) toast(T("ex.toast.copied")); else toast(location.href);
      return;
    }
    // a file: from the result in the panel (none yet, or the local engine still at work: not finished)
    let save = null;
    try { const w = !$("blink").hidden && $("job").hidden ? $("blinkFrame").contentWindow : null; save = w && typeof w.__tsSave === "function" ? w.__tsSave : null; }
    catch { save = null; }
    if (!save) { toast(T("ex.sh.first")); return; }
    const busy = { gif: "cp.gif.busy", video: "cp.vid.busy", pdf: "cp.pdf.busy" }[what];
    if (busy) toast(T(busy));
    try {
      const r = await save(what);
      if (r && r.msg) toast(r.msg, !r.ok);
      else if (busy) { $("toast").className = "toast"; }
    } catch (x) { console.warn("explore: save", x); toast(T("cp.fail"), true); }
  });
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
  for (const key of Object.keys(SURVEYS)) {
    $("bg-" + key).addEventListener("click", () => {
      state.bgPicked = true;              // the opening switch to SPHEREx no longer applies
      try { localStorage.setItem(BG_KEY, key); } catch { /* storage blocked */ }
      setBackground(key);
    });
  }
  const toggleMapSettings = () => {
    const pop = $("layers"), open = pop.hidden;
    pop.hidden = !open;
    $("btnLayers").setAttribute("aria-expanded", String(open));
  };
  // Phones: the one Layers button opens the sheet at its Layers section (sky map, star layers, which map is shown);
  // the rest of the map settings are one tap further ("More map settings").
  $("btnLayers").addEventListener("click", () => {
    if (!isPhone()) { toggleMapSettings(); return; }
    if (document.body.dataset.sheet === "open" && $("layersBox").open) { setSheet("peek"); return; }
    openLayers();
    setTimeout(() => $("layersBox").scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" }), 300);
  });
  $("btnMapMore").addEventListener("click", toggleMapSettings);
  for (const id of ["tgMarkers"]) $(id).addEventListener("change", syncCatalogs);
  for (const id of ["tgEcliptic", "tgGalactic", "tgP9"]) $(id).addEventListener("change", syncLineToggles);
  $("tgCoverage").addEventListener("change", (e) => toggleCoverageLayer(e.target.checked));
  $("tgFoot").addEventListener("change", () => drawFootprints());
  $("tgAuto").addEventListener("change", (e) => { state.autoSpx = e.target.checked; onViewChange(); });
  const sel = $("slice");
  for (const s of SPHEREX_SLICES) sel.add(new Option(iLoc(s.label), s.slice, s.slice === state.slice, s.slice === state.slice));
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
      else openBlink(blinkUrl(p), () => T("ex.blink.title", { name: pname(p) }));
    });
  });
  $("jobCancel").addEventListener("click", () => {
    stopJob();
    $("jobState").textContent = stateText("cancelled");
    $("jobMsg").textContent = T("ex.job.stopped");
    $("jobBar").parentElement.classList.remove("indet");
    $("jobCancel").hidden = true;
  });
  $("btnGallery").addEventListener("click", () => {
    const p = state.selected;
    if (p) openBlink($("btnGallery").dataset.src, () => T("ex.blink.prepared", { name: pname(p) }));
  });
  $("btnZoom").addEventListener("click", () => {
    const p = state.selected;
    if (!p) return;
    const fov = state.al ? state.al.getFov()[0] : 1;
    flyTo(p.pos.ra, p.pos.dec, Math.max(0.12, Math.min(fov / 4, 0.5)));
  });
  wireShareMenu();
  $("blinkClose").addEventListener("click", closeBlink);
  $("blinkFrame").addEventListener("load", () => { $("blinkLoading").hidden = true; });
  // the sheet's handle: a tap toggles it; pulled up it opens, pulled down it folds
  let pullY = null, pulled = false;
  $("sheetToggle").addEventListener("touchstart", (e) => { pullY = e.touches[0].clientY; pulled = false; }, { passive: true });
  $("sheetToggle").addEventListener("touchend", (e) => {
    if (pullY == null) return;
    const dy = e.changedTouches[0].clientY - pullY;
    pullY = null;
    if (Math.abs(dy) > 18) { pulled = true; setSheet(dy < 0 ? "open" : "peek"); }
  }, { passive: true });
  $("sheetToggle").addEventListener("click", () => {
    if (pulled) { pulled = false; return; }                   // already handled as a pull
    setSheet(document.body.dataset.sheet === "open" ? "peek" : "open");
  });
  setSheet("peek");
  wirePanelFold();

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
    if (k === "+" || k === "=") { zoomTo(Math.max(fov / 1.6, minWidthFov()), 0.35); e.preventDefault(); }
    else if (k === "-" || k === "_") { zoomTo(Math.min(fov * 1.6, MAX_FOV), 0.35); e.preventDefault(); }
    else if (k.startsWith("Arrow")) {
      e.preventDefault();
      const cosd = Math.max(0.1, Math.cos(dec * Math.PI / 180));
      if (k === "ArrowLeft") al.gotoRaDec((ra + step / cosd + 360) % 360, dec);
      if (k === "ArrowRight") al.gotoRaDec((ra - step / cosd + 360) % 360, dec);
      if (k === "ArrowUp") al.gotoRaDec(ra, Math.min(90, dec + step));
      if (k === "ArrowDown") al.gotoRaDec(ra, Math.max(-90, dec - step));
    } else if (k === "Enter" && document.activeElement === $("sky")) {
      select({ id: null, name: "Your spot", nameKey: "ex.name.yourSpot", ra, dec, cat: null, manual: true });
    }
  });
}

// Language switch (js/i18n.js): re-render text only. The selection, the coordinate box, the open
// category, the view and an open blink panel stay as they are (the viewer in the panel switches itself).
function relang() {
  if (state.sayMsg) say(state.sayMsg.err, state.sayMsg.render);
  if (state.engineKnown) setEngine(state.engine); else $("stEngine").textContent = T("ex.st.checking");
  if (state.cats.length) {
    const sheet = document.body.dataset.sheet;
    renderCategories();
    if (state.activeCat === "surprise") state.fast?.openSurprise?.();
    else if (state.activeCat) openCategory(state.activeCat);
    for (const b of document.querySelectorAll(".pt")) b.classList.toggle("on", !!state.selected?.id && b.dataset.pid === state.selected.id);
    setSheet(sheet);
    for (const v of Object.values(state.catalogs)) {
      if (v.srcs) { v.dots.removeAll(); v.dots.addSources(v.srcs()); v.labeled.removeAll(); v.labeled.addSources(v.srcs()); }
    }
  }
  for (const o of $("slice").options) { const sl = SPHEREX_SLICES.find((s) => String(s.slice) === o.value); if (sl) o.text = iLoc(sl.label); }
  if (state.selected) { renderCard(); if ($("tgFoot").checked) drawFootprints(); }
  if (setStage.last) setStage(...setStage.last);
  if (!$("blink").hidden && panelTitle) $("blinkTitle").textContent = typeof panelTitle === "function" ? panelTitle() : panelTitle;
  if (state.job && state.jobTick) state.jobTick();          // job progress / preview result bar
  const rb = $("resultBar");
  if (!rb.hidden && rb._fz && !rb.classList.contains("pending")) {
    const fz = rb._fz;
    rb.querySelector("small").textContent = fz.small();
  }
  onViewChange();
}

function openDialog(id) {
  const d = $(id);
  if (!d.open) d.showModal();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// For tests: window.__explore exposes state and a few actions.
window.__explore = { MAX_FOV, state, openCategory, select, flyTo, runSearch, surprise, setBackground, openBlink, closeBlink, startLocalJob, openLayers,
  spxGate,                                                        // SPHEREx as the sky map: shown once its tiles are in (tests)
  stopFlight: () => { flight++; state.al?.stopAnimation?.(); } };   // stopFlight: the opening demo (demo.js) ends a flight where it is
let PG = null;                                                    // js/bins_bar.js: time line of a wavelength-by-wavelength run
import("../js/bins_bar.js").then((m) => { PG = m; }).catch((e) => console.warn("bins_bar.js", e));
import("./finds.js").then((m) => m.initFinds({ state, select, openBlink, toast })).catch((e) => console.warn("Finds list unavailable", e));   // confirmed results of the local engine (finds.js)
