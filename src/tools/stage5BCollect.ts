import { readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseMotionPlannerScenarioArtifact } from '../domain/planning/MotionPlannerScenarioArtifact';
import { stage5BManifestSchema } from '../domain/planning/MotionPlannerStage5B';
import type { RecordedScenario } from '../domain/planning/Stage5BRecorder';

function local(path: string): string {
  const result = resolve(path), rel = relative(process.cwd(), result);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))
    throw new Error('Paths must stay within the workspace.');
  return result;
}
async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: stage5b:collect <recording-directory> <manifest.json>');
  const directory = local(source), output = local(destination);
  const scenarios = [];
  for (const filename of (await readdir(directory)).filter(name => name.endsWith('.json')).sort()) {
    const path = local(resolve(directory, filename));
    const artifact = parseMotionPlannerScenarioArtifact(await readFile(path, 'utf8')) as RecordedScenario;
    const recording = artifact.recording;
    if (!recording?.outcome || !['real-run', 'synthetic'].includes(recording.provenance))
      throw new Error(`${filename}: finalized recorder metadata required; provenance cannot be inferred.`);
    scenarios.push({ id: filename.slice(0, -5), artifact: relative(dirname(output), path).replaceAll('\\', '/'),
      provenance: recording.provenance, expectations: {},
      notes: `Mission ${recording.missionId}; observed outcome: ${recording.outcome}; ${recording.reason ?? ''}`,
      ...(recording.outcome === 'failed' ? { failureAudit: { category: 'unknown',
        evidence: recording.reason ?? 'Recorded mission failure; cause unclassified.' } } : {}),
    });
  }
  if (!scenarios.length) throw new Error('No recorded scenarios found; existing manifest unchanged.');
  const manifest = stage5BManifestSchema.parse({ schemaVersion: 'motion-planner-dataset-v1',
    name: 'Recorded Stage 5B missions (see per-scenario provenance)', scenarios });
  const backup = `${output}.${randomUUID()}.backup`;
  try { await copyFile(output, backup, constants.COPYFILE_EXCL); console.log(`Previous dataset preserved: ${relative(process.cwd(), backup)}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(output, JSON.stringify(manifest, null, 2));
  console.log(`Collected ${scenarios.length} validated scenarios into ${relative(process.cwd(), output)}`);
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
