"""Build site/data/categories.json.
Run: uv run --no-project --with astropy --with numpy python -I site/explore/tools/build_categories.py <repo root>
 Coordinates resolved live from SIMBAD via CDS Sesame,
challenge targets taken from pipeline/targets.json (Gaia DR3) and cross-checked against SIMBAD,
computed points (ecliptic, poles, Planet Nine path) from astropy.
Parallax (mas) of the nearby stars and brown dwarfs: the SIMBAD value (Gaia DR3 where SIMBAD takes it from Gaia,
else the cited literature value); challenge targets: pipeline/targets_extra.json (the values blink.py uses).
Turkish text (name_tr, description_tr, disclaimer_tr, note_tr) comes from categories_tr.json next to this script.
Only the Turkish fields, no network, nothing recomputed: python3 -I site/explore/tools/build_categories.py <repo root> --tr-only"""
import json, re, sys, math, urllib.request, urllib.parse, datetime, os

REPO = sys.argv[1]
TR_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "categories_tr.json")

def add_tr(cats):
    """Turkish fields from categories_tr.json, each right after its English field (category: name_tr,
    description_tr, disclaimer_tr; point: name_tr, note_tr). Every other field stays as it is."""
    tr = json.load(open(TR_FILE, encoding="utf-8"))
    def put(d, extra):
        if not extra:
            return
        new = {}
        for k, v in d.items():
            if k in extra:                       # an older Turkish value: replaced next to its English field
                continue
            new[k] = v
            if k + "_tr" in extra:
                new[k + "_tr"] = extra[k + "_tr"]
        for k, v in extra.items():
            new.setdefault(k, v)
        d.clear(); d.update(new)
    for c in cats:
        put(c, tr["categories"].get(c["id"]))
        for p in c.get("points", []):
            put(p, tr["points"].get(p["id"]))
    return cats

if "--tr-only" in sys.argv[2:]:
    path = f"{REPO}/site/data/categories.json"
    data = json.load(open(path, encoding="utf-8"))
    add_tr(data["categories"])
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(path + ".tmp", path)
    sys.exit(0)

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord, BarycentricMeanEcliptic, Galactic, ICRS, get_constellation

targets = json.load(open(f"{REPO}/pipeline/targets.json"))
targets_extra = json.load(open(f"{REPO}/pipeline/targets_extra.json"))
TODAY = datetime.date.today().isoformat()

def sesame(name):
    url = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxpI/S?" + urllib.parse.quote(name)
    x = urllib.request.urlopen(url, timeout=40).read().decode()
    g = lambda t: (re.search(f"<{t}>([^<]*)</{t}>", x) or [None, None])[1]
    if g("jradeg") is None:
        raise SystemExit(f"Sesame could not resolve {name!r}")
    plx = re.search(r"<plx><v>([^<]*)</v><e>([^<]*)</e>(?:<q>[^<]*</q>)?<r>([^<]*)</r></plx>", x)
    gaia = re.search(r"<alias>Gaia DR3 (\d+)</alias>", x)
    return dict(oname=g("oname"), ra=float(g("jradeg")), dec=float(g("jdedeg")),
                pmra=float(g("pmRA")) if g("pmRA") else None,
                pmdec=float(g("pmDE")) if g("pmDE") else None, otype=g("otype"),
                plx=(float(plx[1]), float(plx[2]), plx[3].replace("&amp;", "&")) if plx else None,
                gaia_dr3=gaia[1] if gaia else None)

# SIMBAD parallax references: Gaia (E)DR3 catalogue entries, and readable names for the literature ones
GAIA_REFS = {"2020yCat.1350....0G", "2022yCat.1355....0G", "2023A&A...674A...1G"}
CITE = {"2018A&A...618A.111L": "Lazorenko & Sahlmann 2018, A&A 618, A111",
        "2012ApJ...752...56F": "Faherty et al. 2012, ApJ 752, 56"}

def parallax_fields(s):
    """parallax (mas) and its source from a sesame() result, or {} when SIMBAD has none."""
    if not s["plx"] or s["plx"][0] <= 0:
        return {}
    v, e, ref = s["plx"]
    if ref in GAIA_REFS and s["gaia_dr3"]:
        return dict(parallax=round(v, 3), parallax_source=f"Gaia DR3 {s['gaia_dr3']} ({v:.3f} +- {e:.3f} mas)")
    return dict(parallax=v, parallax_source=f"{CITE.get(ref, ref)} ({v} +- {e} mas), via SIMBAD; no Gaia DR3 parallax")

def move(ra, dec, pmra, pmdec, dt):
    d = dec + pmdec * dt / 3.6e6
    r = ra + pmra * dt / 3.6e6 / math.cos(math.radians(dec))
    return r % 360, d

def r6(x): return None if x is None else round(x, 6)

def simbad_point(pid, name, simbad_name, note, moving=False, plx=False):
    s = sesame(simbad_name)
    p = dict(id=pid, name=name, ra=r6(s["ra"]), dec=r6(s["dec"]), epoch=2000.0)
    if moving and s["pmra"] is not None:
        p["pmra"], p["pmdec"] = s["pmra"], s["pmdec"]
        if plx:                                  # nearby stars / brown dwarfs: the engine needs it
            p.update(parallax_fields(s))
        p["ra_2026"], p["dec_2026"] = map(r6, move(s["ra"], s["dec"], s["pmra"], s["pmdec"], 26.0))
    p["note"] = note
    p["source"] = f"SIMBAD via CDS Sesame ({s['oname'].strip()}, type {s['otype']}), retrieved {TODAY}"
    return p

def challenge_point(tid, note, simbad_name):
    t = targets[tid]
    p = dict(id=tid, name=t["name"], ra=r6(t["ra"]), dec=r6(t["dec"]), epoch=t["epoch"],
             pmra=round(t["pmra"], 3), pmdec=round(t["pmdec"], 3))
    x = targets_extra.get(tid, {})
    if x.get("plx"):
        p["parallax"], p["parallax_source"] = x["plx"], x.get("plx_source", "pipeline/targets_extra.json")
    p["ra_2026"], p["dec_2026"] = map(r6, move(t["ra"], t["dec"], t["pmra"], t["pmdec"], 2026.0 - t["epoch"]))
    # cross-check with SIMBAD (epoch 2000 -> target epoch)
    s = sesame(simbad_name)
    sr, sd = move(s["ra"], s["dec"], s["pmra"] or 0, s["pmdec"] or 0, t["epoch"] - 2000.0)
    sep = SkyCoord(sr*u.deg, sd*u.deg).separation(SkyCoord(t["ra"]*u.deg, t["dec"]*u.deg)).arcsec
    print(f"  check {tid}: SIMBAD vs targets.json at epoch {t['epoch']}: {sep:.2f} arcsec", file=sys.stderr)
    assert sep < 5, (tid, sep)
    src = "Gaia DR3 " + t["gaia_dr3"] if t.get("gaia_dr3") else (t.get("notes") or "pipeline/targets.json")
    p["source"] = f"{src}; cross-checked with SIMBAD ({s['oname'].strip()}): {sep:.1f}\" apart, retrieved {TODAY}"
    p["note"] = note
    p["challenge"] = True
    p["gallery"] = f"data/{tid}/"
    return p

def computed(pid, name, coord, note, source):
    c = coord.icrs
    return dict(id=pid, name=name, ra=r6(c.ra.deg), dec=r6(c.dec.deg), epoch=2000.0, note=note, source=source)

ECL = lambda lon, lat: SkyCoord(lon=lon*u.deg, lat=lat*u.deg, frame=BarycentricMeanEcliptic(equinox="J2000"))

cats = []

# 1. Challenge targets ----------------------------------------------------------
print("challenge", file=sys.stderr)
challenge = [
    challenge_point("barnard", "The fastest-moving star in our sky. It shifts about 10 arcseconds every year, enough to see between SPHEREx seasons.", "Barnard's star"),
    challenge_point("eps_indi_b", "A pair of cold brown dwarfs orbiting a nearby Sun-like star. They move fast across the sky.", "eps Ind B"),
    challenge_point("wise0855", "The coldest known brown dwarf, about as cold as the North Pole. Very faint, but bright in the infrared.", "WISE J085510.83-071442.5"),
    challenge_point("rw_aur", "A young star still surrounded by dust. Its brightness changes as dust clouds pass in front of it.", "RW Aur"),
    challenge_point("r_dra", "A pulsing red giant. It brightens and fades over about eight months.", "R Dra"),
]
cats.append(dict(id="challenge", name="Challenge targets", icon="🏁", highlight=True,
    description="The five official test targets of the NASA Space Apps 2026 \"Planet X and SPHEREx\" challenge.",
    points=challenge))

# 2. Fast nearby stars ---------------------------------------------------------
print("fast", file=sys.stderr)
cats.append(dict(id="fast_stars", name="Fast nearby stars", icon="🏃",
    description="Close neighbours of the Sun that crawl across the sky fast enough to notice between observing seasons.",
    points=[
        challenge[0] | {"challenge": True},
        simbad_point("kapteyn", "Kapteyn's Star", "Kapteyn's star", "An old halo star passing through our neighbourhood; the second-fastest star in the sky.", True, plx=True),
        simbad_point("groombridge1830", "Groombridge 1830", "HD 103095", "An old, metal-poor star racing through the Sun's neighbourhood.", True, plx=True),
        simbad_point("61cyg_a", "61 Cygni A", "61 Cyg A", "The first star to have its distance measured (1838), thanks to its fast motion.", True, plx=True),
        simbad_point("lacaille9352", "Lacaille 9352", "GJ 887", "A bright red dwarf about 11 light-years away.", True, plx=True),
        simbad_point("van_maanen", "Van Maanen's Star", "Wolf 28", "The closest single white dwarf, a burnt-out star core.", True, plx=True),
        simbad_point("proxima", "Proxima Centauri", "Proxima Centauri", "The closest star to the Sun, 4.2 light-years away.", True, plx=True),
        simbad_point("wolf359", "Wolf 359", "Wolf 359", "One of the closest and faintest red dwarfs.", True, plx=True),
        simbad_point("teegarden", "Teegarden's Star", "Teegarden's star", "A tiny red dwarf with planets, found only in 2003 because of its fast motion.", True, plx=True),
    ]))

# 3. Brown dwarfs --------------------------------------------------------------
print("bd", file=sys.stderr)
cats.append(dict(id="brown_dwarfs", name="Brown dwarfs", icon="🟤",
    description="\"Failed stars\": too small to shine like the Sun, they glow faintly in infrared light, which is what SPHEREx sees.",
    points=[
        simbad_point("luhman16", "Luhman 16AB", "Luhman 16", "The closest brown dwarfs to the Sun, a pair 6.5 light-years away.", True, plx=True),
        challenge[2] | {"challenge": True},
        challenge[1] | {"challenge": True},
        simbad_point("gj229", "Gliese 229 (B)", "HD 42581", "The first brown dwarf ever imaged (1995) orbits this red dwarf. Point is the host star, Gliese 229 A.", True, plx=True),
        simbad_point("2m0415", "2MASS J0415-0935", "2MASS J04151954-0935066", "One of the coldest T-type brown dwarfs.", True, plx=True),
        simbad_point("ugps0722", "UGPS J0722-0540", "UGPS J072227.51-054031.2", "A very cold brown dwarf found in an infrared survey.", True, plx=True),
        simbad_point("gj570d", "Gliese 570 D", "GJ 570 D", "A cold brown dwarf orbiting a triple star system.", True, plx=True),
        simbad_point("ross458c", "Ross 458 C", "Ross 458 C", "A planet-mass brown dwarf companion of a double star.", True, plx=True),
    ]))

# 4. Variable stars ------------------------------------------------------------
print("var", file=sys.stderr)
cats.append(dict(id="variable_stars", name="Variable stars", icon="✨",
    description="Stars that brighten and fade. In a blink they stay in place but change brightness.",
    points=[
        challenge[4] | {"challenge": True},
        challenge[3] | {"challenge": True},
        simbad_point("mira", "Mira (omicron Ceti)", "omi Cet", "The original 'wonderful' variable star; it fades over about 11 months.", True),
        simbad_point("chi_cyg", "chi Cygni", "chi Cyg", "A pulsing giant with one of the largest brightness swings known.", True),
        simbad_point("r_leo", "R Leonis", "R Leo", "A bright red pulsing star in Leo.", True),
        simbad_point("r_cas", "R Cassiopeiae", "R Cas", "A pulsing red giant that changes by a factor of thousands in visible light.", True),
        simbad_point("t_tau", "T Tauri", "T Tau", "The prototype of young, flickering Sun-like stars.", True),
        simbad_point("betelgeuse", "Betelgeuse", "alf Ori", "A red supergiant in Orion that dimmed strongly in 2019-2020.", True),
        simbad_point("irc10216", "CW Leonis (IRC +10216)", "IRC +10216", "A carbon star wrapped in dust; one of the brightest objects in the near-infrared sky.", True),
    ]))

# 5. Planet Nine search zone ---------------------------------------------------
print("p9", file=sys.stderr)
inc, node = 16.0, 97.0  # Brown & Batygin (2021) median marginalised i and Omega
def p9(ulat):
    ur, ir, nr = map(math.radians, (ulat, inc, node))
    x = math.cos(nr)*math.cos(ur) - math.sin(nr)*math.sin(ur)*math.cos(ir)
    y = math.sin(nr)*math.cos(ur) + math.cos(nr)*math.sin(ur)*math.cos(ir)
    z = math.sin(ur)*math.sin(ir)
    return ECL(math.degrees(math.atan2(y, x)) % 360, math.degrees(math.asin(z))).icrs
path = [p9(a) for a in range(0, 361, 5)]
path_radec = [[round(c.ra.deg, 3), round(c.dec.deg, 3)] for c in path]
dense = [(a/4, p9(a/4)) for a in range(0, 1440)]
def at_ra(target):
    best = min(dense, key=lambda t: abs(((t[1].ra.deg - target + 180) % 360) - 180))
    return best[1]
gal_b = [(a, c, abs(c.galactic.b.deg)) for a, c in dense]
node_pt = p9(0.0)  # ascending node: on the ecliptic, near the northern Galactic plane crossing
P9SRC = "Brown & Batygin 2021, AJ 162, 219 (arXiv:2108.09868): ~95% of the predicted probability lies within +/-12 deg of an orbit with i=16 deg, Omega=97 deg; density peaks near RA 45 deg (aphelion). Computed on that path."
p9pts = []
for ra_t, label, note in [
        (45, "Most likely stretch (RA ≈ 3h)", "The predicted path's peak probability, near the far point of the orbit. Theory only, nothing has been found here."),
        (25, "Predicted path (RA ≈ 1.7h)", "A point on the predicted path. Theory only."),
        (65, "Predicted path (RA ≈ 4.3h)", "A point on the predicted path. Theory only."),
    ]:
    p9pts.append(computed(f"p9_ra{ra_t}", label, at_ra(ra_t), note, P9SRC))
p9pts.append(computed("p9_galactic_crossing", "Where the path meets the Milky Way (RA ≈ 6.5h)", node_pt,
    "Searches up to 2024 ruled out about 78% of the predicted parameter space; much of what is left is where the northern Milky Way crosses the ecliptic, near here. Theory only.",
    "Brown, Holman & Batygin 2024, AJ (arXiv:2401.17977); point = ascending node of the Brown & Batygin 2021 median orbit (i=16 deg, Omega=97 deg)."))
cats.append(dict(id="planet_nine", name="Planet Nine search zone", icon="🔭",
    description="A band of sky where theory says a hidden giant planet could be. It has NOT been detected; this is a place to look, not a discovery.",
    disclaimer="Planet Nine is a hypothesis. No detection has been confirmed. Any moving dot you see here is far more likely an asteroid, an artifact or a known star.",
    path=path_radec, path_halfwidth_deg=12.0,
    citation="Brown, M. E. & Batygin, K. 2021, AJ 162, 219, 'The Orbit of Planet Nine' (arXiv:2108.09868); Brown, Holman & Batygin 2024, 'A Pan-STARRS1 Search for Planet Nine' (arXiv:2401.17977).",
    points=p9pts))

# 6. Milky Way centre ----------------------------------------------------------
print("mw", file=sys.stderr)
cats.append(dict(id="milky_way", name="Milky Way center", icon="🌌",
    description="The crowded heart of our galaxy, hidden behind dust in visible light but much clearer in the infrared.",
    points=[
        simbad_point("sgr_a", "Sgr A* (our galaxy's black hole)", "Sgr A*", "The supermassive black hole at the centre of the Milky Way, 26,000 light-years away."),
        simbad_point("baade", "Baade's Window", "Baade's Window", "A gap in the dust where we can see deep into the galactic bulge."),
        computed("gal_anticenter", "Galactic anticenter", SkyCoord(l=180*u.deg, b=0*u.deg, frame="galactic"),
                 "The point straight away from the galactic centre, in Taurus/Auriga.", "Computed: Galactic l=180 deg, b=0 deg (astropy)."),
        simbad_point("cygnus_x", "Cygnus X star-forming region", "Cygnus X", "A huge star factory in the Milky Way's disk, glowing in the infrared."),
    ]))

# 7. Nebulae -------------------------------------------------------------------
print("neb", file=sys.stderr)
cats.append(dict(id="nebulae", name="Nebulae", icon="☁️",
    description="Clouds of gas and dust where stars are born or have died; infrared light shines through the dust.",
    points=[
        simbad_point("m42", "Orion Nebula (M42)", "M 42", "The closest big star nursery, visible to the naked eye."),
        simbad_point("horsehead", "Horsehead Nebula", "Barnard 33", "A dark dust cloud shaped like a horse's head."),
        simbad_point("m16", "Eagle Nebula (M16)", "M 16", "Home of the 'Pillars of Creation'."),
        simbad_point("m8", "Lagoon Nebula (M8)", "M 8", "A bright star-forming cloud in Sagittarius."),
        simbad_point("m17", "Omega Nebula (M17)", "M 17", "One of the brightest star-forming regions in the galaxy."),
        simbad_point("carina", "Carina Nebula", "NGC 3372", "A giant cloud around the massive star Eta Carinae."),
        simbad_point("rho_oph", "Rho Ophiuchi cloud", "L1688", "One of the nearest star nurseries, full of young stars hidden in dust."),
        simbad_point("m1", "Crab Nebula (M1)", "M 1", "The remains of a star that exploded in the year 1054."),
        simbad_point("helix", "Helix Nebula", "NGC 7293", "The glowing shell of a dying Sun-like star."),
        simbad_point("m57", "Ring Nebula (M57)", "M 57", "A small, ring-shaped dying-star shell."),
    ]))

# 8. Galaxies ------------------------------------------------------------------
print("gal", file=sys.stderr)
cats.append(dict(id="galaxies", name="Galaxies", icon="🌀",
    description="Other islands of billions of stars, far beyond the Milky Way.",
    points=[
        simbad_point("m31", "Andromeda Galaxy (M31)", "M 31", "Our big neighbour, 2.5 million light-years away."),
        simbad_point("lmc", "Large Magellanic Cloud", "LMC", "A small galaxy orbiting the Milky Way, near the south ecliptic pole."),
        simbad_point("smc", "Small Magellanic Cloud", "SMC", "The Large Cloud's smaller companion."),
        simbad_point("m33", "Triangulum Galaxy (M33)", "M 33", "A face-on spiral in our Local Group."),
        simbad_point("m51", "Whirlpool Galaxy (M51)", "M 51", "A classic spiral pulling on a smaller companion."),
        simbad_point("m81", "Bode's Galaxy (M81)", "M 81", "A bright spiral in Ursa Major, next to M82."),
        simbad_point("m82", "Cigar Galaxy (M82)", "M 82", "A galaxy bursting with new stars, very bright in the infrared."),
        simbad_point("m104", "Sombrero Galaxy (M104)", "M 104", "An edge-on galaxy with a dark dust lane."),
        simbad_point("cen_a", "Centaurus A", "Cen A", "A galaxy with a giant black hole and a dramatic dust band."),
    ]))

# 9. Asteroid lane (ecliptic) --------------------------------------------------
print("ecl", file=sys.stderr)
ecl_pts = []
for lon in range(0, 360, 30):
    c = ECL(lon, 0).icrs
    con = get_constellation(c)
    ecl_pts.append(computed(f"ecl_{lon:03d}", f"Ecliptic in {con} (λ = {lon}°)", c,
        "Asteroids and comets travel close to this line. A dot that jumps between seasons here is most likely an asteroid.",
        f"Computed: ecliptic longitude {lon} deg, latitude 0 (J2000 mean ecliptic, astropy)."))
cats.append(dict(id="ecliptic", name="Asteroid lane (ecliptic)", icon="☄️",
    description="The path of the Sun and planets across the sky. Most asteroids live near this line, so moving dots are common here.",
    points=ecl_pts))

# 10. SPHEREx deep fields ------------------------------------------------------
print("deep", file=sys.stderr)
cats.append(dict(id="deep_fields", name="SPHEREx deep fields", icon="🎯",
    description="The two ecliptic poles: SPHEREx passes over them on almost every orbit, so these spots have the most observations.",
    points=[
        computed("nep", "North Ecliptic Pole", ECL(0, 90), "SPHEREx's northern deep field, in Draco. Many repeat visits make blinks rich here.",
                 "Computed: ecliptic latitude +90 deg (J2000 mean ecliptic, astropy)."),
        computed("sep", "South Ecliptic Pole", ECL(0, -90), "SPHEREx's southern deep field, in Dorado, next to the Large Magellanic Cloud.",
                 "Computed: ecliptic latitude -90 deg (J2000 mean ecliptic, astropy)."),
    ]))

# 11. Surprise me --------------------------------------------------------------
cats.append(dict(id="surprise", name="Surprise me", icon="🎲", random=True,
    description="Jump to a random spot, chosen from all the points above or anywhere on the sky.", points=[]))

out = dict(
    _note=("Named sky categories for explore.html. ra/dec in degrees (ICRS) at 'epoch' (Julian year). "
           "pmra = mu_alpha*cos(dec), pmdec in mas/yr when known; parallax in mas (nearby stars and brown dwarfs, "
           "with parallax_source). ra_2026/dec_2026 = position linearly moved to 2026.0 "
           "(use these to centre cutouts on fast movers). Points with 'challenge': true are the 5 official targets; "
           "'gallery' is the precomputed product folder (may not exist yet). Built by a script from SIMBAD (CDS Sesame), "
           "Gaia DR3 (pipeline/targets.json) and astropy."),
    generated=TODAY,
    ai_disclosure=("The script that builds this file and its descriptive text were written with help from Anthropic's "
                   "Claude (Claude Code) and checked by Team Fazari; positions and motions come from SIMBAD (CDS) and "
                   "Gaia DR3, not from an AI model."),
    categories=cats)
add_tr(cats)                                     # Turkish fields from categories_tr.json
json.dump(out, open(f"{REPO}/site/data/categories.json", "w"), indent=1, ensure_ascii=False)
print("points:", sum(len(c["points"]) for c in cats), file=sys.stderr)
