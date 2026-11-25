import { describe, expect, it } from 'vitest';
import { Stage5BRecorder, type RecordedScenario } from '../domain/planning/Stage5BRecorder';
import { createMotionPlannerCalibrationBenchmarks } from '../domain/planning/MotionPlannerBenchmarks';
import { parseMotionPlannerScenarioArtifact } from '../domain/planning/MotionPlannerScenarioArtifact';
import { replayMotionPlannerScenario } from '../domain/planning/MotionPlannerReplay';
import { runStage5B, stage5BManifestSchema } from '../domain/planning/MotionPlannerStage5B';
import { alignedReverseRequest } from './fixtures/reverseChoiceAudit';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { defaultOrderSettings } from '../domain/defaults';

const identity = { missionId: 'synthetic-recorder-test', provenance: 'synthetic' as const, appVersion: 'test' };
describe('Stage 5B mission recorder', () => {
  it.each(['success', 'failed', 'cancelled'] as const)('records %s without conflating mission and planner outcome', outcome => {
    const input = createMotionPlannerCalibrationBenchmarks()[0]!;
    const recorder = new Stage5BRecorder(input, identity);
    recorder.recordResult(replayMotionPlannerScenario(input).plannerResult);
    const artifact = parseMotionPlannerScenarioArtifact(JSON.stringify(recorder.finalize(outcome, 'Observed result',
      { finalPose: input.goalPose, orderId: 'observed-order', lastNodeId: 'goal-node', lastNodeSequenceId: 2,
        navigatorErrors: [] }))) as RecordedScenario;
    expect(artifact.recording.outcome).toBe(outcome);
    expect(artifact.recording.finalPose).toEqual(input.goalPose);
    expect(artifact.recording.execution).toEqual(expect.objectContaining({ status: outcome,
      orderId: 'observed-order', lastNodeId: 'goal-node', lastNodeSequenceId: 2, navigatorErrors: [] }));
    expect(artifact.capture?.result.success).toBe(true);
    expect(artifact.recording.completedAt).toBeDefined();
    expect(recorder.state).toBe('FINALIZED');
    expect(recorder.finalize('failed').recording.outcome).toBe(outcome);
  });

  it('snapshots grid, metadata and all weights before mutable inputs change', () => {
    const input = structuredClone(createMotionPlannerCalibrationBenchmarks()[0]!);
    input.grid.data[0] = -1;
    const original = structuredClone(input);
    const recorder = new Stage5BRecorder(input, identity);
    input.grid.data[0] = 100;
    input.startPose.x += 1;
    const artifact = parseMotionPlannerScenarioArtifact(JSON.stringify(recorder.finalize('cancelled')));
    expect(artifact.grid).toEqual(original.grid);
    expect(artifact.startPose).toEqual(original.startPose);
    expect(artifact.configuration).toEqual(original.configuration);
    expect(artifact.footprint).toEqual(original.footprint);
  });

  it('loads a newly recorded artifact through the Stage 5B parser and performs four actual replays', async () => {
    const input = createMotionPlannerCalibrationBenchmarks()[0]!;
    const recorder = new Stage5BRecorder(input, identity);
    recorder.recordResult(replayMotionPlannerScenario(input).plannerResult);
    const json = JSON.stringify(recorder.finalize('success'));
    const manifest = stage5BManifestSchema.parse({ schemaVersion: 'motion-planner-dataset-v1', name: 'Recorder smoke test',
      scenarios: [{ id: 'recorded', artifact: 'recorded.json', provenance: 'synthetic', expectations: {} }] });
    const report = await runStage5B(manifest, async () => parseMotionPlannerScenarioArtifact(json));
    expect(report.rows).toHaveLength(4);
    expect(report.rows.every(row => row.success && row.metrics && row.mapRevision)).toBe(true);
    expect(report.rows.find(row => row.profile === 'CAPTURED_DEFAULT')?.baselineComparison?.matches).toBe(true);
    expect(report.recommendation.profile).toBeNull();
  });

  it('preserves reverse actions and the exact generated and published VDA orientation', () => {
    const request = alignedReverseRequest(.01, .01, false);
    const configuration = createPlanningConfigurationSnapshot({ plannerOptions: request.options,
      footprint: request.footprint, orderSettings: defaultOrderSettings });
    const input = { grid: request.grid, footprint: request.footprint, startPose: request.exactStartPose!,
      goalPose: request.exactGoalPose!, configuration };
    const recorder = new Stage5BRecorder(input, identity);
    const result = replayMotionPlannerScenario(input).plannerResult;
    expect(result.motionPlan!.actions.some(action => action.type === 'TRANSLATE_REVERSE')).toBe(true);
    recorder.recordResult(result);
    const order = new VdaOrderBuilder().build(result.finalPath, { robotPose: { ...input.startPose,
      mapId: input.grid.metadata.mapId, positionInitialized: true }, activeMapId: input.grid.metadata.mapId,
      motionPlan: result.motionPlan, planningConfiguration: configuration,
      corridorPlanning: { grid: input.grid, footprint: input.footprint, plannerOptions: request.options },
    }, defaultOrderSettings);
    recorder.recordOrder(order);
    recorder.recordOrder(order, true);
    const artifact = parseMotionPlannerScenarioArtifact(JSON.stringify(recorder.finalize('success'))) as RecordedScenario;
    expect(artifact.capture?.result.motionPlan).toEqual(JSON.parse(JSON.stringify(result.motionPlan)));
    expect(artifact.recording.orders).toHaveLength(1);
    expect(artifact.recording.orders[0]!.order).toEqual(JSON.parse(JSON.stringify(order)));
    expect(artifact.recording.orders[0]!.publishedAt).toBeDefined();
    expect(artifact.recording.orders[0]!.order.edges.some(edge => edge.orientation === Math.PI)).toBe(true);
  });
});
