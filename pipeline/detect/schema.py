"""Common candidate record of all detectors, merging, and the candidates.json writer.

Every detector returns a list of dicts made by new_candidate(); run.py merges records of the
same object found by several detectors and writes <out>/candidates.json:

  {"schema": "fazari-candidates/1", "field": {...}, "summary": {...}, "detectors": {...},
   "candidates": [ {record}, ... ]}

Record (fields not known stay null):
  id            "C001" (after merging)
  class         gaia-known | asteroid-known | candidate | variable | artifact
  kind          motion | appearing | disappearing | variable | transient
  detectors     ["A", "B", ...] that found it
  ra, dec       position (deg, ICRS) at `epoch` (Julian year; 2026.0 for motion, the
                exposure time for transients)
  positions     per season: {season, jyear, ra, dec, err_arcsec, n}
  motion        {pmra_mas_yr, pmdec_mas_yr, err_pmra_mas_yr, err_pmdec_mas_yr, speed_arcsec_yr,
                 err_speed_arcsec_yr, pa_deg, err_pa_deg, significance_sigma, method}
  snr           detection S/N (best unit)
  flux_ujy, mag_ab
  bins          stack units where it was seen ("1.0um", "D5", ...)
  season_pairs  [[from, to], ...] season pairs where it was seen
  match         {"gaia_dr3": {...}} or {"sso": {...}}: known-object match
  flags         list of short strings (why a class was given, rejections, cautions)
  notes         free text
Language: these are candidates for follow-up, never discoveries.
"""
import json
import math
from datetime import datetime, timezone

CLASSES = ("gaia-known", "asteroid-known", "candidate", "variable", "artifact")
KINDS = ("motion", "appearing", "disappearing", "variable", "transient")
SCHEMA = "fazari-candidates/1"


def new_candidate(detector, kind, ra, dec, epoch=2026.0, cls="candidate", **kw):
    assert cls in CLASSES, cls
    assert kind in KINDS, kind
    c = {"id": None, "class": cls, "kind": kind, "detectors": [detector], "ra": float(ra), "dec": float(dec),
         "epoch": float(epoch), "positions": [], "motion": None, "snr": None, "flux_ujy": None, "mag_ab": None,
         "bins": [], "season_pairs": [], "match": {}, "flags": [], "notes": ""}
    c.update(kw)
    return c


def motion_dict(pmra, pmdec, epmra, epmdec, sig=None, method="", cov=0.0):
    """pm in mas/yr -> motion record with speed ("/yr), PA (deg E of N) and their errors."""
    sp = math.hypot(pmra, pmdec)
    if sp > 0:
        esp = math.sqrt((pmra * epmra) ** 2 + (pmdec * epmdec) ** 2 + 2 * pmra * pmdec * cov) / sp
        epa = math.degrees(math.sqrt((pmdec * epmra) ** 2 + (pmra * epmdec) ** 2) / sp ** 2)
    else:
        esp, epa = math.hypot(epmra, epmdec), 180.0
    return {"pmra_mas_yr": round(pmra, 1), "pmdec_mas_yr": round(pmdec, 1),
            "err_pmra_mas_yr": round(epmra, 1), "err_pmdec_mas_yr": round(epmdec, 1),
            "speed_arcsec_yr": round(sp / 1000, 4), "err_speed_arcsec_yr": round(esp / 1000, 4),
            "pa_deg": round(math.degrees(math.atan2(pmra, pmdec)) % 360, 1), "err_pa_deg": round(min(epa, 180.0), 1),
            "significance_sigma": None if sig is None else round(float(sig), 1), "method": method}


def sep_arcsec(ra1, dec1, ra2, dec2):
    cosd = math.cos(math.radians(0.5 * (dec1 + dec2)))
    return math.hypot(((ra2 - ra1 + 180) % 360 - 180) * cosd, dec2 - dec1) * 3600


def same_object(a, b, tol=4.0):
    """Two records describe the same object: close at 2026.0 and (if both move) similar motion."""
    if sep_arcsec(a["ra"], a["dec"], b["ra"], b["dec"]) > tol + _pos_err(a) + _pos_err(b):
        return False
    ma, mb = a.get("motion"), b.get("motion")
    if ma and mb:
        d = math.hypot(ma["pmra_mas_yr"] - mb["pmra_mas_yr"], ma["pmdec_mas_yr"] - mb["pmdec_mas_yr"]) / 1000
        e = math.hypot(ma["err_speed_arcsec_yr"], mb["err_speed_arcsec_yr"])
        return d < max(1.0, 0.3 * max(ma["speed_arcsec_yr"], mb["speed_arcsec_yr"]), 5 * e)
    return True


def _pos_err(c):
    p = c.get("positions") or []
    return min(3.0, max([q.get("err_arcsec") or 0 for q in p], default=0))


RANK = {"artifact": 0, "variable": 1, "candidate": 2, "asteroid-known": 3, "gaia-known": 4}


def merge(cands):
    """Merge records of the same object. The motion with the smallest error wins; the class
    of a known object wins over 'candidate'; 'artifact' only if every record says so."""
    out = []
    for c in sorted(cands, key=lambda c: -(c.get("snr") or 0)):
        if c["kind"] == "transient":
            out.append(c)
            continue
        for o in out:
            if o["kind"] != "transient" and same_object(o, c):
                o["detectors"] = sorted(set(o["detectors"]) | set(c["detectors"]))
                o["bins"] = sorted(set(o["bins"]) | set(c["bins"]))
                o["season_pairs"] = sorted({tuple(p) for p in o["season_pairs"]} | {tuple(p) for p in c["season_pairs"]})
                o["season_pairs"] = [list(p) for p in o["season_pairs"]]
                if c["class"] != "artifact" or o["class"] == "artifact":
                    o["flags"] = list(dict.fromkeys(o["flags"] + c["flags"]))
                if c["class"] == "artifact" and o["class"] != "artifact":
                    o.setdefault("merged_rejected", []).append({"detectors": c["detectors"], "flags": c["flags"][:3]})
                for k, v in c.get("match", {}).items():
                    o["match"].setdefault(k, v)
                c_ok = c["class"] != "artifact" or o["class"] == "artifact"    # a rejected record never sets the motion
                if o["class"] == "artifact" and c["class"] != "artifact":
                    # the merged object is real: its motion / kind come from the non-rejected record
                    o.setdefault("merged_rejected", []).append({"detectors": list(o["detectors"]), "flags": o["flags"][:3]})
                    o["motion"], o["kind"] = c.get("motion"), c["kind"]
                    o["positions"] = c.get("positions") or []
                    o["ra"], o["dec"] = c["ra"], c["dec"]
                    if c.get("brightness"):
                        o["brightness"] = c["brightness"]
                elif c_ok and c.get("motion") and (not o.get("motion") or
                                                   c["motion"]["err_speed_arcsec_yr"] < o["motion"]["err_speed_arcsec_yr"]):
                    o["motion"] = c["motion"]
                    if c.get("positions"):
                        o["positions"] = c["positions"]
                    o["ra"], o["dec"] = c["ra"], c["dec"]
                if c["class"] != "artifact" and (o["class"] == "artifact" or RANK[c["class"]] > RANK[o["class"]]):
                    if o["class"] == "artifact":
                        o["flags"] = list(c["flags"])
                    o["class"] = c["class"]
                if c["kind"] == "motion" and c_ok:
                    o["kind"] = "motion"
                o["snr"] = max(o.get("snr") or 0, c.get("snr") or 0)
                if c.get("notes") and c["notes"] not in o["notes"]:
                    o["notes"] = (o["notes"] + " | " + c["notes"]).strip(" |")
                break
        else:
            out.append(c)
    order = {"candidate": 0, "variable": 1, "gaia-known": 2, "asteroid-known": 3, "artifact": 4}
    out.sort(key=lambda c: (order[c["class"]], -(c.get("snr") or 0)))
    for k, c in enumerate(out, 1):
        c["id"] = f"C{k:03d}"
    return out


def summary(cands):
    by = {k: 0 for k in CLASSES}
    for c in cands:
        by[c["class"]] += 1
    moving = [c for c in cands if c["kind"] == "motion" and c["class"] in ("candidate", "gaia-known")]
    return {"n": len(cands), "by_class": by, "n_moving": len(moving),
            "n_moving_candidates": sum(c["class"] == "candidate" for c in moving),
            "n_transients": sum(c["kind"] == "transient" for c in cands),
            "n_variable": by["variable"],
            "text": (f"{len(moving)} moving object(s) found here: {sum(c['class'] == 'gaia-known' for c in moving)} known "
                     f"Gaia mover(s), {sum(c['class'] == 'candidate' for c in moving)} candidate(s); "
                     f"{by['variable']} variable candidate(s), {by['asteroid-known']} known asteroid(s), "
                     f"{by['artifact']} rejected as artifacts.")}


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items() if not str(k).startswith("_")}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if hasattr(o, "item") and not isinstance(o, (str, bytes)):
        try:
            o = o.item()
        except (ValueError, AttributeError):
            pass
    if isinstance(o, float):
        return None if not math.isfinite(o) else round(o, 7)
    return o


def write(path, field, cands, detectors_info, extra=None, overwrite=False):
    from pathlib import Path
    path = Path(path)
    if path.exists() and not overwrite:
        raise FileExistsError(f"{path} exists (refusing to overwrite; use a new output folder)")
    doc = {"schema": SCHEMA, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "field": field, "summary": summary(cands), "detectors": detectors_info, "candidates": cands,
           "language_note": "Candidates for follow-up. Not discoveries."}
    if extra:
        doc.update(extra)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.part")
    tmp.write_text(json.dumps(_clean(doc), indent=1))
    tmp.replace(path)
    return doc
