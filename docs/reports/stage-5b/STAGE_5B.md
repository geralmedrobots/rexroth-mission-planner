# Stage 5B dataset workflow

In the application, run a motion-state plan, then select **Export last motion-state
run (success or failure, includes map)** in the planner export controls. The timestamp
and outcome identify the exported attempt. Capture occurs at the coordinator's
request/result boundary, before later telemetry or selections can change its start
pose or map. The artifact retains the complete result (diagnostics and metrics),
configuration, map, exact poses and waypoint selection. Motion-state mode does not
use hybrid waypoints; `waypointsUsed: false` records this explicitly. Legacy/hybrid
waypoint routes are not silently reinterpreted as motion-state evidence.

For a folder containing only actual exported real-run artifacts, run:

```text
npm run stage5b -- --real-exports real-scenarios docs/reports/phase-5/PHASE_5_REAL_REPORT
```

This creates a dataset manifest plus Markdown/JSON comparison reports. Review the
generated manifest's qualitative expectations and scenario labels, then rerun it
with a new report prefix. `--real-exports` is the operator's provenance assertion;
do not use it on generated fixtures. Schema, grid integrity and effective settings
are validated on capture, download and import. Export errors are reported without
turning an otherwise successful planner result into a planning failure.

No exported real-run scenario artifacts were present in this workspace during
implementation. The checked-in empty manifest is intentional: synthetic tests
must not be presented as physical deployment evidence. Profile selection is
pending; keep the existing production configuration until real evidence exists.

Export the motion-planner scenario JSON from the application's existing debug
export control, including unsuccessful tight/complex routes. Save exports in a
local folder under this workspace. Do not put real maps into TypeScript or commit
them as fixtures. Keep the original artifacts unchanged.

Create a dataset manifest (paths are relative to the manifest):

```json
{
  "schemaVersion": "motion-planner-dataset-v1",
  "name": "Site acceptance set",
  "scenarios": [{
    "id": "ward-return-01",
    "artifact": "exports/ward-return-01.json",
    "provenance": "real-run",
    "notes": "Return approach; prefer the wider aisle. Operator-reviewed expectations.",
    "expectations": {
      "reverse": "not-preferred",
      "maximumReverseM": 1,
      "maximumDirectionSwitches": 2,
      "maximumRotationDeg": 270,
      "maximumRotationActions": 4,
      "minimumClearanceM": 0.35,
      "preferOpenRoute": true,
      "maximumPathLengthM": 20,
      "maximumPlanningMs": 2000,
      "maximumExpandedStates": 20000,
      "avoidSuspiciousManoeuvres": true,
      "shortMoveM": 0.2
    }
  }]
}
```

These numbers are examples, not acceptance limits. Set expectations before
comparison with operator knowledge. Terminal orientation is always checked when
the artifact requests it. `preferOpenRoute` compares successful alternatives'
average center clearance; inspect the route geometry to confirm aisle selection.
An optional `failureAudit` object accepts `category` and nonempty `evidence` for
guide, lattice, primitive, physical-infeasibility or other supported diagnoses.
Never label search exhaustion physically infeasible without geometric evidence.

Run from the workspace root:

```text
npm run stage5b -- examples/stage5b.dataset.json docs/reports/stage-5b/STAGE_5B_REPORT
```

The CLI generates JSON evidence and a Markdown report at a new prefix. Existing
reports are not overwritten. Malformed/unreadable scenarios become failure rows
for all four profiles; the dataset continues. Manifest schema errors stop early.
Run serially without other CPU-heavy work. Repeat in fresh processes with new
report prefixes to assess timing variability. Artifact inputs are replayed through
the current production implementation, so replay across code versions is not a
promise of identical plans. Record the source revision alongside report files.

Profiles: CAPTURED_DEFAULT is the exact exported configuration (which may itself
be custom), plus BALANCED, FORWARD_PREFERRED and CLEARANCE_PREFERRED. Only soft
profile settings vary. Stage 5B restores the captured hard minimum after applying
the existing profile helper, which otherwise substitutes 0.1 m. Footprint,
margins, permissions, collision samples and search budget remain captured.

The quality score starts at 100 for independently validated successes and zero
for failures. JSON lists every bounded deduction. Path/reverse/switch/rotation,
desired clearance, suspicious manoeuvres and time/state budgets use explicit
expectations; missing numeric limits incur no penalty. Costs and average
clearance are reported, with average clearance contributing only when open-route
preference is enabled. This makes the score an operator preference aid, not a
physical safety certificate or a globally optimal route proof. Recommendation
uses only real-run rows, success rate first and mean score second; exact ties
favor the captured configuration. Synthetic tests cannot authorize profile adoption.

Known limitation: the operator reports remaining tight/complex route failures.
No corresponding artifacts were available to classify them beyond unknown.
They remain in the report for later performance work and do not block this stage's
offline infrastructure. No planner redesign or production default change is made.
