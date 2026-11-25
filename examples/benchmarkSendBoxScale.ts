import { MotionStatePlanner } from '../src/domain/planning/MotionStatePlanner';
import { sendBoxScaleRequest } from '../src/tests/fixtures/sendBoxScale';

for (const kind of ['open', 'clutter', 'detour'] as const) {
  const request = sendBoxScaleRequest(kind);
  for (const run of ['cold', 'warm', 'new-goal']) {
    if (run === 'new-goal') {
      request.goal = { ...request.goal, column: request.goal.column + 4 };
      request.exactGoalPose = { ...request.exactGoalPose!, x: request.exactGoalPose!.x + .2 };
    }
    const start = performance.now();
    const result = new MotionStatePlanner().plan(request);
    const wallMs = performance.now() - start;
    const guide = result.motionPlannerEvents?.find((e) => e.eventType === 'motionplanner.guide.created');
    const counts = result.motionPlannerEvents?.find((e) => e.eventType === 'motionplanner.state.expanded' && e.final);
    const metrics = result.motionPlannerCalibration?.result;
    console.log(JSON.stringify({ kind, run, success: result.success, wallMs: +wallMs.toFixed(1),
      reportedMs: +result.statistics.durationMs.toFixed(1), guide,
      expanded: result.statistics.visitedCells, counts,
      stages: result.motionPlannerEvents?.filter((e) => e.eventType === 'motionplanner.corridor.completed'),
      cost: metrics?.costs.total, length: metrics?.totalPathLengthM,
      minimumClearance: metrics?.minimumClearanceM, nodes: result.finalPath.length,
      reason: result.error }));
  }
}
