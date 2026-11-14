// Flat all-sky map: the fallback when the 3D sky (Aladin Lite, WebGL2) cannot start.
// A Hammer-Aitoff map drawn on a 2D canvas with the Milky Way plane, the ecliptic and our named
// places. Tap anywhere to pick that spot; everything else on the page keeps working.

import { eclToEq, galToEq } from "./coords.js";

const R = Math.PI / 180;

// Hammer-Aitoff, RA increasing to the left (as on the sky), centred on RA 180°.
function project(ra, dec) {
  let l = ((180 - ra + 540) % 360) - 180;          // -180..180, east to the left
  const lr = l * R, b = dec * R;
  const z = Math.sqrt(1 + Math.cos(b) * Math.cos(lr / 2));
  return [2 * Math.SQRT2 * Math.cos(b) * Math.sin(lr / 2) / z, Math.SQRT2 * Math.sin(b) / z];
}

function unproject(x, y) {
  const z2 = 1 - (x / 4) ** 2 - (y / 2) ** 2;
  if (z2 < 0.5) return null;                        // outside the ellipse
  const z = Math.sqrt(z2);
  const l = 2 * Math.atan2(z * x, 2 * (2 * z2 - 1)) / R;
  const b = Math.asin(Math.max(-1, Math.min(1, z * y))) / R;
  return { ra: (180 - l + 360) % 360, dec: b };
}

export function startFlatMap(host, { points, colors, onPick }) {
  host.innerHTML = "";
  host.classList.add("flat");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Flat map of the whole sky. Tap a spot to pick it.");
  host.appendChild(canvas);
  const note = document.createElement("p");
  note.className = "flat-note";
  note.textContent = "Simple map mode: this device could not start the 3D sky. Tap the map or type a name or coordinates.";
  host.appendChild(note);
  const ctx = canvas.getContext("2d");
  let sel = null, geom = null;

  const ecl = Array.from({ length: 181 }, (_, i) => eclToEq(i * 2, 0));
  const gal = Array.from({ length: 181 }, (_, i) => galToEq(i * 2, 0));

  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = host.clientWidth, h = host.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 16, top = Math.min(150, h * 0.18);
    const s = Math.min((w - 2 * pad) / (4 * Math.SQRT2), (h - top - pad) / (2 * Math.SQRT2));
    const cx = w / 2, cy = top + (h - top - pad) / 2;
    geom = { s, cx, cy };
    const P = (ra, dec) => { const [x, y] = project(ra, dec); return [cx + x * s, cy - y * s]; };
    ctx.clearRect(0, 0, w, h);
    // sky ellipse
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, 2 * Math.SQRT2 * s, Math.SQRT2 * s, 0, 0, 2 * Math.PI);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 2 * Math.SQRT2 * s);
    g.addColorStop(0, "#14204a"); g.addColorStop(1, "#070b18");
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = "rgba(160,180,230,.35)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.clip();
    // grid
    ctx.strokeStyle = "rgba(160,180,230,.12)";
    for (let d = -60; d <= 60; d += 30) line(Array.from({ length: 73 }, (_, i) => ({ ra: i * 5, dec: d })), P);
    for (let r = 0; r < 360; r += 30) line(Array.from({ length: 37 }, (_, i) => ({ ra: r, dec: -90 + i * 5 })), P);
    // Milky Way band and ecliptic
    ctx.strokeStyle = "rgba(170,190,255,.35)"; ctx.lineWidth = 14; line(gal, P);
    ctx.strokeStyle = "#9fc8ff"; ctx.lineWidth = 1.2; ctx.setLineDash([2, 5]); line(gal, P);
    ctx.strokeStyle = "#ffd36e"; ctx.setLineDash([6, 6]); line(ecl, P);
    ctx.setLineDash([]);
    // places
    for (const p of points) {
      const [x, y] = P(p.ra_2026 ?? p.ra, p.dec_2026 ?? p.dec);
      ctx.beginPath(); ctx.arc(x, y, p.challenge ? 5 : 3.2, 0, 2 * Math.PI);
      ctx.fillStyle = colors[p.cat] || "#fff"; ctx.fill();
    }
    if (sel) {
      const [x, y] = P(sel.ra, sel.dec);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.restore();
  }

  function line(list, P) {
    ctx.beginPath();
    let prev = null;
    for (const q of list) {
      const [x, y] = P(q.ra, q.dec);
      if (prev && Math.abs(x - prev[0]) > geom.s) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prev = [x, y];
    }
    ctx.stroke();
  }

  canvas.addEventListener("click", (e) => {
    if (!geom) return;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left - geom.cx) / geom.s, y = -(e.clientY - r.top - geom.cy) / geom.s;
    const q = unproject(x, y);
    if (q) onPick(q);
  });
  addEventListener("resize", draw);
  draw();
  return { setSelection(pos) { sel = pos; draw(); } };
}
