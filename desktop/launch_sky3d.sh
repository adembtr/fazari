#!/bin/bash
# Starts the Fazari local engine (if it is not running yet) and then the Fazari Sky 3D viewer.
# Used by the desktop launcher ~/Desktop/Fazari-3D-Python.desktop.
set -u
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
PORT="${FAZARI_PORT:-8765}"
export FAZARI_T0="$(date +%s.%N)"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
mkdir -p cache/sky3d

up() {
  python3 -I -c "import json,sys,urllib.request as u; sys.exit(0 if json.load(u.urlopen('http://127.0.0.1:${PORT}/api/health', timeout=1)).get('ok') else 1)" 2>/dev/null
}

if ! up && [ -f local/serve.py ]; then
  RUN="python3 -I local/serve.py --port ${PORT}; echo; read -r -p 'Fazari local engine stopped. Press Enter to close.' _"
  if command -v xfce4-terminal >/dev/null; then
    xfce4-terminal --title="Fazari local engine" --working-directory="$PWD" -x bash -c "$RUN" &
  elif command -v gnome-terminal >/dev/null; then
    gnome-terminal --title="Fazari local engine" --working-directory="$PWD" -- bash -c "$RUN" &
  else
    nohup python3 -I local/serve.py --port "${PORT}" >cache/sky3d/serve.log 2>&1 &
  fi
fi
# The viewer does not wait for the engine: it shows "engine offline" until the health check answers.
exec "$UV" run --no-project --with vispy --with PyQt5 --with numpy --with astropy --with astropy-healpix \
  python -I desktop/sky_viewer.py --engine "http://127.0.0.1:${PORT}" "$@" >>cache/sky3d/viewer.log 2>&1
