// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { createPlanningMapSnapshot, createSourceMapSnapshot, sameSourceMap } from '../domain/map/MapSnapshots';
import { AStarPlanner } from '../domain/planner/AStarPlanner';
import { ObstacleInflation } from '../domain/planner/ObstacleInflation';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import type { MapMetadata, OccupancyGrid } from '../domain/types';
import { createSampleMap } from '../features/map/sampleMap';

const instance = { host: 'locator.example', port: 18082, https: true, rpcEndpoint: '/' };
const locator = { kind: 'locator', instance, fingerprint: '7722289214529635123' } as const;
const imported = { kind: 'import' } as const;
const map = (): OccupancyGrid => ({
  metadata: {
    name: ' Map A ', mapId: 'Map-A', width: 3, height: 2, resolution: 0.05,
    origin: { x: -1.5, y: 2.25, yaw: 0.73 }, occupiedThreshold: 0.65, freeThreshold: 0.196, negate: false,
  },
  data: [-1, 0, 100, 0, 12.5, 100],
});

describe('source-map identity', () => {
  it('has a stable digest and identical identities for independent maps with the same values', async () => {
    const first = await createSourceMapSnapshot(map(), locator);
    const second = await createSourceMapSnapshot(map(), { ...locator, instance: { ...instance } });
    expect(first.sourceIdentity.occupancyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.sourceIdentity).toEqual(second.sourceIdentity);
    expect(sameSourceMap(first.sourceIdentity, second.sourceIdentity)).toBe(true);
    expect(first.sourceIdentity.metadata).toMatchObject({ name: ' Map A ', mapId: 'Map-A' });
  });

  it('distinguishes occupancy changes and cell order under the same map name and fingerprint', async () => {
    const original = await createSourceMapSnapshot(map(), locator);
    const grid = map();
    grid.data[4] = 12.6;
    const modified = await createSourceMapSnapshot(grid, locator);
    const reordered = await createSourceMapSnapshot({ ...map(), data: map().data.reverse() }, locator);
    for (const other of [modified, reordered]) {
      expect(other.sourceIdentity.occupancyDigest).not.toBe(original.sourceIdentity.occupancyDigest);
      expect(sameSourceMap(original.sourceIdentity, other.sourceIdentity)).toBe(false);
    }
  });

  it.each<[string, Partial<MapMetadata>]>([
    ['dimensions', { width: 2, height: 3 }],
    ['resolution', { resolution: 0.1 }],
    ['origin X', { origin: { ...map().metadata.origin, x: 9 } }],
    ['origin Y', { origin: { ...map().metadata.origin, y: 9 } }],
    ['origin yaw', { origin: { ...map().metadata.origin, yaw: 0 } }],
    ['occupied threshold', { occupiedThreshold: 0.75 }],
    ['free threshold', { freeThreshold: 0.1 }],
    ['negation', { negate: true }],
  ])('includes %s in the digest', async (_label, changes) => {
    const grid = map();
    const original = await createSourceMapSnapshot(grid, imported);
    const updated = await createSourceMapSnapshot({ ...grid, metadata: { ...grid.metadata, ...changes } }, imported);
    expect(updated.sourceIdentity.occupancyDigest).not.toBe(original.sourceIdentity.occupancyDigest);
  });

  it('distinguishes provenance independently of the occupancy digest', async () => {
    const original = await createSourceMapSnapshot(map(), locator);
    const alternatives = await Promise.all([
      createSourceMapSnapshot(map(), imported),
      createSourceMapSnapshot(map(), { ...locator, fingerprint: '7722289214529635124' }),
      createSourceMapSnapshot(map(), { ...locator, instance: { ...instance, host: 'another.example' } }),
      createSourceMapSnapshot({ ...map(), metadata: { ...map().metadata, mapId: 'map-a' } }, locator),
    ]);
    for (const other of alternatives) {
      expect(other.sourceIdentity.occupancyDigest).toBe(original.sourceIdentity.occupancyDigest);
      expect(sameSourceMap(original.sourceIdentity, other.sourceIdentity)).toBe(false);
    }
  });
});

describe('source and planning snapshots', () => {
  it('separates each mutable grid from the original cells, metadata, and raster bytes', async () => {
    const grid = map();
    const pngBytes = new Uint8Array([1, 2, 3]);
    const image = new Blob([pngBytes], { type: 'image/png' });
    const sourcePromise = createSourceMapSnapshot(grid, locator, { image, pixelWidth: 3, pixelHeight: 2 });
    grid.data[0] = 99;
    grid.metadata.origin.x = 99;
    pngBytes[0] = 99;
    const source = await sourcePromise;
    const planning = createPlanningMapSnapshot(source);
    expect(planning.revision).toBe(0);
    expect(planning.sourceIdentity).toBe(source.sourceIdentity);
    expect(planning.effectiveOccupancyGrid).toEqual(source.rawOccupancyGrid);
    planning.effectiveOccupancyGrid.data[1] = 100;
    planning.effectiveOccupancyGrid.metadata.origin.y = 99;
    expect(source.rawOccupancyGrid).toEqual(map());
    expect(createPlanningMapSnapshot(source).effectiveOccupancyGrid).toEqual(map());
    expect(Object.isFrozen(source.rawOccupancyGrid.data)).toBe(true);
    expect(Object.isFrozen(source.rawOccupancyGrid.metadata.origin)).toBe(true);
    expect(Object.isFrozen(source.originalRaster)).toBe(true);
    const imageCopy = new Uint8Array(await source.originalRaster!.image.arrayBuffer());
    expect(imageCopy).toEqual(new Uint8Array([1, 2, 3]));
    imageCopy[0] = 99;
    expect(new Uint8Array(await source.originalRaster!.image.arrayBuffer())[0]).toBe(1);
  });

  it('produces equivalent inflation and A* paths on the initial planning grid', async () => {
    const original = createSampleMap();
    const source = await createSourceMapSnapshot(original, imported);
    const { effectiveOccupancyGrid } = createPlanningMapSnapshot(source);
    const originalInflated = ObstacleInflation.byRadius(original, 0.12);
    const effectiveInflated = ObstacleInflation.byRadius(effectiveOccupancyGrid, 0.12);
    expect(effectiveInflated).toEqual(originalInflated);
    const start = { row: 5, column: 5 };
    const goal = { row: 38, column: 65 };
    const legacy = new AStarPlanner().plan(originalInflated, start, goal, defaultPlannerOptions);
    const effective = new AStarPlanner().plan(effectiveInflated, start, goal, defaultPlannerOptions);
    expect(legacy.success).toBe(true);
    expect(effective.success).toBe(true);
    expect(effective.rawPath).toEqual(legacy.rawPath);
    expect(source.rawOccupancyGrid).toEqual(original);
  });

  it('produces the same motion-state path and actions on the initial planning grid', async () => {
    const original = createSampleMap();
    const source = await createSourceMapSnapshot(original, imported);
    const { effectiveOccupancyGrid } = createPlanningMapSnapshot(source);
    const start = { row: 6, column: 7 };
    const goal = { row: 6, column: 12 };
    const transform = new CoordinateTransformer(original.metadata);
    const settings = {
      start, goal, exactStartPose: transform.gridToWorld(start.row, start.column),
      exactGoalPose: transform.gridToWorld(goal.row, goal.column), startTheta: 0, goalTheta: 0,
      options: defaultPlannerOptions, footprint: defaultFootprint, plannerStrategy: 'motion-state',
    } as const;
    const legacy = new MotionStatePlanner().plan({ ...settings, grid: original });
    const effective = new MotionStatePlanner().plan({ ...settings, grid: effectiveOccupancyGrid });
    expect(legacy.success).toBe(true);
    expect(effective.success).toBe(true);
    expect(effective.rawPath).toEqual(legacy.rawPath);
    expect(effective.motionPlan?.actions).toEqual(legacy.motionPlan?.actions);
  });
});
