#!/usr/bin/env python3
"""Fazari local engine: a small web server for the team's own computer (NASA Space Apps 2026).

  python3 -I local/serve.py [--port 8765]

Then open http://127.0.0.1:8765/explore.html. Standard library only; bound to 127.0.0.1.

  /                   site/ (static)
  /jobs/<id>/...      blink.py products of a job (cache/jobs/<id>/), so ornek.html?data=/jobs/<id>/ works
  GET    /api/health
  POST   /api/jobs          {ra, dec, name?, bins?, cap?}  -> {id}
  GET    /api/jobs/<id>     {state, progress: {done, total, bytes}, message, result_url, ...}
  DELETE /api/jobs/<id>     cancel (stops the downloads and blink.py)
  GET    /api/jobs          list of known jobs

Jobs run one at a time in a background thread. Each job is one subprocess
(`uv run ... python -I local/job_worker.py`, see there), started in its own process group
so that DELETE can stop it. Results are cached by rounded position and options: posting the
same point again returns the finished job at once (unless pipeline/blink.py changed or
"force": true). Everything is stored under cache/ (gitignored).
"""
import argparse
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
CACHE = ROOT / "cache"
JOB_OUT = CACHE / "jobs"                                       # blink products, served at /jobs/
JOB_META = CACHE / "local" / "jobs"                            # request/status/log per job
WORKER = ROOT / "local" / "job_worker.py"
UV_WITH = ["astropy", "reproject", "numpy", "scipy", "matplotlib", "pillow"]

BINS_ALL = [1.0, 1.5, 2.0, 3.0, 4.0, 4.6]
CAP_DEFAULT, CAP_MIN, CAP_MAX = 6, 1, 30
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


def local_data_dir():
    env = os.environ.get("FAZARI_LOCAL_DATA") or os.environ.get("FAZARI_DATA")
    if env:
        return Path(env).expanduser().resolve()
    p = ROOT.parent / "veri" / "real_spherex"
    return p if p.is_dir() else None


def pipeline_hash():
    """Fingerprint of the science code: a cached result is reused only while it is unchanged."""
    h = hashlib.sha1()
    for p in (ROOT / "pipeline" / "blink.py", ROOT / "pipeline" / "targets.json",
              ROOT / "pipeline" / "targets_extra.json"):
        if p.exists():
            h.update(p.read_bytes())
    return h.hexdigest()[:12]


# ------------------------------------------------------------------------------- targets
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
                     "pmra": float(p["pmra"]), "pmdec": float(p.get("pmdec") or 0), "plx": float(p.get("parallax") or 0),
                     "gaia_dr3": None, "notes": p.get("source", ""),
                     "astrometry_label": "catalogue (site/data/categories.json)"}
                return re.sub(r"[^a-z0-9]+", "_", str(p.get("id", "point")).lower())[:24] or "point", t, None
    label = name or f"Sky field RA {ra:.4f} Dec {dec:+.4f}"
    t = {"name": label, "kind": extra.get("kind") or "motion", "ra": ra, "dec": dec,
         "epoch": extra.get("epoch", 2026.0), "pmra": extra.get("pmra", 0.0), "pmdec": extra.get("pmdec", 0.0),
         "plx": 0.0, "gaia_dr3": None, "astrometry_label": "requested position",
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
    extra = {}
    if body.get("pmra") is not None:
        extra["pmra"] = num(body["pmra"], "pmra", -20000, 20000)
    if body.get("pmdec") is not None:
        extra["pmdec"] = num(body["pmdec"], "pmdec", -20000, 20000)
    if body.get("epoch") is not None:
        extra["epoch"] = num(body["epoch"], "epoch", 1900, 2100)
    if body.get("kind") is not None:
        if body["kind"] not in ("motion", "brightness"):
            raise BadRequest("kind must be 'motion' or 'brightness'")
        extra["kind"] = body["kind"]
    return {"ra": ra, "dec": dec, "name": name, "bins": bins, "cap": int(cap), "extra": extra,
            "force": body.get("force") is True}


def job_identity(p):
    slug, target, local = resolve_target(p["ra"], p["dec"], p["name"], p["extra"])
    ra3, dec3 = round(p["ra"], 3) % 360.0, round(p["dec"], 3)
    mask = sum(1 << BINS_ALL.index(b) for b in p["bins"])
    if local:                                                # all local cutouts: options do not apply
        jid = f"{slug}-local"
        center = {"ra": target["ra"], "dec": target["dec"]}
    else:
        pm = "" if not (target.get("pmra") or target.get("pmdec")) else \
            "-pm" + hashlib.sha1(json.dumps([target["pmra"], target["pmdec"], target["epoch"]]).encode()).hexdigest()[:4]
        jid = f"{slug}-{ra3:.3f}{'n' if dec3 >= 0 else 's'}{abs(dec3):.3f}-c{p['cap']}-b{mask}{pm}"
        center = {"ra": ra3, "dec": dec3}
        if target.get("pmra") or target.get("pmdec"):            # centre on the 2026.0 position
            r, d = moved(target)
            center = {"ra": round(r, 6), "dec": round(d, 6)}
    point_key = f"{center['ra']:.3f}_{center['dec']:+.3f}"
    return jid, {"id": jid, "target": target, "center": center, "point_key": point_key,
                 "local_target": local, "local_data": str(local_data_dir()) if local_data_dir() else None,
                 "bins": p["bins"], "cap": p["cap"], "request": {k: p[k] for k in ("ra", "dec", "name", "bins", "cap")}}


# ------------------------------------------------------------------------------- jobs
class Jobs:
    def __init__(self, uv):
        self.uv = uv
        self.lock = threading.Lock()
        self.jobs = {}                                       # id -> dict(state, ...)
        self.q = queue.Queue()
        self.current = None                                  # (id, Popen)
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
            self.jobs[d.name] = {"state": state, "status": st, "pipeline": st.get("pipeline"), "req": req}
        threading.Thread(target=self._runner, daemon=True, name="job-runner").start()

    def submit(self, p):
        jid, req = job_identity(p)
        ph = pipeline_hash()
        with self.lock:
            j = self.jobs.get(jid)
            if j and j["state"] in STATES_ACTIVE:
                return jid, False
            if (j and j["state"] == "done" and not p["force"] and j.get("pipeline") == ph
                    and (JOB_OUT / jid / "meta.json").exists()):
                return jid, True
            d = JOB_META / jid
            d.mkdir(parents=True, exist_ok=True)
            (d / "request.json").write_text(json.dumps(req, indent=1))
            st = {"state": "queued", "progress": {"done": 0, "total": 0, "bytes": 0},
                  "message": "waiting for the job before it" if self.current else "starting",
                  "pipeline": ph, "queued": time.time()}
            self._write_status(jid, st)
            self.jobs[jid] = {"state": "queued", "status": st, "pipeline": ph, "req": req}
            self.q.put(jid)
            log("queued", jid)
            return jid, False

    def _write_status(self, jid, st):
        p = JOB_META / jid / "status.json"
        tmp = p.with_suffix(".srv.tmp")
        tmp.write_text(json.dumps(st, indent=1))
        os.replace(tmp, p)

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
        out = {"id": jid, "state": state,
               "progress": {k: int(st.get("progress", {}).get(k, 0) or 0) for k in ("done", "total", "bytes")},
               "message": st.get("message", ""), "result_url": f"/jobs/{jid}/"}
        if j["req"]:
            out["target"] = j["req"]["target"].get("name")
            out["center"] = j["req"].get("center")
            out["source"] = "local IRSA cutouts" if j["req"].get("local_target") else "SPHEREx S3"
        for k in ("timings", "images", "result", "cached", "skipped"):
            if st.get(k) is not None:
                out[k] = st[k]
        if state == "done":
            out["viewer"] = f"/ornek.html?data=/jobs/{jid}/"
        return out

    def list(self):
        with self.lock:
            ids = list(self.jobs)
        return [self.get(i) for i in ids]

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
            cur = self.current
        if cur and cur[0] == jid:
            stop(cur[1])
        self._write_status(jid, st)
        log("cancelled", jid)
        return "cancelled"

    def _runner(self):
        while True:
            jid = self.q.get()
            with self.lock:
                j = self.jobs.get(jid)
                if not j or j["state"] != "queued":
                    continue
            try:
                self._run(jid, j)
            except Exception as e:                           # keep the runner alive
                log("runner error", jid, e)
                with self.lock:
                    j["state"] = "error"
                    j["status"] = dict(j["status"], state="error", message=f"local server error: {e}")

    def _run(self, jid, j):
        d = JOB_META / jid
        if not self.uv:
            raise RuntimeError("uv was not found (install it: https://docs.astral.sh/uv/)")
        cmd = [self.uv, "run", "--no-project", "--quiet"]
        for w in UV_WITH:
            cmd += ["--with", w]
        cmd += ["python", "-I", str(WORKER), "--job", str(d)]
        env = dict(os.environ, PYTHONUNBUFFERED="1", FAZARI_S3_CACHE=str(CACHE / "s3"))
        t0 = time.time()
        with open(d / "log.txt", "a") as logf:
            logf.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(cmd)}\n")
            logf.flush()
            with self.lock:
                if j["state"] != "queued":
                    return
                j["state"] = "finding"
                proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=logf, stderr=subprocess.STDOUT,
                                        stdin=subprocess.DEVNULL, env=env, start_new_session=True)
                self.current = (jid, proc)
            log("started", jid, "pid", proc.pid)
            rc = proc.wait()
        with self.lock:
            self.current = None
            st = load_json(d / "status.json", {}) or {}
            if j["state"] == "cancelled":
                st = dict(st, state="cancelled", message="cancelled")
            elif rc != 0 and st.get("state") != "error":
                st = dict(st, state="error", message=f"the job stopped (exit code {rc}); see {d / 'log.txt'}")
            elif rc == 0 and st.get("state") != "done":
                st = dict(st, state="error", message="the job ended without a result")
            st["pipeline"] = j["pipeline"]
            st["wall_seconds"] = round(time.time() - t0, 1)
            j["state"], j["status"] = st["state"], st
            self._write_status(jid, st)
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
            return self._json(200, {"ok": True, "engine": "python", "version": VERSION,
                                    "uv": bool(self.jobs.uv), "local_data": bool(local_data_dir()),
                                    "running": self.jobs.current[0] if self.jobs.current else None})
        if r == "/api/jobs":
            return self._json(200, {"jobs": self.jobs.list()})
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
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid JSON"})
        except BadRequest as e:
            return self._json(400, {"error": str(e)})
        return self._json(200, {"id": jid, "cached": cached})

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
        if Handler.jobs.current:
            stop(Handler.jobs.current[1])
        srv.server_close()


if __name__ == "__main__":
    main()
