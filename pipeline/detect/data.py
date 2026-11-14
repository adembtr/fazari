"""Shared data layer of the candidate finder.

A Field is one sky point with its SPHEREx cutouts (IRSA layout: IMAGE FLAGS VARIANCE ZODI EPSF
WCS-WAVE). Exposures are read once and cleaned exactly as pipeline/blink.py does (ZODI
subtracted, FLAGS bad bits -> NaN, saturated pixels marked, residual offset removed), and keep
the blink.py "_px" layout so blink's photometry functions work on them.

Grouping
  season   blink.split_epochs (gap > 30 d), labelled YYYY-MM
  visit    exposures whose mid-times are within VISIT_GAP_MIN minutes (the six detectors
           observe together: D1+D4, D2+D5, D3+D6 see the same sky at the same time)
  bin      blink.which_bin: single detector, wavelength at the field centre within +-6 %
  unit     what a stack is made of: a wavelength bin ("1.0um") or a whole detector ("D1")

Stacks are inverse-variance means on a common north-up TAN grid (STACK_PIX arcsec per pixel),
with per-pixel outlier clipping, after removing each exposure's registration offset
(calib.py) so that every stack is on the Gaia DR3 frame.
"""
import csv
import json
import math
import os
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

import blink as BL

STACK_PIX = 3.0             # arcsec per stack pixel (blink.py frames use the same)
STACK_DEG = 0.2             # stack field (the cutouts are 0.2 deg)
VISIT_GAP_MIN = 20.0        # exposures closer than this (minutes) form one visit
CLIP_SIGMA = 5.0            # per-pixel outlier clipping in the stacks
CLIP_MODEL = 0.05           # fractional term of the clipping tolerance (PSF/colour mismatch)
EPSF_KEEP_PX = 260          # keep the EPSF table rows within this distance of the cutout (det px)


# ------------------------------------------------------------------------------------ fields
class Field:
    """One sky point: where its cutouts are, its centre, its Gaia field, where products go."""

    def __init__(self, name, data_dir, ra, dec, out_dir=None, gaia_json=None, label=None,
                 target=None, field_stars_csv=None):
        self.name = name
        self.data_dir = Path(data_dir)            # holds dr1/ qr3/ (+ liste_<coll>.csv)
        self.ra, self.dec = float(ra), float(dec)
        self.out_dir = Path(out_dir) if out_dir else None
        self.gaia_json = Path(gaia_json) if gaia_json else None
        self.label = label or name
        self.target = target or {}
        self.field_stars_csv = Path(field_stars_csv) if field_stars_csv else None

    def files(self):
        return sorted(p for c in BL.COLLECTIONS for p in (self.data_dir / c).glob("*.fits")
                      if (self.data_dir / c).is_dir())

    def listing(self):
        rows = {}
        for col in BL.COLLECTIONS:
            p = self.data_dir / f"liste_{col}.csv"
            if not p.exists():
                continue
            with open(p, newline="") as f:
                for r in csv.DictReader(f):
                    url = r.get("access_url", "")
                    if url.endswith(".fits"):
                        rows[url.rsplit("/", 1)[-1]] = dict(r, collection=col)
        return rows

    def gaia(self):
        """Gaia DR3 field stars (blink.py gaia_field.json format) or None."""
        if self.gaia_json and self.gaia_json.exists():
            return json.loads(self.gaia_json.read_text())
        return None


def challenge_field(target, out_dir=None):
    """Field of one of the pipeline/targets.json targets (cutouts in blink.DATA/<target>)."""
    t = BL.load_target(target)
    ra, dec = BL.target_position(t, Time(BL.EPOCH_CENTER, format="jyear").mjd, with_parallax=False)
    g = BL.ROOT / "site" / "data" / target / "gaia_field.json"
    fs = Path(out_dir) / target / "field_stars.csv" if out_dir else None
    return Field(target, BL.DATA / target, ra, dec, out_dir=Path(out_dir) / target if out_dir else None,
                 gaia_json=g if g.exists() else None, label=t["name"], target=t,
                 field_stars_csv=fs if fs and fs.exists() else None)


def job_field(job_id, cache=None, out_dir=None):
    """Field of a local-engine job (cache/jobs/<id>/ products, cache/local/inputs/<id>/ cutouts)."""
    cache = Path(cache) if cache else BL.ROOT / "cache"
    jd = cache / "jobs" / job_id
    meta = json.loads((jd / "meta.json").read_text())
    req = {}
    rp = cache / "local" / "jobs" / job_id / "request.json"
    if rp.exists():
        req = json.loads(rp.read_text())
    tgt = req.get("target", {})
    g = None
    key = tgt.get("gaia_cache_key")
    for cand in ([BL.ROOT / "site" / "data" / key / "gaia_field.json"] if key else []) + [jd / "gaia_field.json"]:
        if cand.exists():
            g = cand
            break
    fs = jd / "field_stars.csv"
    return Field(job_id, cache / "local" / "inputs" / job_id, meta["ra"], meta["dec"],
                 out_dir=Path(out_dir) if out_dir else jd, gaia_json=g, label=meta.get("target", job_id),
                 target=tgt, field_stars_csv=fs if fs.exists() else None)


# ------------------------------------------------------------------------------------ exposures
def read_exposure(path, ra_c, dec_c):
    """One cutout -> exposure dict (blink.py 'info' keys + '_px'), or None if unusable."""
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        img = h["IMAGE"].data.astype(np.float64)
        flg = h["FLAGS"].data.astype(np.int64)
        var = h["VARIANCE"].data.astype(np.float64)
        zodi = h["ZODI"].data.astype(np.float64)
        wcs = WCS(hd)
        swcs = WCS(hd, fobj=h, key="W")
        swcs.sip = None
        tab = h["EPSF"].data
        ovs = int(h["EPSF"].header.get("OVSMPX", 5))
        mjd = float(hd.get("MJD-AVG", hd["MJD-OBS"]))
        mjd_beg = float(hd.get("MJD-BEG", hd.get("MJD-OBS", mjd)))
        mjd_end = float(hd.get("MJD-END", mjd))
        orient = math.degrees(math.atan2(hd["PC2_1"], hd["PC1_1"])) % 360
        det = int(hd["DETECTOR"])
        det_off = (1 - hd.get("CRPIX1A", 1.0), 1 - hd.get("CRPIX2A", 1.0))
        ny, nx = img.shape
        xc, yc = (nx - 1) / 2, (ny - 1) / 2
        dist = np.hypot(tab["XCENTER"] - (xc + det_off[0]), tab["YCENTER"] - (yc + det_off[1]))
        keep = np.nonzero(dist < EPSF_KEEP_PX)[0]
        if not len(keep):
            keep = np.array([int(np.argmin(dist))])
        k0 = int(np.argmin(dist))
        epsf_rows = dict(x=np.asarray(tab["XCENTER"][keep], float) - det_off[0],
                         y=np.asarray(tab["YCENTER"][keep], float) - det_off[1],
                         psf=[np.asarray(tab["EPSF"][k], float) for k in keep])
        psf0 = np.asarray(tab["EPSF"][k0], float)
    x, y = (float(v) for v in wcs.all_world2pix(ra_c, dec_c, 0))
    lam = float(swcs.pixel_to_world_values(x, y)[0]) if (0 <= x < nx and 0 <= y < ny) else \
        float(swcs.pixel_to_world_values(xc, yc)[0])
    sat = (flg & BL.SAT_BITS) != 0
    bad = ((flg & BL.BAD_BITS) != 0) & ~sat
    clean = img - zodi
    clean[bad] = np.nan
    good = np.isfinite(clean) & ~sat
    if good.sum() < 0.3 * good.size:
        return None
    clean -= np.nanmedian(clean[good])
    good_ph = ~bad & ~sat & np.isfinite(clean) & np.isfinite(var) & (var > 0)
    r1, d1 = (float(v) for v in wcs.all_pix2world(xc + 1, yc, 0))
    r0, d0 = (float(v) for v in wcs.all_pix2world(xc, yc, 0))
    r2, d2 = (float(v) for v in wcs.all_pix2world(xc, yc + 1, 0))
    jx, jy = BL.offset_arcsec(r0, d0, r1, d1)[:2], BL.offset_arcsec(r0, d0, r2, d2)[:2]
    detector = f"D{det}"
    e = dict(file=path.name, path=path, mjd=mjd, mjd_beg=mjd_beg, mjd_end=mjd_end,
             jyear=float(Time(mjd, format="mjd").jyear), date=Time(mjd, format="mjd").iso[:10],
             detector=detector, det=det, orient_deg=orient, wavelength_um=lam,
             bin_um=BL.which_bin(lam, detector), x=x, y=y, ra_pred=ra_c, dec_pred=dec_c,
             inside=bool(0 <= x < nx and 0 <= y < ny),
             jac_pred=[[jx[0], jy[0]], [jx[1], jy[1]]], shape=(ny, nx))
    e["_px"] = dict(clean=clean.astype(np.float32), var=np.where(good_ph, var, np.inf).astype(np.float32),
                    good=good_ph, satnan=sat | ~np.isfinite(img), sat=sat, flags=flg.astype(np.int32),
                    wcs=wcs, swcs=swcs, path=path, det_off=det_off, psf=BL.prep_psf(psf0), psf_raw=psf0,
                    ovs=ovs, epsf_rows=epsf_rows)
    return e


def load_exposures(field, log=print, files=None):
    """All usable exposures of a field, with season, visit and bin labels."""
    lst = field.listing()
    exps = []
    for p in (files if files is not None else field.files()):
        try:
            e = read_exposure(p, field.ra, field.dec)
        except Exception as ex:                          # e.g. a file still being written
            log(f"  skip {p.name}: {ex}")
            continue
        if e is None:
            continue
        row = lst.get(p.name, {})
        e["collection"] = p.parent.name
        e["obs_id"] = row.get("obs_id", "")
        e["mjd_t"] = float(row["t_min"]) if row.get("t_min") else e["mjd"]
        exps.append(e)
    if not exps:
        return exps
    ep = BL.split_epochs([e["mjd_t"] for e in exps])
    for e in exps:
        e["epoch"] = ep[e["mjd_t"]]
    # visits: consecutive mid-times within VISIT_GAP_MIN
    order = sorted(range(len(exps)), key=lambda k: exps[k]["mjd"])
    v, last = -1, None
    for k in order:
        m = exps[k]["mjd"]
        if last is None or (m - last) * 1440 > VISIT_GAP_MIN:
            v += 1
        exps[k]["visit"] = v
        last = m
    exps.sort(key=lambda e: (e["mjd"], e["det"]))
    return exps


def seasons(exps):
    return sorted({e["epoch"] for e in exps})


def season_info(exps):
    """Per season: mean jyear, circular-mean orientation, number of exposures."""
    out = {}
    for s in seasons(exps):
        ss = [e for e in exps if e["epoch"] == s]
        ori = float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians([e["orient_deg"] for e in ss])))))) % 360
        out[s] = dict(jyear=float(np.mean([e["jyear"] for e in ss])), orient_deg=ori, n=len(ss),
                      mjd=float(np.mean([e["mjd"] for e in ss])))
    return out


def same_orientation(o1, o2, tol=30.0):
    return abs((o1 - o2 + 180) % 360 - 180) < tol


def unit_of(e, mode):
    """Stack unit of an exposure: 'bin' -> '1.0um' (None if outside every bin), 'det' -> 'D1'."""
    if mode == "bin":
        return f"{e['bin_um']:.1f}um" if e.get("bin_um") else None
    return e["detector"]


# ------------------------------------------------------------------------------------ grid
class Grid:
    """North-up TAN grid centred on the field (STACK_PIX arcsec per pixel)."""

    def __init__(self, ra, dec, pix=STACK_PIX, size_deg=STACK_DEG):
        n = int(round(size_deg * 3600 / pix))
        w = WCS(naxis=2)
        w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        w.wcs.crval = [ra, dec]
        w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
        w.wcs.cdelt = [-pix / 3600, pix / 3600]
        self.wcs, self.n, self.pix = w, n, pix
        self.ra, self.dec = ra, dec
        yy, xx = np.mgrid[:n, :n]
        r, d = w.all_pix2world(xx.ravel(), yy.ravel(), 0)
        self.world = (r, d)

    def to_pix(self, ra, dec):
        x, y = self.wcs.all_world2pix(np.atleast_1d(ra), np.atleast_1d(dec), 0)
        return x, y

    def to_world(self, x, y):
        return self.wcs.all_pix2world(np.atleast_1d(x), np.atleast_1d(y), 0)

    def offset(self, ra, dec):
        """(east, north) arcsec of (ra, dec) from the grid centre."""
        cosd = math.cos(math.radians(self.dec))
        return ((np.asarray(ra) - self.ra + 180) % 360 - 180) * cosd * 3600, (np.asarray(dec) - self.dec) * 3600


def exposure_map(e, grid, cal=(0.0, 0.0)):
    """Native pixel (x, y) of every grid pixel in exposure e. cal = (east, north) arcsec offset of
    this exposure's WCS from the Gaia frame (the WCS puts a source at true + cal)."""
    r, d = grid.world
    cosd = math.cos(math.radians(grid.dec))
    x, y = e["_px"]["wcs"].all_world2pix(r + cal[0] / 3600 / cosd, d + cal[1] / 3600, 0)
    return x.reshape(grid.n, grid.n).astype(np.float32), y.reshape(grid.n, grid.n).astype(np.float32)


def resample(a, xy, cval=np.nan, order=1):
    from scipy.ndimage import map_coordinates
    return map_coordinates(np.asarray(a, np.float64), [xy[1], xy[0]], order=order, mode="constant",
                           cval=cval, prefilter=False).astype(np.float32)


class Stacker:
    """Calibrated, resampled exposures on one grid, cached (image, variance, saturation)."""

    def __init__(self, exps, grid, cal=None):
        self.exps, self.grid = exps, grid
        self.cal = cal or {}
        self._cache = {}

    def layers(self, e, image=None):
        """(img, var, sat) of exposure e on the grid. image: replacement native image (injection)."""
        key = e["file"]
        if key not in self._cache:
            xy = exposure_map(e, self.grid, self.cal.get(key, (0.0, 0.0)))
            px = e["_px"]
            var = np.where(np.isfinite(px["var"]), px["var"], np.nan)
            v = resample(var, xy)
            s = resample(px["satnan"].astype(np.float32), xy, cval=0.0) > 0.25
            self._cache[key] = (xy, v, s)
        xy, v, s = self._cache[key]
        src = px_image(e) if image is None else image
        return resample(src, xy), v, s

    def stack(self, sel, images=None):
        """Inverse-variance mean of exposures sel with per-pixel clipping.
        Returns dict(img, var, n, sat, nexp)."""
        n = self.grid.n
        if not sel:
            return None
        I = np.empty((len(sel), n, n), np.float32)
        V = np.empty_like(I)
        S = np.zeros((n, n), np.float32)
        C = np.zeros((n, n), np.float32)
        for k, e in enumerate(sel):
            im, v, s = self.layers(e, None if images is None else images.get(e["file"]))
            I[k], V[k] = im, v
            S += s
            C += np.isfinite(v)
        ok = np.isfinite(I) & np.isfinite(V) & (V > 0)
        I = np.where(ok, I, np.nan)
        if len(sel) >= 3:
            med = np.nanmedian(I, axis=0)
            tol = np.sqrt(np.where(ok, V, np.inf) + (CLIP_MODEL * np.abs(med)) ** 2)
            ok &= np.abs(I - med) < CLIP_SIGMA * tol
        W = np.where(ok, 1.0 / np.where(ok, V, 1.0), 0.0)
        sw = W.sum(0)
        img = np.where(sw > 0, (W * np.nan_to_num(I)).sum(0) / np.where(sw > 0, sw, 1), np.nan)
        var = np.where(sw > 0, 1.0 / np.where(sw > 0, sw, 1), np.inf)
        # saturation: 'sat' = in >= 30 % of the exposures, 'satcore' = in >= half of those that cover
        # the pixel and in >= 2 (a single exposure's flags do not make a saturated star)
        return dict(img=img.astype(np.float32), var=var.astype(np.float32), n=ok.sum(0).astype(np.int16),
                    sat=((S / len(sel)) > 0.3) & (S >= min(2, len(sel))), satany=S > 0,
                    satcore=(S >= 2) & (S >= 0.5 * np.maximum(C, 1)), nexp=len(sel))


def px_image(e):
    """Native cleaned image with NaN at bad pixels (saturated pixels NaN as well)."""
    px = e["_px"]
    a = px["clean"].astype(np.float64)
    a[~px["good"]] = np.nan
    return a


# ------------------------------------------------------------------------------------ psf
def grid_psf_sigma(det):
    """Gaussian sigma (stack pixels) of a point source in a stack of detector det: EPSF sigma
    (0.61-0.70 native px) and the bilinear resampling (1/6 native px^2) added in quadrature."""
    s_native = {1: 0.61, 2: 0.61, 3: 0.64, 4: 0.69, 5: 0.69, 6: 0.70}.get(int(det), 0.66)
    return math.sqrt(s_native ** 2 + 1 / 6.0) * BL.PIX_NATIVE / STACK_PIX


def jy_to_ab(ujy):
    return 23.9 - 2.5 * math.log10(ujy) if ujy and ujy > 0 else None
