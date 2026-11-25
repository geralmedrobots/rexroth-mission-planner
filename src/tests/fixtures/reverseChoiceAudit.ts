import { defaultPlannerOptions } from '../../domain/defaults';
import type { PlannerRequest } from '../../domain/planner/PlannerService';
import { MotionStatePlanner } from '../../domain/planning/MotionStatePlanner';
import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import { openRefinementFixture } from './adaptiveRefinement';

export function alignedReverseRequest(reverseCost = 2, switchCost = 1,
  explicitGoalHeading = true): PlannerRequest {
  const request = openRefinementFixture(2);
  request.options = structuredClone(defaultPlannerOptions);
  request.options.passageSafety.reverseRiskWeight = reverseCost;
  request.options.passageSafety.motionStateDirectionSwitchWeight = switchCost;
  request.footprint.backwardAllowed = true;
  request.footprint.allowReverse = true;
  request.exactStartPose = { x: 3, y: 2, theta: 0 };
  request.exactGoalPose = { x: 2, y: 2, theta: 0 };
  request.goalTheta = explicitGoalHeading ? 0 : undefined;
  const transform = new CoordinateTransformer(request.grid.metadata);
  request.start = transform.worldToGrid(3, 2)!;
  request.goal = transform.worldToGrid(2, 2)!;
  return request;
}

/** Investigation only: capture the initial connector arguments, then replay each
 * direction independently AFTER planning, with isolated diagnostics. The real
 * planner and all physical checks run unchanged. This exposes both feasible
 * competitors which normal telemetry currently collapses into one winner. */
export function auditReverseChoice(request: PlannerRequest) {
  type TerminalMethod = MotionStatePlanner['terminalCandidate'];
  const planner = new MotionStatePlanner();
  const instrumented = planner as unknown as { terminalCandidate: TerminalMethod };
  const original = instrumented.terminalCandidate;
  let initial: Parameters<TerminalMethod> | undefined;
  instrumented.terminalCandidate = function (...args) {
    initial ??= args;
    return original.apply(planner, args);
  };
  const result = planner.plan(request);
  const alternatives = (['FORWARD', 'REVERSE'] as const).map((direction) => {
    if (!initial) return { direction, feasible: false, reason: 'Initial connector was not attempted' };
    const args = [...initial] as Parameters<TerminalMethod>;
    args[3] = { ...args[3], forward: direction === 'FORWARD' && args[3].forward,
      reverse: direction === 'REVERSE' && args[3].reverse };
    const events: Array<Record<string, unknown>> = [];
    args[10] = (eventType, payload = {}) => events.push({ eventType, ...payload });
    args[11] = structuredClone(args[11]);
    const candidate = original.apply(planner, args);
    return { direction, feasible: Boolean(candidate), cost: candidate?.cost,
      actions: candidate?.actions.map((action) => ({ type: action.type,
        distanceM: action.distanceM, rotationRad: action.rotationRad,
        costComponents: action.costComponents })), rejections: events };
  });
  return { alternatives, result };
}
