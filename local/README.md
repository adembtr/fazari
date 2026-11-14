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

## What a job does

1. **finding**: the 5 challenge targets (matched by name or by position within 60") use the local IRSA
   cutouts and lists (`../veri/real_spherex/<target>/`, or `FAZARI_LOCAL_DATA`). Any other point asks the
   static sky index (`pipeline/sky_index.py`, `site/index/`); IRSA SIA is the fallback.
   A point of `site/data/categories.json` with a known proper motion (e.g. Luhman 16AB) uses that motion.
2. **selection** (not for local targets, which use all their cutouts): per observing season and per
   single-detector wavelength bin (1.0 D1, 1.5 D2, 2.0 D3, 3.0 D4, 4.0 D5, 4.6 D6 um), the `cap` exposures
   closest to the bin centre; bins seen in fewer than 2 seasons are skipped.
3. **downloading**: 0.2 deg cutouts are read from the public SPHEREx S3 bucket with HTTP Range
   (`pipeline/fetch_region.py`, at most 4 requests in flight, User-Agent `fazari-spaceapps/1.0`), about
   3.6 MB per image. The EPSF extension (same for every file of a detector) is cached once per calibration.
4. **processing**: `pipeline/blink.py` on the ad-hoc target writes `cache/jobs/<id>/`
   (meta.json, frames, blink GIFs, difference images, images.csv).

Results are cached by rounded position (0.001 deg) and options: posting the same point again returns the
finished job at once, unless `pipeline/blink.py` or the target catalogue changed (or `"force": true`).

## API (127.0.0.1:8765)

| call | body / answer |
|------|---------------|
| `GET /api/health` | `{"ok": true, "engine": "python", "version": "1.0.0", ...}` |
| `POST /api/jobs` | `{ra, dec, name?, bins?, cap?}` -> `{"id": "...", "cached": bool}` |
| `GET /api/jobs/<id>` | `{state, progress: {done, total, bytes}, message, result_url: "/jobs/<id>/", ...}` |
| `DELETE /api/jobs/<id>` | cancel: stops the downloads and blink.py -> `{"id", "state": "cancelled"}` |
| `GET /api/jobs` | `{"jobs": [...]}` all known jobs |
| `GET /jobs/<id>/...` | blink.py products; view with `ornek.html?data=/jobs/<id>/` |

- `ra` 0..360, `dec` -90..90 (degrees, ICRS); `name` free text (label only, max 100 chars);
  `bins` subset of `[1.0, 1.5, 2.0, 3.0, 4.0, 4.6]` (default all); `cap` 1..30 exposures per season and bin
  (default 6). Optional: `pmra`, `pmdec` (mas/yr), `epoch` (Julian year), `kind` (`motion`|`brightness`), `force`.
- `state`: `queued` -> `finding` -> `downloading` -> `processing` -> `done`, or `error` / `cancelled`.
  Extra fields: `timings` (seconds per stage), `images` (found/selected per bin), `result`, `viewer`.
- Jobs run one at a time; the server keeps answering while a job runs.
- POST/DELETE are accepted only from pages of this server (Host/Origin check).

### Reserved: candidates (not built yet)

`/api/candidates` is reserved for a later "Mark as candidate" feature: a user flags a moving object in a
job's frames with a type and a comment, and the flags go to a shared list. Planned shape:
`GET /api/candidates`, `POST /api/candidates` `{job_id, ra, dec, epoch, type, comment}`, and
`DELETE /api/candidates/<id>` for the author. Storage would live outside `cache/` (it is shared data).

## Files

- `local/serve.py`: HTTP server, job queue, static files (`site/`, `/jobs/`).
- `local/job_worker.py`: one job (find, select, fetch, blink.py).
- `local/launch.sh`: used by the desktop launcher.
- Data: `cache/jobs/<id>/` (products), `cache/local/jobs/<id>/` (request, status, log),
  `cache/local/inputs/<id>/` (links to the cutouts, IRSA-style lists), `cache/local/cutouts/`,
  `cache/local/epsf/`, `cache/s3/` (byte ranges); Gaia field stars of ad-hoc points are cached by
  blink.py in `cache/jobs/<id>/gaia_field.json`. All gitignored.
