// Single-column result layout ("tek sütun", ajan_durumu/tek_sutun_brif.md): ornek.html (also the explorer's result
// panel) and sky.html read top to bottom in one column, every section always open:
//   A what is here · B over time (the image area #fzStage) · C verdict · D measurement (only with a source)
//   · E spectrum · F brightness over time · G small print.
// This is a CLASSIC script, loaded right after the page markup: the blocks are in their sections before the first
// paint, so the old two-column layout never flashes. It only MOVES existing elements (ids never change); every
// number it prints comes from the result's own files (meta.json, candidates.json, spectrum.json) or the catalogue.
// Off with ?ui=classic (js/ui_boot.js sets html.ui-classic): then this file does nothing and the page is as before.
// Texts: English here and in the markup, Turkish in site/i18n/tr.json ("ts.*").
(function () {
  "use strict";
  var D = document, H = D.documentElement;
  if (!H.classList.contains("ui") || H.classList.contains("ui-classic")) return;
  if (!D.getElementById("tsFlow")) return;
  var SELF = (D.currentScript && D.currentScript.src) || new URL("js/ts_flow.js", location.href).href;
  var mod = function (f) { return import(new URL(f, SELF).href); };
  var $ = function (id) { return D.getElementById(id); };
  var q = function (s, r) { return (r || D).querySelector(s); };
  var isSky = !$("tiles") && !!$("form") && !!$("blink");
  H.classList.add("ts-on", isSky ? "ui-page-sky" : "ui-page-viewer");
  H.setAttribute("data-ui-mode", "simple");      // one state: plain sentences on top, technical numbers in the small print
  var safe = function (name, f) { try { return f(); } catch (e) { console.warn("ts_flow:", name, e); } };

  // ---- small helpers ------------------------------------------------------------------------------------------
  var I18 = function () { return globalThis.__fzI18n || null; };
  var fill = function (s, p) { return p ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return p[k] != null ? String(p[k]) : m; }) : String(s); };
  var T = function (key, en, p) { var i = I18(); try { return i ? i.t(key, p, en) : fill(en, p); } catch (e) { return fill(en, p); } };
  var loc = function (s) { var i = I18(); return i ? i.loc(s) : String(s); };
  var month = function (ep) { var i = I18(); return i ? i.month(ep, true) : String(ep); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
  var fin = function (v) { return v != null && v !== "" && isFinite(+v); };
  /** Put node into host (before `before`, else at the end) unless it is already there. */
  function into(host, node, before) {
    if (!host || !node || node === host) return false;
    if (node.parentNode === host && (before === undefined || node.nextSibling === (before || null))) return false;
    host.insertBefore(node, before && before.parentNode === host ? before : null);
    return true;
  }
  function setHtml(el, html) { if (el && el.innerHTML !== html) { el.innerHTML = html; return true; } return false; }
  function setHidden(el, hide) { if (el && el.hidden !== !!hide) el.hidden = !!hide; }

  // ---- sexagesimal ----------------------------------------------------------------------------------------------
  function sexa(ra, dec) {
    var h = ((ra % 360) + 360) % 360 / 15, hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
    if (ss >= 59.95) { ss = 0; mm += 1; } if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
    var a = Math.abs(dec), dd = Math.floor(a), dm = Math.floor((a - dd) * 60), ds = Math.round(((a - dd) * 60 - dm) * 60);
    if (ds >= 60) { ds = 0; dm += 1; } if (dm >= 60) { dm = 0; dd += 1; }
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return { ra: p2(hh) + "h " + p2(mm) + "m " + loc((ss < 10 ? "0" : "") + ss.toFixed(1)) + "s", dec: (dec < 0 ? "−" : "+") + p2(dd) + "° " + p2(dm) + "′ " + p2(ds) + "″" };
  }
  /** A catalogue position {ra, dec, pmra, pmdec (mas/yr), epoch} moved to another year. */
  function moved(p, year) {
    var dt = year - (p.epoch || 2016), cd = Math.max(1e-6, Math.cos(p.dec * Math.PI / 180));
    return { ra: p.ra + (p.pmra || 0) / 3.6e6 * dt / cd, dec: p.dec + (p.pmdec || 0) / 3.6e6 * dt };
  }

  // =============================================================================================================
  // ornek.html: the static blocks into their sections (synchronous, before the first paint)
  // =============================================================================================================
  function buildViewer() {
    var A = $("tsA"), B = $("tsB"), Dm = $("tsD"), E = $("tsE"), G = $("tsG");
    // A: what is here (name, type, why it is a target; facts and links are painted when the result is known)
    var head = $("tsHead");
    into(head, $("title")); into(head, $("kindBadge")); into(head, $("tagList")); into(head, $("why"));
    into($("tsAx"), q(".side > .actions"));
    // B: over time (one sentence, the image area, wavelength buttons, view settings, difference image)
    into(B, q("header.top .real"), q("#tsB > .ts-say"));
    into(B, $("watch"), $("tsBins"));
    into(B, $("fzStage"), $("tsBins"));
    into($("tsView"), q(".side > .controls"));
    into(B, $("markingPanel"), $("tsDiff"));
    into($("tsDiff"), q(".lower > .card.diff"));
    // C: verdict (the strip of js/verdict_strip.js places itself in front of .lead), how sure, candidates of the field
    into($("tsVd"), q(".viewer .lead"));
    into($("tsVd"), $("verdict"));
    into($("tsCx"), $("candidateList"));
    // D: measurement (two tiles and the number line)   E: spectrum
    into(Dm, $("result"));
    into(E, $("spectrumPanel"));
    // G: small print
    into(G, q(".main > .info"));
    into(G, $("flagControls")); into(G, $("faintControls"));
    into(G, $("measure") && $("measure").parentElement);
    into(G, $("explainStrip"));
    var holder = D.createElement("div"); holder.id = "tsGsp"; holder.className = "ts-gsp"; G.appendChild(holder);
    into(G, q(".side > .more")); into(G, q(".app > footer"));
  }

  // ---- A: facts of the result (catalogue, position, SPHEREx coverage, check elsewhere) ---------------------------
  var catState = { key: null, val: undefined };          // undefined = asking, null = the catalogue did not answer
  function resultInfo() {
    var api = window.__fzViewer, m = api && api.meta;
    if (!m) return null;
    var g = m.gaia || {}, ms = m.measured || {};
    var free = !g.source_id && /requested position/i.test(g.label || "");
    var pm = fin(g.pmra_mas_yr) && fin(g.pmdec_mas_yr) ? Math.hypot(+g.pmra_mas_yr, +g.pmdec_mas_yr) / 1000 : 0;
    var year = fin(m.epoch_center) ? +m.epoch_center : 2026;
    var cat = fin(g.ra_deg) && fin(g.dec_deg) ? { ra: +g.ra_deg, dec: +g.dec_deg, pmra: +g.pmra_mas_yr || 0, pmdec: +g.pmdec_mas_yr || 0, epoch: fin(g.ref_epoch) ? +g.ref_epoch : 2016 } : null;
    var here = free || !cat ? { ra: +m.ra, dec: +m.dec } : moved(cat, year);       // where the object is in these images
    var j2000 = free || !cat ? here : moved(cat, 2000);                              // where catalogues that list year-2000 positions have it
    var eps = m.epochs || [];
    var n = m.preview ? m.preview.n_images : fin(m.n_cutouts) ? +m.n_cutouts
      : (m.wavelength_bins || []).reduce(function (a, b) { return a + (b.frames || []).reduce(function (s, f) { return s + (f.n_images || 0); }, 0); }, 0);
    return { m: m, g: g, ms: ms, free: free, pm: pm, here: here, j2000: j2000, eps: eps, n: n, base: api.base, year: year };
  }
  function linksHtml(r) {
    var f5 = function (v) { return (+v).toFixed(5); };
    var p = r.here, z = r.j2000;
    var rad = r.free ? 60 : 30;
    var L = [
      ["SIMBAD", "https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=" + f5(z.ra) + "+" + (z.dec >= 0 ? "%2B" : "") + f5(z.dec) + "&CooFrame=ICRS&CooEpoch=2000&CooEqui=2000&Radius=" + rad + "&Radius.unit=arcsec",
        T("ts.l.simbad", "names and types of known objects")],
      ["ESASky", "https://sky.esa.int/esasky/?target=" + f5(p.ra) + "%20" + f5(p.dec) + "&hips=AllWISE+color&fov=0.25&cooframe=J2000&sci=true",
        T("ts.l.esasky", "the same sky from other telescopes")],
      ["VizieR", "https://vizier.cds.unistra.fr/viz-bin/VizieR-4?-c=" + f5(p.ra) + "%20" + (p.dec >= 0 ? "%2B" : "") + f5(p.dec) + "&-c.rs=30&-source=I/355/gaiadr3&-source=II/328/allwise&-source=II/246/out",
        T("ts.l.vizier", "Gaia, WISE and 2MASS catalogue rows")],
      ["WiseView", "https://byw.tools/wiseview#ra=" + f5(p.ra) + "&dec=" + f5(p.dec) + "&size=176&band=3&speed=20&zoom=9",
        T("ts.l.wiseview", "WISE images of this spot over ten years")],
      ["Legacy Survey", "https://www.legacysurvey.org/viewer?ra=" + f5(p.ra) + "&dec=" + f5(p.dec) + "&layer=ls-dr10&zoom=14&mark=" + f5(p.ra) + "," + f5(p.dec),
        T("ts.l.legacy", "deep optical images")],
    ];
    return L.map(function (x) { return '<a href="' + esc(x[1]) + '" target="_blank" rel="noopener noreferrer" title="' + esc(x[2]) + '">' + esc(x[0]) + "</a>"; }).join("");
  }
  var perYear = function (v) { return T("ts.rate", "{v}″ per year", { v: loc((+v).toFixed(v < 10 ? 2 : 1)) }); };
  function catHtml(r) {
    var g = r.g;
    if (!r.free) {
      var mv = r.pm >= 0.005 ? T("ts.a.catMoves", "moves {v} across the sky", { v: perYear(r.pm) }) : T("ts.a.catStill", "no measurable motion across the sky");
      if (g.source_id) return "<b>Gaia DR3 " + esc(g.source_id) + "</b> · " + esc(mv);
      if (g.label) return esc(T("ts.a.catOther", "Not in Gaia; position and motion from {src}", { src: g.label })) + " · " + esc(mv);
      return esc(T("ts.a.catNone", "No catalogue entry is attached to this result."));
    }
    var c = catState.val;
    if (c === undefined) return '<span class="ts-wait">' + esc(T("ts.a.catAsk", "Asking the Gaia star catalogue…")) + "</span>";
    if (c === null) return esc(T("ts.a.catFail", "The star catalogue did not answer just now; the links below open it directly."));
    if (c.hit) {
      return "<b>" + esc(T("ts.a.catStar", "A catalogued star: Gaia DR3 {id}", { id: c.hit.id })) + "</b> · " +
        esc(T("ts.a.catSep", "{d}″ from this point", { d: loc(c.hit.sep.toFixed(1)) })) +
        (c.hit.v >= 0.005 ? " · " + esc(T("ts.a.catMoves", "moves {v} across the sky", { v: perYear(c.hit.v) })) : "") +
        (fin(c.hit.gmag) ? " · " + esc(T("ts.a.catMag", "magnitude {g}", { g: loc((+c.hit.gmag).toFixed(1)) })) : "");
    }
    return "<b>" + esc(T("ts.a.catEmpty", "No catalogued object at this exact point")) + "</b> · " +
      esc(fin(c.nearest) ? T("ts.a.catNear", "the nearest Gaia DR3 star is {d}″ away", { d: loc(c.nearest.toFixed(0)) }) : T("ts.a.catFar", "no Gaia DR3 star within 20″"));
  }
  function askCatalogue(r) {
    if (!r.free) return;
    var key = r.here.ra.toFixed(5) + "|" + r.here.dec.toFixed(5);
    if (catState.key === key) return;
    var my = catState = { key: key, val: undefined };
    // one catalogue request per result: where something was measured, the viewer already asks around the measured
    // position (js/gr.js catalogueAt); the same question here is answered from its cache
    var pos = (r.ms.positions || []).filter(function (p) { return fin(p.ra) && fin(p.dec); });
    var w = pos.length ? { ra: +pos[pos.length - 1].ra, dec: +pos[pos.length - 1].dec } : r.here;
    mod("./gaia.js").then(function (GA) { return GA.gaiaStars(w.ra, w.dec, 20 / 3600, { max: 50 }); }).then(function (stars) {
      var best = null, cd = Math.cos(r.here.dec * Math.PI / 180);
      (stars || []).forEach(function (s) {
        var p = moved({ ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, epoch: s.epoch || 2016 }, r.year);
        var sep = Math.hypot((p.ra - r.here.ra) * cd, p.dec - r.here.dec) * 3600;
        if (!best || sep < best.sep) best = { sep: sep, s: s };
      });
      my.val = best && best.sep <= 3 ? { hit: { id: best.s.source_id, sep: best.sep, v: Math.hypot(best.s.pmra || 0, best.s.pmdec || 0) / 1000, gmag: best.s.gmag } }
        : { hit: null, nearest: best ? best.sep : null };
    }).catch(function () { my.val = null; }).then(function () { if (catState === my) paintA(); });
  }
  function paintA() {
    var r = isSky ? skyInfo() : resultInfo();
    if (!r) return;
    askCatalogue(r);
    var named = r.sky ? r.named : !!($("tagList") && $("tagList").textContent.trim());
    var kick = $("tsKick");
    if (kick) {
      var kt = named ? T("ts.a.kickTarget", "One of the five challenge targets") : r.free ? T("ts.a.kickPoint", "The point you picked") : T("ts.a.kickResult", "Result");
      if (kick.textContent !== kt) kick.textContent = kt;
      setHidden(kick, false);
    }
    var s = sexa(r.here.ra, r.here.dec);
    var f4 = function (v) { return loc((+v).toFixed(4)); };
    var rows = [
      [T("ts.a.cat", "In the star catalogue"), catHtml(r)],
      [T("ts.a.pos", "Position"), '<b class="ts-nb">' + esc(s.ra) + '</b> <b class="ts-nb">' + esc(s.dec) + '</b> · <span class="ts-nb">RA ' + esc(f4(r.here.ra)) + '°</span> <span class="ts-nb">Dec ' + esc((r.here.dec >= 0 ? "+" : "−") + f4(Math.abs(r.here.dec))) + "°</span>"],
      ["SPHEREx", r.n ? "<b>" + esc(T(r.n === 1 ? "ts.a.img.one" : "ts.a.img.other", r.n === 1 ? "{n} image" : "{n} images", { n: r.n })) + "</b> · " +
        esc(T(r.eps.length === 1 ? "ts.a.vis.one" : "ts.a.vis.other", r.eps.length === 1 ? "{n} visit" : "{n} visits", { n: r.eps.length })) +
        (r.eps.length ? " · " + esc(month(r.eps[0])) + (r.eps.length > 1 ? " – " + esc(month(r.eps[r.eps.length - 1])) : "") : "") +
        (r.m.preview ? " · " + esc(T("ts.a.preview", "a quick first look; the full result follows")) : "") : esc(T("ts.a.noImg", "no images yet"))],
      [T("ts.a.else", "Check elsewhere"), '<span class="ts-links">' + linksHtml(r) + "</span>"],
    ];
    var box = $("tsFacts");
    setHtml(box, rows.map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + x[1] + "</dd>"; }).join(""));
    setHidden(box, false);
  }

  // ---- C: the limit, big ("anything faster than about X per year would have shown") ------------------------------
  // The same numbers as the verdict strip and the viewer's limit line: this run's own sensitivity estimate
  // (candidates.json), else three times the field stars' scatter over the time between the first and last visit.
  var limState = { key: null, val: undefined };
  function askLimit(r) {
    var key = r.base + "|" + (r.m.generated || "") + "|" + (r.m.preview ? "p" : "f");
    if (limState.key === key) return;
    var my = limState = { key: key, val: undefined };
    mod("./gr.js").then(function (GR) {
      return GR.candidates(r.base).then(function (doc) {
        var lim = GR.limitFromSensitivity(doc && doc.sensitivity);
        if (lim && lim.bright) return { kind: "sens", v: lim.bright.v, mag: lim.bright.mag, faint: lim.faint, span: lim.span };
        var cells = (((r.ms.field_calibration || {}).cells) || []).filter(function (c) { return Array.isArray(c.star_rms_arcsec); });
        if (!cells.length) return null;
        var rms = cells.map(function (c) { return (c.star_rms_arcsec[0] + c.star_rms_arcsec[1]) / 2; }).sort(function (a, b) { return a - b; })[cells.length >> 1];
        var ep = r.eps.map(function (e) { return /^(\d{4})-(\d{2})/.exec(e); }).filter(Boolean).map(function (x) { return +x[1] + (+x[2] - 1) / 12; });
        var v = ep.length > 1 ? GR.limitFromField(rms, ep[ep.length - 1] - ep[0]) : null;
        return v ? { kind: "field", v: v, rms: rms, span: ep[ep.length - 1] - ep[0] } : null;
      });
    }).catch(function () { return null; }).then(function (v) { my.val = v || null; if (limState === my) paintLimit(); });
  }
  var rate = function (v) { return loc(v >= 1 ? v.toFixed(1) : v.toFixed(2)); };
  function paintLimit() {
    var box = $("tsLim"), r = resultInfo();
    if (!box || !r) return;
    if (r.m.preview) { setHidden(box, true); H.classList.remove("ts-has-lim"); return; }
    askLimit(r);
    var L = limState.val;
    var none = H.classList.contains("vd-k-none");            // the strip says "no moving object found here"
    if (!L || !none) { setHidden(box, true); H.classList.remove("ts-has-lim"); return; }
    var how = L.kind === "sens"
      ? T("ts.lim.howSens", "How we know: fake moving stars were added to these real images and searched for again; the time between the first and last visit is {y} years.", { y: fin(L.span) ? loc(L.span.toFixed(1)) : "–" })
      : T("ts.lim.howField", "How we know: ordinary stars in these images scatter by {r}″ in position, so a shift between two visits is uncertain by √2 × {r}″; anything that moved three times that in the {y} years between the first and last visit would stand out. A visit averages many images, so the real limit is lower.", { r: loc(L.rms.toFixed(2)), y: loc(L.span.toFixed(1)) });
    var txt = L.kind === "sens"
      ? T("ts.lim.sens", "A star of magnitude {m} or brighter moving faster than {v}″ per year would have shown here.", { m: loc(String(L.mag)), v: rate(L.v) }) +
        (L.faint ? " " + T("ts.lim.faint", "For a faint one (magnitude {m}) the limit is {v}″ per year.", { m: loc(String(L.faint.mag)), v: rate(L.faint.v) }) : "")
      : T("ts.lim.field", "Anything moving faster than about {v}″ per year would have shown in these images.", { v: rate(L.v) });
    setHtml(box, '<p class="ts-lim-k">' + esc(T("ts.lim.k", "How much we could have seen")) + "</p>" +
      '<p class="ts-lim-v"><b>' + esc(rate(L.v)) + "″</b> <span>" + esc(T("ts.perYear", "per year")) + "</span></p>" +
      '<p class="ts-lim-t">' + esc(txt) + " " + esc(T("ts.lim.miss", "Something slower or fainter can be missed.")) + "</p>" +
      '<p class="ts-lim-how">' + esc(how) + "</p>");
    setHidden(box, false);
    H.classList.add("ts-has-lim");
  }

  // ---- F: brightness over time (js/gr.js timeChart; data: spectrum.json through js/spectrum_chart.js) -------------
  var timeState = { spec: null, base: null, um: null }, refocus = null;
  function paintTime() {
    var box = $("tsTime"), api = window.__fzViewer;
    if (!box || !api || !api.meta) return;
    mod("./gr.js").then(function (GR) {
      if (typeof GR.timeChart !== "function") return;
      var um = timeState.um;
      if (um == null) { try { um = api.current().bin_um; } catch (e) { um = null; } }
      if (!timeState.spec && window.__fzSpectrum) timeState.spec = window.__fzSpectrum.spec || null;
      var html = GR.timeChart({ spec: timeState.spec, meta: api.meta, um: um, jump: typeof api.goTo === "function" });
      setHtml(box, html || "");
      var rf = refocus; refocus = null;                  // a visit chosen with the keyboard keeps the focus after the redraw
      if (rf && Date.now() - rf.t < 2500) { var f = box.querySelector('[data-ts-go="' + rf.s + '"]'); if (f && f.focus) { try { f.focus({ preventScroll: true }); } catch (e) { /* old browser */ } } }
      schedule();
    }).catch(function (e) { console.warn("ts_flow: time chart", e); });
  }
  D.addEventListener("fazari:spectrum", function (e) { var d = e.detail || {}; timeState.spec = d.spec || null; timeState.base = d.base || null; paintTime(); });
  D.addEventListener("fazari:frame", function (e) { var um = e.detail && e.detail.bin_um; if (fin(um) && um !== timeState.um) { timeState.um = +um; paintTime(); } });
  // a point of the spectrum (E) or a visit of the brightness chart (F): the image above jumps to that visit and colour
  // (agent B's js/viewer.js goTo; the picture keeps its zoom). Only on ornek.html, where that call exists.
  function jumpTo(season, um) {
    var api = window.__fzViewer;
    if (!api || typeof api.goTo !== "function" || !season) return;
    safe("jump", function () {
      var got = api.goTo({ season: String(season), bin_um: fin(um) ? +um : undefined });
      var st = $("fzStage");
      if (got && st && st.scrollIntoView) {
        var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        st.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
      }
    });
  }
  D.addEventListener("fazari:chartpick", function (e) { var d = e.detail || {}; jumpTo(d.season, d.um); });
  D.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var g = e.target && e.target.closest ? e.target.closest("[data-ts-go]") : null;
    if (!g) return;
    e.preventDefault();
    refocus = { s: g.getAttribute("data-ts-go"), t: Date.now() };
    jumpTo(g.getAttribute("data-ts-go"), g.getAttribute("data-ts-go-um"));
  });
  D.addEventListener("click", function (e) {
    var g = e.target && e.target.closest ? e.target.closest("[data-ts-go]") : null;
    if (g) { jumpTo(g.getAttribute("data-ts-go"), g.getAttribute("data-ts-go-um")); return; }
    var b = e.target && e.target.closest ? e.target.closest("[data-ts-um]") : null;
    if (!b) return;
    safe("band", function () {
      var um = +b.getAttribute("data-ts-um"), api = window.__fzViewer;
      if (api && typeof api.setBin === "function") { api.setBin(um); return; }
      var btn = [].slice.call(D.querySelectorAll("#pgBins button")).filter(function (x) { return fin(x.dataset.um) && Math.abs(+x.dataset.um - um) < 0.05; })[0];
      if (btn) btn.click();
    });
  });

  // ---- the page changes under us (plug-ins add their blocks later): keep everything in its section ----------------
  var lastMeta = null, lastLang = null;
  function tidyViewer() {
    var G = $("tsG"), F = $("tsF"), E = $("tsE"), Dm = $("tsD");
    into($("tsC"), $("planetNote"), $("tsCx"));      // "known planets" note: under the verdict, so it never pushes the image down
    var gr = $("grRatio"); if (gr) into(F, gr);
    var info = q("#tsG > .info"), cf = $("chFrame");
    if (cf && cf.parentNode !== G) G.insertBefore(cf, info ? info.nextSibling : null);
    var fc = $("faintcard"); if (fc && fc.parentNode !== G) G.insertBefore(fc, $("tsGsp"));
    var cn = $("chNew"); if (cn && cn.parentNode !== G) G.insertBefore(cn, $("tsGsp"));     // data release + "is there new data?"
    var how = $("fiHowto"); if (how && !how.hidden) how.hidden = true;
    // the spectrum's table (a fold) belongs to the small print
    var sp = $("spectrum"), hold = $("tsGsp");
    var det = sp && q(":scope > details", sp);
    if (det && hold) { hold.textContent = ""; hold.appendChild(det); }
    // sections that have nothing to show are not shown
    var hero = q("#tiles > .tile.hero");
    setHidden(Dm, !(hero && !hero.classList.contains("empty")));
    setHidden(E, !(sp && !sp.hidden && sp.childElementCount));
    var tm = $("tsTime");
    setHidden(F, !((gr && !gr.hidden && gr.childElementCount) || (tm && tm.childElementCount)));
    var api = window.__fzViewer, lg = I18() ? I18().lang() : "en";
    if (api && api.meta && (api.meta !== lastMeta || lg !== lastLang)) { lastMeta = api.meta; lastLang = lg; paintA(); paintTime(); }
    paintLimit();
  }

  // =============================================================================================================
  // sky.html (in-browser engine): the same sections around the page's own blocks
  // =============================================================================================================
  var cardOf = function (id) { var e = $(id); return e && e.closest ? e.closest(".card") : null; };
  function buildSky() {
    var B = $("tsB"), G = $("tsG"), main = q("main");
    if (main) main.classList.add("ts-app");
    // the field of view is an input of the run: it stays with the search box, not in the small print
    var opt = D.createElement("div"); opt.className = "ts-opt"; opt.id = "tsOpt";
    var ex = q("main > .examples"), fov = $("fov");
    if (ex) { ex.after(opt); into(opt, fov && fov.closest("label")); into(opt, $("fovEst")); }
    // B: the image area, the wavelength buttons (js/bins_bar.js puts its bar into #tsBins), the difference image
    into(B, $("fzStage"), $("tsBins"));
    into($("tsBins"), cardOf("bins"));
    into($("tsDiff"), cardOf("diff"));
    // D: measurement   E: spectrum
    into($("tsD"), cardOf("measure"));
    into($("tsE"), $("spectrum"));
    // G: what was downloaded, the tables of the measurement, the settings of this run
    into(G, $("found")); into(G, $("progress"));
    var gm = D.createElement("div"); gm.id = "tsGm"; gm.className = "ts-gm"; G.appendChild(gm);
    var cap = $("cap"); into(G, cap && cap.closest(".controls"));
  }

  function skyNow() { try { return window.__fzSky ? window.__fzSky() : null; } catch (e) { return null; } }
  /** The run on sky.html in the shape paintA() reads (the same facts as a prepared result). */
  function skyInfo() {
    var s = skyNow(), run = s && s.run, info = run && run.info;
    if (!info || !fin(info.ra0) || !fin(info.dec0)) return null;
    var tg = run.target || null;
    var cat = tg && fin(tg.ra) && fin(tg.dec) ? { ra: +tg.ra, dec: +tg.dec, pmra: +tg.pmra || 0, pmdec: +tg.pmdec || 0, epoch: fin(tg.epoch) ? +tg.epoch : 2016 } : null;
    var here = { ra: +info.ra0, dec: +info.dec0 };
    var res = Object.keys(run.results || {}).map(function (k) { return run.results[k]; });
    var count = function (r) { return (r.frames || []).reduce(function (a, f) { return a + (f.n || 0); }, 0); };
    var n = res.length ? res.reduce(function (a, r) { return a + count(r); }, 0) : s.current ? count(s.current) : 0;
    return { sky: true, run: run, cur: s.current || null, named: !!(tg && tg.kind), m: { preview: s.current && s.current.preview && !res.length ? {} : null },
      g: tg ? { source_id: tg.gaia_dr3 || "", label: tg.source || tg.name || "" } : {}, ms: { positions: (run.astro && run.astro.positions) || [] },
      free: !tg, pm: cat ? Math.hypot(cat.pmra, cat.pmdec) / 1000 : 0, here: here, j2000: cat ? moved(cat, 2000) : here,
      eps: (info.seasons || []).map(function (x) { return x.label; }), n: n, base: "", year: 2026 };
  }
  /** Speed per year of this run: the rule of js/app.js showMotion (the pair of visits with the same camera
   *  orientation closest to one year apart, else first to last when they are more than 0.3 years apart). */
  function skySpeed(run) {
    var a = run && run.astro;
    if (!a || !a.positions || !a.positions.length || !a.pairs || !a.pairs.length) return null;
    var p = a.pairs.filter(function (x) { return x.from === a.positions[0].season && x.to === a.positions[a.positions.length - 1].season; })[0];
    var c = a.pairs.filter(function (x) { return x.sameOrientation && x.dtYears > 0.3; }).sort(function (x, y) { return Math.abs(x.dtYears - 1) - Math.abs(y.dtYears - 1); })[0] || (p && p.dtYears > 0.3 ? p : null);
    return c && fin(c.shift) && fin(c.err) ? { v: c.shift / c.dtYears, e: c.err / c.dtYears, p: c.gaiaShift != null ? c.gaiaShift / c.dtYears : null, from: c.from, to: c.to } : null;
  }
  var skyCat = { key: null, val: undefined };
  function paintSkyTiles(GR, r) {
    var box = $("tsTiles"), sec = $("tsD");
    if (!box || !sec) return;
    var sp = skySpeed(r.run);
    if (!sp) { setHtml(box, ""); setHidden(box, true); H.classList.remove("ts-sky-speed"); return; }
    var tile = function (k, b, small, cls) { return '<div class="tile ' + cls + '"><span class="k">' + k + "</span><b>" + b + "</b><small>" + small + "</small></div>"; };
    var html = tile(esc(T("vw.t.measured", "Measured by us")), esc(GR.rateTxt(sp.v, sp.e)), "± " + esc(GR.rateTxt(sp.e, sp.e)) + '<span class="x"> · ' + esc(T("gr.t.speed", "speed per year")) + "</span>", "hero");
    if (sp.p != null) {
      var who = r.g.source_id ? "Gaia DR3" : (r.g.label || "Gaia DR3");
      html += tile(esc(T("vw.t.predicts", "{who} predicts", { who: who })), esc(GR.rateTxt(sp.p, sp.e)), "", "ref");
    } else if (r.free) {                                   // a free point: the catalogued star there (the page already asked; same cache)
      var pos = r.ms.positions.map(function (x) { return { ra: x.ra, dec: x.dec, mjd: x.mjd }; });
      var key = pos.length ? pos[pos.length - 1].ra + "|" + pos[pos.length - 1].dec : "";
      if (skyCat.key !== key) {
        var my = skyCat = { key: key, val: undefined };
        GR.catalogueAt({ measured: { positions: pos } }, "").then(function (c) { my.val = c || null; if (skyCat === my) schedule(); }).catch(function () { my.val = null; });
      }
      var c = skyCat.val;
      if (c) html += tile(esc(c.src === "SIMBAD" ? T("gr.t.simbad", "SIMBAD catalogue") : T("gr.t.gaia", "ESA Gaia DR3 catalogue")), esc(GR.rateTxt(c.v, sp.e)),
        esc(T("gr.t.catSub", "the star at this point ({d}″ away)", { d: loc((+c.sep).toFixed(1)) })), "ref");
    }
    setHtml(box, html); setHidden(box, false);
    H.classList.toggle("ts-sky-speed", sp.v >= 3 * sp.e);     // the sentence under the tiles then only repeats them
  }
  function paintSkyLimit(GR, r) {
    var box = $("tsLim");
    if (!box) return;
    var a = r.run.astro, c = a && a.calibration, fr = r.cur && r.cur.frames;
    var dt = fr && fr.length > 1 && fr[0].mjdMean && fr[fr.length - 1].mjdMean ? (fr[fr.length - 1].mjdMean - fr[0].mjdMean) / 365.25 : null;
    // the field stars' scatter: of the exposures that measured the centre, else (nothing at the centre, the usual
    // "no source here") of every calibration cell of the run (js/sky.js astrometry().calibration.cells)
    var rms = c && fin(c.rms) ? +c.rms : null;
    if (rms == null && c && Array.isArray(c.cells)) {
      var cr = c.cells.filter(function (x) { return x && x.ok && fin(x.rms) && +x.rms > 0; }).map(function (x) { return +x.rms; }).sort(function (x, y) { return x - y; });
      if (cr.length) rms = cr[cr.length >> 1];
    }
    var v = rms != null && dt ? GR.limitFromField(rms, dt) : null;
    var none = H.classList.contains("vd-k-none") && r.run.complete;
    if (!v || !none) { setHidden(box, true); H.classList.remove("ts-has-lim"); return; }
    setHtml(box, '<p class="ts-lim-k">' + esc(T("ts.lim.k", "How much we could have seen")) + "</p>" +
      '<p class="ts-lim-v"><b>' + esc(rate(v)) + "″</b> <span>" + esc(T("ts.perYear", "per year")) + "</span></p>" +
      '<p class="ts-lim-t">' + esc(T("ts.lim.field", "Anything moving faster than about {v}″ per year would have shown in these images.", { v: rate(v) })) + " " +
        esc(T("ts.lim.miss", "Something slower or fainter can be missed.")) + "</p>" +
      '<p class="ts-lim-how">' + esc(T("ts.lim.howField", "How we know: ordinary stars in these images scatter by {r}″ in position, so a shift between two visits is uncertain by √2 × {r}″; anything that moved three times that in the {y} years between the first and last visit would stand out. A visit averages many images, so the real limit is lower.", { r: loc((+rms).toFixed(2)), y: loc(dt.toFixed(1)) })) + "</p>");
    setHidden(box, false);
    H.classList.add("ts-has-lim");
  }
  /** What js/gr.js timeChart needs to know about the wavelength buttons, from the loaded frames of this run. */
  function skyMeta(run) {
    var D2 = function (x) { return /^D/.test(String(x)) ? String(x) : "D" + x; };
    return { epochs: ((run.info && run.info.seasons) || []).map(function (x) { return x.label; }),
      wavelength_bins: Object.keys(run.results || {}).map(function (k) { var r = run.results[k];
        return { wavelength_um: +r.um, frames: (r.frames || []).map(function (f) { return { epoch: f.season, detectors: (f.detectors || (r.det != null ? [r.det] : [])).map(D2), date_first: f.dateFirst, date_last: f.dateLast, n_images: f.n }; }) }; }) };
  }
  var skySeen = "";
  function tidySky() {
    var G = $("tsG"), V = $("viewer"), r = skyInfo();
    H.classList.toggle("ts-sky-open", !!(V && !V.hidden));
    // plug-ins put their blocks next to the page's own; each one into its section
    var cf = $("chFrame"); if (cf && cf.parentNode !== G) G.insertBefore(cf, q("#tsG > .ts-say") ? q("#tsG > .ts-say").nextSibling : null);
    var cn = $("chNew"); if (cn && cn.parentNode !== G) G.insertBefore(cn, $("tsGm"));
    var pg = $("pgCard"); if (pg && pg.parentNode !== $("tsBins")) $("tsBins").insertBefore(pg, $("tsBins").firstChild);
    // the tables of the measurement (seasons, pairs, method) are small print; the page writes them again at every step
    var meas = $("measure"), gm = $("tsGm");
    if (meas && gm) {
      var tech = [].slice.call(meas.querySelectorAll(":scope > table, :scope > p.small")).filter(function (n) { return !(n.previousElementSibling && n.previousElementSibling.id === "grSkyNl"); });
      if (tech.length) { gm.textContent = ""; tech.forEach(function (n) { gm.appendChild(n); }); }
      else if (!meas.childElementCount && gm.childElementCount) gm.textContent = "";
    }
    var sp = $("spectrum"), tm = $("tsTime");
    setHidden($("tsE"), !((sp && !sp.hidden && sp.childElementCount) || $("chSpecCard")));
    if (!r) return;
    // A: what is here
    var lg = I18() ? I18().lang() : "en";
    var name = r.run.target ? (I18() ? I18().tname(r.run.target.name) : r.run.target.name) : T("ts.a.kickPoint", "The point you picked");
    var nm = $("tsName"); if (nm && nm.textContent !== name) nm.textContent = name;
    var key = [lg, r.n, r.eps.length, r.here.ra, r.here.dec, r.ms.positions.length, catState.val === undefined ? "?" : catState.val ? "y" : "n", r.run.complete ? 1 : 0].join("|");
    if (key !== skySeen) { skySeen = key; paintA(); }
    mod("./gr.js").then(function (GR) {
      paintSkyTiles(GR, r);
      paintSkyLimit(GR, r);
      // C says something only when the verdict strip (wavelength-by-wavelength run) or the limit is on screen
      var vs = $("vdStrip");
      setHidden($("tsC"), !((vs && !vs.hidden && vs.parentNode === $("tsVd")) || ($("tsLim") && !$("tsLim").hidden)));
      var has = !!(r.ms.positions.length && skySpeed(r.run));
      setHidden($("tsD"), !has);
      // F: brightness over time, from the spectrum of the loaded exposures (js/spectrum.js), when the run has made it
      var spec = r.run.spectrum || null, um = r.cur ? +r.cur.um : null;
      if (tm) {
        var html = spec && typeof GR.timeChart === "function" ? GR.timeChart({ spec: spec, meta: skyMeta(r.run), um: um }) : "";
        setHtml(tm, html || "");
        setHidden($("tsF"), !html);
      }
    }).catch(function (e) { console.warn("ts_flow: sky", e); });
  }

  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; safe("tidy", isSky ? tidySky : tidyViewer); });
  }
  safe("build", isSky ? buildSky : buildViewer);
  try { new MutationObserver(schedule).observe(D.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
  D.addEventListener("fazari:lang", function () { setTimeout(function () { lastLang = null; schedule(); }, 40); });
  D.addEventListener("fazari:post", function () { limState.key = null; schedule(); });
  var tries = 0, iv = setInterval(function () { schedule(); if (++tries > 80 || (window.__fzViewer && lastMeta)) clearInterval(iv); }, 250);
  window.__tsFlow = { tidy: schedule, info: resultInfo };
})();
