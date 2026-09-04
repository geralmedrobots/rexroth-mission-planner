# Bosch ROKIT Navigator 2.1.2 planner compatibility

This application is an FMS/global planner, not a safety function or motor
controller. It preserves the configured MQTT topics, VDA version, ClientMotion
configuration, protection fields, monitoring cases, E-stop behavior, and
Motion Feedback checks.

## Geometry and collision model

Import the installed ClientMotion configuration in Settings. The documented
`ClientMotion.vehicle.footprint` VEHICLE-frame polygon is authoritative.
`BoschVehicleConfiguration` validates finite metre coordinates, closure,
nonzero area, unique vertices, and self-intersection. It also reads the
documented driving-mode permissions, general velocity limits, and available
wheel transforms from the supplied snapshot. No ctrlX DataLayer address is
assumed or invented.

If no Bosch configuration is supplied, the UI clearly reports an application
fallback rectangle of 0.83 m x 0.60 m. The fallback does not assert that its
geometric centre is the configured kinematic centre.

Collision checks transform the complete polygon at each sampled pose.
Planning and localization margins default to 0.05 m each and are applied once
to the polygon. The map is not also inflated by a full vehicle radius.
Unknown cells are blocked.

## Mission speed ownership

`orderSettings.missionMaximumSpeedMps` (`MissionMaximumSpeedMps` in the
operator documentation) is the application's single mission-speed setting.
The normal Order builder, replacement-route builder, and recovery Order
builder copy it to every VDA edge `maxSpeed`. Order validation rejects a
positive edge speed that differs from this setting, and separately rejects a
speed above an imported ClientMotion `maxForwardVelocity`.

This FMS does not produce the Bosch binary ClientMotionCommand or
ClientMotionFeedback interfaces. It therefore does not write
`allowedMaxLinearSpeed` and does not modify ClientMotion general constraints.
When those values are present in received telemetry, Speed Limit Analysis
compares mission speed, active-edge speed, allowed linear speed, commanded
linear speed, and measured VDA velocity. Missing non-VDA telemetry remains
explicitly unavailable; no undocumented field or MQTT topic is assumed.

## Planning pipeline

The mandatory sequence is:

```text
VALIDATE_MAP
VALIDATE_START
VALIDATE_GOAL
BUILD_FREE_SPACE_MODEL
PLAN_BASELINE_ROUTE
VALIDATE_BASELINE_FOOTPRINT
DENSIFY_BASELINE
GENERATE_BASELINE_ORIENTATIONS
VALIDATE_BASELINE_ORDER
TRY_CLEARANCE_OPTIMIZATION
TRY_DOOR_ALIGNMENT
TRY_TURN_RELOCATION
TRY_SMOOTHING
FINAL_VALIDATE
ORDER_READY
```

The free-space model computes point and full-footprint connectivity and a
clearance field. It reports unknown-only connectivity, disconnected rooms,
too-narrow passages, and point routes that fail for the configured vehicle.

Reliable mode retains a collision-free baseline. Balanced and Advanced modes
apply optional enhancements to a clone of the last valid path. Each candidate
is footprint-validated before selection; a rejected enhancement is displayed
and the valid baseline remains available.

Waypoint defaults are 0.40 m preferred, 0.60 m maximum, and 0.20 m minimum.
Door alignment defaults are 0.50 m before, 0.35 m after, 15 degrees maximum
approach angle, and 0.80 confidence. Heading limits default to 45 degrees per
node and 20 degrees near a confirmed door. Swept rotations are sampled every
5 degrees.

## Temporary obstacles and Order replacement

Only obstacle coordinates found in already available payload branches are
accepted. Observations retain their source JSON path for diagnostics, are
age-filtered, clustered, transformed to MAP before ingestion, and rasterized
into an in-memory clone. The Locator map is never modified. Temporary
obstacles receive only the configured extra margin; the full footprint is
validated separately.

Global replanning waits for the configured local-bypass interval and requires
fresh state, AUTOMATIC mode, valid localization/Motion Feedback, inactive
E-stop, a confirmed blocking observation, and a meaningful route difference.
No observation returns `WAITING_FOR_OBSTACLE_DATA`; an equivalent route returns
`NO_MEANINGFUL_ALTERNATIVE`.

Replacement uses:

```text
ALTERNATIVE_VALIDATED
CANCEL_SENT
WAITING_CANCEL_ACTION
WAITING_OLD_ORDER_CLEAR
REVALIDATING
PUBLISHING_REPLACEMENT
WAITING_NEW_ORDER_ACCEPTANCE
COMPLETED
```

The exact cancel action ID is correlated. A replacement is never published
while the old Order remains active.

## Operator live test

1. Import the installed ClientMotion configuration and verify that the map
   overlay matches the physical vehicle contour and VEHICLE-frame origin.
2. Load the exact Locator map whose mapId is reported by Navigator.
3. In Reliable mode, plan through an open doorway. Verify `RAW_PATH_FOUND`,
   `BASELINE_PATH_VALID`, footprint overlays, spacing, and `ORDER_READY`.
4. Repeat in Balanced mode. Verify pre-alignment, door-centre, exit points,
   headings, and swept-turn overlays. If enhancement is rejected, confirm the
   baseline remains selected and the precise skip reason is visible.
5. At low test speed with the real safety system active, execute the validated
   Order and record Navigator state and visualization.
6. Place a physical obstacle only under the approved test procedure. Allow
   Navigator local bypass first. If the corridor remains blocked, verify that
   transformed obstacle diagnostics are nonzero, a different global corridor
   is selected, cancellation finishes, the old orderId clears, and only then
   the new Order is accepted.
7. Remove or block the alternate corridor and confirm a precise refusal
   (`PASSAGE_TOO_NARROW`, `START_GOAL_DISCONNECTED`,
   `NO_SAFE_MANOEUVRE_SPACE`, or `NO_PHYSICALLY_VALID_ROUTE`) instead of an
   invented route.

The correct product statement is: the planner calculates a valid route to
every physically reachable free destination represented by the loaded map,
subject to configured geometry, kinematics, safety constraints, sensor
coverage, and connected free space.
