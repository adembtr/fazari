// Coordinate round-trip test for explore.html (headless Chrome, no dependencies; Node 22+).
//
//   node site/explore/tests/roundtrip.mjs [url] [--chrome /usr/bin/google-chrome] [--json out.json]
//   url defaults to http://127.0.0.1:8765/explore.html (any server that serves site/ works)
//
// Everything is ICRS RA/Dec in degrees. Checks:
//  1. sky -> screen pixel -> sky through Aladin (world2pix / pix2world) for Barnard's Star,
//     Epsilon Indi B, Luhman 16 and 20 random points, at several fields of view (down to 0.05 deg),
//     with each point placed off-centre in the view;
//  2. the same through the real UI: a mouse click at the (rounded) pixel of the point fills the
//     coordinate box; box value vs the point (limited by the pixel size) and vs Aladin's value
//     at that pixel (limited only by the 5 decimals of the box);
//  3. typing a coordinate puts the marker and the view centre on it; nudging the typed value by
//     3.6" moves the marker by 3.6";
//  4. the 2D fallback (?flat) projection: sky -> pixel -> sky.
// Prints a JSON summary; exits 1 if any round trip is worse than 1".

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const chromeBin = opt("--chrome", "/usr/bin/google-chrome");
const jsonOut = opt("--json", null);
const url = args[0] || "http://127.0.0.1:8765/explore.html";
const W = 1400, H = 900;

const NAMED = [
  { name: "Barnard's Star", ra: 269.44627, dec: 4.76820 },
  { name: "Epsilon Indi B", ra: 331.09665, dec: -56.80066 },
  { name: "Luhman 16", ra: 162.3289, dec: -53.3194 },
];
let seed = 20261114;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const RANDOM = Array.from({ length: 20 }, (_, i) => ({ name: `random ${i + 1}`, ra: rand() * 360, dec: Math.asin(2 * rand() - 1) * 180 / Math.PI }));
const POINTS = [...NAMED, ...RANDOM];
const FOVS = [60, 10, 1, 0.2, 0.05];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, median: +s[Math.floor(s.length / 2)].toFixed(4), max: +s[s.length - 1].toFixed(4) }; };

async function browser(pageUrl) {
  const port = 9400 + Math.floor(Math.random() * 300);
  const prof = mkdtempSync(join(tmpdir(), "fz-rt-"));
  const proc = spawn(chromeBin, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--no-first-run", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
  let list;
  for (let i = 0; i < 60; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(200); } }
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
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: pageUrl });
  return { send, ev, close: () => { ws.close(); proc.kill(); } };
}

// Great-circle distance in arcsec (also defined in the page as __sep).
const SEP = `(a1,d1,a2,d2)=>{const r=Math.PI/180;const s=Math.sin((d2-d1)*r/2)**2+Math.cos(d1*r)*Math.cos(d2*r)*Math.sin((a2-a1)*r/2)**2;return 2*Math.asin(Math.min(1,Math.sqrt(s)))/r*3600;}`;

const report = { url, frame: "ICRS (Aladin cooFrame), HiPS frames equatorial", points: POINTS.length, fovs: FOVS };
let worst = 0;

// ---- 3D sky (Aladin) ---------------------------------------------------------------------------
{
  const b = await browser(url + (url.includes("?") ? "&" : "?") + "engine=browser&hero=0");   // hero=0: no opening overlay
  for (let i = 0; i < 100; i++) { if (await b.ev("!!(window.__explore && __explore.state.al && __explore.state.cats.length)")) break; await sleep(200); }
  await sleep(4000);                                            // let the opening animation finish
  await b.ev(`window.__sep = ${SEP}; document.querySelector('.panel').style.display='none'; 1`);
  report.frame_check = await b.ev(`(() => { const al = __explore.state.al; return { cooFrame: (al.getFrame ? al.getFrame() : al.view.cooFrame?.label) || null, projection: al.getProjectionName ? al.getProjectionName() : null }; })()`);

  // 1. math round trip through Aladin, point placed off-centre
  const math = {};
  for (const fov of FOVS) {
    const errs = [];
    for (const p of POINTS) {
      const r = await b.ev(`(async () => { const al = __explore.state.al; al.setFoV(${fov});
        const off = ${fov} * 0.18; const cd = Math.max(0.05, Math.cos(${p.dec} * Math.PI / 180));
        al.gotoRaDec((${p.ra} - off / cd + 360) % 360, Math.max(-89.9, Math.min(89.9, ${p.dec} + off * 0.6)));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const xy = al.world2pix(${p.ra}, ${p.dec}); if (!xy) return null;
        const back = al.pix2world(xy[0], xy[1]); return { xy, err: __sep(${p.ra}, ${p.dec}, back[0], back[1]) }; })()`);
      if (r) errs.push(r.err);
    }
    math[`fov_${fov}`] = stats(errs);
    worst = Math.max(worst, math[`fov_${fov}`].max);
  }
  report.sky_to_pixel_to_sky_arcsec = math;

  // 2. the real UI: click at the rounded pixel, read the coordinate box
  const ui = {};
  for (const fov of [1, 0.2, 0.05]) {
    const vsAladin = [], vsPoint = [];
    let pxScale = null;
    for (const p of NAMED) {
      const xy = await b.ev(`(async () => { const al = __explore.state.al; al.setFoV(${fov});
        al.gotoRaDec(${p.ra} + ${fov} * 0.1, ${p.dec} - ${fov} * 0.1);
        await new Promise((r) => setTimeout(r, 300)); return al.world2pix(${p.ra}, ${p.dec}); })()`);
      const x = Math.round(xy[0]), y = Math.round(xy[1]);
      const rect = await b.ev(`JSON.stringify(document.getElementById('sky').getBoundingClientRect())`).then(JSON.parse);
      for (const type of ["mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type, x: rect.x + x, y: rect.y + y, button: "left", clickCount: 1 });
      await sleep(250);
      const r = await b.ev(`(() => { const al = __explore.state.al; const box = document.getElementById('q').value.trim().split(/\\s+/).map(Number);
        const at = al.pix2world(${x}, ${y}); const sc = al.getFov()[0] / document.getElementById('sky').clientWidth * 3600;
        return { box, vsAladin: __sep(box[0], box[1], at[0], at[1]), vsPoint: __sep(box[0], box[1], ${p.ra}, ${p.dec}), sc }; })()`);
      vsAladin.push(r.vsAladin); vsPoint.push(r.vsPoint); pxScale = r.sc;
    }
    ui[`fov_${fov}`] = { pixel_arcsec: +pxScale.toFixed(3), box_vs_aladin_at_pixel: stats(vsAladin), box_vs_point: stats(vsPoint) };
    worst = Math.max(worst, ui[`fov_${fov}`].box_vs_aladin_at_pixel.max);
  }
  report.click_fills_box_arcsec = ui;

  // 3. typed coordinates: marker and view centre; small nudge moves the marker a little
  const typed = [];
  for (const p of NAMED) {
    const t = `${p.ra.toFixed(5)} ${p.dec >= 0 ? "+" : ""}${p.dec.toFixed(5)}`;
    const r = await b.ev(`(async () => { document.getElementById('q').value = ${JSON.stringify(t)};
      document.getElementById('search').requestSubmit(); await new Promise((r) => setTimeout(r, 6500));
      const al = __explore.state.al, s = __explore.state.selected.pos, c = al.getRaDec();
      const src = __explore.state.selCat.getSources()[0];
      const m1 = al.world2pix(src.ra, src.dec);
      document.getElementById('q').value = ${JSON.stringify(`${p.ra.toFixed(5)} ${(p.dec + 0.001) >= 0 ? "+" : ""}${(p.dec + 0.001).toFixed(5)}`)};
      document.getElementById('search').requestSubmit(); await new Promise((r) => setTimeout(r, 6500));
      // both positions in the same (final) view
      const src2 = __explore.state.selCat.getSources()[0], m2 = al.world2pix(src2.ra, src2.dec), m1b = al.world2pix(${p.ra}, ${p.dec});
      const sc = al.getFov()[0] / document.getElementById('sky').clientWidth * 3600;
      return { marker_vs_typed: __sep(src.ra, src.dec, ${p.ra}, ${p.dec}), centre_vs_typed: __sep(c[0], c[1], ${p.ra}, ${p.dec}),
        nudge_marker_moved_arcsec: __sep(src.ra, src.dec, src2.ra, src2.dec),
        nudge_marker_moved_px: m1b && m2 ? Math.hypot(m2[0] - m1b[0], m2[1] - m1b[1]) : null, px_arcsec: sc }; })()`);
    typed.push({ name: p.name, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? v : +v.toFixed(4)])) });
    worst = Math.max(worst, r.marker_vs_typed, r.centre_vs_typed);
  }
  report.typed_coordinate = typed;
  b.close();
}

// ---- 2D fallback (?flat) ----------------------------------------------------------------------
{
  const b = await browser(url + (url.includes("?") ? "&" : "?") + "flat&engine=browser&hero=0");
  for (let i = 0; i < 100; i++) { if (await b.ev("!!(window.__explore && __explore.state.flat)")) break; await sleep(200); }
  await b.ev(`window.__sep = ${SEP}; 1`);
  const flat = {};
  for (const fov of [120, 10, 1, 0.5]) {
    const errs = [];
    for (const p of POINTS) {
      const r = await b.ev(`(() => { const f = __explore.state.flat; f.goTo(${p.ra} - ${fov} * 0.2, ${p.dec} * 0.98, ${fov});
        const xy = f.toPixel(${p.ra}, ${p.dec}); if (!xy) return null; const q = f.toSky(xy[0], xy[1]);
        return __sep(${p.ra}, ${p.dec}, q.ra, q.dec); })()`);
      if (r != null) errs.push(r);
    }
    flat[`fov_${fov}`] = stats(errs);
    worst = Math.max(worst, flat[`fov_${fov}`].max);
  }
  report.fallback_sky_to_pixel_to_sky_arcsec = flat;
  b.close();
}

report.worst_arcsec = +worst.toFixed(4);
report.pass = worst < 1;
const out = JSON.stringify(report, null, 1);
console.log(out);
if (jsonOut) writeFileSync(jsonOut, out);
process.exit(report.pass ? 0 : 1);
