// Network layer for the sky viewer: HTTP Range reads from the public SPHEREx S3 bucket.
// - at most MAX_PARALLEL requests in flight (S3 etiquette, and phones)
// - retry with exponential backoff on network errors, 429/5xx ("S3 busy, retrying")
// - in-memory cache of finished ranges (LRU by bytes)
// - byte/request counters for the progress display
// Content-Range is not exposed by the bucket's CORS rules, so nothing here relies on it.

export const S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/";
export const MAX_PARALLEL = 4;
const MAX_TRIES = 6;
let CACHE_LIMIT = 192 * 1024 * 1024;   // lowered on phones (setCacheLimit)

export const stats = { bytes: 0, requests: 0, retries: 0, cacheHits: 0, inFlight: 0, queued: 0 };
export const events = new EventTarget();   // "status" {detail: {kind, message}}, "progress"

function emit(type, detail) {
  events.dispatchEvent(new CustomEvent(type, { detail }));
}

// ---- concurrency limiter ---------------------------------------------------------------
const waiting = [];
function acquire() {
  if (stats.inFlight < MAX_PARALLEL) { stats.inFlight++; return Promise.resolve(); }
  stats.queued++;
  return new Promise((res) => waiting.push(res));
}
function release() {
  const next = waiting.shift();
  if (next) { stats.queued--; next(); } else { stats.inFlight--; }
}

// ---- cache ------------------------------------------------------------------------------
const cache = new Map();   // key -> Promise<Uint8Array>; insertion order = LRU order
let cacheBytes = 0;
const sizes = new Map();
function cacheGet(key) {
  const p = cache.get(key);
  if (p) { cache.delete(key); cache.set(key, p); stats.cacheHits++; }
  return p;
}
function cachePut(key, p) {
  cache.set(key, p);
  p.then((u8) => {
    if (!cache.has(key)) return;
    sizes.set(key, u8.byteLength);
    cacheBytes += u8.byteLength;
    for (const k of cache.keys()) {
      if (cacheBytes <= CACHE_LIMIT) break;
      if (k === key) continue;
      cacheBytes -= sizes.get(k) || 0;
      sizes.delete(k);
      cache.delete(k);
    }
  }, () => cache.delete(key));
}
export function clearCache() { cache.clear(); sizes.clear(); cacheBytes = 0; }
export function setCacheLimit(bytes) { CACHE_LIMIT = bytes; }
export function resetStats() { stats.bytes = 0; stats.requests = 0; stats.retries = 0; stats.cacheHits = 0; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

async function doFetch(url, rangeValue, signal) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    await acquire();
    let res;
    try {
      stats.requests++;
      emit("progress", stats);
      res = await fetch(url, { headers: { Range: rangeValue }, signal, cache: "no-store", mode: "cors" });
      if (res.status === 206) {
        const buf = new Uint8Array(await res.arrayBuffer());
        stats.bytes += buf.byteLength;
        emit("progress", stats);
        return buf;
      }
      // never read a 200 body: that would be the whole ~62 MB file
      try { res.body && res.body.cancel(); } catch (_) { /* ignore */ }
      if (res.status === 200) throw new HttpError(200, "server ignored the Range header");
      if (res.status === 403 || res.status === 404) throw new HttpError(res.status, `HTTP ${res.status} for ${url}`);
      if (res.status === 416) throw new HttpError(416, `range ${rangeValue} outside the file`);
      lastErr = new HttpError(res.status, `HTTP ${res.status}`);
    } catch (e) {
      if (e.name === "AbortError" || (e instanceof HttpError && [200, 403, 404, 416].includes(e.status))) throw e;
      lastErr = e;
    } finally {
      release();
    }
    stats.retries++;
    const wait = Math.min(16000, 500 * 2 ** attempt) * (0.75 + 0.5 * Math.random());
    emit("status", { kind: "retry", message: `S3 busy, retrying (attempt ${attempt + 2} of ${MAX_TRIES})...` });
    await sleep(wait);
  }
  throw new Error(`S3 did not answer after ${MAX_TRIES} tries (${lastErr && lastErr.message})`);
}

/** Bytes [start, end) of url (end exclusive). Cached. */
export function fetchRange(url, start, end, { signal } = {}) {
  if (!(end > start)) return Promise.resolve(new Uint8Array(0));
  const key = `${url}|${start}|${end}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const p = doFetch(url, `bytes=${start}-${end - 1}`, signal);
  cachePut(key, p);
  return p;
}

/** The last n bytes of url. Cached. */
export function fetchSuffix(url, n, { signal } = {}) {
  const key = `${url}|-${n}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const p = doFetch(url, `bytes=-${n}`, signal);
  cachePut(key, p);
  return p;
}

/** Byte source over an S3 URL, the interface fits.js reads from. */
export function s3Source(urlOrKey, { signal } = {}) {
  const url = /^https?:/.test(urlOrKey) ? urlOrKey : S3_BASE + urlOrKey;
  return {
    url,
    read: (start, end) => fetchRange(url, start, end, { signal }),
    readSuffix: (n) => fetchSuffix(url, n, { signal }),
  };
}

/** Run async fn over items with a concurrency cap (the network cap applies anyway). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}
