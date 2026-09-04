# Med Robots Navigation Control

**PharmaRobot Autonomous Navigation** is Med Robots' operator dashboard for
ROKIT Navigator missions. It retains the existing MQTT, Locator JSON-RPC,
occupancy-map, footprint-aware planner, VDA 5050, mission monitoring, and
diagnostic capabilities while presenting them as a focused industrial HMI.

The official logo is loaded from `src/assets/logo_medrobots.png`. Replace
that file with the approved SVG or PNG when the brand asset changes;
`MedRobotsLogo` deliberately falls back to a labelled placeholder rather than
inventing a permanent replacement mark.

Production-oriented React/TypeScript desktop and browser application that downloads the real server-side map from ROKIT Locator, converts it to an occupancy map, plans a collision-free global route outside ROKIT Navigator, converts the route to a VDA 5050 2.0.0 Order, validates it against map and live robot state, and publishes it over MQTT only after explicit confirmation.

> **This application is not a safety function. Vehicle safety must be provided by certified safety hardware and the machine safety system.**

## Features

- React, Vite, Material UI, Zustand, Zod, mqtt.js, strict TypeScript.
- Electron desktop packaging plus browser development mode.
- Local Node MQTT TCP/TLS-to-WebSocket bridge.
- Official ROKIT Locator JSON-RPC session, map discovery, metadata, PNG, thumbnail, sized-image, and point-cloud bindings.
- Real Locator PNG rendering/occupancy conversion plus ROS YAML + PGM/PNG, generic image, and occupancy JSON fallback imports.
- Correct resolution/origin/yaw transforms and image Y inversion.
- Authoritative `ClientMotion.vehicle.footprint` polygon import with a clearly
  labelled 0.83 m x 0.60 m application fallback.
- Worker-based 8-connected A*, no diagonal corner cutting, wall-proximity cost, turn cost, timeout, bounded invalid-pose correction.
- Line-of-sight and Douglas–Peucker simplification, waypoint spacing, orientation generation, and post-process collision validation.
- Automatic, manual, and hybrid anchor planning.
- VDA 5050 2.0 nodes/edges, alternating sequence IDs, unique identifiers, validation, explicit publication, instant actions, and mission progress.
- Raw MQTT/state/order views, structured logs, diagnostics export, stale-state and safety warnings.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries and the planning data flow.

## Docker

For a clean Docker deployment, see [INSTRUCOES_DOCKER.md](INSTRUCOES_DOCKER.md).
On Windows, after extracting the project, `executar-docker.bat` builds the
container and opens the complete application at `http://localhost:8787`.

## Windows development setup

Open PowerShell:

```powershell
cd C:\Users\Avarynx\WebstormProjects\Bosch\rokit-automatic-path-planner
npm install
npm run dev
```

Open `http://localhost:5173`. The Node bridge runs on `127.0.0.1:8787`.

Quality commands:

```powershell
npm run test
npm run lint
npm run build
npm run format
```

Electron:

```powershell
npm run electron:dev
npm run electron:build
```

The packaged Windows installer is written under `release\`.

## MQTT configuration

Defaults:

```text
Broker:        192.168.1.111:1883
Transport:     TCP through local bridge
Order:         uagv/v2/bosch/0001/order
Instant:       uagv/v2/bosch/0001/instantActions
State:         uagv/v2/bosch/0001/state
Visualization: uagv/v2/bosch/0001/visualization
Connection:    uagv/v2/bosch/0001/connection
QoS:           1
```

Open Settings to change every topic, identity, TLS/certificate validation, credentials, keep-alive, timeouts, and QoS. The state stale timeout is separate from the command timeout, defaults to 10 seconds, and is constrained to 2–60 seconds. Browser direct mode requires an MQTT WebSocket listener; a browser cannot open raw TCP sockets. TCP mode sends commands to the loopback Node bridge, which uses mqtt.js. Passwords are removed from Zustand/localStorage persistence and settings exports.

MQTT connectivity does not prove the VDA topic identity is correct. Interface, topic version, manufacturer, serial number, and the ROKIT configuration must match exactly.

## Map import

### ROKIT Locator Server 2.0

Start the complete application with `npm run dev` (not Vite alone), then click **Map → Locator Server**:

1. Enter the Locator host and confirm the RPC port and endpoint from the installed Locator configuration. The endpoint is deliberately editable. `/` and port `8080` match Bosch's official ROS bridge example, but they are not assumed to match every installation.
2. Select HTTP or HTTPS. For a private CA, select the PEM/CRT file. Do not enable insecure development mode in production.
3. Click **Test Connection**. This calls only `aboutBuildVersion` and `aboutModulesList`; downloads remain disabled unless `ServerMap` is reported.
4. Enter the Locator account and click **Login**. The password is sent once to the loopback proxy for `sessionLogin`, cleared from the form after success, never logged, and never persisted.
5. Click **List Maps** for manual selection. When MQTT has supplied `agvPosition.mapId`, the application performs `serverMapList`, requires an exact name match, and automatically loads it.
6. **Load Active Map** uses only an MQTT-derived or last-known MQTT mapId. **Load Selected** loads the operator’s selected Locator map.
7. If Navigator supplies no mapId, select and load the same Locator map, click **Use Selected Map as Navigator Map ID**, and confirm the exact map name and robot identity in the dialog. Loading a map alone never creates a binding.
7. The application calls `serverMapGetInfo`, then `serverMapGetImageWithResolution`. It validates the Bosch response code, `Container`, MIME type, RFC 4648 base64, PNG signature, IHDR dimensions, and the 20,000-pixel limit before creating a Blob URL and occupancy grid.

The returned `MAPimageOrigin` (`x`, `y`, `a`) is authoritative. It is the lower-left image origin in MAP coordinates; browser image Y increases downward, so transforms invert Y and rotate by `a`. The application never assumes origin `[0,0,0]`.

The grayscale thresholds in Locator settings control raster occupancy. Black
is occupied by default and unknown pixels are blocked during planning. Vehicle
size is checked with the complete configured polygon; the grid overlay expands
obstacles only by the additional planning and localization margins.

Optional code bindings are included for:

- `serverMapGetImage`, with 1–20,000 pixel maximum dimensions and server-preserved aspect ratio.
- `serverMapGetMapThumbnail`, only for list previews and never as a planning map.
- `serverMapGetMap`, decoding `application/PointCloud2D` as little-endian float32 `(x,y)` pairs. `PointCluster` reflector ranges are closed/inclusive. The API has no documented maximum-non-reflector query parameter, so optional thinning is client-side and preserves every reflector point.

Example connection values are in [locator-settings.example.json](examples/locator-settings.example.json). Credentials and CA contents are intentionally absent.

### ROS occupancy map

1. Select **Import YAML** and choose the map YAML.
2. Select **Import image/PGM** and choose the referenced PGM or PNG.
3. The importer applies `resolution`, `origin`, `negate`, `occupied_thresh`, and `free_thresh`.

### Generic image

Import PNG/JPG/PGM without YAML. The initial metadata uses 0.05 m/pixel, origin `(0,0,0)`, and the filename as map ID. Adjust metadata in a project file before robot use; never guess the ROKIT map frame.

### JSON grid

Import either `{metadata,data}` or `{width,height,resolution,origin,cellData}`. Occupancy values use `0` free, `100` occupied, and `-1` unknown. Unknown cells are treated as occupied.

Use click modes **Draw obstacle** and **Erase** for cell editing. Export the project/grid before closing if the edits must be retained.

The bundled [sample-map.yaml](examples/sample-map.yaml) and [sample-map.pgm](examples/sample-map.pgm) are for offline testing only.

## Operating workflow

1. Configure the broker and click Connect.
2. Confirm fresh state, connection `ONLINE`, operating mode, pose initialization, map ID, E-stop and field-violation state.
3. Open the Locator panel and load the exact server map matching `agvPosition.mapId` (or use a trusted file import fallback).
4. The latest state or visualization pose becomes the default start.
5. Select Goal mode and click a free map position. Enter final theta in radians.
6. Select Automatic, Manual, or Hybrid. Hybrid click anchors are mandatory waypoints.
7. Calculate the route and inspect raw path, final waypoints, inflated cells, and footprint.
8. Generate and validate the Order. All red validation issues must be resolved.
9. Click Publish and read the safety/topic/order confirmation.
10. Monitor acceptance, node/edge states, progress, driving status, errors, and stale-state indicators.

Default speed is **0.05 m/s**, not 0.9 m/s.

## Planner behavior

A connected-free-space analysis runs before A*. It distinguishes unknown-only
connections, disconnected rooms, too-narrow passages, and point routes that do
not fit the full footprint. A* supports diagonals but rejects a diagonal when
either adjacent cardinal cell is occupied. A multi-source obstacle-distance
transform adds a cost near walls, so routes favor corridor centers.

Reliable mode creates and retains a footprint-validated baseline. The raw route
is reduced by line of sight and Douglas-Peucker, then densified to a maximum
0.60 m spacing (preferred 0.40 m, minimum 0.20 m). Balanced and Advanced modes
try clearance, doorway, turn-relocation, and smoothing enhancements against a
clone of the last valid route. A rejected enhancement is discarded without
destroying the baseline.

Theta is calculated toward the next waypoint. The last theta comes from the goal when enforcement is enabled. All angles are radians and normalized to `[-π, π]`.

## VDA 5050 Order structure

Node sequence 0 is always constructed from the latest valid robot pose received locally from state or visualization. Its x, y, and normalized theta are copied exactly; it is never the A* start-cell center and never uses the first segment direction. Initial planner points within the configurable 0.03 m duplicate threshold are removed. The first useful planner point becomes Node sequence 2 and Edge sequence 1 connects the real-pose node to it.

Remaining route points become released nodes with sequence IDs `2, 4, 6…`. Each adjacent pair gets a released edge with IDs `1, 3, 5…`. Intermediate theta values point toward the following node; final theta uses the explicitly selected goal orientation or the final segment direction.

Order validation covers identity/version, timestamps, IDs and graph relationships, finite coordinates, theta, map match, bounds, speed ceiling, actions arrays, footprint collisions, MQTT/live-state availability, and stale state. The first-node check additionally compares Node 0 with the live pose using both VDA deviations and practical internal defaults of 0.05 m / 5 degrees.

Generation and publication require MQTT connected, ROKIT `ONLINE`, `AUTOMATIC` mode, fresh locally received state, initialized finite position, a non-empty resolved Navigator mapId, and an exactly matching Locator map. State and visualization receive ages are tracked separately using local `Date.now()` receive times; the remote VDA timestamps are retained only for diagnostics. A fresh non-empty state mapId has priority, then a fresh visualization mapId, then the identity-bound last known MQTT mapId, then an explicitly confirmed Locator binding. Empty or whitespace map IDs never erase the last valid Navigator map ID.

Confirmed map bindings are persisted without credentials and scoped to manufacturer and serial number. Their source is displayed as `manual-confirmed`; they are never presented as Bosch MQTT data. Changing robot identity or Locator selection, clearing the binding, or receiving a different valid MQTT mapId invalidates the binding. Orders generated from a binding contain a visible validation warning.

The implementation is based on the official VDA 5050 2.0.0 Order model. The historical 2.0 repository contains an instant-actions schema naming inconsistency (`actionName` in the tagged schema while the published common action model uses `actionType`). This application isolates VDA 2.0 instant actions in a version-specific builder and uses the published `actions[].actionType` representation. Confirm the installed ROKIT release/factsheet before enabling optional actions.

## Instant actions

The UI offers supported `cancelOrder`. State request is disabled because that action is not confirmed for the current ROKIT configuration. Pause/resume controls are disabled because the tested ROKIT configuration rejected the generated `stopPause` blocking type. `InstantActionBuilder` refuses `stateRequest`, `startPause`, and `stopPause`, so they cannot be published accidentally. `factsheetRequest` remains implemented but should only be used after confirming support.

## ROKIT errors and mission acceptance

The latest state message replaces the current error set. Errors are deduplicated by type, level, description, and sorted references, so repeated MQTT state messages do not inflate the current error badge. A separate timestamped history is bounded to 500 entries and can be cleared; history never participates in new-order validation.

After publication, the mission moves through Publishing and Awaiting acceptance. Acceptance occurs only when `state.orderId` equals the sent order ID. Referenced Navigator errors produce Rejected with the exact descriptions, and the default 5-second acceptance timeout prevents indefinite waiting.

## Safety limitations

- This is not a safety system or motion controller.
- It does not bypass ROKIT, PLC, drive, braking, E-stop, or safety-field logic.
- It downloads maps only from the explicitly configured ROKIT Locator Server through documented JSON-RPC methods; it does not assume Navigator provides a map-download API.
- MQTT connection never commands motion.
- `MissionMaximumSpeedMps` is the single application speed setting. Every
  normal, replacement, compatibility, and recovery Order edge must equal it.
  The imported ClientMotion forward limit is validated separately and is not
  modified by the application.
- Stale state disables new Order publication.
- No automatic cancel is sent on stale state.
- Verify real MotionFeedback, odometry, velocity, drive enable, command timeout, safety PLC, braking, and emergency stop before movement testing.

## Examples

- [settings.example.json](examples/settings.example.json)
- [sample-state.json](examples/sample-state.json)
- [example-order.json](examples/example-order.json)
- [sample-map.yaml](examples/sample-map.yaml)

## Troubleshooting

**Browser cannot connect to port 1883:** use TCP bridge mode with `npm run dev`, or configure an MQTT WebSocket listener and select WebSocket.

**MQTT connected but no state:** check effective state topic, ACLs, topic version, manufacturer, serial number, and broker used by ROKIT.

**Map mismatch:** imported map ID must exactly match active `agvPosition.mapId`. Rename/configure from authoritative ROKIT project data.

**Locator RPC test fails:** verify host, RPC port, endpoint, HTTP/HTTPS choice, firewall, and the installed Locator configuration. A TLS validation error should be solved by selecting the correct private CA, not by globally disabling TLS checks.

**ServerMap unavailable:** `aboutModulesList` did not report `ServerMap`. Confirm the request reached the Locator Server component and that the installed module/version supports the map API.

**Login/session error:** check credentials and permissions. Sessions are requested for 600 seconds and refreshed through documented `sessionRefresh` before long-running map operations.

**Map not found:** Navigator `agvPosition.mapId` must exactly equal a name returned by `serverMapList`, including case. Choose manually only after confirming the coordinate frame.

**PNG rejected:** inspect `responseCode`, image resolution, 20,000-pixel limit, empty/corrupt `Container`, media type, and proxy size limits.

**Start invalid:** confirm localization and matching coordinate frame. Small inflation-edge errors can be corrected; large errors are rejected.

**No path:** inspect original and inflated obstacles, robot dimensions, safety margin, map unknown cells, start/goal, and corridor width.

**Order rejected:** inspect ROKIT errors and raw state. Check version, map, current pose deviation, unsupported parameters/actions, active order, operating mode, and safety state.

**State stale:** restore state-topic feedback and inspect the local receive time, state age, and configured stale threshold in Diagnostics. Device clock differences do not determine freshness. The application intentionally disables Publish when no locally received state arrived inside the configured window.

**Empty active mapId:** inspect the separate state and visualization map IDs, last-known MQTT map, confirmed Locator binding, and resolved source in Diagnostics. If MQTT genuinely supplies no mapId, load the selected Locator map and explicitly confirm the binding. Empty visualization map IDs do not erase valid MQTT-derived IDs.

**Electron build fails:** install current Windows build tools, use an active Node LTS release, remove an incomplete `node_modules`, rerun `npm install`, then `npm run electron:build`.

## Test coverage

Vitest includes exact live-pose Node 0 regression coverage, duplicate start removal, first-edge relationships, angular wraparound, local receive-time freshness, state/visualization map priority, empty-map preservation, robot-identity rejection, map mismatch error ordering, error deduplication/history, unsupported pause/state-request prevention, acceptance/rejection/timeout, practical 302-cell simplification, Locator transforms and Containers, obstacle planning, VDA validation, MQTT publication mocking, and complete map-to-plan-to-order integration tests.

## Official Locator API contract used

The implementation sends Bosch JSON-RPC 2.0 requests as:

```json
{"jsonrpc":"2.0","method":"serverMapList","params":{"query":{"sessionId":"…"}},"id":1}
```

and reads `result.response`. Request IDs increase monotonically in the Node transport. The following names and fields are taken from Bosch's API contract and the official Bosch [`locator_ros_bridge` v2.0 branch](https://github.com/boschglobal/locator_ros_bridge/tree/humble-v2.0):

| Method | Implemented query fields |
|---|---|
| `aboutBuildVersion` | empty query |
| `aboutModulesList` | empty query |
| `sessionLogin` | `userName`, `password`, `timeout {valid,time,resolution}` |
| `sessionRefresh`, `sessionLogout` | `sessionId` |
| `serverMapList` | `sessionId` |
| `serverMapGetInfo` | `sessionId`, `serverMapName` |
| `serverMapGetImageWithResolution` | `sessionId`, `serverMapName`, `resolution` |
| `serverMapGetImage` | `sessionId`, `serverMapName`, `width`, `height`, `level` |
| `serverMapGetMap` | `sessionId`, `serverMapName` |
| `serverMapGetMapThumbnail` | `sessionId`, `serverMapName`, `mapLevel` |

`serverMapGetImageWithResolution` intentionally sends no `level`: Bosch's v2.0 bridge request schema contains only `sessionId`, `serverMapName`, and `resolution`. If an installed 2.0.8 build exposes a different module schema, treat the installed Bosch documentation and `aboutModulesList` output as authoritative and update the typed adapter—do not add speculative fields.

The binary `Container` contract is exactly `contentEncoding: "base64"`, `contentMediaType`, and `content`. Image responses use `MAPimageOrigin {x,y,a}`, metric `width`/`height`, and an `image/png` Container. Point clouds use `application/PointCloud2D`.

## Med Robots automatic startup and credentials

Create the local environment configuration before starting automatic Locator
login:

```powershell
Copy-Item .env.example .env
notepad .env
npm run dev
```

The loopback backend reads Locator credentials from `.env`. The React
renderer, localStorage, exported settings, and diagnostics never receive or
retain the password. Keep `.env` out of source control and use OS-managed
deployment secrets for production installations.

When enabled in Settings, startup runs one coordinated sequence:
configuration, MQTT connection/subscriptions, Locator connectivity,
server-side `sessionLogin`, `serverMapList`, active-map resolution and load,
then fresh localized robot state. Optional failures enter **Degraded** mode
without freezing the HMI. Retries use bounded exponential backoff and do not
create parallel startup connections.

Automatic Locator login uses the existing secure local proxy and only the
official Bosch JSON-RPC methods already implemented by this project. A failed
automatic login exposes the masked manual fallback in Advanced settings.
**Forget saved credentials** invalidates automatic login for the running
process; remove the deployment secret to forget it permanently.

## One-click operator workflow

1. Wait for **Ready** and verify that no critical top-bar status is red.
2. Click one free map destination or choose a map-matched Quick Destination.
3. The application validates the cell, calculates/simplifies the route,
   generates Node 0 from the exact fresh robot pose, and validates the order.
4. Review the cyan route and press **Start Mission**.
5. Monitor Navigator acceptance, driving and arrival in Mission Control.

Direct Dispatch Mode is off by default. When explicitly enabled, a valid
route starts a cancelable countdown. A reconnect, stale state, map mismatch,
localization loss, emergency stop, invalid order, or conflicting active order
blocks dispatch. Reconnecting never resumes an unconfirmed dispatch.

Quick Destinations are local and scoped by exact `mapId`; destinations from a
different map are not offered. Diagnostics retain existing MQTT, Locator,
order, validation and error data. Copy/export passes through credential and
session-ID sanitization. Animation honours both the Reduce Motion preference
and `prefers-reduced-motion`.

## Bosch ROKIT obstacle-bypass corridors

The published protocol header remains VDA 5050 `2.0.0`, and MQTT topics remain
under `uagv/v2`. When **Enable Bosch ROKIT corridor extension** is enabled,
each safe edge can additionally contain the corridor structure defined in
VDA 5050 2.1:

```json
{
  "corridor": {
    "leftWidth": 0.455,
    "rightWidth": 0.275,
    "corridorRefPoint": "KINEMATICCENTER"
  }
}
```

This is deliberately isolated as a Bosch ROKIT compatibility extension; it
does not claim VDA 5050 3.0 support and does not generate a synthetic
trajectory. Disabling the feature produces the original VDA 5050 2.0 Order.

For each edge, the corridor planner samples the full segment and ray-casts
left and right against the original occupancy grid. It uses the most
restrictive clearance, subtracts half the configured robot width, obstacle
safety margin and localization margin, then clamps the result to the
configured maximum. Unknown cells are blocked by default. Unsafe, invalid,
zero-length or too-narrow edges omit the corridor and record the reason in
the Generated Order/Raw JSON diagnostics tabs.

The map **Bypass corridors** layer shows the permitted lateral region. This
region is an authorization boundary for Navigator planning, not proof that a
bypass is possible. Safety fields, vehicle protection zones, localization,
motion feedback and available physical space remain authoritative.

Recommended controlled-area commissioning:

1. Keep speed at `0.05 m/s`, verify e-stop, safety PLC, braking and command
   timeout, and use an open test area.
2. Load the correct Locator map and confirm fresh `ONLINE`/`AUTOMATIC` state.
3. In Settings, verify robot width, margins, sample spacing, maximum width and
   `KINEMATICCENTER`.
4. Select a goal whose preview shows a corridor on the intended edge.
5. Inspect Generated Order and confirm `version: "2.0.0"` plus the expected
   `corridor` values.
6. Start without an obstacle and confirm normal acceptance/travel.
7. Repeat from a safe reset position with a lightweight physical box inside
   the sensed path but with verified free space inside the displayed
   corridor. Keep personnel outside the operating area.
8. Confirm the box appears in the Environment Model and observe whether
   Navigator stops or generates a local bypass. Be ready to use the physical
   e-stop. Never widen a corridor beyond surveyed free space to force bypass.
## ROKIT Corridor Compatibility Test

The developer tool **ROKIT Corridor Compatibility Test** isolates corridor
compatibility from route geometry. It locks the generated route and can publish
five operator-confirmed variants:

- baseline without `corridor`;
- current calculated corridor;
- fixed `0.2 / 0.2 m`;
- fixed `1.0 / 1.0 m`;
- asymmetric `0.1 / 1.0 m`.

Every variant remains a VDA 5050 `2.0.0` Order, receives a new `orderId` and
`headerId`, and retains the same nodes, edges, speeds and route geometry.
Nothing is published automatically.

The panel records the exact JSON string passed to MQTT, its byte size, topic,
header/order IDs, corridor values and the independent results of base VDA 2.0
validation and Bosch corridor-extension validation. The MQTT transport does not
reconstruct this string.

Bypass detection is intentionally conservative. It uses locally received
Navigator `visualization.agvPosition` samples—not the locally rendered corridor—
and requires lateral deviation greater than the configured threshold for several
messages, followed by several samples rejoining the original Order path. Motion
alone is not classified as a bypass. Any extra geometry arrays discovered in the
raw visualization object are listed by JSON path without assigning undocumented
Bosch semantics to them.

The absence of a corridor echo in state or visualization does not prove that the
Navigator discarded it: standard state messages do not normally echo the Order.
Likewise, an accepted Order alone does not prove the corridor was interpreted.
The result remains inconclusive until physical comparison provides persistent
deviation/rejoin evidence or the Navigator returns a correlated rejection.

### Physical comparison procedure

1. Localize the robot and verify MQTT `ONLINE`, `AUTOMATIC`, fresh state,
   initialized position, finite velocity feedback, no emergency stop and matching
   Locator/Navigator map IDs.
2. Generate and validate one route through an open test area.
3. Open **Advanced mission data → ROKIT Corridor Compatibility Test**.
4. Place one box at a repeatable marked position and do not move it between runs.
5. Run **Baseline** and confirm the internal application dialog.
6. Cancel/clear the completed or blocked Order and return the robot to the same
   start pose.
7. Repeat Current, Wide and Asymmetric variants using the locked route.
8. Compare acceptance, correlated errors, maximum deviation and bypass detection
   in the result table. Save the exact payload and structured evidence log.
9. Reset the route session only when intentionally selecting a new route.

The tool never claims that corridor information guarantees bypass. Certified
safety hardware, protection fields, localization, Motion Feedback and Navigator
configuration remain authoritative.

## Automatic global replanning

Automatic global replanning is an optional, explicitly enabled recovery workflow.
It is separate from ROKIT Navigator local obstacle avoidance. Local bypass is
always given time to continue; global replanning starts only after the complete
blocked-condition gate remains true for the configured timeout.

```text
Active VDA Order
      |
      v
BlockedRouteDetector -- robot/visualization still moving --> keep waiting
      |
      | stopped continuously and all safety gates valid
      v
TemporaryObstacleMap (immutable copy of Locator occupancy grid)
      |
      v
A* Planner Web Worker -> simplification -> collision validation
      |
      v
New VDA 5050 2.0 Order with new IDs and corridors
      |
      v
cancelOrder -> wait until old Order is inactive
      |
      v
publish replacement -> wait for matching state.orderId
```

The detector requires all of the following:

- `AUTOMATIC` operating mode;
- an active, incomplete Order;
- translational speed below `0.02 m/s`;
- more than `0.5 m` to the original final node;
- not paused;
- emergency stop `NONE`;
- fresh state and visualization;
- initialized finite localization;
- finite `vx`, `vy`, and `omega`;
- no correlated rejection of the active Order;
- no recent visualization movement indicating an ongoing bypass.

The default stopped timeout is five seconds. Enabling this feature requires one
explicit confirmation because subsequent blocked-route recovery can cancel and
replace an Order without another operator prompt.

### Temporary obstacle sources

The project does not contain an additional obstacle topic. No topic or Bosch
field is invented. Exact RAW state and visualization payloads are retained in
memory and shown in their diagnostics tabs. The ingestion adapter recognizes
point objects, nested point/position objects, `[x,y]` pairs, and flat XY arrays
under Laser1, Laser2, LiDAR/scan, or Environment Model branches. Explicit MAP
frames are preserved; robot/base/laser-local points are transformed with the
latest robot pose. Every cycle reports source topic, source JSON paths, frame
mode, raw/transformed/rejected points, clusters, occupied cells and inflation.

Detections are:

- discarded when stale or for another map;
- clustered and merged using the configured merge distance;
- discarded when smaller than `0.20 m`;
- rasterized only into an in-memory clone;
- inflated by the robot half-diagonal plus the configured safety distance.

The original Locator map is never modified. If these sources expose no usable
obstacle geometry, the optional testing fallback creates a rectangle at least
`1.0 m` in front of the current heading. It is explicitly marked
`BlockedRouteInference`; its configurable geometry is kept outside the current
robot footprint, and the robot footprint is subtracted from its raster layer
before inflation. Disable **Enable inferred obstacle test fallback** when only
measured obstacles may influence planning. A candidate with no measured or
inferred obstacle and no meaningful path change is rejected before VDA Order
generation.

Independently of the configurable route-change preference, a hard `0.01 m`
lateral-change floor prevents an unchanged route from receiving a new Order ID
or triggering `cancelOrder`. After a replacement is accepted, blocked detection
is suspended for 10 seconds by default so Navigator has time to activate the
new Order. The grace period is configurable in **Global Replanning**.

Before A*, an occupied start cell can be projected to the closest free cell
reachable from the goal. The staged search radii are `0.2`, `0.4`, `0.6`, and
`1.0 m`. Projection is enabled by default and affects only the internal A*
start: VDA Node 0 remains the exact live robot pose. Failure is reported as
`No reachable free start cell.` Diagnostics and the map show the original pose,
projected start, projection distance, result, and explored A* cells.

The final VDA route is independently collision checked from the exact live Node
0. A direct connection to the first useful waypoint is preferred. If it is not
safe but the short connection to the projected A* start is safe, that projected
cell is retained as a connector waypoint. Otherwise Order generation stops with
the failing segment index; a planner-only path is never published when its VDA
start connection intersects the map.

A replacement route must also differ laterally from the previous route by the
configured minimum (default `0.15 m`). An unchanged route is rejected before
`cancelOrder` or Order publication. Integrating another sensor provider still
requires a documented adapter to the internal `TemporaryObstacleObservation`
type.

### Configuration and operation

Open **Global Replanning** in the left navigation. Settings include:

- enable automatic replanning;
- blocked timeout;
- minimum obstacle size;
- inflation distance;
- unknown-cell policy;
- maximum planning time;
- maximum planning attempts;
- retry delay;
- maximum transition retries;
- minimum lateral route change;
- enable start pose projection.

The map displays the original path in grey, the blocked remainder in red,
temporary occupied cells in orange, and the replacement path in green. The
panel reports the reason, attempts, obstacle count, route lengths, planning time,
new Order ID, and structured logs.

Example log sequence:

```json
{"source":"BlockedRouteDetector","message":"Robot blocked.","blockedDurationMs":5000}
{"source":"TemporaryMap","message":"Temporary obstacles: 2 sensor, 0 inferred, 2 total."}
{"source":"GlobalPlanner","message":"Planning start projection succeeded at 0.283 m."}
{"source":"GlobalPlanner","message":"Alternative A* route calculated; maximum lateral change 0.420 m.","planningTimeMs":34.2}
{"source":"PathOptimizer","message":"Alternative path simplified and collision checked."}
{"source":"OrderGenerator","message":"New independent VDA Order generated.","orderUpdateId":0}
{"source":"OrderPublisher","message":"cancelOrder published before global replacement."}
{"source":"OrderPublisher","message":"Replacement Order accepted by Navigator."}
```

The replacement Order keeps `version: "2.0.0"`, the active `mapId`, the original
goal pose and speed, while receiving a new `orderId`, `headerId`, node IDs and
edge IDs. Corridor generation uses the same configured Bosch-compatible
extension as normal Orders.

If all planning attempts fail, no Order is published and the operator sees
**No alternative route found.** The robot remains stopped.

### Blocked-robot reverse recovery

Automatic reverse recovery is an optional, fail-safe stage before global
replanning. It is disabled by default and is configured in **Global Replanning
→ Blocked-robot recovery**.

The recovery state machine is:

`IDLE → BLOCKED_CONFIRMED → CHECK_TURN_SPACE → CHECK_REVERSE_SPACE →
BUILD_REVERSE_ORDER → SEND_REVERSE_ORDER → WAIT_REVERSE_ACCEPTANCE → REVERSING
→ REVERSE_COMPLETED → GLOBAL_REPLAN`

Any invalid safety, localization, rear-sensing, cancellation, driving-mode, or
motion-command condition moves the cycle to `FAILED`. The application never
writes motor commands. Reverse is requested only through an independent VDA
5050 2.0 Order: Node 0 is the live pose and yaw, Node 2 is behind the vehicle
with the same yaw, and the released edge has `rotationAllowed: false`, empty
actions, and a default maximum speed of `0.05 m/s`.

Before publishing, the active Order must be cancelled, the `cancelOrder` action
must reach `FINISHED`, and the old active order ID must be cleared. During
motion, recovery is confirmed only when raw Navigator diagnostics report
`requestDrivingMode = 0x02` and `motionCommand.v_x < 0`. Mode `0x04`, stale
Laser 2 data, a new rear obstacle, emergency stop, or loss of valid
localization/motion feedback causes cancellation and safe failure.

`requestDrivingMode`, `motionCommand.v_x`, and `motionCommand.yaw_rate` belong
to the ROKIT Motion Command interface. `availableDrivingModes` belongs to PLC
Motion Feedback. They are not VDA 5050 Order fields.

Recovery therefore uses a pluggable driving-mode telemetry provider:

- **ctrlX DataLayer** — preferred. Reads the four explicitly configured node
  paths through the loopback Node proxy.
- **MQTT raw payload** — optional fallback, only for installations that
  actually mirror the values into MQTT payloads.
- **Disabled** — safe unavailable provider.

The project does not provide default DataLayer node paths or assume a Bosch
REST route. Configure the installed host, port, authentication, endpoint
template containing `{path}`, and all four node paths in **Global Replanning →
Blocked-robot recovery**. Passwords and bearer tokens are held only in memory
and are removed from persisted settings.

If the selected provider cannot supply fresh confirmation, recovery is stopped
with: **Backward driving mode confirmation is unavailable from the configured
telemetry provider.** No VDA schema, MQTT topic, PLC variable, or motor command
is modified.
