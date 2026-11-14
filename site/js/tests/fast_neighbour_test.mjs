// node site/js/tests/fast_neighbour_test.mjs        (offline; LIVE=1 also queries VizieR once for case A)
import { pickFastStar, nearTarget, fastNeighbour, linesFor } from "../fast_neighbour.js";
import { TARGETS } from "../targets.js";
import { jyearToMjd } from "../astro.js";

let fail = 0;
const check = (name, cond, info = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`); if (!cond) fail++; };
const b = TARGETS.barnard;
const barnard = [{ source_id: b.gaia_dr3, ra: b.ra, dec: b.dec, epoch: 2016, pmra: b.pmra, pmdec: b.pmdec, plx: b.plx, gmag: 8.2 }];
const slow = [{ source_id: "1", ra: 158.04886, dec: 14.13738, epoch: 2016, pmra: -41.7, pmdec: 24.8, plx: 3.6, gmag: 4.58 }];
const now = jyearToMjd(2025.5);

// case A: Barnard's Gaia 2016 position -> it moved away, ~99" north
const a = pickFastStar(269.4486, 4.7394, barnard, now);
check("case A: moved_away", a && a.kind === "moved_away", a ? `pm ${a.pm_arcsec_yr.toFixed(2)}"/yr, now ${a.sep_now_arcsec}" away, ${a.link}` : "");
check("case A: 95-101\" away now", a && a.sep_now_arcsec > 95 && a.sep_now_arcsec < 101);
check("case A: link = its position in 2025.5", a && Math.abs(a.dec_now - (b.dec + b.pmdec * 9.5 / 3.6e6)) < 1e-5);
// Barnard where it is now -> moved_here (no link)
const h = pickFastStar(a.ra_now, a.dec_now, barnard, now);
check("Barnard now: moved_here", h && h.kind === "moved_here" && h.sep_now_arcsec < 1);
// a slow bright star (case B) -> nothing
check("slow star: none", pickFastStar(158.0488, 14.1371, slow, now) === null);
check("empty list: none", pickFastStar(10, 10, [], now) === null);
// prepared target: case A and Barnard now are both on Barnard's track; case B is not near any target
const tA = nearTarget(269.4486, 4.7394, { nowJyear: 2026.9 });
check("case A: prepared target barnard", tA && tA.key === "barnard", tA ? `${tA.sep_arcsec}" at ${tA.when_jyear}` : "");
const t2000 = nearTarget(b.ra - (b.pmra * 16 / 3.6e6) / Math.cos(b.dec * Math.PI / 180), b.dec - b.pmdec * 16 / 3.6e6, { nowJyear: 2026.9 });
check("Barnard's 2000 position: prepared target barnard", t2000 && t2000.key === "barnard" && t2000.sep_arcsec < 2, t2000 ? `${t2000.sep_arcsec}" at ${t2000.when_jyear}` : "");
check("case B: no prepared target", nearTarget(158.0488, 14.1371, { nowJyear: 2026.9 }) === null);
// lines: plain words, both languages, "candidate" never "discovery"
const L = linesFor(a, tA);
check("two lines", L.length === 2 && L[0].link && L[1].link === "sky.html?target=barnard");
check("text", /moves 10\.4″\/yr is now 99″ from this point: go to where it is now\./.test(L[0].text_en) && /yılda 10,4″ kayan/.test(L[0].text_tr), L[0].text_en);
check("no 'discovery'", !L.some((x) => /discover|keşif/i.test(x.text_en + x.text_tr)));
// failed Gaia query: error, star unknown (not "none")
const r = await fastNeighbour(269.4486, 4.7394, { stars: null, signal: null, mjd: now }).catch((e) => ({ thrown: e.message }));
if (process.env.LIVE) {
  check("live: Barnard found", r.star && r.star.kind === "moved_away", JSON.stringify(r.star || r.error));
} else {
  check("network result has a star or an error (never silent)", r && (r.star || r.error), r.error || "");
}
console.log(fail ? `${fail} FAILED` : "all passed");
process.exit(fail ? 1 : 0);
