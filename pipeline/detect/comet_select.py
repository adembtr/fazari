"""Which known comets are inside public SPHEREx images, at the time each image was taken.

Step 1 (coarse, all 4088 comets of JPL SBDB): two-body heliocentric orbits from the SBDB
osculating elements, Earth from astropy, total magnitude T = M1 + 5 log10(delta) + K1 log10(r).
Comets that reach T <= T_COARSE during the SPHEREx span are kept.
Step 2 (time match, all 1,307,849 L2 images of the sky index): the comet position is
interpolated to the mid time of every image and tested against the image footprint
(IRSA s_region polygon, margin MARGIN_COARSE deg for the two-body error).
Step 3 (precise): JPL Horizons geocentric astrometric RA/Dec, distance, T-mag at the exact mid
time of each matched image (TLIST), footprint test again with margin 0.

Outputs (cache/comets/): sbdb_comets.json, coarse.json, eph/<pdes>.json (Horizons answers,
numbers only), matches/<pdes>.json (images that contain the comet).
"""
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

import sky_index as SI
import blink as BL

CACHE = BL.ROOT / "cache" / "comets"
UA = "fazari-spaceapps/1.0"
K_GAUSS = 0.01720209895
OBL = math.radians(23.4392911)
T0, T1 = 60789.0, 61319.0
T_COARSE = 17.0
MARGIN_COARSE = 1.0                 # deg
MID = SI.EXPOSURE_DAYS / 2
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
NET = {"bytes": 0, "queries": 0}


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------------------------------ orbits
def kepler_pos(el, jd):
    """Heliocentric equatorial J2000 position (AU) of a two-body orbit at Julian dates jd."""
    e, q, tp = el["e"], el["q"], el["tp"]
    i, om, w = (math.radians(el[k]) for k in ("i", "om", "w"))
    dt = np.asarray(jd, float) - tp
    if abs(e - 1) < 1e-6:
        W = 3 * K_GAUSS / math.sqrt(2 * q ** 3) * dt / 2
        y = np.cbrt(W + np.sqrt(W * W + 1))
        s = y - 1 / y
        nu = 2 * np.arctan(s)
        r = q * (1 + s * s)
    elif e < 1:
        a = q / (1 - e)
        M = K_GAUSS / a ** 1.5 * dt
        M = np.remainder(M + np.pi, 2 * np.pi) - np.pi
        E = np.where(e > 0.8, np.pi * np.sign(M), M)
        for _ in range(60):
            E = E - (E - e * np.sin(E) - M) / (1 - e * np.cos(E))
        nu = 2 * np.arctan2(math.sqrt(1 + e) * np.sin(E / 2), math.sqrt(1 - e) * np.cos(E / 2))
        r = a * (1 - e * np.cos(E))
    else:
        a = q / (e - 1)
        M = K_GAUSS / a ** 1.5 * dt
        H = np.arcsinh(M / e)
        for _ in range(80):
            H = H - (e * np.sinh(H) - H - M) / (e * np.cosh(H) - 1)
        nu = 2 * np.arctan(math.sqrt((e + 1) / (e - 1)) * np.tanh(H / 2))
        r = a * (e * np.cosh(H) - 1)
    u = nu + w
    x = r * (np.cos(om) * np.cos(u) - np.sin(om) * np.sin(u) * np.cos(i))
    y = r * (np.sin(om) * np.cos(u) + np.cos(om) * np.sin(u) * np.cos(i))
    z = r * np.sin(u) * np.sin(i)
    ye = y * math.cos(OBL) - z * math.sin(OBL)
    ze = y * math.sin(OBL) + z * math.cos(OBL)
    return np.stack([x, ye, ze], -1), r


def earth_helio(mjd):
    from astropy.time import Time
    from astropy.coordinates import get_body_barycentric
    t = Time(np.asarray(mjd, float), format="mjd", scale="utc")
    e = get_body_barycentric("earth", t).xyz.to("AU").value.T
    s = get_body_barycentric("sun", t).xyz.to("AU").value.T
    return e - s


def coarse(force=False):
    """Two-body positions of every SBDB comet on a 0.5-day grid; keep those with T <= T_COARSE."""
    out_p = CACHE / "coarse.npz"
    if out_p.exists() and not force:
        d = np.load(out_p, allow_pickle=False)
        return {k: d[k] for k in d.files}
    sb = json.loads((CACHE / "sbdb_comets.json").read_text())
    F = sb["fields"]
    grid = np.arange(T0, T1 + 0.25, 0.5)
    E = earth_helio(grid)
    names, pdes, vecs, mags = [], [], [], []
    for row in sb["data"]:
        o = dict(zip(F, row))
        try:
            el = {k: float(o[k]) for k in ("e", "q", "tp", "i", "om", "w")}
            M1, K1 = float(o["M1"]), float(o["K1"])
        except (TypeError, ValueError):
            continue
        if el["q"] > 12:
            continue
        P, r = kepler_pos(el, grid + 2400000.5)
        g = P - E
        d = np.linalg.norm(g, axis=1)
        T = M1 + 5 * np.log10(d) + K1 * np.log10(r)
        if not np.isfinite(T).any() or np.nanmin(T) > T_COARSE:
            continue
        names.append(o["full_name"].strip())
        pdes.append(o["pdes"])
        vecs.append(g / d[:, None])
        mags.append(T)
    out = {"grid": grid, "names": np.array(names), "pdes": np.array(pdes), "u": np.array(vecs, np.float32),
           "T": np.array(mags, np.float32)}
    np.savez(out_p, **out)
    log(f"coarse: {len(names)} comets reach T <= {T_COARSE} between MJD {T0} and {T1}")
    return out


# ------------------------------------------------------------------------------------------ images
_IMG = {}


def images():
    """All L2 images: mid time, polygon geometry (centre basis + tangent-plane corners), key parts."""
    if _IMG:
        return _IMG
    D = SI.load(SI.cache_dir())
    poly = D["poly"]
    v = SI.unit(poly[..., 0], poly[..., 1])
    c = v.sum(1)
    c /= np.linalg.norm(c, axis=1, keepdims=True)
    ra0 = np.degrees(np.arctan2(c[:, 1], c[:, 0]))
    dec0 = np.degrees(np.arcsin(np.clip(c[:, 2], -1, 1)))
    cc, e, n = SI.tangent_basis(ra0, dec0)
    cx, cy, _ = SI.project(v, cc[:, None], e[:, None], n[:, None])
    _IMG.update(mjd=D["t"] * SI.T_UNIT + SI.T_ZERO + MID, c=cc, e=e, n=n, cx=cx, cy=cy, D=D)
    return _IMG


def key_of(D, i):
    rel, plan, ver, rver = str(D["plans"][D["plan"][i]]).split("|")
    v = rver if D["retry"][i] else ver
    oid = f"{plan}_{int(D['seq'][i]):04d}_{int(D['sub'][i])}"
    det = int(D["det"][i])
    return f"{rel}/level2/{plan}/{v}/{det}/level2_{oid}D{det}_spx_{v}.fits", oid, det


def inside(I, idx, u, margin):
    """Images idx contain the unit vectors u (one per image), within margin deg."""
    px, py, w = SI.project(u, I["c"][idx], I["e"][idx], I["n"][idx])
    return SI.contains(px, py, I["cx"][idx], I["cy"][idx], margin) & (w > 0.5)


def interp_u(grid, U, t):
    j = np.clip(np.searchsorted(grid, t) - 1, 0, grid.size - 2)
    f = ((t - grid[j]) / (grid[j + 1] - grid[j]))[:, None]
    u = U[j] * (1 - f) + U[j + 1] * f
    return u / np.linalg.norm(u, axis=1, keepdims=True)


def coarse_match():
    """Per comet: indices of images whose footprint (grown by MARGIN_COARSE) holds the two-body position."""
    out_p = CACHE / "coarse_match.json"
    if out_p.exists():
        return json.loads(out_p.read_text())
    C = coarse()
    I = images()
    t = I["mjd"]
    res = {}
    cosr = math.cos(math.radians(2.6 + MARGIN_COARSE))
    for k, name in enumerate(C["names"]):
        u = interp_u(C["grid"], C["u"][k].astype(float), t)
        near = np.nonzero((u * I["c"]).sum(1) > cosr)[0]
        if near.size == 0:
            continue
        ok = near[inside(I, near, u[near], MARGIN_COARSE)]
        if ok.size == 0:
            continue
        j = np.clip(np.searchsorted(C["grid"], t[ok]), 0, C["grid"].size - 1)
        T = C["T"][k][j]
        res[str(C["pdes"][k])] = {"name": str(name), "n": int(ok.size), "Tmin": float(T.min()),
                                  "Tmed": float(np.median(T)), "idx": ok.tolist()}
    out_p.write_text(json.dumps(res))
    log(f"coarse match: {len(res)} comets have images")
    return res


# ------------------------------------------------------------------------------------------ Horizons
def horizons_command(pdes):
    if pdes.lower() == "pluto":
        return "999"
    return f"DES={pdes};CAP;NOFRAG"


def horizons_tlist(pdes, mjds, chunk=90):
    """Geocentric astrometric RA/Dec (deg), delta (AU), r (AU), T-mag, N-mag, rates at UTC mjds."""
    safe = pdes.replace("/", "_").replace(" ", "_")
    path = CACHE / "eph" / f"{safe}.json"
    have = {}
    if path.exists():
        have = {round(r["mjd"], 7): r for r in json.loads(path.read_text())["rows"]}
    need = [m for m in mjds if round(m, 7) not in have]
    for a in range(0, len(need), chunk):
        part = need[a:a + chunk]
        q = {"format": "json", "COMMAND": f"'{horizons_command(pdes)}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
             "EPHEM_TYPE": "OBSERVER", "CENTER": "'500@399'", "TLIST_TYPE": "MJD", "TIME_TYPE": "UT",
             "TLIST": "'" + " ".join(f"{m:.7f}" for m in part) + "'", "QUANTITIES": "'1,3,9,19,20'",
             "ANG_FORMAT": "DEG", "EXTRA_PREC": "YES", "CSV_FORMAT": "YES"}
        url = HORIZONS + "?" + urllib.parse.urlencode(q)
        raw = None
        for att in range(8):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=180) as r:
                    raw = r.read()
                break
            except Exception as ex:
                log(f"  Horizons error {type(ex).__name__}; retry")
                time.sleep(5 * 2 ** att)
        if raw is None:
            raise IOError("Horizons failed")
        NET["bytes"] += len(raw)
        NET["queries"] += 1
        txt = json.loads(raw)["result"]
        if "$$SOE" not in txt:
            raise ValueError(f"Horizons: no ephemeris for {pdes}: {txt[:600]}")
        rows = parse_horizons(txt)
        if len(rows) != len(part):
            raise ValueError(f"Horizons rows {len(rows)} != {len(part)}")
        for m, r in zip(part, rows):
            r["mjd"] = m
            have[round(m, 7)] = r
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"pdes": pdes, "command": horizons_command(pdes), "center": "500@399",
                                    "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                    "rows": sorted(have.values(), key=lambda r: r["mjd"])}))
        time.sleep(1.0)
    return [have[round(m, 7)] for m in mjds]


def parse_horizons(txt):
    head = txt.split("$$SOE")[0].strip().splitlines()
    cols = [c.strip() for c in head[-2 if head[-1].startswith("*") else -1].split(",")]
    ira = next(i for i, c in enumerate(cols) if c.startswith("R.A."))
    ide = next(i for i, c in enumerate(cols) if c.startswith("DEC"))
    body = txt.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    rows = []
    for line in body:
        p = [c.strip() for c in line.split(",")]

        def num(i):
            try:
                return float(p[i])
            except (ValueError, IndexError):
                return None

        def col(name):
            return num(cols.index(name)) if name in cols else None
        rows.append({"ra": num(ira), "dec": num(ide), "dra_cosd_h": col("dRA*cosD"), "ddec_h": col("d(DEC)/dt"),
                     "T": col("T-mag") if "T-mag" in cols else col("APmag"), "N": col("N-mag"), "r": col("r"), "delta": col("delta")})
    return rows


def horizons_grid(pdes, step_h=2):
    """One Horizons request: geocentric ephemeris every step_h hours over the SPHEREx span."""
    safe = pdes.replace("/", "_").replace(" ", "_")
    path = CACHE / "eph" / f"{safe}_grid{step_h}h.json"
    if path.exists():
        return json.loads(path.read_text())["rows"]
    from astropy.time import Time
    q = {"format": "json", "COMMAND": f"'{horizons_command(pdes)}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
         "EPHEM_TYPE": "OBSERVER", "CENTER": "'500@399'", "START_TIME": f"'{Time(T0, format='mjd').iso[:16]}'",
         "STOP_TIME": f"'{Time(T1, format='mjd').iso[:16]}'", "STEP_SIZE": f"'{step_h} h'", "TIME_TYPE": "UT",
         "QUANTITIES": "'1,3,9,19,20'", "ANG_FORMAT": "DEG", "EXTRA_PREC": "YES", "CSV_FORMAT": "YES",
         "CAL_FORMAT": "JD"}
    url = HORIZONS + "?" + urllib.parse.urlencode(q)
    raw = None
    for att in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=300) as r:
                raw = r.read()
            break
        except Exception as ex:
            log(f"  Horizons error {type(ex).__name__} {getattr(ex, 'code', '')}; retry")
            time.sleep(5 * 2 ** att)
    if raw is None:
        raise IOError("Horizons failed")
    NET["bytes"] += len(raw)
    NET["queries"] += 1
    txt = json.loads(raw)["result"]
    if "$$SOE" not in txt:
        raise ValueError(f"Horizons: no ephemeris for {pdes}: {txt[:400]}")
    rows = parse_horizons(txt)
    body = txt.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    for r, line in zip(rows, body):
        r["mjd"] = float(line.split(",")[0]) - 2400000.5
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"pdes": pdes, "command": horizons_command(pdes), "center": "500@399",
                                "step_h": step_h, "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                "rows": rows}))
    time.sleep(1.0)
    return rows


def grid_at(rows, t):
    """Interpolate the grid ephemeris (unit vectors, delta, T) to times t (array)."""
    g = np.array([r["mjd"] for r in rows])
    ok = np.array([r["ra"] is not None and r["dec"] is not None for r in rows])
    g = g[ok]
    rr = [r for r, k in zip(rows, ok) if k]
    U = SI.unit(np.array([r["ra"] for r in rr]), np.array([r["dec"] for r in rr]))
    u = interp_u(g, U, t)
    out = {"u": u}
    for k in ("delta", "T", "r", "dra_cosd_h", "ddec_h"):
        v = np.array([np.nan if r[k] is None else r[k] for r in rr], float)
        out[k] = np.interp(t, g, v)
    inspan = (t >= g[0]) & (t <= g[-1])
    out["ok"] = inspan
    return out


def precise(pdes, idx=None, margin=0.0):
    """Images that contain the comet at their mid time (Horizons 2-h grid, interpolated)."""
    I = images()
    D = I["D"]
    rows = horizons_grid(pdes)
    t = I["mjd"]
    E = grid_at(rows, t)
    u = E["u"]
    near = np.nonzero(((u * I["c"]).sum(1) > math.cos(math.radians(2.6))) & E["ok"])[0]
    ok = near[inside(I, near, u[near], margin)]
    out = []
    for i in ok:
        key, oid, det = key_of(D, i)
        ra = float(np.degrees(np.arctan2(u[i, 1], u[i, 0])) % 360)
        dec = float(np.degrees(np.arcsin(u[i, 2])))
        out.append(dict(key=key, obs_id=oid, det=det, mjd=float(t[i]), ra=ra, dec=dec,
                        delta=float(E["delta"][i]), T=None if not np.isfinite(E["T"][i]) else float(E["T"][i]),
                        r=float(E["r"][i]), rate_h=float(math.hypot(E["dra_cosd_h"][i], E["ddec_h"][i]))))
    return out
