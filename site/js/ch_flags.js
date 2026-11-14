// FLAGS statistics of one exposure over the box on screen (challenge item "metadata and flags").
// Called from SkySession.process (sky.js) with the FLAGS rows it has already read: no extra bytes.
// The box = the native detector pixels that the output grid samples (nearest pixel of each grid pixel).
// Groups as pipeline/flags.py (site/data/<t>/flags/flags.json), so both result pages say the same thing.

export const GROUPS = {
  saturated: ["OVERFLOW", "SUR_ERROR", "NONLINEAR"],
  bad: ["TRANSIENT", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "PERSIST", "OUTLIER", "STREAK", "SNOWBALL"],
  other: ["DICHROIC", "PHANMISS", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "BLOOM", "HALO"],
};

/**
 * @param flags  Uint32/Int32 FLAGS values of rows y0.. (width W, height H)
 * @param px,py  native pixel (x, y) of every grid pixel (Float32Array, length N)
 * @param bits   name -> bit value (from the FLAGS header)
 * Returns {nBox, nOff, byName: {NAME: pixels}, groups: {saturated, bad, other, any}} (pixel counts).
 */
export function flagStats(flags, W, H, y0, px, py, bits) {
  const seen = new Uint8Array(W * H);
  const names = Object.entries(bits).filter(([, v]) => v > 0);
  const byName = {};
  const gmask = {};
  for (const [g, list] of Object.entries(GROUPS)) gmask[g] = list.reduce((m, n) => m | (bits[n] || 0), 0);
  const anyMask = gmask.saturated | gmask.bad | gmask.other;
  const groups = { saturated: 0, bad: 0, other: 0, any: 0 };
  let nBox = 0, nOff = 0;
  for (let k = 0; k < px.length; k++) {
    const i = Math.round(px[k]), j = Math.round(py[k]) - y0;
    if (i < 0 || j < 0 || i >= W || j >= H) { nOff++; continue; }
    const q = j * W + i;
    if (seen[q]) continue;
    seen[q] = 1;
    nBox++;
    const f = flags[q] >>> 0;
    if (!f) continue;
    for (const [n, v] of names) if (f & v) byName[n] = (byName[n] || 0) + 1;
    for (const g of ["saturated", "bad", "other"]) if (f & gmask[g]) groups[g]++;
    if (f & anyMask) groups.any++;
  }
  return { nBox, nOff, byName, groups };
}
