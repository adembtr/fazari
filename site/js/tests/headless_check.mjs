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
  const url = `http://127.0.0.1:${httpPort}/sky.html?${query}`;
  console.error("open", url);
  const tStart = Date.now();
  await send("Page.navigate", { url });
  let state = "", lastLog = 0;
  while ((Date.now() - tStart) / 1000 < timeoutS) {
    await sleep(1000);
    const r = await send("Runtime.evaluate", { expression: "JSON.stringify([document.getElementById('result')?.dataset.state, document.getElementById('status')?.textContent, document.getElementById('progress')?.textContent])", returnByValue: true });
    const [st, status, prog] = JSON.parse(r.result.result.value || "[]");
    state = st;
    if (Date.now() - lastLog > 10000) { console.error(`[${((Date.now() - tStart) / 1000).toFixed(0)} s] ${status} | ${prog}`); lastLog = Date.now(); }
    if (state === "done" || state === "error") break;
  }
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
