// Prefetch the map tiles a zoom will end on, and pre-warm the next zoom level (all positions ICRS degrees).
// When you start a wheel zoom, a pinch or a flight, we already know the view it ends on: from the first wheel
// notch on, the tile queue (tilequeue.js) learns the field it ends at (so Aladin's tiles for the views in
// between wait), and that view's tiles are fetched first, nearest the cursor first. When Aladin asks for
// them they come from memory. Only maps that will show at that field are fetched (main.js gives their
// weights: DSS2, the SPHEREx layer, the Pan-STARRS close-up), at most MAX_TILES per map.
// When the view has been still for a moment, the middle of the next zoom level (PREWARM_ZOOM times closer,
// around the cursor) is fetched too, a few tiles per map, behind everything else: the next zoom step starts
// sharp in the middle. The SPHEREx map (IRSA, ~1.5 s per tile) and Pan-STARRS profit most.
//
// The same bookkeeping tells the close-up layer (closeup.js, ?cg=1 only) when its tiles are in.

import { ang2pixNest } from "../js/skyindex.js";
import { queueFetch, setTarget, setView, nextGeneration, busy, hasTile, NOW, SOON } from "./tilequeue.js";
import { surveyInfo, surveyUrl } from "./surveys.js";

const HPX0_ARCSEC = 211076;   // HEALPix pixel size at order 0: sqrt(pi/3) rad
const MAX_TILES = 40;
const PREWARM_TILES = 6;      // per map
const PREWARM_ZOOM = 2.5;
const PREWARM_MS = 400;       // still this long before pre-warming
const HIDDEN = 0.03;          // maps with less weight than this are not fetched (tilequeue.js: same rule)
const R = Math.PI / 180;

/**
 * Tile order Aladin Lite 3.8 loads for a view: the first HEALPix order whose pixels are no larger
 * than a screen pixel (device pixels), minus 9 for 512-pixel tiles, between 3 and the map's deepest
 * order. Checked against the tiles it requests at 30, 5, 1, 0.3 and 0.1 deg on a 1400 px sky.
 */
export function tileOrder(fovDeg, widthPx, maxOrder, dpr = 1) {
  const pxArcsec = fovDeg * 3600 / Math.max(1, widthPx * dpr);
  return Math.max(3, Math.min(maxOrder, Math.ceil(Math.log2(HPX0_ARCSEC / pxArcsec)) - 9));
}

/** Sky point at gnomonic offset (x east, y north, degrees) from (ra, dec): for views not on screen yet. */
function offsetSky(ra, dec, x, y) {
  const xi = -x * R, eta = y * R, d0 = dec * R;            // seen from inside: east is to the left
  const den = Math.cos(d0) - eta * Math.sin(d0);
  const a = Math.atan2(xi, den);
  const d = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den));
  return [((ra + a / R) % 360 + 360) % 360, d / R];
}

/**
 *   al       Aladin instance
 *   size     () -> [width, height] of the sky (CSS pixels)
 *   weights  (fovDeg, dec) -> { key: share 0-1 } of each map on screen at that field (main.js)
 *   base     () -> key of the background map
 *   frame    () -> cube frame shown of cube maps (SPHEREx tile names end in _<frame>)
 *   minFov   () -> closest zoom (deg)
 */
export function createPrefetch({ al, size, weights, base = () => "visible", frame = () => 0, minFov = () => 0 }) {
  const info = new Map();       // key -> Promise<{ base, ext, maxOrder, cube }>
  const known = new Map();      // key -> { base, ext, maxOrder, cube } once resolved
  const wanted = new Map();     // url -> "queued" | "done"
  let current = new Set();      // tiles of the view the latest zoom ends on (older queued ones are skipped)
  let warm = new Set();         // pre-warm tiles of the latest still view
  let run = 0, warmRun = 0;
  let pointer = null;           // last cursor position over the sky

  function layerInfo(key) {
    if (!info.has(key)) {
      const s = surveyInfo(key);
      const p = surveyUrl(key).then(async (b) => {
        let maxOrder = 9;
        try {
          const t = await (await fetch(b + "/properties", { mode: "cors", cache: "force-cache" })).text();
          const m = t.match(/^\s*hips_order\s*=\s*(\d+)/m);
          if (m) maxOrder = Number(m[1]);
        } catch { /* keep the default */ }
        const v = { base: b, ext: s.fmt === "png" ? "png" : "jpg", maxOrder, cube: !!s.cube };
        known.set(key, v);
        return v;
      });
      p.catch(() => info.delete(key));
      info.set(key, p);
    }
    return info.get(key);
  }
  const tileUrl = (li, order, pix) =>
    `${li.base}/Norder${order}/Dir${Math.floor(pix / 10000) * 10000}/Npix${pix}${li.cube ? "_" + frame() : ""}.${li.ext}`;
  const shown = (ws) => Object.keys(ws).filter((k) => ws[k] >= HIDDEN).sort((a, b) => ws[b] - ws[a]);

  // Sample points of a view: [ra, dec, distance from the anchor in px], from a screen-space mapper.
  function samples(map, w, h, ax, ay) {
    const pts = [];
    const nx = 14, ny = Math.max(6, Math.round(14 * h / w));
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
      const x = i / nx * w, y = j / ny * h;
      const q = map(x, y);
      if (q) pts.push([q[0], q[1], Math.hypot(x - ax, y - ay)]);
    }
    return pts;
  }

  // Tile orders of each map at field fov (for the queue: Aladin's tiles of other orders are in-between views).
  function orders(fov, ws) {
    const [w] = size();
    const dpr = window.devicePixelRatio || 1;
    const out = {};
    for (const k of Object.keys(ws)) {
      const li = known.get(k);
      if (li) out[k] = tileOrder(fov, w, li.maxOrder, dpr);
      else layerInfo(k).catch(() => {});
    }
    return out;
  }
  function announce(fov, dec, ms, burst = false) {
    const ws = weights(fov, dec);
    setTarget({ fov, orders: orders(fov, ws), weights: ws, base: base(), ms, burst });
    return ws;
  }

  // ws: { key: share } of the maps at that field. Rank = distance from the cursor, stretched for faint maps
  // (DSS2 at 4 % under SPHEREx): near the cursor the map that makes the picture comes first.
  async function fetchView(pts, fov, ws, cls = NOW, cap = MAX_TILES) {
    const id = cls === NOW ? ++run : ++warmRun;
    const [w] = size();
    const dpr = window.devicePixelRatio || 1;
    pts.sort((a, b) => a[2] - b[2]);                         // nearest the cursor first
    const list = [];
    for (const key of shown(ws)) {
      let li;
      try { li = await layerInfo(key); } catch { continue; }
      if (id !== (cls === NOW ? run : warmRun)) return;
      const order = tileOrder(fov, w, li.maxOrder, dpr);
      const stretch = 1 + 3 * (1 - Math.min(1, ws[key]));
      const seen = new Set();
      for (const [ra, dec, d] of pts) {
        const url = tileUrl(li, order, ang2pixNest(order, ra, dec));
        if (seen.has(url)) continue;
        if (seen.size >= cap) break;
        seen.add(url);
        list.push([url, d * stretch]);
      }
    }
    if (cls === NOW) current = new Set(list.map((x) => x[0]));
    else warm = new Set(list.map((x) => x[0]));
    nextGeneration();
    for (const [url, d] of list) {
      if (wanted.get(url) === "done") continue;
      wanted.set(url, "queued");
      const stale = cls === NOW ? () => !current.has(url) : () => !warm.has(url) && !current.has(url);
      queueFetch(url, { rank: (cls === NOW ? 0 : 1e4) + d, cls, stale }).then((ok) => {
        if (ok === null) wanted.delete(url);                  // skipped (a newer view took over): may be asked again
        else wanted.set(url, "done");
      });
    }
    if (wanted.size > 4000) for (const [u, s] of wanted) { if (s === "done") wanted.delete(u); if (wanted.size < 2000) break; }
  }

  // Wheel notches come in bursts: the queue learns the end field at once (each notch), the tiles of the
  // field the burst ends on are fetched a moment later (each notch's own field would cost requests that are
  // never shown). The zoom still glides for ~0.8 s after the last notch.
  let towardTimer = 0, towardArgs = null;
  function toward(fovTarget, x, y) {
    if (!(fovTarget > 0)) return;
    announce(fovTarget, al.getRaDec()[1], 1500, true);
    towardArgs = [fovTarget, x, y];
    clearTimeout(towardTimer);
    towardTimer = setTimeout(() => { towardTimer = 0; towardNow(...towardArgs); }, 90);
  }

  /** A zoom toward pixel (x, y) that will end at field fovTarget (wheel, pinch, keys). */
  function towardNow(fovTarget, x, y) {
    const [w, h] = size();
    const f0 = al.getFov()[0];
    if (!(fovTarget > 0) || !w) return;
    const s = fovTarget / f0;                               // the final view, in today's screen pixels
    const map = (px, py) => { try { const q = al.pix2world(x + (px - x) * s, y + (py - y) * s); return q && Number.isFinite(q[0]) ? q : null; } catch { return null; } };
    const dec = al.getRaDec()[1];
    fetchView(samples(map, w, h, x, y), fovTarget, weights(fovTarget, dec));
  }

  /** A flight or jump that will end centred on (ra, dec) with field fov, in about ms milliseconds. */
  function view(ra, dec, fov, ms = 3000) {
    const [w, h] = size();
    if (!w) return;
    announce(fov, dec, ms + 500);
    const k = fov / w;                                      // degrees per pixel (small fields)
    const map = (px, py) => offsetSky(ra, dec, (px - w / 2) * k, (h / 2 - py) * k);
    fetchView(samples(map, w, h, w / 2, h / 2), fov, weights(fov, dec));
  }

  // Pre-warm: the middle of the next zoom level around the cursor (or the centre), once the view is still.
  let warmTimer = 0, lastWarm = "";
  function prewarm() {
    warmTimer = 0;
    if (busy()) { warmTimer = setTimeout(prewarm, 300); return; }
    const [w, h] = size();
    if (!w) return;
    const fov = al.getFov()[0];
    const next = Math.max(minFov(), fov / PREWARM_ZOOM);
    if (!(next < fov * 0.95)) return;                       // already at the closest zoom
    const p = pointer && performance.now() - pointer.t < 10000 ? pointer : { x: w / 2, y: h / 2 };
    const [ra0, dec0] = al.getRaDec();
    const sig = `${ra0.toFixed(4)} ${dec0.toFixed(4)} ${fov.toPrecision(4)} ${Math.round(p.x / 40)} ${Math.round(p.y / 40)}`;
    if (sig === lastWarm) return;
    lastWarm = sig;
    const s = next / fov;
    const map = (px, py) => { try { const q = al.pix2world(p.x + (px - p.x) * s, p.y + (py - p.y) * s); return q && Number.isFinite(q[0]) ? q : null; } catch { return null; } };
    fetchView(samples(map, w, h, p.x, p.y), next, weights(next, dec0), SOON, PREWARM_TILES);
  }

  /** Call on every view change: the queue learns what is on screen; pre-warm once it is still. */
  function viewChanged(ra, dec, fov) {
    setView({ fov, weights: weights(fov, dec), base: base() });
    clearTimeout(warmTimer);
    warmTimer = setTimeout(prewarm, PREWARM_MS);
  }

  const box = al.aladinDiv || document.getElementById("sky");
  box?.addEventListener("pointermove", (e) => {
    const r = box.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  }, { passive: true });
  // Learn the deepest order of the maps that show while zooming in (one small cached file each).
  setTimeout(() => { for (const k of [base(), "spherex", "panstarrs"]) layerInfo(k).catch(() => {}); }, 1500);

  /** Share (0-1) of the tiles of map `key` for the view on screen that are in the cache; starts the missing ones. */
  function progress(key) {
    const li = known.get(key);
    if (!li) { layerInfo(key).catch(() => {}); return 0; }
    const [w, h] = size();
    const fov = al.getFov()[0];
    const order = tileOrder(fov, w, li.maxOrder, window.devicePixelRatio || 1);
    const map = (px, py) => { try { const q = al.pix2world(px, py); return q && Number.isFinite(q[0]) ? q : null; } catch { return null; } };
    const urls = new Set();
    for (const [ra, dec] of samples(map, w, h, w / 2, h / 2).sort((a, b) => a[2] - b[2])) {
      urls.add(tileUrl(li, order, ang2pixNest(order, ra, dec)));
      if (urls.size >= MAX_TILES) break;
    }
    let done = 0;
    for (const u of urls) {
      const st = wanted.get(u);
      if (st === "done") { done++; continue; }
      if (st) continue;
      wanted.set(u, "queued");
      queueFetch(u).then((ok) => { if (ok === null) wanted.delete(u); else wanted.set(u, "done"); });
    }
    return urls.size ? done / urls.size : 1;
  }

  /**
   * Share (0-1) of the view on screen that Aladin can paint from tiles of map `key` it has received: at each sample
   * point a tile of the order it draws now or a coarser one (it stands in while the finer one loads). Where it has
   * none, Aladin paints a flat grey patch (the SPHEREx map, main.js). null when this cannot be known (?tq=0, map not
   * resolved yet).
   */
  function coverage(key) {
    const li = known.get(key);
    if (!li) { layerInfo(key).catch(() => {}); return null; }
    const [w, h] = size();
    if (!w || !h) return null;
    const fov = al.getFov()[0];
    const pxArcsec = fov * 3600 / Math.max(1, w * (window.devicePixelRatio || 1));
    const top = Math.max(0, Math.min(li.maxOrder, Math.ceil(Math.log2(HPX0_ARCSEC / pxArcsec)) - 9));   // as drawn now (no floor at 3)
    const tail = (li.cube ? "_" + frame() : "") + "." + li.ext;
    const map = (px, py) => { try { const q = al.pix2world(px, py); return q && Number.isFinite(q[0]) ? q : null; } catch { return null; } };
    let n = 0, ok = 0;
    for (const [ra, dec] of samples(map, w, h, w / 2, h / 2)) {
      n++;
      for (let o = top; o >= 0; o--) {
        const has = hasTile(key, o, ang2pixNest(o, ra, dec), tail);
        if (has === null) return null;
        if (has) { ok++; break; }
      }
    }
    return n ? ok / n : null;
  }

  return { toward, view, viewChanged, progress, coverage, tileOrder };
}
