# Locator map diagnostic overlay

Open **Locator Map Status → Compare map layers** after downloading a Locator map.
This opens a separate viewer; it never writes to the map store or planner.

- Independently toggle the original PNG, every original point (green), occupied
  grid cells (translucent red), and occupied cells without point support (yellow outline).
- Scroll to zoom around the pointer; drag to pan; use Fit map to reset.
- Click a doorway cell to inspect MAP coordinates, image coordinates, occupancy
  and the number of original points in that cell.
- Yellow means no point falls inside that exact cell. It does not mean that the
  wall is incorrect: rasterization can legitimately cover neighboring cells.
  There is no proximity tolerance, filtering, interpolation or inflation.
- Points outside occupied cells, outside the image, or with nonfinite coordinates
  are counted separately. Nonfinite coordinates cannot be drawn but remain in the
  original snapshot. Points outside the image are retained and drawn at their
  continuous positions (pan/zoom to inspect them).

## Installed API compatibility

The running proxy was queried before implementation. It reported Locator Server
2.0.8 (component type 2), ServerMap 9.0. An authenticated `serverMapGetMap` call
confirmed fields `pointCloud`, `pointCloudSize`, `reflectors`, `zones`, and
`responseCode`. Its `application/PointCloud2D` base64 container decoded as
little-endian pairs of float32 coordinates, eight bytes per point.

Every diagnostic download repeats version discovery, permits ServerMap major 9,
validates the required response fields, media type, encoding and exact byte
length, and checks the map fingerprint before and after download against the
loaded PNG's map information. Unknown major versions and changed revisions fail
visibly. The original response/container is retained alongside all decoded
points. The diagnostic never supplies a downsampling limit.

## Coordinates and live findings

Points are mapped through the existing LocatorCoordinateTransformer: subtract
the Bosch image origin, undo origin yaw, divide by resolution, invert image Y.
PNG/occupancy cells are drawn in original image coordinates, without stretching
to the rounded physical extents. Point-to-cell membership uses the existing
CoordinateTransformer's half-open grid convention: `height - 1 - floor(localY /
resolution)`. Taking `floor(imageY)` instead disagrees on exact cell boundaries.
Cell centers and continuous point coordinates are deliberately distinct; no
half-cell offset is added to original points.

An independent, read-only live check is recorded in
`artifacts/map-diagnostics/live-report.json`. For that snapshot:

- 86,204 original points; all inside the image and occupied cells.
- 5,035 occupied cells; four have no original point in the exact cell.
- PNG 482 × 503 pixels, resolution 0.05 m/pixel, yaw zero.
- Bosch reports height 25.20000076 m, whereas 503 × 0.05 = 25.15 m:
  approximately one cell of extent discrepancy. Width agrees within float noise.
  This does not establish an origin or Y-flip error; the existing transform
  aligns all points in this snapshot. Do not stretch the PNG to compensate.
- Alpha is uniformly 255 for this PNG (no transparency ambiguity).

Earlier requests returned a different point count, so the values above describe
one snapshot only; they are not constants or a guarantee of future map geometry.
The viewer displays current counts and revision data on every download.

Browser visual verification was unavailable: computer use stopped because it
could not determine the current browser URL confidently. TypeScript and the
automated coordinate/API tests are reported separately in the implementation
summary. Map conversion, noise filtering, inflation and planning are unchanged.

## Planner Clearance Diagnostics

Enable **Planner Clearance Diagnostics** inside the comparison dialog. Click A
on the doorway approach side and B on the exit side. Subsequent clicks place the
robot footprint. The selection menu lets you replace either endpoint. Headings
are MAP-frame degrees, initially taken from the application's start/goal poses.
The goal-heading checkbox initially follows the saved application setting;
diagnostic overrides never update it. Run diagnostic planner runs the same
operational worker with request preparation from PlanningCoordinator and the
current store configuration snapshot. Existing mission waypoints are excluded
because this probe is specifically between A and B. Manual mode is explicitly
unsupported rather than silently replaced by a different strategy.

The isolated diagnostic worker is cancelled when inputs change, mode is closed
or another request replaces it. Results never commit a route, create an order,
publish MQTT, or change mission/recording state.

### What the colours mean

- Orange: exact `ObstacleInflation.byRadius` output using planning safety margin
  plus localization margin, matching App's static map layer. Original occupied
  and unknown source cells are classified separately.
- Grey: unknown cells. Red: original occupied blockers. Magenta outlines:
  first collision cells and colliding full-footprint polygons.
- White: configured Bosch polygon/rectangle, including configured offsets, plus
  a body-heading indicator. Cyan: effective margin-expanded footprint, using
  the same FootprintModel and PoseCollisionChecker as the planner.
- Blue cells: free cell centres below the actual motion-state hard minimum
  clearance, calculated by the existing motion-state clearance field. This
  is not a footprint erosion and is not applied to legacy search.
- Purple boundary cells: measured doorway cross-section is below the saved
  minimum-passage-width setting. Yellow cross-section: not below that setting.
  Blue polyline: planner result; pale blue segment: selected A-to-B probe.

### Important distinctions found in the existing application

Normal PlanningCoordinator requests pass the **raw** occupancy grid as both grid
and collisionGrid. Static inflation is display-only for these requests. The
configured footprint.inflationRadius is displayed but is not used by that
planner request. Applying the orange map a second time would change behaviour,
so the diagnostic does not do that.

The effective footprint margin is max(configured footprint margin, planning
safety margin + localization margin), per side. Motion-state also has a hard
minimum centre-clearance check. Minimum passage width is used by legacy
PassageDetector to filter detected/aligned passages; motion-state does not use
it as a hard search cutoff. Legacy FreeSpaceAnalyzer can return PASSAGE_TOO_NARROW
based on the footprint width/margin and free-space connectivity. The UI reports
the actual result rather than assigning a failure based solely on a purple cell.

### Clearance estimate and evidence limits

Doorway width is the narrowest sampled free cross-section normal to the A-to-B
travel direction. Rays use exact occupancy-cell edges, the map origin/yaw and
resolution. The map boundary is not treated as an observed wall. Unknown
boundaries remain labelled unknown. Projected body span uses the actual polygon
at the selected start heading, and remaining width subtracts twice the effective
margin. This raster estimate is not a guarantee of physical measurement accuracy,
a curved route's clearance, or manoeuvring feasibility.

Rejected-stage collision cells are taken directly from PlannerResult. Endpoint
collisions are reproduced at the exact request pose using the existing checker.
Legacy rejected enhancement paths can be replayed through the existing detailed
collision validator. Only first blocker cells provided by these checks are
marked; refined motion-state keys are not converted to guessed world positions.
The planner's bounded events do not contain exact poses for every rejected
transition, so the overlay does not claim an exhaustive search collision trace.
For timeouts it reports the exact code/error and states that one blocking cell
or physical impossibility has not been established.

Regression tests cover a 0.600 m raster aperture with 0.400 m body span and 0.050 m
per-side margin (0.100 m remaining), rotated maps, Bosch polygons, unknown edges,
inflated-only classification, exact occupied/unknown endpoint blockers, actual
narrow-opening planner rejection, saved configuration reuse and stale worker
cancellation. No real doorway failure is asserted until endpoints are selected
and the diagnostic planner is run on the user's map.
