"""Run the candidate finder on one field and write candidates.json.

  uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib \
      --with pillow python -I pipeline/find_candidates.py barnard            # challenge target
  ... python -I pipeline/find_candidates.py --job <job id>                     # local-engine job
  ... python -I pipeline/find_candidates.py --dir <cutout dir> --ra R --dec D --name X

Output: <out>/candidates.json (<out> = FAZARI_OUT/<target>, the job folder, or --out). An
existing candidates.json is never overwritten unless --overwrite is given.

Detectors are modules with NAME and run(ctx); add new ones to DETECTORS (order matters only
for shared work: B before D reuses B's systematic floor).
"""
import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

from . import calib as CAL
from . import data as Dt
from . import schema as SC
from . import diffimg, gaia_astrom, deep_astrom, variab, fast, sso, sensitivity, vet, nature, distant

# order: A first (its motion records are used by V to skip moving saturated stars), B before D
# (D reuses B's systematic floor). Detector P (detect/distant.py, distant Solar System bodies) is last
# and independent; its records come with their own nature / confirmation and are kept apart from the
# position merge. Registered 15 Nov 2026 after a check on two null fields (P added 1.6-2.1 s per field,
# 0 records; pipeline/PLANETX.md). It skips the quick stage (it needs the whole cutout).
DETECTORS = [diffimg, gaia_astrom, deep_astrom, variab, fast, distant]
VERSION = "1.1"
GAIA_RETRY_S = float(os.environ.get("FAZARI_GAIA_RETRY_S", 1800))   # keep retrying the Gaia query this long


class Ctx:
    """Everything a detector may use. Detectors add their own notes to ctx.info[NAME]."""

    def __init__(self, field, exps, gaia, cal, cal_summary, images=None, log=print, opts=None):
        self.field, self.exps, self.gaia = field, exps, gaia
        self.cal, self.cal_summary = cal, cal_summary
        self.seasons = Dt.seasons(exps)
        self.season_info = Dt.season_info(exps)
        # stack grid: 0.2 deg (the standard cutout) unless the field says it is smaller (quick boxes)
        self.grid = Dt.Grid(field.ra, field.dec, size_deg=getattr(field, "size_deg", None) or Dt.STACK_DEG)
        self.stacker = Dt.Stacker(exps, self.grid, cal)
        self.images = images
        self.log = log
        self.opts = opts or {}
        self.info, self.shared = {}, {}
        self.season_floor = None


def _gaia_near(g, ra, dec, radius_arcsec, epoch=2026.0):
    """The Gaia list g (gaia_field.json format) cut to the stars within radius_arcsec of
    (ra, dec) at epoch (positions moved with the Gaia proper motion)."""
    cols = g["columns"]
    i_ra, i_de, i_pr, i_pd = (cols.index(k) for k in ("ra", "dec", "pmra", "pmdec"))
    dt = epoch - float(g.get("ref_epoch", 2016.0))
    cosd = math.cos(math.radians(dec))
    keep = []
    for st in g["stars"]:
        dE = ((st[i_ra] - ra + 180) % 360 - 180) * cosd * 3600 + (st[i_pr] or 0.0) * dt / 1000
        dN = (st[i_de] - dec) * 3600 + (st[i_pd] or 0.0) * dt / 1000
        if math.hypot(dE, dN) <= radius_arcsec:
            keep.append(st)
    return dict(g, stars=keep)


def prepare(field, log=print, exps=None, gaia=True, gaia_retry_s=None, gaia_timeout=60, gaia_radius=None):
    """Read the exposures and register them. Returns (exps, gaia table, cal, cal summary).
    gaia_retry_s: how long a failing Gaia query is retried (default GAIA_RETRY_S; 0 = one try);
    gaia_timeout: seconds one try may take; gaia_radius (arcsec): use only the Gaia stars this
    close to the field centre (small boxes: the stars of the 0.15 deg list outside the box
    would be measured for nothing)."""
    t0 = time.time()
    if exps is None:
        exps = Dt.load_exposures(field, log=log)
    log(f"{field.label}: {len(exps)} exposures, seasons {Dt.seasons(exps)} ({time.time() - t0:.1f} s)")
    gt = None
    g = field.gaia() if gaia else None
    gaia_list = {"status": "not asked"}
    if gaia and g is not None and not g.get("stars"):
        # An empty list on disk is what a catalogue outage left behind on 14 Nov 2026 (IRSA TAP answered
        # 502 for hours). It is never taken as "no stars here": the catalogue is asked again and the answer
        # is used from memory (the file on disk belongs to whoever wrote it and is not rewritten).
        log("  the Gaia list on disk is empty: asking the catalogue again")
        g = fetch_gaia(field, log, retry_s=gaia_retry_s, timeout=gaia_timeout, cache=False)
        if g is None:
            gaia_list = {"status": "unavailable", "error": "the Gaia list on disk is empty and asking again failed: "
                         + str(getattr(field, "gaia_error", ""))}
    elif gaia and g is None and field.out_dir is not None:
        g = fetch_gaia(field, log, retry_s=gaia_retry_s, timeout=gaia_timeout)
        if g is None:
            gaia_list = {"status": "unavailable", "error": str(getattr(field, "gaia_error", ""))}
    elif gaia and g is None:
        gaia_list = {"status": "none", "error": "no Gaia list for this field and no folder to keep one in"}
    if g and g.get("stars"):
        gaia_list = {"status": "ok", "stars": len(g["stars"]), "source": g.get("source"), "retrieved": g.get("retrieved")}
    if g and gaia_radius:
        g = _gaia_near(g, field.ra, field.dec, gaia_radius)
    if g and g.get("stars"):
        gt = CAL.GaiaTable(g, (field.target or {}).get("gaia_dr3"))
    if gt is not None and gt.reference().sum() >= 5:
        idx = np.nonzero(gt.reference())[0]
        nbi = np.nonzero(~gt.reference() & np.isfinite(gt.G) & (gt.G < 18.0))[0]
        cal, summ = CAL.registration(exps, lambda m: gt.at(m, idx), None, gt.sid[idx], log=log, mode="gaia",
                                     nb=(lambda m: gt.at(m, nbi)) if len(nbi) else None)
    else:
        from . import deep_astrom
        cal, summ = deep_astrom.self_registration(field, exps, log=log)
    if field.field_stars_csv and field.field_stars_csv.exists():
        summ["blink_field_stars_comparison"] = CAL.compare_with_blink(cal, field.field_stars_csv)
    summ["gaia_list"] = gaia_list                    # "unavailable" = an outage, never "no stars" (see find())
    return exps, gt, cal, summ


GAIA_DOWN_FLAG = ("not checked against the star catalogue: the Gaia catalogue could not be reached in this run, so this "
                  "position change cannot be told from a known star or from two known stars seen as one")

# where the Gaia DR3 list is asked for, in this order: (name, TAP sync URL or None = blink.GAIA_TAP, table).
# Both hold the same DR3 source table with the same column names; the second is asked only when the
# first fails (IRSA answered "502 Proxy Error" on 14 Nov 21:00 while the ESA archive answered in 2 s:
# without a Gaia list a known fast star has no catalogue label and shows up as a candidate).
GAIA_SERVICES = (("NASA/IPAC IRSA TAP", None, "gaia_dr3_source"),
                 ("ESA Gaia Archive TAP", "https://gea.esac.esa.int/tap-server/tap/sync", "gaiadr3.gaia_source"))


def fetch_gaia(field, log=print, retry_s=None, timeout=60, cache=True):
    """Gaia DR3 field stars for a field without a cached list: the same single TAP query as
    blink.gaia_field (0.15 deg, G < 19), cached as <out>/gaia_field.json. None on failure.
    Asked at IRSA first and, if that fails, at the ESA Gaia Archive (GAIA_SERVICES); `timeout`
    is per try (a list of a few thousand stars arrives in 2 to 5 s; a hung service costs one
    timeout before the next one is asked), `retry_s` how long the pair is retried after both failed.
    An answer without a single star counts as a failure (0.07 square degrees of sky to G = 19 are never
    empty) and nothing is written then; the reason is kept in field.gaia_error. cache=False: the list
    on disk is neither read nor written."""
    import csv as _csv
    import urllib.parse
    import urllib.request
    from datetime import datetime, timezone
    dest = field.out_dir / "gaia_field.json" if (cache and field.out_dir is not None) else None
    if dest is not None and dest.exists():
        field.gaia_json = dest
        return json.loads(dest.read_text())
    cols = ["source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag", "ruwe"]

    def ask(url, table):
        q = (f"SELECT {', '.join(cols)} "
             f"FROM {table} WHERE CONTAINS(POINT('ICRS', ra, dec), "
             f"CIRCLE('ICRS', {field.ra:.6f}, {field.dec:.6f}, {Dt.BL.GAIA_RADIUS_DEG}))=1 AND phot_g_mean_mag < {Dt.BL.GAIA_GMAX}")
        par = {"QUERY": q, "FORMAT": "csv"}
        if url:
            par.update(REQUEST="doQuery", LANG="ADQL")
        req = urllib.request.Request(url or Dt.BL.GAIA_TAP, data=urllib.parse.urlencode(par).encode(),
                                     headers={"User-Agent": "python-astro-client/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            lines = r.read(50_000_000).decode().splitlines()
        if not lines or [c.strip().lower() for c in lines[0].split(",")] != cols:
            raise ValueError("not the expected table: " + (lines[0][:80] if lines else "empty answer"))
        rows = list(_csv.DictReader(lines))
        if not rows:
            raise ValueError("an answer without stars")
        return q, rows

    def num(v, nd):
        try:
            x = float(v)
        except (TypeError, ValueError):
            return None
        return round(x, nd) if math.isfinite(x) else None
    try:
        wait, waited = 10, 0
        while True:                    # network trouble: retry with backoff for up to GAIA_RETRY_S
            errs, got = [], None
            for name, url, table in GAIA_SERVICES:
                try:
                    got = (name, table) + ask(url, table)
                    break
                except (OSError, ValueError) as ex:
                    errs.append(f"{name}: {ex}")
                    log(f"  Gaia DR3 query failed at {name} ({ex})")
            if got is not None:
                break
            if waited + wait > (GAIA_RETRY_S if retry_s is None else retry_s):
                raise IOError("; ".join(errs))
            log(f"  Gaia DR3: retrying in {wait} s")
            time.sleep(wait)
            waited += wait
            wait = min(2 * wait, 300)
        name, table, q, rows = got
        # the decimals of IRSA's CSV (ra/dec 7, pm 3, parallax 4, G 6, ruwe 3): any service gives the same numbers
        stars = [[int(r["source_id"]), num(r["ra"], 7), num(r["dec"], 7), num(r["pmra"], 3), num(r["pmdec"], 3),
                  num(r["parallax"], 4), num(r["phot_g_mean_mag"], 6), num(r["ruwe"], 3)] for r in rows]
        stars.sort(key=lambda q: q[0])           # a service returns its rows in no fixed order: the same list every time
    except Exception as ex:
        field.gaia_error = str(ex)[:400]
        log(f"  Gaia DR3 query failed ({ex}): self-registration, known stars are not labelled in this run")
        return None
    g = {"source": f"Gaia DR3 ({table} at {name})", "query": q, "ref_epoch": 2016.0,
         "columns": cols,
         "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "stars": stars}
    if dest is None:
        log(f"  {len(stars)} Gaia DR3 stars from {name} (not written)")
        return g
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_text(json.dumps(g, separators=(",", ":")))
    os.replace(tmp, dest)
    field.gaia_json = dest
    log(f"  cached {len(stars)} Gaia DR3 stars in {dest} ({name})")
    return g


def find(field, detectors=None, log=print, images=None, prepared=None, opts=None):
    """Run the detectors on a field. Returns (merged candidates, ctx)."""
    t0 = time.time()
    exps, gt, cal, summ = prepared or prepare(field, log=log)
    ctx = Ctx(field, exps, gt, cal, summ, images=images, log=log, opts=opts)
    allc = []
    for det in (detectors or DETECTORS):
        t1 = time.time()
        try:
            c = det.run(ctx)
        except Exception as ex:                       # one detector failing must not stop the rest
            import traceback
            traceback.print_exc()
            ctx.info.setdefault(det.NAME, {})["error"] = f"{type(ex).__name__}: {ex}"
            c = []
        ctx.shared.setdefault("records", {})[det.NAME] = c
        ctx.info.setdefault(det.NAME, {})["seconds"] = round(time.time() - t1, 1)
        ctx.info[det.NAME]["n_records"] = len(c)
        allc.extend(c)
    # records of detector P come complete (nature, confidence, confirmed: its own rule and null) and
    # describe one body at season positions hundreds of arcsec apart: they are not merged by position
    own = [c for c in allc if c.get("nature") and "P" in (c.get("detectors") or [])]
    merged = SC.merge([c for c in allc if not any(c is o for o in own)]) + own
    t1 = time.time()
    try:                                # one object, one record; single-exposure transients tested
        merged = vet.post(ctx, merged)
    except Exception as ex:
        import traceback
        traceback.print_exc()
        ctx.info["vetting"] = {"error": f"{type(ex).__name__}: {ex}"}
    try:
        ctx.sensitivity = sensitivity.card(ctx)
    except Exception as ex:
        ctx.sensitivity = {"error": f"{type(ex).__name__}: {ex}"}
    if not (ctx.opts or {}).get("no_sso"):
        sso.classify(ctx, merged)
    vet.after_sso(ctx, merged)
    no_gaia = ((summ or {}).get("gaia_list") or {}).get("status") in ("unavailable", "none")
    n_unchecked = 0
    if no_gaia:
        # The star catalogue was wanted and could not be had. Without it a position change cannot be told from a
        # known star, and two catalogued stars a few arcsec apart are ONE source of the deep stack, whose light
        # the position fit shares differently from season to season. (Job field-326.640n23.090-c6-b63-s0.4,
        # 14 Nov 2026, run during an outage of the catalogue service: two "moving objects" of 5.1 and 2.4
        # arcsec/yr, each a pair of Gaia stars of G 18 to 19.) In such a run nothing that moves is a candidate:
        # the record stays, as "not checked", and the verdict says that the field has to be run again.
        for c in merged:
            if c["kind"] == "motion" and c["class"] == "candidate" and "P" not in (c.get("detectors") or []):
                c["class"] = "artifact"
                c["flags"].insert(0, GAIA_DOWN_FLAG)
                c.setdefault("vetting", {})["reason"] = "catalogue"
                n_unchecked += 1
    nature.annotate(ctx, merged)       # nature, confidence, confirmed for every record
    merged = vet.renumber(merged)
    ctx.verdict = nature.verdict(ctx, merged, stage=(ctx.opts or {}).get("stage", "full"),
                                 centre=(ctx.opts or {}).get("centre") or (field.ra, field.dec), unchecked=n_unchecked)
    if no_gaia and isinstance(ctx.verdict, dict):
        ctx.verdict["gaia_unavailable"] = True
        ctx.verdict["n_unchecked_motions"] = n_unchecked
        if not n_unchecked:
            ctx.verdict["text"] = (str(ctx.verdict.get("text") or "").rstrip() + " The Gaia star catalogue could not be "
                                   "reached in this run: the stars of the field were not identified. Run it again "
                                   "for a checked answer.").strip()
    ctx.info.setdefault("vetting", {})["seconds"] = round(time.time() - t1, 1)
    ctx.info["_total_seconds"] = round(time.time() - t0, 1)
    return merged, ctx


def field_doc(ctx):
    f = ctx.field
    return {"name": f.name, "label": f.label, "ra": f.ra, "dec": f.dec, "n_exposures": len(ctx.exps),
            "searched_deg": round(ctx.grid.n * ctx.grid.pix / 3600, 4),       # side of the square that was searched
            "seasons": [{"season": s, **{k: round(v, 4) if isinstance(v, float) else v for k, v in i.items()}}
                        for s, i in ctx.season_info.items()],
            "detectors_present": sorted({e["detector"] for e in ctx.exps}),
            "registration": ctx.cal_summary}


def _sens(ctx):
    return getattr(ctx, "sensitivity", None)


def add_frame_xy(cands, meta):
    """Pixel position on the blink.py PNG frames (meta.json grid) for the viewer."""
    if not meta:
        return
    from astropy.wcs import WCS
    g = meta["grid"]
    n = g["size_px"][0]
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [meta["ra"], meta["dec"]]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-g["pixel_arcsec"] / 3600, g["pixel_arcsec"] / 3600]
    up, strip = g["upscale"], g["label_strip_px"]

    def xy(ra, dec):
        x, y = w.all_world2pix(ra, dec, 0)
        return [round(float(x) * up + up / 2, 1), round(strip + (n - 1 - float(y)) * up + up / 2, 1)]
    for c in cands:
        c["png_xy"] = xy(c["ra"], c["dec"])
        for p in c.get("positions") or []:
            p["png_xy"] = xy(p["ra"], p["dec"])


def write_candidates(ctx, cands, out_path, overwrite=False, meta=None, extra=None):
    add_frame_xy(cands, meta)
    info = {k: v for k, v in ctx.info.items() if not k.startswith("_")}
    ex = {"finder_version": VERSION, "total_seconds": ctx.info.get("_total_seconds"), "sensitivity": _sens(ctx),
          "verdict": getattr(ctx, "verdict", None)}
    if extra:
        ex.update(extra)
    return SC.write(out_path, field_doc(ctx), cands, info, extra=ex, overwrite=overwrite)


def for_job(job_id, cache=None, log=print, overwrite=False):
    """Local-engine hook: candidates.json next to a finished job's products."""
    field = Dt.job_field(job_id, cache=cache)
    meta = json.loads((field.out_dir / "meta.json").read_text())
    cands, ctx = find(field, log=log)
    out = field.out_dir / "candidates.json"
    doc = write_candidates(ctx, cands, out, overwrite=overwrite, meta=meta)
    log(f"candidates: {doc['summary']['text']} -> {out}")
    return doc


def job_step(ctx):
    """local/job_worker.py post-step (FULL result only, never the preview): candidates.json next
    to the job's blink products. ctx: the worker's post-step dict ("job_id", "out", "status").
    An existing candidates.json is kept (a re-run of the step writes nothing new)."""
    out = Path(ctx["out"])
    dest = out / "candidates.json"
    if dest.exists():
        doc = json.loads(dest.read_text())
        return {"file": "candidates.json", "kept_existing": True, "n_moving": doc["summary"]["n_moving"]}
    status = ctx.get("status")

    def log(m):
        print(m, flush=True)
        if status is not None and str(m).strip().startswith(("A:", "B:", "D:", "V:", "C:", "P:")):
            status.set(message=f"post-step: candidates ({str(m).strip()[:80]})")
    field = Dt.job_field(ctx["job_id"], cache=out.parents[1])
    cands, c = find(field, log=log)
    doc = write_candidates(c, cands, dest, meta=ctx.get("meta"))
    s = doc["summary"]
    return {"file": "candidates.json", "n_moving": s["n_moving"], "n_moving_candidates": s["n_moving_candidates"],
            "n_variable": s["n_variable"], "n_transients": s["n_transients"], "text": s["text"],
            "n_confirmed": s.get("n_confirmed"), "verdict": (doc.get("verdict") or {}).get("text")}


RAW_WCS_FLOOR = 0.10        # arcsec per season and axis, exposures used with their own WCS (no reference stars):
#                             the season x detector registration offsets of 10 fields scatter by 0.053" (median),
#                             0.102" in the worst (crowded) field; the worst case is used
QUICK_REG_MIN = 0.5         # fraction of exposures that must have a registration offset, else "raw WCS"
QUICK_HALF_PX = 14           # the quick box: 29 native pixels (0.05 deg), as the engine cuts it
QUICK_MAX_PX = 61            # cutouts larger than this (0.1 deg) are cut down to the quick box
QUICK_GAIA_TIMEOUT = 12      # seconds one try of the Gaia query may take in the quick stage (one try per service)
QUICK_GAIA_MARGIN = 20.0     # arcsec beyond the box corners: Gaia stars whose wings reach into the box
QUICK_EDGE_PX = 5.5          # px from the box edge inside which a stamp (3.5 px half width + motion) can be cut


def _crop(e, ra, dec, half_px):
    """Exposure e cut to (2 half_px + 1) native pixels around (ra, dec), in memory; None when
    less than 14 px of it are left on an axis."""
    px = e["_px"]
    x, y = (float(v) for v in px["wcs"].all_world2pix(ra, dec, 0))
    ny, nx = px["clean"].shape
    ix, iy = int(round(x)), int(round(y))
    x0, x1, y0, y1 = max(ix - half_px, 0), min(ix + half_px + 1, nx), max(iy - half_px, 0), min(iy + half_px + 1, ny)
    if x1 - x0 < 14 or y1 - y0 < 14:
        return None
    q, p = dict(e), dict(px)
    for k in ("clean", "var", "good", "satnan", "sat", "flags"):
        if k in px:
            p[k] = px[k][y0:y1, x0:x1]
    p["wcs"] = px["wcs"].slice((slice(y0, y1), slice(x0, x1)))
    if px.get("swcs") is not None:
        try:
            p["swcs"] = px["swcs"].slice((slice(y0, y1), slice(x0, x1)))
        except Exception:
            pass
    p["det_off"] = (px["det_off"][0] + x0, px["det_off"][1] + y0)
    er = px["epsf_rows"]
    p["epsf_rows"] = dict(er, x=er["x"] - x0, y=er["y"] - y0)
    q["_px"] = p
    q["shape"] = (y1 - y0, x1 - x0)
    q["x"], q["y"] = e["x"] - x0, e["y"] - y0
    return q


def quick_verdict(field, ra=None, dec=None, log=print, detectors=None, exps=None):
    """Fast answer for a small box (0.05-0.1 deg) of ALL exposures around a clicked point.
    field: a detect.data.Field whose data_dir holds the box cutouts (dr1/ qr3/, the layout of a
    job's inputs); field.ra / field.dec = the centre of the box. ra, dec: the clicked point
    (default: the centre). exps: exposures already read with data.load_exposures (optional).
    Nothing is downloaded here except the Gaia list (one try, no retries) when the field has
    none and has an out_dir to cache it in.
    Returns the candidates.json document as a dict (nothing is written): "candidates" (same
    records as the full run), "verdict" (stage "quick"; the sentence leads with a mover within
    20" of the clicked point), "sensitivity", "summary", "registration", "error_inflation",
    "psf" (exposures per PSF source: the engine's boxes carry no EPSF extension, their PSF is the
    table of the exposure's calibration id in the engine's cache, data.cached_epsf).

    Registration and error inflation: with >= 5 Gaia reference stars per season x detector
    cell the box is registered like a full field. With fewer, the exposures keep their own
    WCS, whose season x detector offsets scatter by RAW_WCS_FLOOR (measured); the per-season
    position floor is then RAW_WCS_FLOOR instead of the 0.005-0.016" of a registered field,
    i.e. bright sources lose a factor 6-20 in motion sensitivity (5 sigma at 0.5-0.7"/yr instead
    of 0.035-0.11"/yr for seasons over 1-1.4 yr), faint ones (photon-limited) lose nothing.
    Cells registered on few stars add their registration error to the floor. Cutouts larger
    than QUICK_MAX_PX are cut to the quick box in memory; only the Gaia stars of the box are
    measured; a record closer than QUICK_EDGE_PX to the box edge is flagged and not confirmed."""
    t0 = time.time()
    centre = (field.ra if ra is None else ra, field.dec if dec is None else dec)
    if exps is None:
        exps = Dt.load_exposures(field, log=log)
    # larger cutouts (the saved 0.2 deg folder of a challenge target) are cut down to the quick box
    # in memory: the quick stage answers for the clicked point, the full stage for the field
    if exps and max(max(e["shape"]) for e in exps) > QUICK_MAX_PX:
        exps = [q for q in (_crop(e, centre[0], centre[1], QUICK_HALF_PX) for e in exps) if q is not None]
        field.ra, field.dec = centre
        log(f"  quick box: {2 * QUICK_HALF_PX + 1} px around the point, {len(exps)} exposures")
    if not exps:
        # "no_data": nothing was measured (the caller may show its own rough answer instead of this sentence)
        return {"verdict": {"text": "No usable exposures in this box.", "stage": "quick", "n_confirmed": 0, "best": None,
                            "best_offset_arcsec": None, "limit": None, "no_data": True},
                "candidates": [], "summary": SC.summary([]), "sensitivity": None, "registration": "none",
                "error_inflation": None, "psf": {}, "finder_version": VERSION, "seconds": round(time.time() - t0, 1)}
    psf = {}
    for e in exps:                                       # "file" (EPSF extension), "calibration cache" or "stand-in"
        k = e.get("psf_source", "file")
        psf[k] = psf.get(k, 0) + 1
    if field.gaia_json is None:                          # a challenge target's folder: its saved Gaia list
        g = Dt.BL.ROOT / "site" / "data" / field.data_dir.name / "gaia_field.json"
        if field.data_dir.parent == Dt.BL.DATA and g.exists():
            field.gaia_json = g
    if getattr(field, "size_deg", None) is None:
        ny, nx = exps[0]["shape"]
        field.size_deg = min(Dt.STACK_DEG, max(ny, nx) * Dt.BL.PIX_NATIVE / 3600)
    half = 0.5 * max(max(e["shape"]) for e in exps) * Dt.BL.PIX_NATIVE          # arcsec
    prepared = prepare(field, log=log, exps=exps, gaia_retry_s=0, gaia_timeout=QUICK_GAIA_TIMEOUT,
                       gaia_radius=half * math.sqrt(2) + QUICK_GAIA_MARGIN)
    summ = prepared[3] or {}
    src = summ.get("source_of_offset") or {}
    n_reg = sum(v for k, v in src.items() if k != "none")
    raw = summ.get("mode") == "none" or n_reg < QUICK_REG_MIN * max(len(exps), 1)
    cerr = [math.hypot(c.get("err_east_arcsec") or 0, c.get("err_north_arcsec") or 0) / math.sqrt(2)
            for c in summ.get("cells") or [] if c.get("accepted")]
    reg_err = float(np.median(cerr)) if cerr else 0.0
    min_floor = RAW_WCS_FLOOR if raw else reg_err
    if raw:                                              # raw WCS: no offsets at all (a few cells are not a frame)
        prepared = (prepared[0], prepared[1], {e["file"]: (0.0, 0.0) for e in exps}, dict(summ, mode_used="raw WCS"))
    dets = detectors or [diffimg, gaia_astrom, deep_astrom]
    # a source whose 7 x 7 px stamp can leave the box in some exposure (any roll angle, plus its
    # motion) is measured on cut stamps: such a record is flagged and never confirmed here
    opts = {"no_sso": True, "stage": "quick", "centre": centre, "min_season_floor": min_floor,
            "quick_radius": max(half - QUICK_EDGE_PX * Dt.BL.PIX_NATIVE, 0.0)}
    cands, ctx = find(field, detectors=dets, log=log, prepared=prepared, opts=opts)
    floor = ctx.season_floor
    mode = "raw WCS (no reference stars)" if raw else f"{summ.get('mode', 'gaia')} reference sources"
    doc = {"schema": SC.SCHEMA, "field": field_doc(ctx), "summary": SC.summary(cands), "candidates": cands,
           "verdict": ctx.verdict, "sensitivity": _sens(ctx), "finder_version": VERSION, "registration": mode,
           "psf": psf,
           "error_inflation": {"season_floor_arcsec": None if floor is None else round(floor, 4),
                               "min_floor_applied_arcsec": round(min_floor, 4), "raw_wcs": bool(raw),
                               "exposures_registered": int(n_reg), "exposures": len(exps),
                               "note": ("no reference stars in the box: the positions carry the raw pointing scatter "
                                        f"of {RAW_WCS_FLOOR} arcsec per season" if raw else
                                        "registered on reference sources; their registration error is in the floor")},
           "seconds": round(time.time() - t0, 1)}
    return SC._clean(doc)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fazari candidate finder (moving and changing sources)")
    ap.add_argument("target", nargs="?", help="challenge target id (pipeline/targets.json)")
    ap.add_argument("--job", help="local-engine job id (cache/jobs/<id>)")
    ap.add_argument("--dir", help="folder with dr1/ qr3/ cutouts (with --ra --dec)")
    ap.add_argument("--ra", type=float)
    ap.add_argument("--dec", type=float)
    ap.add_argument("--name", default="field")
    ap.add_argument("--gaia", help="gaia_field.json for --dir")
    ap.add_argument("--out", help="output folder (default: FAZARI_OUT/<target> or the job folder)")
    ap.add_argument("--detectors", default="", help="comma list of detector names, e.g. A,B")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--no-sso", action="store_true", help="skip SkyBoT queries")
    a = ap.parse_args(argv)
    dets = [d for d in DETECTORS if not a.detectors or d.NAME in a.detectors.split(",")]
    opts = {"no_sso": a.no_sso}
    meta = None
    if a.job:
        field = Dt.job_field(a.job, out_dir=a.out)
        mp = Dt.BL.ROOT / "cache" / "jobs" / a.job / "meta.json"
        meta = json.loads(mp.read_text()) if mp.exists() else None
    elif a.dir:
        field = Dt.Field(a.name, a.dir, a.ra, a.dec, out_dir=a.out, gaia_json=a.gaia)
    else:
        out = a.out or (os.environ.get("FAZARI_OUT") and str(Path(os.environ["FAZARI_OUT"]) / a.target))
        if not out:
            sys.exit("give --out or FAZARI_OUT (the repo's site/data is not written by default)")
        field = Dt.challenge_field(a.target)
        field.out_dir = Path(out)
        fs = Path(out) / "field_stars.csv"
        if fs.exists():
            field.field_stars_csv = fs
        mp = Dt.BL.ROOT / "site" / "data" / a.target / "meta.json"
        meta = json.loads(mp.read_text()) if mp.exists() else None
    if field.out_dir is None:
        sys.exit("no output folder (--out)")
    cands, ctx = find(field, detectors=dets, opts=opts)
    doc = write_candidates(ctx, cands, field.out_dir / "candidates.json", overwrite=a.overwrite, meta=meta)
    print(doc["summary"]["text"])
    for c in cands:
        m = c.get("motion") or {}
        print(f"  {c['id']} {c['class']:14s} {c['kind']:12s} {'+'.join(c['detectors']):6s} "
              f"RA {c['ra']:.5f} Dec {c['dec']:+.5f}  "
              + (f"{m['speed_arcsec_yr']:.3f}+-{m['err_speed_arcsec_yr']:.3f}\"/yr PA {m['pa_deg']:.0f}  sig {m['significance_sigma']}"
                 if m else "") + f"  snr {c.get('snr')}  {'; '.join(c['flags'][:3])}")
    print(f"total {ctx.info.get('_total_seconds')} s")


if __name__ == "__main__":
    main()
