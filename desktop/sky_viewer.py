#!/usr/bin/env python3
"""Fazari Sky 3D: a desktop sky viewer that draws the sky on the GPU, step by step, and sends a
picked point to the Fazari local engine (SPHEREx images -> blink -> motion measurement).

  uv run --no-project --with vispy --with PyQt5 --with numpy --with astropy --with astropy-healpix \
      python -I desktop/sky_viewer.py [--ra 269.45 --dec 4.77 --fov 2]

Mouse: drag = pan, wheel = zoom (toward the cursor), click = pick a point.
Keys: arrows = pan, + / - = zoom, G = grid, R = reset view.

Threads: the GUI thread only draws and reacts. Catalogue tiles (sky_catalog.TileLoader, 3 threads),
the base-layer download, engine health checks and engine jobs (engine_client.EngineJob) run in
background threads and hand their results over through queues, read by a 60 Hz Qt timer.

Stars: ESA Gaia DR3. Images: NASA SPHEREx (IRSA), processed by the Fazari local engine.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import queue
import sys
import threading
import time
from pathlib import Path

T_START = time.perf_counter()
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))            # sibling modules (python -I does not add the script dir)
ROOT = HERE.parent

# Qt binding: PyQt5 works on this Ubuntu 24.04 without extra system packages (Qt >= 6.5 needs
# libxcb-cursor0 for its X11 plugin). PyQt6 is used when PyQt5 is not installed.
try:
    from PyQt5 import QtCore, QtGui, QtWidgets
    QT_API = "pyqt5"
except ImportError:
    from PyQt6 import QtCore, QtGui, QtWidgets
    QT_API = "pyqt6"

import numpy as np
import vispy
vispy.use(app=QT_API)

import sky_catalog as cat
import sky_render
from engine_client import Engine, EngineJob, motion_text

CATEGORIES = ROOT / "site" / "data" / "categories.json"
CAT_COLORS = [(1.0, 0.85, 0.3), (0.4, 0.9, 1.0), (0.95, 0.5, 0.35), (0.7, 1.0, 0.5), (1.0, 0.45, 0.8),
              (0.8, 0.75, 1.0), (0.5, 1.0, 0.85), (1.0, 0.7, 0.4), (0.55, 0.7, 1.0), (0.9, 0.9, 0.9), (1, 1, 0.6)]
Qt = QtCore.Qt


def fmt_ra(ra):
    h = (ra % 360.0) / 15.0
    hh = int(h)
    m = (h - hh) * 60
    mm = int(m)
    ss = (m - mm) * 60
    if ss >= 59.995:
        ss, mm = 0.0, mm + 1
    if mm >= 60:
        mm, hh = 0, (hh + 1) % 24
    return f"{hh:02d}h {mm:02d}m {ss:05.2f}s"


def fmt_dec(dec):
    sgn = "-" if dec < 0 else "+"
    a = abs(dec)
    dd = int(a)
    m = (a - dd) * 60
    mm = int(m)
    ss = (m - mm) * 60
    if ss >= 59.95:
        ss, mm = 0.0, mm + 1
    if mm >= 60:
        mm, dd = 0, dd + 1
    return f"{sgn}{dd:02d}° {mm:02d}′ {ss:04.1f}″"


SEASON_COLORS = [(1.0, 0.55, 0.30), (0.35, 0.80, 1.0), (0.60, 1.0, 0.40), (1.0, 0.40, 0.80),
                 (1.0, 0.90, 0.30), (0.70, 0.60, 1.0)]


def parse_coord(text):
    """'269.44627 +4.76820', '269.44627, 4.7682', '17 57 47.1 +04 46 05.5', '17h57m47.1s +4d46m05s',
    '17:57:47.1 -04:46:05' -> (ra, dec) in degrees (ICRS), or None."""
    import re
    t = text.strip()
    if not t:
        return None
    t = re.sub(r"[hHmMsSdD\u00b0\u2032\u2033'\":,]", " ", t)
    t = re.sub(r"\s*([+-])\s*", r" \1", t)
    tok = t.split()
    try:
        if len(tok) == 2:
            ra, dec = float(tok[0]), float(tok[1])
        elif len(tok) == 6:
            h, m, sec = (float(x) for x in tok[:3])
            sign = -1.0 if tok[3].startswith("-") else 1.0
            d, dm, ds = abs(float(tok[3])), float(tok[4]), float(tok[5])
            ra = 15.0 * (h + m / 60.0 + sec / 3600.0)
            dec = sign * (d + dm / 60.0 + ds / 3600.0)
        else:
            return None
    except ValueError:
        return None
    if not (0.0 <= ra < 360.0 + 1e-9 and -90.0 <= dec <= 90.0):
        return None
    return ra % 360.0, dec


def mjd_to_date(mjd):
    import datetime
    return (datetime.datetime(1858, 11, 17) + datetime.timedelta(days=float(mjd))).strftime("%Y-%m-%d")


def rss_mb():
    try:
        for ln in open("/proc/self/status"):
            if ln.startswith("VmRSS:"):
                return int(ln.split()[1]) / 1024.0
    except OSError:
        pass
    return float("nan")


def load_categories():
    try:
        return json.loads(CATEGORIES.read_text()).get("categories", [])
    except Exception:
        return []


class MainWindow(QtWidgets.QMainWindow):
    def __init__(self, args):
        super().__init__()
        self.args = args
        self.setWindowTitle("Fazari Sky 3D — SPHEREx explorer")
        self.engine = Engine(args.engine)
        self.engine_ok = None
        self.engine_events: queue.Queue = queue.Queue()
        self.job: EngineJob | None = None
        self.job_status = {}
        self.result_frames = {}
        self.frame_pix = []
        self.frame_i = 0
        self.meta = None
        self.pick = None                       # (ra, dec, name)
        self.timing = {}

        self.canvas = sky_render.SkyCanvas(max_stars=args.max_stars, network=not args.offline,
                                           size=(1100, 800))
        self.canvas.on_pick = self.on_canvas_pick
        # touchpad / touchscreen pinch -> zoom (wheel and two-finger scroll work everywhere)
        self.canvas.native.grabGesture(Qt.GestureType.PinchGesture)
        self.canvas.native.installEventFilter(self)
        self.canvas.set_view(args.ra, args.dec, args.fov)
        self.canvas.load_base_now()

        self.cats = load_categories()
        self._build_ui()
        self._set_markers()

        self.timer = QtCore.QTimer(self)
        self.timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.timer.timeout.connect(self.tick)
        self.timer.start(16)
        self.blink_timer = QtCore.QTimer(self)
        self.blink_timer.timeout.connect(self._next_frame)
        self._last_status = 0.0
        threading.Thread(target=self._health_loop, daemon=True, name="engine-health").start()

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        split = QtWidgets.QSplitter(Qt.Orientation.Horizontal)
        split.addWidget(self.canvas.native)
        panel = QtWidgets.QWidget()
        lay = QtWidgets.QVBoxLayout(panel)
        lay.setContentsMargins(8, 8, 8, 8)

        title = QtWidgets.QLabel("<b style='font-size:15px'>Fazari Sky 3D</b><br>"
                                 "<span style='color:#888'>drag = pan · wheel = zoom · click = pick</span>")
        lay.addWidget(title)

        self.tree = QtWidgets.QTreeWidget()
        self.tree.setHeaderHidden(True)
        self.tree.setMinimumHeight(220)
        for ci, c in enumerate(self.cats):
            it = QtWidgets.QTreeWidgetItem([f"{c.get('icon', '')} {c.get('name', c.get('id'))} ({len(c.get('points', []))})"])
            it.setFlags(it.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            it.setCheckState(0, Qt.CheckState.Checked)
            it.setData(0, Qt.ItemDataRole.UserRole, ("cat", ci))
            col = CAT_COLORS[ci % len(CAT_COLORS)]
            it.setForeground(0, QtGui.QBrush(QtGui.QColor.fromRgbF(*col)))
            for pi, p in enumerate(c.get("points", [])):
                ch = QtWidgets.QTreeWidgetItem([p.get("name", p.get("id", "?"))])
                ch.setData(0, Qt.ItemDataRole.UserRole, ("pt", ci, pi))
                ch.setToolTip(0, p.get("note", ""))
                it.addChild(ch)
            self.tree.addTopLevelItem(it)
            if c.get("highlight"):
                it.setExpanded(True)
        self.tree.itemClicked.connect(self.on_tree_click)
        self.tree.itemChanged.connect(lambda *_: self._set_markers())
        self.tabs = QtWidgets.QTabWidget()
        self.tabs.addTab(self.tree, "Objects")

        box = QtWidgets.QGroupBox("Picked point")
        bl = QtWidgets.QVBoxLayout(box)
        self.pick_label = QtWidgets.QLabel("Click on the sky or a point in the list.")
        self.pick_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.pick_label.setWordWrap(True)
        bl.addWidget(self.pick_label)
        crow = QtWidgets.QHBoxLayout()
        self.coord_edit = QtWidgets.QLineEdit()
        self.coord_edit.setPlaceholderText("RA Dec (deg or hms dms), e.g. 269.44627 +4.76820")
        self.coord_edit.setToolTip("ICRS. Degrees '269.44627 +4.76820' or sexagesimal '17 57 47.1 +04 46 05.5'. "
                                   "The marker follows while you type; Enter turns the view there.")
        self.coord_edit.textEdited.connect(lambda *_: self._coord_timer.start(250))
        self.coord_edit.returnPressed.connect(lambda: self.apply_coord_text(fly=True))
        self._coord_timer = QtCore.QTimer(self)
        self._coord_timer.setSingleShot(True)
        self._coord_timer.timeout.connect(lambda: self.apply_coord_text(fly=False))
        go = QtWidgets.QPushButton("Go")
        go.clicked.connect(lambda: self.apply_coord_text(fly=True))
        crow.addWidget(self.coord_edit, 1)
        crow.addWidget(go)
        bl.addLayout(crow)
        frow = QtWidgets.QHBoxLayout()
        self.foot_check = QtWidgets.QCheckBox("SPHEREx footprints")
        self.foot_check.setChecked(True)
        self.foot_check.toggled.connect(self._toggle_footprints)
        self.foot_label = QtWidgets.QLabel("")
        self.foot_label.setWordWrap(True)
        self.foot_label.setStyleSheet("font-size:11px;")
        frow.addWidget(self.foot_check)
        bl.addLayout(frow)
        bl.addWidget(self.foot_label)
        self.fetch_btn = QtWidgets.QPushButton("Fetch SPHEREx images here")
        self.fetch_btn.setEnabled(False)
        self.fetch_btn.clicked.connect(self.start_job)
        bl.addWidget(self.fetch_btn)
        row = QtWidgets.QHBoxLayout()
        self.progress = QtWidgets.QProgressBar()
        self.progress.setRange(0, 1)
        self.progress.setValue(0)
        self.cancel_btn = QtWidgets.QPushButton("Cancel")
        self.cancel_btn.setEnabled(False)
        self.cancel_btn.clicked.connect(self.cancel_job)
        row.addWidget(self.progress, 1)
        row.addWidget(self.cancel_btn)
        bl.addLayout(row)
        self.job_label = QtWidgets.QLabel("")
        self.job_label.setStyleSheet("font-size:11px;")
        self.job_label.setWordWrap(True)
        bl.addWidget(self.job_label)
        lay.addWidget(box)
        lay.addWidget(self.tabs, 1)

        res = QtWidgets.QWidget()
        rl = QtWidgets.QVBoxLayout(res)
        top = QtWidgets.QHBoxLayout()
        self.bin_combo = QtWidgets.QComboBox()
        self.bin_combo.currentIndexChanged.connect(self._show_bin)
        self.epoch_label = QtWidgets.QLabel("")
        top.addWidget(QtWidgets.QLabel("λ"))
        top.addWidget(self.bin_combo)
        top.addWidget(self.epoch_label, 1)
        self.open_btn = QtWidgets.QPushButton("Open in browser")
        self.open_btn.setEnabled(False)
        self.open_btn.clicked.connect(self.open_browser)
        top.addWidget(self.open_btn)
        rl.addLayout(top)
        self.image = QtWidgets.QLabel()
        self.image.setMinimumSize(260, 200)
        self.image.setMaximumHeight(250)
        self.image.setSizePolicy(QtWidgets.QSizePolicy.Policy.Ignored, QtWidgets.QSizePolicy.Policy.Ignored)
        self.image.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.image.setStyleSheet("background:#05070d; border:1px solid #223;")
        rl.addWidget(self.image, 1)
        self.motion = QtWidgets.QLabel("")
        self.motion.setWordWrap(True)
        self.motion.setStyleSheet("font-size:11px;")
        self.motion.setSizePolicy(QtWidgets.QSizePolicy.Policy.Preferred, QtWidgets.QSizePolicy.Policy.Minimum)
        self.motion.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        rl.addWidget(self.motion, 0)
        self.tabs.addTab(res, "Result (blink)")

        credit = QtWidgets.QLabel("<span style='color:#888;font-size:10px'>Stars: ESA Gaia DR3 (Gaia Collaboration 2023). "
                                  "Images: NASA SPHEREx via IRSA, processed by the Fazari local engine. "
                                  "Stars drawn at epoch 2026.0 (Gaia DR3 proper motions). All coordinates ICRS. "
                                  "Milky Way glow is drawn procedurally.</span>")
        credit.setWordWrap(True)
        lay.addWidget(credit)

        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(panel)
        scroll.setMinimumWidth(400)
        split.addWidget(scroll)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 0)
        split.setSizes([1060, 420])
        self.setCentralWidget(split)
        self.status = QtWidgets.QLabel("")
        self.statusBar().addPermanentWidget(self.status, 1)

    def _set_markers(self):
        xyz, colors, sizes, names = [], [], [], []
        self.points = []
        for ci, c in enumerate(self.cats):
            item = self.tree.topLevelItem(ci) if hasattr(self, "tree") else None
            on = item is None or item.checkState(0) == Qt.CheckState.Checked
            col = CAT_COLORS[ci % len(CAT_COLORS)]
            for p in c.get("points", []):
                try:
                    ra, dec = float(p.get("ra_2026", p["ra"])), float(p.get("dec_2026", p["dec"]))
                except (KeyError, TypeError, ValueError):
                    continue
                self.points.append((ra, dec, p.get("name", "?"), c.get("id")))
                xyz.append(cat.radec_to_xyz(ra, dec))
                colors.append((*col, 0.9 if on else 0.0))
                sizes.append(-20.0 if c.get("highlight") else -15.0)   # negative: ring only, the star stays visible
                names.append(p.get("name", "?"))
        if xyz:
            self.canvas.set_markers(np.array(xyz), np.array(colors, np.float32), np.array(sizes, np.float32), names)

    def eventFilter(self, obj, ev):
        t = ev.type()
        if t == QtCore.QEvent.Type.NativeGesture and ev.gestureType() == Qt.NativeGestureType.ZoomNativeGesture:
            p = ev.pos() if hasattr(ev, "pos") else ev.position().toPoint()
            self.canvas.zoom_at(1.0 / max(0.2, 1.0 + ev.value()), p.x(), p.y())
            return True
        if t == QtCore.QEvent.Type.Gesture:
            g = ev.gesture(Qt.GestureType.PinchGesture)
            if g is not None:
                f = g.scaleFactor()
                if f > 0:
                    c = g.centerPoint()
                    lp = self.canvas.native.mapFromGlobal(c.toPoint())
                    self.canvas.zoom_at(1.0 / f, lp.x(), lp.y())
                return True
        return super().eventFilter(obj, ev)

    # ------------------------------------------------------------------ picking
    def on_tree_click(self, item, _col):
        d = item.data(0, Qt.ItemDataRole.UserRole)
        if not d or d[0] != "pt":
            return
        p = self.cats[d[1]]["points"][d[2]]
        ra, dec = float(p.get("ra_2026", p["ra"])), float(p.get("dec_2026", p["dec"]))
        self.canvas.fly_to(ra, dec, fov=min(self.canvas.fov, 1.0) if self.canvas.fov < 1.0 else 1.0)
        self.set_pick(ra, dec, p.get("name"))
        self.canvas.set_pick(ra, dec)

    def on_canvas_pick(self, ra, dec):
        name = None
        best = 60.0 / 3600 * max(1.0, self.canvas.fov / 2.0)      # snap to a listed point near the click
        for pra, pdec, pname, _ in getattr(self, "points", []):
            s = sky_render.ang_sep(ra, dec, pra, pdec)
            if s < best:
                best, name, sra, sdec = s, pname, pra, pdec
        if name:
            ra, dec = sra, sdec
            self.canvas.set_pick(ra, dec)
        self.set_pick(ra, dec, name)

    def set_pick(self, ra, dec, name=None):
        self.pick = (ra, dec, name)
        self.timing["pick"] = time.perf_counter()
        txt = (f"<b>{name}</b><br>" if name else "") + \
              f"RA {fmt_ra(ra)} &nbsp; Dec {fmt_dec(dec)}<br>" \
              f"<span style='color:#888'>RA {ra:.5f}° &nbsp; Dec {dec:+.5f}° (ICRS)</span>"
        self.pick_label.setText(txt)
        if not self.coord_edit.hasFocus():
            self.coord_edit.setText(f"{ra:.6f} {dec:+.6f}")
        self._refresh_fetch_btn()
        self._request_footprints(ra, dec)

    def apply_coord_text(self, fly=True):
        rd = parse_coord(self.coord_edit.text())
        if rd is None:
            self.coord_edit.setStyleSheet("color:#f86;")
            return
        self.coord_edit.setStyleSheet("")
        ra, dec = rd
        self.canvas.set_pick(ra, dec)
        self.set_pick(ra, dec, None)
        c = self.canvas
        on_screen = c.project(ra, dec)
        w, h = c.size
        if fly or on_screen is None or not (0 <= on_screen[0] <= w and 0 <= on_screen[1] <= h):
            c.fly_to(ra, dec)

    # ------------------------------------------------------------------ footprints
    def _request_footprints(self, ra, dec):
        self._foot_gen = getattr(self, "_foot_gen", 0) + 1
        gen = self._foot_gen

        def work():
            try:
                pipe = str(ROOT / "pipeline")
                if pipe not in sys.path:
                    sys.path.append(pipe)
                from sky_index import find_images
                imgs = find_images(ra, dec)
                self.engine_events.put((None, "footprints", (gen, ra, dec, imgs)))
            except Exception as e:
                self.engine_events.put((None, "footprints", (gen, ra, dec, e)))
        threading.Thread(target=work, daemon=True, name="footprints").start()

    def _show_footprints(self, gen, ra, dec, imgs):
        if gen != getattr(self, "_foot_gen", 0):
            return
        if isinstance(imgs, Exception):
            self.foot_label.setText(f"<span style='color:#f86'>sky index: {imgs}</span>")
            self.canvas.set_footprints([], [])
            return
        imgs = sorted(imgs, key=lambda r: r["mjd"])
        seasons, last = [], None
        for r in imgs:
            if last is None or r["mjd"] - last > 30.0:
                seasons.append([])
            seasons[-1].append(r)
            last = r["mjd"]
        polys, cols, legend = [], [], []
        for i, ss in enumerate(seasons):
            col = SEASON_COLORS[i % len(SEASON_COLORS)]
            for r in ss:
                polys.append(r["corners"])
                cols.append((*col, 0.55))
            hexc = "#%02x%02x%02x" % tuple(int(255 * x) for x in col)
            legend.append(f"<span style='color:{hexc}'>\u25a0</span> {mjd_to_date(ss[0]['mjd'])[:7]} ({len(ss)})")
        self.canvas.set_footprints(polys, cols)
        self.foot_info = {"n": len(imgs), "seasons": [(mjd_to_date(ss[0]["mjd"]), len(ss)) for ss in seasons]}
        self.foot_label.setText(f"{len(imgs)} SPHEREx images cover this point (sky index), by season: " + " &nbsp; ".join(legend)
                                if imgs else "No SPHEREx image in the sky index covers this point.")

    def _toggle_footprints(self, on):
        self.canvas.show_footprints = bool(on)
        self.canvas.dirty = True

    def _refresh_fetch_btn(self):
        busy = self.job is not None and self.job.is_alive()
        self.fetch_btn.setEnabled(bool(self.pick) and bool(self.engine_ok) and not busy)
        if not self.engine_ok:
            self.fetch_btn.setToolTip("The local engine (local/serve.py) is not running.")
        else:
            self.fetch_btn.setToolTip("")

    # ------------------------------------------------------------------ engine
    def _health_loop(self):
        while True:
            h = self.engine.health()
            self.engine_events.put((None, "health", h))
            time.sleep(5.0 if h else 3.0)

    def start_job(self):
        if not self.pick:
            return
        ra, dec, name = self.pick
        self.result_frames, self.frame_pix, self.meta = {}, [], None
        self.bin_combo.blockSignals(True)
        self.bin_combo.clear()
        self.bin_combo.blockSignals(False)
        self.image.clear()
        self.motion.setText("")
        self.open_btn.setEnabled(False)
        self.epoch_label.setText("")
        self.tabs.setCurrentIndex(0)
        self.blink_timer.stop()
        self.progress.setRange(0, 0)
        self.job_label.setText("submitting…")
        self.timing["submit"] = time.perf_counter()
        self.job = EngineJob(self.engine, ra, dec, name, self.args.cap, self.engine_events)
        self.job.start()
        self.cancel_btn.setEnabled(True)
        self._refresh_fetch_btn()

    def cancel_job(self):
        if self.job:
            self.job.cancel()
            self.job_label.setText("cancelling…")

    def open_browser(self):
        if self.job and self.job.jid:
            QtGui.QDesktopServices.openUrl(QtCore.QUrl(self.engine.viewer_url(self.job.jid)))

    def _engine_event(self, job, kind, payload):
        if kind == "footprints":
            self._show_footprints(*payload)
            return
        if kind == "health":
            self.engine_ok = bool(payload and payload.get("ok"))
            self._refresh_fetch_btn()
            return
        if job is not self.job:
            return
        if kind == "submitted":
            self.job_label.setText(f"job {payload['id']}" + (" (cached)" if payload.get("cached") else ""))
        elif kind == "status":
            self.job_status = payload
            st = payload.get("state", "?")
            pr = payload.get("progress") or {}
            done, total = pr.get("done", 0), pr.get("total", 0)
            if st == "downloading" and total:
                self.progress.setRange(0, total)
                self.progress.setValue(done)
                self.progress.setFormat(f"%v / %m images  ({pr.get('bytes', 0) / 1e6:.0f} MB)")
            elif st == "done":
                self.progress.setRange(0, 1)
                self.progress.setValue(1)
                self.progress.setFormat("done")
            else:
                self.progress.setRange(0, 0)
            self.job_label.setText(f"<b>{st}</b> — {payload.get('message', '')}")
        elif kind == "meta":
            self.meta = payload
            self.motion.setText(motion_text(payload))
            self.open_btn.setEnabled(True)
        elif kind == "frames":
            for wl, frames in payload.items():
                pix = []
                for epoch, data in frames:
                    pm = QtGui.QPixmap()
                    pm.loadFromData(data)
                    pix.append((epoch, pm))
                self.result_frames[wl] = pix
                self.bin_combo.addItem(f"{wl:g} µm", wl)
            if "result" not in self.timing or self.timing.get("result_job") is not job:
                self.timing["result"] = time.perf_counter()
                self.timing["result_job"] = job
                self.bin_combo.setCurrentIndex(0)
                self._show_bin()
                self.tabs.setCurrentIndex(1)
        elif kind == "finished":
            self.cancel_btn.setEnabled(False)
            self._refresh_fetch_btn()
        elif kind == "error":
            self.progress.setRange(0, 1)
            self.progress.setValue(0)
            self.progress.setFormat("")
            self.job_label.setText(f"<span style='color:#f86'>{payload}</span>")
            self.cancel_btn.setEnabled(False)
            self._refresh_fetch_btn()

    def _show_bin(self, *_):
        wl = self.bin_combo.currentData()
        self.frame_pix = [f for f in self.result_frames.get(wl, []) if f[0] != "difference"]
        self.frame_i = 0
        if self.frame_pix:
            self._next_frame()
            self.blink_timer.start(650)

    def _next_frame(self):
        if not self.frame_pix:
            return
        epoch, pm = self.frame_pix[self.frame_i % len(self.frame_pix)]
        self.frame_i += 1
        w = max(200, self.image.width() - 4)
        hgt = max(200, self.image.height() - 4)
        self.image.setPixmap(pm.scaled(w, hgt, Qt.AspectRatioMode.KeepAspectRatio,
                                       Qt.TransformationMode.SmoothTransformation))
        self.epoch_label.setText(f"season {epoch}")

    # ------------------------------------------------------------------ loop
    def tick(self):
        self.canvas.tick()
        try:
            while True:
                job, kind, payload = self.engine_events.get_nowait()
                self._engine_event(job, kind, payload)
        except queue.Empty:
            pass
        now = time.perf_counter()
        if now - self._last_status > 0.5:
            self._last_status = now
            c = self.canvas
            ld = c.loader.stats
            eng = {None: "engine ?", True: "engine ready", False: "engine offline"}[self.engine_ok]
            self.status.setText(
                f"RA {fmt_ra(c.ra0)}  Dec {fmt_dec(c.dec0)}   FoV {c.fov:.3g}°   G<{c.stats['maglim']:.1f}   "
                f"stars in view {c.stats['stars_view']:,}   on GPU {c.stars_resident:,}   "
                f"tiles {len(c.resident)} (+{c.loader.pending} loading, {ld['net']} net/{ld['disk']} disk)   "
                f"{c.fps():.0f} fps   RSS {rss_mb():.0f} MB   {eng}   · Gaia DR3 (ESA)")

    def closeEvent(self, ev):
        self.canvas.close_loader()
        if self.job:
            self.job.cancel()
        super().closeEvent(ev)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Fazari Sky 3D viewer")
    ap.add_argument("--ra", type=float, default=266.4, help="start centre RA (deg)")
    ap.add_argument("--dec", type=float, default=-29.0, help="start centre Dec (deg)")
    ap.add_argument("--fov", type=float, default=999.0, help="start vertical field of view (deg); clamped so the "
                    "wider screen side spans at most 120 deg (default: that widest view)")
    ap.add_argument("--engine", default="http://127.0.0.1:8765")
    ap.add_argument("--cap", type=int, default=None, help="exposures per season and bin (engine default if unset)")
    ap.add_argument("--max-stars", type=int, default=3_000_000, help="GPU/RAM star cap (LRU eviction)")
    ap.add_argument("--offline", action="store_true", help="no catalogue downloads (disk cache only)")
    ap.add_argument("--size", default="1480x860")
    return ap.parse_args(argv)


def make_app():
    qapp = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv)
    qapp.setApplicationName("Fazari Sky 3D")
    pal = QtGui.QPalette()
    for role, col in ((QtGui.QPalette.ColorRole.Window, "#14161c"), (QtGui.QPalette.ColorRole.WindowText, "#dde"),
                      (QtGui.QPalette.ColorRole.Base, "#0d0f14"), (QtGui.QPalette.ColorRole.Text, "#dde"),
                      (QtGui.QPalette.ColorRole.Button, "#22252e"), (QtGui.QPalette.ColorRole.ButtonText, "#dde"),
                      (QtGui.QPalette.ColorRole.Highlight, "#2a6"), (QtGui.QPalette.ColorRole.AlternateBase, "#181b22")):
        pal.setColor(role, QtGui.QColor(col))
    qapp.setStyle("Fusion")
    qapp.setPalette(pal)
    return qapp


def main(argv=None):
    args = parse_args(argv)
    qapp = make_app()
    win = MainWindow(args)
    w, h = (int(x) for x in args.size.lower().split("x"))
    win.resize(w, h)
    win.show()
    t0 = float(os.environ.get("FAZARI_T0", "0") or 0)

    def first_frame_report():
        if win.canvas.first_frame_s is None:
            QtCore.QTimer.singleShot(5, first_frame_report)
            return
        msg = f"first frame {win.canvas.first_frame_s - T_START:.3f} s after Python start"
        if t0:
            msg += f", {time.time() - t0:.3f} s after launch"
        print(msg, flush=True)
    QtCore.QTimer.singleShot(0, first_frame_report)
    return qapp.exec() if hasattr(qapp, "exec") else qapp.exec_()


if __name__ == "__main__":
    sys.exit(main())
