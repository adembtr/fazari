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
from . import diffimg, gaia_astrom, deep_astrom, variab, fast, sso, sensitivity

# order: A first (its motion records are used by V to skip moving saturated stars), B before D
# (D reuses B's systematic floor)
DETECTORS = [diffimg, gaia_astrom, deep_astrom, variab, fast]
VERSION = "1.0"
GAIA_RETRY_S = float(os.environ.get("FAZARI_GAIA_RETRY_S", 1800))   # keep retrying the Gaia query this long


class Ctx:
    """Everything a detector may use. Detectors add their own notes to ctx.info[NAME]."""

    def __init__(self, field, exps, gaia, cal, cal_summary, images=None, log=print, opts=None):
        self.field, self.exps, self.gaia = field, exps, gaia
        self.cal, self.cal_summary = cal, cal_summary
        self.seasons = Dt.seasons(exps)
        self.season_info = Dt.season_info(exps)
        self.grid = Dt.Grid(field.ra, field.dec)
        self.stacker = Dt.Stacker(exps, self.grid, cal)
        self.images = images
        self.log = log
        self.opts = opts or {}
        self.info, self.shared = {}, {}
        self.season_floor = None


def prepare(field, log=print, exps=None, gaia=True):
    """Read the exposures and register them. Returns (exps, gaia table, cal, cal summary)."""
    t0 = time.time()
    if exps is None:
        exps = Dt.load_exposures(field, log=log)
    log(f"{field.label}: {len(exps)} exposures, seasons {Dt.seasons(exps)} ({time.time() - t0:.1f} s)")
    gt = None
    g = field.gaia() if gaia else None
    if gaia and g is None and field.out_dir is not None:
        g = fetch_gaia(field, log)
    if g:
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
    return exps, gt, cal, summ


def fetch_gaia(field, log=print):
    """Gaia DR3 field stars for a field without a cached list: the same single IRSA TAP query as
    blink.gaia_field (0.15 deg, G < 19), cached as <out>/gaia_field.json. None on failure."""
    import csv as _csv
    import urllib.parse
    import urllib.request
    from datetime import datetime, timezone
    dest = field.out_dir / "gaia_field.json"
    if dest.exists():
        field.gaia_json = dest
        return json.loads(dest.read_text())
    q = ("SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, ruwe "
         "FROM gaia_dr3_source WHERE CONTAINS(POINT('ICRS', ra, dec), "
         f"CIRCLE('ICRS', {field.ra:.6f}, {field.dec:.6f}, {Dt.BL.GAIA_RADIUS_DEG}))=1 AND phot_g_mean_mag < {Dt.BL.GAIA_GMAX}")
    try:
        data = urllib.parse.urlencode({"QUERY": q, "FORMAT": "csv"}).encode()
        req = urllib.request.Request(Dt.BL.GAIA_TAP, data=data, headers={"User-Agent": "fazari-spaceapps/1.0"})
        wait, waited = 10, 0
        while True:                    # network trouble: retry with backoff for up to GAIA_RETRY_S
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    rows = list(_csv.DictReader(r.read(50_000_000).decode().splitlines()))
                break
            except (OSError, ValueError) as ex:
                if waited + wait > GAIA_RETRY_S:
                    raise
                log(f"  Gaia DR3 query failed ({ex}); retrying in {wait} s")
                time.sleep(wait)
                waited += wait
                wait = min(2 * wait, 300)

        def num(v):
            return round(float(v), 7) if v not in ("", None) else None
        stars = [[int(r["source_id"]), num(r["ra"]), num(r["dec"]), num(r["pmra"]), num(r["pmdec"]),
                  num(r["parallax"]), num(r["phot_g_mean_mag"]), num(r["ruwe"])] for r in rows]
    except Exception as ex:
        log(f"  Gaia DR3 query failed ({ex}): self-registration")
        return None
    g = {"source": "Gaia DR3 (gaia_dr3_source at NASA/IPAC IRSA TAP)", "query": q, "ref_epoch": 2016.0,
         "columns": ["source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag", "ruwe"],
         "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "stars": stars}
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(g, separators=(",", ":")))
    field.gaia_json = dest
    log(f"  cached {len(stars)} Gaia DR3 stars in {dest}")
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
    merged = SC.merge(allc)
    try:
        ctx.sensitivity = sensitivity.card(ctx)
    except Exception as ex:
        ctx.sensitivity = {"error": f"{type(ex).__name__}: {ex}"}
    if not (ctx.opts or {}).get("no_sso"):
        sso.classify(ctx, merged)
    ctx.info["_total_seconds"] = round(time.time() - t0, 1)
    return merged, ctx


def field_doc(ctx):
    f = ctx.field
    return {"name": f.name, "label": f.label, "ra": f.ra, "dec": f.dec, "n_exposures": len(ctx.exps),
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
    ex = {"finder_version": VERSION, "total_seconds": ctx.info.get("_total_seconds"), "sensitivity": _sens(ctx)}
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
        if status is not None and str(m).strip().startswith(("A:", "B:", "D:", "V:", "C:")):
            status.set(message=f"post-step: candidates ({str(m).strip()[:80]})")
    field = Dt.job_field(ctx["job_id"], cache=out.parents[1])
    cands, c = find(field, log=log)
    doc = write_candidates(c, cands, dest, meta=ctx.get("meta"))
    s = doc["summary"]
    return {"file": "candidates.json", "n_moving": s["n_moving"], "n_moving_candidates": s["n_moving_candidates"],
            "n_variable": s["n_variable"], "n_transients": s["n_transients"], "text": s["text"]}


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
