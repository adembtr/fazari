#!/usr/bin/env python3
"""Fazari candidate finder: moving and changing sources in the SPHEREx images of one sky point.

  uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib \
      --with pillow python -I pipeline/find_candidates.py <target> | --job <id> | --dir D --ra R --dec D

See pipeline/detect/run.py (options) and pipeline/DETECTION.md (method, tests, limits).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from detect.run import main  # noqa: E402

if __name__ == "__main__":
    main()
