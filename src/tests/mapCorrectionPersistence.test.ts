import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MapCorrectionPersistence } from '../features/map/MapCorrectionPersistence';
import { createSourceMapSnapshot } from '../domain/map/MapSnapshots';
import { applyCorrections } from '../domain/map/MapCorrectionRasterizer';
import type { MapCorrection } from '../domain/map/MapCorrections';

const service = new MapCorrectionPersistence();
const fingerprint = '18446744073709551615';
const source = (fp = fingerprint, cells = [-1, 100, 0]) =>
  createSourceMapSnapshot(
    {
      metadata: {
        width: 3,
        height: 1,
        origin: { x: 0, y: 0, yaw: 0 },
        resolution: 1,
        name: 'same name',
        mapId: '../A',
        negate: false,
        occupiedThreshold: 0.65,
        freeThreshold: 0.196,
      },
      data: cells,
    },
    {
      kind: 'locator',
      fingerprint: fp,
      instance: { host: 'localhost', port: 80, https: false, rpcEndpoint: '/' },
    },
  );
const createdAt = '2026-11-25T00:00:00Z';
const area = { kind: 'circle', center: { x: 0.5, y: 0.5 }, radiusM: 0.27 } as const;
const operations: MapCorrection[] = [
  { id: 'a', createdAt, kind: 'erase', area },
  {
    id: 'b',
    createdAt,
    kind: 'force_free',
    area: {
      kind: 'stroke',
      points: [
        { x: 0.1, y: 0.2 },
        { x: 1, y: 0.5 },
      ],
      radiusM: 0.3,
    },
  },
  {
    id: 'c',
    createdAt,
    kind: 'force_occupied',
    area: {
      kind: 'rectangle',
      vertices: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
    },
  },
  {
    id: 'd',
    createdAt,
    kind: 'wall',
    from: { x: 2, y: 0.2 },
    to: { x: 3, y: 0.6 },
    thicknessM: 0.01,
  },
  {
    id: 'e',
    createdAt,
    kind: 'restore',
    area: {
      kind: 'polygon',
      vertices: [
        { x: 0, y: 0 },
        { x: 0.1, y: 0 },
        { x: 0, y: 0.1 },
      ],
    },
  },
];

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  // Stand-in for the browser lock manager shared by independent service instances.
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', {
    locks: {
      request: (key: string, callback: () => unknown) => {
        const next = (queues.get(key) ?? Promise.resolve()).then(callback);
        queues.set(
          key,
          next.catch(() => {}),
        );
        return next;
      },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('represents an absent record as revision zero without writing', async () => {
  const s = await source();
  expect(await service.loadCorrections(s)).toEqual({
    revision: 0,
    createdAt: null,
    collection: { sourceIdentity: s.sourceIdentity, corrections: [] },
  });
  expect(await service.listRevisions(s)).toHaveLength(1);
  expect(localStorage.length).toBe(0);
});

it('reopens serialized instructions, exact identity and equivalent occupancy after restart', async () => {
  const s = await source(),
    collection = { sourceIdentity: s.sourceIdentity, corrections: operations };
  await service.saveCorrections(s, collection);
  const fresh = await source();
  const loaded = await new MapCorrectionPersistence().loadCorrections(fresh);
  expect(loaded.collection).toEqual(collection);
  expect(
    JSON.parse(localStorage.getItem(localStorage.key(0)!)!).sourceIdentity.source.fingerprint,
  ).toBe(fingerprint);
  expect(applyCorrections(fresh, loaded.collection)).toEqual(applyCorrections(s, collection));
  expect(s.rawOccupancyGrid.data).toEqual([-1, 100, 0]);
});

it('appends ordered revisions, skips duplicate saves and preserves history on restore and reset', async () => {
  const s = await source();
  const save = (corrections: MapCorrection[]) =>
    service.saveCorrections(s, { sourceIdentity: s.sourceIdentity, corrections });
  expect((await save([])).revision).toBe(0);
  expect((await save(operations)).revision).toBe(1);
  expect((await save(structuredClone(operations))).revision).toBe(1);
  const reversed = [...operations].reverse();
  expect((await save(reversed)).revision).toBe(2);
  expect(await service.restoreRevision(s, 1)).toMatchObject({
    revision: 3,
    corrections: operations,
  });
  expect(await service.resetCorrections(s)).toMatchObject({ revision: 4, corrections: [] });
  await expect(service.restoreRevision(s, 99)).rejects.toThrow(/Unknown/);
  expect((await service.listRevisions(s)).map((r) => r.corrections)).toEqual([
    [],
    operations,
    reversed,
    operations,
    [],
  ]);
  expect((await service.loadCorrections(s)).revision).toBe(4);
});

it('isolates equal names with different fingerprints or contents and rejects mismatched collections', async () => {
  const a = await source(),
    b = await source('18446744073709551614'),
    c = await source(fingerprint, [0, 100, 0]);
  for (const s of [a, b, c]) {
    expect((await service.loadCorrections(s)).revision).toBe(0);
    await service.saveCorrections(s, { sourceIdentity: s.sourceIdentity, corrections: operations });
  }
  expect(localStorage.length).toBe(3);
  await expect(
    service.saveCorrections(a, { sourceIdentity: b.sourceIdentity, corrections: operations }),
  ).rejects.toThrow(/identity/i);
});

it.each(['json', 'schema', 'identity', 'inactive geometry', 'sequence', 'active pointer'])(
  'preserves invalid saved %s on reads and mutations',
  async (defect) => {
    const s = await source();
    await service.saveCorrections(s, { sourceIdentity: s.sourceIdentity, corrections: operations });
    await service.resetCorrections(s);
    const key = localStorage.key(0)!,
      doc = JSON.parse(localStorage.getItem(key)!);
    if (defect === 'schema') doc.schemaVersion = 2;
    if (defect === 'identity') doc.sourceIdentity.source.fingerprint = 'different';
    if (defect === 'inactive geometry') doc.revisions[0].corrections[0].area.radiusM = -1;
    if (defect === 'sequence') doc.revisions[0].revision = 9;
    if (defect === 'active pointer') doc.activeRevision = 99;
    const invalid = defect === 'json' ? 'broken' : JSON.stringify(doc);
    localStorage.setItem(key, invalid);
    await expect(service.loadCorrections(s)).rejects.toThrow(/Invalid saved map history/);
    await expect(service.resetCorrections(s)).rejects.toThrow(/Invalid saved map history/);
    expect(localStorage.getItem(key)).toBe(invalid);
    expect(s.rawOccupancyGrid.data).toEqual([-1, 100, 0]);
  },
);

it('retains the previous revision after a failed write and permits retry', async () => {
  const s = await source();
  await service.saveCorrections(s, { sourceIdentity: s.sourceIdentity, corrections: operations });
  const key = localStorage.key(0)!,
    before = localStorage.getItem(key);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('Quota exceeded');
  });
  await expect(service.resetCorrections(s)).rejects.toThrow(/Quota/);
  expect(localStorage.getItem(key)).toBe(before);
  expect((await service.loadCorrections(s)).revision).toBe(1);
  expect((await service.resetCorrections(s)).revision).toBe(2);
});

it('retains concurrent distinct saves across service instances', async () => {
  const s = await source();
  const revisions = await Promise.all(
    operations.map((c) =>
      new MapCorrectionPersistence().saveCorrections(s, {
        sourceIdentity: s.sourceIdentity,
        corrections: [c],
      }),
    ),
  );
  expect(revisions.map((r) => r.revision).sort()).toEqual([1, 2, 3, 4, 5]);
  const history = await service.listRevisions(s);
  for (const r of revisions) expect(history[r.revision]).toEqual(r);
});
