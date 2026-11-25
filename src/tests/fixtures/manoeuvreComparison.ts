import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import { createPlanningConfigurationSnapshot } from '../../domain/planning/PlanningConfigurationSnapshot';
import { MotionStatePlanner } from '../../domain/planning/MotionStatePlanner';
import type { MotionCostComponents } from '../../domain/motion/planningModel';
import { openRefinementFixture } from './adaptiveRefinement';

/** Synthetic geometry from the reported rounded axial distance and lateral error.
 * The obstacle/map and footprint are controlled fixtures, not the real robot map. */
export function manoeuvreRequest(dx = -3.5186, dy = .254, obstacle = true) {
  const request = openRefinementFixture(7);
  request.exactStartPose = { x: 5, y: 2, theta: 0 };
  request.exactGoalPose = { x: 5 + dx, y: 2 + dy, theta: 0 };
  request.goalTheta = undefined;
  request.footprint.backwardAllowed = request.footprint.allowReverse = true;
  Object.assign(request.options.passageSafety, { reverseRiskWeight: .3,
    motionStateDirectionSwitchWeight: 1, headingChangeWeight: .15,
    wallProximityWeight: 3, narrowPassageWeight: 1.5, turnLocationWeight: 1 });
  const transform = new CoordinateTransformer(request.grid.metadata);
  request.start = transform.worldToGrid(5, 2)!;
  request.goal = transform.worldToGrid(5 + dx, 2 + dy)!;
  if (obstacle) {
    const cell = transform.worldToGrid(6, 2)!;
    request.grid.data[cell.row * request.grid.metadata.width + cell.column] = 100;
  }
  request.planningConfiguration = createPlanningConfigurationSnapshot({
    plannerOptions: request.options, footprint: request.footprint,
    orderSettings: { allowedDeviationXy: .2 },
  });
  return request;
}

export interface ManoeuvreDiagnostic {
  name: string; feasible: boolean; alignmentRotationRad: number; alignmentRotationDeg: number;
  rotationSweepMagnitudeRad: number; translationDistanceM: number;
  costComponents: MotionCostComponents | null; cost: number | null;
  rotationCollisionResult: string;
  rotationSweeps: Array<{ result: string; sweepMagnitudeRad: number; clearanceM: number }>;
}

export function compareManoeuvres(request = manoeuvreRequest()) {
  const result = new MotionStatePlanner().plan(request);
  const selection = result.motionPlannerEvents!.find((event) =>
    event.eventType === 'motionplanner.terminalConnector.selection')!;
  return { result, selection, candidates: selection.candidates as ManoeuvreDiagnostic[] };
}
