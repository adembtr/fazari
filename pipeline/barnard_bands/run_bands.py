"""Run pipeline/blink.py main() for Barnard unchanged, but call its own astrometry() once per
wavelength box (exposures with bin_um == box) in addition to the normal all-exposure call.
Outputs only to FAZARI_OUT (scratch). Per-band results -> <FAZARI_OUT>/bands.json
Run (from this folder): the command in the "#" line of site/data/verify/evidence/barnard_bands.csv, then
  python3 -I write_csv.py <FAZARI_OUT>/bands.json ../../site/data/verify/evidence/barnard_bands.csv ../..
Shown on verify.html under the first Barnard's Star test."""
import json, os, sys
REPO = sys.argv[1]
sys.path.insert(0, os.path.join(REPO, "pipeline"))
import blink
orig = blink.astrometry
res = {}
def per_band(t, infos, epochs, ra_c, dec_c, grid_xy):
    for b in blink.BIN_CENTERS:
        sub = [dict(i) for i in infos if i.get("bin_um") == b]
        print(f"=== band {b} um: {len(sub)} exposures")
        if not sub:
            continue
        try:
            res[b] = orig(t, sub, epochs, ra_c, dec_c, grid_xy)
        except Exception as e:
            print("  band failed:", e)
    print("=== all bands")
    res["all"] = orig(t, [dict(i) for i in infos], epochs, ra_c, dec_c, grid_xy)
    (blink.OUT / "bands.json").write_text(json.dumps({str(k): v for k, v in res.items()}, indent=1, default=str))
    return orig(t, infos, epochs, ra_c, dec_c, grid_xy)
blink.astrometry = per_band
blink.main("barnard")
