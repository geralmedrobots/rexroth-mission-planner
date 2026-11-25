import { normalizeAngle } from '../geometry/angles';
import type { MotionDirection, MotionPlan, MotionState } from '../motion/planningModel';

export const DIRECTION_PREFERENCE_EPSILON_RAD = 1e-7;
export const DIRECTION_PREFERENCE_SEMANTICS = 'local-manoeuvre-alignment-v1';

export function preparationContext(state: MotionState) {
  const context = state.directionPreferenceContext;
  return context && !context.translating ? context :
    { heading: state.theta, direction: state.direction, translating: false };
}

export function directionPreference(state: MotionState, goal: { x: number; y: number },
  candidateDirection: MotionDirection, weight: number, continuing = false) {
  const origin = preparationContext(state);
  const goalBearing = Math.atan2(goal.y - state.y, goal.x - state.x);
  const forward = normalizeAngle(goalBearing - origin.heading);
  const reverse = normalizeAngle(goalBearing - (origin.heading + Math.PI));
  const tied = Math.hypot(goal.x - state.x, goal.y - state.y) <= 1e-7 ||
    Math.abs(Math.abs(forward) - Math.abs(reverse)) <= DIRECTION_PREFERENCE_EPSILON_RAD;
  const preferredDirection = tied ? origin.direction :
    Math.abs(forward) < Math.abs(reverse) ? 'FORWARD' : 'REVERSE';
  const penalty = !continuing && candidateDirection !== preferredDirection ? weight : 0;
  return { goalBearingRad: goalBearing, currentHeadingRad: state.theta,
    manoeuvreStartHeadingRad: origin.heading, frontAxisHeadingRad: origin.heading,
    rearAxisHeadingRad: normalizeAngle(origin.heading + Math.PI),
    forwardAlignmentErrorDeg: forward * 180 / Math.PI,
    reverseAlignmentErrorDeg: reverse * 180 / Math.PI, preferredDirection, candidateDirection,
    continuingManoeuvre: continuing, numericalTie: tied,
    directionPreferencePenaltyApplied: penalty !== 0, penaltyAmount: penalty };
}

/** Recompute only the preference component after optimiser geometry changes.
 * Rotations/switches preserve the pre-preparation heading; adjacent translations
 * share a single charge. Other physical cost components are left untouched. */
export function recomputeDirectionPreference(plan: MotionPlan, weight: number): void {
  plan.actions = plan.actions.map((action) => ({ ...action,
    metadata: action.metadata ? { ...action.metadata } : undefined,
    costComponents: action.costComponents ? { ...action.costComponents } : undefined }));
  let context = plan.states[0] ? preparationContext(plan.states[0]) : undefined;
  let translating = false;
  for (const action of plan.actions) {
    if (!context) break;
    let penalty = 0;
    if (action.type === 'TRANSLATE_FORWARD' || action.type === 'TRANSLATE_REVERSE') {
      const candidateDirection = action.type === 'TRANSLATE_FORWARD' ? 'FORWARD' : 'REVERSE';
      const storedGoal = action.metadata?.directionPreferenceGoal as { x: number; y: number } | undefined;
      const evidence = directionPreference({ ...action.from, directionPreferenceContext: context },
        storedGoal ?? action.to, candidateDirection, weight, translating);
      penalty = evidence.penaltyAmount;
      action.metadata = { ...action.metadata, directionPreference: evidence };
      translating = true;
      context = { heading: action.to.theta, direction: action.to.direction, translating: false };
    } else {
      translating = false;
    }
    if (action.costComponents) {
      action.costComponents.total += penalty - action.costComponents.directionSwitch;
      action.costComponents.directionSwitch = penalty;
    }
  }
}
