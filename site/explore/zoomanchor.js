// Zoom toward the cursor for the sky explorer (all positions ICRS degrees, pixels are CSS pixels).
// Rule: when you zoom with the mouse wheel, a trackpad pinch (ctrl + wheel) or two fingers, the sky point
// under the cursor (or under the midpoint between the fingers) stays under it; only the +/- buttons and
// keys zoom about the centre. Used by the 3D sky (Aladin Lite v3) and the flat 2D fallback (flatmap.js).
//
// How: take the sky point under the cursor, change the field, then move the view centre until that same
// sky point is back on the same pixel. Moving the centre to the sky point at pixel (centre + error) shifts
// everything by -error near the centre; the projection is not uniform across the screen, so this is
// repeated (it converges to well under 0.01 px in two or three rounds). Plain float64 throughout.

const WHEEL_RATE = 0.002;      // field factor exp(0.002 * deltaY px): Aladin's own wheel rate, kept as it was
const SMOOTH = 0.2;            // part of the remaining wheel zoom applied per 60 Hz frame (Aladin's value)
const TOL_PX = 0.01;

/** Wheel delta in pixels (lines and pages converted the way Aladin does). */
export function wheelDelta(e) {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  return (e.deltaY && e.deltaY * k) || e.detail || -(e.wheelDelta || 0) || 0;
}

/**
 * Move the view so that the sky point (ra, dec) is on pixel (x, y). view: { toPixel(ra, dec) -> [x, y] | null,
 * toSky(x, y) -> [ra, dec] | null, centre() -> [ra, dec], setCentre(ra, dec) }. Returns the error left (px).
 */
export function pinSky(view, ra, dec, x, y, rounds = 4) {
  let err = Infinity;
  for (let i = 0; i <= rounds; i++) {
    const p = view.toPixel(ra, dec);
    if (!p) return err;
    const ex = p[0] - x, ey = p[1] - y;
    err = Math.hypot(ex, ey);
    if (err < TOL_PX || i === rounds) return err;
    const c = view.toPixel(...view.centre());
    const n = c && view.toSky(c[0] + ex, c[1] + ey);
    if (!n) return err;
    view.setCentre(n[0], n[1]);
  }
  return err;
}

/** Midpoint of the first two touches, relative to the element's box. */
function touchMid(e, box) {
  const r = box.getBoundingClientRect(), a = e.touches[0], b = e.touches[1];
  return [(a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top];
}

/**
 * Aladin Lite v3: wheel and two-finger pinch zoom toward the cursor / finger midpoint.
 *   al       the Aladin instance (its #sky div gets the listeners)
 *   limits   () -> [smallest, largest] field width (deg); the zoom stops there
 * The wheel replaces Aladin's own wheel zoom (its documented "wheelTriggered" callback), with the same rate
 * and the same smoothing. The pinch is still done by Aladin (zoom and finger rotation); right after each
 * finger move the view is shifted back so the midpoint keeps its sky point.
 */
export function anchorAladinZoom(al, { limits }) {
  const box = al.aladinDiv || document.getElementById("sky");
  const view = {
    toPixel: (ra, dec) => { try { const p = al.world2pix(ra, dec); return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null; } catch { return null; } },
    toSky: (x, y) => { try { const q = al.pix2world(x, y); return q && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null; } catch { return null; } },
    centre: () => al.getRaDec(),
    setCentre: (ra, dec) => al.gotoRaDec(ra, dec),
  };

  // ---- wheel / trackpad pinch: smoothed like Aladin's, anchored at the cursor ----
  let pending = 0;             // wheel zoom still to apply (px of deltaY)
  let anchor = null;           // { x, y, ra, dec }: this sky point stays on this pixel
  let left = null;             // the view as we left it (to notice a drag or an animation in between)
  let raf = 0, last = 0;

  const stop = () => { pending = 0; anchor = null; if (raf) cancelAnimationFrame(raf); raf = 0; };
  const grab = (x, y) => { const q = view.toSky(x, y); return q ? { x, y, ra: q[0], dec: q[1] } : null; };
  const snapshot = () => { const c = al.getRaDec(); return [c[0], c[1], al.getFov()[0]]; };
  const movedSince = (s) => { if (!s) return true; const n = snapshot(); return n.some((v, i) => Math.abs(v - s[i]) > 1e-12 * Math.max(1, Math.abs(v))); };

  function step(t) {
    raf = 0;
    const dt = last ? Math.max(1, Math.min(100, t - last)) : 1000 / 60; last = t;   // first frame: a full frame's share
    if (anchor && movedSince(left)) anchor = grab(anchor.x, anchor.y);   // someone else moved the view: re-take the point
    const part = Math.abs(pending) < 0.05 ? pending : pending * (1 - Math.pow(1 - SMOOTH, dt / (1000 / 60)));
    pending -= part;
    const [lo, hi] = limits();
    const f0 = al.getFov()[0];
    const want = Math.max(lo, Math.min(hi, f0 * Math.exp(WHEEL_RATE * part)));
    if (want !== f0) al.setFoV(want);
    const got = al.getFov()[0];
    if (Math.abs(got - f0 * Math.exp(WHEEL_RATE * part)) > 1e-9 * got) pending = 0;   // reached a limit
    if (anchor && got !== f0) pinSky(view, anchor.ra, anchor.dec, anchor.x, anchor.y);
    left = snapshot();
    if (pending) raf = requestAnimationFrame(step);
    else anchor = null;
  }

  al.on("wheelTriggered", (e) => {
    const d = wheelDelta(e);
    if (!d) return;
    const r = box.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    // Same cursor pixel and nothing else moved the view: keep the point we already hold (no rounding creep).
    if (!anchor || Math.abs(anchor.x - x) > 0.5 || Math.abs(anchor.y - y) > 0.5 || movedSince(left)) anchor = grab(x, y);
    left = snapshot();
    pending += d;
    if (!raf) { last = 0; raf = requestAnimationFrame(step); }
  });
  // Grabbing the sky ends a wheel zoom that is still gliding.
  box.addEventListener("pointerdown", stop, { capture: true, passive: true });

  // ---- two-finger pinch: Aladin zooms about the centre, we put the midpoint's sky point back ----
  let mid = null;              // midpoint (px) after the last finger move
  let held = null;             // sky point under that midpoint, taken just before Aladin handles the move
  box.addEventListener("touchstart", (e) => {
    if (e.touches.length >= 2) { stop(); mid = touchMid(e, box); held = null; }
  }, { capture: true, passive: true });
  box.addEventListener("touchmove", (e) => {                         // capture: runs before Aladin's handler
    held = e.touches.length >= 2 && mid ? view.toSky(mid[0], mid[1]) : null;
  }, { capture: true, passive: true });
  box.addEventListener("touchmove", (e) => {                         // bubble: runs after Aladin's zoom / turn
    if (e.touches.length < 2 || !mid) return;
    const m = touchMid(e, box);
    if (held) pinSky(view, held[0], held[1], m[0], m[1]);
    mid = m;
  }, { passive: true });
  const end = (e) => { if (e.touches.length < 2) { mid = null; held = null; } };
  box.addEventListener("touchend", end, { capture: true, passive: true });
  box.addEventListener("touchcancel", end, { capture: true, passive: true });

  return { stop, busy: () => !!raf, pin: (ra, dec, x, y) => pinSky(view, ra, dec, x, y) };
}
