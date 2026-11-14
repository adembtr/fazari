// English / Turkish text for the pages and sections owned by this module set:
// the opening hero (explore/hero.js), verify.html, story.html.
// Other pages are not translated.
//
// Static HTML keeps its English text in the page; elements carry data-i18n="key" (text),
// data-i18n-html="key" (trusted markup from this file) or data-i18n-attr="attr:key;attr:key".
// The English text is remembered on first use, so switching back restores it exactly.
// JavaScript-built text uses t(key, vars) and the EN table below.
//
// Language: ?lang=tr|en, else the saved choice (localStorage "fz-lang"), else English.

import { TR } from "./fz_i18n_tr.js";

const EN = {
  // hero (explore/hero.js)
  "hero.kicker": "Real NASA SPHEREx data · not a simulation",
  "hero.title": "Barnard's Star moved {shift} in one year. Watch it.",
  "hero.hook": "Pluto was found by blinking two photographs. Now you can blink the infrared sky.",
  "hero.blinkLabel": "SPHEREx, {um} µm, {date}. Box {box}′ wide; the full Moon is about 30′.",
  "hero.blinkAlt": "Two SPHEREx infrared images of Barnard's Star taken a year apart, shown one after the other. The bright star jumps upward (north) by about {shift}.",
  "hero.pause": "Pause",
  "hero.play": "Play",
  "hero.card.images": "SPHEREx images",
  "hero.card.seasons": "seasons, {from} – {to}",
  "hero.card.measured": "measured by us",
  "hero.card.gaia": "Gaia DR3 predicts",
  "hero.card.measuredSub": "{from} → {to}",
  "hero.explore": "Explore the sky",
  "hero.result": "See the measurement",
  "hero.evidence": "Is it right? Check the evidence",
  "hero.story": "What is SPHEREx? Meet the targets",
  "hero.reopen": "Watch Barnard's Star move",
  "hero.close": "Close and explore the sky",

  // verify.html (js/verify.js)
  "dir.east": "east",
  "dir.west": "west",
  "dir.north": "north",
  "dir.south": "south",
  "v.title": "Fazari Evidence",
  "v.loading": "Loading the measurements…",
  "v.noData": "The verification table could not be loaded.",
  "v.tag.challenge": "Challenge target",
  "v.tag.extra": "Extra target",
  "v.onlyBins": "Detected only at {bins} µm.",
  "v.pm": "Proper motion from our fit: {m1}, {m2} ± {e} mas a year; reference {r1}, {r2} ({s1}σ, {s2}σ).",
  "v.ref.simbad": "SIMBAD",
  "v.ref.kirk": "Kirkpatrick et al. 2021 (Spitzer)",
  "v.ref.gaia": "Gaia DR3",
  "v.luhmanRef": "The prediction has no parallax; between these two seasons it cancels to {p}″ or less.",
  "v.pass": "Pass",
  "v.fail": "Fail",
  "v.localJob": "Run with the local engine (not in the online site).",
  "v.open": "Open the blink",
  "v.col.target": "Target",
  "v.col.what": "What we compared",
  "v.col.measured": "Measured by us",
  "v.col.ref": "Reference",
  "v.col.diff": "Difference",
  "v.col.result": "Result",
  "v.what": "Shift {from} → {to} ({dt} yr)",
  "v.images": "{n} SPHEREx images, {s} seasons.",
  "v.sigma": "{s}σ (2-D difference {v}″)",
  "v.motionOnly": "Motion on the sky",
  "v.bright": "We measure its brightness instead: at {um} µm it is {r} ± {e} times the {from} value by {to} (saturated star, wing estimate).",
  "v.perYear": "a year",
  "v.na": "Not measurable here",
  "v.naWhy": "Gaia's expected motion is far below our shift errors ({lo}–{hi}″).",
  "v.table.cap": "Measured shift of each target compared with the reference prediction",
  "v.crit": "Pass rule: the measured shift agrees with the reference within {n}σ, where σ is our own 1σ error of the shift. Catalogue errors are much smaller and are left out. The σ value uses the full 2-D difference: length and direction.",
  "v.src": "Generated on {date} from each target's pipeline output (meta.json) by pipeline/verify_table.py.",
  "v.open.barnard": "<b>Barnard's Star sits {lo}–{hi}″ north of the Gaia prediction in every season</b> (±{err}″; east within {e}″). It cancels in the shift and the proper motion, but we do not know its cause. Fainter neighbours to the north, or a bias of the wing fit that depends on the size of the saturated core, are candidates.",
  "v.open.barnard2": "<b>Barnard's Star sits {lo}–{hi}″ north of the Gaia prediction in every season</b> ({slo}–{shi}σ, counting the calibration error; east within {e}″). It cancels in the shift and the proper motion, but we do not know its cause. Fainter neighbours to the north, or a bias of the wing fit that depends on the size of the saturated core, are candidates.",
  "v.abs.ok": "Position vs reference: within the errors (≤ {s}σ).",
  "v.abs.off": "Position vs reference: offset {e}″ E, {n}″ N (up to {s}σ). See the open questions below.",
  "v.abs.na": "Position vs reference: not testable. The reference position is not good enough (no Gaia 5-parameter solution, epoch-2000 position of a binary).",
  "v.src.acc": "Full accuracy tables (proper motion, season positions, field stars):",
  "v.open.eps": "<b>Epsilon Indi B sits {e}″ {ew} and {n}″ {ns} of the Gaia prediction.</b> The offset is the same in both telescope orientations. Our best explanation: B is a pair of brown dwarfs that Gaia does not resolve, and the infrared centre of light differs from the visible one. This fits the data but is not proven.",
  "v.open.wise": "<b>WISE 0855−0714 passes, but it is a weak test.</b> It is seen only at {bins} µm, and its shift error (±{err}″) is about {k} times larger than Barnard's Star's.",
  "v.open.luhman": "<b>Luhman 16AB sits {e}″ {dir} of its catalogue prediction.</b> That prediction uses a year-2000 SIMBAD position of a binary and no parallax, so we do not interpret the offset. The shift, in which both cancel, agrees.",
  "v.open.bright": "<b>RW Aurigae and R Draconis</b> are saturated in every band, so their brightness changes are wing estimates. We have no independent light curve at these dates to check them against.",
  "v.naive.brightest": "brightest pixel",
  "v.naive.moment": "centre of the saturated core",
  "v.naive.off": "{d} ({p} %) from Gaia",
  "v.naive.ours": "our wing fit",
  "v.naive.gaia": "Gaia DR3 prediction",
  "v.core.cap": "One SPHEREx exposure of Barnard's Star ({date}, detector {det}, {um} µm) in its native 6.15″ pixels.",
  "v.core.alt": "Pixel map of Barnard's Star in one SPHEREx exposure: a block of saturated white pixels in the centre, surrounded by the unsaturated wing pixels that our fit uses.",
  "v.core.sat": "saturated pixels: not used",
  "v.core.fit": "unsaturated wing pixels our fit uses",
  "v.core.ours": "centre from our wing fit (this exposure)",
  "v.pairs.h": "Every pair of seasons: length and direction of the shift",
  "v.pairs.pair": "Seasons",
  "v.pairs.same": "same telescope orientation",
  "v.pairs.turned": "telescope turned by 180°",
  "v.pairs.gaia": "Gaia DR3",
  "v.pairs.ours": "Our wing fit",
  "v.pairs.note": "Half-year pairs compare seasons seen with the telescope turned around. There the naive centre also points the wrong way, by up to {d}° (ours: {o}° or less). A bias fixed to the detector no longer cancels; our fit models it.",
  "v.trust.p1": "Barnard's Star is so bright that the centre of its image is <b>saturated</b>: in this exposure {sat} pixels hit the detector's limit. They are flat white and carry no position information. A naive method that looks at the bright centre measures the shape of that white blob, not the star. Our fit uses the {fit} unsaturated pixels around it.",
  "v.trust.p2": "We fit the star's shape to the unsaturated <b>wings</b> around the core instead, and tie every exposure to Gaia field stars. On the same exposures, a naive centroid on the saturated core gives <b>{naive}</b>. Our wing fit gives <b>{ours}</b>. Gaia predicts <b>{gaia}</b>.",
  "v.trust.how": "Same exposures, same seasons ({from}: {n1} exposures, {to}: {n2}), same image coordinates. Naive methods: the brightest unsaturated pixel, and the brightness-weighted centre (first moment) of an 11 × 11 pixel box with the saturated core filled in as flat white. A season is the median of its exposures; no field-star calibration. Naive results depend on such choices (a 7 × 7 box gives {v7}); this is one common choice. Script: pipeline/naive_centroid.py.",
  "v.ctrl.p1": "Our method should find <b>no motion</b> where there is none. We ran it on <b>{n} field stars around Barnard's Star</b> that barely move (Gaia: under {pm} mas a year), in the same exposures, between {from} and {to}. The test stars never calibrate themselves: each half of the stars is calibrated with the other half.",
  "v.ctrl.median": "typical false motion of the whole group (± {e}″)",
  "v.ctrl.scatter": "scatter of a single star",
  "v.ctrl.within": "of the stars within 3σ of no motion",
  "v.ctrl.barnard": "Barnard's Star, for scale (about {k} times the scatter)",
  "v.ctrl.cap": "False motion of each of the {n} slow field stars, {from} → {to}. Every dot should sit at the centre; the green circle is 0.1″.",
  "v.ctrl.alt": "Scatter plot: the false motions of the field stars all lie within about 0.2 arcseconds of zero.",
  "v.ctrl.off": "On this chart, Barnard's Star's {s} would be {w} chart widths.",
  "v.ctrl.outside": "{k} faint stars with larger errors fall outside ±0.3″ and are not drawn.",
  "v.ctrl.how": "Gaia DR3 reference stars of G {g}: unsaturated, isolated, measured with the same centroid as a bright target (field_stars.csv from blink.py). Calibration: per season and detector, the median offset of the other half of the stars. False motion = change of (measured − Gaia) between the two seasons. Script: pipeline/null_fieldstars.py.",

  // story.html (js/story.js)
  "s.title": "Fazari Targets",
  "s.blinkBtn": "Blink: switch between the two seasons",
  "s.blinkCap": "SPHEREx, {um} µm. Box {box}′ wide (the full Moon is about 30′). Tap to blink.",
  "s.openBlink": "Open the blink",
  "s.onSky": "Find it on the sky",
  "s.what": "What it is:",
  "s.why": "Why it matters:",
  "s.shows": "What SPHEREx shows:",
  "s.barnard.tag": "Moves fastest",
  "s.barnard.what": "A small, cool red dwarf star, {ly} light-years away: one of the Sun's nearest neighbours.",
  "s.barnard.why": "No other star crosses our sky as fast: about {pm}″ a year. If a method cannot see Barnard's Star move, it cannot see anything move.",
  "s.barnard.shows": "Its centre is too bright for the detector (saturated), so we measure it from the edges. It moved {shift} ± {err} from {from} to {to}. Gaia predicts {ref}.",
  "s.eps_indi_b.tag": "Brown dwarf pair",
  "s.eps_indi_b.what": "Two brown dwarfs that orbit each other and, together, the star Epsilon Indi A, {ly} light-years away.",
  "s.eps_indi_b.why": "Brown dwarfs are \"failed stars\": too small to shine like the Sun, they glow mostly in infrared light, which is what SPHEREx sees.",
  "s.eps_indi_b.shows": "It moved {shift} ± {err} in {dt} years (Gaia: {ref}). Its position is about half an arcsecond from Gaia's, possibly because SPHEREx sees the infrared light of the pair, which is centred differently.",
  "s.wise0855.tag": "Coldest known",
  "s.wise0855.what": "The coldest brown dwarf known, {ly} light-years away. It is colder than the freezing point of water (about 225–260 K).",
  "s.wise0855.why": "It is the kind of object a Planet X search looks for: cold, dark, and almost invisible except in infrared light. Gaia cannot see it at all.",
  "s.wise0855.shows": "Only at {bins} µm, and faint. It moved {shift} ± {err} in {dt} years. The prediction from Spitzer measurements is {ref}.",
  "s.luhman16.tag": "Closest brown dwarfs",
  "s.luhman16.what": "The closest brown dwarfs to the Sun: a pair about 6.5 light-years away.",
  "s.luhman16.why": "They were found only in 2013, in infrared images from NASA's WISE. Even the Sun's near neighbours can hide.",
  "s.luhman16.shows": "Not one of the five challenge targets: we ran it with our local engine. It moved {shift} ± {err} in {dt} years. The catalogue predicts {ref}.",
  "s.rw_aur.tag": "Changes brightness",
  "s.rw_aur.what": "A very young star system, still surrounded by gas and dust, about {ly} light-years away.",
  "s.rw_aur.why": "RW Aurigae A is known for deep dimming events, thought to be caused by dust passing in front of the star.",
  "s.rw_aur.shows": "At {um} µm it fades to {r} ± {e} of its {from} brightness by {to}, while at 1 µm it is {r1} times as bright. Its centre is saturated, so these are estimates from the star's edges.",
  "s.r_dra.tag": "Pulsing giant",
  "s.r_dra.what": "A red giant star near the end of its life, about {ly} light-years away, that swells and shrinks.",
  "s.r_dra.why": "Stars like this (Mira variables) change their brightness a lot; R Draconis does it every ~245 days. A good test of measuring brightness.",
  "s.r_dra.shows": "At {um} µm it drops to {r} ± {e} of its {from} brightness by {to}, as expected for a Mira. Its centre is saturated, so these are estimates from the star's edges.",
  "how.lead": "SPHEREx is a NASA space telescope, launched on 11 March 2025. It photographs the whole sky in 102 colours of infrared light, which our eyes cannot see. Four ideas explain what you see in a blink.",
  "how.a.h": "One telescope, six detectors",
  "how.a.p": "A 20 cm telescope sends its light to a dichroic mirror that splits it at 2.42 µm: shorter wavelengths go to three detectors, longer ones to the other three. Both sets look at the same 3.5° × 11.3° patch of sky at once, about 7 by 22 full Moons.",
  "how.a.alt": "Diagram: light from the telescope hits a dichroic mirror; short wavelengths go up to detectors D1 to D3, long wavelengths down to D4 to D6.",
  "how.a.tel": "telescope",
  "how.a.dich": "dichroic mirror",
  "how.b.h": "A rainbow filter on every detector",
  "how.b.p": "Each detector sits behind a linear variable filter: its colour changes smoothly from one edge to the other. Where a star lands on the detector decides which wavelength is measured. 17 channels per detector × 6 detectors = 102 colours, from 0.75 to 5.0 µm.",
  "how.b.alt": "Diagram: one detector covered by a filter whose colour changes in 17 steps from one edge to the other.",
  "how.b.det": "One detector behind its filter",
  "how.b.short": "shorter wavelength",
  "how.b.long": "longer wavelength",
  "how.b.count": "17 channels × 6 detectors = 102 colours",
  "how.c.h": "Step, stare, repeat",
  "how.c.p": "Between exposures the telescope steps a little across the sky. The same star lands on a different part of the filter, so each picture shows it in a different colour. That is why a star looks different from one SPHEREx picture to the next, and why our blink compares only pictures of the same colour (±6 %) from the same detector.",
  "how.c.alt": "Diagram: in three exposures the filter shifts under a star that stays in place, so the star is seen in three different colours.",
  "how.c.exp": "exposure {n}",
  "how.c.star": "the same star",
  "how.c.foot": "one star, three colours",
  "how.d.h": "Big pixels, many pictures",
  "how.d.p": "One pixel covers {p}″, like a 2.5 cm coin seen from about {coin} m. Barnard's Star moves {s} a year: only {k} pixels. We can still measure it to a few hundredths of an arcsecond, because SPHEREx photographs the whole sky every six months (four times in its two-year mission) and every picture adds a measurement: {n} images in {ns} seasons for Barnard's Star, about {per} per season.",
  "how.d.alt": "Diagram: a grid of SPHEREx pixels; Barnard's Star moves {s}, about {p} pixels, in a year.",
  "how.d.px": "1 pixel = {p}″",
  "how.d.a": "a year earlier",
  "how.d.b": "a year later",
  "name.p": "Fazari is named after al-Fazārī, a family of astronomers in 8th-century Baghdad who are traditionally credited with making the first astrolabes in the Islamic world (sources disagree whether it was the father, Ibrāhīm, or his son, Muḥammad). Muḥammad al-Fazārī also helped translate an Indian astronomical text, the <i>Sindhind</i>, into Arabic at the court of Caliph al-Manṣūr.",
};

const KEY = "fz-lang";
const listeners = new Set();
const original = new WeakMap();          // element -> {text|html|attrs} in English
let cur = detect();

function detect() {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "tr" || q === "en") return q;
  } catch (e) { /* ignore */ }
  try {
    const s = localStorage.getItem(KEY);
    if (s === "tr" || s === "en") return s;
  } catch (e) { /* storage blocked */ }
  return "en";
}

export function lang() { return cur; }

/** Text for key in the current language, with {name} placeholders filled from vars. */
export function t(key, vars = {}) {
  const table = cur === "tr" ? TR : EN;
  let s = table[key] ?? EN[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

/** Translate data-i18n elements under root (English comes from the page itself). */
export function apply(root = document) {
  for (const el of root.querySelectorAll("[data-i18n],[data-i18n-html],[data-i18n-attr]")) {
    let o = original.get(el);
    if (!o) {
      o = { text: el.textContent, html: el.innerHTML, attrs: {} };
      for (const pair of (el.dataset.i18nAttr || "").split(";").filter(Boolean)) {
        const a = pair.split(":")[0].trim();
        o.attrs[a] = el.getAttribute(a);
      }
      original.set(el, o);
    }
    const tr = cur === "tr";
    if (el.dataset.i18n) el.textContent = tr && TR[el.dataset.i18n] != null ? TR[el.dataset.i18n] : o.text;
    if (el.dataset.i18nHtml) el.innerHTML = tr && TR[el.dataset.i18nHtml] != null ? TR[el.dataset.i18nHtml] : o.html;
    for (const pair of (el.dataset.i18nAttr || "").split(";").filter(Boolean)) {
      const [a, k] = pair.split(":").map((s) => s.trim());
      const v = tr && TR[k] != null ? TR[k] : o.attrs[a];
      if (v != null) el.setAttribute(a, v);
    }
  }
}

export function setLang(l) {
  cur = l === "tr" ? "tr" : "en";
  try { localStorage.setItem(KEY, cur); } catch (e) { /* storage blocked: this page only */ }
  for (const f of listeners) { try { f(cur); } catch (e) { console.warn(e); } }
}

export function onLang(f) { listeners.add(f); return () => listeners.delete(f); }

/** A small EN / TR switch button. */
export function langButton(className = "fz-lang") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  const paint = () => {
    b.textContent = cur === "tr" ? "English" : "Türkçe";
    b.lang = cur === "tr" ? "en" : "tr";
    b.title = cur === "tr" ? "Switch to English" : "Türkçe'ye geç";
  };
  paint();
  b.addEventListener("click", () => setLang(cur === "tr" ? "en" : "tr"));
  onLang(paint);
  return b;
}
