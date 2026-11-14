#!/usr/bin/env python3
"""One local Fazari job: find SPHEREx images of a sky point, get the cutouts, run blink.py.

Started by local/serve.py in its own process group (so a cancel can stop everything):
  uv run --no-project --with astropy --with reproject --with numpy --with scipy \
      --with matplotlib --with pillow python -I local/job_worker.py --job <job dir>

<job dir>/request.json (written by the server) holds the validated request and the resolved
target. Progress goes to <job dir>/status.json (atomic replace), the log to stdout.

Steps
  finding      image list: local IRSA lists for the 5 challenge targets, else the static sky
               index (pipeline/sky_index.py), else IRSA SIA
  downloading  local cutouts are linked; other images are read from the public SPHEREx S3
               bucket with HTTP Range (pipeline/fetch_region.py, <= 4 requests in flight,
               byte cache in cache/s3). The EPSF extension, which blink.py needs and the
               range reader does not copy, is the same for every file of a detector (one
               '[CALIB] epsf <id>' per detector); it is cached in cache/local/epsf/.
  processing   pipeline/blink.py on the ad-hoc target -> cache/jobs/<id>/
  post-steps   POST_STEPS (below): later steps of the full result that read the blink products,
               run in order after blink.py (spectrum, candidates, faint). The server starts
               full jobs with --no-post (the job is "done" and viewable right after the blink)
               and then runs them with --post-only in its own lane; also when a step is new or
               its code changed

Quick looks ("mode": "preview") are not done here but in local/preview.py (the server's fast
lane). While a preview is queued or running the server keeps the flag file
$FAZARI_PREVIEW_FLAG; this worker then starts no new image download (yield_to_preview), so
the preview gets the network first. cache/ is $FAZARI_CACHE when that is set.
"""
import argparse
import csv
import json
import math
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent                 # fazari/
PIPE = ROOT / "pipeline"
CACHE = Path(os.environ.get("FAZARI_CACHE") or ROOT / "cache").expanduser().resolve()
LOCAL = CACHE / "local"
sys.path.insert(0, str(PIPE))

# Single-detector wavelength bins of blink.py (centre um -> detector); kept in sync at run time
BINS = {1.0: 1, 1.5: 2, 2.0: 3, 3.0: 4, 4.0: 5, 4.6: 6}
BIN_TOL = 0.06                    # blink.py tolerance (+-6 %)
SELECT_TOL = 0.055                # a bit tighter: the index wavelength is an approximation
EPOCH_GAP_DAYS = 30               # season separator, as in blink.py
CUTOUT_DEG = 0.2                  # cutout size when request.json has no "cutout_deg" (older jobs); the
                                  # server sets it (local/serve.py FULL_CUTOUT_DEG, 0.4 for full results)
IMAGE_WORKERS = 6                 # images in parallel (S3 test: no 429/5xx up to 128 requests in flight)
S3_HTTP_SLOTS = int(os.environ.get("FAZARI_S3_SLOTS") or 12)               # requests in flight for the S3 downloads (fetch_region's polite 4 stays for IRSA)
PRIORITY_DETECTORS = (3, 6)       # 2.0 and 4.6 um first: the blink fills those bins early
PREVIEW_WAIT_MAX = 90             # s: never wait longer than this for previews (a stuck flag)
# Progressive full result (captain, 14 Nov 22:00; contract: ajan_durumu/motor_hizi.md "PROGRESSIVE CONTRACT").
# One wavelength bin at a time: best bin (most seasons, tie 2.0 um), then 4.6 um (cold objects), then
# BIN_ORDER; FIRST_CAP exposures per season and bin first, the rest of today's selection last ("refine").
# After each bin a blink.py run on everything loaded so far is published as a stage.
BIN_ORDER = [2.0, 3.0, 4.0, 1.5, 1.0, 4.6]   # tie-break and the order after best + 4.6 (table in motor_hizi.md:
                                             # 3.0 / 4.0 gave the smallest single-bin errors, 1.0 um the worst)
FIRST_CAP = 3
SPARSE_LAYERS = ("ZODI", "VARIANCE")   # fetch_region sparse models (2.2x fewer bytes); () = read in full
MAX_TRIES = 3                     # attempts per exposure (each with fetch_region's own HTTP retries)
SMALLER_DEG = 0.2                 # last attempt after time-outs: a smaller cutout (said in the status)
OUTAGE_MAX_S = 600                # network down: keep retrying this long, then go on with what is there
OUTAGE_AFTER = 4                  # this many failures in a row (no success between) = network down
GAIA_STAGE_WAIT = 3               # s a stage waits for the Gaia field; then it is measured without it ("catalogue": "pending")
GAIA_FINAL_WAIT = 30              # s the final run waits at most for the Gaia race, then goes on without it (status says why)
SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
USER_AGENT = "fazari-spaceapps/1.0"
CSV_COLS = ["s_ra", "s_dec", "energy_bandpassname", "obs_id", "em_min", "em_max", "access_url",
            "t_min", "t_max", "obs_collection", "approx_lam_um", "cloud_access"]


class Status:
    """status.json writer (the server reads it while the job runs)."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.d = {"state": "finding", "progress": {"done": 0, "total": 0, "bytes": 0}, "message": "",
                  "timings": {}, "started": time.time()}
        self._t = {}

    def set(self, **kw):
        with self.lock:
            prog = kw.pop("progress", None)
            if prog:
                self.d["progress"].update(prog)
            self.d.update(kw)
            self.d["updated"] = time.time()
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.d, indent=1))
            os.replace(tmp, self.path)

    def stage(self, name, message=""):
        now = time.time()
        if self._t:
            prev, t0 = self._t["name"], self._t["t0"]
            self.d["timings"][prev] = round(now - t0, 2)
        self._t = {"name": name, "t0": now}
        print(f"[{time.strftime('%H:%M:%S')}] {name}: {message}", flush=True)
        self.set(state=name, message=message)

    def add(self, done=0, nbytes=0, message=None):
        with self.lock:
            self.d["progress"]["done"] += done
            self.d["progress"]["bytes"] += nbytes
        if message is not None:
            self.set(message=message)
        else:
            self.set()


# ---------------------------------------------------------------------------------------- priority
def yield_to_preview(status=None):
    """Wait while a preview is queued or running (flag file kept by local/serve.py), at most
    PREVIEW_WAIT_MAX s in all per call; a flag older than 2 minutes is ignored (stale)."""
    flag = os.environ.get("FAZARI_PREVIEW_FLAG")
    if not flag:
        return 0.0
    p, t0, said = Path(flag), time.time(), False
    while time.time() - t0 < PREVIEW_WAIT_MAX:
        try:
            if time.time() - p.stat().st_mtime > 120:
                break
        except OSError:                                  # no flag: no preview waiting
            break
        if status is not None and not said:
            status.set(message="paused: a quick preview goes first")
            said = True
        time.sleep(0.2)
    return time.time() - t0


# ---------------------------------------------------------------------------------------- find
def local_rows(data_dir, target):
    """Rows of the local IRSA SIA lists of a challenge target (only files that are on disk)."""
    rows = []
    for coll in ("dr1", "qr3"):
        p = data_dir / target / f"liste_{coll}.csv"
        if not p.exists():
            continue
        with open(p, newline="") as fh:
            for r in csv.DictReader(fh):
                fn = r.get("access_url", "").rsplit("/", 1)[-1]
                if fn.endswith(".fits") and (data_dir / target / coll / fn).exists():
                    rows.append({"collection": coll, "file": fn})
    return rows


def index_rows(ra, dec):
    import sky_index
    out = []
    for r in sky_index.find_images(ra, dec):
        out.append({"obs_id": r["obs_id"], "collection": r["collection"], "detector": int(r["detector"]),
                    "mjd": float(r["mjd"]), "mjd_end": float(r.get("mjd_end", r["mjd"])), "s3_key": r["s3_key"],
                    "lam_um": r.get("approx_lam_um"), "lam_min_um": r.get("lam_min_um"),
                    "lam_max_um": r.get("lam_max_um")})
    return out


def sia_rows(ra, dec):
    """Fallback when the sky index is missing: IRSA SIA (polite, retried by fetch_region.http_get)."""
    import fetch_region
    out = []
    for coll in ("dr1", "qr3"):
        for r in fetch_region.sia_query(ra, dec, coll, cache_dir=CACHE / "s3"):
            band = r.get("band", "")
            det = int(band[-1]) if band[-1:].isdigit() else 0
            out.append({"obs_id": r["obs_id"], "collection": coll, "detector": det, "mjd": r["t_min"],
                        "mjd_end": r["t_min"], "s3_key": r["key"], "lam_um": None})
    return out


def seasons(mjds):
    order = sorted(set(mjds))
    lab, cur, k = {}, None, -1
    for m in order:
        if cur is None or m - cur > EPOCH_GAP_DAYS:
            k += 1
        lab[m] = k
        cur = m
    return lab


def select(rows, bins, cap):
    """Per season and single-detector wavelength bin, the `cap` exposures closest to the bin centre.

    Only bins that reach >= 2 seasons are kept (blink.py needs two epochs to blink)."""
    best = {}
    for r in rows:                                    # one row per exposure and detector, DR1 first
        k = (r["obs_id"], r["detector"])
        if k not in best or (best[k]["collection"] != "dr1" and r["collection"] == "dr1"):
            best[k] = r
    rows = sorted(best.values(), key=lambda r: r["mjd"])
    lab = seasons([r["mjd"] for r in rows])
    chosen, summary = [], []
    for c in bins:
        det = BINS[c]
        per = {}
        for r in rows:
            if r["detector"] != det:
                continue
            lam = r.get("lam_um")
            if lam is not None and abs(lam / c - 1) > SELECT_TOL:
                continue
            per.setdefault(lab[r["mjd"]], []).append(r)
        if len(per) < 2:
            summary.append({"bin_um": c, "seasons": len(per), "used": 0})
            continue
        n = 0
        for s, rs in sorted(per.items()):
            rs.sort(key=lambda r: (abs((r.get("lam_um") or c) / c - 1), r["mjd"]))
            for r in rs[:cap]:
                chosen.append(dict(r, bin_um=c, season=s))
                n += 1
        summary.append({"bin_um": c, "seasons": len(per), "used": n})
    return chosen, summary


# ---------------------------------------------------------------------------------------- EPSF
_EPSF_LOCK = threading.Lock()


def epsf_id(header):
    for card in header.get("HISTORY", []):
        s = str(card)
        if "[CALIB] epsf" in s:
            return s.split()[-1]
    return None


def epsf_hdu(img_header, s3_key, layout, local_data, stats):
    """EPSF BinTableHDU for an image: from cache/local/epsf/<calib id>.fits, seeded from a local
    IRSA cutout of the same detector, else read once from S3 (~3.9 MB)."""
    from astropy.io import fits
    import fetch_region as fr
    cid = epsf_id(img_header)
    path = LOCAL / "epsf" / (f"{cid}.fits" if cid else f"nocalib_{Path(s3_key).stem}.fits")
    with _EPSF_LOCK:
        if not path.exists() and cid and local_data and local_data.is_dir():
            det = int(img_header["DETECTOR"])
            for p in sorted(local_data.glob(f"*/*/*D{det}_spx_*.fits"))[:40]:
                try:
                    with fits.open(p, memmap=False) as h:
                        if epsf_id(h["IMAGE"].header) == cid and "EPSF" in h:
                            path.parent.mkdir(parents=True, exist_ok=True)
                            fits.HDUList([fits.PrimaryHDU(), h["EPSF"].copy()]).writeto(
                                path.with_suffix(".part"), overwrite=True)
                            os.replace(path.with_suffix(".part"), path)
                            break
                except Exception:
                    continue
        if not path.exists():
            f = fr.S3File(s3_key, CACHE / "s3", stats)
            z = layout["ZODI"]
            off = z["data_off"] + fr.pad2880(z["datasize"])
            info = fr.read_header(f, off, 2 * fr.BLOCK, 5)
            if info.name != "EPSF":
                raise IOError(f"HDU 5 of {s3_key} is {info.name}, not EPSF")
            raw = f.read(info.hdr_off, info.data_off + fr.pad2880(info.datasize))
            hdu = fits.BinTableHDU.fromstring(raw)
            path.parent.mkdir(parents=True, exist_ok=True)
            fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(path.with_suffix(".part"), overwrite=True)
            os.replace(path.with_suffix(".part"), path)
    with fits.open(path, memmap=False) as h:
        return h["EPSF"].copy()


def fetch_cutout(row, ra, dec, store, local_data, status=None, size=CUTOUT_DEG):
    """Cutout FITS (IRSA layout: IMAGE FLAGS VARIANCE ZODI EPSF WCS-WAVE) of one S3 image, `size` deg."""
    import fetch_region as fr
    from astropy.io import fits
    name = Path(row["s3_key"]).name
    out = store / row["collection"] / name
    if out.exists():
        return out, 0, "cached"
    yield_to_preview(status)
    st = fr.Stats()
    r = fr.read_region(row["s3_key"], ra, dec, size_deg=size, layers=fr.LAYERS_ALL,
                       cache_dir=CACHE / "s3", stats=st, sparse=SPARSE_LAYERS)
    if not r["ok"]:
        return None, st.bytes_net, r.get("reason", "no overlap")
    ep = epsf_hdu(r["headers"]["IMAGE"], row["s3_key"], r["layout"], local_data, st)
    part = out.with_name(out.name + ".part")
    fr.write_cutout(r, part, ra, dec, size)
    with fits.open(part, mode="append") as h:
        h.append(ep)
    os.replace(part, out)
    return out, st.bytes_net, r.get("reason", "")


def irsa_row(r):
    det = r["detector"]
    key = r["s3_key"]
    lam = r.get("lam_um")
    cloud = json.dumps({"aws": {"bucket_name": "nasa-irsa-spherex", "key": key, "region": "us-east-1"}})
    return {"s_ra": "", "s_dec": "", "energy_bandpassname": f"SPHEREx-D{det}", "obs_id": r["obs_id"],
            "em_min": f"{r['lam_min_um'] * 1e-6:.5e}" if r.get("lam_min_um") else "",
            "em_max": f"{r['lam_max_um'] * 1e-6:.5e}" if r.get("lam_max_um") else "",
            "access_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/" + key,
            "t_min": f"{r['mjd']:.6f}", "t_max": f"{r.get('mjd_end', r['mjd']):.6f}",
            "obs_collection": "spherex_" + r["collection"], "approx_lam_um": lam if lam is not None else "",
            "cloud_access": cloud}


def link(src, dst):
    """Symlink dst -> src. Only this job's own links are ever replaced (atomically); real files stay."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_symlink():
        if dst.resolve() == Path(src).resolve():
            return
    elif dst.exists():
        return
    tmp = dst.with_name(f"{dst.name}.{os.getpid()}.lnk")
    os.symlink(src, tmp)
    os.replace(tmp, dst)


# ---------------------------------------------------------------------------------------- blink
def run_blink(job_id, target, inputs, out_root, status, n_in):
    """pipeline/blink.py main() in this process, with the ad-hoc target and progress hooks."""
    tj = Path(status.path).parent / "targets.json"
    tj.write_text(json.dumps({job_id: target}, indent=1))
    os.environ["FAZARI_DATA"] = str(inputs)
    os.environ["FAZARI_OUT"] = str(out_root)
    os.environ["FAZARI_TARGETS"] = str(tj)
    import blink
    src = Path(blink.__file__).read_text()
    if "FAZARI_TARGETS" not in src:                    # hook not in blink.py yet: patch it here
        def load_target(name):
            t = dict(json.loads(tj.read_text())[name])
            t.setdefault("plx", 0.0)
            return t
        blink.load_target = load_target
    # Gaia field stars: a challenge target run under a job id reuses the committed
    # site/data/<target>/gaia_field.json; anything else is fetched by blink.py and cached next to
    # the job products (blink.py does that for ad-hoc ids). ROOT is pointed away from the repo
    # during the call so that an older blink.py can never write into site/.
    orig_gaia = blink.gaia_field
    gkey = target.get("gaia_cache_key")

    def gaia_field(name, ra, dec):
        site = ROOT / "site" / "data" / (gkey or name) / "gaia_field.json"
        radius = getattr(blink, "gaia_cache_radius", lambda p: 0.15)
        if site.exists() and radius(site) >= getattr(blink, "GAIA_RADIUS_DEG", 0.15) - 1e-9:   # wide cutouts: refetch
            return json.loads(site.read_text())
        real_root = blink.ROOT
        blink.ROOT = LOCAL / "gaia"
        try:
            return orig_gaia(name, ra, dec)
        finally:
            blink.ROOT = real_root
    blink.gaia_field = gaia_field
    orig_read = blink.read_exposure
    seen = [0]

    def read_exposure(path, t):
        try:
            return orig_read(path, t)
        finally:
            seen[0] += 1
            if seen[0] >= n_in:
                status.set(progress={"done": seen[0], "total": n_in},
                           message="measuring: " + ("motion against Gaia field stars" if target.get("kind", "motion")
                                                    == "motion" else "brightness against comparison stars"))
            elif seen[0] % 4 == 0:
                status.set(progress={"done": seen[0], "total": n_in},
                           message=f"reading and aligning exposure {seen[0]} of {n_in}")
    blink.read_exposure = read_exposure
    blink.main(job_id)


# ---------------------------------------------------------------------------------------- post-steps
# Extension point for later steps of the FULL result (never the preview): each entry is
# ("name", "module", "function") with module importable from pipeline/ (or local/);
# module.function(ctx) runs after blink.py wrote <out>/meta.json, in this order.
# ctx = {"job_id", "req", "target", "out": products folder (Path), "inputs": cutouts folder
# (Path, <inputs>/<id>/{dr1,qr3}), "meta": parsed meta.json, "status": Status}. A step may add
# files to ctx["out"] and return a small JSON-able dict, stored as status.post[name]; its
# exceptions are logged and reported there, they do not fail the job.
# Keep the entries as string constants: local/serve.py reads this list (without importing this
# file) and fingerprints each step's module and the local modules it imports, so a cached job
# reruns only the steps that are new or whose code changed (--post-only), not download + blink.
POST_STEPS = []
# spectrum of the target from every exposure of the job -> spectrum.csv, spectrum.json (pipeline/spectrum.py)
POST_STEPS.append(("spectrum", "spectrum", "job_step"))
# flag layer of the blink frames (saturated / masked / other FLAGS, a few kB) -> flags/ (pipeline/flags.py)
POST_STEPS.append(("flags", "flags", "post_step"))
# moving / changing sources in the whole field -> candidates.json (pipeline/detect, pipeline/DETECTION.md)
POST_STEPS.append(("candidates", "detect.run", "job_step"))
# faint-object mode: float frames, deep stacks, shift-and-stack -> faint/ (pipeline/faint.py, pipeline/FAINT.md)
POST_STEPS.append(("faint", "faint", "post_step"))
# last: a verified result is appended to <cache>/finds.jsonl, the lasting "Finds" list (pipeline/finds.py)
POST_STEPS.append(("finds", "finds", "post_step"))


def _step_function(entry):
    """The callable of a POST_STEPS entry: ("name", "module", "function") or ("name", callable)."""
    if callable(entry[1]):
        return entry[1]
    import importlib
    return getattr(importlib.import_module(entry[1]), entry[2])


def run_post_steps(ctx, only=None, quiet=False, on_step=None):
    """Run the POST_STEPS (or only the named ones, in list order). quiet: a finished job whose steps
    are rerun; its status message is left alone (the step name goes to status.post_step).
    on_step(results so far) after each step (the viewer shows each output as soon as it exists)."""
    results = {}
    for entry in POST_STEPS:
        name = entry[0]
        if only is not None and name not in only:
            continue
        ctx["status"].set(**({"post_step": name} if quiet else {"message": f"post-step: {name}"}))
        t0 = time.time()
        try:
            r = _step_function(entry)(ctx)
            results[name] = {"ok": True, "seconds": round(time.time() - t0, 2), **(r if isinstance(r, dict) else {})}
        except Exception as e:
            traceback.print_exc()
            results[name] = {"ok": False, "error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 2)}
        if on_step:
            on_step(dict(results))
    return results


def run_post_only(jd, req, names):
    """Run some post-steps of a finished job from its kept blink products and cutouts: right after
    the blink (the server starts full jobs with --no-post, so the blink is viewable first) or when a
    step is new or its code changed. The job stays "done" (viewable); status.post is merged after
    each step, the message restored."""
    job_id = req["id"]
    status = Status(jd / "status.json")
    old = json.loads((jd / "status.json").read_text())
    status.d = dict(old)
    status.d.setdefault("progress", {"done": 0, "total": 0, "bytes": 0})
    out = CACHE / "jobs" / job_id
    m = json.loads((out / "meta.json").read_text())
    print(f"[{time.strftime('%H:%M:%S')}] post-steps only: {', '.join(names)}", flush=True)
    status.set(post_running=names)
    t0 = time.time()
    base = dict(old.get("post") or {})
    post = run_post_steps({"job_id": job_id, "req": req, "target": req["target"], "out": out,
                           "inputs": LOCAL / "inputs" / job_id, "meta": m, "status": status},
                          only=names, quiet=True, on_step=lambda r: status.set(post=dict(base, **r)))
    with status.lock:
        status.d.pop("post_running", None)
        status.d.pop("post_step", None)
    status.set(post=dict(old.get("post") or {}, **post), message=old.get("message", ""),
               state=old.get("state", "done"), post_rerun={"steps": names, "seconds": round(time.time() - t0, 1),
                                                           "finished": time.time()})
    print(f"[{time.strftime('%H:%M:%S')}] post-steps done in {time.time() - t0:.1f} s: "
          + ", ".join(f"{k} {'ok' if v.get('ok') else 'failed'}" for k, v in post.items()), flush=True)


# ---------------------------------------------------------------------------------------- progressive
def bin_order(seasons_per_bin, priority=None):
    """Bins with >= 2 seasons: best (most seasons, tie in BIN_ORDER, 2.0 first), then 4.6, then BIN_ORDER."""
    avail = [b for b in BIN_ORDER if seasons_per_bin.get(b, 0) >= 2]
    if not avail:
        return []
    best = max(avail, key=lambda b: (seasons_per_bin[b], -BIN_ORDER.index(b)))
    order = [best] + ([4.6] if best != 4.6 and 4.6 in avail else [])
    order += [b for b in avail if b not in order]
    if priority in order:
        order.remove(priority)
        order.insert(0, priority)
    return order


MAX_STAR_SPEED = 12.0             # "/yr; the fastest known star (Barnard's) moves 10.4"/yr
MAX_NOT_MOVING_ERR = 1.0          # "/yr; a larger error bar cannot support "not moving"


def answer_guard(ms, s, dt, claims_motion):
    """Why a measured shift must not be stated (None = it can be); contract v1.2. degenerate: every season
    position has a zero error bar (the fit never left its start); implausible_speed: faster than any known
    star (a different source in each season); inconsistent: >= 3 seasons and one is > max(4 err, 1.5")
    off the straight-line motion. The measured numbers are kept as they are."""
    pos = [q for q in ms.get("positions") or [] if q.get("mjd") is not None]
    if pos and all(not (q.get("err_east_arcsec") or q.get("err_north_arcsec")) for q in pos):
        return "degenerate"
    if claims_motion and dt and s / dt > MAX_STAR_SPEED:
        return "implausible_speed"
    if claims_motion and len(pos) >= 3:
        import numpy as np
        t = np.array([q["mjd"] for q in pos], float)
        c = math.cos(math.radians(pos[0]["dec"]))
        E = np.array([(q["ra"] - pos[0]["ra"]) * c * 3600 for q in pos])
        N = np.array([(q["dec"] - pos[0]["dec"]) * 3600 for q in pos])
        A = np.vstack([np.ones_like(t), t - t.mean()]).T
        rE = E - A @ np.linalg.lstsq(A, E, rcond=None)[0]
        rN = N - A @ np.linalg.lstsq(A, N, rcond=None)[0]
        for k, q in enumerate(pos):
            err = math.hypot(q.get("err_east_arcsec") or 0, q.get("err_north_arcsec") or 0)
            if math.hypot(rE[k], rN[k]) > max(4 * err, 1.5):
                return "inconsistent"
    return None


ANSWER_TEXT = {      # (en, tr) templates; {sp} = speed per year with its error, {b} = the bins used
    "moving": ("Moves about {sp}″ per year (from {b} µm): a moving-object candidate, not confirmed.",
               "Yılda yaklaşık {sp}″ kayıyor ({b} µm): hareket eden bir aday, doğrulanmadı."),
    "moving_as_predicted": ("Moves {sp}″ per year (from {b} µm), as the catalogue predicts.",
                            "Yılda {sp}″ kayıyor ({b} µm); katalog tahminiyle aynı."),
    "moving_unlike_prediction": ("Moves {sp}″ per year (from {b} µm); the catalogue predicts a different motion.",
                                 "Yılda {sp}″ kayıyor ({b} µm); katalog farklı bir hareket bekliyor."),
    "not_moving": ("No motion measured (from {b} µm): {sp}″ per year.", "Hareket ölçülmedi ({b} µm): yılda {sp}″."),
    "too_uncertain": ("No clear motion measured yet (from {b} µm), although the catalogue expects one: too uncertain so far.",
                      "Henüz belirgin hareket ölçülmedi ({b} µm), oysa katalog bekliyor: şimdilik fazla belirsiz."),
    "not_detected": ("Nothing detected at this position in {b} µm.", "Bu konumda {b} µm'de bir şey görülmedi."),
    "one_season": ("Seen in only one season so far ({b} µm): motion cannot be measured yet.",
                   "Şimdilik yalnızca bir sezonda görüldü ({b} µm): hareket henüz ölçülemez."),
    "brightness": ("Brightness target: see the brightness result ({b} µm).", "Parlaklık hedefi: parlaklık sonucuna bakın ({b} µm)."),
    "no_measurement": ("Could not measure the motion from {b} µm.", "{b} µm'den hareket ölçülemedi."),
    # guarded results (reason != null)
    "degenerate": ("No error bar could be measured in {b} µm (one exposure per season, or the position fit did not move "
                   "from its start): no motion can be stated.",
                   "{b} µm'de hata payı ölçülemedi (sezon başına tek görüntü ya da konum ölçümü başlangıçtan ayrılmadı): "
                   "hareket söylenemez."),
    "disagrees_with_catalogue": ("The measured motion ({sp}″ per year, {b} µm) disagrees with the catalogue and the measurement "
                                 "is weak here: too uncertain so far.",
                                 "Ölçülen hareket (yılda {sp}″, {b} µm) katalogla uyuşmuyor ve buradaki ölçüm zayıf: "
                                 "şimdilik fazla belirsiz."),
    "implausible_speed": ("The measured motion ({sp}″ per year, {b} µm) is faster than any known star: most likely a different "
                          "source was measured in each season. Too uncertain; check the blink by eye.",
                          "Ölçülen hareket (yılda {sp}″, {b} µm) bilinen her yıldızdan hızlı: büyük olasılıkla her sezonda farklı "
                          "bir kaynak ölçüldü. Fazla belirsiz; göz kırpmaya gözle bakın."),
    "large_error": ("The error bar ({sp}″ per year, {b} µm) is too large to tell whether it moves: too uncertain so far.",
                    "Hata payı (yılda {sp}″, {b} µm) hareket edip etmediğini söylemek için çok büyük: şimdilik fazla belirsiz."),
    "inconsistent": ("The season positions ({b} µm) do not line up on one steady motion: too uncertain so far.",
                     "Sezon konumları ({b} µm) tek bir düzgün harekete oturmuyor: şimdilik fazla belirsiz."),
}
CATALOGUE_NOTE = {   # appended to the sentence when the Gaia field is not in the measurement
    "pending": (" Measured before the star catalogue arrived (no field-star calibration yet); updated when it does.",
                " Yıldız kataloğu gelmeden ölçüldü (henüz alan yıldızı kalibrasyonu yok); katalog gelince güncellenir."),
    "unavailable": (" Measured without the star catalogue: it could not be loaded (network), so there is no calibration "
                    "and no catalogue prediction.",
                    " Yıldız kataloğu olmadan ölçüldü: katalog yüklenemedi (ağ); kalibrasyon ve katalog tahmini yok."),
}
UNCAL_FLOOR = 1.0    # " minimum shift for "moving" without the field-star calibration (WCS-only systematics)


def num_txt(v, tr=False):
    """2 decimals; Turkish with a decimal comma (10,37), English with a point (10.37)."""
    t = f"{v:.2f}"
    return t.replace(".", ",") if tr else t


def joint_speed(f):
    """(speed, error) in "/yr from the joint fit's proper motion, the same formula as the result tiles
    (site/js/gr.js speedFit); None without a joint fit."""
    try:
        a, d = float(f["pmra_mas_yr"]), float(f["pmdec_mas_yr"])
    except (KeyError, TypeError, ValueError):
        return None
    v = math.hypot(a, d) / 1000
    ea, ed = f.get("pmra_err_mas_yr"), f.get("pmdec_err_mas_yr")
    e = None
    if ea is not None and ed is not None:
        e = math.hypot(a * ea, d * ed) / (v * 1000) / 1000 if v > 0 else max(ea, ed) / 1000
    return v, e


def answer_from_meta(meta, version, stage, url, catalogue="loaded"):
    """Plain verdict of a blink.py meta.json, with the rule of site/js/explain.js (significant if the
    shift exceeds max(3 x error, 0.2")), the guards of answer_guard(), and the speed per year from the
    joint fit when there is one (as the tiles), else shift / dt. catalogue: "loaded" | "pending" |
    "unavailable" (Gaia field not in this measurement: no prediction, no joint-fit pm, floor 1.0").
    Codes and both languages: PROGRESSIVE CONTRACT."""
    ms = meta.get("measured") or {}
    bins = [b["wavelength_um"] for b in meta.get("wavelength_bins", [])]
    n = sum(f["n_images"] for b in meta.get("wavelength_bins", []) for f in b["frames"])
    cal = catalogue == "loaded"
    out = {"version": version, "stage": stage, "bins_used": bins, "n_images": n, "status": ms.get("status"),
           "meta_url": url + "meta.json", "shift_arcsec": None, "shift_err_arcsec": None, "dt_years": None,
           "pa_deg": None, "speed_arcsec_yr": None, "speed_err_arcsec_yr": None, "speed_source": None,
           "predicted_arcsec": None, "pm_mas_yr": None, "pm_err_mas_yr": None, "catalogue": catalogue}
    f = ms.get("fit") or {}
    if cal and f.get("pmra_err_mas_yr") is not None:
        out["pm_mas_yr"] = [f["pmra_mas_yr"], f["pmdec_mas_yr"]]
        out["pm_err_mas_yr"] = [f["pmra_err_mas_yr"], f["pmdec_err_mas_yr"]]
    st = ms.get("status")
    reason = None
    if st == "brightness":
        code = "brightness"
    elif st == "not_detected":
        code = "not_detected"
    elif st == "detected_one_season":
        code = "one_season"
    elif ms.get("shift_arcsec") is None:
        code = "no_measurement"
    else:
        s, e = float(ms["shift_arcsec"]), ms.get("shift_err_arcsec")
        e = float(e) if e not in (None, 0) else None
        eu = e if e is not None else max(0.1, 0.05 * s)
        dt = float(ms.get("dt_years") or 0) or None
        floor = 0.2 if cal else UNCAL_FLOOR
        has_pred = cal and bool((meta.get("gaia") or {}).get("pmra_mas_yr") or (meta.get("gaia") or {}).get("pmdec_mas_yr"))
        p = float(ms["gaia_predicted_arcsec"]) if has_pred and ms.get("gaia_predicted_arcsec") is not None else None
        sig, psig = s > max(3 * eu, floor), p is not None and p > max(3 * eu, floor)
        if sig and psig:
            same = abs(s - p) <= max(3 * eu, 0.1 + 0.05 * p)
            code = "moving_as_predicted" if same else "moving_unlike_prediction"
        elif sig:
            code = "moving"
        elif psig:
            code = "too_uncertain"
        else:
            code = "not_moving"
        why = answer_guard(ms, s, dt, True) if code != "too_uncertain" else None
        if not why and code == "not_moving" and dt and eu / dt > MAX_NOT_MOVING_ERR:
            why = "large_error"
        poor = len(bins) < 2 or not all(q.get("bias_corrected") for q in ms.get("positions") or [])
        if not why and p is not None and code != "not_moving" and abs(s - p) > 3 * eu and poor:
            why = "disagrees_with_catalogue"       # e.g. a Gaia star that does not move, one bin, 4 sigma "moving"
        if why:
            reason, code = why, ("no_measurement" if why == "degenerate" else "too_uncertain")
        js = joint_speed(f) if cal and out["pm_mas_yr"] is not None else None
        if js:                                     # one number, one method: the tiles' joint-fit speed
            v, ve = js
            src = "joint_fit"
        else:
            v, ve = (s / dt if dt else None), (e / dt if dt and e is not None else None)
            src = "shift_dt"
        out.update(shift_arcsec=round(s, 3), shift_err_arcsec=round(e, 3) if e is not None else None,
                   dt_years=dt, pa_deg=ms.get("pa_deg"), predicted_arcsec=p,
                   speed_arcsec_yr=round(v, 3) if v is not None else None,
                   speed_err_arcsec_yr=round(ve, 3) if ve is not None else None,
                   speed_source=src if v is not None else None)

    def sp(tr):
        v, ve = out["speed_arcsec_yr"], out["speed_err_arcsec_yr"]
        if v is None:
            return ""
        return num_txt(v, tr) + (f" ± {num_txt(ve, tr)}" if ve is not None else "")
    b_en = ", ".join(f"{x:g}" for x in bins)
    b_tr = "; ".join(f"{x:g}".replace(".", ",") for x in bins)      # decimal comma, so the list uses ";"
    en, tr = ANSWER_TEXT[reason or code]
    text_en, text_tr = en.format(sp=sp(False), b=b_en), tr.format(sp=sp(True), b=b_tr)
    if not cal and code not in ("brightness", "not_detected"):
        text_en, text_tr = text_en + CATALOGUE_NOTE[catalogue][0], text_tr + CATALOGUE_NOTE[catalogue][1]
    out.update(code=code, reason=reason, text_en=text_en, text_tr=text_tr)
    return out


COMPOSITE_CHANNELS = {"blue": [1.0, 1.5], "green": [2.0, 3.0], "red": [4.0, 4.6]}


def write_composite(stage_dir, meta):
    """composite/<epoch>.png: the loaded bins' blink frames per season as one colour picture (short = blue,
    middle = green, long = red). Display only; the frames are already stretched (0..1), nothing is measured."""
    import numpy as np
    from PIL import Image
    import blink
    lab = int(meta["grid"].get("label_strip_px", blink.LABEL_H))
    up = int(meta["grid"].get("upscale", blink.UPSCALE))
    per = {}
    for b in meta.get("wavelength_bins", []):
        for fr in b["frames"]:
            per.setdefault(fr["epoch"], {})[b["wavelength_um"]] = stage_dir / fr["file"]
    (stage_dir / "composite").mkdir(exist_ok=True)
    frames = []
    for ep in sorted(per):
        chans = []
        for name in ("red", "green", "blue"):
            imgs = [np.asarray(Image.open(per[ep][u]).convert("L"), float)[lab::up, ::up] / 255.0
                    for u in COMPOSITE_CHANNELS[name] if u in per[ep]]
            chans.append(np.mean(imgs, axis=0) if imgs else None)
        shape = next(c.shape for c in chans if c is not None)
        rgb = np.stack([c if c is not None else np.zeros(shape) for c in chans], -1)
        fn = f"composite/{ep}.png"
        bins = sorted(per[ep])
        blink.to_png((np.clip(rgb, 0, 1) * 255).astype(np.uint8),
                     [ep, "colour view " + "+".join(f"{u:g}" for u in bins) + " um  (look only)"], stage_dir / fn)
        frames.append({"epoch": ep, "file": fn, "bins": bins})
    return {"display_only": True, "channels": COMPOSITE_CHANNELS, "frames": frames,
            "caption_en": "Colour view of the loaded wavelengths: for looking only; measurements are per wavelength.",
            "caption_tr": "Yüklenen dalga boylarının renkli görünümü: yalnızca bakmak için; ölçümler dalga boyu başınadır."}


class Staged:
    """Downloads one bin at a time (priority-aware queue, IMAGE_WORKERS threads) and publishes a stage
    (blink.py in a child process on everything loaded so far) whenever bins complete; the threads keep
    downloading while a stage is measured. Robust: every exposure gets MAX_TRIES attempts (the last one
    with a SMALLER_DEG cutout after time-outs); a network outage pauses the queue (status says so) for at
    most OUTAGE_MAX_S, then the job goes on with what it has."""

    def __init__(self, jd, status, req, chosen, summary, ra, dec, size, local_data):
        self.jd, self.status, self.req = jd, status, req
        self.job_id = req["id"]
        self.ra, self.dec, self.size, self.local_data = ra, dec, size, local_data
        self.store = LOCAL / "cutouts" / (req["point_key"] + ("" if size == CUTOUT_DEG else f"-s{size:g}"))
        self.lock = threading.Condition()
        seasons = {s["bin_um"]: s["seasons"] for s in summary if s.get("used")}
        self.seasons = seasons
        self.order = bin_order(seasons)
        self.items = {b: {"first": [], "refine": []} for b in self.order}
        cnt = {}
        for r in chosen:                                  # chosen: per bin and season, closest first
            b = r["bin_um"]
            if b not in self.items:
                continue
            k = (b, r["season"])
            cnt[k] = cnt.get(k, 0) + 1
            self.items[b]["first" if cnt[k] <= FIRST_CAP else "refine"].append(dict(r, _try=0))
        self.pending = {b: list(v["first"]) for b, v in self.items.items()}
        self.refine_pending = [r for b in self.order for r in self.items[b]["refine"]]
        self.bins = {b: {"bin_um": b, "detector": f"D{BINS[b]}", "state": "queued", "images_done": 0,
                         "images_total": len(self.items[b]["first"]), "seasons": seasons.get(b, 0),
                         "bytes": 0, "error": None, "_ok": 0, "_left": len(self.items[b]["first"]), "_failed_rows": []}
                     for b in self.order}
        self.refine = {"state": "queued" if self.refine_pending else "none", "images_done": 0,
                       "images_total": len(self.refine_pending), "_left": len(self.refine_pending)}
        self.got, self.failed, self.smaller = [], [], []
        self.version, self.stages, self.priority = 0, [], None
        self.fail_streak, self.outage_since = 0, None
        self.t0, self.bytes, self.n_net = time.time(), 0, 0
        self.stage_cost = None
        self.done_bins_published = set()
        self.new_done = False
        self.gaia_ready = lambda: False                   # set by main(): True once the Gaia field is on disk

    # ---- status
    def publish(self, **extra):
        with self.lock:
            self.version += 1
            p = {"version": self.version, "order": list(self.order), "first_cap": FIRST_CAP,
                 "bins": [{k: v for k, v in self.bins[b].items() if not k.startswith("_")} for b in self.order],
                 "refine": {k: v for k, v in self.refine.items() if not k.startswith("_")},
                 "stages": self.stages, "latest": len(self.stages) - 1 if self.stages else None,
                 "answer": self.stages[-1]["answer"] if self.stages else None,
                 "eta": self.eta(), "priority": self.priority, "final_url": None,
                 "catalogue": "loaded" if self.gaia_ready() else "pending"}
            p.update(extra)
        self.status.set(progressive=p)

    def eta(self):
        """Seconds to the next answer and to everything, from this run's own bytes and seconds."""
        el = time.time() - self.t0
        out = {"first_answer_s": None, "all_s": None, "mb_per_s": None, "bytes_left": 0,
               "basis": "measured from this run's own downloads"}
        if self.n_net < 3 or el <= 0:
            out["basis"] = "not yet measured (fewer than 3 exposures in)"
            return out
        rate = self.bytes / el
        per = self.bytes / self.n_net
        left_first = sum(v["_left"] for v in self.bins.values())
        left = left_first + self.refine["_left"]
        cost = self.stage_cost or 15.0
        out["mb_per_s"] = round(rate / 1e6, 2)
        out["bytes_left"] = int(left * per)
        nxt, before = None, 0
        for b in self.order:                              # exposures still to read up to the next bin
            before += self.bins[b]["_left"]
            if self.bins[b]["state"] in ("queued", "loading"):
                nxt = b
                break
        out["next_answer_s"] = round(before * per / rate + cost) if nxt is not None else None
        out["next_bin_um"] = nxt
        out["first_answer_s"] = 0 if self.stages else out["next_answer_s"]
        out["all_s"] = round(left * per / rate + 2 * cost)
        return out

    # ---- download queue
    def read_priority(self):
        """Apply <job dir>/priority.json: move a queued bin to the front, or re-queue a FAILED bin at the
        front (its unread exposures get MAX_TRIES fresh attempts; contract v1.1). True when it re-queued."""
        p = self.jd / "priority.json"
        try:
            um = float(json.loads(p.read_text()).get("bin_um"))
            stamp = p.stat().st_mtime_ns                      # one retry per POST (the server rewrites the file)
        except Exception:
            return False
        with self.lock:
            bs = self.bins.get(um)
            if bs is None:
                return False
            if bs["state"] == "failed":
                if stamp == bs.get("_retry_stamp"):
                    return False
                bs["_retry_stamp"] = stamp
                rows, bs["_failed_rows"] = bs["_failed_rows"], []
                if not rows:                                  # every exposure was read: nothing to fetch again
                    what = "nothing left to read (the failure is in the data, not the network)"
                    if what not in (bs["error"] or ""):
                        bs["error"] = (bs["error"] or "failed") + "; retry: " + what
                    requeued = None
                else:
                    keys = {r["s3_key"] for r in rows}
                    self.failed = [f for f in self.failed if f[0] not in keys]
                    for r in rows:
                        r["_try"] = 0
                    self.pending[um] = rows + self.pending[um]
                    bs.update(state="queued", images_done=0, images_total=len(rows), error=None, _left=len(rows))
                    self.fail_streak, self.outage_since = 0, None
                    requeued = True
            elif um == self.priority or bs["state"] in ("done", "loading"):
                self.priority = um
                return False
            else:
                requeued = False
            if requeued is not None:
                self.priority = um
                self.order.remove(um)
                k = next((i for i, b in enumerate(self.order) if self.bins[b]["state"] == "queued"), len(self.order))
                self.order.insert(k, um)
        what = {True: "re-queued at the front (retry after failure)", False: "moved to the front",
                None: "not retried: " + (bs["error"] or "")}[requeued]
        print(f"  priority: {um} um {what}", flush=True)
        self.publish()
        return bool(requeued)

    def next_item(self):
        with self.lock:
            for b in self.order:
                if self.pending[b]:
                    self.bins[b]["state"] = "loading"
                    return b, self.pending[b].pop(0), False
            if self.refine_pending:
                self.refine["state"] = "loading"
                return None, self.refine_pending.pop(0), True
        return None

    def wait_outage(self):
        """Back-off while the network is down (honest status); False after OUTAGE_MAX_S."""
        with self.lock:
            since = self.outage_since
        if since is None:
            return True
        if time.time() - since > OUTAGE_MAX_S:
            return False
        time.sleep(min(30, 5 + (time.time() - since) / 4))
        return True

    def worker(self):
        import fetch_region as fr
        while True:
            self.read_priority()
            it = self.next_item()
            if it is None:
                return
            b, r, refine = it
            path, nbytes, note, size = None, 0, "", self.size
            with self.lock:
                gave_up = self.outage_since is not None and time.time() - self.outage_since > OUTAGE_MAX_S
            if gave_up:                                     # network down for > OUTAGE_MAX_S: do not wait per image
                note = f"network down for more than {OUTAGE_MAX_S // 60} min"
                r["_try"] = MAX_TRIES
            while r["_try"] < MAX_TRIES:
                r["_try"] += 1
                size = self.size if r["_try"] < MAX_TRIES or "time" not in note.lower() else min(self.size, SMALLER_DEG)
                try:
                    store = self.store if size == self.size else LOCAL / "cutouts" / (self.req["point_key"] + f"-s{size:g}")
                    path, nbytes, note = fetch_cutout(r, self.ra, self.dec, store, self.local_data, self.status, size)
                    if path or "overlap" in (note or "") or "outside" in (note or ""):
                        break                               # done, or no data here (not a network fault)
                except Exception as e:
                    note = f"{type(e).__name__}: {e}"
                with self.lock:                             # a network/read fault
                    self.fail_streak += 1
                    if self.fail_streak >= OUTAGE_AFTER and self.outage_since is None:
                        self.outage_since = time.time()
                if self.outage_since is not None:
                    self.status.set(message=f"network trouble since {time.strftime('%H:%M:%S', time.localtime(self.outage_since))}"
                                    f" ({note[:80]}); retrying, {len(self.got)} cutouts ready")
                    if not self.wait_outage():
                        break
                else:
                    time.sleep(2 * r["_try"])
            with self.lock:
                if path:
                    self.fail_streak, self.outage_since = 0, None
                    self.got.append((r, path))
                    if size != self.size:
                        self.smaller.append({"key": r["s3_key"], "cutout_deg": size})
                    if nbytes:
                        self.bytes += nbytes
                        self.n_net += 1
                else:
                    self.failed.append((r["s3_key"], note or "failed"))
                    print("  skipped", r["s3_key"], note, flush=True)
                    if not refine:
                        self.bins[b]["_failed_rows"].append(r)    # kept for a retry (priority on a failed bin)
                if refine:
                    self.refine["images_done"] += 1
                    self.refine["_left"] -= 1
                    if not self.refine["_left"]:
                        self.refine["state"] = "done"
                else:
                    bs = self.bins[b]
                    bs["images_done"] += 1
                    bs["_left"] -= 1
                    bs["bytes"] += nbytes
                    bs["_ok"] += bool(path)
                    if not bs["_left"]:
                        okseasons = {x["season"] for x, _ in self.got if x["bin_um"] == b}
                        bs["state"] = "done" if len(okseasons) >= 2 else "failed"
                        if bs["state"] == "failed":
                            nf = len(bs["_failed_rows"])
                            bs["error"] = (f"only {len(okseasons)} season(s) could be read" +
                                           (f"; {nf} of {bs['images_total']} images failed ({(note or 'failed')[:60]})" if nf else ""))
                        self.new_done = True
                        self.lock.notify_all()
            self.status.add(done=1, nbytes=nbytes, message=self.progress_message())
            self.publish()

    def progress_message(self):
        done = [b for b in self.order if self.bins[b]["state"] == "done"]
        cur = next((b for b in self.order if self.bins[b]["state"] == "loading"), None)
        msg = f"{len(self.got)} cutouts ready" + (f", {len(self.failed)} skipped" if self.failed else "")
        if self.stages:
            msg = f"answer from {', '.join(f'{x:g}' for x in self.stages[-1]['bins'])} µm ready; " + msg
        if cur is not None:
            msg += f"; loading {cur:g} µm"
        elif self.refine["state"] == "loading":
            msg += "; loading the remaining exposures"
        return msg

    # ---- stages
    def link_inputs(self, name, bins):
        """inputs/<job>-stages/<name>/{dr1,qr3}: the cutouts of `bins` read so far, with their listings."""
        d = LOCAL / "inputs" / f"{self.job_id}-stages" / name
        with self.lock:
            sel = [(r, p) for r, p in self.got if r["bin_um"] in bins]
        for coll in ("dr1", "qr3"):
            cs = [(r, p) for r, p in sel if r["collection"] == coll]
            if not cs:
                continue
            for r, p in cs:
                link(p, d / coll / p.name)
            with open(d / f"liste_{coll}.csv", "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=CSV_COLS)
                w.writeheader()
                for r, _ in sorted(cs, key=lambda x: x[0]["mjd"]):
                    w.writerow(irsa_row(r))
        return d.parent, len(sel)

    def run_stage(self, bins, gaia_file):
        """One stage: blink.py on the bins so far. Without the Gaia field yet it is measured on the SPHEREx WCS
        (no field-star calibration, no catalogue prediction) and marked "catalogue": "pending"."""
        k = len(self.stages) + 1
        name = f"s{k}"
        data_root, n = self.link_inputs(name, bins)
        out_root = CACHE / "jobs" / self.job_id / "stage"
        (out_root / name).mkdir(parents=True, exist_ok=True)
        catalogue = "loaded" if gaia_file and Path(gaia_file).exists() else "pending"
        env = dict(os.environ, FAZARI_CAL_WORKERS=os.environ.get("FAZARI_CAL_WORKERS", "4"))
        if catalogue == "loaded":
            import shutil
            shutil.copy(gaia_file, out_root / name / "gaia_field.json")
        else:
            env["FAZARI_NO_GAIA_FETCH"] = "the star catalogue is still loading"
            self.status.set(message=f"measuring {', '.join(f'{b:g}' for b in bins)} µm without the star catalogue "
                                    "(Gaia DR3 still loading); the answer is updated when it arrives")
        spec = {"name": name, "target": self.req["target"], "data_root": str(data_root), "out_root": str(out_root), "n": n}
        sp = self.jd / f"stage_{name}.json"
        sp.write_text(json.dumps(spec))
        t0 = time.time()
        import subprocess
        with open(self.jd / f"stage_{name}.log", "w") as log:
            rc = subprocess.call([sys.executable, "-I", str(Path(__file__).resolve()), "--job", str(self.jd),
                                  "--stage", str(sp)], stdout=log, stderr=subprocess.STDOUT,
                                 env=env)
        sec = round(time.time() - t0, 1)
        mp = out_root / name / "meta.json"
        if rc != 0 or not mp.exists():
            print(f"  stage {name} ({bins}) failed (exit {rc}); see {self.jd / f'stage_{name}.log'}", flush=True)
            return None
        self.stage_cost = sec
        meta = json.loads(mp.read_text())
        url = f"/jobs/{self.job_id}/stage/{name}/"
        st = {"n": k, "bins": [b["wavelength_um"] for b in meta.get("wavelength_bins", [])], "url": url,
              "n_images": n, "seconds": sec, "catalogue": catalogue,
              "answer": answer_from_meta(meta, self.version + 1, k, url, catalogue)}
        try:
            st["composite"] = write_composite(out_root / name, meta)
        except Exception as e:
            print("  composite failed:", e, flush=True)
            st["composite"] = None
        with self.lock:
            self.stages.append(st)
        print(f"  stage {name}: bins {st['bins']} from {n} cutouts in {sec} s -> {st['answer']['code']}: "
              f"{st['answer']['text_en']}", flush=True)
        self.status.set(message=self.progress_message())
        self.publish()
        return st

    def run(self, gaia_file_fn):
        """Download everything (threads) and publish stages as bins complete. Returns when all is read."""
        self.publish()
        threads = [threading.Thread(target=self.worker, daemon=True) for _ in range(IMAGE_WORKERS)]
        for t in threads:
            t.start()
        published = set()
        while True:
            with self.lock:
                if not self.new_done:
                    self.lock.wait(timeout=1)
                self.new_done = False
            alive = any(t.is_alive() for t in threads)
            if self.read_priority() and not alive:         # retry of a failed bin after the workers finished
                threads.append(threading.Thread(target=self.worker, daemon=True))
                threads[-1].start()
                alive = True
            with self.lock:
                done = [b for b in self.order if self.bins[b]["state"] == "done"]
            todo = [b for b in done if b not in published]
            # everything read: the final run (all exposures) replaces this stage, so no stage then
            if todo and alive:
                self.run_stage(sorted(set(published) | set(todo)), gaia_file_fn())
                published |= set(todo)                    # a failed stage is not retried; the next bin retries
            elif alive and published and self.stages and self.stages[-1].get("catalogue") == "pending" \
                    and self.gaia_ready():                # the catalogue arrived: same bins again, now calibrated
                self.run_stage(sorted(published), gaia_file_fn(0))
            if not alive:
                break
            self.publish()                                # refresh the estimates
        for t in threads:
            t.join()


def stage_main(spec_path):
    """Child process of Staged.run_stage: blink.py on one stage's inputs (no network but Gaia)."""
    spec = json.loads(Path(spec_path).read_text())

    class Quiet:                                          # run_blink's progress hooks: written to the stage dir
        def __init__(self, path):
            self.path = path

        def set(self, **kw):
            pass
    out_root = Path(spec["out_root"])
    run_blink(spec["name"], spec["target"], Path(spec["data_root"]), out_root,
              Quiet(out_root / spec["name"] / "status.json"), spec["n"])


def prefetch_gaia(req, size, out_dir):
    """Gaia DR3 field of the job (blink.py format, radius = 0.75 x cutout size) fetched while the images
    download, so no stage waits for TAP; blink.py's own fetch stays the fallback. Returns the path or None."""
    import blink
    t = dict(req["target"])
    for k, v in (("plx", 0.0), ("epoch", 2016.0), ("pmra", 0.0), ("pmdec", 0.0)):
        if t.get(k) is None:
            t[k] = v
    from astropy.time import Time
    ra_c, dec_c = blink.target_position(t, Time(blink.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    radius = round(max(blink.GAIA_RADIUS_DEG, 0.75 * size), 3)
    path = Path(out_dir) / "gaia_field.json"
    if path.exists() and blink.gaia_cache_radius(path) >= radius - 1e-9:
        return path
    q, source, stars, tried = blink.gaia_rows(ra_c, dec_c, radius, blink.GAIA_GMAX)
    from datetime import datetime, timezone
    out = {"source": source, "query": q, "ref_epoch": 2016.0,
           "columns": ["source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag", "ruwe"],
           "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "radius_deg": radius, "stars": stars}
    if tried:
        out["fallback"] = {"failed": tried}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(out, separators=(",", ":")))
    os.replace(tmp, path)
    print(f"  Gaia DR3 prefetched: {len(stars)} stars, radius {radius} deg ({source})", flush=True)
    return path


# ---------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, help="job folder with request.json")
    ap.add_argument("--post-only", help="comma-separated POST_STEPS names: rerun only these on a finished job")
    ap.add_argument("--no-post", action="store_true",
                    help="stop after the blink (state done); the server runs the post-steps with --post-only")
    ap.add_argument("--stage", help=argparse.SUPPRESS)        # internal: one progressive stage (Staged.run_stage)
    ap.add_argument("--no-stages", action="store_true", help="download everything first (no progressive stages)")
    a = ap.parse_args()
    jd = Path(a.job).resolve()
    if a.stage:
        stage_main(a.stage)
        return
    req = json.loads((jd / "request.json").read_text())
    if a.post_only:
        run_post_only(jd, req, [n for n in a.post_only.split(",") if n])
        return
    job_id, target = req["id"], req["target"]
    ra, dec = req["center"]["ra"], req["center"]["dec"]
    status = Status(jd / "status.json")
    inputs = LOCAL / "inputs"
    tdir = inputs / job_id
    out_root = CACHE / "jobs"
    local_data = Path(req["local_data"]) if req.get("local_data") else None
    size = float(req.get("cutout_deg") or CUTOUT_DEG)
    # blink.py reads these at import; the Gaia prefetch imports it before run_blink, so set them now
    (jd / "targets.json").write_text(json.dumps({job_id: target}, indent=1))
    os.environ.update(FAZARI_DATA=str(inputs), FAZARI_OUT=str(out_root), FAZARI_TARGETS=str(jd / "targets.json"))
    staged = None
    gaia_final = None                                      # set when the Gaia field is prefetched (staged run)
    try:
        status.set(cutout_deg=size)
        status.stage("finding", "looking up SPHEREx images of this point")
        if req.get("local_target"):
            src = local_data / req["local_target"]
            rows = local_rows(local_data, req["local_target"])
            for coll in ("dr1", "qr3"):
                if (src / coll).is_dir():
                    link(src / coll, tdir / coll)
                if (src / f"liste_{coll}.csv").exists():
                    link(src / f"liste_{coll}.csv", tdir / f"liste_{coll}.csv")
            status.set(progress={"done": len(rows), "total": len(rows), "bytes": 0},
                       images={"source": "local IRSA cutouts", "found": len(rows), "selected": len(rows)})
            status.stage("downloading", f"using {len(rows)} local IRSA cutouts of {target['name']}")
            n_in = len(rows)
        else:
            source = "sky index"
            try:
                rows = index_rows(ra, dec)
            except Exception as e:
                print("sky index unavailable, using IRSA SIA:", e, flush=True)
                source = "IRSA SIA"
                rows = sia_rows(ra, dec)
            chosen, summary = select(rows, req["bins"], req["cap"])
            print(f"{len(rows)} images ({source}); selected {len(chosen)}: {summary}", flush=True)
            (jd / "selection.json").write_text(json.dumps({"source": source, "found": len(rows),
                                                           "bins": summary, "images": chosen}, indent=1))
            status.set(images={"source": source, "found": len(rows), "selected": len(chosen), "bins": summary})
            if not chosen:
                raise RuntimeError(f"SPHEREx has {len(rows)} images here, but no wavelength bin is covered "
                                   "in two seasons yet, so there is nothing to blink.")
            # most useful first: 2.0 and 4.6 um (D3, D6) of every season, seasons interleaved, then the rest
            rank = {}
            for r in sorted(chosen, key=lambda r: r["mjd"]):
                g = (r["detector"] not in PRIORITY_DETECTORS, r["detector"])
                r["_rank"] = rank[g] = rank.get(g, -1) + 1
            chosen.sort(key=lambda r: (r["detector"] not in PRIORITY_DETECTORS, r["_rank"], r["detector"]))
            import fetch_region as _fr
            if source == "sky index":                       # S3 only from here on (IRSA SIA stays at 4)
                _fr._HTTP_SLOTS = threading.BoundedSemaphore(S3_HTTP_SLOTS)
            status.stage("downloading", f"reading {len(chosen)} {size:g} deg cutouts from the SPHEREx S3 bucket")
            status.set(progress={"done": 0, "total": len(chosen), "bytes": 0})
            store = LOCAL / "cutouts" / (req["point_key"] + ("" if size == CUTOUT_DEG else f"-s{size:g}"))
            got, failed = [], []
            staged = None
            if not a.no_stages:
                # Gaia DR3 field while the images download (IRSA -> ESA -> VizieR); stages and the final run use it
                gbox = {}

                def gaia_bg():
                    try:
                        gbox["path"] = prefetch_gaia(req, size, out_root / job_id)
                    except Exception as e:
                        gbox["error"] = f"{type(e).__name__}: {e}"
                        print("  Gaia prefetch failed (stages and the final run go on without the catalogue):", gbox["error"], flush=True)
                gt = threading.Thread(target=gaia_bg, daemon=True)
                gt.start()

                def gaia_file(wait=GAIA_STAGE_WAIT):
                    """Path of the Gaia field, or None while it is still loading (a stage never waits long)."""
                    gt.join(timeout=wait)
                    return gbox.get("path")

                def gaia_final():
                    """Final run: wait for the race (bounded), honestly; (path, None) or (None, reason)."""
                    if gt.is_alive():
                        status.set(message="waiting for the star catalogue (Gaia DR3) before the final measurement")
                        print("  waiting for the star catalogue (Gaia DR3)", flush=True)
                        gt.join(timeout=GAIA_FINAL_WAIT)
                    if gbox.get("path"):
                        return gbox["path"], None
                    return None, gbox.get("error") or (f"IRSA, ESA and VizieR gave no Gaia DR3 answer in time (waited "
                                                       f"{GAIA_FINAL_WAIT} s after the last image)")
                staged = Staged(jd, status, req, chosen, summary, ra, dec, size, local_data)
                staged.gaia_ready = lambda: bool(gbox.get("path"))
                staged.run(gaia_file)
                got, failed = staged.got, list(staged.failed)
                if staged.smaller:
                    status.set(smaller=staged.smaller)
                chosen = []                                # nothing left for the plain loop below
            with ThreadPoolExecutor(max_workers=IMAGE_WORKERS) as ex:
                futs = {ex.submit(fetch_cutout, r, ra, dec, store, local_data, status, size): r for r in chosen}
                for fu in as_completed(futs):
                    r = futs[fu]
                    try:
                        path, nbytes, note = fu.result()
                    except Exception as e:
                        path, nbytes, note = None, 0, f"error: {e}"
                    if path:
                        got.append((r, path))
                    else:
                        failed.append((r["s3_key"], note))
                        print("  skipped", r["s3_key"], note, flush=True)
                    status.add(done=1, nbytes=nbytes,
                               message=f"{len(got)} cutouts ready" + (f", {len(failed)} skipped" if failed else ""))
            if not got:
                raise RuntimeError("none of the SPHEREx images could be read: " + "; ".join(n for _, n in failed[:3]))
            for coll in ("dr1", "qr3"):
                sel = [(r, p) for r, p in got if r["collection"] == coll]
                if not sel:
                    continue
                for r, p in sel:
                    link(p, tdir / coll / p.name)
                lp = tdir / f"liste_{coll}.csv"
                tmp = lp.with_suffix(".tmp")
                with open(tmp, "w", newline="") as fh:
                    w = csv.DictWriter(fh, fieldnames=CSV_COLS)
                    w.writeheader()
                    for r, _ in sorted(sel, key=lambda x: x[0]["mjd"]):
                        w.writerow(irsa_row(r))
                os.replace(tmp, lp)
            status.set(skipped=[{"key": k, "reason": n} for k, n in failed])
            n_in = len(got)
        catalogue = None
        if gaia_final is not None:
            gpath, gwhy = gaia_final()
            catalogue = "loaded" if gpath else "unavailable"
            if not gpath:                                  # never block the result on the catalogue
                os.environ["FAZARI_NO_GAIA_FETCH"] = f"star catalogue unavailable: {gwhy}"[:300]
                status.set(catalogue={"state": "unavailable", "reason": gwhy[:300]})
                print("  final run without the star catalogue:", gwhy, flush=True)
            else:
                status.set(catalogue={"state": "loaded"})
        status.stage("processing", "aligning the seasons and building the blink"
                     + (" (star catalogue unavailable: positions on the SPHEREx WCS, no catalogue prediction)"
                        if catalogue == "unavailable" else ""))
        status.set(progress={"done": 0, "total": n_in})
        run_blink(job_id, target, inputs, out_root, status, n_in)
        meta = out_root / job_id / "meta.json"
        if not meta.exists():
            raise RuntimeError("blink.py finished without writing meta.json")
        m = json.loads(meta.read_text())
        if not req.get("local_target") and staged is not None:
            url = f"/jobs/{job_id}/"
            fin = {"n": len(staged.stages) + 1, "bins": [b["wavelength_um"] for b in m.get("wavelength_bins", [])],
                   "url": url, "n_images": n_in, "final": True,
                   "catalogue": catalogue or "loaded",
                   "answer": answer_from_meta(m, staged.version + 1, len(staged.stages) + 1, url, catalogue or "loaded")}
            try:
                fin["composite"] = write_composite(out_root / job_id, m)
            except Exception as e:
                print("  composite failed:", e, flush=True)
                fin["composite"] = None
            staged.stages.append(fin)
            staged.publish(final_url=url)
        if POST_STEPS and not a.no_post:
            post = run_post_steps({"job_id": job_id, "req": req, "target": target, "out": out_root / job_id,
                                   "inputs": tdir, "meta": m, "status": status})
            status.set(post=post)
        nb = len(m.get("wavelength_bins", []))
        meas = m.get("measured", {})
        msg = f"{len(m.get('epochs', []))} seasons, {nb} wavelength bin(s)"
        if meas.get("message"):
            msg += f"; {meas['message']}"
        status.stage("done", msg)
        status.set(result={"epochs": m.get("epochs"), "bins": [b["wavelength_um"] for b in m.get("wavelength_bins", [])],
                           "status": meas.get("status")}, finished=time.time())
    except SystemExit as e:
        status.stage("error", str(e.code) if e.code not in (None, 0) else "blink.py stopped")
        sys.exit(1)
    except Exception as e:
        traceback.print_exc()
        status.stage("error", f"{type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
