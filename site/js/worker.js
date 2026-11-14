// Module Web Worker: all heavy work of sky.html runs here (S3 Range reads, RICE decoding,
// reprojection, median stacking, centroids, Gaia calibration). The page only draws.
// Protocol (postMessage):
//   in : {type: "init", ra, dec, target, images, config, cacheBytes}
//        {type: "loadBin", id, um}     {type: "loadPreview", id, um, opts}     {type: "cancel"}
//   out: {type: "ready", session}      {type: "progress", id, progress}
//        {type: "net", stats}           {type: "status", message}
//        {type: "result", id, result, astrometry}   {type: "error", id, message, aborted}
import { SkySession } from "./sky.js";
import { stats, events, setCacheLimit, resetStats, clearCache, setMaxParallel, MAX_PARALLEL } from "./net.js";
import { summarize, slimAstrometry } from "./engine_common.js";

let session = null;
let ctl = null;
let lastNet = 0;

events.addEventListener("progress", () => {
  const now = Date.now();
  if (now - lastNet < 150) return;
  lastNet = now;
  postMessage({ type: "net", stats: { ...stats } });
});
events.addEventListener("status", (e) => postMessage({ type: "status", message: e.detail.message }));

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      ctl = new AbortController();
      if (m.cacheBytes) setCacheLimit(m.cacheBytes);
      clearCache(); resetStats();
      session = new SkySession({ ra: m.ra, dec: m.dec, target: m.target, images: m.images, config: m.config, signal: ctl.signal });
      postMessage({ type: "ready", session: summarize(session) });
    } else if (m.type === "loadPreview") {          // quick look: 6 requests in flight (a browser's per-host limit)
      setMaxParallel(6);
      const result = await session.loadPreview(m.um, m.opts || {}, (p) => postMessage({ type: "progress", id: m.id, progress: p }));
      postMessage({ type: "net", stats: { ...stats } });
      postMessage({ type: "result", id: m.id, result: slimResult(result), astrometry: null });
    } else if (m.type === "loadBin") {
      setMaxParallel(MAX_PARALLEL);
      const result = await session.loadBin(m.um, (p) => postMessage({ type: "progress", id: m.id, progress: p }));
      postMessage({ type: "net", stats: { ...stats } });
      postMessage({ type: "result", id: m.id, result: slimResult(result), astrometry: slimAstrometry(session.astrometry()) });
    } else if (m.type === "spectrum") {             // spectrum.js: the loaded exposures, format fazari-spectrum/1
      const { spectrumForSession } = await import("./spectrum.js");
      const spec = await spectrumForSession(session, { onProgress: (p) => postMessage({ type: "progress", id: m.id, progress: p }) });
      postMessage({ type: "result", id: m.id, result: spec, astrometry: null });
    } else if (m.type === "cancel") {
      if (ctl) ctl.abort();
      postMessage({ type: "cancelled" });
    }
  } catch (e) {
    postMessage({ type: "error", id: m.id, message: e.message || String(e), aborted: e.name === "AbortError" || (ctl && ctl.signal.aborted) });
  }
};

function slimResult(r) {
  return {
    um: r.um, det: r.det, n: r.n, stretch: r.stretch, diff: r.diff, preview: r.preview, prelim: r.prelim,
    frames: r.frames.map((f) => ({ season: f.season, norm: f.norm, n: f.n, detectors: f.detectors, lam: f.lam, lams: f.lams,
                                  mjdMean: f.mjdMean, date: f.date, dateFirst: f.dateFirst, dateLast: f.dateLast, gaiaXY: f.gaiaXY,
                                  softCorePx: f.softCorePx })),
  };
}
