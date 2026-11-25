# Stage 5B — Real-world validation — awaiting exported artifacts

Scenarios: 0; real runs: 0.

Recommendation: PENDING. No real-run artifacts evaluated. Profile selection pending.

Captured default means the exported run configuration, not newly substituted application defaults.
Failure scores are zero. Success rate ranks first; bounded expectation penalties rank second. Raw total costs use different profile weights and are not comparable.
Clearance is sampled center-to-obstacle distance, not footprint-edge clearance. Suspicious rotations are review candidates, not proof of redundancy. Open-route preference compares average clearance of successful alternatives; inspect geometry.

| Profile | Success | Mean score | Mean time ms (all runs) |
|---|---:|---:|---:|
| CAPTURED_DEFAULT | 0/0 | N/A | N/A |
| BALANCED | 0/0 | N/A | N/A |
| FORWARD_PREFERRED | 0/0 | N/A | N/A |
| CLEARANCE_PREFERRED | 0/0 | N/A | N/A |

| Scenario / profile | Success | Score | ms / states | Path m / cost | Clearance min / avg m | Reverse m / switches | Rotation deg / actions | Suspicious |
|---|---|---:|---|---|---|---|---|---|

## Scenario evidence and known limitations


Tight/complex real routes reported by the operator remain known limitations; without their artifacts their category is unknown. They do not block Stage 5B infrastructure completion.
Timeout is not physical infeasibility. Guide/lattice/primitive diagnoses require trace evidence or a documented manual audit. A single timing sample is affected by caches and CPU contention; repeat in a fresh process for performance conclusions.

## Profile trade-offs

- BALANCED: May retain short reverse manoeuvres and accepts modest detours for clearance.
- FORWARD_PREFERRED: Can add rotation and forward distance where a short reverse manoeuvre is valid.
- CLEARANCE_PREFERRED: Produces longer routes in open alternatives and can search more states.

## Physical robot test checklist

- Verify captured map, localization, footprint, payload, safety margins and operating area match the robot.
- Review every failed case and suspicious manoeuvre before attempting that scenario.
- Start at approved low speed in a controlled area with the normal safety system and stop access available.
- Check forward/reverse execution, switch count, swept turns and clearance against replay.
- Verify final position/orientation and normal publish-time validation.
- Repeat with localization variation and representative obstacles; record actual timing and deviations.
- Export new artifacts, record observations and obtain operational acceptance before changing any default.

Production defaults, planner architecture and safety validation are unchanged by this offline workflow.
