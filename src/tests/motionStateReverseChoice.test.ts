import { describe, expect, it } from 'vitest';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import { alignedReverseRequest, auditReverseChoice } from './fixtures/reverseChoiceAudit';

describe('aligned goal behind robot: cost-choice investigation', () => {
  it.each([
    { reverse: 2, switchCost: 1, expected: 'TRANSLATE_FORWARD', expectedReverse: 3 },
    { reverse: 0, switchCost: 1, expected: 'TRANSLATE_REVERSE', expectedReverse: 1 },
    { reverse: .01, switchCost: .01, expected: 'TRANSLATE_REVERSE', expectedReverse: 1.01 },
  ])('compares both initial solutions with reverse=$reverse and switch=$switchCost',
    ({ reverse, switchCost, expected, expectedReverse }) => {
      const { result, alternatives } = auditReverseChoice(alignedReverseRequest(reverse, switchCost));
      expect(result.success).toBe(true);
      expect(alternatives.every((alternative) => alternative.feasible)).toBe(true);
      expect(alternatives[0]!.cost).toBeCloseTo(1 + .3 * Math.PI + switchCost);
      expect(alternatives[1]!.cost).toBeCloseTo(expectedReverse);
      expect(alternatives[1]!.actions!.map((action) => action.type))
        .toEqual(['DIRECTION_CHANGE', 'TRANSLATE_REVERSE']);
      expect(result.motionPlan!.actions.some((action) => action.type === expected)).toBe(true);
      if (expected === 'TRANSLATE_REVERSE') expect(result.motionPlan!.actions.map((action) => action.type))
        .toEqual(['DIRECTION_CHANGE', 'TRANSLATE_REVERSE']);
      expect(result.motionPlannerEvents!.some((event) => event.eventType === 'motionplanner.transition.candidate' &&
        event.transitionType === 'DIRECTION_CHANGE' && String(event.to).endsWith('REVERSE'))).toBe(true);
    });

  it('charges forward preference even without a final heading request', () => {
    const { result, alternatives } = auditReverseChoice(alignedReverseRequest(0, 1, false));
    expect(alternatives[0]!.cost).toBeCloseTo(2 + .15 * Math.PI);
    expect(alternatives[1]!.cost).toBeCloseTo(1);
    expect(result.motionPlan!.actions.some((action) => action.type === 'TRANSLATE_REVERSE')).toBe(true);
  });

  it('rotates before reverse only by the real off-axis bearing error', () => {
    const request = alignedReverseRequest(.01, .01, false);
    request.planningConfiguration = createPlanningConfigurationSnapshot({
      plannerOptions: request.options, footprint: request.footprint,
      orderSettings: { allowedDeviationXy: 0 },
    });
    request.exactGoalPose = { x: 2, y: 2.1, theta: 0 };
    request.goal = new CoordinateTransformer(request.grid.metadata).worldToGrid(2, 2.1)!;
    const { result, alternatives } = auditReverseChoice(request);
    const reverse = alternatives[1]!;
    const expectedRotation = Math.atan2(.1, 1);
    expect(reverse.feasible).toBe(true);
    expect(reverse.actions!.map((action) => action.type))
      .toEqual(['DIRECTION_CHANGE', 'ROTATE_IN_PLACE', 'TRANSLATE_REVERSE']);
    expect(reverse.actions![1]!.rotationRad).toBeCloseTo(expectedRotation);
    expect(result.motionPlan!.actions.map((action) => action.type))
      .toEqual(['DIRECTION_CHANGE', 'ROTATE_IN_PLACE', 'TRANSLATE_REVERSE']);
  });

  it('rejects a straight reverse connector when its swept path is blocked', () => {
    const request = alignedReverseRequest(.01, .01, false);
    const cell = new CoordinateTransformer(request.grid.metadata).worldToGrid(2.5, 2)!;
    request.grid.data[cell.row * request.grid.metadata.width + cell.column] = 100;
    const { alternatives } = auditReverseChoice(request);
    const reverse = alternatives[1]!;
    expect(reverse.feasible).toBe(false);
    expect(reverse.rejections?.some((event) => event.reason === 'HARD_MINIMUM_CLEARANCE' ||
      event.reason === 'TRANSLATION_SWEEP_COLLISION')).toBe(true);
  });

  it('uses the authoritative backward permission, even if the legacy allowReverse flag disagrees', () => {
    const request = alignedReverseRequest(.01, .01);
    request.footprint.backwardAllowed = false;
    const { result, alternatives } = auditReverseChoice(request);
    expect(result.success).toBe(true);
    expect(alternatives[1]!.feasible).toBe(false);
    expect(result.motionPlan!.actions.some((action) => action.type === 'TRANSLATE_REVERSE')).toBe(false);
  });
});
