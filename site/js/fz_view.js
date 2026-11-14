// The picture area of the result viewer (js/viewer.js): the season frames drawn through js/fz_frames.js on a canvas
// that lies exactly over the frame image inside the zoom box, the view tabs (Film · Time as colour · Difference ·
// Deep), the zoom buttons and the zoom / pan gestures. viewer.js owns the state (which bin, which seasons, which
// view, the zoom transform); this module only draws and reports input.
//
// Fallback: until the frames are processed, or if the browser refuses to read the pixels, the canvas stays hidden
// and the pipeline's own PNG (<img id="frame">) shows as before.

import * as FR from "./fz_frames.js";
import { t } from "./i18n.js";

const L = (key, en, p) => t(key, p, en);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let cssDone = null;
/** css/fz_stage.css next to this module; resolves when loaded (or after 1.5 s). */
export function ensureCss() {
  if (cssDone) return cssDone;
  cssDone = new Promise((res) => {
    if (document.querySelector("link[data-fz-stage]")) return res();
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = new URL("../css/fz_stage.css", import.meta.url).href; l.dataset.fzStage = "1";
    l.onload = l.onerror = () => res();
    setTimeout(res, 1500);
    document.head.appendChild(l);
  });
  return cssDone;
}

// One colour per visit (season), in time order: the same list as the spectrum and brightness charts
// (js/spectrum_chart.js COLORS; agreed in ajan_durumu/AB_ortak.md), used on the picture, in the caption and on
// the season buttons. "Time as colour" has its own two colours (earlier = blue, later = orange: a role, not a visit).
export const SEASON_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#9085e9", "#e66767"];
export const visitColour = (i) => SEASON_COLORS[((i % SEASON_COLORS.length) + SEASON_COLORS.length) % SEASON_COLORS.length];
export const TIME_FIRST = "#1a85ff", TIME_LAST = "#e67a00";

const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
function loadImg(url) {
  return new Promise((res, rej) => { const im = new Image(); im.decoding = "async"; im.onload = () => res(im); im.onerror = () => rej(new Error("load " + url)); im.src = url; });
}
/** Finer drawing grid: about 900 canvas pixels across, at most 8 per cell. */
const upFor = (n) => Math.max(1, Math.min(8, Math.round(900 / n)));

/**
 * createView({ zoomer, frame }) -> view
 *   view.load({ key, urls, up, strip, stretch, cellArcsec, centre, targets }) -> Promise<set | null>  (frames of one bin)
 *   view.paint(spec)   spec: { kind: "frame", i } | { kind: "swipe", a, b, x (0..1 of the width) } | { kind: "trail", idx }
 *                            | { kind: "tcol", a, b } | { kind: "diff", a, b } | { kind: "deep", idx }
 *   view.ready, view.set, view.raw (get/set), view.hide(), view.canvas
 */
export function createView({ zoomer, frame }) {
  const cv = document.createElement("canvas");
  cv.id = "fzView"; cv.hidden = true; cv.setAttribute("aria-hidden", "true");
  frame.after(cv);
  const ctx = cv.getContext("2d");
  const work = document.createElement("canvas");
  const st = { key: null, token: 0, set: null, tiles: new Map(), mix: null, mixKey: "", img: null, up: 4, raw: false, spec: null, geom: null, failed: false };

  function drop() { st.set = null; st.tiles.clear(); st.mix = null; st.mixKey = ""; }
  async function load(o) {
    if (o.key === st.want && st.loading) return st.loading;
    if (o.key === st.key && st.set) return st.set;
    const my = ++st.token;
    st.want = o.key;                                   // st.key names the set that is READY (the one on screen)
    const run = (async () => {
      const frames = [];
      let W = 0, H = 0;
      for (const url of o.urls) {
        const im = await loadImg(url);
        if (my !== st.token) return null;
        W = im.naturalWidth; H = im.naturalHeight;
        work.width = W; work.height = H;
        const wx = work.getContext("2d", { willReadFrequently: true });
        wx.drawImage(im, 0, 0);
        const d = wx.getImageData(0, 0, W, H).data;
        frames.push(FR.gridFromRgba(d, W, H, o.up, o.strip));
        await nextFrame();
        if (my !== st.token) return null;
      }
      work.width = work.height = 1;
      const nx = frames[0].nx, ny = frames[0].ny;
      const set = FR.prepare(frames, { nx, ny, stretch: o.stretch || null, cellArcsec: o.cellArcsec, centre: o.centre, targets: o.targets || null });
      if (my !== st.token) return null;
      drop();
      st.set = set; st.key = o.key; st.up = upFor(Math.max(nx, ny));
      st.geom = { left: 0, top: o.strip, width: nx * o.up, height: ny * o.up };
      cv.width = nx * st.up; cv.height = ny * st.up;
      Object.assign(cv.style, { left: "0px", top: o.strip + "px", width: nx * o.up + "px", height: ny * o.up + "px" });
      st.img = ctx.createImageData(cv.width, cv.height);
      st.failed = false;
      return set;
    })().catch((e) => { if (my === st.token) { console.warn("fz_view: frames not processed, showing the pipeline images", e); st.failed = true; drop(); st.key = null; cv.hidden = true; } return null; })
      .finally(() => { if (my === st.token) st.loading = null; });
    st.loading = run;
    return run;
  }
  const tile = (i) => {
    const k = (st.raw ? "r" : "s") + i;
    if (!st.tiles.has(k)) st.tiles.set(k, FR.frameFloat(st.set, i, st.up, st.raw));
    return st.tiles.get(k);
  };
  const gamma = () => (st.raw ? 1 : st.set.disp.gamma);
  function paint(spec) {
    st.spec = spec;
    if (!st.set || !spec) { cv.hidden = true; return false; }
    const n = st.set.n, okI = (i) => Number.isInteger(i) && i >= 0 && i < n;
    const out = st.img.data, W = cv.width, H = cv.height;
    try {
      if (spec.kind === "frame") {
        if (!okI(spec.i)) return false;
        FR.greyRgba(tile(spec.i), out, gamma());
      } else if (spec.kind === "swipe") {
        if (!okI(spec.a) || !okI(spec.b)) return false;
        const a = tile(spec.a), b = tile(spec.b), xs = Math.max(0, Math.min(W, Math.round(spec.x * W))), g = gamma();
        const key = `sw|${spec.a}|${spec.b}|${st.raw}`;
        if (st.mixKey !== key) { st.mix = [FR.greyRgba(a, new Uint8ClampedArray(out.length), g), FR.greyRgba(b, new Uint8ClampedArray(out.length), g)]; st.mixKey = key; }
        for (let y = 0; y < H; y++) { const o = 4 * y * W; out.set(st.mix[0].subarray(o, o + 4 * xs), o); out.set(st.mix[1].subarray(o + 4 * xs, o + 4 * W), o + 4 * xs); }
      } else {
        const key = `${spec.kind}|${(spec.idx || [spec.a, spec.b]).join(",")}|${st.raw}`;
        if (st.mixKey !== key) {
          const buf = new Uint8ClampedArray(out.length);
          if (spec.kind === "tcol") FR.timeColourRgba(tile(spec.a), tile(spec.b), buf, gamma());
          else if (spec.kind === "diff") FR.diffRgba(tile(spec.a), tile(spec.b), buf);
          else if (spec.kind === "trail") FR.greyRgba(FR.maxOf(spec.idx.map(tile)), buf, gamma());
          else if (spec.kind === "deep") FR.greyRgba(FR.deepFloat(st.set, spec.idx, st.up, st.raw), buf, gamma());
          else return false;
          st.mix = [buf]; st.mixKey = key;
        }
        out.set(st.mix[0]);
      }
      ctx.putImageData(st.img, 0, 0);
    } catch (e) { console.warn("fz_view: paint", e); cv.hidden = true; return false; }
    cv.classList.toggle("fz-raw", st.raw);
    cv.hidden = false;
    return true;
  }
  return {
    canvas: cv, load, paint,
    get ready() { return !!st.set; }, get set() { return st.set; }, get failed() { return st.failed; }, get key() { return st.key; },
    get raw() { return st.raw; },
    set raw(v) { v = !!v; if (v !== st.raw) { st.raw = v; st.mix = null; st.mixKey = ""; if (st.spec) paint(st.spec); } },
    hide() { cv.hidden = true; },
    /** Bytes held for the frames on screen (for the memory check). */
    bytes() { let b = st.img ? st.img.data.length : 0; for (const v of st.tiles.values()) b += v.byteLength; if (st.mix) for (const m of st.mix) b += m.byteLength; if (st.set) b += st.set.n * st.set.nx * st.set.ny * 12; return b; },
  };
}

// ---- view tabs ---------------------------------------------------------------------------------------------
export const VIEWS = ["film", "tcol", "diff", "deep"];
const TAB_EN = { film: "Film", tcol: "Time as colour", diff: "Difference", deep: "Deep" };
/** One row of tabs right under the stage (the picture itself stays as high on the page as it can). onPick(view).
 *  Returns { el, set(view), paint() }. */
export function buildTabs(stage, onPick) {
  const el = document.createElement("div");
  el.id = "fzViews"; el.className = "fz-views"; el.setAttribute("role", "tablist"); el.dataset.tour = "views";
  el.innerHTML = VIEWS.map((v) => `<button type="button" role="tab" data-view="${v}" aria-selected="false" tabindex="-1"></button>`).join("");
  stage.after(el);
  const btns = [...el.querySelectorAll("button")];
  let cur = "film";
  const paint = () => {
    el.setAttribute("aria-label", L("fz.tabs.aria", "How to look at the pictures"));
    btns.forEach((b) => { const on = b.dataset.view === cur; b.textContent = L("fz.tab." + b.dataset.view, TAB_EN[b.dataset.view]); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
  };
  btns.forEach((b, i) => {
    b.onclick = () => onPick(b.dataset.view);
    b.onkeydown = (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      const nb = btns[(i + d + btns.length) % btns.length];
      nb.focus(); onPick(nb.dataset.view);
    };
  });
  paint();
  return { el, set(v) { cur = v; paint(); }, paint };
}

// ---- zoom buttons --------------------------------------------------------------------------------------------
const ICON = {
  in: `<path d="M12 5v14M5 12h14"/>`, out: `<path d="M5 12h14"/>`,
  close: `<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>`,
  whole: `<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M9 4v16M15 4v16M4 9h16M4 15h16" stroke-opacity=".45"/>`,
  raw: `<rect x="4" y="4" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/><rect x="13" y="4" width="7" height="7" fill-opacity=".25"/><rect x="4" y="13" width="7" height="7" fill-opacity=".25"/>`,
};
/** + / − / close-up / whole field / raw pixels, at the right edge of the stage. h: { zoom(f), closeUp(), whole(), raw(on) } */
export function buildZoomUi(stage, h) {
  const el = document.createElement("div");
  el.id = "fzZoomUi"; el.className = "fz-zoomui"; el.setAttribute("role", "group");
  const b = (id, icon, fill) => `<button type="button" data-z="${id}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round">${icon}</svg></button>`;
  el.innerHTML = b("in", ICON.in) + b("out", ICON.out) + b("close", ICON.close) + b("whole", ICON.whole) + b("raw", ICON.raw, true);
  stage.appendChild(el);
  const q = (id) => el.querySelector(`[data-z="${id}"]`);
  q("in").onclick = () => h.zoom(1.5);
  q("out").onclick = () => h.zoom(1 / 1.5);
  q("close").onclick = () => h.closeUp();
  q("whole").onclick = () => h.whole();
  q("raw").onclick = () => h.raw(q("raw").getAttribute("aria-pressed") !== "true");
  const paint = (s = {}) => {
    el.setAttribute("aria-label", L("fz.zoom.aria", "Zoom"));
    const lab = { in: L("fz.zoom.in", "Zoom in"), out: L("fz.zoom.out", "Zoom out"), close: L("fz.zoom.close", "Close-up on the target"),
      whole: L("fz.zoom.whole", "Whole field"), raw: L("fz.zoom.raw", "Raw pixels (no smoothing)") };
    for (const id of Object.keys(lab)) { q(id).title = lab[id]; q(id).setAttribute("aria-label", lab[id]); }
    if (s.atMin != null) q("out").disabled = !!s.atMin;
    if (s.atMax != null) q("in").disabled = !!s.atMax;
    if (s.raw != null) q("raw").setAttribute("aria-pressed", String(!!s.raw));
    if (s.isClose != null) q("close").setAttribute("aria-pressed", String(!!s.isClose));
    if (s.isWhole != null) q("whole").setAttribute("aria-pressed", String(!!s.isWhole));
    if (s.rawOk != null) q("raw").hidden = !s.rawOk;
  };
  paint();
  return { el, paint };
}

// ---- gestures: wheel, pinch, drag, keys -----------------------------------------------------------------------
/**
 * attachGestures(stage, h)   h: { zoomAt(factor, x, y), panBy(dx, dy), canZoom(factor), canDrag(ev), settle(), hint(kind), key(name) }
 * Rule for the wheel: it zooms only after the picture was clicked / tapped or has keyboard focus (or with Ctrl held,
 * which is also what a trackpad pinch sends). Otherwise the page scrolls as usual and a short hint is shown.
 * Touch: two fingers zoom; one finger scrolls the page unless the picture is zoomed in (viewer.js sets touch-action).
 */
export function attachGestures(stage, h) {
  if (!stage.hasAttribute("tabindex")) stage.tabIndex = 0;
  let armed = false, drag = null, pinch = null, moved = false, swallow = false;
  const pts = new Map();
  const local = (ev) => { const r = stage.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const ui = (ev) => !!(ev.target && ev.target.closest && ev.target.closest("button, input, select, a, #gameMsg, #fzViews"));
  document.addEventListener("pointerdown", (ev) => { armed = stage.contains(ev.target); }, true);
  stage.addEventListener("focusin", () => { armed = true; });
  stage.addEventListener("focusout", (ev) => { if (!stage.contains(ev.relatedTarget)) armed = false; });
  stage.addEventListener("wheel", (ev) => {
    if (ui(ev)) return;
    if (!(armed || ev.ctrlKey || ev.metaKey)) { h.hint("wheel"); return; }
    const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : ev.ctrlKey ? 0.012 : 0.0018));
    if (!h.canZoom(f)) return;                       // at a limit: the page scrolls
    ev.preventDefault();
    const [x, y] = local(ev);
    h.zoomAt(f, x, y);
  }, { passive: false });
  stage.addEventListener("pointerdown", (ev) => {
    if ((ev.pointerType === "mouse" && ev.button !== 0) || ui(ev)) return;
    pts.set(ev.pointerId, local(ev));
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
      drag = null; moved = true;
    } else if (pts.size === 1 && h.canDrag(ev)) { drag = { x: ev.clientX, y: ev.clientY, id: ev.pointerId }; moved = false; }
  });
  stage.addEventListener("pointermove", (ev) => {
    if (!pts.has(ev.pointerId)) return;
    pts.set(ev.pointerId, local(ev));
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      h.panBy(mx - pinch.mx, my - pinch.my);
      h.zoomAt(d / pinch.d, mx, my);
      pinch = { d, mx, my };
    } else if (drag && drag.id === ev.pointerId) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) { moved = true; try { stage.setPointerCapture(ev.pointerId); } catch (_) {} stage.classList.add("fz-grabbing"); }
      h.panBy(dx, dy);
      drag.x = ev.clientX; drag.y = ev.clientY;
    }
  });
  const end = (ev) => {
    if (!pts.has(ev.pointerId)) return;
    pts.delete(ev.pointerId);
    if (pts.size < 2) pinch = null;
    if (drag && drag.id === ev.pointerId) {
      if (moved) { swallow = true; setTimeout(() => { swallow = false; }, 0); }
      drag = null; stage.classList.remove("fz-grabbing");
    }
    if (!pts.size) h.settle();
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("click", (ev) => { if (swallow) { ev.stopPropagation(); ev.preventDefault(); swallow = false; } }, true);
  stage.addEventListener("keydown", (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test((ev.target && ev.target.tagName) || "")) return;
    const k = ev.key;
    const name = k === "+" || k === "=" ? "in" : k === "-" || k === "_" ? "out" : k === "0" ? "close"
      : ev.shiftKey && /^Arrow/.test(k) ? k.slice(5).toLowerCase() : null;
    if (!name) return;
    ev.preventDefault(); ev.stopPropagation();
    h.key(name);
  });
  return { get armed() { return armed; } };
}

/** A short line inside the stage that fades by itself (wheel hint). */
export function hintLine(stage) {
  const el = document.createElement("div");
  el.id = "fzHint"; el.className = "fz-hint"; el.hidden = true; el.setAttribute("role", "status");
  stage.appendChild(el);
  let tm = 0, last = 0;
  return (text) => {
    const now = Date.now();
    if (now - last < 2500 && !el.hidden) return;
    last = now;
    el.textContent = text; el.hidden = false;
    clearTimeout(tm);
    tm = setTimeout(() => { el.hidden = true; }, 2200);
  };
}

/**
 * One quiet progress line inside the bottom edge of the stage ("Loading 4.6 µm: 15 of 96"). It reads the wavelength
 * buttons of js/bins_bar.js (the button that is loading carries "done of total" in its own label), so there is no
 * second progress mechanism: the same line works on ornek.html (local engine) and sky.html (browser engine).
 */
/** What the wavelength buttons say is loading right now: { text, frac } or null (host: the bar; default: the one on the page). */
export function progressInfo(host = document.getElementById("pgBins") || document.querySelector(".pg-bins")) {
  const H = document.documentElement;
  const b = host && (host.classList.contains("pg-run") || H.classList.contains("pg-live")) ? host.querySelector('.pg-b[data-state="loading"]') : null;
  if (!b) return null;
  const nums = (String(b.title).split("µm")[1] || "").match(/\d+/g) || [];
  const d = nums.length >= 2 ? Math.min(+nums[0], +nums[1]) : null, tot = nums.length >= 2 ? Math.max(+nums[0], +nums[1]) : null;
  const um = ((b.querySelector(".pg-l") || b).textContent || "").trim();            // "4.6 µm", as the button shows it
  return { text: tot ? L("fz.prog.n", "Loading {um}: {d} of {t}", { um, d, t: tot }) : L("fz.prog", "Loading {um}…", { um }), frac: tot ? d / tot : 0.04 };
}
export function progressLine(stage) {
  const el = document.createElement("div");
  el.id = "fzProg"; el.className = "fz-prog"; el.hidden = true; el.setAttribute("aria-hidden", "true");   // the buttons already announce it
  el.innerHTML = `<span></span><i></i>`;
  stage.appendChild(el);
  const H = document.documentElement;
  let host = null, mo = null;
  const paint = () => {
    const p = progressInfo(host);
    if (!p) { el.hidden = true; stage.classList.remove("fz-has-prog"); return; }
    if (el.firstChild.textContent !== p.text) el.firstChild.textContent = p.text;
    el.lastChild.style.width = (100 * p.frac).toFixed(0) + "%";
    el.hidden = false; stage.classList.add("fz-has-prog");
  };
  const hook = () => {
    const h = document.getElementById("pgBins") || document.querySelector(".pg-bins");
    if (h && h !== host) {
      host = h;
      if (mo) mo.disconnect();
      mo = new MutationObserver(paint);
      mo.observe(h, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "title", "class"] });
    }
    paint();
  };
  try { new MutationObserver(hook).observe(H, { attributes: true, attributeFilter: ["class"] }); } catch (_) {}
  hook();
  return { el, refresh: hook };
}

export { esc as _esc };
