#!/usr/bin/env python3
"""Downloads SPHEREx cutouts of the 5 test targets (Fazari, NASA Space Apps 2026).

Usage (from the fazari/ folder):
  python3 -I pipeline/download.py list                  # only fetch the image listings (KB size)
  python3 -I pipeline/download.py download              # download the cutouts of all targets
  python3 -I pipeline/download.py download barnard r_dra  # only the chosen targets
  python3 -I pipeline/download.py download --collection qr3
  python3 -I pipeline/download.py list barnard --data-dir /path/to/data
  python3 -I pipeline/download.py download barnard --size 0.4   # wider cutouts, own folder

Targets: pipeline/targets.json.
Data directory: --data-dir, else env FAZARI_DATA, else ../veri/real_spherex next to the repo
if that folder exists, else <repo>/raw/. With --size other than 0.2 the default folder is
../veri/real_spherex_<size> (or <repo>/raw_<size>), so cutouts of two sizes never mix; a target
folder remembers its size in cutout_deg.txt and a download of another size into it is refused.
Layout: <data>/<target>/liste_<collection>.csv and <data>/<target>/<collection>/*.fits
An existing file is skipped; an interrupted download stays as .part and is fetched again.
Python standard library only.
"""
import argparse
import csv
import io
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # fazari/
TARGETS = Path(__file__).resolve().parent / "targets.json"
SIA = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = {"dr1": "spherex_dr1", "qr3": "spherex_qr3"}
CENTER_EPOCH = 2026.0         # cutout centre is moved to this date (data span 2025.6-2026.7)
CUTOUT_SIZE = 0.2             # degrees (~117 pixels, 6.15"/pixel); default of --size (site data)
SEARCH_RADIUS = 0.001         # degrees; images that contain the target
WORKERS = 3                   # IRSA is busy, download with little parallelism
ATTEMPTS = 8
USER_AGENT = "fazari-spaceapps/1.0"

lock = threading.Lock()
DATA = None                   # set in main()


def data_dir(cli=None, size=CUTOUT_SIZE):
    """--data-dir, else FAZARI_DATA, else ../veri/real_spherex next to the repo, else <repo>/raw.
    For a size other than CUTOUT_SIZE the defaults get a _<size> suffix (real_spherex_0.4)."""
    if cli:
        return Path(cli).expanduser().resolve()
    env = os.environ.get("FAZARI_DATA")
    if env:
        return Path(env).expanduser().resolve()
    tag = "" if size == CUTOUT_SIZE else f"_{size:g}"
    sibling = ROOT.parent / "veri" / f"real_spherex{tag}"
    if tag:
        return sibling if sibling.parent.is_dir() else ROOT / f"raw{tag}"
    return sibling if sibling.is_dir() else ROOT / "raw"


def check_size(folder, size):
    """A target folder holds one cutout size. cutout_deg.txt records a non-default size; a folder
    without it that already has cutouts holds CUTOUT_SIZE ones (all data made before --size)."""
    mark = folder / "cutout_deg.txt"
    have = float(mark.read_text().strip()) if mark.exists() else (
        CUTOUT_SIZE if any(folder.glob("*/*.fits")) else None)
    if have is not None and abs(have - size) > 1e-9:
        sys.exit(f"{folder} holds {have:g} deg cutouts; refusing to add {size:g} deg ones (use another --data-dir)")
    if size != CUTOUT_SIZE and not mark.exists():
        folder.mkdir(parents=True, exist_ok=True)
        mark.write_text(f"{size:g}\n")


def show(p):
    try:
        return p.relative_to(Path.cwd())
    except ValueError:
        return p


def say(*a):
    with lock:
        print(*a, flush=True)


def center(h):
    """Moves the target to CENTER_EPOCH (linear proper motion)."""
    dt = CENTER_EPOCH - h["epoch"]
    dec = h["dec"] + h["pmdec"] / 3.6e6 * dt
    ra = h["ra"] + h["pmra"] / 3.6e6 * dt / math.cos(math.radians(h["dec"]))
    return ra % 360.0, dec


def fetch(url, timeout=120):
    """Waits and retries on 503/502/timeouts."""
    wait = 5
    for i in range(1, ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or i == ATTEMPTS:
                raise
            err = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if i == ATTEMPTS:
                raise
            err = str(e)[:60]
        say(f"    retry {i}/{ATTEMPTS - 1} ({err}), waiting {wait} s")
        time.sleep(wait)
        wait = min(wait * 2, 60)


def fetch_listing(name, h, short):
    ra, dec = center(h)
    q = urllib.parse.urlencode({
        "COLLECTION": COLLECTIONS[short],
        "POS": f"CIRCLE {ra:.6f} {dec:.6f} {SEARCH_RADIUS}",
        "RESPONSEFORMAT": "CSV",
    })
    text = fetch(f"{SIA}?{q}").decode("utf-8")
    rows = [s for s in csv.DictReader(io.StringIO(text))
            if s.get("access_url", "").endswith(".fits")]
    path = DATA / name / f"liste_{short}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        f.write(text)
    return rows


def read_listing(name, short):
    path = DATA / name / f"liste_{short}.csv"
    if not path.exists():
        return None
    with open(path, newline="") as f:
        return [s for s in csv.DictReader(f) if s.get("access_url", "").endswith(".fits")]


def download_cutout(row, ra, dec, folder, size=CUTOUT_SIZE):
    url = row["access_url"]
    dest = folder / os.path.basename(urllib.parse.urlparse(url).path)
    if dest.exists() and dest.stat().st_size > 0:
        return "present", 0
    data = fetch(f"{url}?center={ra:.6f},{dec:.6f}&size={size:g}")
    if not data.startswith(b"SIMPLE"):
        raise ValueError(f"not a FITS file: {data[:60]!r}")
    tmp = dest.with_suffix(".fits.part")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return "downloaded", len(data)


def main():
    global DATA
    p = argparse.ArgumentParser(description="SPHEREx cutout downloader")
    p.add_argument("action", choices=["list", "download"])
    p.add_argument("targets", nargs="*", help="empty = all")
    p.add_argument("--collection", choices=list(COLLECTIONS), action="append")
    p.add_argument("--data-dir", help="data folder (default: env FAZARI_DATA, "
                   "../veri/real_spherex if present, else <repo>/raw; _<size> appended for --size != 0.2)")
    p.add_argument("--size", type=float, default=CUTOUT_SIZE,
                   help=f"cutout size in degrees (default {CUTOUT_SIZE}; IRSA rule, see pipeline/S3_LAYOUT.md)")
    a = p.parse_args()
    if not 0.05 <= a.size <= 2.0:
        sys.exit("--size must be within 0.05..2 deg")
    DATA = data_dir(a.data_dir, a.size)

    everything = {k: v for k, v in json.loads(TARGETS.read_text()).items()
                  if not k.startswith("_")}
    chosen = a.targets or list(everything)
    for name in chosen:
        if name not in everything:
            sys.exit(f"Unknown target: {name}. Options: {', '.join(everything)}")
    cols = a.collection or list(COLLECTIONS)

    total = 0
    for name in chosen:
        h = everything[name]
        ra, dec = center(h)
        say(f"\n== {h['name']} ({name})  centre {CENTER_EPOCH}: {ra:.5f} {dec:+.5f}")
        for short in cols:
            if a.action == "list":
                rows = fetch_listing(name, h, short)
                mb = sum(float(s.get("access_estsize") or 0) for s in rows) / 1024
                months = {}
                for s in rows:
                    day = datetime(1858, 11, 17) + timedelta(days=float(s["t_min"]))  # MJD
                    key = day.strftime("%Y-%m")
                    months[key] = months.get(key, 0) + 1
                say(f"  {short}: {len(rows)} images (full files {mb:,.0f} MB) {dict(sorted(months.items()))}")
                total += len(rows)
                continue

            rows = read_listing(name, short)
            if rows is None:
                rows = fetch_listing(name, h, short)
            check_size(DATA / name, a.size)
            folder = DATA / name / short
            folder.mkdir(parents=True, exist_ok=True)
            say(f"  {short}: {len(rows)} cutouts -> {show(folder)}")
            count = {"downloaded": 0, "present": 0, "error": 0}
            nbytes = 0
            start = time.time()
            with ThreadPoolExecutor(WORKERS) as ex:
                jobs = {ex.submit(download_cutout, s, ra, dec, folder, a.size): s for s in rows}
                for n, f in enumerate(as_completed(jobs), 1):
                    try:
                        state, b = f.result()
                        count[state] += 1
                        nbytes += b
                    except Exception as e:
                        count["error"] += 1
                        say(f"    ERROR {jobs[f]['obs_id']}: {str(e)[:80]}")
                    if n % 20 == 0 or n == len(rows):
                        say(f"    {n}/{len(rows)}  downloaded {count['downloaded']}  present {count['present']}"
                            f"  errors {count['error']}  {nbytes / 1e6:,.0f} MB  {time.time() - start:,.0f} s")
    if a.action == "list":
        mb = 3.9 + 16 * (a.size / (6.15 / 3600)) ** 2 / 1e6     # EPSF table + IMAGE/FLAGS/VARIANCE/ZODI
        say(f"\nTotal {total} images. ~{mb:.1f} MB per {a.size:g} deg cutout (3.9 MB of it the PSF table)"
            f" -> about {total * mb / 1024:,.1f} GB")


if __name__ == "__main__":
    main()
