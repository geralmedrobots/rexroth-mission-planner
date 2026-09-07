import { normalizeAngle } from '../geometry/angles';
import type { MotionAction, MotionPlan, MotionState } from '../motion/planningModel';
import type { OccupancyGrid, RobotFootprint } from '../types';
import { PoseCollisionChecker } from './PoseCollisionChecker';
import { RotationSweepChecker } from './RotationSweepChecker';
import { TranslationSweepChecker } from './TranslationSweepChecker';

export interface MotionPlanValidationIssue {
  code: string;
  message: string;
  stateIndex?: number;
  actionIndex?: number;
}

export interface MotionPlanValidationResult {
  valid: boolean;
  errors: string[];
  issues: MotionPlanValidationIssue[];
}

const ANGULAR_TOLERANCE = 1e-6;
const POSITION_TOLERANCE = 1e-7;
const angularDistance = (left: number, right: number): number =>
  Math.abs(normalizeAngle(left - right));
const sameState = (left: MotionState, right: MotionState): boolean =>
  Math.hypot(left.x - right.x, left.y - right.y) <= POSITION_TOLERANCE &&
  angularDistance(left.theta, right.theta) <= ANGULAR_TOLERANCE &&
  left.direction === right.direction;

/** Independently replays an exact selected plan immediately before publishing. */
export class MotionPlanValidator {
  public validate(
    plan: MotionPlan,
    grid: OccupancyGrid,
    footprint: RobotFootprint,
    translationIntervalM: number,
    rotationStepRad: number,
    reverseAllowed: boolean,
    finalTheta?: number,
  ): MotionPlanValidationResult {
    const issues: MotionPlanValidationIssue[] = [];
    const reject = (issue: MotionPlanValidationIssue): void => { issues.push(issue); };
    const pose = new PoseCollisionChecker();
    const translation = new TranslationSweepChecker(pose);
    const rotation = new RotationSweepChecker(pose);

    if (!plan.states.length) reject({ code: 'motionplan.empty', message: 'Motion plan has no states.' });
    if (plan.actions.length !== Math.max(0, plan.states.length - 1)) reject({
      code: 'motionplan.cardinality',
      message: 'Motion plan must have exactly one action between each pair of states.',
    });
    plan.states.forEach((state, stateIndex) => {
      if (![state.x, state.y, state.theta].every(Number.isFinite)) reject({
        code: 'motionplan.pose.nonfinite', message: `State ${stateIndex} is not finite.`, stateIndex,
      });
      else if (!pose.pointIsFree(grid, state, footprint)) reject({
        code: 'motionplan.pose.collision', message: `State ${stateIndex} is in collision.`, stateIndex,
      });
      if (!reverseAllowed && state.direction === 'REVERSE') reject({
        code: 'motionplan.reverse.forbidden', message: `State ${stateIndex} uses reverse while reverse is disabled.`, stateIndex,
      });
    });
    plan.actions.forEach((action, actionIndex) => {
      const from = plan.states[actionIndex];
      const to = plan.states[actionIndex + 1];
      if (!from || !to || !sameState(action.from, from) || !sameState(action.to, to)) {
        reject({ code: 'motionplan.action.stateMismatch', message: `Action ${actionIndex} does not reference its exact adjacent states.`, actionIndex });
        return;
      }
      this.validateAction(action, actionIndex, grid, footprint, translationIntervalM,
        rotationStepRad, reverseAllowed, translation, rotation, reject);
    });
    const finalState = plan.states.at(-1);
    if (finalState && finalTheta !== undefined && angularDistance(finalState.theta, finalTheta) > ANGULAR_TOLERANCE) reject({
      code: 'motionplan.finalOrientation',
      message: 'Final orientation does not match the requested orientation.',
      stateIndex: plan.states.length - 1,
    });
    return { valid: issues.length === 0, errors: issues.map((issue) => issue.message), issues };
  }

  private validateAction(
    action: MotionAction,
    actionIndex: number,
    grid: OccupancyGrid,
    footprint: RobotFootprint,
    interval: number,
    rotationStepRad: number,
    reverseAllowed: boolean,
    translation: TranslationSweepChecker,
    rotation: RotationSweepChecker,
    reject: (issue: MotionPlanValidationIssue) => void,
  ): void {
    const { from, to } = action;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (action.type === 'TRANSLATE_FORWARD' || action.type === 'TRANSLATE_REVERSE') {
      const reverse = action.type === 'TRANSLATE_REVERSE';
      if (reverse && !reverseAllowed) reject({ code: 'motionplan.reverse.forbidden', message: `Reverse action ${actionIndex} is not permitted.`, actionIndex });
      if (from.direction !== (reverse ? 'REVERSE' : 'FORWARD') || to.direction !== from.direction) reject({
        code: 'motionplan.translation.direction', message: `Translation ${actionIndex} does not match its direction state.`, actionIndex,
      });
      if (distance <= POSITION_TOLERANCE || angularDistance(from.theta, to.theta) > ANGULAR_TOLERANCE) reject({
        code: 'motionplan.translation.geometry', message: `Translation ${actionIndex} must move with fixed body orientation.`, actionIndex,
      });
      if (distance > POSITION_TOLERANCE) {
        const bearing = Math.atan2(to.y - from.y, to.x - from.x);
        const expected = reverse ? normalizeAngle(from.theta + Math.PI) : from.theta;
        if (angularDistance(bearing, expected) > ANGULAR_TOLERANCE) reject({
          code: 'motionplan.translation.bearing', message: `Translation ${actionIndex} does not follow the robot body axis.`, actionIndex,
        });
      }
      if (!translation.segmentIsFreeAtHeading(grid, from, to, footprint, interval, from.theta)) reject({
        code: 'motionplan.translation.collision', message: `Translation sweep ${actionIndex} is unsafe.`, actionIndex,
      });
      return;
    }
    if (action.type === 'ROTATE' || action.type === 'ROTATE_IN_PLACE') {
      if (distance > POSITION_TOLERANCE || from.direction !== to.direction) reject({
        code: 'motionplan.rotation.geometry', message: `Rotation ${actionIndex} must preserve position and direction state.`, actionIndex,
      });
      if (!rotation.rotationIsFree(grid, from, from.theta, to.theta, footprint, rotationStepRad)) reject({
        code: 'motionplan.rotation.collision', message: `Rotation sweep ${actionIndex} is unsafe.`, actionIndex,
      });
      return;
    }
    if (action.type === 'DIRECTION_CHANGE') {
      if (distance > POSITION_TOLERANCE || angularDistance(from.theta, to.theta) > ANGULAR_TOLERANCE || from.direction === to.direction) reject({
        code: 'motionplan.directionChange.geometry', message: `Direction change ${actionIndex} must only change direction state.`, actionIndex,
      });
      if (!reverseAllowed && to.direction === 'REVERSE') reject({
        code: 'motionplan.reverse.forbidden', message: `Direction change ${actionIndex} selects forbidden reverse motion.`, actionIndex,
      });
      return;
    }
    reject({ code: 'motionplan.action.unknown', message: `Action ${actionIndex} has an unknown transition type.`, actionIndex });
  }
}
