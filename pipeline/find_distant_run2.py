"""Second Planet X strip search (run 2): new strips on the same median orbit, same detector (distant-v3b), same driver.

  python pipeline/find_distant_run2.py plan        -> cache/planetx/plan_run2.json (never overwritten)
  python pipeline/find_distant_run2.py fetch  --fields R2-...,R2-... --cap-mb 900
  python pipeline/find_distant_run2.py search --field R2-... --out cache/planetx/results_run2 --threads 2
  python pipeline/find_distant_run2.py inject --field R2-... --out cache/planetx/injections_run2 --threads 2 ...
  python pipeline/find_distant_run2.py limits cache/planetx/injections_run2

Only the plan is new. Every other command is pipeline/find_distant.py unchanged, pointed at the run-2 plan and a
separate byte ledger (cache/planetx/ledger_run2.json). Pre-registration: pipeline/PLANETX_RUN2_PREREG.md.
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import find_distant as FD  # noqa: E402

FD.PLAN = FD.PX / "plan_run2.json"
FD.LEDGER = FD.PX / "ledger_run2.json"

N_STRIPS = 5
MIN_SEP_DEG = 6.0           # from every strip already searched and from each other (a strip is <= 4.2 deg long)
NU_STEP = 5.0
PREVIOUS = {"F1-aphelion": (67.13641, 13.90672), "F2-ra45": (45.0, 3.90335), "F3-perihelion": (247.13641, -13.90672),
            "F4-nu-75": (178.01128, 17.29059), "F5-nu+75": (337.58355, -23.05617), "F2L-link420": (44.4785, 3.6667)}
PLAN_RULE = ("Points every 5 deg of true anomaly nu on the same median orbit (Brown & Batygin 2021), ranked by the time the "
             "planet spends there per degree of nu (proportional to r^2, Kepler's second law: aphelion first, as in run 1). "
             "Going down that list, a point is taken if it lies >= 6 deg from the centre of every strip already searched "
             "(F1-F5, F2L) and of every point already taken, |b| >= 20 deg and >= 3 seasons with >= 45 D1-D3 exposures in "
             "the index (same exposure rule as run 1), until 5 points are taken. Strips: 110 rows x 2040 columns, as run 1.")


def sep_deg(a1, d1, a2, d2):
    a1, d1, a2, d2 = (math.radians(v) for v in (a1, d1, a2, d2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def cmd_plan(a):
    import sky_index as SI
    out = FD.PLAN
    if out.exists():
        sys.exit(f"{out} exists: not overwritten (the plan is the pre-registration)")
    nus = [((180.0 + k * NU_STEP + 180.0) % 360.0) - 180.0 for k in range(int(360 / NU_STEP))]
    ranked = sorted(nus, key=lambda nu: (-round(FD.orbit_point(nu)["r_au"] ** 2, 6), abs(nu), nu))
    taken, log = [], []
    for nu in ranked:
        if len(taken) >= N_STRIPS:
            break
        p = FD.orbit_point(nu)
        l, b = FD.galactic(p["ra"], p["dec"])
        near = [(n, sep_deg(p["ra"], p["dec"], ra, de)) for n, (ra, de) in
                list(PREVIOUS.items()) + [(t["name"], (t["ra"], t["dec"])) for t in taken]]
        n_min, s_min = min(near, key=lambda q: q[1])
        why = None
        if s_min < MIN_SEP_DEG:
            why = f"{s_min:.1f} deg from {n_min}"
        elif abs(b) < 20:
            why = f"|b| {abs(b):.1f}"
        else:
            seas, good = FD.usable(p)
            if good < 3:
                why = f"seasons with >= {FD.MIN_GOOD} exposures: {good}"
        log.append(dict(nu=nu, r_au=round(p["r_au"], 1), ra=round(p["ra"], 4), dec=round(p["dec"], 4), gal_b=round(b, 2),
                        nearest=n_min, nearest_deg=round(s_min, 2), rejected=why))
        print(f"nu {nu:+7.1f} r {p['r_au']:5.1f} RA {p['ra']:8.4f} Dec {p['dec']:+8.4f} b {b:+6.1f} nearest {n_min} {s_min:5.1f} deg: "
              f"{'REJECTED ' + why if why else 'TAKEN'}", flush=True)
        if why:
            continue
        ex = []
        for si, v in enumerate(seas):
            for r in v:
                c, e, n = SI.tangent_basis(np.float64(r["ra_center"]), np.float64(r["dec_center"]))
                px, py, _ = SI.project(SI.unit(np.float64(p["ra"]), np.float64(p["dec"])), c, e, n)
                cx, cy = zip(*[SI.project(SI.unit(np.float64(aa), np.float64(dd)), c, e, n)[:2] for aa, dd in r["corners"]])
                uu, vv = SI.quad_uv(float(px), float(py), [float(q) for q in cx], [float(q) for q in cy])
                ex.append(dict(s3_key=r["s3_key"], obs_id=r["obs_id"], collection=r["collection"], detector=r["detector"],
                               mjd=r["mjd"], approx_lam_um=r["approx_lam_um"], season_i=si, x_det=round(uu * 2040, 1), y_det=round(vv * 2040, 1)))
        name = f"R2-nu{int(round(nu)):+d}"
        taken.append(dict(name=name, nu_deg=nu, r_au=round(p["r_au"], 1), ra=round(p["ra"], 5), dec=round(p["dec"], 5),
                          ecl_lon=round(p["lon"], 3), ecl_lat=round(p["lat"], 3), gal_l=round(l, 2), gal_b=round(b, 2),
                          n_rows=FD.NROWS, seasons=[dict(mjd=[v[0]["mjd"], v[-1]["mjd"]], n=len(v)) for v in seas], exposures=ex))
    plan = dict(made=time.strftime("%Y-%m-%d %H:%M:%S %z"), source="Brown & Batygin 2021 (AJ 162, 219), uniform-prior medians",
                orbit=dict(a_au=FD.A, e=round(FD.E, 4), q_au=300.0, inc_deg=FD.INC, node_deg=FD.NODE, varpi_deg=FD.VARPI),
                rule=PLAN_RULE, previous=PREVIOUS, considered=log, fields=taken,
                est_total_mb=round(sum(len(f["exposures"]) for f in taken) * (FD.NROWS * 8160 + 28800) / 1e6, 1))
    out.write_text(json.dumps(plan, indent=1))
    for f in taken:
        print(f"{f['name']}: r {f['r_au']} AU RA {f['ra']} Dec {f['dec']} b {f['gal_b']} exposures {len(f['exposures'])} "
              f"{[s['n'] for s in f['seasons']]}")
    print("est. MB", plan["est_total_mb"], "->", out)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "plan":
        cmd_plan(None)
    else:
        FD.main()
