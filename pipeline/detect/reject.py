"""Shared rejection helpers: zones around saturated stars, stack edges.

Saturated stars: every blob of the per-detector saturation cores (saturated in >= half of the
exposures that cover the pixel, and in >= 2 of them; all seasons together) defines a zone of radius SAT_ZONE_K x blob radius + SAT_ZONE_ADD. Inside
it the PSF wings of the star dominate: positions are pulled and difference images carry its
residuals (a moving saturated star, like Barnard's Star, drags its wings over the field
stars around it). Records inside a zone are 'artifact' unless they are the saturated star
itself.
"""
import math

import numpy as np

from . import data as Dt
from . import imgproc as IP
from . import schema as SC

SAT_ZONE_K = 2.5
SAT_ZONE_ADD = 15.0         # arcsec


def sat_zones(ctx):
    if "sat_zones" in ctx.shared:
        return ctx.shared["sat_zones"]
    g = ctx.grid
    m = np.zeros((g.n, g.n), bool)
    for det in sorted({e["detector"] for e in ctx.exps}):
        sel = [e for e in ctx.exps if e["detector"] == det]
        st = ctx.stacker.stack(sel, images=ctx.images)
        if st is not None:
            m |= st["satcore"]
    zones = []
    for x, y, n, r in IP.blobs(m, min_px=3):
        ra, de = g.to_world(x, y)
        rr = r * g.pix
        zones.append((float(ra[0]), float(de[0]), rr, SAT_ZONE_K * rr + SAT_ZONE_ADD))
    ctx.shared["sat_zones"] = zones
    return zones


def in_sat_zone(ctx, ra, dec, allow_core=False):
    """(inside a saturated star's zone?, distance to its centre, core radius)."""
    best = None
    for zr, zd, core, rad in sat_zones(ctx):
        d = SC.sep_arcsec(zr, zd, ra, dec)
        if d < rad and (best is None or d < best[0]):
            best = (d, core)
    if best is None:
        return False, None, None
    if allow_core and best[0] <= best[1] + 6.0:
        return False, best[0], best[1]                 # the saturated star itself
    return True, best[0], best[1]
