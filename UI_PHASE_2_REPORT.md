# Sprint 2 — Mission Planner layout and named waypoints

**Review state.** Sprint 1, its audit and its evidence are preserved in local commit `436f2f5` on `feature/ui-improvements`. Sprint 2 is an uncommitted change set in `mission-planner-ui`. The previous phase had 448 passing sequential tests. Live ctrlX CORE validation is pending.

## Operator workflow and design decisions

| Area | Change and rationale |
| --- | --- |
| Workspace | The map keeps its own grid column. The expanded navigation rail is 184 px, the collapsed rail is 56 px and mission control is 328 px on desktop. The mission panel scrolls independently. Grouped controls and a closed-by-default layer list give the map more vertical space at 720p. |
| System status | The Med Robots header keeps the robot connection, emergency stop, faults and certified-safety notice in view. The connection button opens MQTT, Locator, robot, map and operating-mode details. Stale or absent telemetry retains the Sprint 1 unavailable state. |
| Navigation | Operations groups Planner, Map, Waypoints, Order and Robot State. Engineering groups MQTT, Global Replanning, Logs, Diagnostics and Settings. Labels have distinct icons, the rail collapses to labelled buttons with tooltips, and the active view has a red edge. Map setup holds local imports and advanced click modes. |
| Map | Planning mode, Create Waypoint, Recalculate and Clear path share one toolbar. Grid, inflation, waypoint markers and diagnostic layers share a keyboard-operable disclosure. Coordinates, rotation, zoom and Fit share the footer. The editing-tool group is the insertion point for Map Cleaner. |
| Mission control | The route revision status, destination, distance, time estimate and submitted mission status precede execution controls. Order identifiers, recording, corridor dimensions and telemetry details are expandable. Corridor warnings, validation errors and the direct-dispatch cancellation warning stay outside the disclosure. |
| Visual system | Neutral surfaces and dividers replace tinted gradients and glass effects. Red marks Med Robots branding, active navigation and critical states. Controls share MUI typography, component sizes, radii and focus styling. Status text accompanies color. Existing compact mode, increased map contrast and reduced motion continue to apply. |

## Named waypoints

1. Choose **Create Waypoint**, then click a free map cell. A rejected position leaves placement active for another selection. Escape or Cancel ends placement. Give the point a name and optionally a description, category and heading in radians. The dialog displays its world coordinates.
2. Open **Waypoints** from Operations or **Manage waypoints** from Quick Destinations. Search by name or reverse the alphabetical order. Select a name to center the map at its current zoom. Edit changes the record, Reposition picks a new cell, and Delete requires confirmation. Map layers controls marker visibility.
3. **Use as destination** and a Quick Destinations shortcut share one handler. With a matching active map and fresh pose, selection prepares and validates a preview. With missing prerequisites it records a draft goal and explains what is missing. A saved waypoint selection never starts the Direct Dispatch countdown. Start Mission still uses the existing validation, dispatch and confirmation gates. The ordinary map-goal workflow retains its existing Direct Dispatch policy.

Both views read the existing `med-robots-destinations` store and persistence key. Legacy quick destinations retain explicit heading semantics. New records may omit orientation. Names are trimmed and compared case-insensitively within the planning map ID. Position checks reuse the existing world-to-grid and destination validation against the loaded grid and its inflated occupancy. Checks run during placement, editing and destination selection. A map reload cancels pending placement. Selecting a location by name only changes the map view.

Waypoint identity is scoped to a map ID in the local application profile. A shorthand JSON import without an ID uses its filename. When distributing maps, use distinct stable IDs or filenames and retain the same world-coordinate frame across revisions. Saved locations are local to that browser or Electron profile. They are not synchronized between operator stations.

## Desktop evidence

Fresh headless Edge profiles loaded the same bundled PGM through the real file input. Both phases used the expanded rail, open mission panel and collapsed diagnostics. Screenshots use CSS-pixel viewports at a device scale factor of one. The capture blocked WebSockets, external HTTP and service routes before loading the app. An existing process on port 8787 was left alone. There was no robot traffic or simulated robot state.

| Desktop | Sprint 1 canvas | Sprint 2 canvas | Screenshots |
| --- | --- | --- | --- |
| 1280 × 720 | 696 × 314 | 768 × 445 | [Before](artifacts/ui-phase-2/before-1280x720.jpg) · [After](artifacts/ui-phase-2/after-1280x720.jpg) |
| 1920 × 1080 | 1336 × 784 | 1408 × 805 | [Before](artifacts/ui-phase-2/before-1920x1080.jpg) · [After](artifacts/ui-phase-2/after-1920x1080.jpg) |
| 2560 × 1440 | 1976 × 1170 | 2048 × 1165 | [Before](artifacts/ui-phase-2/before-2560x1440.jpg) · [After](artifacts/ui-phase-2/after-2560x1440.jpg) |

The capture also created **Ward reception** from a map click, saved it, opened its management panel and selected its name to center the map. [Waypoint panel](artifacts/ui-phase-2/waypoint-management.jpg) · [Centered waypoint](artifacts/ui-phase-2/waypoint-centered.jpg)

## Modified files and integration

| Files | Responsibility and integration notes |
| --- | --- |
| [App.tsx](src/App.tsx) | Shell, statuses, navigation, mission panel and waypoint workflow. Map Cleaner should use the labelled map editing toolbar group. Reconcile click ownership in the existing cell handler so a single click cannot both edit occupancy and place a waypoint. |
| [MapCanvas.tsx](src/components/MapCanvas.tsx) | Adds an optional center request, draws map-scoped text markers, groups layers and viewport controls. Marker rendering uses the existing world/pixel transform. Agent 1 may also touch raster drawing and input handling here. Keep named markers above the map and preserve pan/zoom hit testing. |
| [Theme](src/app/theme.ts) and [styles](src/app/styles.css) | Shared color, spacing, surface and control treatments, rail selection, map/footer and disclosure presentation. New editor controls can reuse these styles. |
| [QuickDestinations.tsx](src/features/destinations/QuickDestinations.tsx) and [destinationStore.ts](src/features/destinations/destinationStore.ts) | Shared persisted records, name validation, category and heading compatibility, alphabetical shortcuts and management entry point. |
| [WaypointsPanel.tsx](src/features/destinations/WaypointsPanel.tsx) and [waypointPosition.ts](src/features/destinations/waypointPosition.ts) | Management and editor dialogs, current-map position checks, focus versus mission selection. When Map Cleaner lands, its editable grid and matching inflation must feed the same validation boundary. |
| [missionPlannerUi.test.tsx](src/tests/missionPlannerUi.test.tsx) | Waypoint and authorization regressions, rotated map centering, marker visibility and updated Sprint 1 interactions with expandable sections. |

## Validation and remaining live work

TypeScript and ESLint passed. The complete sequential suite passed all **453 tests in 53 files** in 65.72 seconds, including all 448 Sprint 1 tests and five new waypoint regressions. The new tests cover persisted legacy-compatible records, duplicate names, current position validation, management actions, centered hit testing after rotation and zoom, marker filtering, and the explicit execution boundary with Direct Dispatch enabled. The three desktop checks found no horizontal document overflow or intersection between the mission panel and the map toolbar or footer.

The offline evidence covers viewport geometry, a local raster import and waypoint management. Subsequent controlled ctrlX CORE validation should check the station's Locator map ID and frame against saved positions, physical pose alignment and orientation, the live MQTT/Locator/fault status display, and actual Navigator acknowledgement and lifecycle after separately authorized execution. Test the packaged Electron profile across a real application restart and validate waypoint positions again after integrating Agent 1's editable planning map. No physical commands were sent, no merge was performed and no planning, navigation or safety algorithms were changed.

