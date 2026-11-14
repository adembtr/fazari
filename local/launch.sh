#!/bin/bash
# Starts the Fazari local engine in a terminal window (if it is not running yet) and opens the
# explorer in the default browser. Used by the desktop launcher Fazari-Local.desktop.
set -u
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
PORT="${FAZARI_PORT:-8765}"
PAGE=explore.html
[ -f site/explore.html ] || PAGE=ornek.html
URL="http://127.0.0.1:${PORT}/${PAGE}"

up() {
  python3 -I -c "import json,sys,urllib.request as u; sys.exit(0 if json.load(u.urlopen('http://127.0.0.1:${PORT}/api/health', timeout=1)).get('ok') else 1)" 2>/dev/null
}

if ! up; then
  RUN="python3 -I local/serve.py --port ${PORT}; echo; read -r -p 'Fazari local engine stopped. Press Enter to close.' _"
  if command -v xfce4-terminal >/dev/null; then
    xfce4-terminal --title="Fazari local engine" --working-directory="$PWD" -x bash -c "$RUN" &
  elif command -v gnome-terminal >/dev/null; then
    gnome-terminal --title="Fazari local engine" --working-directory="$PWD" -- bash -c "$RUN" &
  else
    x-terminal-emulator -e bash -c "$RUN" &
  fi
  for _ in $(seq 1 40); do up && break; sleep 0.25; done
fi
xdg-open "$URL" >/dev/null 2>&1 &
