# Fazari — SPHEREx Blink Explorer

Fazari is a planned public web tool that shows images of the same patch of sky, taken by NASA's SPHEREx infrared observatory on different dates, as a "blink" animation. Switching quickly between the epochs makes moving objects (such as nearby brown dwarfs and high proper-motion stars) and changing sources easy to spot by eye. Known stars from Gaia DR3 can be overlaid to help separate real motion from noise.

**Status:** work in progress during NASA Space Apps Challenge 2026 (November 14–15).

Challenge: [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)

## Data

- [SPHEREx DR1 spectral images](https://doi.org/10.26131/IRSA678) — NASA/IPAC Infrared Science Archive (IRSA), DOI: 10.26131/IRSA678
- [SPHEREx QR3 spectral images](https://doi.org/10.26131/IRSA662) — NASA/IPAC IRSA, DOI: 10.26131/IRSA662
- [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3) — European Space Agency (ESA)

This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.

## Repository layout

- `pipeline/` — Python data pipeline (downloads image cutouts and prepares blink frames)
- `site/` — static web app (the blink viewer)

## Use of AI

Parts of the code and documentation in this repository were written with the assistance of Anthropic's Claude (an AI assistant). The idea, design decisions, testing and verification are by Team Fazari. AI-assisted files are noted in commit messages.

## License

MIT — see [LICENSE](LICENSE).

---

Team Fazari — Sakarya, Türkiye
