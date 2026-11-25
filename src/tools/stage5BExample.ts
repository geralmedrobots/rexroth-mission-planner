import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Stage5BRecorder } from '../domain/planning/Stage5BRecorder';
import { createMotionPlannerCalibrationBenchmarks } from '../domain/planning/MotionPlannerBenchmarks';
import { replayMotionPlannerScenario } from '../domain/planning/MotionPlannerReplay';

// Explicitly synthetic: never presented as one of the seven historical missions.
const input = createMotionPlannerCalibrationBenchmarks()[0]!;
const recorder = new Stage5BRecorder(input, { missionId: 'synthetic-recorder-smoke', provenance: 'synthetic', appVersion: '1.0.0' });
const result = replayMotionPlannerScenario(input);
recorder.recordResult(result.plannerResult);
const artifact = recorder.finalize(result.metrics.success ? 'success' : 'failed', 'Synthetic local replay; no robot execution');
await mkdir('artifacts/stage5b/missions', { recursive: true });
const path = `artifacts/stage5b/missions/Synthetic_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.json`;
await writeFile(path, JSON.stringify(artifact, null, 2), { flag: 'wx' });
console.log(path);
