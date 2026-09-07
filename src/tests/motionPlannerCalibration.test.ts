import { describe, expect, it, vi } from 'vitest';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { measureMotionPlan } from '../domain/motion/MotionPlanMetrics';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import type { PlannerRequest } from '../domain/planner/PlannerService';
import {
  compareMotionPlannerConfigurations, replayMotionPlannerScenario,
  type MotionPlannerReplayScenario,
} from '../domain/planning/MotionPlannerReplay';
import { MOTION_STATE_HEADING_BINS } from '../domain/planning/MotionStateConfiguration';
import { CostModel } from '../domain/planning/CostModel';
import type { OccupancyGrid, PlannerOptions, PlannerResult, RobotFootprint, RobotPose } from '../domain/types';
import { PlanningCoordinator, type PlanningInputs } from '../features/planning/PlanningCoordinator';

const makeGrid = (): OccupancyGrid => ({
  metadata: { name: 'calibration-map', mapId: 'calibration-map', width: 60,
    height: 60, resolution: .1, origin: { x: 0, y: 0, yaw: 0 },
    occupiedThreshold: 65, freeThreshold: 25, negate: false },
  data: Array(3_600).fill(0),
});
const pose = (map: OccupancyGrid, row: number, column: number,
  theta = 0): RobotPose => ({
  ...new CoordinateTransformer(map.metadata).gridToWorld(row, column), theta,
  mapId: map.metadata.mapId, positionInitialized: true,
});
const robot = (): RobotFootprint => ({
  ...structuredClone(defaultFootprint), length: .2, width: .2, safetyMargin: 0,
  inflationRadius: 0, allowReverse: true, backwardAllowed: true,
  forwardAllowed: true, allowTurnOnSpot: true, turnOnSpotAllowed: true,
});
const plannerOptions = (patch: Partial<PlannerOptions['passageSafety']> = {}): PlannerOptions => ({
  ...structuredClone(defaultPlannerOptions), policy: 'reliable', reliableBaselineMode: true,
  maxPlanningTimeMs: 5_000,
  passageSafety: { ...structuredClone(defaultPlannerOptions.passageSafety),
    planningSafetyMarginM: 0, localizationMarginM: 0,
    wallProximityWeight: 0, narrowPassageWeight: 0, turnLocationWeight: 0,
    ...patch },
});
const scenario = (options = plannerOptions(), west = false): MotionPlannerReplayScenario => {
  const map = makeGrid();
  const startPose = pose(map, 30, 30, 0);
  const goalPose = pose(map, 30, west ? 25 : 36, 0);
  return { grid: map, footprint: robot(), startPose, goalPose, goalTheta: 0,
    configuration: createPlanningConfigurationSnapshot({ plannerOptions: options,
      footprint: robot(), orderSettings: defaultOrderSettings }) };
};
const occupy = (map: OccupancyGrid, x: number, y: number): void => {
  const transform = new CoordinateTransformer(map.metadata);
  const cell = transform.worldToGrid(x, y);
  if (!cell) throw new Error('Obstacle outside calibration map.');
  map.data[transform.index(cell)] = 100;
};

describe('Stage 4B motion planner calibration', () => {
  it('A. normalizes every authoritative motion-state value consumed by planning', () => {
    const options = plannerOptions({
      headingChangeWeight: .31, reverseRiskWeight: 4.2,
      motionStateDirectionSwitchWeight: 1.7,
      motionStateTerminalOrientationWeight: .44,
      wallProximityWeight: 2.3, wallClearancePreferredM: .42,
      wallClearanceMinimumM: .12, narrowPassageWeight: 1.8,
      turnLocationWeight: .9, rotationCollisionSampleDeg: 3,
    });
    options.distanceWeight = 1.4;
    options.collisionSampleInterval = .021;
    const effective = createPlanningConfigurationSnapshot({ plannerOptions: options,
      footprint: robot() }).normalized.motionState;
    expect(effective).toMatchObject({
      weights: { translationCostPerM: 1.4, rotationCostPerRad: .31,
        reverseCostPerM: 4.2, directionSwitchCost: 1.7,
        wallClearanceCost: 2.3, narrowPassageCost: 1.8,
        turnLocationCost: .9, terminalOrientationCostPerRad: .44 },
      clearance: { preferredM: .42, hardMinimumM: .12 },
      sampling: { translationCollisionIntervalM: .021,
        rotationCollisionIntervalDeg: 3 },
      lattice: { headingBinCount: MOTION_STATE_HEADING_BINS,
        translationStepSource: 'GRID_RESOLUTION' },
      permissions: { forward: true, reverse: true, rotateInPlace: true },
    });
  });

  it('B. ignores conflicting legacy aliases after snapshot creation', () => {
    const options = plannerOptions({ headingChangeWeight: .4,
      reverseRiskWeight: 3, wallProximityWeight: 5 });
    options.turnPenalty = 999;
    options.reversePenalty = 998;
    options.proximityWeight = 997;
    const snapshot = createPlanningConfigurationSnapshot({ plannerOptions: options,
      footprint: robot() });
    options.passageSafety.headingChangeWeight = 777;
    expect(snapshot.normalized.motionState.weights).toMatchObject({
      rotationCostPerRad: .4, reverseCostPerM: 3,
      wallClearanceCost: 5,
    });
    expect(Object.isFrozen(snapshot.normalized.motionState)).toBe(true);
  });

  it('C. calibration snapshots reproduce selected-plan metrics', () => {
    const replay = replayMotionPlannerScenario(scenario());
    expect(replay.plannerResult.success).toBe(true);
    const measured = measureMotionPlan(replay.motionPlan!, scenario().grid,
      replay.calibration.effectiveParameters.sampling.translationCollisionIntervalM);
    expect(replay.calibration.result).toMatchObject({
      totalPathLengthM: measured.totalTranslationDistanceM,
      reversePathLengthM: measured.totalReverseDistanceM,
      totalAbsoluteRotationRad: measured.totalAbsoluteRotationRad,
      minimumClearanceM: measured.minimumClearanceM,
      averageClearanceM: measured.averageClearanceM,
      costs: measured.costs,
    });
  });

  it('D. replays identical captured inputs deterministically', () => {
    const captured = scenario();
    const first = replayMotionPlannerScenario(captured);
    const second = replayMotionPlannerScenario(captured);
    expect(second.calibration.result.planFingerprint)
      .toBe(first.calibration.result.planFingerprint);
    expect(second.motionPlan?.states).toEqual(first.motionPlan?.states);
    expect(second.costBreakdown).toEqual(first.costBreakdown);
    expect(second.calibration.map.revision).toBe(first.calibration.map.revision);
  });

  it('E. compares the exact same scenario without ranking variants', () => {
    const captured = scenario();
    const higherReverse = createPlanningConfigurationSnapshot({
      plannerOptions: plannerOptions({ reverseRiskWeight: 7 }), footprint: robot() });
    const rows = compareMotionPlannerConfigurations({ grid: captured.grid,
      footprint: captured.footprint, startPose: captured.startPose,
      goalPose: captured.goalPose, goalTheta: captured.goalTheta }, [
      { name: 'baseline', configuration: captured.configuration },
      { name: 'higher-reverse', configuration: higherReverse },
    ]);
    expect(rows.map((row) => row.configuration)).toEqual(['baseline', 'higher-reverse']);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => typeof row.expandedStates === 'number')).toBe(true);
  });

  it('F. changes only the normalized reverse cost input when reverse weight changes', () => {
    const baseline = createPlanningConfigurationSnapshot({
      plannerOptions: plannerOptions({ reverseRiskWeight: 2,
        motionStateDirectionSwitchWeight: 1 }), footprint: robot() });
    const changed = createPlanningConfigurationSnapshot({
      plannerOptions: plannerOptions({ reverseRiskWeight: 9,
        motionStateDirectionSwitchWeight: 1 }), footprint: robot() });
    expect(changed.normalized.motionState.weights).toEqual({
      ...baseline.normalized.motionState.weights, reverseCostPerM: 9,
    });
    expect(changed.normalized.motionState.weights.directionSwitchCost).toBe(1);
  });

  it('G. routes rotation weight only into the non-terminal rotation CostModel term', () => {
    const low = replayMotionPlannerScenario(scenario(plannerOptions({
      headingChangeWeight: .1, motionStateTerminalOrientationWeight: .15,
    }), true));
    const high = replayMotionPlannerScenario(scenario(plannerOptions({
      headingChangeWeight: .8, motionStateTerminalOrientationWeight: .15,
    }), true));
    expect(high.calibration.effectiveParameters.weights.rotationCostPerRad).toBe(.8);
    expect(high.calibration.effectiveParameters.weights.terminalOrientationCostPerRad).toBe(.15);
    expect(CostModel.rotation(1, high.calibration.effectiveParameters.weights.rotationCostPerRad))
      .toBe(.8);
    expect(CostModel.rotation(1,
      high.calibration.effectiveParameters.weights.terminalOrientationCostPerRad))
      .toBe(CostModel.rotation(1,
        low.calibration.effectiveParameters.weights.terminalOrientationCostPerRad));
  });

  it('H. applies clearance preference to transitions even under legacy reliable policy', () => {
    const captured = scenario(plannerOptions({ wallProximityWeight: 3,
      wallClearancePreferredM: .8, wallClearanceMinimumM: .05 }));
    occupy(captured.grid, captured.startPose.x + .3, captured.startPose.y + .35);
    const replay = replayMotionPlannerScenario(captured);
    expect(replay.calibration.effectiveParameters.weights.wallClearanceCost).toBe(3);
    expect(replay.costBreakdown.wallClearance).toBeGreaterThan(0);
  });

  it('I. separates reverse, rotation, and clearance diagnostic contributions', () => {
    const replay = replayMotionPlannerScenario(scenario(plannerOptions({
      reverseRiskWeight: 0, motionStateDirectionSwitchWeight: 0,
    }), true));
    expect(replay.calibration.decisionSummary).toMatchObject({
      reverseUsed: true,
      selectedReverseCost: replay.costBreakdown.reverse,
      selectedRotationCost: replay.costBreakdown.rotation +
        replay.costBreakdown.terminalOrientation,
      selectedWallClearanceCost: replay.costBreakdown.wallClearance,
    });
    expect(replay.calibration.result.actionSequence.length).toBeLessThanOrEqual(64);
    expect(replay.calibration.decisionSummary.selectedDecisionEvidence.length)
      .toBeGreaterThan(0);
    expect(replay.calibration.decisionSummary.clearanceDistanceTradeoff)
      .toMatchObject({ selectedDistanceM: replay.calibration.result.totalPathLengthM });
  });

  it('J. keeps effective motion-state configuration immutable during async planning', async () => {
    let resolve!: (result: PlannerResult) => void;
    const requests: PlannerRequest[] = [];
    const planner = { plan: vi.fn((request: PlannerRequest) => new Promise<PlannerResult>((done) => {
      requests.push(request);
      resolve = done;
    })) };
    const coordinator = new PlanningCoordinator({ planner });
    const captured = scenario();
    const inputs: PlanningInputs = {
      grid: captured.grid, start: captured.startPose as RobotPose,
      goal: captured.goalPose as RobotPose, waypoints: [], plannerMode: 'motion-state',
      plannerOptions: structuredClone(captured.configuration.planner),
      footprint: captured.footprint, orderSettings: defaultOrderSettings,
      goalThetaExplicit: true, sessionId: 'calibration-session',
    };
    const pending = coordinator.plan(inputs);
    inputs.plannerOptions.passageSafety.reverseRiskWeight = 999;
    const request = requests[0]!;
    const effective = request.planningConfiguration!.normalized.motionState;
    expect(effective.weights
      .reverseCostPerM).not.toBe(999);
    expect(Object.isFrozen(effective)).toBe(true);
    resolve({ success: false, error: 'test stop', rawPath: [], simplifiedPath: [],
      finalPath: [], statistics: { visitedCells: 0, durationMs: 0,
        rawPointCount: 0, simplifiedPointCount: 0, finalPointCount: 0 } });
    await pending;
  });
});
