// Tile scheduler for the sky maps (HiPS tiles that Aladin Lite downloads): which tile goes first, and from
// which server. Tiles are never changed; a request is only answered sooner or later.
//
// Why (measured from headless Chrome on a ~25 Mbit/s line, Nov 2026, zoom_harness/zoomspeed.mjs):
//  - During a zoom Aladin asks for the tiles of every view it passes (5 -> 1 deg: 47 tiles of the in-between
//    orders 6 and 7 next to the 46 of order 8 it ends on), all at once. They filled every connection and
//    shared the line, so the tiles of the view the zoom ends on started 1-2 s late: 2-5 s to sharp.
//  - It also loads maps that are (nearly) hidden at that field: DSS2 under the SPHEREx layer at 1 deg
//    (SPHEREx 96 %), DSS2 and SPHEREx under Pan-STARRS below 0.3 deg, and the 1-5 MB Allsky file of the
//    close-up map, which also shows as a blurry placeholder.
//  - Tiles spread to IRSA took 1.5-6 s each, and the SPHEREx map (only on IRSA) waited behind them.
// How:
//  - One queue for all servers, best first: tiles of the view a zoom or flight ends on (prefetch.js names
//    them, nearest the cursor first); then the tiles Aladin asks for on screen; then pre-warm tiles (the next
//    zoom level, prefetch.js). Tiles of in-between zoom orders and of hidden maps wait until nothing else is
//    loading, and stop (to be fetched again later) when a new zoom starts. The close-up map's Allsky file
//    is held back (at close zoom it is only a blurry placeholder).
//  - At most MAX_ACTIVE downloads of tiles needed now (plus a few pre-warm or waiting ones, which give way
//    when such a tile finds its server full) and PER_HOST per server: enough to keep a normal line busy, few
//    enough that the first tiles (the middle of the view) do not share it with all the others.
//  - A tile downloaded ahead is kept in memory and handed to Aladin at once when it asks.
//  - Mirrors (setMaps): the same map on several servers has byte-identical tiles (md5 checked: ESA, MAST S3,
//    IRSA). Each tile goes to the server expected to deliver it first (recent time per tile x its load); a
//    server more than SLOW_X times slower than the best one gets tiles only when the others fail. A tile keeps
//    the server it came from (browser cache). The MAST S3 bucket also answers under a second hostname (S3 is
//    HTTP/1.1: 6 connections per hostname).
// ?tq=0 turns all of this off (main.js), for timing comparisons.

const TILE = /\/Norder(\d+)\/(?:Dir\d+\/Npix(\d+)[^/]*|Allsky)\.(?:jpe?g|png)(?:[?#]|$)/i;
const PER_HOST = 6;
const MAX_ACTIVE = 10;
const LATER_ACTIVE = 4;        // waiting tiles (in-between orders, hidden maps) run only with this little else going on
const SOON_ACTIVE = 4;         // pre-warm downloads at once (they give way to tiles needed now)
const STUCK_MS = 15000;        // a download that has not finished by then no longer holds a slot
const SLOW_X = 2.5;
const HEDGE_MS = 1000;           // a tile needed now this late (and 4x its server's usual time): ask a second server too
const HIDDEN = 0.03;           // a map showing with less weight than this is hidden (DSS2 under 96 % SPHEREx still shows its stars)
const ALLSKY_FOV = 20;         // below this field (deg) an Allsky file is only a blurry placeholder
const KEEP = 400;              // tiles downloaded ahead, kept in memory until Aladin asks
const BATCH_GAP_MS = 80;       // asks closer together than this belong to the same batch
const HOLD_MS = 90;            // during a wheel burst, tiles of the field one notch ahead wait this long (the burst may go on)
export const NOW = 0, SOON = 1, LATER = 2, HOLD = 3;

const maps = [];               // { key, bases: [url without trailing /] }
const hosts = new Map();       // host -> { active }
const msPerTile = new Map();   // host -> { ms: recent download time per tile (moving average), t: when last heard of }
const prior = new Map();       // host -> expected ms per tile before any download from it
const FORGET_MS = 10000;       // a server's extra slowness (failure, stuck tile) halves every 10 s: it gets tried again
const routed = new Map();      // tile id -> base that delivered it
const jobs = new Map();        // tile id -> job (waiting, loading, or done and kept)
const queue = [];              // jobs waiting for a slot
const kept = [];               // ids of done jobs that keep their tile in memory, oldest first
const loading = new Set();     // jobs downloading now
const ALIAS = [[/^https:\/\/stpubdata\.s3\.us-east-1\.amazonaws\.com\//, "https://stpubdata.s3.amazonaws.com/"]];
let active = 0, activeNow = 0, gen = 0, lastAt = -1e9, wakeTimer = 0;   // activeNow: started as needed now
let target = null;             // zoom or flight in progress: { fov, orders: {key: order}, weights: {key: w}, base, until }
let view = { fov: 180, weights: {}, base: null };
let installed = false;
let realFetch = (...a) => window.fetch(...a);
// Tiles Aladin has received ("m|order|pix|tail", tail = cube frame and extension): hasTile(), for prefetch.js coverage().
const TILE_AT = /\/Norder(\d+)\/Dir\d+\/Npix(\d+)([^/]*)$/;
const drawn = new Set();
const failedAt = [];            // map index -> times of failed tile downloads (recentFailures)
const stats = { asks: 0, memory: 0, joined: 0, later: 0, held: 0, prefetch: 0, stale: 0, rerouted: 0, retried: 0, hedged: 0, failed: 0, direct: 0 };

function hostOf(url) { try { return new URL(url, location.href).host; } catch { return null; } }
function slot(host) { let h = hosts.get(host); if (!h) hosts.set(host, (h = { active: 0 })); return h; }
function msOf(host) {
  const p = prior.get(host) ?? 800, m = msPerTile.get(host);
  if (!m) return p;
  return m.ms <= p ? m.ms : p + (m.ms - p) * Math.pow(0.5, (performance.now() - m.t) / FORGET_MS);
}
function note(host, ms) { msPerTile.set(host, { ms: 0.8 * msOf(host) + 0.2 * ms, t: performance.now() }); }
function penalize(host) { msPerTile.set(host, { ms: Math.max(msOf(host), STUCK_MS / 2), t: performance.now() }); }

/**
 * The maps and their servers: [{ key, mirrors: [base url, best first] }]. priorMs: { host: expected ms per
 * tile } until measured (default 500 for the first server of a map, 700 for the others).
 */
export function setMaps(list, priorMs = {}) {
  for (const { key, mirrors } of list) {
    const bases = [];
    for (const b of (mirrors || []).filter(Boolean).map((x) => x.replace(/\/+$/, ""))) {
      bases.push(b);
      for (const [re, to] of ALIAS) if (re.test(b + "/")) bases.push((b + "/").replace(re, to).replace(/\/$/, ""));
    }
    if (!bases.length) continue;
    maps.push({ key, bases });
    bases.forEach((b, i) => { const h = hostOf(b); if (h && !prior.has(h)) prior.set(h, priorMs[h] ?? (i ? 700 : 500)); });
  }
}

function split(url) {
  for (let m = 0; m < maps.length; m++) for (const b of maps[m].bases) if (url.startsWith(b + "/")) return { m, path: url.slice(b.length) };
  return null;
}

/**
 * A zoom or flight is under way and will end at field fov: { fov, orders: {key: tile order}, weights: {key: share},
 * base, ms, burst }. burst: a wheel notch (more may follow quickly): Aladin's tiles for the field it reaches wait
 * HOLD_MS after each notch, and those of a field the next notch passes by wait until nothing else is loading.
 */
export function setTarget(t) {
  const now = performance.now();
  target = t ? { ...t, at: now, until: now + (t.ms ?? 1500) } : null;
  if (target) {
    for (const j of loading) if (j.cls === LATER) stop(j);                // a new view: waiting tiles give the line back
    for (const j of queue) {
      if (!j.asked || j.prefetch || j.cls !== NOW) continue;
      const c = classify(j.url, j.m, j.order, j.allsky);
      if (c > j.cls) j.cls = c;
      else if (target.burst && j.notBefore) j.notBefore = now + HOLD_MS;
    }
  }
  pump();
}
/** The view on screen: { fov, weights: {key: share 0-1}, base: key of the background map }. */
export function setView(v) {
  const wasHidden = new Set(Object.keys(view.weights).filter((k) => view.weights[k] < HIDDEN));
  view = v;
  // A map that shows again: its waiting tiles are wanted now.
  let woke = false;
  for (const j of queue) {
    if (j.cls !== LATER || j.m == null) continue;
    const k = maps[j.m].key;
    if (wasHidden.has(k) && (v.weights[k] ?? 1) >= HIDDEN && classify(j.url, j.m, j.order, j.allsky) === NOW) { j.cls = NOW; woke = true; }
  }
  if (woke) pump();
}
const zooming = () => (target && performance.now() < target.until ? target : null);

// How urgent a tile Aladin asks for is (no ranking: prefetch.js ranks the ones it knows).
function classify(url, m, order, allsky) {
  const key = m == null ? null : maps[m].key;
  const z = zooming();
  const at = z || view;
  const w = key == null ? 1 : at.weights[key] ?? 1;
  const base = key != null && key === (at.base ?? view.base);
  if (w < HIDDEN) return LATER;
  if (allsky) return at.fov >= ALLSKY_FOV ? NOW : base ? LATER : HOLD;
  if (!base && order <= 3 && at.fov < ALLSKY_FOV) return LATER;          // coarse placeholder of an overlay
  if (z && key != null && z.orders[key] != null && order > 3 && order !== z.orders[key]) return LATER;   // in-between view
  return NOW;
}

function newJob(url, cls, rank, ownId = null) {
  const s = split(url);
  const id = ownId || (s ? s.m + "|" + s.path : url);
  const om = url.match(/\/Norder(\d+)\//);
  const now = performance.now();
  const job = {
    id, url, m: s ? s.m : null, path: s ? s.path : null, order: om ? +om[1] : -1, allsky: /\/Allsky\./i.test(url),
    cls, rank, gen, t0: now, state: "queued", waiters: [], done: [], prefetch: false, asked: false, stale: null,
  };
  jobs.set(id, job);
  queue.push(job);
  if (window.__fzTileTrace) window.__fzTileTrace.push(job);               // tests only
  return job;
}

function idOf(url) { const s = split(url); return s ? s.m + "|" + s.path : url; }

function cmp(a, b) {
  return a.cls - b.cls || a.rank - b.rank || b.gen - a.gen || a.t0 - b.t0;
}

// Servers a job may use: [[base (null = the address as it is), host]]. A slow server only for waiting tiles.
function usable(job) {
  if (job.m == null) return [[null, hostOf(job.url)]];
  const sticky = routed.get(job.id);
  if (sticky) return [[sticky, hostOf(sticky)]];
  const bases = maps[job.m].bases;
  let fastest = Infinity;
  for (const b of bases) fastest = Math.min(fastest, msOf(hostOf(b)));
  return bases.map((b) => [b, hostOf(b)]).filter(([, h]) => job.cls >= LATER || !(msOf(h) > SLOW_X * fastest));
}

// Server to download a job from: undefined when all its servers are busy (null = the address as it is).
function pickBase(job) {
  let best, bestCost = Infinity;
  for (const [b, h] of usable(job)) {
    if (!h || slot(h).active >= PER_HOST) continue;
    const c = msOf(h) * (1 + slot(h).active / PER_HOST);
    if (c < bestCost) { bestCost = c; best = b; }
  }
  return best;
}

function pump() {
  if (!queue.length) return;
  const calm = !zooming() && !queue.some((j) => j.cls < LATER);
  let soon = 0, wake = Infinity;
  for (const j of loading) if (j.cls === SOON) soon++;
  const now = performance.now();
  queue.sort(cmp);
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    if (job.cls === HOLD) break;                                          // sorted: only held ones follow
    if (job.cls === LATER && !(calm && active < LATER_ACTIVE)) break;
    if (job.cls === SOON && soon >= SOON_ACTIVE) continue;
    if (job.notBefore > now) { wake = Math.min(wake, job.notBefore); continue; }
    if (job.prefetch && !job.asked && job.stale?.()) { queue.splice(i--, 1); finish(job, null); stats.stale++; continue; }
    // Tiles needed now have MAX_ACTIVE downloads of their own: pre-warm and waiting ones never hold them up.
    const room = job.cls === NOW ? activeNow < MAX_ACTIVE : active < MAX_ACTIVE;
    let base = room ? pickBase(job) : undefined;
    if (base === undefined && room && job.cls === NOW && preempt(job)) base = pickBase(job);
    if (base === undefined) continue;
    queue.splice(i--, 1);
    if (job.cls === SOON) soon++;
    start(job, base);
  }
  // Waiting tiles held back only by a zoom still under way: look again when it is over.
  const z = zooming();
  if (z && queue.some((j) => j.cls === LATER)) wake = Math.min(wake, z.until + 5);
  if (wake < Infinity) { clearTimeout(wakeTimer); wakeTimer = setTimeout(pump, Math.max(1, wake - performance.now() + 1)); }
}

// A tile needed now finds all its servers full: stop the youngest pre-warm or waiting download on one of them
// (it goes back in the queue), so the tile can start there. True if one was stopped.
function preempt(job) {
  const could = usable(job).map(([, h]) => h);
  let victim = null;
  for (const j of loading) {
    if (j.cls === NOW || !j.ctl || j.preempted || !could.includes(j.host)) continue;
    if (!victim || j.t1 > victim.t1) victim = j;
  }
  if (!victim) return false;
  stop(victim);
  return true;
}

// Stop a pre-warm or waiting download; it goes back in the queue (start(): catch).
function stop(job) {
  if (!job.ctl || job.preempted) return;
  job.preempted = true;
  stats.preempted = (stats.preempted || 0) + 1;
  job.free(false);
  job.ctl.abort();
}

function start(job, base) {
  job.state = "loading"; job.t1 = performance.now();
  if (base != null && base + job.path !== job.url) stats.rerouted++;
  if (job.img) startImg(job, base);
  else attempt(job, base);
}

// A download slot on host for job; returns free(measure): gives it back once (measure: note the time taken).
function hold(job, host, isNow) {
  const h = slot(host), t1 = performance.now();
  h.active++; active++; if (isNow) activeNow++;
  loading.add(job); job.host = host;
  let freed = false;
  const free = (measure) => {
    if (freed) return;
    freed = true; clearTimeout(timer); h.active--; active--; if (isNow) activeNow--; loading.delete(job);
    const ms = performance.now() - t1;
    if (measure && ms > 40 && ms < STUCK_MS) note(host, ms);              // not cache hits
    queueMicrotask(pump);
  };
  const timer = setTimeout(() => { penalize(host); free(false); }, STUCK_MS);
  return free;
}

function retry(job, host) {                                               // that server failed: another one (once)
  penalize(host);
  routed.delete(job.id);
  job.retried = true; job.state = "queued"; stats.retried++;
  queue.push(job);
  pump();
}

// An <img> load (see installTileQueue).
function startImg(job, base) {
  const url = base == null ? job.url : base + job.path, host = hostOf(url);
  const free = hold(job, host, job.cls === NOW);
  const img = job.img;
  img.addEventListener("load", () => { free(true); if (base != null) routed.set(job.id, base); markDrawn(job); finish(job, { ok: true }); }, { once: true });
  img.addEventListener("error", () => { free(false); if (base != null && !job.retried && job.m != null && maps[job.m].bases.length > 1) retry(job, host); else finish(job, { ok: false }); }, { once: true });
  job.setSrc(url);
}

// One download of a job's tile from one server. A tile needed now that is late (a stalled server: seen
// 6 s once) is asked from a second server too (hedge); the first answer wins and the other one is stopped.
function attempt(job, base) {
  const url = base == null ? job.url : base + job.path, host = hostOf(url), isNow = job.cls === NOW;
  const free = hold(job, host, isNow);
  const ctl = new AbortController();
  if (isNow) job.ctl = null;                                              // never stopped for another tile
  else { job.ctl = ctl; job.free = free; }                               // may be preempted (stop())
  (job.ctls ||= new Set()).add(ctl);
  job.live = (job.live || 0) + 1;
  const init = { mode: "cors", signal: ctl.signal };
  if (isNow && (job.rank < 1e6 || job.hedged)) init.priority = "high";
  else if (job.cls >= SOON) init.priority = "low";
  const late = isNow && job.m != null && !job.hedged && maps[job.m].bases.length > 1
    ? setTimeout(() => {
      // That server is stalled for now: its slot is given back (the download may still win), it is
      // marked slow (twice this wait), and a second server is asked.
      msPerTile.set(host, { ms: Math.max(msOf(host), 2 * (performance.now() - job.t1)), t: performance.now() });
      free(false);
      hedge(job, host);
    }, Math.min(STUCK_MS, Math.max(HEDGE_MS, 4 * msOf(host)))) : 0;
  const settle = () => { clearTimeout(late); job.live--; job.ctls.delete(ctl); };
  realFetch(url, init)
    .then((r) => {
      if (!r.ok && r.status !== 404 && base != null && !job.retried) throw new Error(`HTTP ${r.status}`);
      return r.blob().then((blob) => {
        free(true); settle();
        if (job.state === "done") return;                                 // the other server answered first
        if (base != null && r.ok) routed.set(job.id, base);
        if (routed.size > 20000) routed.delete(routed.keys().next().value);
        for (const c of job.ctls) c.abort();                              // its second download: not needed now
        finish(job, { ok: r.ok, status: r.status, statusText: r.statusText, headers: r.headers, blob });
      });
    })
    .catch((e) => {
      free(false); settle();
      if (job.state === "done") return;
      if (job.preempted) {                                                // stopped for a tile needed now: queue again
        job.preempted = false; job.ctl = null; job.state = "queued";
        queue.push(job);
        queueMicrotask(pump);
        return;
      }
      if (job.live > 0) return;                                           // the other server may still answer
      if (base != null && !job.retried && maps[job.m].bases.length > 1) { retry(job, host); return; }
      stats.failed++;
      finish(job, { error: e });
    });
}

// The tile is late: ask the best other server that has a free slot as well (a slow one too: better than none).
function hedge(job, firstHost) {
  if (job.state !== "loading" || job.hedged || job.m == null) return;
  let best, bestCost = Infinity;
  for (const b of maps[job.m].bases) {
    const h = hostOf(b);
    if (!h || h === firstHost || slot(h).active >= PER_HOST) continue;
    const c = msOf(h) * (1 + slot(h).active / PER_HOST);
    if (c < bestCost) { bestCost = c; best = b; }
  }
  if (best === undefined) { setTimeout(() => hedge(job, firstHost), 500); return; }   // all busy: look again
  job.hedged = true; stats.hedged++;
  attempt(job, best);
}

// A job is over (res null = skipped): answer everyone waiting; keep a downloaded-ahead tile for Aladin.
function finish(job, res) {
  job.state = "done";
  job.res = res;
  if (res && job.m != null && (res.error || (!res.ok && res.status !== 404))) {   // server error, timeout, CORS (not "no tile here")
    const f = (failedAt[job.m] ||= []);
    f.push(performance.now());
    if (f.length > 50) f.shift();
  }
  for (const cb of job.done) cb(res ? !!res.ok : null);
  job.done = [];
  const waiters = job.waiters;
  job.waiters = [];
  for (const w of waiters) deliver(job, w);
  if (!waiters.length && res && res.ok && res.blob && !job.asked) {
    kept.push(job.id);
    while (kept.length > KEEP) { const id = kept.shift(); const j = jobs.get(id); if (j && j.state === "done") jobs.delete(id); }
  } else if (jobs.get(job.id) === job) jobs.delete(job.id);
}

function markDrawn(job) {
  const t = job.m != null && job.path ? job.path.match(TILE_AT) : null;
  if (!t) return;
  if (drawn.size > 50000) drawn.clear();
  drawn.add(`${job.m}|${t[1]}|${t[2]}|${t[3]}`);
}

function deliver(job, w) {
  const r = job.res;
  if (!r) { w.retry(); return; }                                          // skipped prefetch: fetch it for this ask
  if (r.error || !r.blob) { w.reject(r.error || new TypeError("Failed to fetch")); return; }
  if (r.ok) markDrawn(job);
  w.resolve(new Response(r.blob, { status: r.status, statusText: r.statusText, headers: r.headers }));
}

/** Queue (and spread over mirrors) HiPS tile downloads. Call before the sky starts. */
export function installTileQueue({ maps: list = [], priorMs = {} } = {}) {
  if (installed) return true;
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (!desc || !desc.set || !desc.get || typeof window.fetch !== "function") return false;
  setMaps(list, priorMs);
  const nativeFetch = window.fetch.bind(window);
  realFetch = nativeFetch;

  // fetch(): Aladin's tile downloads (it passes no abort signal).
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    if (!url || !TILE.test(url) || (init?.method && init.method !== "GET") || init?.signal || (input instanceof Request && input.signal?.aborted)) {
      stats.direct++;
      return nativeFetch(input, init);
    }
    stats.asks++;
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, retry: () => nativeFetch(input, init).then(resolve, reject) };
      const job = ask(url);
      if (job.state === "done") { stats.memory++; deliver(job, w); if (jobs.get(job.id) === job) jobs.delete(job.id); return; }
      job.waiters.push(w);
      pump();
    });
  };

  // <img src>: tile or Allsky files Aladin loads as images.
  const waiting = new WeakMap();                                          // img -> its job while waiting
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true, enumerable: desc.enumerable, get: desc.get,
    set(value) {
      const url = String(value);
      if (!TILE.test(url)) { stats.direct++; return desc.set.call(this, value); }
      const img = this, old = waiting.get(img);
      if (old && old.state === "queued") { const i = queue.indexOf(old); if (i >= 0) queue.splice(i, 1); jobs.delete(old.id); }
      const now = performance.now();
      if (now - lastAt > BATCH_GAP_MS) gen++;
      lastAt = now;
      const s = split(url);
      const om = url.match(/\/Norder(\d+)\//);
      const own = (s ? s.m + "|" + s.path : url) + "#img" + gen;          // not shared: it belongs to this <img>
      const job = newJob(url, classify(url, s ? s.m : null, om ? +om[1] : -1, /\/Allsky\./i.test(url)), Infinity, own);
      job.img = img; job.asked = true;
      job.setSrc = (u) => { waiting.delete(img); desc.set.call(img, u); };
      waiting.set(img, job);
      pump();
      return undefined;
    },
  });
  installed = true;
  return true;
}

// Aladin asks for a tile: join the download that is already there, or queue a new one.
function ask(url) {
  const now = performance.now();
  if (now - lastAt > BATCH_GAP_MS) gen++;
  lastAt = now;
  const job = jobs.get(idOf(url));
  if (job) {
    stats.joined++;
    if (job.state !== "done") {                                           // (a loading one is then not stopped)
      const c = classify(url, job.m, job.order, job.allsky);
      if (c < job.cls) job.cls = c;
      job.stale = null;
    }
    job.asked = true;
    return job;
  }
  const s = split(url);
  const om = url.match(/\/Norder(\d+)\//);
  const cls = classify(url, s ? s.m : null, om ? +om[1] : -1, /\/Allsky\./i.test(url));
  if (cls === LATER) stats.later++;
  if (cls === HOLD) stats.held++;
  const j = newJob(url, cls, Infinity);
  j.asked = true;
  const z = zooming();
  if (cls === NOW && z && z.burst && now - z.at < HOLD_MS) j.notBefore = z.at + HOLD_MS;
  return j;
}

/**
 * Download a tile ahead of Aladin (prefetch.js). rank: smaller first (distance from the cursor in px);
 * cls: NOW for the view a zoom ends on, SOON for pre-warming. stale() -> true when no longer wanted.
 * Resolves true / false when done, or null when skipped as stale.
 */
export function queueFetch(url, { rank = 1e6, cls = NOW, stale = null } = {}) {
  return new Promise((resolve) => {
    if (!TILE.test(url)) { resolve(false); return; }
    let job = jobs.get(idOf(url));
    if (job && job.state === "done") { resolve(job.res ? !!job.res.ok : null); return; }
    if (job) {
      if (cls < job.cls) job.cls = cls;                                   // (a loading one is then not stopped)
      if (job.state === "queued") {
        if (rank < job.rank) job.rank = rank;
        if (!job.asked) job.stale = stale;
        job.gen = Math.max(job.gen, gen);
      }
      job.done.push(resolve);
      pump();
      return;
    }
    stats.prefetch++;
    job = newJob(url, cls, rank);
    job.prefetch = true;
    job.stale = stale;
    job.done.push(resolve);
    pump();
  });
}

/** A new set of prefetches begins (they go ahead of older ones with the same rank). */
export function nextGeneration() { return ++gen; }

/** True while tiles that matter now (not pre-warm or waiting ones) are still loading or queued. */
export function busy() {
  if (queue.some((j) => j.cls === NOW)) return true;
  for (const j of jobs.values()) if (j.state === "loading" && j.cls === NOW) return true;
  return false;
}

/**
 * True when Aladin has received tile (order, pix) of map `key` (tail: what follows the pixel number in the file name,
 * e.g. "_42.png" for frame 42 of a cube). prefetch.js coverage() uses it; null when the queue is off (?tq=0).
 */
export function hasTile(key, order, pix, tail) {
  if (!installed) return null;
  const m = maps.findIndex((x) => x.key === key);
  return m >= 0 && drawn.has(`${m}|${order}|${pix}|${tail}`);
}

/** Tile downloads of map `key` that failed (server error, timeout, CORS; not 404) in the last ms milliseconds. */
export function recentFailures(key, ms = 10000) {
  const m = maps.findIndex((x) => x.key === key), t = performance.now() - ms;
  return m < 0 || !failedAt[m] ? 0 : failedAt[m].filter((x) => x >= t).length;
}

/** For tests: queue state. */
export function tileQueueInfo() {
  const byCls = [0, 0, 0, 0];
  for (const j of queue) byCls[j.cls]++;
  const out = { installed, active, queued: queue.length, waiting: { now: byCls[0], soon: byCls[1], later: byCls[2], held: byCls[3] },
    pending: active + byCls[0] + byCls[1] + byCls[2], kept: kept.length, ...stats, zooming: !!zooming(), hosts: {} };
  for (const [k, h] of hosts) out.hosts[k] = { active: h.active, queued: 0, ms_per_tile: Math.round(msOf(k)) };
  return out;
}
