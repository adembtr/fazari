// Opening demo of the Sky Explorer (started by explore/hero.js on a first visit).
//
// Something moves at once: the explorer flies to Barnard's Star with short captions, shows that the
// old background photo and the 2026 marker disagree (the explorer's own fast-star note), blinks two
// real SPHEREx images a year apart, then visits WISE 0855-0714 and ends on the result card.
// Light: two meta.json files and four ~45 kB frame PNGs from site/data; the sky tiles are the ones the
// explorer loads anyway. Every number comes from those meta.json files.
//
// Stop: any click / tap / wheel / key anywhere (Esc too), or the "Skip demo" button at the top. The
// overlay is removed, a running flight is halted where it is, and the explorer is left as it is
// (normally on Barnard's Star with its card). Not started with prefers-reduced-motion (hero.js then
// shows the static card). Captions: site/i18n/{en,tr}.json, keys hero.demo.*.

import { t, lang, num, month, onLang } from "../js/i18n.js";
import { surveyInfo, closeupKeyAt, CLOSEUP_FOV, minFov } from "./surveys.js";

const PX = 6.15;                                  // SPHEREx native pixel, arcsec
const LY_PER_PC = 3.26156;
const STOP_EVENTS = ["pointerdown", "wheel", "keydown", "touchstart"];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const as = (v, d = 2) => `${num(v, d)}″`;

/** Small blink of two frames of one target, cropped around its markers (SVG, PNG pixel coordinates). */
function blink(base, meta, bin, crop) {
  const m = meta?.measured || {};
  const b = (meta?.wavelength_bins || []).find((x) => x.wavelength_um === bin);
  if (!b || !m.from_epoch) return "";
  const eps = [m.from_epoch, m.to_epoch];
  const fr = eps.map((e) => b.frames.find((f) => f.epoch === e));
  const mk = eps.map((e) => (meta.markers || []).find((k) => k.epoch === e)?.png_xy);
  if (!fr[0] || !fr[1] || !mk[0] || !mk[1]) return "";
  const [W, H] = meta.grid?.png_px || [720, 770];
  const cx = (mk[0][0] + mk[1][0]) / 2, cy = (mk[0][1] + mk[1][1]) / 2, x0 = cx - crop / 2, y0 = cy - crop / 2;
  const r = Math.max(6, crop * 0.07), fs = crop * 0.07;
  return `<svg viewBox="${x0.toFixed(1)} ${y0.toFixed(1)} ${crop} ${crop}" aria-hidden="true">
    <image href="${base + fr[0].file}" width="${W}" height="${H}"/>
    <image class="fb" href="${base + fr[1].file}" width="${W}" height="${H}"/>
    <circle class="ra" cx="${mk[0][0]}" cy="${mk[0][1]}" r="${r}"/><circle class="rb" cx="${mk[1][0]}" cy="${mk[1][1]}" r="${r}"/>
    <text class="la" x="${x0 + crop * 0.05}" y="${y0 + crop * 0.93}" font-size="${fs}">${esc(month(eps[0]))}</text>
    <text class="lb" x="${x0 + crop * 0.05}" y="${y0 + crop * 0.93}" font-size="${fs}">${esc(month(eps[1]))}</text>
  </svg>`;
}

/**
 * Run the demo. final(): called at the natural end (hero.js shows the result card).
 * onStop(): called once when the demo stops for any reason. Returns { stop }.
 */
export function runDemo({ final, onStop } = {}) {
  let stopped = false, flipT = 0;
  const timers = new Set();
  const X = () => window.__explore;

  // ---- overlay
  const root = document.createElement("div");
  root.className = "fz-demo";
  root.lang = lang();
  root.innerHTML = `<div class="fz-demo-catch" aria-hidden="true"></div>
    <section class="fz-demo-top" role="region" aria-roledescription="demo">
      <div class="fz-demo-cap">
        <p class="k"><span class="dot" aria-hidden="true"></span><span class="lbl"></span></p>
        <h2 aria-live="polite"></h2>
        <p class="s"></p>
      </div>
      <button type="button" class="fz-demo-skip"></button>
    </section>
    <figure class="fz-demo-blink" hidden><div class="img"></div><figcaption></figcaption></figure>`;
  document.body.appendChild(root);
  document.body.classList.add("fz-demo-on");
  const $ = (s) => root.querySelector(s);
  const skip = $(".fz-demo-skip");
  let cap = { h: "", s: "", n: 0 };
  function paint() {
    root.lang = lang();
    $(".lbl").textContent = `${t("hero.demo.label")} · ${Math.min(cap.n, 4)}/4`;
    $("h2").textContent = cap.h;
    $(".s").textContent = cap.s;
    skip.innerHTML = `${esc(t("hero.demo.skip"))} <span aria-hidden="true">✕</span>`;
    skip.title = t("hero.demo.hint");
    $(".fz-demo-top").setAttribute("aria-label", t("hero.demo.aria"));
  }
  let texts = () => ({ h: "", s: "" });
  const say = (n, f) => { texts = f; cap = { ...f(), n }; paint(); };
  const unLang = onLang(() => { cap = { ...texts(), n: cap.n }; paint(); fig.refresh?.(); });
  cap.n = 1;
  paint();                                               // label and "Skip demo" at once; the caption follows

  // ---- stop on any input
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const id of timers) clearTimeout(id);
    clearInterval(flipT);
    for (const ev of STOP_EVENTS) removeEventListener(ev, onInput, true);
    removeEventListener("resize", onResize);
    unLang();
    root.remove();
    document.body.classList.remove("fz-demo-on");
    halt();
    onStop?.();
  }
  function onInput(e) {
    if (e.type === "keydown" && ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    if (e.type === "keydown" && e.key === "Escape") e.preventDefault();
    if (e.type === "pointerdown" || e.type === "touchstart") e.stopPropagation();   // the click does not also pick a spot
    stop();
  }
  for (const ev of STOP_EVENTS) addEventListener(ev, onInput, { capture: true, passive: false });
  skip.addEventListener("click", stop);

  /** End a running flight where it is (main.js stopFlight: no further steps, Aladin animation stopped). */
  function halt() {
    try { X()?.stopFlight?.(); } catch (e) { /* view is fine as it is */ }
  }

  const wait = (ms) => new Promise((res) => { const id = setTimeout(() => { timers.delete(id); res(); }, ms); timers.add(id); });
  async function until(cond, ms) {                       // poll for the explorer, give up after ms
    const t0 = performance.now();
    while (!stopped && !cond() && performance.now() - t0 < ms) await wait(120);
    return !stopped && cond();
  }

  // ---- blink figure
  const fig = { el: $(".fz-demo-blink") };
  function showBlink(html, capf) {
    if (!html) { fig.el.hidden = true; return; }
    fig.el.querySelector(".img").innerHTML = html;
    fig.refresh = () => { fig.el.querySelector("figcaption").textContent = capf(); };
    fig.refresh();
    fig.el.hidden = false;
    const lab = gap?.querySelector("text"), a = lab?.getBoundingClientRect(), f = fig.el.getBoundingClientRect();
    if (a && a.right > f.left && a.left < f.right && a.bottom > f.top && a.top < f.bottom) lab.style.visibility = "hidden";
    clearInterval(flipT);
    flipT = setInterval(() => fig.el.querySelector("svg")?.classList.toggle("b"), 800);
  }

  /** Arrow on the sky from where the star is in the background photo to its 2026 marker. */
  let gap = null, gapArgs = null;
  const onResize = () => gapArgs && drawGap(...gapArgs);
  addEventListener("resize", onResize);
  function drawGap(id, fov) {
    gap?.remove(); gap = null; gapArgs = [id, fov];
    const x = X(), al = x?.state?.al, p = x?.state?.byId?.get(id), pos = x?.state?.selected?.pos;
    if (!al || !p || !pos || !(p.pmra || p.pmdec)) return;
    const key = fov <= CLOSEUP_FOV[1] ? closeupKeyAt(pos.dec, fov) : "visible";
    const ep = surveyInfo(key)?.epoch;
    if (!ep) return;
    const dt = 2026 - ep;
    const old = { ra: pos.ra - (p.pmra || 0) * dt / 3.6e6 / Math.cos(pos.dec * Math.PI / 180), dec: pos.dec - (p.pmdec || 0) * dt / 3.6e6 };
    let a, b;
    try { a = al.world2pix(old.ra, old.dec); b = al.world2pix(pos.ra, pos.dec); } catch (e) { return; }
    if (!a || !b || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return;
    const box = document.getElementById("sky").getBoundingClientRect();
    const [x1, y1, x2, y2] = [a[0] + box.left, a[1] + box.top, b[0] + box.left, b[1] + box.top];
    const L = Math.hypot(x2 - x1, y2 - y1);
    if (L < 24) return;
    const ux = (x2 - x1) / L, uy = (y2 - y1) / L, r = 22;
    const sx = x1 + ux * r, sy = y1 + uy * r, ex = x2 - ux * (r + 4), ey = y2 - uy * (r + 4);
    const head = `M${ex - ux * 12 - uy * 7} ${ey - uy * 12 + ux * 7}L${ex} ${ey}L${ex - ux * 12 + uy * 7} ${ey - uy * 12 - ux * 7}`;
    gap = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    gap.setAttribute("class", "fz-demo-gap");
    gap.setAttribute("aria-hidden", "true");
    const lab = t("hero.demo.old", { year: Math.round(ep) });
    const lw = lab.length * 7.6;                     // label beside the ring if it fits, else under it (phones)
    const at = x1 + r + 6 + lw < innerWidth - 8 ? [x1 + r + 6, y1 + 5, "start"]
      : x1 - r - 6 - lw > 8 ? [x1 - r - 6, y1 + 5, "end"]
      : [Math.min(Math.max(x1, lw / 2 + 8), innerWidth - lw / 2 - 8), y1 + r + 19, "middle"];
    gap.innerHTML = `<circle cx="${x1}" cy="${y1}" r="${r}" class="old"/>
      <path d="M${sx} ${sy}L${ex} ${ey}${head}" class="arr"/>
      <text x="${at[0]}" y="${at[1]}" text-anchor="${at[2]}" class="lab">${esc(lab)}</text>`;
    root.appendChild(gap);
  }

  async function fly(id, fov) {
    const x = X(), p = x?.state?.byId?.get(id);
    if (!p) return false;
    x.select(p, { fly: false });
    const pos = x.state.selected?.pos || { ra: p.ra_2026 ?? p.ra, dec: p.dec_2026 ?? p.dec };
    if (!x.state.al) { await x.flyTo(pos.ra, pos.dec, fov); return true; }
    await Promise.race([x.flyTo(pos.ra, pos.dec, fov), wait(9000)]);
    return true;
  }

  // ---- the script
  (async () => {
    const [bm, wm] = await Promise.all([get("data/barnard/meta.json"), get("data/wise0855/meta.json")]);
    if (stopped) return;
    const b = bm?.measured || {}, bg = bm?.gaia || {};
    const pm = Math.hypot(bg.pmra_mas_yr || 0, bg.pmdec_mas_yr || 0) / 1000;
    const ly = bg.parallax_mas ? Math.round(1000 / bg.parallax_mas * LY_PER_PC) : null;
    if (b.shift_arcsec != null) {
      say(1, () => ({ h: t("hero.title", { shift: `${Math.round(b.shift_arcsec)}″` }), s: t("hero.hook") }));
    }
    // 1. wait for the sky (or the flat fallback map) and the place list, let the opening zoom start
    const ready = await until(() => X()?.state?.byId?.get("barnard") && (X().state.al || X().state.flat), 20000);
    if (stopped) return;
    await wait(ready ? 2200 : 0);
    if (stopped) return;
    say(2, () => ({ h: t("hero.demo.s1"), s: ly ? t("hero.demo.s1b", { ly: num(ly, 0), pm: as(pm, 1) }) : "" }));
    // Sharp close-up photo (taken years before 2026): 0.3° on a wide screen, the same scale (0.75″ per pixel) on a phone.
    const near = Math.min(CLOSEUP_FOV[1], Math.max(minFov(innerWidth), 0.3 * innerWidth / 1440));
    if (ready) await fly("barnard", near);
    if (stopped) return;
    await wait(600);
    if (stopped) return;
    // 2. old photo vs 2026 marker (the explorer's fast-star note sits next to the scale bar)
    say(2, () => ({ h: t("hero.demo.s2"), s: t("hero.demo.s2b") }));
    drawGap("barnard", near);
    await wait(5500);
    if (stopped) return;
    // 3. the SPHEREx blink
    if (b.shift_arcsec != null) {
      say(3, () => ({ h: t("hero.demo.s3", { shift: as(b.shift_arcsec), err: as(b.shift_err_arcsec) }),
        s: t("hero.demo.s3b", { from: month(b.from_epoch), to: month(b.to_epoch), gaia: as(b.gaia_predicted_arcsec) }) }));
      showBlink(blink("data/barnard/", bm, 2.0, 200), () => t("hero.demo.blinkCap", { um: num(2.0, 1) }));
      await wait(6000);
      if (stopped) return;
    }
    // 4. WISE 0855-0714
    const w = wm?.measured || {};
    if (w.shift_arcsec != null && ready) {
      fig.el.hidden = true;
      gap?.remove(); gap = gapArgs = null;
      say(4, () => ({ h: t("hero.demo.s4"), s: t("hero.demo.s4b", { shift: as(w.shift_arcsec), err: as(w.shift_err_arcsec), ref: as(w.gaia_predicted_arcsec) }) }));
      await fly("wise0855", 1.0);
      if (stopped) return;
      showBlink(blink("data/wise0855/", wm, 4.6, 120), () => t("hero.demo.blinkCap", { um: num(4.6, 1) }));
      await wait(6000);
      if (stopped) return;
    }
    // 5. the result card (hero.js); the demo is over
    const f = final;
    final = null;
    stop();
    f?.();
  })().catch((e) => { console.warn("demo", e); stop(); });

  return { stop };
}
