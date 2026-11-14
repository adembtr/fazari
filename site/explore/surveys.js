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
      "https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color",
      "https://alasky.cds.unistra.fr/DSS/DSSColor",
    ],
    credit: "DSS2 colour: Digitized Sky Survey, STScI/NASA; coloured and HEALPixed by CDS",
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
  },
};

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
    const s = SURVEYS[key];
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
