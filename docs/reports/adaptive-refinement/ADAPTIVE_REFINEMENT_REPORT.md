Adaptive local motion-state refinement is implemented. All changes in this task stayed inside this workspace; pre-existing working-tree changes were preserved.

The original planner offered 0.50 m, 0.25 m and one map-resolution translation everywhere. It had no explicit 0.10 m intermediate primitive on a 0.05 m map, filtered out sub-grid translations, skipped endpoints in the same map cell, and retained only one cost winner per row/column/heading/direction. Consequently nearby positions with different rotation feasibility could be lost. Adding shorter moves alone would still lose same-cell manoeuvring positions to dominance pruning.

The new search policy uses the existing motion-state ClearanceField and the authoritative expanded footprint polygon. Let R be the maximum distance of an expanded polygon vertex from the rotation origin, H the existing hard minimum, P the existing preferred clearance, and C the sampled centre-to-obstacle clearance:

| Condition | Translation lengths | Position keys |
| --- | --- | --- |
| C > R + max(H, P) | 0.50 / 0.25 m | Existing map cell |
| R + H < C <= R + max(H, P) | Add 0.10 m | Existing map cell |
| C <= R + H | Retain 0.10 and 0.05 m as well | Local bins of min(map resolution, 0.05 m) / 2 |

For maps finer than 0.05 m, tight mode also retains the map-resolution primitive. For maps coarser than 0.50 m, the map-resolution primitive remains available. Tight comparisons include the existing numerical tolerance of 1e-9. If preferred clearance is below the hard minimum, the medium band disappears instead of introducing another threshold.

R includes configured polygon geometry, centre offsets and the effective safety margin already used by collision checking. It converts centre clearance into an advisory estimate of room around the rotation envelope. These thresholds never certify a pose as safe and do not replace or reinterpret the physical hard-minimum check. No independent clearance constants or configuration controls were added.

Each expanded state's clearance selects its initial lengths. Existing minimum-clearance samples along candidate translations also trigger shorter lengths on approach, including when a long candidate is subsequently rejected. This gives safe intermediate stopping/turning positions before an obstacle. All lengths are attempted longest first; long moves remain available in every mode. Actual translation endpoints stay on the exact body axis and are never snapped to the positional key. Only tight cells get sub-cell keys; giving medium cells sub-cell keys too was unnecessary and increased detour search time.

The hierarchical guide, corridor widening, Weighted-A* weight, connector cadence, planning budgets and expansion cap are unchanged. MotionPlanOptimiser continues to merge compatible straight actions and independently validate its candidates. More search states do not automatically become more VDA nodes; different selected manoeuvres can still change the final count.

Diagnostics are emitted in `motionplanner.completed` on success and failure; successful plans also retain `eventCounts`:

- `primitiveAttempts`, `primitiveAccepted`, `primitiveCollisions`, `primitiveClearanceRejections` and `primitivePruned` are keyed by length in metres. Attempts exclude dominance/corridor pruning; accepted + collision + hard-clearance rejections equals attempts. Out-of-map endpoints count as collision rejections.
- `generatedStatesByMode` counts actual frontier insertions by endpoint mode (`normal`, `medium`, `tight`), including rotations and direction switches. Medium + tight gives refined-mode generation. Counts include improvements/reinsertions and corridor retries, not globally unique poses.
- `minimumRefinementClearanceM` is null when refinement was never requested. Otherwise it is the minimum source or candidate-sweep clearance that requested refinement. It can be zero for a rejected sweep; it is **not** the minimum clearance of the selected safe plan.
- `refinementMediumClearanceM`, `refinementTightClearanceM` and `refinedPositionResolutionM` expose the actual derived policy. Existing `searchDurationMs`, guide/corridor timings, total `durationMs` and expanded-state counts expose time impact.

Before/after results below compare the working-tree planner saved immediately before this task with the final implementation, using the same safety and cost configuration per case. These are synthetic regression/warehouse fixtures, not a captured production map. Each implementation received one warmup per case, then five measured runs with alternating order. Times are median wall times in milliseconds, including postprocessing. Caches are warm/shared; stage timeouts can make expansion counts vary between runs. Full samples, diagnostics and the baseline module SHA-256 are in [ADAPTIVE_REFINEMENT_REPORT.json](ADAPTIVE_REFINEMENT_REPORT.json).

| Scenario | Successes before → after | Expanded before → after | ms before → after | Final nodes before → after |
| --- | --- | --- | --- | --- |
| Open 18 m | 5/5 → 5/5 | 24 → 24 | 4.06 → 4.10 | 2 → 2 |
| Warehouse open | 5/5 → 5/5 | 1 → 1 | 12.42 → 12.32 | 4 → 4 |
| Warehouse clutter | 5/5 → 5/5 | 1636 → 572 | 596.45 → 418.20 | 7 → 10 |
| Warehouse detour | 5/5 → 5/5 | 1416 → 792 | 417.31 → 391.13 | 10 → 10 |
| Tight L turn, 0.10 m map | 0/5 → 5/5 | 351 → 48 | 72.75 → 50.97 | 0 → 11 |
| Narrow L passage, 0.05 m map | 5/5 → 5/5 | 145 → 168 | 126.23 → 194.92 | 13 → 11 |
| Medium passage | 5/5 → 5/5 | 50 → 24 | 13.07 → 7.23 | 13 → 11 |
| Sealed passage | 0/5 → 0/5 | 24 → 45 | 11.69 → 30.70 | 0 → 0 |

The formerly failing turn uses a 0.45 × 0.22 m rectangle in a 0.40 m L-shaped passage, with start x = 1.025 m on a 0.10 m map. The original planner exhausted its frontier; refinement finds and validates a route. The narrow 0.05 m fixture incurs approximately 69 ms of extra planning time, and an impossible sealed passage incurs approximately 19 ms. Easy-route node counts remain unchanged. The clutter route has three additional final states because its selected manoeuvre changes; compatible straight actions are still merged.

Eight new regressions cover 2 m and 18 m open routes, the previously failing turn, a narrow 0.05 m-map passage, medium clearance, occupied and unknown barriers, and threshold derivation. Short-step ablations fail the constrained passage/turn, while the real refined planner succeeds. Successful constrained plans pass independent footprint/sweep validation. Existing long-move collision fallback, all-heading body-axis, calibration, optimisation and full-size performance regressions also pass.

Validation completed:

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm test -- --maxWorkers=1` — 36 files, 336 tests passed.

Files changed by this task:

- `src/domain/planning/MotionStatePlanner.ts` — local primitive selection, tight-state identity and diagnostics.
- `src/domain/planning/MotionStateRefinement.ts` — derived search policy.
- `src/tests/motionStateRefinement.test.ts` — eight regressions.
- `src/tests/fixtures/adaptiveRefinement.ts` — reproducible open/passage/turn fixtures.
- `src/tools/benchmarkAdaptiveRefinement.ts` — repeated benchmark; run `npx tsx src/tools/benchmarkAdaptiveRefinement.ts` for current results. An optional first argument names a saved baseline planner module exporting `MotionStatePlanner`.
- `ADAPTIVE_REFINEMENT_REPORT.md` and `ADAPTIVE_REFINEMENT_REPORT.json` — explanation and measurements.

Footprint checking, swept translations and rotations, hard clearance enforcement, effective margins, unknown-cell blocking, final MotionPlan validation, planner cost weights and calibration defaults are unchanged by this task. No safety checker, cost/calibration implementation, configuration schema or optimiser file was modified by this task. Temporary baseline/probe modules used for the comparison were removed.
