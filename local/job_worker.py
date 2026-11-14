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
               run in order after blink.py (spectrum, candidates, faint); --post-only reruns
               some of them on a finished job (the server does this when their code changed)

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
IMAGE_WORKERS = 3                 # images in parallel; HTTP itself is capped at 4 by fetch_region
PREVIEW_WAIT_MAX = 90             # s: never wait longer than this for previews (a stuck flag)
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
                       cache_dir=CACHE / "s3", stats=st)
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
# moving / changing sources in the whole field -> candidates.json (pipeline/detect, pipeline/DETECTION.md)
POST_STEPS.append(("candidates", "detect.run", "job_step"))
# faint-object mode: float frames, deep stacks, shift-and-stack -> faint/ (pipeline/faint.py, pipeline/FAINT.md)
POST_STEPS.append(("faint", "faint", "post_step"))


def _step_function(entry):
    """The callable of a POST_STEPS entry: ("name", "module", "function") or ("name", callable)."""
    if callable(entry[1]):
        return entry[1]
    import importlib
    return getattr(importlib.import_module(entry[1]), entry[2])


def run_post_steps(ctx, only=None, quiet=False):
    """Run the POST_STEPS (or only the named ones, in list order). quiet: a finished job whose steps
    are rerun; its status message is left alone (the step name goes to status.post_step)."""
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
    return results


def run_post_only(jd, req, names):
    """Rerun some post-steps of a finished job from its kept blink products and cutouts. The job
    stays "done" (its result stays viewable); status.post is merged, the message restored."""
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
    post = run_post_steps({"job_id": job_id, "req": req, "target": req["target"], "out": out,
                           "inputs": LOCAL / "inputs" / job_id, "meta": m, "status": status},
                          only=names, quiet=True)
    with status.lock:
        status.d.pop("post_running", None)
        status.d.pop("post_step", None)
    status.set(post=dict(old.get("post") or {}, **post), message=old.get("message", ""),
               state=old.get("state", "done"), post_rerun={"steps": names, "seconds": round(time.time() - t0, 1),
                                                           "finished": time.time()})
    print(f"[{time.strftime('%H:%M:%S')}] post-steps done in {time.time() - t0:.1f} s: "
          + ", ".join(f"{k} {'ok' if v.get('ok') else 'failed'}" for k, v in post.items()), flush=True)


# ---------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, help="job folder with request.json")
    ap.add_argument("--post-only", help="comma-separated POST_STEPS names: rerun only these on a finished job")
    a = ap.parse_args()
    jd = Path(a.job).resolve()
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
            status.stage("downloading", f"reading {len(chosen)} {size:g} deg cutouts from the SPHEREx S3 bucket")
            status.set(progress={"done": 0, "total": len(chosen), "bytes": 0})
            store = LOCAL / "cutouts" / (req["point_key"] + ("" if size == CUTOUT_DEG else f"-s{size:g}"))
            got, failed = [], []
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
        status.stage("processing", "aligning the seasons and building the blink")
        status.set(progress={"done": 0, "total": n_in})
        run_blink(job_id, target, inputs, out_root, status, n_in)
        meta = out_root / job_id / "meta.json"
        if not meta.exists():
            raise RuntimeError("blink.py finished without writing meta.json")
        m = json.loads(meta.read_text())
        if POST_STEPS:
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
