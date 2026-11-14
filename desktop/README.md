# Fazari Sky 3D (Python desktop viewer)

A desktop sky viewer for the NASA Space Apps 2026 challenge "Planet X and SPHEREx". It is a planetarium
view: the camera sits at the centre of the celestial sphere and you look out at the sky as from the ground
(east to the left when north is up, not mirrored). You turn left/right/up/down, zoom from a 120 degree view
down to a few arcminutes, click a point, and the
Fazari local engine fetches the SPHEREx images of that point, runs our blink/motion pipeline and shows the
result in the same window.

## Start

Double-click **Fazari 3D (Python)** on the desktop (`~/Desktop/Fazari-3D-Python.desktop` runs
`desktop/launch_sky3d.sh`: it starts the local engine `local/serve.py` in a terminal window if it is not
running yet, then the viewer). Or from the `fazari/` folder:

```
uv run --no-project --with vispy --with PyQt5 --with numpy --with astropy --with astropy-healpix \
    python -I desktop/sky_viewer.py            # optional: --ra 269.45 --dec 4.77 --fov 2
python3 -I local/serve.py                      # the engine, in another terminal (for "Fetch SPHEREx images")
```

Nothing is installed globally: `uv` builds a cached environment. Needs an OpenGL 2.1 GPU driver.

PyQt5 rather than PyQt6: Qt 6.5 and later need the system package `libxcb-cursor0` for its X11 plugin, which
this Ubuntu 24.04 machine does not have, and vispy's Qt backend crashed with the older PyQt6 6.4 wheels. If
PyQt5 is not available, the viewer uses PyQt6.

Controls: drag = turn the look direction (yaw/pitch, north stays up, no roll), mouse wheel or two-finger
scroll = zoom toward the cursor (touch pinch where Qt delivers it), click = pick a point (it snaps to a listed
object nearby), arrow keys = turn, `+`/`-` = zoom, `G` = grid on/off, `R` = back to the widest view. Click an
object in the side panel to fly there.

The widest view spans 120 degrees across the wider side of the window (about 120 x 95 degrees in a
1100 x 830 sky area), so the whole sky never fits on one screen and there is no all-sky map or globe view.
A compass in the lower left shows celestial north (N, red) and east (E, blue) at the view centre,
recomputed from the projection every frame, with the look direction and the field size.

## Coordinates (ICRS everywhere)

Everything the viewer shows and reads is ICRS RA/Dec in degrees: the stars, the markers, the footprints, the
input box, the click. (The Milky Way glow is computed from galactic latitude inside its shader, but it is only
a picture; no position goes through another frame.)

- Type a coordinate in the box of "Picked point" (`269.44627 +4.76820`, `17 57 47.1 +04 46 05.5`,
  `17h57m47.1s +4d46m05s`): the marker follows while you type, Enter or "Go" turns the view there.
- Click the sky: the box shows the clicked coordinate (6 decimals = 0.004").
- Picking (screen pixel -> RA/Dec) is computed in float64 on the CPU; the GPU only draws.
- Stars are drawn at **epoch 2026.0**: every tile also holds the Gaia DR3 proper motion, and positions are
  moved from 2016.0 in float64 (the same linear formula as `local/serve.py`) before they go to the GPU.
- `desktop/tests/test_coords.py` checks this offscreen: Barnard's Star, Epsilon Indi B, Luhman 16 and 20
  random points, at fields of view 60, 10, 1, 0.2 and 0.05 deg (numbers below).

## SPHEREx footprints

For the picked point the viewer asks the static sky index (`pipeline/sky_index.find_images`, files in
`site/index/`) in a background thread, and draws the four-corner outline of every covering SPHEREx image on
the sphere (edges follow great circles), coloured by observing season (a new season after a gap of more
than 30 days). A legend with the image count per season sits under the input box; the "SPHEREx
footprints" checkbox turns the layer on and off.

## What you see

- **Stars**: ESA Gaia DR3. A base layer of the ~21 000 stars with G < 7 (plus 78 naked-eye stars that Gaia
  saturates on, from Hipparcos) is always there. Fainter stars come in as you zoom (below).
- **Milky Way**: drawn by a formula, not an image: the fragment shader turns each pixel into galactic
  coordinates and evaluates a disk + bulge + dust lane + fractal noise glow, plus the Magellanic Clouds.
- **Lines**: RA/Dec grid, galactic equator, ecliptic (gold).
- **SPHEREx footprints** of the picked point (above).
- **Markers**: rings (the star stays visible inside) for the 72 points of `site/data/categories.json` (2026 positions), coloured by category; the
  side panel lists them and toggles each category.
- **Status bar**: centre (sexagesimal), field of view, limiting magnitude, stars in view / on the GPU,
  tiles loaded and loading, frames per second, memory, engine state.

## How it works

| part | file | notes |
|------|------|-------|
| rendering | `sky_render.py` | vispy gloo (OpenGL 2.1). Every layer is unit vectors; the vertex shader rotates them into the camera frame and applies a stereographic projection (round stars at any field of view, 0.03-220 deg). Stars are additive point sprites: size and brightness from G against the zoom's limiting magnitude, colour from BP-RP. |
| GPU memory | `sky_render.StarPool` | fixed 262 144-star vertex buffers. A tile is copied into a free range when it arrives (`glBufferSubData`), and the range is blanked when it is evicted: no re-upload of the whole sky. A frame is ~10 draw calls; Python does no per-star work per frame. |
| level of detail | `sky_catalog.py` | Gaia DR3 in magnitude slices on HEALPix grids: order 2 (G 7-10), 4 (10-13), 6 (13-16), 8 (16-18.5), about five tiles across the screen at each level. A slice is requested only when the zoom's limiting magnitude reaches it; only tiles that cover the view are requested, nearest and brightest first. One tile = one range query on `source_id` (it carries the level-12 HEALPix index) at the ESA Gaia archive; the CDS VizieR mirror at IDIA is the fallback. |
| cache, limits | `cache/sky3d/` | every tile is stored as `.npy` (`cache/sky3d/gaia/o<order>_g<range>/<pix>.npy`) and read from disk next time. At most 3 catalogue requests at once, retries with exponential backoff, User-Agent `fazari-spaceapps/1.0`. A 3 million star cap with least-recently-used eviction of tiles out of view. |
| threads | | GUI thread: drawing and input only. Tile workers (3), base-layer download, engine health check and engine jobs run in background threads and hand results over through queues read by a 60 Hz timer; at most ~8 ms of tile uploads per frame. |
| engine | `engine_client.py` | `POST /api/jobs {ra, dec, name}`, polls `GET /api/jobs/<id>`, `DELETE` to cancel; when done reads `meta.json` and the `frames/*.png` and blinks them in the panel with the measured motion. "Open in browser" opens `ornek.html?data=/jobs/<id>/`. |
| benchmark | `bench_viewer.py` | scripted camera path, offscreen (`QT_QPA_PLATFORM=offscreen`), writes `cache/sky3d/bench*.json` and the `B_*.png` screenshots. |

## Tests and benchmark

```
QT_QPA_PLATFORM=offscreen uv run --no-project --with vispy --with PyQt5 --with numpy --with astropy \
    --with astropy-healpix python -I desktop/tests/test_coords.py
```

```
QT_QPA_PLATFORM=offscreen uv run --no-project --with vispy --with PyQt5 --with numpy --with astropy \
    --with astropy-healpix python -I desktop/bench_viewer.py [--engine-runs]
```

## Measured (2026-11-14, Intel Iris Xe / Mesa 25.2, 1480 x 860 window, sky area 1056 x 831)

| what | number |
|------|--------|
| widest view | 120 deg across x 97.7 deg (stereographic) |
| start to first frame (Python start, base layer from cache) | 1.0 s on screen, 1.8-2.2 s offscreen |
| frame rate while turning / zooming, real window | 62 fps (vsync), 2.5 ms CPU per frame |
| frame rate offscreen, glFinish every frame (no vsync) | 85 fps turning at the widest view, 78 zooming, 104 panning at 5 deg with 760 000 stars on the GPU |
| memory (RSS) | 230 MB at start, 280 MB with 760 000 stars resident |
| stars drawn in view (Barnard field) | 4 000 at 120 deg, 9 700 at 6 deg (G<12.8), 4 300 at 1.3 deg (G<16.3), 2 300 at 0.38 deg (G<18.9) |
| new tiles (ESA Gaia archive) | ~3 s per tile, 3 in parallel; a new region at 6 deg settles in ~30 s, cached afterwards (~1 s) |
| coordinate round trip | text -> marker 0.005" max; pixel <-> coordinate (float64) < 1e-9"; GPU-drawn marker within 0.08 px (0.06" at 0.2 deg, 0.02" at 0.05 deg) |
| marker on Barnard's Star (Gaia DR3 + proper motion to 2026.0) | lands on the drawn star, 0.00" (pixel 0.87") |
| click -> result, Luhman 16AB (engine run, downloads already cached by the engine) | 79 s (engine processing 78 s); cached result 0.05 s |
| Barnard's Star, engine vs `site/data/barnard/meta.json` | 10.207" at PA 355.69 deg in both (Gaia DR3 predicts 10.244") |

## Later: a shared candidate registry (not built)

Room is left for a sharing server where users mark a candidate moving object and name it:

- A candidate = `{job_id, ra, dec, epoch, motion (pmra, pmdec), wavelength bins, frames, author, comment}`.
  The viewer already has everything except the author: the picked point, the job id and `meta.json`.
- The user proposes a **Fazari registry name**. The server accepts it only if it is unique in our registry
  (case- and punctuation-insensitive), else suggests one (e.g. `FZR J1757+0446a`, from the position like
  IAU-style designations). It is our catalogue label only, clearly marked as such: official names come from
  the IAU, and a registry entry would link to the official designation once one exists.
- The local engine reserves `/api/candidates` for this (see `local/README.md`). In the viewer it would be a
  "Mark as candidate" button in the result box and a "Candidates" category in the side panel, drawn with the
  same marker layer.

## Credits

Stars: ESA Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023), via the ESA Gaia archive and CDS VizieR;
the brightest stars from Hipparcos (ESA 1997). Images: NASA SPHEREx via NASA/IPAC IRSA, processed by the
Fazari local engine. Rendering: vispy, Qt; HEALPix via astropy-healpix.
