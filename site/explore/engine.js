// Which engine builds the blink?
//   LOCAL:   local/serve.py on 127.0.0.1 (GET /api/health -> {ok:true, engine:"python"}) runs the job
//            in Python; we poll it, then show the products in ornek.html.
//   BROWSER: sky.html does everything in the page (the public GitHub Pages site).
//
// Local API (see local/serve.py):
//   POST   /api/jobs        {ra, dec, name?}  -> {id}
//   GET    /api/jobs/<id>   -> {state: queued|finding|downloading|processing|done|error,
//                               progress: {done, total, bytes}, message, result_url}
//   DELETE /api/jobs/<id>   cancel

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

export const engineLabel = (e) => (e.kind === "local" ? "Local Python engine" : "In-browser engine");

/**
 * Run one local job. Calls onUpdate(job) after every poll; resolves with the final job
 * ({state: "done", result_url} or {state: "error"|"cancelled"}). Returns {promise, cancel}.
 */
export function runLocalJob({ ra, dec, name, pmra, pmdec, epoch, force }, onUpdate, { interval = 1500 } = {}) {
  let id = null, stopped = false, timer = null;
  const promise = (async () => {
    const r = await fetch("/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ra, dec, ...(name ? { name } : {}),
        // Known proper motion (e.g. a star found by name) so the engine follows the star.
        ...(pmra != null && pmdec != null && epoch != null ? { pmra, pmdec, epoch } : {}),
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

const STATE_TEXT = {
  queued: "Waiting in line…",
  finding: "Finding SPHEREx images of this spot…",
  downloading: "Downloading SPHEREx images…",
  processing: "Lining up the seasons and building the blink…",
  done: "Done.",
  error: "Something went wrong.",
  cancelled: "Cancelled.",
};
export const stateText = (s) => STATE_TEXT[s] || s || "";

/** One-line summary of a finished job's meta.json (blink.py products), or null. */
export async function resultSummary(resultUrl) {
  try {
    const r = await fetch(resultUrl + "meta.json", { cache: "no-store" });
    if (!r.ok) return null;
    const m = await r.json();
    const ms = m.measured || {};
    const f = (x, d = 2) => Number(x).toFixed(d);
    if (ms.shift_arcsec != null) {
      let t = `Moved ${f(ms.shift_arcsec)}″ ± ${f(ms.shift_err_arcsec ?? 0)}″ between ${ms.from_epoch} and ${ms.to_epoch}`;
      if (ms.gaia_predicted_arcsec != null) t += ` (Gaia predicts ${f(ms.gaia_predicted_arcsec)}″)`;
      return { text: t + ".", meta: m };
    }
    const msg = ms.message || (ms.detection && ms.detection.message);
    return msg ? { text: msg, meta: m } : { text: `${(m.epochs || []).length} seasons ready.`, meta: m };
  } catch { return null; }
}
