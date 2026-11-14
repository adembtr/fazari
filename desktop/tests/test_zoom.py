#!/usr/bin/env python3
"""Zoom-toward-the-cursor test for Fazari Sky 3D (offscreen Qt, synthetic events only; no real mouse).

  QT_QPA_PLATFORM=offscreen uv run --no-project --with vispy --with PyQt5 --with numpy --with astropy \
      --with astropy-healpix python -I desktop/tests/test_zoom.py [--out FILE]

Rule: the sky point under the cursor stays under the cursor while you zoom. A sky point (Barnard's Star,
and one 6 deg from the north celestial pole) is put exactly on a cursor pixel off the centre; then 5 wheel
notches in and 5 out are sent to the canvas as Qt wheel events (what a mouse sends), and the point's
screen position is compared with the cursor after each notch. The same for a touchpad pinch
(QNativeGestureEvent, zoom). The keyboard + / - still zoom about the centre. ICRS degrees, logical pixels.
Exit code 1 if any drift is above 1 px.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import sky_viewer as sv                      # noqa: E402

QtCore, QtGui, Qt = sv.QtCore, sv.QtGui, sv.Qt
ROOT = HERE.parent.parent
LIMIT_PX = 1.0
BARNARD = (269.44627, 4.76820)
NEAR_POLE = (40.0, 84.0)


def pump(qapp, sec):
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < sec:
        qapp.processEvents()
        time.sleep(0.004)


def place(c, ra, dec, x, y):
    """Move the view (not the zoom) until (ra, dec) is on pixel (x, y). Independent of zoom_at."""
    w, h = c.size
    for _ in range(40):
        p = c.project(ra, dec)
        ex, ey = p[0] - x, p[1] - y
        if math.hypot(ex, ey) < 1e-4:
            return True
        n = c.pick(w / 2 + ex, h / 2 + ey)
        c.set_view(ra=n[0], dec=n[1])
    return False


def drift(c, ra, dec, x, y):
    p = c.project(ra, dec)
    return math.hypot(p[0] - x, p[1] - y) if p else float("inf")


def wheel_event(x, y, notches):
    pos = QtCore.QPointF(x, y)
    ang = QtCore.QPoint(0, int(120 * notches))
    return QtGui.QWheelEvent(pos, pos, QtCore.QPoint(0, 0), ang, Qt.MouseButton.NoButton,
                             Qt.KeyboardModifier.NoModifier, Qt.ScrollPhase.NoScrollPhase, False)


def gesture_event(x, y, value):
    pos = QtCore.QPointF(x, y)
    try:      # Qt 5.10+: with a touch device
        return QtGui.QNativeGestureEvent(Qt.NativeGestureType.ZoomNativeGesture, None, pos, pos, pos, value, 0, 0)
    except TypeError:
        return QtGui.QNativeGestureEvent(Qt.NativeGestureType.ZoomNativeGesture, pos, pos, pos, value, 0, 0)


def run(c, qapp, target, point, fov, x, y, kind="wheel"):
    ra, dec = point
    c._anim = None
    c.set_view(ra, dec, fov)
    ok = place(c, ra, dec, x, y)
    rows = []
    for d in (1, 1, 1, 1, 1, -1, -1, -1, -1, -1):          # wheel up = zoom in
        f0 = c.fov
        ev = wheel_event(x, y, d) if kind == "wheel" else gesture_event(x, y, 0.15 * d)
        QtCore.QCoreApplication.sendEvent(target, ev)
        pump(qapp, 0.02)
        rows.append({"dir": "in" if d > 0 else "out", "fov_from": round(f0, 6), "fov_to": round(c.fov, 6),
                     "drift_px": round(drift(c, ra, dec, x, y), 4)})
    dr = [r["drift_px"] for r in rows]
    return {"placed": ok, "cursor_px": [x, y], "start_fov": fov, "max_px": max(dr), "median_px": statistics.median(dr),
            "steps": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "cache" / "sky3d" / "test_zoom.json"))
    args = ap.parse_args()
    qapp = sv.make_app()
    win = sv.MainWindow(sv.parse_args(["--size", "1480x860", "--offline"]))
    win.resize(1480, 860)
    win.show()
    pump(qapp, 1.0)
    c = win.canvas
    target = c.native
    w, h = c.size
    x30, y30 = round(0.3 * w), round(0.3 * h)
    x70, y70 = round(0.7 * w), round(0.7 * h)
    out = {"canvas_px": [w, h], "limit_px": LIMIT_PX, "wheel": [], "touchpad_pinch": []}
    # The camera keeps north up, so a point 6 deg from the pole can only sit near the line from the centre
    # to the pole: the pole cases use small fields or a cursor straight above the centre.
    cases = [(BARNARD, "Barnard's Star", ((100.0, x30, y30), (10.0, x30, y30), (0.1, x30, y30), (30.0, x70, y70))),
             (NEAR_POLE, "near the north pole", ((10.0, x30, y30), (2.0, x70, y70), (60.0, round(0.5 * w), round(0.25 * h))))]
    for point, name, runs in cases:
        for fov, x, y in runs:
            r = run(c, qapp, target, point, min(fov, c.max_fov()), x, y)
            out["wheel"].append({"point": name, **r})
    for fov in (30.0, 0.5):
        out["touchpad_pinch"].append({"point": "Barnard's Star", **run(c, qapp, target, BARNARD, fov, x30, y30, "gesture")})
    # keyboard +: about the centre
    c.set_view(BARNARD[0], BARNARD[1], 10.0)
    ra0, dec0, f0 = c.ra0, c.dec0, c.fov
    QtCore.QCoreApplication.sendEvent(target, QtGui.QKeyEvent(QtCore.QEvent.Type.KeyPress, Qt.Key.Key_Plus,
                                                               Qt.KeyboardModifier.NoModifier, "+"))
    pump(qapp, 0.05)
    out["keyboard_plus"] = {"fov_from": f0, "fov_to": c.fov, "centre_moved_deg": math.hypot((c.ra0 - ra0) * math.cos(math.radians(dec0)), c.dec0 - dec0)}
    allv = [s["drift_px"] for grp in ("wheel", "touchpad_pinch") for r in out[grp] for s in r["steps"]]
    out["worst_px"] = max(allv)
    out["median_px"] = statistics.median(allv)
    kb = out["keyboard_plus"]
    out["pass"] = (out["worst_px"] <= LIMIT_PX and all(r["placed"] for g in ("wheel", "touchpad_pinch") for r in out[g])
                   and kb["fov_to"] < kb["fov_from"] and kb["centre_moved_deg"] < 1e-9)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=1))
    for g in ("wheel", "touchpad_pinch"):
        for r in out[g]:
            print(f"{g:15s} {r['point']:20s} fov {r['start_fov']:7.3f} cursor {r['cursor_px']}: max {r['max_px']:.4f} px, "
                  f"median {r['median_px']:.4f} px")
    print("keyboard +:", kb)
    print(f"worst {out['worst_px']:.4f} px, median {out['median_px']:.4f} px, pass {out['pass']}  -> {args.out}")
    win.close()
    return 0 if out["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
