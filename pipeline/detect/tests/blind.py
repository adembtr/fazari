#!/usr/bin/env python3
"""Blind recovery and null tests on fields with data on disk.

  uv run ... python -I pipeline/detect/tests/blind.py --out /tmp/blind barnard eps_indi_b wise0855 \
      job:luhman16-162.295s53.317-c6-b63-pm8778 rw_aur r_dra

The finder runs WITHOUT the target position (the field centre is only the stack centre; the
target is not excluded from anything and not given to any detector). Afterwards the
candidates are compared with the reference track of the target (catalogue position, proper
motion, parallax): the nearest non-artifact motion candidate within MATCH_ARCSEC at 2026.0.
Writes <out>/<field>/candidates.json and <out>/blind_summary.json.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))

from astropy.time import Time                   # noqa: E402

from detect import data as Dt                   # noqa: E402
from detect import run as R                     # noqa: E402
from detect import schema as SC                 # noqa: E402
import blink as BL                              # noqa: E402

MATCH_ARCSEC = 6.0


def reference(name):
    """Reference target dict (blink.py target schema) or None."""
    if name.startswith("job:"):
        rp = BL.ROOT / "cache" / "local" / "jobs" / name[4:] / "request.json"
        if rp.exists():
            return json.loads(rp.read_text()).get("target")
        return None
    return BL.load_target(name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fields", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--detectors", default="A,B,D,V")
    a = ap.parse_args()
    out = Path(a.out)
    rows = []
    for name in a.fields:
        rowp = out / name.replace(":", "_") / "blind_row.json"
        try:                                   # restartable: a finished field is not run again
            rows.append(json.loads(rowp.read_text()))
            print(f"{name}: done before, skipped", flush=True)
            continue
        except (OSError, ValueError):
            pass
        t0 = time.time()
        if name.startswith("job:"):
            field = Dt.job_field(name[4:], out_dir=out / name.replace(":", "_"))
            meta_p = BL.ROOT / "cache" / "jobs" / name[4:] / "meta.json"
        else:
            field = Dt.challenge_field(name)
            field.out_dir = out / name
            meta_p = BL.ROOT / "site" / "data" / name / "meta.json"
        dets = [d for d in R.DETECTORS if d.NAME in a.detectors.split(",")]
        cands, ctx = R.find(field, detectors=dets, opts={"no_sso": True})
        meta = json.loads(meta_p.read_text()) if meta_p.exists() else None
        doc = R.write_candidates(ctx, cands, field.out_dir / "candidates.json", overwrite=True, meta=meta)
        t = reference(name)
        row = {"field": name, "label": field.label, "n_exposures": len(ctx.exps), "seasons": ctx.seasons,
               "summary": doc["summary"], "seconds": round(time.time() - t0, 1),
               "non_artifact": [{"id": c["id"], "class": c["class"], "kind": c["kind"], "detectors": c["detectors"],
                                 "ra": round(c["ra"], 6), "dec": round(c["dec"], 6),
                                 "speed": (c.get("motion") or {}).get("speed_arcsec_yr"),
                                 "pa": (c.get("motion") or {}).get("pa_deg"), "flags": c["flags"][:3]}
                                for c in cands if c["class"] != "artifact"]}
        if t and t.get("kind", "motion") == "motion" and (t.get("pmra") or t.get("pmdec")):
            mjd26 = Time(2026.0, format="jyear").mjd
            r26, d26 = BL.target_position(t, mjd26, with_parallax=False)
            ref_sp = math.hypot(t["pmra"], t["pmdec"]) / 1000
            ref_pa = math.degrees(math.atan2(t["pmra"], t["pmdec"])) % 360
            best = None
            for c in cands:
                if c["kind"] != "motion" or c["class"] == "artifact" or not c.get("motion"):
                    continue
                d = SC.sep_arcsec(c["ra"], c["dec"], r26, d26)
                if d < MATCH_ARCSEC and (best is None or d < best[0]):
                    best = (d, c)
            row["reference"] = {"ra_2026": r26, "dec_2026": d26, "speed_arcsec_yr": round(ref_sp, 4),
                                "pa_deg": round(ref_pa, 2), "pmra": t["pmra"], "pmdec": t["pmdec"],
                                "source": t.get("notes", "")[:120]}
            if best:
                d, c = best
                m = c["motion"]
                row["recovered"] = {"id": c["id"], "class": c["class"], "detectors": c["detectors"],
                                    "sep_arcsec": round(d, 2), "speed_arcsec_yr": m["speed_arcsec_yr"],
                                    "err_speed": m["err_speed_arcsec_yr"], "pa_deg": m["pa_deg"], "err_pa": m["err_pa_deg"],
                                    "pmra": m["pmra_mas_yr"], "pmdec": m["pmdec_mas_yr"],
                                    "d_speed": round(m["speed_arcsec_yr"] - ref_sp, 4),
                                    "d_pa": round((m["pa_deg"] - ref_pa + 180) % 360 - 180, 2),
                                    "bins": c["bins"], "season_pairs": c["season_pairs"], "flags": c["flags"],
                                    "parallax_mas": m.get("parallax_mas")}
            else:
                row["recovered"] = None
        rows.append(row)
        rowp.parent.mkdir(parents=True, exist_ok=True)
        rowp.with_suffix(".part").write_text(json.dumps(SC._clean(row), indent=1))
        rowp.with_suffix(".part").replace(rowp)
        print(json.dumps({k: row.get(k) for k in ("field", "summary", "reference", "recovered", "seconds")}, default=str)[:1500])
        print("  non-artifact:", [(x["id"], x["class"], x["kind"], x["detectors"], x["speed"]) for x in row["non_artifact"]])
    tag = "_".join(f.replace("job:", "")[:12] for f in a.fields)
    (out / f"blind_summary_{tag}.json").write_text(json.dumps(SC._clean(rows), indent=1))


if __name__ == "__main__":
    main()
