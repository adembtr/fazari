// The 5 challenge targets, copied from pipeline/targets.json + targets_extra.json (parallax).
// ra/dec in degrees at `epoch` (Julian year); pmra = mu_alpha*cos(dec), pmdec in mas/yr; plx in mas.
// Regenerate by hand if those files change (the site only publishes site/).
export const TARGETS = {
 "barnard": {
  "name": "Barnard's Star",
  "kind": "motion",
  "ra": 269.44850252543836,
  "dec": 4.739420051112412,
  "epoch": 2016,
  "pmra": -801.5509783684709,
  "pmdec": 10362.394206546573,
  "plx": 546.976,
  "rv": -110.47,
  "rv_source": "Gaia DR3 radial velocity; used for the perspective acceleration (+0.064 arcsec 2016 -> 2026)",
  "gaia_dr3": "4472832130942575872",
  "source": "Gaia DR3 4472832130942575872"
 },
 "eps_indi_b": {
  "name": "Epsilon Indi B",
  "kind": "motion",
  "ra": 331.07645259656397,
  "dec": -56.79381206688221,
  "epoch": 2016,
  "pmra": 3981.97666296105,
  "pmdec": -2466.8318147663504,
  "plx": 270.658,
  "gaia_dr3": "6412596012146801152",
  "source": "Gaia DR3 6412596012146801152"
 },
 "wise0855": {
  "name": "WISE 0855-0714",
  "kind": "motion",
  "ra": 133.795129,
  "dec": -7.245147,
  "epoch": 2010.5,
  "pmra": -8120,
  "pmdec": 670,
  "plx": 439,
  "gaia_dr3": null,
  "source": "Not in Gaia (too faint). Position from the challenge text (WISE J085510.83-071442.5, epoch approximate). Proper motion approximate, from the literature (Luhman & Esplin 2016)."
 },
 "rw_aur": {
  "name": "RW Aurigae",
  "kind": "brightness",
  "ra": 76.9565443110343,
  "dec": 30.401316149887936,
  "epoch": 2016,
  "pmra": 4.90603392110511,
  "pmdec": -24.577534567492915,
  "plx": 5.454,
  "gaia_dr3": "156430817820015232",
  "source": "Gaia DR3 156430817820015232"
 },
 "r_dra": {
  "name": "R Draconis",
  "kind": "brightness",
  "ra": 248.1673783672889,
  "dec": 66.75500674547219,
  "epoch": 2016,
  "pmra": -20.642811719160797,
  "pmdec": 6.148818852711324,
  "plx": 1.251,
  "gaia_dr3": "1648328016354496384",
  "source": "Gaia DR3 1648328016354496384"
 }
};

export const ALIASES = {
  barnard: ["barnard", "barnard star", "barnards star", "barnard s star", "gj 699", "gl 699"],
  eps_indi_b: ["eps indi b", "epsilon indi b", "eps ind b", "epsilon indi ba"],
  wise0855: ["wise 0855", "wise0855", "wise 0855-0714", "wise j085510.83-071442.5"],
  rw_aur: ["rw aur", "rw aurigae"],
  r_dra: ["r dra", "r draconis"],
};
