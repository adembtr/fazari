// Shared by worker.js and engine.js (inline fallback): plain, cloneable summaries.

export function summarize(s) {
  return {
    ra0: s.ra0, dec0: s.dec0, n: s.n, pixArcsec: s.cfg.pixArcsec, cap: s.cfg.cap,
    nImages: s.images.length,
    seasons: s.seasons.map((x) => ({ label: x.label, mjd0: x.mjd0, mjd1: x.mjd1 })),
    bins: s.bins.map((b) => ({ um: b.um, det: b.det, nSeasons: b.nSeasons, available: b.available })),
  };
}

export function slimAstrometry(a) {
  return { ...a, headerChecks: undefined };
}
