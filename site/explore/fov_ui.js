// Field-of-view selector on the explorer's place card (#fovSel, #fovEst in explore.html).
// The choice lives in the address bar (?fov=0.3, so "Copy link" keeps it) and goes with the result:
// the local engine gets it as cutout_deg (engine.js), the in-browser engine as sky.html?fov= (main.js
// blinkUrl). No choice = the engine's default (local 0.2°, browser 0.15°; js/fov.js FOV_DEFAULT). Choices, defaults and the
// rough time/size estimate: js/fov.js.
import { fovFromUrl, fovFor, fillFovSelect, fovEstimateText, fovTimeText, setFovInUrl, FOV_PHONE_MAX } from "../js/fov.js";
import { t, onLang } from "../js/i18n.js";

const $ = (id) => document.getElementById(id);
const phone = () => (typeof matchMedia === "function" && matchMedia("(max-width: 640px), (pointer: coarse) and (max-width: 900px)").matches)
  || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const kind = () => (document.body.classList.contains("engine-local") ? "local" : "browser");
const selected = () => (window.__explore && window.__explore.state && window.__explore.state.selected) || null;

let chosen = fovFromUrl();                 // what the user asked for (null = engine default)
let last = "";
let shown = null;                          // { fov, saved }: the width the selector shows now
window.__fzFovShown = () => shown;         // the field square on the sky (fieldsquare.js) draws this width

/** The field (degrees) the next result uses with the current engine; null = engine default. */
export function currentFov() {
  if (chosen == null) return null;
  return fovFor(kind(), chosen, { phone: phone() });
}
window.__fzFov = currentFov;               // main.js / engine.js read it without importing this module

function render(force = false) {
  const sel = $("fovSel"), est = $("fovEst");
  if (!sel || !est) return;
  const k = kind(), ph = phone();
  const p = selected();
  const saved = k === "local" && !!(p && p.challenge);          // the 5 site targets: their saved 0.2° images
  const value = saved ? 0.2 : fovFor(k, chosen, { phone: ph });
  const key = [k, ph, value, saved, document.documentElement.lang].join("|");
  if (!force && key === last) return;
  last = key;
  if (!shown || shown.fov !== value || shown.saved !== saved) {
    shown = { fov: value, saved };
    document.dispatchEvent(new CustomEvent("fazari:fov", { detail: shown }));
  }
  fillFovSelect(sel, k, value, { phone: ph });
  sel.disabled = saved;
  est.textContent = fovEstimateText(k, value, { phone: ph && k !== "local", saved })
    + (ph && k !== "local" && !saved ? " " + t("pg.fov.phoneMax", null, `Phones: up to ${FOV_PHONE_MAX}°.`) : "");
  sel.title = t("pg.fov.title");
  // the expected time, small, inside the big button (the size and details stay in the Field row)
  const look = $("btnLook");
  if (look) {
    let eta = $("lookEta");
    if (!eta) { eta = document.createElement("small"); eta.id = "lookEta"; eta.className = "look-eta"; look.append(eta); }
    eta.textContent = fovTimeText(k, value, { phone: ph && k !== "local", saved });
  }
}

function init() {
  const sel = $("fovSel");
  if (!sel) return;
  sel.addEventListener("change", () => {
    chosen = Number(sel.value);
    setFovInUrl(chosen);
    render(true);
  });
  render(true);
  // engine detection (body class), a new place on the card, the language: render again
  new MutationObserver(() => render()).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const card = $("card");
  if (card) new MutationObserver(() => render()).observe(card, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true, characterData: true });
  onLang(() => render(true));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
