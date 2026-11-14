# Candidate finder: moving and changing sources (v1)

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

Version v1: thresholds frozen at TEST-READY v1 16:58, code committed in 257a7c3. Test results (V1–V10:
6 pass, 3 fail, 1 limit) are in [`site/data/verify/tests.json`](../site/data/verify/tests.json), summarised at
the top of [`ACCURACY.md`](ACCURACY.md).
