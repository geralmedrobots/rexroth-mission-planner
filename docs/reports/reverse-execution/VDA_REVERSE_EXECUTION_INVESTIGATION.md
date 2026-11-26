The confirmed application defect was loss of traversal direction at VdaOrderBuilder's edge construction. TRANSLATE_REVERSE retained node theta but produced no edge orientation. The fix serializes orientation=pi for caller-supplied MotionPlan reverse translations and orientation=0 for forward translations. Planner geometry, objective and costs were not changed.

Evidence limits: no exact published order, order ID, complete start/goal coordinates, runtime logs, installed Navigator implementation/manual, PLC project, or wheel-command capture for the latest run was found in this workspace. Searching the available JSON/log files for 3.018823774 and 2.451 found no matching run. The user's contentReference markers do not provide accessible artifacts. The reported physical sequence is consistent with the missing field, but cannot be conclusively attributed to a particular Navigator or PLC decision from this repository alone.

The VDA 5050 2.0 tagged [official order schema](https://github.com/VDA5050/VDA5050/blob/2.0.0/json_schemas/order.schema) distinguishes node orientation from tangential edge orientation. Node theta constrains the pose at a node. Edge orientation=0 specifies forward traversal and pi specifies reverse traversal; without a trajectory the reference is the line between nodes. The direction string is intended for line-guided junction selection, not a forward/reverse gear command. This fix uses the existing 2.0 tangential orientation field; it introduces neither a protocol version change nor a Bosch-specific extension. No negative maxSpeed or trajectory orientation samples are necessary for this representation.

Pipeline traced in local code:

1. MotionPlan stores body theta, physical FORWARD/REVERSE direction and explicit actions. The reported D:F-R -> B:3.019m has no rotation action.
2. App.tsx order generation supplies the selected MotionPlan to VdaOrderBuilder. The builder derives the route directly from its states and independently validates the MotionPlan with the planning grid/footprint. It does not rebuild the heading from path tangent in this branch.
3. Every MotionPlan state becomes a node. Node 0 uses the live robot position; all nodes use decided body theta. Each consecutive pair becomes an edge.
4. Before the fix, edges contained IDs, alternating sequence IDs, released=true, positive mission maxSpeed, rotationAllowed, optional corridor, and empty actions. No orientation, orientationType, trajectory, reverse flag, or direction command was written. Corridor is the only Bosch-related extension used here and does not encode body/travel orientation.
5. DIRECTION_CHANGE becomes two coincident nodes with equal theta and an empty-action, zero-length edge. It has no explicit protocol direction-change action. There is no evidence that Navigator interprets this as reverse. The duplicate remains unchanged in this fix: removing it would alter sequencing without installed-Navigator evidence. Reverse intent now resides on the subsequent translating edge, independently of the duplicate.
6. App.tsx dispatch calls mqttService.publish with JSON.stringify(order). MqttService passes that string unchanged to the MQTT client, or wraps the same string in the local WebSocket bridge request. server/index.ts forwards message.payload unchanged to MQTT. The corridor compatibility service clones the order and only edits corridor fields, so orientation survives that path too.
7. No Navigator trajectory/control-loop implementation or PLC/wheel-command producer exists in this workspace. BoschVehicleConfiguration imports differential-drive constraints, backwardAllowed and maxReverseVelocity; this establishes the app's configuration vocabulary, not the deployed controller's implementation.
8. useMqtt parses signed velocity.vx without clamping and retains raw payloads. SpeedLimitDiagnostics optionally extracts motionCommand.v_x when actually present. It does not request ClientMotion telemetry or generate motor commands. Absolute values used for speed-limit analysis do not modify command or feedback values. The bridge is an MQTT transport bridge, not a velocity-to-wheel bridge.

For the reported heading h approximately -2.451 rad and distance d approximately 3.018823774 m, the order can be reconstructed only parametrically:

| Item | Position | Node body theta / edge orientation before | After |
| --- | --- | --- | --- |
| Node 0, sequence 0 | (sx,sy) live start | h | h |
| Node 1, sequence 2 | (sx,sy) direction-state duplicate | h | h |
| Node 2, sequence 4 | (sx-d*cos(h),sy-d*sin(h)) | h | h |
| Edge 0, sequence 1 | Node 0 -> Node 1 | orientation absent, actions empty | unchanged |
| Edge 1, sequence 3 | Node 1 -> Node 2 | orientation absent, actions empty | orientation=3.141592653589793, actions empty |

All released flags remain true; maxSpeed remains the configured positive missionMaximumSpeedMps; rotationAllowed remains its original first-edge/settings-derived value; existing corridor is preserved; trajectory is absent. Runtime IDs, mapId, speed, deviations and corridor dimensions cannot be recovered from the supplied summary.

The translating edge's world bearing is about +39.6 degrees. With tangential orientation pi, its body orientation is about -140.4 degrees. The intended longitudinal motion sign is negative. Previously the node headings alone left travel orientation unspecified; a receiver's choice to align forward and then restore node theta could satisfy those endpoint headings. After the fix the edge explicitly requests reverse. This is expected protocol behavior, not a claim that hardware execution has been observed or certified. rotationAllowed has not been changed or used to alter Navigator obstacle handling.

Bosch's [ROKIT Node-RED dashboard article](https://community.boschrexroth.com/ctrlx-automation-how-tos-qmglrz33/post/rokit-dashboard-with-node-red-for-ctrlx-automation-wlqrZRsOu1p4weS) describes selectable trajectory driving directions, VDA-to-Navigator delivery, and Navigator's conversion to lower-level commands. It is a reference sample, not a capability declaration for the installed robot. Available sources do not prove which optional fields that installed version supports, whether a vehicle configuration disables reverse, or whether its PLC preserves negative velocities. No undocumented Bosch command, configuration flag, or trajectory extension was invented.

Added diagnostics:

- [motion-execution] at build time: action/direction, exact poses, body theta, world bearing, angular difference, expected longitudinal sign, actual edge fields, absence of trajectory, explicit reverse encoding, and UNOBSERVED Navigator/wheel interpretation. Coincident direction-state edges are explicitly labelled as having no protocol direction-change action.
- [order-motion] immediately before publish: actual serialized nodes/edges and encoded direction, linked by orderId/edgeId/sequenceId. This also covers orders supplied outside the builder.
- [speed-cycle] retains the existing signed values and now explicitly reports commandLongitudinalSign and observedLongitudinalSign. Missing command telemetry is UNOBSERVED, not assumed positive or zero. These are observed message fields, not access to motor-level commands.

Six regression cases cover reverse at body headings 0 and -140 degrees, explicit forward orientation, MQTT client serialization, TCP bridge envelope preservation, and negative command/feedback telemetry. The geometry check independently reconstructs body heading as edge bearing + orientation: omitting orientation or replacing pi with 0 breaks the reverse tests. They verify protocol encoding, not a Navigator simulator. Existing independent collision validation is exercised before order building.

Files changed: src/domain/vda5050/VdaOrderBuilder.ts; src/domain/types.ts (optional edge orientation); src/domain/vda5050/MotionExecutionDiagnostics.ts (new); src/services/MqttService.ts; src/domain/robot/SpeedLimitDiagnostics.ts; src/tests/vdaReverseExecution.test.ts (new); this report. No planner, cost model, calibration defaults, clearance checks, safety margins, unknown-cell handling, adaptive refinement, Navigator settings or PLC code was modified. No order was sent to a robot during this investigation.

To establish end-to-end physical execution, the remaining evidence is the failing/successor raw published order and correlated state/error/ClientMotion command logs, plus the installed Navigator interface documentation or factsheet and PLC velocity-to-wheel implementation. Without those, negative-velocity preservation after Navigator and the exact failing-run cause remain unverified.

Validation passed: npm run typecheck; npm run lint; npm test -- --maxWorkers=1 (373 tests, 41 files). The targeted VDA reverse execution, VDA builder, order-safety and integration run also passed all 37 tests across its four files.
