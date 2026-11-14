// Progressive full result of the browser engine (captain, 14 Nov 2026 22:00). Runs inside the worker
// (worker.js "loadAll"): one wavelength bin at a time, best bin first (most seasons, tie 2.0 um), then
// 4.6 um (cold objects), then ORDER; after every bin: its result, the answer recomputed from all bins so
// far, and an "All" colour view (display only). "prioritize" moves a waiting bin to the front.
// Contract (field names): ajan_durumu/motor_hizi.md "PROGRESSIVE CONTRACT".
import { stats } from "./net.js";

export const ORDER = [2.0, 3.0, 4.0, 1.5, 1.0, 4.6];   // after best + 4.6 (measured: motor_hizi.md table)
export const CHANNELS = { blue: [1.0, 1.5], green: [2.0, 3.0], red: [4.0, 4.6] };
export const CAPTION_EN = "Colour view of the loaded wavelengths: for looking only; measurements are per wavelength.";
export const CAPTION_TR = "Yüklenen dalga boylarının renkli görünümü: yalnızca bakmak için; ölçümler dalga boyu başınadır.";

let queue = null;          // bins not started yet, in order
let current = null;
let states = null;         // um -> BIN of the running loadAll (for retrying a failed bin)
let onRequeue = null;

/** Order of the available bins: best (most seasons; tie 2.0, then ORDER), 4.6, then ORDER. */
export function binOrder(bins, priority = null) {
  const avail = bins.filter((b) => b.available);
  if (!avail.length) return [];
  const rank = (um) => { const i = ORDER.indexOf(um); return i < 0 ? 99 : i; };
  const best = avail.slice().sort((a, b) => (b.nSeasons - a.nSeasons) || (rank(a.um) - rank(b.um)))[0].um;
  const order = [best];
  if (best !== 4.6 && avail.some((b) => b.um === 4.6)) order.push(4.6);
  for (const um of ORDER) if (!order.includes(um) && avail.some((b) => b.um === um)) order.push(um);
  for (const b of avail) if (!order.includes(b.um)) order.push(b.um);
  if (priority != null && order.includes(priority)) { order.splice(order.indexOf(priority), 1); order.unshift(priority); }
  return order;
}

/** Move a waiting bin to the front (no-op when it is loading or done). Returns true when the order changed. */
export function prioritize(um) {
  if (!queue) return false;
  um = Number(um);
  const st = states && states.get(um);
  if (st && st.state === "failed") {                       // retry a failed bin: back to the front of the queue
    Object.assign(st, { state: "queued", done: 0, error: null });
    queue.unshift(um);
    if (onRequeue) onRequeue(um);
    return true;
  }
  const i = queue.indexOf(um);
  if (i <= 0) return false;
  queue.splice(i, 1);
  queue.unshift(um);
  return true;
}

export const MAX_STAR_SPEED = 12;      // "/yr; the fastest known star (Barnard's) moves 10.4"/yr
export const UNCAL_FLOOR = 1.0;        // " minimum shift for "moving" without the field-star calibration
export const MAX_NOT_MOVING_ERR = 1;   // "/yr; a larger error bar cannot support "not moving"

/** Why a measured shift must not be stated as a motion (null = it can be). Guards (contract v1.2):
 * saturated: the centre source is saturated in a season of the pair and that season has no calibrated
 *   (wing fit + saturated-star bias) position -> the centroid is not reliable;
 * implausible_speed: faster than any known star -> almost surely a different source in each season;
 * inconsistent: >= 3 seasons and one season is > max(4 err, 1.5") off the straight-line motion;
 * disagrees_with_catalogue: a catalogue prediction exists, the shift is off it by > 3 err, and the fit is
 *   poor (saturated or uncalibrated season, or one wavelength bin only). The measured numbers are kept as they are. */
export function unreliable(astro, session, h, s, eU, p, claimsMotion) {
  const pos = astro.positions || [];
  const P = (lab) => pos.find((x) => x.season === lab) || null;
  const satUncal = (lab) => {
    const ex = session.exposures.filter((e) => e.season === lab && e.ra_fit != null);
    const sat = ex.filter((e) => e.saturated), bad = sat.filter((e) => !e.posPool);
    const q = P(lab);
    return sat.length > 0 && ((q && !q.calibrated) || bad.length * 2 >= ex.length);
  };
  const seasons = [h.from, h.to];
  const sat = seasons.some(satUncal);
  if (sat) return "saturated";
  if (claimsMotion && h.dtYears > 0 && s / h.dtYears > MAX_STAR_SPEED) return "implausible_speed";
  if (claimsMotion && pos.length >= 3) {                 // straight-line motion through every season
    const t = pos.map((q) => q.mjd), ra0 = pos[0].ra, dec0 = pos[0].dec, c = Math.cos(dec0 * Math.PI / 180);
    const E = pos.map((q) => (q.ra - ra0) * c * 3600), N = pos.map((q) => (q.dec - dec0) * 3600);
    const fit = (y) => { const n = t.length, mt = t.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
      const sxx = t.reduce((a, v) => a + (v - mt) ** 2, 0), b = sxx > 0 ? t.reduce((a, v, k) => a + (v - mt) * (y[k] - my), 0) / sxx : 0;
      return t.map((v, k) => y[k] - (my + b * (v - mt))); };
    const rE = fit(E), rN = fit(N);
    if (pos.some((q, k) => Math.hypot(rE[k], rN[k]) > Math.max(4 * Math.hypot(q.errEast, q.errNorth), 1.5))) return "inconsistent";
  }
  const poor = seasons.some((lab) => { const q = P(lab); return !q || !q.calibrated || session.exposures.some((e) => e.season === lab && e.ra_fit != null && e.saturated); });
  const fewBins = new Set(session.exposures.filter((e) => e.ra_fit != null).map((e) => e.bin)).size < 2;
  if (p != null && Math.abs(s - p) > 3 * eU && (poor || fewBins)) return "disagrees_with_catalogue";
  return null;
}

/** Plain verdict from session.astrometry(), same rule as site/js/explain.js (shift > max(3 err, 0.2")),
 * then the guards of unreliable(): a guarded result is "too_uncertain" with reason and an honest sentence. */
export function answerFrom(astro, session, version, binsUsed, catalogue = "loaded") {
  // catalogue: "loaded" | "unavailable" (Gaia field query failed: no field-star calibration, no prediction, floor 1.0")
  const cal = catalogue === "loaded";
  const pos = (astro && astro.positions) || [];
  const pairs = (astro && astro.pairs) || [];
  const nImages = session.exposures.filter((e) => binsUsed.includes(e.bin)).length;
  const out = { version, bins_used: binsUsed, n_images: nImages, shift_arcsec: null, shift_err_arcsec: null, dt_years: null,
                pa_deg: null, speed_arcsec_yr: null, speed_err_arcsec_yr: null, speed_source: null, predicted_arcsec: null,
                pm_mas_yr: null, pm_err_mas_yr: null, catalogue };
  let code, reason = null;
  if (pos.length < 2 || !pairs.length) code = pos.length === 1 ? "one_season" : "no_measurement";
  else {
    const same = pairs.filter((p) => p.sameOrientation);
    const h = same.length ? same.reduce((a, p) => (p.dtYears > a.dtYears ? p : a)) : pairs.reduce((a, p) => (p.dtYears > a.dtYears ? p : a));
    const s = h.shift, e = Number.isFinite(h.err) && h.err > 0 ? h.err : null;
    const eU = e ?? Math.max(0.1, 0.05 * s);
    const moving = session.target && (session.target.pmra || session.target.pmdec);
    const p = cal && moving && Number.isFinite(h.gaiaShift) ? h.gaiaShift : null;
    const floor = cal ? 0.2 : UNCAL_FLOOR;
    const sig = s > Math.max(3 * eU, floor), psig = p != null && p > Math.max(3 * eU, floor);
    if (sig && psig) code = Math.abs(s - p) <= Math.max(3 * eU, 0.1 + 0.05 * p) ? "moving_as_predicted" : "moving_unlike_prediction";
    else if (sig) code = "moving";
    else if (psig) code = "too_uncertain";
    else code = "not_moving";
    let why = code === "too_uncertain" ? null : unreliable(astro, session, h, s, eU, p, true);
    if (!why && code === "not_moving" && h.dtYears > 0 && eU / h.dtYears > MAX_NOT_MOVING_ERR) why = "large_error";
    if (why) { reason = why; code = "too_uncertain"; }
    Object.assign(out, { shift_arcsec: +s.toFixed(3), shift_err_arcsec: e != null ? +e.toFixed(3) : null, dt_years: h.dtYears,
                         pa_deg: h.pa, predicted_arcsec: p, speed_arcsec_yr: h.dtYears ? +(s / h.dtYears).toFixed(3) : null,
                         speed_err_arcsec_yr: h.dtYears && e != null ? +(e / h.dtYears).toFixed(3) : null,
                         speed_source: h.dtYears ? "shift_dt" : null });     // the browser has no joint fit (local engine: tiles' joint fit)
  }
  const texts = (tr) => {                       // Turkish: decimal comma (10,37), so the bin list uses ";"
    const f = (v) => (tr ? v.toFixed(2).replace(".", ",") : v.toFixed(2));
    const b = binsUsed.map((x) => (tr ? String(x).replace(".", ",") : String(x))).join(tr ? "; " : ", ");
    const sp = out.speed_arcsec_yr != null ? f(out.speed_arcsec_yr) + (out.speed_err_arcsec_yr != null ? ` ± ${f(out.speed_err_arcsec_yr)}` : "") : "";
    const se = out.speed_err_arcsec_yr != null ? f(out.speed_err_arcsec_yr) : "?";
    const R = {
      saturated: [`The source is saturated (too bright) in ${b} µm, so its position there is not reliable: too uncertain so far. A longer wavelength (4.0 / 4.6 µm) may settle it.`,
                  `Kaynak ${b} µm'de doymuş (fazla parlak); oradaki konumu güvenilir değil: şimdilik fazla belirsiz. Daha uzun bir dalga boyu (4,0 / 4,6 µm) netleştirebilir.`],
      implausible_speed: [`The measured shift (${sp}″ per year, ${b} µm) is faster than any known star: most likely a different source was measured in each season. Too uncertain; check the blink by eye.`,
                          `Ölçülen kayma (yılda ${sp}″, ${b} µm) bilinen her yıldızdan hızlı: büyük olasılıkla her sezonda farklı bir kaynak ölçüldü. Fazla belirsiz; göz kırpmaya gözle bakın.`],
      large_error: [`The error bar (± ${se}″ per year, ${b} µm) is too large to tell whether it moves: too uncertain so far.`,
                    `Hata payı (yılda ± ${se}″, ${b} µm) hareket edip etmediğini söylemek için çok büyük: şimdilik fazla belirsiz.`],
      inconsistent: [`The season positions (${b} µm) do not line up on one steady motion: too uncertain so far.`,
                     `Sezon konumları (${b} µm) tek bir düzgün harekete oturmuyor: şimdilik fazla belirsiz.`],
      disagrees_with_catalogue: [`The measured shift (${sp}″ per year, ${b} µm) disagrees with the catalogue and the fit is poor here: too uncertain so far.`,
                                 `Ölçülen kayma (yılda ${sp}″, ${b} µm) katalogla uyuşmuyor ve buradaki ölçüm zayıf: şimdilik fazla belirsiz.`],
    };
    return reason ? R[reason] : {
      moving: [`Moves about ${sp}″ per year (from ${b} µm): a moving-object candidate, not confirmed.`, `Yılda yaklaşık ${sp}″ kayıyor (${b} µm): hareket eden bir aday, doğrulanmadı.`],
      moving_as_predicted: [`Moves ${sp}″ per year (from ${b} µm), as the catalogue predicts.`, `Yılda ${sp}″ kayıyor (${b} µm); katalog tahminiyle aynı.`],
      moving_unlike_prediction: [`Moves ${sp}″ per year (from ${b} µm); the catalogue predicts a different motion.`, `Yılda ${sp}″ kayıyor (${b} µm); katalog farklı bir hareket bekliyor.`],
      not_moving: [`No motion measured (from ${b} µm): ${sp}″ per year.`, `Hareket ölçülmedi (${b} µm): yılda ${sp}″.`],
      too_uncertain: [`No clear motion measured yet (from ${b} µm), although the catalogue expects one: too uncertain so far.`, `Henüz belirgin hareket ölçülmedi (${b} µm), oysa katalog bekliyor: şimdilik fazla belirsiz.`],
      one_season: [`Measured in only one season so far (${b} µm): motion cannot be measured yet.`, `Şimdilik yalnızca bir sezonda ölçüldü (${b} µm): hareket henüz ölçülemez.`],
      no_measurement: [`Could not measure the motion from ${b} µm.`, `${b} µm'den hareket ölçülemedi.`],
    }[code];
  };
  let en = texts(false)[0], tr = texts(true)[1];
  if (!cal && !["one_season", "no_measurement"].includes(code)) {
    en += " Measured without the star catalogue: it could not be loaded (network), so there is no calibration and no catalogue prediction.";
    tr += " Yıldız kataloğu olmadan ölçüldü: katalog yüklenemedi (ağ); kalibrasyon ve katalog tahmini yok.";
  }
  return { ...out, code, reason, text_en: en, text_tr: tr };
}

/** "All" view: per season the loaded bins' normalised frames as RGBA (short = blue, middle = green, long = red). */
export function composite(results, n) {
  const seasons = new Map();
  for (const r of Object.values(results)) for (const f of r.frames) {
    if (!seasons.has(f.season)) seasons.set(f.season, {});
    seasons.get(f.season)[r.um] = f.norm;
  }
  const out = [];
  for (const [season, byUm] of seasons) {
    const rgba = new Uint8ClampedArray(n * n * 4);
    const ch = ["red", "green", "blue"].map((c) => CHANNELS[c].map((u) => byUm[u]).filter(Boolean));
    for (let k = 0; k < n * n; k++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, m = 0;
        for (const a of ch[c]) { const v = a[k]; if (Number.isFinite(v)) { s += v; m++; } }
        rgba[4 * k + c] = m ? Math.round(255 * Math.min(1, Math.max(0, s / m))) : 0;
      }
      rgba[4 * k + 3] = 255;
    }
    out.push({ season, bins: Object.keys(byUm).map(Number).sort((a, b) => a - b), rgba });
  }
  out.sort((a, b) => (a.season < b.season ? -1 : 1));
  return out;
}

/**
 * Load every available bin, one at a time, posting events (see the contract). post(msg) sends to the page,
 * slim(result) makes a result cloneable. Resolves {results: {um: slimResult}, answer, order}.
 */
// A failed bin keeps {error}; prioritize(um) on it re-queues it at the front (state "queued", done 0, error null).
export async function runAll(session, id, opts, post, slim) {
  const bins = session.bins.map((b) => ({ um: b.um, det: b.det, nSeasons: b.nSeasons, available: b.available }));
  queue = binOrder(bins, opts.priority ?? null);
  if (Array.isArray(opts.order) && opts.order.length) queue = opts.order.map(Number).filter((u) => queue.includes(u));
  const state = new Map(bins.filter((b) => b.available).map((b) => [b.um, { um: b.um, det: b.det, state: "queued", done: 0, total: 0, nSeasons: b.nSeasons, error: null }]));
  let version = 0;
  const plan = () => ({ order: [...(current != null ? [current] : []), ...queue], bins: [...state.values()].map((x) => ({ ...x })) });
  states = state;
  onRequeue = () => post({ type: "plan", id, version: ++version, ...plan() });
  const t0 = Date.now(), b0 = stats.bytes;
  let nEx = 0, bytesEx = 0;
  const planned = (um) => {               // exposures a bin will read: up to cap per season
    const b = session.bins.find((x) => x.um === um);
    return b ? Object.values(b.candidates).reduce((a, c) => a + Math.min(session.cfg.cap, c.length), 0) : 0;
  };
  for (const st of state.values()) st.total = planned(st.um);      // known before loading (button fill)
  post({ type: "plan", id, version: ++version, ...plan() });
  const eta = () => {
    const el = (Date.now() - t0) / 1000, by = stats.bytes - b0;
    const bins = [...state.values()].map((x) => ({ ...x }));     // live done / total of every bin (Q1, v1.1)
    if (nEx < 3 || el <= 0) return post({ type: "eta", id, firstAnswerS: null, allS: null, mbPerS: null, bytesLeft: null, basis: "not yet measured", bins });
    const rate = by / el, per = bytesEx / nEx;
    const cur = current != null ? Math.max(0, planned(current) - (state.get(current).done || 0)) : 0;
    const rest = queue.reduce((a, u) => a + planned(u), 0);
    const done = [...state.values()].some((x) => x.state === "done");
    post({ type: "eta", id, firstAnswerS: done ? 0 : Math.round((cur * per) / rate + 2), nextAnswerS: Math.round((cur * per) / rate + 2),
           allS: Math.round(((cur + rest) * per) / rate + 2 * (queue.length + 1)), mbPerS: +(rate / 1e6).toFixed(2),
           bytesLeft: Math.round((cur + rest) * per), basis: "measured from this run's own downloads", bins });
  };
  const timer = setInterval(eta, 2000);
  const results = {};
  let answer = null;
  try {
    while (queue.length) {
      const um = queue.shift();
      current = um;
      const st = state.get(um);
      st.state = "loading"; st.total = planned(um);
      post({ type: "bin", id, version: ++version, um, state: "loading", ...plan() });
      try {
        const bytesBefore = stats.bytes;
        const r = await session.loadBin(um, (p) => { st.done = p.done || 0; });
        const nb = r.frames.reduce((a, f) => a + f.n, 0);
        nEx += nb; bytesEx += stats.bytes - bytesBefore;
        st.state = "done"; st.done = nb;
        results[um] = r;
        current = null;
        const astro = session.astrometry();
        const cs = session.cfg && session.cfg.calibrate === false ? null : await session.calStars;
        const catalogue = cs && cs.ok ? "loaded" : cs ? "unavailable" : "off";
        answer = answerFrom(astro, session, version + 1, Object.keys(results).map(Number).sort((a, b) => a - b),
                            catalogue === "off" ? "loaded" : catalogue);
        post({ type: "bin", id, version: ++version, um, state: "done", result: slim(r), astrometry: { ...astro, headerChecks: undefined }, answer, ...plan() });
        post({ type: "composite", id, version, n: session.n, displayOnly: true, channels: CHANNELS,
              caption_en: CAPTION_EN, caption_tr: CAPTION_TR, seasons: composite(results, session.n) });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        st.state = "failed"; st.error = e.message || String(e); current = null;
        post({ type: "bin", id, version: ++version, um, state: "failed", error: st.error, ...plan() });
      }
    }
  } finally {
    clearInterval(timer);
    queue = null; current = null; states = null; onRequeue = null;
  }
  const slimAll = {};
  for (const [um, r] of Object.entries(results)) slimAll[um] = slim(r);
  return { results: slimAll, answer, order: [...state.keys()] };
}
