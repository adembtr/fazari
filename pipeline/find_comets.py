#!/usr/bin/env python3
"""Fazari: known comets moving through real SPHEREx images (selection, boxes, products, site data).

  uv run --no-project --with astropy --with reproject --with numpy --with scipy --with matplotlib --with pillow \
      python -I -u pipeline/find_comets.py run --comet "2025 R2" [--n 60] [--tmax 16]
  ... find_comets.py products --comet "2025 R2" [--site]

See pipeline/detect/comets.py (method) and pipeline/COMETS.md (results, limits).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from detect.comet_products import main  # noqa: E402

if __name__ == "__main__":
    main()
