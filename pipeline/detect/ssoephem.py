"""Known solar-system objects in a SPHEREx field, as seen from SPHEREx.

IMCCE SkyBoT cone search (https://ssp.imcce.fr/webservices/skybot/), output 'obs': name,
number, class, astrometric J2000 RA/Dec (geocentre, light-time corrected), V, position
uncertainty, rates (dRA*cos(Dec), dDec in arcsec/h), geocentric and heliocentric distances,
phase angle, solar elongation. Fallback: JPL SB-Ident (https://ssd-api.jpl.nasa.gov/sb_ident.api),
geocentric too.

SPHEREx is in low Earth orbit (~7000 km from the geocentre). The parallax between the geocentre
and the spacecraft is 7000 km / distance: ~4" for a main-belt asteroid at 2.5 AU, ~10" at 1 AU.
topocentric() moves every geocentric position to the spacecraft position given in the exposure
header (X_SC, Y_SC, Z_SC at mid-exposure, km, geocentric equatorial), using the object's
geocentric distance: direction(dg * u - r_sc).

Queries are small (one cone per field or per extra visit), cached on disk (cache/asteroids/skybot/,
one JSON per query: the parsed numbers and short strings only, never the raw response), and at
most one request every MIN_INTERVAL seconds. User-Agent fazari-spaceapps/1.0, no personal data.
"""
import hashlib
import json
import math
import time
import urllib.parse
import urllib.request

import numpy as np

from . import s3box as S3

SKYBOT = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
SBIDENT = "https://ssd-api.jpl.nasa.gov/sb_ident.api"
UA = "fazari-spaceapps/1.0"
CACHE = S3.CACHE / "skybot"
MIN_INTERVAL = 2.0
PATIENCE_S = 1800
AU_KM = 149597870.7
BYTES = {"net": 0, "queries": 0}
_last = [0.0]


def _sexa(s, hours):
    s = str(s).strip()
    p = [float(v) for v in s.replace(":", " ").split()]
    v = abs(p[0]) + (p[1] if len(p) > 1 else 0) / 60 + (p[2] if len(p) > 2 else 0) / 3600
    return (-1 if s.startswith("-") else 1) * v * (15.0 if hours else 1.0)


def _num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def _get(url, timeout=120):
    wait = MIN_INTERVAL - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    raw = None
    t0, pause = time.time(), 5.0
    while time.time() - t0 < PATIENCE_S:        # network down / service busy: keep waiting (30 min)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read(20_000_000)
            break
        except Exception as ex:
            code = getattr(ex, "code", None)
            if code is not None and code not in (429, 500, 502, 503, 504):
                break
            print(f"  ephemeris service error {type(ex).__name__}; retry in {pause:.0f} s", flush=True)
            time.sleep(pause)
            pause = min(2 * pause, 120)
    _last[0] = time.time()
    if raw is not None:
        BYTES["net"] += len(raw)
        BYTES["queries"] += 1
    return raw


def h_mag(v, dh, dg, phase_deg, G=0.15):
    """Absolute magnitude H from the predicted V (H-G system, G = 0.15 as SkyBoT assumes)."""
    if None in (v, dh, dg, phase_deg) or dh <= 0 or dg <= 0:
        return None
    a = math.radians(phase_deg)
    t = math.tan(a / 2)
    phi1 = math.exp(-3.33 * t ** 0.63)
    phi2 = math.exp(-1.87 * t ** 1.22)
    return v - 5 * math.log10(dh * dg) + 2.5 * math.log10((1 - G) * phi1 + G * phi2)


def cone(mjd, ra, dec, radius_deg, offline=False):
    """Known SSOs within radius_deg of (ra, dec) at UTC time mjd (geocentric). List of dicts:
    name, number, cls, ra, dec, vmag, err_arcsec, dra_cosd_h, ddec_h (arcsec/h), dg, dh (AU),
    phase_deg, elong_deg, H. None if both services failed. Cached per query."""
    jd = float(mjd) + 2400000.5
    q = {"-ep": f"{jd:.6f}", "-ra": f"{ra:.5f}", "-dec": f"{dec:.5f}", "-rd": f"{radius_deg:.4f}",
         "-mime": "json", "-output": "obs", "-loc": "500", "-filter": "0", "-objFilter": "111",
         "-refsys": "EQJ2000", "-from": "fazari"}
    key = hashlib.sha1(json.dumps(q, sort_keys=True).encode()).hexdigest()[:20]
    path = CACHE / f"{key}.json"
    if path.exists():
        try:
            c = json.loads(path.read_text())
            # an empty answer of a few bytes is a SkyBoT error message cached by an older version: ask again
            if c["objects"] or (c.get("raw_bytes") or 0) > 1000 or c.get("note") == "empty":
                return c["objects"]
        except (ValueError, KeyError):
            pass
    if offline:
        return None
    raw = _get(SKYBOT + "?" + urllib.parse.urlencode(q))
    objs, source = None, "skybot"
    note = None
    data = _parse(raw)
    if data is None and q["-objFilter"] == "111":
        # SkyBoT fails when a planet's satellites are in the cone (seen with Saturn): retry asteroids + comets
        q2 = dict(q, **{"-objFilter": "101"})
        raw = _get(SKYBOT + "?" + urllib.parse.urlencode(q2))
        data = _parse(raw)
        note = "planets and satellites excluded (SkyBoT satellite ephemeris error)"
    if data is not None:
        if True:
            objs = []
            for o in data:
                try:
                    d = {"name": str(o.get("Name", ""))[:40], "number": str(o.get("Num", "") or "")[:12],
                         "cls": str(o.get("Class", ""))[:24],
                         "ra": _sexa(o["RA (hms)"], True), "dec": _sexa(o["DEC (dms)"], False),
                         "vmag": _num(o.get("VMag (mag)")), "err_arcsec": _num(o.get("Err (arcsec)")),
                         "dra_cosd_h": _num(o.get("dRA (arcsec/h)")), "ddec_h": _num(o.get("dDEC (arcsec/h)")),
                         "dg": _num(o.get("dg (ua)")), "dh": _num(o.get("dh (ua)")),
                         "phase_deg": _num(o.get("Phase (deg)")), "elong_deg": _num(o.get("SunElong (deg)"))}
                except (KeyError, ValueError, TypeError, IndexError, AttributeError):
                    continue
                d["H"] = h_mag(d["vmag"], d["dh"], d["dg"], d["phase_deg"])
                objs.append(d)
    if objs is None:
        objs, source = sbident(mjd, ra, dec, radius_deg), "jpl-sbident"
    if objs is None:
        return None
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"query": q, "source": source, "raw_bytes": len(raw) if raw is not None else None,
                                "note": note or ("empty" if not objs else None),
                                "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "objects": objs}))
    return objs


def _parse(raw):
    """SkyBoT JSON answer -> list of rows, [] for 'no object', None for an error answer."""
    if raw is None:
        return None
    txt = raw.decode("utf-8", "replace").lstrip()
    if txt[:1] not in "[{":
        return None
    try:
        data = json.loads(txt)
    except ValueError:
        return None
    if isinstance(data, dict):
        if data.get("data"):
            return data["data"]
        msg = str(data.get("message", ""))
        if data.get("flag") == 0 or "no solar system object" in msg.lower():
            return []
        return None
    return data if isinstance(data, list) else None


def sbident(mjd, ra, dec, radius_deg):
    """Fallback: JPL SB-Ident, geocentric, square field of half-width radius_deg. Fewer columns
    (no distances): the parallax correction then uses 2.5 AU and is flagged by dg=None."""
    jd = float(mjd) + 2400000.5
    q = {"sb-kind": "a", "mpc-code": "500", "obs-time": f"{jd:.6f}", "two-pass": "true", "suppress-first-pass": "true",
         "fov-ra-center": f"{ra:.5f}", "fov-dec-center": f"{dec:.5f}",
         "fov-ra-hwidth": f"{radius_deg:.4f}", "fov-dec-hwidth": f"{radius_deg:.4f}"}
    raw = _get(SBIDENT + "?" + urllib.parse.urlencode(q))
    if raw is None:
        return None
    try:
        d = json.loads(raw.decode("utf-8", "replace"))
        fields = d.get("fields_second") or d.get("fields_first") or []
        rows = d.get("data_second_pass") or d.get("data_first_pass") or []
    except (ValueError, AttributeError):
        return None
    col = {f: i for i, f in enumerate(fields)}
    out = []
    for r in rows:
        try:
            name = str(r[col["Object name"]])[:40]
            num = name.split()[0] if name[:1].isdigit() else ""
            ra_s = r[col["Astrometric RA (hh:mm:ss)"]]
            de_s = r[col["Astrometric Dec (dd mm'ss\")"]].replace("'", " ").replace('"', " ")
            v = _num(r[col["Visual magnitude (V)"]]) if "Visual magnitude (V)" in col else None
            out.append({"name": name, "number": num, "cls": "", "ra": _sexa(ra_s, True), "dec": _sexa(de_s, False),
                        "vmag": v, "err_arcsec": None,
                        "dra_cosd_h": _num(r[col["RA rate (\"/h)"]]) if "RA rate (\"/h)" in col else None,
                        "ddec_h": _num(r[col["Dec rate (\"/h)"]]) if "Dec rate (\"/h)" in col else None,
                        "dg": None, "dh": None, "phase_deg": None, "elong_deg": None, "H": None})
        except (KeyError, ValueError, TypeError, IndexError):
            continue
    return out


def at_time(o, mjd0, mjd):
    """Geocentric position of object o (from a cone at mjd0) moved linearly to mjd with its rates."""
    dt_h = (mjd - mjd0) * 24.0
    dra = (o.get("dra_cosd_h") or 0.0) * dt_h / 3600.0
    ddec = (o.get("ddec_h") or 0.0) * dt_h / 3600.0
    dec = o["dec"] + ddec
    ra = o["ra"] + dra / max(1e-6, math.cos(math.radians(0.5 * (o["dec"] + dec))))
    return ra % 360.0, dec


def topocentric(ra, dec, dg_au, sc_km):
    """Geocentric astrometric direction (deg) at distance dg_au -> direction from the spacecraft
    at geocentric equatorial position sc_km. Returns (ra, dec) arrays."""
    ra = np.radians(np.atleast_1d(np.asarray(ra, float)))
    dec = np.radians(np.atleast_1d(np.asarray(dec, float)))
    dg = np.atleast_1d(np.asarray([2.5 if d is None else d for d in np.atleast_1d(dg_au)], float))
    u = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], -1) * dg[:, None]
    v = u - np.asarray(sc_km, float)[None, :] / AU_KM
    r = np.degrees(np.arctan2(v[:, 1], v[:, 0])) % 360.0
    d = np.degrees(np.arcsin(v[:, 2] / np.linalg.norm(v, axis=1)))
    return r, d
