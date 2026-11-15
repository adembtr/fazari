#!/usr/bin/env python3
"""Re-run of test V8 (known asteroids) with the star-mask fix, and 24 new fields (pipeline/ASTEROIDS_RERUN_PLAN.md).

  UV="uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow"
  $UV python -I pipeline/asteroid_rerun.py select [--write]   # the 24 new fields (static sky index only)
  $UV python -I pipeline/asteroid_rerun.py compare --since 2026-11-15T13:00 [--out FILE] [--md FILE] [--csv FILE]

select: the same criteria as detect/asteroids.select_fields (D2/D3 visits whose 4 sub-exposures are within 2 deg
        of the ecliptic, the mission span cut into 24 equal time bins, the visit nearest the bin centre within one
        bin, detectors alternating, >= 3 reference visits >= 1 day away), with the bin centres moved by half a bin
        and the 24 visits of V8 left out. Reads the sky index catalogue and the static index, no pixel. First checks
        that the unshifted rule gives the 24 V8 fields again. --write: cache/asteroids/fields.json gets the new
        fields as F25-F48 (a copy of the 24-field file is kept as fields_v8.json, never overwritten).
compare: found / known per magnitude bin and false detections (confirmed objects in single exposures that match no
        known object, as in V8) for the stored V8 run files (newest per field before the V8 report, 2026-11-14
        13:41:58 UTC), for this re-run (newest run file per field written after --since), for the old 24 fields,
        the new fields and all together. Reads cache/asteroids/runs/ only.
"""
import argparse
import calendar
import csv
import gzip
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sky_index as SI  # noqa: E402
from detect import asteroids as A  # noqa: E402
from detect import asteroid_report as AR  # noqa: E402

V8_REPORT_UTC = "2026-11-14T13:41:58"         # summary.json of V8 ("generated"); its run files are older
OLD_IDS = [f"F{i:02d}" for i in range(1, 25)]
VLIMS = (17, 18, 19, 20)


def _ecliptic_visits(beta_max=2.0, catalog=None):
    """The visit list of select_fields, unchanged: (mjd, visit, detector, subs), sorted by time."""
    catalog = catalog or (A.BL.ROOT / "cache" / "sky_index" / "catalog.csv.gz")
    visits = {}
    with gzip.open(catalog, "rt") as fh:
        for r in csv.DictReader(fh):
            det = int(r["detector"])
            if det not in A.DETECTORS:
                continue
            ra, dec = float(r["ra_center"]), float(r["dec_center"])
            if abs(dec) > 30:
                continue
            b = A.ecliptic_beta(ra, dec)
            if abs(b) > beta_max + 0.5:
                continue
            vid = r["obs_id"].rsplit("_", 1)[0]
            visits.setdefault((vid, det), []).append(dict(obs_id=r["obs_id"], mjd=float(r["t_min"]), ra=ra, dec=dec,
                                                         beta=b, key=r["s3_key"], coll=r["collection"]))
    good = []
    for (vid, det), subs in visits.items():
        subs.sort(key=lambda s: s["obs_id"])
        if len(subs) != 4 or any(abs(s["beta"]) > beta_max for s in subs):
            continue
        good.append((subs[0]["mjd"], vid, det, subs))
    good.sort()
    return good


def pick(good, n=24, shift=0.0, exclude=frozenset(), first_id=1):
    """select_fields' bin loop; shift = bin centres moved by this fraction of a bin; exclude = {(visit, det)}."""
    t0, t1 = good[0][0], good[-1][0]
    w = (t1 - t0) / n
    pool = [g for g in good if (g[1], g[2]) not in exclude]
    fields, used, bins = [], set(), []
    for i in range(n):
        tc = t0 + (i + 0.5 + shift) * w
        want = A.DETECTORS[i % len(A.DETECTORS)]
        cands = sorted(pool, key=lambda g: (g[2] != want, abs(g[0] - tc)))
        for mjd, vid, det, subs in cands[:200]:
            if abs(mjd - tc) > w or (vid, det) in used:
                continue
            ra_c = float(np.mean([s["ra"] for s in subs]))
            dec_c = float(np.mean([s["dec"] for s in subs]))
            refs = [r for r in SI.find_images(ra_c, dec_c) if r["detector"] == det
                    and abs(r["mjd"] - mjd) >= A.REF_MIN_DAYS]
            nvis = len({r["obs_id"].rsplit("_", 1)[0] for r in refs})
            if nvis < A.N_REF:
                continue
            used.add((vid, det))
            bins.append(i)
            fields.append(dict(id=f"F{first_id + len(fields):02d}", visit=vid, detector=det, mjd=round(mjd, 6),
                               date=A._date(mjd), ra=round(ra_c, 5), dec=round(dec_c, 5),
                               beta=round(A.ecliptic_beta(ra_c, dec_c), 3),
                               lam=round(A.ecliptic_lambda(ra_c, dec_c), 2),
                               collection=subs[0]["coll"], n_ref_visits=nvis,
                               subs=[dict(obs_id=s["obs_id"], key=s["key"]) for s in subs]))
            break
    return fields, bins, (t0, t1, w)


def select(write=False):
    old = json.loads(A.FIELDS.read_text())[:24]
    assert [f["id"] for f in old] == OLD_IDS, "fields.json does not start with the 24 fields of V8"
    good = _ecliptic_visits()
    print(f"{len(good)} ecliptic visits with 4 sub-exposures on D{A.DETECTORS}")
    again, _, (t0, t1, w) = pick(good)
    same = [(f["visit"], f["detector"]) for f in again] == [(f["visit"], f["detector"]) for f in old]
    print(f"unshifted rule gives the 24 V8 fields again: {same}  (span MJD {t0:.3f}-{t1:.3f}, bin {w:.3f} d)")
    if not same:
        sys.exit("the selection does not reproduce V8: stop")
    new, bins, _ = pick(good, shift=0.5, exclude=frozenset((f["visit"], f["detector"]) for f in old), first_id=25)
    for f, i in zip(new, bins):
        print(f"{f['id']} bin {i:2d} {f['visit']} D{f['detector']} {f['date']} lambda {f['lam']:6.1f} beta {f['beta']:+.2f} "
              f"ref visits {f['n_ref_visits']}")
    print(f"{len(new)} new fields")
    if write:
        full = json.loads(A.FIELDS.read_text())
        if len(full) != 24:
            sys.exit(f"{A.FIELDS} has {len(full)} fields, not 24: not written")
        keep = A.FIELDS.with_name("fields_v8.json")
        if not keep.exists():
            shutil.copy2(A.FIELDS, keep)
        tmp = A.FIELDS.with_suffix(".part")
        tmp.write_text(json.dumps(full + new, indent=1))
        tmp.replace(A.FIELDS)
        print(f"wrote {A.FIELDS} (24 + {len(new)} fields); the 24-field file is kept as {keep}")
    return new


# ================================================================================ compare
def _runs(before=None, since=None):
    """Newest run file per field (F*.json) with mtime < before or >= since (epoch s); tracklets attached."""
    best = {}
    for p in A.RUNS.glob("F*.json"):
        m = p.stat().st_mtime
        if (before is not None and m >= before) or (since is not None and m < since):
            continue
        fid = p.stem.split("_")[0]
        if fid not in best or m > best[fid].stat().st_mtime:
            best[fid] = p
    out = {}
    for fid, p in sorted(best.items()):
        r = json.loads(p.read_text())
        tp = A.RUNS / f"T_{p.stem}.json"
        if not r.get("tracklets") and tp.exists():
            r["tracklets"] = json.loads(tp.read_text()).get("tracklets", [])
        r["_file"] = p.name
        out[fid] = r
    return out


def tally(runs):
    """Totals over fields: found / stack / known per V limit, false single / stack, tracklets."""
    t = {f"{a}_v{v}": 0 for v in VLIMS for a in ("found", "stack", "either", "known")}
    t.update(fields=0, false_single=0, false_stack=0, tracklets_tried=0, tracklets_linked=0, tracklets_wrong=0,
             found_objects=0, detections=0)
    offs = []
    for r in runs.values():
        row = AR.field_row(r)
        t["fields"] += 1
        for v in VLIMS:
            for a in ("found", "stack", "either", "known"):
                t[f"{a}_v{v}"] += row[f"{a}_v{v}"]
        t["false_single"] += row["n_false"] or 0
        t["false_stack"] += row["n_false_stack"] or 0
        t["tracklets_tried"] += row["n_tracklet_tried"]
        t["tracklets_linked"] += row["n_tracklets"]
        t["tracklets_wrong"] += row["n_tracklet_wrong"]
        t["found_objects"] += row["n_found"]
        offs += [d["off_px"] for k in r.get("known", []) if k.get("found") for d in k["dets"] if "off_px" in d]
    t["detections"] = len(offs)
    t["offset_px_median"] = round(float(np.median(offs)), 3) if offs else None
    t["offset_px_p90"] = round(float(np.percentile(offs, 90)), 3) if offs else None
    t["frac_within_1px"] = round(float(np.mean(np.array(offs) <= 1)), 4) if offs else None
    return t


def compare(since, out=None, md=None, csv_out=None):
    v8_before = calendar.timegm(time.strptime(V8_REPORT_UTC, "%Y-%m-%dT%H:%M:%S"))
    since_s = time.mktime(time.strptime(since, "%Y-%m-%dT%H:%M"))
    fields = json.loads(A.FIELDS.read_text())
    new_ids = [f["id"] for f in fields if f["id"] not in OLD_IDS]
    v8 = {k: v for k, v in _runs(before=v8_before).items() if k in OLD_IDS}
    rr = _runs(since=since_s)
    groups = {
        "v8_round_v1": v8,
        "rerun_old_fields": {k: v for k, v in rr.items() if k in OLD_IDS},
        "rerun_new_fields": {k: v for k, v in rr.items() if k in new_ids},
        "rerun_all_fields": {k: v for k, v in rr.items() if k in OLD_IDS or k in new_ids},
    }
    res = {g: tally(r) for g, r in groups.items()}
    res["files"] = {g: {k: v["_file"] for k, v in r.items()} for g, r in groups.items()}
    res["not_done"] = {"old": [k for k in OLD_IDS if k not in rr], "new": [k for k in new_ids if k not in rr]}
    # objects gained / lost on the old fields (V < 18), and false detections per old field before / after
    gl = []
    for fid in OLD_IDS:
        if fid not in v8 or fid not in rr:
            continue
        a = {k["name"]: k for k in v8[fid]["known"] if k.get("found")}
        b = {k["name"]: k for k in rr[fid]["known"] if k.get("found")}
        for nm in sorted(set(a) ^ set(b)):
            k = a.get(nm) or b.get(nm)
            gl.append(dict(field=fid, name=nm, V=k["V"], change="gained" if nm in b else "lost"))
    res["changes_old_fields"] = sorted(gl, key=lambda d: (d["V"], d["field"]))
    res["false_per_old_field"] = {fid: [v8[fid]["n_false"], rr[fid]["n_false"], v8[fid]["n_false_stack"],
                                        rr[fid]["n_false_stack"]] for fid in OLD_IDS if fid in v8 and fid in rr}
    res["since"] = since
    res["generated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    lines = ["| set | fields | V < 17 | V < 18 | V < 19 | V < 20 | false (single) | false (stack) | tracklets linked / tried (wrong) |",
             "|---|---|---|---|---|---|---|---|---|"]
    for g in ("v8_round_v1", "rerun_old_fields", "rerun_new_fields", "rerun_all_fields"):
        t = res[g]
        lines.append(f"| {g} | {t['fields']} | " + " | ".join(f"{t[f'found_v{v}']} / {t[f'known_v{v}']}" for v in VLIMS)
                     + f" | {t['false_single']} | {t['false_stack']} | {t['tracklets_linked']} / {t['tracklets_tried']}"
                     f" ({t['tracklets_wrong']}) |")
    text = "\n".join(lines)
    print(text)
    print("not done:", res["not_done"])
    print("changes on the old fields:", json.dumps(res["changes_old_fields"]))
    if out:
        Path(out).write_text(json.dumps(A._jsonable(res), indent=1))
    if csv_out:
        cols = ["id", "set", "visit", "detector", "date"] + [f"{a}_v{v}" for v in VLIMS for a in ("known", "found")] + [
            "n_found", "n_det", "off_px_median", "off_px_max", "frac_within_1px", "n_false", "n_false_stack",
            "v8_n_false", "v8_n_false_stack", "n_tracklets", "n_tracklet_tried", "n_tracklet_wrong", "file", "error"]
        with open(csv_out, "w", newline="") as fh:
            wr = csv.DictWriter(fh, cols, extrasaction="ignore")
            wr.writeheader()
            for fid, r in groups["rerun_all_fields"].items():
                row = AR.field_row(r)
                row.update(set="old" if fid in OLD_IDS else "new", file=r["_file"],
                           v8_n_false=v8[fid]["n_false"] if fid in v8 and fid in OLD_IDS else "",
                           v8_n_false_stack=v8[fid]["n_false_stack"] if fid in v8 and fid in OLD_IDS else "")
                wr.writerow(row)
    if md:
        Path(md).write_text(text + "\n")
    return res


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select")
    s.add_argument("--write", action="store_true")
    c = sub.add_parser("compare")
    c.add_argument("--since", required=True, help="local time YYYY-mm-ddTHH:MM: run files written after it are the re-run")
    c.add_argument("--out", default="")
    c.add_argument("--md", default="")
    c.add_argument("--csv", default="", help="per-field CSV of the re-run (evidence file)")
    a = ap.parse_args()
    if a.cmd == "select":
        select(a.write)
    else:
        compare(a.since, a.out or None, a.md or None, a.csv or None)


if __name__ == "__main__":
    main()
