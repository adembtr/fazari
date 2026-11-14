// Test driver for js/bins_bar.js (loaded ONLY with ?mock=1; never by a normal page). Replays a progressive run
// as PROGRESSIVE CONTRACT v1 job-status objects, built from a result folder that is already on the site
// (default data/barnard/): bins one at a time, a stage per finished bin (the meta filtered to the bins loaded so
// far; the viewer swaps it in place), an answer whose error bar shrinks, a colour composite made in the browser
// from the frame PNGs, an estimate, one failing bin (?mockfail=4.0; "none" = no failure), priority requests.
// ?mockspeed=2 runs twice as fast. window.__fzPgMock = { prioritize(um), events, pause(), resume() }.

const ORDER = [2.0, 3.0, 4.0, 1.5, 1.0, 4.6];   // contract v1.1
const same = (a, b) => Math.abs(a - b) < 0.05;

function binOrder(bins) {                                  // contract: best (most seasons, tie 2.0 then ORDER), 4.6, ORDER
  const avail = bins.filter((b) => b.seasons >= 2).map((b) => b.um);
  const rank = (u) => { const i = ORDER.findIndex((x) => same(x, u)); return i < 0 ? 99 : i; };
  const best = avail.slice().sort((a, b) => bins.find((x) => x.um === b).seasons - bins.find((x) => x.um === a).seasons || rank(a) - rank(b))[0];
  const out = best == null ? [] : [best];
  if (avail.some((u) => same(u, 4.6)) && !same(best, 4.6)) out.push(avail.find((u) => same(u, 4.6)));
  for (const u of avail.slice().sort((a, b) => rank(a) - rank(b))) if (!out.includes(u)) out.push(u);
  return out;
}

async function grey(url) {
  const im = new Image();
  im.src = url;
  await im.decode();
  const c = document.createElement("canvas");
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(im, 0, 0);
  return { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data };
}
/** One season's colour picture from the loaded bins' frame PNGs (short = blue, middle = green, long = red). */
async function compositeFrame(base, meta, loaded, epoch) {
  const ch = { b: [1.0, 1.5], g: [2.0, 3.0], r: [4.0, 4.6] };
  const files = {};
  for (const b of meta.wavelength_bins) {
    if (!loaded.some((u) => same(u, b.wavelength_um))) continue;
    const f = b.frames.find((x) => x.epoch === epoch);
    if (f) files[b.wavelength_um] = base + f.file;
  }
  const got = {};
  for (const [u, url] of Object.entries(files)) { try { got[u] = await grey(url); } catch (_) { /* skip */ } }
  const any = Object.values(got)[0];
  if (!any) return null;
  const out = new ImageData(any.w, any.h);
  for (const [k, list] of Object.entries(ch)) {
    const src = list.map((u) => Object.entries(got).find(([x]) => same(+x, u))).filter(Boolean).map(([, v]) => v);
    const o = { r: 0, g: 1, b: 2 }[k];
    for (let i = 0; i < any.w * any.h; i++) {
      let s = 0;
      for (const v of src) s += v.d[4 * i];
      out.data[4 * i + o] = src.length ? s / src.length : 0;
      out.data[4 * i + 3] = 255;
    }
  }
  const c = document.createElement("canvas");
  c.width = any.w; c.height = any.h;
  c.getContext("2d").putImageData(out, 0, 0);
  return { epoch, file: c.toDataURL("image/png"), bins: Object.keys(got).map(Number).sort((a, b) => a - b) };
}

/** Mock local-engine job: calls onJob(jobStatus) on every change. */
export function mockLocal(meta, base, onJob, { speed = 1, fail = null, reason = null } = {}) {   // reason: ?mockreason=saturated (first two stages too uncertain)
  const tick = 260 / Math.max(0.1, speed);
  const nIn = (b) => b.frames.reduce((s, f) => s + Math.min(3, f.n_images || 3), 0);
  const bins = meta.wavelength_bins.map((b) => ({ bin_um: +b.wavelength_um, detector: ((b.frames[0] || {}).detectors || ["D?"]).join("+"), state: "queued",
    images_done: 0, images_total: nIn(b), seasons: b.frames.length, bytes: 0, error: null }));
  let order = binOrder(bins.map((b) => ({ um: b.bin_um, seasons: b.seasons })));
  const failUm = fail === "none" ? null : Number(fail) || order[Math.min(4, order.length - 1)];
  let failed = false, version = 0, paused = false, cur = null, wait = 0, refineLeft = 8, priority = null;
  const stages = [], events = [];
  const ms = meta.measured || {};
  const allDone = () => bins.every((b) => b.state === "done" || b.state === "failed");
  const answer = (used, n) => {
    const dt = +ms.dt_years || 1, s = +ms.shift_arcsec, e0 = +ms.shift_err_arcsec || 0.05;
    const k = Math.sqrt(bins.length / used.length) * 1.6;            // fewer bins, fewer exposures: wider error bar
    const out = { version: version + 1, stage: n, bins_used: used, n_images: used.reduce((a, u) => a + bins.find((b) => same(b.bin_um, u)).images_total, 0),
      shift_arcsec: null, shift_err_arcsec: null, dt_years: dt, pa_deg: ms.pa_deg ?? null, speed_arcsec_yr: null, speed_err_arcsec_yr: null,
      predicted_arcsec: ms.gaia_predicted_arcsec ?? null, status: ms.status, meta_url: base + "meta.json" };
    if (!Number.isFinite(s)) return { ...out, code: ms.photometry ? "brightness" : "no_measurement", text_en: "(mock)", text_tr: "(mock)" };
    const sh = s * (1 + (used.length % 2 ? 0.02 : -0.015) / used.length), e = e0 * k;
    const p = Number.isFinite(+ms.gaia_predicted_arcsec) ? +ms.gaia_predicted_arcsec : null;
    const sig = sh > Math.max(3 * e, 0.2), psig = p != null && p > Math.max(3 * e, 0.2);
    const code = sig && psig ? (Math.abs(sh - p) <= Math.max(3 * e, 0.1 + 0.05 * p) ? "moving_as_predicted" : "moving_unlike_prediction") : sig ? "moving" : psig ? "too_uncertain" : "not_moving";
    const b = used.map((u) => String(u)).join(", "), sp = `${(sh / dt).toFixed(2)} ± ${(e / dt).toFixed(2)}`, spT = sp.replace(/\./g, ",");
    if (reason && used.length <= 2) return { ...out, code: "too_uncertain", reason, text_en: `Too uncertain so far (from ${b} µm): the star is saturated, so its position cannot be measured well enough.`,
      text_tr: `Şimdilik fazla belirsiz (${b} µm): yıldız doymuş, konumu yeterince iyi ölçülemiyor.` };
    const T = { moving_as_predicted: [`Moves ${sp}″ per year (from ${b} µm), as the catalogue predicts.`, `Yılda ${spT}″ kayıyor (${b} µm); katalog tahminiyle aynı.`],
      moving: [`Moves about ${sp}″ per year (from ${b} µm): a moving-object candidate, not confirmed.`, `Yılda yaklaşık ${spT}″ kayıyor (${b} µm): hareket eden bir aday, doğrulanmadı.`] }[code] || ["", ""];
    return { ...out, code, reason: null, shift_arcsec: +sh.toFixed(3), shift_err_arcsec: +e.toFixed(3), speed_arcsec_yr: +(sh / dt).toFixed(3), speed_err_arcsec_yr: +(e / dt).toFixed(3),
      text_en: T[0], text_tr: T[1] };
  };
  const stageOf = async (used) => {
    const n = stages.length + 1;
    const m2 = { ...meta, wavelength_bins: meta.wavelength_bins.filter((b) => used.some((u) => same(u, b.wavelength_um))) };
    let composite = null;
    if (used.length >= 2) {
      const eps = [...new Set(m2.wavelength_bins.flatMap((b) => b.frames.map((f) => f.epoch)))].sort();
      const frames = (await Promise.all(eps.map((ep) => compositeFrame(base, meta, used, ep)))).filter(Boolean);
      composite = { display_only: true, channels: { blue: [1.0, 1.5], green: [2.0, 3.0], red: [4.0, 4.6] }, frames,
        caption_en: "Colour view of the loaded wavelengths: for looking only; measurements are per wavelength.",
        caption_tr: "Yüklenen dalga boylarının renkli görünümü: yalnızca bakmak için; ölçümler dalga boyu başınadır." };
    }
    stages.push({ n, bins: used, url: base, n_images: 0, answer: answer(used, n), composite, seconds: 2, _meta: m2 });
  };
  const status = (state) => {
    const left = bins.reduce((a, b) => a + (b.state === "done" || b.state === "failed" ? 0 : b.images_total - b.images_done), 0) + refineLeft;
    const nxt = order.map((u) => bins.find((b) => same(b.bin_um, u))).find((b) => b.state !== "done" && b.state !== "failed");
    const toFirst = nxt ? nxt.images_total - nxt.images_done : 0;
    const j = { id: "mock", state, progress: {}, progressive: {
      version: ++version, order: order.slice(), first_cap: 3,
      bins: order.map((u) => ({ ...bins.find((b) => same(b.bin_um, u)) })),
      refine: { state: allDone() ? (refineLeft ? "loading" : "done") : "queued", images_done: 8 - refineLeft, images_total: 8 },
      stages: stages.slice(), latest: stages.length ? stages.length - 1 : null, answer: stages.length ? stages[stages.length - 1].answer : null,
      eta: version < 4 ? { first_answer_s: null, all_s: null, mb_per_s: null, bytes_left: 0, basis: "not yet measured" }
        : { first_answer_s: stages.length ? 0 : Math.round(toFirst * tick / 1000 + 2), all_s: Math.round(left * tick / 1000 + 3), mb_per_s: 0.4, bytes_left: left * 3e6, basis: "mock" },
      priority, final_url: state === "done" ? base : null } };
    events.push(JSON.parse(JSON.stringify({ t: Date.now(), state, progressive: { ...j.progressive, stages: j.progressive.stages.map((s) => ({ ...s, _meta: undefined, composite: s.composite ? "(frames)" : null })) } })));
    onJob(j);
  };
  let busy = false;
  const step = async () => {
    if (paused || busy) return;
    if (wait > 0) { wait--; return; }
    if (cur == null) {
      const b = order.map((u) => bins.find((x) => same(x.bin_um, u))).find((x) => x.state === "queued");
      if (!b) {
        if (refineLeft > 0) { refineLeft--; status("downloading"); return; }
        clearInterval(timer); status("done"); return;
      }
      cur = b; b.state = "loading"; status("downloading"); return;
    }
    cur.images_done++; cur.bytes += 3e6;
    if (!failed && failUm != null && same(cur.bin_um, failUm) && cur.images_done >= Math.ceil(cur.images_total * 0.4)) {
      failed = true; cur.state = "failed"; cur.error = "timed out after 3 tries"; cur = null; status("downloading"); return;
    }
    if (cur.images_done >= cur.images_total) {
      cur.state = "done"; cur = null;
      busy = true;
      const used = bins.filter((b) => b.state === "done").map((b) => b.bin_um).sort((a, b) => a - b);
      await stageOf(used);
      busy = false;
      wait = 2;
    }
    status("downloading");
  };
  const timer = setInterval(step, tick);
  status("downloading");
  return {
    events,
    pause() { paused = true; }, resume() { paused = false; },
    prioritize(um) {
      const b = bins.find((x) => same(x.bin_um, um));
      if (!b || b.state === "done" || b.state === "loading") return;
      if (b.state === "failed") { b.state = "queued"; b.images_done = 0; b.error = null; }   // the mock retries a failed bin
      priority = b.bin_um;
      order = order.filter((u) => !same(u, um));
      const k = order.findIndex((u) => bins.find((x) => same(x.bin_um, u)).state === "queued");
      order.splice(k < 0 ? order.length : k, 0, b.bin_um);
      status("downloading");
    },
  };
}
