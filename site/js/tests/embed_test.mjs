// Offline test of the embed card's verdict line (site/js/embed.js) on the five site/data targets.
//   node site/js/tests/embed_test.mjs
// Checks: a line in English and Turkish for every target, the motion targets match their catalogue, the brightness
// targets give a change with its error, the speed has an error bar, no "discover" anywhere, monthly labels in both languages.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const E = await import(join(site, "js", "embed.js"));
const X = await import(join(site, "js", "explain.js"));
let fail = 0;
const check = (c, msg) => { if (!c) { fail++; console.log("FAIL", msg); } };
const want = { barnard: "moving_as_predicted", eps_indi_b: "moving_as_predicted", wise0855: "moving_as_predicted", rw_aur: "brightness", r_dra: "brightness" };
for (const [t, kind] of Object.entries(want)) {
  const m = JSON.parse(readFileSync(join(site, "data", t, "meta.json"), "utf8"));
  const en = E.verdictHtml(m, X, "en"), tr = E.verdictHtml(m, X, "tr");
  console.log(t, "|", en, "|", tr);
  check(en && tr && en !== tr, `${t}: a line in both languages`);
  check(!/discover|keşf/i.test(en + tr), `${t}: no "discover"`);
  if (kind === "brightness") {
    check(/(brighter|fainter|No brightness change)/.test(en) && /(Parlaklaştı|Sönükleşti|değişmedi)/.test(tr), `${t}: a brightness change`);
    check(/±/.test(en) && /±/.test(tr), `${t}: the change has its error`);
  } else {
    check(E.motionClass(m, X) === kind, `${t}: class ${E.motionClass(m, X)} (want ${kind})`);
    check(/Moves \d+\.\d+ ± \d+\.\d+″\/yr/.test(en) && /Hareket ediyor: \d+,\d+ ± \d+,\d+″\/yıl/.test(tr), `${t}: the speed with its error`);
    check(/matching/.test(en) && /uyumlu/.test(tr), `${t}: matches the catalogue`);
  }
}
check(E.monthTxt("2025-08", "en") === "Aug 2025" && /^Ağu 2025$/.test(E.monthTxt("2025-08", "tr")), "month labels");
check(E.speedTxt(10.368, 0.0556, "tr") === "10,37 ± 0,06″/yıl", "Turkish decimal comma");
console.log(fail ? `embed_test: ${fail} FAILED` : "embed_test: OK");
process.exit(fail ? 1 : 0);
