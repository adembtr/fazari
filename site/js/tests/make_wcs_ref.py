#!/usr/bin/env python3
"""Reference numbers for wcs_test.mjs, made with astropy.

  uv run --no-project --with astropy --with numpy python -I site/js/tests/make_wcs_ref.py

Takes a few local IRSA cutouts (env FAZARI_DATA, default ../veri/real_spherex next to the
repo) and two full-size files on S3 (headers only, via HTTP Range), and writes
site/js/tests/wcs_ref.json: pixel -> sky (all_pix2world), sky -> pixel (all_world2pix,
tight tolerance) and wavelength (alternate WCS 'W') for a grid of pixels.
"""
import io, json, os, sys, urllib.request, warnings, logging
from pathlib import Path
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

warnings.simplefilter("ignore", FITSFixedWarning)
logging.getLogger("astropy").setLevel(logging.WARNING)
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
DATA = Path(os.environ.get("FAZARI_DATA", ROOT.parent / "veri" / "real_spherex"))
S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
S3_KEYS = [
    "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits",
    "qr3/level2/2026W33_2A/l2b-v27-2026-241/3/level2_2026W33_2A_0594_4D3_spx_l2b-v27-2026-241.fits",
]


def rng(url, a, b=None):
    h = {"Range": f"bytes={a}-{'' if b is None else b - 1}"} if a >= 0 else {"Range": f"bytes={a}"}
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60).read()


def ref_for(hdr, hdul, xs, ys):
    w = WCS(hdr)
    sw = WCS(hdr, fobj=hdul, key="W")
    sw.sip = None
    x, y = np.meshgrid(xs, ys)
    x, y = x.ravel().astype(float), y.ravel().astype(float)
    ra, dec = w.all_pix2world(x, y, 0)
    # sky -> pixel reference: astropy's iterative solver with a tight tolerance
    xb, yb = w.all_world2pix(ra, dec, 0, tolerance=1e-10, maxiter=200)
    lam, bw = sw.pixel_to_world_values(x, y)
    return dict(x=x.tolist(), y=y.tolist(), ra=ra.tolist(), dec=dec.tolist(),
                x_back=xb.tolist(), y_back=yb.tolist(), lam=np.asarray(lam).tolist(), bw=np.asarray(bw).tolist())


def main():
    out = {"cutouts": [], "s3": []}
    files = []
    for col in ("dr1", "qr3"):
        fs = sorted((DATA / "barnard" / col).glob("*.fits"))
        files += fs[:: max(1, len(fs) // 5)][:5]
    for p in files:
        with fits.open(p) as h:
            hdr = h["IMAGE"].header
            ny, nx = h["IMAGE"].data.shape
            # inside the cutout and far outside it (the full detector: browser uses full frames)
            xs = [0, nx // 2, nx - 1, -900.3, 1500.7]
            ys = [0, ny // 3, ny - 1, -1200.2, 1700.9]
            r = ref_for(hdr, h, xs, ys)
        r["file"] = str(p.relative_to(DATA))
        r["detector"] = int(hdr["DETECTOR"])
        out["cutouts"].append(r)
        print("cutout", p.name, file=sys.stderr)
    for key in S3_KEYS:
        url = S3 + key
        head = rng(url, 0, 12 * 2880)
        tail = rng(url, -5760)
        hdr = fits.Header.fromstring(head[2880:].decode("latin1"))
        # an HDUList holding the WCS-WAVE table (last 5760 bytes) so astropy can read the -TAB lookup
        tab = fits.BinTableHDU.fromstring(tail)
        hdul = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=hdr), tab])
        xs = [0, 511.5, 1019.5, 1530.25, 2039]
        ys = [0, 255.75, 1019.5, 1800.5, 2039]
        r = ref_for(hdr, hdul, xs, ys)
        r["key"] = key
        out["s3"].append(r)
        print("s3", key.rsplit("/", 1)[-1], file=sys.stderr)
    clean = lambda o: [None if isinstance(v, float) and v != v else v for v in o] if isinstance(o, list) else o
    for group in out.values():
        for r in group:
            for k in list(r):
                r[k] = clean(r[k])
    (HERE / "wcs_ref.json").write_text(json.dumps(out))
    print("wrote", HERE / "wcs_ref.json", file=sys.stderr)


if __name__ == "__main__":
    main()
