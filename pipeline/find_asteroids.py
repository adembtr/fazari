#!/usr/bin/env python3
"""Fazari known-asteroid recovery in SPHEREx ecliptic fields (detector C, known-object mode).

  uv run --no-project --with astropy --with numpy --with scipy --with pillow \
      python -I pipeline/find_asteroids.py select | run [--only F01] | report | blink --field F01 --name X

See pipeline/detect/asteroids.py (method) and pipeline/ASTEROIDS.md (results, limits).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from detect.asteroids import main  # noqa: E402

if __name__ == "__main__":
    main()
