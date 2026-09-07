import { normalizeAngle } from '../geometry/angles';
import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { measureMotionPlan, type MotionPlanMetrics } from '../motion/MotionPlanMetrics';
import type { MotionAction, MotionCostComponents, MotionPlan, MotionState } from '../motion/planningModel';
import { MotionPlanValidator } from '../planner/MotionPlanValidator';
import { buildMotionStateClearanceField } from '../planner/ClearanceField';
import type { OccupancyGrid, RobotFootprint } from '../types';
import type { EffectiveMotionStateConfiguration } from './MotionStateConfiguration';
import { CostModel } from './CostModel';

export interface MotionPlanOptimisationResult {
  plan: MotionPlan;
  inputMetrics: MotionPlanMetrics;
  metrics: MotionPlanMetrics;
  candidatesConsidered: number;
  candidatesAccepted: number;
  candidatesRejectedByValidation: number;
  candidatesRejectedByClearance: number;
}

const POSITION_TOLERANCE = 1e-7;
const ANGULAR_TOLERANCE = 1e-7;
const angularDistance = (left: number, right: number): number =>
  Math.abs(normalizeAngle(left - right));
const samePosition = (left: MotionState, right: MotionState): boolean =>
  Math.hypot(left.x - right.x, left.y - right.y) <= POSITION_TOLERANCE;

/**
 * Conservative post-processing for an already-selected motion-state route.
 * Each candidate is independently replayed with the complete footprint and is
 * accepted only when it preserves (or improves) both minimum and sampled
 * average clearance. It never derives body theta from an XY bearing.
 */
export class MotionPlanOptimiser {
  public optimise(
    source: MotionPlan,
    grid: OccupancyGrid,
    footprint: RobotFootprint,
    configuration: EffectiveMotionStateConfiguration,
    finalTheta?: number,
  ): MotionPlanOptimisationResult {
    const clearanceField = buildMotionStateClearanceField(grid);
    let plan = structuredClone(source) as MotionPlan;
    const inputMetrics = measureMotionPlan(plan, grid,
      configuration.sampling.translationCollisionIntervalM, 64,
      clearanceField);
    let metrics = inputMetrics;
    let candidatesConsidered = 0;
    let candidatesAccepted = 0;
    let candidatesRejectedByValidation = 0;
    let candidatesRejectedByClearance = 0;

    const consider = (candidate: MotionPlan): boolean => {
      candidatesConsidered += 1;
      const checked = new MotionPlanValidator().validate(candidate, grid, footprint,
        configuration.sampling.translationCollisionIntervalM,
        configuration.sampling.rotationCollisionIntervalRad,
        configuration.permissions.reverse, finalTheta);
      if (!checked.valid) {
        candidatesRejectedByValidation += 1;
        return false;
      }
      const candidateMetrics = measureMotionPlan(candidate, grid,
        configuration.sampling.translationCollisionIntervalM, 64, clearanceField);
      const hardMinimum = configuration.clearance.hardMinimumM;
      if (candidateMetrics.minimumClearanceM + 1e-6 < hardMinimum ||
        candidateMetrics.minimumClearanceM + 1e-6 < metrics.minimumClearanceM ||
        candidateMetrics.averageClearanceM + 1e-6 < metrics.averageClearanceM) {
        candidatesRejectedByClearance += 1;
        return false;
      }
      plan = candidate;
      metrics = candidateMetrics;
      candidatesAccepted += 1;
      return true;
    };

    // Remove rotations that are below numerical motion tolerance. Relinking is
    // validated, so even a tiny heading needed by an adjacent translation stays.
    for (let index = 0; index < plan.actions.length;) {
      const action = plan.actions[index]!;
      if ((action.type === 'ROTATE' || action.type === 'ROTATE_IN_PLACE') &&
        samePosition(action.from, action.to) &&
        angularDistance(action.from.theta, action.to.theta) <= ANGULAR_TOLERANCE) {
        const candidate = this.withoutAction(plan, index);
        if (consider(candidate)) continue;
      }
      index += 1;
    }

    // Collapse consecutive collinear translations without changing direction,
    // heading, or endpoints. Costs are re-integrated over accepted geometry.
    for (let index = 0; index < plan.actions.length - 1;) {
      const first = plan.actions[index]!;
      const second = plan.actions[index + 1]!;
      if (this.compatibleTranslations(first, second)) {
        const replacement: MotionAction = {
          type: first.type, from: first.from, to: second.to,
          distanceM: Math.hypot(second.to.x - first.from.x, second.to.y - first.from.y),
          costComponents: this.translationComponents(first.from, second.to,
            first.type === 'TRANSLATE_REVERSE', grid, configuration, clearanceField),
          metadata: { ...first.metadata, optimised: 'merged-compatible-translations' },
        };
        if (consider(this.replaceActions(plan, index, index + 1, replacement))) continue;
      }
      index += 1;
    }

    // A geometric shortcut is only considered across motion with one unchanged
    // direction and identical endpoint body theta. Full validation proves the
    // swept translation; the clearance gate prevents erasing a wider route.
    for (let start = 0; start < plan.actions.length - 2; start += 1) {
      for (let end = plan.actions.length - 1; end >= start + 2; end -= 1) {
        const removed = plan.actions.slice(start, end + 1);
        const from = plan.states[start]!;
        const to = plan.states[end + 1]!;
        if (!this.shortcutSemanticsMatch(removed, from, to)) continue;
        const type = from.direction === 'REVERSE' ? 'TRANSLATE_REVERSE' : 'TRANSLATE_FORWARD';
        const replacement: MotionAction = {
          type, from, to,
          distanceM: Math.hypot(to.x - from.x, to.y - from.y),
          costComponents: this.translationComponents(from, to,
            type === 'TRANSLATE_REVERSE', grid, configuration, clearanceField),
          metadata: { optimised: 'clearance-preserving-footprint-shortcut' },
        };
        if (consider(this.replaceActions(plan, start, end, replacement))) break;
      }
    }

    plan.metadata = { ...plan.metadata, optimised: true,
      optimiserVersion: 'motion-state-stage-5' };
    plan.diagnostics = { ...plan.diagnostics, optimisation: {
      candidatesConsidered, candidatesAccepted, candidatesRejectedByValidation,
      candidatesRejectedByClearance,
      rotationChangeRad: metrics.totalAbsoluteRotationRad -
        inputMetrics.totalAbsoluteRotationRad,
      rotationActionChange: metrics.rotationActionCount - inputMetrics.rotationActionCount,
    } };
    return { plan, inputMetrics, metrics, candidatesConsidered, candidatesAccepted,
      candidatesRejectedByValidation, candidatesRejectedByClearance };
  }

  private compatibleTranslations(first: MotionAction, second: MotionAction): boolean {
    return (first.type === 'TRANSLATE_FORWARD' || first.type === 'TRANSLATE_REVERSE') &&
      second.type === first.type && first.to.direction === second.from.direction &&
      first.from.direction === first.to.direction && second.from.direction === second.to.direction &&
      angularDistance(first.from.theta, first.to.theta) <= ANGULAR_TOLERANCE &&
      angularDistance(first.from.theta, second.from.theta) <= ANGULAR_TOLERANCE &&
      angularDistance(first.from.theta, second.to.theta) <= ANGULAR_TOLERANCE;
  }

  /** Re-integrates physical per-metre costs after geometry changes. */
  private translationComponents(from: MotionState, to: MotionState, reverse: boolean,
    grid: OccupancyGrid, configuration: EffectiveMotionStateConfiguration,
    clearanceField: Float32Array): MotionCostComponents {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const components: MotionCostComponents = {
      distance: CostModel.distance(distance, configuration.weights.translationCostPerM),
      rotation: 0,
      reverse: CostModel.motionStateReverseRisk(reverse, distance,
        configuration.weights.reverseCostPerM),
      directionSwitch: 0, wallClearance: 0, narrowPassage: 0,
      turnLocation: 0, terminalOrientation: 0, total: 0,
    };
    const transform = new CoordinateTransformer(grid.metadata);
    const samples = Math.max(1, Math.ceil(distance / grid.metadata.resolution));
    const sampleDistance = distance / samples;
    for (let index = 0; index < samples; index += 1) {
      const ratio = (index + .5) / samples;
      const cell = transform.worldToGrid(from.x + (to.x - from.x) * ratio,
        from.y + (to.y - from.y) * ratio);
      const clearance = cell ? clearanceField[transform.index(cell)] ?? 0 : 0;
      components.wallClearance += CostModel.motionStateWallProximity(clearance,
        configuration.clearance.preferredM, sampleDistance,
        configuration.weights.wallClearanceCost);
      components.narrowPassage += CostModel.motionStateNarrowPassage(clearance,
        configuration.footprint.widthM, configuration.footprint.effectiveSafetyMarginM,
        configuration.passage.maximumWidthM, sampleDistance,
        configuration.weights.narrowPassageCost);
    }
    components.total = components.distance + components.reverse +
      components.wallClearance + components.narrowPassage;
    return components;
  }

  private shortcutSemanticsMatch(actions: MotionAction[], from: MotionState,
    to: MotionState): boolean {
    if (!actions.some((action) => action.type === 'TRANSLATE_FORWARD' ||
      action.type === 'TRANSLATE_REVERSE')) return false;
    if (from.direction !== to.direction || angularDistance(from.theta, to.theta) > ANGULAR_TOLERANCE)
      return false;
    return actions.every((action) => action.type !== 'DIRECTION_CHANGE' &&
      action.from.direction === from.direction && action.to.direction === from.direction);
  }

  private withoutAction(plan: MotionPlan, actionIndex: number): MotionPlan {
    const states = [...plan.states.slice(0, actionIndex + 1),
      ...plan.states.slice(actionIndex + 2)];
    const actions = [...plan.actions.slice(0, actionIndex),
      ...plan.actions.slice(actionIndex + 1)];
    return this.relink(plan, states, actions);
  }

  private replaceActions(plan: MotionPlan, first: number, last: number,
    replacement: MotionAction): MotionPlan {
    const states = [...plan.states.slice(0, first + 1), ...plan.states.slice(last + 1)];
    const actions = [...plan.actions.slice(0, first), replacement,
      ...plan.actions.slice(last + 1)];
    return this.relink(plan, states, actions);
  }

  private relink(plan: MotionPlan, states: MotionState[], actions: MotionAction[]): MotionPlan {
    return {
      ...plan, states,
      actions: actions.map((action, index) => ({ ...action,
        from: { ...states[index]! }, to: { ...states[index + 1]! },
      })),
    };
  }
}
