// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createSourceMapSnapshot } from '../domain/map/MapSnapshots';
import {
  applyCorrections,
  previewMapCorrection,
  validateMapCorrectionCollection,
} from '../domain/map/MapCorrectionRasterizer';
import type { CorrectionArea, MapCorrection } from '../domain/map/MapCorrections';
import { AStarPlanner } from '../domain/planner/AStarPlanner';
import { defaultPlannerOptions } from '../domain/defaults';
import recorded from '../../artifacts/map-diagnostics/live-report.json';

const pt = (x: number, y: number) => ({ x, y });
const stamp = { createdAt: '2026-11-25T00:00:00Z' };
const area: CorrectionArea = {
  kind: 'rectangle',
  vertices: [pt(0, 0), pt(4, 0), pt(4, 3), pt(0, 3)],
};
const op = (
  kind: Exclude<MapCorrection['kind'], 'wall'>,
  geometry: CorrectionArea = area,
  id: string = kind,
): MapCorrection => ({ ...stamp, id, kind, area: geometry });
const wall = (x: number, y: number, u: number, v: number, thicknessM = 0.01): MapCorrection => ({
  ...stamp,
  id: 'wall',
  kind: 'wall',
  from: pt(x, y),
  to: pt(u, v),
  thicknessM,
});
const source = (
  width = 4,
  height = 3,
  data = [0, 0, -1, 0, 0, 100, 100, 0, 0, 100, -1, 0],
  resolution = 1,
  origin = { x: 0, y: 0, yaw: 0 },
) =>
  createSourceMapSnapshot(
    {
      metadata: {
        width,
        height,
        resolution,
        origin,
        mapId: 'M',
        name: 'M',
        freeThreshold: 0.196,
        occupiedThreshold: 0.65,
        negate: false,
      },
      data,
    },
    { kind: 'import' },
  );
type Source = Awaited<ReturnType<typeof source>>;
const collection = (s: Source, corrections: readonly MapCorrection[]) => ({
  sourceIdentity: s.sourceIdentity,
  corrections,
});
const run = (s: Source, ...ops: MapCorrection[]) => applyCorrections(s, collection(s, ops));

describe('ordered map corrections', () => {
  it.each(['erase', 'force_free', 'force_occupied', 'restore'] as const)(
    'applies %s to all three source classes',
    async (kind) => {
      const s = await source();
      const original = [...s.rawOccupancyGrid.data];
      const ops = [op('force_occupied', area, 'prior'), op(kind)];
      const copy = structuredClone(ops);
      const result = run(s, ...ops);
      expect(result.data).toEqual(
        original.map((v) =>
          kind === 'restore'
            ? v
            : kind === 'force_occupied'
              ? 100
              : kind === 'erase' && v < 0
                ? -1
                : 0,
        ),
      );
      expect(ops).toEqual(copy);
      expect(s.rawOccupancyGrid.data).toEqual(original);
      expect(result.metadata.origin).not.toBe(s.rawOccupancyGrid.metadata.origin);
    },
  );
  it('replays array order, removal, alternate overrides and source restoration', async () => {
    const s = await source();
    const ops = [
      op('force_free'),
      op('force_occupied'),
      op('erase'),
      wall(-1, 0.5, 5, 0.5),
      op('restore'),
    ];
    expect(run(s).data).toEqual(s.rawOccupancyGrid.data);
    expect(run(s, ...ops)).toEqual(run(s, ...structuredClone(ops)));
    expect(run(s, ...ops).data).toEqual(s.rawOccupancyGrid.data);
    expect(run(s, ...ops.slice(0, 3)).data[10]).toBe(-1);
    expect(run(s, ...ops.slice(0, 4)).data[10]).toBe(100);
  });
  it('previews unique ordered source, previous and resulting values across overlapping strokes', async () => {
    const s = await source();
    const stroke: CorrectionArea = {
      kind: 'stroke',
      points: [pt(-5, 0.5), pt(3.5, 0.5), pt(-5, 0.5)],
      radiusM: 0.1,
    };
    const proposed = op('force_free', stroke);
    const prior = collection(s, [wall(0, 0.5, 2, 0.5)]);
    const preview = previewMapCorrection(s, prior, proposed);
    expect(preview.cells.map((c) => c.index)).toEqual([8, 9, 10, 11]);
    expect(preview.cells.map((c) => c.sourceValue)).toEqual([0, 100, -1, 0]);
    expect(preview.cells.map((c) => c.previousValue)).toEqual([100, 100, 100, 0]);
    const result = run(s, ...prior.corrections, proposed);
    for (const c of preview.cells) expect(result.data[c.index]).toBe(c.resultValue);
    expect(result.data).toHaveLength(12);
  });
  it('changes only a centre on an inclusive circular boundary', async () => {
    const s = await source();
    const brush: CorrectionArea = { kind: 'circle', center: pt(1, 1.5), radiusM: 0.5 };
    expect(
      previewMapCorrection(s, collection(s, []), op('erase', brush)).cells.map((c) => c.index),
    ).toEqual([4, 5]);
    expect(run(s, op('erase', brush)).data[5]).toBe(0);
    expect(run(s, op('force_free', { ...brush, center: pt(-10, -10) }))).toEqual(run(s));
  });
  it('conservatively covers a subcell concave polygon in either winding direction', async () => {
    const s = await source(4, 3, Array(12).fill(-1));
    const vertices = [
      pt(0.1, 0.1),
      pt(2.9, 0.1),
      pt(2.9, 0.2),
      pt(0.2, 0.2),
      pt(0.2, 2.9),
      pt(0.1, 2.9),
    ];
    const polygon: CorrectionArea = { kind: 'polygon', vertices };
    expect(run(s, op('force_free', polygon))).toEqual(run(s));
    const result = run(s, op('force_occupied', polygon));
    expect(result.data).toEqual([100, -1, -1, -1, 100, -1, -1, -1, 100, 100, 100, -1]);
    expect(run(s, op('force_occupied', { ...polygon, vertices: [...vertices].reverse() }))).toEqual(
      result,
    );
  });
  it.each([
    [wall(-2, 1, 8, 1), [4, 5, 6, 7, 8, 9, 10, 11]],
    [wall(1, -2, 1, 8), [0, 1, 4, 5, 8, 9]],
    [wall(0, 0, 3, 3), [1, 2, 3, 4, 5, 6, 8, 9]],
    [wall(0, 0.5, 4, 0.5, 1.2), [4, 5, 6, 7, 8, 9, 10, 11]],
    [wall(-1, 0.2, 5, 2.2), [5, 6, 7, 8, 9]],
  ] as const)('covers touched cells along a wall %#', async (correction, indices) => {
    const s = await source();
    expect(
      previewMapCorrection(s, collection(s, []), correction).cells.map((c) => c.index),
    ).toEqual(indices);
  });
  it.each([0.05, 0.25, 1])(
    'preserves geometry under rigid MAP transforms at %s m/cell',
    async (resolution) => {
      const yaw = 0.72,
        origin = { x: -8, y: 3, yaw };
      const s = await source(4, 3, Array(12).fill(-1), resolution, origin);
      const world = (x: number, y: number) =>
        pt(
          origin.x + resolution * (Math.cos(yaw) * x - Math.sin(yaw) * y),
          origin.y + resolution * (Math.sin(yaw) * x + Math.cos(yaw) * y),
        );
      const polygon: CorrectionArea = {
        kind: 'rectangle',
        vertices: [world(0.5, 0.5), world(2.5, 0.5), world(2.5, 1.5), world(0.5, 1.5)],
      };
      expect(run(s, op('force_free', polygon)).data).toEqual([
        -1, -1, -1, -1, 0, 0, 0, -1, 0, 0, 0, -1,
      ]);
    },
  );
  it.each(['circle', 'stroke', 'rectangle', 'polygon'] as const)(
    'previews both explicit overrides with a %s',
    async (kind) => {
      const s = await source();
      const vertices = [pt(0.1, 0.1), pt(3.9, 0.1), pt(3.9, 2.9), pt(0.1, 2.9)] as const;
      const geometry: CorrectionArea =
        kind === 'circle'
          ? { kind, center: pt(2, 1.5), radiusM: 3 }
          : kind === 'stroke'
            ? { kind, points: [pt(-1, 1.5), pt(5, 1.5)], radiusM: 1.1 }
            : { kind, vertices };
      const free = op('force_free', geometry);
      const preview = previewMapCorrection(s, collection(s, []), free);
      expect(
        preview.cells
          .filter((c) => c.previousValue === -1 && c.resultValue === 0)
          .map((c) => c.index),
      ).toEqual([2, 10]);
      expect(
        preview.cells.filter((c) => c.previousValue === 100 && c.resultValue === 0),
      ).toHaveLength(3);
      expect(
        preview.cells.filter((c) => c.previousValue === 0 && c.resultValue === 0),
      ).toHaveLength(7);
      expect(run(s, free, op('force_occupied', geometry)).data).toEqual(Array(12).fill(100));
    },
  );
  it('opens a synthetic unknown barrier only on the derived explicit free override', async () => {
    const data = Array.from({ length: 25 }, (_, i) => (i % 5 === 2 ? -1 : 0));
    const s = await source(5, 5, data);
    const brush: CorrectionArea = { kind: 'circle', center: pt(2.5, 2.5), radiusM: 0.2 };
    const canPass = (...ops: MapCorrection[]) =>
      new AStarPlanner().plan(
        run(s, ...ops),
        { row: 2, column: 0 },
        { row: 2, column: 4 },
        defaultPlannerOptions,
      ).success;
    expect(canPass()).toBe(false);
    expect(canPass(op('erase', brush))).toBe(false);
    const free = op('force_free', brush);
    expect(canPass(free)).toBe(true);
    expect(canPass(free, op('restore', brush))).toBe(false);
    expect(canPass(free, op('force_occupied', brush))).toBe(false);
    expect(s.rawOccupancyGrid.data).toEqual(data);
  });
  it.each([
    { kind: 'polygon', vertices: [pt(0, 0), pt(2, 2), pt(0, 2), pt(2, 0)] },
    { kind: 'polygon', vertices: [pt(0, 0), pt(1, 0), pt(2, 0)] },
    { kind: 'rectangle', vertices: [pt(0, 0), pt(1, 0), pt(2, 1), pt(0, 1)] },
    { kind: 'stroke', points: [], radiusM: 1 },
    { kind: 'circle', center: pt(NaN, 0), radiusM: 1 },
    { kind: 'circle', center: pt(1, 1), radiusM: 0 },
    { kind: 'circle', center: pt(1, 1), radiusM: Infinity },
  ])('rejects malformed area %#', async (invalid) => {
    const s = await source();
    expect(() =>
      validateMapCorrectionCollection(s, collection(s, [op('erase', invalid as CorrectionArea)])),
    ).toThrow();
  });
  it('rejects incompatible identities, duplicate IDs, invalid walls, dimensions and unsupported operations', async () => {
    const s = await source(),
      other = await source(4, 3, Array(12).fill(0));
    for (const invalid of [
      collection(other, []),
      {
        ...collection(s, []),
        sourceIdentity: {
          ...s.sourceIdentity,
          metadata: { ...s.sourceIdentity.metadata, width: 7 },
        },
      },
      collection(s, [op('erase'), op('erase')]),
      collection(s, [wall(0, 0, 0, 0)]),
      collection(s, [wall(0, 0, 1, 1, -1)]),
      { ...collection(s, []), corrections: [{ ...op('erase'), kind: 'unknown' }] },
    ]) {
      expect(() => validateMapCorrectionCollection(s, invalid)).toThrow();
    }
    expect(() => run({ ...s, rawOccupancyGrid: { ...s.rawOccupancyGrid, data: [] } })).toThrow(
      /dimensions/,
    );
    expect(
      run(
        s,
        ...validateMapCorrectionCollection(
          s,
          JSON.parse(JSON.stringify(collection(s, [op('erase')]))),
        ).corrections,
      ),
    ).toEqual(run(s, op('erase')));
  });
  it('replays a representative collection on the recorded dimensions', async () => {
    const [w, h] = recorded.imagePixels as [number, number];
    const s = await source(
      w,
      h,
      Array.from({ length: w * h }, (_, i) => [-1, 0, 100][i % 3]!),
      recorded.resolution,
      { x: recorded.origin.x, y: recorded.origin.y, yaw: recorded.origin.a },
    );
    const corrections: MapCorrection[] = [];
    for (let i = 0; i < 12; i++) {
      const y = i * 0.8;
      const stroke: CorrectionArea = {
        kind: 'stroke',
        points: [pt(-10, y), pt(-6, y + 0.6), pt(-2, y), pt(1, y + 1)],
        radiusM: 0.15,
      };
      for (const kind of ['erase', 'force_free', 'force_occupied', 'restore'] as const)
        corrections.push(op(kind, stroke, kind + i));
      corrections.push({ ...wall(-13, y, 5, y + 5, 0.1), id: 'wall' + i });
    }
    const batch = collection(s, corrections);
    const expected = applyCorrections(s, batch);
    const times: number[] = [];
    for (let i = 0; i < 11; i++) {
      const start = performance.now();
      const result = applyCorrections(s, batch);
      times.push(performance.now() - start);
      expect(result.data[1000]).toBe(expected.data[1000]);
    }
    times.sort((a, b) => a - b);
    console.info(
      '60 corrections / 242446 cells, warm median and range (ms)',
      times[5],
      times[0],
      times[10],
    );
  });
});
