#!/usr/bin/env python3
"""Reads a small sky region out of full SPHEREx Level 2 images on AWS S3 with HTTP Range requests.

Reference reader for Fazari (NASA Space Apps 2026). It reproduces IRSA's cutout service
(`<ibe access_url>?center=<ra>,<dec>&size=<deg>`) pixel for pixel, but reads only the rows it needs
(about 2.6 MB per image for IMAGE+FLAGS+ZODI instead of a 62 MB file). Byte layout: pipeline/S3_LAYOUT.md.

Usage (from the fazari/ folder):
  uv run --no-project --with astropy --with numpy python -I pipeline/fetch_region.py \\
      --target barnard --collection dr1 --limit 4
  ... pipeline/fetch_region.py --ra 162.3289 --dec -53.3194 --collection dr1 --limit 3   # image list from IRSA SIA
  ... pipeline/fetch_region.py --ra R --dec D --images liste_dr1.csv --size-px 64 --edge pad

As a library:
  from fetch_region import read_region, write_cutout
  r = read_region(s3_key, ra, dec, size_deg=0.2, layers=("IMAGE", "FLAGS", "ZODI"))
  r["arrays"]["IMAGE"], r["headers"]["IMAGE"], r["wcs"], r["wavelength"], r["geometry"], r["stats"]

Byte ranges are cached in <repo>/cache/s3/ (gitignored); set --cache DIR or FAZARI_S3_CACHE to move it.
"""
import argparse
import csv
import http.client
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

ROOT = Path(__file__).resolve().parent.parent            # fazari/
S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
USER_AGENT = "fazari-spaceapps/1.0"
DEFAULT_CACHE = Path(os.environ.get("FAZARI_S3_CACHE", ROOT / "cache" / "s3"))
COLLECTIONS = {"dr1": "spherex_dr1", "qr3": "spherex_qr3"}
BLOCK = 2880
MAX_PARALLEL = 4                  # polite limit for S3 and IRSA: at most 4 requests in flight
RETRY_CODES = (429, 500, 502, 503, 504)
LAYERS_ALL = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")
DEFAULT_LAYERS = ("IMAGE", "FLAGS", "ZODI")

# First read: PRIMARY (2880) + IMAGE header (23040 or 25920 seen) in one request.
FIRST_READ = 12 * BLOCK
# FLAGS header (17280 seen) + its 2040*8 byte descriptor table in one request.
FLAGS_READ = 6 * BLOCK + 2040 * 8
# VARIANCE / ZODI headers (11520 seen).
IMAGE_HDR_READ = 4 * BLOCK
# WCS-WAVE = last 2 blocks of the file (header + 720-byte table).
WAVE_TAIL = 2 * BLOCK

_HTTP_SLOTS = threading.BoundedSemaphore(MAX_PARALLEL)


def pad2880(n):
    return (n + BLOCK - 1) // BLOCK * BLOCK


def iround(x):
    """Round half up (floor(x + 0.5)); IRSA's rounding for pixel positions and sizes."""
    return int(math.floor(x + 0.5))


# ----------------------------------------------------------------------------------------------
# HTTP with retries, statistics and an on-disk range cache
# ----------------------------------------------------------------------------------------------

class Stats:
    """Thread-safe counters: network requests/bytes/seconds and cache hits."""

    def __init__(self):
        self._lock = threading.Lock()
        self.requests = 0
        self.bytes_net = 0
        self.seconds_net = 0.0
        self.cache_hits = 0
        self.bytes_cache = 0

    def add_net(self, nbytes, seconds):
        with self._lock:
            self.requests += 1
            self.bytes_net += nbytes
            self.seconds_net += seconds

    def add_cache(self, nbytes):
        with self._lock:
            self.cache_hits += 1
            self.bytes_cache += nbytes

    def as_dict(self):
        return {"requests": self.requests, "bytes_net": self.bytes_net,
                "seconds_net": round(self.seconds_net, 3), "cache_hits": self.cache_hits,
                "bytes_cache": self.bytes_cache}


_local = threading.local()


def _keepalive_get(url, headers, timeout):
    """GET over a per-thread persistent HTTPS connection (saves the TLS handshake on every range)."""
    u = urllib.parse.urlsplit(url)
    pool = getattr(_local, "pool", None)
    if pool is None:
        pool = _local.pool = {}
    conn = pool.get(u.netloc)
    if conn is None:
        conn = pool[u.netloc] = http.client.HTTPSConnection(u.netloc, timeout=timeout)
    path = u.path + ("?" + u.query if u.query else "")
    for fresh in (False, True):
        try:
            conn.request("GET", path, headers=headers)
            resp = conn.getresponse()
            body = resp.read()
            break
        except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError):
            conn.close()                       # idle connection closed by the server: reconnect once
            conn = pool[u.netloc] = http.client.HTTPSConnection(u.netloc, timeout=timeout)
            if fresh:
                pool.pop(u.netloc, None)
                raise
        except Exception:
            conn.close()
            pool.pop(u.netloc, None)
            raise
    if resp.status >= 400:
        raise urllib.error.HTTPError(url, resp.status, resp.reason, resp.headers, None)
    return body, resp.status, resp.headers


def http_get(url, byte_range=None, timeout=60, retries=6):
    """GET with optional Range header ("bytes=a-b" or "bytes=-n").

    At most MAX_PARALLEL requests run at once (process wide). Exponential backoff on 429/5xx and
    network errors. S3 requests reuse a persistent connection per thread. Returns (body, status, headers)."""
    headers = {"User-Agent": USER_AGENT}
    if byte_range:
        headers["Range"] = byte_range
    wait = 1.0
    for attempt in range(1, retries + 1):
        error = None
        with _HTTP_SLOTS:
            try:
                if url.startswith(S3_BASE):
                    return _keepalive_get(url, headers, timeout)
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return resp.read(), resp.status, resp.headers
            except urllib.error.HTTPError as e:
                if e.code not in RETRY_CODES or attempt == retries:
                    raise
                retry_after = e.headers.get("Retry-After") if e.headers else None
                if retry_after and retry_after.isdigit():
                    wait = max(wait, float(retry_after))
                error = f"HTTP {e.code}"
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, http.client.HTTPException) as e:
                if attempt == retries:
                    raise
                error = str(e)[:80]
        print(f"  retry {attempt}/{retries - 1} after {error}; waiting {wait:.0f} s", file=sys.stderr)
        time.sleep(wait)
        wait = min(wait * 2, 60)
    raise RuntimeError("unreachable")


class S3File:
    """Byte-range reader for one S3 object, with an on-disk cache of the ranges read.

    A request is served from the cache when one cached range covers it."""

    def __init__(self, key, cache_dir=DEFAULT_CACHE, stats=None):
        self.key = key
        self.url = S3_BASE + urllib.parse.quote(key)
        self.stats = stats or Stats()
        self.size = None
        self.cache = None
        self._mem = []                         # ranges read in this session: (start, end, bytes)
        self._lock = threading.Lock()
        if cache_dir:
            self.cache = Path(cache_dir) / re.sub(r"[^A-Za-z0-9_.-]+", "_", key)
            self.cache.mkdir(parents=True, exist_ok=True)
            size_file = self.cache / "size"
            if size_file.exists():
                self.size = int(size_file.read_text())

    def _cached(self, start, end):
        with self._lock:
            for a, b, data in self._mem:
                if a <= start and end <= b:
                    return data[start - a:end - a]
        if not self.cache:
            return None
        exact = self.cache / f"{start}-{end}.bin"
        if exact.exists():
            return exact.read_bytes()
        for p in self.cache.glob("*.bin"):
            a, b = (int(v) for v in p.stem.split("-"))
            if a <= start and end <= b:
                with open(p, "rb") as fh:
                    fh.seek(start - a)
                    return fh.read(end - start)
        return None

    def _store(self, start, end, data):
        if end - start <= 1 << 20:              # keep small ranges (headers, tables) in memory
            with self._lock:
                self._mem.append((start, end, data))
        if not self.cache:
            return
        tmp = self.cache / f".{start}-{end}.{threading.get_ident()}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, self.cache / f"{start}-{end}.bin")

    def _set_size(self, content_range):
        if content_range and "/" in content_range:
            total = content_range.rsplit("/", 1)[1]
            if total.isdigit():
                self.size = int(total)
                if self.cache and not (self.cache / "size").exists():
                    (self.cache / "size").write_text(str(self.size))

    def read(self, start, end):
        """Bytes [start, end) of the object."""
        if self.size is not None:
            end = min(end, self.size)
        if end <= start:
            return b""
        data = self._cached(start, end)
        if data is not None:
            self.stats.add_cache(len(data))
            return data
        t0 = time.monotonic()
        data, status, headers = http_get(self.url, f"bytes={start}-{end - 1}")
        self.stats.add_net(len(data), time.monotonic() - t0)
        if status == 206:
            self._set_size(headers.get("Content-Range"))
        elif status == 200:                    # server ignored Range: we got the whole object
            self.size = len(data)
            data = data[start:end]
        if len(data) != min(end, self.size or end) - start:
            raise IOError(f"short read {len(data)} for {start}-{end} of {self.key}")
        self._store(start, start + len(data), data)
        return data

    def read_tail(self, n):
        """The last n bytes (suffix range; also learns the file size)."""
        if self.size is not None:
            return self.read(self.size - n, self.size)
        t0 = time.monotonic()
        data, status, headers = http_get(self.url, f"bytes=-{n}")
        self.stats.add_net(len(data), time.monotonic() - t0)
        if status != 206:
            raise IOError(f"suffix range not honoured for {self.key}")
        self._set_size(headers.get("Content-Range"))
        self._store(self.size - len(data), self.size, data)
        return data


# ----------------------------------------------------------------------------------------------
# FITS structure
# ----------------------------------------------------------------------------------------------

def find_end_card(buf):
    """Byte index of the END card in a header buffer, or None."""
    for i in range(0, len(buf) - 79, 80):
        if buf[i:i + 3] == b"END" and buf[i:i + 80].rstrip(b" ") == b"END":
            return i
    return None


class HDUInfo:
    """Location of one HDU in the file and its parsed header."""

    def __init__(self, index, hdr_off, hlen, header):
        self.index = index
        self.hdr_off = hdr_off
        self.hlen = hlen
        self.header = header
        self.data_off = hdr_off + hlen
        h = header
        naxis = h.get("NAXIS", 0)
        n = 1 if naxis else 0
        for i in range(1, naxis + 1):
            n *= h[f"NAXIS{i}"]
        self.datasize = abs(h["BITPIX"]) // 8 * h.get("GCOUNT", 1) * (h.get("PCOUNT", 0) + n)
        self.next_off = self.data_off + pad2880(self.datasize)
        self.name = h.get("EXTNAME", "PRIMARY" if index == 0 else f"HDU{index}").strip()

    def __repr__(self):
        return (f"HDU({self.index} {self.name} hdr@{self.hdr_off} len {self.hlen} "
                f"data@{self.data_off} size {self.datasize})")


def read_header(f, offset, guess, index):
    """Reads and parses the header that starts at `offset` (reads `guess` bytes, more if needed)."""
    buf = f.read(offset, offset + guess)
    while True:
        end = find_end_card(buf)
        if end is not None:
            break
        if f.size is not None and offset + len(buf) >= f.size:
            raise IOError(f"no END card in header at {offset} of {f.key}")
        buf += f.read(offset + len(buf), offset + len(buf) + 4 * BLOCK)
    hlen = pad2880(end + 80)
    text = buf[:end + 80].decode("latin-1")
    if index > 0 and not text.startswith("XTENSION"):
        raise IOError(f"expected an extension header at {offset} of {f.key}")
    if index == 0 and not text.startswith("SIMPLE"):
        raise IOError(f"not a FITS file: {f.key}")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        header = fits.Header.fromstring(text)
    return HDUInfo(index, offset, hlen, header)


def scan_layout(f, upto="ZODI"):
    """Walks the HDU headers from the start of the file up to EXTNAME `upto` (inclusive).

    Returns {EXTNAME: HDUInfo}. Each step costs one ranged GET (FLAGS also gets its descriptor table)."""
    hdus = {}
    info = read_header(f, 0, FIRST_READ, 0)
    hdus["PRIMARY"] = info
    guesses = {1: FIRST_READ - info.next_off, 2: FLAGS_READ}
    index = 1
    while True:
        if f.size is not None and info.next_off >= f.size:
            break
        info = read_header(f, info.next_off, max(guesses.get(index, IMAGE_HDR_READ), BLOCK), index)
        hdus[info.name] = info
        if info.name == upto:
            break
        index += 1
    return hdus


def read_wave_hdu(f):
    """WCS-WAVE table HDU from the file tail (falls back to walking all headers)."""
    tail = f.read_tail(WAVE_TAIL)
    end = find_end_card(tail)
    if tail.startswith(b"XTENSION= 'BINTABLE'") and end is not None and b"WCS-WAVE" in tail[:end]:
        raw = tail
    else:                                                # unexpected layout: walk the headers
        hdus = scan_layout(f, upto="WCS-WAVE")
        info = hdus["WCS-WAVE"]
        raw = f.read(info.hdr_off, info.next_off)
    primary = fits.PrimaryHDU().header.tostring().encode("ascii")
    hdul = fits.HDUList.fromstring(primary + raw)
    return hdul[1]


# ----------------------------------------------------------------------------------------------
# RICE_1 decoding (pure Python reference; astropy's C codec is used when available)
# ----------------------------------------------------------------------------------------------

def rice_decode(buf, npix, blocksize=32, bytepix=4):
    """Decodes one RICE_1 tile (cfitsio fits_rdecomp, 32-bit). Returns an int32 array of npix values.

    Kept simple on purpose: this is the reference for the JavaScript port."""
    if bytepix != 4:
        raise NotImplementedError("only BYTEPIX=4 (int32) is implemented")
    fsbits, fsmax, bbits, mask32 = 5, 25, 32, 0xFFFFFFFF
    out = [0] * npix
    lastpix = int.from_bytes(buf[0:4], "big")
    pos = 4
    b = buf[pos]
    pos += 1
    nbits = 8                                  # number of unread bits held in b (the low bits)
    i = 0
    while i < npix:
        nbits -= fsbits                        # read the 5-bit code -> fs
        while nbits < 0:
            b = (b << 8) | buf[pos]
            pos += 1
            nbits += 8
        fs = (b >> nbits) - 1
        b &= (1 << nbits) - 1
        imax = min(i + blocksize, npix)
        if fs < 0:                             # low entropy: all differences are zero
            for k in range(i, imax):
                out[k] = lastpix
            i = imax
            continue
        for k in range(i, imax):
            if fs == fsmax:                    # high entropy: raw 32-bit differences
                kk = bbits - nbits
                diff = b << kk
                kk -= 8
                while kk >= 0:
                    diff |= buf[pos] << kk
                    pos += 1
                    kk -= 8
                if nbits > 0:
                    b = buf[pos]
                    pos += 1
                    diff |= b >> (-kk)
                    b &= (1 << nbits) - 1
                else:
                    b = 0
                diff &= mask32
            else:                              # unary prefix (count zeros) + fs low bits
                while b == 0:
                    nbits += 8
                    b = buf[pos]
                    pos += 1
                nzero = nbits - b.bit_length()
                nbits -= nzero + 1
                b ^= 1 << nbits                # drop the leading 1 bit
                nbits -= fs
                while nbits < 0:
                    b = (b << 8) | buf[pos]
                    pos += 1
                    nbits += 8
                diff = (nzero << fs) | (b >> nbits)
                b &= (1 << nbits) - 1
            diff = (~(diff >> 1)) & mask32 if diff & 1 else diff >> 1
            lastpix = (diff + lastpix) & mask32
            out[k] = lastpix
        i = imax
    return np.array(out, dtype=np.uint32).view(np.int32)


def _rice_decoder(blocksize, bytepix, npix):
    try:
        from astropy.io.fits.hdu.compressed._codecs import Rice1
        codec = Rice1(blocksize=blocksize, bytepix=bytepix, tilesize=npix)
        return lambda raw: np.asarray(codec.decode(np.frombuffer(raw, np.uint8)), dtype=np.int32)
    except Exception:                                   # astropy internals moved: use the reference
        return lambda raw: rice_decode(raw, npix, blocksize, bytepix)


# ----------------------------------------------------------------------------------------------
# Reading rows of a layer
# ----------------------------------------------------------------------------------------------

def read_plain_rows(f, info, y0, y1):
    """Rows y0..y1 (inclusive, 0-based) of an uncompressed 2-D image HDU, full width."""
    h = info.header
    width = h["NAXIS1"]
    dtype = {-32: ">f4", -64: ">f8", 8: "u1", 16: ">i2", 32: ">i4", 64: ">i8"}[h["BITPIX"]]
    rowbytes = width * np.dtype(dtype).itemsize
    raw = f.read(info.data_off + y0 * rowbytes, info.data_off + (y1 + 1) * rowbytes)
    return np.frombuffer(raw, dtype).reshape(y1 - y0 + 1, width)


def read_compressed_rows(f, info, y0, y1, decoder=None):
    """Rows y0..y1 of a tile-compressed (ZIMAGE) HDU whose tiles span the full width (ZTILE1 = ZNAXIS1)."""
    h = info.header
    if h.get("ZCMPTYPE", "").strip() != "RICE_1":
        raise NotImplementedError(f"compression {h.get('ZCMPTYPE')} not implemented")
    width, height = h["ZNAXIS1"], h["ZNAXIS2"]
    tw, th = h.get("ZTILE1", width), h.get("ZTILE2", 1)
    if tw != width:
        raise NotImplementedError("tiles narrower than the image are not implemented")
    if h.get("TFIELDS", 1) != 1 or not h["TFORM1"].strip().startswith(("1PB", "PB")):
        raise NotImplementedError(f"unexpected compressed table layout TFORM1={h['TFORM1']}")
    params = {h.get(f"ZNAME{i}", "").strip(): h.get(f"ZVAL{i}") for i in range(1, 10)}
    blocksize, bytepix = params.get("BLOCKSIZE", 32), params.get("BYTEPIX", 4)
    if h["ZBITPIX"] != 32 or bytepix != 4:
        raise NotImplementedError("only ZBITPIX=32 / BYTEPIX=4 is implemented")
    rowlen = h["NAXIS1"]                                    # 8 bytes: (nbytes, offset) as >i4
    heap = info.data_off + h.get("THEAP", rowlen * h["NAXIS2"])
    t0, t1 = y0 // th, y1 // th
    desc = np.frombuffer(f.read(info.data_off + t0 * rowlen, info.data_off + (t1 + 1) * rowlen),
                         ">i4").reshape(-1, 2)
    nbytes, offs = desc[:, 0].astype(np.int64), desc[:, 1].astype(np.int64)
    lo, hi = int(offs.min()), int((offs + nbytes).max())
    blob = f.read(heap + lo, heap + hi)
    decode = decoder or _rice_decoder(blocksize, bytepix, tw * th)
    tiles = []
    for n, o, t in zip(nbytes, offs, range(t0, t1 + 1)):
        rows_in_tile = min(th, height - t * th)
        if decoder is None and rows_in_tile != th:
            values = rice_decode(blob[o - lo:o - lo + n], tw * rows_in_tile, blocksize, bytepix)
        else:
            values = decode(blob[o - lo:o - lo + n])
        tiles.append(np.asarray(values, np.int32)[:tw * rows_in_tile].reshape(rows_in_tile, tw))
    rows = np.concatenate(tiles, axis=0)
    return rows[y0 - t0 * th:y1 - t0 * th + 1]


def read_rows(f, info, y0, y1):
    if info.header.get("ZIMAGE", False):
        return read_compressed_rows(f, info, y0, y1)
    return read_plain_rows(f, info, y0, y1)


# ----------------------------------------------------------------------------------------------
# Sparse layers: ZODI and VARIANCE modelled from a few rows (local engine, fewer bytes)
# ----------------------------------------------------------------------------------------------
# A full row of a plain layer is 2040 x 4 = 8160 bytes, so ZODI and VARIANCE of a 0.4 deg box
# (234 rows) cost 1.9 MB each, as much as IMAGE. Both are smooth: ZODI is the zodiacal-light
# model, VARIANCE is read noise + photon noise of IMAGE. With `sparse=("ZODI", "VARIANCE")`
# read_region reads only SPARSE_ROWS rows of them (box columns only, ~1 kB each) and models:
#   ZODI      per column a quadratic in y through the sampled rows (tested on 45 0.4 deg
#             cutouts: 99 % of the pixels within 0.03 sigma of the true model, worst 0.1 sigma)
#   VARIANCE  a + b * IMAGE, a and b fitted on the good pixels of the sampled rows (median
#             per-pixel error 4 %); pixels where IMAGE is not finite are NaN as in the real layer
# The cutout headers say so (FZSPARSE, FZMODEL). Bad fits fall back to the full rows.
SPARSE_ROWS = 5
SPARSE_BAD_BITS = 1 | 2 | 4 | 64 | 512 | 1024 | 2048 | 32768   # blink.py BAD_BITS | SAT_BITS


def sparse_row_list(y0, y1, n=SPARSE_ROWS):
    """n rows spread evenly over y0..y1 (inclusive), first and last included."""
    return sorted({int(round(v)) for v in np.linspace(y0, y1, max(2, min(n, y1 - y0 + 1)))})


def read_plain_row_part(f, info, y, x0, x1):
    """Columns x0..x1 of row y of an uncompressed 2-D image HDU (one small range)."""
    h = info.header
    dtype = {-32: ">f4", -64: ">f8", 32: ">i4"}[h["BITPIX"]]
    size = np.dtype(dtype).itemsize
    start = info.data_off + (y * h["NAXIS1"] + x0) * size
    return np.frombuffer(f.read(start, start + (x1 - x0 + 1) * size), dtype)


def model_zodi(rows_y, rows, y0, y1):
    """ZODI on rows y0..y1 from sampled rows: per-column quadratic (linear for < 4 rows) in y."""
    ry = np.asarray(rows_y, float) - y0
    deg = 2 if len(ry) >= 4 else len(ry) - 1
    z = np.asarray(rows, float)
    good = np.all(np.isfinite(z), axis=0)
    c = np.polyfit(ry, np.where(good, z, 0.0), deg)            # (deg+1, ncol)
    yy = np.arange(y1 - y0 + 1, dtype=float)
    out = sum(c[k][None, :] * yy[:, None] ** (deg - k) for k in range(deg + 1))
    if not good.all():                    # a NaN in a sampled row (not seen in 5.6 M ZODI pixels): column mean
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            out[:, ~good] = np.nanmean(z[:, ~good], axis=0)[None, :]
    return out.astype(np.float32)


def model_variance(rows_y, vrows, image, flags, y0):
    """VARIANCE = a + b * IMAGE fitted on the good pixels of the sampled rows; None if the fit is poor."""
    v = np.asarray(vrows, float)
    im = np.asarray(image[[r - y0 for r in rows_y]], float)
    ok = np.isfinite(v) & np.isfinite(im) & (v > 0)
    if flags is not None:
        ok &= (np.asarray(flags[[r - y0 for r in rows_y]]).astype(np.int64) & SPARSE_BAD_BITS) == 0
    if ok.sum() < 50:
        return None, None
    x, y = im[ok], v[ok]
    use = np.ones(len(x), bool)
    for _ in range(3):                                          # clip outliers (cosmic rays, hot pixels)
        A = np.vstack([np.ones(use.sum()), x[use]]).T
        (a, b), *_ = np.linalg.lstsq(A, y[use], rcond=None)
        r = y / np.maximum(a + b * x, 1e-30) - 1
        new = np.abs(r) < 5 * max(1.4826 * np.median(np.abs(r[use])), 0.01)
        if new.sum() < 50 or (new == use).all():
            break
        use = new
    if not (a > 0 and b >= 0):
        return None, None
    model = a + b * np.asarray(image, float)
    model = np.where(np.isfinite(model), np.maximum(model, 0.5 * a), np.nan)
    rel = float(np.median(np.abs(y[use] / (a + b * x[use]) - 1)))
    return model.astype(np.float32), {"a": float(a), "b": float(b), "median_rel_err": round(rel, 4),
                                      "n_fit": int(use.sum())}


# ----------------------------------------------------------------------------------------------
# WCS, IRSA cutout geometry, cutout headers
# ----------------------------------------------------------------------------------------------

_COMPRESSION_KEYS = re.compile(
    r"^(Z(IMAGE|TENSION|SIMPLE|EXTEND|BLOCKED|BITPIX|NAXIS\d*|PCOUNT|GCOUNT|TILE\d+|CMPTYPE|NAME\d+|VAL\d+"
    r"|QUANTIZ|DITHER0|HECKSUM|DATASUM)|TFIELDS|TTYPE\d+|TFORM\d+|TDIM\d+|THEAP)$")
_SIP_KEYS = re.compile(r"^(A|B|AP|BP)_(ORDER|\d+_\d+)$")


def celestial_wcs(header):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return WCS(header, relax=True)


def image_header(info):
    """Header of an image HDU as an uncompressed image header (FLAGS: drop the tile-compression keys)."""
    h = info.header.copy()
    if not h.get("ZIMAGE", False):
        return h
    zbitpix, znaxis = h["ZBITPIX"], h["ZNAXIS"]
    dims = [h[f"ZNAXIS{i}"] for i in range(1, znaxis + 1)]
    for k in list(h.keys()):
        if _COMPRESSION_KEYS.match(k):
            del h[k]
    h["XTENSION"] = "IMAGE"
    h["BITPIX"] = zbitpix
    h["NAXIS"] = znaxis
    for i, n in enumerate(dims, 1):
        h[f"NAXIS{i}"] = n
    h["PCOUNT"] = 0
    h["GCOUNT"] = 1
    return h


def shift_header(h, x0, y0, nx, ny):
    """Cutout header: NAXIS1/2 = nx/ny and every CRPIX1/2 (primary and alternate keys) shifted by (x0, y0).

    Same float arithmetic as IRSA: the new primary CRPIX is rounded to 15 significant digits, and the
    alternate keys (A, W, ...) are shifted by the difference old CRPIX - new CRPIX
    (e.g. CRPIX2 1135.6 -> 692.6, CRPIX2A 1.0 -> -441.9999999999999)."""
    h = h.copy()
    h["NAXIS1"], h["NAXIS2"] = nx, ny
    for axis, shift in ((1, x0), (2, y0)):
        k = f"CRPIX{axis}"
        delta = shift
        if k in h:
            new = float(f"{float(h[k]) - shift:.15g}")
            delta = float(h[k]) - new
            h[k] = new
        for alt in [chr(c) for c in range(ord("A"), ord("Z") + 1)]:
            if k + alt in h:
                h[k + alt] = float(h[k + alt]) - delta
    return h


def pixel_of(wcs, ra, dec):
    """0-based pixel (x, y) of (ra, dec) with the full SIP WCS, or None if the point is far off the image."""
    ra0, dec0 = wcs.wcs.crval
    cos_sep = (math.sin(math.radians(dec)) * math.sin(math.radians(dec0))
               + math.cos(math.radians(dec)) * math.cos(math.radians(dec0)) * math.cos(math.radians(ra - ra0)))
    if cos_sep < math.cos(math.radians(10.0)):           # image is ~3.5 deg wide
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        lin = wcs.wcs_world2pix([[ra, dec]], 0)[0]
        if not np.all(np.isfinite(lin)) or np.any(np.abs(lin - 1020) > 5000):
            return None
        try:
            p = wcs.all_world2pix([[ra, dec]], 0, tolerance=1e-8, maxiter=50)[0]
        except Exception:
            p = wcs.all_world2pix([[ra, dec]], 0, tolerance=1e-8, maxiter=50, quiet=True)[0]
    return float(p[0]), float(p[1])


def irsa_geometry(wcs, ra, dec, shape, size_deg=0.2, size_px=None):
    """Pixel box of IRSA's cutout `center=ra,dec&size=size_deg` (see S3_LAYOUT.md).

    shape = (ny, nx) of the full image. Returns a dict; all pixel indices 0-based, ranges inclusive.
    x0u/y0u/nx/ny = the unclipped box; x0..x1, y0..y1 = the box clipped to the image (what IRSA returns)."""
    height, width = shape
    p = pixel_of(wcs, ra, dec)
    if p is None:
        return {"overlap": False, "contains": False, "reason": "target far outside image"}
    px, py = p
    if size_px:
        nx = ny = int(size_px)
    else:
        cd = wcs.wcs.get_pc() * wcs.wcs.cdelt[:, None]
        sx, sy = math.hypot(cd[0, 0], cd[1, 0]), math.hypot(cd[0, 1], cd[1, 1])
        nx, ny = iround(size_deg / sx), iround(size_deg / sy)
    x0u, y0u = iround(px - (nx - 1) / 2), iround(py - (ny - 1) / 2)
    x0, y0 = max(0, x0u), max(0, y0u)
    x1, y1 = min(width - 1, x0u + nx - 1), min(height - 1, y0u + ny - 1)
    g = {"px": px, "py": py, "nx": nx, "ny": ny, "x0u": x0u, "y0u": y0u,
         "x0": x0, "x1": x1, "y0": y0, "y1": y1,
         "contains": bool(-0.5 <= px < width - 0.5 and -0.5 <= py < height - 0.5),
         "overlap": bool(x0 <= x1 and y0 <= y1)}
    g["clipped"] = bool(g["overlap"] and (x1 - x0 + 1 != nx or y1 - y0 + 1 != ny))
    if not g["overlap"]:
        g["reason"] = "region outside image"
    return g


# ----------------------------------------------------------------------------------------------
# Wavelength (alternate WCS 'W', WAVE-TAB lookup in the WCS-WAVE table)
# ----------------------------------------------------------------------------------------------

def wave_lookup(header, table_hdu, x, y):
    """Central wavelength and bandwidth (um) at 0-based pixel(s) (x, y) of the image `header` describes.

    Bilinear interpolation on the WCS-WAVE control grid (FITS Paper III -TAB, as astropy/wcslib do it)."""
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    t = table_hdu.data
    out = []
    for axis in (1, 2):
        col_vals = header.get(f"PS{axis}_1W", "VALUES").strip()
        m = int(header.get(f"PV{axis}_3W", axis)) - 1
        values = np.asarray(t[col_vals][0], float)               # shape (len(Y), len(X), 2) = [iy, ix, m]
        xs = np.asarray(t[header.get("PS1_2W", "X").strip()][0], float)
        ys = np.asarray(t[header.get("PS2_2W", "Y").strip()][0], float)
        # intermediate coordinates psi = CRVAL + CDELT * (p - CRPIX), p 1-based (PC is identity)
        psx = header.get("CRVAL1W", 1) + header.get("CDELT1W", 1) * (x + 1 - header.get("CRPIX1W", 1))
        psy = header.get("CRVAL2W", 1) + header.get("CDELT2W", 1) * (y + 1 - header.get("CRPIX2W", 1))
        fx = np.interp(psx, xs, np.arange(xs.size))
        fy = np.interp(psy, ys, np.arange(ys.size))
        ix = np.minimum(np.floor(fx).astype(int), xs.size - 2)
        iy = np.minimum(np.floor(fy).astype(int), ys.size - 2)
        tx, ty = fx - ix, fy - iy
        g = values[:, :, m]
        out.append((1 - ty) * ((1 - tx) * g[iy, ix] + tx * g[iy, ix + 1])
                   + ty * ((1 - tx) * g[iy + 1, ix] + tx * g[iy + 1, ix + 1]))
    return out[0], out[1]


# ----------------------------------------------------------------------------------------------
# Main entry point
# ----------------------------------------------------------------------------------------------

# Layout facts used to guess offsets (always verified; see S3_LAYOUT.md).
IMAGE_DATA_BYTES = 2040 * 2040 * 4
KNOWN_IMAGE_HLEN = (23040, 25920)
EXT_HLEN = 4 * BLOCK                                       # VARIANCE / ZODI header length seen
FLAGS_GUESS = (BLOCK + min(KNOWN_IMAGE_HLEN) + IMAGE_DATA_BYTES,
               BLOCK + max(KNOWN_IMAGE_HLEN) + IMAGE_DATA_BYTES + FLAGS_READ)


class _Located:
    """Predicted position of a plain image layer: same shape/BITPIX as `header`, data at `data_off`."""

    def __init__(self, header, data_off):
        self.header = header
        self.data_off = data_off


def _run_parallel(fns):
    if len(fns) == 1:
        return [fns[0]()]
    with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, len(fns))) as ex:
        return list(ex.map(lambda fn: fn(), fns))


def _run_serial(fns):
    return [fn() for fn in fns]


def locate_hdus(f, with_flags=True):
    """PRIMARY, IMAGE (and FLAGS) headers; served from the round-1 reads when the guesses hold."""
    prim = read_header(f, 0, FIRST_READ, 0)
    img = read_header(f, prim.next_off, max(FIRST_READ - prim.next_off, BLOCK), 1)
    hdus = {"PRIMARY": prim, "IMAGE": img}
    if img.name != "IMAGE":
        return scan_layout(f, upto="ZODI")
    if with_flags:
        flags = read_header(f, img.next_off, FLAGS_READ, 2)
        if flags.name != "FLAGS":
            return scan_layout(f, upto="ZODI")
        hdus["FLAGS"] = flags
    return hdus


def read_region(key, ra, dec, size_deg=0.2, size_px=None, layers=DEFAULT_LAYERS, edge="clip",
                cache_dir=DEFAULT_CACHE, wave=True, stats=None, parallel=True, sparse=()):
    """Reads the region around (ra, dec) from the full L2 image `key` on S3.

    edge="clip": IRSA-identical (box clipped at the image border, smaller arrays).
    edge="pad":  always ny x nx; outside pixels are NaN (float layers) or 0 (FLAGS).
    sparse: layers among ("ZODI", "VARIANCE") modelled from SPARSE_ROWS rows instead of read in
    full (see model_zodi / model_variance; result["sparse"] describes the models).
    Returns a dict with keys: key, ok, reason, geometry, arrays{layer: ndarray}, headers{layer: Header},
    primary_header, wcs (cutout celestial WCS), wave_hdu, wavelength, obs, stats."""
    layers = [s.strip().upper() for s in layers]
    for layer in layers:
        if layer not in LAYERS_ALL:
            raise ValueError(f"unknown layer {layer}; choose from {LAYERS_ALL}")
    stats = stats or Stats()
    t_start = time.monotonic()
    f = S3File(key, cache_dir, stats)
    run = _run_parallel if parallel else _run_serial

    # Round trip 1 (parallel): PRIMARY + IMAGE header; FLAGS header + descriptor table at the guessed offset
    # (it only depends on the IMAGE header length, 23040 or 25920 so far); WCS-WAVE from the file tail.
    need_flags_block = any(layer in layers for layer in ("FLAGS", "VARIANCE", "ZODI"))
    first = [lambda: f.read(0, FIRST_READ)]
    if need_flags_block:
        first.append(lambda: f.read(*FLAGS_GUESS))
    if wave:
        first.append(lambda: read_wave_hdu(f))
    got = run(first)
    wave_hdu = got[-1] if wave else None
    hdus = locate_hdus(f, need_flags_block)
    img = hdus["IMAGE"]
    full_wcs = celestial_wcs(img.header)
    shape = (img.header["NAXIS2"], img.header["NAXIS1"])
    g = irsa_geometry(full_wcs, ra, dec, shape, size_deg=size_deg, size_px=size_px)
    h = img.header
    result = {"key": key, "ok": False, "geometry": g, "arrays": {}, "headers": {},
              "primary_header": hdus["PRIMARY"].header,
              "obs": {"obsid": h.get("OBSID"), "detector": h.get("DETECTOR"), "date_avg": h.get("DATE-AVG"),
                      "mjd_avg": h.get("MJD-AVG"), "xposure": h.get("XPOSURE")}}
    if not g["overlap"]:
        result["reason"] = g.get("reason", "no overlap")
        result["stats"] = dict(stats.as_dict(), seconds=round(time.monotonic() - t_start, 3))
        return result

    if edge == "clip":
        bx0, by0, bnx, bny = g["x0"], g["y0"], g["x1"] - g["x0"] + 1, g["y1"] - g["y0"] + 1
    elif edge == "pad":
        bx0, by0, bnx, bny = g["x0u"], g["y0u"], g["nx"], g["ny"]
    else:
        raise ValueError("edge must be 'clip' or 'pad'")
    y0, y1 = g["y0"], g["y1"]

    # Round trip 2 (parallel): rows of every layer. VARIANCE/ZODI positions are predicted from the
    # FLAGS heap size and the usual 11520-byte headers; their headers are read in the same round and checked.
    tasks, names = [], []
    pred = {}
    sparse = [s.strip().upper() for s in sparse if s.strip().upper() in ("ZODI", "VARIANCE") and s.strip().upper() in layers]
    if "VARIANCE" in sparse and not ("IMAGE" in layers and "FLAGS" in layers):
        sparse.remove("VARIANCE")                         # the model needs IMAGE and FLAGS of the box
    srows = sparse_row_list(y0, y1) if sparse else []
    if "VARIANCE" in layers or "ZODI" in layers:
        var_hdr = hdus["FLAGS"].next_off
        zodi_hdr = var_hdr + EXT_HLEN + pad2880(img.datasize)
        pred = {"VARIANCE": (3, var_hdr), "ZODI": (4, zodi_hdr)}
    for layer in layers:
        if layer in pred:
            index, hdr_off = pred[layer]
            guess = _Located(img.header, hdr_off + EXT_HLEN)
            tasks.append(lambda i=index, o=hdr_off: read_header(f, o, EXT_HLEN, i))
            names.append(("hdr", layer))
            if layer in sparse:                           # a few short ranges instead of all rows
                for r in srows:
                    tasks.append(lambda gi=guess, r=r: read_plain_row_part(f, gi, r, g["x0"], g["x1"]))
                    names.append(("srow", layer, r))
                continue
            tasks.append(lambda gi=guess: read_plain_rows(f, gi, y0, y1))
        else:
            tasks.append(lambda info=hdus[layer]: read_rows(f, info, y0, y1))
        names.append(("rows", layer))
    done = dict(zip(names, run(tasks)))
    for layer in pred:
        if layer not in layers:
            continue
        info = done[("hdr", layer)]
        if info.name != layer or info.hdr_off != pred[layer][1] or info.hlen != EXT_HLEN:
            # unusual layout: walk the headers and read the rows again from the true offset
            info = scan_layout(f, upto="ZODI")[layer]
            done[("rows", layer)] = read_plain_rows(f, info, y0, y1)
            if layer in sparse:
                sparse.remove(layer)
        hdus[layer] = info

    parts, sparse_info = {}, {}
    for layer in layers:
        if layer in sparse:
            continue
        part = done[("rows", layer)][:, g["x0"]:g["x1"] + 1]
        parts[layer] = part.astype(part.dtype.newbyteorder("="))
    if "ZODI" in sparse:
        parts["ZODI"] = model_zodi(srows, [done[("srow", "ZODI", r)] for r in srows], y0, y1)
        sparse_info["ZODI"] = {"rows": srows, "model": f"per-column polynomial in y through {len(srows)} rows"}
    if "VARIANCE" in sparse:
        model, fit = model_variance(srows, [done[("srow", "VARIANCE", r)] for r in srows],
                                    parts["IMAGE"], parts["FLAGS"], y0)
        if model is None:                                 # poor fit: read the real rows after all
            part = read_plain_rows(f, hdus["VARIANCE"], y0, y1)[:, g["x0"]:g["x1"] + 1]
            parts["VARIANCE"] = part.astype(part.dtype.newbyteorder("="))
        else:
            parts["VARIANCE"] = model
            sparse_info["VARIANCE"] = dict(fit, rows=srows, model="a + b * IMAGE")
    if sparse_info:
        result["sparse"] = sparse_info

    for layer in layers:
        part = parts[layer]
        if edge == "pad":
            fill = np.nan if part.dtype.kind == "f" else 0
            full = np.full((bny, bnx), fill, dtype=part.dtype)
            full[g["y0"] - by0:g["y1"] - by0 + 1, g["x0"] - bx0:g["x1"] - bx0 + 1] = part
            part = full
        result["arrays"][layer] = part
        result["headers"][layer] = shift_header(image_header(hdus[layer]), bx0, by0, bnx, bny)
        if layer in sparse_info:
            si = sparse_info[layer]
            hh = result["headers"][layer]
            hh["FZSPARSE"] = (len(si["rows"]), "layer modelled from this many rows (fetch_region)")
            hh["FZMODEL"] = (si["model"], "model of the sparse layer")
            if layer == "VARIANCE":
                hh["FZVAR_A"] = (si["a"], "VARIANCE model: a + b * IMAGE")
                hh["FZVAR_B"] = (si["b"], "VARIANCE model: a + b * IMAGE")
                hh["FZVARERR"] = (si["median_rel_err"], "median |true/model - 1| on the sampled rows")
    if wave:
        result["wave_hdu"] = wave_hdu
    result["layout"] = {name: {"hdr_off": i.hdr_off, "hlen": i.hlen, "data_off": i.data_off,
                               "datasize": i.datasize} for name, i in hdus.items()}

    ref = result["headers"].get("IMAGE") or shift_header(image_header(img), bx0, by0, bnx, bny)
    result["wcs"] = celestial_wcs(ref)
    if wave:
        wl, bw = wave_lookup(img.header, result["wave_hdu"], g["px"], g["py"])
        yy, xx = np.mgrid[0:bny, 0:bnx]
        wmap, bmap = wave_lookup(ref, result["wave_hdu"], xx, yy)
        result["wavelength"] = {"um_at_target": float(wl), "bandwidth_um_at_target": float(bw),
                                "um_min": float(wmap.min()), "um_max": float(wmap.max())}
        result["wavelength_map"], result["bandwidth_map"] = wmap.astype(np.float32), bmap.astype(np.float32)
    if edge == "pad" and g["clipped"]:
        result["padded"] = {"left": g["x0"] - bx0, "right": bx0 + bnx - 1 - g["x1"],
                            "bottom": g["y0"] - by0, "top": by0 + bny - 1 - g["y1"]}
    result["box"] = {"x0": bx0, "y0": by0, "nx": bnx, "ny": bny, "edge": edge}
    result["ok"] = True
    reasons = ([] if g["contains"] else ["target outside image, region overlaps it"]) + \
        (["clipped at image border" + (", NaN padded" if edge == "pad" else "")] if g["clipped"] else [])
    result["reason"] = "; ".join(reasons)
    result["stats"] = dict(stats.as_dict(), seconds=round(time.monotonic() - t_start, 3))
    return result


def write_cutout(result, path, ra=None, dec=None, size=None):
    """Writes the region as a FITS file laid out like an IRSA cutout (EPSF is not included)."""
    prim = fits.PrimaryHDU(header=result["primary_header"].copy())
    ph = prim.header
    ph["FZSRCKEY"] = (result["key"], "S3 key of the full image")
    ph["FZEDGE"] = (result["box"]["edge"], "clip = IRSA-like, pad = NaN padded")
    ph["FZX0"] = (result["box"]["x0"], "0-based full-image column of cutout pixel 0")
    ph["FZY0"] = (result["box"]["y0"], "0-based full-image row of cutout pixel 0")
    ph["FZCLIP"] = (bool(result["geometry"]["clipped"]), "region crosses the image border")
    if ra is not None:
        ph["FZRA"], ph["FZDEC"] = (ra, "requested centre RA [deg]"), (dec, "requested centre Dec [deg]")
    if size is not None:
        ph["FZSIZE"] = (str(size), "requested size")
    hdul = fits.HDUList([prim])
    for layer in LAYERS_ALL:
        if layer in result["arrays"]:
            hdul.append(fits.ImageHDU(data=result["arrays"][layer], header=result["headers"][layer]))
    if "wave_hdu" in result:
        hdul.append(result["wave_hdu"].copy())
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        hdul.writeto(path, overwrite=True)
    return path


# ----------------------------------------------------------------------------------------------
# Image lists (SIA CSV, IRSA SIA query, sky index)
# ----------------------------------------------------------------------------------------------

def key_from_url(url):
    m = re.search(r"/ibe/data/spherex/(.+?\.fits)", url or "")
    return m.group(1) if m else None


def read_image_list(csv_path):
    """Rows of an IRSA SIA CSV as dicts {key, t_min, band, obs_id}.

    The S3 key comes from `cloud_access` (JSON; may be split across columns in hand-written CSVs)
    or else from `access_url`."""
    out = []
    with open(csv_path, newline="") as fh:
        lines = fh.read().splitlines()
    if not lines:
        return out
    head = next(csv.reader([lines[0]]))
    col = {name: i for i, name in enumerate(head)}
    for line in lines[1:]:
        if not line.strip():
            continue
        row = next(csv.reader([line]))
        m = re.search(r'"key"\s*:\s*"([^"]+)"', line) or re.search(r'""key""\s*:\s*""([^"]+)""', line)
        url = row[col["access_url"]] if "access_url" in col and col["access_url"] < len(row) else ""
        key = m.group(1) if m else key_from_url(url)
        if not key:
            continue

        def get(name):
            i = col.get(name)
            return row[i] if i is not None and i < len(row) else ""
        out.append({"key": key, "t_min": float(get("t_min") or "nan"), "band": get("energy_bandpassname"),
                    "obs_id": get("obs_id")})
    return out


def sia_query(ra, dec, collection="dr1", radius=0.001, cache_dir=DEFAULT_CACHE):
    """Image list from IRSA SIA for a point (cached as CSV under cache_dir)."""
    params = {"COLLECTION": COLLECTIONS[collection], "POS": f"CIRCLE {ra} {dec} {radius}",
              "RESPONSEFORMAT": "CSV"}
    url = SIA_URL + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    path = None
    if cache_dir:
        path = Path(cache_dir) / "sia" / f"sia_{collection}_{ra:.5f}_{dec:+.5f}_{radius}.csv"
        if path.exists():
            return read_image_list(path)
    body, status, _ = http_get(url, timeout=300, retries=8)
    if path is None:
        path = Path(os.environ.get("TMPDIR", "/tmp")) / f"fazari_sia_{os.getpid()}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return read_image_list(path)


def index_image_list(ra, dec, collection=None, index_dir=None):
    """Image list from the static sky index (pipeline/sky_index.py reading site/index/)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import sky_index
    except ImportError as e:
        raise SystemExit(f"--from-index: cannot import pipeline/sky_index.py ({e})")
    path = Path(index_dir) if index_dir else ROOT / "site" / "index"
    if not (path / "manifest.json").exists():
        raise SystemExit(f"--from-index: no sky index at {path} (run pipeline/sky_index.py build)")
    rows = sky_index.find_images(ra, dec, index=path)
    return [{"key": r["s3_key"], "t_min": r["mjd"], "band": f"D{r['detector']}", "obs_id": r["obs_id"]}
            for r in rows if collection is None or r["collection"] == collection]


def target_position(name, epoch=2026.0):
    """(ra, dec) of a target from pipeline/targets.json, moved to `epoch` with linear proper motion."""
    targets = json.loads((ROOT / "pipeline" / "targets.json").read_text())
    if name not in targets:
        raise SystemExit(f"unknown target {name}; known: {[k for k in targets if not k.startswith('_')]}")
    t = targets[name]
    dt = epoch - t["epoch"]
    dec = t["dec"] + t["pmdec"] / 3.6e6 * dt
    ra = t["ra"] + t["pmra"] / 3.6e6 * dt / math.cos(math.radians(t["dec"]))
    return ra % 360.0, dec


def default_data_dir():
    env = os.environ.get("FAZARI_DATA")
    if env:
        return Path(env)
    sibling = ROOT.parent / "veri" / "real_spherex"
    return sibling if sibling.exists() else ROOT / "raw"


def dump_wave_tables(images, path, cache_dir=DEFAULT_CACHE):
    """Writes the WCS-WAVE table of each detector (first image per detector in `images`) to JSON.

    The table is the same for every file of a detector that has the same spectral_wcs calibration
    (IMAGE header HISTORY '[CALIB] spectral_wcs <id>'), so a browser can ship these and skip the tail read."""
    out = {"_note": "SPHEREx WCS-WAVE tables per detector. values[iy][ix][m]: m=0 central wavelength, "
                    "m=1 bandwidth (um), at control points x[ix], y[iy] (1-based full-detector pixels). "
                    "Bilinear interpolation. Valid when the IMAGE header has the same calib_id; else read the "
                    "file's own WCS-WAVE HDU. Made by pipeline/fetch_region.py --dump-wave-tables."}
    for row in images:
        f = S3File(row["key"], cache_dir)
        img = locate_hdus(f, with_flags=False)["IMAGE"]
        det = str(img.header["DETECTOR"])
        if det in out:
            continue
        calib = [str(c).split()[-1] for c in img.header.get("HISTORY", []) if "spectral_wcs" in str(c)]
        t = read_wave_hdu(f)
        source = [str(c) for c in t.header.get("HISTORY", []) if "spectral_wcs" in str(c)]
        out[det] = {"calib_id": calib[0] if calib else None,
                    "source": source[0].split()[-1] if source else None, "example_key": row["key"],
                    "x": [int(v) for v in t.data["X"][0]], "y": [int(v) for v in t.data["Y"][0]],
                    "values": np.asarray(t.data["VALUES"][0], float).tolist()}
        if all(str(d) in out for d in range(1, 7)):
            break
    keys = ["_note"] + sorted(k for k in out if k != "_note")
    text = "{\n" + ",\n".join(f" {json.dumps(k)}: {json.dumps(out[k], separators=(',', ':'))}" for k in keys) + "\n}\n"
    Path(path).write_text(text)
    return out


# ----------------------------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ra", type=float)
    ap.add_argument("--dec", type=float)
    size = ap.add_mutually_exclusive_group()
    size.add_argument("--size-px", type=int, help="square size in pixels")
    size.add_argument("--size-deg", type=float, default=0.2, help="size in degrees, IRSA rule (default 0.2)")
    ap.add_argument("--target", help="target name from pipeline/targets.json (centre moved to --epoch)")
    ap.add_argument("--epoch", type=float, default=2026.0)
    ap.add_argument("--images", help="IRSA SIA CSV with access_url / cloud_access")
    ap.add_argument("--from-index", action="store_true",
                    help="image list from the static sky index (site/index/, built by pipeline/sky_index.py)")
    ap.add_argument("--collection", default="dr1", choices=["dr1", "qr3", "all"])
    ap.add_argument("--layers", default=",".join(DEFAULT_LAYERS), help="comma list of IMAGE,FLAGS,VARIANCE,ZODI")
    ap.add_argument("--edge", default="clip", choices=["clip", "pad"],
                    help="clip = IRSA identical (default); pad = fixed size, NaN outside the image")
    ap.add_argument("--out", default=str(ROOT / "cache" / "regions"), help="output folder for cutout FITS")
    ap.add_argument("--no-write", action="store_true", help="do not write FITS files")
    ap.add_argument("--limit", type=int, help="only the first N images (sorted by time)")
    ap.add_argument("--cache", default=str(DEFAULT_CACHE), help="byte-range cache folder ('' = off)")
    ap.add_argument("--workers", type=int, default=2, help="images in parallel (HTTP is capped at 4 anyway)")
    ap.add_argument("--dump-wave-tables", metavar="JSON",
                    help="write the WCS-WAVE table of each detector (from the image list) to JSON and stop")
    a = ap.parse_args(argv)

    if a.target and (a.ra is None or a.dec is None):
        a.ra, a.dec = target_position(a.target, a.epoch)
    if a.ra is None or a.dec is None:
        ap.error("give --ra and --dec, or --target")
    cache = Path(a.cache) if a.cache else None
    collections = ["dr1", "qr3"] if a.collection == "all" else [a.collection]

    images = []
    for coll in collections:
        if a.images:
            rows = read_image_list(a.images)
        elif a.from_index:
            rows = index_image_list(a.ra, a.dec, coll)
        elif a.target and (default_data_dir() / a.target / f"liste_{coll}.csv").exists():
            rows = read_image_list(default_data_dir() / a.target / f"liste_{coll}.csv")
        else:
            rows = sia_query(a.ra, a.dec, coll, cache_dir=cache)
        images += [r for r in rows if a.images or r["key"].startswith(coll + "/")]
    seen, unique = set(), []
    for r in sorted(images, key=lambda r: (r.get("t_min", 0), r["key"])):
        if r["key"] not in seen:
            seen.add(r["key"])
            unique.append(r)
    images = unique[:a.limit] if a.limit else unique
    if a.dump_wave_tables:
        tables = dump_wave_tables(unique, a.dump_wave_tables, cache)
        print(f"wrote {a.dump_wave_tables}: detectors {sorted(k for k in tables if not k.startswith('_'))}",
              file=sys.stderr)
        return
    print(f"centre RA {a.ra:.6f} Dec {a.dec:+.6f}; {len(images)} image(s)", file=sys.stderr)

    layers = [s for s in a.layers.split(",") if s]
    total = Stats()
    out_dir = Path(a.out)

    def one(row):
        st = Stats()
        try:
            r = read_region(row["key"], a.ra, a.dec, size_deg=a.size_deg, size_px=a.size_px, layers=layers,
                            edge=a.edge, cache_dir=cache, stats=st)
        except Exception as e:                                   # report and continue with the others
            return {"key": row["key"], "ok": False, "reason": f"error: {e}", "stats": st.as_dict()}
        summary = {"key": r["key"], "ok": r["ok"], "reason": r.get("reason", ""), "obs": r["obs"],
                   "geometry": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in r["geometry"].items()},
                   "stats": r["stats"]}
        if r["ok"]:
            summary["box"] = r["box"]
            summary["wavelength"] = r.get("wavelength")
            img = r["arrays"].get("IMAGE")
            if img is not None:
                summary["finite_fraction"] = round(float(np.isfinite(img).mean()), 4)
            if r.get("padded"):
                summary["padded"] = r["padded"]
            if not a.no_write:
                name = Path(r["key"]).name.replace(".fits", "_region.fits")
                summary["file"] = str(write_cutout(r, out_dir / name, a.ra, a.dec, a.size_px or a.size_deg))
        return summary

    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=max(1, min(a.workers, MAX_PARALLEL))) as ex:
        for s in ex.map(one, images):
            st = s["stats"]
            total.requests += st.get("requests", 0)
            total.bytes_net += st.get("bytes_net", 0)
            total.cache_hits += st.get("cache_hits", 0)
            print(json.dumps(s, default=str))
            g = s.get("geometry", {})
            print(f"  {'OK ' if s['ok'] else '-- '}{Path(s['key']).name}  box {s.get('box', {}).get('nx')}x"
                  f"{s.get('box', {}).get('ny')} at ({g.get('x0')},{g.get('y0')})  "
                  f"{st.get('bytes_net', 0) / 1e6:.2f} MB net, {st.get('requests', 0)} req, "
                  f"{st.get('seconds', 0):.2f} s  {s.get('reason', '')}", file=sys.stderr)
    print(f"total: {len(images)} image(s), {total.bytes_net / 1e6:.2f} MB downloaded, {total.requests} requests, "
          f"{total.cache_hits} cache hits, {time.monotonic() - t0:.1f} s", file=sys.stderr)


if __name__ == "__main__":
    main()
