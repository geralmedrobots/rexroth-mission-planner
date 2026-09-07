import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import type { MotionPlan } from '../motion/planningModel';
import { planSynchronously } from '../planner/PlannerService';
import type { OccupancyGrid, PathPoint, PlannerResult, RobotFootprint } from '../types';
import type { MotionPlannerCalibrationSnapshot } from './MotionPlannerCalibration';
import { createPlanningConfigurationSnapshot,
  type PlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';

export interface MotionPlannerReplayScenario {
  grid: OccupancyGrid;
  footprint: RobotFootprint;
  startPose: PathPoint;
  goalPose: PathPoint;
  goalTheta?: number;
  configuration: PlanningConfigurationSnapshot;
}

export interface MotionPlannerReplayResult {
  motionPlan?: MotionPlan;
  calibration: MotionPlannerCalibrationSnapshot;
  metrics: MotionPlannerCalibrationSnapshot['result'];
  costBreakdown: MotionPlannerCalibrationSnapshot['result']['costs'];
  boundedDiagnostics: readonly Record<string, unknown>[];
  plannerResult: PlannerResult;
}

/** Headless replay through the exact production planner dispatcher and implementation. */
export const replayMotionPlannerScenario = (
  scenario: MotionPlannerReplayScenario,
): MotionPlannerReplayResult => {
  const grid = structuredClone(scenario.grid) as OccupancyGrid;
  // The scenario footprint is authoritative; variants supply planner values.
  // Re-normalizing also prevents a stale snapshot footprint from changing the
  // supposedly identical physical scenario in a comparison run.
  const configuration = createPlanningConfigurationSnapshot({
    plannerOptions: structuredClone(scenario.configuration.planner),
    footprint: structuredClone(scenario.footprint),
    orderSettings: structuredClone(scenario.configuration.order),
  });
  const transform = new CoordinateTransformer(grid.metadata);
  const start = transform.worldToGrid(scenario.startPose.x, scenario.startPose.y);
  const goal = transform.worldToGrid(scenario.goalPose.x, scenario.goalPose.y);
  if (!start || !goal) throw new Error('Replay start and goal must be inside the captured grid.');
  const plannerResult = planSynchronously({
    grid, collisionGrid: grid, start, goal,
    options: structuredClone(configuration.planner),
    footprint: structuredClone(scenario.footprint),
    exactStartPose: structuredClone(scenario.startPose),
    exactGoalPose: structuredClone(scenario.goalPose),
    startTheta: scenario.startPose.theta, goalTheta: scenario.goalTheta,
    planningConfiguration: configuration, plannerStrategy: 'motion-state',
  });
  const calibration = plannerResult.motionPlannerCalibration;
  if (!calibration) throw new Error('Production motion-state replay did not produce calibration data.');
  return {
    motionPlan: plannerResult.motionPlan, calibration, metrics: calibration.result,
    costBreakdown: calibration.result.costs,
    boundedDiagnostics: (plannerResult.motionPlannerEvents ?? []).slice(-32),
    plannerResult,
  };
};

export interface MotionPlannerConfigurationVariant {
  name: string;
  configuration: PlanningConfigurationSnapshot;
}

export interface MotionPlannerComparisonRow {
  configuration: string;
  success: boolean;
  totalCost: number;
  pathLengthM: number;
  reverseDistanceM: number;
  rotationRad: number;
  directionSwitches: number;
  minimumClearanceM: number;
  averageClearanceM: number;
  expandedStates: number;
  planFingerprint?: string;
}

/** Runs all supplied configurations; intentionally does not rank or select one. */
export const compareMotionPlannerConfigurations = (
  scenario: Omit<MotionPlannerReplayScenario, 'configuration'>,
  variants: readonly MotionPlannerConfigurationVariant[],
): MotionPlannerComparisonRow[] => variants.map((variant) => {
  const replay = replayMotionPlannerScenario({ ...scenario,
    configuration: variant.configuration });
  return {
    configuration: variant.name, success: replay.metrics.success,
    totalCost: replay.costBreakdown.total,
    pathLengthM: replay.metrics.totalPathLengthM,
    reverseDistanceM: replay.metrics.reversePathLengthM,
    rotationRad: replay.metrics.totalAbsoluteRotationRad,
    directionSwitches: replay.metrics.directionChangeCount,
    minimumClearanceM: replay.metrics.minimumClearanceM,
    averageClearanceM: replay.metrics.averageClearanceM,
    expandedStates: replay.metrics.expandedStates,
    planFingerprint: replay.metrics.planFingerprint,
  };
});
