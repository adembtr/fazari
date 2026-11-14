#!/usr/bin/env python3
"""Scripted benchmark of the Fazari Sky 3D viewer (no mouse or keyboard is touched).

  QT_QPA_PLATFORM=offscreen uv run --no-project --with vispy --with PyQt5 --with numpy --with astropy \
      --with astropy-healpix python -I desktop/bench_viewer.py [--engine-runs] [--shots DIR] [--out FILE]

With QT_QPA_PLATFORM=offscreen the whole window renders on the GPU without appearing on the screen.
It measures start-up to the first frame, frame times while panning and zooming (glFinish in every
frame, so GPU time is included), memory, stars drawn per zoom, and, with --engine-runs, the click ->
result time through the local engine for Barnard's Star and Luhman 16AB. Screenshots get a B_ prefix.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sky_viewer as sv                      # noqa: E402  (sets T_START at import)
from sky_viewer import QtCore, QtWidgets     # noqa: E402

import numpy as np                           # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BARNARD = (269.446268, 4.768204)
GC = (266.40, -29.0)


def proc_age():
    """Seconds since this process started (includes interpreter start-up)."""
    try:
        start = int(open("/proc/self/stat").read().rsplit(")", 1)[1].split()[19])
        up = float(open("/proc/uptime").read().split()[0])
        return up - start / os.sysconf("SC_CLK_TCK")
    except Exception:
        return float("nan")


class Bench:
    def __init__(self, args):
        self.args = args
        self.qapp = sv.make_app()
        self.win = sv.MainWindow(sv.parse_args(["--size", "1480x860", "--ra", str(GC[0]), "--dec", str(GC[1]),
                                                "--fov", "999"] + (["--cap", str(args.cap)] if args.cap else [])))
        self.win.resize(1480, 860)
        self.c = self.win.canvas
        self.out = {"machine": {}, "zoom": [], "fps": {}, "engine": {}}
        self.shots = Path(args.shots)
        self.shots.mkdir(parents=True, exist_ok=True)

    def pump(self, sec=0.0, until=None, timeout=None):
        t0 = time.perf_counter()
        while True:
            self.qapp.processEvents()
            if until is not None and until():
                return True
            el = time.perf_counter() - t0
            if until is None and el >= sec:
                return True
            if timeout is not None and el >= timeout:
                return False
            time.sleep(0.004)

    def shot(self, name):
        p = self.shots / f"B_{name}.png"
        self.pump(0.3)
        self.win.grab().save(str(p))
        print("  screenshot", p, flush=True)
        return str(p)

    def wait_tiles(self, timeout=120):
        t0 = time.perf_counter()
        self.pump(0.5)
        ok = self.pump(until=lambda: self.c.loader.pending == 0 and not self.c._lod_dirty, timeout=timeout)
        self.pump(0.4)
        return ok, time.perf_counter() - t0

    # ------------------------------------------------------------------ steps
    def start(self):
        self.win.show()
        self.pump(until=lambda: self.c.first_frame_s is not None, timeout=30)
        self.out["open"] = {
            "python_start_to_first_frame_s": round(self.c.first_frame_s - sv.T_START, 3),
            "process_start_to_first_frame_s": round(proc_age() - (time.perf_counter() - self.c.first_frame_s), 3),
            "base_stars": 0 if self.c.base is None else int(len(self.c.base)),
        }
        from vispy.gloo import gl
        self.out["machine"] = {"gl_renderer": gl.glGetParameter(gl.GL_RENDERER),
                               "gl_version": gl.glGetParameter(gl.GL_VERSION),
                               "qt": sv.QT_API, "platform": self.qapp.platformName()}
        print("open", self.out["open"], self.out["machine"], flush=True)

    def frames(self, n, step):
        """Draw n frames, calling step(i) before each; returns fps and draw-time percentiles."""
        self.c.finish_gl = True
        self.c.draw_ms.clear()
        t0 = time.perf_counter()
        for i in range(n):
            step(i)
            self.c.tick()
            self.c.native.repaint()
            self.qapp.processEvents()
        el = time.perf_counter() - t0
        self.c.finish_gl = False
        ms = np.array(self.c.draw_ms)
        return {"frames": n, "fps": round(n / el, 1), "frame_ms_p50": round(float(np.median(ms)), 2),
                "frame_ms_p95": round(float(np.percentile(ms, 95)), 2), "stars_on_gpu": self.c.stars_resident,
                "stars_in_view": self.c.stats["stars_view"]}

    def fps_tests(self):
        c = self.c
        c.set_view(*GC, 999)
        self.out["max_fov"] = {"wide_deg": round(c.fov_wide(), 2), "vertical_deg": round(c.fov, 2),
                               "screen_px": list(c.size)}
        self.pump(1.0)
        r = self.frames(300, lambda i: c.set_view(ra=c.ra0 + 0.6))
        self.out["fps"]["turn_left_right_widest"] = r
        print("turn widest", r, flush=True)
        r = self.frames(300, lambda i: c.set_view(dec=GC[1] + 60 * math.sin(i / 300 * 2 * math.pi)))
        self.out["fps"]["turn_up_down_widest"] = r
        print("pitch widest", r, flush=True)
        c.set_view(*BARNARD, 999)
        f0 = c.fov
        r = self.frames(300, lambda i: c.set_view(fov=f0 * (1.5 / f0) ** (i / 299)))
        self.out["fps"]["zoom_widest_to_1.5"] = r
        print("zoom widest->1.5", r, flush=True)

    def zoom_series(self):
        c = self.c
        for (name, center) in (("barnard", BARNARD), ("galactic_centre", GC)):
            for fov in (999, 60, 20, 5, 1, 0.3):
                c.set_view(*center, fov)
                t0 = time.perf_counter()
                net0 = c.loader.stats["net"]
                ok, dt = self.wait_tiles(timeout=150)
                rec = {"field": name, "fov_deg": round(c.fov, 3), "fov_wide_deg": round(c.fov_wide(), 3), "maglim_G": round(c.stats["maglim"], 2),
                       "stars_in_view": c.stats["stars_view"], "stars_on_gpu": c.stars_resident,
                       "tiles_resident": len(c.resident), "tiles_fetched_net": c.loader.stats["net"] - net0,
                       "settle_s": round(dt, 1), "complete": ok, "rss_mb": round(sv.rss_mb(), 1)}
                self.out["zoom"].append(rec)
                print("zoom", rec, flush=True)
                if name == "barnard" and fov == 999:
                    self.out["shots_widest"] = self.shot("01_widest_view")
                if name == "barnard" and fov == 1:
                    self.out["shots_zoom"] = self.shot("02_zoom_lod_barnard_1deg")
                if name == "galactic_centre" and fov == 5:
                    self.shot("03_zoom_lod_galactic_centre_5deg")
        # frame rate with many stars resident: pan around the galactic centre at 5 deg
        c.set_view(*GC, 5)
        self.wait_tiles(60)
        r = self.frames(300, lambda i: c.set_view(ra=GC[0] + 2.0 * math.sin(i / 300 * 2 * math.pi),
                                                    dec=GC[1] + 1.0 * math.cos(i / 300 * 2 * math.pi)))
        self.out["fps"]["pan_gc_fov5_loaded"] = r
        print("pan gc fov5", r, flush=True)
        self.out["rss_mb_after_zoom"] = round(sv.rss_mb(), 1)
        self.compass_shots()
        self.out["tile_loader"] = dict(c.loader.stats)

    def compass_shots(self):
        """Turn toward the north celestial pole and past it: the compass must follow."""
        c = self.c
        rec = []
        for i, (ra, dec) in enumerate(((60.0, 30.0), (60.0, 75.0), (240.0, 80.0))):
            c.set_view(ra, dec, 999)
            self.pump(0.6)
            n, e = c.compass_directions()
            rec.append({"ra": ra, "dec": dec, "north_xy": [round(float(x), 4) for x in n],
                        "east_xy": [round(float(x), 4) for x in e]})
            if i == 1:
                p = self.shot("07_compass_widest_near_pole")
                img = self.win.grab()
                pr = img.devicePixelRatio()
                h = c.size[1]
                crop = img.copy(0, int((h - 140) * pr), int(520 * pr), int(140 * pr))
                crop = crop.scaled(crop.width() * 2, crop.height() * 2)
                crop.save(str(self.shots / "B_08_compass_closeup.png"))
        self.out["compass"] = rec
        print("compass", rec, flush=True)

    def click(self, ra, dec, fov=1.0):
        """Fly there, then 'click' the pixel of the target through the normal pick path."""
        c = self.c
        c.fly_to(ra, dec, fov)
        self.pump(until=lambda: not c.animating, timeout=10)
        self.wait_tiles(60)
        px, py = c.project(ra, dec)
        pra, pdec = c.pick(px, py)
        c.set_pick(pra, pdec)
        self.win.on_canvas_pick(pra, pdec)
        self.pump(0.2)
        return pra, pdec

    def engine_run(self, key, ra, dec, timeout):
        w = self.win
        self.pump(until=lambda: w.engine_ok is not None, timeout=10)
        rec = {"engine_ok": w.engine_ok}
        pra, pdec = self.click(ra, dec)
        rec["picked"] = {"ra": round(pra, 6), "dec": round(pdec, 6), "name": w.pick[2]}
        rec["pick_screenshot"] = self.shot(f"04_pick_{key}")
        if not w.engine_ok:
            self.out["engine"][key] = rec
            return
        w.job_status = {}
        t0 = time.perf_counter()
        w.fetch_btn.click()
        took_progress = False
        states = []

        def done():
            nonlocal took_progress
            st = w.job_status.get("state")
            if st and (not states or states[-1][0] != st):
                states.append((st, round(time.perf_counter() - t0, 1), w.job_status.get("message", "")[:80]))
                print("  ", key, states[-1], flush=True)
            if not took_progress and st in ("queued", "finding", "downloading", "processing") and time.perf_counter() - t0 > 1.5:
                took_progress = True
                rec["progress_screenshot"] = self.shot(f"05_progress_{key}")
            return w.timing.get("result_job") is w.job or (w.job and not w.job.is_alive())
        self.pump(until=done, timeout=timeout)
        rec["states"] = states
        if w.timing.get("result_job") is w.job:
            rec["click_to_result_s"] = round(w.timing["result"] - t0, 2)
            rec["job_id"] = w.job.jid
            st = w.job_status
            rec["engine_timings"] = st.get("timings")
            rec["images"] = st.get("images")
            self.pump(1.5)
            rec["result_screenshot"] = self.shot(f"06_result_{key}")
            m = (w.meta or {}).get("measured") or {}
            rec["measured"] = {k: m.get(k) for k in ("shift_arcsec", "shift_err_arcsec", "pa_deg", "dt_years", "from_epoch",
                                                    "to_epoch", "gaia_predicted_arcsec", "gaia_pa_deg", "measured_pm_mas_yr", "status")}
            rec["motion_text"] = w.motion.text()
        else:
            rec["error"] = w.job_label.text()
        self.out["engine"][key] = rec
        print("engine", key, json.dumps(rec, default=str)[:1500], flush=True)

    def compare_barnard(self):
        try:
            ref = json.loads((ROOT / "site" / "data" / "barnard" / "meta.json").read_text())["measured"]
        except Exception:
            return
        got = (self.out["engine"].get("barnard") or {}).get("measured") or {}
        self.out["barnard_vs_site"] = {
            "site_shift_arcsec": ref.get("shift_arcsec"), "site_pa_deg": ref.get("pa_deg"),
            "site_gaia_predicted_arcsec": ref.get("gaia_predicted_arcsec"),
            "engine_shift_arcsec": got.get("shift_arcsec"), "engine_pa_deg": got.get("pa_deg"),
            "difference_arcsec": (round(got["shift_arcsec"] - ref["shift_arcsec"], 3)
                                  if got.get("shift_arcsec") is not None and ref.get("shift_arcsec") is not None else None)}
        print("barnard vs site", self.out["barnard_vs_site"], flush=True)

    def onscreen(self, seconds):
        """Real window, normal event loop (60 Hz timer, vsync): turn and zoom for `seconds`, count frames."""
        c = self.c
        c.set_view(*GC, 999)
        self.pump(1.0)
        res = {}
        for name, fn in (("turn", lambda t: c.set_view(ra=GC[0] + 25 * t, dec=GC[1] + 10 * math.sin(t))),
                         ("zoom", lambda t: c.set_view(fov=c.max_fov() * (2.0 / c.max_fov()) ** (t / seconds)))):
            n0 = len(c.frame_times)
            c.frame_times.clear()
            t0 = time.perf_counter()
            while (t := time.perf_counter() - t0) < seconds:
                fn(t)
                self.qapp.processEvents()
                time.sleep(0.002)
            res[name] = {"seconds": seconds, "frames": len(c.frame_times),
                         "fps": round(len(c.frame_times) / seconds, 1),
                         "draw_ms_p50": round(float(np.median(list(c.draw_ms)[-len(c.frame_times):])), 2)}
            print("onscreen", name, res[name], flush=True)
        self.out["onscreen"] = res

    def run(self):
        if self.args.onscreen_seconds:
            self.win.setAttribute(QtCore.Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.start()
        if self.args.onscreen_seconds:
            self.onscreen(self.args.onscreen_seconds)
            Path(self.args.out).write_text(json.dumps(self.out, indent=1, default=str))
            self.win.close()
            return
        if not self.args.engine_only:
            self.fps_tests()
            self.zoom_series()
        if self.args.engine_runs or self.args.engine_only:
            pts = {}
            for c in sv.load_categories():
                for p in c.get("points", []):
                    pts.setdefault(p.get("id"), (float(p.get("ra_2026", p["ra"])), float(p.get("dec_2026", p["dec"]))))
            for key in self.args.targets.split(","):
                hit = next((k for k in pts if k and key.lower() in k.lower()), None)
                if hit is None:
                    print("no such point", key, flush=True)
                    continue
                self.engine_run(key, *pts[hit], timeout=self.args.engine_timeout)
                if key == "barnard":
                    self.compare_barnard()
        self.out["rss_mb_end"] = round(sv.rss_mb(), 1)
        Path(self.args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(self.args.out).write_text(json.dumps(self.out, indent=1, default=str))
        print("wrote", self.args.out, flush=True)
        self.win.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=str(ROOT.parent / "gorseller" / "uygulama"))
    ap.add_argument("--out", default=str(ROOT / "cache" / "sky3d" / "bench.json"))
    ap.add_argument("--engine-runs", action="store_true")
    ap.add_argument("--engine-only", action="store_true")
    ap.add_argument("--engine-timeout", type=float, default=3600)
    ap.add_argument("--cap", type=int, default=None)
    ap.add_argument("--targets", default="barnard,luhman", help="category point ids for --engine-runs")
    ap.add_argument("--onscreen-seconds", type=float, default=0, help="real window test (no offscreen)")
    Bench(ap.parse_args()).run()


if __name__ == "__main__":
    main()
