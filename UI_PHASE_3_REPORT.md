# Sprint 3 — Mission creation, execution and history

**Review state.** Local commit `d299fbc` checkpoints the reviewed Sprint 2 implementation, screenshots and report on `feature/ui-improvements` in `mission-planner-ui`. Sprint 3 remains uncommitted. The Sprint 2 baseline was 453 passing tests. No robot commands were sent.

## Operator workflow

| Stage | Behavior |
| --- | --- |
| Create and edit | Open **Missions** in Operations. Give the mission a name and optional description. Add a saved waypoint or choose **Add from map** and click a free cell. Repeated visits are separate list entries. Move entries up or down or remove them. A map click inside the editor cannot start the quick Direct Dispatch workflow. **Quick mission** returns to the existing single-goal controls. |
| Manage templates | **Save template** persists the ordered list in the local profile. **Library** shows templates for the loaded map, supports search, load/edit, duplication, renaming through the name field and confirmed deletion. A duplicate receives a new template ID. Loading a template requires a new preview. |
| Validate | Validate the remaining stops in sequence. A deleted, disabled, cross-map, occupied or unreachable stop blocks authorization and identifies the affected stop or leg. A moved waypoint resolves to its current coordinates and produces a warning. The blue route and numbered endpoints correspond to the ordered list. Distance and time at configured maximum speed cover the remaining route. The time estimate excludes stops, acceleration and operator handoffs. |
| Authorize | **Authorize destination** opens the existing Send Mission confirmation with mission name, destination number, speed, topic and operational warning. The planner inputs, live robot state, target and gates are checked again. One confirmation permits one destination order. Validation alone sends nothing. |
| Monitor | History opens after a new handoff. The editor and History show the submitted mission, active target, completed and remaining destinations, current order progress, robot and replanning status, and available execution errors. After matching completion telemetry, **Prepare next destination** opens the remaining itinerary. A fresh preview and another explicit authorization are required. |
| Cancel or reconcile | The supported cancel action uses the existing confirmation and MQTT contract. A request is distinguished from a matching finished or failed action. Conflicting Navigator order identity blocks a named cancellation. Disconnect, stale telemetry, an uncorrelated replacement or application restart leaves an unresolved run for review. Ending local tracking explicitly records the operator decision and sends no command. |

## Architecture and data

- A template stores a stable UUID, map ID, name, description and ordered stops. Every stop has its own ID. Saved-waypoint stops also retain the waypoint UUID and a position, optional heading and display-label snapshot. Map picks retain their world coordinates. Validation looks up the current waypoint by UUID and checks the planning grid and its inflation. A renamed waypoint remains resolvable.
- Templates and run history use one Zustand persistence key, `med-robots-missions-v1`. Draft input, pending checks and executable previews are session state. History snapshots preserve names and stop coordinates independently of subsequent template edits or deletions. A storage-write failure keeps the live data in memory and displays the persistence limitation.
- Preview calls the existing planning coordinator in the selected mode. Manual mode uses the existing footprint collision validator. Each leg is built with the VDA builder and checked with the VDA validator, including the node limit. The first leg uses the live pose. Later legs use **projected arrival poses** for preview. Their actual start conditions must be validated again at handoff.
- Each preview has an attempt token and captured dependencies. Edits, a superseding request, waypoint-store changes, grid or inflation changes, planner/vehicle/order settings, the effective map, or a changed start pose invalidate it. A connection or safety-state transition also expires its authorization. Dynamic dispatch blockers are checked before and after confirmation. Position equality is conservative, so changing localization estimates can require another preview while the robot is stationary.
- The existing hybrid planner can pass through intermediate anchors. The VDA builder emits nodes with empty action lists, and the current monitor tracks a single submitted order. Passing through an anchor does not establish a stop or timed dwell. Structured missions therefore use independently validated orders, one per destination. Only the authorized leg enters the existing operational route store and normal publish path. Each subsequent leg starts from fresh robot telemetry. No scheduler publishes follow-on orders.
- A run records its ID, template snapshot, submitted order ID, active index, completed stop count, status, progress, errors and available timestamps. History distinguishes **first MQTT handoff**, **first observed driving**, **observed completion**, and **local end of tracking**. Duration is elapsed time since the first handoff when both timestamps exist. An unconfirmed first handoff has no invented start time. A cancel request stores its action ID and operator-request reason. Completion is correlated to the submitted order or cancel action. Quick orders submitted through the normal publisher are also recorded. Older sessions have no historical backfill.

## Browser evidence

Headless Edge ran against the loopback frontend. An isolated test profile blocked WebSockets, external requests and service routes before navigation. The browser harness supplied a local occupancy grid and fixture telemetry and intercepted the publication in memory. The captures show test data. The editor, planner, order builder, validator and confirmation UI ran in the browser.

| Workflow | Evidence |
| --- | --- |
| Two map-picked destinations saved in the mission library | [Mission library](artifacts/ui-phase-3/01-library.jpg) |
| Ordered route, numbered stops, estimated distance and duration | [1920 × 1080](artifacts/ui-phase-3/02-preview.jpg) · [1280 × 720](artifacts/ui-phase-3/preview-1280x720.jpg) · [2560 × 1440](artifacts/ui-phase-3/preview-2560x1440.jpg) |
| Explicit authorization of the first destination | [Confirmation](artifacts/ui-phase-3/03-authorization.jpg) |
| Recorded handoff awaiting Navigator acceptance | [History](artifacts/ui-phase-3/04-handoff.jpg) |

At all three desktop viewports the measured map ended at or before the mission panel and the document had no horizontal overflow. The harness observed exactly one intercepted order for the two-stop template.

## Files and integration boundaries

| Files | Responsibility |
| --- | --- |
| [MissionsPanel.tsx](src/features/mission/MissionsPanel.tsx) | Editor, library, history, validation and execution controls. |
| [missionLibrary.ts](src/features/mission/missionLibrary.ts) | Template and run models, persistence, waypoint resolution and evidence-based run transitions. |
| [missionPreview.ts](src/features/mission/missionPreview.ts) | Segment-by-segment planning, order construction, validation, warnings and route totals. |
| [useMissionWorkspace.ts](src/features/mission/useMissionWorkspace.ts) | Editor state, preview invalidation, validation race protection and continuation eligibility. |
| [App.tsx](src/App.tsx) | Operations navigation, map-pick routing, existing authorization/publisher integration, observation and cancel correlation. |
| [MapCanvas.tsx](src/components/MapCanvas.tsx) and [styles.css](src/app/styles.css) | Presentation of the validated route, numbered endpoints, mode label and mission panel layout. |
| [missionPlannerUi.test.tsx](src/tests/missionPlannerUi.test.tsx) and [missionLibrary.test.ts](src/tests/missionLibrary.test.ts) | UI, mocked execution, validation, persistence and history regressions. |

Agent 1’s likely integration points are map click ownership, grid replacement, and canvas overlay ordering. A pick belongs to exactly one tool. An editable planning grid and its matching inflation must replace the preview dependencies together. The existing world-coordinate transform draws the mission overlay. No navigation, collision, replanning or robot communication implementation was modified.

## Regression results

| Check | Result |
| --- | --- |
| TypeScript and ESLint | Both passed. |
| Complete sequential suite | **466/466 passed** across 54 files. This includes the complete 453-test Sprint 2 baseline and 13 new regressions. |
| Complete parallel suite | **464/466 passed** across 54 files. All 32 application UI tests and all five mission-library tests passed. |
| Isolated planner rerun with one worker | **35/35 passed** across the two planner files that failed in parallel. |

The parallel failures were [global replanning](src/tests/globalReplanning.test.ts#L301), which took **273.3 ms** against a **200 ms** limit, and the [SendBox guide test](src/tests/motionStateSendBoxPerformance.test.ts#L35), which returned **budget-exhausted** where it expected **found**. The first assertion also failed in the Sprint 1 parallel run. The second is a different assertion from the SendBox clutter case in the original audit. Both passed in the full sequential run and the isolated rerun. No planner implementations, deadlines or test expectations were changed.

The new regressions exercise editing, sorting destination order, saved-waypoint IDs, duplicate/delete/search, persistence, geometry failures on a later leg, moved/deleted waypoints during confirmation, explicit two-leg handoff and completion, cancellation evidence, target changes during cancel confirmation, disconnection, rejection, acceptance timeout, restart and storage failure. UI tests mock MQTT publication and startup connections.

## Unsupported behavior and pending live validation

- Timed waits, automatic multi-stop continuation and explicit pause/resume are unavailable. The current ROKIT adapter supports `cancelOrder` and `factsheetRequest`. A received paused state can still be displayed. Adding node actions or a different continuation policy requires confirmed controller support and operational approval.
- An uncorrelated replacement order ends reliable tracking of the original order ID. The operator can inspect the live replanning diagnostics and reconcile the run. The application does not infer that a replacement reached a named destination.
- History lives in the local profile. It contains only evidence observed while the application was tracking an order. It has no facility-wide synchronization or retrospective Navigator event feed.
- Live ctrlX CORE validation remains pending for map and pose alignment, localization stability during confirmation, MQTT acceptance and rejection, final-node completion, cancel acknowledgement, replacement-order correlation, and disconnect/reconnect behavior. Verify real route timing, packaged Electron persistence and Map Cleaner integration before clinical operation.

