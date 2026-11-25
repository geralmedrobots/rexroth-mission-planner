import { normalizeAngle } from '../geometry/angles';
import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { measureMotionPlan, type MotionPlanMetrics } from '../motion/MotionPlanMetrics';
import type { MotionAction, MotionCostComponents, MotionPlan, MotionState } from '../motion/planningModel';
import { MotionPlanValidator } from '../planner/MotionPlanValidator';
import { buildMotionStateClearanceField } from '../planner/ClearanceField';
import { TranslationSweepChecker } from '../planner/TranslationSweepChecker';
import type { OccupancyGrid, RobotFootprint } from '../types';
import type { EffectiveMotionStateConfiguration } from './MotionStateConfiguration';
import { CostModel } from './CostModel';
import { recomputeDirectionPreference } from './DirectionPreference';

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
const SHORT_TRANSLATION_MULTIPLIER = 1.5;
const angularDistance = (left: number, right: number): number =>
  Math.abs(normalizeAngle(left - right));
const samePosition = (left: MotionState, right: MotionState): boolean =>
  Math.hypot(left.x - right.x, left.y - right.y) <= POSITION_TOLERANCE;

/**
 * Conservative post-processing for an already-selected motion-state route.
 * It coalesces uninterrupted body-axis translation runs and accepts only
 * geometry-screened shortcuts. Each replacement is sweep-checked with the
 * full footprint; the caller still independently validates the final plan.
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
    recomputeDirectionPreference(plan, configuration.weights.directionSwitchCost);
    const inputMetrics = measureMotionPlan(plan, grid,
      configuration.sampling.translationCollisionIntervalM, 64,
      clearanceField);
    let metrics = inputMetrics;
    let candidatesConsidered = 0;
    let candidatesAccepted = 0;
    let candidatesRejectedByValidation = 0;
    let candidatesRejectedByClearance = 0;

    const consider = (candidate: MotionPlan, merged?: MotionAction,
      preserveRouteClearance = false): boolean => {
      candidatesConsidered += 1;
      recomputeDirectionPreference(candidate, configuration.weights.directionSwitchCost);
      // Merging a straight run cannot change any retained transition. Checking
      // just its new swept segment avoids replaying the whole plan O(n^2)
      // times. The complete MotionPlanValidator replay remains mandatory in
      // MotionStatePlanner and immediately before publishing.
      const valid = merged ? this.translationIsSafe(merged, grid, footprint, configuration) :
        new MotionPlanValidator().validate(candidate, grid, footprint,
          configuration.sampling.translationCollisionIntervalM,
          configuration.sampling.rotationCollisionIntervalRad,
          configuration.permissions.reverse, finalTheta).valid;
      if (!valid) {
        candidatesRejectedByValidation += 1;
        return false;
      }
      const candidateMetrics = measureMotionPlan(candidate, grid,
        configuration.sampling.translationCollisionIntervalM, 64, clearanceField);
      const hardMinimum = configuration.clearance.hardMinimumM;
      if (candidateMetrics.minimumClearanceM + 1e-6 < hardMinimum ||
        (preserveRouteClearance && (candidateMetrics.minimumClearanceM + 1e-6 <
          metrics.minimumClearanceM || candidateMetrics.averageClearanceM + 1e-6 <
          metrics.averageClearanceM))) {
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

    // The lattice exposes a one-bin-at-a-time turn as one action per bin.
    // Those actions do not represent separate physical manoeuvres when they
    // share a pose. Coalesce them only after checking the complete swept
    // rotation; this preserves the stricter of the original checks.
    for (let index = 0; index < plan.actions.length - 1;) {
      const first = plan.actions[index]!;
      const second = plan.actions[index + 1]!;
      if (!this.isRotation(first) || !this.isRotation(second) ||
        !samePosition(first.to, second.from)) {
        index += 1;
        continue;
      }
      const merged: MotionAction = {
        type: 'ROTATE_IN_PLACE', from: first.from, to: second.to,
        rotationRad: angularDistance(first.from.theta, second.to.theta),
        costComponents: this.addCosts(first.costComponents, second.costComponents),
        metadata: { ...first.metadata, ...second.metadata,
          optimised: 'merged-consecutive-rotations' },
      };
      if (consider(this.replaceActions(plan, index, index + 1, merged))) continue;
      index += 1;
    }

    // A connector can produce ROTATE -> one grid step -> ROTATE. Try the only
    // exact endpoint-preserving simplifications: do the final rotation before
    // the translation, or do the translation before the final rotation. Both
    // candidates still go through the normal footprint sweep and full-plan
    // validator, so this is never a clearance relaxation.
    for (let index = 0; index < plan.actions.length - 2; index += 1) {
      const first = plan.actions[index]!;
      const translation = plan.actions[index + 1]!;
      const last = plan.actions[index + 2]!;
      if (!this.isRotation(first) || !this.isTranslation(translation) ||
        !this.isRotation(last) ||
        Math.hypot(translation.to.x - translation.from.x,
          translation.to.y - translation.from.y) >
          Math.max(grid.metadata.resolution * SHORT_TRANSLATION_MULTIPLIER,
            configuration.sampling.translationCollisionIntervalM) ||
        !samePosition(first.to, translation.from) ||
        !samePosition(translation.to, last.from)) continue;

      const beforeTranslation = this.makeRotationThenTranslation(first, translation,
        last, grid, footprint, configuration, clearanceField);
      if (beforeTranslation && consider(this.replaceActionList(plan, index, index + 2,
        beforeTranslation))) continue;
      const afterTranslation = this.makeTranslationThenRotation(first, translation,
        last, grid, footprint, configuration, clearanceField);
      if (afterTranslation && consider(this.replaceActionList(plan, index, index + 2,
        afterTranslation))) continue;
    }

    // Collapse each maximal straight run in one pass. The old pairwise pass
    // repeatedly rebuilt and fully replayed the complete plan; the following
    // run-level pass produces one meaningful VDA translation per motion change.
    for (let index = 0; index < plan.actions.length - 1;) {
      const first = plan.actions[index]!;
      let last = index;
      while (last + 1 < plan.actions.length &&
        this.compatibleTranslations(plan.actions[last]!, plan.actions[last + 1]!)) last += 1;
      if (last > index) {
        const final = plan.actions[last]!;
        const sourceDistance = plan.actions.slice(index, last + 1).reduce((total, action) =>
          total + Math.hypot(action.to.x - action.from.x, action.to.y - action.from.y), 0);
        const mergedDistance = Math.hypot(final.to.x - first.from.x, final.to.y - first.from.y);
        // A terminal connector can share a heading bin while still carrying a
        // small grid-quantisation offset. It is not a straight run: merging it
        // would silently shorten the calibrated physical distance.
        if (Math.abs(sourceDistance - mergedDistance) > POSITION_TOLERANCE) {
          index += 1;
          continue;
        }
        const replacement: MotionAction = {
          type: first.type, from: first.from, to: final.to,
          distanceM: mergedDistance,
          costComponents: this.translationComponents(first.from, final.to,
            first.type === 'TRANSLATE_REVERSE', grid, configuration, clearanceField),
          metadata: { ...first.metadata, optimised: 'merged-compatible-translations' },
        };
        if (consider(this.replaceActions(plan, index, last, replacement), replacement)) {
          index += 1;
          continue;
        }
      }
      index += 1;
    }

    // Consider only the longest valid body-axis shortcut from each retained
    // state. This keeps the useful old smoothing behaviour without spending
    // quadratic whole-plan validation on candidates that cannot be a legal
    // translation in the first place.
    for (let start = 0; start < plan.actions.length - 2; start += 1) {
      for (let end = plan.actions.length - 1; end >= start + 2; end -= 1) {
        const removed = plan.actions.slice(start, end + 1);
        const from = plan.states[start]!;
        const to = plan.states[end + 1]!;
        if (!this.shortcutSemanticsMatch(removed, from, to)) continue;
        const type = from.direction === 'REVERSE' ? 'TRANSLATE_REVERSE' : 'TRANSLATE_FORWARD';
        const replacement: MotionAction = {
          type, from, to, distanceM: Math.hypot(to.x - from.x, to.y - from.y),
          costComponents: this.translationComponents(from, to,
            type === 'TRANSLATE_REVERSE', grid, configuration, clearanceField),
          metadata: { optimised: 'clearance-preserving-footprint-shortcut' },
        };
        // Reject before reconstructing/relinking whenever this cannot be a
        // physically valid body-axis translation.
        if (!this.translationIsSafe(replacement, grid, footprint, configuration)) continue;
        if (consider(this.replaceActions(plan, start, end, replacement), replacement, true)) break;
      }
    }

    plan.metadata = { ...plan.metadata, optimised: true,
      optimiserVersion: 'motion-state-stage-5' };
    // Keep action endpoints value-equal but reference-independent from states.
    // This also prevents downstream diagnostics or tests from mutating a state
    // through an action endpoint alias.
    plan = this.relink(plan, plan.states, plan.actions);
    plan.diagnostics = { ...plan.diagnostics, retainedRotations:
      this.rotationDiagnostics(plan), rotationOptimisation: {
        shortTranslationThresholdM: Math.max(grid.metadata.resolution *
          SHORT_TRANSLATION_MULTIPLIER, configuration.sampling.translationCollisionIntervalM),
        rule: 'Only exact endpoint-preserving, independently swept-validated replacements are accepted.',
      } };
    plan.diagnostics = { ...plan.diagnostics, optimisation: {
      candidatesConsidered, candidatesAccepted, candidatesRejectedByValidation,
      candidatesRejectedByClearance,
      inputRotationActionCount: inputMetrics.rotationActionCount,
      outputRotationActionCount: metrics.rotationActionCount,
      inputTotalAbsoluteRotationRad: inputMetrics.totalAbsoluteRotationRad,
      outputTotalAbsoluteRotationRad: metrics.totalAbsoluteRotationRad,
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

  private isRotation(action: MotionAction): boolean {
    return action.type === 'ROTATE' || action.type === 'ROTATE_IN_PLACE';
  }

  private isTranslation(action: MotionAction): boolean {
    return action.type === 'TRANSLATE_FORWARD' || action.type === 'TRANSLATE_REVERSE';
  }

  private addCosts(left?: MotionCostComponents, right?: MotionCostComponents): MotionCostComponents | undefined {
    if (!left && !right) return undefined;
    const result = { ...(left ?? right!) };
    for (const key of Object.keys(result) as Array<keyof MotionCostComponents>)
      result[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0);
    return result;
  }

  private makeRotationThenTranslation(first: MotionAction, translation: MotionAction,
    last: MotionAction, grid: OccupancyGrid, footprint: RobotFootprint,
    configuration: EffectiveMotionStateConfiguration, clearanceField: Float32Array): MotionAction[] | undefined {
    const rotation: MotionAction = { type: 'ROTATE_IN_PLACE', from: first.from,
      to: { ...first.from, theta: last.to.theta },
      rotationRad: angularDistance(first.from.theta, last.to.theta),
      metadata: { ...first.metadata, optimised: 'short-translation-final-heading' } };
    const moved: MotionAction = { ...translation, from: rotation.to, to: last.to,
      distanceM: Math.hypot(last.to.x - rotation.to.x, last.to.y - rotation.to.y),
      costComponents: this.translationComponents(rotation.to, last.to,
        translation.type === 'TRANSLATE_REVERSE', grid, configuration, clearanceField),
      metadata: { ...translation.metadata, optimised: 'short-translation-final-heading' } };
    return this.translationIsSafe(moved, grid, footprint, configuration) &&
      angularDistance(moved.to.theta, last.to.theta) <= ANGULAR_TOLERANCE ? [rotation, moved] : undefined;
  }

  private makeTranslationThenRotation(first: MotionAction, translation: MotionAction,
    last: MotionAction, grid: OccupancyGrid, footprint: RobotFootprint,
    configuration: EffectiveMotionStateConfiguration, clearanceField: Float32Array): MotionAction[] | undefined {
    const moved: MotionAction = { ...translation, from: first.from, to: {
      ...last.to, theta: first.from.theta,
    }, distanceM: Math.hypot(last.to.x - first.from.x, last.to.y - first.from.y),
    costComponents: this.translationComponents(first.from, last.to,
      translation.type === 'TRANSLATE_REVERSE', grid, configuration, clearanceField),
    metadata: { ...translation.metadata, optimised: 'short-translation-original-heading' } };
    const rotation: MotionAction = { type: 'ROTATE_IN_PLACE', from: moved.to, to: last.to,
      rotationRad: angularDistance(first.from.theta, last.to.theta),
      metadata: { ...last.metadata, optimised: 'short-translation-original-heading' } };
    return this.translationIsSafe(moved, grid, footprint, configuration) ? [moved, rotation] : undefined;
  }

  private rotationDiagnostics(plan: MotionPlan): Array<Record<string, unknown>> {
    return plan.actions.flatMap((action, index) => {
      if (!this.isRotation(action)) return [];
      const previous = plan.actions[index - 1];
      const next = plan.actions[index + 1];
      let reason = 'required-to-change-body-heading';
      if (action.metadata?.finalOrientation || action.metadata?.terminalConnector)
        reason = 'required-terminal-orientation-or-connector';
      else if (previous && this.isTranslation(previous)) reason = 'required-after-translation-heading-change';
      else if (next && this.isTranslation(next)) reason = 'required-before-translation-heading';
      return [{ actionIndex: index, angleDeg: (action.rotationRad ??
        angularDistance(action.from.theta, action.to.theta)) * 180 / Math.PI,
        reason, clearanceM: action.metadata?.clearanceM,
        sweptValidation: 'retained-plan-is-revalidated-by-MotionPlanValidator' }];
    });
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

  private translationIsSafe(action: MotionAction, grid: OccupancyGrid,
    footprint: RobotFootprint, configuration: EffectiveMotionStateConfiguration): boolean {
    if (action.type !== 'TRANSLATE_FORWARD' && action.type !== 'TRANSLATE_REVERSE') return false;
    const expected = action.type === 'TRANSLATE_REVERSE' ?
      normalizeAngle(action.from.theta + Math.PI) : action.from.theta;
    const bearing = Math.atan2(action.to.y - action.from.y, action.to.x - action.from.x);
    return angularDistance(action.from.theta, action.to.theta) <= ANGULAR_TOLERANCE &&
      angularDistance(bearing, expected) <= ANGULAR_TOLERANCE &&
      new TranslationSweepChecker().segmentIsFreeAtHeading(grid, action.from, action.to,
        footprint, configuration.sampling.translationCollisionIntervalM, action.from.theta);
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

  private replaceActionList(plan: MotionPlan, first: number, last: number,
    replacements: MotionAction[]): MotionPlan {
    const states = [...plan.states.slice(0, first),
      replacements.length ? replacements[0]!.from : plan.states[first]!,
      ...replacements.map((action) => action.to),
      ...plan.states.slice(last + 2)];
    const actions = [...plan.actions.slice(0, first), ...replacements,
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
