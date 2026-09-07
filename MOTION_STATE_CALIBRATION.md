# Motion-state calibration (Stage 5A)

These fixtures and profiles are deterministic engineering aids. They do not
establish production-ready physical tuning. Production defaults remain selected
unless a caller explicitly applies a calibration profile.

## Dimensional model

| Term | Normalized unit | Accumulation |
|---|---|---|
| translation | cost/m | translation distance |
| rotation | cost/rad | absolute non-terminal rotation |
| reverse | cost/m | reverse translation distance |
| direction switch | cost/event | each FORWARD/REVERSE change |
| wall clearance | cost/m | distance integral of clearance deficit |
| narrow passage | cost/m | distance integral of passage penalty |
| turn location | cost*m/rad | angle divided by local clearance |
| terminal orientation | cost/rad | requested final-orientation rotation only |

Before Stage 5A, reverse, wall-clearance and narrow-passage costs were charged
once per translation action. A route split into twice as many states could cost
about twice as much without changing its physical geometry. Those three terms
are now integrated by translation distance in search and are recomputed from the
accepted optimized geometry. Legacy-planner cost methods were not changed.

## Candidate profiles

| value | BALANCED | FORWARD_PREFERRED | CLEARANCE_PREFERRED |
|---|---:|---:|---:|
| translationCostPerM | 1 | 1 | 1 |
| rotationCostPerRad | 0.25 | 0.25 | 0.25 |
| reverseCostPerM | 0.5 | 3 | 1.5 |
| directionSwitchCost | 1.2 | 1 | 1.5 |
| wallClearanceCostPerM | 3 | 3 | 8 |
| preferredClearanceM | 0.35 | 0.35 | 0.8 |
| hardMinimumClearanceM | 0.1 | 0.1 | 0.1 |
| narrowPassageCostPerM | 1.5 | 1.5 | 1.5 |
| turnLocationCost | 1 | 1 | 1 |
| terminalOrientationCostPerRad | 0.15 | 0.15 | 0.15 |

`BALANCED` permits a genuinely short reverse while its per-event switch cost
discourages oscillation. `FORWARD_PREFERRED` prices sustained reverse more
strongly. `CLEARANCE_PREFERRED` will accept longer routes for sustained open
clearance and can expand more states. These profiles are explicitly applied
through `applyMotionPlannerCalibrationProfile`; none changes application defaults.

## Benchmarks and sweeps

`createMotionPlannerCalibrationBenchmarks()` creates scenarios A-J. Use
`runMotionPlannerCalibrationBenchmarks()` and
`formatMotionPlannerCalibrationReport()` for profile tables. Use
`createMotionPlannerCalibrationSweeps()` to vary reverse, rotation, clearance,
preferred clearance, direction switching, or terminal orientation independently.
All runs call `replayMotionPlannerScenario()`, which uses the production planner
dispatcher and `MotionStatePlanner`.

The synthetic results show thresholds, not physical truth. In the controlled
immediately-behind fixture at rotation cost 0.25 and switch cost 1.0, reverse is
selected at reverse cost 1.0 cost/m and forward rotation is selected at 1.5
cost/m. In the controlled near-wall fixture with preferred clearance 0.6 m, the
route changes from 3.00 m / 0.30 m minimum clearance to about 3.34 m / 0.50 m
minimum clearance between wall weights 2 and 4 cost/m. In the direction-switch
fixture, sufficiently large per-event costs remove a two-switch alternative.

Terminal-orientation sweeps keep the route geometry stable in the final-theta
fixture. Once a normal lattice rotation is cheaper than the terminal connector,
the selected cost saturates at that alternative; this is expected competition
between two existing ways to meet the same final orientation, not a hidden
whole-route weight.

## Real-world scenario artifacts

The UI action **Export calibration scenario (includes grid)** deliberately writes
a JSON artifact containing the full occupancy grid, footprint, poses and immutable
configuration. Normal Operational Log diagnostics still contain no grid data.
Use `parseMotionPlannerScenarioArtifact()` and
`replayMotionPlannerScenarioArtifact()` offline, then apply or compare any number
of configurations against the same captured geometry. Map revision and footprint
hashes are verified before replay.
