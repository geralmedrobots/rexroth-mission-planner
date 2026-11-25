import { z } from 'zod';
import { normalizeAngle } from '../geometry/angles';
import { MotionPlanValidator } from '../planner/MotionPlanValidator';
import { measureMotionPlan } from '../motion/MotionPlanMetrics';
import { MOTION_PLANNER_CALIBRATION_PROFILES, applyMotionPlannerCalibrationProfile } from './MotionPlannerCalibrationProfiles';
import { createPlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';
import { motionPlanFingerprint, motionPlannerFootprintHash, motionPlannerGridRevision } from './MotionPlannerCalibration';
import { replayMotionPlannerScenario, type MotionPlannerReplayResult } from './MotionPlannerReplay';
import type { MotionPlannerScenarioArtifact } from './MotionPlannerScenarioArtifact';
import { validateMotionPlannerScenarioArtifact } from './MotionPlannerScenarioArtifact';

export const failureCategories = ['timeout/search-performance', 'corridor/guide limitation',
  'heading-bin/lattice limitation', 'primitive limitation', 'physically infeasible',
  'validation rejection', 'unknown'] as const;
const limit = z.number().finite().nonnegative();
export const stage5BManifestSchema = z.object({
  schemaVersion: z.literal('motion-planner-dataset-v1'),
  name: z.string().min(1),
  scenarios: z.array(z.object({
    id: z.string().min(1), artifact: z.string().min(1),
    provenance: z.enum(['real-run', 'synthetic']),
    notes: z.string().default(''),
    expectations: z.object({
      reverse: z.enum(['expected', 'not-preferred', 'either']).default('either'),
      maximumReverseM: limit.optional(), maximumDirectionSwitches: limit.int().optional(),
      maximumRotationDeg: limit.optional(), maximumRotationActions: limit.int().optional(),
      minimumClearanceM: limit.optional(), preferOpenRoute: z.boolean().default(false),
      maximumPathLengthM: limit.optional(), maximumPlanningMs: limit.optional(),
      maximumExpandedStates: limit.int().optional(),
      avoidSuspiciousManoeuvres: z.boolean().default(true),
      shortMoveM: limit.default(.2),
    }).strict(),
    failureAudit: z.object({ category: z.enum(failureCategories), evidence: z.string().min(1) }).optional(),
  }).strict()).superRefine((rows, ctx) => {
    if (new Set(rows.map(row => row.id)).size !== rows.length)
      ctx.addIssue({ code: 'custom', message: 'Scenario IDs must be unique.' });
  }),
}).strict();
export type Stage5BManifest = z.infer<typeof stage5BManifestSchema>;
export type Stage5BScenario = Stage5BManifest['scenarios'][number];
export const stage5BProfiles = ['CAPTURED_DEFAULT', 'BALANCED', 'FORWARD_PREFERRED', 'CLEARANCE_PREFERRED'] as const;
export type Stage5BProfile = typeof stage5BProfiles[number];

/** Only preferences vary. Hard feasibility and execution budgets stay captured. */
export function stage5BConfiguration(artifact: MotionPlannerScenarioArtifact, profile: Stage5BProfile) {
  if (profile === 'CAPTURED_DEFAULT') return artifact.configuration;
  const candidate = applyMotionPlannerCalibrationProfile(artifact.configuration,
    artifact.footprint, MOTION_PLANNER_CALIBRATION_PROFILES[profile]);
  return createPlanningConfigurationSnapshot({
    plannerOptions: { ...candidate.planner, passageSafety: { ...candidate.planner.passageSafety,
      wallClearanceMinimumM: artifact.configuration.planner.passageSafety.wallClearanceMinimumM } },
    footprint: artifact.footprint, orderSettings: artifact.configuration.order,
  });
}

export function classifyStage5BFailure(result: MotionPlannerReplayResult, audit?: Stage5BScenario['failureAudit']) {
  if (result.metrics.success) return undefined;
  const code = result.plannerResult.diagnostics?.physicalFailureCode ?? '';
  const reason = result.metrics.failureReason ?? '';
  const events = result.plannerResult.motionPlannerEvents ?? [];
  if (events.some(event => event.eventType === 'motionplan.validation.failed'))
    return { category: 'validation rejection', evidence: reason };
  if (/TIMEOUT/.test(code)) return { category: 'timeout/search-performance', evidence: `${code}: ${reason}` };
  // A finite lattice exhausting its search is NOT a proof of physical infeasibility.
  if (audit) return { ...audit, evidence: `Manual audit: ${audit.evidence}; replay: ${code}: ${reason}` };
  return { category: 'unknown', evidence: `${code}: ${reason}; needs trace or geometric evidence` };
}

export interface Stage5BRow {
  scenario: string; profile: Stage5BProfile; provenance: Stage5BScenario['provenance'];
  mapRevision: string; footprintHash: string;
  metrics?: MotionPlannerReplayResult['metrics'];
  success: boolean; score: number; penalties: Record<string, number>;
  violations: string[]; suspiciousActionIndices: number[];
  failure?: { category: string; evidence: string };
  effectiveParameters?: MotionPlannerReplayResult['calibration']['effectiveParameters'];
  baselineComparison?: {
    recordedSuccess: boolean; replaySuccess: boolean;
    recordedPlanFingerprint?: string; replayPlanFingerprint?: string; matches: boolean;
  };
}

export function evaluateStage5BReplay(scenario: Stage5BScenario, artifact: MotionPlannerScenarioArtifact,
  profile: Stage5BProfile, result: MotionPlannerReplayResult): Stage5BRow {
  const m = result.metrics, e = scenario.expectations;
  const configuration = stage5BConfiguration(artifact, profile).normalized.motionState;
  const violations: string[] = [];
  const suspiciousActionIndices: number[] = [];
  const recordedFingerprint = artifact.capture?.result.motionPlan
    ? motionPlanFingerprint(artifact.capture.result.motionPlan) : undefined;
  const baselineComparison = profile === 'CAPTURED_DEFAULT' && artifact.capture ? {
    recordedSuccess: artifact.capture.result.success, replaySuccess: m.success,
    ...(recordedFingerprint ? { recordedPlanFingerprint: recordedFingerprint } : {}),
    ...(m.planFingerprint ? { replayPlanFingerprint: m.planFingerprint } : {}),
    matches: artifact.capture.result.success === m.success && recordedFingerprint === m.planFingerprint,
  } : undefined;
  if (baselineComparison && !baselineComparison.matches)
    violations.push('Captured-default replay did not reproduce the recorded planner success/plan fingerprint');
  const actions = result.motionPlan?.actions ?? [];
  const rotation = (type: string) => type === 'ROTATE' || type === 'ROTATE_IN_PLACE';
  actions.forEach((action, index) => {
    if (!rotation(action.type)) return;
    let distance = 0;
    for (let next = index + 1; next < actions.length; next++) {
      const following = actions[next]!;
      if (rotation(following.type)) {
        if (distance <= e.shortMoveM) suspiciousActionIndices.push(index);
        break;
      }
      if (!following.type.startsWith('TRANSLATE')) break;
      distance += Math.hypot(following.to.x - following.from.x, following.to.y - following.from.y);
      if (distance > e.shortMoveM) break;
    }
  });
  let success = m.success;
  if (success) {
    const plan = result.motionPlan;
    const footprint = { ...artifact.footprint, safetyMargin: configuration.footprint.effectiveSafetyMarginM };
    const validation = plan && new MotionPlanValidator().validate(plan, artifact.grid, footprint,
      configuration.sampling.translationCollisionIntervalM, configuration.sampling.rotationCollisionIntervalRad,
      configuration.permissions.reverse, artifact.goalTheta);
    if (!validation?.valid) violations.push(...(validation?.errors ?? ['Successful replay missing MotionPlan']));
    const last = plan?.states.at(-1), first = plan?.states[0];
    if (!first || Math.hypot(first.x - artifact.startPose.x, first.y - artifact.startPose.y) > 1e-7 ||
      Math.abs(normalizeAngle(first.theta - artifact.startPose.theta)) > 1e-6)
      violations.push('Captured start pose not respected');
    if (!last || Math.hypot(last.x - artifact.goalPose.x, last.y - artifact.goalPose.y) > 1e-7)
      violations.push('Captured goal position not respected');
    if (plan && measureMotionPlan(plan, artifact.grid, configuration.sampling.translationCollisionIntervalM)
      .minimumClearanceM + 1e-6 < configuration.clearance.hardMinimumM)
      violations.push('Hard clearance rejected');
    success = violations.length === 0;
  }
  const penalties: Record<string, number> = {};
  const upper = (name: string, actual: number, maximum: number | undefined, weight: number) => {
    penalties[name] = maximum === undefined ? 0 : weight * Math.min(1, Math.max(0,
      (actual - maximum) / Math.max(maximum, 1)));
    if (maximum !== undefined && actual > maximum + 1e-6) violations.push(`${name}: ${actual} exceeds ${maximum}`);
  };
  upper('path length', m.totalPathLengthM, e.maximumPathLengthM, 10);
  upper('reverse distance', m.reversePathLengthM, e.maximumReverseM, 15);
  upper('direction switches', m.directionChangeCount, e.maximumDirectionSwitches, 15);
  upper('rotation angle', m.totalAbsoluteRotationDeg, e.maximumRotationDeg, 15);
  upper('rotation actions', m.rotationActionCount, e.maximumRotationActions, 10);
  upper('planning time', m.planningDurationMs, e.maximumPlanningMs, 5);
  upper('expanded states', m.expandedStates, e.maximumExpandedStates, 5);
  // Profile costs have different weights, so total cost is reported, not ranked.
  penalties['total cost (report only; incomparable weights)'] = 0;
  penalties['average clearance (report only unless open-route preference)'] = 0;
  penalties.clearance = e.minimumClearanceM === undefined ? 0 : 15 * Math.min(1,
    Math.max(0, e.minimumClearanceM - m.minimumClearanceM) / Math.max(.01, e.minimumClearanceM));
  if (penalties.clearance > 0) violations.push('Desired minimum clearance not reached');
  penalties['reverse preference'] = (e.reverse === 'expected' && m.reversePathLengthM <= 1e-7) ||
    (e.reverse === 'not-preferred' && m.reversePathLengthM > 1e-7) ? 10 : 0;
  penalties['suspicious manoeuvres'] = e.avoidSuspiciousManoeuvres ? Math.min(15, suspiciousActionIndices.length * 5) : 0;
  return { scenario: scenario.id, profile, provenance: scenario.provenance,
    mapRevision: artifact.mapRevision, footprintHash: artifact.footprintGeometryHash,
    metrics: m, effectiveParameters: result.calibration.effectiveParameters, success,
    score: success ? Math.max(0, 100 - Object.values(penalties).reduce((a, b) => a + b, 0)) : 0,
    penalties, violations, suspiciousActionIndices,
    ...(baselineComparison ? { baselineComparison } : {}),
    failure: m.success && !success ? { category: 'validation rejection', evidence: violations.join('; ') } :
      classifyStage5BFailure(result, scenario.failureAudit) };
}

export async function runStage5B(manifest: Stage5BManifest,
  load: (path: string) => Promise<MotionPlannerScenarioArtifact>) {
  const rows: Stage5BRow[] = [];
  for (const scenario of manifest.scenarios) {
    let artifact: MotionPlannerScenarioArtifact;
    try {
      artifact = await load(scenario.artifact);
      validateMotionPlannerScenarioArtifact(artifact);
      if (artifact.capture && (artifact.capture.plannerMode !== 'motion-state' || artifact.capture.waypointsUsed))
        throw new Error('Stage 5B requires a motion-state run; waypoint/legacy runs cannot be silently replayed as motion-state.');
      if (motionPlannerGridRevision(artifact.grid) !== artifact.mapRevision ||
        motionPlannerFootprintHash(artifact.footprint) !== artifact.footprintGeometryHash)
        throw new Error('Artifact integrity mismatch');
    } catch (error) {
      for (const profile of stage5BProfiles) rows.push({ scenario: scenario.id, profile,
        provenance: scenario.provenance, mapRevision: '', footprintHash: '', success: false,
        score: 0, penalties: {}, violations: [], suspiciousActionIndices: [],
        failure: { category: 'unknown', evidence: `Artifact load failed: ${String(error)}` } });
      continue;
    }
    const group: Stage5BRow[] = [];
    for (const profile of stage5BProfiles) {
      try {
        group.push(evaluateStage5BReplay(scenario, artifact, profile, replayMotionPlannerScenario({
          ...artifact, configuration: stage5BConfiguration(artifact, profile),
          profileName: profile === 'CAPTURED_DEFAULT' ? artifact.selectedProfile : profile,
        })));
      } catch (error) {
        group.push({ scenario: scenario.id, profile, provenance: scenario.provenance,
          mapRevision: artifact.mapRevision, footprintHash: artifact.footprintGeometryHash,
          success: false, score: 0, penalties: {}, violations: [], suspiciousActionIndices: [],
          failure: { category: 'unknown', evidence: `Replay exception: ${String(error)}` } });
      }
    }
    if (scenario.expectations.preferOpenRoute) {
      const best = Math.max(0, ...group.filter(row => row.success).map(row => row.metrics!.averageClearanceM));
      for (const row of group.filter(row => row.success)) {
        const penalty = 10 * (best - row.metrics!.averageClearanceM) / Math.max(.01, best);
        row.penalties['open route relative clearance'] = penalty;
        row.score = Math.max(0, row.score - penalty);
      }
    }
    rows.push(...group);
  }
  return { schemaVersion: 'stage-5b-v1', dataset: manifest, rows,
    recommendation: recommendStage5B(rows) };
}

export function recommendStage5B(rows: Stage5BRow[]) {
  const real = rows.filter(row => row.provenance === 'real-run');
  if (!real.length) return { profile: null, reason: 'No real-run artifacts evaluated. Profile selection pending.' };
  const ranked = stage5BProfiles.map(profile => {
    const runs = real.filter(row => row.profile === profile);
    return { profile, successRate: runs.filter(row => row.success).length / Math.max(1, runs.length),
      meanScore: runs.reduce((sum, row) => sum + row.score, 0) / Math.max(1, runs.length) };
  }).sort((a, b) => b.successRate - a.successRate || b.meanScore - a.meanScore);
  if (!ranked[0]!.successRate) return { profile: null, reason: 'No successful real-run replay; no evidence for profile selection.' };
  return { profile: ranked[0]!.profile, reason: 'Provisional dataset recommendation: highest real-run success rate, then mean quality score. Ties retain captured configuration. Review individual failures and robot tests before adoption.', ranked };
}

export function formatStage5BReport(report: Awaited<ReturnType<typeof runStage5B>>): string {
  const lines = ['# Stage 5B — ' + report.dataset.name, '',
    `Scenarios: ${report.dataset.scenarios.length}; real runs: ${report.dataset.scenarios.filter(s => s.provenance === 'real-run').length}.`, '',
    `Recommendation: ${report.recommendation.profile ?? 'PENDING'}. ${report.recommendation.reason}`, '',
    'Captured default means the exported run configuration, not newly substituted application defaults.',
    'Failure scores are zero. Success rate ranks first; bounded expectation penalties rank second. Raw total costs use different profile weights and are not comparable.',
    'Clearance is sampled center-to-obstacle distance, not footprint-edge clearance. Suspicious rotations are review candidates, not proof of redundancy. Open-route preference compares average clearance of successful alternatives; inspect geometry.', '',
    '| Profile | Success | Mean score | Mean time ms (all runs) |', '|---|---:|---:|---:|'];
  for (const profile of stage5BProfiles) {
    const rows = report.rows.filter(row => row.profile === profile);
    const timed = rows.filter(row => row.metrics);
    lines.push(`| ${profile} | ${rows.filter(row => row.success).length}/${rows.length} | ${rows.length ? (rows.reduce((sum, row) => sum + row.score, 0) / rows.length).toFixed(2) : 'N/A'} | ${timed.length ? (timed.reduce((sum, row) => sum + row.metrics!.planningDurationMs, 0) / timed.length).toFixed(2) : 'N/A'} |`);
  }
  lines.push('', '| Scenario / profile | Success | Score | ms / states | Path m / cost | Clearance min / avg m | Reverse m / switches | Rotation deg / actions | Suspicious |', '|---|---|---:|---|---|---|---|---|---|');
  for (const row of report.rows) {
    const m = row.metrics;
    lines.push(`| ${row.scenario} / ${row.profile} | ${row.success} | ${row.score.toFixed(2)} | ${m ? `${m.planningDurationMs.toFixed(1)} / ${m.expandedStates}` : 'N/A'} | ${m ? `${m.totalPathLengthM.toFixed(3)} / ${m.costs.total.toFixed(3)}` : 'N/A'} | ${m ? `${m.minimumClearanceM.toFixed(3)} / ${m.averageClearanceM.toFixed(3)}` : 'N/A'} | ${m ? `${m.reversePathLengthM.toFixed(3)} / ${m.directionChangeCount}` : 'N/A'} | ${m ? `${m.totalAbsoluteRotationDeg.toFixed(1)} / ${m.rotationActionCount}` : 'N/A'} | ${row.suspiciousActionIndices.join(',')} |`);
  }
  const baseline = report.rows.filter(row => row.profile === 'CAPTURED_DEFAULT' && row.baselineComparison);
  lines.push('', '## Captured baseline reproduction', '');
  if (!baseline.length) lines.push('No recorded planner result was available for fingerprint comparison.');
  for (const row of baseline) lines.push(`- ${row.scenario}: ${row.baselineComparison!.matches ? 'MATCH' : 'MISMATCH'}; recorded=${row.baselineComparison!.recordedPlanFingerprint ?? `success:${row.baselineComparison!.recordedSuccess}`}; replay=${row.baselineComparison!.replayPlanFingerprint ?? `success:${row.baselineComparison!.replaySuccess}`}.`);
  lines.push('', '## Scenario evidence and known limitations', '');
  for (const scenario of report.dataset.scenarios) lines.push(`- ${scenario.id} (${scenario.provenance}): ${scenario.notes}; source: ${scenario.artifact}`);
  for (const row of report.rows) {
    if (row.failure) lines.push(`- ${row.scenario}/${row.profile}: ${row.failure.category}: ${row.failure.evidence}`);
    if (row.violations.length) lines.push(`- ${row.scenario}/${row.profile} expectations: ${row.violations.join('; ')}`);
    if (row.success) lines.push(`- ${row.scenario}/${row.profile} penalties: ${JSON.stringify(row.penalties)}`);
  }
  lines.push('', 'Tight/complex real routes reported by the operator remain known limitations; without their artifacts their category is unknown. They do not block Stage 5B infrastructure completion.',
    'Timeout is not physical infeasibility. Guide/lattice/primitive diagnoses require trace evidence or a documented manual audit. A single timing sample is affected by caches and CPU contention; repeat in a fresh process for performance conclusions.', '',
    '## Profile trade-offs', '', ...Object.values(MOTION_PLANNER_CALIBRATION_PROFILES).map(p => `- ${p.name}: ${p.tradeoffs}`), '',
    '## Physical robot test checklist', '',
    '- Verify captured map, localization, footprint, payload, safety margins and operating area match the robot.',
    '- Review every failed case and suspicious manoeuvre before attempting that scenario.',
    '- Start at approved low speed in a controlled area with the normal safety system and stop access available.',
    '- Check forward/reverse execution, switch count, swept turns and clearance against replay.',
    '- Verify final position/orientation and normal publish-time validation.',
    '- Repeat with localization variation and representative obstacles; record actual timing and deviations.',
    '- Export new artifacts, record observations and obtain operational acceptance before changing any default.', '',
    'Production defaults, planner architecture and safety validation are unchanged by this offline workflow.', '');
  return lines.join('\n');
}
