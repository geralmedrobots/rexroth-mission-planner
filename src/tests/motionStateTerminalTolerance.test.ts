import { describe, expect, it } from 'vitest';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import { MotionPlanValidator } from '../domain/planner/MotionPlanValidator';
import { alignedReverseRequest } from './fixtures/reverseChoiceAudit';

function fixture(dx: number, dy: number, tolerance = .2, explicit = false) {
  const request = alignedReverseRequest(.01, .01, explicit);
  request.exactGoalPose = { x: 3 + dx, y: 2 + dy, theta: 0 };
  request.goal = new CoordinateTransformer(request.grid.metadata)
    .worldToGrid(3 + dx, 2 + dy)!;
  request.planningConfiguration = createPlanningConfigurationSnapshot({
    plannerOptions: request.options, footprint: request.footprint,
    orderSettings: { allowedDeviationXy: tolerance },
  });
  return request;
}

describe('terminal position tolerance', () => {
  it.each([-1, 1])('keeps the exact body heading for a 2.8 degree approach, sign %s', (sign) => {
    const request = fixture(sign, Math.tan(2.8 * Math.PI / 180));
    const result = new MotionStatePlanner().plan(request);
    expect(result.success).toBe(true);
    expect(result.motionPlan!.actions.map((action) => action.type)).toEqual(sign < 0 ?
      ['DIRECTION_CHANGE', 'TRANSLATE_REVERSE'] : ['TRANSLATE_FORWARD']);
    const endpoint = result.motionPlan!.states.at(-1)!;
    expect(endpoint.theta).toBe(0);
    expect(endpoint.x).toBeCloseTo(3 + sign);
    expect(endpoint.y).toBeCloseTo(2);
    expect(Math.hypot(endpoint.x - request.exactGoalPose!.x,
      endpoint.y - request.exactGoalPose!.y)).toBeLessThan(.2);
    expect(new MotionPlanValidator().validate(result.motionPlan!, request.grid,
      request.footprint, .03, Math.PI / 36, true).valid).toBe(true);
    const diagnostic = result.motionPlannerEvents!.find((event) =>
      event.eventType === 'motionplanner.terminalConnector.selection')!;
    expect(diagnostic.selectedCandidate).toBe(sign < 0 ? 'straight-reverse' : 'straight-forward');
    const candidates = diagnostic.candidates as Array<{ name: string; cost: number | null }>;
    expect(candidates).toHaveLength(4);
    if (sign < 0) expect(candidates.find((c) => c.name === 'straight-reverse')!.cost!)
      .toBeLessThan(candidates.find((c) => c.name === 'rotate-forward')!.cost!);
  });

  it('retains rotation outside the configured XY allowance', () => {
    const result = new MotionStatePlanner().plan(fixture(-1, .1, .05));
    expect(result.success).toBe(true);
    expect(result.motionPlan!.actions.some((a) => a.type === 'ROTATE_IN_PLACE')).toBe(true);
  });

  it('keeps exact position and restores an explicitly requested heading', () => {
    const result = new MotionStatePlanner().plan(fixture(-1, .1, .2, true));
    expect(result.success).toBe(true);
    const end = result.motionPlan!.states.at(-1)!;
    expect(end.x).toBeCloseTo(2);
    expect(end.y).toBeCloseTo(2.1);
    expect(end.theta).toBeCloseTo(0);
    expect(result.motionPlan!.actions.filter((a) => a.type === 'ROTATE_IN_PLACE')).toHaveLength(2);
  });

  it('rejects a projected reverse endpoint whose path violates hard clearance', () => {
    const request = fixture(-1, .05);
    const cell = new CoordinateTransformer(request.grid.metadata).worldToGrid(2.5, 2)!;
    request.grid.data[cell.row * request.grid.metadata.width + cell.column] = 100;
    const result = new MotionStatePlanner().plan(request);
    const diagnostic = result.motionPlannerEvents!.find((event) =>
      event.eventType === 'motionplanner.terminalConnector.selection')!;
    const straight = (diagnostic.candidates as Array<{ name: string; feasible: boolean;
      rejections: Array<{ reason: string }> }>).find((c) => c.name === 'straight-reverse')!;
    expect(straight.feasible).toBe(false);
    expect(straight.rejections.some((r) => r.reason === 'HARD_MINIMUM_CLEARANCE')).toBe(true);
  });

  it('rejects footprint sweep collisions even when centerline clearance passes', () => {
    const request = fixture(-1, -.05);
    const cell = new CoordinateTransformer(request.grid.metadata).worldToGrid(2.5, 2.15)!;
    request.grid.data[cell.row * request.grid.metadata.width + cell.column] = 100;
    const result = new MotionStatePlanner().plan(request);
    const diagnostic = result.motionPlannerEvents!.find((event) =>
      event.eventType === 'motionplanner.terminalConnector.selection')!;
    const straight = (diagnostic.candidates as Array<{ name: string; feasible: boolean;
      rejections: Array<{ reason: string }> }>).find((c) => c.name === 'straight-reverse')!;
    expect(straight.feasible).toBe(false);
    expect(straight.rejections.some((r) => r.reason === 'TRANSLATION_SWEEP_COLLISION')).toBe(true);
  });
});
