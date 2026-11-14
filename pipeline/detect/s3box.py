"""Small pixel boxes of SPHEREx Level 2 images, read straight from the public S3 bucket.

Used by the known-asteroid recovery (asteroids.py). Only what a box needs is read:

  - PRIMARY + IMAGE header: one Range request (28.8 kB) per exposure (WCS with SIP, MJD-AVG,
    spacecraft position X_SC/Y_SC/Z_SC, PSF_FWHM, calibration ids);
  - IMAGE (and VARIANCE) pixels of a box: one Range request per row covering only the box
    columns (the layers are plain big-endian float32, 8160 bytes per full row), so a 33 x 33
    box costs 33 x 132 bytes per layer instead of 33 full rows;
  - FLAGS (RICE_1 tile-compressed, one tile per row): only when asked (diagnostics of missed
    objects), the compressed rows of the box (~4-5 kB per row);
  - VARIANCE needs the FLAGS header (its heap size moves the later HDUs): read once per
    exposure, only for exposures whose variance is used.

Header ranges are cached in cache/asteroids/s3/<key>/ (fetch_region.S3File), boxes as .npy in
cache/asteroids/boxes/<key>/. Every network byte is counted in STATS (the run reports it).
Downloaded data is untrusted: only FITS headers (parsed by astropy) and raw float/int arrays
are taken from it.
"""
import hashlib
import json
import math
import os
import re
import threading
import time
import urllib.parse
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

import blink as BL
import fetch_region as FR

CACHE = Path(os.environ.get("FAZARI_AST_CACHE") or (BL.ROOT / "cache" / "asteroids"))
STATS = FR.Stats()
HEAD_READ = FR.BLOCK + 25920            # PRIMARY + the longer IMAGE header seen (23040 / 25920)
FLAGS_HDR = 17280
EXT_HDR = 11520
ROW_BYTES = 2040 * 4
NPIX = 2040
WORKERS = 24                            # small row requests in flight (one keep-alive connection each)
EXPOSURE_HALF_DAYS = 0.000666           # index mjd = exposure start; MJD-AVG = start + ~57.5 s
EPSF_DIRS = [CACHE / "epsf", BL.ROOT / "cache" / "local" / "epsf"]   # second one: read-only seed
WAVE_TABLES = BL.PIPE / "wcs_wave_tables.json"
_pool = ThreadPoolExecutor(max_workers=WORKERS)
_lock = threading.Lock()
_wave = {}


def _safe(key):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", key)


def calib_id(header, name):
    for card in header.get("HISTORY", []):
        s = str(card)
        if f"[CALIB] {name} " in s + " ":
            return s.split()[-1]
    return None


class Exposure:
    """One full SPHEREx L2 detector image on S3, read lazily."""

    def __init__(self, key):
        self.key = key
        self.url = FR.S3_BASE + urllib.parse.quote(key)
        self.f = FR.S3File(key, CACHE / "s3", STATS)
        self._img = None
        self._var = None
        self._flags = None
        self.wcs = None
        self._lock = threading.RLock()          # header reads and WCS calls, one thread at a time

    # ------------------------------------------------------------------ headers
    def load(self):
        if self._img is not None:
            return self
        with self._lock:
            if self._img is None:
                with_retry(self._load, f"header {self.key}")
        return self

    def _load(self):
        self.f.read(0, HEAD_READ)
        prim = FR.read_header(self.f, 0, FR.BLOCK, 0)
        img = FR.read_header(self.f, prim.next_off, HEAD_READ - prim.next_off, 1)
        if img.name != "IMAGE" or img.header.get("NAXIS1") != NPIX or img.header.get("BITPIX") != -32:
            raise ValueError(f"unexpected IMAGE HDU in {self.key}: {img}")
        h = img.header
        self.header = h
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.wcs = FR.celestial_wcs(h)
        self.mjd = float(h.get("MJD-AVG", h.get("MJD-OBS")))
        self.detector = int(h["DETECTOR"])
        self.sc_km = np.array([float(h.get("X_SC", "nan")), float(h.get("Y_SC", "nan")), float(h.get("Z_SC", "nan"))])
        self.psf_fwhm_arcsec = float(h.get("PSF_FWHM", 0) or 0) or None
        self.xposure = float(h.get("XPOSURE", 0) or 0)
        self.epsf_id = calib_id(h, "epsf")
        self.wave_id = calib_id(h, "spectral_wcs")
        self._img = img

    def _layer_info(self, name):
        """HDUInfo of FLAGS or VARIANCE (FLAGS header first: its heap size places VARIANCE)."""
        self.load()
        with self._lock:
            return with_retry(lambda: self._layer_info_locked(name), f"{name} header {self.key}")

    def _layer_info_locked(self, name):
        if self._flags is None:
            fl = FR.read_header(self.f, self._img.next_off, FLAGS_HDR, 2)
            if fl.name != "FLAGS":
                fl = FR.scan_layout(self.f, upto="FLAGS")["FLAGS"]
            self._flags = fl
        if name == "FLAGS":
            return self._flags
        if self._var is None:
            v = FR.read_header(self.f, self._flags.next_off, EXT_HDR, 3)
            if v.name != "VARIANCE":
                v = FR.scan_layout(self.f, upto="VARIANCE")["VARIANCE"]
            self._var = v
        return self._var

    # ------------------------------------------------------------------ geometry
    def world2pix(self, ra, dec):
        """0-based full-detector pixel (x, y) of sky positions (SIP included)."""
        self.load()
        with self._lock, warnings.catch_warnings():
            warnings.simplefilter("ignore")
            x, y = self.wcs.all_world2pix(np.atleast_1d(ra), np.atleast_1d(dec), 0, tolerance=1e-7, maxiter=60,
                                          quiet=True)
        return np.asarray(x, float), np.asarray(y, float)

    def pix2world(self, x, y):
        self.load()
        with self._lock:
            r, d = self.wcs.all_pix2world(np.atleast_1d(x), np.atleast_1d(y), 0)
        return np.asarray(r, float), np.asarray(d, float)

    def wavelength(self, x, y):
        """Central wavelength (um) at full-detector pixel(s), from the per-detector WCS-WAVE table
        (pipeline/wcs_wave_tables.json) when the calibration id matches, else None."""
        self.load()
        if not _wave:
            try:
                _wave.update(json.loads(WAVE_TABLES.read_text()))
            except (OSError, ValueError):
                _wave["_none"] = True
        t = _wave.get(str(self.detector))
        if not t or (self.wave_id and t.get("calib_id") and t["calib_id"] != self.wave_id):
            return None
        xs, ys = np.asarray(t["x"], float), np.asarray(t["y"], float)
        vals = np.asarray(t["values"], float)[:, :, 0]
        fx = np.interp(np.asarray(x, float) + 1, xs, np.arange(xs.size))
        fy = np.interp(np.asarray(y, float) + 1, ys, np.arange(ys.size))
        ix = np.minimum(np.floor(fx).astype(int), xs.size - 2)
        iy = np.minimum(np.floor(fy).astype(int), ys.size - 2)
        tx, ty = fx - ix, fy - iy
        return ((1 - ty) * ((1 - tx) * vals[iy, ix] + tx * vals[iy, ix + 1])
                + ty * ((1 - tx) * vals[iy + 1, ix] + tx * vals[iy + 1, ix + 1]))

    # ------------------------------------------------------------------ pixels
    def box(self, layer, x0, y0, x1, y1):
        """Pixels [y0..y1, x0..x1] (inclusive, 0-based, clipped to the detector; outside = NaN / 0)
        of IMAGE, VARIANCE (float32) or FLAGS (int32)."""
        self.load()
        layer = layer.upper()
        cx0, cy0, cx1, cy1 = max(0, x0), max(0, y0), min(NPIX - 1, x1), min(NPIX - 1, y1)
        shape = (y1 - y0 + 1, x1 - x0 + 1)
        fill = 0 if layer == "FLAGS" else np.nan
        out = np.full(shape, fill, dtype=np.int32 if layer == "FLAGS" else np.float32)
        if cx0 > cx1 or cy0 > cy1:
            return out
        cdir = CACHE / "boxes" / _safe(self.key)
        cpath = cdir / f"{layer}_{cx0}_{cy0}_{cx1}_{cy1}.npy"
        part = None
        if cpath.exists():
            try:
                part = np.load(cpath, allow_pickle=False)
            except (OSError, ValueError):
                part = None
        if part is None:
            if layer == "FLAGS":
                info = self._layer_info("FLAGS")
                rows = with_retry(lambda: FR.read_compressed_rows(self.f, info, cy0, cy1), "FLAGS rows")
                part = np.asarray(rows[:, cx0:cx1 + 1], np.int32)
            else:
                info = self._img if layer == "IMAGE" else self._layer_info("VARIANCE")
                part = self._plain_rows(info.data_off, cx0, cy0, cx1, cy1)
            cdir.mkdir(parents=True, exist_ok=True)
            tmp = cdir / f".{cpath.name}.{threading.get_ident()}.tmp.npy"
            np.save(tmp, part)
            os.replace(tmp, cpath)
        out[cy0 - y0:cy1 - y0 + 1, cx0 - x0:cx1 - x0 + 1] = part
        return out

    def _plain_rows(self, data_off, x0, y0, x1, y1):
        nb = (x1 - x0 + 1) * 4

        def one(y):
            a = data_off + y * ROW_BYTES + x0 * 4
            t0 = time.monotonic()
            body, status = _get_range(self.url, a, a + nb - 1)
            STATS.add_net(len(body), time.monotonic() - t0)
            if status == 200:                       # Range ignored (never seen on S3)
                body = body[a:a + nb]
            if len(body) != nb:
                raise IOError(f"short read {len(body)} != {nb} at row {y} of {self.key}")
            return np.frombuffer(body, ">f4")
        rows = list(_pool.map(one, range(y0, y1 + 1)))
        return np.stack(rows).astype(np.float32)

    # ------------------------------------------------------------------ PSF
    def epsf(self, x, y):
        """(psf oversampled 2-D array summing to 1 over its grid, oversampling) of the EPSF row
        nearest full-detector pixel (x, y), when the EPSF calibration file is cached; else None."""
        self.load()
        if not self.epsf_id:
            return None
        for d in EPSF_DIRS:
            p = d / f"{self.epsf_id}.fits"
            if p.exists():
                return _epsf_from_file(p, x, y)
        return None


NET_PATIENCE_S = 1800                    # keep retrying network errors for up to 30 min


def with_retry(fn, what=""):
    """Run fn(); on network errors retry with backoff (1 s .. 60 s) for up to NET_PATIENCE_S.
    HTTP 4xx other than 429 is not retried (a real error, e.g. a missing file)."""
    t0, wait = time.monotonic(), 1.0
    while True:
        try:
            return fn()
        except Exception as ex:
            code = getattr(ex, "code", None)
            if code is not None and code not in FR.RETRY_CODES:
                raise
            if not isinstance(ex, (OSError, IOError, ConnectionError, TimeoutError)) and code is None and \
                    "http" not in type(ex).__module__:
                raise
            if time.monotonic() - t0 > NET_PATIENCE_S:
                raise
            print(f"  network error {type(ex).__name__} {what}; retry in {wait:.0f} s", flush=True)
            time.sleep(wait)
            wait = min(2 * wait, 60)


def _get_range(url, a, b):
    """One small ranged GET over the calling thread's keep-alive connection, with backoff."""
    def go():
        body, status, _ = FR._keepalive_get(url, {"User-Agent": FR.USER_AGENT, "Range": f"bytes={a}-{b}"}, 60)
        return body, status
    return with_retry(go, f"range {a}-{b}")


_EPSF_TABLES = {}


def _epsf_from_file(path, x, y):
    from astropy.io import fits
    if path not in _EPSF_TABLES:
        with fits.open(path, memmap=False) as h:
            t = h["EPSF"].data
            ovs = int(h["EPSF"].header.get("OVSMPX", 5))
            _EPSF_TABLES[path] = (np.asarray(t["XCENTER"], float), np.asarray(t["YCENTER"], float),
                                  np.asarray(t["EPSF"], float), ovs)
    xc, yc, tab, ovs = _EPSF_TABLES[path]
    k = int(np.argmin((xc - (x + 1)) ** 2 + (yc - (y + 1)) ** 2))
    psf = np.asarray(tab[k], float)
    if psf.ndim == 1:
        n = int(round(math.sqrt(psf.size)))
        psf = psf.reshape(n, n)
    return psf / psf.sum(), ovs


_EXP = {}


def exposure(key):
    with _lock:
        e = _EXP.get(key)
        if e is None:
            e = _EXP[key] = Exposure(key)
    return e.load()


def bytes_downloaded():
    return int(STATS.bytes_net)


def stats():
    return STATS.as_dict()


def digest(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:16]
