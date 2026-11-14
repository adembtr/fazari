# Fazari — SPHEREx Blink Explorer

Fazari shows images of the same patch of sky, taken by NASA's SPHEREx infrared observatory in different observing seasons, as a "blink" animation. Switching between the seasons makes moving objects (nearby brown dwarfs, high proper-motion stars) and changing sources easy to spot by eye. For each season the viewer marks where the target should be according to its Gaia DR3 position, proper motion and parallax, so real motion can be told apart from noise.

Challenge: [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/) — NASA Space Apps Challenge 2026.

## Status

Work in progress during the hackathon (14–15 November 2026).

- **Works now:** the data pipeline and a local viewer, demonstrated on Barnard's Star (three seasons, six wavelength bins, motion measured and compared with Gaia).
- **Planned:** the other four challenge targets (Epsilon Indi B, WISE 0855-0714, RW Aurigae, R Draconis), search by any user-entered coordinate, and a public site on GitHub Pages.

## Repository layout

- `pipeline/targets.json` — target catalog (position, proper motion, reference epoch, source).
- `pipeline/targets_extra.json` — parallaxes used for the Gaia prediction.
- `pipeline/download.py` — lists and downloads SPHEREx image cutouts from IRSA (Python standard library only).
- `pipeline/blink.py` — builds the blink frames and measures the motion.
- `site/ornek.html` — viewer page (blink, wavelength choice, zoom, Gaia marker, difference image, measured motion).
- `site/data/<target>/` — pipeline output: `frames/*.png`, `blink_*um.gif`, `diff_*um.png`, `images.csv` (per-exposure diagnostics), `meta.json` (read by the viewer).

## Reproduce

Requires Python 3 and [uv](https://docs.astral.sh/uv/).

1. Download the cutouts (resumable; files already on disk are skipped):

   ```
   python3 -I pipeline/download.py list barnard
   python3 -I pipeline/download.py download barnard            # DR1 and QR3
   python3 -I pipeline/download.py download barnard --collection dr1
   ```

   Data directory: `--data-dir DIR`, else the `FAZARI_DATA` environment variable, else `../veri/real_spherex` next to the repository if it exists, else `raw/` inside the repository (not committed). Layout: `<data>/<target>/liste_<collection>.csv` and `<data>/<target>/<collection>/*.fits`.

2. Build the frames and the measurement (writes to `site/data/<target>/`, or to `$FAZARI_OUT/<target>/` if set):

   ```
   uv run --no-project --with astropy --with reproject --with numpy --with scipy \
       --with matplotlib --with pillow python -I pipeline/blink.py barnard
   ```

3. View locally:

   ```
   cd site && python3 -m http.server 8765
   ```

   then open http://127.0.0.1:8765/ornek.html

## Method

1. SPHEREx Level 2 spectral images that contain the target are found with the IRSA SIA service; a 0.2° cutout is downloaded from each.
2. Exposures are grouped into seasons wherever consecutive dates are more than 30 days apart.
3. The wavelength at the target pixel is read from each image's spectral WCS. Exposures are put into bins at 1.0, 1.5, 2.0, 3.0, 4.0 and 4.6 µm (±6 %), so that only matching wavelengths are blinked.
4. Each exposure: the ZODI (zodiacal light) model is subtracted, bad pixels from the FLAGS layer are masked, saturated pixels are marked.
5. Exposures are reprojected onto one north-up TAN grid centred on the target (3″/pixel, 0.15° field) and median-stacked per season and bin. All frames of a bin share one asinh stretch.
6. Astrometry: a pixel-integrated Gaussian is fitted to the unsaturated wings of the star in native pixels. A joint fit of all exposures solves for position and proper motion, with the parallax fixed to the catalog value and one centroid offset per detector.

## Result: Barnard's Star

From `site/data/barnard/meta.json` (358 cutouts; seasons 2025-08, 2026-03, 2026-08):

| | Measured | Gaia DR3 prediction |
|---|---|---|
| Shift 2025-08 → 2026-08 (0.98 yr, same telescope orientation) | 10.13″ at PA 355.8° | 10.23″ at PA 355.7° |
| Proper motion (joint fit, 354 exposures) | −788.5 ± 53.1, 10264.5 ± 53.1 mas/yr | −801.6, 10362.4 mas/yr |

The headline shift uses two seasons seen with the same orientation, where the detector-fixed centroid offset cancels. The March season is seen rotated by 180° and is used to calibrate that offset, so it is not an independent check.

## Known limitations

- The 4.0 and 4.6 µm bins mix exposures from two detectors (D4+D5 and D5+D6).
- The pipeline uses 0.2° cutouts around each target, not full SPHEREx images.
- WISE 0855-0714 is not in Gaia; its position and motion in the catalog are approximate (literature values).
- Barnard's Star is saturated in its core; its position comes from the wings only.

## Data and credits

- [SPHEREx DR1 spectral images](https://doi.org/10.26131/IRSA678) — NASA/IPAC Infrared Science Archive (IRSA), DOI: 10.26131/IRSA678
- [SPHEREx QR3 spectral images](https://doi.org/10.26131/IRSA662) — NASA/IPAC IRSA, DOI: 10.26131/IRSA662
- [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3) — European Space Agency (ESA). Positions, proper motions and parallaxes of the targets are Gaia DR3 values (except WISE 0855-0714).

This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.

This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC).

This is a hackathon project by Team Fazari. It is not endorsed by NASA or ESA.

## Tools

Python (astropy, reproject, NumPy, SciPy, Matplotlib, Pillow), uv, HTML, CSS, JavaScript, NASA/IPAC IRSA SIA and cutout services.

## Use of AI

Code and documentation in this repository were written with help from Anthropic's Claude (Claude Code). Commits made with AI help carry a `Co-Authored-By: Claude` trailer. Team Fazari designed the project and checked and tested the results.

## License

MIT — see [LICENSE](LICENSE).

---

Team Fazari — Sakarya, Türkiye
