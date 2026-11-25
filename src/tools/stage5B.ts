import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { parseMotionPlannerScenarioArtifact } from '../domain/planning/MotionPlannerScenarioArtifact';
import { stage5BManifestSchema, runStage5B, formatStage5BReport } from '../domain/planning/MotionPlannerStage5B';

// All inputs and generated reports stay in the invoking workspace. Scenario
// maps are external data files referenced by the manifest, never bundled.
function workspacePath(path: string, base = process.cwd()): string {
  const resolved = resolve(base, path);
  const rel = relative(process.cwd(), resolved);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))
    throw new Error('Stage 5B paths must stay inside the workspace.');
  return resolved;
}

async function main() {
  const args = process.argv.slice(2);
  const directoryMode = args[0] === '--real-exports';
  const [manifestArg, outputArg] = directoryMode ? args.slice(1) : args;
  if (!manifestArg || !outputArg) throw new Error('Usage: npm run stage5b -- <manifest.json> <new-report-prefix>');
  const manifestPath = workspacePath(manifestArg);
  const output = workspacePath(outputArg);
  const manifest = directoryMode ? stage5BManifestSchema.parse({
    schemaVersion: 'motion-planner-dataset-v1', name: 'Operator-supplied real exports',
    scenarios: (await readdir(manifestPath)).filter(name => name.endsWith('.json')).sort().map((name, index) => ({
      id: `real-${index + 1}`, artifact: relative(dirname(output), resolve(manifestPath, name)),
      provenance: 'real-run', notes: 'Operator supplied via --real-exports; qualitative expectations require review.',
      expectations: {},
    })),
  }) : stage5BManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (directoryMode) await writeFile(output + '.dataset.json', JSON.stringify(manifest, null, 2), { flag: 'wx' });
  const report = await runStage5B(manifest, async path => parseMotionPlannerScenarioArtifact(
    await readFile(workspacePath(path, directoryMode ? dirname(output) : dirname(manifestPath)), 'utf8')));
  // Exclusive creation prevents accidental replacement of previous evidence.
  await writeFile(output + '.json', JSON.stringify(report, null, 2), { flag: 'wx' });
  await writeFile(output + '.md', formatStage5BReport(report), { flag: 'wx' });
  console.log(`Stage 5B: ${report.rows.length} runs; recommendation: ${report.recommendation.profile ?? 'pending'}`);
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
