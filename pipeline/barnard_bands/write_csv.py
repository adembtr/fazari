"""bands.json (from run_bands.py) -> site/data/verify/evidence/barnard_bands.csv. No number typed by hand."""
import csv, json, subprocess, sys
src, dest, repo = sys.argv[1], sys.argv[2], sys.argv[3]
b = json.load(open(src))
commit = subprocess.check_output(["git", "-C", repo, "rev-parse", "--short", "HEAD"], text=True).strip()
cmd = ("FAZARI_OUT=<scratch> FAZARI_FIELD_STARS=0 FAZARI_NO_GAIA_FETCH=1 uv run --no-project --with astropy --with reproject "
       "--with numpy --with scipy --with matplotlib --with pillow python -I run_bands.py <repo>  "
       "(= pipeline/blink.py main('barnard') unchanged; its astrometry() also run on the exposures of one wavelength box "
       "at a time: bin_um from which_bin = detector + lambda within 6%; shift = same-orientation season pair)")
rows = []
for k in sorted((k for k in b if k != "all"), key=float):
    m = b[k]
    if not m.get("shift_arcsec"):
        continue
    dt = m["dt_years"]
    rows.append({"um": float(k), "n_exposures": m["fit"]["n_used"], "seasons": f"{m['from_epoch']}→{m['to_epoch']}",
                 "shift_arcsec": round(m["shift_arcsec"], 3), "err_arcsec": round(m["shift_err_arcsec"], 3),
                 "dt_yr": round(dt, 4), "speed_arcsec_yr": round(m["shift_arcsec"] / dt, 3),
                 "err_speed": round(m["shift_err_arcsec"] / dt, 3), "pa_deg": round(m["pa_deg"], 2),
                 "gaia_pred_arcsec": round(m["gaia_predicted_arcsec"], 3)})
with open(dest, "w", newline="", encoding="utf-8") as f:
    f.write(f"# Barnard's Star per wavelength box, code {commit}: {cmd}\n")
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
print(open(dest).read())
