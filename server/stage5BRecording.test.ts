import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express, Request, Response, RequestHandler } from 'express';
import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { registerStage5BRecording } from './stage5BRecording';
import { Stage5BRecorder } from '../src/domain/planning/Stage5BRecorder';
import { createMotionPlannerCalibrationBenchmarks } from '../src/domain/planning/MotionPlannerBenchmarks';
vi.mock('node:fs/promises', () => { const fs = { mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(),
  rename: vi.fn(), unlink: vi.fn() }; return { ...fs, default: fs }; });

async function send(body: unknown) {
  let handler!: RequestHandler;
  registerStage5BRecording({ post: (_path: string, callback: RequestHandler) => { handler = callback; } } as unknown as Express);
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler({ body } as Request, response as unknown as Response, vi.fn());
  return response;
}
const input = createMotionPlannerCalibrationBenchmarks()[0]!;
const makeBody = (recordingId: string) => {
  const body = new Stage5BRecorder(input, { missionId: 'server-test', provenance: 'synthetic', appVersion: 'test' },
    '2026-09-11T00:00:00.000Z').finalize('failed');
  body.recording.recordingId = recordingId;
  return body;
};
const body = makeBody('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
describe('local Stage 5B artifact persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readFile).mockImplementation(async path => {
      const saved = vi.mocked(writeFile).mock.calls.find(call => call[0] === path)?.[1];
      if (typeof saved === 'string') return saved;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
  });
  it('rejects log arrays', async () => {
    expect((await send([])).status).toHaveBeenCalledWith(400);
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('uses unique filenames in the fixed directory and exclusive writes', async () => {
    const first = await send(body), second = await send(makeBody('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'));
    expect(first.status).toHaveBeenCalledWith(201);
    expect(mkdir).toHaveBeenCalledWith(expect.stringMatching(/artifacts[\\/]stage5b[\\/]missions$/), { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/missions[\\/]\.Mission_.*\.json\..*\.tmp$/), JSON.stringify(body, null, 2), { flag: 'wx' });
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), expect.stringMatching(/missions[\\/]Mission_.*\.json$/));
    expect(unlink).not.toHaveBeenCalled();
    expect(first.json.mock.calls[0]![0].path).not.toBe(second.json.mock.calls[0]![0].path);
  });
  it('reports storage failures rather than claiming the artifact was saved', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
    const response = await send(body);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ error: 'Scenario save failed: Error: disk full' });
  });
  it('makes a retry idempotent and rejects replacement of earlier evidence', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(body, null, 2)).mockResolvedValueOnce('different evidence');
    expect((await send(body)).status).toHaveBeenCalledWith(201);
    expect((await send(body)).status).toHaveBeenCalledWith(409);
  });
});
