import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { buildLegacyMotionPlan } from '../domain/motion/LegacyMotionPlanBuilder';
import { measureMotionPlan } from '../domain/motion/MotionPlanMetrics';
import type { MotionActionType, MotionDirection, MotionPlan, MotionState } from '../domain/motion/planningModel';
import { MotionPlanOptimiser } from '../domain/planning/MotionPlanOptimiser';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import { buildMotionStateClearanceField } from '../domain/planner/ClearanceField';
import { MotionPlanValidator } from '../domain/planner/MotionPlanValidator';
import { PathCollisionValidator } from '../domain/planner/PathCollisionValidator';
import { RouteSafetyProcessor } from '../domain/planner/RouteSafetyProcessor';
import { RotationSweepChecker } from '../domain/planner/RotationSweepChecker';
import { TranslationSweepChecker } from '../domain/planner/TranslationSweepChecker';
import type { OccupancyGrid, PathPoint, PlannerOptions, RobotFootprint, RobotPose } from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';

const grid = (): OccupancyGrid => ({
  metadata: { name: 'optimiser', mapId: 'optimiser', width: 100, height: 100,
    resolution: .1, origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 65,
    freeThreshold: 25, negate: false },
  data: Array(10_000).fill(0),
});
const footprint = (length = .4, width = .3): RobotFootprint => ({
  ...structuredClone(defaultFootprint), length, width, safetyMargin: 0,
  inflationRadius: 0, allowReverse: true, backwardAllowed: true,
  forwardAllowed: true, allowTurnOnSpot: true, turnOnSpotAllowed: true,
});
const options = (): PlannerOptions => ({
  ...structuredClone(defaultPlannerOptions), policy: 'balanced', reliableBaselineMode: false,
  passageSafety: { ...structuredClone(defaultPlannerOptions.passageSafety),
    wallClearanceMinimumM: .05 },
});
const state = (x: number, y: number, theta: number,
  direction: MotionDirection = 'FORWARD'): MotionState => ({ x, y, theta, direction });
const motionPlan = (states: MotionState[], types: MotionActionType[]): MotionPlan => ({
  states,
  actions: types.map((type, index) => ({
    type, from: { ...states[index]! }, to: { ...states[index + 1]! },
    ...(type.startsWith('TRANSLATE') ? { distanceM: Math.hypot(
      states[index + 1]!.x - states[index]!.x,
      states[index + 1]!.y - states[index]!.y,
    ) } : {}),
    ...(type === 'ROTATE' || type === 'ROTATE_IN_PLACE' ? {
      rotationRad: Math.abs(states[index + 1]!.theta - states[index]!.theta),
    } : {}),
  })),
  metadata: { source: 'motion-state-planner', plannerVersion: 'test' },
});
const occupy = (map: OccupancyGrid, x: number, y: number): void => {
  const transform = new CoordinateTransformer(map.metadata);
  const cell = transform.worldToGrid(x, y);
  if (!cell) throw new Error('Obstacle outside test map.');
  map.data[transform.index(cell)] = 100;
};
const optimise = (plan: MotionPlan, map = grid(), robot = footprint()) =>
  new MotionPlanOptimiser().optimise(plan, map, robot,
    createPlanningConfigurationSnapshot({ plannerOptions: options(), footprint: robot })
      .normalized.motionState,
    plan.states.at(-1)?.theta);

describe('MotionPlanOptimiser feasibility-preserving architecture', () => {
  it('A. does not collapse a wider obstacle route into an unsafe straight shortcut', () => {
    const map = grid();
    occupy(map, 3, 2);
    const plan = motionPlan([
      state(1, 2, 0), state(2, 2, 0), state(2, 3, Math.PI / 2),
      state(4, 3, 0), state(4, 2, -Math.PI / 2), state(5, 2, 0),
    ], ['TRANSLATE_FORWARD', 'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD',
      'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD']);
    // Add the missing same-XY states required between rotation and translation.
    const valid = motionPlan([
      state(1, 2, 0), state(2, 2, 0), state(2, 2, Math.PI / 2),
      state(2, 3, Math.PI / 2), state(2, 3, 0), state(4, 3, 0),
      state(4, 3, -Math.PI / 2), state(4, 2, -Math.PI / 2),
      state(4, 2, 0), state(5, 2, 0),
    ], ['TRANSLATE_FORWARD', 'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD',
      'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD', 'ROTATE_IN_PLACE',
      'TRANSLATE_FORWARD', 'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD']);
    expect(plan.states.length).toBe(6); // documents the geometric intent above
    expect(new MotionPlanValidator().validate(valid, map, footprint(), .02,
      Math.PI / 36, true, 0).valid).toBe(true);
    const result = optimise(valid, map);
    expect(result.plan.states.some((item) => item.y === 3)).toBe(true);
    expect(result.plan.actions.length).toBeGreaterThan(1);
  });

  it('B. rejects point-visible shortcuts whose swept footprint collides', () => {
    const map = grid();
    occupy(map, 3, 2.22);
    const robot = footprint(.4, .5);
    const from: PathPoint = { x: 1, y: 2, theta: 0 };
    const to: PathPoint = { x: 5, y: 2, theta: 0 };
    const pointRobot = { ...robot, length: 0, width: 0, polygon: undefined };
    expect(new PathCollisionValidator().segmentIsFree(map, from, to, pointRobot, .02)).toBe(true);
    expect(new TranslationSweepChecker().segmentIsFreeAtHeading(
      map, from, to, robot, .02, 0)).toBe(false);
    const detour = motionPlan([
      state(1, 2, 0), state(1, 3, Math.PI / 2), state(1, 3, 0),
      state(5, 3, 0), state(5, 3, -Math.PI / 2), state(5, 2, -Math.PI / 2),
      state(5, 2, 0),
    ], ['ROTATE_IN_PLACE', 'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD',
      'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD', 'ROTATE_IN_PLACE']);
    // Use physically valid same-position rotations/translations.
    detour.states.splice(1, 0, state(1, 2, Math.PI / 2));
    detour.actions = motionPlan(detour.states, [
      'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD', 'ROTATE_IN_PLACE',
      'TRANSLATE_FORWARD', 'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD',
      'ROTATE_IN_PLACE',
    ]).actions;
    expect(new MotionPlanValidator().validate(detour, map, robot, .02,
      Math.PI / 36, true, 0).valid).toBe(true);
    const result = optimise(detour, map, robot);
    expect(result.plan.states.some((item) => item.y === 3)).toBe(true);
  });

  it('C. does not introduce a shortcut that would require a new unsafe start rotation', () => {
    const map = grid();
    const robot = footprint(.8, .3);
    occupy(map, 2.25, 2.25);
    const plan = motionPlan([
      state(2, 2, 0), state(3, 2, 0), state(3, 2, Math.PI / 2),
      state(3, 3, Math.PI / 2),
    ], ['TRANSLATE_FORWARD', 'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD']);
    expect(new RotationSweepChecker().rotationIsFree(map, plan.states[0]!, 0,
      Math.PI / 4, robot, Math.PI / 72)).toBe(false);
    expect(new MotionPlanValidator().validate(plan, map, robot, .02,
      Math.PI / 72, true, Math.PI / 2).valid).toBe(true);
    const result = optimise(plan, map, robot);
    expect(result.plan.actions[0]!.type).toBe('TRANSLATE_FORWARD');
    expect(result.plan.actions.some((action) => action.type === 'ROTATE_IN_PLACE')).toBe(true);
  });

  it('D. preserves reverse body theta while merging translations', () => {
    const plan = motionPlan([
      state(4, 2, 0, 'REVERSE'), state(3, 2, 0, 'REVERSE'),
      state(2, 2, 0, 'REVERSE'),
    ], ['TRANSLATE_REVERSE', 'TRANSLATE_REVERSE']);
    const result = optimise(plan);
    expect(result.plan.actions).toHaveLength(1);
    expect(result.plan.states.map((item) => item.theta)).toEqual([0, 0]);
    expect(result.plan.actions[0]!.type).toBe('TRANSLATE_REVERSE');
  });

  it('E. preserves explicit direction changes', () => {
    const plan = motionPlan([
      state(2, 2, 0), state(3, 2, 0), state(3, 2, 0, 'REVERSE'),
      state(2, 2, 0, 'REVERSE'),
    ], ['TRANSLATE_FORWARD', 'DIRECTION_CHANGE', 'TRANSLATE_REVERSE']);
    const result = optimise(plan);
    expect(result.plan.actions.map((action) => action.type))
      .toEqual(['TRANSLATE_FORWARD', 'DIRECTION_CHANGE', 'TRANSLATE_REVERSE']);
  });

  it('F. merges redundant compatible consecutive translations safely', () => {
    const plan = motionPlan(Array.from({ length: 9 }, (_, index) => state(1 + index, 2, 0)),
      Array.from({ length: 8 }, () => 'TRANSLATE_FORWARD'));
    const result = optimise(plan);
    expect(result.plan.actions).toHaveLength(1);
    expect(result.plan.actions[0]!.distanceM).toBeCloseTo(8);
    expect(result.candidatesConsidered).toBe(1);
  });

  it('G. removes a redundant zero rotation without changing the translation', () => {
    const plan = motionPlan([
      state(1, 2, 0), state(1, 2, 0), state(2, 2, 0),
    ], ['ROTATE_IN_PLACE', 'TRANSLATE_FORWARD']);
    const result = optimise(plan);
    expect(result.plan.actions.map((action) => action.type)).toEqual(['TRANSLATE_FORWARD']);
    expect(result.plan.states).toHaveLength(2);
  });

  it('M. coalesces open-space lattice rotations without changing total angle', () => {
    const plan = motionPlan([
      state(1, 2, 0), state(1, 2, Math.PI / 4),
      state(1, 2, Math.PI / 2), state(1, 3, Math.PI / 2),
    ], ['ROTATE_IN_PLACE', 'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD']);
    const before = measureMotionPlan(plan, grid(), .02);
    const result = optimise(plan);
    const after = measureMotionPlan(result.plan, grid(), .02);
    expect(result.plan.actions.map((action) => action.type))
      .toEqual(['ROTATE_IN_PLACE', 'TRANSLATE_FORWARD']);
    expect(after.rotationActionCount).toBe(1);
    expect(after.totalAbsoluteRotationRad).toBeCloseTo(before.totalAbsoluteRotationRad);
    expect(result.plan.diagnostics?.retainedRotations).toEqual([
      expect.objectContaining({ reason: 'required-before-translation-heading' }),
    ]);
  });

  it('N. retains a necessary obstacle-clearance rotation at the selected pose', () => {
    const map = grid();
    occupy(map, 1.8, 2);
    const plan = motionPlan([
      state(1, 2, 0), state(1, 2, Math.PI / 4),
      state(1, 2, Math.PI / 2), state(1, 2.1, Math.PI / 2),
    ], ['ROTATE_IN_PLACE', 'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD']);
    const result = optimise(plan, map, footprint(.4, .5));
    expect(result.plan.actions.filter((action) => action.type === 'ROTATE_IN_PLACE'))
      .toHaveLength(1);
    expect(new MotionPlanValidator().validate(result.plan, map, footprint(.4, .5), .02,
      Math.PI / 36, true, Math.PI / 2).valid).toBe(true);
  });

  it('O. does not remove rotations around a short translation when both headings are geometric requirements', () => {
    const plan = motionPlan([
      state(1, 2, 0), state(1, 2, Math.PI / 2),
      state(1, 2.1, Math.PI / 2), state(1, 2.1, Math.PI),
    ], ['ROTATE_IN_PLACE', 'TRANSLATE_FORWARD', 'ROTATE_IN_PLACE']);
    const result = optimise(plan);
    expect(result.plan.actions.map((action) => action.type)).toEqual([
      'ROTATE_IN_PLACE', 'TRANSLATE_FORWARD', 'ROTATE_IN_PLACE',
    ]);
    expect(result.plan.diagnostics?.retainedRotations).toEqual([
      expect.objectContaining({ reason: 'required-before-translation-heading' }),
      expect.objectContaining({ reason: 'required-after-translation-heading-change' }),
    ]);
  });

  it('P. retains terminal connector and final-orientation rotations', () => {
    const plan = motionPlan([
      state(1, 2, 0), state(1, 2, Math.PI / 2),
      state(1, 2.1, Math.PI / 2), state(1, 2.1, Math.PI),
    ], ['ROTATE_IN_PLACE', 'TRANSLATE_FORWARD', 'ROTATE_IN_PLACE']);
    plan.actions[0]!.metadata = { terminalConnector: true };
    plan.actions[2]!.metadata = { finalOrientation: true };
    const result = optimise(plan);
    expect(result.metrics.rotationActionCount).toBe(2);
    expect(result.plan.diagnostics?.retainedRotations).toEqual([
      expect.objectContaining({ reason: 'required-terminal-orientation-or-connector' }),
      expect.objectContaining({ reason: 'required-terminal-orientation-or-connector' }),
    ]);
  });

  it('H. returns a plan accepted by MotionPlanValidator', () => {
    const map = grid();
    const robot = footprint();
    const result = optimise(motionPlan([
      state(1, 2, 0), state(2, 2, 0), state(3, 2, 0),
    ], ['TRANSLATE_FORWARD', 'TRANSLATE_FORWARD']), map, robot);
    expect(new MotionPlanValidator().validate(result.plan, map, robot, .02,
      Math.PI / 36, true, 0).valid).toBe(true);
  });

  it('I. RouteSafetyProcessor is a no-op for motion-state mode', () => {
    const map = grid();
    const states = [state(1, 2, Math.PI, 'REVERSE'), state(2, 2, Math.PI, 'REVERSE')];
    const result = new RouteSafetyProcessor().process(map, states, footprint(), options(),
      Math.PI, Math.PI, 'motion-state');
    expect(result.path).toEqual(states);
    expect(result.path.map((item) => (item as MotionState).direction))
      .toEqual(['REVERSE', 'REVERSE']);
  });

  it('J. VdaOrderBuilder serializes optimised theta/direction without selection', () => {
    const map = grid();
    const robot = footprint();
    const plan = optimise(motionPlan([
      state(4, 2, Math.PI, 'REVERSE'), state(5, 2, Math.PI, 'REVERSE'),
      state(6, 2, Math.PI, 'REVERSE'),
    ], ['TRANSLATE_REVERSE', 'TRANSLATE_REVERSE']), map, robot).plan;
    const pose: RobotPose = { ...plan.states[0]!, mapId: map.metadata.mapId,
      positionInitialized: true };
    const order = new VdaOrderBuilder().build([], {
      robotPose: pose, activeMapId: map.metadata.mapId, motionPlan: plan,
      finalGoalTheta: Math.PI,
      corridorPlanning: { grid: map, footprint: robot, plannerOptions: options() },
    }, defaultOrderSettings, 'optimised-motion-plan');
    expect(order.nodes.map((node) => node.nodePosition.theta))
      .toEqual(plan.states.map((item) => item.theta));
    expect(order.nodes[1]!.nodePosition.x).toBeGreaterThan(order.nodes[0]!.nodePosition.x);
  });

  it('K. selected-plan clearance metrics use the collision Costmap', () => {
    const map = grid();
    occupy(map, 3, 3);
    const plan = motionPlan([state(1, 2, 0), state(2, 2, 0)], ['TRANSLATE_FORWARD']);
    const metrics = measureMotionPlan(plan, map, .02);
    const transform = new CoordinateTransformer(map.metadata);
    const field = buildMotionStateClearanceField(map);
    const expected = Math.min(...plan.states.map((item) => {
      const cell = transform.worldToGrid(item.x, item.y)!;
      return field[transform.index(cell)]!;
    }));
    expect(metrics.minimumClearanceM).toBeCloseTo(expected);
  });

  it('L. keeps legacy direction selection isolated and unchanged', () => {
    const route = [{ x: 2, y: 2, theta: 0 }, { x: 1, y: 2, theta: 0 }];
    const legacy = buildLegacyMotionPlan(route, 0, options());
    const pose: RobotPose = { x: 2, y: 2, theta: 0, mapId: 'optimiser',
      positionInitialized: true };
    const order = new VdaOrderBuilder().build([route[1]!], {
      robotPose: pose, activeMapId: 'optimiser',
    }, defaultOrderSettings, 'legacy-isolation');
    expect(order.nodes.map((node) => node.nodePosition.theta))
      .toEqual(legacy.states.map((item) => item.theta));
    expect(legacy.metadata.source).toBe('legacy-direction-compatibility');
  });
});
