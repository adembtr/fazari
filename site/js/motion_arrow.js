// The measured-motion arrow, shared by the result viewer (js/viewer.js, SVG) and the browser engine (js/app.js, canvas).
// A year of motion is a few image pixels, so the arrow is drawn longer by a round factor N that is written on the
// image ("arrow drawn ×N"). It always starts at the measured first position; the true end stays marked.
// The label is the speed with its error and the direction: "10.37 ± 0.06″/yr north".

import { t, loc } from "./i18n.js";

const ok = (v) => v != null && v !== "" && Number.isFinite(+v);
const FACTORS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];

/** A shift worth drawing longer: at least 3 times its error (or no error given). */
export function significant(shift, err) { return !(ok(err) && +err > 0) || +shift >= 3 * +err; }

/** Largest round factor that keeps the drawn arrow within `want` (same units as len); 1 when it is already long. */
export function drawScale(len, want) {
  if (!(len > 0) || !(want > 0)) return 1;
  let n = 1;
  for (const f of FACTORS) if (len * f <= want) n = f;
  return n;
}

const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Position angle (degrees east of north) -> "north", "north-east", ... (TR: "kuzeye", ...). */
export function dirWord(pa) {
  if (!ok(pa)) return "";
  const k = DIRS[Math.round((((+pa % 360) + 360) % 360) / 45) % 8];
  return t("fi.dir." + k);
}

/** Speed (″/yr), its error and direction: the joint fit of all exposures when the result has one
 *  (meta.measured.fit, as the result card), else the pair on screen (shift / years). */
export function speedOf(fit, pair) {
  if (fit && ok(fit.pmra_mas_yr) && ok(fit.pmdec_mas_yr)) {
    const a = +fit.pmra_mas_yr, d = +fit.pmdec_mas_yr, v = Math.hypot(a, d);
    const e = ok(fit.pmra_err_mas_yr) && ok(fit.pmdec_err_mas_yr) && v > 0
      ? Math.hypot(a * fit.pmra_err_mas_yr, d * fit.pmdec_err_mas_yr) / v : null;
    return { v: v / 1000, e: e == null ? null : e / 1000, pa: (Math.atan2(a, d) * 180 / Math.PI + 360) % 360 };
  }
  if (pair && ok(pair.s) && ok(pair.dt) && pair.dt > 0.05)
    return { v: pair.s / pair.dt, e: ok(pair.e) ? pair.e / pair.dt : null, pa: ok(pair.pa) ? +pair.pa : null };
  return null;
}

/** "10.37 ± 0.06″/yr north" (TR "yılda 10,37 ± 0,06″, kuzeye"). */
export function speedText(sp) {
  if (!sp) return "";
  const d = sp.e != null && sp.e < 0.095 ? 2 : sp.v < 1 ? 2 : 1;
  const v = loc(sp.v.toFixed(d)), dir = dirWord(sp.pa);
  return sp.e != null ? t("fi.arw.rate", { v, e: loc(sp.e.toFixed(d)), dir }).trim() : t("fi.arw.rateNoErr", { v, dir }).trim();
}

/** "arrow drawn ×5" / "arrow at true length" */
export function scaleText(n) { return n > 1 ? t("fi.arw.drawn", { n }) : t("fi.arw.trueLen"); }
