/* Fazari UI layer, step 1 of 2 (classic script, loaded in <head> so the page never flashes the old layout).
 * Sets <html class="ui" data-ui-mode="simple|detailed">; css/ui_shell.css only styles pages with html.ui,
 * and js/ui_shell.js (module) does the rest.
 * Switch the layer off:  ?ui=classic in the URL (this page, and a result panel inside it), or set UI_ON = false below.
 * Nothing here may throw: every step is wrapped. */
(function () {
  var UI_ON = true;                      // emergency switch for the whole site
  var h = document.documentElement;
  try {
    var q = new URLSearchParams(location.search).get("ui");
    if (q === "classic" || q === "0" || q === "off") UI_ON = false;
  } catch (e) { /* no URL API */ }
  try {                                   // a result panel inside the explorer follows the page around it
    if (window.parent !== window && window.parent.document.documentElement.classList.contains("ui-classic")) UI_ON = false;
  } catch (e) { /* other origin */ }
  if (!UI_ON) { h.classList.add("ui-classic"); return; }
  h.classList.add("ui");
  var mode = "simple";
  try { if (localStorage.getItem("fz-ui-mode") === "detailed") mode = "detailed"; } catch (e) { /* storage blocked */ }
  h.setAttribute("data-ui-mode", mode);
  try { if (window.parent !== window) h.classList.add("ui-embedded"); } catch (e) { /* ignore */ }
})();
