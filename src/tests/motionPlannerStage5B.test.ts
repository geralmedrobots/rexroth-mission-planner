import { describe, expect, it } from 'vitest';
import { createMotionPlannerCalibrationBenchmarks } from '../domain/planning/MotionPlannerBenchmarks';
import { createMotionPlannerScenarioArtifact, parseMotionPlannerScenarioArtifact,
  serializeMotionPlannerScenarioArtifact } from '../domain/planning/MotionPlannerScenarioArtifact';
import { stage5BManifestSchema, stage5BConfiguration, stage5BProfiles, runStage5B,
  formatStage5BReport, classifyStage5BFailure, evaluateStage5BReplay, recommendStage5B } from '../domain/planning/MotionPlannerStage5B';
import { replayMotionPlannerScenario, type MotionPlannerReplayResult } from '../domain/planning/MotionPlannerReplay';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';

const artifact = () => createMotionPlannerScenarioArtifact(createMotionPlannerCalibrationBenchmarks()[0]!);
const manifest = () => stage5BManifestSchema.parse({ schemaVersion: 'motion-planner-dataset-v1', name: 'Synthetic infrastructure test',
  scenarios: [{ id: 'open', artifact: 'external.json', provenance: 'synthetic', expectations: {} }] });

describe('Stage 5B offline dataset evaluation', () => {
  it('loads serialized artifacts, replays all profiles and preserves exact scenario inputs', async () => {
    const input = artifact();
    const before = serializeMotionPlannerScenarioArtifact(input);
    const report = await runStage5B(manifest(), async () => parseMotionPlannerScenarioArtifact(before));
    expect(report.rows.map(row => row.profile)).toEqual([...stage5BProfiles]);
    expect(report.rows.every(row => row.success)).toBe(true);
    expect(report.rows.every(row => row.mapRevision === input.mapRevision)).toBe(true);
    expect(serializeMotionPlannerScenarioArtifact(input)).toBe(before);
    expect(report.recommendation.profile).toBeNull();
    expect(formatStage5BReport(report)).toContain('PENDING');
    expect(report.rows[0]!.metrics!.planFingerprint).toBe(replayMotionPlannerScenario(input).metrics.planFingerprint);
  });

  it('keeps captured hard clearance even when the named profile requests a smaller value', () => {
    const original = artifact();
    const input = { ...original, configuration: createPlanningConfigurationSnapshot({
      plannerOptions: { ...original.configuration.planner, passageSafety: {
        ...original.configuration.planner.passageSafety, wallClearanceMinimumM: .45 } },
      footprint: original.footprint, orderSettings: original.configuration.order }) };
    for (const profile of stage5BProfiles.slice(1)) {
      const candidate = stage5BConfiguration(input, profile).normalized.motionState;
      const baseline = stage5BConfiguration(input, 'CAPTURED_DEFAULT').normalized.motionState;
      expect(candidate.clearance.hardMinimumM).toBe(.45);
      expect(candidate.sampling).toEqual(baseline.sampling);
      expect(candidate.footprint).toEqual(baseline.footprint);
      expect(candidate.permissions).toEqual(baseline.permissions);
      expect(candidate.maximumPlanningTimeMs).toBe(baseline.maximumPlanningTimeMs);
    }
  });

  it('keeps missing and corrupted artifacts as known failure rows and continues', async () => {
    const data = manifest();
    data.scenarios.push({ ...data.scenarios[0]!, id: 'valid', artifact: 'valid.json' });
    const report = await runStage5B(data, async path => {
      if (path === 'external.json') throw new Error('missing export');
      return artifact();
    });
    expect(report.rows).toHaveLength(8);
    expect(report.rows.slice(0, 4).every(row => !row.success && row.score === 0)).toBe(true);
    expect(report.rows.slice(4).every(row => row.success)).toBe(true);
    const damaged = artifact(); damaged.grid.data[0] = 100;
    expect((await runStage5B(manifest(), async () => damaged)).rows[0]!.failure?.evidence).toContain('integrity');
  });

  it('rejects ambiguous manifests and invalid expectation limits', () => {
    const data = manifest(); data.scenarios.push(data.scenarios[0]!);
    expect(() => stage5BManifestSchema.parse(data)).toThrow(/unique/);
    const invalid = manifest(); invalid.scenarios[0]!.expectations.maximumReverseM = -1;
    expect(() => stage5BManifestSchema.parse(invalid)).toThrow();
  });

  it('distinguishes timeout from unknown search exhaustion and accepts documented audits', () => {
    const replay = replayMotionPlannerScenario(artifact());
    const failed: MotionPlannerReplayResult = { ...replay, metrics: { ...replay.metrics, success: false, failureReason: 'search exhausted' },
      plannerResult: { ...replay.plannerResult, diagnostics: undefined } };
    expect(classifyStage5BFailure(failed)?.category).toBe('unknown');
    expect(classifyStage5BFailure(failed, { category: 'primitive limitation', evidence: 'Documented replay comparison' })?.category).toBe('primitive limitation');
    failed.plannerResult = { ...replay.plannerResult, diagnostics: {
      ...replay.plannerResult.diagnostics!, physicalFailureCode: 'MOTION_STATE_SEARCH_TIMEOUT' } };
    expect(classifyStage5BFailure(failed)?.category).toBe('timeout/search-performance');
  });

  it('explains expectation penalties and rejects corrupted successful plans independently', () => {
    const input = artifact(), replay = replayMotionPlannerScenario(input);
    const scenario = manifest().scenarios[0]!;
    scenario.expectations.maximumPathLengthM = 0;
    const evaluated = evaluateStage5BReplay(scenario, input, 'CAPTURED_DEFAULT', replay);
    expect(evaluated.score).toBeLessThan(100);
    expect(evaluated.penalties['path length']).toBeGreaterThan(0);
    replay.motionPlan!.states.at(-1)!.theta += .1;
    const rejected = evaluateStage5BReplay(scenario, input, 'CAPTURED_DEFAULT', replay);
    expect(rejected.success).toBe(false);
    expect(rejected.score).toBe(0);
    expect(rejected.failure?.category).toBe('validation rejection');
  });

  it('ranks real evidence by success first, excludes synthetic evidence and abstains on empty data', async () => {
    const report = await runStage5B(manifest(), async () => artifact());
    expect(recommendStage5B([]).profile).toBeNull();
    const rows = report.rows.map(row => ({ ...row, provenance: 'real-run' as const,
      score: row.profile === 'BALANCED' ? 90 : 50 }));
    expect(recommendStage5B(rows).profile).toBe('BALANCED');
    rows[1]!.success = false;
    expect(recommendStage5B(rows).profile).toBe('CAPTURED_DEFAULT');
  });

  it('flags rotate-short-move-rotate across split translations without claiming redundancy', () => {
    const input = artifact(), replay = replayMotionPlannerScenario(input);
    const first = replay.motionPlan!.states[0]!;
    const middle = { ...first, x: first.x + .05 };
    const end = { ...first, x: first.x + .1 };
    replay.motionPlan!.actions = [
      { type: 'ROTATE_IN_PLACE', from: first, to: first },
      { type: 'TRANSLATE_FORWARD', from: first, to: middle },
      { type: 'TRANSLATE_FORWARD', from: middle, to: end },
      { type: 'ROTATE_IN_PLACE', from: end, to: end },
    ];
    const row = evaluateStage5BReplay(manifest().scenarios[0]!, input, 'CAPTURED_DEFAULT', replay);
    expect(row.suspiciousActionIndices).toEqual([0]);
    expect(row.penalties['suspicious manoeuvres']).toBe(5);
  });

  it('checks requested terminal orientation independently of the reported success flag', () => {
    const input = artifact(), replay = replayMotionPlannerScenario(input);
    const requested = { ...input, goalTheta: replay.motionPlan!.states.at(-1)!.theta + .3 };
    const row = evaluateStage5BReplay(manifest().scenarios[0]!, requested, 'CAPTURED_DEFAULT', replay);
    expect(row.success).toBe(false);
    expect(row.failure?.category).toBe('validation rejection');
    expect(row.violations.join(' ')).toContain('Final orientation');
  });
});
