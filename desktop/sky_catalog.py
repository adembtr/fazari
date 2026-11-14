"""Star catalogue for the Fazari 3D sky viewer: a bright base layer plus Gaia DR3 HEALPix tiles.

Level of detail (LOD)
---------------------
The sky is never loaded at once. A small base layer (Gaia DR3 G < 7, about 21 000 stars, plus the
few naked-eye stars Gaia saturates on, from Hipparcos) is always drawn. Fainter stars come in
magnitude slices, each on its own HEALPix grid, so a tile always holds a few hundred to a few
thousand stars and about five tiles span the screen:

    level  HEALPix order  tile size  G range       needed when the field of view is below
      1         2          14.7 deg   7  - 10       ~62 deg
      2         4           3.7 deg   10 - 13       ~16 deg
      3         6           0.9 deg   13 - 16       ~3.9 deg
      4         8           0.23 deg  16 - 18.5     ~1.0 deg

Stars are drawn at epoch 2026.0: each tile also holds pmra/pmdec and the positions are moved from the
Gaia epoch 2016.0 in float64 before they go to the GPU (Barnard's Star moves 104" in those 10 years).

A Gaia DR3 source_id carries its level-12 nested HEALPix index (source_id // 2**35), so one tile is
a single range query on the primary key of gaiadr3.gaia_source at the ESA Gaia archive (about 1.4 s).
The CDS VizieR mirror at IDIA (cone search + HEALPix filter) is the fallback.

Threads: TileLoader runs at most 3 worker threads (= at most 3 catalogue requests in flight). The
GUI thread posts the wanted tiles with a priority (coarse levels first, then nearest to the view
centre); a worker takes the best wanted tile, reads it from the disk cache or the network, and puts
the result on a queue that the GUI thread drains. Tiles that are no longer wanted are skipped.
Everything fetched is cached on disk under fazari/cache/sky3d/ (gitignored).

Stars: ESA Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023), via the ESA Gaia archive and CDS VizieR.
"""
from __future__ import annotations

import heapq
import io
import math
import os
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent            # fazari/
CACHE = ROOT / "cache" / "sky3d"
UA = "fazari-spaceapps/1.0"
ESA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
VIZIER_ASU = ["https://vizier.idia.ac.za/viz-bin/asu-tsv", "https://vizier.cds.unistra.fr/viz-bin/asu-tsv"]
MAX_WORKERS = 3                                           # polite: at most 3 catalogue requests at once
TILE_MAX_STARS = 200_000

BASE_GMAX = 7.0
GAIA_EPOCH = 2016.0
EPOCH = 2026.0          # every star is drawn at this epoch (Gaia DR3 proper motion applied)
COLS = "ra, dec, phot_g_mean_mag, bp_rp, pmra, pmdec"
LEVELS = [
    {"level": 1, "order": 2, "gmin": 7.0, "gmax": 10.0},
    {"level": 2, "order": 4, "gmin": 10.0, "gmax": 13.0},
    {"level": 3, "order": 6, "gmin": 13.0, "gmax": 16.0},
    {"level": 4, "order": 8, "gmin": 16.0, "gmax": 18.5},
]
CREDIT = "Stars: ESA Gaia DR3 (Gaia Collaboration 2023), via the ESA Gaia archive / CDS VizieR"


def maglim_for_fov(fov_deg: float) -> float:
    """Faintest magnitude worth drawing at this vertical field of view (deg)."""
    return float(np.clip(6.5 + 5.0 * math.log10(90.0 / max(fov_deg, 1e-3)), 6.5, 19.0))


def radec_to_xyz(ra_deg, dec_deg):
    ra = np.radians(np.asarray(ra_deg, dtype=np.float64))
    dec = np.radians(np.asarray(dec_deg, dtype=np.float64))
    c = np.cos(dec)
    return np.stack([c * np.cos(ra), c * np.sin(ra), np.sin(dec)], axis=-1)


def propagate(ra, dec, pmra, pmdec, dt):
    """Linear proper motion (mas/yr) over dt years, as local/serve.py moves the catalogue positions.
    Returns ra, dec in degrees (ICRS)."""
    pmra = np.nan_to_num(np.asarray(pmra, np.float64))
    pmdec = np.nan_to_num(np.asarray(pmdec, np.float64))
    dec2 = np.asarray(dec, np.float64) + pmdec / 3.6e6 * dt
    ra2 = np.asarray(ra, np.float64) + pmra / 3.6e6 * dt / np.maximum(np.cos(np.radians(dec)), 1e-6)
    return np.mod(ra2, 360.0), np.clip(dec2, -90.0, 90.0)


def to_gpu(rows: np.ndarray, epoch: float = EPOCH) -> np.ndarray:
    """(N,6) ra, dec, G, BP-RP, pmra, pmdec at the Gaia epoch -> (N,5) float32 x, y, z, G, BP-RP
    at `epoch`, sorted by G (bright first). Positions are computed in float64."""
    if rows.size == 0:
        return np.zeros((0, 5), np.float32)
    rows = rows[np.argsort(rows[:, 2], kind="stable")]
    out = np.empty((len(rows), 5), np.float32)
    ra, dec = rows[:, 0], rows[:, 1]
    if rows.shape[1] >= 6:
        ra, dec = propagate(ra, dec, rows[:, 4], rows[:, 5], epoch - GAIA_EPOCH)
    out[:, :3] = radec_to_xyz(ra, dec)
    out[:, 3] = rows[:, 2]
    c = rows[:, 3]
    out[:, 4] = np.where(np.isfinite(c), c, 0.82)          # no colour: draw it Sun-like
    return out


# ------------------------------------------------------------------------------- network
def _http(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _with_backoff(fn, tries=3, base=2.0, stop=None):
    err = None
    for i in range(tries):
        if stop is not None and stop.is_set():
            raise RuntimeError("stopped")
        try:
            return fn()
        except urllib.error.HTTPError as e:
            err = e
            if e.code in (400, 404):                     # a bad query will not get better
                break
        except Exception as e:                           # timeouts, resets, DNS
            err = e
        time.sleep(base * (2 ** i))
    raise err if err else RuntimeError("request failed")


def _parse_csv(text: str) -> np.ndarray:
    lines = text.strip().splitlines()
    if not lines or "ra" not in lines[0].lower():
        raise ValueError("unexpected TAP answer: " + text[:200])
    ncol = len(lines[0].split(","))
    out = []
    for ln in lines[1:]:
        f = ln.split(",")
        if len(f) < ncol:
            continue
        try:
            out.append([float(x) if x.strip() else math.nan for x in f[:ncol]])
        except ValueError:
            continue
    return np.array(out, dtype=np.float64).reshape(-1, ncol)


def esa_query(adql: str, timeout=90, stop=None) -> np.ndarray:
    data = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                   "QUERY": adql}).encode()
    return _parse_csv(_with_backoff(lambda: _http(ESA_TAP, data, timeout), stop=stop))


def vizier_cone(source, ra, dec, radius_deg, cols, constraints, timeout=90, stop=None) -> list[list[str]]:
    """Rows (list of str fields, in `cols` order) of a VizieR cone search; mirrors in turn."""
    q = {"-source": source, "-c": f"{ra:.6f} {dec:+.6f}", "-c.rd": f"{radius_deg:.5f}",
         "-out": ",".join(cols), "-out.max": str(TILE_MAX_STARS)}
    q.update(constraints)
    err = None
    for base in VIZIER_ASU:
        url = base + "?" + urllib.parse.urlencode(q)
        try:
            text = _with_backoff(lambda: _http(url, None, timeout), tries=2, stop=stop)
        except Exception as e:
            err = e
            continue
        rows, head = [], None
        for ln in text.splitlines():
            if not ln or ln.startswith("#"):
                continue
            f = [s.strip() for s in ln.split("\t")]
            if head is None:
                head = f
                if cols[0] not in head:
                    break
                continue
            if not f or not any(ch.isdigit() for ch in f[0]):
                continue                                   # units and dashes rows
            rows.append([f[head.index(c)] if c in head and head.index(c) < len(f) else "" for c in cols])
        if head is not None and cols[0] in head:
            return rows
        err = ValueError("unexpected VizieR answer")
    raise err if err else RuntimeError("VizieR failed")


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return math.nan


# ------------------------------------------------------------------------------- base layer
def base_cache_path() -> Path:
    return CACHE / f"base_gaia_g{BASE_GMAX:g}_pm.npy"      # ra, dec, G, BP-RP, pmra, pmdec (epoch 2016.0)


def load_base_cached() -> np.ndarray | None:
    p = base_cache_path()
    if p.exists():
        try:
            return np.load(p, allow_pickle=False)
        except Exception:
            return None
    return None


def fetch_base(stop=None) -> np.ndarray:
    """Gaia DR3 G < 7 (all sky) plus the Hipparcos naked-eye stars that Gaia lacks. Cached."""
    rows = esa_query(f"SELECT {COLS} FROM gaiadr3.gaia_source "
                     f"WHERE phot_g_mean_mag < {BASE_GMAX}", timeout=180, stop=stop)
    try:   # the brightest stars saturate Gaia; take them from Hipparcos (V, B-V) if Gaia has nothing there
        hip = vizier_cone("I/239/hip_main", 0.0, 0.0, 180.0, ["HIP", "RAICRS", "DEICRS", "Vmag", "B-V", "pmRA", "pmDE"],
                          {"Vmag": "<4.5"}, stop=stop)
        h = np.array([[_num(x) for x in r[1:7]] for r in hip], np.float64).reshape(-1, 6)
        h = h[np.isfinite(h[:, :3]).all(axis=1)]
        if len(h):
            g = rows[rows[:, 2] < 6.0]
            dots = radec_to_xyz(h[:, 0], h[:, 1]) @ radec_to_xyz(g[:, 0], g[:, 1]).T
            missing = dots.max(axis=1) < math.cos(math.radians(30 / 3600)) if len(g) else np.ones(len(h), bool)
            add = h[missing]
            # Hipparcos positions are epoch 1991.25: move them to the Gaia epoch; rough V -> G and
            # B-V -> BP-RP for display only
            ra16, dec16 = propagate(add[:, 0], add[:, 1], add[:, 4], add[:, 5], GAIA_EPOCH - 1991.25)
            add = np.column_stack([ra16, dec16, add[:, 2] - 0.15 * np.nan_to_num(add[:, 3]),
                                   0.05 + 1.25 * add[:, 3], add[:, 4], add[:, 5]])
            rows = np.vstack([rows, add])
    except Exception:
        pass
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = base_cache_path().with_suffix(".tmp.npy")
    np.save(tmp, rows)
    os.replace(tmp, base_cache_path())
    return rows


# ------------------------------------------------------------------------------- tiles
def tile_path(level: dict, pix: int) -> Path:
    return CACHE / "gaia" / f"o{level['order']}_g{level['gmin']:g}-{level['gmax']:g}_pm" / f"{pix}.npy"


def fetch_tile(level: dict, pix: int, stop=None) -> tuple[np.ndarray, str]:
    """Rows (N,6) ra, dec, G, BP-RP, pmra, pmdec (Gaia epoch 2016.0) of one tile; (rows, source)."""
    order = level["order"]
    shift = 35 + 2 * (12 - order)
    lo, hi = pix << shift, ((pix + 1) << shift) - 1
    try:
        rows = esa_query(f"SELECT {COLS} FROM gaiadr3.gaia_source "
                         f"WHERE source_id BETWEEN {lo} AND {hi} "
                         f"AND phot_g_mean_mag >= {level['gmin']} AND phot_g_mean_mag < {level['gmax']}",
                         stop=stop)
        return rows, "esa"
    except Exception:
        if stop is not None and stop.is_set():
            raise
    # fallback: VizieR cone around the tile, then keep the stars that fall in this HEALPix pixel
    from astropy_healpix import HEALPix
    import astropy.units as u
    hp = HEALPix(nside=2 ** order, order="nested")
    lon, lat = hp.healpix_to_lonlat([pix])
    radius = hp.pixel_resolution.to_value(u.deg) * 1.0
    rr = vizier_cone("I/355/gaiadr3", lon.to_value(u.deg)[0], lat.to_value(u.deg)[0], radius,
                     ["RA_ICRS", "DE_ICRS", "Gmag", "BP-RP", "pmRA", "pmDE"],
                     {"Gmag": f"{level['gmin']}..{level['gmax']}"}, stop=stop)
    rows = np.array([[_num(x) for x in r] for r in rr], np.float64).reshape(-1, 6)
    rows = rows[np.isfinite(rows[:, :3]).all(axis=1)]
    if len(rows):
        keep = hp.lonlat_to_healpix(rows[:, 0] * u.deg, rows[:, 1] * u.deg) == pix
        rows = rows[keep & (rows[:, 2] < level["gmax"])]
    return rows, "vizier"


class TileLoader:
    """Priority-ordered background loading of (level index, pixel) tiles.

    GUI thread: want(list of (score, key)); drain() -> list of finished results.
    Workers: take the best wanted key, load from disk or network, post (key, gpu array, info)."""

    def __init__(self, workers=MAX_WORKERS):
        self._cv = threading.Condition()
        self._heap: list = []
        self._wanted: set = set()
        self._inflight: set = set()
        self._failed: dict = {}                            # key -> time it may be retried
        self.results: queue.Queue = queue.Queue()
        self.stop = threading.Event()
        self.stats = {"net": 0, "disk": 0, "fail": 0, "net_s": 0.0, "fallback": 0}
        self._threads = [threading.Thread(target=self._run, daemon=True, name=f"tiles-{i}")
                         for i in range(workers)]
        for t in self._threads:
            t.start()

    def want(self, scored_keys, resident):
        now = time.monotonic()
        with self._cv:
            self._wanted = {k for _, k in scored_keys}
            self._heap = [(s, k) for s, k in scored_keys
                          if k not in resident and k not in self._inflight and self._failed.get(k, 0) <= now]
            heapq.heapify(self._heap)
            self._cv.notify_all()

    @property
    def pending(self) -> int:
        with self._cv:
            return len(self._heap) + len(self._inflight)

    def close(self):
        self.stop.set()
        with self._cv:
            self._cv.notify_all()

    def _run(self):
        while not self.stop.is_set():
            with self._cv:
                while not self._heap and not self.stop.is_set():
                    self._cv.wait(0.5)
                if self.stop.is_set():
                    return
                _, key = heapq.heappop(self._heap)
                if key not in self._wanted or key in self._inflight:
                    continue
                self._inflight.add(key)
            li, pix = key
            level = LEVELS[li]
            t0 = time.perf_counter()
            src = "disk"
            try:
                p = tile_path(level, pix)
                rows = None
                if p.exists():
                    try:
                        rows = np.load(p, allow_pickle=False)
                    except Exception:
                        rows = None
                if rows is None:
                    rows, src = fetch_tile(level, pix, stop=self.stop)
                    p.parent.mkdir(parents=True, exist_ok=True)
                    tmp = p.with_suffix(".tmp.npy")
                    np.save(tmp, rows)
                    os.replace(tmp, p)
                    self.stats["net"] += 1
                    self.stats["net_s"] += time.perf_counter() - t0
                    if src != "esa":
                        self.stats["fallback"] += 1
                else:
                    self.stats["disk"] += 1
                arr = to_gpu(rows[:TILE_MAX_STARS] if len(rows) > TILE_MAX_STARS else rows)
                self.results.put((key, arr, {"src": src, "s": time.perf_counter() - t0}))
            except Exception as e:
                self.stats["fail"] += 1
                with self._cv:
                    self._failed[key] = time.monotonic() + 60.0
                self.results.put((key, None, {"src": "error", "error": str(e)[:200]}))
            finally:
                with self._cv:
                    self._inflight.discard(key)


def wanted_tiles(center_radec, radius_deg, fov_deg, hp_cache: dict) -> list:
    """[(score, (level index, pix))] for the tiles that cover the view at this zoom."""
    from astropy_healpix import HEALPix
    import astropy.units as u
    maglim = maglim_for_fov(fov_deg)
    ra0, dec0 = center_radec
    c0 = radec_to_xyz(ra0, dec0)
    out = []
    for li, lv in enumerate(LEVELS):
        if maglim <= lv["gmin"] + 0.3:
            break
        hp = hp_cache.get(lv["order"])
        if hp is None:
            hp = hp_cache[lv["order"]] = HEALPix(nside=2 ** lv["order"], order="nested")
        res = hp.pixel_resolution.to_value(u.deg)
        r = min(radius_deg + 0.8 * res, 179.0)
        pix = hp.cone_search_lonlat(ra0 * u.deg, dec0 * u.deg, r * u.deg)
        lon, lat = hp.healpix_to_lonlat(pix)
        d = np.degrees(np.arccos(np.clip(radec_to_xyz(lon.to_value(u.deg), lat.to_value(u.deg)) @ c0, -1, 1)))
        order = np.argsort(d)[:160]                        # never more than 160 tiles per level
        for i in order:
            out.append((li * 10.0 + float(d[i]) / max(radius_deg, 1e-3), (li, int(pix[i]))))
    return out
