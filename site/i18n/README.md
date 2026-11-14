# Site text in English and Turkish

`en.json` and `tr.json` hold every UI string: flat `{ "key": "text" }`, `{name}` = a parameter.
The module is `site/js/i18n.js`. English is the default; `?lang=tr` or the EN | TR switch turns Turkish on.

## Add a new string

1. Add the key and the English text to `en.json`. Use the page prefix: `ex.` explorer, `vw.` result viewer
   (ornek.html), `mk.` marking, `pl.` pipeline sentences, `fv.` faint mode, `sp.` spectrum, `ex.ss.` / `ex.fs.` star layers, `sk.` sky.html,
   `v.` verify, `s.` / `how.` story, `hero.` opening card, `pg.` shared page chrome.
2. Turkish in `tr.json` is optional. A missing key shows the English text.
3. Use it:
   - Static HTML: `<span data-i18n="ex.key">English text</span>` (the English in the page stays the source).
     Markup: `data-i18n-html="key"`. Attributes: `data-i18n-attr="title:key1;aria-label:key2;placeholder:key3"`.
     Do not put `data-i18n` on an element whose text your JavaScript also changes; use `t()` there.
   - JavaScript: `import { t, tn, num, loc, month, field, onLang, lang } from "./i18n.js";`
     - `t("ex.found", { name })`; a third argument is the English fallback if en.json lacks the key.
     - `tn("vw.images", n)` uses `vw.images.one` / `vw.images.other` (Turkish needs only `.other`).
     - `num(10.24, 1)` gives `10.2` or `10,2`. `loc("10.2″")` swaps the decimal point in Turkish.
       Never use them for values that are parsed again (coordinate box, URLs).
     - `month("2025-09")` gives `Sep 2025` / `Eyl 2025`; `month(ep, true)` the long name.
     - `field(obj, "name")` gives `obj.name_tr` in Turkish when it exists.
     - `tname("Barnard's Star")` gives a sky object's Turkish name (tr.json `tname.<English name>`), else the name.
     - `ptext(s)` shows a pipeline sentence from meta.json / faint.json in Turkish: exact sentences are
       `pl.x.*` keys (en.json holds the pipeline's exact English), sentences with numbers are patterns in
       `PIPE` in i18n.js (`pl.*`). Unknown pipeline text stays English.
     - Re-render dynamic text on a switch: `onLang(() => render())` or listen to the
       `fazari:lang` event on `document` (`detail.lang`).
   - Classic scripts, and modules that also run in Node: `globalThis.__fzI18n?.t(...)` (absent = English).
4. The switch: put `<span data-i18n-toggle></span>` where it should appear.
   A site page inside a frame (the explorer's result panel) follows the page around it; switching in either
   switches both (direct call, `postMessage({type: "fazari-lang"})` and the shared `fz-lang` storage key).

## Turkish style

Short sentences, everyday words. Fixed terms: blink = blink (first mention: "göz kırpma karşılaştırması"),
candidate = aday, proper motion = öz hareket, season = sezon, wavelength = dalga boyu, difference image =
fark görüntüsü. Never "keşif": a find is an "aday". Proper names stay (SPHEREx, Gaia DR3, NASA/IPAC IRSA).
Numbers shown to people use a decimal comma (`num`, `loc`).

Check what is still English: open a page with `?lang=tr` and run `__fzI18n.missing` in the console.
