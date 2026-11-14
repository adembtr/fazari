// Headless check of the blink viewer's plain sentence, "What you are seeing" strip and manual marking.
//   node site/js/tests/viewer_check.mjs [site_url] [--job <id>] [--shots <dir>] [--chrome /usr/bin/google-chrome]
// site_url: a server that serves site/ (default http://127.0.0.1:8765, the local engine; nothing is
// started or stopped). Opens ornek.html for the five targets (and one engine job with --job, or the
// first finished job of GET /api/jobs), then on Barnard's Star and the job: Mark something -> click
// the Gaia marker -> type + note -> Save -> reload (kept) -> Export JSON (downloaded file checked)
// -> Clear. Then again with localStorage blocked (every access throws). Fails on page exceptions.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : d; };
const CHROME = opt("--chrome", "/usr/bin/google-chrome");
const SHOTS = opt("--shots", null);
let JOB = opt("--job", null);
const SITE = (args[0] || "http://127.0.0.1:8765").replace(/\/$/, "");
const tag = (label) => label.replace(/^job /, "job_").replace(/[^\w.-]+/g, "_").replace(/_+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

const fails = [];
const check = (c, msg) => { if (!c) { fails.push(msg); console.log("  FAIL " + msg); } };
const tmpBase = (process.env.TMPDIR || "").length > 60 ? "/tmp" : process.env.TMPDIR || tmpdir();
const profile = mkdtempSync(join(tmpBase, "fz-viewer-chrome-"));
const dl = mkdtempSync(join(tmpBase, "fz-viewer-dl-"));
const cdpPort = await freePort();
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "about:blank"],
{ stdio: "ignore", env: { ...process.env, TMPDIR: tmpBase } });
const chromeExit = new Promise((r) => chrome.once("exit", r));
const rmTemp = () => { for (const d of [profile, dl]) try { rmSync(d, { recursive: true, force: true }); } catch (_) {} };
// Chrome writes into its profile while it shuts down: wait for it to exit, then remove the temp folders
const cleanup = async () => {
  try { chrome.kill("SIGTERM"); } catch (_) {}
  await Promise.race([chromeExit, sleep(5000)]);
  rmTemp();
};
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch (_) {} rmTemp(); });

let ws, id = 0;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((r) => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result && r.result.result ? r.result.result.value : undefined;
};
async function waitFor(expr, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(150); }
  return false;
}
async function open(url) {
  await send("Page.navigate", { url });
  return waitFor(`!!(document.getElementById("explainSentence") && document.getElementById("fzmToggle") && document.getElementById("frame").complete && document.getElementById("frame").naturalWidth)`);
}
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const h = await ev(`Math.ceil(document.documentElement.scrollHeight)`);
  await send("Emulation.setDeviceMetricsOverride", { width: 820, height: Math.min(h, 4000), deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const r = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 1100, deviceScaleFactor: 1, mobile: false });
  console.log("  shot " + join(SHOTS, name));
}
async function clickAt(x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

async function sentence(label, url) {
  check(await open(url), `${label}: page did not load`);
  await sleep(500);
  const s = await ev(`({ text: document.getElementById("explainSentence").innerText, items: [...document.querySelectorAll("#explainStrip li")].map(l => l.dataset.key) })`);
  console.log(`${label}: ${s.text.replace(/\n/g, "  [")}${s.text.includes("\n") ? "]" : ""}\n  strip: ${s.items.join(", ")}`);
  check(s.text && s.text.length > 20, `${label}: no sentence`);
  check(!/discover/i.test(s.text), `${label}: says discover`);
  check(s.items.includes("blink"), `${label}: no blink item`);
  return s;
}

async function marking(label, url, blocked) {
  check(await open(url), `${label}: page did not load`);
  await sleep(300);
  const mk = await ev(`fetch(new URLSearchParams(location.search).get("data") + "meta.json").then(r => r.json()).then(m => ({ mk: (m.markers || [])[0], grid: m.grid }))`);
  await ev(`document.getElementById("fzmToggle").click()`);
  check(await ev(`document.getElementById("fzmToggle").getAttribute("aria-pressed") === "true"`), `${label}: toggle`);
  // the screen position of the first Gaia marker -> click it
  const [px, py] = mk.mk.png_xy;
  const xy = await ev(`(() => { const r = document.getElementById("zoomer").getBoundingClientRect();
    return [r.left + ${px} / ${mk.grid.png_px[0]} * r.width, r.top + ${py} / ${mk.grid.png_px[1]} * r.height]; })()`);
  await clickAt(xy[0], xy[1]);
  await sleep(200);
  check(await ev(`!!document.getElementById("fzmForm")`), `${label}: no form after click`);
  await ev(`document.querySelector('input[name=fzmType][value=brightness]').click()`);
  await ev(`(() => { const n = document.getElementById("fzmNote"); n.value = "test mark near the target"; n.dispatchEvent(new Event("input")); })()`);
  if (SHOTS) await shot(`U_marking_form_${tag(label)}.png`);
  await ev(`document.getElementById("fzmSave").click()`);
  await sleep(200);
  const st = await ev(`(() => { let s = null; try { s = localStorage.getItem("fazari.myCandidates.v1"); } catch (e) { s = "BLOCKED"; }
    return { s, rows: document.querySelectorAll("#fzmList li").length, here: document.querySelectorAll("#fzmList li.here").length,
      rings: document.querySelectorAll("#fzmOv circle[stroke='#7fd4ff']").length, warn: !!document.querySelector("#fzmPanel .warn") }; })()`);
  check(st.rows === 1 && st.here === 1 && st.rings === 1, `${label}: list/ring ${JSON.stringify(st)}`);
  if (blocked) check(st.s === "BLOCKED" && st.warn, `${label}: blocked storage not reported`);
  else {
    const arr = JSON.parse(st.s || "[]");
    const m = arr[0] || {};
    const d = Math.hypot((m.ra - mk.mk.ra) * Math.cos(mk.mk.dec * Math.PI / 180), m.dec - mk.mk.dec) * 3600;
    console.log(`  saved: RA ${m.ra} Dec ${m.dec} (${d.toFixed(2)}″ from the marker) type ${m.type} season ${m.season} ${m.wavelength_um} µm field ${JSON.stringify(m.field)}`);
    check(arr.length === 1 && d < 1.5, `${label}: saved position ${d}″ off`);
    for (const k of ["ra", "dec", "type", "note", "season", "wavelength_um", "marked_at", "field", "target"]) check(k in m, `${label}: entry lacks ${k}`);
    check(m.type === "brightness" && m.note === "test mark near the target", `${label}: type/note`);
    // reload: kept, ring drawn again
    check(await open(url), `${label}: reload`);
    await sleep(300);
    check(await ev(`document.querySelectorAll("#fzmList li.here").length === 1 && document.querySelectorAll("#fzmOv circle[stroke='#7fd4ff']").length === 1`), `${label}: not kept after reload`);
  }
  if (SHOTS) await shot(`U_marking_list_${tag(label)}.png`);
  // export
  for (const f of readdirSync(dl)) rmSync(join(dl, f));
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dl });
  await ev(`document.getElementById("fzmExport").click()`);
  let file = null;
  for (let i = 0; i < 40 && !file; i++) { await sleep(150); file = readdirSync(dl).find((f) => f.endsWith(".json")); }
  check(file, `${label}: no export file`);
  if (file) {
    const doc = JSON.parse(readFileSync(join(dl, file), "utf8"));
    console.log(`  export ${file}: schema ${doc.schema}, ${doc.n} candidate(s)`);
    check(doc.schema === "fazari-my-candidates/1" && doc.candidates.length === 1, `${label}: export content`);
  }
  // clear (two clicks)
  await ev(`document.getElementById("fzmClear").click()`);
  check(await ev(`/Click again/.test(document.getElementById("fzmClear").textContent)`), `${label}: clear not armed`);
  await ev(`document.getElementById("fzmClear").click()`);
  await sleep(100);
  const after = await ev(`(() => { let s; try { s = localStorage.getItem("fazari.myCandidates.v1"); } catch (e) { s = "BLOCKED"; }
    return { s, rows: document.querySelectorAll("#fzmList li").length, rings: document.querySelectorAll("#fzmOv circle[stroke='#7fd4ff']").length }; })()`);
  check(after.rows === 0 && after.rings === 0 && (blocked ? after.s === "BLOCKED" : after.s === null), `${label}: clear ${JSON.stringify(after)}`);
}

try {
  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); if (targets.some((t) => t.type === "page")) break; } catch (_) {}
    await sleep(150);
  }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type))
      errors.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 1100, deviceScaleFactor: 1, mobile: false });

  if (!JOB) {
    const jobs = (await (await fetch(SITE + "/api/jobs")).json()).jobs.filter((j) => j.state === "done");
    JOB = (jobs.find((j) => /not detected/i.test(j.message || "")) || jobs[0] || {}).id;
  }
  const pages = ["barnard", "eps_indi_b", "wise0855", "rw_aur", "r_dra"].map((t) => [t, `${SITE}/ornek.html?data=data/${t}/`]);
  if (JOB) pages.push([`job ${JOB}`, `${SITE}/ornek.html?data=/jobs/${JOB}/`]);
  for (const [label, url] of pages) {
    await sentence(label, url);
    await shot(`U_explain_${tag(label)}.png`);
  }
  console.log("marking: Barnard's Star");
  await marking("barnard", pages[0][1], false);
  if (JOB) { console.log(`marking: job ${JOB}`); await marking(`job ${JOB}`, pages[pages.length - 1][1], false); }

  // localStorage blocked: every access throws (as with blocked site data)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });` });
  console.log("localStorage blocked:");
  await sentence("barnard (no storage)", pages[0][1]);
  await marking("barnard (no storage)", pages[0][1], true);
  if (errors.length) console.log("page errors/warnings:\n  " + errors.join("\n  "));
  check(!errors.some((e) => !/^warning:/.test(e)), "page exceptions");
} catch (e) {
  fails.push("crash: " + (e.stack || e));
} finally {
  try { ws && ws.close(); } catch (_) {}
  await cleanup();
}
if (fails.length) { console.error("FAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("OK");
