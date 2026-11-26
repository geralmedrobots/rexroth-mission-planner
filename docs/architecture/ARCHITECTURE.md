# Architecture

## Med Robots operator architecture

The UI is organized as an operator shell rather than a test screen:

```text
AppShell
  +-- fixed Med Robots status and safety bars
  +-- collapsible operator navigation
  +-- MapCanvas (one-click destination + layered route display)
  +-- Mission Control + Quick Destinations
  +-- collapsible sanitized diagnostics drawer
  +-- Settings and advanced integration controls
```

`StartupConnectionManager` is a cancellable sequential state machine. Its
React integration composes the existing MQTT service, Locator session/map
services and stores; it does not duplicate transport logic. Locator automatic
credentials remain in the loopback Node process environment. Renderer calls
can request automatic login but never receive the password or Bosch session
identifier.

`destinationValidation`, `dispatchGate`, `VdaOrderBuilder`, and
`VdaOrderValidator` keep safety-relevant decisions outside React rendering.
The default click workflow is preview-first. Direct Dispatch is a separate,
persisted operator option with a cancelable countdown and a fresh gate check
immediately before publication.

### Bosch ROKIT corridor compatibility layer

`EdgeCorridorPlanner` calculates lateral free space from the occupancy grid
and configured footprint. `VdaOrderBuilder` attaches the optional result
without changing the base message version (`2.0.0`) or creating trajectories.
`VdaOrderValidator.validateBase` validates the normal VDA 5050 2.0 message,
while `BoschRokitCorridorValidator` independently validates the VDA 5050 2.1
corridor definition required by the Bosch compatibility target. The combined
validator blocks malformed extension values but treats safely omitted
corridors as warnings.

## Runtime topology

```text
React/Vite UI ── Web Worker ── A* + simplification + collision validation
     │
     ├── browser MQTT/WebSocket ─────────────────────── MQTT broker
     │
     ├── local WebSocket ── Node TCP/TLS MQTT bridge ─ MQTT broker
     │
     └── local HTTP proxy ── typed JSON-RPC/TLS ─────── ROKIT Locator Server

Electron main process ── packaged React UI + local bridge
```

The renderer never receives Node privileges. Electron uses context isolation and a narrow preload API. Browser mode connects directly only when the broker exposes MQTT over WebSocket. TCP/TLS MQTT is handled by the local Node service on loopback port 8787.

## Module responsibilities

- `domain/geometry`: angle helpers and invertible world/grid transforms, including rotated origins and image Y inversion.
- `domain/planner`: circular inflation, rectangular footprint checks, proximity transform, A*, simplification, spacing, and collision revalidation.
- `workers`: runs planning outside the UI thread.
- `domain/vda5050`: VDA 5050 2.0 Order/instant-action creation, topic generation, and publish validation.
- `domain/robot`: live state/visualization pose selection plus current-error deduplication and bounded history helpers.
- `schemas`: defensive Zod parsing of untrusted MQTT messages.
- `services`: MQTT transports and structured log stream.
- `stores`: Zustand application/mission state with password-free local persistence.
- `server`: TCP/TLS MQTT bridge for browser development and Electron.
- `electron`: isolated desktop host and optional OS-backed secret protection API.
- `components` and `features`: map canvas, status panels, controls, import workflow, and diagnostics.
- `features/locator/api`: typed local-proxy calls and exact official ServerMap/session method adapters.
- `features/locator/schemas`: Zod boundaries for Bosch JSON responses and binary Containers.
- `features/locator/services`: session lifecycle, PNG/PointCloud2D decoding, MAP/image transforms, occupancy conversion, and object-URL lifecycle.
- `features/locator/stores`: password-free Locator connection, module, map-selection, and download state.
- `server/locatorRpcClient`: monotonically identified Bosch JSON-RPC transport and per-connection TLS policy.
- `server/locatorProxy`: loopback-only session holder and strict allowlist of official map methods.

## Planning pipeline

```text
occupancy image
  → threshold/unknown-cell classification
  → footprint inflation
  → start/goal validity and bounded correction
  → 8-connected A* with corner prevention and wall-proximity cost
  → line-of-sight reduction
  → Douglas–Peucker
  → minimum/maximum segment spacing
  → orientation assignment
  → rectangular footprint collision sampling
  → exact live robot pose inserted as VDA Node 0
  → near-duplicate planner start cells removed
  → VDA nodes/edges
  → semantic + map + live-state validation
  → explicit operator publish
```

For Locator maps, the pipeline begins with `sessionLogin → serverMapList → serverMapGetInfo → serverMapGetImageWithResolution`. `agvPosition.mapId` is matched exactly. The PNG remains visible as the map canvas background while its grayscale occupancy classification feeds inflation and planning.

The renderer has no direct network path to Locator JSON-RPC. The local Node service holds the session and performs HTTP(S), so TLS CA configuration and session refresh remain outside domain/planner code. The local `/locator/*` paths are application proxy routes, not Bosch REST endpoints; the proxy sends only the official JSON-RPC method names and `params.query` objects.

Unknown occupancy values are treated as occupied. A smoothed/simplified result is accepted only after collision validation; otherwise the raw collision-free path is retained.

Raw A* cells, line-of-sight/Douglas–Peucker geometry, and maximum-segment-length VDA points remain separate data products and statistics. The VDA builder does not accept an implicit path start: callers must provide a finite live robot pose and active Navigator mapId.

## Safety boundary

This software is an FMS integration and path-planning tool, not a certified safety component. It never writes motor or PLC commands. MQTT connection alone never triggers planning or publication. Stale state disables Order publication, and every Order or instant action requires an operator gesture and confirmation.
## Corridor compatibility diagnostics

`features/corridorCompatibility` is an isolated developer diagnostic:

- `CorridorCompatibilityService` creates controlled Orders and captures the
  exact serialized payload.
- `corridorCompatibilityStore` correlates state/errors by `orderId` and retains
  bounded structured evidence.
- `BypassDetector` compares Navigator-provided visualization positions with the
  locked global Order path and requires persistent deviation plus rejoin.
- `CorridorCompatibilityPanel` presents controlled dispatch, payload and result
  evidence.

It reuses `MqttService` without changing MQTT topics or transport and does not
modify `EdgeCorridorPlanner`, route simplification or node generation.

## Automatic global replanning

The replanning feature is isolated in `features/replanning`:

```text
useGlobalReplanning
 ├─ BlockedRouteDetector
 ├─ TemporaryObstacleMap
 │   └─ ObstacleInflation
 ├─ GlobalReplanner
 │   ├─ PlannerService -> planner.worker.ts -> AStarPlanner
 │   ├─ PathSimplifier / PathCollisionValidator
 │   └─ VdaOrderBuilder
 ├─ VdaOrderValidator
 └─ MQTT transition
     ├─ InstantActionBuilder(cancelOrder)
     ├─ wait for old Order inactive
     ├─ publish new Order
     └─ wait for state.orderId acceptance
```

`globalReplanningStore` persists configuration but keeps temporary maps, runtime
paths, Orders and logs in memory. `MapCanvas` reads only the four visualization
layers needed for replanning, avoiding redraws caused by the 250 ms detector
status updates.

The original Locator grid is treated as immutable. `TemporaryObstacleMap`
returns separate raw-overlay and inflated grids. A* runs in the existing Web
Worker; route optimization and exact-goal reattachment are collision checked
before the VDA Order is built. `ObstacleIngestion` consumes retained RAW MQTT
payloads, normalizes object, pair and flat-array points, converts robot-local
coordinates to MAP, clusters them, and emits source diagnostics. Temporary
geometry uses Laser1, Laser2 and Environment Model observations. When none are
available, an explicitly labelled and configurable test fallback may create a
rectangle ahead of the robot; it is never presented as measured sensor data.

`StartPoseProjector` searches `0.2`, `0.4`, `0.6`, then `1.0 m` for the closest
free cell in the goal-connected component. This cell is used only as A* input.
It is removed from the VDA route, whose Node 0 remains the exact robot pose.
Projection diagnostics and A* explored cells remain in the runtime store for
the map and diagnostics panel. `GlobalReplanner` rejects candidates whose
maximum lateral change is below the configured minimum, so retries cannot
publish the same blocked geometry under a new ID.
