// Field square on the explorer's sky (explore.html): the patch of sky a result covers around the picked
// point, drawn on the Aladin sphere above every map (SPHEREx, visible light, the close-ups) at every zoom.
//   Field square (cyan, solid): the width chosen in the place card's Field selector (fov_ui.js, 0.15-0.6°),
//     north up, centred on the picked point. It follows the selector at once ("fazari:fov").
//   Prepared blink square (gold, dashed): for the 5 site targets, the field of their ready result in
//     data/<target>/ (meta.json grid, north-up TAN: 180 px x 3″ = 0.15°). When it is the same square as the
//     field, only one is drawn and its label says so.
// Both go when the card closes or another point is picked. Thin lines with a dark edge, never a fill, so the
// star in the middle stays clear; a small label at a corner once the square is big enough on screen
// ("Downloaded area · 0.3°"), and then "Measured point" beside the crosshair of the picked point.
// Separate from candidates.js, whose pink dashed "Finder field" outline belongs to a result opened in the
// blink panel (it is drawn only for results with candidates.json).
//   initFieldSquare({ state, hooks }) -> { update(), info() }     state.A / state.al: Aladin namespace and view
import { t as T, num as iNum, onLang } from "../js/i18n.js";

const CYAN = "#7fd4ff", GOLD = "#ffc94d", EDGE = "rgba(4,6,12,.62)";
const LABEL_MIN_PX = 64;          // the square's side on screen from which its label is drawn
const SAME_DEG = 0.004;           // two squares closer than this in width and centre are one square
const DEG = Math.PI / 180;

/** Corners [ra, dec] of a north-up square of width w and height h (deg) around ra0/dec0 (TAN projection),
 *  in the order NE, NW, SW, SE (east is left on the sky as seen, so NE is the top-left corner). */
export function squareCorners(ra0, dec0, w, h = w) {
  const hx = Math.tan(w / 2 * DEG), hy = Math.tan(h / 2 * DEG);
  const a0 = ra0 * DEG, d0 = dec0 * DEG;
  const toSky = (xi, eta) => {                     // gnomonic inverse; xi to the east, eta to the north
    const den = Math.cos(d0) - eta * Math.sin(d0);
    const ra = a0 + Math.atan2(xi, den);
    const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den));
    return [((ra / DEG) % 360 + 360) % 360, dec / DEG];
  };
  return [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]].map(([x, y]) => toSky(x, y));
}

const readyCache = new Map();      // gallery folder -> Promise<{ ra, dec, w, h } | null>
function readyField(gallery) {
  if (!readyCache.has(gallery)) {
    readyCache.set(gallery, fetch(gallery + "meta.json").then((r) => (r.ok ? r.json() : null)).then((m) => {
      const g = (m && m.grid) || {};
      const [ny, nx] = g.size_px || [];
      if (!m || !Number.isFinite(+m.ra) || !Number.isFinite(+m.dec) || !(g.pixel_arcsec > 0) || !(nx > 0) || !(ny > 0)) return null;
      return { ra: +m.ra, dec: +m.dec, w: nx * g.pixel_arcsec / 3600, h: ny * g.pixel_arcsec / 3600 };
    }).catch(() => null));
  }
  return readyCache.get(gallery);
}

const fmt = (v) => iNum(+(+v).toFixed(2));        // 0.3 -> "0.3" / "0,3", 0.15 -> "0.15"

export function initFieldSquare({ state, hooks }) {
  const { A, al } = state;
  if (!A || !al) return null;
  // ready square first, so the field square draws on top of it
  const ovReady = A.graphicOverlay({ name: "Prepared blink field", color: GOLD, lineWidth: 1.2, lineDash: [6, 4] });
  const ovField = A.graphicOverlay({ name: "Field of the next result", color: CYAN, lineWidth: 1.3 });
  al.addOverlay(ovReady);
  al.addOverlay(ovField);
  const labels = A.catalog({ name: "Field square labels", shape: drawLabels, sourceSize: 8, color: CYAN });
  al.addCatalog(labels);

  let cur = null;                  // { ra, dec, field: {w, corners}, ready: {ra, dec, w, h, corners} | null, key }
  let run = 0;

  function fieldWidth() {
    const s = typeof window.__fzFovShown === "function" ? window.__fzFovShown() : null;
    if (s && s.fov > 0) return s.fov;
    const v = Number((document.getElementById("fovSel") || {}).value);
    return v > 0 ? v : 0.15;
  }

  function clear() {
    run++;
    if (!cur) return;
    cur = null;
    ovField.removeAll(); ovReady.removeAll(); labels.removeAll();
  }

  const outline = (overlay, corners, color, width) => {
    overlay.add(A.polygon(corners, { color: EDGE, lineWidth: width + 2 }));
    overlay.add(A.polygon(corners, { color, lineWidth: width }));
  };

  async function update() {
    const p = state.selected, card = document.getElementById("card");
    if (!p || !p.pos || !card || card.hidden) { clear(); return; }
    const w = fieldWidth();
    const myRun = ++run;
    const ready = p.challenge && p.gallery ? await readyField(p.gallery) : null;
    if (myRun !== run || state.selected !== p) return;
    const { ra, dec } = p.pos;
    const key = [ra, dec, w, ready ? ready.w : 0].join("|");
    if (cur && cur.key === key) return;
    ovField.removeAll(); ovReady.removeAll(); labels.removeAll();
    const same = !!ready && Math.abs(ready.w - w) < SAME_DEG && Math.abs(ready.h - w) < SAME_DEG
      && Math.abs(ready.dec - dec) < SAME_DEG && Math.abs((ready.ra - ra) * Math.cos(dec * DEG)) < SAME_DEG;
    cur = { ra, dec, key, same, field: { w, corners: squareCorners(ra, dec, w) }, ready: null };
    if (ready && !same) {
      cur.ready = { ...ready, corners: squareCorners(ready.ra, ready.dec, ready.w, ready.h) };
      outline(ovReady, cur.ready.corners, GOLD, 1.2);
    }
    outline(ovField, cur.field.corners, CYAN, 1.3);
    labels.addSources([A.source(ra, dec, { fieldSquare: true })]);
  }

  /** Labels at the squares' corners, in screen px, once a square is big enough to carry one. */
  function drawLabels(source, ctx) {
    if (!cur) return;
    const pix = (c) => { try { const q = al.world2pix(c[0], c[1]); return q && Number.isFinite(q[0]) ? q : null; } catch (_) { return null; } };
    const text = (s, x, y, color, base, align = "left") => {
      ctx.font = "600 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.textAlign = align; ctx.textBaseline = base;
      ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(4,6,12,.85)";
      ctx.strokeText(s, x, y);
      ctx.fillStyle = color; ctx.fillText(s, x, y);
    };
    ctx.save();
    const [ne, nw] = cur.field.corners.map(pix);
    const fieldTop = ne && nw ? Math.min(ne[1], nw[1]) : null;
    const big = ne && nw && Math.hypot(nw[0] - ne[0], nw[1] - ne[1]) >= LABEL_MIN_PX;
    if (big) {
      const s = cur.same ? T("ex.sq.same", { v: fmt(cur.field.w) }, `Downloaded area · ${fmt(cur.field.w)}° · prepared blink`)
        : T("ex.sq.field", { v: fmt(cur.field.w) }, `Downloaded area · ${fmt(cur.field.w)}°`);
      text(s, Math.min(ne[0], nw[0]) + 1, fieldTop - 4, CYAN, "alphabetic");
    }
    if (cur.ready) {                     // above its top-left corner; below the square when that is too close to the field label
      const [rne, rnw, rsw, rse] = cur.ready.corners.map(pix);
      if (rne && rnw && rsw && rse && Math.hypot(rnw[0] - rne[0], rnw[1] - rne[1]) >= LABEL_MIN_PX) {
        const s = T("ex.sq.ready", { v: fmt(cur.ready.w) }, `Prepared blink ${fmt(cur.ready.w)}°`);
        const top = Math.min(rne[1], rnw[1]);
        if (fieldTop == null || top - fieldTop >= 16) text(s, Math.min(rne[0], rnw[0]) + 1, top - 4, GOLD, "alphabetic");
        else text(s, Math.min(rsw[0], rse[0]) + 1, Math.max(rsw[1], rse[1]) + 4, GOLD, "top");
      }
    }
    // "Measured point" at the crosshair (main.js drawSelection: ring r 16, ticks out to 28 px), on its left: the
    // target's name (Aladin label) is drawn to the right of the point, the square labels above the squares (and the
    // prepared-blink one under its square when it is close to the field label), and the place card can cover the
    // sky under the point.
    const c = big ? pix([cur.ra, cur.dec]) : null;
    if (c) text(T("ex.sq.point", null, "Measured point"), c[0] - 32, c[1], "#ffffff", "middle", "right");
    ctx.restore();
  }

  // a new point on the card, the card closing (hidden), the Field selector, the language
  hooks.card.push(() => update());
  const card = document.getElementById("card");
  if (card) new MutationObserver(() => update()).observe(card, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("fazari:fov", () => update());
  onLang(() => { try { al.view.requestRedraw(); } catch (_) { /* older Aladin */ } });
  update();
  return {
    update,
    info: () => (cur ? { ra: cur.ra, dec: cur.dec, field: cur.field.w, ready: cur.ready ? cur.ready.w : null, same: cur.same,
      squares: cur.ready ? 2 : 1 } : null),
  };
}
