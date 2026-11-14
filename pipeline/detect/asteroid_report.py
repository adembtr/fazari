"""Report of the known-asteroid recovery (asteroids.py): tables, site JSON, candidates.json, blink.

  report: reads cache/asteroids/runs/F*.json (the newest file per field) and writes
          site/data/asteroids/summary.json, site/data/asteroids/candidates.json (shared candidate
          schema, class 'asteroid-known' / 'candidate') and prints the Markdown tables used in
          pipeline/ASTEROIDS.md. Existing site files are never overwritten: a new name is used.
  blink:  one recovered asteroid moving from exposure to exposure, as small PNG frames on a
          north-up grid + blink.json (markers), under site/data/asteroids/<name>/ (new folder).
"""
import json
import math
import time
from pathlib import Path

import numpy as np

import blink as BL
from . import asteroids as A
from . import s3box as S3
from . import schema as SC

VLIMS = (17, 18, 19, 20)
S3_RESPONSE_HEADER = 502        # bytes of HTTP response headers of one S3 206 answer (measured with curl)


def _newest_runs():
    runs = {}
    for p in sorted(A.RUNS.glob("F*.json")):
        fid = p.stem.split("_")[0]
        runs.setdefault(fid, []).append(p)
    out = []
    for fid in sorted(runs):
        p = max(runs[fid], key=lambda q: q.stat().st_mtime)
        r = json.loads(p.read_text())
        tp = A.RUNS / f"T_{p.stem}.json"
        if not r.get("tracklets") and tp.exists():
            r["tracklets"] = json.loads(tp.read_text()).get("tracklets", [])
        out.append(r)
    return out


def _new_path(path):
    path = Path(path)
    if not path.exists():
        return path
    return path.with_name(f"{path.stem}_{time.strftime('%Y%m%dT%H%M%S')}{path.suffix}")


REASONS = [("crowded field", "crowded field (star residuals)"), ("edge", "edge"), ("no usable references", "no references"), ("ephemeris uncertainty", "ephemeris uncertain"),
           ("masked pixels", "masked pixels (saturated star / bad pixels)"),
           ("one sub-exposure", "seen in 1 exposure only / not confirmed"),
           ("bright static source", "blended with a static star"), ("not PSF-shaped", "not PSF-shaped (EPSF chi2 cut)"), ("bad subtraction", "bad subtraction (star residual)"), ("below the per-exposure", "S/N 5-15 over the visit, < 5 per exposure"),
           ("too faint", "too faint (S/N < 5 over the visit)")]


def reason_category(text):
    for key, cat in REASONS:
        if key in (text or ""):
            return cat
    return "other"


def geocentric_offsets(runs):
    """Offsets (px) of the recovered detections from the GEOCENTRIC SkyBoT positions, i.e. without
    the move to the SPHEREx position: shows what the parallax correction is worth."""
    from . import ssoephem as EPH
    out = []
    for r in runs:
        f = r["field"]
        if not r.get("exposures"):
            continue
        mjd0 = r["exposures"][0]["mjd"]
        objs = EPH.cone(mjd0, f["ra"], f["dec"], A.R_CONE, offline=True)
        if not objs:
            continue
        for k in r.get("known", []):
            if not k.get("found"):
                continue
            o = objs[k["idx"]]
            for d in k["dets"]:
                ra, dec = EPH.at_time(o, mjd0, d["mjd"])
                out.append(SC.sep_arcsec(d["ra"], d["dec"], ra, dec) / A.PIX)
    return out


def cache_bytes():
    """Everything ever read from the network for this work is in cache/asteroids/ (nothing is
    deleted): S3 header ranges (.bin), S3 boxes (.npy: payload + a 128-byte npy header each, one
    Range request per box row) and SkyBoT answers (raw size recorded since it was added, else
    the size of the parsed copy, which is smaller)."""
    hdr = sum(q.stat().st_size for q in (S3.CACHE / "s3").rglob("*.bin"))
    nhdr = sum(1 for _ in (S3.CACHE / "s3").rglob("*.bin"))
    box, rows = 0, 0
    for q in (S3.CACHE / "boxes").rglob("*.npy"):
        try:
            a = np.load(q, mmap_mode="r")
            box += a.nbytes
            rows += a.shape[0]
        except (OSError, ValueError):
            continue
    sky, nsky = 0, 0
    for q in (S3.CACHE / "skybot").glob("*.json"):
        try:
            d = json.loads(q.read_text())
        except ValueError:
            continue
        sky += d.get("raw_bytes") or q.stat().st_size
        nsky += 1
    return dict(s3_header_bytes=hdr, s3_header_requests=nhdr, s3_box_bytes=box, s3_box_requests=rows,
                s3_payload_bytes=hdr + box, s3_requests=nhdr + rows,
                s3_response_header_bytes=(nhdr + rows) * S3_RESPONSE_HEADER,
                s3_wire_bytes=hdr + box + (nhdr + rows) * S3_RESPONSE_HEADER, skybot_bytes=sky, skybot_queries=nsky)


def galactic_b(ra, dec):
    from astropy.coordinates import SkyCoord
    return float(SkyCoord(ra, dec, unit="deg").galactic.b.deg)


CROWDED = 3.0       # box noise this many times the median field = crowded (star residuals dominate)


def mark_crowded(runs):
    """Fields whose median difference-image noise is > CROWDED x the median of all fields; their
    faint misses get the reason category 'crowded field'."""
    nz = [r.get("noise_median") for r in runs if r.get("noise_median")]
    ref = float(np.median(nz)) if nz else None
    for r in runs:
        r["_crowding"] = (r.get("noise_median") / ref) if ref and r.get("noise_median") else None
        if r["_crowding"] and r["_crowding"] > CROWDED:
            for k in r.get("known", []):
                if not k.get("found") and reason_category(k.get("reason")) in (
                        "too faint (S/N < 5 over the visit)", "S/N 5-15 over the visit, < 5 per exposure",
                        "seen in 1 exposure only / not confirmed", "bad subtraction (star residual)"):
                    k["reason"] = (f"crowded field (b = {galactic_b(r['field']['ra'], r['field']['dec']):+.1f}°, noise "
                                   f"{r['_crowding']:.1f}x the median field): " + k["reason"])


def link_ok(t):
    """A blind cross-visit link that the ephemeris confirms: every second-visit detection within
    MATCH_PX of the ephemeris position. Linked tracks that fail this are wrong links."""
    return t.get("status") == "linked" and bool(t.get("off2_px")) and max(t["off2_px"]) <= A.MATCH_PX


def has_visit2(t):
    return not str(t.get("status", "")).startswith(("no other visit", "error"))


def field_row(r):
    f = r["field"]
    kn = r.get("known", [])
    row = dict(id=f["id"], visit=f["visit"], detector=f"D{f['detector']}", date=f["date"], lam=f["lam"], beta=f["beta"],
               gal_b=round(galactic_b(f["ra"], f["dec"]), 1), crowding=None if r.get("_crowding") is None
               else round(r["_crowding"], 2), n_cone=r.get("n_cone"), n_on_detector=r.get("n_on_detector"),
               error=r.get("error"))
    for v in VLIMS:
        sel = [k for k in kn if k["V"] is not None and k["V"] < v]
        row[f"known_v{v}"] = len(sel)
        row[f"found_v{v}"] = sum(k["found"] for k in sel)
        row[f"stack_v{v}"] = sum(bool(k.get("found_stack")) for k in sel)
        row[f"either_v{v}"] = sum(bool(k["found"] or k.get("found_stack")) for k in sel)
    st = [k["stack"] for k in kn if k.get("found_stack")]
    soff = [d["off_px"] for q in st for d in q["subs"] if "off_px" in d]
    row["n_found_stack"] = len(st)
    row["stack_sub_off_px_median"] = round(float(np.median(soff)), 3) if soff else None
    row["stack_sub_off_px_max"] = round(float(np.max(soff)), 3) if soff else None
    row["n_false_stack"] = r.get("n_false_stack")
    found = [k for k in kn if k["found"]]
    offs = [d["off_px"] for k in found for d in k["dets"] if "off_px" in d]
    row["n_found"] = len(found)
    row["n_det"] = len(offs)
    row["off_px_median"] = round(float(np.median(offs)), 3) if offs else None
    row["off_px_max"] = round(float(np.max(offs)), 3) if offs else None
    row["frac_within_1px"] = round(float(np.mean(np.array(offs) <= 1.0)), 3) if offs else None
    row["n_false"] = r.get("n_false")
    row["n_single"] = r.get("n_single")
    row["area_deg2"] = r.get("area_deg2_per_exposure")
    if found:
        fz = max(found, key=lambda k: k["V"])
        row["faintest"] = dict(name=fz["name"], V=fz["V"], H=fz["H"], flux_ujy=fz.get("flux_ujy"),
                               lam_um=next((d.get("lam_um") for d in fz["dets"] if d.get("lam_um")), fz.get("lam_um")),
                               snr=fz.get("snr"))
    tr = [t for t in r.get("tracklets", []) if link_ok(t)]
    row["n_tracklets"] = len(tr)
    row["n_tracklet_wrong"] = sum(1 for t in r.get("tracklets", []) if t.get("status") == "linked" and not link_ok(t))
    row["n_tracklet_tried"] = sum(1 for t in r.get("tracklets", []) if has_visit2(t))
    row["n_tracklet_objects"] = len(r.get("tracklets", []))
    fr = [abs(t["rate_diff_frac"]) for t in tr if t.get("rate_diff_frac") is not None]
    pa = [abs(t["pa_diff_deg"]) for t in tr if t.get("pa_diff_deg") is not None]
    row["rate_diff_frac_median"] = round(float(np.median(fr)), 4) if fr else None
    row["pa_diff_deg_median"] = round(float(np.median(pa)), 2) if pa else None
    row["bytes_s3"] = r.get("bytes_s3")
    row["requests_s3"] = r.get("requests_s3")
    return row


def candidates(runs):
    out = []
    for r in runs:
        f = r["field"]
        exps = r.get("exposures", [])
        kn = {k["idx"]: k for k in r.get("known", [])}
        for o in r.get("objects", []):
            if not o.get("confirmed", o["n_exp"] >= 2):
                continue
            d0 = max(o["dets"], key=lambda d: d["snr"])
            from astropy.time import Time
            jy = float(Time(d0["mjd"], format="mjd").jyear)
            m = o.get("match")
            cls = "asteroid-known" if m is not None else "candidate"
            c = SC.new_candidate(A.NAME, "transient", d0["ra"], d0["dec"], round(jy, 6), cls=cls,
                                 snr=d0["snr"], flux_ujy=d0["flux_ujy"], bins=[f"D{f['detector']}"])
            c["mag_ab"] = round(23.9 - 2.5 * math.log10(d0["flux_ujy"]), 2) if d0["flux_ujy"] > 0 else None
            c["mjd"] = d0["mjd"]
            c["field"] = f["id"]
            c["visit"] = f["visit"]
            c["detections"] = [dict(sub=d["sub"], obs_id=exps[d["sub"] - 1]["obs_id"] if len(exps) >= d["sub"] else None,
                                    mjd=d["mjd"], ra=d["ra"], dec=d["dec"], snr=d["snr"], flux_ujy=d["flux_ujy"],
                                    lam_um=d.get("lam_um"), off_px=d.get("off_px"), off_arcsec=d.get("off_arcsec"))
                               for d in o["dets"]]
            rm = o.get("rate_measured")
            c["rate_arcsec_per_hour"] = round(math.hypot(rm["ra_cosd"], rm["dec"]), 2) if rm else None
            if m is not None:
                k = kn.get(m)
                if k:
                    c["match"]["sso"] = dict(name=k["name"], number=k["number"], cls=k["cls"], vmag=k["V"], H=k["H"],
                                             sep_px_median=k.get("off_px_median"), sep_px_max=k.get("off_px_max"),
                                             source="IMCCE SkyBoT, moved to the SPHEREx position")
                    c["flags"].append(f"recovered known asteroid {k['number']} {k['name']}".replace("  ", " ").strip())
                else:
                    c["flags"].append("matched a known object fainter than the box limit")
                    c["match"]["sso"] = {"index": m}
            else:
                c["flags"].append("unmatched: no known object within %.0f px" % A.MATCH_PX)
                c["notes"] = "Seen in >= 2 sub-exposures; not checked further (artifact or unlisted mover)."
            out.append(c)
    return out


def md_tables(rows, runs):
    L = []
    L.append("| Field | Date (UTC) | Det | λ_ecl | β | b | V<17 single / stack / known | V<18 | V<19 | V<20 | Offset median / worst (px) "
             "| ≤ 1 px | False single / stack | Faintest recovered single-exposure (V, H, µJy @ µm) | Tracklets linked / tried, rate diff |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    tot = {f"{a}_v{v}": 0 for v in VLIMS for a in ("known", "found", "stack", "either")}
    for r in rows:
        if r.get("error"):
            L.append(f"| {r['id']} | {r['date']} | {r['detector']} | {r['lam']:.0f}° | {r['beta']:+.1f}° | error: {r['error']} |")
            continue
        for k in tot:
            tot[k] += r[k]
        fz = r.get("faintest")
        fzs = (f"{fz['name']}: V {fz['V']:.1f}, H {fz['H']:.1f}, {fz['flux_ujy']:.0f} µJy @ {fz['lam_um']:.2f}"
               if fz and fz.get("lam_um") and fz.get("H") is not None else "-")
        tr = (f"{r['n_tracklets']} / {r['n_tracklet_tried']}" + (f" (+{r['n_tracklet_wrong']} wrong)" if r.get("n_tracklet_wrong") else "")
              + (f", {100 * r['rate_diff_frac_median']:.1f} %, PA {r['pa_diff_deg_median']:.1f}°" if r.get("rate_diff_frac_median") is not None else ""))
        off = f"{r['off_px_median']:.2f} / {r['off_px_max']:.2f}" if r["off_px_median"] is not None else "-"
        w1 = f"{100 * r['frac_within_1px']:.0f} %" if r["frac_within_1px"] is not None else "-"
        L.append(f"| {r['id']} | {r['date']} | {r['detector']} | {r['lam']:.0f}° | {r['beta']:+.1f}° | {r['gal_b']:+.0f}° | "
                 + " | ".join(f"{r[f'found_v{v}']} / {r[f'stack_v{v}']} / {r[f'known_v{v}']}" for v in VLIMS)
                 + f" | {off} | {w1} | {r['n_false']} / {r.get('n_false_stack')} | {fzs} | {tr} |")
    L.append("| **Total** | | | | | | " + " | ".join(f"**{tot[f'found_v{v}']} / {tot[f'stack_v{v}']} / {tot[f'known_v{v}']}**"
                                                for v in VLIMS) + " | | | | | |")
    return "\n".join(L), tot


def results_markdown(summ, table_md, missed, tracks, found):
    """The Results section of pipeline/ASTEROIDS.md."""
    t, o, oa, og = summ["totals"], summ["offset_px"] or {}, summ["offset_arcsec"] or {}, summ["offset_px_without_parallax"] or {}
    b = summ["bytes"]
    tr = summ["tracklets"]
    L = [f"Generated {summ['generated']} by `find_asteroids.py report` from `cache/asteroids/runs/`; the same numbers are in "
         "`site/data/asteroids/summary.json`.", "",
         f"- **{summ['n_fields_ok']} fields**, {summ['n_found']} different known asteroids recovered blind in single exposures "
         f"({summ['n_detections']} single-exposure detections matched to the ephemeris).",
         "- Recovered / known, by brightness: " + ", ".join(f"V < {v}: **{t[f'found_v{v}']} / {t[f'known_v{v}']}**" for v in VLIMS)
         + ". Visit stack: " + ", ".join(f"V < {v}: {t[f'stack_v{v}']}" for v in VLIMS) + "; either mode: "
         + ", ".join(f"V < {v}: {t[f'either_v{v}']}" for v in VLIMS) + ".",
         f"- Position offset detection − ephemeris (per exposure): median **{o.get('median')} px "
         f"({oa.get('median')}\")**, 90 % {o.get('p90')} px ({oa.get('p90')}\"), worst {o.get('max')} px ({oa.get('max')}\"); "
         f"**{100 * (o.get('frac_within_1px') or 0):.1f} %** within 1 px.",
         f"- Without the move from the geocentre to SPHEREx the same detections are off by median {og.get('median')} px, "
         f"90 % {og.get('p90')} px, worst {og.get('max')} px.",
         f"- False detections (confirmed objects matching no known object): {summ['false_per_field']['total']} in all, median "
         f"{summ['false_per_field']['median']:.0f} per field (per field: column 'False').",
         f"- Tracklets across visits: of {tr['objects']} recovered objects (single exposures or visit stack), {tr['tried']} had another visit of the same detector "
         f"within 1 day; **{tr['linked']}** were linked blindly there and confirmed by the ephemeris (every second-visit "
         f"detection ≤ {A.MATCH_PX:.0f} px from it); wrong links: {len(tr['wrong_links'])} ("
         + ", ".join(f"{w['field']} {w['name']}: {min(w['off2_px']):.0f} px from the ephemeris" for w in tr['wrong_links'])
         + f"). Measured rate − ephemeris rate (confirmed links): median {100 * (tr['rate_diff_frac_median'] or 0):.2f} % "
         f"of the rate, direction median {tr['pa_diff_deg_median']}°.",
         f"- Data read: **{b['s3_payload_bytes'] / 1e6:.1f} MB** of S3 byte ranges ({b['s3_requests']} Range requests; with the "
         f"measured 502-byte response headers {b['s3_wire_bytes'] / 1e6:.1f} MB on the wire) and {b['skybot_bytes'] / 1e6:.1f} MB "
         f"from SkyBoT ({b['skybot_queries']} cone searches), counting everything in `cache/asteroids/` including the "
         f"development runs; the production runs alone (ledger) read {(b.get('ledger_s3') or 0) / 1e6:.1f} MB from S3 in "
         f"{b.get('ledger_s3_requests') or 0} requests. No whole file was downloaded.", "",
         "### Per field", "",
         "single = single-exposure detections confirmed within the visit, stack = visit stack, known = SkyBoT objects of that "
         "brightness inside the detector (≥ 8 px from the edge) in the 1.5° cone. b = Galactic latitude.", "", table_md, ""]
    lk = [x for x in tracks if x.get("status") == "linked"]
    if lk:
        L += ["### Tracklets (second visit linked without the ephemeris)", "",
              "Δt = second visit − first visit. Offsets: second-visit detections − ephemeris. A link with an offset > "
              f"{A.MATCH_PX:.0f} px is a wrong link (marked).", "",
              "| Field | Object | Δt (h) | det. 2nd visit | offsets 2nd visit (px) | measured rate (\"/h, PA) | ephemeris rate (\"/h, PA) | Δrate | ΔPA |",
              "|---|---|---|---|---|---|---|---|---|"]
        for x in sorted(lk, key=lambda x: (x["field"], x["name"])):
            m, e = x["rate_measured"] or {}, x["rate_ephem"] or {}
            L.append(f"| {x['field']} | {x['name']}{'' if link_ok(x) else ' (**wrong link**)'} | {x['dt_h']:+.2f} | {x['n_det2']} | "
                     f"{', '.join(f'{v:.2f}' for v in x['off2_px'])} | {m.get('speed', 0):.2f}, {m.get('pa', 0):.1f}° | "
                     f"{e.get('speed', 0):.2f}, {e.get('pa', 0):.1f}° | {100 * (x['rate_diff_frac'] or 0):.2f} % | {x['pa_diff_deg'] or 0:+.2f}° |")
        L.append("")
    fz = sorted(found, key=lambda k: -k["V"])[:8]
    L += ["### Faintest recoveries", "", "| Field | Object | V | H | flux (µJy) | λ (µm) | fit S/N (best exposure) | exposures |",
          "|---|---|---|---|---|---|---|---|"]
    for k in fz:
        L.append(f"| {k['field']} | {(k['number'] + ' ' + k['name']).strip()} | {k['V']:.1f} | {k['H']:.2f} | "
                 f"{k.get('flux_ujy') or 0:.0f} | {k.get('lam_um') or 0:.2f} | {k.get('snr')} | {k['n_det']} |")
    L += ["", "### Missed known objects", "",
          "Reasons, V < 19: " + ", ".join(f"{c}: {n}" for c, n in summ["miss_reasons_v19"].items()) + ".",
          "Reasons, V < 20: " + ", ".join(f"{c}: {n}" for c, n in summ["miss_reasons_v20"].items()) + ".", "",
          "Every missed object with V < 18:", "", "| Field | Object | V | H | Reason |", "|---|---|---|---|---|"]
    for k in sorted(missed, key=lambda k: k["V"]):
        if k["V"] < 18:
            L.append(f"| {k['field']} | {(k['number'] + ' ' + k['name']).strip()} | {k['V']:.1f} | {k['H']} | {k['reason']} |")
    L += ["", "The full list (V ≤ 20.5) with reasons is in `site/data/asteroids/summary.json` (`missed`)."]
    return "\n".join(L)


def main(site=False, replace=False):
    """site=False: write to cache/asteroids/report/ (drafts); site=True: site/data/asteroids/."""
    runs = [r for r in _newest_runs()]
    mark_crowded(runs)
    rows = [field_row(r) for r in runs]
    md, tot = md_tables(rows, runs)
    offs = [d["off_px"] for r in runs for k in r.get("known", []) if k.get("found") for d in k["dets"] if "off_px" in d]
    offs_as = [d["off_arcsec"] for r in runs for k in r.get("known", []) if k.get("found") for d in k["dets"]
               if "off_arcsec" in d]
    found = [dict(k, field=r["field"]["id"]) for r in runs for k in r.get("known", []) if k.get("found")]
    missed = [dict(k, field=r["field"]["id"]) for r in runs for k in r.get("known", []) if not k.get("found")]
    tracks = [dict(t, field=r["field"]["id"]) for r in runs for t in r.get("tracklets", [])]
    linked = [t for t in tracks if link_ok(t)]
    wrong = [t for t in tracks if t.get("status") == "linked" and not link_ok(t)]
    led = json.loads(A.LEDGER.read_text()) if A.LEDGER.exists() else {}
    cb = cache_bytes()
    summ = dict(
        generated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), n_fields=len(runs),
        n_fields_ok=sum(1 for r in runs if not r.get("error")),
        totals=tot, n_found=len(found), n_detections=len(offs),
        offset_px=dict(median=round(float(np.median(offs)), 3), p90=round(float(np.percentile(offs, 90)), 3),
                       max=round(float(np.max(offs)), 3), frac_within_1px=round(float(np.mean(np.array(offs) <= 1)), 4))
        if offs else None,
        offset_px_without_parallax=(lambda g: dict(median=round(float(np.median(g)), 3), p90=round(float(np.percentile(g, 90)), 3),
                                                   max=round(float(np.max(g)), 3),
                                                   frac_within_1px=round(float(np.mean(np.array(g) <= 1)), 4)) if g else None)(
            geocentric_offsets(runs)),
        offset_arcsec=dict(median=round(float(np.median(offs_as)), 2), p90=round(float(np.percentile(offs_as, 90)), 2),
                           max=round(float(np.max(offs_as)), 2)) if offs_as else None,
        false_per_field=dict(total=sum(r["n_false"] or 0 for r in rows if not r.get("error")),
                             median=float(np.median([r["n_false"] or 0 for r in rows if not r.get("error")])) if rows else None),
        tracklets=dict(objects=len(tracks), tried=sum(1 for t in tracks if has_visit2(t)), linked=len(linked),
                       wrong_links=[dict(field=t["field"], name=t["name"], off2_px=t.get("off2_px")) for t in wrong],
                       rate_diff_frac_median=round(float(np.median([abs(t["rate_diff_frac"]) for t in linked
                                                                      if t.get("rate_diff_frac") is not None])), 4)
                       if linked else None,
                       pa_diff_deg_median=round(float(np.median([abs(t["pa_diff_deg"]) for t in linked
                                                                  if t.get("pa_diff_deg") is not None])), 2)
                       if linked else None),
        bytes=dict(s3=cb["s3_payload_bytes"], **cb, ledger_s3=led.get("total_s3_bytes"),
                   ledger_s3_requests=led.get("total_s3_requests"), ledger_skybot=led.get("total_skybot_bytes")),
        fields=rows,
        found=[dict(field=k["field"], name=k["name"], number=k["number"], V=k["V"], H=k["H"], n_det=k["n_det"],
                    off_px_median=k["off_px_median"], off_px_max=k["off_px_max"], flux_ujy=k.get("flux_ujy"),
                    snr=k.get("snr"), lam_um=k.get("lam_um"), cls=k["cls"]) for k in found],
        miss_reasons_v19=dict(__import__("collections").Counter(reason_category(k["reason"]) for k in missed
                                                                 if k["V"] < 19).most_common()),
        miss_reasons_v20=dict(__import__("collections").Counter(reason_category(k["reason"]) for k in missed
                                                                 if k["V"] < 20).most_common()),
        missed=[dict(field=k["field"], name=k["name"], number=k["number"], V=k["V"], H=k["H"], reason=k["reason"],
                     category=reason_category(k["reason"]),
                     forced_snr=k.get("forced_snr"), cls=k["cls"]) for k in missed],
        tracklets_list=[{k: v for k, v in t.items() if k != "dets2"} for t in tracks])
    OUT = A.OUT_SITE if site else S3.CACHE / "report"
    OUT.mkdir(parents=True, exist_ok=True)
    summ["blinks"] = sorted(q.parent.name for q in OUT.glob("*/blink.json"))
    p = (OUT / "summary.json") if replace else _new_path(OUT / "summary.json")
    p.write_text(json.dumps(A._jsonable(summ), indent=1))
    cands = candidates(runs)
    for k, c in enumerate(cands, 1):
        c["id"] = f"A{k:03d}"
    cp = _new_path(OUT / "candidates.json")
    final_cp = (OUT / "candidates.json") if replace else cp
    if replace:
        cp = OUT / f"candidates.part{time.strftime('%Y%m%dT%H%M%S')}.json"     # SC.write never overwrites
    SC.write(cp, dict(name="asteroid-fields", label=f"{len(runs)} SPHEREx ecliptic fields (known-asteroid recovery)",
                      fields=[dict(id=r["field"]["id"], visit=r["field"]["visit"], detector=r["field"]["detector"],
                                   ra=r["field"]["ra"], dec=r["field"]["dec"], date=r["field"]["date"]) for r in runs]),
             cands, {A.NAME: dict(name="known-asteroid recovery in ecliptic fields (single exposures, linked per visit)",
                                  thresholds=dict(z=A.Z_DET, link_px=A.LINK_PX, match_px=A.MATCH_PX,
                                                  model_frac=A.MODEL_C, box_px=A.BOX, v_analyse=A.V_ANALYSE))})
    if cp != final_cp:
        __import__("os").replace(cp, final_cp)
        cp = final_cp
    res_md = results_markdown(summ, md, missed, tracks, found)
    (S3.CACHE / "report").mkdir(parents=True, exist_ok=True)
    (S3.CACHE / "report" / "results.md").write_text(res_md)
    if site:
        doc = A.BL.PIPE / "ASTEROIDS.md"
        txt = doc.read_text()
        if "RESULTS_PLACEHOLDER" in txt:
            doc.write_text(txt.replace("RESULTS_PLACEHOLDER", res_md))
            print(f"filled the Results section of {doc}")
        elif replace and "\n## Results\n" in txt and "\n## Limits\n" in txt:
            head, rest = txt.split("\n## Results\n", 1)
            _, tail = rest.split("\n## Limits\n", 1)
            doc.write_text(head + "\n## Results\n\n" + res_md + "\n\n## Limits\n" + tail)
            print(f"replaced the Results section of {doc}")
    print(md)
    print()
    print(json.dumps({k: summ[k] for k in ("totals", "n_found", "n_detections", "offset_px", "offset_px_without_parallax",
                                          "offset_arcsec", "miss_reasons_v19", "miss_reasons_v20",
                                          "false_per_field", "tracklets", "bytes")}, indent=1))
    print(f"\nwrote {p} and {cp}")
    # missed list (V < 19) and reason counts (V < 20)
    print("\nMissed V < 19:")
    for k in sorted(missed, key=lambda k: k["V"]):
        if k["V"] < 19:
            print(f"| {k['field']} | {(k['number'] + ' ' + k['name']).strip()} | {k['V']:.1f} | {k['H']} | {k['reason']} |")
    from collections import Counter
    for v in (19, 20):
        c = Counter(reason_category(k["reason"]) for k in missed if k["V"] < v)
        print(f"\nMiss reasons V < {v}:", dict(c.most_common()))


# ============================================================================ blink
def blink(field_id, name, pix_arcsec=3.0, margin_arcsec=45.0, up=3, site=False):
    """Frames of one recovered asteroid: reference (median of the references), the 4 sub-exposures of
    the visit and the sub-exposures of the linked second visit, on one north-up grid."""
    from astropy.wcs import WCS
    from scipy.ndimage import map_coordinates
    from PIL import Image
    runs = {r["field"]["id"]: r for r in _newest_runs()}
    r = runs[field_id]
    k = next(k for k in r["known"] if k["name"] == name and (k.get("found") or k.get("found_stack")))
    dets1 = k["dets"] if k.get("found") else k["stack"]["subs"]
    tr = next((t for t in r.get("tracklets", []) if t["name"] == name and link_ok(t)), None)
    pts = [(d["ra"], d["dec"]) for d in dets1] + ([(d["ra"], d["dec"]) for d in tr["dets2"]] if tr else [])
    ra0 = float(np.mean([p[0] for p in pts]))
    dec0 = float(np.mean([p[1] for p in pts]))
    cosd = math.cos(math.radians(dec0))
    ext = max(max(abs((p[0] - ra0) * cosd), abs(p[1] - dec0)) for p in pts) * 3600 + margin_arcsec
    n = int(2 * ext / pix_arcsec) + 1
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-pix_arcsec / 3600, pix_arcsec / 3600]
    yy, xx = np.mgrid[0:n, 0:n]
    gr, gd = w.all_pix2world(xx.ravel(), yy.ravel(), 0)

    def onto_grid(exp):
        x, y = exp.world2pix(gr, gd)
        x0, y0 = int(math.floor(x.min())) - 3, int(math.floor(y.min())) - 3
        x1, y1 = int(math.ceil(x.max())) + 3, int(math.ceil(y.max())) + 3
        a = exp.box("IMAGE", x0, y0, x1, y1).astype(float)
        b, _ = A.robust_bg(a)
        a = a - b
        bad = ~np.isfinite(a)
        img = map_coordinates(np.where(bad, 0, a), [y - y0, x - x0], order=1, mode="constant", cval=np.nan)
        m = map_coordinates(bad.astype(float), [y - y0, x - x0], order=1, mode="constant", cval=1.0)
        img[m > 0.5] = np.nan
        return img.reshape(n, n)

    frames = []
    subs = r["exposures"]
    # reference: median of the reference exposures used for this object's boxes
    ref_keys = k.get("ref_keys") or []
    ref_imgs = [onto_grid(S3.exposure(key)) for key in ref_keys]
    if ref_imgs:
        frames.append(dict(kind="reference", label=f"reference: median of {len(ref_imgs)} other dates", img=np.nanmedian(
            np.stack(ref_imgs), 0), mjd=None, key=None))
    for d in dets1:
        e = subs[d["sub"] - 1]
        frames.append(dict(kind="visit1", label=f"visit 1, exposure {d['sub']}", img=onto_grid(S3.exposure(e["key"])),
                           mjd=d["mjd"], key=e["key"], det=d, pred=k["predicted"][d["sub"] - 1]))
    if tr:
        for d in tr["dets2"]:
            frames.append(dict(kind="visit2", label=f"visit 2 ({tr['dt_h']:+.1f} h), exposure {d['sub']}",
                               img=onto_grid(S3.exposure(d["key"])), mjd=d["mjd"], key=d["key"], det=d,
                               pred=dict(ra=d["pred_ra"], dec=d["pred_dec"]) if "pred_ra" in d else None))
    frames = frames[:1] + sorted(frames[1:], key=lambda f: f["mjd"]) if frames and frames[0]["kind"] == "reference" \
        else sorted(frames, key=lambda f: f["mjd"])
    allv = np.concatenate([f["img"][np.isfinite(f["img"])] for f in frames])
    lo, hi = np.percentile(allv, 1), np.percentile(allv, 99.7)
    out = _new_path((A.OUT_SITE if site else S3.CACHE / "report") / name.replace(" ", "_"))
    out.mkdir(parents=True, exist_ok=False)
    meta = dict(name=name, number=k["number"], V=k["V"], H=k["H"], field=field_id, visit=r["field"]["visit"],
                detector=r["field"]["detector"], grid=dict(size_px=n, pixel_arcsec=pix_arcsec, upscale=up, ra=ra0, dec=dec0,
                                                         north_up=True, east_left=True),
                rate_ephem=tr["rate_ephem"] if tr else None, rate_measured=tr["rate_measured"] if tr else None,
                frames=[])
    soft = (hi - lo) * 0.05
    for i, f in enumerate(frames):
        a = np.clip((np.arcsinh((np.nan_to_num(f["img"], nan=lo) - lo) / soft) / np.arcsinh((hi - lo) / soft)), 0, 1)
        g = (a[::-1] * 255).astype(np.uint8)                       # north up
        im = Image.fromarray(g, "L").resize((n * up, n * up), Image.NEAREST)
        fn = f"frame_{i:02d}.png"
        im.save(out / fn, optimize=True)
        fm = dict(file=fn, kind=f["kind"], label=f["label"], mjd=f["mjd"])
        if f["mjd"]:
            from astropy.time import Time
            fm["utc"] = Time(f["mjd"], format="mjd").iso[:19]
        if f.get("det"):
            x, y = w.all_world2pix(f["det"]["ra"], f["det"]["dec"], 0)
            fm["detected_xy"] = [round(float(x) * up + up / 2, 1), round((n - 1 - float(y)) * up + up / 2, 1)]
            fm["lam_um"] = f["det"].get("lam_um")
            fm["snr"] = f["det"].get("snr")
        if f.get("pred"):
            x, y = w.all_world2pix(f["pred"]["ra"], f["pred"]["dec"], 0)
            fm["ephemeris_xy"] = [round(float(x) * up + up / 2, 1), round((n - 1 - float(y)) * up + up / 2, 1)]
        meta["frames"].append(fm)
    (out / "blink.json").write_text(json.dumps(A._jsonable(meta), indent=1))
    print(f"wrote {len(frames)} frames to {out}")

