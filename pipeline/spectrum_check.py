#!/usr/bin/env python3
"""Spectrum flux check: SPHEREx spectra of field stars (pipeline/spectrum.py, unchanged) against 2MASS J/H/Ks and
AllWISE W1/W2. Rules: pipeline/SPECTRUM_CHECK_PREREG.md. Read-only: writes only to --work (outside the repo) and, in
`report`, pipeline/SPECTRUM_CHECK.md + pipeline/spectrum_check.csv.

Steps:
  catalog   VizieR cone per field: Gaia DR3 (I/355/gaiadr3), 2MASS (II/246/out), AllWISE (II/328/allwise) -> <work>/cat/
  sample    cuts 1-6, measurement order (seed 20261115) -> <work>/sample.json
  measure   pipeline/spectrum.py per star, in order, with the load / time guards -> <work>/out/sc_<id>/spectrum.json
  report    band synthesis, metrics, verdict -> pipeline/SPECTRUM_CHECK.md, pipeline/spectrum_check.csv

  uv run --no-project --with astropy --with numpy --with scipy python -I pipeline/spectrum_check.py <step> --work DIR
"""
import argparse
import csv
import io
import json
import math
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NASA = ROOT.parent
VERI = NASA / "veri" / "real_spherex"
CACHE = NASA / "fazari" / "cache"
LOCAL_IN = CACHE / "local" / "inputs"
VERI_FIELDS = ["barnard", "eps_indi_b", "r_dra", "rw_aur", "wise0855"]
LOCAL_FIELDS = [
    "field-10.000n41.000-c2-b63", "field-106.796s5.562-c6-b63", "field-118.166s40.292-c6-b63-s0.4",
    "field-158.049n14.137-c6-b63", "field-178.256n37.805-c6-b63-s0.4", "field-2.695s39.688-c6-b63-s0.4",
    "field-201.350s12.650-c6-b63", "field-201.365s43.019-c6-b63", "field-210.000n12.000-c6-b63-s0.4",
    "field-210.000s5.000-c6-b63", "field-214.499n35.509-c6-b63-s0.4", "field-225.000n5.000-c6-b63-s0.4",
    "field-226.000n6.000-c6-b63-s0.4", "field-251.175s28.468-c6-b63-s0.4", "field-259.095s34.806-c6-b63",
    "field-263.523s68.901-c6-b63", "field-269.018s25.508-c6-b63", "field-269.765n66.481-c6-b63",
    "field-271.125s22.235-c6-b63", "field-335.000s12.000-c30-b63", "field-53.773n47.956-c6-b63-s0.4",
    "field-74.831n28.578-c6-b63", "field-89.899n25.093-c6-b63",
    "luhman16-162.295s53.317-c6-b63-pm8778",
]
VIZIER = ["https://vizier.cfa.harvard.edu/viz-bin/asu-tsv", "https://vizier.idia.ac.za/viz-bin/asu-tsv"]
CONE_DEG = 0.15
CATS = {
    "gaia": ("I/355/gaiadr3", "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,Gmag,BP-RP,RUWE,VarFlag,2MASS,AllWISE", "Gmag=<19.5"),
    "tmass": ("II/246/out", "2MASS,RAJ2000,DEJ2000,Jmag,e_Jmag,Hmag,e_Hmag,Kmag,e_Kmag,Qflg,Cflg,Xflg,Bflg", None),
    "wise": ("II/328/allwise", "AllWISE,RAJ2000,DEJ2000,W1mag,e_W1mag,W2mag,e_W2mag,ccf,ex,nb,qph", None),
}
UA = "fazari-spectrum-check"
SEED = 20261115
KS_RANGE = (9.5, 13.5)
EDGE_PX, EDGE_FRAC = 8, 0.5
RUWE_MAX = 1.4
TARGET_EXCL_AS, BRIGHT_G, BRIGHT_EXCL_AS = 60.0, 9.0, 90.0
ISO_AS, ISO_DMAG = 18.0, 2.5
GF_MARGIN_AS = 90.0          # star this far inside its field's cached Gaia list (neighbour radius 75" + stamp)
# bands: lambda_iso (um), top-hat (um), F0 (Jy), reference spectrum, AB offset (sensitivity only)
BANDS = {
    "J": (1.235, (1.154, 1.316), 1594.0, "vega", 0.91),
    "H": (1.662, (1.537, 1.788), 1024.0, "vega", 1.39),
    "Ks": (2.159, (2.028, 2.290), 666.7, "vega", 1.85),
    "W1": (3.3526, (2.80, 3.80), 309.540, "vega", 2.699),
    "W2": (4.6028, (4.00, 5.00), 171.787, "vega", 3.339),
}
# WISE colour correction for F_nu ~ nu^2 (Wright et al. 2010, Table 6, alpha = -2): the catalogue's nu^-2-convention flux
# divided by f_c is the true F_nu(lambda_iso) of a Rayleigh-Jeans star. 2MASS (Vega-based isophotal fluxes): 1.
FC_RJ = {"J": 1.0, "H": 1.0, "Ks": 1.0, "W1": 1.0283, "W2": 1.0206}
TM_IDX = {"J": 0, "H": 1, "Ks": 2}
WI_IDX = {"W1": 0, "W2": 1}
COVER_MIN = 0.8              # primary tier (verdict)
COVER_PARTIAL = 0.3          # secondary tier: reported, no verdict
STOP_AT, PAUSE = "19:45", ("18:49", "19:20")
SPECTRUM_CMD = ["uv", "run", "--no-project", "--with", "astropy", "--with", "reproject", "--with", "numpy",
                "--with", "scipy", "--with", "matplotlib", "--with", "pillow", "python", "-I", "pipeline/spectrum.py"]


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def num(s):
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def sep_as(r1, d1, r2, d2):
    c = math.cos(math.radians((d1 + d2) / 2))
    return math.hypot((r1 - r2) * c, d1 - d2) * 3600.0


# ---------------------------------------------------------------------------------------------- fields
def field_info(name):
    """(data_root, gaia_field.json source, centre ra, dec at 2026.0)."""
    if name in VERI_FIELDS:
        t = json.loads((ROOT / "pipeline" / "targets.json").read_text())[name]
        dt = 2026.0 - t.get("epoch", 2016.0)
        dec = t["dec"] + t.get("pmdec", 0) * dt / 3.6e6
        ra = t["ra"] + t.get("pmra", 0) * dt / 3.6e6 / math.cos(math.radians(t["dec"]))
        g = ROOT / "site" / "data" / name / "gaia_field.json"
        if not g.exists():
            g = CACHE / "gaia" / name / "gaia_field.json"
        return VERI, g, ra, dec
    m = json.loads((CACHE / "jobs" / name / "meta.json").read_text())
    return LOCAL_IN, CACHE / "jobs" / name / "gaia_field.json", m["ra"], m["dec"]


def gaia_field_circle(name):
    """Centre and radius (deg) of the cached Gaia field list (from its query text)."""
    import re
    d = json.loads(field_info(name)[1].read_text())
    m = re.search(r"CIRCLE\('ICRS',\s*([-\d.]+),\s*([-\d.]+),\s*([\d.]+)\)", d["query"])
    return float(m.group(1)), float(m.group(2)), float(m.group(3))


def fields():
    return VERI_FIELDS + LOCAL_FIELDS


def cutouts(name):
    root = field_info(name)[0]
    return sorted(p for c in ("dr1", "qr3") if (root / name / c).is_dir() for p in (root / name / c).glob("*.fits"))


# ---------------------------------------------------------------------------------------------- catalog
def vizier(source, cols, ra, dec, extra):
    q = {"-source": source, "-c": f"{ra:.6f} {dec:+.6f}", "-c.rd": f"{CONE_DEG}", "-out": cols, "-out.max": "unlimited"}
    if extra:
        k, v = extra.split("=", 1)
        q[k] = v
    last = None
    for base in VIZIER:
        for attempt in range(2):
            try:
                req = urllib.request.Request(base + "?" + urllib.parse.urlencode(q), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=180) as r:
                    text = r.read().decode("utf-8", "replace")
                if "<html" in text[:500].lower():
                    raise IOError("HTML reply")
                return text, base
            except Exception as e:      # noqa: BLE001
                last = e
                log(f"  {base}: {type(e).__name__} {e}; retry")
                time.sleep(5)
    raise RuntimeError(f"VizieR failed: {last}")


def parse_tsv(text):
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    if len(lines) < 3:
        return []
    head = lines[0].split("\t")
    rows = []
    for ln in lines[3:]:                     # header, units, dashes
        v = ln.split("\t")
        if len(v) < len(head):
            continue
        rows.append({h: x.strip() for h, x in zip(head, v)})
    return rows


def cmd_catalog(work):
    cat = work / "cat"
    cat.mkdir(parents=True, exist_ok=True)
    for f in fields():
        _, _, ra, dec = field_info(f)
        for k, (src, cols, extra) in CATS.items():
            p = cat / f"{f}.{k}.tsv"
            if p.exists() and p.stat().st_size > 0:
                continue
            t0 = time.time()
            text, base = vizier(src, cols, ra, dec, extra)
            p.write_text(f"# {src} cone {CONE_DEG} deg at {ra:.6f} {dec:+.6f} from {base} "
                         f"{datetime.now().isoformat(timespec='seconds')}\n" + text)
            log(f"{f} {k}: {len(parse_tsv(text))} rows, {time.time() - t0:.1f} s")
            time.sleep(1)


def load_cat(work, f, k):
    return parse_tsv((work / "cat" / f"{f}.{k}.tsv").read_text())


# ---------------------------------------------------------------------------------------------- sample
def edge_fraction(name, stars):
    """Fraction of the field's cutouts in which each star is >= EDGE_PX from every edge."""
    from astropy.io import fits
    from astropy.wcs import WCS
    import numpy as np
    import warnings
    warnings.simplefilter("ignore")
    files = cutouts(name)
    ra = np.array([s["ra"] for s in stars])
    dec = np.array([s["dec"] for s in stars])
    good = np.zeros(len(stars))
    for p in files:
        hd = fits.getheader(p, "IMAGE")
        w = WCS(hd)
        x, y = w.all_world2pix(ra, dec, 0)
        nx, ny = hd["NAXIS1"], hd["NAXIS2"]
        good += (x >= EDGE_PX) & (y >= EDGE_PX) & (x <= nx - 1 - EDGE_PX) & (y <= ny - 1 - EDGE_PX)
    return good / max(len(files), 1), len(files)


def cmd_sample(work):
    counts = {}
    kept = {}

    def cut(name, n):
        counts[name] = counts.get(name, 0) + n

    for f in fields():
        _, _, fra, fdec = field_info(f)
        gaia = load_cat(work, f, "gaia")
        tm = {r["2MASS"]: r for r in load_cat(work, f, "tmass")}
        tml = list(tm.values())
        wi = {r["AllWISE"]: r for r in load_cat(work, f, "wise")}
        wil = list(wi.values())
        for r in gaia:
            r["_ra"], r["_dec"], r["_g"] = num(r["RA_ICRS"]), num(r["DE_ICRS"]), num(r["Gmag"])
        bright = [r for r in gaia if r["_g"] is not None and r["_g"] < BRIGHT_G]
        cand = []
        n0 = 0
        for r in gaia:
            t = tm.get(r.get("2MASS", ""))
            ks = num(t["Kmag"]) if t else None
            if not t or ks is None or not (KS_RANGE[0] <= ks <= KS_RANGE[1]):
                continue
            n0 += 1
            cand.append((r, t, wi.get(r.get("AllWISE", ""))))
        cut("1_selected_gaia_2mass_ks_window", n0)
        if not cand:
            continue
        stars = [{"ra": r["_ra"], "dec": r["_dec"]} for r, _, _ in cand]
        frac, nfiles = edge_fraction(f, stars)
        gra, gdec, grad = gaia_field_circle(f)
        c2 = [c for c, fr in zip(cand, frac) if fr >= EDGE_FRAC
              and sep_as(c[0]["_ra"], c[0]["_dec"], gra, gdec) <= grad * 3600 - GF_MARGIN_AS]
        cut("2_outside_cutouts_or_gaia_field", len(cand) - len(c2))
        c3 = [c for c in c2 if c[0].get("VarFlag", "") != "VARIABLE" and num(c[0].get("RUWE")) is not None
              and num(c[0]["RUWE"]) < RUWE_MAX]
        cut("3_gaia_variable_or_ruwe", len(c2) - len(c3))
        c4 = [c for c in c3 if sep_as(c[0]["_ra"], c[0]["_dec"], fra, fdec) >= TARGET_EXCL_AS
              and not any(b is not c[0] and sep_as(c[0]["_ra"], c[0]["_dec"], b["_ra"], b["_dec"]) < BRIGHT_EXCL_AS
                          for b in bright)]
        cut("4_near_field_target_or_bright_star", len(c3) - len(c4))
        c5 = []
        for r, t, w in c4:
            ra, dec, g = r["_ra"], r["_dec"], r["_g"]
            ks, j = num(t["Kmag"]), num(t["Jmag"])
            bad = any(o is not r and o["_g"] is not None and g is not None and o["_g"] < g + ISO_DMAG
                      and sep_as(ra, dec, o["_ra"], o["_dec"]) < ISO_AS for o in gaia)
            for o in tml:
                if bad or o is t:
                    continue
                if sep_as(ra, dec, num(o["RAJ2000"]), num(o["DEJ2000"])) < ISO_AS:
                    ok, oj = num(o["Kmag"]), num(o["Jmag"])
                    bad = (ok is not None and ok < ks + ISO_DMAG) or (ok is None and oj is not None and j is not None
                                                                      and oj < j + ISO_DMAG)
            w1s = num(w["W1mag"]) if w else None
            ref = w1s if w1s is not None else ks
            for o in wil:
                if bad or o is w:
                    continue
                ow1 = num(o["W1mag"])
                if ow1 is not None and ow1 < ref + ISO_DMAG and sep_as(ra, dec, num(o["RAJ2000"]), num(o["DEJ2000"])) < ISO_AS:
                    bad = True
            if not bad:
                c5.append((r, t, w))
        cut("5_not_isolated_18as", len(c4) - len(c5))
        for r, t, w in c5:
            sid = r["Source"]
            if sid in kept and kept[sid]["n_cutouts"] >= nfiles:
                cut("6_duplicate", 1)
                continue
            if sid in kept:
                cut("6_duplicate", 1)
            kept[sid] = {"source_id": sid, "field": f, "n_cutouts": nfiles, "ra": r["_ra"], "dec": r["_dec"],
                         "pmra": num(r["pmRA"]) or 0.0, "pmdec": num(r["pmDE"]) or 0.0, "plx": num(r["Plx"]) or 0.0,
                         "g": r["_g"], "bp_rp": num(r["BP-RP"]), "ruwe": num(r["RUWE"]), "tmass": t, "allwise": w}
        log(f"{f}: {n0} in window, {len(c5)} pass, {nfiles} cutouts")
    order = sorted(kept, key=int)
    random.Random(SEED).shuffle(order)
    out = {"made": datetime.now().isoformat(timespec="seconds"), "seed": SEED, "cut_counts": counts,
           "n": len(order), "order": order, "stars": kept,
           "per_field": {f: sum(s["field"] == f for s in kept.values()) for f in fields()}}
    (work / "sample.json").write_text(json.dumps(out, indent=1))
    log(f"sample: {len(order)} stars; cuts {counts}")


# ---------------------------------------------------------------------------------------------- measure
def hm(s):
    h, m = map(int, s.split(":"))
    return h * 60 + m


def now_min():
    t = datetime.now()
    return t.hour * 60 + t.minute + t.second / 60


def pkg_temp():
    for h in Path("/sys/class/hwmon").glob("hwmon*"):
        try:
            if (h / "name").read_text().strip() != "coretemp":
                continue
            for lab in h.glob("temp*_label"):
                if lab.read_text().strip() == "Package id 0":
                    return int((h / lab.name.replace("label", "input")).read_text()) / 1000
        except OSError:
            pass
    return None


def mem_avail():
    for ln in open("/proc/meminfo"):
        if ln.startswith("MemAvailable:"):
            return int(ln.split()[1]) // 1024
    return 0


def jobs_running():
    """(Planet X run 3 running, injection job running). Run 3 is a shell driver (run3.sh) that starts one
    find_distant_run3.py process per field, so the driver counts too (no gap between fields)."""
    out = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout.splitlines()
    ls = [ln for ln in out if "pgrep" not in ln and "spectrum_check" not in ln and not ln.startswith("/bin/bash -c source")]
    run3 = any(("find_distant_run3" in ln and "python" in ln) or ln.strip() == "bash run3.sh" or ln.endswith("/run3.sh")
               for ln in ls)
    inj = any(("inj_seeds" in ln or "driver_amend" in ln) and "python" in ln for ln in ls)
    return run3, inj


def wait_ok(statusf):
    """Block until the load rules allow one more star. Returns False at the stop time."""
    while True:
        t = now_min()
        if t >= hm(STOP_AT):
            return False, None
        why = None
        run3, inj = jobs_running()
        if run3 and inj:
            why = "both science jobs running"
        elif hm(PAUSE[0]) <= t < hm(PAUSE[1]):
            why = "presentation pause"
        elif mem_avail() < 6000:
            why = f"memory {mem_avail()} MB"
        else:
            tps = []
            for _ in range(3):                    # median of 3 samples 0.5 s apart (the run-3 driver uses 5 x 1 s):
                tps.append(pkg_temp() or 0)       # a single read catches the short spike right after a star
                time.sleep(0.5)
            tp = sorted(tps)[1]
            if tp >= 90:
                why = f"cpu {tp:.0f} C (max {max(tps):.0f})"
        if why is None:
            return True, run3
        statusf(f"waiting: {why}")
        time.sleep(10)


def cmd_measure(work, limit=None):
    smp = json.loads((work / "sample.json").read_text())
    out = work / "out"
    out.mkdir(parents=True, exist_ok=True)
    # FAZARI_TARGETS copy (field centres), cached Gaia field lists in <out>/<field>/
    tg = json.loads((ROOT / "pipeline" / "targets.json").read_text())
    tj = {k: v for k, v in tg.items() if k in VERI_FIELDS}
    for f in fields():
        root, g, ra, dec = field_info(f)
        if f not in tj:
            tj[f] = {"name": f, "kind": "motion", "ra": ra, "dec": dec, "epoch": 2016.0, "pmra": 0.0, "pmdec": 0.0, "plx": 0.0}
        dst = out / f / "gaia_field.json"
        if not dst.exists() and not (ROOT / "site" / "data" / f / "gaia_field.json").exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(g, dst)
    tpath = work / "targets_fields.json"
    tpath.write_text(json.dumps(tj, indent=1))
    logf = work / "measure_log.jsonl"
    done = set()
    if logf.exists():
        for ln in logf.read_text().splitlines():
            done.add(json.loads(ln)["source_id"])
    st = work / "measure_status.txt"

    def statusf(msg):
        st.write_text(f"{datetime.now().isoformat(timespec='seconds')} {len(done)}/{smp['n']} {msg}\n")

    n = 0
    for sid in smp["order"]:
        if sid in done:
            continue
        if limit is not None and n >= limit:
            break
        ok, run3 = wait_ok(statusf)
        if not ok:
            statusf("stopped at stop time")
            log("stop time reached")
            break
        s = smp["stars"][sid]
        root = field_info(s["field"])[0]
        tjson = json.dumps({"name": f"sc_{sid}", "ra": s["ra"], "dec": s["dec"], "pmra": s["pmra"], "pmdec": s["pmdec"],
                            "plx": s["plx"], "epoch": 2016.0})
        env = dict(os.environ, FAZARI_DATA=str(root), FAZARI_TARGETS=str(tpath), FAZARI_NO_GAIA_FETCH="1")
        cmd = ["nice", "-n", "19"] + ([] if run3 else ["taskset", "-c", "12-17"]) + SPECTRUM_CMD + [
            f"sc_{sid}", "--target-json", tjson, "--data-target", s["field"], "--out", str(out)]
        t0 = time.time()
        statusf(f"measuring {sid} ({s['field']})")
        p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
        txt = p.stdout + p.stderr
        rec = {"source_id": sid, "field": s["field"], "rc": p.returncode, "seconds": round(time.time() - t0, 1),
               "gaia_model": "no Gaia field stars" not in txt, "pinned": not run3, "tail": txt.strip().splitlines()[-1:]}
        with open(logf, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
        done.add(sid)
        n += 1
        log(f"{sid} {s['field']} rc={p.returncode} {rec['seconds']} s")
    statusf("loop ended")


# ---------------------------------------------------------------------------------------------- report
def pool_bins(binned, season=None):
    """{(det, lo, hi): (flux, err)} pooled over seasons (w2 step 1); also the set of bad (saturated / wing) bins."""
    groups, bad = {}, set()
    for b in binned:
        if season is not None and b.get("season") != season:
            continue
        key = (b["detector"], float(b["lam_lo_um"]), float(b["lam_hi_um"]))
        if b.get("kind") == "saturated_wing" or (b.get("n_saturated") or 0) > 0:
            bad.add(key)
        if b.get("kind") != "measured" or not b.get("flux_err_ujy") or b.get("flux_ujy") is None:
            continue
        groups.setdefault(key, []).append((float(b["flux_ujy"]), float(b["flux_err_ujy"])))
    pooled = {}
    for k, v in groups.items():
        w = [1 / e ** 2 for _, e in v]
        m = sum(wi * f for wi, (f, _) in zip(w, v)) / sum(w)
        e = 1 / math.sqrt(sum(w))
        if len(v) > 1:
            c2 = sum(wi * (f - m) ** 2 for wi, (f, _) in zip(w, v)) / (len(v) - 1)
            e *= max(1.0, math.sqrt(c2))
        pooled[k] = (m, e)
    return pooled, bad


def synth(pooled, bad, band, ref=None):
    """Flat-band (top-hat) flux of a band; None + reason when a rule drops it."""
    lam, (lo, hi), _, sys_ref, _ = BANDS[band]
    ref = ref or sys_ref
    keys = [k for k in set(pooled) | bad if k[2] > lo and k[1] < hi]
    if any(k in bad for k in keys):
        return None, "saturated"
    num_ = var = den = cov = 0.0
    for k in sorted(keys, key=lambda k: k[1]):
        if k not in pooled:
            continue
        a, c = max(k[1], lo), min(k[2], hi)
        f, e = pooled[k]
        wt = math.log(c / a)
        num_ += f * wt
        var += (e * wt) ** 2
        den += (c * c - a * a) / (2 * lam ** 2) if ref == "nu-2" else lam ** 2 * (a ** -2 - c ** -2) / 2
        cov += wt
    if cov < COVER_PARTIAL * math.log(hi / lo):
        return None, "coverage"
    return (num_ / den, math.sqrt(var) / den, cov / math.log(hi / lo)), None


def cat_flux(s, band, ab=False, raw=False):
    lam, _, f0, _, abo = BANDS[band]
    if band in TM_IDX:
        t = s["tmass"]
        i = TM_IDX[band]
        m, e = num(t[("Jmag", "Hmag", "Kmag")[i]]), num(t[("e_Jmag", "e_Hmag", "e_Kmag")[i]])
        ok = (len(t.get("Qflg", "")) == 3 and t["Qflg"][i] == "A" and len(t.get("Cflg", "")) == 3 and t["Cflg"][i] == "0"
              and t.get("Xflg", "") == "0")
    else:
        w = s["allwise"]
        if not w:
            return None, "no_allwise"
        i = WI_IDX[band]
        m, e = num(w[("W1mag", "W2mag")[i]]), num(w[("e_W1mag", "e_W2mag")[i]])
        ok = (len(w.get("qph", "")) == 4 and w["qph"][i] == "A" and len(w.get("ccf", "")) == 4 and w["ccf"][i] == "0"
              and w.get("ex", "") == "0" and w.get("nb", "") == "1")
    if m is None or e is None:
        return None, "no_catalogue_mag"
    if not ok:
        return None, "catalogue_quality"
    f = (3631.0 * 10 ** (-0.4 * (m + abo)) if ab else f0 * 10 ** (-0.4 * m)) * 1e6
    if not raw:
        f /= FC_RJ[band]
    return (f, 0.4 * math.log(10) * f * e, m), None


def det_radius(spec, band, out_dir_files):
    """Mean distance (px) of the band's measured exposures from the detector centre (cutout x/y + CRPIX1A/2A)."""
    lo, hi = BANDS[band][1]
    rs = []
    for p in spec["points"]:
        if p["status"] not in ("detection", "nondetection") or not (lo <= p["wavelength_um"] <= hi):
            continue
        cr = out_dir_files.get(p["file"])
        if cr is None:
            continue
        x = p["x_pix"] + 1 - cr[0]
        y = p["y_pix"] + 1 - cr[1]
        rs.append(math.hypot(x - 1020.5, y - 1020.5))
    return sum(rs) / len(rs) if rs else None


def crpix_table(work, smp, sids):
    """CRPIX1A/2A of every cutout file used (header only), cached."""
    from astropy.io import fits
    cp = work / "crpix.json"
    tab = json.loads(cp.read_text()) if cp.exists() else {}
    flds = sorted({smp["stars"][s]["field"] for s in sids})
    for f in flds:
        for p in cutouts(f):
            if p.name in tab:
                continue
            hd = fits.getheader(p, "IMAGE")
            tab[p.name] = [hd.get("CRPIX1A"), hd.get("CRPIX2A")]
    cp.write_text(json.dumps(tab))
    return tab


def stats(R, sig, rng):
    import numpy as np
    R, sig = np.asarray(R), np.asarray(sig)
    med = float(np.median(R))
    boots = [np.median(R[rng.integers(0, len(R), len(R))]) for _ in range(2000)]
    mad = lambda x: float(1.4826 * np.median(np.abs(x - np.median(x))))      # noqa: E731
    sc = mad(R)

    def width(f):
        return mad((R - med) / np.sqrt(sig ** 2 + (f * med) ** 2))
    w0 = width(0.0)
    if w0 <= 1:
        floor = 0.0
    else:
        lo, hi = 0.0, 1.0
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if width(mid) > 1 else (lo, mid)
        floor = hi
    return {"n": len(R), "median": med, "median_err": float(np.std(boots)), "scatter": sc, "pull_width_raw": w0,
            "floor": floor}


def verdict(st):
    if st["n"] < 20:
        return "too few stars"
    d = abs(st["median"] - 1)
    v = "pass" if d <= 0.03 else ("limit" if d <= 0.06 else "fail")
    a, b = st["median"] - st["median_err"], st["median"] + st["median_err"]
    dmin = 0.0 if a <= 1 <= b else min(abs(a - 1), abs(b - 1))
    dmax = max(abs(a - 1), abs(b - 1))
    crosses = any(dmin <= t < dmax for t in (0.03, 0.06))
    return v + (" (1-sigma interval crosses a threshold)" if crosses else "")


def cmd_report(work):
    import numpy as np
    from scipy.stats import spearmanr
    smp = json.loads((work / "sample.json").read_text())
    logs = {}
    if (work / "measure_log.jsonl").exists():
        for ln in (work / "measure_log.jsonl").read_text().splitlines():
            r = json.loads(ln)
            logs[r["source_id"]] = r
    measured = [s for s in smp["order"] if s in logs]
    crp = crpix_table(work, smp, measured)
    drops = {b: {} for b in BANDS}
    rows = []
    n_fail = n_nogaia = 0
    for sid in measured:
        rec = logs[sid]
        sp = work / "out" / f"sc_{sid}" / "spectrum.json"
        if rec["rc"] != 0 or not sp.exists():
            n_fail += 1
            continue
        if not rec["gaia_model"]:
            n_nogaia += 1
            continue
        spec = json.loads(sp.read_text())
        s = smp["stars"][sid]
        pooled, bad = pool_bins(spec["binned"])
        tm = s["tmass"]
        jk = (num(tm["Jmag"]) - num(tm["Kmag"])) if num(tm["Jmag"]) is not None and num(tm["Kmag"]) is not None else None
        for band in BANDS:
            c, why = cat_flux(s, band)
            if c is None:
                drops[band][why] = drops[band].get(why, 0) + 1
                continue
            sy, why = synth(pooled, bad, band)
            if sy is None:
                drops[band][why] = drops[band].get(why, 0) + 1
                continue
            F, E, cov = sy
            alt = synth(pooled, bad, band, ref="nu-2")[0]          # exactly extra_checks.py w2 (no colour term)
            craw = cat_flux(s, band, raw=True)[0]
            cab = cat_flux(s, band, ab=True)[0]
            R = F / c[0]
            sigR = abs(R) * math.hypot(E / F if F else 0, c[1] / c[0])
            seasons = {}
            for k, se in enumerate(sorted(spec.get("seasons", [])), 1):
                p2, b2 = pool_bins(spec["binned"], se)
                y, _ = synth(p2, b2, band)
                if y:
                    seasons[f"s{k}"] = y[0] / c[0]
            rows.append({"source_id": sid, "field": s["field"], "band": band,
                         "tier": "full" if cov >= COVER_MIN else "partial", "cat_mag": c[2], "cat_flux_ujy": c[0],
                         "cat_err_ujy": c[1], "spherex_flux_ujy": F, "spherex_err_ujy": E, "coverage": cov,
                         "ratio": R, "ratio_err": sigR, "ratio_alt_reference": alt[0] / craw[0] if alt else None,
                         "ratio_ab_offsets": F / cab[0] if cab else None, "j_minus_ks": jk,
                         "det_radius_px": det_radius(spec, band, crp), "g": s["g"],
                         "season_ratios": seasons})
    rng = np.random.default_rng(1)
    res = {}
    for band, tier in [(b, t) for t in ("full", "partial") for b in BANDS]:
        br = [r for r in rows if r["band"] == band and r["tier"] == tier]
        if len(br) < 3:
            res[f"{band}/{tier}"] = {"n": len(br)}
            continue
        st = stats([r["ratio"] for r in br], [r["ratio_err"] for r in br], rng)
        st["verdict"] = verdict(st) if tier == "full" else "no verdict (partial coverage)"
        for key, lab in (("cat_mag", "mag"), ("j_minus_ks", "J-Ks"), ("det_radius_px", "det_radius"), ("g", "G")):
            xy = [(r[key], r["ratio"]) for r in br if r[key] is not None]
            if len(xy) >= 5:
                rho, p = spearmanr([a for a, _ in xy], [b for _, b in xy])
                st[f"trend_{lab}"] = (float(rho), float(p), len(xy))
        sea = {}
        for r in br:
            for k, v in r["season_ratios"].items():
                sea.setdefault(k, []).append(v)
        st["season_median"] = {k: (float(np.median(v)), len(v)) for k, v in sorted(sea.items())}
        alt = [r["ratio_alt_reference"] for r in br if r["ratio_alt_reference"]]
        abr = [r["ratio_ab_offsets"] for r in br if r["ratio_ab_offsets"]]
        st["median_alt_reference"] = float(np.median(alt)) if alt else None
        st["median_ab_offsets"] = float(np.median(abr)) if abr else None
        # brightness halves
        mags = np.array([r["cat_mag"] for r in br])
        rr = np.array([r["ratio"] for r in br])
        mm = np.median(mags)
        st["median_bright_half"] = float(np.median(rr[mags <= mm]))
        st["median_faint_half"] = float(np.median(rr[mags > mm]))
        res[f"{band}/{tier}"] = st
    summary = {"made": datetime.now().isoformat(timespec="seconds"), "planned": smp["n"], "measured": len(measured),
               "engine_failed": n_fail, "no_gaia_model": n_nogaia, "sample_cuts": smp["cut_counts"],
               "band_drops": drops, "bands": res,
               "fields_measured": sorted({smp["stars"][s]["field"] for s in measured})}
    (work / "report.json").write_text(json.dumps(summary, indent=1))
    with open(ROOT / "pipeline" / "spectrum_check.csv", "w", newline="") as fh:
        cols = ["source_id", "field", "band", "tier", "cat_mag", "cat_flux_ujy", "cat_err_ujy", "spherex_flux_ujy",
                "spherex_err_ujy", "coverage", "ratio", "ratio_err", "ratio_alt_reference", "ratio_ab_offsets",
                "j_minus_ks", "det_radius_px", "g", "season_ratios"]
        w = csv.DictWriter(fh, fieldnames=cols, lineterminator="\n")
        w.writeheader()
        for r in rows:
            o = {k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.items()}
            o["season_ratios"] = ";".join(f"{k}:{v:.4f}" for k, v in sorted(r["season_ratios"].items()))
            w.writerow(o)
    (work / "report_tables.md").write_text(render_md(summary))
    print(json.dumps(summary, indent=1))


def render_md(sm):
    """Markdown tables of the report (pasted into pipeline/SPECTRUM_CHECK.md)."""
    out = []
    for tier in ("full", "partial"):
        out += [f"### {tier} coverage", "",
                "| band | N | median R | +- (bootstrap) | robust scatter | pull width (no floor) | floor | verdict |",
                "|---|---|---|---|---|---|---|---|"]
        for b in BANDS:
            st = sm["bands"].get(f"{b}/{tier}", {})
            if "median" not in st:
                out.append(f"| {b} | {st.get('n', 0)} | - | - | - | - | - | {'too few stars' if tier == 'full' else '-'} |")
                continue
            out.append(f"| {b} | {st['n']} | {st['median']:.3f} | {st['median_err']:.3f} | {st['scatter']:.3f} | "
                       f"{st['pull_width_raw']:.2f} | {st['floor']:.3f} | {st['verdict']} |")
        out += ["", "| band | rho(mag) p | rho(J-Ks) p | rho(det. radius) p | rho(G) p | bright / faint half | per season (median R, N) | w2 normalisation | AB offsets |",
                "|---|---|---|---|---|---|---|---|---|"]
        for b in BANDS:
            st = sm["bands"].get(f"{b}/{tier}", {})
            if "median" not in st:
                continue
            tr = lambda k: (f"{st[k][0]:+.2f} ({st[k][1]:.2g})" if k in st else "-")      # noqa: E731
            sea = ", ".join(f"{k} {v[0]:.3f} ({v[1]})" for k, v in st["season_median"].items())
            alt = f"{st['median_alt_reference']:.3f}" if st.get("median_alt_reference") else "-"
            ab = f"{st['median_ab_offsets']:.3f}" if st.get("median_ab_offsets") else "-"
            out.append(f"| {b} | {tr('trend_mag')} | {tr('trend_J-Ks')} | {tr('trend_det_radius')} | {tr('trend_G')} | "
                       f"{st['median_bright_half']:.3f} / {st['median_faint_half']:.3f} | {sea} | {alt} | {ab} |")
        out.append("")
    out += ["### Cuts", "", "| step | stars |", "|---|---|"]
    out += [f"| {k.replace('1_selected', '1 (selected, not removed):')} | {v} |" for k, v in sm["sample_cuts"].items()]
    out += ["", "| band | dropped: " + " | ".join(["catalogue_quality", "no_allwise", "no_catalogue_mag", "saturated", "coverage"]) + " |",
            "|---|---|---|---|---|---|"]
    for b in BANDS:
        d = sm["band_drops"][b]
        out.append(f"| {b} | " + " | ".join(str(d.get(k, 0)) for k in ["catalogue_quality", "no_allwise",
                                                                          "no_catalogue_mag", "saturated", "coverage"]) + " |")
    out += ["", f"Planned {sm['planned']}, measured {sm['measured']}, engine failed {sm['engine_failed']}, "
            f"no Gaia neighbour model {sm['no_gaia_model']}; fields measured: {len(sm['fields_measured'])}.", ""]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("step", choices=["catalog", "sample", "measure", "report"])
    ap.add_argument("--work", required=True, help="scratch folder outside the repository")
    ap.add_argument("--limit", type=int, help="measure: at most this many stars (smoke test)")
    a = ap.parse_args()
    work = Path(a.work).expanduser().resolve()
    if ROOT in work.parents or work == ROOT:
        sys.exit("--work must be outside the repository")
    work.mkdir(parents=True, exist_ok=True)
    {"catalog": lambda: cmd_catalog(work), "sample": lambda: cmd_sample(work),
     "measure": lambda: cmd_measure(work, a.limit), "report": lambda: cmd_report(work)}[a.step]()


if __name__ == "__main__":
    main()
