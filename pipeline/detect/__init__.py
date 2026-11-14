"""Fazari candidate finder: moving and changing sources in SPHEREx images of one sky point.

Modules
  schema     candidate record, classes, merging, candidates.json writer
  data       exposures of a field, seasons, visits, wavelength bins, calibrated stacks
  measure    batched EPSF astrometry of a source list in one exposure (native pixels)
  calib      per-exposure / per-cell registration against Gaia DR3 (or the field itself)
  diffimg    detector A: season-difference images, catalogue-free
  gaia_astrom detector B: every Gaia DR3 star, measured motion vs the Gaia prediction
  deep_astrom detector D: catalogue-free astrometry of every source of the deep stack
  fast       detector C: single-exposure transients within a season (asteroids)
  sso        known solar-system objects (IMCCE SkyBoT cone search, cached)
  inject     synthetic moving sources for the injection tests
  run        runs the registered detectors and writes candidates.json

A detector is any module with NAME (str) and run(ctx) -> list of candidate dicts
(schema.new_candidate). Register it in run.DETECTORS. See pipeline/DETECTION.md.
"""
import sys
from pathlib import Path

_PIPE = str(Path(__file__).resolve().parent.parent)          # pipeline/ (blink.py, sky_index.py)
if _PIPE not in sys.path:
    sys.path.insert(0, _PIPE)
