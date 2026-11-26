The planner accounts for the complete forward and reverse alignment angles, motion costs, direction switch, reverse surcharge, and physical sweeps. No calculation bug or fixed-per-turn penalty was found. No objective, weight, safety or refinement change was justified. This change adds diagnostic evidence and regression coverage.

The reported rounded projection (3.5186 m) and lateral error (0.254 m) define a synthetic reproduction: start (5, 2, theta=0), goal (1.4814, 2.254, theta=0), goalTheta undefined, XY tolerance 0.2 m. Exact real poses, footprint and occupancy grid were not supplied for this latest case, so these results do not establish the real map's individual costs or collision results. The lateral sign is chosen positive; reversing that sign reverses signed rotations but preserves magnitudes.

Goal bearing is 3.069529853127 rad / 175.871105673569 degrees. Front axis is 0, rear axis is pi. Required forward body heading is the bearing; required reverse body heading is bearing + pi, normalized to -0.072062800463 rad. Thus forward alignment is +175.871105673569 degrees and reverse alignment is -4.128894326431 degrees. Neither uses the theta-bin heading.

Full initial candidate comparison, using the fixture with one obstacle cell at world (6,2), 1 m start centre clearance, 0.4 x 0.22 m rectangular footprint, and 0.1 m hard minimum. Weights: translation 1, rotation .15, reverse .3, switch 1, wall 3, narrow 1.5, turn 1, terminal orientation .15. These are fixture inputs, not changes to defaults.

| Quantity | Straight forward | Straight reverse | Rotate forward | Rotate reverse |
| --- | ---: | ---: | ---: | ---: |
| Required body heading rad | 0 | 0 | 3.069529853127 | -0.072062800463 |
| Required motion axis rad | 0 | pi | 3.069529853127 | 3.069529853127 |
| Signed alignment degrees | 0 | 0 | 175.871105673569 | -4.128894326431 |
| Sweep magnitude rad | 0 | 0 | 3.069529853127 | 0.072062800463 |
| Signed axis projection m | -3.5186 | 3.5186 | -3.5186 | 3.5186 |
| Candidate translation m | 0 (ray clamped) | 3.5186 | 3.527755938270 | 3.527755938270 |
| Terminal XY error m | 3.527755938270 | .254 | 0 | 0 |
| Translation cost | not evaluated | not evaluated | 3.527755938270 | 3.527755938270 |
| Direction switch cost | not evaluated | not evaluated | 0 | 1 |
| Reverse surcharge | not evaluated | not evaluated | 0 | 1.058326781481 |
| Rotation cost | not evaluated | not evaluated | .460429477969 | .010809420069 |
| Turn-location cost | not evaluated | not evaluated | 3.069529853127 | .072062800463 |
| Wall clearance cost | not evaluated | not evaluated | 0 | 0 |
| Narrow passage cost | not evaluated | not evaluated | 0 | 0 |
| Terminal orientation cost | not evaluated | not evaluated | 0 | 0 |
| Total | ineligible | ineligible | 7.057715269366 | 5.668954940284 |
| Feasibility | behind forward ray | XY error exceeds .2 | feasible | feasible, selected |
| Rotation collision check | not checked | not checked | passed | passed |

The selected sequence is D:F-R -> R:4.1deg -> B:3.528m, unchanged by this investigation. Rejected candidates have null costs rather than invented totals. Run `npx tsx src/tools/auditManoeuvreComparison.ts` for all candidate fields, component totals, sweep outcomes and selected actions in both controlled maps.

Rotation cost is abs(angle) * rotationCostPerRad. Turn-location cost is abs(angle) * turnLocationWeight / max(centreClearanceM, gridResolutionM). At the same position, both costs scale by the forward/reverse angle ratio (about 42.595). The latter is equivalent to integrating a constant centre-clearance penalty over angle; it is not an integral of orientation-dependent footprint clearance. Wall/narrow costs apply to translation. No explicit swept-area or duration cost exists.

In the obstacle-free fixture, clearance is infinite and turn-location cost is zero. The same forward candidate costs 3.988185416239 and reverse costs 5.596892139821, so forward is selected. The 2.058326781481 combined reverse/switch surcharge exceeds the .449620057900 rotation-cost saving. This is a mismatch between a strong general preference for small-rotate+reverse and the present numerical objective, not an omitted forward angle or an incorrect angular scaling formula. Even directly behind, reverse need not win with ordinary current weights. Weights were deliberately left unchanged.

RotationSweepChecker traverses the entire shortest normalized angular interval and tests the full footprint at every sampled heading including endpoints. At the 5-degree setting, these sweeps have 36 intervals (37 pose checks if unobstructed) versus 1 interval (2 checks). A longer angular sweep covers more orientations, though swept area is not proportional to angle and rectangle symmetry matters. This is the existing sampled check, not a claim of exact continuous collision detection. The connector does not try the complementary longer rotation if the shortest sweep collides. A regression places an obstacle in the large sweep of a 1.2 m rectangle while the small reverse sweep and translation remain free.

All four strategies are considered before the least complete feasible cost is selected. FORWARD initialization adds the explicit switch cost to reverse, but does not suppress reverse. Normal weighted search can compare further candidates after the initial connector; its existing search/corridor budget and termination policy do not guarantee a globally minimal plan. The connector comparison itself uses full unweighted motion costs.

Only request.goalTheta enforces terminal heading. Matching startPose.theta and exactGoalPose.theta alone does not impose restoration. Explicit restoration incurs terminalOrientation and turnLocation cost and its own full sweep check. The application coordinator leaves goalTheta undefined for normal motion-state destination requests.

Changed files: MotionStatePlanner.ts (candidate diagnostics and equivalent instrumented rotation check); src/tests/fixtures/manoeuvreComparison.ts; src/tests/motionStateManoeuvreComparison.test.ts; src/tools/auditManoeuvreComparison.ts; this report. Existing terminal-tolerance tests remain unchanged. Safety/collision semantics, hard clearance, safety margins, unknown cells, calibration defaults, Navigator, XY tolerance and adaptive refinement remain unchanged.

Validation: npm run typecheck and npm run lint passed; npm test -- --maxWorkers=1 passed all 356 tests across 39 files, including the seven new manoeuvre tests and all terminal-tolerance tests. Full-size clutter and detour performance cases passed at approximately 565 ms and 524 ms; these are single-run observations, not a controlled performance comparison.
