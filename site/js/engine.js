// Runs a SkySession in a module Web Worker (worker.js), so the page never freezes. Falls back
// to the main thread when module workers are not available. Cancel aborts the in-flight
// fetches (AbortController in the worker), then terminates the worker.
import { summarize, slimAstrometry } from "./engine_common.js";

export function workersSupported() {
  if (typeof Worker === "undefined") return false;
  // module worker support test (Chrome 80+, Safari 15+, Firefox 114+)
  let ok = false;
  try {
    const opts = { get type() { ok = true; return "module"; } };
    new Worker("data:,", opts).terminate();
  } catch (_) { /* ignore */ }
  return ok;
}

export class Engine {
  constructor({ useWorker = workersSupported(), onNet = () => {}, onStatus = () => {} } = {}) {
    this.useWorker = useWorker;
    this.onNet = onNet; this.onStatus = onStatus;
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
  }

  async init(args) {
    if (this.useWorker) {
      try {
        this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      } catch (e) {
        this.useWorker = false;
      }
    }
    if (this.useWorker) {
      this.worker.onmessage = (ev) => this._onMessage(ev.data);
      this.worker.onerror = (ev) => {
        for (const p of this.pending.values()) p.reject(new Error(ev.message || "worker error"));
        this.pending.clear();
      };
      return new Promise((resolve, reject) => {
        this.pending.set("init", { resolve, reject });
        this.worker.postMessage({ type: "init", ...args });
      });
    }
    // inline fallback (same code, main thread)
    const [{ SkySession }, net] = await Promise.all([import("./sky.js"), import("./net.js")]);
    this.net = net;
    this.ctl = new AbortController();
    if (args.cacheBytes) net.setCacheLimit(args.cacheBytes);
    net.clearCache(); net.resetStats();
    this._netListener = () => this.onNet({ ...net.stats });
    this._statusListener = (e) => this.onStatus(e.detail.message);
    net.events.addEventListener("progress", this._netListener);
    net.events.addEventListener("status", this._statusListener);
    this.session = new SkySession({ ...args, signal: this.ctl.signal });
    return summarize(this.session);
  }

  _onMessage(m) {
    if (m.type === "cancelled") { if (this._cancelDone) this._cancelDone(); return; }
    if (this.closed) return;
    if (m.type === "net") this.onNet(m.stats);
    else if (m.type === "status") this.onStatus(m.message);
    else if (m.type === "ready") { const p = this.pending.get("init"); this.pending.delete("init"); p && p.resolve(m.session); }
    else if (m.type === "progress") { const p = this.pending.get(m.id); p && p.onProgress(m.progress); }
    else if (["plan", "bin", "composite", "eta"].includes(m.type)) { const p = this.pending.get(m.id); p && p.onEvent && p.onEvent(m); }
    else if (m.type === "result") { const p = this.pending.get(m.id); this.pending.delete(m.id); p && p.resolve({ result: m.result, astrometry: m.astrometry }); }
    else if (m.type === "error") {
      const p = this.pending.get(m.id) || this.pending.get("init");
      this.pending.delete(m.id); this.pending.delete("init");
      if (p) { const e = new Error(m.message); if (m.aborted) e.name = "AbortError"; p.reject(e); }
    }
  }

  /** Download and stack one bin. Resolves {result, astrometry}. */
  loadBin(um, onProgress = () => {}) {
    if (this.useWorker) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress });
        this.worker.postMessage({ type: "loadBin", id, um });
      });
    }
    this.net.setMaxParallel(this.net.MAX_PARALLEL);
    return this.session.loadBin(um, onProgress).then((result) => ({ result, astrometry: slimAstrometry(this.session.astrometry()) }));
  }

  /** Progressive full result: every available bin, one at a time (progressive.js). onEvent gets
   * {type: "plan" | "bin" | "composite" | "eta", ...} (ajan_durumu/motor_hizi.md "PROGRESSIVE CONTRACT").
   * Resolves {result: {results: {um: result}, answer, order}, astrometry}. */
  loadAll(opts = {}, onEvent = () => {}) {
    if (this.useWorker) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress: () => {}, onEvent });
        this.worker.postMessage({ type: "loadAll", id, opts });
      });
    }
    this.net.setMaxParallel(this.net.MAX_PARALLEL);
    return import("./progressive.js").then(({ runAll }) => runAll(this.session, 0, opts, onEvent, (r) => r))
      .then((result) => ({ result, astrometry: slimAstrometry(this.session.astrometry()) }));
  }

  /** Move a waiting bin to the front of loadAll's queue (no-op if it is loading or done). */
  prioritize(um) {
    if (this.useWorker) { if (this.worker) this.worker.postMessage({ type: "prioritize", um }); return; }
    import("./progressive.js").then(({ prioritize }) => prioritize(um));
  }

  /** Quick preview of one bin (SkySession.loadPreview). Resolves {result, astrometry: null}. */
  loadPreview(um, opts = {}, onProgress = () => {}) {
    if (this.useWorker) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress });
        this.worker.postMessage({ type: "loadPreview", id, um, opts });
      });
    }
    this.net.setMaxParallel(6);
    return this.session.loadPreview(um, opts, onProgress).then((result) => ({ result, astrometry: null }));
  }

  /** Spectrum of the source from the exposures loaded so far (spectrum.js). Resolves {result: spec}. */
  spectrum(onProgress = () => {}) {
    if (this.useWorker) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress });
        this.worker.postMessage({ type: "spectrum", id });
      });
    }
    return import("./spectrum.js").then((m) => m.spectrumForSession(this.session, { onProgress })).then((result) => ({ result }));
  }

  /** Challenge tools on the exposures already in memory (ch_worker.js: spectrum, deep, frameinfo). Resolves {result}. */
  ch(op, args = {}) {
    if (this.useWorker) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress: () => {} });
        this.worker.postMessage({ type: "ch", id, op, args });
      });
    }
    return import("./ch_worker.js").then((m) => m.chHandle(this.session, op, args)).then((result) => ({ result }));
  }

  /** Abort in-flight fetches and stop. The engine cannot be used afterwards. */
  async cancel() {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("cancelled"); err.name = "AbortError";
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    if (this.useWorker && this.worker) {
      await new Promise((res) => {
        this._cancelDone = res;
        try { this.worker.postMessage({ type: "cancel" }); } catch (_) { res(); }
        setTimeout(res, 300);        // do not wait long for a busy worker
      });
      this.worker.terminate();
      this.worker = null;
    } else if (this.ctl) {
      this.ctl.abort();
      this.net.events.removeEventListener("progress", this._netListener);
      this.net.events.removeEventListener("status", this._statusListener);
    }
  }
}
