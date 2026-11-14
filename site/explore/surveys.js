// Background sky surveys (HiPS) for the explorer, with mirror fallback.
// Each survey lists mirrors in order of preference; the first one whose `properties` file answers
// is used. ESA's ESASky mirror comes first for the background maps so that IRSA only serves the
// SPHEREx layer (Chrome saw HTTP/2 stream errors from IRSA when both came from there at once).
// In Nov 2026 the main CDS alasky host returned 404 for tiles, so never rely on a single host.

export const SURVEYS = {
  visible: {
    key: "visible",
    label: "Visible",
    title: "Visible light (DSS2 colour)",
    blurb: "What the sky looks like to the eye, through a big telescope.",
    fmt: "jpeg",
    mirrors: [
      "https://skies.esac.esa.int/DSSColor",
      "https://stpubdata.s3.us-east-1.amazonaws.com/mast/skybackgrounds/DSSColor",   // STScI/MAST copy (CORS ok, Nov 2026)
      "https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color",
      "https://alasky.cds.unistra.fr/DSS/DSSColor",
    ],
    credit: "DSS2 colour: Digitized Sky Survey, STScI/NASA; coloured and HEALPixed by CDS",
    short: "DSS2 colour", years: "1975–1999", epoch: 1990,
    zoomPx: 5,                           // closest zoom when this is the sharpest map: 1" = 5 screen pixels
  },
  twomass: {
    key: "twomass",
    label: "Near-IR",
    title: "Near-infrared (2MASS colour, 1.2–2.2 µm)",
    blurb: "Infrared light passes through dust, so hidden stars appear.",
    fmt: "jpeg",
    mirrors: [
      "https://skies.esac.esa.int/2MASSColor",
      "https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color",
      "https://alasky.cds.unistra.fr/2MASS/Color",
    ],
    credit: "2MASS: University of Massachusetts & IPAC/Caltech, NASA/NSF",
    short: "2MASS", years: "1997–2001", epoch: 1999,
  },
  wise: {
    key: "wise",
    label: "WISE",
    title: "Mid-infrared (AllWISE colour, 3.4–22 µm)",
    blurb: "Warm dust and cold objects glow; this is where brown dwarfs were found.",
    fmt: "jpeg",
    mirrors: [
      "https://skies.esac.esa.int/AllWISEColor",
      "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1",
      "https://alasky.cds.unistra.fr/AllWISE/RGB-W4-W2-W1",
    ],
    credit: "AllWISE: NASA/JPL-Caltech/UCLA, IPAC",
    short: "AllWISE", years: "2010–2011", epoch: 2010.5,
  },
  spherex: {
    key: "spherex",
    label: "SPHEREx",
    title: "SPHEREx all-sky map (DR1, 0.75–5 µm)",
    blurb: "NASA's SPHEREx map of the whole sky in 102 infrared colours.",
    fmt: "png",
    cube: true,
    mirrors: [
      "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube",
    ],
    credit: "SPHEREx DR1 all-sky HiPS: NASA/SPHEREx, Caltech/IPAC (NASA/IPAC Infrared Science Archive)",
    short: "SPHEREx DR1", years: "2025–2026", epoch: 2025.8,
  },
};

// Sharp close-up maps, used automatically when you zoom in past CLOSEUP_FOV (not background buttons).
// Pan-STARRS DR1 (0.25" pixels, ~1" seeing) covers Dec > -30 deg; south of that the sharpest map that
// answers is DSS2 colour (key "visible"). Checked from headless Chrome on 2026-11-14: the MAST S3 copy
// answers with CORS (*) and has tiles down to order 11; the CDS alasky copies returned 404, and the
// CDS SkyMapper / DES / Legacy Surveys maps (sharper in the south) only exist on alasky, so not used.
export const CLOSEUP_SURVEYS = {
  panstarrs: {
    key: "panstarrs",
    title: "Pan-STARRS DR1 colour (i, r, g)",
    fmt: "jpeg",
    mirrors: [
      "https://stpubdata.s3.us-east-1.amazonaws.com/mast/skybackgrounds/PanSTARRS",
      "https://alasky.cds.unistra.fr/Pan-STARRS/DR1/color-i-r-g",
    ],
    credit: "Pan-STARRS DR1: PS1 Science Consortium, STScI/MAST; HEALPixed by CDS",
    short: "Pan-STARRS DR1", years: "2009–2015", epoch: 2012,
    decMin: -29.5,                       // stay clear of the -30 deg edge (black outside the survey)
    zoomPx: 12,                          // closest zoom: 1" = 12 screen pixels
  },
};

/** Survey or close-up map by key. */
export const surveyInfo = (key) => SURVEYS[key] || CLOSEUP_SURVEYS[key];

// Close-up rule (degrees of field width): the sharp map fades in from CLOSEUP_FOV[0] to CLOSEUP_FOV[1].
export const CLOSEUP_FOV = [0.5, 0.3];
export const SPHEREX_PIXEL_ARCSEC = 6.15;      // SPHEREx detector pixel
export const SPHEREX_MAP_PIXEL_ARCSEC = 12.9;  // pixel of the IRSA all-sky HiPS (order 5 x 512 = order 14)

/** Sharpest working map at a view centre: Pan-STARRS north of -30 deg, DSS2 colour further south. */
export function closeupKeyAt(dec, fov) {
  return dec - fov > CLOSEUP_SURVEYS.panstarrs.decMin ? "panstarrs" : "visible";
}

// Closest zoom (field width, degrees): as close as the sharpest map at that spot still shows real
// detail, and never closer than 1' across. For a 1400 px wide sky:
//   Pan-STARRS (Dec > -30): 1" = 12 screen px -> 1.9' (its 0.25" pixels are 3 px, its ~1" stars ~12 px);
//   DSS2 colour (far south): 1" = 5 screen px -> 4.7' (its 0.8" map pixels are 4 px, 2-3" stars 10-15 px).
// Any closer would only magnify pixels.
export function minFov(widthPx, key = "panstarrs") {
  const pxPerArcsec = surveyInfo(key)?.zoomPx || SURVEYS.visible.zoomPx;
  return Math.max(1 / 60, (widthPx || 1400) / pxPerArcsec / 3600);
}

// SPHEREx DR1 cube: frame index = 17*(band-1) + (channel-1); wavelengths from the HiPS properties.
export const SPHEREX_SLICES = [
  { um: 1.0, slice: 12, label: "1.0 µm" },
  { um: 1.5, slice: 30, label: "1.5 µm" },
  { um: 2.0, slice: 42, label: "2.0 µm" },
  { um: 3.0, slice: 59, label: "3.0 µm" },
  { um: 4.0, slice: 73, label: "4.0 µm" },
  { um: 4.6, slice: 90, label: "4.6 µm" },
];

const chosen = new Map();

async function probe(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url + "/properties", { signal: ctl.signal, mode: "cors", cache: "force-cache" });
    return r.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}

/** Resolve the working mirror URL of a survey (cached). Rejects when no mirror answers. */
export function surveyUrl(key, ms = 5000) {
  if (!chosen.has(key)) {
    const s = surveyInfo(key);
    const p = (async () => {
      let remembered = null;
      try { remembered = sessionStorage.getItem("fz-hips-" + key); } catch { /* storage blocked */ }
      const order = remembered && s.mirrors.includes(remembered)
        ? [remembered, ...s.mirrors.filter((m) => m !== remembered)] : s.mirrors;
      // One mirror at a time (so a dead host costs a few seconds, not a console full of errors).
      for (const m of order) {
        if (await probe(m, ms)) {
          try { sessionStorage.setItem("fz-hips-" + key, m); } catch { /* ignore */ }
          return m;
        }
      }
      throw new Error(`No mirror of ${s.title} is answering right now.`);
    })();
    p.catch(() => chosen.delete(key));
    chosen.set(key, p);
  }
  return chosen.get(key);
}
