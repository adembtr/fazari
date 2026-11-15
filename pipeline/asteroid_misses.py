#!/usr/bin/env python3
"""Why the V8 known-asteroid run missed its bright objects (pipeline/ASTEROID_MISSES.md). Cache only:
every network call raises, nothing is written to cache/asteroids/runs/.

  uv run --no-project --with numpy,astropy,scipy,pillow,reproject,matplotlib python -I pipeline/asteroid_misses.py \
      boxes [--vmax 18] [--out misses_boxes.json]          # re-run the boxes of each missed object, old code path
  ... python -I pipeline/asteroid_misses.py trial F10,F04 [--out trial.json]
                                                            # whole fields, STAR_MASK_NSIG None (V8) vs current value

boxes: per missed object (V < vmax, newest run file per field, as the V8 report) and sub-exposure: forced EPSF S/N
at the predicted position, reference flux R3 and difference flux D3 in the 3 x 3 pixels there, and every
candidate within 3 px with its Z, S/N, EPSF chi2 (and the allowed chi2), reference/excess ratio and rejection reason.
trial: runs the detection of whole fields twice (old fit stamp, new star mask) and counts found / known objects and
false detections; the first run must reproduce the stored V8 run of the field.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_region as FR  # noqa: E402
from detect import asteroids as A, s3box as S3, ssoephem as EPH  # noqa: E402

RUNS = S3.CACHE / "runs"


def _offline(*a, **k):
    raise RuntimeError("offline: not in the cache")


FR._keepalive_get = _offline
S3._get_range = _offline
EPH._get = _offline


def newest_runs():
    out = {}
    for p in RUNS.glob("F*.json"):
        fid = p.name[:3]
        if fid not in out or p.stat().st_mtime > out[fid].stat().st_mtime:
            out[fid] = p
    return dict(sorted(out.items()))


def boxes(vmax):
    A.STAR_MASK_NSIG = None                     # the code path of the V8 run
    out = []
    for fid, path in newest_runs().items():
        d = json.loads(path.read_text())
        exps = [S3.exposure(s["key"]) for s in d["field"]["subs"]]
        for k in d["known"]:
            if k["V"] >= vmax or k.get("found"):
                continue
            pred = {p["sub"]: p for p in k["predicted"]}
            inside = [i for i in range(len(exps)) if (i + 1) in pred]
            rr, dd = [], []
            for i in inside:
                r_, d_ = A.box_corners_world(exps[i], [round(pred[i + 1]["x"])], [round(pred[i + 1]["y"])])
                rr.append(r_)
                dd.append(d_)
            rec = dict(field=fid, run=path.name, name=k["name"], V=k["V"], reason=k["reason"],
                       rate_arcsec_h=round(math.hypot(k["rate_cosd_h"], k["rate_dec_h"]), 1), subs=[])
            try:
                refs = [A.RefPatch(S3.exposure(rk), np.concatenate(rr), np.concatenate(dd)) for rk in k["ref_keys"]]
            except RuntimeError:
                rec["error"] = "reference patches not in the cache with these extents"
                out.append(rec)
                continue
            for i in inside:
                p = pred[i + 1]
                try:
                    b = A.detect_box(exps[i], refs, int(round(p["x"])), int(round(p["y"])))
                except RuntimeError:
                    rec["subs"].append(dict(sub=i + 1, error="box not in the cache"))
                    continue
                s = dict(sub=i + 1, n_ref=b["n_ref"], noise=b.get("noise"))
                if b.get("D") is None:
                    s["why"] = b.get("reason")
                    rec["subs"].append(s)
                    continue
                xi, yi = p["x"] - b["origin"][0], p["y"] - b["origin"][1]
                ix, iy = int(round(xi)), int(round(yi))
                sl = (slice(iy - 1, iy + 2), slice(ix - 1, ix + 2))
                fc = A.forced(b, xi, yi)
                s.update(forced_snr=None if not fc else round(fc["snr"], 1),
                         R3=round(float(np.nansum(b["R"][sl])), 3), D3=round(float(np.nansum(b["D"][sl])), 3))
                near = []
                for kind, lst in (("kept", b["dets"]), ("rejected", b.get("rej", []))):
                    for q in lst:
                        dist = math.hypot(q["x"] - p["x"], q["y"] - p["y"])
                        if dist <= 3:
                            f = dict(snr=q["snr"], chi2r=q["chi2r"])
                            near.append(dict(kind=kind, dist_px=round(dist, 2), z=round(q["z"], 1), snr=round(q["snr"], 1),
                                             chi2r=round(q["chi2r"], 2),
                                             chi2_allowed=round(A.CHI2_MAX * (1 + (A.snr_raw(f) / A.CHI2_SNR) ** 2), 1),
                                             ratio=q["static_ratio"], why=q.get("why")))
                s["near"] = near
                rec["subs"].append(s)
            out.append(rec)
            print(json.dumps(rec), flush=True)
    return out


def tally(res):
    t = {}
    for k in res["known"]:
        for lim in (17, 18, 19, 20):
            if k["V"] < lim:
                a = t.setdefault(f"V<{lim}", [0, 0, 0])
                a[0] += bool(k.get("found"))
                a[1] += bool(k.get("found_stack"))
                a[2] += 1
    return t


def trial(fids):
    fields = {f["id"]: f for f in json.loads((S3.CACHE / "fields.json").read_text())}
    new_value = A.STAR_MASK_NSIG
    runs = newest_runs()
    A.log = lambda *a: None
    out = {}
    for fid in fids:
        row = {}
        for tag, val in (("v8_code", None), ("star_mask", new_value)):
            A.STAR_MASK_NSIG = val
            t0 = time.time()
            res = A.run_field(fields[fid], track=False)
            row[tag] = {"found_stack_known": tally(res), "n_false": res["n_false"], "n_false_stack": res["n_false_stack"],
                        "found": sorted(k["name"] for k in res["known"] if k.get("found")),
                        "found_stack": sorted(k["name"] for k in res["known"] if k.get("found_stack")),
                        "seconds": round(time.time() - t0, 1)}
        st = json.loads(runs[fid].read_text())
        row["stored_v8"] = {"file": runs[fid].name, "found_stack_known": tally(st), "n_false": st["n_false"],
                            "n_false_stack": st["n_false_stack"]}
        out[fid] = row
        print(fid, json.dumps({k: [v["found_stack_known"], v["n_false"], v["n_false_stack"]] for k, v in row.items()}),
              flush=True)
    A.STAR_MASK_NSIG = new_value
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["boxes", "trial"])
    ap.add_argument("fields", nargs="?", default="")
    ap.add_argument("--vmax", type=float, default=18.0)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    res = boxes(a.vmax) if a.what == "boxes" else trial([f for f in a.fields.split(",") if f])
    if a.out:
        Path(a.out).write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
