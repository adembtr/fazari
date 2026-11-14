// Runs sky.html in headless Chrome and prints the JSON the page writes into #result.
//   node site/js/tests/headless_check.mjs "target=barnard&all=1" [timeout_s]
// Serves site/ with `python3 -m http.server` on a free port, drives Chrome over the DevTools
// protocol (Node 22 global WebSocket), polls #result[data-state] until done/error.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, "../..");
const query = process.argv[2] || "target=barnard";
const timeoutS = Number(process.argv[3] || 600);
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const httpPort = await freePort();
const cdpPort = await freePort();
const server = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: SITE, stdio: "ignore" });
const profile = mkdtempSync(resolve(process.env.TMPDIR || tmpdir(), "skyblink-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "about:blank"], {
  stdio: ["ignore", "ignore", process.env.CHROME_LOG ? "inherit" : "ignore"],
  // Chrome puts a unix socket in TMPDIR; a long TMPDIR path makes it abort ("Socket path too long")
  env: { ...process.env, TMPDIR: (process.env.TMPDIR || "").length > 60 ? "/tmp" : process.env.TMPDIR || "/tmp" },
});
const cleanup = () => { try { chrome.kill("SIGTERM"); } catch (_) {} try { server.kill("SIGTERM"); } catch (_) {} };
process.on("exit", cleanup);

let ws;
try {
  let targets;
  for (let i = 0; i < 150; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch (_) {}
    await sleep(200);
  }
  if (!targets || !targets.some((t) => t.type === "page")) throw new Error("Chrome did not start (no page target)");
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled") consoleLines.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    if (m.method === "Runtime.exceptionThrown") consoleLines.push("EXCEPTION " + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  const send = (method, params = {}) => new Promise((r) => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
  await send("Runtime.enable");
  await send("Performance.enable");
  await send("Page.enable");
  if (process.env.PHONE) {   // iPhone-sized touch device
    await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 3, mobile: true });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  // main-thread responsiveness probe: longest gap between animation frames, long tasks
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__perf = { maxGap: 0, ticks: 0, longTasks: 0, longTotal: 0, longMax: 0 };
    (() => { let last = performance.now();
      const tick = (t) => { const g = t - last; if (g > window.__perf.maxGap && window.__perf.ticks > 2) window.__perf.maxGap = g;
        last = t; window.__perf.ticks++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { const p = window.__perf; p.longTasks++; p.longTotal += e.duration; p.longMax = Math.max(p.longMax, e.duration); } })
        .observe({ type: "longtask", buffered: true }); } catch (_) {}
    })();` });
  const url = `http://127.0.0.1:${httpPort}/sky.html?${query}`;
  console.error("open", url);
  const tStart = Date.now();
  await send("Page.navigate", { url });
  let state = "", lastLog = 0, cancelled = false;
  while ((Date.now() - tStart) / 1000 < timeoutS) {
    await sleep(1000);
    const r = await send("Runtime.evaluate", { expression: "JSON.stringify([document.getElementById('result')?.dataset.state, document.getElementById('status')?.textContent, document.getElementById('progress')?.textContent])", returnByValue: true });
    const [st, status, prog] = JSON.parse(r.result.result.value || "[]");
    state = st;
    if (Date.now() - lastLog > 10000) { console.error(`[${((Date.now() - tStart) / 1000).toFixed(0)} s] ${status} | ${prog}`); lastLog = Date.now(); }
    if (process.env.CANCEL_AT && !cancelled && (Date.now() - tStart) / 1000 >= Number(process.env.CANCEL_AT)) {
      cancelled = true;
      const before = await send("Runtime.evaluate", { expression: "document.getElementById('progress').textContent", returnByValue: true });
      await send("Runtime.evaluate", { expression: "document.getElementById('cancel').click()" });
      console.error("clicked Cancel at", process.env.CANCEL_AT, "s:", before.result.result.value);
      await sleep(3000);
      const after = await send("Runtime.evaluate", { expression: "JSON.stringify([document.getElementById('status').textContent, document.getElementById('progress').textContent, document.getElementById('cancel').hidden])", returnByValue: true });
      console.error("3 s after Cancel:", after.result.result.value);
      await sleep(3000);
      const after2 = await send("Runtime.evaluate", { expression: "document.getElementById('progress').textContent", returnByValue: true });
      console.error("6 s after Cancel:", after2.result.result.value);
      break;
    }
    if (state === "done" || state === "error") break;
  }
  const perf = await send("Runtime.evaluate", { expression: "JSON.stringify({ ...window.__perf, firstFrameMs: window.__firstFrameMs })", returnByValue: true });
  const metrics = await send("Performance.getMetrics");
  const M = Object.fromEntries(metrics.result.metrics.map((m) => [m.name, m.value]));
  console.error("perf:", perf.result.result.value, `| main-thread JS heap used ${(M.JSHeapUsedSize / 1e6).toFixed(1)} MB of ${(M.JSHeapTotalSize / 1e6).toFixed(1)} MB`);
  if (process.env.SHOT) {   // optional full-page screenshot (PNG) for a visual check
    const { writeFileSync } = await import("node:fs");
    const w = Number(process.env.SHOT_WIDTH || 800);
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: 3000, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(1500);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, "base64"));
  }
  const r = await send("Runtime.evaluate", { expression: "document.getElementById('result').textContent", returnByValue: true });
  const status = await send("Runtime.evaluate", { expression: "document.getElementById('status').textContent + ' | ' + document.getElementById('progress').textContent", returnByValue: true });
  console.error("final:", status.result.result.value);
  if (consoleLines.length) console.error("console:\n  " + consoleLines.slice(-15).join("\n  "));
  console.log(r.result.result.value);
  console.error(`wall time ${((Date.now() - tStart) / 1000).toFixed(1)} s, state ${state}`);
} finally {
  try { ws && ws.close(); } catch (_) {}
  cleanup();
}
process.exit(0);
