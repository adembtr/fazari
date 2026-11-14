// Idle sky = no frames. Aladin Lite asks for an animation frame 60 times a second for ever, even when nothing
// moves and nothing is drawn (measured Nov 2026, headless Chrome on the real GPU: 600 frames per 10 s at rest,
// renderer 7-12 % and GPU process 21-23 % CPU; Adem's own tab ~35 % + ~31 %). The loop itself is the cost:
// every requested frame keeps the compositor and the GPU process busy.
// Here: once the view has been still and nothing was drawn for IDLE_FRAMES frames, Aladin's loop runs only
// POLL_MS apart (it still takes in tiles that arrive and draws them, just a moment later). Any input on the
// page, any call that changes the view or its layers, and any finished download wake the 60 fps loop at once.
// A hidden tab gets no frames from the browser anyway. ?idle=0 turns this off.

const IDLE_FRAMES = 30;         // ~0.5 s of nothing before the loop slows down
const POLL_MS = 250;            // slow loop: a late tile shows at most this much later
// Aladin and wasm calls that change what is on screen (getters, pix2world etc. do not wake the loop).
const MUTATOR = /^(goto|set|animate|zoom|add|remove|increase|decrease|select|show|hide|toggle|adjust|center|point|change|move|go|rotate|resize|start|stop|swap|register|press|release|reverse|apply|push|load|draw|enable|disable)/i;
const NOT = new Set(["update", "isRendering", "isInerting", "isMoving", "isZooming"]);

/** Slow Aladin's redraw loop while the sky is idle. Returns { wake, stats } or null when not possible. */
export function idleAladinLoop(al) {
  const view = al && al.view, wasm = view && view.wasm;
  if (!view || !wasm || typeof view.redraw !== "function" || typeof view.redrawClbk !== "function") return null;
  const stats = { frames: 0, slow: 0, wakes: 0 };
  let quiet = 0, idle = false, timer = 0, asked = false;   // asked: a frame (this loop) is already requested
  const busy = () => view.moving || view.needRedraw || view.dragging || view.pan || Math.abs(view.zoomDelta || 0) > 0.001
    || (typeof wasm.isRendering === "function" && wasm.isRendering());
  const ask = () => { if (!asked) { asked = true; requestAnimationFrame(frame); } };

  // Aladin ends every redraw with requestAnimationFrame(view.redrawClbk): this is that callback.
  function frame(t) {
    asked = false;
    if (idle) return;
    stats.frames++;
    view.redraw(t);                                     // it asks for the next frame itself
    asked = true;
    quiet = busy() ? 0 : quiet + 1;
    if (quiet >= IDLE_FRAMES) {                         // still: one frame every POLL_MS
      idle = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!idle) return;
        stats.slow++;
        idle = false; quiet = IDLE_FRAMES - 1;           // one frame; slow again unless it found work
        view.prevTime = performance.now() - 16;         // no big time step for inertia / animations
        ask();
      }, POLL_MS);
    }
  }
  function wake() {
    if (!idle) { quiet = 0; return; }
    idle = false; quiet = 0; stats.wakes++;
    clearTimeout(timer);
    view.prevTime = performance.now() - 16;
    ask();
  }
  view.redrawClbk = frame;

  // Calls that change the view or its layers.
  const wrap = (obj, names) => {
    for (const k of names) {
      if (NOT.has(k) || !MUTATOR.test(k)) continue;
      let d = null;
      for (let p = obj; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, k);
      const f = d && d.value;
      if (typeof f !== "function") continue;
      obj[k] = function (...a) { wake(); return f.apply(this, a); };
    }
  };
  const names = (o) => { const s = new Set(); for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (k !== "constructor") s.add(k); return s; };
  wrap(al, names(al));
  wrap(wasm, names(wasm));
  const rr = view.requestRedraw;
  if (typeof rr === "function") view.requestRedraw = function (...a) { wake(); return rr.apply(this, a); };

  // Input anywhere on the page (the sky, its controls, keys) and finished downloads (tiles).
  for (const t of ["pointerdown", "pointermove", "wheel", "touchstart", "touchmove", "keydown", "resize", "focus"]) {
    addEventListener(t, wake, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  const f0 = window.fetch;
  if (typeof f0 === "function") {
    window.fetch = function (...a) {
      const p = f0.apply(this, a);
      p.then(wake, wake);
      return p;
    };
  }
  return { wake, stats, get idle() { return idle; } };
}
