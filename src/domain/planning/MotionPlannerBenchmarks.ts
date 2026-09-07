import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../defaults';
import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import type { MotionCostComponents } from '../motion/planningModel';
import type { OccupancyGrid, PathPoint, PlannerOptions, RobotFootprint } from '../types';
import { applyMotionPlannerCalibrationProfile,
  MOTION_PLANNER_CALIBRATION_PROFILES,
  type MotionPlannerCalibrationProfileName } from './MotionPlannerCalibrationProfiles';
import { createPlanningConfigurationSnapshot,
  type PlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';
import { replayMotionPlannerScenario, type MotionPlannerReplayScenario } from './MotionPlannerReplay';

export type MotionPlannerBenchmarkId = 'A_AHEAD_OPEN' | 'B_BEHIND_SIDE_OPEN' |
  'C_IMMEDIATELY_BEHIND' | 'D_UNSAFE_NEAR_ROTATION' | 'E_WIDER_CLEARANCE' |
  'F_NARROW_PASSAGE' | 'G_DIRECTION_SWITCH' | 'H_ROTATION_VS_SHORT_REVERSE' |
  'I_FINAL_THETA' | 'J_CLEARANCE_DISTANCE_ALTERNATIVES';

export interface MotionPlannerBenchmarkScenario extends MotionPlannerReplayScenario {
  readonly id: MotionPlannerBenchmarkId;
  readonly title: string;
  readonly expectation: string;
}

const grid = (id: string, resolution = .1, width = 60, height = 60): OccupancyGrid => ({
  metadata: { name: id, mapId: id, width, height, resolution,
    origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 65,
    freeThreshold: 25, negate: false },
  data: Array(width * height).fill(0),
});

const footprint = (): RobotFootprint => ({
  ...structuredClone(defaultFootprint), length: .2, width: .2,
  centerOffsetX: 0, centerOffsetY: 0, safetyMargin: 0, inflationRadius: 0,
  forwardAllowed: true, backwardAllowed: true, turnOnSpotAllowed: true,
  allowReverse: true, allowTurnOnSpot: true,
});

const options = (): PlannerOptions => ({
  ...structuredClone(defaultPlannerOptions), maxPlanningTimeMs: 5_000,
  passageSafety: { ...structuredClone(defaultPlannerOptions.passageSafety),
    planningSafetyMarginM: 0, localizationMarginM: 0 },
});

const pose = (map: OccupancyGrid, row: number, column: number,
  theta = 0): PathPoint => ({
  ...new CoordinateTransformer(map.metadata).gridToWorld(row, column), theta,
});

const occupyRectangle = (map: OccupancyGrid, rowFrom: number, rowTo: number,
  columnFrom: number, columnTo: number): void => {
  for (let row = rowFrom; row <= rowTo; row += 1) {
    for (let column = columnFrom; column <= columnTo; column += 1) {
      if (row >= 0 && column >= 0 && row < map.metadata.height &&
        column < map.metadata.width) map.data[row * map.metadata.width + column] = 100;
    }
  }
};

const configuration = (mapFootprint: RobotFootprint): PlanningConfigurationSnapshot =>
  createPlanningConfigurationSnapshot({ plannerOptions: options(),
    footprint: mapFootprint, orderSettings: defaultOrderSettings });

const scenario = (id: MotionPlannerBenchmarkId, title: string, expectation: string,
  map: OccupancyGrid, startPose: PathPoint, goalPose: PathPoint,
  goalTheta?: number): MotionPlannerBenchmarkScenario => {
  const robot = footprint();
  return { id, title, expectation, grid: map, footprint: robot, startPose,
    goalPose, goalTheta, configuration: configuration(robot),
    profileName: 'PRODUCTION_BASELINE' };
};

/** Synthetic, deterministic calibration fixtures; they are not physical validation. */
export const createMotionPlannerCalibrationBenchmarks = ():
readonly MotionPlannerBenchmarkScenario[] => {
  const a = grid('benchmark-a');
  const b = grid('benchmark-b');
  const c = grid('benchmark-c');
  const d = grid('benchmark-d');
  // Obstacle beside the start makes a local rotation sweep unsafe.
  occupyRectangle(d, 28, 31, 32, 33);
  const e = grid('benchmark-e');
  // Direct travel is feasible but stays beside this block; the upper side is open.
  occupyRectangle(e, 33, 35, 24, 44);
  const f = grid('benchmark-f');
  // 0.7 m corridor: above the hard minimum for the 0.2 m footprint.
  occupyRectangle(f, 25, 25, 15, 45);
  occupyRectangle(f, 33, 33, 15, 45);
  const g = grid('benchmark-g');
  occupyRectangle(g, 28, 32, 34, 36);
  const h = grid('benchmark-h');
  const i = grid('benchmark-i');
  const j = grid('benchmark-j');
  // Barrier with a short close lower opening and a longer, open upper route.
  occupyRectangle(j, 12, 42, 31, 33);
  // Open lower slot but place side obstacles so its clearance is deliberately low.
  for (let row = 34; row <= 37; row += 1) {
    for (let column = 31; column <= 33; column += 1) j.data[row * 60 + column] = 0;
  }
  occupyRectangle(j, 33, 33, 27, 37);
  occupyRectangle(j, 38, 38, 27, 37);

  return [
    scenario('A_AHEAD_OPEN', 'Ahead in open space',
      'Forward travel with essentially no rotation and no reverse.', a,
      pose(a, 30, 20, 0), pose(a, 30, 40, 0), 0),
    scenario('B_BEHIND_SIDE_OPEN', 'Moderately behind and sideways',
      'Compare modest rotation plus forward against reverse.', b,
      pose(b, 30, 30, 0), pose(b, 22, 22, 0)),
    scenario('C_IMMEDIATELY_BEHIND', 'Immediately behind',
      'A materially cheaper short reverse remains available.', c,
      pose(c, 30, 30, 0), pose(c, 30, 26, 0), 0),
    scenario('D_UNSAFE_NEAR_ROTATION', 'Unsafe near-obstacle rotation',
      'Translate away before rotating in safe space.', d,
      pose(d, 30, 30, 0), pose(d, 20, 42, Math.PI / 2), Math.PI / 2),
    scenario('E_WIDER_CLEARANCE', 'Straight versus wider clearance',
      'A slightly longer route can win for meaningful sustained clearance.', e,
      pose(e, 30, 18, 0), pose(e, 30, 48, 0)),
    scenario('F_NARROW_PASSAGE', 'Unavoidable valid narrow passage',
      'Remain feasible above the hard minimum regardless of soft cost.', f,
      pose(f, 29, 18, 0), pose(f, 29, 42, 0)),
    scenario('G_DIRECTION_SWITCH', 'Direction-switch alternative',
      'Avoid unnecessary forward/reverse oscillation.', g,
      pose(g, 30, 30, 0), pose(g, 30, 42, 0)),
    scenario('H_ROTATION_VS_SHORT_REVERSE', 'Rotation versus short reverse',
      'Neither reverse nor rotation dominates independently of magnitude.', h,
      pose(h, 30, 30, 0), pose(h, 27, 27, 0), 0),
    scenario('I_FINAL_THETA', 'Final orientation',
      'Reach requested theta locally without distorting the whole route.', i,
      pose(i, 30, 18, 0), pose(i, 30, 42, Math.PI / 2), Math.PI / 2),
    scenario('J_CLEARANCE_DISTANCE_ALTERNATIVES', 'Short/close versus long/open',
      'Expose the cost tradeoff without adding an obstacle-routing heuristic.', j,
      pose(j, 35, 18, 0), pose(j, 35, 47, 0)),
  ];
};

export interface MotionPlannerBenchmarkRow {
  scenario: MotionPlannerBenchmarkId;
  profile: string;
  success: boolean;
  planningDurationMs: number;
  expandedStates: number;
  totalCost: number;
  pathLengthM: number;
  forwardDistanceM: number;
  reverseDistanceM: number;
  rotationRad: number;
  rotationDeg: number;
  rotationActions: number;
  directionSwitches: number;
  minimumClearanceM: number;
  averageClearanceM: number;
  costs: MotionCostComponents;
  planFingerprint?: string;
  reverseEvidence: string;
}

export interface MotionPlannerBenchmarkVariant {
  name: string;
  configurationFor(scenario: MotionPlannerBenchmarkScenario): PlanningConfigurationSnapshot;
}

export const calibrationProfileVariants = ():
readonly MotionPlannerBenchmarkVariant[] => Object.values(
  MOTION_PLANNER_CALIBRATION_PROFILES).map((profile) => ({
  name: profile.name,
  configurationFor: (benchmark: MotionPlannerBenchmarkScenario) =>
    applyMotionPlannerCalibrationProfile(benchmark.configuration,
      benchmark.footprint, profile),
}));

export const runMotionPlannerCalibrationBenchmarks = (
  scenarios: readonly MotionPlannerBenchmarkScenario[],
  variants: readonly MotionPlannerBenchmarkVariant[],
): MotionPlannerBenchmarkRow[] => scenarios.flatMap((benchmark) => variants.map((variant) => {
  const replay = replayMotionPlannerScenario({ ...benchmark,
    configuration: variant.configurationFor(benchmark),
    profileName: variant.name as MotionPlannerCalibrationProfileName });
  const result = replay.metrics;
  return {
    scenario: benchmark.id, profile: variant.name, success: result.success,
    planningDurationMs: result.planningDurationMs,
    expandedStates: result.expandedStates, totalCost: result.costs.total,
    pathLengthM: result.totalPathLengthM,
    forwardDistanceM: result.forwardPathLengthM,
    reverseDistanceM: result.reversePathLengthM,
    rotationRad: result.totalAbsoluteRotationRad,
    rotationDeg: result.totalAbsoluteRotationDeg,
    rotationActions: result.rotationActionCount,
    directionSwitches: result.directionChangeCount,
    minimumClearanceM: result.minimumClearanceM,
    averageClearanceM: result.averageClearanceM,
    costs: result.costs, planFingerprint: result.planFingerprint,
    reverseEvidence: replay.calibration.decisionSummary.reverseExplanation,
  };
}));

const fixed = (value: number): string => Number.isFinite(value) ? value.toFixed(3) : 'n/a';

export const formatMotionPlannerCalibrationReport = (
  rows: readonly MotionPlannerBenchmarkRow[],
): string => {
  const header = '| scenario | profile | success | path m | reverse m | rotation deg | switches | min clearance m | avg clearance m | total cost |';
  const separator = '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.map((row) => `| ${row.scenario} | ${row.profile} | ${row.success} | ${fixed(row.pathLengthM)} | ${fixed(row.reverseDistanceM)} | ${fixed(row.rotationDeg)} | ${row.directionSwitches} | ${fixed(row.minimumClearanceM)} | ${fixed(row.averageClearanceM)} | ${fixed(row.totalCost)} |`);
  return [header, separator, ...body].join('\n');
};

export const findMotionPlannerBenchmarkRegressions = (
  rows: readonly MotionPlannerBenchmarkRow[],
): string[] => rows.flatMap((row) => {
  const benchmark = createMotionPlannerCalibrationBenchmarks()
    .find((candidate) => candidate.id === row.scenario);
  if (!row.success) return [`${row.scenario}/${row.profile}: planning failed`];
  const hardMinimum = benchmark?.configuration.normalized.motionState.clearance.hardMinimumM ?? 0;
  if (row.minimumClearanceM + 1e-9 < hardMinimum) {
    return [`${row.scenario}/${row.profile}: minimum clearance ${row.minimumClearanceM}m is below ${hardMinimum}m`];
  }
  if (row.scenario === 'A_AHEAD_OPEN' &&
    (row.reverseDistanceM > 1e-6 || row.rotationDeg > 1)) {
    return [`${row.scenario}/${row.profile}: unnecessary reverse or rotation in open space`];
  }
  if (row.scenario === 'G_DIRECTION_SWITCH' && row.directionSwitches > 1) {
    return [`${row.scenario}/${row.profile}: ${row.directionSwitches} direction switches`];
  }
  return [];
});
