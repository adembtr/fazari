"""Client for the Fazari local engine (local/serve.py on 127.0.0.1:8765). Standard library only.

All calls block, so the viewer runs them in background threads (EngineJob, health checks) and
reads their events from a queue on the GUI thread.
"""
from __future__ import annotations

import json
import queue
import threading
import time
import urllib.error
import urllib.request

UA = "fazari-spaceapps/1.0"
TERMINAL = ("done", "error", "cancelled")


class Engine:
    def __init__(self, base="http://127.0.0.1:8765"):
        self.base = base.rstrip("/")

    def _req(self, method, path, body=None, timeout=10):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"User-Agent": UA, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()

    def health(self, timeout=1.5):
        try:
            return json.loads(self._req("GET", "/api/health", timeout=timeout))
        except Exception:
            return None

    def submit(self, ra, dec, name=None, cap=None):
        body = {"ra": float(ra) % 360.0, "dec": float(dec)}
        if name:
            body["name"] = str(name)[:100]
        if cap:
            body["cap"] = int(cap)
        try:
            return json.loads(self._req("POST", "/api/jobs", body))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"engine refused the job: HTTP {e.code} {e.read()[:200]!r}") from None

    def status(self, jid):
        return json.loads(self._req("GET", f"/api/jobs/{jid}"))

    def cancel(self, jid):
        try:
            return json.loads(self._req("DELETE", f"/api/jobs/{jid}"))
        except Exception:
            return None

    def get_json(self, path):
        return json.loads(self._req("GET", path, timeout=20))

    def get_bytes(self, path):
        return self._req("GET", path, timeout=30)

    def viewer_url(self, jid):
        return f"{self.base}/ornek.html?data=/jobs/{jid}/"


class EngineJob(threading.Thread):
    """Submit one job, poll it, and when done fetch meta.json and the blink frames.

    Events put on `events` (read by the GUI thread):
      ("submitted", {id, cached})   ("status", status dict)   ("error", message)
      ("meta", meta dict)           ("frames", {bin: [(epoch, png bytes), ...]})  ("finished", None)
    """

    def __init__(self, engine: Engine, ra, dec, name=None, cap=None, events: queue.Queue = None):
        super().__init__(daemon=True, name="engine-job")
        self.engine, self.ra, self.dec, self.name, self.cap = engine, ra, dec, name, cap
        self.events = events or queue.Queue()
        self.cancel_flag = threading.Event()
        self.jid = None
        self.t_submit = None
        self.t_done = None

    def put(self, kind, payload=None):
        self.events.put((self, kind, payload))

    def cancel(self):
        self.cancel_flag.set()

    def run(self):
        try:
            self.t_submit = time.perf_counter()
            r = self.engine.submit(self.ra, self.dec, self.name, self.cap)
            self.jid = r["id"]
            self.put("submitted", r)
            sent_cancel = False
            while True:
                if self.cancel_flag.is_set() and not sent_cancel:
                    self.engine.cancel(self.jid)
                    sent_cancel = True
                try:
                    st = self.engine.status(self.jid)
                except Exception as e:
                    self.put("status", {"state": "unknown", "message": f"engine not answering ({e})"})
                    time.sleep(2.0)
                    continue
                self.put("status", st)
                if st.get("state") in TERMINAL:
                    break
                self.cancel_flag.wait(0.7)
            if st.get("state") != "done":
                self.put("error", st.get("message") or st.get("state"))
                return
            meta = self.engine.get_json(f"/jobs/{self.jid}/meta.json")
            self.put("meta", meta)
            bins = meta.get("wavelength_bins") or []
            first = _default_bin(bins)
            order = ([first] if first is not None else []) + [b for b in bins if b is not first]
            for b in order:
                if self.cancel_flag.is_set():
                    return
                frames = []
                for fr in b.get("frames", []):
                    frames.append((fr.get("epoch") or fr.get("date") or "?",
                                   self.engine.get_bytes(f"/jobs/{self.jid}/{fr['file']}")))
                if b.get("diff"):
                    try:
                        frames.append(("difference", self.engine.get_bytes(f"/jobs/{self.jid}/{b['diff']}")))
                    except Exception:
                        pass
                self.put("frames", {b.get("wavelength_um"): frames})
                if b is first:
                    self.t_done = time.perf_counter()
            self.put("finished", None)
        except Exception as e:
            self.put("error", str(e)[:300])


def _default_bin(bins):
    for want in (2.0, 1.5, 3.0):
        for b in bins:
            if abs(float(b.get("wavelength_um", 0)) - want) < 1e-6 and b.get("frames"):
                return b
    return next((b for b in bins if b.get("frames")), None)


def motion_text(meta: dict) -> str:
    """Human-readable summary of what the engine measured (meta.json of blink.py)."""
    m = meta.get("measured") or {}
    lines = []
    tgt = meta.get("target")
    if tgt:
        lines.append(f"Target: {tgt}")
    ep = meta.get("epochs") or []
    if ep:
        lines.append(f"Seasons: {', '.join(ep)}  ({meta.get('n_cutouts', '?')} cutouts)")
    if m.get("shift_arcsec") is not None:
        lines.append(f"Measured shift: {m['shift_arcsec']:.2f}\" ± {m.get('shift_err_arcsec') or 0:.2f}\" "
                     f"in {m.get('dt_years', 0):.2f} yr ({m.get('from_epoch')} → {m.get('to_epoch')}), "
                     f"PA {m.get('pa_deg', 0):.1f}°")
        if m.get("gaia_predicted_arcsec") is not None:
            lines.append(f"Gaia DR3 predicts: {m['gaia_predicted_arcsec']:.2f}\" at PA {m.get('gaia_pa_deg', 0):.1f}°")
        if m.get("measured_pm_mas_yr") is not None:
            lines.append(f"Proper motion: {m['measured_pm_mas_yr'] / 1000:.2f}\"/yr")
    msg = m.get("message") or (m.get("detection") or {}).get("message")
    if msg:
        lines.append(msg)
    if not m:
        lines.append("No motion measurement in this result (see the browser view for the images).")
    return "\n".join(lines)
