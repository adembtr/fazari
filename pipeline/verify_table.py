"""Build the verification table for site/verify.html from the pipeline outputs.

Reads (never writes) the products of blink.py:
  site/data/<target>/meta.json                       the five challenge targets
  cache/jobs/luhman16-*/meta.json                    Luhman 16AB, a local-engine job (the run with the
                                                     most cutouts), or --job DIR to choose one
  site/data/accuracy.json or pipeline/accuracy.json  if another tool wrote one: copied in as "accuracy"
Writes:
  site/data/verify/table.json   (or --out FILE)

Python standard library only:
  python3 -I pipeline/verify_table.py [--job cache/jobs/<id>] [--out FILE]

Pass / fail rule (also written into the JSON): a motion target passes when the measured shift vector
between the two same-orientation seasons agrees with the reference prediction within 3 sigma, where
sigma is our 1-sigma shift error (shift_err_arcsec). Catalogue errors are much smaller and left out.
The difference is the full 2-D vector difference (length and direction).
"""

import glob
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
NSIG = 3.0

TARGETS = [  # (id, display name, challenge target?)
    ("barnard", "Barnard's Star", True),
    ("eps_indi_b", "Epsilon Indi B", True),
    ("wise0855", "WISE 0855−0714", True),
    ("luhman16", "Luhman 16AB", False),
    ("rw_aur", "RW Aurigae", True),
    ("r_dra", "R Draconis", True),
]


def vec(shift, pa):
    """(east, north) arcsec from length and position angle (deg, east of north)."""
    a = math.radians(pa)
    return shift * math.sin(a), shift * math.cos(a)


def r(x, n=3):
    return None if x is None else round(float(x), n)


def season_count(meta, key):
    return sum(1 for c in (meta.get("measured", {}).get("detection", {}).get(key) or []) if c.get("detected"))


def motion_row(tid, name, challenge, meta, src, viewer):
    m = meta["measured"]
    g = meta.get("gaia") or {}
    det = m.get("detection") or {}
    me, mn = vec(m["shift_arcsec"], m["pa_deg"])
    ge, gn = vec(m["gaia_predicted_arcsec"], m["gaia_pa_deg"])
    dvec = math.hypot(me - ge, mn - gn)
    err = m["shift_err_arcsec"]
    nsig = dvec / err if err else None
    fit = m.get("fit") or {}
    pm = None
    if fit.get("pmra_mas_yr") is not None:
        pm = {
            "measured_mas_yr": [r(fit["pmra_mas_yr"], 1), r(fit["pmdec_mas_yr"], 1)],
            "err_mas_yr": [r(fit.get("pmra_err_mas_yr"), 1), r(fit.get("pmdec_err_mas_yr"), 1)],
            "reference_mas_yr": [r(fit.get("gaia_pmra_mas_yr"), 1), r(fit.get("gaia_pmdec_mas_yr"), 1)],
            "n_used": fit.get("n_used") or fit.get("n_seasons"),
        }
        pm["diff_sigma"] = [r(abs(a - b) / e, 1) if e else None
                            for a, b, e in zip(pm["measured_mas_yr"], pm["reference_mas_yr"], pm["err_mas_yr"])]
    ref_label = g.get("label") or "reference"
    ref_detail = g.get("parallax_reference") or ""
    if g.get("source_id"):
        ref_detail = f"Gaia DR3 {g['source_id']}: proper motion, parallax" + (
            " and radial velocity" if tid == "barnard" else "") + f" (reference epoch {g.get('ref_epoch')})"
    row = {
        "id": tid, "name": name, "challenge": challenge, "kind": "motion",
        "status": "pass" if nsig is not None and nsig <= NSIG else "fail",
        "detection": m.get("status"), "detection_message": m.get("message"),
        "detected_bins_um": det.get("detected_bins_um"),
        "n_images": meta.get("n_cutouts"), "seasons": meta.get("epochs"),
        "astrometry_path": m.get("astrometry_path"),
        "measured": {"shift_arcsec": r(m["shift_arcsec"]), "err_arcsec": r(err), "pa_deg": r(m["pa_deg"], 2),
                     "from": m["from_epoch"], "to": m["to_epoch"], "dt_years": r(m["dt_years"], 4),
                     "same_orientation": m.get("same_orientation")},
        "reference": {"shift_arcsec": r(m["gaia_predicted_arcsec"]), "pa_deg": r(m["gaia_pa_deg"], 2),
                      "label": ref_label, "detail": ref_detail, "parallax_mas": g.get("parallax_mas") or None,
                      "pm_total_mas_yr": r(math.hypot(g.get("pmra_mas_yr") or 0, g.get("pmdec_mas_yr") or 0), 1)},
        "diff": {"shift_arcsec": r(m["shift_arcsec"] - m["gaia_predicted_arcsec"]),
                 "percent": r(100 * (m["shift_arcsec"] / m["gaia_predicted_arcsec"] - 1), 2),
                 "vector_arcsec": r(dvec), "sigma": r(nsig, 2),
                 "pa_deg": r((m["pa_deg"] - m["gaia_pa_deg"] + 180) % 360 - 180, 2)},
        "proper_motion": pm,
        "position_minus_reference_2026_arcsec": [r(fit.get("pos_2026_minus_gaia_east_arcsec")),
                                                 r(fit.get("pos_2026_minus_gaia_north_arcsec"))],
        "season_minus_reference_arcsec": [
            {"epoch": p.get("epoch"), "east": r(p.get("minus_gaia_east_arcsec")), "north": r(p.get("minus_gaia_north_arcsec")),
             "err_east": r(p.get("err_east_arcsec")), "err_north": r(p.get("err_north_arcsec"))}
            for p in (m.get("positions") or []) if p.get("minus_gaia_east_arcsec") is not None],
        "source": src, "viewer": viewer,
    }
    return row


def luhman_row():
    paths = [p for p in glob.glob(str(ROOT / "cache" / "jobs" / "luhman16-*" / "meta.json"))]
    if "--job" in sys.argv:
        paths = [str(Path(sys.argv[sys.argv.index("--job") + 1]) / "meta.json")]
    best = None
    for p in paths:
        try:
            meta = json.loads(Path(p).read_text())
        except (OSError, ValueError):
            continue
        if (meta.get("measured") or {}).get("shift_arcsec") is None:
            continue
        if best is None or meta.get("n_cutouts", 0) > best[1].get("n_cutouts", 0):
            best = (p, meta)
    if not best:
        return None
    p, meta = best
    job = Path(p).parent.name
    row = motion_row("luhman16", "Luhman 16AB", False, meta, f"cache/jobs/{job}/meta.json (local engine job {job})",
                     f"ornek.html?data=/jobs/{job}/")
    row["local_job"] = job
    row["reference"]["label"] = "SIMBAD proper motion"
    plx = (meta.get("gaia") or {}).get("parallax_mas") or 0      # jobs since the categories carry a parallax
    if plx:
        row["reference"]["detail"] = (f"SIMBAD via CDS Sesame (site/data/categories.json), epoch 2000. The prediction "
                                      f"includes the annual parallax ({plx:g} mas).")
        return row
    row["reference"]["detail"] = ("SIMBAD via CDS Sesame (site/data/categories.json), epoch 2000. The prediction has "
                                  "no parallax; between two seasons ~1 year apart the parallax shift nearly cancels.")
    # how much parallax can be left between the two seasons: |dt - 1 yr| of the Earth's orbit, plx ~0.5"
    dt = meta["measured"]["dt_years"]
    row["reference"]["parallax_residual_max_arcsec"] = r(0.5 * 2 * math.pi * abs(dt - round(dt)), 3)
    return row


def brightness_row(tid, name, meta):
    ph = (meta.get("measured") or {}).get("photometry") or {}
    g = meta.get("gaia") or {}
    pm = math.hypot(g.get("pmra_mas_yr") or 0, g.get("pmdec_mas_yr") or 0)
    bins = []
    for b in ph.get("bins") or []:
        ss = b.get("seasons") or []
        if not ss:
            continue
        bins.append({"wavelength_um": b.get("wavelength_um"), "detector": b.get("detector"),
                     "seasons": [s["epoch"] for s in ss],
                     "ratio": [r(s.get("ratio_to_first")) for s in ss], "err": [r(s.get("ratio_err")) for s in ss],
                     "flags": b.get("flags") or []})
    return {
        "id": tid, "name": name, "challenge": True, "kind": "brightness", "status": "not_measurable",
        "n_images": meta.get("n_cutouts"), "seasons": meta.get("epochs"),
        "expected_motion_arcsec_yr": r(pm / 1000, 4),
        "reference": {"label": "Gaia DR3 proper motion", "detail": f"Gaia DR3 {g.get('source_id')}",
                      "parallax_mas": g.get("parallax_mas") or None},
        "brightness_bins": bins,
        "brightness_caveats": ph.get("caveats"),
        "source": f"site/data/{tid}/meta.json", "viewer": f"ornek.html?data=data/{tid}/",
    }


def main():
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else DATA / "verify" / "table.json"
    rows = []
    for tid, name, challenge in TARGETS:
        if tid == "luhman16":
            row = luhman_row()
            if row:
                rows.append(row)
            continue
        p = DATA / tid / "meta.json"
        meta = json.loads(p.read_text())
        m = meta.get("measured") or {}
        if m.get("shift_arcsec") is not None:
            rows.append(motion_row(tid, name, challenge, meta, f"site/data/{tid}/meta.json", f"ornek.html?data=data/{tid}/"))
        elif m.get("status") == "brightness":
            rows.append(brightness_row(tid, name, meta))
        else:
            rows.append({"id": tid, "name": name, "challenge": challenge, "kind": "motion", "status": "not_detected",
                         "detection_message": m.get("message"), "source": f"site/data/{tid}/meta.json"})
    doc = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": "pipeline/verify_table.py",
        "criterion": {
            "n_sigma": NSIG,
            "text": ("Pass: the measured shift between two seasons seen with the same telescope orientation agrees "
                     f"with the reference prediction within {NSIG:g} sigma. Sigma is our 1-sigma error of the shift; "
                     "the catalogue errors are much smaller and are left out. The difference is the full 2-D "
                     "difference (length and direction)."),
        },
        "rows": rows,
    }
    for acc in (DATA / "accuracy.json", ROOT / "pipeline" / "accuracy.json"):
        if acc.exists():
            try:
                doc["accuracy"] = json.loads(acc.read_text())
                doc["accuracy_source"] = str(acc.relative_to(ROOT))
            except ValueError:
                pass
            break
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    print("wrote", out)
    for row in rows:
        if row["kind"] == "motion" and "measured" in row:
            print(f"  {row['name']:16s} {row['measured']['shift_arcsec']:7.3f} +- {row['measured']['err_arcsec']:.3f}  "
                  f"ref {row['reference']['shift_arcsec']:7.3f}  diff {row['diff']['shift_arcsec']:+.3f} "
                  f"|d| {row['diff']['vector_arcsec']:.3f} = {row['diff']['sigma']:.2f} sigma  {row['status']}")
        else:
            print(f"  {row['name']:16s} {row['status']}")


if __name__ == "__main__":
    main()
