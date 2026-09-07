import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { normalizeAngle } from '../geometry/angles';
import { buildMotionStateClearanceField } from '../planner/ClearanceField';
import type { OccupancyGrid } from '../types';
import type { MotionAction, MotionCostComponents, MotionPlan } from './planningModel';

export interface MotionPlanMetrics {
  totalTranslationDistanceM: number;
  totalReverseDistanceM: number;
  totalAbsoluteRotationRad: number;
  totalAbsoluteRotationDeg: number;
  directionSwitchCount: number;
  rotationActionCount: number;
  translationActionCount: number;
  minimumClearanceM: number;
  averageClearanceM: number;
  costs: MotionCostComponents;
  actionSequenceSummary: string[];
  actionSequenceTruncated: boolean;
}

const zeroCosts = (): MotionCostComponents => ({
  distance: 0, rotation: 0, reverse: 0, directionSwitch: 0,
  wallClearance: 0, narrowPassage: 0, turnLocation: 0,
  terminalOrientation: 0, total: 0,
});

const actionDistance = (action: MotionAction): number =>
  Math.hypot(action.to.x - action.from.x, action.to.y - action.from.y);
const angularDistance = (action: MotionAction): number =>
  Math.abs(normalizeAngle(action.to.theta - action.from.theta));

const summariseAction = (action: MotionAction): string => {
  if (action.type === 'TRANSLATE_FORWARD') return `F:${actionDistance(action).toFixed(3)}m`;
  if (action.type === 'TRANSLATE_REVERSE') return `B:${actionDistance(action).toFixed(3)}m`;
  if (action.type === 'DIRECTION_CHANGE')
    return `D:${action.from.direction[0]}-${action.to.direction[0]}`;
  return `R:${(angularDistance(action) * 180 / Math.PI).toFixed(1)}deg`;
};

/** Metrics are sampled from the same OccupancyGrid used by collision checking. */
export const measureMotionPlan = (
  plan: MotionPlan,
  grid: OccupancyGrid,
  sampleIntervalM: number,
  maximumSummaryActions = 64,
  clearanceField: Float32Array = buildMotionStateClearanceField(grid),
): MotionPlanMetrics => {
  const transform = new CoordinateTransformer(grid.metadata);
  const finiteMapClearance = Math.hypot(
    grid.metadata.width * grid.metadata.resolution,
    grid.metadata.height * grid.metadata.resolution,
  );
  const clearanceSamples: number[] = [];
  const sample = (x: number, y: number): void => {
    const cell = transform.worldToGrid(x, y);
    const value = cell ? clearanceField[transform.index(cell)] : 0;
    clearanceSamples.push(Number.isFinite(value) ? value! : finiteMapClearance);
  };
  if (plan.states[0]) sample(plan.states[0].x, plan.states[0].y);

  let totalTranslationDistanceM = 0;
  let totalReverseDistanceM = 0;
  let totalAbsoluteRotationRad = 0;
  let directionSwitchCount = 0;
  let rotationActionCount = 0;
  let translationActionCount = 0;
  const costs = zeroCosts();
  for (const action of plan.actions) {
    const distance = actionDistance(action);
    if (action.type === 'TRANSLATE_FORWARD' || action.type === 'TRANSLATE_REVERSE') {
      totalTranslationDistanceM += distance;
      if (action.type === 'TRANSLATE_REVERSE') totalReverseDistanceM += distance;
      translationActionCount += 1;
      const steps = Math.max(1, Math.ceil(distance /
        Math.max(sampleIntervalM, grid.metadata.resolution / 3)));
      for (let index = 1; index <= steps; index += 1) {
        const ratio = index / steps;
        sample(action.from.x + (action.to.x - action.from.x) * ratio,
          action.from.y + (action.to.y - action.from.y) * ratio);
      }
    } else {
      sample(action.to.x, action.to.y);
      if (action.type === 'DIRECTION_CHANGE') directionSwitchCount += 1;
      else {
        totalAbsoluteRotationRad += angularDistance(action);
        rotationActionCount += 1;
      }
    }
    if (action.costComponents) for (const key of Object.keys(costs) as Array<keyof MotionCostComponents>)
      costs[key] += action.costComponents[key];
  }
  const minimumClearanceM = clearanceSamples.length ? Math.min(...clearanceSamples) : 0;
  const averageClearanceM = clearanceSamples.length
    ? clearanceSamples.reduce((sum, value) => sum + value, 0) / clearanceSamples.length : 0;
  return {
    totalTranslationDistanceM, totalReverseDistanceM, totalAbsoluteRotationRad,
    totalAbsoluteRotationDeg: totalAbsoluteRotationRad * 180 / Math.PI,
    directionSwitchCount, rotationActionCount, translationActionCount,
    minimumClearanceM, averageClearanceM, costs,
    actionSequenceSummary: plan.actions.slice(0, maximumSummaryActions).map(summariseAction),
    actionSequenceTruncated: plan.actions.length > maximumSummaryActions,
  };
};
