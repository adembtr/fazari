#!/usr/bin/env python3
"""Static sky index of SPHEREx Level 2 spectral images (Fazari, NASA Space Apps 2026).

The browser cannot ask IRSA which images cover a point (IRSA SIA/TAP send no CORS headers),
so this script downloads the image metadata once from IRSA TAP and writes a static,
tiled index to site/index/. site/js/skyindex.js reads it. Format: site/index/FORMAT.md.

Usage (from the fazari/ folder):
  uv run --no-project --with numpy --with healpy python -I pipeline/sky_index.py fetch
  uv run --no-project --with numpy --with healpy python -I pipeline/sky_index.py build
  uv run --no-project --with numpy python -I pipeline/sky_index.py query --ra 269.44627 --dec 4.76820
  uv run --no-project --with numpy python -I pipeline/sky_index.py query --ra .. --dec .. --from-cache
  uv run --no-project --with numpy python -I pipeline/sky_index.py check

From Python (numpy only):  from sky_index import find_images; find_images(ra, dec)

`build` runs `fetch` first if the cache is incomplete. `fetch` is resumable: every time chunk
is cached as its own file and skipped when present.
Cache: --cache DIR, else env FAZARI_CACHE, else <repo>/cache/sky_index/ (gitignored).

Data source: IRSA TAP table spherex.obscore (collections spherex_dr1 and spherex_qr3,
calib_level 2 images) plus spherex.artifact for the few images stored under an
"l2b_retry" processing folder, plus an anonymous S3 listing of the level2 folders.
"""
import argparse
import csv
import gzip
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent           # fazari/
OUT_DEFAULT = ROOT / "site" / "index"
TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
USER_AGENT = "fazari-spaceapps/1.0"
COLLECTIONS = {"dr1": "spherex_dr1", "qr3": "spherex_qr3"}
RELEASES = ["dr1", "qr3"]                                # S3 top folders
T_START, T_STOP, T_STEP = 60789.0, 61330.0, 5.0          # MJD chunks for the TAP download
ATTEMPTS = 10
WORKERS = 3                                              # parallel TAP queries (be polite)


# ----------------------------------------------------------------------------- helpers

def log(*a):
    print(*a, file=sys.stderr, flush=True)


def cache_dir(cli=None):
    if cli:
        return Path(cli).expanduser().resolve()
    env = os.environ.get("FAZARI_CACHE")
    if env:
        return Path(env).expanduser().resolve()
    return ROOT / "cache" / "sky_index"


def http_get(url, data=None, timeout=600):
    """GET (or POST form data) with exponential backoff on 429/5xx and network errors."""
    body = urllib.parse.urlencode(data).encode() if data else None
    delay = 5.0
    for attempt in range(1, ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == ATTEMPTS:
                raise
            log(f"  HTTP {e.code}, retry {attempt} in {delay:.0f}s")
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if attempt == ATTEMPTS:
                raise
            log(f"  {type(e).__name__}: {e}, retry {attempt} in {delay:.0f}s")
        time.sleep(delay)
        delay = min(delay * 2, 300)


def tap_csv(query):
    """Run a synchronous TAP query, return the CSV text. Raises on a VOTable error answer."""
    for attempt in range(1, 4):
        raw = http_get(TAP, {"QUERY": query, "FORMAT": "csv"}).decode("utf-8")
        if raw.lstrip().startswith("<?xml") or "QUERY_STATUS" in raw[:2000]:
            log(f"  TAP error answer (attempt {attempt}): {raw[:300]!r}")
            time.sleep(30 * attempt)
            continue
        return raw
    raise RuntimeError("TAP query failed: " + query)


# ----------------------------------------------------------------------------- fetch

def chunk_name(t0):
    return f"obscore_{t0:.0f}.csv.gz"


def fetch(cache):
    """Download the metadata into the cache (resumable)."""
    cache.mkdir(parents=True, exist_ok=True)
    colls = ",".join(f"'{c}'" for c in COLLECTIONS.values())
    # 1) obscore rows, chunked by start time (at most WORKERS queries at a time)
    def one(t0):
        t1 = t0 + T_STEP
        f = cache / chunk_name(t0)
        if f.exists():
            return
        q = ("select obs_id, obs_collection, energy_bandpassname, t_min, s_region "
             f"from spherex.obscore where obs_collection in ({colls}) and calib_level = 2 "
             f"and t_min >= {t0} and t_min < {t1}")
        text = tap_csv(q)
        tmp = f.with_name(f.name + ".part")
        with gzip.open(tmp, "wt", encoding="utf-8") as g:
            g.write(text)
        tmp.rename(f)
        log(f"obscore {t0:.0f}..{t1:.0f}: {text.count(chr(10)) - 1} rows")

    starts = []
    t0 = T_START
    while t0 < T_STOP:
        starts.append(t0)
        t0 += T_STEP
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(one, starts))
    # 2) totals, to check completeness
    f = cache / "obscore_counts.csv"
    if not f.exists():
        log("obscore counts")
        f.write_text(tap_csv("select obs_collection, count(*) as n from spherex.obscore "
                             f"where obs_collection in ({colls}) and calib_level = 2 "
                             "group by obs_collection"))
    # 3) images stored under a "retry" processing folder (key differs from the main folder)
    f = cache / "retry_uris.csv"
    if not f.exists():
        log("retry artifact uris")
        f.write_text(tap_csv("select uri from spherex.artifact where uri like '%/level2/%l2b_retry%' "
                             "and producttype = 'science'"))
    # 4) S3 level2 folder listing: plan -> processing folders
    f = cache / "s3_level2_folders.json"
    if not f.exists():
        log("S3 level2 folder listing")
        res = {}
        for rel in RELEASES:
            for plan in s3_list(f"{rel}/level2/"):
                res[plan] = s3_list(plan)
        f.write_text(json.dumps(res, indent=1))
    log("fetch complete")


def s3_list(prefix):
    """Anonymous ListObjectsV2 with delimiter: sub-prefixes of prefix."""
    out, tok = [], None
    while True:
        u = S3 + "?list-type=2&delimiter=/&prefix=" + urllib.parse.quote(prefix)
        if tok:
            u += "&continuation-token=" + urllib.parse.quote(tok)
        t = http_get(u, timeout=120).decode()
        out += [p for p in re.findall(r"<Prefix>([^<]*)</Prefix>", t) if p != prefix]
        m = re.search(r"<NextContinuationToken>([^<]*)<", t)
        if not m:
            return out
        tok = m.group(1)


def fetch_complete(cache):
    t0, ok = T_START, True
    while t0 < T_STOP:
        ok &= (cache / chunk_name(t0)).exists()
        t0 += T_STEP
    return ok and all((cache / n).exists() for n in
                      ("obscore_counts.csv", "retry_uris.csv", "s3_level2_folders.json"))


# ----------------------------------------------------------------------------- load

OBS_RE = re.compile(r"^(\d{4}W\d{2}_\d[A-Z])_(\d{4})_(\d+)$")
RETRY_RE = re.compile(r"ibe/data/spherex/(\w+)/level2/([^/]+)/(l2b_retry-[^/]+)/(\d)/level2_(.+)D(\d)_spx_")
T_UNIT = 1e-6            # day; t_min is stored as integer micro-days since T_ZERO
T_ZERO = 60000.0
POS_UNIT = 1e-4          # degree; image centre RA/Dec quantum (0.36")
RES_UNIT = 1e-4          # degree; corner residual quantum (0.36", max rounding error 0.18")
ANG_STEPS = 65536        # rotation angle quantum = 360/65536 degree


def load(cache):
    """Parse the cached TAP chunks into numpy arrays (cached as npz)."""
    import numpy as np
    npz = cache / "images.npz"
    if npz.exists():
        d = np.load(npz, allow_pickle=False)
        return {k: d[k] for k in d.files}
    if not fetch_complete(cache):
        fetch(cache)
    folders = json.loads((cache / "s3_level2_folders.json").read_text())
    main_ver, retry_ver = {}, {}
    for plan_prefix, subs in folders.items():
        rel, _, plan = plan_prefix.rstrip("/").split("/")
        for s in subs:
            ver = s.rstrip("/").split("/")[-1]
            if ver.startswith("l2b-"):
                assert (rel, plan) not in main_ver, plan_prefix
                main_ver[(rel, plan)] = ver
            elif ver.startswith("l2b_retry-"):
                assert (rel, plan) not in retry_ver, plan_prefix
                retry_ver[(rel, plan)] = ver
    retry = set()
    for line in (cache / "retry_uris.csv").read_text().splitlines()[1:]:
        m = RETRY_RE.search(line)
        if not m:
            continue
        rel, plan, ver, det, oid, det2 = m.groups()
        assert det == det2 and retry_ver.get((rel, plan)) == ver, line
        retry.add((rel, oid, int(det)))

    coll_code = {v: i for i, v in enumerate(COLLECTIONS.values())}     # 0 dr1, 1 qr3
    rels = list(COLLECTIONS)
    plans, plan_idx = [], {}
    cols = {k: [] for k in ("coll", "plan", "seq", "sub", "det", "t", "retry")}
    poly = []
    seen = set()
    dups = 0
    t0 = T_START
    while t0 < T_STOP:
        with gzip.open(cache / chunk_name(t0), "rt", encoding="utf-8") as g:
            for r in csv.DictReader(g):
                c = coll_code[r["obs_collection"]]
                rel = rels[c]
                m = OBS_RE.match(r["obs_id"])
                assert m, r["obs_id"]
                plan, seq, sub = m.group(1), int(m.group(2)), int(m.group(3))
                det = int(r["energy_bandpassname"][-1])
                k = (c, r["obs_id"], det)
                if k in seen:
                    dups += 1
                    continue
                seen.add(k)
                if (rel, plan) not in plan_idx:
                    assert (rel, plan) in main_ver, (rel, plan)
                    plan_idx[(rel, plan)] = len(plans)
                    plans.append([rel, plan, main_ver[(rel, plan)], retry_ver.get((rel, plan), "")])
                p = r["s_region"].split()
                assert p[0] == "POLYGON" and len(p) == 12, r["s_region"]
                cols["coll"].append(c)
                cols["plan"].append(plan_idx[(rel, plan)])
                cols["seq"].append(seq)
                cols["sub"].append(sub)
                cols["det"].append(det)
                cols["t"].append(round((float(r["t_min"]) - T_ZERO) / T_UNIT))
                cols["retry"].append((rel, r["obs_id"], det) in retry)
                poly.append([float(x) for x in p[2:10]])
        t0 += T_STEP
    if dups:
        log(f"warning: {dups} duplicate rows skipped")
    counts = {row.split(",")[0]: int(row.split(",")[1]) for row in
              (cache / "obscore_counts.csv").read_text().splitlines()[1:] if row}
    for c, name in enumerate(COLLECTIONS.values()):
        got = sum(1 for x in cols["coll"] if x == c)
        log(f"{name}: {got} images (TAP count {counts.get(name)})")
        if got != counts.get(name):
            log("  WARNING: count differs from the TAP total")
    out = {
        "coll": np.array(cols["coll"], np.uint8),
        "plan": np.array(cols["plan"], np.uint16),
        "seq": np.array(cols["seq"], np.uint16),
        "sub": np.array(cols["sub"], np.uint8),
        "det": np.array(cols["det"], np.uint8),
        "t": np.array(cols["t"], np.int64),
        "retry": np.array(cols["retry"], bool),
        "poly": np.array(poly, np.float64).reshape(-1, 4, 2),
        "plans": np.array(["|".join(p) for p in plans]),
    }
    log(f"retry images matched: {int(out['retry'].sum())} of {len(retry)} retry uris")
    np.savez(npz, **out)
    return out


# ----------------------------------------------------------------------------- geometry

def unit(ra, dec):
    import numpy as np
    ra, dec = np.radians(ra), np.radians(dec)
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], -1)


def tangent_basis(ra0, dec0):
    """Centre vector, east and north unit vectors of the tangent plane at (ra0, dec0) (degrees)."""
    import numpy as np
    a, d = np.radians(ra0), np.radians(dec0)
    c = np.stack([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)], -1)
    e = np.stack([-np.sin(a), np.cos(a), np.zeros_like(a)], -1)
    n = np.stack([-np.sin(d) * np.cos(a), -np.sin(d) * np.sin(a), np.cos(d)], -1)
    return c, e, n


def project(v, c, e, n):
    """Gnomonic projection of unit vectors v (..., 3) about centre c; returns x, y in degrees and w."""
    import numpy as np
    w = (v * c).sum(-1)
    return np.degrees((v * e).sum(-1) / w), np.degrees((v * n).sum(-1) / w), w


def geometry(D):
    """Quantised footprint model: centre, rotation, per-detector template and corner residuals.

    corner_k (tangent plane at the quantised centre, degrees) =
        R(angle) @ template[det][k] + residual_k * RES_UNIT
    """
    import numpy as np
    poly = D["poly"]
    v = unit(poly[..., 0], poly[..., 1])                      # N,4,3
    c = v.sum(1)
    c /= np.linalg.norm(c, axis=1, keepdims=True)
    ra = np.degrees(np.arctan2(c[:, 1], c[:, 0])) % 360.0
    dec = np.degrees(np.arcsin(np.clip(c[:, 2], -1, 1)))
    raq = np.round(ra / POS_UNIT).astype(np.int64) % round(360 / POS_UNIT)
    decq = np.round(dec / POS_UNIT).astype(np.int64)
    cc, e, n = tangent_basis(raq * POS_UNIT, decq * POS_UNIT)
    x, y, _ = project(v, cc[:, None], e[:, None], n[:, None])  # N,4
    det = D["det"]
    tmpl = np.zeros((7, 4, 2))
    ang = np.arctan2(y[:, 1] - y[:, 0], x[:, 1] - x[:, 0])     # first guess: edge 0->1 direction
    for it in range(3):
        for d in range(1, 7):
            m = det == d
            ca, sa = np.cos(-ang[m])[:, None], np.sin(-ang[m])[:, None]
            tx = ca * x[m] - sa * y[m]
            ty = sa * x[m] + ca * y[m]
            tmpl[d, :, 0] = np.median(tx, 0)
            tmpl[d, :, 1] = np.median(ty, 0)
        tmpl = np.round(tmpl, 6)
        T = tmpl[det]                                          # N,4,2
        # best rotation (2-D Procrustes) of the template onto the corners
        s = (T[..., 0] * y - T[..., 1] * x).sum(1)
        k = (T[..., 0] * x + T[..., 1] * y).sum(1)
        ang = np.arctan2(s, k)
    angq = np.round(ang / (2 * np.pi) * ANG_STEPS).astype(np.int64) % ANG_STEPS
    a = angq * (2 * np.pi / ANG_STEPS)
    ca, sa = np.cos(a)[:, None], np.sin(a)[:, None]
    T = tmpl[det]
    px = ca * T[..., 0] - sa * T[..., 1]
    py = sa * T[..., 0] + ca * T[..., 1]
    res = np.stack([np.round((x - px) / RES_UNIT), np.round((y - py) / RES_UNIT)], -1)  # N,4,2
    big = np.abs(res).max(axis=(1, 2))
    assert big.max() < 32767, "corner residual overflow"
    log(f"corner residuals (arcsec): median {np.median(big) * RES_UNIT * 3600:.2f}, "
        f"p99 {np.percentile(big, 99) * RES_UNIT * 3600:.2f}, max {big.max() * RES_UNIT * 3600:.1f}")
    return {"raq": raq, "decq": decq, "angq": angq, "res": res.astype(np.int16).reshape(-1, 8),
            "tmpl": tmpl}


def corners_model(raq, decq, angq, res, tmpl, det):
    """Rebuild the tangent-plane corners (x, y in degrees) from the stored model; N,4 each."""
    import numpy as np
    a = np.asarray(angq) * (2 * np.pi / ANG_STEPS)
    ca, sa = np.cos(a)[:, None], np.sin(a)[:, None]
    T = tmpl[det]
    r = np.asarray(res, np.float64).reshape(-1, 4, 2) * RES_UNIT
    return ca * T[..., 0] - sa * T[..., 1] + r[..., 0], sa * T[..., 0] + ca * T[..., 1] + r[..., 1]


def contains(px, py, cx, cy, margin):
    """Point (px, py) inside the convex quad (cx, cy: N,4) or within `margin` degrees of it."""
    import numpy as np
    x0, y0 = cx, cy
    x1, y1 = np.roll(cx, -1, axis=1), np.roll(cy, -1, axis=1)
    ex, ey = x1 - x0, y1 - y0
    cross = ex * (py[:, None] - y0) - ey * (px[:, None] - x0)
    area = (x0 * y1 - x1 * y0).sum(1)                          # orientation sign
    sgn = np.where(area >= 0, 1.0, -1.0)[:, None]
    inside = (cross * sgn >= 0).all(1)
    # distance to each edge segment
    L2 = ex * ex + ey * ey
    t = np.clip(((px[:, None] - x0) * ex + (py[:, None] - y0) * ey) / L2, 0, 1)
    dx = px[:, None] - (x0 + t * ex)
    dy = py[:, None] - (y0 + t * ey)
    near = (dx * dx + dy * dy).min(1) <= margin * margin
    return inside | near


def point_in_images(ra, dec, raq, decq, angq, res, tmpl, det, margin):
    """Boolean mask of the stored images that contain (ra, dec)."""
    import numpy as np
    c, e, n = tangent_basis(np.asarray(raq) * POS_UNIT, np.asarray(decq) * POS_UNIT)
    p = unit(np.float64(ra), np.float64(dec))
    px, py, w = project(p[None, :], c, e, n)
    cx, cy = corners_model(raq, decq, angq, res, tmpl, det)
    return contains(px, py, cx, cy, margin) & (w > 0.5)


def point_in_polygons(ra, dec, poly, margin):
    """Exact test against the original IRSA polygons (tangent plane at each polygon's centre)."""
    import numpy as np
    v = unit(poly[..., 0], poly[..., 1])
    c = v.sum(1)
    c /= np.linalg.norm(c, axis=1, keepdims=True)
    ra0 = np.degrees(np.arctan2(c[:, 1], c[:, 0]))
    dec0 = np.degrees(np.arcsin(np.clip(c[:, 2], -1, 1)))
    cc, e, n = tangent_basis(ra0, dec0)
    cx, cy, _ = project(v, cc[:, None], e[:, None], n[:, None])
    p = unit(np.float64(ra), np.float64(dec))
    px, py, w = project(p[None, :], cc, e, n)
    return contains(px, py, cx, cy, margin) & (w > 0.5)


# ----------------------------------------------------------------------------- tiles

MAGIC = b"SXT1"
ASSIGN_MARGIN = 0.02     # degree; footprints are grown by this much before tile assignment
MAX_MARGIN = 0.01        # degree; largest query margin the index guarantees to be complete


def shuffle(arr):
    """Byte-plane order (all low bytes, then the next byte, ...): compresses better."""
    import numpy as np
    a = np.ascontiguousarray(arr)
    return a.view(np.uint8).reshape(-1, a.dtype.itemsize).T.tobytes()


def unshuffle(buf, off, n, dtype):
    import numpy as np
    dt = np.dtype(dtype)
    w = dt.itemsize
    b = np.frombuffer(buf, np.uint8, n * w, off).reshape(w, n).T.copy()
    return b.view(dt).reshape(n), off + n * w


def encode_tile(idx, D, G):
    """Binary tile for the images idx. Layout in FORMAT.md."""
    import numpy as np
    order = np.lexsort((D["det"][idx], D["sub"][idx], D["seq"][idx], D["plan"][idx], D["t"][idx]))
    idx = np.asarray(idx)[order]
    key = (D["t"][idx] << 24) | (D["plan"][idx].astype(np.int64) << 8) | D["sub"][idx]
    first = np.ones(len(idx), bool)
    first[1:] = (key[1:] != key[:-1]) | (D["seq"][idx][1:] != D["seq"][idx][:-1])
    ex = idx[first]
    eid = np.cumsum(first) - 1
    n_exp, n_img = len(ex), len(idx)
    detbit = (1 << (D["det"][idx] - 1)).astype(np.uint8)
    detmask = np.zeros(n_exp, np.uint8)
    np.bitwise_or.at(detmask, eid, detbit)
    retrymask = np.zeros(n_exp, np.uint8)
    np.bitwise_or.at(retrymask, eid, np.where(D["retry"][idx], detbit, 0).astype(np.uint8))
    t = D["t"][ex]
    dt = np.diff(t, prepend=0)
    assert dt.min() >= 0 and t.max() < 2 ** 32
    raq, decq = G["raq"][idx], G["decq"][idx]
    parts = [
        MAGIC, np.array([n_exp, n_img], "<u4").tobytes(),
        shuffle(dt.astype("<u4")),
        D["plan"][ex].astype("u1" if len(D["plans"]) < 256 else "<u2").tobytes(),
        shuffle(D["seq"][ex].astype("<u2")),
        D["sub"][ex].astype("u1").tobytes(),
        detmask.tobytes(), retrymask.tobytes(),
        shuffle(raq.astype("<u4")),
        shuffle(decq.astype("<i4")),
        shuffle(G["angq"][idx].astype("<u2")),
        shuffle(G["res"][idx].T.astype("<i2")),   # 8 columns: x0 y0 x1 y1 x2 y2 x3 y3
    ]
    return b"".join(parts)


def decode_tile(buf, plan_width=1):
    """Inverse of encode_tile: dict of exposure and image columns."""
    import numpy as np
    assert buf[:4] == MAGIC, "bad tile"
    n_exp, n_img = np.frombuffer(buf, "<u4", 2, 4)
    n_exp, n_img = int(n_exp), int(n_img)
    off = 12
    dt, off = unshuffle(buf, off, n_exp, "<u4")
    plan = np.frombuffer(buf, "u1" if plan_width == 1 else "<u2", n_exp, off).astype(np.int64)
    off += n_exp * plan_width
    seq, off = unshuffle(buf, off, n_exp, "<u2")
    sub = np.frombuffer(buf, "u1", n_exp, off); off += n_exp
    detmask = np.frombuffer(buf, "u1", n_exp, off); off += n_exp
    retrymask = np.frombuffer(buf, "u1", n_exp, off); off += n_exp
    raq, off = unshuffle(buf, off, n_img, "<u4")
    decq, off = unshuffle(buf, off, n_img, "<i4")
    angq, off = unshuffle(buf, off, n_img, "<u2")
    res, off = unshuffle(buf, off, n_img * 8, "<i2")
    assert off == len(buf)
    t = np.cumsum(dt.astype(np.int64))
    eid, det, retry = [], [], []
    for i in range(n_exp):
        for d in range(1, 7):
            if detmask[i] >> (d - 1) & 1:
                eid.append(i)
                det.append(d)
                retry.append(bool(retrymask[i] >> (d - 1) & 1))
    eid = np.array(eid, np.int64)
    return {"t": t[eid], "plan": plan[eid], "seq": seq[eid], "sub": sub[eid], "det": np.array(det),
            "retry": np.array(retry), "raq": raq.astype(np.int64), "decq": decq.astype(np.int64),
            "angq": angq.astype(np.int64), "res": res.reshape(8, n_img).T}


def grown_vertices(G, i_list, D, grow=ASSIGN_MARGIN):
    """Unit vectors of each footprint grown outward by `grow` degrees (for tile assignment)."""
    import numpy as np
    i_list = np.asarray(i_list)
    cx, cy = corners_model(G["raq"][i_list], G["decq"][i_list], G["angq"][i_list],
                           G["res"][i_list], G["tmpl"], D["det"][i_list])
    r = np.hypot(cx, cy)
    f = 1 + grow * math.sqrt(2) / r
    x, y = np.radians(cx * f), np.radians(cy * f)
    c, e, n = tangent_basis(G["raq"][i_list] * POS_UNIT, G["decq"][i_list] * POS_UNIT)
    v = c[:, None] + x[..., None] * e[:, None] + y[..., None] * n[:, None]
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def assign(G, D, idx, order, parent=None, parent_order=None):
    """{pixel: [image indices]} at HEALPix order (nested) for the images idx."""
    import healpy as hp
    import numpy as np
    nside = 1 << order
    V = grown_vertices(G, idx, D)
    out = {}
    shift = 2 * (order - parent_order) if parent is not None else 0
    for j, i in enumerate(idx):
        pix = hp.query_polygon(nside, V[j], inclusive=True, nest=True, fact=8)
        for p in pix:
            if parent is not None and (p >> shift) != parent:
                continue
            out.setdefault(int(p), []).append(int(i))
    return out


COV_ORDER = 6            # coverage map: HEALPix order 6 (49152 pixels of ~0.92 deg)
SEASON_GAP = 30.0        # days; a gap longer than this starts a new season


def coverage(D, G, out_dir):
    """coverage.json: per order-6 pixel, number of images and of seasons whose footprint holds the pixel centre."""
    import healpy as hp
    import numpy as np
    nside = 1 << COV_ORDER
    N = len(D["det"])
    pix_l, t_l = [], []
    for i0 in range(0, N, 100000):
        sl = np.arange(i0, min(N, i0 + 100000))
        V = grown_vertices(G, sl, D, grow=0.0)
        for j, i in enumerate(sl):
            p = hp.query_polygon(nside, V[j], inclusive=False, nest=True)
            if len(p):
                pix_l.append(p.astype(np.int32))
                t_l.append(np.full(len(p), D["t"][i] // 1000000, np.int32))   # day number
    pix = np.concatenate(pix_l)
    t = np.concatenate(t_l)
    npix = hp.nside2npix(nside)
    images = np.bincount(pix, minlength=npix)
    o = np.lexsort((t, pix))
    pix, t = pix[o], t[o]
    same = np.r_[False, pix[1:] == pix[:-1]]
    new_season = ~same | (np.r_[0, np.diff(t)] > SEASON_GAP)
    seasons = np.bincount(pix[new_season], minlength=npix)
    cov = {"scheme": "nested", "order": COV_ORDER,
           "note": "per HEALPix pixel: images = DR1+QR3 images whose footprint contains the pixel centre; "
                   f"seasons = groups of those images separated by gaps > {SEASON_GAP:g} days",
           "images": images.tolist(), "seasons": seasons.tolist()}
    (out_dir / "coverage.json").write_text(json.dumps(cov, separators=(",", ":")))
    frac = float((images > 0).mean())
    log(f"coverage: sky fraction {frac:.4f}, max images per pixel {images.max()}, "
        f"max seasons {seasons.max()}")
    return {"sky_fraction": frac}


def write_catalog(D, G, cache):
    """Full per-image catalog for Python use: <cache>/catalog.csv.gz (not published)."""
    import numpy as np
    f = cache / "catalog.csv.gz"
    plans = [p.split("|") for p in D["plans"]]
    rels = list(COLLECTIONS)
    ra_c, dec_c = G["raq"] * POS_UNIT, G["decq"] * POS_UNIT
    tmp = f.with_name(f.name + ".part")
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as g:
        w = csv.writer(g, lineterminator="\n")
        w.writerow(["obs_id", "collection", "detector", "t_min", "t_max", "em_min_um", "em_max_um",
                    "ra_center", "dec_center", "ra1", "dec1", "ra2", "dec2", "ra3", "dec3", "ra4", "dec4",
                    "s3_key"])
        for i in range(len(D["det"])):
            rel, plan, ver, rver = plans[D["plan"][i]]
            if D["retry"][i]:
                ver = rver
            det = int(D["det"][i])
            oid = f"{plan}_{int(D['seq'][i]):04d}_{int(D['sub'][i])}"
            t = int(D["t"][i]) * T_UNIT + T_ZERO
            lam = LAM_UM[str(det)]
            p = D["poly"][i]
            w.writerow([oid, rels[D["coll"][i]], det, f"{t:.6f}", f"{t + EXPOSURE_DAYS:.6f}", lam[0], lam[1],
                        f"{ra_c[i]:.5f}", f"{dec_c[i]:.5f}"] + [repr(float(x)) for x in p.reshape(-1)] +
                       [f"{rel}/level2/{plan}/{ver}/{det}/level2_{oid}D{det}_spx_{ver}.fits"])
    tmp.rename(f)
    log(f"catalog: {f} ({f.stat().st_size / 1e6:.0f} MB)")


def build(cache, out_dir, base_order, max_order, limit_kb):
    import numpy as np
    D = load(cache)
    G = geometry(D)
    N = len(D["det"])
    log(f"{N} images, assigning to order-{base_order} tiles")
    t0 = time.time()
    todo = [(base_order, p, idx) for p, idx in assign(G, D, np.arange(N), base_order).items()]
    log(f"  {len(todo)} tiles in {time.time() - t0:.0f}s")
    leaves = {}
    stats = []
    tile_dir = out_dir / "t"
    plan_width = 1 if len(D["plans"]) < 256 else 2
    while todo:
        order, pix, idx = todo.pop()
        blob = gzip.compress(encode_tile(np.array(idx), D, G), compresslevel=9, mtime=0)
        if len(blob) > limit_kb * 1024 and order < max_order:
            kids = assign(G, D, np.array(idx), order + 1, parent=pix, parent_order=order)
            todo += [(order + 1, p, i) for p, i in kids.items()]
            continue
        if len(blob) > limit_kb * 1024:
            log(f"  WARNING tile {order}/{pix} is {len(blob) / 1024:.0f} KB at max order")
        f = tile_dir / str(order) / f"{pix}.bin.gz"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(blob)
        leaves.setdefault(order, []).append(pix)
        stats.append((len(blob), len(idx), order, pix))
    keep = {f"{o}/{p}.bin.gz" for o, v in leaves.items() for p in v}
    stale = [f for f in tile_dir.glob("*/*.bin.gz") if f"{f.parent.name}/{f.name}" not in keep]
    if stale:
        log(f"WARNING: {len(stale)} tile files from an older build are not in the new manifest "
            f"(unused, safe to delete), e.g. {stale[0]}")
    cov = coverage(D, G, out_dir)
    sky_frac = cov["sky_fraction"]
    plans = [p.split("|") for p in D["plans"]]
    ends = {}
    for c, name in enumerate(COLLECTIONS):
        m = D["coll"] == c
        if not m.any():
            continue
        ends[name] = {"images": int(m.sum()),
                      "mjd_min": round(float(D["t"][m].min()) * T_UNIT + T_ZERO, 6),
                      "mjd_max": round(float(D["t"][m].max()) * T_UNIT + T_ZERO, 6)}
    sizes = sorted(s[0] for s in stats)
    manifest = {
        "format": "fazari-spherex-sky-index",
        "version": 1,
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "IRSA TAP spherex.obscore (calib_level 2) + spherex.artifact (retry folders) + S3 listing",
        "collections": ends,
        "s3_base": S3,
        "key_pattern": "{rel}/level2/{plan}/{ver}/{det}/level2_{plan}_{seq:04d}_{sub}D{det}_spx_{ver}.fits",
        "plans": [{"rel": r, "plan": p, "ver": v, "retry_ver": rv} for r, p, v, rv in plans],
        "plan_width": plan_width,
        "t_zero": T_ZERO, "t_unit": T_UNIT,
        "exposure_days": EXPOSURE_DAYS,
        "pos_unit": POS_UNIT, "res_unit": RES_UNIT, "ang_steps": ANG_STEPS,
        "templates": {str(d): G["tmpl"][d].tolist() for d in range(1, 7)},
        "lam_um": LAM_UM,
        "npix": 2040,
        "wave": wave_tables(),
        "default_margin": DEFAULT_MARGIN, "max_margin": MAX_MARGIN,
        "healpix": {"scheme": "nested", "base_order": base_order, "max_order": max_order},
        "tile_path": "t/{order}/{pix}.bin.gz",
        "tiles": {str(o): sorted(v) for o, v in sorted(leaves.items())},
        "stats": {"tiles": len(stats), "total_bytes": int(sum(sizes)), "largest_bytes": int(sizes[-1]),
                  "median_bytes": int(sizes[len(sizes) // 2]), "records": int(sum(s[1] for s in stats)),
                  "sky_fraction": round(sky_frac, 4), "coverage_order": COV_ORDER},
        "coverage_file": "coverage.json",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    log(f"wrote {len(stats)} tiles, {sum(sizes) / 1e6:.1f} MB, largest {sizes[-1] / 1024:.0f} KB, "
        f"records {manifest['stats']['records']}, sky fraction {sky_frac:.3f}")
    big = sorted(stats, reverse=True)[:5]
    log("largest tiles:", [(f"{o}/{p}", f"{b / 1024:.0f}KB", n) for b, n, o, p in big])


WAVE_TABLES = ROOT / "pipeline" / "wcs_wave_tables.json"


def wave_tables():
    """Central-wavelength control grids (WCS-WAVE) per detector, for approx_lam_um; {} if absent."""
    if not WAVE_TABLES.exists():
        log("note: no wcs_wave_tables.json, approx_lam_um falls back to a log-linear model")
        return {}
    d = json.loads(WAVE_TABLES.read_text())
    return {k: {"x": v["x"], "y": v["y"], "lam": [[round(c[0], 5) for c in row] for row in v["values"]]}
            for k, v in d.items() if not k.startswith("_")}


# per-detector wavelength range (micrometre), identical for spherex_dr1 and spherex_qr3 (checked with TAP)
LAM_UM = {"1": [0.7455, 1.1167], "2": [1.1033, 1.6499], "3": [1.6301, 2.4346],
          "4": [2.4027, 3.8473], "5": [3.8113, 4.4300], "6": [4.4115, 5.0096]}
DEFAULT_MARGIN = 0.001   # degree; same as the 0.001 deg SIA search circle of the reference lists
EXPOSURE_DAYS = 0.0013323785   # t_max - t_min of every image (TAP: 0.00133237799 .. 0.00133237900)


# ----------------------------------------------------------------------------- query

class Index:
    """Reads the built index the same way site/js/skyindex.js does."""

    def __init__(self, path):
        self.path = Path(path)
        self.m = json.loads((self.path / "manifest.json").read_text())
        self.leaves = {int(o): set(v) for o, v in self.m["tiles"].items()}
        import numpy as np
        self.tmpl = np.zeros((7, 4, 2))
        for d, t in self.m["templates"].items():
            self.tmpl[int(d)] = t

    def tile_for(self, ra, dec):
        for o in sorted(self.leaves, reverse=True):
            p = ang2pix_nest(o, ra, dec)
            if p in self.leaves[o]:
                return o, p
        return None

    def find(self, ra, dec, margin=None):
        import numpy as np
        margin = self.m["default_margin"] if margin is None else margin
        if not 0 <= margin <= self.m["max_margin"]:
            raise ValueError(f"margin must be within 0..{self.m['max_margin']} degree")
        tp = self.tile_for(ra, dec)
        if tp is None:
            return []
        f = self.path / self.m["tile_path"].format(order=tp[0], pix=tp[1])
        T = decode_tile(gzip.decompress(f.read_bytes()), self.m["plan_width"])
        ok = np.nonzero(point_in_images(ra, dec, T["raq"], T["decq"], T["angq"], T["res"],
                                        self.tmpl, T["det"], margin))[0]
        cx, cy = corners_model(T["raq"][ok], T["decq"][ok], T["angq"][ok], T["res"][ok], self.tmpl, T["det"][ok])
        out = []
        for j, i in enumerate(ok):
            r = self.record(T["plan"][i], T["seq"][i], T["sub"][i], T["det"][i], T["t"][i], T["retry"][i])
            ra0, dec0 = T["raq"][i] * POS_UNIT, T["decq"][i] * POS_UNIT
            r["ra_center"], r["dec_center"] = round(float(ra0), 5), round(float(dec0), 5)
            r["corners"] = [[round(a, 6), round(b, 6)] for a, b in
                            zip(*deproject(cx[j], cy[j], ra0, dec0))]
            c, e, n = tangent_basis(np.float64(ra0), np.float64(dec0))
            px, py, _ = project(unit(np.float64(ra), np.float64(dec)), c, e, n)
            u, v = quad_uv(float(px), float(py), cx[j], cy[j])
            r["approx_lam_um"] = approx_lambda(self.m, r["detector"], u, v)
            out.append(r)
        out.sort(key=lambda r: (r["mjd"], r["detector"]))
        return out

    def record(self, plan, seq, sub, det, t, retry):
        P = self.m["plans"][int(plan)]
        ver = P["retry_ver"] if retry else P["ver"]
        oid = f"{P['plan']}_{int(seq):04d}_{int(sub)}"
        det = int(det)
        key = f"{P['rel']}/level2/{P['plan']}/{ver}/{det}/level2_{oid}D{det}_spx_{ver}.fits"
        mjd = int(t) * self.m["t_unit"] + self.m["t_zero"]
        lam = self.m["lam_um"][str(det)]
        return {"obs_id": oid, "collection": P["rel"], "detector": det, "mjd": round(mjd, 6),
                "mjd_end": round(mjd + self.m["exposure_days"], 6), "s3_key": key,
                "url": self.m["s3_base"] + key, "lam_min_um": lam[0], "lam_max_um": lam[1]}


def approx_lambda(m, det, u, v):
    """Wavelength (um) at detector-frame (u, v): bilinear in the WCS-WAVE control grid when the
    manifest has it, else log-linear along y from lam_max (y = 0) to lam_min (y = 1)."""
    u, v = min(1.0, max(0.0, u)), min(1.0, max(0.0, v))
    w = m.get("wave", {}).get(str(det))
    if w:
        x = min(w["x"][-1], max(w["x"][0], 0.5 + u * m["npix"]))
        y = min(w["y"][-1], max(w["y"][0], 0.5 + v * m["npix"]))

        def cell(grid, val):
            i = 0
            while i < len(grid) - 2 and val > grid[i + 1]:
                i += 1
            span = grid[i + 1] - grid[i]
            return i, ((val - grid[i]) / span if span else 0.0)
        i, fx = cell(w["x"], x)
        k, fy = cell(w["y"], y)
        L = w["lam"]
        lam = ((1 - fy) * ((1 - fx) * L[k][i] + fx * L[k][i + 1]) +
               fy * ((1 - fx) * L[k + 1][i] + fx * L[k + 1][i + 1]))
        return round(lam, 4)
    lo, hi = m["lam_um"][str(det)]
    return round(math.exp(math.log(hi) - (math.log(hi) - math.log(lo)) * v), 4)


def quad_uv(px, py, cx, cy):
    """Detector-frame (u, v) in 0..1 of a tangent-plane point inside the quad whose corners are
    pixel (0,0) (1,0) (1,1) (0,1), by Newton inversion of the bilinear map."""
    cx, cy = [float(a) for a in cx], [float(a) for a in cy]
    e = (cx[1] - cx[0], cy[1] - cy[0])
    f = (cx[3] - cx[0], cy[3] - cy[0])
    g = (cx[0] - cx[1] + cx[2] - cx[3], cy[0] - cy[1] + cy[2] - cy[3])
    u = v = 0.5
    for _ in range(30):
        fx = cx[0] + u * e[0] + v * f[0] + u * v * g[0] - px
        fy = cy[0] + u * e[1] + v * f[1] + u * v * g[1] - py
        a, b, c, d = e[0] + v * g[0], f[0] + u * g[0], e[1] + v * g[1], f[1] + u * g[1]
        det = a * d - b * c
        if not det:
            break
        du, dv = (d * fx - b * fy) / det, (-c * fx + a * fy) / det
        u, v = u - du, v - dv
        if abs(du) + abs(dv) < 1e-12:
            break
    return u, v


def deproject(x, y, ra0, dec0):
    """Inverse gnomonic projection: tangent-plane x, y (degrees) about (ra0, dec0) -> RA, Dec lists."""
    import numpy as np
    c, e, n = tangent_basis(np.float64(ra0), np.float64(dec0))
    x, y = np.radians(np.asarray(x, float)), np.radians(np.asarray(y, float))
    v = c + x[:, None] * e + y[:, None] * n
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    ra = np.degrees(np.arctan2(v[:, 1], v[:, 0])) % 360.0
    dec = np.degrees(np.arcsin(np.clip(v[:, 2], -1, 1)))
    return ra.tolist(), dec.tolist()


def ang2pix_nest(order, ra, dec):
    """HEALPix nested pixel index of (ra, dec) in degrees (pure Python; same code as skyindex.js)."""
    nside = 1 << order
    z = math.sin(math.radians(dec))
    za = abs(z)
    tt = (math.radians(ra) % (2 * math.pi)) / (math.pi / 2)        # [0, 4)
    if tt >= 4:
        tt = 0.0
    if za <= 2 / 3:
        t1 = nside * (0.5 + tt)
        t2 = nside * z * 0.75
        jp = int(t1 - t2)
        jm = int(t1 + t2)
        ifp, ifm = jp >> order, jm >> order
        face = (ifp | 4) if ifp == ifm else (ifp if ifp < ifm else ifm + 8)
        ix = jm & (nside - 1)
        iy = nside - (jp & (nside - 1)) - 1
    else:
        ntt = min(3, int(tt))
        tp = tt - ntt
        tmp = nside * math.sqrt(3 * (1 - za))
        jp = min(nside - 1, int(tp * tmp))
        jm = min(nside - 1, int((1 - tp) * tmp))
        if z >= 0:
            face, ix, iy = ntt, nside - jm - 1, nside - jp - 1
        else:
            face, ix, iy = ntt + 8, jp, jm
    ipf = 0
    for b in range(order):
        ipf |= ((ix >> b) & 1) << (2 * b) | ((iy >> b) & 1) << (2 * b + 1)
    return face * nside * nside + ipf


_INDEX = {}
_BRUTE = {}


def find_images(ra, dec, margin=DEFAULT_MARGIN, index=None):
    """Images whose footprint contains (ra, dec) (degrees, ICRS), within `margin` degrees.

    Reads the static index (default <repo>/site/index). Returns a list of dicts sorted by time:
    obs_id, collection ('dr1'|'qr3'), detector (1..6), mjd (start), mjd_end, s3_key, url,
    lam_min_um, lam_max_um, ra_center, dec_center, corners ([[ra, dec] x 4], from the stored
    footprint model, accurate to ~0.2 arcsec). Needs numpy only.
    """
    path = Path(index) if index else OUT_DEFAULT
    if path not in _INDEX:
        _INDEX[path] = Index(path)
    return _INDEX[path].find(float(ra), float(dec), margin)


def brute_find(cache, ra, dec, margin=DEFAULT_MARGIN):
    """Reference answer straight from the cached IRSA polygons (no index)."""
    import numpy as np
    key = str(cache)
    if key not in _BRUTE:
        D = load(cache)
        v = unit(D["poly"][..., 0], D["poly"][..., 1]).sum(1)
        _BRUTE[key] = (D, v / np.linalg.norm(v, axis=1, keepdims=True))
    D, cen = _BRUTE[key]
    p = unit(np.float64(ra), np.float64(dec))
    cand = np.nonzero(cen @ p > math.cos(math.radians(3.0)))[0]      # half-diagonal is ~2.5 deg
    ok = cand[point_in_polygons(ra, dec, D["poly"][cand], margin)]
    plans = [p.split("|") for p in D["plans"]]
    rels = list(COLLECTIONS)
    out = []
    for i in ok:
        rel, plan = plans[D["plan"][i]][:2]
        out.append({"obs_id": f"{plan}_{int(D['seq'][i]):04d}_{int(D['sub'][i])}",
                    "collection": rels[D["coll"][i]], "detector": int(D["det"][i]),
                    "mjd": round(int(D["t"][i]) * T_UNIT + T_ZERO, 6)})
    return out


# ----------------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", help="metadata cache folder")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch", help="download the metadata into the cache")
    b = sub.add_parser("build", help="write site/index/ (and the full catalog into the cache)")
    b.add_argument("--out", default=str(OUT_DEFAULT))
    b.add_argument("--base-order", type=int, default=2)
    b.add_argument("--max-order", type=int, default=9)
    b.add_argument("--limit-kb", type=float, default=190, help="split tiles above this gzip size")
    b.add_argument("--no-catalog", action="store_true")
    q = sub.add_parser("query", help="print the images that contain a point")
    q.add_argument("--ra", type=float, required=True)
    q.add_argument("--dec", type=float, required=True)
    q.add_argument("--margin", type=float, default=DEFAULT_MARGIN, help="degree")
    q.add_argument("--index", default=str(OUT_DEFAULT))
    q.add_argument("--from-cache", action="store_true", help="use the cached IRSA polygons, not the index")
    q.add_argument("--json", action="store_true")
    c = sub.add_parser("check", help="compare the index with reference SIA lists and with the cache")
    c.add_argument("--refs", default=str(ROOT.parent / "veri" / "real_spherex"))
    c.add_argument("--index", default=str(OUT_DEFAULT))
    c.add_argument("--random", type=int, default=2000, help="random test points vs the cache")
    a = ap.parse_args(argv)
    cache = cache_dir(a.cache)
    if a.cmd == "fetch":
        fetch(cache)
    elif a.cmd == "build":
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        build(cache, out, a.base_order, a.max_order, a.limit_kb)
        if not a.no_catalog:
            write_catalog(load(cache), geometry(load(cache)), cache)
    elif a.cmd == "query":
        rows = (brute_find(cache, a.ra, a.dec, a.margin) if a.from_cache
                else find_images(a.ra, a.dec, a.margin, a.index))
        if a.json:
            print(json.dumps(rows, indent=1))
        else:
            for r in rows:
                print(f"{r['collection']}  {r['obs_id']:<20} D{r['detector']}  {r['mjd']:.6f}  {r.get('s3_key', '')}")
            n = {}
            for r in rows:
                n[(r["collection"], r["detector"])] = n.get((r["collection"], r["detector"]), 0) + 1
            print(f"{len(rows)} images; per collection/detector: "
                  + ", ".join(f"{k[0]} D{k[1]}: {v}" for k, v in sorted(n.items())), file=sys.stderr)
    elif a.cmd == "check":
        check(cache, Path(a.refs), Path(a.index), a.random)


def target_position(t, epoch=2026.0):
    """Linear proper motion to `epoch` (same as the reference list download)."""
    dt = epoch - t["epoch"]
    dec = t["dec"] + t["pmdec"] / 3.6e6 * dt
    ra = t["ra"] + t["pmra"] / 3.6e6 * dt / math.cos(math.radians(t["dec"]))
    return ra % 360.0, dec


def check(cache, refs, index, n_random):
    """Index vs reference SIA lists (5 targets) and vs brute force on the cache (random points)."""
    import numpy as np
    targets = json.loads((ROOT / "pipeline" / "targets.json").read_text())
    ok_all = True
    for name, t in targets.items():
        if name.startswith("_"):
            continue
        ra, dec = target_position(t)
        ref = set()
        for coll in COLLECTIONS:
            f = refs / name / f"liste_{coll}.csv"
            if not f.exists():
                continue
            lines = f.read_text().splitlines()
            hdr = next(csv.reader(lines[:1]))
            io_, ib = hdr.index("obs_id"), hdr.index("energy_bandpassname")
            for r in csv.reader(lines[1:]):
                ref.add((coll, r[io_], int(r[ib][-1])))
        got = {(r["collection"], r["obs_id"], r["detector"]) for r in find_images(ra, dec, index=index)}
        brute = {(r["collection"], r["obs_id"], r["detector"]) for r in brute_find(cache, ra, dec)}
        same = got == ref
        ok_all &= same
        print(f"{name:<11} ra {ra:.5f} dec {dec:+.5f}: index {len(got)}, reference {len(ref)}, cache {len(brute)}"
              f"  {'OK' if same else 'DIFF'}")
        for k in sorted(ref - got):
            print("   missing from index:", k, "in cache:", k in brute)
        for k in sorted(got - ref):
            print("   extra in index:", k, "in cache:", k in brute)
    # random points, plus points close to image corners (hardest case), vs the exact IRSA polygons
    D = load(cache)
    rng = np.random.default_rng(1)
    pts = [(float(rng.uniform(0, 360)), float(np.degrees(np.arcsin(rng.uniform(-1, 1))))) for _ in range(n_random)]
    for i in rng.choice(len(D["det"]), n_random // 2, replace=False):
        k = rng.integers(4)
        ra, dec = D["poly"][i, k]
        pts.append((float(ra + rng.normal(0, 0.003) / max(0.05, math.cos(math.radians(dec)))),
                    float(np.clip(dec + rng.normal(0, 0.003), -90, 90))))
    bad = tot = 0
    for ra, dec in pts:
        got = {(r["collection"], r["obs_id"], r["detector"]) for r in find_images(ra, dec, index=index)}
        brute = {(r["collection"], r["obs_id"], r["detector"]) for r in brute_find(cache, ra, dec)}
        loose = {(r["collection"], r["obs_id"], r["detector"]) for r in brute_find(cache, ra, dec, 0.0015)}
        tight = {(r["collection"], r["obs_id"], r["detector"]) for r in brute_find(cache, ra, dec, 0.0005)}
        tot += len(brute)
        if not (tight <= got <= loose):      # quantisation may only matter within 0.0005 deg of the edge
            bad += 1
            print(f"   random point {ra:.5f} {dec:+.5f}: index {len(got)} cache {len(brute)}"
                  f" missing {sorted(tight - got)[:3]} extra {sorted(got - loose)[:3]}")
        elif got != brute:
            pass
    print(f"random/corner points: {len(pts)}, image matches {tot}, failures {bad}")
    print("ALL OK" if ok_all and not bad else "SOME DIFFERENCES (see above)")


if __name__ == "__main__":
    main()
