#!/usr/bin/env python3
"""Fast-star layer for the Fazari sky explorer (NASA Space Apps 2026).

Builds site/data/fast_stars.json.gz (gzipped JSON): Gaia DR3 stars with total proper motion > 500 mas/yr that
SPHEREx should be able to see, and that the SPHEREx sky index covers in at least 2 observing
seasons. Read by site/explore/faststars.js.

Usage (from the fazari/ folder):
  uv run --no-project --with numpy python -I pipeline/fast_stars.py             # query (cached) + build
  uv run --no-project --with numpy python -I pipeline/fast_stars.py --refresh   # query the archives again

Data (one catalogue query each, a few thousand rows, cached under cache/fast_stars/):
  1. ESA Gaia archive TAP: gaiadr3.gaia_source WHERE pm > 500 (4746 rows on 2026-11-14, ~9 s), then
     the Gaia DR3 best-neighbour cross-matches to 2MASS PSC and AllWISE (J, H, Ks, W1) for those
     source_ids (chunks of 1000; joining them in the first query makes the archive scan very slow).
  2. SIMBAD TAP: the SIMBAD main identifier, object type and common name ("NAME ...") of each
     star, by its "Gaia DR3 <source_id>" identifier.
  3. SPHEREx seasons from the static sky index (site/index/, pipeline/sky_index.py find_images) at
     the star's 2026.0 position.

Brightness cut ("can SPHEREx see it?")
  m_spx = the brightest of J, H, Ks (2MASS, AB = Vega + 0.91 / 1.39 / 1.85, Blanton & Roweis 2007)
          and W1 (AllWISE, AB = Vega + 2.699, Jarrett et al. 2011): an AB magnitude in the
          1.2-3.4 um range that SPHEREx detectors D2-D4 cover. Bands with 2MASS/AllWISE quality
          flag A-D (2MASS) or A-C (W1) only.
          Stars without a usable 2MASS/AllWISE match: estimated from Gaia, J_AB = G - f(BP-RP),
          with f a quadratic fitted to the stars of this sample that have a good 2MASS J
          (residual scatter is printed); without BP-RP, J_AB = G (conservative for red stars).
  Assumed SPHEREx 5-sigma point-source depth per single exposure: ~17.5 AB at 1-2 um in an
  unconfused field (the project's working number, "roughly 17-18 AB"; season stacks go deeper).
    yes    m_spx <= 16.5   (S/N >~ 12 per exposure: plainly visible in every season)
    maybe  16.5 < m_spx <= 18.0   (near the single-exposure limit: may show only in stacks or
           in some wavelengths)
    kept   m_spx <= 18.0; fainter stars are left out of the file.
  The verdict is lowered for (a) a brighter star of this list within 12" (2 SPHEREx pixels of
  6.2"): "maybe", or "no" when it is > 2 mag brighter and within 9"; (b) |b| < 5 deg and
  m_spx > 16: "maybe" (crowded Milky Way field); (c) 2MASS J more than 1 mag brighter than the
  Gaia-colour estimate (G < 18, not a SIMBAD brown dwarf): "maybe" (possibly a wrong 2MASS match).
  m_spx < 9: "yes", core probably saturated.
  Note: the Gaia/2MASS best-neighbour cross-match misses the fastest stars (e.g. Barnard's Star,
  Proxima); they fall back to the Gaia estimate (Barnard: 6.2 AB est. vs 2MASS J_AB 6.15).

Coverage cut: >= 2 seasons (groups of SPHEREx images separated by > 30 days, as coverage.json)
at the star's position at epoch 2026.0 (linear proper motion from Gaia epoch 2016.0).

Credits: Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1), ESA/Gaia/DPAC;
2MASS (Skrutskie et al. 2006) and AllWISE (Cutri et al. 2013) through the Gaia DR3 cross-match
(Marrese et al. 2019); SIMBAD (Wenger et al. 2000), CDS Strasbourg.
"""
import argparse
import csv
import gzip
import io
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent           # fazari/
sys.path.insert(0, str(ROOT / "pipeline"))
CACHE = ROOT / "cache" / "fast_stars"
OUT = ROOT / "site" / "data" / "fast_stars.json.gz"   # gzip: ~0.7 MB of JSON -> ~0.28 MB
CATEGORIES = ROOT / "site" / "data" / "categories.json"
UA = "fazari-spaceapps/1.0"
ESA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
SIMBAD_TAP = ["https://simbad.cds.unistra.fr/simbad/sim-tap/sync",       # CDS (was down on 2026-11-14)
              "https://simbad.harvard.edu/simbad/sim-tap/sync"]         # Harvard mirror

PM_MIN = 500.0           # mas/yr, total proper motion
GAIA_EPOCH = 2016.0
EPOCH = 2026.0           # positions in the file are also given at this epoch (no parallax)
DEPTH_AB = 17.5          # assumed 5-sigma depth of one SPHEREx exposure at 1-2 um (AB)
YES_MAX, KEEP_MAX = 16.5, 18.0
SATURATED_BELOW = 9.0
BLEND_ARCSEC, BLEND_NO_ARCSEC = 12.0, 9.0
PLANE_B, PLANE_FAINT = 5.0, 16.0
XM_MAX, XM_GMAX = 1.0, 18.0   # 2MASS J brighter than the Gaia-colour estimate by > 1 mag (G < 18) -> "maybe"
SEASON_MJD0 = 60000      # seasons are stored as flat (MJD - 60000, images) pairs
MIN_SEASONS = 2
SEASON_GAP = 30.0        # days, as pipeline/sky_index.py coverage
AB = {"j": 0.91, "h": 1.39, "ks": 1.85, "w1": 2.699}

GAIA_ADQL = f"""
SELECT source_id, ra, dec, pmra, pmdec, parallax, parallax_error, pm, phot_g_mean_mag, bp_rp, ruwe,
       radial_velocity, astrometric_params_solved
FROM gaiadr3.gaia_source WHERE pm > {PM_MIN:g}
"""
# Second step, by source_id (a join in the first query makes the archive scan far slower).
XMATCH_ADQL = """
SELECT tx.source_id, t.j_m, t.h_m, t.ks_m, t.ph_qual AS tmass_qual
FROM gaiadr3.tmass_psc_xsc_best_neighbour AS tx
JOIN gaiadr3.tmass_psc_xsc_join AS tj ON tj.clean_tmass_psc_xsc_oid = tx.clean_tmass_psc_xsc_oid
JOIN gaiadr1.tmass_original_valid AS t ON t.designation = tj.original_psc_source_id
WHERE tx.source_id IN ({ids})
"""
WISE_ADQL = """
SELECT wx.source_id, w.w1mpro, w.w2mpro, w.ph_qual AS wise_qual
FROM gaiadr3.allwise_best_neighbour AS wx
JOIN gaiadr1.allwise_original_valid AS w ON w.allwise_oid = wx.allwise_oid
WHERE wx.source_id IN ({ids})
"""


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http_post(url, data, timeout=300, tries=3):
    body = urllib.parse.urlencode(data).encode()
    delay = 5.0
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if attempt == tries:
                raise
            log(f"  {type(e).__name__}: {e}; retry {attempt} in {delay:.0f}s")
            time.sleep(delay)
            delay *= 2


def tap(url, adql, tries=3):
    t0 = time.time()
    text = http_post(url, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}, tries=tries)
    if text.lstrip().startswith("<?xml") or "QUERY_STATUS" in text[:2000]:
        raise RuntimeError(f"TAP error from {url}: {text[:400]}")
    return text, time.time() - t0


def gaia_rows(refresh):
    f = CACHE / f"gaia_dr3_pm{PM_MIN:g}.csv"
    if refresh or not f.exists():
        log("Gaia DR3 query (ESA archive TAP) ...")
        text, dt = tap(ESA_TAP, GAIA_ADQL)
        CACHE.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
        log(f"  {text.count(chr(10)) - 1} rows in {dt:.1f} s")
    rows = list(csv.DictReader(io.StringIO(f.read_text())))
    ids = [r["source_id"] for r in rows]
    for name, adql in (("tmass", XMATCH_ADQL), ("allwise", WISE_ADQL)):
        fx = CACHE / f"xmatch_{name}_pm{PM_MIN:g}.csv"
        if refresh or not fx.exists():
            log(f"Gaia DR3 best-neighbour cross-match to {name} (ESA archive TAP) ...")
            parts, total = [], 0.0
            for k in range(0, len(ids), 1000):
                text, dt = tap(ESA_TAP, adql.format(ids=",".join(ids[k:k + 1000])))
                total += dt
                parts.append(text if k == 0 else text.split("\n", 1)[1])
            fx.write_text("".join(p if p.endswith("\n") else p + "\n" for p in parts))
            log(f"  done in {total:.1f} s")
        xm = {}
        for r in csv.DictReader(io.StringIO(fx.read_text())):
            xm.setdefault(r["source_id"], r)               # one best neighbour per source
        for r in rows:
            for k, v in (xm.get(r["source_id"]) or {}).items():
                if k != "source_id":
                    r[k] = v
    return rows


def simbad_names(ids, refresh):
    f = CACHE / "simbad_names.json"
    if not refresh and f.exists():
        got = json.loads(f.read_text())
        if all(i in got for i in ids):
            return got
    log("SIMBAD names (SIMBAD TAP) ...")
    got, total, mirrors = {}, 0.0, list(SIMBAD_TAP)
    for k in range(0, len(ids), 400):
        chunk = ids[k:k + 400]
        inlist = ",".join(f"'Gaia DR3 {i}'" for i in chunk)
        adql = ("SELECT g.id AS gid, b.main_id, b.otype, n.id AS common FROM ident AS g "
                "JOIN basic AS b ON b.oid = g.oidref "
                "LEFT OUTER JOIN ident AS n ON n.oidref = g.oidref AND n.id LIKE 'NAME %' "
                f"WHERE g.id IN ({inlist})")
        for k_url in range(len(mirrors)):
            try:
                text, dt = tap(mirrors[0], adql, tries=1)
                break
            except (urllib.error.URLError, RuntimeError, OSError) as e:
                if k_url == len(mirrors) - 1:
                    raise
                log(f"  {mirrors[0]}: {e}; using the next mirror")
                mirrors.append(mirrors.pop(0))
        total += dt
        for r in csv.DictReader(io.StringIO(text)):
            sid = r["gid"].replace("Gaia DR3", "").strip()
            e = got.setdefault(sid, {"main_id": r["main_id"], "otype": r["otype"], "common": ""})
            if r.get("common") and not e["common"]:
                e["common"] = r["common"]
        for i in chunk:
            got.setdefault(i, None)
    CACHE.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(got))
    log(f"  {sum(1 for v in got.values() if v)} of {len(ids)} found in {total:.1f} s")
    return got


def nice_name(e):
    if not e:
        return ""
    m = (e.get("main_id") or "").strip()
    if m.startswith("NAME "):
        return m[5:]
    n = (e.get("common") or "").replace("NAME ", "", 1).strip()
    if n:
        return n
    for p in ("NAME ", "V* ", "* "):
        if m.startswith(p):
            m = m[len(p):]
    return " ".join(m.split())


def num(s):
    try:
        x = float(s)
    except (TypeError, ValueError):
        return math.nan
    return x if math.isfinite(x) else math.nan


def move(ra, dec, pmra, pmdec, dt):
    """Linear proper motion (mas/yr, pmra includes cos dec) over dt years: ICRS degrees."""
    d2 = dec + pmdec * dt / 3.6e6
    r2 = ra + pmra * dt / 3.6e6 / max(math.cos(math.radians(dec)), 1e-9)
    return r2 % 360.0, max(-90.0, min(90.0, d2))


def sep_arcsec(r1, d1, r2, d2):
    a1, b1, a2, b2 = map(math.radians, (r1, d1, r2, d2))
    s = math.sin((b2 - b1) / 2) ** 2 + math.cos(b1) * math.cos(b2) * math.sin((a2 - a1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(s)))) * 3600


def gal_b(ra, dec):
    # ICRS -> Galactic latitude (same rotation as site/explore/coords.js)
    r = math.radians
    v = (math.cos(r(dec)) * math.cos(r(ra)), math.cos(r(dec)) * math.sin(r(ra)), math.sin(r(dec)))
    row = (-0.8676661490190047, -0.1980763734312015, +0.4559837761750669)
    return math.degrees(math.asin(max(-1.0, min(1.0, sum(a * b for a, b in zip(row, v))))))


def ir_mags(r):
    """{band: AB mag} from the usable 2MASS / AllWISE measurements."""
    out = {}
    tq = (r.get("tmass_qual") or "").strip()
    for k, band in enumerate(("j", "h", "ks")):
        m = num(r.get(f"{band}_m"))
        if math.isfinite(m) and len(tq) == 3 and tq[k] in "ABCD":
            out[band] = m + AB[band]
    wq = (r.get("wise_qual") or "").strip()
    w1 = num(r.get("w1mpro"))
    if math.isfinite(w1) and wq[:1] in ("A", "B", "C") and wq:
        out["w1"] = w1 + AB["w1"]
    return out


def fit_g_minus_j(rows):
    """Quadratic G - J_AB = c0 + c1 c + c2 c^2 in c = BP-RP, from the stars with a good 2MASS J."""
    import numpy as np
    xs, ys = [], []
    for r in rows:
        ir, g, c = ir_mags(r), num(r["phot_g_mean_mag"]), num(r["bp_rp"])
        if "j" in ir and math.isfinite(g) and math.isfinite(c) and -0.6 < c < 5.0:
            xs.append(c)
            ys.append(g - ir["j"])
    x, y = np.array(xs), np.array(ys)
    coef = np.polyfit(x, y, 2)
    for _ in range(3):                                     # clip mismatches / binaries
        res = y - np.polyval(coef, x)
        s = 1.4826 * np.median(np.abs(res - np.median(res)))
        keep = np.abs(res) < 3 * s
        coef = np.polyfit(x[keep], y[keep], 2)
    res = y - np.polyval(coef, x)
    s = 1.4826 * np.median(np.abs(res))
    log(f"  G - J_AB fit on {len(x)} stars: coef {coef.round(4).tolist()} (c^2, c, 1), robust scatter {s:.2f} mag")
    return lambda c: float(np.polyval(coef, max(-0.6, min(5.0, c)))), [round(float(v), 4) for v in coef], round(float(s), 2)


def seasons_at(ra, dec):
    from sky_index import find_images
    imgs = find_images(ra, dec)
    out, prev = [], -1e9
    for im in imgs:
        if im["mjd"] - prev > SEASON_GAP:
            out.append([])
        out[-1].append(im["mjd"])
        prev = im["mjd"]
    # [mean MJD (rounded to 0.1 d), number of images] per season
    return [[round(sum(s) / len(s), 1), len(s)] for s in out]


def categories_points():
    try:
        cats = json.loads(CATEGORIES.read_text())["categories"]
    except (OSError, ValueError, KeyError):
        return []
    pts, seen = [], set()
    for c in cats:
        for p in c.get("points", []):
            if p.get("id") in seen or p.get("ra") is None:
                continue
            seen.add(p.get("id"))
            pts.append(p)
    return pts


def build(refresh):
    t_start = time.time()
    rows = gaia_rows(refresh)
    log(f"{len(rows)} Gaia DR3 stars with pm > {PM_MIN:g} mas/yr")
    est, coef, scatter = fit_g_minus_j(rows)

    stars = []
    n_faint = n_nophot = 0
    for r in rows:
        g, c = num(r["phot_g_mean_mag"]), num(r["bp_rp"])
        ir = ir_mags(r)
        m_est = (g - est(c)) if math.isfinite(g) and math.isfinite(c) else math.nan
        if ir:
            band = min(ir, key=ir.get)
            m, src = ir[band], band
        elif math.isfinite(g):
            m, src = (g - est(c), "gaia_est") if math.isfinite(c) else (g, "gaia_g")
        else:
            n_nophot += 1
            continue
        if m > KEEP_MAX:
            n_faint += 1
            continue
        ra, dec = float(r["ra"]), float(r["dec"])
        pmra, pmdec = num(r["pmra"]), num(r["pmdec"])
        r26, d26 = move(ra, dec, pmra, pmdec, EPOCH - GAIA_EPOCH)
        stars.append({"sid": r["source_id"], "ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec,
                      "plx": num(r["parallax"]), "g": g, "bprp": c, "ruwe": num(r["ruwe"]),
                      "rv": num(r["radial_velocity"]), "m": m, "msrc": src, "r26": r26, "d26": d26,
                      "xm_off": (m_est - ir["j"]) if "j" in ir and math.isfinite(m_est) else math.nan})
    log(f"{len(stars)} bright enough (m_spx <= {KEEP_MAX}); {n_faint} fainter, {n_nophot} without photometry")

    # SPHEREx seasons at the 2026.0 position
    t0 = time.time()
    kept = []
    n_thin = 0
    fs = CACHE / "seasons.json"                 # sid -> seasons (valid for one build of site/index)
    idx_built = json.loads((ROOT / "site" / "index" / "manifest.json").read_text()).get("built")
    sc = json.loads(fs.read_text()) if fs.exists() else {}
    if sc.get("_index_built") != idx_built:
        sc = {"_index_built": idx_built}
    for k, s in enumerate(stars):
        if s["sid"] not in sc:
            sc[s["sid"]] = seasons_at(s["r26"], s["d26"])
        s["seasons"] = sc[s["sid"]]
        if len(s["seasons"]) >= MIN_SEASONS:
            kept.append(s)
        else:
            n_thin += 1
        if (k + 1) % 500 == 0:
            log(f"  seasons: {k + 1}/{len(stars)}")
    fs.write_text(json.dumps(sc))
    log(f"{len(kept)} with >= {MIN_SEASONS} SPHEREx seasons ({n_thin} with fewer), lookup {time.time() - t0:.0f} s")

    # names: SIMBAD, and our own named points (categories.json) by position
    names = simbad_names([s["sid"] for s in kept], refresh)
    pts = categories_points()
    for s in kept:
        e = names.get(s["sid"])
        s["name"] = nice_name(e)
        s["otype"] = (e or {}).get("otype") or ""
        for p in pts:
            pr, pd = p.get("ra_2026", p["ra"]), p.get("dec_2026", p["dec"])
            if abs(pd - s["d26"]) < 0.01 and sep_arcsec(pr, pd, s["r26"], s["d26"]) < 3.0:
                s["pid"], s["name"] = p["id"], p["name"]
                break

    # visibility verdicts
    kept.sort(key=lambda s: s["m"])
    for i, s in enumerate(kept):
        vis, why = ("yes", "bright") if s["m"] <= YES_MAX else ("maybe", "faint")
        if s["m"] < SATURATED_BELOW:
            why = "saturated"
        for o in kept[:i]:                                   # brighter stars of the list
            if abs(o["d26"] - s["d26"]) > BLEND_ARCSEC / 3600:
                continue
            d = sep_arcsec(o["r26"], o["d26"], s["r26"], s["d26"])
            if d < BLEND_ARCSEC:
                if d < BLEND_NO_ARCSEC and o["m"] < s["m"] - 2:
                    vis, why = "no", f"blend:{d:.1f}:{o['name'] or 'Gaia DR3 ' + o['sid']}"
                elif vis != "no":
                    vis, why = "maybe", f"near:{d:.1f}:{o['name'] or 'Gaia DR3 ' + o['sid']}"
                break
        if vis == "yes" and abs(gal_b(s["r26"], s["d26"])) < PLANE_B and s["m"] > PLANE_FAINT:
            vis, why = "maybe", "plane"
        # 2MASS J much brighter than Gaia's colours predict: maybe a wrong match. Not applied to brown dwarfs
        # (SIMBAD BD*: L/T dwarfs are far redder than the M-dwarf colour fit) nor at G >= 18 (noisy BP-RP).
        if vis == "yes" and s["xm_off"] > XM_MAX and s["g"] < XM_GMAX and s["otype"] != "BD*":
            vis, why = "maybe", f"xm:{s['xm_off']:.1f}"
        s["vis"], s["why"] = vis, why

    kept.sort(key=lambda s: -math.hypot(s["pmra"], s["pmdec"]))
    fields = ["sid", "name", "otype", "pid", "ra", "dec", "pmra", "pmdec", "plx", "rv", "g", "bprp",
              "m_spx", "m_src", "vis", "why", "seasons"]

    def r_(x, n):
        return None if not math.isfinite(x) else round(x, n)

    data = [[s["sid"], s["name"], s["otype"], s.get("pid"), round(s["ra"], 7), round(s["dec"], 7),
             r_(s["pmra"], 1), r_(s["pmdec"], 1), r_(s["plx"], 2), r_(s["rv"], 1), r_(s["g"], 2),
             r_(s["bprp"], 2), round(s["m"], 1), s["msrc"], s["vis"], s["why"],
             [v for mjd, n in s["seasons"] for v in (round(mjd - SEASON_MJD0), n)]] for s in kept]
    counts = {v: sum(1 for s in kept if s["vis"] == v) for v in ("yes", "maybe", "no")}
    doc = {
        "_note": "Gaia DR3 stars with total proper motion > 0.5 arcsec/yr that SPHEREx should see, with the "
                 "SPHEREx seasons that cover them. Built by pipeline/fast_stars.py; read by site/explore/faststars.js.",
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "credit": "Gaia DR3: ESA/Gaia/DPAC (Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1); 2MASS and AllWISE "
                  "via the Gaia DR3 cross-match; names: SIMBAD (CDS); seasons: SPHEREx sky index (NASA/IPAC IRSA).",
        "epoch": GAIA_EPOCH,
        "cuts": {"pm_min_mas_yr": PM_MIN, "m_spx_max_ab": KEEP_MAX, "yes_max_ab": YES_MAX,
                 "assumed_depth_ab_per_exposure": DEPTH_AB, "min_seasons": MIN_SEASONS, "season_gap_days": SEASON_GAP,
                 "m_spx": "brightest of 2MASS J/H/Ks and AllWISE W1 in AB; else Gaia G - f(BP-RP)",
                 "g_minus_j_ab_fit": {"coef_c2_c1_c0": coef, "scatter_mag": scatter},
                 "blend_arcsec": BLEND_ARCSEC, "plane_abs_b_deg": PLANE_B, "xmatch_max_mag": XM_MAX},
        "seasons_format": f"flat list of (mean MJD - season_mjd0, number of images) pairs, one pair per SPHEREx season",
        "season_mjd0": SEASON_MJD0,
        "counts": {"gaia_pm_gt_500": len(rows), "bright_enough": len(stars), "kept": len(kept), **counts},
        "fields": fields,
        "stars": data,
    }
    raw = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    OUT.write_bytes(gzip.compress(raw, 9, mtime=0))      # mtime=0: same input, same bytes
    log(f"wrote {OUT.relative_to(ROOT)}: {len(kept)} stars, {OUT.stat().st_size / 1024:.0f} KB gzip "
        f"({len(raw) / 1024:.0f} KB JSON) "
        f"(yes {counts['yes']}, maybe {counts['maybe']}, no {counts['no']}) in {time.time() - t_start:.0f} s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh", action="store_true", help="query Gaia and SIMBAD again (else use cache/fast_stars/)")
    build(ap.parse_args().refresh)
