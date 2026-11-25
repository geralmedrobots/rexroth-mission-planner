import { describe, expect, it } from 'vitest';
import { directionPreference, preparationContext, recomputeDirectionPreference } from '../domain/planning/DirectionPreference';
import { compareManoeuvres, manoeuvreRequest } from './fixtures/manoeuvreComparison';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { MotionPlanOptimiser } from '../domain/planning/MotionPlanOptimiser';
import { MotionPlanValidator } from '../domain/planner/MotionPlanValidator';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import type { MotionPlan, MotionState, MotionDirection, MotionCostComponents } from '../domain/motion/planningModel';

describe('geometric direction preference', () => {
  it.each([[-3.5186, 0, 'REVERSE'], [-3.5186, .254, 'REVERSE'],
    [3.5186, 0, 'FORWARD'], [3.5186, .254, 'FORWARD']])(
    'assigns preference once for goal offset %s, %s', (dx, dy, preferred) => {
      const { result, candidates } = compareManoeuvres(manoeuvreRequest(Number(dx), Number(dy), false));
      for (const name of ['rotate-forward', 'rotate-reverse']) {
        const c = candidates.find((candidate) => candidate.name === name)!;
        expect(c.feasible).toBe(true);
        expect(c.costComponents!.directionSwitch).toBe(name.endsWith(String(preferred).toLowerCase()) ? 0 : 1);
      }
      expect(result.motionPlan!.actions.filter((a) => a.type === 'DIRECTION_CHANGE')
        .every((a) => a.costComponents!.total === 0)).toBe(true);
      if (preferred === 'REVERSE') expect(result.motionPlan!.actions.map((a) => a.type)).toContain('DIRECTION_CHANGE');
    });

  it.each(['FORWARD', 'REVERSE'] as const)('preserves %s at numerical ties, including after a pending switch', (direction) => {
    const state = { x: 0, y: 0, theta: 0, direction };
    for (const offset of [-1e-9, 0, 1e-9]) {
      const goal = { x: Math.cos(Math.PI / 2 + offset), y: Math.sin(Math.PI / 2 + offset) };
      expect(directionPreference(state, goal, direction, 1).preferredDirection).toBe(direction);
      const changed: MotionState = { ...state, direction: direction === 'FORWARD' ? 'REVERSE' : 'FORWARD',
        directionPreferenceContext: preparationContext(state) };
      expect(directionPreference(changed, goal, changed.direction, 1).penaltyAmount).toBe(1);
    }
  });

  it('does not use the tie epsilon as an angular tolerance', () => {
    expect(directionPreference({ x: 0, y: 0, theta: 0, direction: 'FORWARD' },
      { x: -1e-5, y: 1 }, 'REVERSE', 1).preferredDirection).toBe('REVERSE');
  });

  it('keeps pre-rotation heading so splitting preparation cannot avoid the charge', () => {
    const initial: MotionState = { x: 0, y: 0, theta: 0, direction: 'FORWARD' };
    const rotated = { ...initial, theta: Math.PI, directionPreferenceContext: preparationContext(initial) };
    const evidence = directionPreference(rotated, { x: -1, y: 0 }, 'FORWARD', 1);
    expect(evidence.preferredDirection).toBe('REVERSE');
    expect(evidence.penaltyAmount).toBe(1);
  });

  it('charges one non-preferred reverse run before and after optimiser merging', () => {
    const request = manoeuvreRequest(3, 0, false);
    const states: MotionState[] = [
      { x: 2, y: 2, theta: Math.PI, direction: 'FORWARD' },
      { x: 2, y: 2, theta: Math.PI, direction: 'REVERSE' },
      { x: 2, y: 2, theta: 0, direction: 'REVERSE' },
      ...[1.9, 1.8, 1.7].map((x) => ({ x, y: 2, theta: 0, direction: 'REVERSE' as MotionDirection })),
    ];
    const zero = (): MotionCostComponents => ({ distance: 0, rotation: 0, reverse: 0,
      directionSwitch: 0, wallClearance: 0, narrowPassage: 0, turnLocation: 0, terminalOrientation: 0, total: 0 });
    const plan: MotionPlan = { states, metadata: {}, actions: states.slice(1).map((to, index) => ({
      from: states[index]!, to, type: index === 0 ? 'DIRECTION_CHANGE' : index === 1 ? 'ROTATE_IN_PLACE' : 'TRANSLATE_REVERSE',
      costComponents: zero(),
    })) };
    recomputeDirectionPreference(plan, 1);
    expect(plan.actions.map((a) => a.costComponents!.directionSwitch)).toEqual([0, 0, 1, 0, 0]);
    const optimised = new MotionPlanOptimiser().optimise(plan, request.grid, request.footprint,
      request.planningConfiguration!.normalized.motionState).plan;
    expect(optimised.actions.filter((a) => a.type === 'TRANSLATE_REVERSE')).toHaveLength(1);
    expect(optimised.actions.reduce((sum, a) => sum + a.costComponents!.directionSwitch, 0)).toBe(1);
  });

  it('charges lattice translation choices once and carries the run across primitive boundaries', () => {
    type Transitions = MotionStatePlanner['transitions'];
    const planner = new MotionStatePlanner();
    const instrumented = planner as unknown as { transitions: Transitions };
    const original = instrumented.transitions;
    let captured: Parameters<Transitions> | undefined;
    instrumented.transitions = function (...args) {
      captured ??= args;
      return original.apply(planner, args);
    };
    planner.plan(manoeuvreRequest(-3.5186, .254, false));
    const args = [...captured!] as Parameters<Transitions>;
    args[0] = { ...args[0], theta: 0, direction: 'REVERSE',
      directionPreferenceContext: { heading: Math.PI, direction: 'FORWARD', translating: false } };
    args[9] = () => {};
    args[12] = () => true;
    const first = original.apply(planner, args).find((edge) => edge.action.type === 'TRANSLATE_REVERSE')!;
    expect(first.action.costComponents!.directionSwitch).toBe(1);
    args[0] = first.state;
    const second = original.apply(planner, args).find((edge) => edge.action.type === 'TRANSLATE_REVERSE')!;
    expect(second.action.costComponents!.directionSwitch).toBe(0);
    expect(second.action.costComponents!.reverse).toBeCloseTo(.3 * second.action.distanceM!);
  });

  it('chooses safe forward when the asymmetric rear footprint blocks reverse', () => {
    const request = manoeuvreRequest(-3, 0, false);
    request.footprint.length = .6;
    request.footprint.centerOffsetX = -.25;
    const cell = new CoordinateTransformer(request.grid.metadata).worldToGrid(1.6, 2)!;
    request.grid.data[cell.row * request.grid.metadata.width + cell.column] = 100;
    const transform = new CoordinateTransformer(request.grid.metadata);
    for (let x = 1; x < 4; x += .1) for (const y of [1.7, 2.3]) {
      const wall = transform.worldToGrid(x, y)!;
      request.grid.data[wall.row * request.grid.metadata.width + wall.column] = 100;
    }
    request.planningConfiguration = createPlanningConfigurationSnapshot({
      plannerOptions: request.options, footprint: request.footprint,
      orderSettings: { allowedDeviationXy: 0 } });
    const { result, candidates } = compareManoeuvres(request);
    expect(candidates.find((c) => c.name === 'rotate-reverse')!.feasible).toBe(false);
    expect(candidates.find((c) => c.name === 'rotate-forward')!.costComponents!.directionSwitch).toBe(1);
    expect(result.success).toBe(true);
    expect(result.motionPlan!.actions.some((a) => a.type === 'TRANSLATE_FORWARD')).toBe(true);
    expect(new MotionPlanValidator().validate(result.motionPlan!, request.grid,
      request.footprint, .03, Math.PI / 36, true).valid).toBe(true);
  });
});
