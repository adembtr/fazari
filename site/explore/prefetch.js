// Prefetch the map tiles a zoom will end on, before Aladin asks for them (all positions ICRS degrees).
// When you start a wheel zoom, a pinch or a flight, we already know the view it ends on, so we start
// downloading that view's tiles (nearest the cursor first) through the tile queue (tilequeue.js). When
// Aladin asks for them at the end of the zoom they come from the browser cache. Only the tiles of the
// view you are going to see are fetched (at most MAX_TILES per map), never a whole region.
//
// The same bookkeeping tells the close-up layer (closeup.js) when its tiles are in, so it can wait
// with fading in instead of showing a blurry placeholder.

import { ang2pixNest } from "../js/skyindex.js";
import { queueFetch } from "./tilequeue.js";
import { surveyInfo, surveyUrl } from "./surveys.js";

const HPX0_ARCSEC = 211076;   // HEALPix pixel size at order 0: sqrt(pi/3) rad
const MAX_TILES = 40;
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

function tileUrl(base, ext, order, pix) {
  return `${base}/Norder${order}/Dir${Math.floor(pix / 10000) * 10000}/Npix${pix}.${ext}`;
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
 *   layers   (fovDeg, dec) -> survey keys that will be on screen at that field (e.g. ["visible", "panstarrs"])
 */
export function createPrefetch({ al, size, layers }) {
  const info = new Map();       // key -> Promise<{ base, ext, maxOrder }>
  const known = new Map();      // key -> { base, ext, maxOrder } once resolved
  const wanted = new Map();     // url -> "queued" | "done"
  let current = new Set();      // tiles of the view the latest zoom ends on (older queued ones are skipped)
  let run = 0;

  function layerInfo(key) {
    if (!info.has(key)) {
      const s = surveyInfo(key);
      const p = surveyUrl(key).then(async (base) => {
        let maxOrder = 9;
        try {
          const t = await (await fetch(base + "/properties", { mode: "cors", cache: "force-cache" })).text();
          const m = t.match(/^\s*hips_order\s*=\s*(\d+)/m);
          if (m) maxOrder = Number(m[1]);
        } catch { /* keep the default */ }
        const v = { base, ext: s.fmt === "png" ? "png" : "jpg", maxOrder };
        known.set(key, v);
        return v;
      });
      p.catch(() => info.delete(key));
      info.set(key, p);
    }
    return info.get(key);
  }

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

  async function fetchView(pts, fov, keys) {
    const id = ++run;
    const [w] = size();
    const dpr = window.devicePixelRatio || 1;
    pts.sort((a, b) => a[2] - b[2]);                         // nearest the cursor first
    const list = [];
    for (const key of keys) {
      let li;
      try { li = await layerInfo(key); } catch { continue; }
      if (id !== run) return;
      const order = tileOrder(fov, w, li.maxOrder, dpr);
      const seen = new Set();
      for (const [ra, dec] of pts) {
        const url = tileUrl(li.base, li.ext, order, ang2pixNest(order, ra, dec));
        if (seen.has(url)) continue;
        seen.add(url);
        if (seen.size > MAX_TILES) break;
        list.push(url);
      }
    }
    current = new Set(list);
    for (const url of list) {
      if (wanted.has(url)) continue;
      wanted.set(url, "queued");
      queueFetch(url, { stale: () => !current.has(url) }).then((ok) => {
        if (ok === null) wanted.delete(url);                  // skipped (a newer zoom took over): may be asked again
        else wanted.set(url, "done");
      });
    }
    if (wanted.size > 4000) for (const [u, s] of wanted) { if (s === "done") wanted.delete(u); if (wanted.size < 2000) break; }
  }

  // Wheel notches come in bursts; only the field the burst ends on is worth fetching (each notch's own
  // in-between field would cost requests that are never shown). The zoom still runs for ~1 s after that.
  let towardTimer = 0, towardArgs = null;
  function toward(fovTarget, x, y) {
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
    const [ra, dec] = al.getRaDec();
    fetchView(samples(map, w, h, x, y), fovTarget, layers(fovTarget, dec));
  }

  /** A flight or jump that will end centred on (ra, dec) with field fov. */
  function view(ra, dec, fov) {
    const [w, h] = size();
    if (!w) return;
    const k = fov / w;                                      // degrees per pixel (small fields)
    const map = (px, py) => offsetSky(ra, dec, (px - w / 2) * k, (h / 2 - py) * k);
    fetchView(samples(map, w, h, w / 2, h / 2), fov, layers(fov, dec));
  }

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
      urls.add(tileUrl(li.base, li.ext, order, ang2pixNest(order, ra, dec)));
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

  return { toward, view, progress, tileOrder };
}
