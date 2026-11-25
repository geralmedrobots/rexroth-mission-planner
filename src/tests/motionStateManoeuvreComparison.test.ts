import { describe, expect, it } from 'vitest';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import { compareManoeuvres, manoeuvreRequest } from './fixtures/manoeuvreComparison';

describe('complete forward and reverse manoeuvres', () => {
  it.each([[-3.5186, 0], [-3.5186, .254]])('compares full angles and costs behind: %s, %s', (dx, dy) => {
    const { result, candidates } = compareManoeuvres(manoeuvreRequest(dx, dy));
    const forward = candidates.find((c) => c.name === 'rotate-forward')!;
    const reverse = candidates.find((c) => c.name === 'rotate-reverse')!;
    const rearAngle = Math.atan2(dy, -dx);
    expect(forward.feasible && reverse.feasible).toBe(true);
    expect(forward.rotationSweepMagnitudeRad).toBeCloseTo(Math.PI - rearAngle, 12);
    expect(reverse.rotationSweepMagnitudeRad).toBeCloseTo(rearAngle, 12);
    expect(forward.costComponents!.rotation).toBeCloseTo(.15 * (Math.PI - rearAngle), 12);
    expect(reverse.costComponents!.rotation).toBeCloseTo(.15 * rearAngle, 12);
    expect(reverse.costComponents!.directionSwitch).toBe(0);
    expect(forward.costComponents!.directionSwitch).toBe(1);
    expect(reverse.costComponents!.reverse).toBeCloseTo(.3 * Math.hypot(dx, dy), 12);
    if (dy) expect(forward.costComponents!.turnLocation / reverse.costComponents!.turnLocation)
      .toBeCloseTo((Math.PI - rearAngle) / rearAngle, 10);
    expect(reverse.cost!).toBeLessThan(forward.cost!);
    expect(result.motionPlan!.actions.some((a) => a.type === 'TRANSLATE_REVERSE')).toBe(true);
  });

  it('prefers reverse in open space after assigning the preference penalty to forward', () => {
    const { candidates } = compareManoeuvres(manoeuvreRequest(-3.5186, .254, false));
    const forward = candidates.find((c) => c.name === 'rotate-forward')!;
    const reverse = candidates.find((c) => c.name === 'rotate-reverse')!;
    expect(forward.costComponents!.turnLocation).toBe(0);
    expect(reverse.cost!).toBeLessThan(forward.cost!);
  });

  it('prefers the small forward alignment for an ahead goal', () => {
    const { result, candidates } = compareManoeuvres(manoeuvreRequest(3.5186, .254, false));
    expect(candidates.find((c) => c.name === 'rotate-forward')!.rotationSweepMagnitudeRad)
      .toBeCloseTo(Math.atan2(.254, 3.5186), 12);
    expect(result.motionPlan!.actions.some((a) => a.type === 'TRANSLATE_FORWARD')).toBe(true);
  });

  it('rejects a blocked direct reverse manoeuvre', () => {
    const request = manoeuvreRequest();
    const cell = new CoordinateTransformer(request.grid.metadata).worldToGrid(3.2, 2.13)!;
    request.grid.data[cell.row * request.grid.metadata.width + cell.column] = 100;
    const { candidates } = compareManoeuvres(request);
    expect(candidates.find((c) => c.name === 'rotate-reverse')!.feasible).toBe(false);
  });

  it('rejects the large forward sweep while retaining the small reverse sweep', () => {
    const request = manoeuvreRequest(-3.5186, .254, false);
    request.footprint.length = 1.2;
    const cell = new CoordinateTransformer(request.grid.metadata).worldToGrid(5, 2.5)!;
    request.grid.data[cell.row * request.grid.metadata.width + cell.column] = 100;
    request.planningConfiguration = createPlanningConfigurationSnapshot({
      plannerOptions: request.options, footprint: request.footprint,
    });
    const { result, candidates } = compareManoeuvres(request);
    expect(candidates.find((c) => c.name === 'rotate-forward')!.rotationCollisionResult).toBe('COLLISION');
    const reverse = candidates.find((c) => c.name === 'rotate-reverse')!;
    expect(reverse.feasible).toBe(true);
    expect(reverse.rotationCollisionResult).toBe('PASSED');
    expect(result.motionPlan!.actions.some((a) => a.type === 'TRANSLATE_REVERSE')).toBe(true);
  });

  it('restores heading only when explicitly requested and charges the terminal rotation', () => {
    const request = manoeuvreRequest();
    request.goalTheta = 0;
    const { result, candidates } = compareManoeuvres(request);
    expect(result.motionPlan!.states.at(-1)!.theta).toBeCloseTo(0);
    expect(candidates.find((c) => c.name === 'rotate-reverse')!.costComponents!.terminalOrientation)
      .toBeCloseTo(.15 * Math.atan2(.254, 3.5186), 12);
  });
});
