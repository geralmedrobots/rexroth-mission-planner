import { describe, expect, it } from 'vitest';
import { defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { CostModel } from '../domain/planning/CostModel';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import type { MotionPlan } from '../domain/motion/planningModel';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';

describe('Stage 3D–3F planning boundary', () => {
  it('normalizes legacy settings and freezes every snapshot level', () => {
    const snapshot = createPlanningConfigurationSnapshot({
      plannerOptions: { corridor: { unknownCellsBlocked: false }, passageSafety: { preferredWaypointSpacingM: 0.33 } },
      footprint: { backwardAllowed: true },
    });
    expect(snapshot.normalized.map.unknownCellsBlocked).toBe(false);
    expect(snapshot.normalized.waypointSpacingM.preferred).toBe(0.33);
    expect(snapshot.normalized.permissions.reverseAllowed).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.planner)).toBe(true);
    expect(() => ((snapshot.planner as unknown as { distanceWeight: number }).distanceWeight = 99)).toThrow();
  });

  it('keeps the existing named cost formulas numerically equivalent', () => {
    const options = { ...defaultPlannerOptions, policy: 'balanced' as const, reliableBaselineMode: false };
    expect(CostModel.distance(Math.hypot(3, 4), options.distanceWeight)).toBe(5);
    expect(CostModel.wallProximity(0.2, options)).toBeCloseTo(2 * 0.1 * 0.1 / 0.3);
    expect(CostModel.headingChange(Math.PI / 2, options)).toBeCloseTo(options.passageSafety.headingChangeWeight * Math.PI / 2);
    expect(CostModel.turnLocation(Math.PI / 2, 0.4, options)).toBeCloseTo(options.passageSafety.turnLocationWeight * Math.PI / 2 / 0.4);
    expect(CostModel.reverseRisk(true, options)).toBe(options.passageSafety.reverseRiskWeight);
    expect(CostModel.directionSwitchPenalty(options)).toBe(options.passageSafety.reverseRiskWeight * 0.5);
  });

  it('serializes an explicit MotionPlan deterministically by motion content', () => {
    const motionPlan: MotionPlan = {
      states: [
        { x: 0, y: 0, theta: 0, direction: 'FORWARD' },
        { x: 1, y: 0, theta: 0, direction: 'FORWARD' },
        { x: 1, y: 1, theta: Math.PI / 2, direction: 'REVERSE' },
      ], actions: [], metadata: { source: 'test' },
    };
    const context = { robotPose: { x: 0, y: 0, theta: 0, mapId: 'stage3', positionInitialized: true }, activeMapId: 'stage3', motionPlan };
    const first = new VdaOrderBuilder().build([{ x: 1, y: 0, theta: 0 }, { x: 1, y: 1, theta: 0 }], context, defaultOrderSettings, 'same-order');
    const second = new VdaOrderBuilder().build([{ x: 1, y: 0, theta: 0 }, { x: 1, y: 1, theta: 0 }], context, defaultOrderSettings, 'same-order');
    expect(second.nodes.map((node) => node.nodePosition)).toEqual(first.nodes.map((node) => node.nodePosition));
    expect(second.edges.map((edge) => ({ ...edge, edgeId: undefined, startNodeId: undefined, endNodeId: undefined }))).toEqual(
      first.edges.map((edge) => ({ ...edge, edgeId: undefined, startNodeId: undefined, endNodeId: undefined })),
    );
  });
});
