import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { normalizeAngle } from '../domain/geometry/angles';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { PathCollisionValidator } from '../domain/planner/PathCollisionValidator';
import { RouteSafetyError, RouteSafetyProcessor } from '../domain/planner/RouteSafetyProcessor';
import type { OccupancyGrid, PathPoint, PlannerOptions, RobotFootprint } from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator, type OrderValidationContext } from '../domain/vda5050/VdaOrderValidator';

const makeGrid = (width = 100, height = 100, resolution = .05): OccupancyGrid => ({
  metadata: { name: 'motion-characterization', mapId: 'motion-map', width, height,
    resolution, origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 65,
    freeThreshold: 20, negate: false }, data: new Array(width * height).fill(0),
});
const robot: RobotFootprint = { ...defaultFootprint, length: .83, width: .60,
  safetyMargin: 0, inflationRadius: 0 };
const tiny: RobotFootprint = { ...defaultFootprint, length: .2, width: .2,
  safetyMargin: 0, inflationRadius: 0 };
const safeOptions = (patch: Partial<PlannerOptions> = {}): PlannerOptions => ({
  ...defaultPlannerOptions, ...patch, passageSafety: {
    ...defaultPlannerOptions.passageSafety, enableDoorwayDetection: false,
    enableDoorAlignment: false, enableWaypointDensification: false, ...patch.passageSafety,
  },
});
const obstacle = (grid: OccupancyGrid, x: number, y: number): void => {
  const cell = new CoordinateTransformer(grid.metadata).worldToGrid(x, y);
  if (!cell) throw new Error('Test obstacle is outside the map.');
  grid.data[cell.row * grid.metadata.width + cell.column] = 100;
};
const orderContext = (grid: OccupancyGrid, footprint = tiny, options = defaultPlannerOptions) => ({
  robotPose: { x: 2, y: 2, theta: 0, mapId: 'motion-map', positionInitialized: true },
  activeMapId: 'motion-map', corridorPlanning: { grid, footprint, plannerOptions: options },
});

describe('Stage 2 motion and orientation characterization', () => {
  it('rejects first-edge rotation near an obstacle', () => {
    const grid = makeGrid(); obstacle(grid, 2.38, 2.38);
    const collision = new PathCollisionValidator();
    expect(collision.rotationIsFree(grid, { x: 2, y: 2 }, 0, Math.PI / 2, robot, 5 * Math.PI / 180)).toBe(false);
  });

  it('records that even a small initial rotation can be collision-unsafe', () => {
    const grid = makeGrid(); obstacle(grid, 2.38, 2.38);
    const collision = new PathCollisionValidator();
    expect(collision.rotationIsFree(grid, { x: 2, y: 2 }, 0, 10 * Math.PI / 180, robot, 1 * Math.PI / 180)).toBe(false);
  });

  it('captures the current reverse-selection defect when reverse motion is disabled', () => {
    const options = safeOptions({ passageSafety: { ...defaultPlannerOptions.passageSafety, reverseRiskWeight: 0 } });
    const order = new VdaOrderBuilder().build([{ x: 1, y: 2, theta: 0 }, { x: .5, y: 2, theta: 0 }], orderContext(makeGrid(), robot, options), defaultOrderSettings, 'reverse-disabled-characterization');
    // Known defect: VdaOrderBuilder does not consult footprint.allowReverse/backwardAllowed.
    expect(robot.allowReverse).toBe(false);
    expect(order.nodes[1]!.nodePosition.theta).toBeCloseTo(0);
  });

  it('preserves asymmetric footprint geometry for reverse-oriented poses', () => {
    const grid = makeGrid();
    const asymmetric = { ...tiny, centerOffsetX: .25, length: .6, width: .2 };
    const collision = new PathCollisionValidator();
    expect(collision.pointIsFree(grid, { x: 2, y: 2, theta: 0 }, asymmetric)).toBe(true);
    obstacle(grid, 2.52, 2);
    expect(collision.pointIsFree(grid, { x: 2, y: 2, theta: 0 }, asymmetric)).toBe(false);
  });

  it('characterizes forward to reverse and reverse to forward direction transitions', () => {
    const options = safeOptions({ passageSafety: { ...defaultPlannerOptions.passageSafety, reverseRiskWeight: .1 } });
    const path = [{ x: 2, y: 2.5, theta: 0 }, { x: 2, y: 3, theta: 0 }, { x: 2, y: 2.4, theta: 0 }, { x: 3, y: 2.4, theta: 0 }];
    const order = new VdaOrderBuilder().build(path, orderContext(makeGrid(), tiny, options), defaultOrderSettings, 'direction-switch-characterization');
    // Current baseline enters reverse at the second segment and remains reverse
    // for the following segment; preserve this before any direction refactor.
    expect(order.nodes.map((node) => node.nodePosition.theta)).toEqual([0, Math.PI / 2, Math.PI / 2, Math.PI, 0]);
  });

  it('falls back to forward theta when both direction candidates are infeasible', () => {
    const grid = makeGrid(); grid.data.fill(100);
    const order = new VdaOrderBuilder().build([{ x: 1, y: 2, theta: 0 }, { x: .5, y: 2, theta: 0 }], orderContext(grid, tiny), defaultOrderSettings, 'both-infeasible-characterization');
    // Known defect: infeasible candidates do not make order construction fail.
    expect(order.nodes[1]!.nodePosition.theta).toBeCloseTo(Math.PI);
  });

  it('rejects an unsafe final goal rotation', () => {
    const grid = makeGrid(); obstacle(grid, 2.38, 2.38);
    expect(() => new RouteSafetyProcessor().process(grid,
      [{ x: 1, y: 2, theta: 0 }, { x: 2, y: 2, theta: Math.PI / 2 }], robot,
      safeOptions(), 0, Math.PI / 2)).toThrow(RouteSafetyError);
  });

  it('keeps theta deltas continuous across the +/-pi wrap', () => {
    const delta = normalizeAngle(-Math.PI + .02 - (Math.PI - .02));
    expect(Math.abs(delta)).toBeCloseTo(.04);
  });

  it('shows that XY-safe translation can still require unsafe rotation', () => {
    const grid = makeGrid(); obstacle(grid, 2.38, 2.38);
    const collision = new PathCollisionValidator();
    expect(collision.segmentIsFree(grid, { x: 1, y: 2, theta: 0 }, { x: 2, y: 2, theta: 0 }, robot, .03)).toBe(true);
    expect(collision.rotationIsFree(grid, { x: 2, y: 2 }, 0, Math.PI / 2, robot, 5 * Math.PI / 180)).toBe(false);
  });

  it('records that rotate-here is unsafe while a reverse-first translation is feasible', () => {
    const grid = makeGrid(); obstacle(grid, 2.38, 2.38);
    const collision = new PathCollisionValidator();
    expect(collision.rotationIsFree(grid, { x: 2, y: 2 }, 0, Math.PI / 2, robot, 5 * Math.PI / 180)).toBe(false);
    expect(collision.segmentIsFree(grid, { x: 2, y: 2, theta: 0 }, { x: 1.5, y: 2, theta: 0 }, robot, .03)).toBe(true);
  });

  it('records reliable mode accepting a translation-feasible but rotation-infeasible final path', () => {
    const grid = makeGrid(); obstacle(grid, 2.38, 2.38);
    const path: PathPoint[] = [{ x: 1, y: 2, theta: 0 }, { x: 2, y: 2, theta: Math.PI / 2 }];
    const collision = new PathCollisionValidator();
    expect(collision.pathIsFree(grid, path, robot, .03)).toBe(true);
    expect(collision.rotationIsFree(grid, { x: 2, y: 2 }, 0, Math.PI / 2, robot, 5 * Math.PI / 180)).toBe(false);
  });

  it('restores the unchecked baseline after a failed turn enhancement', () => {
    const grid = makeGrid();
    const baseline = [{ x: 1, y: 1, theta: 0 }, { x: 3, y: 1, theta: 0 }];
    const result = new RouteSafetyProcessor().process(grid, baseline, tiny,
      safeOptions({ waypointSpacing: 10, passageSafety: { ...defaultPlannerOptions.passageSafety,
        enableTurnFeasibilityChecking: false, enableWaypointDensification: false } }), 0, 0);
    expect(result.path.map(({ x, y, theta }) => ({ x, y, theta }))).toEqual(baseline);
  });

  it('documents VDA validation of XY-safe nodes with unsafe theta transitions', () => {
    const grid = makeGrid(); obstacle(grid, 2.38, 2.38);
    const order = new VdaOrderBuilder().build([{ x: 2.5, y: 2, theta: Math.PI / 2 }], orderContext(grid, robot), defaultOrderSettings, 'vda-theta-characterization');
    const context: OrderValidationContext = {
      mqttConnected: true, stateReceived: true, connectionReceived: true, activeMapId: 'motion-map',
      currentPose: { x: 2, y: 2, theta: 0, mapId: 'motion-map', positionInitialized: true }, grid,
      footprint: robot, settings: defaultOrderSettings, connectionOnline: true, operatingMode: 'AUTOMATIC',
      stateAgeMs: 0, visualizationAgeMs: 0, positionInitialized: true, locatorMapName: 'motion-map',
    };
    // Known defect: base VDA validation checks XY interpolation but not swept theta transitions.
    expect(new VdaOrderValidator().validate(order, context).valid).toBe(true);
  });

  it('regenerates direction-dependent nodes when reverse weight changes', () => {
    const path = [{ x: 1, y: 2, theta: 0 }, { x: .5, y: 2, theta: 0 }];
    const lowReverse = safeOptions({ passageSafety: { ...defaultPlannerOptions.passageSafety, reverseRiskWeight: 0 } });
    const highReverse = safeOptions({ passageSafety: { ...defaultPlannerOptions.passageSafety, reverseRiskWeight: 10 } });
    const builder = new VdaOrderBuilder();
    const first = builder.build(path, orderContext(makeGrid(), tiny, lowReverse), defaultOrderSettings, 'weight-first');
    const second = builder.build(path, orderContext(makeGrid(), tiny, highReverse), defaultOrderSettings, 'weight-second');
    expect(first.nodes[1]!.nodePosition.theta).not.toBe(second.nodes[1]!.nodePosition.theta);
    const reverseEnabled = { ...tiny, allowReverse: true, backwardAllowed: true };
    const enabled = builder.build(path, orderContext(makeGrid(), reverseEnabled, lowReverse), defaultOrderSettings, 'permission-enabled');
    // Known defect: changing the footprint permission alone does not invalidate
    // or alter the direction-dependent order calculation.
    expect(enabled.nodes[1]!.nodePosition.theta).toBe(first.nodes[1]!.nodePosition.theta);
  });
});
