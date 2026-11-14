// Tile request queue for the sky maps (HiPS): a few tile downloads per server at a time, the view you
// are looking at first, spread over the servers that hold the same map. Tiles are never changed or
// dropped; they only arrive in a better order and from the server that can deliver them first.
//
// Why: Aladin Lite asks for every tile of a new view at once (40-50 requests during one wheel zoom).
// The ESA ESASky server, which serves our DSS2, 2MASS and AllWISE maps, gets much slower under such a
// burst: measured Nov 2026 from Chrome, 6 requests at a time gave 14-18 tiles/s, 48 at a time gave
// 6 tiles/s (median wait 6.7 s) or failed outright. So after a zoom the sky took seconds to sharpen.
//
// How: Aladin 3.8 downloads tiles with fetch() (and a few files, like Allsky, through <img>). We hold back
// tile requests beyond PER_HOST running per server and start them as earlier ones finish; a slot is free
// once the whole tile has arrived. Requests that arrive together form a batch; the newest batch goes
// first (older batches belong to views you zoomed past), and inside a batch Aladin's own order is kept.
// Our prefetches (prefetch.js: the tiles of the view a zoom will end on) go ahead of the in-between
// views Aladin asks for while the zoom is still running.
// Mirrors (setMirrorGroups): the same HiPS on several servers has byte-identical tiles (checked with
// md5 on ESA, MAST S3 and IRSA copies). Each tile goes to the server expected to deliver it first
// (rounds of PER_HOST tiles ahead of it there x its recent time per tile); a tile fetched once stays
// with that server so the browser cache is reused. A failed tile is fetched again from the address
// Aladin asked for. The MAST S3 bucket also answers under a second hostname: S3 speaks HTTP/1.1, where
// Chrome opens at most 6 connections per hostname, so two names double the parallel downloads
// (measured Nov 2026: 1.4-2x tiles/s for Pan-STARRS and DSS2 tiles).

const TILE = /\/Norder\d+\/(?:Dir\d+\/Npix\d+[^/]*|Allsky)\.(?:jpe?g|png)(?:[?#]|$)/i;
const PER_HOST = 6;
const BATCH_GAP_MS = 80;      // requests closer together than this belong to the same batch
const STUCK_MS = 15000;       // a download that has not finished by then no longer holds a slot

const hosts = new Map();      // host -> { active, queue: job[] }
const groups = [];            // [[base url, ...]]: the same map on several servers
const routed = new Map();     // group + tile path -> base used (keeps the browser cache useful)
const msPerTile = new Map();  // host -> recent download time per tile (moving average)
const ALIAS = [[/^https:\/\/stpubdata\.s3\.us-east-1\.amazonaws\.com\//, "https://stpubdata.s3.amazonaws.com/"]];
let gen = 0, lastAt = -1e9;
let installed = false;
const stats = { queued: 0, direct: 0, maxQueue: 0, rerouted: 0, retried: 0 };

function hostOf(url) { try { return new URL(url, location.href).host; } catch { return null; } }
function slot(host) {
  let h = hosts.get(host);
  if (!h) hosts.set(host, h = { active: 0, queue: [] });
  return h;
}

/**
 * Same map on several servers, best first (e.g. the mirror lists in surveys.js).
 * priorMs: { host: expected ms per tile } until we have measured it (default 500 for the first mirror, 700 after).
 */
export function setMirrorGroups(list, priorMs = {}) {
  for (const bases of list) {
    const g = [];
    for (const b of bases.filter(Boolean).map((x) => x.replace(/\/+$/, ""))) {
      g.push(b);
      for (const [re, to] of ALIAS) if (re.test(b + "/")) g.push((b + "/").replace(re, to).replace(/\/$/, ""));
    }
    if (g.length < 2) continue;
    groups.push(g);
    g.forEach((b, i) => { const h = hostOf(b); if (h && !msPerTile.has(h)) msPerTile.set(h, priorMs[h] ?? (i ? 700 : 500)); });
  }
}

function split(url) {
  for (let g = 0; g < groups.length; g++) for (const b of groups[g]) if (url.startsWith(b + "/")) return { g, path: url.slice(b.length) };
  return null;
}

// Expected time until one more tile from this server has arrived: the rounds of PER_HOST downloads
// ahead of it, plus its own.
function cost(host) {
  const h = slot(host);
  return (Math.floor((h.active + h.queue.length) / PER_HOST) + 1) * (msPerTile.get(host) ?? 800);
}

/** The address to download a tile from: the server already used for it, else the quickest one now. */
function route(url) {
  const s = split(url);
  if (!s) return url;
  const key = s.g + s.path;
  let base = routed.get(key);
  if (!base) {
    let best = Infinity;
    for (const b of groups[s.g]) { const c = cost(hostOf(b)); if (c < best) { best = c; base = b; } }
    routed.set(key, base);
    if (routed.size > 20000) routed.delete(routed.keys().next().value);
  }
  const out = base + s.path;
  if (out !== url) stats.rerouted++;
  return out;
}

function forget(url) {
  const s = split(url);
  if (s) routed.delete(s.g + s.path);
}

function pump(host) {
  const h = slot(host);
  while (h.active < PER_HOST && h.queue.length) {
    let best = 0;                                         // prefetch first, then newest batch, first-come inside it
    for (let i = 1; i < h.queue.length; i++) {
      const a = h.queue[i], b = h.queue[best];
      if (a.prio > b.prio || (a.prio === b.prio && a.gen > b.gen)) best = i;
    }
    const job = h.queue.splice(best, 1)[0];
    run(host, h, job);
  }
}

function run(host, h, job) {
  h.active++;
  job.t1 = performance.now();
  let freed = false;
  const free = (network = true) => {
    if (freed) return;
    freed = true; clearTimeout(timer); h.active--;
    job.t2 = performance.now();
    const ms = job.t2 - job.t1;
    if (network && ms > 40 && ms < STUCK_MS) msPerTile.set(host, 0.8 * (msPerTile.get(host) ?? ms) + 0.2 * ms);   // not cache hits
    pump(host);
  };
  const timer = setTimeout(() => { msPerTile.set(host, Math.max(msPerTile.get(host) ?? 0, STUCK_MS / 2)); free(false); }, STUCK_MS);
  job.start(free);
}

/** Put a download in its server's queue. start(free, url) runs when its turn comes. */
function enqueue(url, start, prio = 0) {
  const to = route(url);
  const host = hostOf(to);
  if (!host) return null;
  const now = performance.now();
  if (now - lastAt > BATCH_GAP_MS) gen++;
  lastAt = now;
  const h = slot(host);
  const job = { gen, prio, host, t0: now, url: to };
  job.start = (free) => start(free, to);
  h.queue.push(job);
  if (window.__fzTileTrace) window.__fzTileTrace.push(job);                // tests only
  stats.queued++; stats.maxQueue = Math.max(stats.maxQueue, h.queue.length);
  pump(host);
  return job;
}

/** Take a job that has not started yet out of its queue (true if it was still waiting). */
function cancel(job) {
  const h = hosts.get(job.host);
  const i = h ? h.queue.indexOf(job) : -1;
  if (i < 0) return false;
  h.queue.splice(i, 1);
  return true;
}

let realFetch = (...a) => window.fetch(...a);

/** Queue (and spread over mirrors) HiPS tile downloads. Call before the sky starts. */
export function installTileQueue({ mirrors = [], priorMs = {} } = {}) {
  if (installed) return true;
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (!desc || !desc.set || !desc.get || typeof window.fetch !== "function") return false;
  setMirrorGroups(mirrors, priorMs);
  const nativeFetch = window.fetch.bind(window);
  realFetch = nativeFetch;
  const abortErr = (signal) => signal.reason ?? new DOMException("Aborted", "AbortError");

  // fetch(): Aladin's tile downloads. The caller gets the full tile once our turn has come and it arrived.
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    if (!url || !TILE.test(url)) { stats.direct++; return nativeFetch(input, init); }
    const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
    const call = (to) => (to === url ? nativeFetch(input, init)
      : input instanceof Request ? nativeFetch(new Request(to, input), init) : nativeFetch(to, init));
    return new Promise((resolve, reject) => {
      const job = enqueue(url, (free, to) => {
        if (signal?.aborted) { free(false); reject(abortErr(signal)); return; }
        call(to)
          .then((r) => {
            if (!r.ok && to !== url && r.status !== 404) throw new Error(`HTTP ${r.status}`);
            return r.blob().then((body) => {
              free();
              resolve(new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers }));
            });
          })
          .catch((e) => {
            free();
            if (to === url || signal?.aborted) { reject(e); return; }
            stats.retried++; forget(url);                     // that mirror failed: ask the original address
            nativeFetch(input, init).then(resolve, reject);
          });
      });
      if (!job) { nativeFetch(input, init).then(resolve, reject); return; }
      signal?.addEventListener("abort", () => { if (cancel(job)) reject(abortErr(signal)); }, { once: true });
    });
  };

  // <img src>: tiles or Allsky files Aladin loads as images.
  const waiting = new WeakMap();                          // img -> job not started yet (a second src replaces it)
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true, enumerable: desc.enumerable, get: desc.get,
    set(value) {
      const url = String(value);
      if (!TILE.test(url)) { stats.direct++; return desc.set.call(this, value); }
      const img = this, w = waiting.get(img);
      if (w) { w.url = url; return undefined; }           // still queued: load the newer address when its turn comes
      const pending = { url };
      waiting.set(img, pending);
      const ok = enqueue(url, (free, to) => {
        waiting.delete(img);
        const target = pending.url === url ? to : pending.url;
        img.addEventListener("load", () => free(), { once: true });
        img.addEventListener("error", () => {
          free();
          if (target !== pending.url) { stats.retried++; forget(pending.url); desc.set.call(img, pending.url); }
        }, { once: true });
        desc.set.call(img, target);
      });
      if (!ok) { waiting.delete(img); desc.set.call(img, value); }
      return undefined;
    },
  });
  installed = true;
  return true;
}

/**
 * Download a tile through the same queue, ahead of Aladin's own requests (for prefetching).
 * Resolves true / false when done, or null when skipped because stale() said it is no longer needed.
 */
export function queueFetch(url, { stale } = {}) {
  return new Promise((resolve) => {
    const ok = enqueue(url, (free, to) => {
      if (stale?.()) { free(false); resolve(null); return; }
      realFetch(to, { mode: "cors" })
        .then((r) => r.arrayBuffer().then(() => r.ok))
        .catch(() => false)
        .then((r) => { free(); if (!r) forget(url); resolve(r); });
    }, 1);
    if (!ok) resolve(false);
  });
}

/** For tests: queue state per server. */
export function tileQueueInfo() {
  const out = { installed, ...stats, hosts: {} };
  for (const [k, h] of hosts) out.hosts[k] = { active: h.active, queued: h.queue.length, ms_per_tile: Math.round(msPerTile.get(k) ?? 0) };
  return out;
}
