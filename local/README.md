# Fazari local engine

Runs the full SPHEREx blink pipeline on your own computer and shows the results in the browser.

```
python3 -I local/serve.py            # from the fazari/ folder, then open http://127.0.0.1:8765/explore.html
```

Or double-click **Fazari Local** on the desktop (`~/Desktop/Fazari-Local.desktop` runs `local/launch.sh`:
it starts the server in a terminal window if it is not running yet and opens the explorer).

Needs: Python 3.10+ (the server uses the standard library only) and [uv](https://docs.astral.sh/uv/).
The heavy work runs in `uv run --no-project --with astropy --with reproject --with numpy --with scipy
--with matplotlib --with pillow python -I local/job_worker.py`, so nothing is installed globally.
The server listens on 127.0.0.1 only.

## Preview first, full result in the background

A click in the explorer posts the full job with `"preview": true`. Unless the full result is cached,
the server also queues a **preview** of the point in its own fast lane (`local/preview.py`):

- one wavelength only: 2.0 um on detector D3 (else the next bin seen in two seasons), 2-4 exposures
  per season (12 in all for 3-6 seasons), the ones whose wavelength at the point is closest to 2.0 um;
- small regions only: a 0.1 deg box, IMAGE + FLAGS rows (about 0.8 MB per image, no VARIANCE, ZODI,
  EPSF or wavelength table), 6 images and at most 6 requests in flight, in season round-robin order;
  the challenge targets read their local cutouts instead (no download);
- a first look as soon as every season has 2 regions (`<cache>/jobs/<id>-pv/quick/`, announced as
  `"partial"` in the job status), then the complete preview (`<cache>/jobs/<id>-pv/`);
- products in blink.py's layout with `"preview": {...}` in meta.json; ornek.html labels them
  "Preview (N images)". It is not a measurement: no Gaia calibration, no error bars; for a target with
  a known proper motion a raw-WCS shift is shown as **preliminary**.

The explorer shows the preview as soon as it exists, then replaces it with the full result
("Full result (N images)"). Priority: the preview lane never waits for a full job, and while a
preview is queued or running the full job starts no new image download (flag file
`<cache>/local/preview.active`, see `yield_to_preview` in job_worker.py).

## What a job does

1. **finding**: the 5 challenge targets (matched by name or by position within 60") use the local IRSA
   cutouts and lists (`../veri/real_spherex/<target>/`, or `FAZARI_LOCAL_DATA`). Any other point asks the
   static sky index (`pipeline/sky_index.py`, `site/index/`); IRSA SIA is the fallback.
   A point of `site/data/categories.json` with a known proper motion (e.g. Luhman 16AB) uses that motion and
   its `parallax` (mas, when the point has one); else the `pmra`/`pmdec`/`epoch`/`parallax` of the request.
2. **selection** (not for local targets, which use all their cutouts): per observing season and per
   single-detector wavelength bin (1.0 D1, 1.5 D2, 2.0 D3, 3.0 D4, 4.0 D5, 4.6 D6 um), the `cap` exposures
   closest to the bin centre (default 30, in practice all of them); bins seen in fewer than 2 seasons are
   skipped. The first answer uses 3 per season and bin (`FIRST_CAP`), the rest refine it.
3. **downloading**: cutouts of `FULL_CUTOUT_DEG` = 0.2 deg (`local/serve.py`; request option `cutout_deg`)
   are read from the public SPHEREx S3 bucket with HTTP Range (`pipeline/fetch_region.py`, at most 4
   requests in flight, User-Agent `fazari-spaceapps/1.0`), about 3.6 MB per image (0.4 deg: about 7 MB).
   0.2 deg is the default for the fastest first result; 0.4 deg (on request) holds 4-6x the Gaia reference stars and halves the field-calibration error
   (`pipeline/ACCURACY.md`). The EPSF extension (same for every file of a detector) is cached once per
   calibration. The challenge targets use their local cutouts: `../veri/real_spherex_<size>/` if it has
   that size (`pipeline/download.py --size`), else the 0.2 deg ones (no multi-GB download on a click).
4. **processing**: `pipeline/blink.py` on the ad-hoc target writes `cache/jobs/<id>/`
   (meta.json, frames, blink GIFs, difference images, images.csv).
5. **post-steps**: `POST_STEPS` in `local/job_worker.py` (extension point for later steps of the full
   result, e.g. a moving-object finder; never run for a preview). They run AFTER the job is shown:
   the full worker is started with `--no-post`, so the job is `done` and viewable as soon as blink.py
   wrote meta.json and the frames; the server then runs `job_worker.py --post-only <steps>` in its
   `post` lane (next to the next full job). Until they finish the status has
   `post_pending: {steps, state}` and `complete: false`, and `post.<step>` appears as each one
   ends; ornek.html (`site/js/post_watch.js`) polls that and mounts each output when it exists. `spectrum` (`pipeline/spectrum.py`):
   forced PSF photometry of the target in every exposure of the job -> `spectrum.csv` (one row per
   exposure) and `spectrum.json` (points, season bins, summary), shown as a chart in ornek.html
   (~15 s for 250 exposures). `candidates` (`pipeline/detect`) and `faint` (`pipeline/faint.py`)
   follow. Entries are `("name", "module", "function")` string constants, so the server can
   fingerprint each step without importing the worker (see below).

Results are cached by rounded position (0.001 deg), options and the target's motion (proper motion, epoch and,
when nonzero, parallax: the `-pm<hash>` part of the id): posting the same point again returns the
finished job at once, unless `pipeline/blink.py` (and the local modules it imports) or the target
catalogue changed (or `"force": true`). Each post-step has its own fingerprint: its module and every
local module it imports (any depth; `serve.py post_step_hashes`, recorded per job as
`post_hashes`). If only post-steps are new or changed and the job's cutouts are still in
`cache/local/inputs/<id>/`, the cached result is returned at once (`cached: true`, no preview) and
just those steps are rerun in the post lane (`job_worker.py --post-only a,b`); the job stays `done`
and its status shows `post_pending: {steps, state}` meanwhile. Without the cutouts the job reruns fully.

## API (127.0.0.1:8765)

| call | body / answer |
|------|---------------|
| `GET /api/health` | `{"ok": true, "engine": "python", "version": "1.0.0", ...}` |
| `POST /api/jobs` | `{ra, dec, name?, bins?, cap?, cutout_deg?, mode?, preview?}` -> `{"id": "...", "cached": bool, "mode", "preview": {"id", "cached"} \| null}` |
| `GET /api/jobs/<id>` | `{state, mode, progress: {done, total, bytes}, message, result_url: "/jobs/<id>/", queue, eta_s, partial?, ...}` |
| `DELETE /api/jobs/<id>` | cancel: stops the downloads and blink.py -> `{"id", "state": "cancelled"}` |
| `GET /api/jobs` | `{"jobs": [...]}` all known jobs |
| `GET /jobs/<id>/...` | blink.py products; view with `ornek.html?data=/jobs/<id>/` |

- `ra` 0..360, `dec` -90..90 (degrees, ICRS); `name` free text (label only, max 100 chars);
  `bins` subset of `[1.0, 1.5, 2.0, 3.0, 4.0, 4.6]` (default all); `cap` 1..30 exposures per season and bin
  (default 30 = in practice all within ±5.5 % of the bin centre; was 6). Optional: `pmra`, `pmdec` (mas/yr), `epoch` (Julian year), `parallax`
  (mas, 0..2000; the explorer sends it for category points and fast stars), `kind` (`motion`|`brightness`), `force`.
- `cutout_deg`: cutout size of a full job, one of 0.2, 0.3, 0.4, 0.5, 0.6 (default `FULL_CUTOUT_DEG` = 0.2).
  It is part of the job id (`...-s0.4`; 0.2 deg ids have no tag, as before) and of the cutout store
  (`cache/local/cutouts/<point>-s0.4/`), so sizes never mix. Previews keep their own small region.
  In the explorer the user picks it with the Field selector on the place card (`?fov=0.3` in the
  address bar, also passed to sky.html; `site/js/fov.js` holds the choices and the rough time/size
  estimate shown next to it). The five challenge targets always use their saved images (0.2 deg, or a
  larger set saved by `pipeline/download.py --size`); nothing is downloaded for them.
- `mode`: `full` (default) or `preview` (one id per point: `<...>-pv`, bins/cap do not apply);
  `"preview": true` with a full request also queues the preview (the `preview` field of the answer).
- `state`: `queued` -> `finding` -> `downloading` -> `processing` -> `done`, or `error` / `cancelled`.
  Extra fields: `timings` (seconds per stage), `images` (found/selected per bin), `result`, `viewer`,
  `queue: {lane, ahead, position, wait_s}` (queued: jobs ahead in its lane and a rough wait; running:
  position 0), `eta_s` (running: rough seconds left), `paused_for_preview` (a full job waiting for a
  preview), `partial: {n_images, url}` (preview: first look ready), `post` (post-step results),
  `post_pending: {steps, state}` (viewable, post-steps still queued/running), `complete` (blink and
  every post-step done). Post-steps cut off by a server stop are queued again at the next start.
- Three lanes, one job at a time each: `full`, `preview` and `post`; the server keeps answering while
  jobs run.
- `FAZARI_CACHE=/some/dir python3 -I local/serve.py --port 8791` keeps everything (jobs, byte cache,
  cutouts) in that folder instead of `cache/`, e.g. a fresh temporary folder for uncached timing runs.
- POST/DELETE are accepted only from pages of this server (Host/Origin check).

### Reserved: candidates (not built yet)

`/api/candidates` is reserved for a later "Mark as candidate" feature: a user flags a moving object in a
job's frames with a type and a comment, and the flags go to a shared list. Planned shape:
`GET /api/candidates`, `POST /api/candidates` `{job_id, ra, dec, epoch, type, comment}`, and
`DELETE /api/candidates/<id>` for the author. Storage would live outside `cache/` (it is shared data).

## Files

- `local/serve.py`: HTTP server, job queue, static files (`site/`, `/jobs/`).
- `local/job_worker.py`: one full job (find, select, fetch, blink.py, post-steps).
- `local/preview.py`: one preview job (fast lane).
- `local/launch.sh`: used by the desktop launcher.
- Data: `cache/jobs/<id>/` (products), `cache/local/jobs/<id>/` (request, status, log),
  `cache/local/inputs/<id>/` (links to the cutouts, IRSA-style lists), `cache/local/cutouts/`,
  `cache/local/epsf/`, `cache/s3/` (byte ranges); Gaia field stars of ad-hoc points are cached by
  blink.py in `cache/jobs/<id>/gaia_field.json`. All gitignored.
