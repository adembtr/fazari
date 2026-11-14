"""Detector S: shift-and-stack search for faint moving sources (pipeline/FAINT.md).

A source too faint for one exposure can still be found by adding many exposures along its
path. For a grid of trial motions every exposure is shifted by motion x (its time - t_ref) and
the shifted exposures are added; a moving source then piles up in one place, static stars are
removed beforehand by template subtraction.

  1. Grid: the blink.py frame grid (TAN, 3"/px, 0.15 deg); exposures resampled bilinearly,
     effective PSF per exposure (its own EPSF resampled the same way; faint.py).
  2. Static sky removed with templates that do NOT contain the exposure's own epoch:
       pm  (proper motion, "/yr): per detector, the other seasons (leave-one-season-out)
       sso (fast movers, "/h):    per detector and season, the exposures outside the window
     R = I - T, V_R = V + V_T + (EPS x T)^2 (EPS absorbs PSF and colour mismatch of bright stars),
     saturated cores masked; 45" mesh background removed from R.
  3. Matched filter per exposure: psi = corr(R / V_R, K), phi = corr(1 / V_R, K^2); summed per
     visit (pm) or pointing (sso).
  4. pm: self-subtraction-aware season statistic. The leave-one-season-out template of season s
     holds the mover at its other-season positions p_k (weight w_sk), so the residual has +F at
     p_s and -w_sk F at p_k; the statistic matches that whole pattern (Search.cube_aware):
       A_s = Psi_s(p_s) - sum_k w_sk Psi_s(p_k),  D_s = Phi_s(p_s) |m_s|^2,  Z = sum A / sqrt(sum D)
     sso: plain sum over the pointings of a window, Z = sum psi_g(p + v dt_g) / sqrt(sum phi_g(..)).
     Integer-pixel shifts in the search; Z divided by its robust scatter at random trial motions.
  5. Epoch consistency (seasons for pm, visits for sso): chi2 of the epoch fluxes <= p = 0.001
     value and >= 2 epochs covering the position. Peak map = max over v of Z; peaks >= threshold
     refined (finer motions, half pixels, bilinear reads), motion error from the curvature of
     Z^2. Classes: one epoch only or a static star > 10x brighter on the path -> 'artifact';
     the field target / a Gaia DR3 mover -> 'gaia-known'; else 'candidate'.

API
  run(ctx)                    detector entry point of detect/run.py (mode from ctx.opts
                              "shift_stack_modes", default ["pm"])
  run(field_or_run, mode=..)  also accepts a faint.FieldRun or a detect.data.Field
  run_field(run, mode, ...)   the same plus faint/shiftstack.json, peak-map PNGs
  Search(run).pm(...) / .sso(...) / .forced(track)   lower-level (tests)
Candidates follow detect/schema.py (new_candidate): pm -> kind 'motion' with motion in mas/yr;
sso -> kind 'transient' with 'rate' {"ra_arcsec_h", "dec_arcsec_h"}. Extra key 'shiftstack'
holds the S-specific numbers. Language: candidates for follow-up, never discoveries.
"""
import json
import math
import time
from pathlib import Path

import numpy as np

import blink as BL
import faint as FA
from . import schema as SC

NAME = "S"
EPS_MODEL = {"pm": 0.20, "sso": 0.15}   # measured: residual PSF flux of stars ~18-24 % across seasons
SAT_PAD = 3                     # grid px around saturated template cores masked
PM_VMAX, PM_STEP = 12.0, 1.0    # "/yr
PM_VMIN = 2.0                   # "/yr: slower = static within the PSF over the baseline
SSO_VMAX, SSO_VMIN = 60.0, 4.0  # "/h
SSO_WINDOW_H = 12.0             # visits within this span are searched together
SSO_CONE_DEG = 35.0             # trial directions within this angle of the ecliptic (both senses)
SSO_MAX_V = 15000
LAM_TOL = 0.03                  # wavelength match of the templates (|ln ratio|), ~1 spectral element
MIN_TMPL = 4                    # exposures per template at least
STATIC_RATIO = 10.0             # static PSF flux at the path > this x the peak flux: 'static residual'
THRESH = {"pm": 6.0, "sso": 6.5}
MIN_EPOCH_SNR = 2.0
CHI2_CRIT = {1: 10.83, 2: 13.82, 3: 16.27, 4: 18.47, 5: 20.52, 6: 22.46, 7: 24.32}   # p = 0.001
TAU_EPOCH = {"pm": 0.25, "sso": 0.5}   # fractional flux tolerance between epochs in the chi2 test:
# the epochs mix different wavelengths (a brown dwarf or an asteroid changes a lot with wavelength)
# and carry the template model error; without it a bright real mover fails the test.
JYR_H = 365.25 * 24.0


# ------------------------------------------------------------------------------------- helpers
def epoch_chi2(A, D, scale, tau, axis=0):
    """chi2 of the epoch fluxes f = A / D about their weighted mean F = sum A / sum D, with the
    variance scale^2 / D + (tau F)^2 per epoch (epochs with D <= 0 are left out)."""
    with np.errstate(all="ignore"):
        good = D > 0
        Dp = np.where(good, D, np.nan)
        F = np.where(good, A, 0).sum(axis) / np.where(good, D, 0).sum(axis)
        Fe = np.expand_dims(F, axis)
        q = (A / Dp - Fe) ** 2 / (scale ** 2 / Dp + (tau * Fe) ** 2)
        return np.where(good, q, 0.0).sum(axis)


def add_shift(acc, a, dx, dy):
    """acc[y, x] += a[y + dy, x + dx] where both exist (integer shifts)."""
    n = a.shape[0]
    if abs(dx) >= n or abs(dy) >= n:
        return
    ys = slice(max(0, -dy), n - max(0, dy))
    yd = slice(max(0, dy), n - max(0, -dy))
    xs = slice(max(0, -dx), n - max(0, dx))
    xd = slice(max(0, dx), n - max(0, -dx))
    acc[ys, xs] += a[yd, xd]


def ecliptic_pa(ra, dec):
    """Position angle (deg E of N) of the direction of increasing ecliptic longitude."""
    from astropy.coordinates import SkyCoord, GeocentricTrueEcliptic
    import astropy.units as u
    c = SkyCoord(ra * u.deg, dec * u.deg).transform_to(GeocentricTrueEcliptic())
    c2 = SkyCoord(lon=c.lon + 0.01 * u.deg, lat=c.lat, frame=GeocentricTrueEcliptic()).icrs
    de = (c2.ra.deg - ra) * math.cos(math.radians(dec))
    dn = c2.dec.deg - dec
    return math.degrees(math.atan2(de, dn)) % 360, float(c.lat.deg)


class InjectedLayers:
    """faint.Layers with synthetic point sources added (exposure's own WCS, EPSF and time).
    source: dict(ra, dec, mjd0, ve, vn (arcsec per day, east/north), flux_ujy)."""

    def __init__(self, base, sources):
        self.base, self.sources, self.grid = base, sources, base.grid
        self._lay = {}

    def xy(self, e):
        return self.base.xy(e)

    def kernel(self, e):
        return self.base.kernel(e)

    def get(self, e):
        k = e["file"]
        if k not in self._lay:
            img, var, sat = self.base.get(e)
            img = img.copy()
            for s in self.sources:
                dtd = e["mjd"] - s["mjd0"]
                cosd = math.cos(math.radians(s["dec"]))
                ra = s["ra"] + s["ve"] * dtd / 3600 / cosd
                dec = s["dec"] + s["vn"] * dtd / 3600
                gx, gy = (float(v[0]) for v in self.grid.to_pix(ra, dec))
                if not (-15 < gx < self.grid.n + 15 and -15 < gy < self.grid.n + 15):
                    continue
                box, x0, y0 = FA.source_on_grid(e, self.base.xy(e), self.grid, gx, gy, s["flux_ujy"])
                # source_on_grid centres the box on round(g); the source keeps its sub-pixel offset
                FA.add_box(img, box, x0, y0)
            self._lay[k] = (img, var, sat)
        return self._lay[k]


# ------------------------------------------------------------------------------------- search
class Search:
    def __init__(self, run, layers=None, log=print):
        self.run, self.grid, self.exps = run, run.grid, run.exps
        self.lay = layers or run.lay
        self.log = log
        self._tmpl = {}
        self.n = self.grid.n

    # ---- templates and filtered residuals -------------------------------------------------
    def template(self, key, sel):
        if key not in self._tmpl:
            st = FA.deep_stack(sel, self.lay) if sel else None
            if st is not None:
                from scipy.ndimage import binary_dilation
                st["mask"] = binary_dilation(BL.clean_satmask(st["satfrac"] > 0.3) | (st["satfrac"] > 0.5),
                                             iterations=SAT_PAD)
            self._tmpl[key] = st
        return self._tmpl[key]

    def matched_template(self, e, pool, tag, tol=LAM_TOL):
        """Template for exposure e from 'pool' (same detector, its own epoch excluded) at nearly
        the same wavelength (|ln lam ratio| <= tol, widened in steps until >= MIN_TMPL exposures):
        a star's flux changes with wavelength across the linear variable filter (measured: a
        template mixing all wavelengths of a detector leaves ~25 % of a star's flux)."""
        b = int(math.floor(math.log(e["wavelength_um"]) / tol))
        for wid in (1, 2, 3, 5, 99):
            sel = [o for o in pool if abs(math.log(o["wavelength_um"]) / tol - (b + 0.5)) <= wid]
            if len(sel) >= MIN_TMPL or wid == 99:
                break
        return self.template((tag, e["det"], b, wid), sel) if sel else None

    def raw_groups(self, exps=None):
        """psi/phi per visit of the raw exposures (no template): for co-moving checks."""
        return self.groups(exps or self.exps, lambda e: self.zero_template(), 0.0, lambda e: e["visit"])

    def zero_template(self):
        if "_zero" not in self._tmpl:
            n = self.n
            self._tmpl["_zero"] = {"img": np.zeros((n, n), np.float32), "var": np.zeros((n, n), np.float32),
                                   "mask": np.zeros((n, n), bool)}
        return self._tmpl["_zero"]

    def filtered(self, e, T, eps):
        """psi, phi of exposure e minus template T (None if no overlap)."""
        from scipy.signal import fftconvolve
        img, var, sat = self.lay.get(e)
        ok = (np.isfinite(img) & np.isfinite(var) & (var > 0) & (sat < 0.25) & np.isfinite(T["img"])
              & np.isfinite(T["var"]) & (T["var"] < np.inf) & ~T["mask"])
        if ok.sum() < 0.2 * ok.size:
            return None
        R = np.where(ok, img - T["img"], 0.0)
        R = np.where(ok, R - FA.mesh_background(R, ok), 0.0)
        VR = np.where(ok, var + T["var"] + (eps * T["img"]) ** 2, np.inf)
        w = np.where(ok, 1.0 / VR, 0.0)
        K = self.lay.kernel(e)
        psi = fftconvolve(R * w, K[::-1, ::-1], mode="same").astype(np.float32)
        phi = fftconvolve(w, (K * K)[::-1, ::-1], mode="same").astype(np.float32)
        phi[phi < 0] = 0
        return psi, phi

    def groups(self, exps, tmpl_of, eps, group_key, label=lambda e: e["epoch"]):
        """[(psi, phi, mjd, key, label)] summed per group; label = epoch used by the robust
        statistic (season for pm, visit for sso)."""
        out = {}
        for e in exps:
            T = tmpl_of(e)
            if T is None:
                continue
            f = self.filtered(e, T, eps)
            if f is None:
                continue
            g = group_key(e)
            if g not in out:
                out[g] = [np.zeros((self.n, self.n), np.float32), np.zeros((self.n, self.n), np.float32), [], label(e)]
            out[g][0] += f[0]
            out[g][1] += f[1]
            out[g][2].append(e["mjd"])
        return [(v[0], v[1], float(np.mean(v[2])), k, v[3]) for k, v in sorted(out.items(), key=lambda kv: np.mean(kv[1][2]))]

    # ---- the stack ---------------------------------------------------------------------------
    def shifts(self, groups, vel, t_ref, per, exact=False):
        """Pixel shifts (V, G, 2) for velocities vel (V, 2) east/north per unit 'per' days
        (integers for the search; exact=True: float, for bilinear reads)."""
        dt = np.array([(g[2] - t_ref) / per for g in groups])                   # in velocity time unit
        de = vel[:, 0:1] * dt[None, :]
        dn = vel[:, 1:2] * dt[None, :]
        dx, dy = -de / self.grid.pix, dn / self.grid.pix
        if exact:
            return np.stack([dx, dy], -1)
        return np.stack([np.rint(dx).astype(int), np.rint(dy).astype(int)], -1)

    def zmap(self, groups, sh):
        P = np.zeros((self.n, self.n), np.float32)
        Q = np.zeros((self.n, self.n), np.float32)
        for (psi, phi, *_), (dx, dy) in zip(groups, sh):
            add_shift(P, psi, int(dx), int(dy))
            add_shift(Q, phi, int(dx), int(dy))
        return P, Q

    def cube_max(self, groups, vel, t_ref, per, scale=None, phimin=None, robust=True):
        """Max over velocities of the (normalised) statistic and the index of the best velocity.
        robust: the fluxes of the epochs (group label: season for pm, visit for sso) along the
        path must agree (chi2 <= CHI2_CRIT, p = 0.001) and >= 2 epochs must cover the position, so
        a residual present in one epoch only cannot make a peak; a consistent mover keeps its
        full S/N (dropping the brightest of only 3-4 seasons cost too much S/N in the tests)."""
        sh = self.shifts(groups, vel, t_ref, per)
        labels = sorted({g[4] for g in groups})
        li = [labels.index(g[4]) for g in groups]
        L = len(labels)
        P0, Q0 = self.zmap(groups, np.zeros((len(groups), 2), int))
        inner = Q0 > 0
        if phimin is None:
            phimin = 0.4 * float(np.median(Q0[inner])) if inner.any() else 0.0
        if scale is None:
            scale = self.noise_scale(groups, sh, phimin)
        robust = robust and L >= 2
        chi2max = CHI2_CRIT.get(L - 1, 25.0)
        zmax = np.full((self.n, self.n), -np.inf, np.float32)
        ibest = np.zeros((self.n, self.n), np.int32)
        P = np.zeros((L, self.n, self.n), np.float32)
        Q = np.zeros((L, self.n, self.n), np.float32)
        for k in range(len(vel)):
            P[:] = 0
            Q[:] = 0
            for gi, (g, (dx, dy)) in enumerate(zip(groups, sh[k])):
                add_shift(P[li[gi]], g[0], int(dx), int(dy))
                add_shift(Q[li[gi]], g[1], int(dx), int(dy))
            Pt, Qt = P.sum(0), Q.sum(0)
            ok = Qt > phimin
            if robust:                                   # epochs must agree: chi2 of the epoch fluxes
                c2 = epoch_chi2(P, Q, scale, getattr(self, "_tau", 0.0), 0)
                nl = (Q > 0.1 * phimin / L).sum(0)
                ok &= (nl >= 2) & (c2 <= chi2max)
            z = np.where(ok, Pt / np.sqrt(np.where(ok, Qt, 1.0)), -np.inf) / scale
            b_ = z > zmax
            zmax[b_] = z[b_]
            ibest[b_] = k
        return zmax, ibest, scale, phimin

    def noise_scale(self, groups, sh, phimin, n=8):
        """Robust scatter of Z over the field at n random trial motions (pure noise mostly)."""
        rng = np.random.default_rng(1)
        ks = rng.choice(len(sh), size=min(n, len(sh)), replace=False)
        lat = np.zeros((self.n, self.n), bool)
        lat[8:-8:3, 8:-8:3] = True
        ss = []
        for k in ks:
            P, Q = self.zmap(groups, sh[k])
            ok = (Q > phimin) & lat
            if ok.sum() > 100:
                ss.append(FA.robust_sigma(P[ok] / np.sqrt(Q[ok])))
        return float(np.median(ss)) if ss else 1.0

    def at(self, groups, v, t_ref, per, scale, x, y):
        """Z, flux, per-group (flux, err) at stack pixel (x, y) for velocity v."""
        sh = self.shifts(groups, np.array([v], float), t_ref, per, exact=True)[0]
        P = Q = 0.0
        per_g = []
        for (psi, phi, mjd, key, season), (dx, dy) in zip(groups, sh):
            xf, yf = x + dx, y + dy
            x0, y0 = int(math.floor(xf)), int(math.floor(yf))
            if not (0 <= x0 < self.n - 1 and 0 <= y0 < self.n - 1):
                continue
            ax, ay = xf - x0, yf - y0
            wq = [((1 - ax) * (1 - ay), y0, x0), (ax * (1 - ay), y0, x0 + 1), ((1 - ax) * ay, y0 + 1, x0), (ax * ay, y0 + 1, x0 + 1)]
            p_ = sum(w * float(psi[j, i]) for w, j, i in wq)
            q_ = sum(w * float(phi[j, i]) for w, j, i in wq)
            if q_ > 0:
                P += p_
                Q += q_
                per_g.append((key, season, mjd, p_ / q_, scale / math.sqrt(q_)))
        if Q <= 0:
            return None
        ep = {}
        for key, season, mjd, f, e in per_g:                # epoch label = group label (season / visit)
            lab = [g[4] for g in groups if g[3] == key][0]
            q = ep.setdefault(lab, [0.0, 0.0])
            q[0] += f / e ** 2 * scale ** 2
            q[1] += scale ** 2 / e ** 2
        chi2 = float(epoch_chi2(np.array([a for a, b in ep.values()]), np.array([b for a, b in ep.values()]),
                                scale, getattr(self, "_tau", 0.0)))
        z = P / math.sqrt(Q) / scale
        zr = z if len(ep) >= 2 and chi2 <= CHI2_CRIT.get(len(ep) - 1, 25.0) else None
        return dict(z=z, z_robust=zr, chi2=chi2, n_epochs=len(ep), flux=P / Q, err=scale / math.sqrt(Q), groups=per_g)

    def refine(self, groups, v0, step, t_ref, per, scale, x, y, nf=9, vlim=None, robust=True):
        """Finer motion grid (step/4) and half-pixel positions around a peak, bilinear reads:
        best (z, v, x, y), motion errors from the curvature of Z^2 (Delta chi^2 = 1)."""
        offs = (np.arange(nf) - nf // 2) * (step / 4.0)
        fine = np.array([(v0[0] + a, v0[1] + b) for b in offs for a in offs])
        if vlim is not None:
            fine = fine[(np.abs(fine[:, 0]) <= vlim + 1e-9) & (np.abs(fine[:, 1]) <= vlim + 1e-9)]
        best = (-np.inf, tuple(v0), x, y)
        for dx in (-1, -0.5, 0, 0.5, 1):
            for dy in (-1, -0.5, 0, 0.5, 1):
                zr, z, f = self.z_many(groups, fine, t_ref, per, scale, x + dx, y + dy)
                st = zr if robust else z
                st = np.where(np.isfinite(st), st, -np.inf)
                k = int(np.argmax(st))
                if st[k] > best[0]:
                    best = (float(st[k]), tuple(fine[k]), x + dx, y + dy)
        # curvature of the full statistic along each axis through the best motion
        errs = []
        for ax_ in (0, 1):
            line = np.array([(best[1][0] + (a if ax_ == 0 else 0), best[1][1] + (a if ax_ == 1 else 0)) for a in offs])
            _, z, _ = self.z_many(groups, line, t_ref, per, scale, best[2], best[3])
            ok = np.isfinite(z)
            e = step
            if ok.sum() >= 4:
                c = np.polyfit(offs[ok], z[ok] ** 2, 2)[0]
                if c < 0:
                    e = min(math.sqrt(-1.0 / c), 3 * step)
            errs.append(e)
        return best, errs, None

    def z_many(self, groups, vel, t_ref, per, scale, x, y):
        """Vectorised: (robust Z, Z, flux) at stack pixel (x, y) for all velocities vel (V, 2)."""
        key = id(groups)
        if getattr(self, "_zm_key", None) != key:
            self._zm = (np.stack([g[0] for g in groups]), np.stack([g[1] for g in groups]))
            labels = sorted({g[4] for g in groups})
            oh = np.zeros((len(groups), len(labels)))
            for i, g in enumerate(groups):
                oh[i, labels.index(g[4])] = 1
            self._zm_oh, self._zm_key = oh, key
        PS, QS = self._zm
        sh = self.shifts(groups, np.asarray(vel, float), t_ref, per, exact=True)
        xf, yf = x + sh[..., 0], y + sh[..., 1]
        x0, y0 = np.floor(xf).astype(int), np.floor(yf).astype(int)
        fx, fy = xf - x0, yf - y0
        ok = (x0 >= 0) & (x0 < self.n - 1) & (y0 >= 0) & (y0 < self.n - 1)
        gi = np.broadcast_to(np.arange(len(groups))[None, :], x0.shape)
        xi, yi = np.clip(x0, 0, self.n - 2), np.clip(y0, 0, self.n - 2)

        def bil(A):
            v = ((1 - fx) * (1 - fy) * A[gi, yi, xi] + fx * (1 - fy) * A[gi, yi, xi + 1]
                 + (1 - fx) * fy * A[gi, yi + 1, xi] + fx * fy * A[gi, yi + 1, xi + 1])
            return np.where(ok, v, 0.0)
        pp, qq = bil(PS), bil(QS)
        Pl, Ql = pp @ self._zm_oh, qq @ self._zm_oh
        Pt, Qt = Pl.sum(1), Ql.sum(1)
        with np.errstate(all="ignore"):
            z = Pt / np.sqrt(Qt) / scale
            c2 = epoch_chi2(Pl, Ql, scale, getattr(self, "_tau", 0.0), 1)
            nl = (Ql > 0).sum(1)
            crit = CHI2_CRIT.get(Ql.shape[1] - 1, 25.0)
            zr = np.where((nl >= 2) & (c2 <= crit), z, np.nan)
            f = Pt / Qt
        return zr, z, f

    def z_aware(self, groups, vel, t_ref, per, scale, x, y):
        """Self-subtraction-aware statistic for the pm residuals (vectorised over vel).
        The leave-one-season-out template of season s contains the mover at its positions in
        the other seasons k (weight w_k), so the residual of s has the mover (+) at p_s and
        negative copies at p_k. Matching that whole pattern,
            Z = sum_g [psi_g(p_s) - sum_k w_k psi_g(p_k)] / sqrt(sum_g phi_g(p_s) (1 + sum_k w_k^2)),
        peaks at the true motion; the plain sum pushes the motion of a slow mover outwards."""
        key = id(groups)
        if getattr(self, "_zm_key", None) != key:
            self.z_many(groups, np.zeros((1, 2)), t_ref, per, scale, x, y)
        PS, QS = self._zm
        labs = sorted({g[4] for g in groups})
        lab_g = np.array([labs.index(g[4]) for g in groups])
        phiw = np.array([float(np.median(g[1][g[1] > 0])) if (g[1] > 0).any() else 0.0 for g in groups])
        Phi = np.array([phiw[lab_g == k].sum() for k in range(len(labs))])
        tk = np.array([np.sum(phiw[lab_g == k] * np.array([g[2] for g in groups])[lab_g == k]) / max(Phi[k], 1e-30)
                       for k in range(len(labs))])
        vel = np.asarray(vel, float)
        G = len(groups)
        gi = np.broadcast_to(np.arange(G)[None, :], (len(vel), G))

        def read(A, dts):                          # dts (G,) time offsets in velocity units
            dx = -vel[:, 0:1] * dts[None, :] / self.grid.pix
            dy = vel[:, 1:2] * dts[None, :] / self.grid.pix
            xf, yf = x + dx, y + dy
            x0, y0 = np.floor(xf).astype(int), np.floor(yf).astype(int)
            fx, fy = xf - x0, yf - y0
            ok = (x0 >= 0) & (x0 < self.n - 1) & (y0 >= 0) & (y0 < self.n - 1)
            xi, yi = np.clip(x0, 0, self.n - 2), np.clip(y0, 0, self.n - 2)
            v_ = ((1 - fx) * (1 - fy) * A[gi, yi, xi] + fx * (1 - fy) * A[gi, yi, xi + 1]
                  + (1 - fx) * fy * A[gi, yi + 1, xi] + fx * fy * A[gi, yi + 1, xi + 1])
            return np.where(ok, v_, 0.0)
        dt_own = np.array([(g[2] - t_ref) / per for g in groups])
        num = read(PS, dt_own)
        den = read(QS, dt_own)
        L = len(labs)
        W = np.zeros((G, L))                       # w_k of the template of group g
        for k in range(L):
            W[:, k] = np.where(lab_g != k, Phi[k] / np.maximum(Phi.sum() - Phi[lab_g], 1e-30), 0.0)
            if W[:, k].any():
                num = num - W[None, :, k] * read(PS, np.full(G, (tk[k] - t_ref) / per))
        # |m|^2 / phi = 1 - 2 sum_k w_k rho(p_g - p_k) + sum_kj w_k w_j rho(p_k - p_j), rho = normalised
        # autocorrelation of the effective PSF (positions overlap for slow motion)
        tg = np.array([g[2] for g in groups])

        def disp(dt):                               # (V, ...) pixel displacement for time differences dt
            dt = np.asarray(dt) / per
            return (-vel[:, 0].reshape((-1,) + (1,) * dt.ndim) * dt / self.grid.pix,
                    vel[:, 1].reshape((-1,) + (1,) * dt.ndim) * dt / self.grid.pix)
        r_gk = self.rho(*disp(tg[:, None] - tk[None, :]))           # (V, G, L)
        r_kj = self.rho(*disp(tk[:, None] - tk[None, :]))           # (V, L, L)
        m2 = 1 - 2 * np.einsum("gk,vgk->vg", W, r_gk) + np.einsum("gk,gj,vkj->vg", W, W, r_kj)
        P, Q = num.sum(1), (den * np.maximum(m2, 1e-3)).sum(1)
        with np.errstate(all="ignore"):
            return np.where(Q > 0, P / np.sqrt(np.where(Q > 0, Q, 1)), np.nan) / scale

    def rho(self, dx, dy):
        """Normalised autocorrelation of the mean effective PSF at pixel displacement (dx, dy)."""
        if getattr(self, "_acorr", None) is None:
            from scipy.signal import fftconvolve
            K = np.mean([self.lay.kernel(e) for e in self.exps[::max(1, len(self.exps) // 40)]], axis=0)
            A = fftconvolve(K, K[::-1, ::-1], mode="full")
            self._acorr = (A / A.max()).astype(np.float64)
        from scipy.ndimage import map_coordinates
        A = self._acorr
        c = (A.shape[0] - 1) / 2
        dx, dy = np.broadcast_arrays(np.asarray(dx, float), np.asarray(dy, float))
        v = map_coordinates(A, [dy.ravel() + c, dx.ravel() + c], order=1, mode="constant", cval=0.0)
        return v.reshape(dx.shape)

    def raw_check(self, groups, v, x, y, t_ref, per, scale, flux, vel=None, step=1.0, vmin=PM_VMIN):
        """For a pm peak found in the residuals: (1) the brightest STATIC source along the path
        (PSF flux in the all-exposure stack); if it is > STATIC_RATIO x the peak flux the peak is
        probably a residual of that star; (2) the motion re-measured on the raw (not template
        subtracted) co-moving stack with the robust statistic, over the whole trial grid and
        +-2 px: template subtraction pushes the positive lobes of a slow mover apart and
        exaggerates its motion."""
        out = {"flags": []}
        if getattr(self, "_static_F", None) is None and self._static is not None:
            stt = self._static
            ok = np.isfinite(stt["img"]) & np.isfinite(stt["var"])
            self._static_F = FA.matched(stt["img"], stt["var"], stt["K"], ok)[0]
        sh = self.shifts([(None, None, mjd) for mjd in sorted({g[2] for g in groups})], np.array([v], float), t_ref, per)[0]
        fs = 0.0
        for dx, dy in sh:
            xx, yy = int(round(x)) + int(dx), int(round(y)) + int(dy)
            if 0 <= xx < self.n and 0 <= yy < self.n and np.isfinite(self._static_F[yy, xx]):
                fs = max(fs, float(self._static_F[yy, xx]))
        out["static_flux_on_path_ujy"] = round(fs, 1)
        if flux > 0 and fs > STATIC_RATIO * flux:
            out["flags"].append(f"static star on the path ({fs:.0f} uJy): probably its residual")
        if vel is None:
            return out
        best = (-np.inf, None, None)
        for dx in np.arange(-2, 2.01, 0.5):
            for dy in np.arange(-2, 2.01, 0.5):
                za = self.z_aware(groups, vel, t_ref, per, scale, x + dx, y + dy)
                k = int(np.nanargmax(np.where(np.isfinite(za), za, -np.inf)))
                if za[k] > best[0]:
                    best = (float(za[k]), vel[k], (x + dx, y + dy))
        if best[1] is None:
            return out
        offs = np.arange(-1.0, 1.0 + 1e-9, 0.125) * step          # finer motion grid around it
        fine = np.array([(best[1][0] + a, best[1][1] + b) for a in offs for b in offs])
        za = self.z_aware(groups, fine, t_ref, per, scale, *best[2])
        k = int(np.nanargmax(np.where(np.isfinite(za), za, -np.inf)))
        vb = fine[k]
        slow = math.hypot(*vb) < vmin
        edge = max(abs(vb[0]), abs(vb[1])) >= float(np.max(np.abs(vel))) - 1e-6
        out["raw"] = {"snr_aware": round(float(za[k]), 2), "v_east": round(float(vb[0]), 2),
                      "v_north": round(float(vb[1]), 2), "at_edge": bool(slow or edge), "x": best[2][0], "y": best[2][1]}
        if slow or edge:
            out["flags"].append("self-subtraction-aware motion at the grid limits (motion kept from the residuals)")
        return out

    # ---- proper motion: season-level, self-subtraction-aware statistic -------------------------
    def season_maps(self, groups):
        """Per season: summed psi/phi, phi-weighted mean time, template weights W[s, k] (share of
        season k in the leave-one-season-out template of season s)."""
        labs = sorted({g[4] for g in groups})
        P, Q, t, Phi = [], [], [], []
        for lab in labs:
            gs = [g for g in groups if g[4] == lab]
            P.append(np.sum([g[0] for g in gs], axis=0))
            Q.append(np.sum([g[1] for g in gs], axis=0))
            w = np.array([float(np.median(g[1][g[1] > 0])) if (g[1] > 0).any() else 0.0 for g in gs])
            t.append(float(np.sum(w * np.array([g[2] for g in gs])) / max(w.sum(), 1e-30)))
            Phi.append(float(w.sum()))
        Phi = np.array(Phi)
        L = len(labs)
        W = np.zeros((L, L))
        for a in range(L):
            for k in range(L):
                if k != a:
                    W[a, k] = Phi[k] / max(Phi.sum() - Phi[a], 1e-30)
        return dict(labels=labs, P=np.stack(P).astype(np.float32), Q=np.stack(Q).astype(np.float32), t=np.array(t), W=W)

    def m2(self, SM, vel, per):
        """|m|^2 / phi per (velocity, season): the self-subtracted pattern's norm (PSF overlap)."""
        dts = SM["t"] / per
        dd = dts[:, None] - dts[None, :]
        dx = -vel[:, 0][:, None, None] * dd[None] / self.grid.pix
        dy = vel[:, 1][:, None, None] * dd[None] / self.grid.pix
        R = self.rho(dx, dy)                                         # (V, L, L)
        W = SM["W"]
        return 1 - 2 * np.einsum("sk,vsk->vs", W, R) + np.einsum("sk,sj,vkj->vs", W, W, R)

    def cube_aware(self, SM, vel, t_ref, per, scale=None, m2min=0.08):
        """Max over velocities of the self-subtraction-aware Z, with the season chi2 test. The plain
        model (no negative copies) is evaluated too and the larger passing Z kept: a bright mover is
        clipped out of the templates (deep_stack's 5 sigma clip), so it leaves no negative copies."""
        L, n = len(SM["labels"]), self.n
        dts = (SM["t"] - t_ref) / per
        sx = np.rint(-vel[:, 0][:, None] * dts[None] / self.grid.pix).astype(int)
        sy = np.rint(vel[:, 1][:, None] * dts[None] / self.grid.pix).astype(int)
        M2 = self.m2(SM, vel, per)
        Q0 = SM["Q"].sum(0)
        phimin = 0.4 * float(np.median(Q0[Q0 > 0])) if (Q0 > 0).any() else 0.0
        chi2max = CHI2_CRIT.get(L - 1, 25.0)
        A = np.zeros((L, n, n), np.float32)
        D = np.zeros((L, n, n), np.float32)
        A0 = np.zeros((L, n, n), np.float32)
        D0 = np.zeros((L, n, n), np.float32)
        C = np.zeros((n, n), np.float32)
        tmp = np.zeros((n, n), np.float32)

        def zfor(k, sc=1.0, plain=False):
            A[:] = 0; D[:] = 0; C[:] = 0
            for a in range(L):
                add_shift(A[a], SM["P"][a], int(sx[k, a]), int(sy[k, a]))
                add_shift(D[a], SM["Q"][a], int(sx[k, a]), int(sy[k, a]))
                add_shift(C, SM["Q"][a], int(sx[k, a]), int(sy[k, a]))
                A0[a] = A[a]
                D0[a] = D[a]
                for b in range(L):
                    if b != a and SM["W"][a, b] > 0:
                        tmp[:] = 0
                        add_shift(tmp, SM["P"][a], int(sx[k, b]), int(sy[k, b]))
                        A[a] -= SM["W"][a, b] * tmp
                D[a] *= max(M2[k, a], 1e-3)
            At, Dt = A.sum(0), D.sum(0)
            with np.errstate(all="ignore"):
                z = np.where(Dt > 0, At / np.sqrt(np.where(Dt > 0, Dt, 1.0)), -np.inf)
            c2 = epoch_chi2(A, D, sc, getattr(self, "_tau", 0.0), 0)
            nl = (D > 0).sum(0)
            ok = (C > phimin) & (nl >= 2) & (float(np.mean(M2[k])) >= m2min)
            if not plain:
                return z, c2, ok
            Dt0 = D0.sum(0)
            with np.errstate(all="ignore"):
                z0 = np.where(Dt0 > 0, A0.sum(0) / np.sqrt(np.where(Dt0 > 0, Dt0, 1.0)), -np.inf)
            c20 = epoch_chi2(A0, D0, sc, getattr(self, "_tau", 0.0), 0)
            ok0 = (C > phimin) & (nl >= 2)
            return z, c2, ok, z0, c20, ok0
        if scale is None:
            rng = np.random.default_rng(1)
            far = np.nonzero(np.hypot(vel[:, 0], vel[:, 1]) >= 0.5 * np.max(np.abs(vel)))[0]
            lat = np.zeros((n, n), bool)
            lat[8:-8:3, 8:-8:3] = True
            ss = []
            for k in rng.choice(far, size=min(8, len(far)), replace=False):
                z, c2, ok = zfor(k)
                m = ok & lat & np.isfinite(z)
                if m.sum() > 100:
                    ss.append(FA.robust_sigma(z[m]))
            scale = float(np.median(ss)) if ss else 1.0
        zmax = np.full((n, n), -np.inf, np.float32)
        ibest = np.zeros((n, n), np.int32)
        for k in range(len(vel)):
            z, c2, ok, z0, c20, ok0 = zfor(k, scale, plain=True)
            z = np.maximum(np.where(ok & (c2 <= chi2max), z / scale, -np.inf),
                           np.where(ok0 & (c20 <= chi2max), z0 / scale, -np.inf))
            b_ = z > zmax
            zmax[b_] = z[b_]
            ibest[b_] = k
        return zmax, ibest, scale

    def aware_many(self, SM, vel, t_ref, per, scale, x, y):
        """Vectorised season-level aware statistic at (x, y) (bilinear): z, chi2, per-season A, D."""
        vel = np.atleast_2d(np.asarray(vel, float))
        L = len(SM["labels"])
        dts = (SM["t"] - t_ref) / per
        xf = x + (-vel[:, 0][:, None] * dts[None] / self.grid.pix)          # (V, L): position in season k
        yf = y + (vel[:, 1][:, None] * dts[None] / self.grid.pix)

        def bil(img, X, Y):
            x0, y0 = np.floor(X).astype(int), np.floor(Y).astype(int)
            fx, fy = X - x0, Y - y0
            ok = (x0 >= 0) & (x0 < self.n - 1) & (y0 >= 0) & (y0 < self.n - 1)
            xi, yi = np.clip(x0, 0, self.n - 2), np.clip(y0, 0, self.n - 2)
            v = ((1 - fx) * (1 - fy) * img[yi, xi] + fx * (1 - fy) * img[yi, xi + 1]
                 + (1 - fx) * fy * img[yi + 1, xi] + fx * fy * img[yi + 1, xi + 1])
            return np.where(ok, v, 0.0)
        M2 = self.m2(SM, vel, per)
        A = np.zeros((len(vel), L))
        D = np.zeros((len(vel), L))
        for a in range(L):
            A[:, a] = bil(SM["P"][a], xf[:, a], yf[:, a])
            D[:, a] = bil(SM["Q"][a], xf[:, a], yf[:, a]) * np.maximum(M2[:, a], 1e-3)
            for b in range(L):
                if b != a and SM["W"][a, b] > 0:
                    A[:, a] -= SM["W"][a, b] * bil(SM["P"][a], xf[:, b], yf[:, b])
        At, Dt = A.sum(1), D.sum(1)
        with np.errstate(all="ignore"):
            z = np.where(Dt > 0, At / np.sqrt(Dt), np.nan) / scale
        c2 = epoch_chi2(A, D, scale, getattr(self, "_tau", 0.0), 1)
        return z, c2, A, D

    def peaks_aware(self, SM, vel, zmax, ib, scale, t_ref, per, step, threshold, vmin, max_peaks):
        from scipy.ndimage import maximum_filter
        a = np.where(np.isfinite(zmax), zmax, -np.inf)
        mx = maximum_filter(a, size=7, mode="constant", cval=-np.inf)
        edge = np.zeros_like(a, bool)
        edge[6:-6, 6:-6] = True
        ys, xs = np.nonzero((a == mx) & (a >= threshold) & edge)
        cand = sorted(zip(xs, ys), key=lambda p: -a[p[1], p[0]])[:4 * max_peaks]   # refinement drops many
        vlim = float(np.max(np.abs(vel)))
        L = len(SM["labels"])
        crit = CHI2_CRIT.get(L - 1, 25.0)
        if getattr(self, "_static_F", None) is None and getattr(self, "_static", None) is not None:
            stt = self._static
            self._static_F = FA.matched(stt["img"], stt["var"], stt["K"], np.isfinite(stt["img"]) & np.isfinite(stt["var"]))[0]
        SM0 = dict(SM, W=np.zeros_like(SM["W"]))       # plain model: no negative copies (bright movers)
        offs = (np.arange(9) - 4) * (step / 4.0)
        peaks = []
        for x, y in cand:
            best = (-np.inf, tuple(vel[ib[y, x]]), float(x), float(y), "aware")
            for mname, S_ in (("aware", SM), ("plain", SM0)):     # coarse: every trial motion, both models
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        z, c2, _, _ = self.aware_many(S_, vel, t_ref, per, scale, x + dx, y + dy)
                        z = np.where(np.isfinite(z) & (c2 <= crit), z, -np.inf)
                        k = int(np.argmax(z))
                        if z[k] > best[0]:
                            best = (float(z[k]), tuple(vel[k]), x + dx, y + dy, mname)
            model = best[4]
            S_ = SM if model == "aware" else SM0
            v0 = best[1]
            fine = np.array([(v0[0] + p, v0[1] + q) for q in offs for p in offs])
            fine = fine[(np.abs(fine[:, 0]) <= vlim + 1e-9) & (np.abs(fine[:, 1]) <= vlim + 1e-9)]
            for dx in (-1, -0.5, 0, 0.5, 1):
                for dy in (-1, -0.5, 0, 0.5, 1):
                    z, c2, _, _ = self.aware_many(S_, fine, t_ref, per, scale, best[2] + dx, best[3] + dy)
                    z = np.where(np.isfinite(z) & (c2 <= crit), z, -np.inf)
                    k = int(np.argmax(z))
                    if z[k] > best[0]:
                        best = (float(z[k]), tuple(fine[k]), best[2] + dx, best[3] + dy, model)
            if not np.isfinite(best[0]) or best[0] < threshold:
                continue
            zb, v, bx, by, _ = best
            errs = []
            for ax_ in (0, 1):
                line = np.array([(v[0] + (o if ax_ == 0 else 0), v[1] + (o if ax_ == 1 else 0)) for o in offs])
                z, _, _, _ = self.aware_many(S_, line, t_ref, per, scale, bx, by)
                ok = np.isfinite(z)
                e = step
                if ok.sum() >= 4:
                    c = np.polyfit(offs[ok], z[ok] ** 2, 2)[0]
                    if c < 0:
                        e = min(math.sqrt(-1.0 / c), 3 * step)
                errs.append(e)
            z, c2, A, D = self.aware_many(S_, np.array([v]), t_ref, per, scale, bx, by)
            A, D = A[0], D[0]
            flux = float(A.sum() / D.sum())
            ra, dec = (float(q[0]) for q in self.grid.to_world(bx, by))
            epochs = []
            for i_, lab in enumerate(SM["labels"]):
                if D[i_] > 0:
                    epochs.append(dict(epoch=str(lab), mjd=float(SM["t"][i_]), flux_ujy=round(float(A[i_] / D[i_]), 2),
                                       err_ujy=round(float(scale / math.sqrt(D[i_])), 2),
                                       snr=round(float(A[i_] / math.sqrt(D[i_]) / scale), 2), n=1))
            n_pos = sum(q["snr"] >= MIN_EPOCH_SNR for q in epochs)
            speed = math.hypot(*v)
            pa = math.degrees(math.atan2(v[0], v[1])) % 360
            flags = []
            if speed < vmin:
                flags.append("slow: within the PSF over the baseline (static-like)")
            if n_pos < 2:
                flags.append("seen in one season only")
            if max(abs(v[0]), abs(v[1])) >= vlim - 1e-6:
                flags.append("best motion at the edge of the trial grid")
            fs = 0.0                                # brightest static source along the path
            for i_ in range(L):
                dtk = (SM["t"][i_] - t_ref) / per
                xx, yy = int(round(bx - v[0] * dtk / self.grid.pix)), int(round(by + v[1] * dtk / self.grid.pix))
                if 0 <= xx < self.n and 0 <= yy < self.n and np.isfinite(self._static_F[yy, xx]):
                    fs = max(fs, float(self._static_F[yy, xx]))
            if flux > 0 and fs > STATIC_RATIO * flux:
                flags.append(f"static star on the path ({fs:.0f} uJy): probably its residual")
            peaks.append(dict(x=float(bx), y=float(by), ra=ra, dec=dec, snr=round(zb, 2), chi2=round(float(c2[0]), 2),
                              flux_ujy=round(flux, 2), flux_err_ujy=round(float(scale / math.sqrt(D.sum())), 2),
                              mag_ab=FA.ab_mag(flux), v_east=round(float(v[0]), 3), v_north=round(float(v[1]), 3),
                              v_err=[round(float(e_), 3) for e_ in errs], speed=round(speed, 3), pa_deg=round(pa, 1),
                              epochs=epochs, n_epochs_snr2=n_pos, flags=flags, static_flux_on_path_ujy=round(fs, 1),
                              self_subtraction_m2=round(float(np.mean(self.m2(S_, np.array([v]), per)[0])), 3),
                              model=("self-subtraction aware" if model == "aware" else
                                     "plain (bright: clipped out of the templates)"),
                              motion_text=f'{speed:.1f}"/yr toward PA {pa:.0f}°'))
        peaks.sort(key=lambda p: -p["snr"])
        kept = []                                   # one object, one peak (its S/N is flat along the speed)
        for p in peaks:
            if any(math.hypot(p["x"] - q["x"], p["y"] - q["y"]) < 4 for q in kept):
                continue
            kept.append(p)
        kept = kept[:max_peaks]
        return dict(peaks=kept, threshold=threshold, statistic=(
            "self-subtraction-aware matched filter on leave-one-season-out residuals (the mover's negative copies in "
            "the templates are part of the model; flux = true flux); only paths whose season fluxes agree "
            "(chi2, p = 0.001) and that >= 2 seasons cover count"))

    # ---- modes -------------------------------------------------------------------------------
    def pm(self, vmax=PM_VMAX, step=PM_STEP, eps=EPS_MODEL["pm"], threshold=THRESH["pm"], vmin=PM_VMIN,
           exps=None, max_peaks=25, lam_range=None):
        """Proper-motion search across seasons ("/yr). Templates: other seasons, same detector.
        lam_range=(lo, hi) um restricts the exposures (e.g. (3.0, 5.1) for cold brown dwarfs)."""
        t0 = time.time()
        self._tau = TAU_EPOCH["pm"]
        exps = exps or self.exps
        if lam_range:
            exps = [e for e in exps if lam_range[0] <= e["wavelength_um"] < lam_range[1]]
        seasons = sorted({e["epoch"] for e in exps})
        if len(seasons) < 2:
            return dict(mode="pm", error="needs >= 2 seasons", peaks=[])
        by = {}
        for e in exps:
            by.setdefault((e["det"], e["epoch"]), []).append(e)

        def tmpl_of(e):
            others = [o for (d, s), es in by.items() if d == e["det"] and s != e["epoch"] for o in es]
            return self.matched_template(e, others, ("pm", e["epoch"]))
        groups = self.groups(exps, tmpl_of, eps, lambda e: e["visit"])
        self._static = FA.deep_stack(exps, self.lay)
        w = np.array([float(np.median(g[1][g[1] > 0])) if (g[1] > 0).any() else 0 for g in groups])
        t_ref = float(np.sum(w * np.array([g[2] for g in groups])) / np.sum(w))
        ax = np.arange(-vmax, vmax + 1e-9, step)
        vel = np.array([(a, b) for a in ax for b in ax], float)
        SM = self.season_maps(groups)
        zmax, ib, scale = self.cube_aware(SM, vel, t_ref, 365.25)
        res = self.peaks_aware(SM, vel, zmax, ib, scale, t_ref, 365.25, step, threshold, vmin, max_peaks)
        self._SM = SM
        res.update(mode="pm", unit="arcsec/yr", n_velocities=len(vel), vmax=vmax, step=step, eps_model=eps,
                   t_ref_mjd=t_ref, t_ref_jyear=_jyear(t_ref), n_groups=len(groups), seasons=seasons,
                   noise_scale=round(scale, 3), seconds=round(time.time() - t0, 1), lam_range=lam_range,
                   _zmax=zmax, _ib=ib, _vel=vel,
                   _groups=groups, _scale=scale)
        return res

    def sso(self, vmax=SSO_VMAX, vmin=SSO_VMIN, eps=EPS_MODEL["sso"], threshold=THRESH["sso"],
            window_h=SSO_WINDOW_H, cone_deg=SSO_CONE_DEG, max_v=SSO_MAX_V, windows=None, max_peaks=10):
        """Fast-mover search within visit windows ("/h). Templates: same detector and season,
        exposures outside the window. Trial directions within cone_deg of the ecliptic."""
        t0 = time.time()
        self._tau = TAU_EPOCH["sso"]
        pa_ecl, beta = ecliptic_pa(self.grid.ra, self.grid.dec)
        vis = {}
        for e in self.exps:
            vis.setdefault(e["visit"], []).append(e)
        order = sorted(vis, key=lambda v: min(e["mjd"] for e in vis[v]))
        if windows is None:
            windows, cur = [], []
            for v in order:
                t = min(e["mjd"] for e in vis[v])
                if cur and (t - min(e["mjd"] for e in vis[cur[0]])) * 24 > window_h:
                    windows.append(cur)
                    cur = []
                cur.append(v)
            if cur:
                windows.append(cur)
            windows = [w for w in windows if len(w) >= 2]
        by = {}
        for e in self.exps:
            by.setdefault((e["det"], e["epoch"]), []).append(e)
        all_peaks, runs = [], []
        best_map, best_z = None, -np.inf
        zall = np.full((self.n, self.n), -np.inf, np.float32)
        for wi, wv in enumerate(windows):
            es = [e for v in wv for e in vis[v]]
            wset = set(wv)

            def tmpl_of(e, wset=wset, wi=wi):
                others = [o for o in by[(e["det"], e["epoch"])] if o["visit"] not in wset]
                return self.matched_template(e, others, ("sso", wi, e["epoch"])) if len(others) >= 3 else None
            groups = self.groups(es, tmpl_of, eps, lambda e: round(e["mjd"], 4), label=lambda e: int(e["visit"]))
            if len(groups) < 2:
                continue
            span_h = (groups[-1][2] - groups[0][2]) * 24
            t_ref = float(np.mean([g[2] for g in groups]))
            step = max(3.0 / max(span_h / 2, 1e-3), 0.25)          # <= 1 px drift at the window ends
            vel = self._cone_grid(vmax, vmin, step, pa_ecl, cone_deg)
            while len(vel) > max_v:
                step *= 1.15
                vel = self._cone_grid(vmax, vmin, step, pa_ecl, cone_deg)
            zmax, ib, scale, phimin = self.cube_max(groups, vel, t_ref, 1 / 24.0)
            res = self._peaks("sso", groups, vel, zmax, ib, scale, t_ref, 1 / 24.0, step, threshold, vmin, max_peaks)
            res.update(window=wi, visits=[int(v) for v in wv], span_h=round(span_h, 2), n_groups=len(groups),
                       n_velocities=len(vel), step=round(step, 3), t_ref_mjd=t_ref, noise_scale=round(scale, 3),
                       season=es[0]["epoch"])
            zall = np.maximum(zall, zmax)
            if res["peaks"] and res["peaks"][0]["snr"] > best_z:
                best_z = res["peaks"][0]["snr"]
                best_map = (wi, groups, vel, zmax, ib, scale, t_ref, step)
            all_peaks += [dict(p, window=wi) for p in res["peaks"]]
            runs.append({k: v for k, v in res.items() if k != "peaks"})
            self.log(f"  sso window {wi} ({len(wv)} visits, {span_h:.1f} h, {len(vel)} motions): "
                     f"{len(res['peaks'])} peaks >= {threshold}" + (f", best {res['peaks'][0]['snr']:.1f}" if res["peaks"] else ""))
        all_peaks.sort(key=lambda p: -p["snr"])
        return dict(mode="sso", unit="arcsec/h", ecliptic_pa_deg=round(pa_ecl, 1), ecliptic_lat_deg=round(beta, 2),
                    cone_deg=cone_deg, vmax=vmax, vmin=vmin, threshold=threshold, windows=runs, peaks=all_peaks,
                    n_velocities=int(np.median([r["n_velocities"] for r in runs])) if runs else 0,
                    seconds=round(time.time() - t0, 1), _zmax=zall, _best=best_map)

    @staticmethod
    def _cone_grid(vmax, vmin, step, pa, cone):
        ax = np.arange(-vmax, vmax + 1e-9, step)
        vv = np.array([(a, b) for a in ax for b in ax], float)
        sp = np.hypot(vv[:, 0], vv[:, 1])
        ang = np.degrees(np.arctan2(vv[:, 0], vv[:, 1])) % 360
        d = np.abs((ang - pa + 90) % 180 - 90)                     # angle to the ecliptic line
        return vv[(sp >= vmin) & (sp <= vmax) & (d <= cone)]

    def _peaks(self, mode, groups, vel, zmax, ib, scale, t_ref, per, step, threshold, vmin, max_peaks):
        from scipy.ndimage import maximum_filter
        a = np.where(np.isfinite(zmax), zmax, -np.inf)
        mx = maximum_filter(a, size=7, mode="constant", cval=-np.inf)
        edge = np.zeros_like(a, bool)
        edge[6:-6, 6:-6] = True
        ys, xs = np.nonzero((a == mx) & (a >= threshold) & edge)
        cand = sorted(zip(xs, ys), key=lambda p: -a[p[1], p[0]])[:4 * max_peaks]   # refinement drops many
        peaks = []
        for x, y in cand:
            v0 = vel[ib[y, x]]
            vlim = float(np.max(np.abs(vel))) if mode == "pm" else None
            (z, v, bx, by), errs, _ = self.refine(groups, v0, step, t_ref, per, scale, x, y, vlim=vlim)
            r = self.at(groups, v, t_ref, per, scale, bx, by)
            if r is None or not np.isfinite(z):
                continue
            ra, dec = (float(q[0]) for q in self.grid.to_world(bx, by))
            # per epoch (season for pm, visit for sso): combined flux along the path
            ep = {}
            for key, season, mjd, f, e in r["groups"]:
                ep.setdefault(season, []).append((f, e, mjd))
            epochs = []
            for k, lst in ep.items():
                wts = np.array([1 / e ** 2 for _, e, _ in lst])
                f = float(np.sum(wts * np.array([f for f, _, _ in lst])) / wts.sum())
                epochs.append(dict(epoch=str(k), mjd=float(np.mean([m for *_, m in lst])), flux_ujy=round(f, 2),
                                   err_ujy=round(float(1 / math.sqrt(wts.sum())), 2), snr=round(f * math.sqrt(wts.sum()), 2),
                                   n=len(lst)))
            n_pos = sum(q["snr"] >= MIN_EPOCH_SNR for q in epochs)
            extra = {}
            if mode == "pm" and getattr(self, "_static", None) is not None:
                extra = self.raw_check(groups, v, bx, by, t_ref, per, scale, r["flux"], vel=vel, step=step, vmin=vmin)
            speed = math.hypot(*v)
            flags = []
            if speed < vmin:
                flags.append("slow: within the PSF over the baseline (static-like)")
            if n_pos < 2:
                flags.append(f"seen in one {'season' if mode == 'pm' else 'visit'} only")
            if vlim is not None and max(abs(v[0]), abs(v[1])) >= vlim - 1e-6:
                flags.append("best motion at the edge of the trial grid")
            flags += extra.pop("flags", [])
            unit = '"/yr' if mode == "pm" else '"/h'
            peaks.append(dict(x=float(bx), y=float(by), ra=ra, dec=dec, snr=round(float(z), 2),
                              snr_all=round(float(r["z"]), 2), flux_ujy=round(r["flux"], 2),
                              flux_err_ujy=round(r["err"], 2), mag_ab=FA.ab_mag(r["flux"]),
                              v_east=round(float(v[0]), 3), v_north=round(float(v[1]), 3),
                              v_err=[round(float(e_), 3) for e_ in errs], speed=round(speed, 3),
                              pa_deg=round(math.degrees(math.atan2(v[0], v[1])) % 360, 1), epochs=epochs,
                              n_epochs_snr2=n_pos, flags=flags, **extra,
                              motion_text=f"{speed:.1f}{unit} toward PA {math.degrees(math.atan2(v[0], v[1])) % 360:.0f}°"))
        peaks.sort(key=lambda p: -p["snr"])
        kept = []                                   # one object can give 2 peaks (dipole lobes)
        for p in peaks:
            pv = best_v(p)
            if any(math.hypot(p["x"] - q["x"], p["y"] - q["y"]) < 4 and
                   math.hypot(pv[0] - best_v(q)[0], pv[1] - best_v(q)[1]) < 2 * step for q in kept):
                continue
            kept.append(p)
        peaks = kept[:max_peaks]
        return dict(peaks=peaks, threshold=threshold, statistic=(
            "S/N along the path, all epochs; only paths whose epoch fluxes agree (chi2, p = 0.001) and that "
            ">= 2 epochs cover count (robust against single-epoch residuals)"))

    # ---- forced measurement along a known track ------------------------------------------------
    def forced(self, track, exps=None, mode="pm", eps=None, raw=False):
        """Flux along a known path. track(mjd) -> (ra, dec). raw=True: no template subtraction
        (use when the object moves less than the PSF over the baseline); otherwise the pm
        templates (other seasons). Returns per season and total (flux, err, S/N)."""
        exps = exps or self.exps
        by = {}
        for e in exps:
            by.setdefault((e["det"], e["epoch"]), []).append(e)
        eps = EPS_MODEL["pm"] if eps is None else eps
        rows = []
        zero = {"img": np.zeros((self.n, self.n), np.float32), "var": np.zeros((self.n, self.n), np.float32),
                "mask": np.zeros((self.n, self.n), bool)}
        for e in exps:
            if raw:
                T = zero
            else:
                others = [o for (d, s), es in by.items() if d == e["det"] and s != e["epoch"] for o in es]
                T = self.matched_template(e, others, ("pm", e["epoch"]))
                if T is None:
                    continue
            f = self.filtered(e, T, 0.0 if raw else eps)
            if f is None:
                continue
            ra, dec = track(e["mjd"])
            gx, gy = (float(q[0]) for q in self.grid.to_pix(ra, dec))
            # bilinear read of psi/phi at the exact position
            from scipy.ndimage import map_coordinates
            p = float(map_coordinates(f[0], [[gy], [gx]], order=1, mode="constant", cval=0.0)[0])
            q = float(map_coordinates(f[1], [[gy], [gx]], order=1, mode="constant", cval=0.0)[0])
            if q <= 0:
                continue
            rows.append(dict(file=e["file"], epoch=e["epoch"], detector=e["detector"], wavelength_um=e["wavelength_um"],
                             mjd=e["mjd"], psi=p, phi=q))
        return rows


def _jyear(mjd):
    return 2000.0 + (mjd - 51544.5) / 365.25


def combine_forced(rows, scale, key=None):
    """Inverse-variance combination of forced rows (psi, phi), errors x scale."""
    out = {}
    for r in rows:
        k = key(r) if key else "all"
        out.setdefault(k, [0.0, 0.0, 0])
        out[k][0] += r["psi"]
        out[k][1] += r["phi"]
        out[k][2] += 1
    res = {}
    for k, (P, Q, n) in out.items():
        f, e = P / Q, scale / math.sqrt(Q)
        res[k] = dict(flux_ujy=round(f, 2), err_ujy=round(e, 2), snr=round(f / e, 2), n=n,
                      limit5_ujy=round(5 * e + max(f, 0), 2), limit5_ab=FA.ab_mag(5 * e + max(f, 0)))
    return res


# ------------------------------------------------------------------------------------- outputs
def peak_png(zmax, peaks, path, title, threshold, overwrite=False, vmax=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    if Path(path).exists() and not overwrite:
        raise FileExistsError(path)
    n = zmax.shape[0]
    half = n * BL.PIX_ARCSEC / 2 / 60
    z = np.where(np.isfinite(zmax), zmax, np.nan)
    if not np.isfinite(z).any():
        z = np.zeros_like(z)
    fig, ax = plt.subplots(figsize=(5.2, 4.6), dpi=110)
    im = ax.imshow(np.flipud(z), cmap="magma", vmin=0, vmax=vmax or max(threshold + 2, np.nanpercentile(z, 99.9)),
                   extent=[half, -half, -half, half], interpolation="nearest")
    for k, p in enumerate(peaks):
        xo = (p["x"] - (n - 1) / 2) * BL.PIX_ARCSEC / 60
        yo = (p["y"] - (n - 1) / 2) * BL.PIX_ARCSEC / 60
        ax.add_patch(plt.Circle((-xo, yo), 0.35, fill=False, color="#5df2ff", lw=1.2))
        ax.text(-xo + 0.45, yo + 0.35, str(k + 1), color="#5df2ff", fontsize=8)
    ax.set_xlabel("east  <-  offset (arcmin)  ->  west")
    ax.set_ylabel("north offset (arcmin)")
    ax.set_title(title, fontsize=9)
    fig.colorbar(im, ax=ax, label="best S/N over trial motions")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def vmap_png(search, res, peak, path, overwrite=False):
    """Z against trial motion at the peak position (pm mode)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    if Path(path).exists() and not overwrite:
        raise FileExistsError(path)
    vel, scale = res["_vel"], res["_scale"]
    ax_ = np.unique(vel[:, 0])
    Z = np.full((len(ax_), len(ax_)), np.nan)
    z, c2, _, _ = search.aware_many(search._SM, vel, res["t_ref_mjd"], 365.25, scale, peak["x"], peak["y"])
    for k, v in enumerate(vel):
        i, j = np.searchsorted(ax_, v[0]), np.searchsorted(ax_, v[1])
        Z[j, i] = z[k]
    fig, ax = plt.subplots(figsize=(4.6, 4.2), dpi=110)
    im = ax.imshow(Z, origin="lower", cmap="viridis", extent=[ax_[0], ax_[-1], ax_[0], ax_[-1]], interpolation="nearest")
    ax.plot([peak["v_east"]], [peak["v_north"]], "r+", ms=12)
    ax.set_xlabel('trial motion east ("/yr)')
    ax.set_ylabel('trial motion north ("/yr)')
    ax.set_title(f'S/N vs motion at peak 1 (best {peak["snr"]:.1f})', fontsize=9)
    fig.colorbar(im, ax=ax, label="S/N")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def best_v(p):
    """Motion of a peak: the self-subtraction-aware refit when it is inside the grid, else the residual's."""
    raw = p.get("raw")
    if raw and not raw["at_edge"]:
        return raw["v_east"], raw["v_north"]
    return p["v_east"], p["v_north"]


def gaia_match(run, peaks, t_ref_jyear, radius=8.0, dv=6.0):
    """Known movers among the peaks: the field's target (by position at t_ref), and Gaia DR3 stars
    with |pm| > 0.5"/yr (moved to t_ref; position and motion within dv). dv is wide: the measured
    motion of slow or bright movers is biased by several "/yr (FAINT.md, tests)."""
    gj = None
    for cand in ([BL.ROOT / "site" / "data" / run.name / "gaia_field.json"] if run.name else []) + \
                ([run.out_dir / "gaia_field.json"] if run.out_dir else []):
        if cand and Path(cand).exists():
            gj = json.loads(Path(cand).read_text())
            break
    t = run.target or {}
    for p in peaks:
        p.setdefault("match", {})
        if t.get("ra") is not None and t.get("pmra") is not None:
            mjd = (t_ref_jyear - 2000.0) * 365.25 + 51544.5
            ra_t, dec_t = BL.target_position(t, mjd)
            sep = SC.sep_arcsec(ra_t, dec_t, p["ra"], p["dec"])
            ve, vn = best_v(p)
            dvv = math.hypot(ve - t["pmra"] / 1000, vn - t["pmdec"] / 1000)
            if sep < radius + 2:
                p["match"]["target"] = {"name": t.get("name"), "sep_arcsec": round(sep, 2), "dv_arcsec_yr": round(dvv, 2),
                                        "gaia_dr3": t.get("gaia_dr3")}
        if gj:
            col = {c: i for i, c in enumerate(gj["columns"])}
            for s in gj["stars"]:
                pmra, pmdec = s[col["pmra"]], s[col["pmdec"]]
                if pmra is None or math.hypot(pmra, pmdec) < 500:
                    continue
                dt = t_ref_jyear - float(gj.get("ref_epoch", 2016.0))
                cosd = math.cos(math.radians(s[col["dec"]]))
                ra = s[col["ra"]] + pmra * dt / 3.6e6 / cosd
                dec = s[col["dec"]] + pmdec * dt / 3.6e6
                if SC.sep_arcsec(ra, dec, p["ra"], p["dec"]) < radius and \
                        math.hypot(best_v(p)[0] - pmra / 1000, best_v(p)[1] - pmdec / 1000) < dv:
                    p["match"]["gaia_dr3"] = {"source_id": str(s[col["source_id"]]), "pmra": pmra, "pmdec": pmdec,
                                              "g": s[col.get("phot_g_mean_mag", 0)]}
                    break


def to_candidates(res, run):
    """shift-and-stack peaks -> detect/schema.py records."""
    out = []
    for p in res["peaks"]:
        flags = list(p["flags"])
        cls = "candidate"
        if p["n_epochs_snr2"] < 2:
            cls = "artifact"
        m = p.get("match") or {}
        if any(f.startswith("static star on the path") for f in flags):
            cls = "artifact"
        if res["mode"] == "pm":
            raw = p.get("raw")
            if raw and not raw["at_edge"] and False:     # (older path; motion now comes from the aware statistic)
                p["v_east_residual"], p["v_north_residual"] = p["v_east"], p["v_north"]
                p["v_east"], p["v_north"] = raw["v_east"], raw["v_north"]
                sp_, pa_ = math.hypot(p["v_east"], p["v_north"]), math.degrees(math.atan2(p["v_east"], p["v_north"])) % 360
                p["speed"], p["pa_deg"] = round(sp_, 3), round(pa_, 1)
                p["motion_text"] = f'{sp_:.1f}"/yr toward PA {pa_:.0f}°'
                flags.append("motion from the self-subtraction-aware fit")
            if "gaia_dr3" in m or ("target" in m and m["target"].get("gaia_dr3")):
                cls = "gaia-known"
            elif "target" in m:
                flags.append(f"known object (field target {m['target']['name']}, not in Gaia)")
            sig = p["snr"]
            c = SC.new_candidate(
                NAME, "motion", p["ra"], p["dec"], epoch=res["t_ref_jyear"], cls=cls,
                positions=[dict(season=q["epoch"], jyear=_jyear(q["mjd"]), ra=None, dec=None, err_arcsec=None, n=q["n"])
                           for q in p["epochs"]],
                motion=SC.motion_dict(p["v_east"] * 1000, p["v_north"] * 1000, p["v_err"][0] * 1000, p["v_err"][1] * 1000,
                                      sig=sig, method="shift-and-stack (S)"),
                snr=p["snr"], flux_ujy=p["flux_ujy"], mag_ab=p["mag_ab"], bins=["all wavelengths"],
                season_pairs=[], match=m, flags=flags,
                notes=f"shift-and-stack peak: S/N {p['snr']} at {p['motion_text']}; per-season S/N "
                      + ", ".join(f"{q['epoch']} {q['snr']}" for q in p["epochs"]))
            for q in c["positions"]:              # season position along the fitted path
                dtd = q["jyear"] - res["t_ref_jyear"]
                cosd = math.cos(math.radians(p["dec"]))
                q["ra"] = p["ra"] + p["v_east"] * dtd / 3600 / cosd
                q["dec"] = p["dec"] + p["v_north"] * dtd / 3600
                q["err_arcsec"] = round(math.hypot(*p["v_err"]) * abs(dtd) + 6.0 / max(p["snr"], 1), 2)
        else:
            if m.get("sso"):
                cls = "asteroid-known"
            c = SC.new_candidate(NAME, "transient", p["ra"], p["dec"], epoch=_jyear(res.get("t_ref_mjd", p["epochs"][0]["mjd"])),
                                 cls=cls, snr=p["snr"], flux_ujy=p["flux_ujy"], mag_ab=p["mag_ab"], bins=["all wavelengths"],
                                 match=m, flags=flags,
                                 notes=f"shift-and-stack (fast movers) peak: S/N {p['snr']} at {p['motion_text']}")
            c["rate"] = {"ra_arcsec_h": p["v_east"], "dec_arcsec_h": p["v_north"], "err_arcsec_h": p["v_err"],
                         "speed_arcsec_h": p["speed"], "pa_deg": p["pa_deg"]}
        p["class"] = cls
        p["flags"] = flags
        c["shiftstack"] = {"mode": res["mode"], "unit": res["unit"], "v_east": p["v_east"], "v_north": p["v_north"],
                           "epochs": p["epochs"], "n_velocities": res.get("n_velocities"), "threshold": res.get("threshold")}
        out.append(c)
    return out


# ------------------------------------------------------------------------------------- entry
def _as_run(obj, log=print):
    """faint.FieldRun from a FieldRun, a detect.run.Ctx or a detect.data.Field."""
    if isinstance(obj, FA.FieldRun):
        return obj
    field = getattr(obj, "field", None) or obj
    run = FA.FieldRun(field.name, field.data_dir, field.out_dir, field.ra, field.dec, target=getattr(field, "target", None),
                      log=log)
    exps = getattr(obj, "exps", None)
    if exps:
        run.exps, run.by_file = exps, {e["file"]: e for e in exps}
    else:
        run.load()
    return run


def run(obj, mode=None, log=None, **opts):
    """Detector entry point. obj: detect.run.Ctx (detector API), faint.FieldRun or detect.data.Field.
    Returns candidate records (detect/schema.py)."""
    log = log or getattr(obj, "log", None) or print
    modes = [mode] if mode else list((getattr(obj, "opts", None) or {}).get("shift_stack_modes", ["pm"]))
    r = _as_run(obj, log)
    out = []
    for m in modes:
        out += run_field(r, mode=m, write=False, log=log, **opts)
    info = getattr(obj, "info", None)
    if isinstance(info, dict):
        info.setdefault(NAME, {})["modes"] = modes
    return out


def run_field(run, mode="pm", write=True, overwrite=False, log=print, tag=None, **opts):
    """Search one field, write <out>/faint/shiftstack.json (+ PNGs) if write. Returns candidates.
    tag names the run in shiftstack.json (default = mode), e.g. 'pm_long' for
    mode='pm', lam_range=(3.8, 5.1); runs with other tags are kept."""
    tag = tag or mode
    s = Search(run, log=log)
    res = s.pm(**opts) if mode == "pm" else s.sso(**opts)
    if mode == "pm" and res.get("peaks"):
        gaia_match(run, res["peaks"], res["t_ref_jyear"])
    cands = to_candidates(res, run)
    if write and run.out_dir:
        od = Path(run.out_dir) / "faint"
        od.mkdir(parents=True, exist_ok=True)
        pk = res["peaks"][:12]
        peak_png(res["_zmax"], pk, od / f"shiftstack_{tag}.png",
                 f"{run.name}: shift-and-stack ({mode}), {res.get('n_velocities')} trial motions", res.get("threshold", 6),
                 overwrite=overwrite)
        doc_run = {k: v for k, v in res.items() if not k.startswith("_")}
        doc_run["tag"] = tag
        doc_run["peak_map_png"] = f"shiftstack_{tag}.png"
        if mode == "pm" and pk:
            vmap_png(s, res, pk[0], od / f"shiftstack_{tag}_v.png", overwrite=overwrite)
            doc_run["vmap_png"] = f"shiftstack_{tag}_v.png"
        nc = sum(c["class"] == "candidate" for c in cands)
        known = [p for p in pk if p.get("match")]
        lr = res.get("lam_range")
        doc_run["summary"] = (f"{'Proper motion' if mode == 'pm' else 'Fast movers'}"
                              f"{f' ({lr[0]}-{lr[1]} um)' if lr else ' (all wavelengths)'}: {res.get('n_velocities')} trial motions"
                              f"{' up to ' + str(res.get('vmax')) + ' ' + res.get('unit', '') if res.get('vmax') else ''}; "
                              f"{len(res['peaks'])} peak(s) at S/N >= {res.get('threshold')}, "
                              f"{len(known)} matched to known movers, {nc} candidate(s) for follow-up.")
        path = od / "shiftstack.json"
        doc = {"schema": "fazari-shiftstack/1", "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "field": {"name": run.name, "ra": run.grid.ra, "dec": run.grid.dec}, "runs": [],
               "note": ("Shift-and-stack: exposures shifted along trial motions and added after template subtraction. "
                        "S/N in units of the measured noise. Peaks are candidates for follow-up, not discoveries."),
               "candidates": []}
        if path.exists():                    # another mode of the same run is kept
            old = json.loads(path.read_text())
            if any(r.get("tag", r.get("mode")) == tag for r in old.get("runs", [])) and not overwrite:
                raise FileExistsError(f"{path} already has a {tag} run (use overwrite)")
            doc["runs"] = [r for r in old.get("runs", []) if r.get("tag", r.get("mode")) != tag]
            doc["candidates"] = [c for c in old.get("candidates", [])
                                 if c.get("shiftstack", {}).get("tag", c.get("shiftstack", {}).get("mode")) != tag]
        for c in cands:
            c["shiftstack"]["tag"] = tag
        doc["runs"].append(doc_run)
        doc["candidates"] += cands
        FA.write_new(path, json.dumps(FA.clean_json(SC._clean(doc)), indent=1), overwrite=True)
        log(f"  shift-and-stack {mode}: {doc_run['summary']} -> {path}")
    return cands
