// Offline test of gaia.js raceMirrors (tarayici_olcum, 14 Nov 2026): mirrors asked at once, first good answer
// wins, losers aborted, an all-fail round retried, an outage thrown (never an empty star list).
// Run: node site/js/tests/gaia_race_test.mjs
import { raceMirrors, RACE } from "../gaia.js";

RACE.roundMs = [300, 600]; RACE.pauseMs = 50;
const M = ["https://a.test/x", "https://b.test/x", "https://c.test/x"];
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };

// behaviour per host: {ms, status, body} or "hang"
function fake(beh, log) {
  return (url, { signal }) => new Promise((resolve, reject) => {
    const h = new URL(url).host[0], b = beh[h];
    log.push(`start ${h}`);
    signal.addEventListener("abort", () => { log.push(`abort ${h}`); reject(new DOMException("aborted", "AbortError")); });
    if (b === "hang") return;
    setTimeout(() => resolve({ ok: b.status === 200, status: b.status, text: async () => b.body }), b.ms);
  });
}
const parse = (t) => (t.startsWith("ROWS") ? t : new Error("unexpected answer"));

{
  const log = [], t0 = Date.now();
  const v = await raceMirrors("q", parse, { mirrors: M, fetchFn: fake({ a: { ms: 200, status: 200, body: "ROWS a" }, b: { ms: 30, status: 200, body: "ROWS b" }, c: "hang" }, log) });
  const dt = Date.now() - t0;
  ok(v === "ROWS b" && dt < 150, `fastest wins (${v}, ${dt} ms)`);
  ok(log.includes("abort a") && log.includes("abort c"), "losers aborted");
  ok(["start a", "start b", "start c"].every((s) => log.indexOf(s) < 3), "all asked at once");
}
{
  const log = [];
  const v = await raceMirrors("q", parse, { mirrors: M, fetchFn: fake({ a: { ms: 10, status: 502, body: "" }, b: { ms: 10, status: 200, body: "<html>Page unavailable" }, c: { ms: 120, status: 200, body: "ROWS c" } }, log) });
  ok(v === "ROWS c", "502 and an HTML page are not answers; the slow good one wins");
}
{
  // first round: all fail; second round: a answers
  let n = 0; const log = [];
  const f = (url, o) => { n++; return fake(n <= 3 ? { a: "hang", b: { ms: 5, status: 502 }, c: { ms: 5, status: 500 } } : { a: { ms: 5, status: 200, body: "ROWS a" }, b: "hang", c: "hang" }, log)(url, o); };
  const t0 = Date.now();
  const v = await raceMirrors("q", parse, { mirrors: M, fetchFn: f });
  ok(v === "ROWS a" && n === 6, `retried after an all-fail round (${Date.now() - t0} ms, ${n} requests)`);
}
{
  const log = [];
  let err = null;
  try { await raceMirrors("q", parse, { mirrors: M, fetchFn: fake({ a: "hang", b: "hang", c: { ms: 5, status: 502 } }, log) }); } catch (e) { err = e; }
  ok(err && /no answer/.test(err.message) && /HTTP 502/.test(err.message), `outage thrown, not an empty list (${err && err.message})`);
}
{
  const ctl = new AbortController(), log = [];
  setTimeout(() => ctl.abort(), 40);
  let err = null;
  try { await raceMirrors("q", parse, { mirrors: M, signal: ctl.signal, fetchFn: fake({ a: "hang", b: "hang", c: "hang" }, log) }); } catch (e) { err = e; }
  ok(err && err.name === "AbortError" && log.filter((s) => s.startsWith("abort")).length === 3, "caller abort aborts every request");
}
{
  const log = [];
  const v = await raceMirrors("q", (t) => (t.startsWith("#Column\tRA_ICRS\t") ? [] : new Error("x")), { mirrors: M, fetchFn: fake({ a: { ms: 5, status: 200, body: "#Column\tRA_ICRS\t..." }, b: "hang", c: "hang" }, log) });
  ok(Array.isArray(v) && v.length === 0, "a real empty answer (VizieR #Column lines only) is an empty list");
}
console.log(fails ? `${fails} FAILED` : "OK");
process.exit(fails ? 1 : 0);
