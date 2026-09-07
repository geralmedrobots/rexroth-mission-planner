import { describe, expect, it } from 'vitest';
import { CostModel } from '../domain/planning/CostModel';
import {
  calibrationProfileVariants, createMotionPlannerCalibrationBenchmarks,
  formatMotionPlannerCalibrationReport, runMotionPlannerCalibrationBenchmarks,
  type MotionPlannerBenchmarkScenario,
} from '../domain/planning/MotionPlannerBenchmarks';
import { MOTION_PLANNER_CALIBRATION_PROFILES } from '../domain/planning/MotionPlannerCalibrationProfiles';
import { createMotionPlannerCalibrationSweeps } from '../domain/planning/MotionPlannerCalibrationSweeps';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import { compareMotionPlannerConfigurations,
  replayMotionPlannerScenario } from '../domain/planning/MotionPlannerReplay';
import { createMotionPlannerScenarioArtifact, parseMotionPlannerScenarioArtifact,
  replayMotionPlannerScenarioArtifact, serializeMotionPlannerScenarioArtifact } from '../domain/planning/MotionPlannerScenarioArtifact';

const benchmarks = (): readonly MotionPlannerBenchmarkScenario[] =>
  createMotionPlannerCalibrationBenchmarks();
const benchmark = (id: MotionPlannerBenchmarkScenario['id']): MotionPlannerBenchmarkScenario => {
  const found = benchmarks().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing benchmark ${id}`);
  return found;
};

const configure = (scenario: MotionPlannerBenchmarkScenario, patch: {
  reverse?: number; rotation?: number; switchCost?: number; wall?: number;
  preferred?: number; hardMinimum?: number; narrow?: number; turn?: number;
  terminal?: number;
}) => createPlanningConfigurationSnapshot({
  plannerOptions: {
    ...structuredClone(scenario.configuration.planner),
    passageSafety: {
      ...structuredClone(scenario.configuration.planner.passageSafety),
      ...(patch.reverse === undefined ? {} : { reverseRiskWeight: patch.reverse }),
      ...(patch.rotation === undefined ? {} : { headingChangeWeight: patch.rotation }),
      ...(patch.switchCost === undefined ? {} : {
        motionStateDirectionSwitchWeight: patch.switchCost }),
      ...(patch.wall === undefined ? {} : { wallProximityWeight: patch.wall }),
      ...(patch.preferred === undefined ? {} : { wallClearancePreferredM: patch.preferred }),
      ...(patch.hardMinimum === undefined ? {} : {
        wallClearanceMinimumM: patch.hardMinimum }),
      ...(patch.narrow === undefined ? {} : { narrowPassageWeight: patch.narrow }),
      ...(patch.turn === undefined ? {} : { turnLocationWeight: patch.turn }),
      ...(patch.terminal === undefined ? {} : {
        motionStateTerminalOrientationWeight: patch.terminal }),
    },
  },
  footprint: scenario.footprint,
  orderSettings: scenario.configuration.order,
});

describe('Stage 5A systematic motion-state calibration', () => {
  it('A. keeps benchmark definitions and repeated planning deterministic', () => {
    expect(benchmarks().map(({ id }) => id)).toEqual([
      'A_AHEAD_OPEN', 'B_BEHIND_SIDE_OPEN', 'C_IMMEDIATELY_BEHIND',
      'D_UNSAFE_NEAR_ROTATION', 'E_WIDER_CLEARANCE', 'F_NARROW_PASSAGE',
      'G_DIRECTION_SWITCH', 'H_ROTATION_VS_SHORT_REVERSE', 'I_FINAL_THETA',
      'J_CLEARANCE_DISTANCE_ALTERNATIVES',
    ]);
    const scenario = benchmark('A_AHEAD_OPEN');
    const first = replayMotionPlannerScenario(scenario);
    const second = replayMotionPlannerScenario(scenario);
    expect(second.metrics.planFingerprint).toBe(first.metrics.planFingerprint);
    expect(second.costBreakdown).toEqual(first.costBreakdown);
    expect((first.motionPlan?.diagnostics?.selected as Record<string, unknown>)
      .selectedTotalCost).toBe(first.costBreakdown.total);
    expect(first.motionPlan?.metadata.cost).toBe(first.costBreakdown.total);
  });

  it('B. uses forward without unnecessary rotation for an ahead open-space goal', () => {
    const result = replayMotionPlannerScenario(benchmark('A_AHEAD_OPEN'));
    expect(result.metrics.success).toBe(true);
    expect(result.metrics.reversePathLengthM).toBe(0);
    expect(result.metrics.totalAbsoluteRotationRad).toBeCloseTo(0, 8);
  });

  it('C. retains reverse for a physically sensible immediately-behind case', () => {
    const scenario = benchmark('C_IMMEDIATELY_BEHIND');
    const result = replayMotionPlannerScenario({ ...scenario,
      configuration: configure(scenario, { reverse: 1.5, rotation: .25,
        switchCost: .5, wall: 0, narrow: 0, turn: 0 }) });
    expect(result.metrics.success).toBe(true);
    expect(result.metrics.reversePathLengthM).toBeGreaterThan(0);
    expect(result.calibration.decisionSummary.reverseExplanation)
      .toMatch(/reverse total=\d+\.\d{3}.*translation=.*reverse=.*rotation=.*clearance=/);
  });

  it('moves before rotating when the start rotation sweep is obstructed', () => {
    const result = replayMotionPlannerScenario(benchmark('D_UNSAFE_NEAR_ROTATION'));
    expect(result.metrics.success).toBe(true);
    const actions = result.motionPlan?.actions ?? [];
    const firstRotation = actions.findIndex(({ type }) =>
      type === 'ROTATE' || type === 'ROTATE_IN_PLACE');
    const firstTranslation = actions.findIndex(({ type }) =>
      type === 'TRANSLATE_FORWARD' || type === 'TRANSLATE_REVERSE');
    expect(firstTranslation).toBeGreaterThanOrEqual(0);
    expect(firstTranslation).toBeLessThan(firstRotation);
  });

  it('D. increasing reverse cost moves an isolated case toward rotation/forward', () => {
    const scenario = benchmark('C_IMMEDIATELY_BEHIND');
    const rows = compareMotionPlannerConfigurations(scenario, [
      { name: 'reverse-low', configuration: configure(scenario,
        { reverse: .2, rotation: .25, switchCost: 0, wall: 0, narrow: 0, turn: 0 }) },
      { name: 'reverse-high', configuration: configure(scenario,
        { reverse: 5, rotation: .25, switchCost: 0, wall: 0, narrow: 0, turn: 0 }) },
    ]);
    expect(rows[0]!.reverseDistanceM).toBeGreaterThan(rows[1]!.reverseDistanceM);
    expect(rows[1]!.rotationRad).toBeGreaterThan(rows[0]!.rotationRad);
  });

  it('E. increasing rotation cost moves an isolated case toward reverse', () => {
    const scenario = benchmark('C_IMMEDIATELY_BEHIND');
    const rows = compareMotionPlannerConfigurations(scenario, [
      { name: 'rotation-low', configuration: configure(scenario,
        { reverse: 1, rotation: .02, switchCost: 0, wall: 0, narrow: 0, turn: 0 }) },
      { name: 'rotation-high', configuration: configure(scenario,
        { reverse: 1, rotation: 1, switchCost: 0, wall: 0, narrow: 0, turn: 0 }) },
    ]);
    expect(rows[1]!.reverseDistanceM).toBeGreaterThan(rows[0]!.reverseDistanceM);
    expect(rows[1]!.rotationRad).toBeLessThan(rows[0]!.rotationRad);
  });

  it('F. increasing clearance cost can select a longer, higher-clearance route', () => {
    const scenario = benchmark('E_WIDER_CLEARANCE');
    const rows = compareMotionPlannerConfigurations(scenario, [
      { name: 'distance-only', configuration: configure(scenario,
        { wall: 0, preferred: .6, narrow: 0, turn: 0 }) },
      { name: 'clearance', configuration: configure(scenario,
        { wall: 8, preferred: .6, narrow: 0, turn: 0 }) },
    ]);
    expect(rows[1]!.pathLengthM).toBeGreaterThan(rows[0]!.pathLengthM);
    expect(rows[1]!.minimumClearanceM).toBeGreaterThan(rows[0]!.minimumClearanceM);
    expect(rows[1]!.averageClearanceM).toBeGreaterThan(rows[0]!.averageClearanceM);
  });

  it('G/H. keeps hard clearance independent of soft cost and valid narrow passages feasible', () => {
    const scenario = benchmark('F_NARROW_PASSAGE');
    const feasible = replayMotionPlannerScenario({ ...scenario,
      configuration: configure(scenario,
        { hardMinimum: .1, wall: 100, narrow: 100 }) });
    const blockedLowSoft = replayMotionPlannerScenario({ ...scenario,
      configuration: configure(scenario,
        { hardMinimum: .45, wall: 0, narrow: 0 }) });
    const blockedHighSoft = replayMotionPlannerScenario({ ...scenario,
      configuration: configure(scenario,
        { hardMinimum: .45, wall: 100, narrow: 100 }) });
    expect(feasible.metrics.success).toBe(true);
    expect(feasible.metrics.minimumClearanceM).toBeGreaterThanOrEqual(.1);
    expect(blockedLowSoft.metrics.success).toBe(false);
    expect(blockedHighSoft.metrics.success).toBe(false);
  });

  it('I. charges direction switching per event and therefore discourages oscillation', () => {
    const oneUsefulSwitch = CostModel.motionStateDirectionSwitch('FORWARD', 'REVERSE', .5);
    const oscillation = oneUsefulSwitch +
      CostModel.motionStateDirectionSwitch('REVERSE', 'FORWARD', .5) +
      CostModel.motionStateDirectionSwitch('FORWARD', 'REVERSE', .5);
    expect(oneUsefulSwitch).toBe(.5);
    expect(oscillation).toBe(1.5);
    const scenario = benchmark('G_DIRECTION_SWITCH');
    const result = replayMotionPlannerScenario({ ...scenario,
      configuration: configure(scenario, { switchCost: 2 }) });
    expect(result.metrics.directionChangeCount).toBeLessThanOrEqual(1);
  });

  it('J. integrates reverse and clearance costs by physical distance, not action count', () => {
    expect(CostModel.motionStateReverseRisk(true, 1, 2)).toBeCloseTo(
      10 * CostModel.motionStateReverseRisk(true, .1, 2), 10);
    expect(CostModel.motionStateWallProximity(.2, .6, 1, 8)).toBeCloseTo(
      10 * CostModel.motionStateWallProximity(.2, .6, .1, 8), 10);
    expect(CostModel.motionStateNarrowPassage(.4, .2, 0, 1.8, 1, 1.5)).toBeCloseTo(
      10 * CostModel.motionStateNarrowPassage(.4, .2, 0, 1.8, .1, 1.5), 10);

    const coarse = benchmark('A_AHEAD_OPEN');
    const fineGrid = structuredClone(coarse.grid);
    fineGrid.metadata = { ...fineGrid.metadata, mapId: 'benchmark-a-fine',
      name: 'benchmark-a-fine', resolution: .05, width: 120, height: 120 };
    fineGrid.data = Array(14_400).fill(0);
    const distanceOnly = configure(coarse, { reverse: 2, rotation: 0,
      switchCost: 0, wall: 0, narrow: 0, turn: 0, terminal: 0 });
    const fine = replayMotionPlannerScenario({ ...coarse, grid: fineGrid,
      configuration: distanceOnly });
    const coarseResult = replayMotionPlannerScenario({ ...coarse,
      configuration: distanceOnly });
    expect(fine.metrics.totalPathLengthM).toBeCloseTo(coarseResult.metrics.totalPathLengthM, 6);
    expect(fine.costBreakdown.total).toBeCloseTo(coarseResult.costBreakdown.total, 6);
  });

  it('K. exposes controlled sweeps and reproducible named candidate profiles', () => {
    const scenario = benchmark('A_AHEAD_OPEN');
    const sweeps = createMotionPlannerCalibrationSweeps(scenario.configuration,
      scenario.footprint);
    expect(sweeps.reverseCostPerM.map(({ configuration }) =>
      configuration.normalized.motionState.weights.reverseCostPerM))
      .toEqual([.5, 1, 1.5, 2, 3, 4]);
    const variants = calibrationProfileVariants();
    expect(variants.map(({ name }) => name)).toEqual([
      'BALANCED', 'FORWARD_PREFERRED', 'CLEARANCE_PREFERRED']);
    const first = runMotionPlannerCalibrationBenchmarks([scenario], variants);
    const second = runMotionPlannerCalibrationBenchmarks([scenario], variants);
    expect(second.map((row) => ({ ...row, planningDurationMs: 0 })))
      .toEqual(first.map((row) => ({ ...row, planningDurationMs: 0 })));
    expect(formatMotionPlannerCalibrationReport(first)).toContain('| scenario | profile |');
    expect(first[0]!.costs).toEqual(expect.objectContaining({
      distance: expect.any(Number), rotation: expect.any(Number),
      reverse: expect.any(Number), directionSwitch: expect.any(Number),
      wallClearance: expect.any(Number), narrowPassage: expect.any(Number),
      turnLocation: expect.any(Number), terminalOrientation: expect.any(Number),
      total: expect.any(Number),
    }));
    expect(MOTION_PLANNER_CALIBRATION_PROFILES.CLEARANCE_PREFERRED.values
      .wallClearanceCostPerM).toBe(8);
    expect(MOTION_PLANNER_CALIBRATION_PROFILES.CLEARANCE_PREFERRED.values
      .preferredClearanceM).toBe(.8);
  });

  it('L. exports a deliberate full scenario artifact and reproduces its plan', () => {
    const scenario = benchmark('I_FINAL_THETA');
    const original = replayMotionPlannerScenario(scenario);
    const artifact = createMotionPlannerScenarioArtifact({ ...scenario,
      originalCalibration: original.calibration });
    const restored = parseMotionPlannerScenarioArtifact(
      serializeMotionPlannerScenarioArtifact(artifact));
    const replay = replayMotionPlannerScenarioArtifact(restored);
    expect(replay.metrics.planFingerprint).toBe(original.metrics.planFingerprint);
    expect(replay.costBreakdown).toEqual(original.costBreakdown);
    expect(restored.grid.data).toHaveLength(scenario.grid.data.length);
  });

  it('keeps terminal-orientation sweeps local to final orientation behaviour', () => {
    const scenario = benchmark('I_FINAL_THETA');
    const low = replayMotionPlannerScenario({ ...scenario,
      configuration: configure(scenario, { terminal: 0 }) });
    const high = replayMotionPlannerScenario({ ...scenario,
      configuration: configure(scenario, { terminal: .6 }) });
    expect(high.metrics.totalPathLengthM).toBeCloseTo(low.metrics.totalPathLengthM, 8);
    expect(high.metrics.reversePathLengthM).toBe(low.metrics.reversePathLengthM);
    expect(high.metrics.minimumClearanceM).toBe(low.metrics.minimumClearanceM);
    expect(high.motionPlan?.states.at(-1)?.theta).toBeCloseTo(Math.PI / 2, 8);
    expect(low.motionPlan?.states.at(-1)?.theta).toBeCloseTo(Math.PI / 2, 8);
  });
});
