"""Known solar-system objects: IMCCE SkyBoT cone search (https://ssp.imcce.fr/webservices/skybot/).

Small queries only (one cone per transient or per visit), cached on disk (cache/skybot/, one
JSON file per query), at most one request every MIN_INTERVAL seconds. Positions are geocentric
astrometric J2000 at the exposure mid-time; SPHEREx is in low Earth orbit, so a main-belt
asteroid can sit up to ~10" from its geocentric position (MATCH_ARCSEC allows for that).
Responses are untrusted: only numbers and short strings are taken from them.
"""
import hashlib
import math
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

import blink as BL
from . import schema as SC

URL = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
CACHE = Path(os.environ.get("FAZARI_SKYBOT_CACHE") or (BL.ROOT / "cache" / "skybot"))
MIN_INTERVAL = 1.5
MATCH_ARCSEC = 20.0
_last = [0.0]


def _parse_sexa(s, hours):
    s = str(s).strip()
    p = [float(v) for v in s.replace(":", " ").split()]
    v = abs(p[0]) + p[1] / 60 + p[2] / 3600
    return (-1 if s.startswith("-") else 1) * v * (15.0 if hours else 1.0)


def cone(ra, dec, mjd, radius_deg, offline=False):
    """Known SSOs within radius_deg of (ra, dec) at time mjd: list of dicts
    {name, number, cls, ra, dec, vmag, err_arcsec}; None if the service failed."""
    jd = round(float(mjd) + 2400000.5, 5)
    q = {"-ep": f"{jd:.5f}", "-ra": f"{ra:.5f}", "-dec": f"{dec:.5f}", "-rd": f"{radius_deg:.4f}", "-mime": "json",
         "-output": "object", "-loc": "500", "-filter": "0", "-objFilter": "111", "-refsys": "EQJ2000",
         "-from": "fazari"}
    key = hashlib.sha1(json.dumps(q, sort_keys=True).encode()).hexdigest()[:20]
    path = CACHE / f"{key}.json"
    if path.exists():
        try:
            return json.loads(path.read_text())["objects"]
        except (ValueError, KeyError):
            pass
    if offline:
        return None
    wait = MIN_INTERVAL - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(URL + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "fazari-spaceapps/1.0"})
    raw = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read(2_000_000).decode("utf-8", "replace")
            break
        except Exception:
            time.sleep(3 * (attempt + 1))
    _last[0] = time.time()
    if raw is None:
        return None
    try:
        data = json.loads(raw) if raw.lstrip()[:1] in ("[", "{") else []
    except ValueError:
        data = []
    if isinstance(data, dict):
        data = data.get("data") or []
    objs = []
    for o in data if isinstance(data, list) else []:
        try:
            objs.append({"name": str(o.get("Name", ""))[:40], "number": str(o.get("Num", ""))[:12],
                         "cls": str(o.get("Class", ""))[:20],
                         "ra": _parse_sexa(o["RA (hms)"], True), "dec": _parse_sexa(o["DEC (dms)"], False),
                         "vmag": float(o["VMag (mag)"]) if o.get("VMag (mag)") not in (None, "") else None,
                         "err_arcsec": float(o["Err (arcsec)"]) if o.get("Err (arcsec)") not in (None, "") else None})
        except (KeyError, ValueError, TypeError, IndexError):
            continue
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"query": q, "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                "objects": objs}))
    return objs


def match(ra, dec, mjd, radius_arcsec=MATCH_ARCSEC, offline=False, sc_km=None):
    """Nearest known SSO within radius_arcsec at time mjd -> (dict or None, status).
    With sc_km (SPHEREx geocentric position from the exposure header, km) the SkyBoT positions are
    moved from the geocentre to the spacecraft (ssoephem.topocentric), which removes the up to
    ~10" low-Earth-orbit parallax; the match radius then shrinks to 2 native pixels."""
    if sc_km is not None and all(map(math.isfinite, sc_km)):
        from . import ssoephem as EPH
        objs = EPH.cone(mjd, ra, dec, 0.05, offline=offline)
        if objs is not None:
            best = None
            if objs:
                tr, td = EPH.topocentric([o["ra"] for o in objs], [o["dec"] for o in objs], [o["dg"] for o in objs], sc_km)
                lim = 2 * BL.PIX_NATIVE
                for o, r, d_ in zip(objs, tr, td):
                    d = SC.sep_arcsec(ra, dec, float(r), float(d_))
                    if d <= lim + 3 * (o.get("err_arcsec") or 0) and (best is None or d < best[0]):
                        best = (d, dict(name=o["name"], number=o["number"], cls=o["cls"], ra=float(r), dec=float(d_),
                                        vmag=o["vmag"], err_arcsec=o["err_arcsec"], H=o.get("H"),
                                        frame="SPHEREx-centric (geocentric SkyBoT + header X_SC/Y_SC/Z_SC)"))
            if best is None:
                return None, "no known object"
            d, o = best
            return dict(o, sep_arcsec=round(d, 2), sep_px=round(d / BL.PIX_NATIVE, 2)), "ok"
    objs = cone(ra, dec, mjd, max(radius_arcsec * 3, 60.0) / 3600, offline=offline)
    if objs is None:
        return None, "service unavailable"
    best = None
    for o in objs:
        d = SC.sep_arcsec(ra, dec, o["ra"], o["dec"])
        if d <= radius_arcsec + 3 * (o.get("err_arcsec") or 0) and (best is None or d < best[0]):
            best = (d, o)
    if best is None:
        return None, "no known object"
    d, o = best
    return dict(o, sep_arcsec=round(d, 2), sep_px=round(d / BL.PIX_NATIVE, 2)), "ok"


def _sc_position(ctx, c):
    """SPHEREx position (km, geocentric) at the candidate's best exposure, from its FITS header."""
    try:
        files = [d.get("file") for d in c.get("detections") or []]
        best = max(c.get("detections") or [], key=lambda d: d.get("snr") or 0)["file"] if files else None
        e = next((e for e in ctx.exps if e.get("file") == best), None)
        if e is None or not e.get("path"):
            return None
        from astropy.io import fits
        h = fits.getheader(e["path"], "IMAGE")
        return [float(h["X_SC"]), float(h["Y_SC"]), float(h["Z_SC"])]
    except Exception:
        return None


def classify(ctx, cands):
    """Transients (detector C) that match a known SSO -> class asteroid-known."""
    off = bool((ctx.opts or {}).get("sso_offline"))
    n = 0
    for c in cands:
        if c["kind"] != "transient" or c["class"] == "artifact":
            continue
        m, status = match(c["ra"], c["dec"], c["mjd"], offline=off, sc_km=_sc_position(ctx, c))
        c["sso_check"] = status
        if m:
            c["class"] = "asteroid-known"
            c["match"]["sso"] = m
            c["flags"].append(("known solar-system object " + f"{m['number']} {m['name']}".strip()).strip())
            n += 1
    ctx.info.setdefault("C", {})["n_asteroid_known"] = n
