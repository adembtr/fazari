// Close-zoom check for explore.html (headless Chrome, no dependencies; Node 22+).
//
//   node site/explore/tests/closeup.mjs [url] --out DIR [--tag after] [--fovs 2,0.5,0.1,min] [--swiftshader]
//   url defaults to http://127.0.0.1:8765/explore.html
//
// For Barnard's Star (north, Pan-STARRS sky) and Epsilon Indi B (far south, DSS2 sky), at each field
// of view: set the view, wait until no map tile is loading, save a screenshot (DIR/Z_<tag>_<target>_<fov>.png),
// then pan slowly for 3 s and count frames. Prints JSON: tile count and load times per host, frames per
// second, the image layers with their opacity, and what the scale/legend box says. "min" = closest zoom.
// Uses the real GPU by default (frame rates mean little on the software renderer).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const outDir = opt("--out", ".");
const tag = opt("--tag", "after");
const fovs = opt("--fovs", "2,0.5,0.1,min").split(",");
const soft = flag("--swiftshader");
const url = args[0] || "http://127.0.0.1:8765/explore.html";
const W = 1400, H = 900;
const TARGETS = [{ id: "barnard", ra: 269.44627, dec: 4.76820 }, { id: "eps_indi_b", ra: 331.09665, dec: -56.80066 }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9500 + Math.floor(Math.random() * 300);
const prof = mkdtempSync(join(tmpdir(), "fz-cu-"));
const gl = soft ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=gl"];
const proc = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, ...gl,
  "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } try { rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ } };
process.on("exit", cleanup);

let list;
for (let i = 0; i < 80; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map();
const pendingTiles = new Map(); let tiles = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent" && /Norder\d+\/Dir\d+\/Npix/.test(m.params.request.url)) pendingTiles.set(m.params.requestId, { url: m.params.request.url, t0: m.params.timestamp });
  if ((m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") && pendingTiles.has(m.params.requestId)) {
    const r = pendingTiles.get(m.params.requestId); pendingTiles.delete(m.params.requestId);
    tiles.push({ host: new URL(r.url).host, ms: (m.params.timestamp - r.t0) * 1000, ok: m.method === "Network.loadingFinished", why: m.params.errorText || null });
  }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: url + (url.includes("?") ? "&" : "?") + "engine=browser&p=barnard" });
for (let i = 0; i < 150; i++) { if (await ev("!!(window.__explore && __explore.state.al && __explore.state.selected)").catch(() => false)) break; await sleep(200); }
await sleep(7000);                                               // opening flight

async function settle(maxMs = 25000) {                          // until no tile has been loading for 1.5 s
  const t0 = Date.now(); let quiet = Date.now(), last = -1;
  while (Date.now() - t0 < maxMs) {
    await sleep(250);
    if (pendingTiles.size === 0 && tiles.length === last) { if (Date.now() - quiet > 1500) break; } else quiet = Date.now();
    last = tiles.length;
  }
  return Date.now() - t0;
}

const renderer = await ev(`(() => { const c = document.createElement('canvas').getContext('webgl2'); const e = c && c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; })()`);
const report = { url, tag, renderer, viewport: [W, H], targets: {} };
for (const t of TARGETS) {
  report.targets[t.id] = {};
  await ev(`(() => { __explore.select(__explore.state.byId.get(${JSON.stringify(t.id)}), { fly: false }); return 1; })()`);
  await sleep(500);
  for (const f of fovs) {
    tiles = [];
    const fov = f === "min" ? 1e-4 : Number(f);                    // the explorer clamps to its closest zoom
    await ev(`(() => { const al = __explore.state.al; al.gotoRaDec(${t.ra}, ${t.dec}); al.setFoV(${fov}); return 1; })()`);
    const settle_ms = await settle();
    await sleep(800);
    const name = `Z_${tag}_${t.id}_${f === "min" ? "min" : f.replace(".", "p") + "deg"}.png`;
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, name), Buffer.from(shot.result.data, "base64"));
    const snap = tiles.slice();
    const hosts = {};
    for (const l of snap) {
      const h = hosts[l.host] ||= { tiles: 0, failed: 0, ms: [] };
      h.tiles++; if (l.ok) h.ms.push(l.ms); else { h.failed++; h.why = l.why; }
    }
    for (const h of Object.values(hosts)) { h.ms.sort((a, b) => a - b); h.median_ms = h.ms.length ? Math.round(h.ms[h.ms.length >> 1]) : null; h.max_ms = h.ms.length ? Math.round(h.ms[h.ms.length - 1]) : null; delete h.ms; }
    const view = await ev(`(() => { const al = __explore.state.al, t = (id) => { const e = document.getElementById(id); return !e || e.hidden ? null : e.textContent; };
      return { fov: +al.getFov()[0].toFixed(4), layers: al.getStackLayers().map((n) => { const l = al.getOverlayImageLayer(n); return \`\${(l.name || n)} @ \${l.getOpacity().toFixed(2)}\`; }),
        scale: t('scaleLbl'), spherex_pixel_box: t('scalePx') ? document.getElementById('scaleBox').style.width : null, image: t('scaleImg'), note: t('scaleMove') }; })()`);
    const fps = await ev(`(async () => { const al = __explore.state.al; const [ra0, dec0] = al.getRaDec(); const f = al.getFov()[0];
      const times = []; const t0 = performance.now();
      await new Promise((res) => { const step = (t) => { times.push(t); const k = (t - t0) / 3000;
        al.gotoRaDec(ra0 + f * 0.3 * Math.sin(k * Math.PI * 2) / Math.cos(dec0 * Math.PI / 180), dec0 + f * 0.15 * Math.sin(k * Math.PI * 4));
        if (t - t0 < 3000) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
      al.gotoRaDec(ra0, dec0); const d = times.slice(1).map((x, i) => x - times[i]).sort((a, b) => a - b);
      return { fps: +(1000 * (times.length - 1) / (times[times.length - 1] - times[0])).toFixed(1), p95_frame_ms: +d[Math.floor(d.length * 0.95)].toFixed(1) }; })()`);
    report.targets[t.id][f] = { screenshot: name, ...view, settle_ms, tiles: snap.length, by_host: hosts, ...fps };
    console.error(t.id, f, JSON.stringify(report.targets[t.id][f]));
  }
}
ws.close();
cleanup();
console.log(JSON.stringify(report, null, 1));
process.exit(0);
