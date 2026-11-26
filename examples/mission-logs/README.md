# Seven real mission logs

These are byte-for-byte copies from `C:\Users\Avarynx\Desktop\Miguel`.
The original files were not modified. SHA-256 hashes of each source and copy
were compared and matched at import.

The manifest is `examples/stage5b.dataset.json`. Its supported `artifact` paths
are relative to the manifest directory, for example `mission-logs/first_mission.txt`.
The manifest inventories log evidence; it is **not yet a replayable dataset**.

| Dataset ID | File | JSON log entries | Observed outcome |
| --- | --- | ---: | --- |
| Mission 001 | first_mission.txt | 1000 | Assumed successful per operator |
| Mission 002 | second_mission.txt | 1000 | Assumed successful per operator |
| Mission 003 | third_mission.txt | 1000 | Assumed successful per operator |
| Mission 004 | fourth_mission.txt | 1000 | Assumed successful per operator |
| Mission 005 | fifth_mission.txt | 1000 | Assumed successful per operator |
| Mission 006 | sixth_mission.txt | 1000 | FAILED, operator-confirmed |
| Mission 007 | seventh_mission.txt | 621 | Assumed successful per operator |

All seven referenced files exist and parse as JSON arrays. Their timestamp windows
are in the requested chronological order on 2026-09-10. No entry has level `error`;
that does not establish execution success. Six files contain exactly 1000 entries,
so completeness of those mission histories cannot be assumed. Mission 006 includes
planner diagnostics; planner completion does not establish successful execution.
No evidence established a different outcome for the other missions.

## Supported schema and missing replay data

`stage5BManifestSchema` in `src/domain/planning/MotionPlannerStage5B.ts` supports
`id`, `artifact`, `provenance`, `notes`, `expectations`, and optional `failureAudit`.
It has no dedicated observed success/failure field. Outcomes are therefore recorded
in `notes`. Mission 006 additionally uses `failureAudit.category: unknown` with
operator evidence, without attributing its failure to a planner defect.

The CLI resolves each artifact relative to the manifest, then calls
`parseMotionPlannerScenarioArtifact`. It requires a `motion-planner-scenario-v1`
object containing the complete occupancy grid, footprint, poses, configuration,
and matching validation hashes. It does not import application log arrays.
None of these seven files contains that full artifact or the required grid data.
Calibration/diagnostic fragments cannot replace the missing replay inputs.
No fields, maps, configurations, or outcomes were fabricated to pass validation.

To obtain a replayable dataset, use the application's **Export last motion-state
run (success or failure, includes map)** export for each corresponding mission,
as documented in [STAGE_5B.md](../../docs/reports/stage-5b/STAGE_5B.md), and reference those actual artifacts in the manifest.
Keep these original logs as supporting evidence. A later rerun is new evidence,
not an exact reconstruction of a missing historical export.

## Command result

Executed from the repository root:

```text
npm run stage5b -- examples/stage5b.dataset.json docs/reports/profile-selection/PROFILE_SELECTION_TEST_REPORT
```

Exit code: 0. Output: `Stage 5B: 28 runs; recommendation: pending`.
All 28 rows (seven missions times four existing profiles) are artifact-load
failures: `Invalid input: expected object, received array`. There were **zero
actual planner replays**. These are input failures, not seven failed missions.
Recommendation: `No successful real-run replay; no evidence for profile selection.`

Generated repository-root outputs:

- `PROFILE_SELECTION_TEST_REPORT.json`
- `PROFILE_SELECTION_TEST_REPORT.md`

The CLI catches artifact-load errors and still exits successfully, so the exit
code alone does not indicate a usable baseline. No schema/path-only correction
can recover the missing full scenario data. Profile selection and a replayed
static-weight baseline remain blocked on those exports.

Only the manifest, copied logs, this documentation, and generated reports were
changed/created for this task. Planner code, weights, safety, calibration, and
the contents of mission logs were not changed.
