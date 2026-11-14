// Close-up helpers for the sky explorer (all positions ICRS degrees):
//  - the sharp close-up map (Pan-STARRS DR1, or DSS2 colour in the far south) that takes over when you
//    zoom in past CLOSEUP_FOV, so the sky does not turn into big blocky SPHEREx pixels;
//  - a scale bar, with the size of one SPHEREx pixel (6.15") drawn to scale when it is big enough;
//  - which map is on screen and when it was taken: fast-moving stars appear where they were then,
//    while our markers stay at their 2026 positions.
// Real data only: every map is shown at its own resolution. Nothing is sharpened, and the SPHEREx map is
// not interpolated (tried: bilinear filtering changes its colours and fills its blank pixels).

import { CLOSEUP_FOV, SPHEREX_PIXEL_ARCSEC, SPHEREX_MAP_PIXEL_ARCSEC, closeupKeyAt, surveyInfo, surveyUrl, minFov } from "./surveys.js";
import { separation, nowYear } from "./coords.js";
import { t as T, loc as iLoc, field as iField, tname as iName } from "../js/i18n.js";

const $ = (id) => document.getElementById(id);
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
// Scale bar lengths to choose from (arcsec).
const NICE = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000, 72000];
const BAR_MAX_PX = 110;

/** 0 above CLOSEUP_FOV[0], 1 below CLOSEUP_FOV[1], smooth in between. */
export function closeupRamp(fov) {
  const [a, b] = CLOSEUP_FOV;
  return smooth((a - fov) / (a - b));
}

/** Angle in arcsec -> short text (10.4″, 2.4′, 1°). */
export function formatArcsec(v) {
  if (v < 59.5) return `${v < 19.95 ? +v.toFixed(1) : Math.round(v)}″`;
  if (v < 3570) return `${v < 597 ? +(v / 60).toFixed(1) : Math.round(v / 60)}′`;
  return `${+(v / 3600).toFixed(v < 35700 ? 1 : 0)}°`;
}

/**
 * Close-up manager.
 *   A, al        Aladin namespace and instance (null in the flat 2D fallback: then only the scale bar)
 *   state        the explorer state (reads bg and selected)
 *   pix2sky      (x, y) CSS pixels in #sky -> { ra, dec } or null
 *   size         () -> [width, height] of #sky in CSS pixels
 *   onChange     called when a setting or the close-up layer changes (redraw / recompute opacities)
 *   onLimits     called when the closest allowed zoom changes (moving between Pan-STARRS and DSS2 sky)
 */
export function createCloseup({ A = null, al = null, state, pix2sky, size, onChange, onLimits }) {
  const ui = {
    root: $("scale"), bar: $("scaleBar"), lbl: $("scaleLbl"), pxRow: $("scalePx"), box: $("scaleBox"),
    img: $("scaleImg"), move: $("scaleMove"), on: $("tgSharp"), mix: $("sharpMix"), mixOut: $("sharpMixOut"),
  };
  let layer = null;            // { key, hips } : the close-up overlay currently in Aladin
  let busy = false;
  let sharpOp = 0;             // its opacity right now
  let view = null;
  let limitKey = null;         // sharpest map at the view centre, which sets the closest zoom
  const failed = new Set();    // close-up maps whose servers did not answer
  let prefetch = null;         // prefetch.js: says when the close-up tiles of the view are in the cache
  let lastT = 0, heldSince = 0, tick = 0;
  const FADE_MS = 100;         // fastest fade in or out of the close-up map (was 250: it held back the sharp frame)
  // Holding the close-up back until its tiles arrive measured slower to sharp (Pan-STARRS 0.3 deg 4.0 -> 5.4 s),
  // so it is off by default; ?cg=1 turns it on (max 4 s hold).
  const WAIT_MAX_MS = new URLSearchParams(location.search).get("cg") === "1" ? 4000 : 0;

  const enabled = () => !!al && (ui.on ? ui.on.checked : true);
  const mix = () => (ui.mix ? Number(ui.mix.value) / 100 : 0);
  const keyAt = (dec, fov) => {
    const k = closeupKeyAt(dec, fov);
    return failed.has(k) ? "visible" : k;
  };

  // What the close-up layer should be and how opaque, for the current view and settings.
  function wanted(dec, fov) {
    if (!enabled()) return { key: null, op: 0, could: false };
    const key = keyAt(dec, fov);
    if (state.bg === "visible") {
      // Default map: the sharp map takes over. Far south the DSS2 background already is the sharpest.
      const could = key !== "visible";
      return { key: could ? key : null, op: could ? closeupRamp(fov) : 0, could };
    }
    // A map the person picked (Near-IR, WISE, SPHEREx) stays; the sharp map only shows through it on request.
    const m = mix();
    return { key: m > 0 ? key : null, op: m > 0 ? closeupRamp(fov) * m : 0, could: m > 0 };
  }

  async function ensure(key) {
    if (busy || !al) return;
    busy = true;
    try {
      const url = await surveyUrl(key);
      const s = surveyInfo(key);
      const h = A.imageHiPS(url, { name: `${s.title} (close-up)`, imgFormat: s.fmt });
      al.setOverlayImageLayer(h, "closeup");
      try { h.setOpacity(0); } catch { /* applied on the next update */ }
      layer = { key, hips: h };
    } catch (e) {
      console.warn("Close-up map unavailable", key, e);
      if (key !== "visible") failed.add(key);
    } finally { busy = false; }
    if (failed.has(key)) { limitKey = null; onLimits?.(); }
    onChange?.();
  }

  function drop() {
    if (!layer || !al) return;
    try { al.removeImageLayer("closeup"); } catch (e) { console.warn(e); }
    layer = null; sharpOp = 0;
  }

  /** Call on every view change, before computing the SPHEREx fade. */
  function update(ra, dec, fov) {
    view = { ra, dec, fov };
    const lk = keyAt(dec, 0);
    if (lk !== limitKey) { limitKey = lk; onLimits?.(); }
    if (!al) return;
    const w = wanted(dec, fov);
    // Add it once it starts to show (Aladin loads tiles even for an invisible layer, which made panning
    // stutter at 0.5 deg), drop it a bit after it has faded out (hysteresis against churn).
    const need = w.key && (w.op > 0 || (layer && w.could && fov < CLOSEUP_FOV[0] * 1.4));
    if (need && layer?.key !== w.key) ensure(w.key);
    else if (!need && layer) drop();
    let target = layer && layer.key === w.key ? w.op : 0;
    const now = performance.now();
    const dt = lastT ? Math.min(100, now - lastT) : 16;
    lastT = now;
    // Keep the map you see (DSS2) until the sharp tiles of this view have arrived, instead of fading in a
    // blurry placeholder; then fade in quickly. Only for its first appearance, not while you pan or zoom on.
    if (target > 0 && sharpOp === 0 && prefetch && layer) {
      heldSince ||= now;
      if (now - heldSince < WAIT_MAX_MS && prefetch.progress(layer.key) < 0.98) target = 0;
      else heldSince = 0;
    } else heldSince = 0;
    if (target !== sharpOp) {
      const step = dt / FADE_MS;
      sharpOp = Math.abs(target - sharpOp) <= step ? target : sharpOp + Math.sign(target - sharpOp) * step;
    }
    if (layer) { try { layer.hips.setOpacity(sharpOp); } catch { /* not ready yet */ } }
    // Still fading or waiting for tiles: look again shortly.
    if (layer && (sharpOp !== target || heldSince) && !tick) {
      tick = setTimeout(() => { tick = 0; lastT = performance.now() - 16; onChange?.(); }, sharpOp !== target ? 16 : 100);
    }
  }

  /** Factor for the automatic SPHEREx fade: it gives way to the sharp map at close zoom. */
  function spherexFactor(fov) {
    return enabled() ? 1 - closeupRamp(fov) : 1;
  }

  // Layers on screen with their visible weight (bottom to top: background, SPHEREx fade, close-up).
  function onScreen(spxOp) {
    const out = [];
    const wSharp = layer ? sharpOp : 0;
    const wSpx = spxOp * (1 - wSharp);
    const wBase = (1 - spxOp) * (1 - wSharp);
    out.push({ key: state.bg, w: wBase });
    if (wSpx > 0) out.push({ key: "spherex", w: wSpx });
    if (wSharp > 0) out.push({ key: layer.key, w: wSharp });
    const merged = new Map();
    for (const l of out) merged.set(l.key, (merged.get(l.key) || 0) + l.w);
    return [...merged].map(([key, w]) => ({ key, w })).filter((l) => l.w >= 0.2).sort((a, b) => b.w - a.w);
  }

  /** Redraw the scale bar, the map/date line and the fast-mover note. spxOp: automatic SPHEREx opacity. */
  function render(spxOp = 0) {
    if (!ui.root || !view) return;
    const [w, h] = size();
    if (!w || !h) return;
    const d = 40;
    const p1 = pix2sky(w / 2 - d, h / 2), p2 = pix2sky(w / 2 + d, h / 2);
    if (!p1 || !p2) return;
    const asPerPx = separation(p1.ra, p1.dec, p2.ra, p2.dec) * 3600 / (2 * d);
    if (!(asPerPx > 0)) return;
    let len = NICE[0];
    for (const n of NICE) if (n / asPerPx <= BAR_MAX_PX) len = n;
    ui.bar.style.width = `${(len / asPerPx).toFixed(1)}px`;
    ui.lbl.textContent = iLoc(formatArcsec(len)) + (len === 1800 ? T("ex.cu.moon1") : len === 3600 ? T("ex.cu.moon2") : "");   // Moon ~30′ across
    const box = SPHEREX_PIXEL_ARCSEC / asPerPx;
    ui.pxRow.hidden = box < 3;
    if (box >= 3) { ui.box.style.width = ui.box.style.height = `${box.toFixed(1)}px`; }

    if (!al) { ui.img.hidden = true; ui.move.hidden = true; return; }
    const layers = onScreen(spxOp);
    const main = layers[0] ? surveyInfo(layers[0].key) : surveyInfo(state.bg);
    ui.img.hidden = false;
    const txt = layers.map((l) => { const s = surveyInfo(l.key); return `${T("ex.cu.short." + l.key, null, s.short)} (${s.years})`; });
    const spxShown = layers.some((l) => l.key === "spherex");
    ui.img.textContent = T("ex.cu.image", { maps: txt.join(" + ") }) + (spxShown ? T("ex.cu.mapPx", { px: iLoc(SPHEREX_MAP_PIXEL_ARCSEC) }) : "");

    // Fast movers: the background image is from another year than our (2026) marker.
    const p = state.selected;
    let note = "";
    if (p?.pos && (p.pmra || p.pmdec)) {
      const pm = Math.hypot(p.pmra || 0, p.pmdec || 0) / 1000;                  // arcsec per year
      const markerYear = p.pmEpoch ?? (p.ra_2026 != null ? 2026 : nowYear());
      const off = pm * Math.abs(markerYear - main.epoch);
      const near = separation(view.ra, view.dec, p.pos.ra, p.pos.dec) < view.fov;
      if (near && off > Math.max(2, 3 * asPerPx)) {
        note = T("ex.cu.note", { name: p.nameKey ? T(p.nameKey) : iName(iField(p, "name")), pm: iLoc(formatArcsec(pm)), map: T("ex.cu.short." + (layers[0] ? layers[0].key : state.bg), null, main.short), years: main.years,
          off: iLoc(formatArcsec(off)), year: Math.floor(markerYear) });
      }
    }
    ui.move.hidden = !note;
    ui.move.textContent = note;
  }

  /** Credit for the close-up map when it is on screen (for the credits line), else "". */
  function credit() {
    return layer && sharpOp > 0.05 ? surveyInfo(layer.key).credit : "";
  }

  // Layers popover controls.
  ui.on?.addEventListener("change", () => onChange?.());
  ui.mix?.addEventListener("input", () => {
    if (ui.mixOut) ui.mixOut.textContent = `${ui.mix.value}%`;
    onChange?.();
  });
  // Find a working Pan-STARRS server early (one small file), so the first close-up does not wait for it.
  if (al) setTimeout(() => surveyUrl("panstarrs").catch(() => { /* ensure() reports it */ }), 3000);

  // A new pick (or closing it) changes the fast-mover note: the selection card re-renders then.
  const card = $("card");
  if (card && onChange) new MutationObserver(() => onChange()).observe(card, { attributes: true, attributeFilter: ["hidden"], subtree: true, childList: true, characterData: true });
  if (ui.root) ui.root.hidden = false;

  /** Closest allowed zoom (field width, degrees) at the current view. */
  function closest() {
    return minFov(size()[0] || innerWidth, keyAt(view ? view.dec : 90, 0));
  }

  /** Map key the close-up will show at field fov near dec (for prefetching), or null. */
  function keyFor(fov, dec) {
    const w = wanted(dec, fov);
    return w.op > 0 ? w.key : null;
  }

  /** Close-up map and its opacity at field fov near dec: { key, op } (key null when none shows). */
  function weightFor(fov, dec) {
    const w = wanted(dec, fov);
    return w.op > 0 && w.key ? { key: w.key, op: w.op } : { key: null, op: 0 };
  }

  return {
    update, spherexFactor, render, credit, minFov: closest, keyFor, weightFor,
    setPrefetch: (p) => { prefetch = p; },
    // For tests and the measurement script.
    info: () => ({ key: layer?.key || null, opacity: sharpOp, failed: [...failed] }),
  };
}
