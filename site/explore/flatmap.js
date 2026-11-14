// 2D fallback sky: used when the 3D sky (Aladin Lite, WebGL2) cannot start.
// A pannable stereographic window seen from the centre of the celestial sphere (north up, east LEFT),
// never wider than MAX_FOV, drawn on a plain 2D canvas: drag to look around, wheel or pinch to zoom,
// tap to pick a spot. Shows the Milky Way plane, the ecliptic and our named places.

import { eclToEq, galToEq } from "./coords.js";

const R = Math.PI / 180;
export const MAX_FOV = 120;
const MIN_FOV = 0.5;

export function startFlatMap(host, { points, colors, onPick, onView, ra = 83.8, dec = -1, fov = 90 }) {
  host.innerHTML = "";
  host.classList.add("flat");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Sky map. Drag to look around, scroll or pinch to zoom, tap a spot to pick it.");
  host.appendChild(canvas);
  const note = document.createElement("p");
  note.className = "flat-note";
  note.textContent = "Simple sky mode: this device could not start the 3D sky. Drag, zoom and tap still work.";
  host.appendChild(note);
  const ctx = canvas.getContext("2d");
  const view = { ra, dec, fov: Math.min(MAX_FOV * Math.min(1, (host.clientWidth || 1) / Math.max(1, host.clientHeight || 1)), fov) };
  let sel = null, w = 0, h = 0, raf = 0;

  const ecl = Array.from({ length: 361 }, (_, i) => eclToEq(i, 0));
  const gal = Array.from({ length: 361 }, (_, i) => galToEq(i, 0));

  const scale = () => (w / 2) / (2 * Math.tan(view.fov * R / 4));   // px per stereographic unit

  // Stereographic projection about the view centre; east to the left as seen from inside.
  function project(ra, dec) {
    const d0 = view.dec * R, d = dec * R, da = (ra - view.ra) * R;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
    if (cosc < -0.3) return null;                                     // far behind the viewer
    const k = 2 / (1 + cosc), s = scale();
    const x = k * Math.cos(d) * Math.sin(da);
    const y = k * (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da));
    return [w / 2 - x * s, h / 2 - y * s];
  }

  function unproject(px, py) {
    const s = scale();
    const x = -(px - w / 2) / s, y = -(py - h / 2) / s;
    const rho = Math.hypot(x, y);
    if (rho < 1e-12) return { ra: view.ra, dec: view.dec };
    const c = 2 * Math.atan(rho / 2), d0 = view.dec * R;
    const dec = Math.asin(Math.cos(c) * Math.sin(d0) + y * Math.sin(c) * Math.cos(d0) / rho);
    const ra = view.ra * R + Math.atan2(x * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - y * Math.sin(d0) * Math.sin(c));
    return { ra: ((ra / R) % 360 + 360) % 360, dec: dec / R };
  }

  function line(list) {
    ctx.beginPath();
    let prev = null;
    for (const q of list) {
      const p = project(q.ra, q.dec);
      if (!p) { prev = null; continue; }
      if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > w) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      prev = p;
    }
    ctx.stroke();
  }

  function draw() {
    raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = host.clientWidth; h = host.clientHeight;
    if (w && h) view.fov = Math.min(view.fov, MAX_FOV * Math.min(1, w / h));   // layout may settle after start
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
    g.addColorStop(0, "#111c40"); g.addColorStop(1, "#05070d");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // RA/Dec grid, finer when zoomed in
    const step = view.fov > 60 ? 15 : view.fov > 20 ? 5 : view.fov > 6 ? 1 : 0.25;
    const n = Math.round(360 / step);
    ctx.strokeStyle = "rgba(160,180,230,.13)"; ctx.lineWidth = 1;
    for (let d = -90 + step; d < 90 - 1e-9; d += step) line(Array.from({ length: 721 }, (_, i) => ({ ra: i / 2, dec: d })));
    for (let i = 0; i < n; i++) line(Array.from({ length: 181 }, (_, j) => ({ ra: i * step, dec: -90 + j })));
    // Milky Way band and plane, ecliptic
    ctx.strokeStyle = "rgba(170,190,255,.16)"; ctx.lineWidth = Math.max(6, Math.min(80, scale() * 0.17)); line(gal);
    ctx.strokeStyle = "#9fc8ff"; ctx.lineWidth = 1.2; ctx.setLineDash([2, 5]); line(gal);
    ctx.strokeStyle = "#ffd36e"; ctx.setLineDash([6, 6]); line(ecl);
    ctx.setLineDash([]);
    // places
    ctx.font = "600 12px system-ui, sans-serif";
    for (const p of points) {
      const q = project(p.ra_2026 ?? p.ra, p.dec_2026 ?? p.dec);
      if (!q || q[0] < -20 || q[1] < -20 || q[0] > w + 20 || q[1] > h + 20) continue;
      const c = colors[p.cat] || "#fff";
      ctx.beginPath(); ctx.arc(q[0], q[1], p.challenge ? 6 : 4, 0, 2 * Math.PI);
      ctx.strokeStyle = c; ctx.lineWidth = p.challenge ? 2.2 : 1.6; ctx.stroke();
      if ((view.fov < 70 && w / view.fov > 8) || p.challenge) { ctx.fillStyle = c; ctx.fillText(p.name, q[0] + 9, q[1] + 4); }
    }
    if (sel) {
      const q = project(sel.ra, sel.dec);
      if (q) {
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(q[0], q[1], 14, 0, 2 * Math.PI); ctx.stroke();
        ctx.strokeStyle = "#7fd4ff";
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.beginPath(); ctx.moveTo(q[0] + dx * 18, q[1] + dy * 18); ctx.lineTo(q[0] + dx * 26, q[1] + dy * 26); ctx.stroke();
        }
      }
    }
    onView?.({ ...view });
  }
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };

  // Drag to look around, wheel / pinch to zoom, tap to pick.
  const ptrs = new Map();
  let downAt = null, moved = 0, pinch0 = null;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) { downAt = [e.clientX, e.clientY]; moved = 0; }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: view.fov }; }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const last = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2 && pinch0) {
      const [a, b] = [...ptrs.values()];
      zoomTo(pinch0.fov * pinch0.dist / Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])));
      moved += 10;
      return;
    }
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    moved += Math.abs(dx) + Math.abs(dy);
    const dpp = view.fov / w;                                         // degrees per pixel near the centre
    view.ra = ((view.ra + dx * dpp / Math.max(0.05, Math.cos(view.dec * R))) % 360 + 360) % 360;
    view.dec = Math.max(-89.9, Math.min(89.9, view.dec + dy * dpp));
    redraw();
  });
  const up = (e) => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch0 = null;
    if (ptrs.size === 0 && downAt && moved < 6) {
      const r = canvas.getBoundingClientRect();
      onPick(unproject(e.clientX - r.left, e.clientY - r.top));
    }
    if (ptrs.size === 0) downAt = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", (e) => { ptrs.delete(e.pointerId); downAt = null; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomTo(view.fov * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  addEventListener("resize", redraw);

  // fov is the width; keep the taller side within MAX_FOV too (portrait phones).
  const maxW = () => MAX_FOV * Math.min(1, (host.clientWidth || 1) / Math.max(1, host.clientHeight || 1));
  function zoomTo(f) { view.fov = Math.max(MIN_FOV, Math.min(maxW(), f)); redraw(); }
  draw();
  return {
    setSelection(pos) { sel = pos; redraw(); },
    goTo(ra, dec, fov) { view.ra = ra; view.dec = dec; if (fov) view.fov = Math.max(MIN_FOV, Math.min(maxW(), fov)); redraw(); },
    getView: () => ({ ...view }),
    // For tests: sky <-> canvas pixel (ICRS degrees, CSS pixels).
    toPixel: (ra, dec) => project(ra, dec),
    toSky: (px, py) => unproject(px, py),
  };
}
