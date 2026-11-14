"""What is it, how sure are we, is it confirmed, and the one-line answer for a field.

run.py calls annotate(ctx, cands) after the detectors and the vetting. Every record gets

  nature        {label, text, evidence, reason}: the physical kind of object and what the
                decision rests on
  confidence    {percent, basis, sentence, how, ...}: a derived "how sure" number
  confirmed     True / False with the checks behind it (confirmation)

and verdict(ctx, cands) makes the one-line plain-language answer of the field.

NATURE. The decisive measurement for anything that moves is its parallax. SPHEREx looks 90 deg
away from the Sun, so the seasons of a field are half a year apart at opposite ends of the
Earth's orbit: a body at distance d (AU) is displaced by 2 x 206265"/d between consecutive
seasons, and comes back between seasons one year apart, where only its own motion is left.
A body BOUND TO THE SUN cannot move faster than the escape speed at its distance, i.e. its
proper motion is at most  mu_max(d) = sqrt(2) x 1296000"/yr x d^-1.5  (1296000"/yr = 2 pi rad/yr,
the circular rate at 1 AU). A source moving mu must therefore be closer than
    d_max = (sqrt(2) x 1296000 / mu)^(2/3) AU      and show a parallax of at least
    pi_min = 206265" / d_max.
Barnard's Star (10.4"/yr): d_max = 3140 AU, pi_min = 66"; a 0.1"/yr mover: pi_min = 3".
A source followed as ONE track through seasons half a year apart has a parallax of at most a
few arcsec, so with mu >= 0.1"/yr it is far outside the Solar System: a star or brown dwarf.
(Solar System bodies at hundreds of AU jump by hundreds of arcsec between seasons; finding
them needs the dedicated linker, detect/distant.py.) For such a source the tangential velocity
4.74 x mu / pi km/s must also stay below the Galactic escape speed (800 km/s, with the 3 sigma upper
limit of the fitted parallax); otherwise no known kind of object moves like this: the record keeps its
measurement, says so, and is never confirmed. Colour (flux per detector, 0.75-5 um) separates reflected sunlight (brightest at
1 um, 7x fainter at 4.6 um) from a cold self-luminous object (seen at 4-5 um only).

CONFIDENCE (derived, not chosen):
  catalogued movers       percent = agreement of the measured motion vector with Gaia DR3,
                          100 x (1 - |measured - Gaia| / |Gaia|), with the difference in sigma.
  uncatalogued movers     percent = 100 x (1 - false-alarm probability of the field):
      FAP = N_tested x p(z) x K
      p(z)  two-sided Gaussian tail of the calibrated significance z (errors from the residual
            permutation of the source itself, astrometry.calibrate)
      N     sources tested in the field (trials)
      K     how much heavier than Gaussian the tail could still be without the date-shuffle
            null test having seen it: K = max(1, UL / p(5)), UL = 95 % upper limit of the
            false-mover rate per tested source in the shuffle test (NULL_TEST below).
  known asteroids         position match with the ephemeris.
  anything else           no null calibration yet: no percentage (basis "not-calibrated").

CONFIRMED (rule "confirm-v1"): see confirm().
"""
import math
import re

from scipy.stats import norm

from . import schema as SC

K_CIRC = 1296000.0          # arcsec/yr x AU^1.5: heliocentric circular rate at 1 AU
AU_ARCSEC = 206264.806      # arcsec x AU: parallax of a body at 1 AU
V_GALACTIC_MAX = 800.0      # km/s: no star bound to the Galaxy moves faster relative to the Sun
SOLAR_FNU = {"D1": 1.0, "D2": 0.94, "D3": 0.70, "D4": 0.33, "D5": 0.18, "D6": 0.14}   # Sun, relative to D1 (AB)

# date-shuffle null test of the mover decision (detectors B + D): false movers / tested sources.
# Update from ajan_durumu/test_sonuclari.md after every test round.
NULL_TEST = {"false_movers": 0, "source_trials": 22200,
             "what": "60 exposure-date shuffles of the WISE 0855 field (370 sources each), core v1"}

VARIABLE_NULL_TEST = None    # no null test for brightness changes yet: they stay candidates (never confirmed)
CONFIRM_SIGMA = 7.0
CONFIRM_PERCENT = 99.9
CONFIRM_MIN_INDEPENDENT = 2
RULE = "confirm-v1"
NATURE_KEYS = ("label", "text", "evidence", "reason")
CONFIDENCE_KEYS = ("percent", "basis", "sentence", "how", "false_alarm_probability", "gaia_difference_sigma",
                   "gaia_difference_percent")
EDGE_FLAG = "close to the edge of the quick box"

LABEL_TEXT = {
    "catalogued-star": "a known object of the Gaia catalogue",
    "catalogued-star-anomalous": "a catalogued star that moves differently from its Gaia motion",
    "nearby-star-or-brown-dwarf-candidate": "a nearby star or brown dwarf candidate that is not in Gaia",
    "distant-solar-system-candidate": "a distant Solar System body candidate",
    "solar-system-known": "a known Solar System object",
    "solar-system-candidate": "a Solar System object candidate (not in the asteroid catalogue)",
    "variable-star-candidate": "a variable star candidate",
    "transient-or-moving-candidate": "a source that appeared, disappeared or moved; its nature is open",
    "single-exposure-event": "seen in a single exposure only",
    "artifact": "not a real object",
}
LIGHT_MOVED_ARCSEC = 2.0    # displacement from which an uncatalogued motion needs the images to show it (confirm)
REASONS = (
    ("saturation", ("saturated star", "saturation", "saturated core")),
    ("edge", ("edge",)),
    ("roll", ("opposite telescope orientations", "same-orientation", "opposite-orientation", "ghost")),
    ("wavelength", ("detector halves", "wavelength", "linear variable filter", "one detector", "one bin")),
    ("cosmic", ("cosmic", "one exposure only", "single exposure")),
    ("crowding", ("blend", "structured residual", "variability-induced", "measurement stamp")),
    ("unphysical", ("not physical", "escape speed", "not a physical track")),
    ("track", ("native-pixel", "two flux changes", "straight line", "5 sigma", "stack", "predicted position", "one season pair")),
)


# ------------------------------------------------------------------------------------ physics
def bound_orbit_limit(mu):
    """(d_max AU, pi_min arcsec) for a body bound to the Sun that moves mu arcsec/yr."""
    d_max = (math.sqrt(2) * K_CIRC / max(mu, 1e-9)) ** (2.0 / 3.0)
    return d_max, AU_ARCSEC / d_max


def reflected_mag(radius_km, d_au, albedo=0.3, band="D1"):
    """AB magnitude of a body of radius radius_km at d_au (from the Sun and from us) in
    reflected sunlight, full phase. Sun at 1 AU: AB -27.04 in D1."""
    sun = -27.04 - 2.5 * math.log10(SOLAR_FNU[band])
    return sun - 2.5 * math.log10(albedo * (radius_km / 1.495978707e8) ** 2 / d_au ** 4)


def sed_class(sed):
    """'red-only' (seen at 4-5 um and not at 0.75-1.65 um: a cold self-luminous object), 'red'
    (>= 2x brighter at 4-5 um than at 0.75-1.65 um: a cool dwarf), 'sun-like' (the colour of
    reflected sunlight or of a solar-type star), 'star-like' (anything else), None = not measured."""
    if not sed:
        return None
    short = [sed.get(d) for d in ("D1", "D2") if sed.get(d) is not None]
    lng = [sed.get(d) for d in ("D5", "D6") if sed.get(d) is not None]
    if not lng and not short:
        return None
    if lng and not short:
        return "red-only"
    if lng and max(lng) > 2.0 * max(max(short), 0.0):
        return "red"
    if short and lng:
        r = max(lng) / max(max(short), 1e-9)
        if 0.07 <= r <= 0.36:            # Sun: 0.14-0.18
            return "sun-like"
    return "star-like"


def _reason(flags):
    txt = " | ".join(flags).lower()
    for code, keys in REASONS:
        if any(k in txt for k in keys):
            return code
    return "track"


def _plx(mo):
    """(parallax arcsec, error arcsec, adopted?) of a motion record, or None."""
    if mo.get("parallax_mas") is not None and mo.get("err_parallax_mas") is not None:
        return mo["parallax_mas"] / 1000, mo["err_parallax_mas"] / 1000, True
    t = mo.get("parallax_fit_mas")
    if t:
        return t[0] / 1000, t[1] / 1000, False
    return None


def _gaia_at_2016(ctx, c):
    """Gaia DR3 source at the place where the mover was at the Gaia epoch (2016.0), if any."""
    gt, mo = ctx.gaia, c.get("motion")
    if gt is None or not gt.n or not mo:
        return None
    dt = 2016.0 - (c.get("epoch") or 2026.0)
    cosd = math.cos(math.radians(c["dec"]))
    ra = c["ra"] + mo["pmra_mas_yr"] * dt / 3.6e6 / cosd
    dec = c["dec"] + mo["pmdec_mas_yr"] * dt / 3.6e6
    tol = max(1.5, 3 * abs(dt) * mo["err_speed_arcsec_yr"])
    best = None
    for k in range(gt.n):
        d = SC.sep_arcsec(ra, dec, float(gt.ra[k]), float(gt.dec[k]))
        if d <= tol and (best is None or d < best[0]):
            best = (d, k)
    if best is None:
        return None
    k = best[1]
    return {"source_id": str(gt.sid[k]), "G": round(float(gt.G[k]), 2), "sep_arcsec": round(best[0], 2),
            "five_parameter_solution": bool(gt.has5p[k])}


# ------------------------------------------------------------------------------------ nature
def nature(ctx, c):
    ev = {}
    flags = c.get("flags") or []
    if c["class"] == "artifact":
        r = (c.get("vetting") or {}).get("reason") or _reason(flags)
        if r == "catalogue":           # run.find: the star catalogue could not be reached in this run
            return {"label": "artifact", "reason": r, "evidence": {"flags": flags[:4]},
                    "text": ("Not checked against the star catalogue: the Gaia catalogue could not be reached in this "
                             "run, so this position change cannot be told from a known star or from two known stars "
                             "seen as one. It is not reported as a moving object; run the field again.")}
        return {"label": "artifact", "reason": r, "evidence": {"flags": flags[:4]},
                "text": "Rejected: " + (flags[0] if flags else "did not pass the checks") + "."}
    g = (c.get("match") or {}).get("gaia_dr3")
    if c.get("sed_ujy"):
        ev["sed_ujy"] = c["sed_ujy"]
        ev["sed_class"] = sed_class(c["sed_ujy"])
    if g:
        ev["catalogue"] = {"gaia_dr3": g}
    if c["kind"] == "motion" and c.get("motion"):
        mo = c["motion"]
        mu = mo["speed_arcsec_yr"]
        ev["motion"] = {"speed_arcsec_yr": mu, "err_speed_arcsec_yr": mo["err_speed_arcsec_yr"], "pa_deg": mo["pa_deg"],
                        "significance_sigma": mo.get("significance_sigma")}
        d_max, pi_min = bound_orbit_limit(mu)
        bo = {"max_distance_au": round(d_max, 0), "min_parallax_arcsec": round(pi_min, 2),
              "min_swing_between_half_year_seasons_arcsec": round(2 * pi_min, 1)}
        ev["bound_orbit_test"] = bo
        if c["class"] == "gaia-known" and g:
            plx = g.get("parallax_mas")
            if plx and plx > 0:
                ev["distance_pc"] = round(1000.0 / plx, 2)
                ev["tangential_velocity_km_s"] = round(4.74 * mu / (plx / 1000), 1)
                bo.update(measured_parallax_arcsec=round(plx / 1000, 4), parallax_source="Gaia DR3",
                          bound_to_sun_possible=bool(plx / 1000 >= pi_min))
            txt = (f"A known object (Gaia DR3 {g.get('source_id')}): it moves {mu:.2f} arcsec per year, as the Gaia "
                   f"catalogue says" + (f", at {ev['distance_pc']:.1f} parsec" if ev.get("distance_pc") else "") + ".")
            return {"label": "catalogued-star", "text": txt, "evidence": ev}
        if g and g.get("own_motion") is not False and "anomalous vs Gaia" in " ".join(flags):
            return {"label": "catalogued-star-anomalous", "evidence": ev,
                    "text": (f"A catalogued star (Gaia DR3 {g.get('source_id')}) measured to move {mu:.2f} arcsec per year, "
                             "different from its Gaia motion: a candidate for follow-up (a companion, or a faint "
                             "neighbour in the same pixel).")}
        g16 = _gaia_at_2016(ctx, c)
        if g16:
            ev.setdefault("catalogue", {})["gaia_at_2016_position"] = g16
        px = _plx(mo)
        if px:
            p, ep, adopted = px
            up = max(p, 0.0) + 3 * ep
            bo.update(measured_parallax_arcsec=round(p, 4), err_parallax_arcsec=round(ep, 4),
                      parallax_upper_limit_arcsec=round(up, 4), parallax_source="track fit" + ("" if adopted else " (test value)"),
                      bound_to_sun_possible=bool(up >= pi_min))
            if p > 0 and p >= 3 * ep:
                ev["distance_pc"] = round(1.0 / p, 2)
                ev["distance_pc_range"] = [round(1.0 / (p + ep), 2), round(1.0 / max(p - ep, 1e-6), 2)]
                ev["tangential_velocity_km_s"] = round(4.74 * mu / p, 1)
                vmin = 4.74 * mu / (p + 3 * ep)
            else:
                ev["distance_pc_min"] = round(1.0 / up, 2) if up > 0 else None
                vmin = 4.74 * mu / up if up > 0 else float("inf")
                ev["tangential_velocity_km_s_min"] = round(vmin, 1) if math.isfinite(vmin) else None
            if up < pi_min:
                if vmin > V_GALACTIC_MAX:
                    # The motion is measured; what moves like this is not known. It stays a candidate that
                    # this finder never confirms (confirm(): "physically possible"). It is not thrown away:
                    # a straight track at 5 to 40 arcsec per year without parallax is exactly what the
                    # injection test puts into the images, and v1.1 rejected every bright one of them
                    # (Eps Indi B field, AB 13, seed 1: 16 of 28 movers >= 0.3"/yr found instead of 27).
                    # In the 12 validation fields no real record ever met this condition.
                    ev["physical_test"] = {"passes": False, "min_tangential_velocity_km_s": round(vmin, 0),
                                           "limit_km_s": V_GALACTIC_MAX}
                    return {"label": "transient-or-moving-candidate", "evidence": ev,
                            "text": (f"Moves {mu:.1f} arcsec per year in a straight line, which no known kind of object "
                                     f"does: without the parallax of a Solar System body (at least {pi_min:.0f} arcsec) it "
                                     f"would be a star moving faster than {vmin:.0f} km/s, above the escape speed of the "
                                     "Galaxy. Measured, but not explained: it stays a candidate and is never confirmed here.")}
                sc = ev.get("sed_class")
                dist = (f"about {ev['distance_pc']:.1f} parsec away" if ev.get("distance_pc")
                        else f"farther than {ev['distance_pc_min']:.0f} parsec" if ev.get("distance_pc_min") else "far away")
                known = (f" Gaia DR3 {g16['source_id']} lies where it was in 2016: probably that star, whose motion Gaia "
                         "did not measure." if g16 else " There is no Gaia source on its path.")
                return {"label": "nearby-star-or-brown-dwarf-candidate", "evidence": ev,
                        "text": (f"Moves {mu:.2f} arcsec per year and is {dist}: outside the Solar System (a body bound to "
                                 f"the Sun with this motion would be closer than {d_max:.0f} AU and swing by at least "
                                 f"{2 * pi_min:.0f} arcsec between seasons; it does not)."
                                 + (" Seen at 4-5 micron only: a very cold brown dwarf candidate." if sc == "red-only"
                                    else " Its light rises towards 4-5 micron, as that of cool and brown dwarfs does."
                                    if sc == "red" else " A nearby star or brown dwarf candidate.") + known)}
            if p > 0 and p >= 3 * ep:
                d_au = AU_ARCSEC / p
                ev["distance_au"] = round(d_au, 0)
                return {"label": "distant-solar-system-candidate", "evidence": ev,
                        "text": (f"Moves {mu:.3f} arcsec per year with a parallax of {p:.2f} arcsec: a distance of about "
                                 f"{d_au:.0f} AU, where an orbit around the Sun is possible. A candidate for follow-up.")}
        bo["bound_to_sun_possible"] = bo.get("bound_to_sun_possible")
        if mu > 15.0 and not px:
            ev["note"] = "faster than any known star (Barnard's Star: 10.4 arcsec/yr) and no parallax information"
        return {"label": "transient-or-moving-candidate", "evidence": ev,
                "text": (f"Moves {mu:.2f} arcsec per year. Its parallax is not measured (seasons at one side of the Earth's "
                         f"orbit only, or too few): it can be a nearby star or brown dwarf, or, if it swings by more than "
                         f"{2 * pi_min:.0f} arcsec between seasons half a year apart, a body bound to the Sun closer than "
                         f"{d_max:.0f} AU.")}
    if c["kind"] == "variable" or (c["kind"] in ("appearing", "disappearing") and g):
        b = c.get("brightness") or {}
        ev["variability"] = {"max_change_frac": b.get("max_change_frac"), "max_sigma": b.get("max_sigma")}
        fr = b.get("max_change_frac")
        how = (f"by {abs(100 * fr):.0f} %" if fr is not None else "strongly")
        what = "became fainter" if (b.get("max_sigma") or 0) < 0 else "became brighter"
        who = ("A catalogued star (Gaia DR3 " + str(g.get("source_id")) + ") that ") if g else "A source that "
        cc = b.get("colour_change")
        if cc:
            ev["variability"]["colour_change"] = cc
            return {"label": "variable-star-candidate", "evidence": ev,
                    "text": who + f"changed colour between seasons: brighter at {_um(cc['brighter_in'])} micron and fainter "
                            f"at {_um(cc['fainter_in'])} micron (up to {abs(100 * fr):.0f} % in one detector). A grey "
                            "change cannot do this; dust or a temperature change can: a variable star candidate."}
        return {"label": "variable-star-candidate", "evidence": ev,
                "text": who + f"{what} {how} between seasons, in several detectors at once: a variable star candidate."}
    if c["kind"] in ("appearing", "disappearing"):
        return {"label": "transient-or-moving-candidate", "evidence": ev,
                "text": ("A source that is there in one season and not in another, with no catalogued star at the "
                         "position: something that moved away or changed strongly. Its nature is open.")}
    if c["kind"] == "transient":
        vt = c.get("vetting") or {}
        vis, st = vt.get("visit") or {}, vt.get("steady_source") or {}
        # exposures that show it: its own detections, or the forced photometry of the visit (vet.py)
        nexp = max(len({d.get("file") for d in c.get("detections") or []}),
                   1 + int(vis.get("seen_in") or 0) if vis.get("verdict") == "confirmed" else 0)
        ev["n_exposures"] = nexp
        ev["rate_arcsec_per_hour"] = c.get("rate_arcsec_per_hour")
        if vt:
            ev["vetting"] = vt
        sso = (c.get("match") or {}).get("sso")
        if c["class"] == "asteroid-known" and sso:
            ev.setdefault("catalogue", {})["sso"] = sso
            return {"label": "solar-system-known", "evidence": ev,
                    "text": f"The known asteroid {(str(sso.get('number') or '') + ' ' + str(sso.get('name') or '')).strip()}, "
                            "at its predicted position at the time of the exposure."}
        if nexp >= 2 and st.get("verdict") == "excess":
            name = str(st.get("source") or "")
            name = ("Gaia DR3 " + name[1:]) if name[:1] == "G" and name[1:].isdigit() else "a steady source"
            f1, f0 = st.get("flux_ujy"), st.get("same_wavelength_other_visits_ujy")
            times = f"{f1 / f0:.1f} times brighter" if f1 and f0 and f0 > 0 else "brighter"
            return {"label": "transient-or-moving-candidate", "evidence": ev,
                    "text": (f"{name[0].upper() + name[1:]} was {times} at {st.get('wavelength_um', 0):.2f} micron in one visit "
                             f"({nexp} exposures minutes apart) than at the same wavelength in the other visits: a flare, "
                             "or an object passing in front of it. Its nature is open.")}
        if nexp >= 2:
            return {"label": "solar-system-candidate", "evidence": ev,
                    "text": ("Seen in two or more exposures of one visit and gone afterwards, not at a catalogued "
                             "position: a moving Solar System object candidate (not matched to a known asteroid).")}
        return {"label": "single-exposure-event", "evidence": ev,
                "text": "Seen in a single exposure and could not be checked in another one: unconfirmed."}
    return {"label": "transient-or-moving-candidate", "evidence": ev, "text": "A changing source; its nature is open."}


DET_UM = {"D1": (0.75, 1.1), "D2": (1.1, 1.6), "D3": (1.6, 2.4), "D4": (2.4, 3.8), "D5": (3.8, 4.4), "D6": (4.4, 5.0)}


def _um(dets):
    """Wavelength range (micron) of a list of detectors, e.g. ['D5', 'D6'] -> '3.8-5.0'."""
    r = [DET_UM[d] for d in dets if d in DET_UM]
    return f"{min(a for a, _ in r):g}-{max(b for _, b in r):g}" if r else "?"


# ------------------------------------------------------------------------------------ confidence
def _p_gauss(z):
    return float(2 * norm.sf(max(z, 0.0)))


def null_inflation():
    """K: how much heavier than Gaussian the 5 sigma tail may be without the null test having
    seen it (95 % upper limit of the false-mover rate per source over the Gaussian rate)."""
    ul = (NULL_TEST["false_movers"] + 3.0) / max(NULL_TEST["source_trials"], 1)
    return max(1.0, ul / _p_gauss(5.0)), ul


def n_tested(ctx):
    n = 0
    for d in ("B", "D"):
        n += int(((ctx.info.get(d) or {}).get("counts") or {}).get("measured") or 0)
    return max(n, 1)


def confidence(ctx, c):
    mo = c.get("motion") or {}
    g = (c.get("match") or {}).get("gaia_dr3") or {}
    if c["class"] == "artifact":
        return {"percent": None, "basis": "not-calibrated", "sentence": "Rejected by the checks.", "how": ""}
    if c["class"] == "gaia-known" and mo and g.get("pmra_mas_yr") is not None and g.get("pmdec_mas_yr") is not None:
        gm = math.hypot(g["pmra_mas_yr"], g["pmdec_mas_yr"])
        dv = math.hypot(mo["pmra_mas_yr"] - g["pmra_mas_yr"], mo["pmdec_mas_yr"] - g["pmdec_mas_yr"])
        pct = max(0.0, 100.0 * (1 - dv / gm)) if gm > 0 else None
        dsig = mo.get("deviation_from_gaia_sigma")
        if dsig is None:
            e = math.hypot(mo["err_pmra_mas_yr"], mo["err_pmdec_mas_yr"]) / math.sqrt(2)
            dsig = round(dv / e, 1) if e > 0 else None
        return {"percent": None if pct is None else round(pct, 2), "basis": "gaia-agreement",
                "gaia_difference_sigma": dsig, "gaia_difference_percent": None if pct is None else round(100 - pct, 2),
                "sentence": (f"Measured {mo['speed_arcsec_yr']:.3f} arcsec per year; the Gaia catalogue says {gm / 1000:.3f}. "
                             f"The two agree to {pct:.1f} % ({dsig} sigma apart)." if pct is not None else ""),
                "how": "100 x (1 - |measured - Gaia| / |Gaia|) of the proper-motion vectors; sigma = difference over the "
                       "calibrated measurement error"}
    if c["kind"] == "motion" and mo and mo.get("significance_sigma") is not None:
        z = float(mo["significance_sigma"])
        K, ul = null_inflation()
        n = n_tested(ctx)
        fap = min(1.0, n * _p_gauss(z) * K)
        pct = 100.0 * (1 - fap)
        one_in = None if fap <= 0 else 1.0 / fap
        many = "more than a million" if one_in is None or one_in > 1e6 else f"{one_in:,.0f}"
        near = ("" if z >= CONFIRM_SIGMA else " It is close to the detection threshold, where rare systematic errors that a "
                "shuffle test cannot show are not excluded.")
        return {"percent": round(min(pct, 99.9999), 4), "basis": "null-calibrated", "false_alarm_probability": float(f"{fap:.3g}"),
                "sentence": (f"A motion signal this strong ({z:.1f} sigma) would appear by chance in about 1 of {many} fields "
                             "like this one that hold no moving object." + near),
                "how": (f"FAP = N x p(z) x K: N = {n} sources tested here, p = Gaussian tail of the calibrated significance "
                        f"(errors from residual permutation), K = {K:.0f} = what the date-shuffle null test "
                        f"({NULL_TEST['false_movers']} false movers in {NULL_TEST['source_trials']} source trials) cannot yet exclude")}
    if c["class"] == "asteroid-known":
        sso = (c.get("match") or {}).get("sso") or {}
        return {"percent": None, "basis": "catalogue-match",
                "sentence": (f"Matches the predicted position of a known asteroid within {sso.get('sep_arcsec')} arcsec."
                             if sso.get("sep_arcsec") is not None else "Matches a known asteroid."),
                "how": "IMCCE SkyBoT ephemeris at the exposure time, moved to the spacecraft position"}
    b = c.get("brightness") or {}
    if b.get("max_sigma") is not None:
        return {"percent": None, "basis": "not-calibrated",
                "sentence": ((f"Colour change: {abs(b['max_sigma']):.1f} sigma in the strongest detector, and at least one "
                              "more detector at 5 sigma or more in the other direction."
                              if b.get("colour_change") else
                              f"Brightness change of {abs(b['max_sigma']):.1f} sigma with all detectors combined.")
                             + " No null test exists yet for brightness changes, so no percentage is given."),
                "how": ("per-detector fractional changes with the field's own season-to-season floor (variab.py)"
                        if b.get("colour_change") else
                        "inverse-variance combination of the per-detector fractional changes (variab.py)")}
    return {"percent": None, "basis": "not-calibrated", "sentence": "No calibrated confidence for this kind of record.",
            "how": ""}


# ------------------------------------------------------------------------------------ confirmed
def _flag_sigma(flags, pattern):
    for f in flags:
        m = re.search(pattern, f)
        if m:
            return float(m.group(1))
    return None


def confirm(ctx, c):
    """Rule confirm-v1. A record is confirmed only when every 'must' check passes and at least
    CONFIRM_MIN_INDEPENDENT independent confirmations hold. Motion:
      must   calibrated significance >= 7 sigma; confidence percent >= 99.9; no caution (not a
             blend, not in the wings of a saturated star); for catalogued movers
             |measured - Gaia| <= 3 sigma; physically possible (nature(): not faster than the
             Galactic escape speed without the parallax of a Solar System body)
      independent confirmations (>= 2 needed)
             same-orientation season pair shows the motion at >= 3 sigma
             wavelength: the short (D1-D3) and long (D4-D6) halves each show it at >= 3 sigma and
             agree, or >= 2 single detectors each show it at >= 3 sigma and agree
             seasons: >= 3 seasons fit the adopted motion model (probability >= 0.01)
             methods: found by the difference images (A) AND by the astrometry (B or D)
    Variables: >= 7 sigma combined, >= 3 detectors agree, >= 5 sigma without the best detector,
    seen in a same-orientation pair, no caution, AND a null test that calibrates their false-alarm
    rate (VARIABLE_NULL_TEST: none yet, so brightness changes stay candidates). Asteroids: ephemeris match within 2 native
    pixels in >= 2 exposures."""
    checks, flags = [], c.get("flags") or []
    txt = " | ".join(flags).lower()

    def add(name, ok, value=None, need=None, independent=False):
        checks.append({"name": name, "pass": bool(ok), "value": value, "need": need, "independent": independent})
    if c["class"] == "artifact":
        return False, {"rule": RULE, "checks": [], "n_independent": 0, "sentence": "Rejected by the checks."}
    mo, ck = c.get("motion"), c.get("checks") or {}
    conf = c.get("confidence") or {}
    caution = any(k in txt for k in ("blend", "wings of a saturated", "no same-orientation", EDGE_FLAG))
    if c["kind"] == "motion" and mo:
        z = mo.get("significance_sigma") or 0.0
        add("significance", z >= CONFIRM_SIGMA, z, f">= {CONFIRM_SIGMA} sigma")
        if c["class"] == "gaia-known":
            d = conf.get("gaia_difference_sigma")
            add("agrees with Gaia", d is not None and d <= 3.0, d, "<= 3 sigma")
        else:
            p = conf.get("percent")
            add("false-alarm probability", p is not None and p >= CONFIRM_PERCENT, p, f">= {CONFIRM_PERCENT} %")
        add("no caution", not caution, None, "not blended, not next to a saturated star")
        phys = ((c.get("nature") or {}).get("evidence") or {}).get("physical_test")
        add("physically possible", not (phys and phys.get("passes") is False), phys,
            "a star bound to the Galaxy or a body bound to the Sun can move like this")
        so = ck.get("same_orientation_sigma")
        if so is None:
            so = _flag_sigma(flags, r"confirmed by same-orientation seasons \(([\d.]+) sigma\)")
        add("same-orientation seasons", so is not None and so >= 3.0, so, ">= 3 sigma", independent=True)
        hv = ck.get("halves") or {}
        votes = ck.get("detector_votes") or {}
        nvote = sum(1 for v in votes.values() if v.get("sigma", 0) >= 3.0 and v.get("agrees"))
        halves_ok = len(hv) == 2 and all(h.get("sigma", 0) >= 3.0 and h.get("agrees") for h in hv.values())
        add("wavelength", halves_ok or nvote >= 2, {"halves": hv, "detectors_at_3_sigma": nvote},
            "both wavelength halves, or >= 2 single detectors, at >= 3 sigma and in agreement", independent=True)
        fit = c.get("fit") or {}
        ns, pl = fit.get("n_seasons") or len(c.get("positions") or []), fit.get("p_linear")
        add("seasons", ns >= 3 and (pl is None or pl >= 0.01), {"n_seasons": ns, "model_probability": pl},
            ">= 3 seasons fitting the motion model", independent=True)
        dets = set(c.get("detectors") or [])
        add("two methods", "A" in dets and bool(dets & {"B", "D"}), sorted(dets), "difference images and astrometry",
            independent=True)
        # A source that is not in the catalogue and moved by LIGHT_MOVED_ARCSEC or more between two seasons has
        # changed the images themselves: the difference images show it (detector A), or the light at its first
        # and last position changed as a moved source must (deep_astrom.static_scene). Position fits alone do
        # not confirm such a displacement: two static sources that share their light differently from season
        # to season give the same fits (job field-326.640n23.090, 14 Nov 2026).
        ts = [p.get("jyear") for p in c.get("positions") or [] if p.get("jyear") is not None]
        disp = (mo.get("displacement") or {}).get("arcsec")
        if disp is None:
            disp = (mo.get("speed_arcsec_yr") or 0.0) * ((max(ts) - min(ts)) if len(ts) >= 2 else 0.0)
        sc = ck.get("static_scene") or {}
        if c["class"] != "gaia-known" and (disp >= LIGHT_MOVED_ARCSEC or sc.get("static")):
            add("the light moved", "A" in dets or bool(sc.get("moved")),
                {"displacement_arcsec": round(float(disp), 2), "detectors": sorted(dets), "static_scene": sc or None},
                f"a displacement of {LIGHT_MOVED_ARCSEC:g} arcsec or more is seen in the difference images, or the light "
                "at the first and the last position changed as it must")
    elif c["kind"] in ("variable", "appearing", "disappearing") and c.get("brightness"):
        comb = c["brightness"].get("combined") or []
        best = max(comb, key=lambda h: abs(h.get("sigma") or 0)) if comb else {}
        add("significance", abs(best.get("sigma") or 0) >= CONFIRM_SIGMA, best.get("sigma"), f">= {CONFIRM_SIGMA} sigma")
        add("no caution", not caution, None, "not blended, not next to a saturated star")
        add("null test", VARIABLE_NULL_TEST is not None, VARIABLE_NULL_TEST,
            "a null test that calibrates the false-alarm rate of brightness changes")
        add("detectors agree", (best.get("n_detectors_agree") or 0) >= 3, best.get("n_detectors_agree"), ">= 3",
            independent=True)
        add("without the best detector", (best.get("sigma_without_best_detector") or 0) >= 5.0,
            best.get("sigma_without_best_detector"), ">= 5 sigma", independent=True)
        same = [h for h in comb if h.get("same_orientation") and abs(h.get("sigma") or 0) >= 5.0]
        add("same-orientation seasons", bool(same), len(same), ">= 1 pair at >= 5 sigma", independent=True)
    elif c["class"] == "asteroid-known":
        sso = (c.get("match") or {}).get("sso") or {}
        nexp = len({d.get("file") for d in c.get("detections") or []})
        add("ephemeris match", sso.get("sep_px") is not None and sso["sep_px"] <= 2.0, sso.get("sep_px"), "<= 2 native pixels")
        add("exposures", nexp >= 2, nexp, ">= 2", independent=True)
        add("visit", nexp >= 2, nexp, ">= 2", independent=True)
    else:
        return False, {"rule": RULE, "checks": [], "n_independent": 0, "sentence": "This kind of record is never confirmed."}
    must = [k for k in checks if not k["independent"]]
    ind = [k for k in checks if k["independent"]]
    n_ind = sum(k["pass"] for k in ind)
    ok = all(k["pass"] for k in must) and n_ind >= (len(ind) if c["kind"] != "motion" and c["class"] != "asteroid-known"
                                                    else CONFIRM_MIN_INDEPENDENT)
    failed = [k["name"] for k in checks if not k["pass"]]
    sent = (f"Confirmed: passes {len(must)} required checks and {n_ind} of {len(ind)} independent confirmations." if ok else
            "Not confirmed (stays a candidate): " + (", ".join(failed) if failed else "too few independent confirmations") + ".")
    return bool(ok), {"rule": RULE, "checks": checks, "n_independent": int(n_ind), "sentence": sent}


def annotate(ctx, cands):
    for c in cands:
        if c.get("nature") and c.get("confirmation") and "P" in (c.get("detectors") or []):
            continue                                     # detector P decides for its own records (rule distant-v1)
        qr, qc = (ctx.opts or {}).get("quick_radius"), (ctx.opts or {}).get("centre")
        if qr is not None and qc and c["class"] != "artifact" and SC.sep_arcsec(qc[0], qc[1], c["ra"], c["dec"]) > qr \
                and not any(f.startswith(EDGE_FLAG) for f in c["flags"]):
            c["flags"].append(EDGE_FLAG + ": its stamps are cut in some exposures; the full stage measures it again")
        try:
            c["nature"] = nature(ctx, c)
            if c["nature"]["label"] == "artifact" and c["class"] != "artifact":
                c["flags"].append("not physical: " + c["nature"]["text"])
                c["class"] = "artifact"
            c["confidence"] = confidence(ctx, c)
            c["confirmed"], c["confirmation"] = confirm(ctx, c)
            for k in NATURE_KEYS:                        # the same keys in every record, null when not applicable
                c["nature"].setdefault(k, None)
            for k in CONFIDENCE_KEYS:
                c["confidence"].setdefault(k, None)
        except Exception as ex:                          # never lose a record over its description
            c.setdefault("nature", {"label": None, "text": "", "evidence": {}})
            c.setdefault("confidence", {"percent": None, "basis": "not-calibrated", "sentence": "", "how": ""})
            c["confirmed"] = False
            c["confirmation"] = {"rule": RULE, "checks": [], "n_independent": 0, "sentence": f"not evaluated ({type(ex).__name__}: {ex})"}
    return cands


# ------------------------------------------------------------------------------------ verdict
def _compass(pa):
    return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][int(((pa % 360) + 22.5) // 45) % 8]


def limit_of(ctx):
    """{speed_arcsec_yr, mag_ab}: the slowest motion that would have been seen for a source of
    that brightness (sensitivity card; AB 16 when available, else the faintest row with a value)."""
    rows = [r for r in ((getattr(ctx, "sensitivity", None) or {}).get("motion") or []) if r.get("min_speed_arcsec_yr")]
    if not rows:
        return None
    r = next((r for r in rows if r["mag_ab"] == 16), None) or max(rows, key=lambda r: r["mag_ab"])
    return {"speed_arcsec_yr": r["min_speed_arcsec_yr"], "mag_ab": r["mag_ab"]}


def mover_sentence(c):
    mo = c["motion"]
    d = mo.get("displacement")
    lab = (c.get("nature") or {}).get("label")
    what = LABEL_TEXT.get(lab, "a moving source")
    g = (c.get("match") or {}).get("gaia_dr3")
    if lab == "catalogued-star" and g:
        what += f" (Gaia DR3 {g.get('source_id')})"
    if d and d.get("arcsec"):
        move = (f"Moved {d['arcsec']:.2f} arcsec in {d['dt_yr']:.2f} years towards the {_compass(d['pa_deg'])} "
                f"({mo['speed_arcsec_yr']:.2f} arcsec per year)")
    else:
        move = f"Moves {mo['speed_arcsec_yr']:.2f} arcsec per year towards the {_compass(mo['pa_deg'])}"
    pct = (c.get("confidence") or {}).get("percent")
    basis = (c.get("confidence") or {}).get("basis")
    if c.get("confirmed"):
        sure = ""
        if pct is not None:
            sure = (f", agreement with Gaia {pct:.1f} %" if basis == "gaia-agreement"
                    else ", more than 99.99 % sure" if pct > 99.99 else f", {pct:.2f} % sure")
        return f"{move}: {what}; confirmed{sure}."
    return f"{move}: {what}; a candidate, not confirmed yet ({_why_not(c)})."


WHY_NOT = {"significance": f"the signal is below {CONFIRM_SIGMA:g} sigma",
           "false-alarm probability": "a chance alarm is not excluded at the 0.1 % level",
           "no caution": "blended, next to a saturated star or at the edge of the box",
           "agrees with Gaia": "the motion differs from the Gaia catalogue by more than 3 sigma",
           "physically possible": "no star bound to the Galaxy and no body bound to the Sun moves like this",
           "the light moved": "the images do not show that the light left the first position and arrived at the last",
           "null test": "no null test exists yet for brightness changes"}


def _why_not(c):
    """Plain reason why a record is not confirmed (rule confirm-v1)."""
    cf = c.get("confirmation") or {}
    must = [k for k in cf.get("checks") or [] if not k.get("independent") and not k.get("pass")]
    why = [WHY_NOT.get(k["name"], k["name"]) for k in must]
    ind = [k for k in cf.get("checks") or [] if k.get("independent")]
    if ind and sum(bool(k.get("pass")) for k in ind) < CONFIRM_MIN_INDEPENDENT:
        why.append(f"fewer than {CONFIRM_MIN_INDEPENDENT} independent confirmations")
    return "; ".join(why) if why else "the checks are incomplete"


def verdict(ctx, cands, stage="full", centre=None, radius=20.0, unchecked=0):
    """One line for a person. centre = (ra, dec) of the clicked point: a mover within radius
    arcsec of it leads the sentence; else the most significant mover; else the limit.
    unchecked: number of position changes that were measured but could not be checked against
    the star catalogue (run.find, catalogue unreachable): then no limit is claimed."""
    movers = [c for c in cands if c["kind"] == "motion" and c.get("motion") and c["class"] in ("candidate", "gaia-known")]
    variables = [c for c in cands if c["class"] == "variable"]
    lim = limit_of(ctx)
    best, away = None, None
    if movers:
        if centre:
            near = [c for c in movers if SC.sep_arcsec(centre[0], centre[1], c["ra"], c["dec"]) <= radius]
            if near:
                best = max(near, key=lambda c: c["motion"].get("significance_sigma") or 0)
        if best is None:
            best = max(movers, key=lambda c: (bool(c.get("confirmed")), c["motion"].get("significance_sigma") or 0))
            if centre and stage == "quick":
                away = SC.sep_arcsec(centre[0], centre[1], best["ra"], best["dec"])
    if best is not None:
        text = mover_sentence(best)
        if away is not None:
            text = f"Nothing moving at the chosen point itself, but {away:.0f} arcsec from it: " + text[0].lower() + text[1:]
        if len(movers) > 1:
            text += f" {len(movers) - 1} more moving source(s) in this field."
    elif unchecked:
        text = (f"No moving object is reported here: the Gaia star catalogue could not be reached in this run, and "
                f"without it the {unchecked} position change(s) that were measured cannot be told from known stars or "
                "from two known stars seen as one. Run this field again.")
    elif lim:
        text = (f"Nothing moving found here: a source brighter than AB {lim['mag_ab']} moving faster than "
                f"{lim['speed_arcsec_yr']:.2f} arcsec per year would have been seen.")
    else:
        text = "Nothing moving found here."
    if variables:
        text += f" {len(variables)} source(s) changed brightness."
    si = ctx.season_info
    ts = [v["jyear"] for v in si.values()]
    if len(ts) >= 2:
        text += f" ({len(ts)} seasons over {max(ts) - min(ts):.1f} years, {len(ctx.exps)} exposures.)"
    return {"text": text, "stage": stage, "n_confirmed": sum(bool(c.get("confirmed")) for c in cands),
            "best": None if best is None else best.get("id"),
            "best_offset_arcsec": None if away is None else round(away, 1), "limit": lim}
