// Finds: the lasting list of CONFIRMED results of the local engine (step 3 of the result flow:
// fast answer -> how sure -> save if confirmed). The engine appends them to <cache>/finds.jsonl
// (pipeline/finds.py, post-step "finds") and serves them at GET /api/finds as {schema, finds: [...]}.
// Shown only when that endpoint answers (local engine on this machine); the static site never has it.
// Everything shown comes from the records as written: no number is computed here, and a confidence
// percent appears only when the core gave one (confidence.percent), otherwise only its sentence.
// Hook (main.js): import("./finds.js").then((m) => m.initFinds({ state, select, openBlink, toast }))
import { t, num, month, onLang } from "../js/i18n.js";
import { isLocalHost } from "./engine.js";
import { natureLabel } from "./candidates.js";

const POLL_MS = 30000;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const JOB_URL = /^\/jobs\/[\w.+-]+\/$/;

export function initFinds({ state, select, openBlink, toast } = {}) {
  if (!isLocalHost() || typeof document === "undefined") return null;
  let box = null, finds = [], timer = 0, busy = false;

  function mount() {
    if (box) return box;
    const body = document.getElementById("panelBody");
    if (!body) return null;
    box = document.createElement("section");
    box.className = "cat-detail fd";
    box.id = "findsList";
    box.hidden = true;
    box.setAttribute("aria-live", "polite");
    body.insertBefore(box, body.querySelector(".howto"));
    box.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest("button[data-fd]");
      if (b && box.contains(b)) open(finds[+b.dataset.fd]);
    });
    return box;
  }

  function where(r) {
    if (r.name) return r.name;
    if (!ok(r.ra) || !ok(r.dec)) return r.target || r.job_id;
    return `${num(+r.ra, 4)}° ${+r.dec >= 0 ? "+" : "−"}${num(Math.abs(+r.dec), 4)}°`;
  }
  function value(r) {
    if (ok(r.value)) {
      const v = num(+r.value, 2), e = ok(r.error) ? num(+r.error, 2) : "–";
      return ok(r.dt_years) ? t("ex.fd.val", { v, e, dt: num(+r.dt_years, 2) }) : `${v} ± ${e}″`;
    }
    if (ok(r.speed_arcsec_yr)) return t("ex.fd.speed", { v: num(+r.speed_arcsec_yr, 2), e: ok(r.speed_err) ? num(+r.speed_err, 2) : "–" });
    return "";
  }
  function sure(r) {                                     // only what the record holds
    const c = r.confidence;
    if (c && (ok(c.percent) || c.sentence)) {
      return { head: ok(c.percent) ? t("ex.fd.pct", { p: num(+c.percent) }) : "", sentence: c.sentence || "" };
    }
    if (ok(r.agreement_sigma)) {
      const ref = String((r.reference || {}).label || "");
      return { head: t("ex.fd.agree", { s: num(+r.agreement_sigma, 2), ref: /gaia/i.test(ref) ? "Gaia DR3" : t("ex.fd.cat") }), sentence: "" };
    }
    return { head: "", sentence: "" };
  }

  function row(r, i) {
    const s = sure(r), cls = natureLabel(r.class);
    const date = month(r.date || r.to || (ok(r.epoch) ? String(Math.floor(+r.epoch)) : ""));
    const l2 = [date, value(r)].filter(Boolean).join(" · ");
    const l3 = [s.head, cls].filter(Boolean).join(" · ");
    return `<li><button type="button" class="pt" data-fd="${i}" title="${esc(t("ex.fd.open"))}">` +
      `<span class="pn">${esc(where(r))}${r.candidate ? ` <small>${esc(r.candidate)}</small>` : ""}</span>` +
      (l2 ? `<span class="pd">${esc(l2)}</span>` : "") +
      (l3 ? `<span class="pd">${esc(l3)}</span>` : "") +
      (s.sentence ? `<span class="pd fd-s">${esc(s.sentence)}</span>` : "") +
      `</button></li>`;
  }

  function render() {
    if (!mount()) return;
    const list = finds.map((r, i) => [r, i]).sort((a, b) => String(b[0].saved || "").localeCompare(String(a[0].saved || "")));
    const rules = new Map(finds.map((r) => r.verified_by).filter((v) => v && v.rule).map((v) => [v.rule, v]));
    const ruleNote = [...rules.values()].map((v) => (/fallback/.test(v.rule) || v.limit_sigma != null ? t("ex.fd.rule.old", { k: num(v.limit_sigma) })
      : t("ex.fd.rule.conf", { rule: v.rule }))).join(" ");
    box.innerHTML = `<h3>${esc(t("ex.fd.h"))}${finds.length ? ` <small>${finds.length}</small>` : ""}</h3>` +
      `<p class="hint" style="font-size:12.5px;color:var(--mut)">${esc(t("ex.fd.hint"))}${ruleNote ? " " + esc(ruleNote) : ""}</p>` +
      (list.length ? `<ul class="points fd-list">${list.map(([r, i]) => row(r, i)).join("")}</ul>` : `<p class="hint">${esc(t("ex.fd.empty"))}</p>`);
  }

  function open(r) {
    if (!r) return;
    const fov = (/-s(\d+(?:\.\d+)?)$/.exec(r.job_id || "") || [])[1];
    if (ok(r.ra) && ok(r.dec)) {
      select({ id: null, name: where(r), ra: +r.ra, dec: +r.dec, cat: null, manual: true, note: t("ex.fd.cardNote") },
        { fly: true, fov: fov ? Math.max(0.15, +fov) : 0.3 });
    }
    const url = JOB_URL.test(r.result_url || "") ? r.result_url : `/jobs/${encodeURIComponent(r.job_id || "")}/`;
    const src = "ornek.html?data=" + encodeURIComponent(url);
    if (state && state.job) {                          // opening the blink here would stop the running job
      window.open(src, "_blank", "noopener");
      toast?.(t("ex.fd.busy"));
      return;
    }
    openBlink?.(src, t("ex.fd.panel", { name: where(r) }));
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch("/api/finds", { cache: "no-store" });
      const d = res.ok ? await res.json() : null;
      if (!d || !Array.isArray(d.finds)) throw new Error("no finds");
      finds = d.finds.filter((r) => r && typeof r === "object" && r.job_id);
      render();
      if (box) box.hidden = false;
    } catch (e) {
      if (box) box.hidden = true;                       // no engine (or an older one): no list
    } finally {
      busy = false;
    }
  }

  onLang(() => { if (box && !box.hidden) render(); });
  window.addEventListener("focus", refresh);
  timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  refresh();
  return { refresh, stop: () => clearInterval(timer), get finds() { return finds; } };
}
