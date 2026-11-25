import type { Express } from 'express';
import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateFinalizedStage5BArtifact } from './stage5BArtifactValidation.js';

const activeWrites = new Set<string>();

/** Fixed local destination; client-supplied paths are never used. */
export function registerStage5BRecording(app: Express): void {
  app.post('/api/stage5b/missions', async (request, response) => {
    let artifact: ReturnType<typeof validateFinalizedStage5BArtifact>;
    try { artifact = validateFinalizedStage5BArtifact(request.body); }
    catch (error) { response.status(400).json({ error: `A finalized full scenario artifact is required: ${String(error)}` }); return; }
    const filename = `Mission_${new Date(artifact.recording.startedAt).toISOString().replace(/[:.]/g, '-')}_${artifact.recording.recordingId}.json`;
    const contents = JSON.stringify(artifact, null, 2);
    if (activeWrites.has(filename)) {
      response.status(409).json({ error: 'This recording is currently being saved; retry without changing it.' }); return;
    }
    activeWrites.add(filename);
    let temporaryPath: string | undefined;
    try {
      const directory = resolve(process.cwd(), 'artifacts/stage5b/missions');
      const finalPath = resolve(directory, filename);
      await mkdir(directory, { recursive: true });
      try {
        const existing = await readFile(finalPath, 'utf8');
        if (existing !== contents) {
          response.status(409).json({ error: 'Recording ID already exists with different contents; nothing overwritten.' }); return;
        }
        response.status(201).json({ path: `artifacts/stage5b/missions/${filename}` }); return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      temporaryPath = resolve(directory, `.${filename}.${crypto.randomUUID()}.tmp`);
      await writeFile(temporaryPath, contents, { flag: 'wx' });
      validateFinalizedStage5BArtifact(JSON.parse(await readFile(temporaryPath, 'utf8')));
      await rename(temporaryPath, finalPath);
      temporaryPath = undefined;
      response.status(201).json({ path: `artifacts/stage5b/missions/${filename}` });
    } catch (error) { response.status(500).json({ error: `Scenario save failed: ${String(error)}` }); }
    finally {
      activeWrites.delete(filename);
      if (temporaryPath) try { await unlink(temporaryPath); } catch { /* Best-effort cleanup after a failed atomic write. */ }
    }
  });
}
