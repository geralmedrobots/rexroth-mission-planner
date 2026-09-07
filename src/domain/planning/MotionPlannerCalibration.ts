import { normalizeAngle } from '../geometry/angles';
import { measureMotionPlan, type MotionPlanMetrics } from '../motion/MotionPlanMetrics';
import type { MotionCostComponents, MotionPlan } from '../motion/planningModel';
import type { OccupancyGrid, PathPoint, PlannerResult, RobotFootprint } from '../types';
import type { EffectiveMotionStateConfiguration } from './MotionStateConfiguration';

export interface MotionPlannerCalibrationSnapshot {
  readonly schemaVersion: 'stage-4b';
  readonly plannerMode: 'motion-state';
  readonly map: {
    readonly mapId: string;
    readonly revision: string;
    readonly gridResolutionM: number;
    readonly width: number;
    readonly height: number;
  };
  readonly robot: {
    readonly footprintId: string;
    readonly footprintGeometryHash: string;
  };
  readonly request: {
    readonly startPose: PathPoint;
    readonly goalPose: PathPoint;
    readonly requestedGoalTheta?: number;
    readonly forwardAllowed: boolean;
    readonly reverseAllowed: boolean;
  };
  readonly effectiveParameters: EffectiveMotionStateConfiguration & {
    readonly translationTransitionStepM: number;
  };
  readonly result: {
    readonly success: boolean;
    readonly failureReason?: string;
    readonly planningDurationMs: number;
    readonly expandedStates: number;
    readonly planFingerprint?: string;
    readonly totalPathLengthM: number;
    readonly forwardPathLengthM: number;
    readonly reversePathLengthM: number;
    readonly totalAbsoluteRotationRad: number;
    readonly totalAbsoluteRotationDeg: number;
    readonly rotationActionCount: number;
    readonly directionChangeCount: number;
    readonly minimumClearanceM: number;
    readonly averageClearanceM: number;
    readonly costs: MotionCostComponents;
    readonly actionSequence: readonly string[];
    readonly actionSequenceTruncated: boolean;
  };
  readonly decisionSummary: {
    readonly reverseUsed: boolean;
    readonly reverseExplanation: string;
    readonly reverseActions: ReadonlyArray<{
      readonly actionIndex: number; readonly x: number; readonly y: number;
      readonly theta: number; readonly distanceM: number; readonly cost: number;
    }>;
    readonly directionChanges: ReadonlyArray<{
      readonly actionIndex: number; readonly x: number; readonly y: number;
      readonly from: string; readonly to: string;
    }>;
    readonly selectedRotationRad: number;
    readonly selectedRotationCost: number;
    readonly selectedReverseCost: number;
    readonly selectedWallClearanceCost: number;
    readonly optimiserRotationChangeRad: number;
    readonly selectedDecisionEvidence: readonly Record<string, unknown>[];
    readonly clearanceDistanceTradeoff?: Record<string, unknown>;
  };
}

const emptyCosts = (): MotionCostComponents => ({
  distance: 0, rotation: 0, reverse: 0, directionSwitch: 0,
  wallClearance: 0, narrowPassage: 0, turnLocation: 0,
  terminalOrientation: 0, total: 0,
});

const hashText = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const gridRevision = (grid: OccupancyGrid): string => {
  let hash = 0x811c9dc5;
  const metadata = JSON.stringify(grid.metadata);
  for (let index = 0; index < metadata.length; index += 1) {
    hash ^= metadata.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  for (const value of grid.data) {
    hash ^= (value + 256) & 0xffff;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const footprintHash = (footprint: RobotFootprint): string => hashText(JSON.stringify({
  length: footprint.length, width: footprint.width,
  centerOffsetX: footprint.centerOffsetX, centerOffsetY: footprint.centerOffsetY,
  safetyMargin: footprint.safetyMargin, polygon: footprint.polygon ?? null,
}));

export const motionPlanFingerprint = (plan: MotionPlan): string => `fnv1a32:${hashText(JSON.stringify({
  states: plan.states.map(({ x, y, theta, direction }) => ({ x, y,
    theta: normalizeAngle(theta), direction })),
  actions: plan.actions.map(({ type, distanceM, rotationRad, costComponents }) => ({
    type, distanceM, rotationRad, costComponents,
  })),
}))}`;

const metricsOrEmpty = (plan: MotionPlan | undefined, grid: OccupancyGrid,
  interval: number): MotionPlanMetrics => plan ? measureMotionPlan(plan, grid, interval) : {
    totalTranslationDistanceM: 0, totalReverseDistanceM: 0,
    totalAbsoluteRotationRad: 0, totalAbsoluteRotationDeg: 0,
    directionSwitchCount: 0, rotationActionCount: 0, translationActionCount: 0,
    minimumClearanceM: 0, averageClearanceM: 0, costs: emptyCosts(),
    actionSequenceSummary: [], actionSequenceTruncated: false,
  };

export interface CalibrationSnapshotInput {
  grid: OccupancyGrid;
  footprint: RobotFootprint;
  startPose: PathPoint;
  goalPose: PathPoint;
  goalTheta?: number;
  configuration: EffectiveMotionStateConfiguration;
  result: PlannerResult;
}

export const createMotionPlannerCalibrationSnapshot = (
  input: CalibrationSnapshotInput,
): MotionPlannerCalibrationSnapshot => {
  const metrics = metricsOrEmpty(input.result.motionPlan, input.grid,
    input.configuration.sampling.translationCollisionIntervalM);
  const footprintGeometryHash = footprintHash(input.footprint);
  const reverseActions = (input.result.motionPlan?.actions ?? []).flatMap((action, actionIndex) =>
    action.type === 'TRANSLATE_REVERSE' ? [{ actionIndex, x: action.from.x,
      y: action.from.y, theta: action.from.theta,
      distanceM: Math.hypot(action.to.x - action.from.x, action.to.y - action.from.y),
      cost: action.costComponents?.reverse ?? 0 }] : []).slice(0, 16);
  const directionChanges = (input.result.motionPlan?.actions ?? []).flatMap((action, actionIndex) =>
    action.type === 'DIRECTION_CHANGE' ? [{ actionIndex, x: action.from.x,
      y: action.from.y, from: action.from.direction, to: action.to.direction }] : [])
    .slice(0, 16);
  const selectedDiagnostic = input.result.motionPlan?.diagnostics?.selected as
    Record<string, unknown> | undefined;
  const optimisation = input.result.motionPlan?.diagnostics?.optimisation as
    Record<string, unknown> | undefined;
  return {
    schemaVersion: 'stage-4b', plannerMode: 'motion-state',
    map: { mapId: input.grid.metadata.mapId, revision: gridRevision(input.grid),
      gridResolutionM: input.grid.metadata.resolution, width: input.grid.metadata.width,
      height: input.grid.metadata.height },
    robot: { footprintId: `${input.footprint.source ?? 'configured'}:${footprintGeometryHash}`,
      footprintGeometryHash },
    request: {
      startPose: { x: input.startPose.x, y: input.startPose.y, theta: input.startPose.theta },
      goalPose: { x: input.goalPose.x, y: input.goalPose.y, theta: input.goalPose.theta },
      ...(input.goalTheta === undefined ? {} : { requestedGoalTheta: input.goalTheta }),
      forwardAllowed: input.configuration.permissions.forward,
      reverseAllowed: input.configuration.permissions.reverse,
    },
    effectiveParameters: { ...input.configuration,
      translationTransitionStepM: input.grid.metadata.resolution },
    result: {
      success: input.result.success, failureReason: input.result.error,
      planningDurationMs: input.result.statistics.durationMs,
      expandedStates: input.result.statistics.visitedCells,
      ...(input.result.motionPlan ? { planFingerprint:
        motionPlanFingerprint(input.result.motionPlan) } : {}),
      totalPathLengthM: metrics.totalTranslationDistanceM,
      forwardPathLengthM: metrics.totalTranslationDistanceM - metrics.totalReverseDistanceM,
      reversePathLengthM: metrics.totalReverseDistanceM,
      totalAbsoluteRotationRad: metrics.totalAbsoluteRotationRad,
      totalAbsoluteRotationDeg: metrics.totalAbsoluteRotationDeg,
      rotationActionCount: metrics.rotationActionCount,
      directionChangeCount: metrics.directionSwitchCount,
      minimumClearanceM: metrics.minimumClearanceM,
      averageClearanceM: metrics.averageClearanceM,
      costs: metrics.costs, actionSequence: metrics.actionSequenceSummary,
      actionSequenceTruncated: metrics.actionSequenceTruncated,
    },
    decisionSummary: {
      reverseUsed: metrics.totalReverseDistanceM > 0,
      reverseExplanation: metrics.totalReverseDistanceM > 0
        ? 'Reverse belongs to the lowest-cost physically feasible plan found under the captured parameters; inspect selected-decision alternatives for local evidence.'
        : 'The selected plan contains no reverse translation.',
      reverseActions, directionChanges,
      selectedRotationRad: metrics.totalAbsoluteRotationRad,
      selectedRotationCost: metrics.costs.rotation + metrics.costs.terminalOrientation,
      selectedReverseCost: metrics.costs.reverse,
      selectedWallClearanceCost: metrics.costs.wallClearance,
      optimiserRotationChangeRad: typeof optimisation?.rotationChangeRad === 'number'
        ? optimisation.rotationChangeRad : 0,
      selectedDecisionEvidence: Array.isArray(selectedDiagnostic?.selectedDecisionEvidence)
        ? selectedDiagnostic.selectedDecisionEvidence.slice(0, 12) as Record<string, unknown>[] : [],
      ...(selectedDiagnostic?.clearanceDistanceTradeoff &&
        typeof selectedDiagnostic.clearanceDistanceTradeoff === 'object'
        ? { clearanceDistanceTradeoff:
          selectedDiagnostic.clearanceDistanceTradeoff as Record<string, unknown> } : {}),
    },
  };
};
