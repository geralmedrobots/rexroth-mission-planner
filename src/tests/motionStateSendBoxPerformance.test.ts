import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFootprint, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { buildMotionStateClearanceField } from '../domain/planner/ClearanceField';
import { MotionPlanValidator } from '../domain/planner/MotionPlanValidator';
import { PoseCollisionChecker } from '../domain/planner/PoseCollisionChecker';
import type { PlannerRequest } from '../domain/planner/PlannerService';
import { TranslationSweepChecker } from '../domain/planner/TranslationSweepChecker';
import { MotionStateGuide } from '../domain/planning/MotionStateGuide';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import type { OccupancyGrid, PlannerResult } from '../domain/types';
import { sendBoxScaleRequest } from './fixtures/sendBoxScale';

const map = (width = 43, height = 41): OccupancyGrid => ({ metadata: {
  name: 'scale-regression', mapId: 'scale-regression', width, height, resolution: .05,
  origin: { x: -1, y: -1, yaw: .27 }, occupiedThreshold: 65, freeThreshold: 25, negate: false,
}, data: Array(width * height).fill(0) });
const configuration = (request: PlannerRequest) => createPlanningConfigurationSnapshot({
  plannerOptions: request.options, footprint: request.footprint }).normalized.motionState;
const event = (result: PlannerResult, type: string) =>
  result.motionPlannerEvents!.find((item) => item.eventType === type)!;
afterEach(() => vi.restoreAllMocks());

describe('SendBox-scale preprocessing and search', () => {
  it('coarsens the full 898x865 map, reuses static data for a new goal, and meets guide targets', () => {
    const request = sendBoxScaleRequest('open');
    const builder = new MotionStateGuide();
    const settings = configuration(request);
    const cold = builder.build(request.grid, request.start, request.goal, request.footprint, settings);
    expect(cold.resolutionM).toBe(.2);
    expect(cold.coarseGrid.metadata.width).toBe(225);
    expect(cold.coarseGrid.metadata.height).toBe(217);
    expect(cold.clearance).toHaveLength(898 * 865);
    expect(cold.status).toBe('found');
    expect(cold.durationMs).toBeLessThan(200);
    expect(cold.expandedCells).toBeLessThan(1_000);
    const warm = builder.build(structuredClone(request.grid), request.start,
      { ...request.goal, column: request.goal.column + 4 }, request.footprint, settings);
    expect(warm.cacheHit).toBe(true);
    expect(warm.clearance).toBe(cold.clearance);
    expect(warm.coarseGrid).toBe(cold.coarseGrid);
    expect(warm.durationMs).toBeLessThan(100);
    const repeated = builder.build(request.grid, request.start,
      { ...request.goal, column: request.goal.column + 4 }, request.footprint, settings);
    expect(repeated.heuristicCacheHit).toBe(true);
  });

  it('preserves every occupied/unknown fine cell under rotated, non-divisible downsampling', () => {
    const grid = map();
    for (const [row, col, value] of [[10, 14, 100], [22, 23, -1], [31, 32, 65], [0, 42, 100]])
      grid.data[row! * grid.metadata.width + col!] = value!;
    const request = sendBoxScaleRequest('open');
    const guide = new MotionStateGuide().build(grid, { row: 15, column: 5 },
      { row: 15, column: 35 }, request.footprint, configuration(request));
    const original = new CoordinateTransformer(grid.metadata);
    const coarse = new CoordinateTransformer(guide.coarseGrid.metadata);
    grid.data.forEach((value, index) => {
      if (value !== -1 && value < grid.metadata.occupiedThreshold) return;
      const world = original.gridToWorld(Math.floor(index / grid.metadata.width), index % grid.metadata.width);
      const cell = coarse.worldToGrid(world.x, world.y)!;
      const aggregated = guide.coarseGrid.data[coarse.index(cell)]!;
      expect(aggregated < 0 || aggregated >= grid.metadata.occupiedThreshold).toBe(true);
    });
    expect(guide.coarseGrid.data.some((value) => value < 0)).toBe(true);
    // Coarse padding never enlarges the physically valid source map.
    expect(guide.coarseGrid.data.at(-1)).not.toBeUndefined();
  });

  it('invalidates static data for in-place edits, origin, footprint, margins and guide resolution', () => {
    const grid = map();
    const footprint = structuredClone(defaultFootprint);
    const options = structuredClone(defaultPlannerOptions);
    const builder = new MotionStateGuide();
    const build = (targetResolutionM = .2) => builder.build(grid, { row: 15, column: 6 },
      { row: 15, column: 32 }, footprint,
      createPlanningConfigurationSnapshot({ plannerOptions: options, footprint }).normalized.motionState,
      { targetResolutionM, budgetMs: 150 });
    const first = build(); expect(build().cacheHit).toBe(true);
    grid.data[15 * grid.metadata.width + 20] = -1;
    const changed = build(); expect(changed.cacheHit).toBe(false);
    expect(changed.clearance).not.toBe(first.clearance);
    grid.metadata.origin.yaw += .1; expect(build().cacheHit).toBe(false);
    footprint.width += .1; expect(build().cacheHit).toBe(false);
    options.passageSafety.localizationMarginM += .1; expect(build().cacheHit).toBe(false);
    expect(build(.15).cacheHit).toBe(false);
  });

  it('gives corridors their full stage budgets even after 2476 ms of guide preparation', () => {
    const request = sendBoxScaleRequest('open');
    const realNow = performance.now.bind(performance);
    let guideDelay = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + guideDelay);
    const build = MotionStateGuide.prototype.build;
    vi.spyOn(MotionStateGuide.prototype, 'build').mockImplementation(function (this: MotionStateGuide, ...args) {
      const result = build.apply(this, args);
      guideDelay += 2476;
      return result;
    });
    const result = new MotionStatePlanner().plan(request);
    expect(result.success).toBe(true);
    const start = event(result, 'motionplanner.corridor.started');
    expect(Number(start.remainingSearchBudgetMs)).toBeGreaterThan(2900);
    expect(Number(start.stageBudgetMs)).toBeGreaterThan(300);
    expect(Number(event(result, 'motionplanner.corridor.completed').expanded)).toBeGreaterThan(0);
    expect(result.statistics.durationMs).toBeGreaterThan(2476);
  });

  it.each(['clutter', 'detour'] as const)('solves full-size %s with production costs and validates the original map', (kind) => {
    const request = sendBoxScaleRequest(kind);
    const result = new MotionStatePlanner().plan(request);
    expect(result.success, result.error).toBe(true);
    expect(result.statistics.durationMs).toBeLessThan(2500);
    const guide = event(result, 'motionplanner.guide.created');
    expect(Number(guide.durationMs)).toBeLessThan(200);
    const stages = result.motionPlannerEvents!.filter((e) => e.eventType === 'motionplanner.corridor.completed');
    expect(stages.every((stage) => Number(stage.expanded) > 0)).toBe(true);
    const counts = event(result, 'motionplanner.completed');
    const collisions = counts.primitiveCollisions as Record<string, number>;
    expect(collisions['0.500']).toBeGreaterThan(0);
    expect(collisions['0.500']).toBeGreaterThan(collisions['0.050'] ?? 0);
    const settings = configuration(request);
    const footprint = { ...request.footprint, safetyMargin: settings.footprint.effectiveSafetyMarginM };
    expect(new MotionPlanValidator().validate(result.motionPlan!, request.grid, footprint,
      settings.sampling.translationCollisionIntervalM, settings.sampling.rotationCollisionIntervalRad,
      false, 0).valid).toBe(true);
    expect(result.motionPlannerCalibration!.result.minimumClearanceM).toBeGreaterThanOrEqual(
      settings.clearance.hardMinimumM);
    expect(result.motionPlan!.states[0]!.x).toBe(request.exactStartPose!.x);
    expect(result.motionPlan!.states.at(-1)!.x).toBe(request.exactGoalPose!.x);
    // Independently fail closed at publish validation after a map update.
    const moved = structuredClone(request.grid);
    moved.data[request.goal.row * moved.metadata.width + request.goal.column] = 100;
    expect(new MotionPlanValidator().validate(result.motionPlan!, moved, footprint,
      settings.sampling.translationCollisionIntervalM, settings.sampling.rotationCollisionIntervalRad,
      false, 0).valid).toBe(false);
  });

  it('checks a valid short primitive after both long primitives collide', () => {
    const grid = map(80, 80); grid.metadata.origin = { x: 0, y: 0, yaw: 0 };
    const transform = new CoordinateTransformer(grid.metadata);
    const start = { row: 40, column: 30 }; const goal = { row: 40, column: 32 };
    grid.data[38 * 80 + 38] = 100;
    const footprint = { ...defaultFootprint, length: .4, width: .2,
      safetyMargin: 0, polygon: undefined };
    const options = structuredClone(defaultPlannerOptions);
    options.passageSafety.planningSafetyMarginM = 0; options.passageSafety.localizationMarginM = 0;
    const request: PlannerRequest = { grid, start, goal, footprint, options, startTheta: 0, goalTheta: 0,
      exactStartPose: transform.gridToWorld(start.row, start.column),
      exactGoalPose: transform.gridToWorld(goal.row, goal.column) };
    const result = new MotionStatePlanner().plan(request);
    expect(result.success).toBe(true);
    const counts = event(result, 'motionplanner.completed');
    expect((counts.primitiveCollisions as Record<string, number>)['0.500']).toBeGreaterThan(0);
    expect((counts.primitiveCollisions as Record<string, number>)['0.250']).toBeGreaterThan(0);
    expect((counts.primitiveAccepted as Record<string, number>)['0.050']).toBeGreaterThan(0);
  });

  it('uses exact body-axis primitive endpoints for all 16 headings without grid snapping', () => {
    const grid = map(80, 80); grid.metadata.origin.yaw = 0;
    const transform = new CoordinateTransformer(grid.metadata);
    const footprint = { ...defaultFootprint, length: .2, width: .2, safetyMargin: 0,
      turnOnSpotAllowed: false, allowTurnOnSpot: false };
    const check = vi.spyOn(TranslationSweepChecker.prototype, 'segmentIsFreeAtHeading');
    for (let bin = 0; bin < 16; bin += 1) {
      const theta = bin * Math.PI / 8;
      const initial = { ...transform.gridToWorld(40, 40), theta };
      const goal = { ...initial, x: initial.x + Math.cos(theta) * .3,
        y: initial.y + Math.sin(theta) * .3 };
      const result = new MotionStatePlanner().plan({ grid, start: { row: 40, column: 40 },
        goal: transform.worldToGrid(goal.x, goal.y)!, exactStartPose: initial, exactGoalPose: goal,
        startTheta: theta, goalTheta: theta, footprint, options: structuredClone(defaultPlannerOptions) });
      expect(result.success).toBe(true);
    }
    for (const [, from, to, , , heading] of check.mock.calls) {
      const dx = to.x - from.x; const dy = to.y - from.y;
      expect(Math.abs(dx * Math.sin(heading) - dy * Math.cos(heading))).toBeLessThan(1e-7);
      expect(dx * Math.cos(heading) + dy * Math.sin(heading)).toBeGreaterThan(0);
    }
  });

  it('times out guide work without declaring physical infeasibility', () => {
    const request = sendBoxScaleRequest('open');
    const guide = new MotionStateGuide().build(request.grid, request.start, request.goal,
      request.footprint, configuration(request), { targetResolutionM: .2, budgetMs: 0 });
    expect(guide.status).toBe('budget-exhausted'); expect(guide.cells).toEqual([]);
    vi.spyOn(MotionStateGuide.prototype, 'build').mockReturnValue(guide);
    const result = new MotionStatePlanner().plan(request);
    expect(result.success).toBe(true);
    expect(event(result, 'motionplanner.corridor.started').unrestricted).toBe(true);
    request.options.maxPlanningTimeMs = 0;
    const timeout = new MotionStatePlanner().plan(request);
    expect(timeout.diagnostics!.physicalFailureCode).toBe('MOTION_STATE_SEARCH_TIMEOUT');
    expect(event(timeout, 'motionplanner.completed').reason).toMatch(/timed out/);
  });
});

describe('physical calculation equivalence', () => {
  it('preserves the exact nearest-obstacle octile metric, including unknown cells', () => {
    const grid = map(21, 23);
    const obstacles = [{ row: 0, column: 20 }, { row: 9, column: 1 },
      { row: 7, column: 13 }, { row: 22, column: 8 }];
    obstacles.forEach((cell, index) => { grid.data[cell.row * 21 + cell.column] = index % 2 ? -1 : 100; });
    const field = buildMotionStateClearanceField(grid);
    for (let row = 0; row < 23; row += 1) for (let column = 0; column < 21; column += 1) {
      const expected = Math.min(...obstacles.map((cell) => {
        const dx = Math.abs(column - cell.column); const dy = Math.abs(row - cell.row);
        return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * .05;
      }));
      expect(field[row * 21 + column]).toBeCloseTo(expected, 6);
    }
    expect(buildMotionStateClearanceField(structuredClone(grid))).toBe(field);
  });

  it('matches uncached polygon collision at sub-cell positions, all headings, unknowns and map boundaries', () => {
    const grid = map(40, 40);
    for (let row = 0; row < 40; row += 1) grid.data[row * 40 + 20] = row % 3 ? 100 : -1;
    const fast = new PoseCollisionChecker(grid); const reference = new PoseCollisionChecker();
    const transform = new CoordinateTransformer(grid.metadata);
    const footprint = { ...defaultFootprint, source: 'bosch-client-motion' as const,
      centerOffsetX: .12, safetyMargin: .1, polygon: [
        { x: -.3, y: -.12 }, { x: .15, y: -.12 }, { x: .2, y: .2 }, { x: -.3, y: .2 },
      ] };
    for (const column of [0, 4, 12, 16, 20, 25, 32, 39]) for (let bin = 0; bin < 16; bin += 1) {
      const point = { ...transform.gridToWorld(20, column), theta: bin * Math.PI / 8 };
      for (const offset of [0, .017]) {
        const shifted = { ...point, x: point.x + offset };
        expect(fast.pointIsFree(grid, shifted, footprint)).toBe(reference.pointIsFree(grid, shifted, footprint));
        expect(fast.inspectPose(grid, shifted, footprint)).toEqual(reference.inspectPose(grid, shifted, footprint));
      }
    }
  });
});
