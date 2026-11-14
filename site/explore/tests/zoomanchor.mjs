// Zoom-toward-the-cursor test for explore.html (headless Chrome, no dependencies; Node 22+).
//
//   node site/explore/tests/zoomanchor.mjs [url] [--chrome /usr/bin/google-chrome] [--json out.json] [--shots DIR]
//   url defaults to http://127.0.0.1:8765/explore.html (any server that serves site/ works)
//
// Rule under test: when you zoom, the sky point under the cursor (or under the midpoint between two
// fingers) stays under it. Everything is ICRS RA/Dec in degrees, pixels are CSS pixels in #sky.
//  1. 3D sky, mouse wheel: Barnard's Star is put exactly under a cursor 30% from the left and top edges;
//     5 wheel notches in, then 5 out, at three starting fields (100, 10 and 0.1 deg). After each notch
//     (once the smooth zoom has settled) the star's screen position is compared with the cursor, and
//     every animation frame in between is sampled as well (catches jitter).
//  2. 3D sky, trackpad pinch (wheel events with ctrlKey, small deltas, sent in a burst).
//  3. 3D sky, keyboard + / -: still zooms about the centre (the centre stays put).
//  4. 3D sky on a phone-sized screen, two-finger pinch (CDP touch events): midpoint off-centre, fingers
//     spread then close; also a pinch whose midpoint travels. A pinch must not count as a tap.
//  5. Flat 2D fallback (?flat): the same wheel and pinch checks.
// Prints a JSON summary (drift in pixels: max and median); exits 1 if any drift is above 3 px.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const chromeBin = opt("--chrome", "/usr/bin/google-chrome");
const jsonOut = opt("--json", null);
const shots = opt("--shots", null);
const url = args[0] || "http://127.0.0.1:8765/explore.html";
const LIMIT_PX = 3;
const STAR = { name: "Barnard's Star", ra: 269.44627, dec: 4.76820 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (a) => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? { n: s.length, median: +s[Math.floor(s.length / 2)].toFixed(3), max: +s[s.length - 1].toFixed(3) } : { n: 0 };
};
const withQuery = (u, q) => u + (u.includes("?") ? "&" : "?") + q;

const procs = [];
process.on("exit", () => { for (const p of procs) p(); });

async function browser(pageUrl, { W, H, mobile = false }) {
  const port = 9700 + Math.floor(Math.random() * 250);
  const prof = mkdtempSync(join(tmpdir(), "fz-za-"));
  const proc = spawn(chromeBin, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
  const gone = new Promise((r) => proc.on("exit", r));
  const kill = () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } try { rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ } };
  procs.push(kill);
  let list;
  for (let i = 0; i < 80; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(200); } }
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: pageUrl });
  const shot = async (name) => {
    if (!shots) return;
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) writeFileSync(join(shots, name), Buffer.from(r.result.data, "base64"));
  };
  // Close Chrome properly, then remove the temporary profile (its helper processes write until they exit).
  const close = async () => {
    await Promise.race([send("Browser.close"), sleep(2000)]);
    ws.close();
    await Promise.race([gone, sleep(3000)]);
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    for (let i = 0; i < 40; i++) {
      try { rmSync(prof, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  };
  return { send, ev, shot, close };
}

// In-page helpers. A "view" is { toPixel(ra, dec) -> [x, y] | null, toSky(x, y) -> [ra, dec] | null,
// centre() -> [ra, dec], goTo(ra, dec) }. place() puts a sky point exactly on a pixel by dragging the
// view (independent of the code under test); sampler() records the drift of that point every frame.
const HELPERS = `
window.__za = {
  views: {
    aladin: () => { const al = __explore.state.al; return {
      toPixel: (ra, dec) => { const p = al.world2pix(ra, dec); return p && Number.isFinite(p[0]) ? p : null; },
      toSky: (x, y) => { const q = al.pix2world(x, y); return q && Number.isFinite(q[0]) ? q : null; },
      centre: () => al.getRaDec(), goTo: (ra, dec) => al.gotoRaDec(ra, dec), fov: () => al.getFov()[0], setFov: (f) => al.setFoV(f) }; },
    flat: () => { const f = __explore.state.flat; return {
      toPixel: (ra, dec) => f.toPixel(ra, dec),
      toSky: (x, y) => { const q = f.toSky(x, y); return q ? [q.ra, q.dec] : null; },
      centre: () => { const v = f.getView(); return [v.ra, v.dec]; }, goTo: (ra, dec) => f.goTo(ra, dec),
      fov: () => f.getView().fov, setFov: (fov) => { const v = f.getView(); f.goTo(v.ra, v.dec, fov); } }; },
  },
  place(v, ra, dec, x, y) {
    for (let i = 0; i < 30; i++) {
      const p = v.toPixel(ra, dec), c = v.toPixel(...v.centre());
      if (!p || !c) return false;
      const ex = p[0] - x, ey = p[1] - y;
      if (Math.hypot(ex, ey) < 1e-3) return true;
      const n = v.toSky(c[0] + ex, c[1] + ey);
      if (!n) return false;
      v.goTo(n[0], n[1]);
    }
    return false;
  },
  drift(v, ra, dec, x, y) { const p = v.toPixel(ra, dec); return p ? Math.hypot(p[0] - x, p[1] - y) : Infinity; },
  // What the page has received so far (CDP input can arrive a frame later than the command returns).
  seen: { wheels: 0, mid: null, n: 0 },
  sample: null,
  sampler(v, ra, dec, x, y) {
    const s = { max: 0, frames: 0, on: true };
    const tick = () => { if (!s.on) return; s.max = Math.max(s.max, __za.drift(v, ra, dec, x, y)); s.frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return (__za.sample = s);
  },
};
addEventListener("wheel", () => { __za.seen.wheels++; }, { capture: true, passive: true });
for (const t of ["touchstart", "touchmove"]) addEventListener(t, (e) => {
  const r = document.getElementById("sky").getBoundingClientRect(), a = e.touches[0], b = e.touches[1];
  __za.seen.n = e.touches.length;
  if (b) __za.seen.mid = [(a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top];
}, { capture: true, passive: true });
1`;
const frames = (n) => `new Promise((r) => { let k = ${n}; const f = () => (--k <= 0 ? r(1) : requestAnimationFrame(f)); requestAnimationFrame(f); })`;

const wait = async (b, expr, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await b.ev(expr)) return true; await sleep(200); } return false; };
// Wait for the page to start; reload and try again (slow network, or a file caught mid-edit), up to 4 times.
async function boot(b, expr) {
  for (let i = 0; i < 4; i++) {
    if (await wait(b, expr, 30000)) return;
    console.error("page not ready, reloading");
    await b.send("Page.reload", { ignoreCache: true });
  }
  throw new Error("the page did not start: " + expr);
}
// Wait until the field of view has not changed for 6 frames (the wheel zoom is smoothed over frames).
async function settle(b, view) {
  await b.ev(`new Promise((res) => { const v = __za.views.${view}(); let last = v.fov(), same = 0; const t0 = performance.now();
    const tick = () => { const f = v.fov(); same = Math.abs(f - last) <= 1e-12 * f ? same + 1 : 0; last = f;
      if (same >= 6 || performance.now() - t0 > 6000) return res(1); requestAnimationFrame(tick); };
    requestAnimationFrame(tick); })`);
}

const report = { url, star: STAR, limit_px: LIMIT_PX };
const allDrifts = [];

// Wheel notches at a cursor: returns per-notch rows and a summary.
async function wheelRun(b, view, { fov, x, y, rect, notch = 100, ctrl = false, burst = 0, label }) {
  await settle(b, view);
  await b.ev(`(() => { const v = __za.views.${view}(); v.setFov(${fov}); v.goTo(${STAR.ra}, ${STAR.dec}); return __za.place(v, ${STAR.ra}, ${STAR.dec}, ${x}, ${y}); })()`);
  await sleep(300);
  await b.ev(`(() => { const v = __za.views.${view}(); return __za.place(v, ${STAR.ra}, ${STAR.dec}, ${x}, ${y}); })()`);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + x, y: rect.y + y });
  await sleep(100);
  const target = await b.ev(`(() => { const e = document.elementFromPoint(${rect.x + x}, ${rect.y + y}); return e ? e.tagName + "." + (e.className || "") : null; })()`);
  const rows = [];
  const dirs = burst ? [-1] : [-1, -1, -1, -1, -1, 1, 1, 1, 1, 1];
  for (const dir of dirs) {
    await b.ev(`(() => { const v = __za.views.${view}(); __za.sampler(v, ${STAR.ra}, ${STAR.dec}, ${x}, ${y}); return 1; })()`);
    const f0 = await b.ev(`__za.views.${view}().fov()`);
    const w0 = await b.ev("__za.seen.wheels");
    for (let k = 0; k < (burst || 1); k++) {
      await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x + x, y: rect.y + y, deltaX: 0, deltaY: dir * notch, modifiers: ctrl ? 2 : 0 });
      if (burst) await sleep(16);
    }
    const arrived = await wait(b, `__za.seen.wheels >= ${w0 + (burst || 1)}`, 5000);
    await settle(b, view);
    const r = await b.ev(`(() => { const v = __za.views.${view}(); const s = __za.sample; s.on = false;
      return { fov: v.fov(), drift: __za.drift(v, ${STAR.ra}, ${STAR.dec}, ${x}, ${y}), during: s.max, frames: s.frames }; })()`);
    rows.push({ dir: dir < 0 ? "in" : "out", fov_from: +f0.toPrecision(5), fov_to: +r.fov.toPrecision(5),
      drift_px: +r.drift.toFixed(3), max_during_px: +r.during.toFixed(3), frames: r.frames, ...(arrived ? {} : { wheel_not_seen: true }) });
  }
  const finals = rows.map((r) => r.drift_px), during = rows.map((r) => r.max_during_px);
  allDrifts.push(...finals, ...during);
  return { label, cursor_px: [x, y], target, start_fov: fov, drift_after_step_px: stats(finals), drift_during_animation_px: stats(during), steps: rows };
}

// ---- 1-3. 3D sky (Aladin), desktop size -------------------------------------------------------
{
  const W = 1400, H = 900;
  const b = await browser(withQuery(url, "engine=browser&hero=0"), { W, H });
  await boot(b, "!!(window.__explore && __explore.state.al && __explore.state.cats.length)");
  await sleep(4500);                                            // the opening glide
  await b.ev(`document.querySelector('.panel').style.display='none'; ${HELPERS}`);
  report.aladin_anchor_module = await b.ev("!!__explore.state.zoomAnchor");
  const rect = await b.ev(`JSON.stringify(document.getElementById('sky').getBoundingClientRect())`).then(JSON.parse);
  const x = Math.round(0.3 * rect.width), y = Math.round(0.3 * rect.height);
  report.wheel_3d = [];
  for (const fov of [100, 10, 0.1]) report.wheel_3d.push(await wheelRun(b, "aladin", { fov, x, y, rect, label: `wheel from ${fov} deg` }));
  await b.shot("ZC_wheel_3d.png");
  report.step_after_wheel_3d = await b.ev("__explore.state.step");   // the step hints move on to 2 once you zoom (info)
  // Off-centre the other way (70% / 70%) and near a pole.
  report.wheel_3d.push(await wheelRun(b, "aladin", { fov: 30, x: Math.round(0.7 * rect.width), y: Math.round(0.7 * rect.height), rect, label: "wheel from 30 deg, cursor at 70%/70%" }));
  // Trackpad pinch: ctrlKey wheel events with small deltas, in a burst.
  report.trackpad_pinch_3d = await wheelRun(b, "aladin", { fov: 20, x, y, rect, notch: 6, ctrl: true, burst: 12, label: "trackpad pinch (ctrl+wheel burst)" });
  // Keyboard + / -: about the centre.
  const kb = await b.ev(`(async () => { const al = __explore.state.al; al.setFoV(10); al.gotoRaDec(${STAR.ra}, ${STAR.dec}); document.activeElement?.blur?.();
    const c0 = al.getRaDec(), f0 = al.getFov()[0];
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const c1 = al.getRaDec(), f1 = al.getFov()[0];
    return { fov_from: f0, fov_to: f1, centre_moved_arcsec: Math.hypot((c1[0] - c0[0]) * Math.cos(c0[1] * Math.PI / 180), c1[1] - c0[1]) * 3600 }; })()`);
  report.keyboard_plus_3d = { ...kb, about_centre: kb.centre_moved_arcsec < 1 && kb.fov_to < kb.fov_from };
  await b.close();
}

// ---- 4. 3D sky on a phone: two-finger pinch -----------------------------------------------------
async function pinchRun(b, view, { rect, mid0, mid1 = mid0, d0, d1, steps = 5, fov, label }) {
  await settle(b, view);
  await b.ev(`(() => { const v = __za.views.${view}(); v.setFov(${fov}); v.goTo(${STAR.ra}, ${STAR.dec}); return __za.place(v, ${STAR.ra}, ${STAR.dec}, ${mid0[0]}, ${mid0[1]}); })()`);
  await sleep(300);
  await b.ev(`(() => { const v = __za.views.${view}(); return __za.place(v, ${STAR.ra}, ${STAR.dec}, ${mid0[0]}, ${mid0[1]}); })()`);
  const sel0 = await b.ev("JSON.stringify(__explore.state.selected?.pos || null)");
  // Two fingers d px apart on a slanted line through the midpoint m.
  const pts = (m, d) => [{ x: rect.x + m[0] - 0.3 * d, y: rect.y + m[1] - 0.4 * d, id: 0, radiusX: 4, radiusY: 4, force: 1 },
    { x: rect.x + m[0] + 0.3 * d, y: rect.y + m[1] + 0.4 * d, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  // Every finger position must be on the sky canvas (a finger on a panel is not part of the pinch).
  const ends = [...pts(mid0, d0), ...pts(mid0, d1), ...pts(mid1, d0), ...pts(mid1, d1)];
  const target = [...new Set(await b.ev(`${JSON.stringify(ends)}.map((p) => { const e = document.elementFromPoint(p.x, p.y); return e ? e.tagName + "." + (e.className || "") : null; })`))].join(" ");
  await b.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(mid0, d0) });
  await sleep(60);
  const rows = [];
  const f0 = await b.ev(`__za.views.${view}().fov()`);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, d = d0 + (d1 - d0) * t, m = [mid0[0] + (mid1[0] - mid0[0]) * t, mid0[1] + (mid1[1] - mid0[1]) * t];
    await b.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(m, d) });
    await wait(b, `!!__za.seen.mid && Math.hypot(__za.seen.mid[0] - ${m[0]}, __za.seen.mid[1] - ${m[1]}) < 0.75 && __za.seen.n === 2`, 5000);
    await b.ev(frames(2));
    const r = await b.ev(`(() => { const v = __za.views.${view}(); return { fov: v.fov(), drift: __za.drift(v, ${STAR.ra}, ${STAR.dec}, ${m[0]}, ${m[1]}) }; })()`);
    rows.push({ mid: m.map((q) => +q.toFixed(1)), finger_gap_px: +d.toFixed(1), fov: +r.fov.toPrecision(5), drift_px: +r.drift.toFixed(3) });
  }
  await b.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(700);
  const sel1 = await b.ev("JSON.stringify(__explore.state.selected?.pos || null)");
  const drifts = rows.map((r) => r.drift_px);
  allDrifts.push(...drifts);
  return { label, target, fov_from: +f0.toPrecision(5), drift_px: stats(drifts), pinch_counted_as_tap: sel0 !== sel1, steps: rows };
}

{
  const W = 390, H = 844;
  const b = await browser(withQuery(url, "engine=browser&hero=0"), { W, H, mobile: true });
  await boot(b, "!!(window.__explore && __explore.state.al && __explore.state.cats.length)");
  await sleep(4500);
  await b.ev(HELPERS);
  const rect = await b.ev(`JSON.stringify(document.getElementById('sky').getBoundingClientRect())`).then(JSON.parse);
  // 30% from the left, 42% from the top: higher up, a finger would land on the step hints (OL.steps)
  // that cover the top of the phone sky, and a finger on a panel is not part of the pinch.
  const mid = [Math.round(0.3 * rect.width), Math.round(0.42 * rect.height)];
  report.pinch_3d_phone = [
    await pinchRun(b, "aladin", { rect, mid0: mid, d0: 40, d1: 160, fov: 20, label: "pinch out (zoom in), midpoint fixed at 30%/42%" }),
    await pinchRun(b, "aladin", { rect, mid0: mid, d0: 160, d1: 40, fov: 5, label: "pinch in (zoom out), midpoint fixed at 30%/42%" }),
    await pinchRun(b, "aladin", { rect, mid0: mid, mid1: [Math.round(0.6 * rect.width), Math.round(0.5 * rect.height)], d0: 50, d1: 140, fov: 20, label: "pinch with a travelling midpoint" }),
  ];
  await b.shot("ZC_pinch_3d_phone.png");
  await b.close();
}

// ---- 5. Flat 2D fallback ----------------------------------------------------------------------
{
  const W = 1400, H = 900;
  const b = await browser(withQuery(url, "flat&engine=browser&hero=0"), { W, H });
  await boot(b, "!!(window.__explore && __explore.state.flat)");
  await sleep(500);
  await b.ev(`document.querySelector('.panel').style.display='none'; ${HELPERS}`);
  const rect = await b.ev(`JSON.stringify(document.getElementById('sky').getBoundingClientRect())`).then(JSON.parse);
  const x = Math.round(0.3 * rect.width), y = Math.round(0.3 * rect.height);
  report.wheel_flat = [];
  for (const fov of [100, 10, 0.5]) report.wheel_flat.push(await wheelRun(b, "flat", { fov, x, y, rect, label: `flat wheel from ${fov} deg` }));
  report.pinch_flat = [
    await pinchRun(b, "flat", { rect, mid0: [x, y], d0: 40, d1: 200, fov: 30, label: "flat pinch out (zoom in), midpoint fixed" }),
    await pinchRun(b, "flat", { rect, mid0: [x, y], d0: 200, d1: 40, fov: 5, label: "flat pinch in (zoom out), midpoint fixed" }),
    await pinchRun(b, "flat", { rect, mid0: [x, y], mid1: [Math.round(0.55 * rect.width), Math.round(0.5 * rect.height)], d0: 50, d1: 160, fov: 30, label: "flat pinch with a travelling midpoint" }),
  ];
  await b.shot("ZC_flat.png");
  await b.close();
}

const worst = Math.max(...allDrifts.filter(Number.isFinite));
report.worst_drift_px = +worst.toFixed(3);
report.all_drift_px = stats(allDrifts);
const taps = [...report.pinch_3d_phone, ...report.pinch_flat].some((r) => r.pinch_counted_as_tap);
const targets = [...report.wheel_3d, ...report.wheel_flat, ...report.pinch_3d_phone, ...report.pinch_flat]
  .every((r) => r.target && r.target.split(" ").every((t) => /^CANVAS/.test(t)));
report.pass = worst <= LIMIT_PX && !taps && targets && report.keyboard_plus_3d.about_centre && allDrifts.every(Number.isFinite);
const out = JSON.stringify(report, null, 1);
console.log(out);
if (jsonOut) writeFileSync(jsonOut, out);
process.exit(report.pass ? 0 : 1);
