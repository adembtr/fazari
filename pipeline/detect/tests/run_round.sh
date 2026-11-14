#!/bin/bash
# Full test round of the candidate finder against the current code (restartable: every test
# skips the field / magnitude outputs that already exist in OUT).
#   pipeline/detect/tests/run_round.sh <OUT dir>
# 4 processes: blind+null fields (2), injection (1 + 1 after the blind runs), shuffle null (1).
set -u
OUT="$1"
cd "$(dirname "$(readlink -f "$0")")/../../.." || exit 1          # fazari/
mkdir -p "$OUT/blind" "$OUT/inj" "$OUT/shuf"
PY="uv run --no-project --quiet --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow python -I -u"
NULLS="job:field-201.365s43.019-c6-b63 job:field-74.831n28.578-c6-b63 job:field-259.095s34.806-c6-b63 job:field-263.523s68.901-c6-b63 job:field-106.796s5.562-c6-b63 job:field-10.000n41.000-c2-b63"
LUH="job:luhman16-162.295s53.317-c6-b63-pm8778"
( FAZARI_OUT="$OUT/blind/fo" $PY pipeline/detect/tests/blind.py --out "$OUT/blind" barnard rw_aur r_dra > "$OUT/blind/b1.log" 2>&1
  $PY pipeline/detect/tests/injection.py --out "$OUT/inj" --field barnard --mags 12,14,16,18 --seed 1 > "$OUT/inj/i3.log" 2>&1 ) &
( FAZARI_OUT="$OUT/blind/fo" $PY pipeline/detect/tests/blind.py --out "$OUT/blind" eps_indi_b wise0855 $LUH $NULLS > "$OUT/blind/b2.log" 2>&1
  $PY pipeline/detect/tests/injection.py --out "$OUT/inj" --field wise0855 --mags 12,13,14,15,16,17,18,19 --seed 1 > "$OUT/inj/i2.log" 2>&1 ) &
$PY pipeline/detect/tests/injection.py --out "$OUT/inj" --field eps_indi_b --mags 12,13,14,15,16,17,18,19 --seed 1 > "$OUT/inj/i1.log" 2>&1 &
$PY pipeline/detect/tests/shuffle.py --out "$OUT/shuf" --n 100 eps_indi_b wise0855 $NULLS $LUH r_dra rw_aur barnard > "$OUT/shuf/s.log" 2>&1 &
wait
python3 -I pipeline/detect/tests/inj_report.py "$OUT/inj" --json "$OUT/inj/report.json" > "$OUT/inj/report.md" 2>&1
echo "round done $(date +%H:%M)" > "$OUT/DONE"
