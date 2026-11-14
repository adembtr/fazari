// Plain-language explanations for the blink viewer (ornek.html) and the explorer's result bar.
//
// API (pure functions need no DOM; the explorer and site/js/tests/explain_test.mjs use them too)
//   explainResult(meta, has?) -> { sentence, note, items }
//     sentence  one plain sentence from the measured numbers in a blink.py / local-engine
//               meta.json, e.g. "Barnard's Star moved 10.2″ north in one year, as Gaia predicts."
//               or "Too faint to measure here: ...". Unconfirmed things are "candidates"; never
//               "discovery". null only for a meta with nothing measured at all.
//     note      optional short caveat ("Rough estimate: ... saturates the detector ...") or "".
//     items     the "What you are seeing" strip: [{ key, name, text, ask, show, pic }], keys blink,
//               ring, diff, arrow, curve, spectrum, cands; `ask` = what part of the challenge it
//               answers; `show` = the data exists; `pic` = small inline SVG (arrow, light curve) or "".
//               `has` = { spectrum: bool, cands: bool } for things other modules draw.
//   plainSentence(meta, opt?) -> { text, note } | null      (the sentence alone)
//   seeingItems(meta, has?, opt?) -> items without pictures
//   opt = { lang: "en" | "tr" }; default: the page's language from js/i18n.js (globalThis.__fzI18n),
//   or English (Node, tests). Turkish sentences are built here too (Turkish needs case suffixes).
//   mountExplain(meta, base, { sentenceEl, stripEl }?) -> { set(key, on) }
//     renders into #explainSentence / #explainStrip when the page has them (or the given
//     elements); otherwise creates them in the current ornek.html layout (sentence above
//     .controls, strip above the measurement card). Safe to call again.
//
// Spectrum and candidate rings come from other modules; their strip items show only when the data
// exists: meta.spectrum / meta.measured.spectrum, a candidates.json with candidates next to
// meta.json, a matching element on the page (#spectrum, .spectrum-chart, [data-fz-spectrum],
// .cand-ring, [data-fz-candidates]), or an event:
//   document.dispatchEvent(new CustomEvent("fazari:has", { detail: { key: "spectrum", on: true } }))

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
// Turkish
const MONTHS_TR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const DIRS_TR = ["kuzey", "kuzeydoğu", "doğu", "güneydoğu", "güney", "güneybatı", "batı", "kuzeybatı"];
const DIRS_TR_TO = ["kuzeye", "kuzeydoğuya", "doğuya", "güneydoğuya", "güneye", "güneybatıya", "batıya", "kuzeybatıya"];
const NUM_TR = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on", "on bir", "on iki"];
const NAMES_TR = { "Barnard's Star": "Barnard Yıldızı", "Barnard's star": "Barnard Yıldızı" };
/** "en" or "tr": opt.lang, else the page's language (js/i18n.js), else English. */
function langOf(opt) {
  let l = opt && opt.lang;
  if (!l) { try { const g = globalThis.__fzI18n; l = g && typeof g.lang === "function" ? g.lang() : "en"; } catch (_) { l = "en"; } }
  return l === "tr" ? "tr" : "en";
}
const dc = (s) => String(s).replace(/(\d)\.(\d)/g, "$1,$2");          // Turkish decimal comma
/** A target's Turkish name (tr.json "tname.*" through js/i18n.js, else a small built-in list). */
function nameTr(n) {
  try { const g = globalThis.__fzI18n; const v = g && g.tname && g.tname(n); if (v && v !== n) return v; } catch (_) {}
  return NAMES_TR[n] || n;
}

const ok = (v) => v != null && Number.isFinite(+v);
/** "2025-09" -> "September 2025" / "Eylül 2025" (anything else is returned as it is). */
export function monthName(ep, lang = "en") {
  const m = /^(\d{4})-(\d{2})/.exec(ep || "");
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${(lang === "tr" ? MONTHS_TR : MONTHS)[+m[2] - 1]} ${m[1]}` : String(ep || "");
}
/** Position angle (deg, 0 = north, 90 = east) -> one of 8 compass words (Turkish `to`: "kuzeye", ...). */
export function compass(pa, lang = "en", to = false) {
  const i = Math.round((((+pa % 360) + 360) % 360) / 45) % 8;
  return lang === "tr" ? (to ? DIRS_TR_TO : DIRS_TR)[i] : DIRS[i];
}
const arcsec = (v, lang) => { const s = (Math.abs(v) >= 1 ? (+v).toFixed(1) : (+v).toFixed(2)) + "″"; return lang === "tr" ? dc(s) : s; };
function span(dt, lang) {
  if (!ok(dt) || dt <= 0) return "";
  const y = Math.round(dt);
  if (lang === "tr") {
    if (y >= 1 && Math.abs(dt - y) < 0.12) return `${NUM_TR[y] || y} yılda`;
    const mo = Math.max(1, Math.round(dt * 12));
    return `${NUM_TR[mo] || mo} ayda`;
  }
  if (y >= 1 && Math.abs(dt - y) < 0.12) return y === 1 ? "in one year" : `in ${NUM[y] || y} years`;
  const mo = Math.max(1, Math.round(dt * 12));
  return mo === 1 ? "in one month" : `in ${NUM[mo] || mo} months`;
}
/** Wavelength bins (µm) -> "4.6 µm", "4–5 µm" (the 4.6 µm bin reaches about 4.9 µm). */
export function bandLabel(ws, lang = "en") {
  const v = [...ws].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return "";
  const f = (x) => (lang === "tr" ? dc(String(+x.toFixed(1))) : String(+x.toFixed(1)));
  if (v.length === 1) return `${f(v[0])} µm`;
  const hi = v[v.length - 1] >= 4.5 ? 5 : v[v.length - 1];
  return `${f(v[0])}–${f(hi)} µm`;
}
/** Who the prediction comes from, or null when the job had no catalogue motion (a plain sky position). */
function predictor(meta) {
  const lab = ((meta && meta.gaia) || {}).label || "";
  if (/requested position/i.test(lab)) return null;
  // nom / gen: Turkish subject and genitive ("Gaia" / "Gaia'nın")
  if (/gaia/i.test(lab)) return { who: "Gaia", verb: "predicts", nom: "Gaia", gen: "Gaia'nın" };
  if (/spitzer/i.test(lab)) return { who: "earlier Spitzer measurements", verb: "predict", nom: "önceki Spitzer ölçümleri", gen: "önceki Spitzer ölçümlerinin" };
  return { who: "the catalogue", verb: "predicts", nom: "katalog", gen: "kataloğun" };
}
/** The target's name, or "The source at the centre" for an unnamed sky position. */
function subject(meta) {
  const n = String((meta && meta.target) || "").trim();
  return !n || /^(none|null|undefined)$/i.test(n) || /^sky field\b/i.test(n) ? null : n;
}
const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

function motionSentence(meta, ms, S, L) {
  const s = +ms.shift_arcsec;
  const e = ok(ms.shift_err_arcsec) && ms.shift_err_arcsec > 0 ? +ms.shift_err_arcsec : null;
  const eU = e ?? Math.max(0.1, 0.05 * s);                     // no error bar: be conservative
  const P = predictor(meta);
  const p = P && ok(ms.gaia_predicted_arcsec) ? +ms.gaia_predicted_arcsec : null;
  const t = span(ms.dt_years) || (ms.from_epoch && ms.to_epoch ? `between ${monthName(ms.from_epoch)} and ${monthName(ms.to_epoch)}` : "");
  const dir = ok(ms.pa_deg) ? compass(ms.pa_deg) : "";
  const sig = s > Math.max(3 * eU, 0.2);
  const predSig = p != null && p > Math.max(3 * eU, 0.2);
  // seen only in some wavelength bins (e.g. WISE 0855: 4–5 µm only)
  const det = ms.detection || {};
  const allBins = (meta.wavelength_bins || []).map((b) => b.wavelength_um);
  const seen = det.detected_bins_um || [];
  const band = ms.status === "partial" && seen.length && seen.length < new Set(allBins).size
    ? ` (seen only at ${bandLabel(seen)})` : "";
  const pred = P ? `${P.who} ${P.verb}` : "";
  const err = e != null ? ` ± ${(+e).toFixed(s >= 1 ? 1 : 2)}″` : "";
  if (L === "tr") {
    const A = (v) => arcsec(v, "tr");
    const tt = span(ms.dt_years, "tr") || (ms.from_epoch && ms.to_epoch ? `${monthName(ms.from_epoch, "tr")} ile ${monthName(ms.to_epoch, "tr")} arasında` : "");
    const to = ok(ms.pa_deg) ? compass(ms.pa_deg, "tr", true) : "";
    const bandT = band ? ` (yalnızca ${bandLabel(seen, "tr")}'de görüldü)` : "";
    const errT = dc(err);
    const pTo = ok(ms.gaia_pa_deg) ? ` ${compass(ms.gaia_pa_deg, "tr", true)}` : "";
    if (sig && predSig) {
      const same = Math.abs(s - p) <= Math.max(3 * eU, 0.1 + 0.05 * p) &&
        (!ok(ms.gaia_pa_deg) || !ok(ms.pa_deg) || angDiff(ms.pa_deg, ms.gaia_pa_deg) <= Math.max(15, (180 / Math.PI) * Math.atan2(3 * eU, s)));
      if (same) return `${S} ${tt} ${A(s)} ${to} kaydı${bandT}; ${P.gen} tahminiyle aynı.`;
      return `${S} ${tt} ${A(s)}${errT} ${to} kaydı${bandT}; ${P.nom} ${A(p)}${pTo} kayma bekliyor. Aradaki fark doğrulanmadı.`;
    }
    if (sig) {
      return `${S} ${tt} ${A(s)}${errT} ${to} kaymış görünüyor${bandT}: hareket eden bir aday, doğrulanmadı` +
        (P && p != null ? ` (${P.nom} belirgin bir hareket beklemiyor).` : ".");
    }
    if (predSig) {
      return `${S}: belirgin bir hareket ölçülmedi (${tt} ${A(s)}${errT}), oysa ${P.nom} ${A(p)}${pTo} kayma bekliyor. Ölçüm burada fazla belirsiz.`;
    }
    return `${S} ölçülebilir bir hareket göstermedi: ${tt} ${A(s)}${errT}, yani hata payı içinde sıfır` +
      (P && p != null ? `; ${P.gen} beklediği gibi.` : ".");
  }
  if (sig && predSig) {
    const same = Math.abs(s - p) <= Math.max(3 * eU, 0.1 + 0.05 * p) &&
      (!ok(ms.gaia_pa_deg) || !ok(ms.pa_deg) || angDiff(ms.pa_deg, ms.gaia_pa_deg) <= Math.max(15, (180 / Math.PI) * Math.atan2(3 * eU, s)));
    if (same) return `${S} moved ${arcsec(s)} ${dir} ${t}${band}, as ${pred}.`;
    return `${S} moved ${arcsec(s)}${err} ${dir} ${t}${band}; ${pred} ${arcsec(p)}` +
      (ok(ms.gaia_pa_deg) ? ` ${compass(ms.gaia_pa_deg)}` : "") + `. The difference is unconfirmed.`;
  }
  if (sig) {
    return `${S} seems to have moved ${arcsec(s)}${err} ${dir} ${t}${band}: a moving-object candidate, not confirmed` +
      (P && p != null ? ` (${P.who} ${P.verb === "predict" ? "expect" : "expects"} no clear motion).` : ".");
  }
  if (predSig) {
    return `${S}: no clear motion measured (${arcsec(s)}${err} ${t}), although ${pred} ${arcsec(p)}` +
      (ok(ms.gaia_pa_deg) ? ` ${compass(ms.gaia_pa_deg)}` : "") + `. The measurement is too uncertain here.`;
  }
  return `${S} did not move measurably: ${arcsec(s)}${err} ${t}, which is zero within the errors` +
    (P && p != null ? `, as ${pred}.` : ".");
}

/** How a brightness ratio reads: "about half as bright", "about 25% fainter", "about twice as bright". */
export function howMuch(r, lang = "en") {
  if (lang === "tr") {                                     // Turkish: adverb + verb ("yaklaşık yarı yarıya sönükleşti")
    if (r < 1) {
      const f = 1 / r;
      if (f >= 2.5) return `yaklaşık ${Math.round(f)} kat sönükleşti`;
      if (f >= 1.7) return "yaklaşık yarı yarıya sönükleşti";
      return `yaklaşık %${Math.max(5, Math.round((1 - r) * 20) * 5)} sönükleşti`;
    }
    if (r >= 2.5) return `yaklaşık ${Math.round(r)} kat parlaklaştı`;
    if (r >= 1.7) return "yaklaşık iki kat parlaklaştı";
    return `yaklaşık %${Math.max(5, Math.round((r - 1) * 20) * 5)} parlaklaştı`;
  }
  if (r < 1) {
    const f = 1 / r;
    if (f >= 2.5) return `about ${Math.round(f)} times fainter`;
    if (f >= 1.7) return "about half as bright";
    return `about ${Math.max(5, Math.round((1 - r) * 20) * 5)}% fainter`;
  }
  if (r >= 2.5) return `about ${Math.round(r)} times brighter`;
  if (r >= 1.7) return "about twice as bright";
  return `about ${Math.max(5, Math.round((r - 1) * 20) * 5)}% brighter`;
}

/** The strongest brightness change: { main, group, ratio, from, to, label, all } or { flat } or null. */
export function brightnessChange(ph) {
  const bins = ((ph && ph.bins) || []).filter((b) => (b.seasons || []).length >= 2)
    .sort((a, b) => a.wavelength_um - b.wavelength_um);
  if (!bins.length) return null;
  const cands = [];
  bins.forEach((b, i) => {
    const ref = b.seasons[0];
    b.seasons.slice(1).forEach((s) => {
      const r = +s.ratio_to_first, er = +s.ratio_err;
      if (ok(r) && r > 0 && ok(er) && er > 0) cands.push({ i, b, ref: ref.epoch, to: s.epoch, r, er, z: Math.abs(r - 1) / er });
    });
  });
  const sig = cands.filter((c) => c.z >= 3 && Math.abs(c.r - 1) >= 0.1).sort((a, b) => b.z - a.z);
  if (!sig.length) {
    const errs = cands.map((c) => c.er).sort((a, b) => a - b);
    const last = bins[0].seasons;
    return { flat: true, from: last[0].epoch, to: last[last.length - 1].epoch,
      err: errs.length ? errs[Math.floor(errs.length / 2)] : null };
  }
  const main = sig[0];
  // neighbouring bins that changed the same way between the same two seasons (2σ, within 30 %)
  const like = (i) => cands.find((c) => c.i === i && c.ref === main.ref && c.to === main.to &&
    (c.r < 1) === (main.r < 1) && c.z >= 2 && Math.abs(Math.log(c.r / main.r)) <= Math.log(1.3));
  const group = [main];
  for (let i = main.i - 1; i >= 0 && like(i); i--) group.unshift(like(i));
  for (let i = main.i + 1; i < bins.length && like(i); i++) group.push(like(i));
  const rs = group.map((c) => c.r).sort((a, b) => a - b);
  const ratio = rs[Math.floor(rs.length / 2)];
  const all = group.length >= 3 && group.length === bins.length;
  // a significant change the other way, same seasons, elsewhere in the spectrum
  const other = sig.filter((c) => c.ref === main.ref && c.to === main.to && (c.r < 1) !== (main.r < 1))[0] || null;
  return { main, group, ratio, from: main.ref, to: main.to, all, other,
    label: bandLabel(group.map((c) => c.b.wavelength_um)) };
}

function brightnessSentence(meta, ph, S, named, L) {
  const c = brightnessChange(ph);
  if (L === "tr") return brightnessSentenceTr(ph, c, S, named);
  const cand = named ? "" : ": a brightness-change candidate, not confirmed";
  const sat = (ph.bins || []).some((b) => b.saturated || (b.flags || []).some((f) => /saturat/i.test(f)));
  const note = sat ? "Rough estimate: the star is so bright that its centre saturates the detector, so its outer glow is measured." : "";
  if (!c) return { text: `There are too few comparison stars here to measure how ${named ? S : "the source at the centre"} changes in brightness.`, note: "" };
  if (c.flat) {
    return { text: `${S} kept about the same brightness between ${monthName(c.from)} and ${monthName(c.to)}: no change larger than the errors` +
      (ok(c.err) ? ` (about ±${Math.round(100 * c.err)}%)` : "") + ".", note };
  }
  const where = c.all ? `at every wavelength measured (${c.label})` : `at ${c.label}`;
  let t = `${S} got ${howMuch(c.ratio)} ${where} between ${monthName(c.from)} and ${monthName(c.to)}`;
  if (c.other) t += `, while it got ${howMuch(c.other.r)} at ${bandLabel([c.other.b.wavelength_um])}`;
  return { text: t + cand + ".", note };
}

function brightnessSentenceTr(ph, c, S, named) {
  const cand = named ? "" : ": parlaklığı değişen bir aday, doğrulanmadı";
  const sat = (ph.bins || []).some((b) => b.saturated || (b.flags || []).some((f) => /saturat/i.test(f)));
  const note = sat ? "Kaba tahmin: yıldız çok parlak, merkezi dedektörde doyuyor. Bu yüzden yıldızın dış kısmındaki ışık ölçülüyor." : "";
  if (!c) return { text: `Burada karşılaştırma yıldızı çok az; ${named ? S : "merkezdeki kaynak"} için parlaklık değişimi ölçülemiyor.`, note: "" };
  const between = `${monthName(c.from, "tr")} ile ${monthName(c.to, "tr")} arasında`;
  if (c.flat) {
    return { text: `${S}, ${between} aşağı yukarı aynı parlaklıkta kaldı: hata payından büyük bir değişim yok` +
      (ok(c.err) ? ` (yaklaşık ±%${Math.round(100 * c.err)})` : "") + ".", note };
  }
  const where = c.all ? `ölçülen her dalga boyunda (${bandLabel(c.group.map((g) => g.b.wavelength_um), "tr")})` : `${bandLabel(c.group.map((g) => g.b.wavelength_um), "tr")}'de`;
  let t = `${S}, ${between} ${where} ${howMuch(c.ratio, "tr")}`;
  if (c.other) t += `; ${bandLabel([c.other.b.wavelength_um], "tr")}'de ise ${howMuch(c.other.r, "tr")}`;
  return { text: t + cand + ".", note };
}

/** One plain sentence (plus an optional caveat) for a meta.json, or null if there is nothing to say. */
export function plainSentence(meta, opt) {
  if (!meta || typeof meta !== "object") return null;
  const L = langOf(opt);
  const ms = meta.measured || {};
  const name = subject(meta);
  const S = name ? (L === "tr" ? nameTr(name) : name) : (L === "tr" ? "Merkezdeki kaynak" : "The source at the centre");
  const status = ms.status || (ms.detection || {}).status || "";
  const tidy = (s) => (L === "tr" ? s.replace(/\( /g, "(").replace(/ \)/g, ")").trim() : s);
  try {
    if (ms.photometry) return brightnessSentence(meta, ms.photometry, S, !!name, L);
    if (ok(ms.shift_arcsec)) return { text: tidy(motionSentence(meta, ms, S, L).replace(/ {2,}/g, " ").replace(/ ([,.;:])/g, "$1")), note: "" };
    if (L === "tr") { const r = plainSentenceTr(meta, ms, status, name, S); if (r !== undefined) return r; }
    if (status === "preview" || meta.preview) {
      const pre = ms.preliminary;
      const pv = meta.preview || {};
      const at = ok(pv.bin_um) ? ` at ${(+pv.bin_um).toFixed(1)} µm` : "";
      if (pre && ok(pre.shift_arcsec)) {
        const P = predictor(meta);
        return {
          text: `Quick look: ${S} seems to have moved about ${arcsec(pre.shift_arcsec)} ${compass(pre.pa_deg)} between ` +
            `${monthName(pre.from_epoch)} and ${monthName(pre.to_epoch)}` +
            (P && ok(pre.catalogue_shift_arcsec) ? ` (${P.who} ${P.verb} ${arcsec(pre.catalogue_shift_arcsec)})` : "") + ".",
          note: `A rough first look${at}, without error bars. The full measurement follows.`,
        };
      }
      return { text: `Quick look${at}: watch the blink for anything that moves or changes. The full measurement follows.`, note: "" };
    }
    const seen = ((ms.detection || {}).detected_bins_um) || [];
    if (status === "not_detected") {
      return { text: name ? `${name} is too faint to measure here: it does not stand out above the noise in any season.`
        : "Too faint to measure here: nothing at the centre stands out above the noise in any season.", note: "" };
    }
    if (status === "detected_one_season") {
      return { text: `${S} shows up in only one season${seen.length ? ` (at ${bandLabel(seen)})` : ""}, so its motion cannot be measured here.`, note: "" };
    }
    if (status === "partial" && seen.length) {
      return { text: `${S} shows up only at ${bandLabel(seen)}; its motion could not be measured here.`, note: "" };
    }
    if (status === "detected") return { text: `${S} shows up in every season, but its motion could not be measured here.`, note: "" };
    const msg = ms.message || (ms.detection || {}).message;
    return msg ? { text: msg, note: "" } : null;
  } catch (e) {
    const msg = ms.message || (ms.detection || {}).message;
    return msg ? { text: msg, note: "" } : null;
  }
}

/** Turkish for the preview and "not measured" cases; undefined = fall through (pipeline message). */
function plainSentenceTr(meta, ms, status, name, S) {
  if (status === "preview" || meta.preview) {
    const pre = ms.preliminary;
    const pv = meta.preview || {};
    const at = ok(pv.bin_um) ? ` (${dc((+pv.bin_um).toFixed(1))} µm)` : "";
    if (pre && ok(pre.shift_arcsec)) {
      const P = predictor(meta);
      return {
        text: `Hızlı bakış: ${S}, ${monthName(pre.from_epoch, "tr")} ile ${monthName(pre.to_epoch, "tr")} arasında yaklaşık ` +
          `${arcsec(pre.shift_arcsec, "tr")} ${compass(pre.pa_deg, "tr", true)} kaymış görünüyor` +
          (P && ok(pre.catalogue_shift_arcsec) ? ` (${P.nom} ${arcsec(pre.catalogue_shift_arcsec, "tr")} bekliyor)` : "") + ".",
        note: `Kaba bir ilk bakış${at}, hata payı olmadan. Tam ölçüm birazdan gelecek.`,
      };
    }
    return { text: `Hızlı bakış${at}: blink'te hareket eden ya da değişen bir şey var mı, izleyin. Tam ölçüm birazdan gelecek.`, note: "" };
  }
  const seen = ((ms.detection || {}).detected_bins_um) || [];
  if (status === "not_detected") {
    return { text: name ? `${S} burada ölçülemeyecek kadar sönük: hiçbir sezonda gürültünün üstüne çıkmıyor.`
      : "Burada ölçülemeyecek kadar sönük: merkezde hiçbir sezonda gürültünün üstüne çıkan bir şey yok.", note: "" };
  }
  if (status === "detected_one_season") {
    return { text: `${S} yalnızca bir sezonda görünüyor${seen.length ? ` (${bandLabel(seen, "tr")}'de)` : ""}; bu yüzden hareketi burada ölçülemiyor.`, note: "" };
  }
  if (status === "partial" && seen.length) {
    return { text: `${S} yalnızca ${bandLabel(seen, "tr")}'de görünüyor; hareketi burada ölçülemedi.`, note: "" };
  }
  if (status === "detected") return { text: `${S} her sezonda görünüyor, ama hareketi burada ölçülemedi.`, note: "" };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// "What you are seeing" strip
// ---------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function seeingItems(meta, has = {}, opt) {
  const L = langOf(opt);
  const ms = (meta && meta.measured) || {};
  const ref = (((meta && meta.gaia) || {}).label || "Gaia DR3").split(" (")[0];
  const P = predictor(meta);
  const bins = (meta && meta.wavelength_bins) || [];
  const moved = ok(ms.shift_arcsec) ? ms : (ms.preliminary && ok(ms.preliminary.shift_arcsec) ? ms.preliminary : null);
  const bc = ms.photometry ? brightnessChange(ms.photometry) : null;
  const curveBin = bc && bc.main ? bc.main.b.wavelength_um : null;
  const items = [
    { key: "blink", name: "Blink", show: bins.length > 0,
      text: "The same patch of sky in each season, one after another. Still dots are background; a dot that jumps has moved.",
      ask: "The main ask: a sequence of SPHEREx images, played like a short video (as in WiseView)." },
    { key: "ring", name: "Ring", show: !!((meta.markers || []).length || (ms.positions || []).length),
      text: P ? `Where ${ref} puts the target in that season.` : "The position you picked.",
      ask: "Suggested: overlay Gaia (or WISE) positions." },
    { key: "diff", name: "Difference image", show: bins.some((b) => b.diff),
      text: "Last season minus the first. Still stars cancel out; red = later, blue = earlier.",
      ask: "Suggested: subtract images taken on different dates." },
    { key: "arrow", name: "Arrow", show: !!moved,
      text: moved ? `The measured motion: ${arcsec(moved.shift_arcsec)} toward ${compass(moved.pa_deg)}` +
        (ok(moved.dt_years) ? ` ${span(moved.dt_years)}` : "") + " (north up, east left, like the image)." : "",
      ask: "The goal: make moving objects easy to spot." },
    { key: "curve", name: "Light curve", show: !!curveBin,
      text: curveBin ? `Brightness in each season at ${(+curveBin).toFixed(1)} µm, compared with nearby stars (1 = first season).` : "",
      ask: "The second test: objects that change brightness (RW Aur, R Dra)." },
    { key: "spectrum", name: "Spectrum", show: !!(has.spectrum || (meta && (meta.spectrum || ms.spectrum))),
      text: "Brightness across SPHEREx's colours, from 0.75 to 5 µm.",
      ask: "Extra credit: an instant spectrum from SPHEREx's 102 colours." },
    { key: "cands", name: "Candidate rings", show: !!has.cands,
      text: "Spots the automatic finder flags as moving or changing: candidates to check, not discoveries.",
      ask: "Our extra: automatic finding (the challenge asks only for the viewer)." },
  ];
  if (L !== "tr") return items;
  const trx = {
    blink: ["Blink", "Aynı gökyüzü parçası, her sezondan bir görüntü, art arda. Yerinde duran noktalar arka plandır; sıçrayan nokta hareket etmiştir.",
      "Ana istek: SPHEREx görüntülerinden kısa bir video gibi oynatılan bir dizi (WiseView'daki gibi)."],
    ring: ["Halka", P ? `Hedefin o sezonda olması gereken yer (${ref}).` : "Seçtiğiniz konum.",
      "Önerilen: Gaia (ya da WISE) konumlarını görüntünün üstüne koymak."],
    diff: ["Fark görüntüsü", "Son sezon eksi ilk sezon. Yerinde duran yıldızlar birbirini siler; kırmızı = sonra, mavi = önce.",
      "Önerilen: farklı tarihlerde çekilen görüntüleri birbirinden çıkarmak."],
    arrow: ["Ok", moved ? `Ölçülen hareket: ${ok(moved.dt_years) ? span(moved.dt_years, "tr") + " " : ""}${arcsec(moved.shift_arcsec, "tr")} ` +
        `${compass(moved.pa_deg, "tr", true)} (görüntüdeki gibi kuzey yukarıda, doğu solda).` : "",
      "Amaç: hareket eden cisimleri kolayca fark ettirmek."],
    curve: ["Işık eğrisi", curveBin ? `Her sezondaki parlaklık, ${dc((+curveBin).toFixed(1))} µm'de, yakındaki yıldızlarla karşılaştırmalı (1 = ilk sezon).` : "",
      "İkinci test: parlaklığı değişen cisimler (RW Aur, R Dra)."],
    spectrum: ["Tayf", "SPHEREx'in renkleri boyunca parlaklık, 0,75'ten 5 µm'ye.",
      "Ek puan: SPHEREx'in 102 renginden anında bir tayf."],
    cands: ["Aday halkaları", "Otomatik bulucunun hareket eden ya da değişen diye işaretlediği noktalar: kontrol edilecek adaylar, kesin bulgu değil.",
      "Bizim eklememiz: otomatik bulma (yarışma yalnızca görüntüleyiciyi istiyor)."],
  };
  return items.map((it) => (trx[it.key] ? { ...it, name: trx[it.key][0], text: trx[it.key][1], ask: trx[it.key][2] } : it));
}

// small pictures for the strip (inline SVG, colours from the viewer)
function arrowSvg(m, P, lang) {
  const tr = lang === "tr";
  const S = 44, c = S / 2, L = 15;
  const end = (pa, l) => [c - l * Math.sin(pa * Math.PI / 180), c - l * Math.cos(pa * Math.PI / 180)];
  const [x, y] = end(m.pa_deg, L);
  const pPa = ok(m.gaia_pa_deg) ? m.gaia_pa_deg : ok(m.catalogue_pa_deg) ? m.catalogue_pa_deg : null;
  const pred = P && pPa != null ? (() => { const [a, b] = end(pPa, L + 3); return `<line x1="${c}" y1="${c}" x2="${a.toFixed(1)}" y2="${b.toFixed(1)}" stroke="#9aa3b2" stroke-width="1.2" stroke-dasharray="2 2"><title>${esc(tr ? `${P.gen} tahmini` : `${P.who} prediction`)}</title></line>`; })() : "";
  return `<svg class="fzx-pic" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="${tr ? `${compass(m.pa_deg, "tr", true)} doğru ok` : `Arrow toward ${compass(m.pa_deg)}`}">` +
    `<circle cx="${c}" cy="${c}" r="20" fill="none" stroke="#333b50"/>` +
    `<text x="${c}" y="8" fill="#9aa3b2" font-size="8" text-anchor="middle">${tr ? "K" : "N"}</text>` +
    `<text x="5" y="${c + 3}" fill="#9aa3b2" font-size="8" text-anchor="middle">${tr ? "D" : "E"}</text>` + pred +
    `<line x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#ffb347" stroke-width="2.2" stroke-linecap="round" marker-end="url(#fzxHead)"/>` +
    `<defs><marker id="fzxHead" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#ffb347"/></marker></defs>` +
    `<circle cx="${c}" cy="${c}" r="2" fill="#e8eaf0"/></svg>`;
}
function curveSvg(meta, bin, L) {
  const tr = L === "tr", d = (s) => (tr ? dc(s) : s);
  const eps = meta.epochs || [];
  const pts = (bin.seasons || []).map((s) => ({ i: eps.indexOf(s.epoch), r: +s.ratio_to_first, e: +s.ratio_err || 0, ep: s.epoch }))
    .filter((p) => p.i >= 0 && ok(p.r));
  if (pts.length < 2) return "";
  const W = 96, H = 44, px = 8, py = 6;
  const lo = Math.min(1, ...pts.map((p) => p.r - p.e)), hi = Math.max(1, ...pts.map((p) => p.r + p.e));
  const pad = (hi - lo) * 0.1 || 0.1;
  const Y = (v) => py + (H - 2 * py) * (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad)));
  const X = (i) => px + (W - 2 * px) * (eps.length > 1 ? i / (eps.length - 1) : 0.5);
  const line = pts.map((p, k) => `${k ? "L" : "M"}${X(p.i).toFixed(1)} ${Y(p.r).toFixed(1)}`).join("");
  return `<svg class="fzx-pic" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${tr ? `${d((+bin.wavelength_um).toFixed(1))} µm'de ışık eğrisi` : `Light curve at ${(+bin.wavelength_um).toFixed(1)} µm`}">` +
    `<line x1="${px - 4}" x2="${W - px + 4}" y1="${Y(1).toFixed(1)}" y2="${Y(1).toFixed(1)}" stroke="#333b50" stroke-dasharray="3 3"/>` +
    pts.map((p) => p.e ? `<line x1="${X(p.i).toFixed(1)}" x2="${X(p.i).toFixed(1)}" y1="${Y(p.r - p.e).toFixed(1)}" y2="${Y(p.r + p.e).toFixed(1)}" stroke="#7a8296" stroke-width="1.2"/>` : "").join("") +
    `<path d="${line}" fill="none" stroke="#ffb347" stroke-width="2"/>` +
    pts.map((p) => `<circle cx="${X(p.i).toFixed(1)}" cy="${Y(p.r).toFixed(1)}" r="3.5" fill="#ffb347" stroke="#151925" stroke-width="1.5"><title>${esc(monthName(p.ep, L))}: ${d(p.r.toFixed(2))}${p.e ? " ± " + d(p.e.toFixed(2)) : tr ? " (referans)" : " (reference)"}</title></circle>`).join("") +
    `</svg>`;
}

function picFor(meta, key, L) {
  const ms = (meta && meta.measured) || {};
  if (key === "arrow") {
    const moved = ok(ms.shift_arcsec) ? ms : (ms.preliminary && ok(ms.preliminary.shift_arcsec) ? ms.preliminary : null);
    return moved && ok(moved.pa_deg) ? arrowSvg(moved, predictor(meta), L) : "";
  }
  if (key === "curve") {
    const bc = ms.photometry ? brightnessChange(ms.photometry) : null;
    return bc && bc.main ? curveSvg(meta, bc.main.b, L) : "";
  }
  return "";
}

/** Sentence, caveat and strip items (with small pictures) for one result. */
export function explainResult(meta, has = {}, opt) {
  const L = langOf(opt);
  const ps = plainSentence(meta, { lang: L });
  let items = [];
  try { items = seeingItems(meta || {}, has, { lang: L }).map((it) => ({ ...it, pic: it.show ? picFor(meta, it.key, L) : "" })); } catch (_) {}
  return { sentence: ps ? ps.text : null, note: ps ? ps.note || "" : "", items };
}

const CSS = `
.fzx-plain { margin:0 0 10px; padding:9px 12px; border-radius:8px; background:#151925; border-left:4px solid #ffb347; }
.fzx-plain p { margin:0; font-size:1.02rem; }
.fzx-plain small { display:block; margin-top:3px; }
.fzx-seeing { margin-top:10px; }
.fzx-seeing summary { color:#9aa3b2; font-size:.9rem; margin:0 0 6px; }
.fzx-items { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:6px; }
.fzx-items li { background:#151925; border-radius:8px; padding:7px 9px; font-size:.84rem; line-height:1.35; display:flex; gap:8px; align-items:flex-start; }
.fzx-items li b { color:#e8eaf0; }
.fzx-items li div { min-width:0; }
.fzx-items .ask { display:block; color:#7f8aa0; font-size:.78rem; margin-top:2px; }
.fzx-items li.wide { flex-direction:column; gap:4px; }
.fzx-pic { flex:none; }
`;

function addStyle(id, css) {
  if (document.getElementById(id)) return;
  const st = document.createElement("style");
  st.id = id; st.textContent = css;
  document.head.appendChild(st);
}

/** Put the sentence and the strip on the page (containers by id, else the current ornek.html layout). */
export function mountExplain(meta, base = "", where = {}) {
  addStyle("fzx-style", CSS);
  const has = { spectrum: false, cands: false };
  // sentence: #explainSentence, else above the blink controls
  let box = where.sentenceEl || document.getElementById("explainSentence");
  if (!box) {
    box = document.createElement("div");
    box.id = "explainSentence";
    const ctl = document.querySelector(".controls");
    (ctl ? ctl.parentNode : document.body).insertBefore(box, ctl || null);
  }
  box.classList.add("fzx-plain");
  box.setAttribute("aria-live", "polite");
  // strip: #explainStrip, else below the image, above the measurement card
  let host = where.stripEl || document.getElementById("explainStrip");
  if (!host) {
    host = document.createElement("div");
    host.id = "explainStrip";
    const card = document.getElementById("mtitle") && document.getElementById("mtitle").closest(".card");
    (card ? card.parentNode : document.body).insertBefore(host, card || null);
  }
  const draw = () => {
    const r = explainResult(meta, has);
    box.hidden = !r.sentence;
    box.innerHTML = r.sentence ? `<p>${esc(r.sentence)}</p>` + (r.note ? `<small>${esc(r.note)}</small>` : "") : "";
    const items = r.items.filter((it) => it.show);
    const was = host.querySelector("details.fzx-seeing");
    const sum = langOf() === "tr" ? "Ne görüyorsunuz" : "What you are seeing";
    host.innerHTML = `<details class="fzx-seeing"${!was || was.open ? " open" : ""}><summary>${sum}</summary><ul class="fzx-items">` + items.map((it) =>
      `<li data-key="${it.key}"${it.key === "curve" && it.pic ? ' class="wide"' : ""}>${it.pic}<div><b>${esc(it.name)}</b>: ${esc(it.text)}` +
      `<span class="ask">${esc(it.ask)}</span></div></li>`).join("") + `</ul></details>`;
  };
  draw();
  host.__fzxDraw = draw;                                   // the latest result, for the language switch
  if (host.__fzx) return host.__fzx;                       // listeners only once per container
  document.addEventListener("fazari:lang", () => { try { host.__fzxDraw(); } catch (e) { console.warn("explain.js", e); } });
  const set = (k, on) => { if (k in has && has[k] !== !!on) { has[k] = !!on; draw(); } };
  document.addEventListener("fazari:has", (ev) => { const d = ev.detail || {}; set(d.key === "candidates" ? "cands" : d.key, d.on !== false); });
  // other modules' output on the page
  // only count visible, filled containers (an empty or hidden #spectrum is just a mount point)
  const shown = (sel) => [...document.querySelectorAll(sel)].some((el) => !el.closest("[hidden]") && el.childElementCount > 0);
  const look = () => {
    if (!has.spectrum && shown("#spectrum, .spectrum-chart, [data-fz-spectrum]")) set("spectrum", true);
    if (!has.cands && (document.querySelector(".cand-ring") || shown("[data-fz-candidates]"))) set("cands", true);
  };
  let pend = 0;
  try { new MutationObserver(() => { if (!pend) pend = setTimeout(() => { pend = 0; look(); }, 300); }).observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  look();
  if (base) {
    fetch(base + "candidates.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && (d.candidates || []).length) set("cands", true); }).catch(() => {});
  }
  host.__fzx = { set };
  return host.__fzx;
}
