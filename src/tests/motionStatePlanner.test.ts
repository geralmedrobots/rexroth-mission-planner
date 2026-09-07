import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import type { MotionPlan } from '../domain/motion/planningModel';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import { MotionPlanValidator } from '../domain/planner/MotionPlanValidator';
import { PoseCollisionChecker } from '../domain/planner/PoseCollisionChecker';
import { RotationSweepChecker } from '../domain/planner/RotationSweepChecker';
import type { OccupancyGrid, PlannerOptions, RobotFootprint, RobotPose } from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';

const makeGrid = (resolution = .1, width = 70, height = 70): OccupancyGrid => ({
  metadata: { name: 'motion-state-test', mapId: 'motion-state-test', width, height,
    resolution, origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 65,
    freeThreshold: 25, negate: false },
  data: Array(width * height).fill(0),
});
const cellPose = (grid: OccupancyGrid, row: number, column: number, theta = 0): RobotPose => ({
  ...new CoordinateTransformer(grid.metadata).gridToWorld(row, column), theta,
  mapId: grid.metadata.mapId, positionInitialized: true,
});
const occupyWorld = (grid: OccupancyGrid, x: number, y: number): void => {
  const transform = new CoordinateTransformer(grid.metadata);
  const cell = transform.worldToGrid(x, y);
  if (!cell) throw new Error(`Test obstacle (${x}, ${y}) is outside the map.`);
  grid.data[transform.index(cell)] = 100;
};
const rectangle = (length = .4, width = .2, reverse = true): RobotFootprint => ({
  ...structuredClone(defaultFootprint), length, width, safetyMargin: 0,
  inflationRadius: 0, allowReverse: reverse, backwardAllowed: reverse,
  forwardAllowed: true, allowTurnOnSpot: true, turnOnSpotAllowed: true,
});
const options = (reverseWeight = 2): PlannerOptions => ({
  ...structuredClone(defaultPlannerOptions), policy: 'balanced', reliableBaselineMode: false,
  maxPlanningTimeMs: 5_000,
  passageSafety: { ...structuredClone(defaultPlannerOptions.passageSafety),
    reverseRiskWeight: reverseWeight, wallProximityWeight: 0, narrowPassageWeight: 0,
    turnLocationWeight: 0, motionStateDirectionSwitchWeight: reverseWeight * .5,
    planningSafetyMarginM: 0, localizationMarginM: 0 },
});
const plan = (grid: OccupancyGrid, start: RobotPose, goal: RobotPose,
  footprint = rectangle(), plannerOptions = options(), goalTheta = goal.theta) => {
  const transform = new CoordinateTransformer(grid.metadata);
  return new MotionStatePlanner().plan({
    grid, start: transform.worldToGrid(start.x, start.y)!,
    goal: transform.worldToGrid(goal.x, goal.y)!, exactStartPose: start,
    exactGoalPose: goal, startTheta: start.theta, goalTheta,
    options: plannerOptions, footprint, plannerStrategy: 'motion-state',
  });
};
const actionTypes = (motionPlan: MotionPlan): string[] =>
  motionPlan.actions.map((action) => action.type);

describe('MotionStatePlanner architecture', () => {
  it('A. prefers rotate-here when the sweep is safe', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 30, 0);
    const goal = cellPose(grid, 25, 30, Math.PI / 2);
    const result = plan(grid, start, goal, rectangle(), options(), Math.PI / 2);
    expect(result.success).toBe(true);
    expect(result.motionPlan!.actions[0]?.type).toBe('ROTATE_IN_PLACE');
    expect(result.motionPlan!.actions.find((action) => action.type.startsWith('TRANSLATE'))?.type)
      .toBe('TRANSLATE_FORWARD');
  });

  it('B. discovers reverse-first when rotating and forward translation at start are unsafe', () => {
    const grid = makeGrid(.05, 140, 140);
    const footprint = rectangle(.8, .3, true);
    const start = cellPose(grid, 70, 70, 0);
    const goal = cellPose(grid, 50, 60, Math.PI / 2);
    occupyWorld(grid, start.x + .25, start.y + .25);
    occupyWorld(grid, start.x + .45, start.y);
    const rotation = new RotationSweepChecker(new PoseCollisionChecker());
    expect(rotation.rotationIsFree(grid, start, 0, Math.PI / 2, footprint, Math.PI / 36)).toBe(false);
    const result = plan(grid, start, goal, footprint, options(0.05), Math.PI / 2);
    expect(result.success).toBe(true);
    const types = actionTypes(result.motionPlan!);
    expect(types.indexOf('TRANSLATE_REVERSE')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('TRANSLATE_REVERSE')).toBeLessThan(types.indexOf('ROTATE_IN_PLACE'));
  });

  it('C. discovers forward-first when rotating and reverse translation at start are unsafe', () => {
    const grid = makeGrid(.05, 140, 140);
    const footprint = rectangle(.8, .3, true);
    const start = cellPose(grid, 70, 70, 0);
    const goal = cellPose(grid, 50, 80, Math.PI / 2);
    occupyWorld(grid, start.x + .25, start.y + .25);
    occupyWorld(grid, start.x - .45, start.y);
    const result = plan(grid, start, goal, footprint, options(0.05), Math.PI / 2);
    expect(result.success).toBe(true);
    const types = actionTypes(result.motionPlan!);
    expect(types.indexOf('TRANSLATE_FORWARD')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('TRANSLATE_FORWARD')).toBeLessThan(types.indexOf('ROTATE_IN_PLACE'));
  });

  it('D. does not generate reverse transitions when reverse is disabled', () => {
    const grid = makeGrid();
    const footprint = rectangle(.4, .2, false);
    const start = cellPose(grid, 35, 25, 0);
    const goal = cellPose(grid, 35, 40, 0);
    const result = plan(grid, start, goal, footprint);
    expect(result.success).toBe(true);
    const candidates = result.motionPlannerEvents?.filter((event) =>
      event.eventType === 'motionplanner.transition.candidate') ?? [];
    expect(candidates.some((event) => event.transitionType === 'TRANSLATE_REVERSE')).toBe(false);
    expect(result.motionPlan!.states.some((state) => state.direction === 'REVERSE')).toBe(false);
  });

  it('E. preserves separate same-XY heading states', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 30, 0);
    const goal = cellPose(grid, 25, 30, Math.PI / 2);
    const result = plan(grid, start, goal, rectangle(), options(), Math.PI / 2);
    const rotationIndex = result.motionPlan!.actions.findIndex((action) => action.type === 'ROTATE_IN_PLACE');
    const from = result.motionPlan!.states[rotationIndex]!;
    const to = result.motionPlan!.states[rotationIndex + 1]!;
    expect([to.x, to.y]).toEqual([from.x, from.y]);
    expect(to.thetaBin).not.toBe(from.thetaBin);
  });

  it('F. preserves separate same-XY direction states', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 35, 0);
    const goal = cellPose(grid, 35, 25, 0);
    const result = plan(grid, start, goal, rectangle(), options(0), 0);
    const switchIndex = result.motionPlan!.actions.findIndex((action) => action.type === 'DIRECTION_CHANGE');
    expect(switchIndex).toBeGreaterThanOrEqual(0);
    const from = result.motionPlan!.states[switchIndex]!;
    const to = result.motionPlan!.states[switchIndex + 1]!;
    expect([to.x, to.y, to.theta]).toEqual([from.x, from.y, from.theta]);
    expect(to.direction).not.toBe(from.direction);
  });

  it('G. validates asymmetric-footprint reverse sweep near an obstacle', () => {
    const grid = makeGrid(.05, 140, 140);
    const start = cellPose(grid, 70, 70, 0);
    const asymmetric: RobotFootprint = { ...rectangle(.8, .25, true),
      source: 'bosch-client-motion', polygon: [
        { x: -.65, y: .125 }, { x: .2, y: .125 },
        { x: .2, y: -.125 }, { x: -.65, y: -.125 },
      ] };
    occupyWorld(grid, start.x - .75, start.y);
    const reverse = { ...start, x: start.x - .15 };
    const motionPlan: MotionPlan = { states: [
      { ...start, direction: 'REVERSE' }, { ...reverse, direction: 'REVERSE' },
    ], actions: [{ type: 'TRANSLATE_REVERSE', from: { ...start, direction: 'REVERSE' },
      to: { ...reverse, direction: 'REVERSE' }, distanceM: .15 }], metadata: { source: 'test' } };
    const checked = new MotionPlanValidator().validate(motionPlan, grid, asymmetric,
      .01, Math.PI / 36, true);
    expect(checked.valid).toBe(false);
    expect(checked.issues.some((issue) => issue.code === 'motionplan.translation.collision')).toBe(true);
  });

  it('H. rejects a rotation whose endpoints are safe but intermediate sweep collides', () => {
    const grid = makeGrid(.05, 140, 140);
    const footprint = rectangle(.8, .3, true);
    const pose = cellPose(grid, 70, 70, 0);
    occupyWorld(grid, pose.x + .25, pose.y + .25);
    const checker = new PoseCollisionChecker();
    expect(checker.pointIsFree(grid, pose, footprint)).toBe(true);
    expect(checker.pointIsFree(grid, { ...pose, theta: Math.PI / 2 }, footprint)).toBe(true);
    const from = { ...pose, direction: 'FORWARD' as const };
    const to = { ...pose, theta: Math.PI / 2, direction: 'FORWARD' as const };
    const motionPlan: MotionPlan = { states: [from, to], actions: [
      { type: 'ROTATE_IN_PLACE', from, to, rotationRad: Math.PI / 2 },
    ], metadata: { source: 'test' } };
    const checked = new MotionPlanValidator().validate(motionPlan, grid, footprint,
      .01, Math.PI / 72, true, Math.PI / 2);
    expect(checked.issues.some((issue) => issue.code === 'motionplan.rotation.collision')).toBe(true);
  });

  it('I. rejects reachable goal XY when its requested final orientation is unsafe', () => {
    const grid = makeGrid(.05, 140, 140);
    const footprint = rectangle(.6, .18, false);
    const start = cellPose(grid, 70, 45, 0);
    const goal = cellPose(grid, 70, 70, 0);
    for (let column = 40; column <= 75; column += 1) {
      grid.data[66 * grid.metadata.width + column] = 100;
      grid.data[74 * grid.metadata.width + column] = 100;
    }
    expect(plan(grid, start, goal, footprint, options(), undefined).success).toBe(true);
    const finalResult = plan(grid, start, { ...goal, theta: Math.PI / 2 }, footprint,
      options(), Math.PI / 2);
    expect(finalResult.success).toBe(false);
    expect(finalResult.motionPlan).toBeUndefined();
  });

  it('J. fails closed when no motion-state route exists', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 20, 0);
    const goal = cellPose(grid, 35, 50, 0);
    for (let row = 0; row < grid.metadata.height; row += 1)
      grid.data[row * grid.metadata.width + 35] = 100;
    const result = plan(grid, start, goal, rectangle(.3, .2, false));
    expect(result.success).toBe(false);
    expect(result.finalPath).toEqual([]);
    expect(result.motionPlan).toBeUndefined();
    expect(result.motionPlannerEvents?.some((event) => event.eventType === 'motionplanner.failed')).toBe(true);
  });

  it('K. direction-switch/reverse penalty changes the selected route', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 40, 0);
    const goal = cellPose(grid, 35, 30, 0);
    const lowPenalty = plan(grid, start, goal, rectangle(), options(0), 0);
    const highPenalty = plan(grid, start, goal, rectangle(), options(20), 0);
    expect(actionTypes(lowPenalty.motionPlan!)).toContain('TRANSLATE_REVERSE');
    expect(actionTypes(highPenalty.motionPlan!)).not.toContain('TRANSLATE_REVERSE');
    expect(actionTypes(highPenalty.motionPlan!)).toContain('ROTATE_IN_PLACE');
  });

  it('L. wraps requested theta safely around plus/minus pi', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 40, Math.PI - .01);
    const goal = { ...start, theta: -Math.PI + .01 };
    const result = plan(grid, start, goal, rectangle(), options(), -Math.PI + .01);
    expect(result.success).toBe(true);
    expect(result.motionPlan!.states.at(-1)!.theta).toBeCloseTo(-Math.PI + .01);
    expect(result.motionPlan!.actions.at(-1)!.rotationRad).toBeLessThan(.05);
  });

  it('M. MotionPlanValidator rejects a corrupted selected plan', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 25, 0);
    const goal = cellPose(grid, 35, 40, 0);
    const result = plan(grid, start, goal);
    const corrupted = structuredClone(result.motionPlan!);
    const index = corrupted.actions.findIndex((action) => action.type === 'TRANSLATE_FORWARD');
    corrupted.actions[index]!.to.theta += .2;
    const checked = new MotionPlanValidator().validate(corrupted, grid, rectangle(),
      .02, Math.PI / 36, true, 0);
    expect(checked.valid).toBe(false);
    expect(checked.issues.some((issue) => issue.code === 'motionplan.action.stateMismatch')).toBe(true);
  });

  it('N. VdaOrderBuilder preserves MotionPlan theta/direction without reinterpretation', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 40, 0);
    const goal = cellPose(grid, 35, 30, 0);
    const footprint = rectangle();
    const result = plan(grid, start, goal, footprint, options(0), 0);
    expect(actionTypes(result.motionPlan!)).toContain('TRANSLATE_REVERSE');
    const order = new VdaOrderBuilder().build(result.finalPath, {
      robotPose: start, activeMapId: grid.metadata.mapId, motionPlan: result.motionPlan,
      finalGoalTheta: 0, corridorPlanning: { grid, footprint, plannerOptions: options(0) },
    }, defaultOrderSettings, 'motion-state-order');
    expect(order.nodes.map((node) => node.nodePosition.theta))
      .toEqual(result.motionPlan!.states.map((state) => state.theta));
    expect(order.nodes.at(-1)!.nodePosition.theta).toBe(0);
  });

  it('emits bounded structured motion-state and validation diagnostics with cost terms', () => {
    const grid = makeGrid(.05, 140, 140);
    const footprint = rectangle(.8, .3, true);
    const start = cellPose(grid, 70, 70, 0);
    const goal = cellPose(grid, 50, 60, Math.PI / 2);
    occupyWorld(grid, start.x + .25, start.y + .25);
    occupyWorld(grid, start.x + .45, start.y);
    const result = plan(grid, start, goal, footprint, options(.05), Math.PI / 2);
    const names = new Set(result.motionPlannerEvents?.map((event) => event.eventType));
    expect(names).toEqual(expect.objectContaining(new Set([
      'motionplanner.started', 'motionplanner.state.expanded',
      'motionplanner.transition.candidate', 'motionplanner.transition.rejected',
      'collision.translation', 'collision.rotation.sweep',
      'motionplanner.goal.reached', 'motionplan.created',
      'motionplan.validation.passed',
    ])));
    expect(result.motionPlannerEvents!.length).toBeLessThan(170);
    expect(result.motionPlan!.actions.every((action) =>
      action.costComponents && action.costComponents.total >= 0)).toBe(true);
  });

  it('requires the independent validation context before motion-state VDA conversion', () => {
    const grid = makeGrid();
    const start = cellPose(grid, 35, 25, 0);
    const goal = cellPose(grid, 35, 40, 0);
    const result = plan(grid, start, goal);
    expect(() => new VdaOrderBuilder().build(result.finalPath, {
      robotPose: start, activeMapId: grid.metadata.mapId, motionPlan: result.motionPlan,
    }, defaultOrderSettings)).toThrow(/validation requires the planning grid and footprint/i);
  });
});
