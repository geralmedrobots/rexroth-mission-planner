import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { measureMotionPlan } from '../domain/motion/MotionPlanMetrics';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import { MotionStateGuide } from '../domain/planning/MotionStateGuide';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import { MotionPlanValidator } from '../domain/planner/MotionPlanValidator';
import type { OccupancyGrid, PlannerOptions, RobotFootprint, RobotPose } from '../domain/types';

const grid = (id: string, resolution = .1, width = 80, height = 80): OccupancyGrid => ({
  metadata: { name: id, mapId: id, width, height, resolution,
    origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 65,
    freeThreshold: 25, negate: false },
  data: Array(width * height).fill(0),
});
const pose = (map: OccupancyGrid, row: number, column: number,
  theta = 0): RobotPose => ({
  ...new CoordinateTransformer(map.metadata).gridToWorld(row, column), theta,
  mapId: map.metadata.mapId, positionInitialized: true,
});
const robot = (reverse = false, length = .4, width = .3): RobotFootprint => ({
  ...structuredClone(defaultFootprint), length, width, safetyMargin: 0,
  inflationRadius: 0, polygon: undefined, forwardAllowed: true,
  backwardAllowed: reverse, allowReverse: reverse,
  turnOnSpotAllowed: true, allowTurnOnSpot: true,
});
const options = (wallWeight = 0, preferredM = .3): PlannerOptions => ({
  ...structuredClone(defaultPlannerOptions), reliableBaselineMode: false,
  maxPlanningTimeMs: 3_000,
  passageSafety: { ...structuredClone(defaultPlannerOptions.passageSafety),
    planningSafetyMarginM: 0, localizationMarginM: 0,
    wallClearanceMinimumM: .05, wallClearancePreferredM: preferredM,
    wallProximityWeight: wallWeight, narrowPassageWeight: 0, turnLocationWeight: 0 },
});
const occupy = (map: OccupancyGrid, rowFrom: number, rowTo: number,
  columnFrom: number, columnTo: number): void => {
  for (let row = rowFrom; row <= rowTo; row += 1) for (let column = columnFrom;
    column <= columnTo; column += 1)
    map.data[row * map.metadata.width + column] = 100;
};
const plan = (map: OccupancyGrid, start: RobotPose, goal: RobotPose,
  footprint = robot(), plannerOptions = options(), goalTheta = goal.theta) => {
  const transform = new CoordinateTransformer(map.metadata);
  return new MotionStatePlanner().plan({ grid: map,
    start: transform.worldToGrid(start.x, start.y)!,
    goal: transform.worldToGrid(goal.x, goal.y)!, exactStartPose: start,
    exactGoalPose: goal, startTheta: start.theta, goalTheta,
    options: plannerOptions, footprint, plannerStrategy: 'motion-state' });
};
const selected = (result: ReturnType<typeof plan>): Record<string, unknown> =>
  result.motionPlan?.diagnostics?.selected as Record<string, unknown>;

describe('hierarchical guided motion-state planning', () => {
  it('uses an obstacle-aware guide when the Euclidean direction is wall-blocked', () => {
    const map = grid('hierarchical-wall');
    occupy(map, 12, 67, 39, 41);
    const start = pose(map, 40, 12, 0); const goal = pose(map, 40, 67, 0);
    const result = plan(map, start, goal);
    expect(result.success).toBe(true);
    expect(Number(selected(result).guideLengthM)).toBeGreaterThan(
      Math.hypot(goal.x - start.x, goal.y - start.y));
    expect(result.motionPlan!.states.some((state) => state.y > start.y + 2 ||
      state.y < start.y - 2)).toBe(true);
  });

  it('makes the advisory guide prefer sustained clearance', () => {
    const map = grid('hierarchical-clearance', .1, 60, 60);
    occupy(map, 33, 35, 24, 44);
    const startCell = { row: 30, column: 18 }; const goalCell = { row: 30, column: 48 };
    const footprint = robot();
    const build = (wallWeight: number) => {
      const configuration = createPlanningConfigurationSnapshot({
        plannerOptions: options(wallWeight, .8), footprint }).normalized.motionState;
      return new MotionStateGuide().build(map, startCell, goalCell, footprint, configuration);
    };
    const neutral = build(0); const preferred = build(12);
    const minimum = (guide: typeof neutral) => Math.min(...guide.cells.map((cell) =>
      guide.clearance[cell.row * map.metadata.width + cell.column]!));
    expect(minimum(preferred)).toBeGreaterThan(minimum(neutral));
  });

  it('widens a point-guide corridor when the robot cannot use its narrow opening', () => {
    const map = grid('hierarchical-widen');
    occupy(map, 20, 60, 39, 41);
    // Point guide uses this short opening; the 0.5 m-wide robot cannot.
    for (let row = 39; row <= 41; row += 1) for (let column = 39;
      column <= 41; column += 1) map.data[row * map.metadata.width + column] = 0;
    const result = plan(map, pose(map, 40, 14, 0), pose(map, 40, 66, 0),
      robot(false, .5, .5));
    expect(result.success).toBe(true);
    const completed = result.motionPlannerEvents?.filter((event) =>
      event.eventType === 'motionplanner.corridor.completed') ?? [];
    expect(completed[0]?.found).toBe(false);
    expect(completed.length).toBeGreaterThan(1);
    expect(completed.at(-1)?.found).toBe(true);
    expect(Number(selected(result).corridorWidthUsedM) >= 2.5 ||
      selected(result).unrestrictedFallbackRequired === true).toBe(true);
  });

  it('applies weighted guidance to reverse-enabled search', () => {
    const map = grid('hierarchical-reverse');
    const reverseOptions = options();
    reverseOptions.passageSafety.reverseRiskWeight = .01;
    reverseOptions.passageSafety.motionStateDirectionSwitchWeight = .01;
    const result = plan(map, pose(map, 40, 42, 0), pose(map, 40, 34, 0),
      robot(true), reverseOptions, 0);
    expect(result.success).toBe(true);
    expect(selected(result).weightedHeuristic).toBe(1.25);
    expect(result.motionPlan!.actions.some((action) =>
      action.type === 'TRANSLATE_REVERSE')).toBe(true);
  });

  it('uses an analytic connector and long primitive in open space', () => {
    const map = grid('hierarchical-open');
    const result = plan(map, pose(map, 40, 10, 0), pose(map, 40, 70, 0));
    expect(result.success).toBe(true);
    expect(Number(selected(result).analyticConnectorAttempts)).toBeGreaterThan(0);
    expect(Number(selected(result).analyticConnectorSuccesses)).toBeGreaterThan(0);

    const blocked = grid('hierarchical-primitive');
    occupy(blocked, 20, 60, 38, 42);
    const primitivePlan = plan(blocked, pose(blocked, 40, 10, 0), pose(blocked, 30, 70, 0));
    expect(primitivePlan.success).toBe(true);
    expect(Number(selected(primitivePlan).longPrimitiveTransitions)).toBeGreaterThan(0);
  });

  it('rejects a colliding connector, safely detours, and passes full validation', () => {
    const map = grid('hierarchical-connector-collision');
    occupy(map, 30, 50, 38, 42);
    const footprint = robot(); const plannerOptions = options();
    const result = plan(map, pose(map, 40, 12, 0), pose(map, 40, 68, 0),
      footprint, plannerOptions, 0);
    expect(result.success).toBe(true);
    expect(result.motionPlannerEvents?.some((event) =>
      event.eventType === 'motionplanner.transition.rejected' &&
      event.terminalConnector === true)).toBe(true);
    expect(new MotionPlanValidator().validate(result.motionPlan!, map, footprint,
      plannerOptions.collisionSampleInterval,
      plannerOptions.passageSafety.rotationCollisionSampleDeg * Math.PI / 180,
      false, 0).valid).toBe(true);
  });

  it('hits the guide cache and invalidates it for map and footprint changes', () => {
    const map = grid('hierarchical-cache', .1, 40, 40);
    const start = { row: 20, column: 5 }; const goal = { row: 20, column: 34 };
    const footprint = robot();
    const configuration = createPlanningConfigurationSnapshot({
      plannerOptions: options(), footprint }).normalized.motionState;
    const builder = new MotionStateGuide();
    expect(builder.build(map, start, goal, footprint, configuration).cacheHit).toBe(false);
    expect(builder.build(map, start, goal, footprint, configuration).cacheHit).toBe(true);
    map.data[5 * map.metadata.width + 5] = 100;
    expect(builder.build(map, start, goal, footprint, configuration).cacheHit).toBe(false);
    const wider = robot(false, .4, .4);
    const widerConfiguration = createPlanningConfigurationSnapshot({
      plannerOptions: options(), footprint: wider }).normalized.motionState;
    expect(builder.build(map, start, goal, wider, widerConfiguration).cacheHit).toBe(false);
  });

  it('keeps final path metrics finite after hierarchical planning', () => {
    const map = grid('hierarchical-metrics');
    const result = plan(map, pose(map, 50, 10, 0), pose(map, 20, 65, Math.PI / 2));
    const metrics = measureMotionPlan(result.motionPlan!, map,
      defaultPlannerOptions.collisionSampleInterval);
    expect(result.success).toBe(true);
    expect(metrics.costs.total).toBeGreaterThan(0);
    expect(metrics.minimumClearanceM).toBeGreaterThanOrEqual(0);
  });
});
