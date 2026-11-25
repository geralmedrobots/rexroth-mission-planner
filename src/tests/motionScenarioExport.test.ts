import { describe, expect, it } from 'vitest';
import { createMotionPlannerCalibrationBenchmarks } from '../domain/planning/MotionPlannerBenchmarks';
import { PlanningCoordinator, type PlanningInputs } from '../features/planning/PlanningCoordinator';
import { createMotionPlannerScenarioArtifact, parseMotionPlannerScenarioArtifact,
  serializeMotionPlannerScenarioArtifact, type MotionPlannerScenarioArtifact } from '../domain/planning/MotionPlannerScenarioArtifact';
import type { PlannerResult, RobotPose } from '../domain/types';
import { planSynchronously } from '../domain/planner/PlannerService';
import { runStage5B, stage5BManifestSchema } from '../domain/planning/MotionPlannerStage5B';

const sample = () => createMotionPlannerCalibrationBenchmarks()[0]!;
const inputs = (): PlanningInputs => {
  const scenario = sample();
  return { grid: scenario.grid, start: scenario.startPose as RobotPose, goal: scenario.goalPose as RobotPose,
    footprint: scenario.footprint, plannerOptions: structuredClone(scenario.configuration.planner),
    orderSettings: structuredClone(scenario.configuration.order), waypoints: [], plannerMode: 'motion-state', sessionId: 'test' };
};

describe('captured scenario export', () => {
  it.each([true, false])('preserves exact request independently of live mutations, success=%s', async success => {
    const source = inputs();
    const original = structuredClone(source);
    const exports: MotionPlannerScenarioArtifact[] = [];
    let complete!: (result: PlannerResult) => void;
    const coordinator = new PlanningCoordinator({ onScenarioCaptured: artifact => exports.push(artifact),
      planner: { plan: () => new Promise(resolve => { complete = resolve; }) } });
    const pending = coordinator.plan(source);
    source.start.x += .2; source.grid.data[0] = 100;
    complete({ success, error: success ? undefined : 'Search timeout', rawPath: [], simplifiedPath: [], finalPath: [],
      statistics: { durationMs: 94, visitedCells: 30, rawPointCount: 0, simplifiedPointCount: 0, finalPointCount: 0 } });
    await pending;
    const artifact = parseMotionPlannerScenarioArtifact(serializeMotionPlannerScenarioArtifact(exports[0]!));
    expect(artifact.startPose).toEqual(original.start);
    expect(artifact.grid).toEqual(original.grid);
    expect(artifact.capture?.result.success).toBe(success);
    expect(artifact.capture?.waypointsUsed).toBe(false);
    expect(artifact.configuration.normalized.motionState.clearance.hardMinimumM)
      .toBe(original.plannerOptions.passageSafety.wallClearanceMinimumM);
  });

  it('rejects malformed, corrupted and configuration-inconsistent imports', () => {
    const original = createMotionPlannerScenarioArtifact(sample());
    expect(() => parseMotionPlannerScenarioArtifact('{}')).toThrow();
    const missing = structuredClone(original); missing.grid.data.pop();
    expect(() => parseMotionPlannerScenarioArtifact(JSON.stringify(missing))).toThrow(/dimensions/);
    const inconsistent = JSON.parse(JSON.stringify(original));
    inconsistent.configuration.planner.passageSafety.wallClearanceMinimumM += .2;
    expect(() => parseMotionPlannerScenarioArtifact(JSON.stringify(inconsistent))).toThrow(/configuration/);
  });

  it('replays an exported run directly in all Stage 5B configurations', async () => {
    let captured: MotionPlannerScenarioArtifact | undefined;
    await new PlanningCoordinator({ planner: { plan: async request => planSynchronously(request) },
      onScenarioCaptured: artifact => { captured = artifact; } }).plan(inputs());
    expect(captured).toBeDefined();
    const manifest = stage5BManifestSchema.parse({ schemaVersion: 'motion-planner-dataset-v1', name: 'Synthetic export test',
      scenarios: [{ id: 'synthetic', artifact: 'scenario.json', provenance: 'synthetic', expectations: {} }] });
    const report = await runStage5B(manifest, async () => parseMotionPlannerScenarioArtifact(serializeMotionPlannerScenarioArtifact(captured!)));
    expect(report.rows).toHaveLength(4);
    expect(report.rows.every(row => row.success)).toBe(true);
    expect(report.recommendation.profile).toBeNull();
  });
});
