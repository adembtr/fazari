// Which engine builds the blink?
//   LOCAL:   local/serve.py on 127.0.0.1 (GET /api/health -> {ok:true, engine:"python"}) runs the job
//            in Python; we poll it, then show the products in ornek.html.
//   BROWSER: sky.html does everything in the page (the public GitHub Pages site).
//
// Local API (see local/serve.py):
//   POST   /api/jobs        {ra, dec, name?, cutout_deg?, preview?: true} -> {id, cached, preview: {id, cached} | null}
//   GET    /api/jobs/<id>   -> {state: queued|finding|downloading|processing|done|error, mode: full|preview,
//                               progress: {done, total, bytes}, message, result_url, queue, eta_s, partial?}
//   DELETE /api/jobs/<id>   cancel
// The explorer asks for a quick preview first (the engine's fast lane: one wavelength, a few images
// per season, small regions) and shows it until the full result is done (runLocalPreviewJob).

import { t as T, tn as Tn, num as iNum, ptext as iPtext } from "../js/i18n.js";

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

/** Ask the local server whether it is there. Only on a local host (no 404 noise on the public site). */
export const isLocalHost = () => LOCAL_HOSTS.test(location.hostname);

export async function detectEngine({ force, timeout = 4000 } = {}) {
  if (force === "browser") return { kind: "browser" };
  if (force !== "local" && !isLocalHost()) return { kind: "browser" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);   // a busy engine can answer slowly
  try {
    const r = await fetch("/api/health", { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return { kind: "browser" };
    const j = await r.json();
    if (j && j.ok === true && j.engine === "python") return { kind: "local", info: j };
  } catch { /* no local server */ } finally { clearTimeout(timer); }
  return { kind: "browser" };
}

export const engineLabel = (e) => T(e.kind === "local" ? "ex.eng.local" : "ex.eng.browser");

/**
 * Run one local job. Calls onUpdate(job) after every poll; resolves with the final job
 * ({state: "done", result_url} or {state: "error"|"cancelled"}). Returns {promise, cancel}.
 */
export function runLocalJob({ ra, dec, name, pmra, pmdec, epoch, parallax, force }, onUpdate, { interval = 1500 } = {}) {
  let id = null, stopped = false, timer = null;
  const promise = (async () => {
    const r = await fetch("/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ra, dec, ...(name ? { name } : {}),
        // Known proper motion (e.g. a star found by name) so the engine follows the star.
        ...(pmra != null && pmdec != null && epoch != null ? { pmra, pmdec, epoch } : {}),
        ...(parallax > 0 ? { parallax } : {}),                     // mas, known distance (nearby star)
        ...(force ? { force: true } : {}),
      }),
    });
    if (!r.ok) throw new Error(`The local engine refused the job (HTTP ${r.status}).`);
    ({ id } = await r.json());
    if (!id) throw new Error("The local engine did not return a job id.");
    for (;;) {
      if (stopped) return { state: "cancelled" };
      let job;
      try {
        const q = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!q.ok) throw new Error(`HTTP ${q.status}`);
        job = await q.json();
      } catch (e) {
        job = { state: "error", message: `Lost contact with the local engine (${e.message}).` };
      }
      if (stopped) return { state: "cancelled" };
      onUpdate(job);
      if (job.state === "done" || job.state === "error" || job.state === "cancelled") return job;
      await new Promise((res) => { timer = setTimeout(res, interval); });
    }
  })();
  const cancel = async () => {
    stopped = true;
    clearTimeout(timer);
    if (id) { try { await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { /* ignore */ } }
  };
  return { promise, cancel };
}

const TERMINAL = new Set(["done", "error", "cancelled"]);

/**
 * Run a point on the local engine with a quick preview first: POST {..., preview: true} queues the
 * full job and, unless its result is cached, a preview in the engine's fast lane
 * (-> {id, cached, preview: {id, cached} | null}). Polls both (the preview every `fastInterval` ms
 * until it is finished) and calls onUpdate({full, preview}) after every poll; preview is null when
 * there is none. Resolves with the final full job. Returns {promise, cancel} (cancel stops both).
 */
export function runLocalPreviewJob({ ra, dec, name, pmra, pmdec, epoch, parallax, force, cutout_deg }, onUpdate,
                                   { interval = 1500, fastInterval = 400, after = null } = {}) {
  const ids = { full: null, preview: null };
  const fov = cutout_deg || (typeof window !== "undefined" && window.__fzFov ? window.__fzFov() : null);   // explore/fov_ui.js
  let stopped = false, timer = null;
  const get = async (id) => {
    try {
      const q = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!q.ok) throw new Error(`HTTP ${q.status}`);
      return await q.json();
    } catch (e) {
      return { state: "error", message: `Lost contact with the local engine (${e.message}).` };
    }
  };
  const promise = (async () => {
    if (after) { try { await after; } catch { /* ignore */ } }   // the previous job's cancel reached the engine
    if (stopped) return { state: "cancelled" };
    const r = await fetch("/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ra, dec, ...(name ? { name } : {}),
        ...(pmra != null && pmdec != null && epoch != null ? { pmra, pmdec, epoch } : {}),
        ...(parallax > 0 ? { parallax } : {}),                     // mas, known distance (nearby star)
        ...(force ? { force: true } : {}),
        ...(fov ? { cutout_deg: fov } : {}),                       // field of the full result (0.2-0.6 deg; else 0.4)
        preview: true,
      }),
    });
    if (!r.ok) throw new Error(`The local engine refused the job (HTTP ${r.status}).`);
    const sub = await r.json();
    ids.full = sub.id;
    ids.preview = sub.preview ? sub.preview.id : null;
    if (!ids.full) throw new Error("The local engine did not return a job id.");
    let pv = null;
    for (;;) {
      if (stopped) return { state: "cancelled" };
      const pvLive = ids.preview && !(pv && TERMINAL.has(pv.state));
      const [full, p2] = await Promise.all([get(ids.full), pvLive ? get(ids.preview) : Promise.resolve(pv)]);
      pv = p2;
      if (stopped) return { state: "cancelled" };
      onUpdate({ full, preview: pv, cached: !!sub.cached });
      if (TERMINAL.has(full.state)) return full;
      await new Promise((res) => { timer = setTimeout(res, pvLive ? fastInterval : interval); });
    }
  })();
  const cancel = async () => {
    stopped = true;
    clearTimeout(timer);
    await Promise.all([ids.preview, ids.full].filter(Boolean).map((id) =>
      fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null)));
  };
  return { promise, cancel };
}

/** "about 3 min" / "about 40 s" for a wait in seconds. */
export function fmtWait(s) {
  if (s == null || !Number.isFinite(s)) return "";
  return s >= 90 ? T("ex.eng.min", { n: Math.round(s / 60) }) : T("ex.eng.sec", { n: Math.max(5, Math.round(s / 5) * 5) });
}

/** One line on where a local job stands (queue position / progress / time left). */
export function jobLine(j) {
  if (!j) return "";
  const pr = j.progress || {};
  const q = j.queue || {};
  if (j.state === "queued") {
    return q.ahead ? Tn("ex.eng.queue", q.ahead, { wait: fmtWait(q.wait_s) }) : T("ex.eng.starting");
  }
  if (j.paused_for_preview && j.state === "downloading") return T("ex.eng.paused");
  const bits = [];
  if (j.state === "finding") bits.push(T("ex.eng.finding"));
  if (j.state === "downloading") bits.push(pr.total ? T("ex.eng.dl", { done: pr.done || 0, total: pr.total }) : T("ex.eng.dl0"));
  if (j.state === "processing") bits.push(pr.total ? T("ex.eng.meas", { done: pr.done || 0, total: pr.total }) : T("ex.eng.meas0"));
  if (pr.bytes) bits.push(`${(pr.bytes / 1048576).toFixed(0)} MB`);
  if (j.eta_s != null && j.state !== "finding") bits.push(T("ex.eng.left", { t: fmtWait(j.eta_s) }));
  return bits.join(" · ");
}

const STATE_TEXT = {
  queued: "Waiting in line…",
  finding: "Finding SPHEREx images of this spot…",
  downloading: "Downloading SPHEREx images…",
  processing: "Lining up the seasons and building the blink…",
  done: "Done.",
  error: "Something went wrong.",
  cancelled: "Cancelled.",
};
export const stateText = (s) => (STATE_TEXT[s] ? T("ex.eng.state." + s, null, STATE_TEXT[s]) : s || "");

/** One-line summary of a finished job's meta.json (blink.py products), or null. */
export async function resultSummary(resultUrl) {
  try {
    const r = await fetch(resultUrl + "meta.json", { cache: "no-store" });
    if (!r.ok) return null;
    const m = await r.json();
    const ms = m.measured || {};
    const f = (x, d = 2) => iNum(x, d);
    // images in the blink frames (all wavelength bins): the real count behind "Full result (N images)"
    const n = m.preview ? m.preview.n_images
      : (m.wavelength_bins || []).reduce((a, b) => a + (b.frames || []).reduce((s, fr) => s + (fr.n_images || 0), 0), 0);
    // plain-language sentence (js/explain.js, the same words as the viewer); the numbers below if it fails
    const plain = await import("../js/explain.js").then((x) => x.plainSentence(m)).catch(() => null);
    if (plain && plain.text) return { text: plain.text, meta: m, n };
    if (ms.shift_arcsec != null) {
      let t = T("ex.eng.moved", { s: f(ms.shift_arcsec), e: f(ms.shift_err_arcsec ?? 0), from: ms.from_epoch, to: ms.to_epoch });
      if (ms.gaia_predicted_arcsec != null) t += T("ex.eng.gaia", { g: f(ms.gaia_predicted_arcsec) });
      return { text: t + ".", meta: m, n };
    }
    const msg = ms.message || (ms.detection && ms.detection.message);
    return msg ? { text: iPtext(msg), meta: m, n } : { text: T("ex.eng.seasons", { n: (m.epochs || []).length }), meta: m, n };
  } catch { return null; }
}
