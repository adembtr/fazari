#!/usr/bin/env python3
"""Fazari local engine: a small web server for the team's own computer (NASA Space Apps 2026).

  python3 -I local/serve.py [--port 8765]

Then open http://127.0.0.1:8765/explore.html. Standard library only; bound to 127.0.0.1.

  /                   site/ (static)
  /jobs/<id>/...      blink.py products of a job (cache/jobs/<id>/), so ornek.html?data=/jobs/<id>/ works
  GET    /api/health
  POST   /api/jobs          {ra, dec, name?, bins?, cap?, mode?, preview?}  -> {id, cached, preview?}
  GET    /api/jobs/<id>     {state, progress: {done, total, bytes}, message, result_url, queue, ...}
  DELETE /api/jobs/<id>     cancel (stops the downloads and blink.py)
  POST   /api/jobs/<id>/priority  {"bin_um": 4.0}: that wavelength bin downloads next (progressive full job)
  GET    /api/jobs          list of known jobs
  GET    /api/finds         verified results, {schema, finds: [...]} from <cache>/finds.jsonl (pipeline/finds.py)

Three lanes, each running one job at a time in a background thread:
  full     the measurement (`uv run ... python -I local/job_worker.py --no-post`, see there): the
           job is "done" and viewable as soon as blink.py wrote meta.json and the frames
  preview  a quick look (`local/preview.py`): one wavelength, 2-4 exposures per season, small
           regions; it never waits for a full job. While a preview is queued or running, the
           full job does not start new image downloads (cooperative pause through the flag
           file <cache>/local/preview.active), so the preview gets the network first.
  post     the post-steps of a finished full job (job_worker.py --post-only: spectrum, candidates,
           faint), next to the next full job. Meanwhile the job status has
           "post_pending": {"steps", "state"} and "complete": false; "post" fills in step by step.
POST {"preview": true} with a full request also queues the preview of that point (unless the
full result is cached) and returns its id as {"preview": {"id", "cached"}}; right after it, in the
same lane, the quick decision (`local/quick.py`, "mode": "quick": a 0.05 deg box of every exposure,
"does the clicked object move?", preliminary) as {"quick": {"id", "cached"}}. A queued job's
status carries {"queue": {"lane", "ahead", "position", "wait_s"}}; a running one "eta_s".
Each job is one subprocess started in its own process group so that DELETE can stop it.
Results are cached by rounded position and options: posting the same point again returns the
finished job at once (unless the science code changed or "force": true). The blink code
(pipeline_hash) and each post-step of job_worker.POST_STEPS (post_step_hashes: its module and the
local modules it imports) have their own fingerprints; when only post-steps are new or changed,
the cached result is returned at once and just those steps are rerun in the post lane
(job_worker.py --post-only, status "post_pending"), as long as the job's cutouts are still kept. Everything is stored
under cache/ (gitignored), or under $FAZARI_CACHE when that is set (e.g. a fresh temporary
folder for uncached timing runs; the repo's cache/ is then not touched).
"""
import argparse
import ast
import hashlib
import http.server
import json
import math
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

VERSION = "1.0.0"
ROOT = Path(__file__).resolve().parent.parent                  # fazari/
SITE = ROOT / "site"
CACHE = Path(os.environ.get("FAZARI_CACHE") or ROOT / "cache").expanduser().resolve()
JOB_OUT = CACHE / "jobs"                                       # blink products, served at /jobs/
JOB_META = CACHE / "local" / "jobs"                            # request/status/log per job
PREVIEW_FLAG = CACHE / "local" / "preview.active"              # exists while a preview is queued/running
WORKER = ROOT / "local" / "job_worker.py"
PREVIEW_WORKER = ROOT / "local" / "preview.py"
QUICK_WORKER = ROOT / "local" / "quick.py"
UV_WITH = ["astropy", "reproject", "numpy", "scipy", "matplotlib", "pillow"]
LANES = ("full", "preview", "post")   # post: the post-steps of a finished full job (job_worker.py --post-only)
MODES = {"full": "full", "preview": "preview", "quick": "quick"}
SMALL_MODES = {"preview": "-pv", "quick": "-qd"}   # preview-lane jobs: one id per point (bins/cap/size do not apply)
EST_QUICK_S = 45.0                # a whole quick decision (all exposures, small boxes)
# rough durations for the queue estimate (seconds; measured on the team's computer)
EST_PREVIEW_S = 12.0              # a whole preview
EST_FULL_S = 300.0                # a full job before its image count is known
EST_READ_S_PER_IMAGE = 0.1        # blink.py: reading and aligning one exposure
EST_MEASURE_S_PER_IMAGE = 0.7     # blink.py after reading: detection, calibration, products (per exposure)
EST_POST_S = 180.0                # the post-steps of a full job (spectrum ~10 s, candidates + faint minutes)

BINS_ALL = [1.0, 1.5, 2.0, 3.0, 4.0, 4.6]
CAP_DEFAULT, CAP_MIN, CAP_MAX = 6, 1, 30
# Cutout size of FULL results (degrees). Default 0.2 deg (14 November 2026): the smallest download and
# the fastest first result. 0.3-0.6 deg stay on request ("cutout_deg"); 0.4 deg holds ~4-6x the Gaia
# reference stars of 0.2 deg and halves the field-calibration error (pipeline/ACCURACY.md). The preview
# keeps its own small region (local/preview.py REGION_DEG). The size is part of the job id and of the
# cutout store, so products of different sizes never mix; 0.2 deg jobs keep their old ids (no size tag).
FULL_CUTOUT_DEG = 0.2
LEGACY_CUTOUT_DEG = 0.2           # the local IRSA cutouts (../veri/real_spherex) and jobs made before
CUTOUT_CHOICES = (0.2, 0.3, 0.4, 0.5, 0.6)   # allowed "cutout_deg" in POST /api/jobs
MATCH_ARCSEC = 60.0               # a posted point this close to a known target is that target
NAME_MATCH_DEG = 0.25             # a matching name counts only if the point is also this close
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,95}$")
STATES_ACTIVE = ("queued", "finding", "downloading", "processing")
MAX_BODY = 64 * 1024


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def find_uv():
    for c in (shutil.which("uv"), Path.home() / ".local/bin/uv", Path.home() / ".cargo/bin/uv", "/usr/local/bin/uv"):
        if c and Path(c).is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def local_data_dir(size=LEGACY_CUTOUT_DEG):
    """Local IRSA cutouts of the challenge targets: 0.2 deg in FAZARI_LOCAL_DATA / FAZARI_DATA or
    ../veri/real_spherex; another size only in ../veri/real_spherex_<size> (pipeline/download.py --size)."""
    if size != LEGACY_CUTOUT_DEG:
        p = ROOT.parent / "veri" / f"real_spherex_{size:g}"
        return p if p.is_dir() else None
    env = os.environ.get("FAZARI_LOCAL_DATA") or os.environ.get("FAZARI_DATA")
    if env:
        return Path(env).expanduser().resolve()
    p = ROOT.parent / "veri" / "real_spherex"
    return p if p.is_dir() else None


def size_tag(size):
    """Job-id / store suffix of a cutout size: '' for 0.2 deg (old ids stay valid), else -s<size>."""
    return "" if size == LEGACY_CUTOUT_DEG else f"-s{size:g}"


WORKER_DIRS = (ROOT / "pipeline", ROOT / "local")       # where the workers import local modules from


def module_file(name, base=None):
    """Source file of a local module ('blink', 'detect.run', relative to `base` if given), else None."""
    parts = [x for x in name.split(".") if x]
    for d in ([base] if base else WORKER_DIRS):
        q = d.joinpath(*parts) if parts else d
        for f in (q.with_suffix(".py") if parts else None, q / "__init__.py"):
            if f and f.is_file():
                return f
    return None


def local_closure(files):
    """These source files and every local module they import, at any depth (also imports inside
    functions and __import__/import_module with a constant name; package __init__.py included)."""
    seen, todo = [], [Path(f) for f in files if f]
    while todo:
        f = todo.pop()
        if f in seen or not f.is_file():
            continue
        seen.append(f)
        try:
            tree = ast.parse(f.read_text(), str(f))
        except (SyntaxError, UnicodeDecodeError, OSError):
            continue
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [(a.name, None) for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = None
                if node.level:
                    base = f.parent
                    for _ in range(node.level - 1):
                        base = base.parent
                mod = node.module or ""
                names = [(mod, base)] if mod else []
                names += [(f"{mod}.{a.name}" if mod else a.name, base) for a in node.names]
            elif (isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant)
                  and isinstance(node.args[0].value, str)
                  and getattr(node.func, "id", getattr(node.func, "attr", None)) in ("__import__", "import_module")):
                names = [(node.args[0].value, None)]
            for n, base in names:
                parts = n.split(".")
                for i in range(1, len(parts) + 1):      # the package chain: detect/__init__.py, detect/run.py
                    m = module_file(".".join(parts[:i]), base)
                    if m:
                        todo.append(m)
    return seen


def _digest(files):
    h = hashlib.sha1()
    for p in sorted(set(files)):
        h.update(str(p.relative_to(ROOT)).encode() + b"\0" + p.read_bytes())
    return h.hexdigest()[:12]


def pipeline_hash(mode="full"):
    """Fingerprint of the science code of the blink: pipeline/blink.py and the local modules it
    imports, the target lists (a preview adds local/preview.py and its imports). A cached result
    is reused only while it is unchanged. The post-steps have their own (post_step_hashes)."""
    first = [ROOT / "pipeline" / "blink.py", ROOT / "pipeline" / "targets.json", ROOT / "pipeline" / "targets_extra.json"]
    if mode == "preview":
        first.append(PREVIEW_WORKER)
    if mode == "quick":
        first.append(QUICK_WORKER)
    rest = sorted(set(local_closure([f for f in first if f.suffix == ".py"])) - set(first))
    h = hashlib.sha1()
    for p in first + rest:                                   # blink.py alone gives the same value as before
        if p.exists():
            h.update(p.read_bytes())
    return h.hexdigest()[:12]


def declared_post_steps():
    """[(name, module)] of POST_STEPS in local/job_worker.py, read without importing it; module is
    None for an entry that is not ("name", "module", "function") string constants."""
    try:
        tree = ast.parse(WORKER.read_text(), str(WORKER))
    except (SyntaxError, OSError):
        return []
    steps = []

    def entry(t):
        if isinstance(t, ast.Tuple) and t.elts and isinstance(t.elts[0], ast.Constant):
            mod = t.elts[1] if len(t.elts) >= 3 else None
            steps.append((t.elts[0].value, mod.value if isinstance(mod, ast.Constant) and isinstance(mod.value, str) else None))

    for node in tree.body:
        if (isinstance(node, ast.Assign) and isinstance(node.value, ast.List)
                and any(isinstance(t, ast.Name) and t.id == "POST_STEPS" for t in node.targets)):
            steps = []
            for e in node.value.elts:
                entry(e)
        elif (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and node.value.args
              and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == "append"
              and isinstance(node.value.func.value, ast.Name) and node.value.func.value.id == "POST_STEPS"):
            entry(node.value.args[0])
    return steps


def post_step_hashes():
    """{step name: fingerprint of its module and the local modules it imports} (a step given as a
    function: of local/job_worker.py). A cached full job whose recorded step fingerprint differs
    (or is missing: a new step) gets that step rerun alone (worker --post-only)."""
    out = {}
    for name, mod in declared_post_steps():
        parts = (mod or "").split(".")
        chain = [module_file(".".join(parts[:i])) for i in range(1, len(parts) + 1)] if mod else []
        out[name] = _digest(local_closure(chain) if chain and chain[-1] else [WORKER])
    return out


def inputs_ready(jid):
    """The cutouts of a finished job are still there (cache/local/inputs/<id>/{dr1,qr3}/*.fits)."""
    d = CACHE / "local" / "inputs" / jid
    return any(f.exists() for c in ("dr1", "qr3") if (d / c).is_dir() for f in (d / c).glob("*.fits"))


def sep_arcsec(ra1, dec1, ra2, dec2):
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(r1 - r2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c)))) * 3600


def moved(t, epoch=2026.0):
    """Catalogue position moved linearly to `epoch` (as download.py centres the cutouts)."""
    dt = epoch - float(t.get("epoch", 2016.0))
    dec = t["dec"] + (t.get("pmdec") or 0) / 3.6e6 * dt
    ra = t["ra"] + (t.get("pmra") or 0) / 3.6e6 * dt / max(1e-6, math.cos(math.radians(t["dec"])))
    return ra % 360.0, dec


def norm(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def load_json(p, default):
    try:
        return json.loads(Path(p).read_text())
    except Exception:
        return default


def read_finds():
    """GET /api/finds: the verified results that the "finds" post-step appended to <cache>/finds.jsonl
    (pipeline/finds.py), oldest first; a damaged line is skipped. The same shape as a static finds.json."""
    out = []
    try:
        with open(CACHE / "finds.jsonl", encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("job_id"):
                    out.append(r)
    except OSError:
        pass
    return {"schema": "fazari-finds/1", "finds": out}


def resolve_target(ra, dec, name, extra):
    """Which target is this? Returns (slug, target dict for blink.py, local target key or None).

    1. one of pipeline/targets.json (by name or position) -> its catalogue entry; local IRSA
       cutouts are used when present;
    2. a point of site/data/categories.json with known proper motion -> that motion;
    3. else a fixed sky point (no motion)."""
    cat = {k: v for k, v in load_json(ROOT / "pipeline" / "targets.json", {}).items() if not k.startswith("_")}
    extra_cat = load_json(ROOT / "pipeline" / "targets_extra.json", {})
    ld = local_data_dir()
    for key, t in cat.items():
        r26, d26 = moved(t)
        d = min(sep_arcsec(ra, dec, r26, d26), sep_arcsec(ra, dec, t["ra"], t["dec"]))
        by_name = name and norm(name) in (norm(key), norm(t.get("name")))
        if d <= MATCH_ARCSEC or (by_name and d <= NAME_MATCH_DEG * 3600):
            tt = dict(t)
            for k, v in (extra_cat.get(key) or {}).items():
                tt.setdefault(k, v)
            tt.setdefault("plx", 0.0)
            tt["gaia_cache_key"] = key
            tt["catalog_key"] = key
            local = key if ld and (ld / key).is_dir() and any((ld / key).glob("*/*.fits")) else None
            return key, tt, local
    cats = load_json(SITE / "data" / "categories.json", {}).get("categories", [])
    for c in cats:
        for p in c.get("points", []):
            try:
                pr, pd = float(p.get("ra_2026", p["ra"])), float(p.get("dec_2026", p["dec"]))
            except (KeyError, TypeError, ValueError):
                continue
            by_name = name and norm(name) == norm(p.get("name"))
            d = min(sep_arcsec(ra, dec, pr, pd), sep_arcsec(ra, dec, float(p["ra"]), float(p["dec"])))
            if (d <= MATCH_ARCSEC or (by_name and d <= NAME_MATCH_DEG * 3600)) and p.get("pmra") is not None:
                t = {"name": p.get("name") or name, "kind": "brightness" if c.get("id") == "variable_stars" else "motion",
                     "ra": float(p["ra"]), "dec": float(p["dec"]), "epoch": float(p.get("epoch", 2016.0)),
                     "pmra": float(p["pmra"]), "pmdec": float(p.get("pmdec") or 0),
                     # parallax (mas): the point's catalogue value, else the request's, else 0
                     "plx": float(p["parallax"]) if p.get("parallax") is not None else extra.get("plx", 0.0),
                     "plx_source": (p.get("parallax_source") or "site/data/categories.json") if p.get("parallax") is not None
                     else ("given in the request" if extra.get("plx") else ""),
                     "gaia_dr3": None, "notes": p.get("source", ""),
                     "astrometry_label": "catalogue (site/data/categories.json)"}
                return re.sub(r"[^a-z0-9]+", "_", str(p.get("id", "point")).lower())[:24] or "point", t, None
    label = name or f"Sky field RA {ra:.4f} Dec {dec:+.4f}"
    t = {"name": label, "kind": extra.get("kind") or "motion", "ra": ra, "dec": dec,
         "epoch": extra.get("epoch", 2026.0), "pmra": extra.get("pmra", 0.0), "pmdec": extra.get("pmdec", 0.0),
         "plx": extra.get("plx", 0.0), "plx_source": "given in the request" if extra.get("plx") else "",
         "gaia_dr3": None, "astrometry_label": "requested position",
         "notes": "Ad-hoc point from the local engine" + (" (proper motion given in the request)"
                                                         if extra.get("pmra") or extra.get("pmdec") else
                                                         " (no proper motion assumed)")}
    return "field", t, None


# ------------------------------------------------------------------------------- validation
class BadRequest(Exception):
    pass


def num(v, what, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise BadRequest(f"{what} must be a number")
    try:
        x = float(v)
    except ValueError:
        raise BadRequest(f"{what} must be a number") from None
    if not math.isfinite(x) or not lo <= x <= hi:
        raise BadRequest(f"{what} must be within {lo}..{hi}")
    return x


def parse_request(body):
    if not isinstance(body, dict):
        raise BadRequest("JSON object expected")
    ra = num(body.get("ra"), "ra", 0.0, 360.0) % 360.0
    dec = num(body.get("dec"), "dec", -90.0, 90.0)
    name = body.get("name")
    if name is not None:
        if not isinstance(name, str):
            raise BadRequest("name must be a string")
        name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()[:100] or None
    bins = body.get("bins")
    if bins is None:
        bins = list(BINS_ALL)
    else:
        if not isinstance(bins, list) or not bins or len(bins) > len(BINS_ALL):
            raise BadRequest(f"bins must be a non-empty list from {BINS_ALL}")
        out = set()
        for b in bins:
            x = num(b, "bin", 0.5, 6.0)
            m = [c for c in BINS_ALL if abs(c - x) < 0.051]
            if not m:
                raise BadRequest(f"unknown bin {b}; choose from {BINS_ALL} (micron)")
            out.add(m[0])
        bins = sorted(out)
    cap = body.get("cap", CAP_DEFAULT)
    if isinstance(cap, bool) or not isinstance(cap, (int, float)) or int(cap) != cap or not CAP_MIN <= cap <= CAP_MAX:
        raise BadRequest(f"cap must be an integer within {CAP_MIN}..{CAP_MAX}")
    mode = body.get("mode", "full")
    if mode not in MODES:
        raise BadRequest("mode must be 'full', 'preview' or 'quick'")
    if body.get("preview") not in (None, True, False):
        raise BadRequest("preview must be true or false")
    size = num(body.get("cutout_deg", FULL_CUTOUT_DEG), "cutout_deg", 0.1, 1.0)
    if not any(abs(size - c) < 1e-6 for c in CUTOUT_CHOICES):
        raise BadRequest(f"cutout_deg must be one of {list(CUTOUT_CHOICES)}")
    size = round(size, 1)
    extra = {}
    if body.get("pmra") is not None:
        extra["pmra"] = num(body["pmra"], "pmra", -20000, 20000)
    if body.get("pmdec") is not None:
        extra["pmdec"] = num(body["pmdec"], "pmdec", -20000, 20000)
    if body.get("epoch") is not None:
        extra["epoch"] = num(body["epoch"], "epoch", 1900, 2100)
    if body.get("parallax") is not None:                     # mas; 0 = no parallax term
        extra["plx"] = num(body["parallax"], "parallax", 0, 2000)
    if body.get("kind") is not None:
        if body["kind"] not in ("motion", "brightness"):
            raise BadRequest("kind must be 'motion' or 'brightness'")
        extra["kind"] = body["kind"]
    return {"ra": ra, "dec": dec, "name": name, "bins": bins, "cap": int(cap), "extra": extra,
            "force": body.get("force") is True, "mode": mode, "preview": body.get("preview") is True,
            "cutout_deg": size}


def job_identity(p):
    slug, target, local = resolve_target(p["ra"], p["dec"], p["name"], p["extra"])
    ra3, dec3 = round(p["ra"], 3) % 360.0, round(p["dec"], 3)
    mask = sum(1 << BINS_ALL.index(b) for b in p["bins"])
    preview = p.get("mode") in SMALL_MODES                   # one id per point: bins/cap do not apply
    suffix = SMALL_MODES.get(p.get("mode"), "")
    size = LEGACY_CUTOUT_DEG if preview else p.get("cutout_deg", FULL_CUTOUT_DEG)
    ldir = local_data_dir()
    if local and not preview and size != LEGACY_CUTOUT_DEG:
        # a challenge target at another size: its local cutouts of that size if downloaded
        # (pipeline/download.py --size), else the 0.2 deg ones (no multi-GB download on a click)
        ls = local_data_dir(size)
        if ls and (ls / local).is_dir() and any((ls / local).glob("*/*.fits")):
            ldir = ls
        else:
            size = LEGACY_CUTOUT_DEG
    if local:                                                # all local cutouts: options do not apply
        jid = f"{slug}-local" + (suffix if preview else size_tag(size))
        center = {"ra": target["ra"], "dec": target["dec"]}
    else:
        # motion hash: proper motion + epoch, and the parallax when there is one (ids of jobs without
        # parallax stay as they were; a job run with parallax 0 is never reused for a parallax request)
        motion = [target["pmra"], target["pmdec"], target["epoch"]] + ([target["plx"]] if target.get("plx") else [])
        pm = "" if not (target.get("pmra") or target.get("pmdec") or target.get("plx")) else \
            "-pm" + hashlib.sha1(json.dumps(motion).encode()).hexdigest()[:4]
        opts = suffix if preview else f"-c{p['cap']}-b{mask}{size_tag(size)}"
        jid = f"{slug}-{ra3:.3f}{'n' if dec3 >= 0 else 's'}{abs(dec3):.3f}{opts}{pm}"
        center = {"ra": ra3, "dec": dec3}
        if target.get("pmra") or target.get("pmdec"):            # centre on the 2026.0 position
            r, d = moved(target)
            center = {"ra": round(r, 6), "dec": round(d, 6)}
    point_key = f"{center['ra']:.3f}_{center['dec']:+.3f}"
    return jid, {"id": jid, "target": target, "center": center, "point_key": point_key,
                 "local_target": local, "local_data": str(ldir) if ldir else None,
                 "bins": p["bins"], "cap": p["cap"], "mode": p.get("mode", "full"), "cutout_deg": size,
                 "request": dict({k: p[k] for k in ("ra", "dec", "name", "bins", "cap")},
                                 cutout_deg=p.get("cutout_deg", FULL_CUTOUT_DEG))}


# ------------------------------------------------------------------------------- jobs
def lane_of(j):
    return "preview" if (j.get("req") or {}).get("mode") in SMALL_MODES else "full"


class Jobs:
    def __init__(self, uv):
        self.uv = uv
        self.lock = threading.Lock()
        self.jobs = {}                                       # id -> dict(state, ...)
        self.queues = {lane: queue.Queue() for lane in LANES}
        self.running = {lane: None for lane in LANES}        # lane -> (id, Popen)
        JOB_META.mkdir(parents=True, exist_ok=True)
        JOB_OUT.mkdir(parents=True, exist_ok=True)
        for d in sorted(JOB_META.iterdir()):
            st = load_json(d / "status.json", None)
            req = load_json(d / "request.json", None)
            if not st or not req or not ID_RE.match(d.name):
                continue
            state = st.get("state")
            if state in STATES_ACTIVE:                       # the server stopped while it ran
                state, st["message"] = "error", "interrupted (the local server was stopped); post it again"
            self.jobs[d.name] = {"state": state, "status": st, "pipeline": st.get("pipeline"), "req": req,
                                 "post_hashes": st.get("post_hashes") or {}}
            pend = (st.get("post_pending") or {}).get("steps")
            if state == "done" and pend and inputs_ready(d.name):   # post-steps cut off by a server stop
                self._queue_post(d.name, self.jobs[d.name], pend, write=False)
        self._set_flag()                                     # nothing queued yet: clears a stale flag
        for lane in LANES:
            threading.Thread(target=self._runner, args=(lane,), daemon=True, name=f"job-runner-{lane}").start()

    @property
    def current(self):
        """The running full job (id, Popen) or None (kept for /api/health and older callers)."""
        return self.running["full"]

    def _set_flag(self):
        """<cache>/local/preview.active exists while a preview is queued or running (lock held or init).
        The full job's worker does not start new image downloads while it exists."""
        isprev = lambda j: (j.get("req") or {}).get("mode") == "preview"   # the quick decision does not pause it
        run = self.running["preview"]
        busy = (run is not None and isprev(self.jobs.get(run[0]) or {})) or any(
            j["state"] == "queued" and isprev(j) for j in self.jobs.values())
        try:
            if busy:
                PREVIEW_FLAG.parent.mkdir(parents=True, exist_ok=True)
                PREVIEW_FLAG.write_text(json.dumps({"since": time.time()}))
            elif PREVIEW_FLAG.exists():
                PREVIEW_FLAG.unlink()
        except OSError as e:
            log("preview flag:", e)

    def _queue_post(self, jid, j, names, write=True):
        """Queue post-steps of a finished job in the post lane (lock held or init). The job stays
        done and viewable; status.json keeps post_pending so that a server restart picks them up."""
        hashes = post_step_hashes()
        names = [n for n in hashes if n in names]            # known steps, in POST_STEPS order
        if not names:
            return False
        j["post_only"] = {"steps": names, "state": "queued", "queued": time.time(),
                          "hashes": {n: hashes[n] for n in names}}
        j["status"] = dict(j["status"], post_pending={"steps": names, "state": "queued"})
        if write:
            self._write_status(jid, j["status"])
        self.queues["post"].put(jid)
        log("queued post-steps", jid, ",".join(names))
        return True

    def submit(self, p):
        jid, req = job_identity(p)
        mode = req["mode"]
        ph = pipeline_hash(mode)
        steps = post_step_hashes() if mode == "full" else {}
        with self.lock:
            j = self.jobs.get(jid)
            if j and j["state"] in STATES_ACTIVE:
                return jid, False
            if j and j.get("post_only"):                     # viewable; its post-steps are queued/running
                return jid, True
            if (j and j["state"] == "done" and not p["force"] and j.get("pipeline") == ph
                    and (JOB_OUT / jid / "meta.json").exists()):
                stale = [n for n, h in steps.items() if (j.get("post_hashes") or {}).get(n) != h]
                if not stale:                                # complete
                    return jid, True
                if inputs_ready(jid) and self._queue_post(jid, j, stale):   # only the new/changed post-steps
                    return jid, True
            d = JOB_META / jid
            d.mkdir(parents=True, exist_ok=True)
            (d / "request.json").write_text(json.dumps(req, indent=1))
            lane = "preview" if mode in SMALL_MODES else "full"
            st = {"state": "queued", "mode": mode, "progress": {"done": 0, "total": 0, "bytes": 0},
                  "message": "waiting for the job before it" if self.running[lane] else "starting",
                  "pipeline": ph, "queued": time.time()}
            self._write_status(jid, st)
            self.jobs[jid] = {"state": "queued", "status": st, "pipeline": ph, "req": req, "post_expected": steps}
            if lane == "preview":
                self._set_flag()
            self.queues[lane].put(jid)
            log("queued", jid)
            return jid, False

    def _write_status(self, jid, st):
        p = JOB_META / jid / "status.json"
        tmp = p.with_suffix(".srv.tmp")
        tmp.write_text(json.dumps(st, indent=1))
        os.replace(tmp, p)

    def _remaining(self, jid, lane, st=None):
        """Rough seconds until a running job is done, from its live status."""
        st = st or load_json(JOB_META / jid / "status.json", {}) or {}
        now = time.time()
        started = st.get("started") or now
        if lane == "preview":
            est = EST_QUICK_S if st.get("mode") == "quick" or "-qd" in jid else EST_PREVIEW_S
            return max(2.0, est - (now - started))
        if st.get("post_running") or str(st.get("message", "")).startswith(("post-step", "faint-object")):
            return EST_POST_S / 2
        pr, tm = st.get("progress") or {}, st.get("timings") or {}
        done, total = int(pr.get("done") or 0), int(pr.get("total") or 0)
        proc = (EST_READ_S_PER_IMAGE + EST_MEASURE_S_PER_IMAGE) * total
        if st.get("state") == "downloading" and total and done:
            t0 = started + tm.get("finding", 0)
            return (now - t0) / done * (total - done) + proc
        if st.get("state") == "downloading" and total:
            return EST_FULL_S
        if st.get("state") == "processing" and total and done < total:
            t0 = started + tm.get("finding", 0) + tm.get("downloading", 0)
            rate = (now - t0) / done if done else EST_READ_S_PER_IMAGE
            return rate * (total - done) + EST_MEASURE_S_PER_IMAGE * total
        if st.get("state") == "processing" and total:          # all read: measuring since the last update
            return max(10.0, EST_MEASURE_S_PER_IMAGE * total - (now - (st.get("updated") or now)))
        return EST_FULL_S

    def _queue_info(self, jid, j):
        """Lane, jobs ahead (running one included) and a rough wait for a queued job (lock held)."""
        lane = lane_of(j)
        t = j["status"].get("queued", 0)
        ahead = [k for k, o in self.jobs.items() if k != jid and o["state"] == "queued" and lane_of(o) == lane
                 and o["status"].get("queued", 0) <= t]
        run = self.running[lane]
        wait = (self._remaining(run[0], lane) if run else 0.0) + len(ahead) * (EST_PREVIEW_S if lane == "preview" else EST_FULL_S)
        n = len(ahead) + (1 if run else 0)
        return {"lane": lane, "ahead": n, "position": n + 1, "wait_s": round(wait)}

    def get(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                return None
            st = dict(j["status"])
            if j["state"] in ("finding", "downloading", "processing"):
                live = load_json(JOB_META / jid / "status.json", None)
                if live and live.get("state") in ("finding", "downloading", "processing"):
                    st = live
                    j["state"] = live["state"]
            state = j["state"]
            lane = lane_of(j)
            queue_info = self._queue_info(jid, j) if state == "queued" else None
            preview_running = self.running["preview"] is not None or any(
                o["state"] == "queued" and lane_of(o) == "preview" for o in self.jobs.values())
            post_only = dict(j["post_only"]) if j.get("post_only") else None
            if post_only and post_only["state"] == "running":       # results of the steps done so far
                live = load_json(JOB_META / jid / "status.json", None)
                if live and live.get("post") is not None:
                    st["post"] = live["post"]
        out = {"id": jid, "state": state, "mode": lane,
               "progress": {k: int(st.get("progress", {}).get(k, 0) or 0) for k in ("done", "total", "bytes")},
               "message": st.get("message", ""), "result_url": f"/jobs/{jid}/"}
        if j["req"]:
            out["target"] = j["req"]["target"].get("name")
            out["center"] = j["req"].get("center")
            out["source"] = "local IRSA cutouts" if j["req"].get("local_target") else "SPHEREx S3"
        for k in ("timings", "images", "result", "cached", "skipped", "wall_seconds", "post", "partial",
                  "progressive", "smaller"):                 # progressive: per-bin stages (job_worker.Staged)
            if st.get(k) is not None:
                out[k] = st[k]
        if queue_info:
            out["queue"] = queue_info
        elif state in ("finding", "downloading", "processing"):
            out["queue"] = {"lane": lane, "ahead": 0, "position": 0, "wait_s": 0}
            out["eta_s"] = round(self._remaining(jid, lane, st))
            if lane == "full" and preview_running and state in ("finding", "downloading"):
                out["paused_for_preview"] = True
        if state == "done":
            out["viewer"] = f"/ornek.html?data=/jobs/{jid}/"
        if post_only:                                        # viewable, post-steps still queued/running
            out["post_pending"] = {"steps": post_only["steps"], "state": post_only["state"]}
        out["complete"] = state == "done" and not post_only  # blink and every post-step finished
        return out

    def list(self):
        with self.lock:
            ids = list(self.jobs)
        return [self.get(i) for i in ids]

    def counts(self):
        with self.lock:
            q = {lane: sum(1 for o in self.jobs.values() if o["state"] == "queued" and lane_of(o) == lane) for lane in LANES}
            q["post"] = sum(1 for o in self.jobs.values() if (o.get("post_only") or {}).get("state") == "queued")
            r = {lane: (self.running[lane][0] if self.running[lane] else None) for lane in LANES}
        return q, r

    def cancel(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                return None
            if j["state"] not in STATES_ACTIVE:
                return j["state"]
            j["state"] = "cancelled"
            st = dict(j["status"], state="cancelled", message="cancelled")
            j["status"] = st
            lane = lane_of(j)
            cur = self.running[lane]
            if lane == "preview":
                self._set_flag()
        if cur and cur[0] == jid:
            stop(cur[1])
        self._write_status(jid, st)
        log("cancelled", jid)
        return "cancelled"

    def stop_all(self):
        for lane in LANES:
            cur = self.running[lane]
            if cur:
                stop(cur[1])

    def _runner(self, lane):
        while True:
            jid = self.queues[lane].get()
            with self.lock:
                j = self.jobs.get(jid)
                post = lane == "post"
                if not j or (post and not (j["state"] == "done" and (j.get("post_only") or {}).get("state") == "queued")) \
                        or (not post and j["state"] != "queued"):
                    continue
            try:
                self._run(jid, j, lane, post_only=j["post_only"]["steps"] if post else None)
            except Exception as e:                           # keep the runner alive
                log("runner error", jid, e)
                with self.lock:
                    if post:
                        j.pop("post_only", None)
                    else:
                        j["state"] = "error"
                        j["status"] = dict(j["status"], state="error", message=f"local server error: {e}")
                    self.running[lane] = None
                    if lane == "preview":
                        self._set_flag()

    def _run(self, jid, j, lane, post_only=None):
        d = JOB_META / jid
        if not self.uv:
            raise RuntimeError("uv was not found (install it: https://docs.astral.sh/uv/)")
        cmd = [self.uv, "run", "--no-project", "--quiet"]
        for w in UV_WITH:
            cmd += ["--with", w]
        worker = (QUICK_WORKER if j["req"].get("mode") == "quick" else PREVIEW_WORKER) if lane == "preview" else WORKER
        cmd += ["python", "-I", str(worker), "--job", str(d)]
        if post_only:
            cmd += ["--post-only", ",".join(post_only)]
        elif lane == "full":
            cmd += ["--no-post"]                             # viewable after the blink; post-steps in their lane
        env = dict(os.environ, PYTHONUNBUFFERED="1", FAZARI_CACHE=str(CACHE), FAZARI_S3_CACHE=str(CACHE / "s3"),
                   FAZARI_PREVIEW_FLAG=str(PREVIEW_FLAG))
        t0 = time.time()
        with open(d / "log.txt", "a") as logf:
            logf.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(cmd)}\n")
            logf.flush()
            with self.lock:
                if post_only:
                    if not j.get("post_only"):
                        return
                    j["post_only"]["state"] = "running"
                    j["status"] = dict(j["status"], post_pending={"steps": post_only, "state": "running"})
                    self._write_status(jid, j["status"])
                elif j["state"] != "queued":
                    return
                else:
                    j["state"] = "finding"
                proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=logf, stderr=subprocess.STDOUT,
                                        stdin=subprocess.DEVNULL, env=env, start_new_session=True)
                self.running[lane] = (jid, proc)
                if lane == "preview":
                    self._set_flag()                         # refresh its time stamp
            log("started", jid, "pid", proc.pid)
            rc = proc.wait()
        with self.lock:
            self.running[lane] = None
            st = load_json(d / "status.json", {}) or {}
            if post_only:                                    # the job stays done; record the steps that ran
                po = j.pop("post_only", None) or {}
                ran = st.get("post") or {}
                if rc == 0:
                    j["post_hashes"] = dict(j.get("post_hashes") or {},
                                            **{n: h for n, h in po.get("hashes", {}).items() if n in ran})
                st = dict(st, state="done", pipeline=j["pipeline"], post_hashes=j.get("post_hashes") or {})
                st.pop("post_running", None)
                st.pop("post_pending", None)
                st.pop("post_step", None)
                j["status"] = st
                self._write_status(jid, st)
                log("post-steps", jid, "exit", rc, f"{round(time.time() - t0, 1)} s")
                return
            if j["state"] == "cancelled":
                st = dict(st, state="cancelled", message="cancelled")
            elif rc != 0 and st.get("state") != "error":
                st = dict(st, state="error", message=f"the job stopped (exit code {rc}); see {d / 'log.txt'}")
            elif rc == 0 and st.get("state") != "done":
                st = dict(st, state="error", message="the job ended without a result")
            st["pipeline"] = j["pipeline"]
            st["post_hashes"] = j["post_hashes"] = {n: h for n, h in (j.get("post_expected") or {}).items()
                                                    if n in (st.get("post") or {})}
            st["mode"] = lane
            st["wall_seconds"] = round(time.time() - t0, 1)
            j["state"], j["status"] = st["state"], st
            missing = [n for n in (j.get("post_expected") or {}) if n not in j["post_hashes"]]
            if not (st["state"] == "done" and lane == "full" and missing and self._queue_post(jid, j, missing, write=False)):
                st.pop("post_pending", None)
            self._write_status(jid, j["status"])
            if lane == "preview":
                self._set_flag()
        log("finished", jid, st["state"], f"{st['wall_seconds']} s", st.get("message", ""))


def stop(proc):
    """SIGTERM to the whole process group (uv, python, download threads), SIGKILL after 5 s."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(50):
        if proc.poll() is not None:
            return
        time.sleep(0.1)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


# ------------------------------------------------------------------------------- HTTP
class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "FazariLocal/" + VERSION
    jobs = None
    port = 8765
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map,
                          **{".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
                             ".wasm": "application/wasm", ".csv": "text/csv", ".gz": "application/gzip"})

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, fmt, *args):
        if "/api/jobs/" in (self.path or "") and self.command == "GET":
            return                                           # polling noise
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # --- safety: only this machine's own pages may use the API (DNS rebinding / CSRF)
    def _host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        return host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}", "127.0.0.1", "localhost")

    def _origin_ok(self):
        o = self.headers.get("Origin")
        return o is None or o.lower() in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}")

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.path.startswith("/api/") or self.path.startswith("/jobs/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(b)

    def _route(self):
        return urllib.parse.urlsplit(self.path).path

    def translate_path(self, path):
        """site/ for everything, cache/jobs/<id>/ for /jobs/<id>/...; never outside those folders."""
        p = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        parts = [s for s in p.split("/") if s]
        if any(s in (".", "..") or "\x00" in s for s in parts):
            return str(SITE / "__forbidden__")
        if parts[:1] == ["jobs"]:
            if len(parts) < 2 or not ID_RE.match(parts[1]):
                return str(SITE / "__forbidden__")
            base = (JOB_OUT / parts[1]).resolve()
            target = base.joinpath(*parts[2:]).resolve()
            if target != base and base not in target.parents:
                return str(SITE / "__forbidden__")
            return str(target) + ("/" if p.endswith("/") else "")
        target = SITE.joinpath(*parts).resolve()
        if target != SITE.resolve() and SITE.resolve() not in target.parents:
            return str(SITE / "__forbidden__")
        return str(target) + ("/" if p.endswith("/") and parts else "")

    def list_directory(self, path):
        self.send_error(404, "No directory listing")
        return None

    def do_GET(self):
        if not self._host_ok():
            return self._json(403, {"error": "forbidden host"})
        r = self._route()
        if r == "/api/health":
            queued, running = self.jobs.counts()
            return self._json(200, {"ok": True, "engine": "python", "version": VERSION,
                                    "uv": bool(self.jobs.uv), "local_data": bool(local_data_dir()),
                                    "running": running["full"], "running_preview": running["preview"],
                                    "running_post": running["post"],
                                    "queued": queued, "lanes": list(LANES), "preview": True})
        if r == "/api/jobs":
            return self._json(200, {"jobs": self.jobs.list()})
        if r == "/api/finds":
            return self._json(200, read_finds())
        if r.startswith("/api/jobs/"):
            jid = urllib.parse.unquote(r[len("/api/jobs/"):]).strip("/")
            if not ID_RE.match(jid):
                return self._json(400, {"error": "bad job id"})
            j = self.jobs.get(jid)
            return self._json(200, j) if j else self._json(404, {"error": "no such job"})
        if r.startswith("/api/"):
            return self._json(404, {"error": "unknown endpoint"})
        return super().do_GET()

    def do_HEAD(self):
        if not self._host_ok():
            return self._json(403, {"error": "forbidden host"})
        if self._route().startswith("/api/"):
            return self.do_GET()
        return super().do_HEAD()

    def do_POST(self):
        if not self._host_ok() or not self._origin_ok():
            return self._json(403, {"error": "forbidden origin"})
        m = re.match(r"^/api/jobs/([^/]+)/priority$", self._route())
        if m:                                                # {"bin_um": 4.0}: that bin downloads next
            jid = urllib.parse.unquote(m.group(1))
            if not ID_RE.match(jid) or not (JOB_META / jid / "request.json").exists():
                return self._json(404, {"error": "no such job"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
                um = float(json.loads(self.rfile.read(n) if 0 < n <= MAX_BODY else b"{}").get("bin_um"))
            except (ValueError, TypeError, json.JSONDecodeError):
                return self._json(400, {"error": 'body {"bin_um": <number>} required'})
            tmp = JOB_META / jid / "priority.json.tmp"
            tmp.write_text(json.dumps({"bin_um": um, "time": time.time()}))
            os.replace(tmp, JOB_META / jid / "priority.json")
            # the worker applies it within ~1 s; answer with the NEW order (the worker's, or the same rule here)
            prog = {}
            for _ in range(15):
                prog = (load_json(JOB_META / jid / "status.json", {}) or {}).get("progressive") or {}
                if prog.get("priority") == um:
                    return self._json(200, {"ok": True, "bin_um": um, "order": prog.get("order"), "applied": True})
                time.sleep(0.1)
            order = list(prog.get("order") or [])
            state = {b.get("bin_um"): b.get("state") for b in prog.get("bins") or []}
            if um in order and state.get(um) in ("queued", "failed"):   # to the front of the bins still to load
                order.remove(um)
                k = next((i for i, b in enumerate(order) if state.get(b) == "queued"), len(order))
                order.insert(k, um)
            return self._json(200, {"ok": True, "bin_um": um, "order": order, "applied": False})
        if self._route() != "/api/jobs":
            return self._json(404, {"error": "unknown endpoint"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if not 0 < n <= MAX_BODY:
            return self._json(400, {"error": "JSON body required (max 64 KB)"})
        try:
            body = json.loads(self.rfile.read(n))
            p = parse_request(body)
            jid, cached = self.jobs.submit(p)
            out = {"id": jid, "cached": cached, "mode": p["mode"]}
            if p["mode"] == "full" and p["preview"]:          # quick look first, unless the result is ready
                out["preview"] = None
                out["quick"] = None
                if not cached:
                    pid, pcached = self.jobs.submit(dict(p, mode="preview"))
                    out["preview"] = {"id": pid, "cached": pcached}
                    qid, qcached = self.jobs.submit(dict(p, mode="quick"))   # after the preview, same lane
                    out["quick"] = {"id": qid, "cached": qcached}
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid JSON"})
        except BadRequest as e:
            return self._json(400, {"error": str(e)})
        return self._json(200, out)

    def do_DELETE(self):
        if not self._host_ok() or not self._origin_ok():
            return self._json(403, {"error": "forbidden origin"})
        r = self._route()
        if not r.startswith("/api/jobs/"):
            return self._json(404, {"error": "unknown endpoint"})
        jid = urllib.parse.unquote(r[len("/api/jobs/"):]).strip("/")
        if not ID_RE.match(jid):
            return self._json(400, {"error": "bad job id"})
        st = self.jobs.cancel(jid)
        if st is None:
            return self._json(404, {"error": "no such job"})
        return self._json(200, {"id": jid, "state": st})


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="Fazari local engine (127.0.0.1 only)")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    if not 1024 <= a.port <= 65535:
        ap.error("port must be within 1024..65535")
    uv = find_uv()
    Handler.jobs = Jobs(uv)
    Handler.port = a.port
    try:
        srv = Server(("127.0.0.1", a.port), Handler)
    except OSError as e:
        sys.exit(f"cannot listen on 127.0.0.1:{a.port}: {e} (is the server already running?)")
    page = "explore.html" if (SITE / "explore.html").exists() else "ornek.html"
    log(f"Fazari local engine {VERSION}: http://127.0.0.1:{a.port}/{page}")
    log(f"site {SITE}; jobs {JOB_OUT}; uv {uv or 'NOT FOUND'}; local data {local_data_dir() or 'none'}")
    log("Ctrl+C stops the server.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Handler.jobs.stop_all()
        srv.server_close()


if __name__ == "__main__":
    main()
