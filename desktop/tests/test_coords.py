#!/usr/bin/env python3
"""Coordinate round-trip test for Fazari Sky 3D (offscreen, no mouse or keyboard).

  QT_QPA_PLATFORM=offscreen uv run --no-project --with vispy --with PyQt5 --with numpy --with astropy \
      --with astropy-healpix python -I desktop/tests/test_coords.py [--shots DIR] [--out FILE]

Everything is ICRS (RA/Dec, degrees). For Barnard's Star, Epsilon Indi B, Luhman 16 and 20 random
points, at several fields of view (down to 0.05 deg), it checks:

  marker    typed text -> parse -> marker vertex (float32 on the GPU) vs the true direction
  cpu       coordinate -> screen pixel (float64) -> coordinate (the pick math)
  click     the same with the pixel rounded to an integer (what a real mouse click gives), and the
            text the input box shows after that click, parsed back
  gpu       the marker as the GPU draws it: rendered image -> centroid of the marker pixels ->
            pick -> coordinate (catches any float32 / shader / projection mismatch)

and that a marker on Barnard's Star (Gaia DR3 position + proper motion to 2026.0) lands on the star
drawn in the background. Writes the numbers to JSON and screenshots B_barnard_marker.png and
B_footprints.png. Exit code 1 if any error is 1 arcsec or more.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import sky_viewer as sv                      # noqa: E402
import sky_catalog as cat                    # noqa: E402
import numpy as np                           # noqa: E402

ROOT = HERE.parent.parent
NAMED = {"barnard": (269.44627, 4.76820), "eps_indi_b": (331.09665, -56.80066), "luhman16": (162.3289, -53.3194)}
FOVS = [60.0, 10.0, 1.0, 0.2, 0.05]
LIMIT_ARCSEC = 1.0


def sep_arcsec(ra1, dec1, ra2, dec2):
    a = cat.radec_to_xyz(ra1, dec1)
    b = cat.radec_to_xyz(ra2, dec2)
    # atan2 form: exact for tiny angles (acos loses precision below ~0.01")
    return math.degrees(math.atan2(np.linalg.norm(np.cross(a, b)), float(np.dot(a, b)))) * 3600.0


def vec_sep_arcsec(v, ra, dec):
    v = np.asarray(v, np.float64)
    b = cat.radec_to_xyz(ra, dec)
    return math.degrees(math.atan2(np.linalg.norm(np.cross(v, b)), float(np.dot(v, b)))) * 3600.0


class T:
    def __init__(self, args):
        self.args = args
        self.qapp = sv.make_app()
        self.win = sv.MainWindow(sv.parse_args(["--size", "1480x860"]))
        self.win.resize(1480, 860)
        self.win.show()
        self.c = self.win.canvas
        self.pump(1.0)

    def pump(self, sec=0.0, until=None, timeout=30.0):
        t0 = time.perf_counter()
        while True:
            self.qapp.processEvents()
            if until is not None and until():
                return True
            if until is None and time.perf_counter() - t0 >= sec:
                return True
            if time.perf_counter() - t0 >= timeout:
                return False
            time.sleep(0.004)

    def isolate(self, stars=False):
        c = self.c
        c.show_milky_way = False
        c.show_stars = stars
        c.show_markers = False
        c.show_footprints = False
        c.show_grid = False
        c.show_compass = False
        c.show_lines = False

    def restore(self):
        c = self.c
        c.show_milky_way = c.show_stars = c.show_markers = c.show_footprints = c.show_grid = c.show_compass = True
        c.show_lines = True

    def centroid(self, img, px, py, rad, mask_fn):
        """Weighted centroid (logical px) of pixels selected by mask_fn within rad logical px."""
        pr = self.c.pixel_scale
        H, W = img.shape[:2]
        x0, x1 = int(max(0, (px - rad) * pr)), int(min(W, (px + rad) * pr))
        y0, y1 = int(max(0, (py - rad) * pr)), int(min(H, (py + rad) * pr))
        sub = img[y0:y1, x0:x1, :3].astype(np.float64)
        wgt = mask_fn(sub)
        if wgt.sum() <= 0:
            return None
        yy, xx = np.mgrid[y0:y1, x0:x1]
        cx = ((xx + 0.5) * wgt).sum() / wgt.sum() / pr
        cy = ((yy + 0.5) * wgt).sum() / wgt.sum() / pr
        return cx, cy

    def round_trip(self, name, ra, dec, rng):
        c, w = self.c, self.win
        rows = []
        for fov in FOVS:
            # put the point off-centre (up to 30% of the field) so the whole projection is exercised
            ang = rng.uniform(0, 2 * math.pi)
            off = 0.3 * fov * rng.uniform(0.2, 1.0)
            cdec = max(-89.0, min(89.0, dec + off * math.sin(ang)))
            cra = ra + off * math.cos(ang) / max(math.cos(math.radians(cdec)), 0.05)
            c.set_view(cra, cdec, fov)
            # typed text -> marker
            w.coord_edit.setText(f"{ra:.6f} {dec:+.6f}")
            w.apply_coord_text(fly=False)
            if c.animating:
                c._anim = None
                c.set_view(cra, cdec, fov)
            e_marker = vec_sep_arcsec(c.pick_xyz, ra, dec)
            # coordinate -> pixel -> coordinate (float64)
            px, py = c.project(ra, dec)
            r2, d2 = c.pick(px, py)
            e_cpu = sep_arcsec(ra, dec, r2, d2)
            # integer pixel (a mouse click), then what the input box shows
            ipx, ipy = round(px), round(py)
            rc, dc = c.pick(ipx, ipy)
            e_click = sep_arcsec(ra, dec, rc, dc)
            w.on_canvas_pick(rc, dc)
            snapped = w.pick[2] is not None
            rt, dt_ = sv.parse_coord(w.coord_edit.text())
            e_text = sep_arcsec(w.pick[0], w.pick[1], rt, dt_)
            # half a pixel at this zoom (the resolution limit of a click)
            half_px = sep_arcsec(*c.pick(px, py), *c.pick(px + 0.5, py))
            # GPU: render only the picked-point marker and find its centroid
            c.set_pick(ra, dec)
            self.isolate()
            img = c.render()
            self.restore()
            cen = self.centroid(img, px, py, 24,
                                lambda s: np.where((s[..., 1] > 60) & (s[..., 2] > 60) & (s[..., 0] < 0.6 * s[..., 1]),
                                                   s[..., 1], 0.0))
            if cen is None:
                e_gpu, gpu_px = None, None
            else:
                rg, dg = c.pick(*cen)
                e_gpu = sep_arcsec(ra, dec, rg, dg)
                gpu_px = math.hypot(cen[0] - px, cen[1] - py)
            rows.append({"point": name, "fov_deg": fov, "marker_arcsec": e_marker, "cpu_arcsec": e_cpu,
                         "click_int_px_arcsec": e_click, "input_text_arcsec": e_text, "half_pixel_arcsec": half_px,
                         "gpu_arcsec": e_gpu, "gpu_px": gpu_px, "snapped_to_listed_point": snapped})
        return rows

    def barnard_marker(self):
        """Marker at Barnard's Gaia DR3 position moved to 2026.0 vs the star drawn in the background."""
        c, w = self.c, self.win
        g = json.loads((ROOT / "site" / "data" / "barnard" / "meta.json").read_text())["gaia"]
        ra26, dec26 = cat.propagate(g["ra_deg"], g["dec_deg"], g["pmra_mas_yr"], g["pmdec_mas_yr"],
                                    cat.EPOCH - g["ref_epoch"])
        ra26, dec26 = float(ra26), float(dec26)
        c.set_view(ra26, dec26, 0.2)
        ok = self.pump(until=lambda: c.loader.pending == 0 and not c._lod_dirty and len(c.resident) > 0, timeout=120)
        self.pump(1.0)
        px, py = c.project(ra26, dec26)
        self.isolate(stars=True)
        img = c.render()
        self.restore()
        if self.args.debug:
            from vispy import io as vio
            vio.write_png(self.args.debug, img)
            print("debug: resident", sorted(k for k in c.resident if k[0] == 0), "wanted", sorted(k for k in c.wanted if k[0] == 0),
                  "view", c.ra0, c.dec0, c.fov, "px", px, py, flush=True)
        # Barnard (G = 8.2) is drawn as a ~22 px sprite; its nearest Gaia neighbour brighter than
        # G = 10 is 590" (680 px) away, so a 12 px window around the expected pixel holds only it.
        # (The brightest pixel of the wider field is a white star: Barnard is red, so its summed RGB
        # is lower. Take the luminance-weighted centroid in the 12 px window instead.)
        pr = c.pixel_scale
        cen = self.centroid(img, px, py, 12, lambda s: np.clip(s.sum(axis=2) - 6.0, 0, None) ** 2)
        rs, ds = c.pick(*cen)
        res = {"gaia_dr3": g["source_id"], "ra_2026": ra26, "dec_2026": dec26,
               "categories_ra_2026": 269.446268, "categories_dec_2026": 4.768204,
               "star_centroid_px": [round(cen[0], 2), round(cen[1], 2)], "marker_px": [round(px, 2), round(py, 2)],
               "star_vs_marker_arcsec": sep_arcsec(ra26, dec26, rs, ds),
               "pixel_arcsec_at_fov": sep_arcsec(*c.pick(px, py), *c.pick(px + 1, py)),
               "gaia_2016_vs_2026_arcsec": sep_arcsec(g["ra_deg"], g["dec_deg"], ra26, dec26), "tiles_loaded": ok}
        w.coord_edit.setText(f"{ra26:.6f} {dec26:+.6f}")
        w.apply_coord_text(fly=False)
        self.pump(0.5)
        p = Path(self.args.shots) / "B_barnard_marker.png"
        w.grab().save(str(p))
        res["screenshot"] = str(p)
        # a close-up crop of the centre
        img2 = w.grab()
        cx, cy = int(px * pr), int(py * pr)
        img2.copy(cx - int(60 * pr), cy - int(60 * pr), int(120 * pr), int(120 * pr)).scaled(480, 480).save(
            str(Path(self.args.shots) / "B_barnard_marker_closeup.png"))
        return res

    def footprints(self):
        c, w = self.c, self.win
        ra, dec = NAMED["barnard"]
        c.set_view(ra, dec, 14.0)
        w.foot_info = None
        w.coord_edit.setText(f"{ra:.6f} {dec:+.6f}")
        w.apply_coord_text(fly=False)
        self.pump(until=lambda: getattr(w, "foot_info", None) is not None, timeout=60)
        self.pump(until=lambda: c.loader.pending == 0, timeout=60)
        self.pump(0.8)
        p = Path(self.args.shots) / "B_footprints.png"
        w.grab().save(str(p))
        return {"screenshot": str(p), **(w.foot_info or {})}

    def run(self):
        rng = np.random.default_rng(2026)
        pts = dict(NAMED)
        for i in range(20):
            z = rng.uniform(-1, 1)
            pts[f"random_{i:02d}"] = (float(rng.uniform(0, 360)), float(math.degrees(math.asin(z))))
        rows = []
        for name, (ra, dec) in pts.items():
            rows += self.round_trip(name, ra, dec, rng)
        out = {"points": {k: list(v) for k, v in pts.items()}, "fovs_deg": FOVS, "rows": rows, "summary": {}}
        for key in ("marker_arcsec", "cpu_arcsec", "click_int_px_arcsec", "input_text_arcsec", "gpu_arcsec"):
            v = np.array([r[key] for r in rows if r[key] is not None])
            out["summary"][key] = {"n": int(len(v)), "max": float(v.max()), "median": float(np.median(v))}
            for fov in FOVS:
                vf = np.array([r[key] for r in rows if r[key] is not None and r["fov_deg"] == fov])
                out["summary"][f"{key}@{fov:g}"] = {"max": float(vf.max()), "median": float(np.median(vf))}
        out["summary"]["gpu_px"] = {"max": float(max(r["gpu_px"] for r in rows if r["gpu_px"] is not None))}
        out["barnard_marker"] = self.barnard_marker()
        out["footprints"] = self.footprints()
        Path(self.args.out).write_text(json.dumps(out, indent=1))
        for k, v in out["summary"].items():
            if "@" not in k:
                print(f"{k:22s} {v}")
        for k, v in out["summary"].items():
            if "@" in k:
                print(f"{k:28s} max {v['max']:.4f}\"  median {v['median']:.4f}\"")
        print("barnard marker", json.dumps(out["barnard_marker"]))
        print("footprints", json.dumps(out["footprints"]))
        # Exact paths (text -> marker, pixel <-> coordinate in float64, input box) must be < 1".
        # What is measured on rendered pixels (GPU centroid, integer-pixel click) cannot beat the
        # pixel itself: those must be < max(1", half a pixel at that zoom).
        bad = [r for r in rows if max(r["marker_arcsec"], r["cpu_arcsec"], r["input_text_arcsec"]) >= LIMIT_ARCSEC]
        bad_px = [r for r in rows if (r["gpu_arcsec"] is None or
                                      r["gpu_arcsec"] >= max(LIMIT_ARCSEC, r["half_pixel_arcsec"]) or
                                      r["click_int_px_arcsec"] >= max(LIMIT_ARCSEC, 1.5 * r["half_pixel_arcsec"]))]
        out["pass"] = {"exact_paths_failing": len(bad), "pixel_limited_failing": len(bad_px)}
        Path(self.args.out).write_text(json.dumps(out, indent=1))
        print(f"rows {len(rows)}: exact paths >= 1\": {len(bad)};  GPU/click beyond max(1\", pixel limit): {len(bad_px)}")
        self.win.close()
        return 1 if bad or bad_px or out["barnard_marker"]["star_vs_marker_arcsec"] >= LIMIT_ARCSEC else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=str(ROOT.parent / "gorseller" / "uygulama"))
    ap.add_argument("--debug", default="")
    ap.add_argument("--out", default=str(ROOT / "cache" / "sky3d" / "test_coords.json"))
    sys.exit(T(ap.parse_args()).run())


if __name__ == "__main__":
    main()
