"""Vetting of the merged candidate list (run.py calls post() after the detectors).

1. One object, one record. A moving source leaves footprints in the other detectors: it
   "disappears" at its old position and "appears" at the new one (detector A, lone peaks),
   the fixed-position photometry of detector V sees it fade or brighten, and a source with
   strong spectral features lights up in single exposures (detector C). Records that lie on
   the track of a mover are attached to it (track_records) and are no longer candidates of
   their own.
2. Single-exposure transients (detector C) are tested against the two things that imitate
   them:
   wavelength mismatch  SPHEREx sees every point at ONE wavelength per exposure (linear
                        variable filter). A steady source with a spectral feature (a T dwarf's
                        methane bands, an emission line) is much brighter in the exposures
                        that fall on the feature than in the season median it is compared
                        with. Test: at the same wavelength (within LAM_TOL) in OTHER visits the
                        source is just as bright -> not a transient. The same position
                        flaring in two or more visits is the same thing (a solar-system body
                        would have moved away).
   cosmic rays / glints a visit holds 2-4 exposures a few minutes apart. A source that is in
                        one of them and absent from the others of the same detector, although
                        they cover the position deeply enough, is not a celestial source.
3. motion.displacement: how far the object moved between two same-orientation seasons (the
   number a person can check on the blink frames), next to the rate in arcsec per year.
"""
import math

import numpy as np

import blink as BL
from . import measure as M
from . import schema as SC

TRACK_ARCSEC = 9.0          # 1.5 native pixels: records this close to a mover's track belong to it
STAMP_ARCSEC = 21.5         # 3.5 native pixels: half width of the 7 x 7 px measurement stamp
CROWD_RATIO = 1.5           # a mover makes the motion of another source "not independent" only when it is this
#                             much brighter. Injection runs (WISE 0855 AB 14 / 18, Eps Indi B AB 13): the right
#                             rejections had flux ratios 1.9, 8.7 and 35 (a false motion beside a real fast mover);
#                             at 1.00 to 1.35 the rule threw out the true mover (a spurious one-season-pair record,
#                             or a second record of the same object, was "brighter" by 0.4 to 35 %)
STEADY_ARCSEC = 6.15        # a transient this close to a listed source (1 native pixel) is tested as that source
LAM_TOL = 0.015             # fractional wavelength difference that counts as "the same wavelength"
EXCESS_FRAC = 0.3           # a real brightening exceeds the same-wavelength flux of other visits by this fraction
VISIT_SEEN = 0.5            # confirmed: another exposure of the visit shows >= this fraction of the flux ...
VISIT_SEEN_SIGMA = 3.0      # ... at this significance
VISIT_ABSENT_SIGMA = 2.0    # refuted: it shows less than half the flux at this significance ...
VISIT_STILL_MIN = 4.0       # ... in an exposure taken within this many minutes (an asteroid at 0.75"/min moves 3")


def post(ctx, cands):
    """All vetting steps; returns the new candidate list (ids renumbered)."""
    info = {}
    cands = absorb_tracks(ctx, cands, info)
    try:
        vet_transients(ctx, cands, info)
    except Exception as ex:                                   # vetting must never lose the detections
        info["transient_vetting_error"] = f"{type(ex).__name__}: {ex}"
    add_displacement(ctx, cands)
    for c in cands:                       # the checks of a rejected motion do not describe a non-motion record
        if c["kind"] != "motion":
            c.pop("checks", None)
        elif c.get("motion") and c["motion"].get("parallax_fit_mas"):
            # detector A's rough stack estimate of a parallax is superseded by the track fit
            c["flags"] = [f for f in c["flags"] if not f.startswith("season positions need a parallax")]
    ctx.info["vetting"] = info
    return renumber(cands)


def after_sso(ctx, cands):
    """Single-exposure events that could not be checked in a second exposure. A detection in one
    exposure of one detector cannot be told from a cosmic-ray hit or a glint; the only other
    confirmation is a known asteroid at that place and time (sso.classify, run before this). At
    the depth of one SPHEREx exposure (AB ~17-18) the asteroid catalogue is complete, so what is
    left is rejected. (Eps Indi B field, 41 deg from the ecliptic: 5 such events in 458
    exposures.) The flag says whether the asteroid catalogue was asked."""
    n = 0
    for c in cands:
        if c["kind"] != "transient" or c["class"] != "candidate" or "single exposure" not in c["flags"]:
            continue
        asked = c.get("sso_check") == "no known object"
        tail = " and no known asteroid was there" if asked else "; the asteroid catalogue was not asked"
        c["class"] = "artifact"
        ev = c.setdefault("vetting", {})
        if ev.pop("pending", None) == "refuted":
            c["flags"].append("in one exposure only: another exposure of the same visit and detector, taken within "
                              f"{VISIT_STILL_MIN:g} minutes, covers the position and does not show it (cosmic ray or glint)"
                              + tail)
        else:
            c["flags"].append("single exposure, not confirmed: no second exposure covers the position" + tail)
            n += 1
        ev["reason"] = "cosmic"
    ctx.info.setdefault("vetting", {}).setdefault("transients", {})["single_exposure_unconfirmed_rejected"] = n


def renumber(cands):
    order = {"candidate": 0, "variable": 1, "gaia-known": 2, "asteroid-known": 3, "artifact": 4}
    cands.sort(key=lambda c: (order[c["class"]], c["kind"] == "transient", -(c.get("snr") or 0)))
    for k, c in enumerate(cands, 1):
        c["id"] = f"C{k:03d}"
    return cands


def _movers(cands):
    return [c for c in cands if c["kind"] == "motion" and c.get("motion") and c["class"] in ("candidate", "gaia-known")]


def _track_distance(m, ra, dec, t=None):
    """Distance (arcsec) of (ra, dec) from the track of mover m: at time t (Julian year) when
    given, else from the nearest point of the track between its first and last season (padded
    by 0.3 yr)."""
    mo = m["motion"]
    cosd = math.cos(math.radians(m["dec"]))
    if "P" in (m.get("detectors") or []):
        # a distant body: its seasons lie hundreds of arcsec apart (parallax), not on one line
        ps = m.get("positions") or [m]
        return min(math.hypot(((ra - p["ra"] + 180) % 360 - 180) * cosd * 3600, (dec - p["dec"]) * 3600) for p in ps)
    pE, pN = mo["pmra_mas_yr"] / 1000, mo["pmdec_mas_yr"] / 1000
    x = ((ra - m["ra"] + 180) % 360 - 180) * cosd * 3600
    y = (dec - m["dec"]) * 3600
    t0 = m.get("epoch") or 2026.0
    if t is not None:
        return math.hypot(x - pE * (t - t0), y - pN * (t - t0))
    ts = [p["jyear"] for p in m.get("positions") or []] or [t0 - 0.75, t0 + 0.75]
    a, b = min(ts) - 0.3 - t0, max(ts) + 0.3 - t0
    v2 = pE * pE + pN * pN
    s = 0.0 if v2 <= 0 else min(max((x * pE + y * pN) / v2, a), b)
    return math.hypot(x - pE * s, y - pN * s)


def _brighter(m, c, ratio=1.0):
    """True when mover m is at least `ratio` times as bright as record c (flux, else S/N); False when unknown."""
    for k in ("flux_ujy", "snr"):
        a, b = m.get(k), c.get(k)
        if a is not None and b is not None and a > 0 and b > 0:
            return a >= ratio * b
    return False


def _weak(m):
    """A motion that detector A alone saw, in one season pair of a field with more seasons. Two unrelated
    changes (one source fading, another brightening, or lobes of two different movers) look like this, and
    the finder cannot tell which of the two it is. Such a record is reported, but it does not decide about
    other records: it neither makes another motion an artifact nor takes the changes at its two ends as its
    own footprints (they stay candidates of their own). Eps Indi B field, injection runs AB 12 to 14, seed 1:
    the 2 true movers lost to the crowding rule were lost to such a record built from their own lobes (they
    had been found by A, D and V at 296 and 500 sigma), and the 3 injected appearing / disappearing sources
    lost against v1 were attached to such a record."""
    return (m.get("detectors") or []) == ["A"] and \
        any(str(f).startswith("one season pair only") for f in m.get("flags") or [])


def _closest_approach(m, c):
    """Smallest separation (arcsec) of two moving records at the epochs at which either of them was measured
    (their season positions); None when neither has season positions. Two tracks that cross are not a
    crowding case when the two sources were never inside one measurement stamp at the same time."""
    if not (m.get("motion") and c.get("motion")):
        return None
    ts = sorted({round(float(p["jyear"]), 3) for r in (m, c) for p in (r.get("positions") or [])
                 if p.get("jyear") is not None})
    if not ts:
        return None

    def at(r, t):
        mo = r["motion"]
        dt = t - (r.get("epoch") or 2026.0)
        return (r["ra"] + mo["pmra_mas_yr"] * dt / 3.6e6 / math.cos(math.radians(r["dec"])),
                r["dec"] + mo["pmdec_mas_yr"] * dt / 3.6e6)
    return min(SC.sep_arcsec(*at(m, t), *at(c, t)) for t in ts)


def absorb_tracks(ctx, cands, info):
    """Attach the footprints of a mover to the mover: appearing / disappearing / variable records
    and transients within TRACK_ARCSEC of its track, and within STAMP_ARCSEC when the mover is
    the brighter of the two (it then passes through the 7 x 7 px measurement stamp of the other
    source and changes that source's flux and position in the seasons it is inside).
    For the same reason an uncatalogued MOTION within STAMP_ARCSEC of the track of a clearly
    brighter mover (CROWD_RATIO) is not an independent measurement: it becomes an artifact
    (reason crowding). Two records of similar brightness both stay: which of them depends on the
    other cannot be told from the brightness. The two must have been inside one stamp at the same
    time (_closest_approach at the season epochs): tracks that merely cross do not count. A
    one-season-pair record of detector A alone (_weak) neither rejects nor attaches anything."""
    movers = _movers(cands)
    if not movers:
        return cands
    out, n, nm = [], 0, 0
    # 1. motions inside the stamp of a clearly brighter mover. Done for all motions before anything is
    #    attached, so that no record is attached to a mover that is rejected here (it would be lost with it).
    for c in cands:
        if c["class"] != "candidate" or c["kind"] != "motion" or "P" in (c.get("detectors") or []):
            continue
        for m in movers:
            if m is c or m["class"] == "artifact" or "P" in (m.get("detectors") or []) \
                    or _weak(m) or not _brighter(m, c, CROWD_RATIO):
                continue
            d = _track_distance(m, c["ra"], c["dec"])
            near = _closest_approach(m, c) if d <= STAMP_ARCSEC else None
            if d <= STAMP_ARCSEC and (near is None or near <= STAMP_ARCSEC):
                c["class"] = "artifact"
                c["flags"].append(f"{d:.0f}\" from the track of a brighter moving source (RA {m['ra']:.5f} "
                                  f"Dec {m['dec']:+.5f}): that source moves through its measurement stamp (crowding)")
                c.setdefault("vetting", {})["reason"] = "crowding"
                nm += 1
                break
    # 2. footprints of the movers that are left
    for c in cands:
        if c["class"] == "artifact" or c["kind"] == "motion":
            out.append(c)
            continue
        t = c.get("epoch") if c["kind"] == "transient" else None
        best = None
        for m in movers:
            if m["class"] == "artifact" or _weak(m):
                continue
            d = _track_distance(m, c["ra"], c["dec"], t)
            lim = STAMP_ARCSEC if _brighter(m, c) and "P" not in (m.get("detectors") or []) else TRACK_ARCSEC
            if d <= lim and (best is None or d < best[0]):
                best = (d, m)
        if best is None:
            out.append(c)
            continue
        m = best[1]
        m.setdefault("track_records", []).append({
            "kind": c["kind"], "class": c["class"], "detectors": c["detectors"], "ra": c["ra"], "dec": c["dec"],
            "epoch": c.get("epoch"), "snr": c.get("snr"), "distance_from_track_arcsec": round(best[0], 1),
            "note": ("single-exposure brightening at the object's position at that time" if c["kind"] == "transient"
                     else "the object leaving / reaching this position, or its light at a fixed position"
                     if best[0] <= TRACK_ARCSEC else
                     "a source whose measurement stamp the brighter moving object passes through")})
        n += 1
    for m in movers:
        tr = m.get("track_records")
        if tr and m["class"] != "artifact":
            m["flags"].append(f"{len(tr)} other record(s) along its track are this object (track_records)")
    info["records_attached_to_movers"] = n
    info["motions_in_the_stamp_of_a_brighter_mover"] = nm
    return out


def _steady_source(ctx, c, src, A, k):
    """Index of the listed source within STEADY_ARCSEC of transient c at its time, or None."""
    e = ctx.exps[k]
    r, d = src.at(e["mjd"], e["jyear"])
    cosd = math.cos(math.radians(c["dec"]))
    dd = np.hypot((r - c["ra"]) * cosd, d - c["dec"]) * 3600
    if not len(dd):
        return None
    j = int(np.argmin(dd))
    return j if dd[j] <= STEADY_ARCSEC else None


def _same_wavelength_test(ctx, A, j, k):
    """Is listed source j as bright at the wavelength of exposure k in other visits?
    Returns (verdict, detail): 'feature' (yes: spectral feature), 'excess' (no: brighter now
    than at this wavelength in other visits), or 'unknown' (no other visit at this wavelength)."""
    e = ctx.exps[k]
    lam = A["lam"][k, j]
    f, ef = A["f"][k, j], A["ef"][k, j]
    if not (np.isfinite(lam) and np.isfinite(f) and np.isfinite(ef)):
        return "unknown", {}
    comp = [i for i, q in enumerate(ctx.exps)
            if q["detector"] == e["detector"] and q["visit"] != e["visit"] and A["ok"][i, j]
            and np.isfinite(A["f"][i, j]) and np.isfinite(A["lam"][i, j]) and abs(A["lam"][i, j] / lam - 1) <= LAM_TOL]
    if len(comp) < 2:
        return "unknown", {"n_same_wavelength": len(comp)}
    fc = A["f"][comp, j]
    med = float(np.median(fc))
    scat = float(BL.robust_sigma(fc)) if len(comp) >= 4 else float(np.median(A["ef"][comp, j]))
    excess = float(f - med)
    need = max(EXCESS_FRAC * abs(med), 3 * math.hypot(float(ef), scat))
    det = {"n_same_wavelength": len(comp), "wavelength_um": round(float(lam), 4),
           "flux_ujy": round(float(f) * BL.PIXEL_UJY, 1), "same_wavelength_other_visits_ujy": round(med * BL.PIXEL_UJY, 1)}
    return ("excess" if excess > need else "feature"), det


def _visit_test(ctx, c, k):
    """Is transient c (found in exposure k) also in the other exposures of the same visit and
    detector? Returns ('confirmed' | 'refuted' | 'unknown', detail)."""
    e = ctx.exps[k]
    cosd = math.cos(math.radians(c["dec"]))

    def forced(q):
        cE, cN = ctx.cal.get(q["file"], (0.0, 0.0))
        m = M.measure_linear(q, [c["ra"] + cE / 3600 / cosd], [c["dec"] + cN / 3600],
                             image=None if ctx.images is None else ctx.images.get(q["file"]))
        return (float(m["f"][0]), float(m["ef"][0])) if m["ok"][0] else None
    here = forced(e)
    if here is None or here[0] <= 0:
        return "unknown", {}
    others = [q for q in ctx.exps if q["visit"] == e["visit"] and q["detector"] == e["detector"] and q["file"] != e["file"]]
    seen = absent = usable = 0
    for q in others:
        r = forced(q)
        if r is None or not np.isfinite(r[1]) or r[1] <= 0:
            continue
        usable += 1
        if r[0] >= VISIT_SEEN * here[0] and r[0] / r[1] >= VISIT_SEEN_SIGMA:
            seen += 1
        elif (VISIT_SEEN * here[0] - r[0]) / r[1] >= VISIT_ABSENT_SIGMA \
                and abs(q["mjd"] - e["mjd"]) * 1440.0 <= VISIT_STILL_MIN:
            # only an exposure taken while a main-belt asteroid (< 0.75"/min) would still be inside
            # the same pixel can say "not there"
            absent += 1
    det = {"exposures_same_visit_and_detector": usable, "seen_in": seen, "absent_in": absent}
    if seen:
        return "confirmed", det
    if absent:
        return "refuted", det
    return "unknown", det


def vet_transients(ctx, cands, info):
    tr = [c for c in cands if c["kind"] == "transient" and c["class"] == "candidate"]
    counts = {"tested": len(tr), "spectral_feature_of_steady_source": 0, "repeats_at_same_position": 0,
              "not_in_other_exposures_of_visit": 0, "confirmed_in_visit": 0, "unverified_single_exposure": 0}
    info["transients"] = counts
    if not tr:
        return
    from . import deep_astrom
    src, ng = deep_astrom.field_sources(ctx)
    A, T = deep_astrom.field_measure(ctx)
    idx = {e["file"]: i for i, e in enumerate(ctx.exps)}
    # the same position flaring in >= 2 visits is a steady source, not a moving body
    groups = []
    for c in tr:
        for g in groups:
            if SC.sep_arcsec(g[0]["ra"], g[0]["dec"], c["ra"], c["dec"]) <= STEADY_ARCSEC:
                g.append(c)
                break
        else:
            groups.append([c])
    repeat = set()
    for g in groups:
        if len({round(c.get("mjd") or 0, 1) for c in g}) >= 2:
            repeat.update(id(c) for c in g)
    for c in tr:
        dets = c.get("detections") or []
        best = max(dets, key=lambda d: d.get("snr") or 0) if dets else None
        k = idx.get(best["file"]) if best else None
        ev = c.setdefault("vetting", {})
        if id(c) in repeat:
            c["class"] = "artifact"
            c["flags"].append("the same position brightens in several visits: a steady source with a spectral feature seen "
                              "through the linear variable filter (wavelength mismatch), not a moving or transient object")
            ev["reason"] = "wavelength"
            counts["repeats_at_same_position"] += 1
            continue
        if k is None:
            continue
        j = _steady_source(ctx, c, src, A, k) if src.n else None
        if j is not None:
            verdict, det = _same_wavelength_test(ctx, A, j, k)
            ev["steady_source"] = dict(det, source=str(src.ids[j]), verdict=verdict)
            if verdict in ("feature", "unknown"):
                c["class"] = "artifact"
                c["flags"].append("at the position of a steady source that is as bright at this wavelength in other visits: "
                                  "its spectrum through the linear variable filter (wavelength mismatch)" if verdict == "feature"
                                  else "at the position of a steady source; no other visit at this wavelength to compare "
                                       "with: treated as its spectrum through the linear variable filter")
                ev["reason"] = "wavelength"
                counts["spectral_feature_of_steady_source"] += 1
                continue
            c["flags"].append("brighter than the steady source at this position is at the same wavelength in other visits "
                              "(a flare, or an object passing in front of it)")
        if len({d["file"] for d in dets}) >= 2:
            counts["confirmed_in_visit"] += 1
            continue
        verdict, det = _visit_test(ctx, c, k)
        ev["visit"] = dict(det, verdict=verdict)
        if verdict == "refuted":
            # not rejected yet: the asteroid catalogue is asked first (run.py: sso.classify, then after_sso)
            ev["pending"] = "refuted"
            if "single exposure" not in c["flags"]:
                c["flags"].append("single exposure")
            counts["not_in_other_exposures_of_visit"] += 1
        elif verdict == "confirmed":
            c["flags"] = [f for f in c["flags"] if f != "single exposure"] + ["also seen in another exposure of the visit"]
            counts["confirmed_in_visit"] += 1
        else:
            if "single exposure" not in c["flags"]:
                c["flags"].append("single exposure")
            c["flags"].append("no other exposure of the visit covers the position in this detector: not verifiable")
            counts["unverified_single_exposure"] += 1


def add_displacement(ctx, cands):
    """motion.displacement: measured shift between two same-orientation seasons (longest
    baseline); between the first and last season when no such pair exists."""
    si = ctx.season_info
    for c in cands:
        mo, pos = c.get("motion"), c.get("positions") or []
        if not mo or len(pos) < 2 or mo.get("displacement"):
            continue
        best = None
        for i in range(len(pos)):
            for k in range(i + 1, len(pos)):
                a, b = pos[i], pos[k]
                if a["season"] not in si or b["season"] not in si:
                    continue
                o1, o2 = si[a["season"]]["orient_deg"], si[b["season"]]["orient_deg"]
                same = abs((o1 - o2 + 180) % 360 - 180) < 30
                dt = b["jyear"] - a["jyear"]
                key = (same, dt)
                if best is None or key > best[0]:
                    best = (key, a, b)
        if best is None:
            continue
        (same, dt), a, b = best
        cosd = math.cos(math.radians(0.5 * (a["dec"] + b["dec"])))
        dE = ((b["ra"] - a["ra"] + 180) % 360 - 180) * cosd * 3600
        dN = (b["dec"] - a["dec"]) * 3600
        mo["displacement"] = {"from": a["season"], "to": b["season"], "dt_yr": round(dt, 4),
                              "arcsec": round(math.hypot(dE, dN), 3),
                              "err_arcsec": round(math.hypot(a.get("err_arcsec") or 0, b.get("err_arcsec") or 0), 3),
                              "pa_deg": round(math.degrees(math.atan2(dE, dN)) % 360, 1), "same_orientation": bool(same)}
