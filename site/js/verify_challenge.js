// verify.html, section "#challenge": every required and suggested item of the challenge and where Fazari does it,
// drawn from data/verify/challenge.json (the same list as the README table "Challenge request -> In Fazari").
// Labels: site/i18n/{en,tr}.json keys "vch.*". A missing file hides the section.

import { t, lang, onLang } from "./i18n.js";

const SRC = "data/verify/challenge.json";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tx = (o) => (o && typeof o === "object" ? (lang() === "tr" && o.tr ? o.tr : o.en ?? "") : o ?? "");
let DATA = null;

function style() {
  if (document.getElementById("vchStyle")) return;
  const s = document.createElement("style");
  s.id = "vchStyle";
  s.textContent = `
#challenge .vch-sum { margin: 4px 0 10px; color: var(--soft); }
#challenge ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
#challenge li { display: grid; grid-template-columns: 2.2em minmax(0, 1fr) auto; gap: 2px 10px; align-items: baseline;
  padding: 8px 10px; border: 1px solid var(--line, rgba(127,127,127,.25)); border-radius: 8px; }
#challenge .vch-n { font-weight: 800; color: var(--blue); font-variant-numeric: tabular-nums; }
#challenge .vch-req { font-weight: 700; min-width: 0; }
#challenge .vch-kind { font-weight: 400; color: var(--soft); font-size: 13px; margin-left: 6px; }
#challenge .vch-st { font-size: 13px; font-weight: 700; white-space: nowrap; }
#challenge .vch-st.done { color: var(--good); }
#challenge .vch-st.partial { color: var(--warn, #c98a00); }
#challenge .vch-where { grid-column: 2 / 4; margin: 0; color: var(--fg); font-size: 14.5px; overflow-wrap: anywhere; }
#challenge .vch-where a { margin-left: 6px; white-space: nowrap; }
#challenge .vch-note { color: var(--soft); }
@media (max-width: 520px) { #challenge li { grid-template-columns: 1.8em minmax(0, 1fr); } #challenge .vch-st { grid-column: 2; } #challenge .vch-where { grid-column: 2; } }`;
  document.head.append(s);
}

function render() {
  const sec = document.getElementById("challenge"), box = document.getElementById("vchBox");
  if (!sec || !box) return;
  const items = DATA && Array.isArray(DATA.items) ? DATA.items : [];
  if (!items.length) { sec.hidden = true; return; }
  sec.hidden = false;
  const done = items.filter((x) => x.status === "done").length, part = items.filter((x) => x.status === "partial").length;
  const req = items.filter((x) => x.kind === "required");
  const sum = t("vch.sum", { n: items.length, done, part, req: req.length, reqDone: req.filter((x) => x.status === "done").length });
  box.innerHTML = `<p class="vch-sum">${esc(sum)}</p><ol>${items.map((x) => {
    const st = x.status === "done" ? "done" : "partial";
    const links = (x.links || []).filter((l) => Array.isArray(l) && l[0] && !/^[a-z]+:/i.test(l[0]))
      .map(([href, label]) => `<a href="${esc(href)}">${esc(label)} →</a>`).join("");
    return `<li><span class="vch-n">${esc(x.n)}</span>
      <span class="vch-req">${esc(tx(x.req))}<span class="vch-kind">${esc(t(x.kind === "required" ? "vch.required" : "vch.suggested"))}</span></span>
      <span class="vch-st ${st}">${st === "done" ? "✓ " : "◐ "}${esc(t("vch." + st))}</span>
      <p class="vch-where">${esc(tx(x.where))}${x.note ? ` <span class="vch-note">${esc(tx(x.note))}</span>` : ""}${links}</p></li>`;
  }).join("")}</ol>`;
}

async function main() {
  style();
  try {
    const r = await fetch(SRC, { cache: "no-cache" });
    DATA = r.ok ? await r.json() : null;
  } catch (e) { DATA = null; }
  render();
  onLang(() => render());
}
main();
