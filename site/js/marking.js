// "Mark something": light-weight manual marking in the blink viewer (ornek.html).
//
// Click the image -> a ring -> pick a type (moving, brightness change, artifact, not sure) and an
// optional note -> the mark goes into "My candidates", kept in this browser (localStorage, key
// fazari.myCandidates.v1; every access in try/catch, memory-only when storage is blocked) with
// Export JSON and Clear. No server: sharing and a name registry come later (explore.html
// #candidateSlot and /api/candidates stay reserved for that).
//
// API
//   initMarking(container, imgEl, meta, opts?) -> { setOn(bool), toggle, marks(), redraw() }
//     container  element or id: the "My candidates" panel is rendered inside it
//     imgEl      element or id of the frame image; its box must show the whole PNG of
//                meta.grid.png_px (stretched, no letterboxing). The ring layer is an SVG laid
//                exactly over it (a sibling, so it follows any zoom transform of the parent).
//     meta       the result's meta.json
//     opts.base        result folder ("data/barnard/", "/jobs/<id>/"): stored with each mark
//     opts.current     () => ({ frame, bin_um }): the frame on screen (meta.wavelength_bins[].frames[])
//     opts.toggleParent element or id for the "Mark something" button (default: top of container)
//     opts.clickTarget  element that receives clicks (default: imgEl.closest(".stage") or its parent)
//   mountMarking({ meta, base, current })  the same for the current ornek.html layout
//     (button in .controls, panel under .info, image #frame)
//   gridOf(meta) -> { toSky(px, py), toPng(ra, dec), inside(px, py), size } | null
//     PNG pixel <-> sky from meta.grid (north-up east-left TAN, pixel_arcsec, size_px, upscale,
//     label_strip_px, centred on meta.ra / meta.dec), as written by blink.py and local/preview.py.
//   exportDoc(marks), fieldOf(base), KEY, TYPES
// Marks inside the current image are drawn as numbered rings, whichever result they were made in.

import { TanGrid } from "./wcs.js";

export const KEY = "fazari.myCandidates.v1";
export const TYPES = [["moving", "Moving"], ["brightness", "Brightness change"], ["artifact", "Artifact"], ["unsure", "Not sure"]];
const typeLabel = (k) => (TYPES.find((t) => t[0] === k) || [k, k])[1];
const ok = (v) => v != null && Number.isFinite(+v);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** PNG pixel <-> sky for a meta.json grid, or null when the meta has no usable grid. */
export function gridOf(meta) {
  const g = (meta && meta.grid) || {};
  const up = +g.upscale || 1, L = +g.label_strip_px || 0;
  const [ny, nx] = g.size_px || [];
  if (g.projection !== "TAN" || !(g.pixel_arcsec > 0) || !(nx > 0) || !(ny > 0) || g.north_up_east_left === false ||
      !ok(meta.ra) || !ok(meta.dec)) return null;
  const tg = new TanGrid(+meta.ra, +meta.dec, +g.pixel_arcsec, nx);
  const dj = (nx - ny) / 2;                      // TanGrid is square; shift rows of a non-square grid
  return {
    toSky(px, py) { return tg.pixToSky((px - up / 2) / up, (py - L - up / 2) / up + dj); },
    toPng(ra, dec) { const [i, j] = tg.skyToPix(ra, dec); return [i * up + up / 2, L + (j - dj) * up + up / 2]; },
    inside(px, py) { return px >= 0 && px <= nx * up && py >= L && py <= L + ny * up; },
    size: [nx * up, ny * up + L],
  };
}

/** Which result a viewer URL shows: {kind: "target"|"job"|"other", id}. */
export function fieldOf(base) {
  const b = String(base || "");
  let m = /\/jobs\/([^/?#]+)/.exec(b);
  if (m) return { kind: "job", id: decodeURIComponent(m[1]) };
  m = /(?:^|\/)data\/([^/?#]+)\/?$/.exec(b.replace(/^\.?\//, ""));
  if (m) return { kind: "target", id: m[1] };
  return { kind: "other", id: b };
}

/** The exported document (also what the Export JSON button downloads). */
export function exportDoc(marks) {
  return {
    schema: "fazari-my-candidates/1",
    exported: new Date().toISOString(),
    note: "Marked by eye in the Fazari blink viewer. Candidates for follow-up, not discoveries. " +
      "RA/Dec: ICRS degrees, read from the blink frame grid (3″ pixels); season/wavelength: the frame on screen.",
    n: marks.length,
    candidates: marks,
  };
}

// --- storage (every access in try/catch: blocked storage, private windows, quota) ----------------
function readStore() {
  try {
    const s = window.localStorage.getItem(KEY);
    const v = s ? JSON.parse(s) : [];
    return { marks: Array.isArray(v) ? v.filter((x) => x && ok(x.ra) && ok(x.dec)) : [], ok: true };
  } catch (_) { return { marks: null, ok: false }; }
}
function writeStore(marks) {
  try {
    if (marks.length) window.localStorage.setItem(KEY, JSON.stringify(marks));
    else window.localStorage.removeItem(KEY);
    return true;
  } catch (_) { return false; }
}

const CSS = `
#fzmToggle[aria-pressed="true"] { border-color:#7fd4ff; color:#7fd4ff; }
.fzm-on, .fzm-on img { cursor: crosshair; }
.fzm { background:#151925; border-radius:8px; padding:8px 10px; margin:0 0 10px; font-size:.9rem; }
.fzm .hint { margin:0 0 6px; color:#9aa3b2; }
.fzm form { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; margin:0 0 8px; padding:8px; border:1px dashed #4a5672; border-radius:6px; }
.fzm form .where { flex-basis:100%; margin:0; color:#c9d2e3; font-variant-numeric:tabular-nums; }
.fzm fieldset { border:0; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:4px; }
.fzm fieldset label { display:inline-flex; gap:4px; align-items:center; background:#222838; border:1px solid #333b50; border-radius:6px; padding:3px 8px; color:#e8eaf0; cursor:pointer; }
.fzm fieldset label:has(input:checked) { border-color:#7fd4ff; color:#7fd4ff; }
.fzm input[type=text] { font:inherit; flex:1 1 180px; min-width:0; background:#0f131c; color:#e8eaf0; border:1px solid #333b50; border-radius:6px; padding:4px 8px; }
.fzm .head { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
.fzm .head b { margin-right:auto; }
.fzm .head button, .fzm form button { min-width:0; padding:3px 10px; font-size:.85rem; }
.fzm ol { list-style:none; margin:6px 0 0; padding:0; max-height:168px; overflow:auto; }
.fzm li { display:flex; gap:8px; align-items:baseline; padding:3px 4px; border-top:1px solid #262c3c; font-size:.84rem; }
.fzm li.here { background:#13202b; }
.fzm li .n { color:#7fd4ff; font-weight:700; min-width:2.2em; }
.fzm li .t { flex:1; min-width:0; overflow-wrap:anywhere; }
.fzm li .t small { color:#9aa3b2; }
.fzm li button { min-width:0; padding:0 7px; font-size:.8rem; }
.fzm .warn { color:#ffcf8a; margin:6px 0 0; font-size:.82rem; }
.fzm .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
`;

const el = (x) => (typeof x === "string" ? document.getElementById(x) : x) || null;

/** Mark something: toggle, ring layer over `imgEl`, "My candidates" panel in `container`. */
export function initMarking(container, imgEl, meta, opts = {}) {
  const box = el(container), img = el(imgEl);
  if (!box || !img) return null;
  if (box.dataset.fzm) return box.__fzm || null;                 // once per container
  box.dataset.fzm = "1";
  const $ = (id) => document.getElementById(id);
  const base = opts.base || "";
  const current = typeof opts.current === "function" ? opts.current : () => ({});
  const grid = gridOf(meta);
  const field = fieldOf(base);
  if (!$("fzm-style")) { const st = document.createElement("style"); st.id = "fzm-style"; st.textContent = CSS; document.head.appendChild(st); }

  const st = readStore();
  let marks = st.marks || [];
  let stored = st.ok;
  let on = false, pending = null, clearArmed = 0;

  // "Mark something" toggle
  const btn = document.createElement("button");
  btn.id = "fzmToggle"; btn.type = "button"; btn.textContent = "Mark something";
  btn.setAttribute("aria-pressed", "false");
  btn.title = grid ? "Click the image to mark something you see; it goes into your list of candidates"
    : "This result has no sky grid, so marks cannot be placed";
  btn.disabled = !grid;
  const tp = el(opts.toggleParent);
  if (tp) tp.appendChild(btn); else box.parentNode.insertBefore(btn, box);

  // ring layer: an SVG sibling laid exactly over the image (follows zoom transforms of the parent)
  const NS = "http://www.w3.org/2000/svg";
  const ov = document.createElementNS(NS, "svg");
  ov.id = "fzmOv";
  ov.setAttribute("aria-hidden", "true");
  ov.style.cssText = "position:absolute; pointer-events:none; overflow:visible;";
  img.parentNode.insertBefore(ov, img.nextSibling);
  const place = () => {
    ov.style.left = img.offsetLeft + "px"; ov.style.top = img.offsetTop + "px";
    ov.style.width = img.offsetWidth + "px"; ov.style.height = img.offsetHeight + "px";
  };
  const clickTarget = el(opts.clickTarget) || img.closest(".stage") || img.parentNode;

  // the panel
  const panel = document.createElement("section");
  panel.id = "fzmPanel"; panel.className = "fzm"; panel.setAttribute("aria-label", "My candidates");
  box.appendChild(panel);

  // PNG pixels per screen pixel (ring strokes and labels stay the same size at any zoom)
  const k = () => { const r = img.getBoundingClientRect(); return grid && r.width ? grid.size[0] / r.width : 1; };
  const here = (m) => {
    if (!grid) return null;
    const [x, y] = grid.toPng(m.ra, m.dec);
    return Number.isFinite(x) && grid.inside(x, y) ? [x, y] : null;
  };

  function drawRings() {
    if (!grid) { ov.innerHTML = ""; return; }
    place();
    const [W, H] = grid.size;
    ov.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const q = k(), sw = (2 * q).toFixed(2), hw = (4.5 * q).toFixed(2), fs = (13 * q).toFixed(1);
    // a dark halo under each ring keeps it visible on bright (saturated) stars
    const ring = (x, y, r, col, dash = "") =>
      `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#05070d" stroke-opacity=".75" stroke-width="${hw}"/>` +
      `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${col}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
    let s = "";
    marks.forEach((m, n) => {
      const p = here(m);
      if (!p) return;
      const [x, y] = p.map((v) => v.toFixed(1));
      s += ring(x, y, 14, "#7fd4ff") +
        `<text x="${(p[0] + 15).toFixed(1)}" y="${(p[1] - 13).toFixed(1)}" fill="#7fd4ff" stroke="#05070d" stroke-width="${(3 * q).toFixed(2)}" paint-order="stroke" ` +
        `font-size="${fs}" font-family="system-ui" font-weight="700">${n + 1}</text>`;
    });
    if (pending) {
      const [x, y] = pending.png_xy;
      const tick = `M${x - 27} ${y}H${x - 20}M${x + 20} ${y}H${x + 27}M${x} ${y - 27}V${y - 20}M${x} ${y + 20}V${y + 27}`;
      s += ring(x, y, 18, "#7fd4ff", `${(6 * q).toFixed(1)} ${(4 * q).toFixed(1)}`) +
        `<path d="${tick}" stroke="#05070d" stroke-opacity=".75" stroke-width="${hw}"/><path d="${tick}" stroke="#ffffff" stroke-width="${sw}"/>`;
    }
    ov.innerHTML = s;
  }

  const fmtRa = (v) => (+v).toFixed(5) + "°";
  const fmtDec = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(5) + "°";
  const seenText = (m) => [m.season, ok(m.wavelength_um) ? (+m.wavelength_um).toFixed(2) + " µm" : null].filter(Boolean).join(", ");

  function render() {
    const show = on || marks.length > 0;
    panel.hidden = !show;
    if (!show) { panel.innerHTML = ""; drawRings(); return; }
    let h = "";
    if (on && !pending) h += `<p class="hint">Click the image where you see something that moves or changes. Your ring stays while the blink plays.</p>`;
    if (pending) {
      h += `<form id="fzmForm" autocomplete="off">` +
        `<p class="where">New mark: RA ${fmtRa(pending.ra)}, Dec ${fmtDec(pending.dec)} · seen in ${esc(seenText(pending)) || "this frame"}</p>` +
        `<fieldset><legend class="sr-only">Type</legend>` + TYPES.map(([k, l]) =>
          `<label><input type="radio" name="fzmType" value="${k}"${(pending.type || "moving") === k ? " checked" : ""}> ${l}</label>`).join("") +
        `</fieldset>` +
        `<input type="text" id="fzmNote" maxlength="200" placeholder="Note (optional)" value="${esc(pending.note || "")}" aria-label="Note (optional)">` +
        `<button type="submit" id="fzmSave">Save</button><button type="button" id="fzmCancel">Cancel</button></form>`;
    }
    const n = marks.length;
    h += `<div class="head"><b>My candidates (${n})</b>` +
      (n ? `<button type="button" id="fzmExport" title="Download all your marks as JSON">Export JSON</button>` +
        `<button type="button" id="fzmClear" title="Remove all your marks from this browser">${clearArmed ? `Clear all ${n}? Click again` : "Clear"}</button>` : "") +
      `</div>`;
    if (n) {
      h += `<ol id="fzmList">` + marks.map((m, k) => ({ m, k })).reverse().map(({ m, k }) => {
        const inHere = !!here(m);
        const where = m.target || (m.field && m.field.id) || "";
        return `<li class="${inHere ? "here" : ""}" data-id="${esc(m.id)}"><span class="n">#${k + 1}</span>` +
          `<span class="t"><b>${esc(typeLabel(m.type))}</b> · RA ${fmtRa(m.ra)}, Dec ${fmtDec(m.dec)}` +
          `<small> · ${esc(where)}${seenText(m) ? " · " + esc(seenText(m)) : ""}${inHere ? " · on this image" : ""}</small>` +
          (m.note ? `<br><small>“${esc(m.note)}”</small>` : "") + `</span>` +
          `<button type="button" class="del" aria-label="Remove mark ${k + 1}" title="Remove">×</button></li>`;
      }).join("") + `</ol>`;
    } else if (!on) {
      h += `<p class="hint">Nothing marked yet.</p>`;
    }
    if (!stored) h += `<p class="warn">This browser blocks local storage: your marks last only until you leave this page. Use Export JSON to keep them.</p>`;
    panel.innerHTML = h;
    drawRings();
    const form = $("fzmForm");
    if (form) {
      form.onsubmit = (e) => { e.preventDefault(); save(); };
      $("fzmCancel").onclick = () => { pending = null; render(); };
      form.querySelectorAll("input[name=fzmType]").forEach((r) => { r.onchange = () => { pending.type = r.value; }; });
      $("fzmNote").oninput = (e) => { pending.note = e.target.value; };
    }
    if ($("fzmExport")) $("fzmExport").onclick = exportJson;
    if ($("fzmClear")) $("fzmClear").onclick = clearAll;
    panel.querySelectorAll("li .del").forEach((b) => {
      b.onclick = () => { remove(b.closest("li").dataset.id); };
    });
  }

  function remove(id) {
    const fresh = readStore();                         // keep marks made meanwhile in another tab
    if (fresh.ok) marks = fresh.marks;
    marks = marks.filter((m) => m.id !== id);
    stored = writeStore(marks);
    render();
  }

  function save() {
    if (!pending) return;
    const m = {
      id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ra: +pending.ra.toFixed(6), dec: +pending.dec.toFixed(6),
      type: pending.type || "moving", type_label: typeLabel(pending.type || "moving"),
      note: (pending.note || "").trim().slice(0, 200),
      season: pending.season || null, frame_date: pending.frame_date || null,
      wavelength_um: pending.wavelength_um ?? null, bin_um: pending.bin_um ?? null,
      detectors: pending.detectors || null, frame: pending.frame_file || null,
      png_xy: pending.png_xy,
      target: meta.target || null,
      field: field,                                       // {kind: "target"|"job", id}
      viewer: "ornek.html?data=" + base,
      marked_at: new Date().toISOString(),
    };
    const fresh = readStore();
    if (fresh.ok) marks = fresh.marks.filter((x) => !marks.some((y) => y.id === x.id)).concat(marks);
    marks.push(m);
    pending = null;
    stored = writeStore(marks);
    render();
  }

  function exportJson() {
    try {
      const blob = new Blob([JSON.stringify(exportDoc(marks), null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `fazari-my-candidates-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    } catch (e) { console.warn("export", e); }
  }

  function clearAll() {
    if (!clearArmed) {
      clearArmed = setTimeout(() => { clearArmed = 0; render(); }, 4000);
      render();
      return;
    }
    clearTimeout(clearArmed); clearArmed = 0;
    marks = [];
    stored = writeStore(marks);
    render();
  }

  function setOn(v) {
    on = !!v && !!grid;
    btn.setAttribute("aria-pressed", String(on));
    if (clickTarget) clickTarget.classList.toggle("fzm-on", on);
    if (!on) pending = null;
    render();
  }
  btn.onclick = () => setOn(!on);

  if (clickTarget) clickTarget.addEventListener("click", (ev) => {
    if (!on || !grid) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const [W, H] = grid.size;
    const x = (ev.clientX - r.left) / r.width * W, y = (ev.clientY - r.top) / r.height * H;
    if (!grid.inside(x, y)) return;                       // the label strip is not sky
    const [ra, dec] = grid.toSky(x, y);
    if (!ok(ra) || !ok(dec)) return;
    let cur = {};
    try { cur = current() || {}; } catch (_) {}
    const f = cur.frame || {};
    pending = {
      ra, dec, png_xy: [+x.toFixed(1), +y.toFixed(1)],
      season: f.epoch || null, frame_date: f.date || null,
      wavelength_um: ok(f.wavelength_um) ? +(+f.wavelength_um).toFixed(3) : null,
      bin_um: ok(cur.bin_um) ? +cur.bin_um : null, detectors: f.detectors || null, frame_file: f.file || null,
      type: pending ? pending.type : "moving", note: pending ? pending.note : "",
    };
    render();
    const first = panel.querySelector("input[name=fzmType]:checked");
    if (first) first.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pending) { pending = null; render(); } });
  // redraw when the image box or its zoom changes
  const zs = $("zoom");
  if (zs) zs.addEventListener("change", () => setTimeout(drawRings, 30));
  img.parentNode.addEventListener("transitionend", drawRings);
  window.addEventListener("resize", drawRings);
  try { new ResizeObserver(drawRings).observe(img); } catch (_) {}
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    const fresh = readStore();
    if (fresh.ok) { marks = fresh.marks; render(); }
  });
  render();
  const api = { setOn, toggle: btn, marks: () => marks.slice(), redraw: drawRings };
  box.__fzm = api;
  return api;
}

/** The current ornek.html layout: button in .controls, panel under the image info line, image #frame. */
export function mountMarking({ meta, base = "", current = () => ({}) }) {
  let box = document.getElementById("markingPanel");
  if (!box) {
    box = document.createElement("div");
    box.id = "markingPanel";
    const info = document.querySelector(".info");
    if (info) info.parentNode.insertBefore(box, info.nextSibling); else document.body.appendChild(box);
  }
  return initMarking(box, "frame", meta, { base, current, toggleParent: document.querySelector(".controls") });
}
