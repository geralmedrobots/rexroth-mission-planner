import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { ObstacleInflation } from '../domain/planner/ObstacleInflation';
import { planSynchronously } from '../domain/planner/PlannerService';
import { classifyObstacle, effectiveDiagnosticFootprint, inspectDiagnosticPose, measureDoorway,
  precisePlannerOutcome, prepareClearanceRequest, rejectionEvidence } from '../features/locator/services/plannerClearanceDiagnostics';
import type { OccupancyGrid, PlannerResult } from '../domain/types';
import type { PlanningInputs } from '../features/planning/PlanningCoordinator';

const robot = { ...defaultFootprint, length: .3, width: .4, safetyMargin: .05, inflationRadius: .87 };
function map(yaw = 0): OccupancyGrid {
  return { metadata: { name: 'door', mapId: 'door', width: 30, height: 20, resolution: .1,
    origin: { x: -2, y: -3, yaw }, occupiedThreshold: .65, freeThreshold: .196, negate: false }, data: Array<number>(600).fill(0) };
}
function inputs(grid: OccupancyGrid): PlanningInputs {
  const t = new CoordinateTransformer(grid.metadata);
  return { grid, start: { ...t.gridToWorld(10, 6), theta: 0, mapId: 'door', positionInitialized: true },
    goal: { ...t.gridToWorld(10, 24), theta: 0, mapId: 'door', positionInitialized: true }, waypoints: [], plannerMode: 'automatic',
    plannerOptions: { ...structuredClone(defaultPlannerOptions), maxPlanningTimeMs: 500,
      passageSafety: { ...defaultPlannerOptions.passageSafety, planningSafetyMarginM: .02, localizationMarginM: .03 } },
    footprint: robot, orderSettings: defaultOrderSettings, sessionId: 'diagnostic-test' };
}
function corridor(grid: OccupancyGrid) {
  for (let col = 0; col < 30; col++) { grid.data[6 * 30 + col] = 100; grid.data[13 * 30 + col] = 100; }
}

describe('doorway raster clearance measurements', () => {
  it('measures wall-edge clearance across travel, rather than the distance between selected sides', () => {
    const grid = map(); corridor(grid); const config = inputs(grid);
    const measured = measureDoorway(grid, config.start, config.goal, robot)!;
    expect(measured.widthM).toBeCloseTo(.6, 8);
    expect(measured.projectedWidthM).toBeCloseTo(.4, 8);
    expect(measured.remainingWidthM).toBeCloseTo(.1, 8);
    expect(measured.left.cell.row).toBe(6); expect(measured.right.cell.row).toBe(13);
    expect(measured.blockedCentreSamples).toBe(0);
  });
  it('is invariant under rotated origins and negative map coordinates', () => {
    const grid = map(.71); corridor(grid); const config = inputs(grid);
    const measured = measureDoorway(grid, { ...config.start, theta: .71 }, { ...config.goal, theta: .71 }, robot)!;
    expect(measured.widthM).toBeCloseTo(.6, 8);
    expect(measured.projectedWidthM).toBeCloseTo(.4, 8);
  });
  it('honours robot heading and the actual Bosch footprint polygon', () => {
    const grid = map(); corridor(grid); const config = inputs(grid);
    expect(measureDoorway(grid, { ...config.start, theta: Math.PI / 2 }, config.goal, robot)?.projectedWidthM).toBeCloseTo(.3);
    const polygon = { ...robot, source: 'bosch-client-motion' as const,
      polygon: [{ x: -.1, y: -.35 }, { x: .1, y: -.35 }, { x: .1, y: .35 }, { x: -.1, y: .35 }] };
    expect(measureDoorway(grid, config.start, config.goal, polygon)?.remainingWidthM).toBeCloseTo(-.2);
  });
  it('keeps unknown boundaries distinct and does not mistake image edges for walls', () => {
    const grid = map(); const config = inputs(grid);
    expect(measureDoorway(grid, config.start, config.goal, robot)).toBeUndefined();
    corridor(grid); for (let col = 0; col < 30; col++) grid.data[6 * 30 + col] = -1;
    expect(measureDoorway(grid, config.start, config.goal, robot)?.left.obstacle).toBe('unknown');
    expect(measureDoorway(grid, config.start, config.start, robot)).toBeUndefined();
  });
});

describe('collision provenance and unchanged planning requests', () => {
  it('distinguishes occupied, unknown, inflated-only, free and outside cells', () => {
    const grid = map(); grid.data[10 * 30 + 10] = 100; grid.data[10 * 30 + 20] = -1;
    const inflated = ObstacleInflation.byRadius(grid, .15);
    expect(classifyObstacle(grid, { row: 10, column: 10 }, inflated)).toBe('occupied');
    expect(classifyObstacle(grid, { row: 10, column: 20 }, inflated)).toBe('unknown');
    expect(classifyObstacle(grid, { row: 10, column: 11 }, inflated)).toBe('inflated');
    expect(classifyObstacle(grid, { row: 10, column: 15 }, inflated)).toBe('free');
    expect(classifyObstacle(grid, { row: -1, column: 15 }, inflated)).toBe('outside');
  });
  it.each([100, -1])('identifies the exact blocker for a full-footprint endpoint rejection (%s)', value => {
    const grid = map(); const config = inputs(grid); grid.data[10 * 30 + 7] = value;
    const original = structuredClone(config);
    const planned = planSynchronously(prepareClearanceRequest(config));
    expect(planned.success).toBe(false);
    expect(planned.diagnostics?.physicalFailureCode).toBe('START_NOT_FREE');
    const evidence = rejectionEvidence(grid, planned, config);
    expect(evidence.some(e => e.cell?.row === 10 && e.cell.column === 7 && e.obstacle === (value < 0 ? 'unknown' : 'occupied'))).toBe(true);
    expect(precisePlannerOutcome(planned)).toMatch(/START_NOT_FREE/);
    expect(config).toEqual(original);
  });
  it('reports a boundary footprint collision without inventing a map cell', () => {
    const grid = map(); const t = new CoordinateTransformer(grid.metadata);
    const inspected = inspectDiagnosticPose(grid, t.gridToWorld(0, 0), robot);
    expect(inspected.obstacle).toBe('outside'); expect(inspected.cell).toBeUndefined();
  });
  it('uses saved settings, exact endpoints and current strategy without applying display inflation', () => {
    const config: PlanningInputs = { ...inputs(map()), plannerMode: 'motion-state', goalThetaExplicit: true };
    config.plannerOptions.passageSafety.minimumPassageWidthM = 1.37;
    config.plannerOptions.passageSafety.planningSafetyMarginM = .1;
    config.plannerOptions.passageSafety.localizationMarginM = .04;
    const request = prepareClearanceRequest(config);
    expect(request.plannerStrategy).toBe('motion-state');
    expect(request.collisionGrid).toBe(config.grid);
    expect(request.exactStartPose).toEqual(config.start); expect(request.exactGoalPose).toEqual(config.goal);
    expect(request.goalTheta).toBe(config.goal.theta);
    expect(request.options.passageSafety.minimumPassageWidthM).toBe(1.37);
    expect(request.footprint.inflationRadius).toBe(.87);
    expect(effectiveDiagnosticFootprint(config).safetyMargin).toBeCloseTo(.14);
    expect(config.footprint.safetyMargin).toBe(.05);
  });
  it('reports narrow-passage failure from the actual planner, not a guessed width threshold', () => {
    const grid = map(); const config = inputs(grid);
    for (let row = 0; row < 20; row++) if (row !== 10) grid.data[row * 30 + 15] = 100;
    const planned = planSynchronously(prepareClearanceRequest(config));
    expect(planned.success).toBe(false);
    expect(['PASSAGE_TOO_NARROW', 'VEHICLE_FOOTPRINT_COLLISION']).toContain(planned.diagnostics?.physicalFailureCode);
    expect(precisePlannerOutcome(planned)).toContain(planned.error);
  });
  it('does not infer exact cells or physical impossibility from timeout', () => {
    const result: PlannerResult = { success: false, error: 'Motion-state search timeout.', rawPath: [], simplifiedPath: [], finalPath: [],
      statistics: { durationMs: 1, visitedCells: 1, rawPointCount: 0, simplifiedPointCount: 0, finalPointCount: 0 } };
    const config = inputs(map());
    expect(precisePlannerOutcome(result)).toMatch(/not established/);
    expect(rejectionEvidence(config.grid, result, config)).toEqual([]);
  });
  it('does not silently replace manual mode with a different search strategy', () => {
    const config: PlanningInputs = { ...inputs(map()), plannerMode: 'manual' };
    expect(() => prepareClearanceRequest(config)).toThrow(/Manual mode/);
  });
});
