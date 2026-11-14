// Offline test of site/js/progressive.js (wavelength-by-wavelength loading) with a fake session: no network.
//   node site/js/tests/pg_test.mjs   -> prints the bin events, ETA rows, captions and results; 4.6 um fails once and is retried.
import * as P from "../progressive.js";
const n = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail46 = true;
const mk = (um, det, ns) => ({ um, det, nSeasons: ns, available: true, candidates: { a: [1, 2, 3], b: [1, 2, 3] } });
const session = { n, cfg: { cap: 3 }, target: null, exposures: [], bins: [mk(2.0, "D3", 2), mk(4.6, "D6", 2), mk(3.0, "D4", 2)],
  async loadBin(um, prog) {
    for (let i = 1; i <= 6; i++) { await sleep(500); prog({ done: i }); }
    if (um === 4.6 && fail46) { fail46 = false; throw new Error("network down"); }
    return { um, frames: [{ season: "a", n: 3, norm: new Float32Array(n * n).fill(0.5) }, { season: "b", n: 3, norm: new Float32Array(n * n).fill(0.2) }] };
  },
  astrometry() { return { positions: [], pairs: [] }; } };
const ev = [];
const post = (m) => { ev.push(m); if (m.type === "bin" && m.um === 4.6 && m.state === "failed") console.log("failed 4.6 ->", "prioritize:", P.prioritize(4.6)); };
const r = await P.runAll(session, 1, {}, post, (x) => ({ um: x.um }));
console.log("bins events", ev.filter((m) => m.type === "bin").map((m) => m.um + ":" + m.state).join(" "));
const eta = ev.filter((m) => m.type === "eta" && m.bins);
console.log("eta with bins", eta.length, JSON.stringify(eta.map((m) => m.bins.map((b) => b.um + "=" + b.done + "/" + b.total + b.state[0]).join(","))));
const c = ev.find((m) => m.type === "composite"); console.log("caption", !!c.caption_en, !!c.caption_tr);
console.log("results", Object.keys(r.results));
