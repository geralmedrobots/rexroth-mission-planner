import { afterEach, describe, expect, it, vi } from 'vitest';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import { MotionStateRefinement } from '../domain/planning/MotionStateRefinement';
import { MotionPlanValidator } from '../domain/planner/MotionPlanValidator';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import type { PlannerRequest } from '../domain/planner/PlannerService';
import type { PlannerResult } from '../domain/types';
import { openRefinementFixture, refinementFixture } from './fixtures/adaptiveRefinement';

const completed = (result: PlannerResult) => result.motionPlannerEvents!.find(
  (event) => event.eventType === 'motionplanner.completed')!;
const counts = (result: PlannerResult, key: string) =>
  completed(result)[key] as Record<string, number>;
const validate = (request: PlannerRequest, result: PlannerResult) => {
  expect(result.success).toBe(true);
  expect(new MotionPlanValidator().validate(result.motionPlan!, request.grid,
    request.footprint, request.options.collisionSampleInterval,
    request.options.passageSafety.rotationCollisionSampleDeg * Math.PI / 180,
    false, request.goalTheta).valid).toBe(true);
};

afterEach(() => vi.restoreAllMocks());

describe('clearance-driven local motion-state refinement', () => {
  it.each([2, 18])('keeps an easy %s m route coarse and merges straight planning states', (distanceM) => {
    const request = openRefinementFixture(distanceM);
    const result = new MotionStatePlanner().plan(request);
    validate(request, result);
    expect(Object.keys(counts(result, 'primitiveAttempts')).sort()).toEqual(['0.250', '0.500']);
    expect(counts(result, 'generatedStatesByMode').normal).toBeGreaterThan(0);
    expect(counts(result, 'generatedStatesByMode').tight).toBe(0);
    expect(counts(result, 'generatedStatesByMode').medium).toBe(0);
    expect(completed(result).minimumRefinementClearanceM).toBeNull();
    expect(result.statistics.visitedCells).toBeLessThan(100);
    expect(result.statistics.durationMs).toBeLessThan(1000);
    expect(result.motionPlan!.states).toHaveLength(2);
    if (distanceM > 12) expect(Number((result.motionPlan!.diagnostics!.selected as
      Record<string, unknown>).longPrimitiveTransitions)).toBeGreaterThan(0);
  });

  it('finds the tight turn lost by the original cell-only lattice', () => {
    const request = refinementFixture(.4, .45, .22, .025);
    const result = new MotionStatePlanner().plan(request);
    validate(request, result);
    expect(counts(result, 'primitiveAccepted')['0.100']).toBeGreaterThan(0);
    expect(counts(result, 'primitiveAccepted')['0.050']).toBeGreaterThan(0);
    expect(counts(result, 'generatedStatesByMode').tight).toBeGreaterThan(0);
    expect(result.statistics.visitedCells).toBeLessThan(300);
    const optimiser = result.motionPlannerEvents!.find(
      (event) => event.eventType === 'motionplan.optimised')!;
    expect(Number(optimiser.outputStateCount)).toBeLessThan(Number(optimiser.inputStateCount));
    // Ablation: keeping the refined keys without the short manoeuvring moves
    // still cannot negotiate this corner. No collision checks are mocked.
    vi.spyOn(MotionStateRefinement.prototype, 'distances').mockReturnValue([.5, .25]);
    expect(new MotionStatePlanner().plan(request).success).toBe(false);
  });

  it('retains both short lengths in a narrow passage on a 0.05 m map', () => {
    const request = refinementFixture(.4, .45, .22, .025, .05);
    const result = new MotionStatePlanner().plan(request);
    validate(request, result);
    expect(counts(result, 'primitiveAccepted')['0.100']).toBeGreaterThan(0);
    expect(counts(result, 'primitiveAccepted')['0.050']).toBeGreaterThan(0);
    expect(counts(result, 'primitiveAccepted')['0.500']).toBeGreaterThan(0);
    vi.spyOn(MotionStateRefinement.prototype, 'distances').mockReturnValue([.5, .25]);
    expect(new MotionStatePlanner().plan(request).success).toBe(false);
  });

  it('generates medium-clearance states and 0.10 m moves', () => {
    const request = refinementFixture(.8, .35, .22, .025);
    const result = new MotionStatePlanner().plan(request);
    validate(request, result);
    expect(counts(result, 'generatedStatesByMode').medium).toBeGreaterThan(0);
    expect(counts(result, 'primitiveAccepted')['0.100']).toBeGreaterThan(0);
  });

  it.each([100, -1])('cannot shortcut through a sealed passage (cell value %s)', (value) => {
    const request = refinementFixture(.4, .45, .22, .025);
    for (let row = 0; row < request.grid.metadata.height; row++)
      request.grid.data[row * request.grid.metadata.width + 20] = value;
    const result = new MotionStatePlanner().plan(request);
    expect(result.success).toBe(false);
    expect(result.motionPlan).toBeUndefined();
    const event = completed(result);
    expect(Number(event.translationCollisions) + Object.values(
      counts(result, 'primitiveClearanceRejections')).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    for (const [length, attempts] of Object.entries(counts(result, 'primitiveAttempts')))
      expect(attempts).toBe((counts(result, 'primitiveAccepted')[length] ?? 0) +
        (counts(result, 'primitiveCollisions')[length] ?? 0) +
        (counts(result, 'primitiveClearanceRejections')[length] ?? 0));
  });

  it('derives thresholds from the expanded footprint and existing clearance values', () => {
    const request = refinementFixture();
    const configuration = createPlanningConfigurationSnapshot({
      plannerOptions: request.options, footprint: request.footprint }).normalized.motionState;
    const policy = new MotionStateRefinement(request.footprint, configuration, .1);
    const radius = Math.hypot(.2, .11);
    expect(policy.tightClearanceM).toBeCloseTo(radius + configuration.clearance.hardMinimumM);
    expect(policy.mediumClearanceM).toBeCloseTo(radius + configuration.clearance.preferredM);
    expect(policy.distances(policy.mode(policy.mediumClearanceM + .01), .1)).toEqual([.5, .25]);
    expect(policy.distances(policy.mode((policy.tightClearanceM + policy.mediumClearanceM) / 2), .1))
      .toEqual([.5, .25, .1]);
    expect(policy.distances(policy.mode(policy.tightClearanceM), .1)).toEqual([.5, .25, .1, .05]);
  });
});
