# Native Stage 5B mission recording

## Operator workflow

Run the app and local bridge from this repository (`npm run dev`). Every
motion-state planning request automatically starts a recording before the planner
worker runs. The Mission control panel shows recording/save status and the count
of pending recordings. No planner, Navigator, map, safety or cost settings change.

The existing `motion-planner-scenario-v1` object is used directly. An optional
`recording` metadata section extends that object; there is no second replay schema.
Old scenario artifacts continue to load without recording metadata.

Successful planning leaves recording active until execution ends. Generated orders
are associated by route revision, then publication and outcomes by order ID.
Planner failure/exception, publication failure, Navigator rejection/acceptance
timeout, and observed completion finalize automatically. A matched `cancelOrder`
action with status `FINISHED` finalizes cancellation; publishing a cancel request
alone is not treated as proof of cancellation. No motion commands are added.
Unpublished previews are finalized as cancelled when superseded or cleared.
Changing the selection does not cancel the recording of an already published order.

In advanced mission data, use **Finalize success**, **Finalize failed**, or
**Finalize cancelled** to record the outcome of the current route when automatic
observation is unavailable. These buttons only finalize evidence; they do not
cancel or otherwise control the robot. **Retry save** retries retained finalized
artifacts after bridge/storage failure. Do not close/reload the app while recordings
are pending: pending data is in memory, not a crash-recovery journal.

The server strictly validates the finalized artifact, including grid dimensions
and grid/footprint integrity hashes, then writes to
`artifacts/stage5b/missions/` relative to its working directory:

```text
Mission_<start timestamp with colons/dots replaced by hyphens>_<recording UUID>.json
```

Start the bridge from this repository to keep that directory project-local.
The client cannot choose a filesystem path. Writes use exclusive creation; retries
of identical evidence acknowledge the same file. Different contents for an existing
recording ID are rejected. The existing bridge JSON size limit is 50 MB; oversized
artifacts produce a visible save error and remain in memory. Files are never
silently replaced or reduced to log fragments.

Persistence uses a unique temporary file in the mission directory. The server
reads and validates that serialized file before atomically renaming it to its final
`.json` name. Failed writes remove the temporary file, so the collector sees only
complete final JSON files.

## Replay inputs and captured evidence

The parser in `MotionPlannerScenarioArtifact.ts` requires:

- `schemaVersion`, `mapRevision`, `footprintGeometryHash`, `selectedProfile`.
- Complete `grid.metadata`: width, height, resolution, origin x/y/yaw, mapId, name,
  occupied/free thresholds and negate convention; all `grid.data` cells, including
  unknown cells. Dimensions and revision hash must agree.
- `footprint`, including length/width/safety margin and the complete source geometry
  object with offsets, permissions and other collision inputs. Hash must agree.
- Exact `startPose` and `goalPose` x/y/theta. `goalTheta` is omitted unless explicitly
  requested; the mere presence of `goalPose.theta` does not constrain arrival.
- Full `configuration.planner`, `.footprint`, `.order`, and `.normalized` snapshot.
  Effective motion-state configuration is recomputed and checked for consistency.

`PlanningCoordinator` already snapshots those authoritative inputs for its worker.
Its new observer snapshots the same data once into `Stage5BRecorder`. This includes
XY/theta tolerances, all weights, reverse/rotation permissions, footprint and reference
offsets, hard clearance, safety/localization margins, unknown handling, heading bins,
primitive/refinement parameters, corridor settings and search budgets. Constants
implemented in planner code still require the same app revision to reproduce.
The current planner initializes direction internally as FORWARD; replay uses that
same behavior. The recorder does not infer physical gear or introduce a new seed.

The live UI has no separate active named calibration-profile identity. Live captures
use `CUSTOM` and preserve the complete actual configuration, avoiding a false
baseline label. Provenance includes the package version and optional
`VITE_APP_GIT_COMMIT` supplied at build time; absent commit information is omitted.
Mission ID, independent recording UUID, start/end timestamps and map ID are retained.

`capture.result` preserves the complete PlannerResult: MotionPlan states/actions,
cost components, calibration metrics, rotations, direction changes, forward/reverse
distances, clearance metrics, duration, expanded/visited states and available
diagnostics. `originalCalibration` is retained when produced. Existing JSON behavior
omits undefined fields and encodes non-finite diagnostic numbers such as infinite
open-space clearance as null; replay computes fresh metrics from the full inputs.
Replay inputs themselves must pass the existing finite-number/integrity checks.

`recording.orders` preserves the generated/published VDA objects without rebuilding
them: nodes, edges, body headings, reverse edge orientation, trajectories if present,
corridors, speed limits, order IDs and generation/publication timestamps. No PLC
commands or unseen Navigator behavior are invented. This is planner replay evidence,
not a simulation of physical execution.

`recording.outcome` is success/failed/cancelled, independently of planner success.
`recording.execution` keeps that physical outcome separate from
`capture.result.success` and retains the order ID, last reached node, Navigator
errors, final observed pose, publication/completion times and execution duration
whenever those values are observable. The root reason, final pose and completion
time remain for compatibility. The
collector also expresses outcomes in supported manifest `notes` and failed missions
in `failureAudit` with category `unknown`, without inventing a failure cause.

## Collect and replay

```text
npm run stage5b:collect -- artifacts/stage5b/missions examples/stage5b.dataset.json
npm run stage5b -- examples/stage5b.dataset.json PROFILE_SELECTION_TEST_REPORT
```

Collection validates every artifact before replacing the manifest, requires explicit
recorder provenance, sorts filenames, writes relative paths and backs up an existing
manifest to `<manifest>.<UUID>.backup`. It does not import raw log arrays. Keep real
and synthetic provenance distinct; synthetic rows never support a real-run profile
recommendation. The replay CLI still requires a new report prefix or prior reports
moved aside, because its outputs use exclusive creation.

For `CAPTURED_DEFAULT`, the Stage 5B report compares the recorded MotionPlan
fingerprint and planner success with the replay result. A mismatch is reported as a
baseline reproduction failure before profile comparison is trusted.

For a local example generated through the recorder itself:

```text
npx tsx src/tools/stage5BExample.ts
```

The example is explicitly synthetic, based on an existing benchmark, and records no
robot execution. It is not a reconstruction of any of the seven Desktop missions.
Those logs remain untouched under `examples/mission-logs/`. Their former manifest
and artifact-load-failure reports were preserved as backups before collecting the
new example and rerunning the requested report.

## Boundaries

Automatic capture covers the app's motion-state PlanningCoordinator path. Legacy,
manual, hybrid waypoint plans and unrelated imported/compatibility orders are not
silently relabelled as motion-state scenarios. Inputs rejected before a valid
planning request is prepared cannot be replayed. Each planning request is one
artifact; retries/replans have distinct recording UUIDs even if the mission ID repeats.
Unobserved hardware failures require explicit operator finalization. Final pose is
the latest available observed pose, not an assertion of localization accuracy.

Capturing a grid adds one bounded snapshot per request, not copies on every telemetry
update. Output recording and disk I/O are observers; their failures do not alter
planner results, validation, order publication or robot safety. Planning timing
depends on hardware, so captured time budgets do not imply bit-for-bit repeatability
of wall-clock durations or timeout outcomes.

## Files

Implementation: `src/domain/planning/Stage5BRecorder.ts`,
`src/services/Stage5BRecordingService.ts`, `server/stage5BRecording.ts`,
`src/tools/stage5BCollect.ts`, `src/tools/stage5BExample.ts`.
Integration: `src/domain/planning/MotionPlannerScenarioArtifact.ts`,
`src/features/planning/PlanningCoordinator.ts`, `src/stores/appStore.ts`,
`src/App.tsx`, `server/index.ts`, `package.json`.
Tests: `src/tests/stage5BRecorder.test.ts`,
`src/tests/stage5BRecordingService.test.ts`, `server/stage5BRecording.test.ts`.
Evidence: `examples/stage5b.dataset.json`, its backup, synthetic artifact(s),
`PROFILE_SELECTION_TEST_REPORT.json` and `.md`, and their `.log-import.backup` files.

## Validation result (2026-09-14)

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- --maxWorkers=1`: 44 test files, 387 tests passed.
- Requested Stage 5B command: exit 0, twelve successful actual planner replays
  (three synthetic recorder artifacts times four profiles), zero artifact-load
  failures and zero replay exceptions. All three captured-default MotionPlan
  fingerprints matched their recorded plans.
- Profile recommendation remains pending because no real-run artifact was evaluated.

Current-recorder example:
`artifacts/stage5b/missions/Synthetic_2026-09-14T09-59-58-783Z_d72fb90c-c834-4cfa-b743-b3264cc783b1.json`.
The earlier synthetic smoke artifacts are also retained and collected. None is
labelled as physical robot evidence. Real recording persistence/mission association,
save retry, idempotency, cancellation, failed outcomes and reverse VDA preservation
are covered by tests; a live robot/bridge recording has not been exercised here.
