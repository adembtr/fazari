"""Fazari finds: the lasting list of CONFIRMED local-engine results, <cache>/finds.jsonl.

Step 3 of the result flow: fast answer -> how sure -> save if confirmed.

Engine: post-step "finds" in local/job_worker.py (post_step), the last step of a full job, after the
candidate finder ("candidates" -> <job>/candidates.json). Every candidate that passes is_verified (below)
is appended as ONE line to <cache>/finds.jsonl. Append only: existing lines are never rewritten or
deleted; a record is added once per key (job_id + pipeline hash + candidate id). Every line is a complete
JSON record, so the file turns into static JSON as it is: GET /api/finds (local/serve.py) returns
{"schema": "fazari-finds/1", "finds": [record, ...]}, and a copy of that object can be published later
as site/data/finds.json.

Record "fazari-find/1" (values copied from the job's own files; no number is computed here):
    saved          UTC time the line was written
    job_id, pipeline, result_url   the job, the blink code fingerprint (local/serve.py pipeline_hash,
                   from the job's status.json), its products (/jobs/<id>/)
    candidate      candidates.json id (null: an old-core job saved by the fallback rule)
    name, target   the object's name if known (the job target when it is verdict.best), the job's target
    ra, dec, epoch, date   position (deg, ICRS), its epoch (yr) and season
    quantity, value, error, unit, from, to, dt_years, pa_deg
                   motion.displacement: how far it moved between two seasons (arcsec) +- error
    speed_arcsec_yr, speed_err  motion.speed_arcsec_yr and its error
    confidence     {percent, basis, sentence} exactly as the core wrote them (percent may be null)
    nature         {label, text}; class = nature.label (old core: gaia-known | catalogue-known)
    confirmation   {rule, n_independent, sentence}
    agreement_sigma, reference   |measured - catalogue| in sigma and the catalogue (when given)
    verified_by    the rule that passed

Check or backfill the finished jobs of a cache folder (appends only what passes, skips duplicates):
    python3 -I pipeline/finds.py [--cache DIR] [--job ID] [--dry-run]
Standard library only.
"""
import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = "fazari-find/1"
FILE_NAME = "finds.jsonl"

# =====================================================================================================
# WHAT GOES INTO THE LIST -- the one rule, is_verified(result); change it here only.
# Core v1 (pipeline/detect): a candidate counts when its CONFIRMED_FIELD is exactly true (rule confirm-v1
# in the core; the core decides, this file only copies).
CONFIRMED_FIELD = "confirmed"
# OLD-CORE FALLBACK, used ONLY when the result has no CONFIRMED_FIELD at all (candidates.json from before
# core v1, or no candidates.json): the job target matched to a catalogue whose measured motion (meta.json)
# agrees with the catalogue prediction within FALLBACK_SIGMA standard errors.
FALLBACK_SIGMA = 2.0
# =====================================================================================================


def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _agreement(meta):
    """(agreement_sigma, reference dict) of the measured shift against the catalogue, or (None, why)."""
    ms = meta.get("measured") or {}
    ref = meta.get("gaia") or {}
    label = str(ref.get("label") or "")
    if not ref or not label or "requested position" in label.lower():
        return None, "no catalogue match (the job measured a position, not a catalogue star)"
    s, e, pa = _num(ms.get("shift_arcsec")), _num(ms.get("shift_err_arcsec")), _num(ms.get("pa_deg"))
    p, ppa = _num(ms.get("gaia_predicted_arcsec")), _num(ms.get("gaia_pa_deg"))
    if s is None or e is None or e <= 0 or p is None or ppa is None:
        return None, "no motion measurement with an error and a catalogue prediction"
    de, dn = _num(ms.get("shift_east_arcsec")), _num(ms.get("shift_north_arcsec"))
    if de is None or dn is None:
        if pa is None:
            return None, "no direction of the measured motion"
        de, dn = s * math.sin(math.radians(pa)), s * math.cos(math.radians(pa))
    pe, pn = p * math.sin(math.radians(ppa)), p * math.cos(math.radians(ppa))
    return math.hypot(de - pe, dn - pn) / e, {"label": label, "predicted": p, "pa_deg": ppa}


def is_verified(result):
    """THE RULE (isVerified). result = {"candidate": one candidates.json record or None,
    "meta": meta.json, "status": status.json (may be {})}. Returns (verified: bool, details: dict)."""
    meta = result.get("meta") or {}
    c = result.get("candidate")
    if meta.get("preview") or (result.get("status") or {}).get("mode") == "preview":
        return False, {"why": "a preview is never saved"}
    if isinstance(c, dict) and CONFIRMED_FIELD in c:                     # core v1 and later
        ok = c.get(CONFIRMED_FIELD) is True
        cf = c.get("confirmation") or {}
        return ok, {"why": cf.get("sentence") or ("confirmed by the core" if ok else "not confirmed by the core"),
                    "verified_by": {"rule": cf.get("rule") or CONFIRMED_FIELD, "field": CONFIRMED_FIELD}}
    # ---- OLD-CORE FALLBACK: only for results WITHOUT the "confirmed" field --------------------------
    ms = meta.get("measured") or {}
    if ms.get("status") != "detected":
        return False, {"why": f"old core: measurement status '{ms.get('status')}', not 'detected'"}
    sig, ref = _agreement(meta)
    if sig is None:
        return False, {"why": "old core: " + ref}
    ok = sig <= FALLBACK_SIGMA
    return ok, {"why": f"old core: measured motion {'agrees with' if ok else 'differs from'} {ref['label']} "
                       f"({sig:.2f} sigma; limit {FALLBACK_SIGMA:g})",
                "agreement_sigma": sig, "reference": ref,
                "verified_by": {"rule": "old-core-fallback: catalogue agreement", "limit_sigma": FALLBACK_SIGMA}}


def _rnd(v, n):
    return None if _num(v) is None else round(float(v), n)


def _target(meta, request):
    return ((request or {}).get("target") or {}).get("name") or meta.get("target") or None


def record(job_id, cand, meta, status, request=None, details=None, verdict=None):
    """The finds.jsonl line (dict) of a confirmed candidate (core v1)."""
    d = details or is_verified({"candidate": cand, "meta": meta, "status": status})[1]
    mo = cand.get("motion") or {}
    dp = mo.get("displacement") or {}
    cf, nat = cand.get("confidence"), cand.get("nature")
    con = cand.get("confirmation") or {}
    tgt = _target(meta, request)
    pos = (cand.get("positions") or [None])[-1] or {}
    return {
        "schema": SCHEMA, "saved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "job_id": job_id, "pipeline": (status or {}).get("pipeline"), "result_url": f"/jobs/{job_id}/",
        "candidate": cand.get("id"),
        "name": tgt if tgt and cand.get("id") is not None and cand.get("id") == (verdict or {}).get("best") else None,
        "target": tgt,
        "ra": _rnd(cand.get("ra"), 6), "dec": _rnd(cand.get("dec"), 6), "epoch": _rnd(cand.get("epoch"), 4),
        "date": cand.get("season") or dp.get("to") or pos.get("season"),
        "quantity": "motion" if (dp or mo) else (cand.get("kind") or None),
        "value": _rnd(dp.get("arcsec"), 4), "error": _rnd(dp.get("err_arcsec"), 4), "unit": "arcsec",
        "from": dp.get("from"), "to": dp.get("to"), "dt_years": _rnd(dp.get("dt_yr"), 4),
        "pa_deg": _rnd(dp.get("pa_deg", mo.get("pa_deg")), 2),
        "speed_arcsec_yr": _rnd(mo.get("speed_arcsec_yr"), 4), "speed_err": _rnd(mo.get("err_speed_arcsec_yr"), 4),
        "confidence": {k: cf.get(k) for k in ("percent", "basis", "sentence")} if isinstance(cf, dict) else None,
        "nature": {k: nat.get(k) for k in ("label", "text")} if isinstance(nat, dict) else None,
        "class": (nat or {}).get("label") or cand.get("class"),
        "confirmation": {k: con.get(k) for k in ("rule", "n_independent", "sentence")} if con else None,
        "agreement_sigma": _rnd((cf or {}).get("gaia_difference_sigma") if isinstance(cf, dict) else None, 2),
        "reference": None,
        "verified_by": d.get("verified_by"),
    }


def record_fallback(job_id, meta, status, request=None, details=None):
    """OLD-CORE FALLBACK line (no "confirmed" field anywhere): the job target from meta.json."""
    ms = meta.get("measured") or {}
    d = details or is_verified({"candidate": None, "meta": meta, "status": status})[1]
    pos = next((q for q in (ms.get("positions") or []) if q.get("epoch") == ms.get("to_epoch")
                and _num(q.get("ra")) is not None and _num(q.get("dec")) is not None), None)
    ref = d.get("reference") or ({"label": (meta.get("gaia") or {}).get("label")} if meta.get("gaia") else None)
    sig = d.get("agreement_sigma")
    if sig is None:
        sig = _agreement(meta)[0]
    gaia = "gaia" in str((ref or {}).get("label") or "").lower()
    tgt = _target(meta, request)
    return {
        "schema": SCHEMA, "saved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "job_id": job_id, "pipeline": (status or {}).get("pipeline"), "result_url": f"/jobs/{job_id}/",
        "candidate": None, "name": tgt, "target": tgt,
        "ra": _rnd(pos["ra"] if pos else meta.get("ra"), 6), "dec": _rnd(pos["dec"] if pos else meta.get("dec"), 6),
        "epoch": pos.get("epoch") if pos else None, "date": pos.get("date") if pos else None,
        "quantity": "motion", "value": _rnd(ms.get("shift_arcsec"), 4), "error": _rnd(ms.get("shift_err_arcsec"), 4),
        "unit": "arcsec", "from": ms.get("from_epoch"), "to": ms.get("to_epoch"), "dt_years": _rnd(ms.get("dt_years"), 4),
        "pa_deg": _rnd(ms.get("pa_deg"), 2), "speed_arcsec_yr": None, "speed_err": None,
        "confidence": None, "nature": None,
        "class": "gaia-known" if gaia else "catalogue-known", "confirmation": None,
        "agreement_sigma": _rnd(sig, 2),
        "reference": ref and {k: (_rnd(v, 4) if k != "label" else v) for k, v in ref.items()},
        "verified_by": d.get("verified_by"),
    }


def read(path):
    """All complete records of a finds.jsonl (a damaged line is skipped, never repaired)."""
    out = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("job_id"):
                    out.append(r)
    except FileNotFoundError:
        pass
    return out


def append(path, rec):
    """Append rec as one line unless (job_id, pipeline, candidate) is already in the file. Returns True if written.
    Locked (fcntl) so two writers cannot interleave; the file is only ever opened for appending."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"
    with open(path, "a+", encoding="utf-8") as fh:
        try:
            import fcntl
            fcntl.flock(fh, fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        fh.seek(0)
        for old in fh:
            try:
                r = json.loads(old)
            except ValueError:
                continue
            if isinstance(r, dict) and r.get("job_id") == rec["job_id"] and r.get("pipeline") == rec["pipeline"] \
                    and r.get("candidate") == rec.get("candidate"):
                return False
        fh.seek(0, os.SEEK_END)
        if fh.tell() > 0:                                    # a previous writer cut off mid-line: start a new line
            fh.seek(fh.tell() - 1)
            last = fh.read(1)
            fh.seek(0, os.SEEK_END)
            if last != "\n":
                fh.write("\n")
        fh.write(line)
        fh.flush()
        os.fsync(fh.fileno())
    return True


def save_if_verified(cache, job_id, meta, status, request=None, cands=None, dry_run=False):
    """Check one job (its candidates.json when the core marks "confirmed", else the old-core fallback)
    and append what passes. Returns a small dict (for status.post.finds)."""
    status = status or {}
    items = [c for c in ((cands or {}).get("candidates") or []) if isinstance(c, dict)]
    path = Path(cache) / FILE_NAME
    if any(CONFIRMED_FIELD in c for c in items):                          # core v1 and later
        recs = []
        for c in items:
            ok, d = is_verified({"candidate": c, "meta": meta, "status": status})
            if ok:
                recs.append(record(job_id, c, meta, status, request, d, (cands or {}).get("verdict")))
        n_new = 0 if dry_run else sum(append(path, r) for r in recs)
        return {"rule": CONFIRMED_FIELD, "verified": bool(recs), "n_confirmed": len(recs), "appended": n_new,
                "why": f"{len(recs)} confirmed candidate(s), {n_new} new in the list"}
    ok, d = is_verified({"candidate": None, "meta": meta, "status": status})   # OLD-CORE FALLBACK
    out = {"rule": "old-core-fallback", "verified": ok, "why": d.get("why"), "appended": 0}
    if d.get("agreement_sigma") is not None:
        out["agreement_sigma"] = round(d["agreement_sigma"], 2)
    if ok and not dry_run:
        out["appended"] = int(append(path, record_fallback(job_id, meta, status, request, d)))
        if not out["appended"]:
            out["why"] += "; already in the list"
    return out


def _load(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def post_step(ctx):
    """local/job_worker.py POST_STEPS entry (the last one): append the job's confirmed candidates to
    <cache>/finds.jsonl. Writes nothing into the job's folders."""
    out = Path(ctx["out"])
    cache = out.parent.parent                                # <cache>/jobs/<id> -> <cache>
    st = ctx.get("status")
    status = dict(getattr(st, "d", None) or {})
    if not status.get("pipeline"):                           # the server writes it into status.json
        try:
            status["pipeline"] = json.loads((cache / "local" / "jobs" / ctx["job_id"] / "status.json").read_text()).get("pipeline")
        except (OSError, ValueError):
            pass
    meta = ctx.get("meta") or json.loads((out / "meta.json").read_text())
    r = save_if_verified(cache, ctx["job_id"], meta, status, ctx.get("req"), _load(out / "candidates.json"))
    print(f"finds: {r['appended']} saved ({r['rule']}): {r['why']}", flush=True)
    return r


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fazari finds: check finished jobs and append the confirmed ones")
    ap.add_argument("--cache", default=os.environ.get("FAZARI_CACHE") or str(ROOT / "cache"),
                    help="cache folder (default $FAZARI_CACHE or fazari/cache)")
    ap.add_argument("--job", action="append", help="only this job id (repeatable)")
    ap.add_argument("--dry-run", action="store_true", help="print the decisions, write nothing")
    a = ap.parse_args(argv)
    cache = Path(a.cache).expanduser().resolve()
    metas = cache / "local" / "jobs"
    if not metas.is_dir():
        sys.exit(f"no jobs in {metas}")
    for d in sorted(metas.iterdir()):
        if a.job and d.name not in a.job:
            continue
        try:
            st = json.loads((d / "status.json").read_text())
            req = json.loads((d / "request.json").read_text())
            meta = json.loads((cache / "jobs" / d.name / "meta.json").read_text())
        except (OSError, ValueError):
            continue
        if st.get("state") != "done" or st.get("mode") == "preview" or meta.get("preview"):
            continue
        r = save_if_verified(cache, d.name, meta, st, req, _load(cache / "jobs" / d.name / "candidates.json"), dry_run=a.dry_run)
        print(f"{d.name}: {r['appended']} saved, {'verified' if r['verified'] else 'no'} ({r['rule']}) - {r['why']}")


if __name__ == "__main__":
    main()
