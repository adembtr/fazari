# Candidate finder: moving and changing sources (work in progress)

Code: `pipeline/detect/` (package), launcher `pipeline/find_candidates.py`.
Output: `candidates.json` next to the blink products of a target or job.

## Candidate schema (for every detector, including new ones)

The record format is defined and documented at the top of
[`pipeline/detect/schema.py`](detect/schema.py) (`new_candidate()`, `motion_dict()`).
A detector is a module with `NAME` (short string) and `run(ctx) -> list of records`;
register it in `pipeline/detect/run.py` (`DETECTORS`). `ctx` gives the exposures
(`ctx.exps`, blink.py layout with `_px`), seasons (`ctx.seasons`, `ctx.season_info`),
the Gaia registration offsets (`ctx.cal`), the Gaia table (`ctx.gaia`), the common stack
grid (`ctx.grid`) and a cached stacker (`ctx.stacker.stack(exposures)`).

Classes: `gaia-known`, `asteroid-known`, `candidate`, `variable`, `artifact`.
Kinds: `motion`, `appearing`, `disappearing`, `variable`, `transient`.
Language: always "candidate", never "discovery".

The full method, thresholds, tests and limits follow when the tests are done.
