import { normalizeAngle } from '../geometry/angles';
import type { OccupancyGrid, PathPoint, PlannerOptions, RobotFootprint } from '../types';
import type { MotionAction, MotionDirection, MotionPlan, MotionState } from './planningModel';
import { PathCollisionValidator } from '../planner/PathCollisionValidator';
import { CostModel } from '../planning/CostModel';

/** Stage 3 compatibility selector. This is intentionally the old direction algorithm. */
export const buildLegacyMotionPlan = (route: PathPoint[], startTheta: number, options: PlannerOptions, grid?: OccupancyGrid, footprint?: RobotFootprint, finalGoalTheta?: number): MotionPlan => {
  const states: MotionState[] = [];
  const actions: MotionAction[] = [];
  let previousTheta = normalizeAngle(startTheta);
  let previousDirection: MotionDirection | undefined;
  const collision = new PathCollisionValidator();
  for (let index = 0; index < route.length; index += 1) {
    const point = route[index]!; const next = route[index + 1]; const previous = route[index - 1];
    let theta = index === 0 ? normalizeAngle(startTheta) : normalizeAngle(point.theta);
    let direction: MotionDirection = previousDirection ?? 'FORWARD';
    if (index > 0 && !point.orientationLocked && !point.passageId && next) {
      const bearing = normalizeAngle(Math.atan2(next.y - point.y, next.x - point.x));
      const candidates = (['FORWARD', 'REVERSE'] as const).map((candidate) => {
        const candidateTheta = candidate === 'FORWARD' ? bearing : normalizeAngle(bearing + Math.PI);
        const rotation = Math.abs(normalizeAngle(candidateTheta - previousTheta));
        let obstacle = 0;
        if (grid && footprint) {
          const free = collision.pointIsFree(grid, { ...point, theta: candidateTheta }, footprint) &&
            collision.rotationIsFree(grid, { x: point.x, y: point.y }, previousTheta, candidateTheta, footprint, options.passageSafety.rotationCollisionSampleDeg * Math.PI / 180);
          if (!free) obstacle = Number.POSITIVE_INFINITY;
        }
        const reversePenalty = candidate === 'REVERSE' ? options.passageSafety.reverseRiskWeight : 0;
        const turn = CostModel.directionSwitch(previousDirection, candidate, options);
        const compatibilityTurn = previousDirection && previousDirection !== candidate
          ? (options.turnPenalty ?? options.passageSafety.headingChangeWeight) : 0;
        return { candidate, candidateTheta, rotation, obstacle, total: CostModel.distance(Math.hypot(next.x - point.x, next.y - point.y), options.distanceWeight) + CostModel.rotation(rotation, options.passageSafety.headingChangeWeight) + reversePenalty + turn + compatibilityTurn + obstacle };
      });
      const chosen = candidates.filter((candidate) => Number.isFinite(candidate.obstacle)).sort((a, b) => a.total - b.total)[0] ?? candidates[0]!;
      direction = chosen.candidate; theta = chosen.candidateTheta;
    } else if (index === route.length - 1 && !point.orientationLocked && !point.passageId && finalGoalTheta !== undefined) {
      theta = normalizeAngle(finalGoalTheta);
    } else if (index === route.length - 1 && previous) {
      theta = normalizeAngle(Math.atan2(point.y - previous.y, point.x - previous.x));
    }
    const state: MotionState = { x: point.x, y: point.y, theta, direction };
    const prior = states[states.length - 1];
    states.push(state);
    if (prior) actions.push({ type: prior.direction !== direction ? 'DIRECTION_CHANGE' : (direction === 'REVERSE' ? 'TRANSLATE_REVERSE' : 'TRANSLATE_FORWARD'), from: prior, to: state, distanceM: Math.hypot(state.x - prior.x, state.y - prior.y) });
    if (index > 0 && !point.orientationLocked && !point.passageId && next) { previousTheta = theta; previousDirection = direction; }
  }
  return { states, actions, metadata: { source: 'legacy-direction-compatibility', plannerVersion: 'stage-3' } };
};
