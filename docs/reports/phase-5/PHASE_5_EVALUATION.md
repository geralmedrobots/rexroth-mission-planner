# Phase 5 evaluation status: OPEN

Real scenarios evaluated: **0**. No full real occupancy map/scenario artifacts were
available in the workspace. `src/tests/fixtures/sendBoxScale.ts` explicitly identifies
its maps as synthetic approximations. Runtime success/timing statements without
the captured map and request cannot be replayed as real cases.

All four comparison configurations are implemented: captured/default, BALANCED,
FORWARD_PREFERRED, CLEARANCE_PREFERRED. Real success rates, timing, path length/cost,
clearance, reverse distance, switch count, rotation count/angle and suspicious
manoeuvre counts are **N/A**, not zero. No profile recommendation is justified.
Retain production defaults. Generated numerical status is in PHASE_5_COMPARISON.md
and PHASE_5_COMPARISON.json.

The operator-reported failures in tighter/complex geometry remain known examples
without replayable evidence. Classification: **unknown**. Do not infer physical
infeasibility from timeout or finite-lattice search exhaustion. Later artifacts
can support timeout/search-performance or documented guide/lattice/primitive,
validation-rejection and physical-infeasibility classifications.

To close Phase 5, supply actual exports for at least these representative cases:

- One easy open route.
- One cluttered route.
- One wall-adjacent route.
- One route with several turns and an explicit terminal orientation.
- One reverse-related case if present in real operation; otherwise document its absence.
- At least one difficult/failed tight-geometry route, retaining its failure result.

Use the application export action after each run, put those JSON files inside the
workspace and use the folder command documented in [STAGE_5B.md](../stage-5b/STAGE_5B.md). Review qualitative
expectations with the operator before using scores to recommend a profile. Keep
failed routes in the dataset; they do not block infrastructure completion and do
not authorize a planner redesign. An offline recommendation remains provisional
until the physical robot checklist in the generated report is completed.

Correctness issue addressed: export previously combined a live telemetry start
pose with a past planner result. Export now retains the exact coordinator capture.
No planner algorithms, production defaults or safety/protocol semantics changed.
