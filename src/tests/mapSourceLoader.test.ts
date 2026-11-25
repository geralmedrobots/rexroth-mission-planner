import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sameSourceMap } from '../domain/map/MapSnapshots';
import { ObstacleInflation } from '../domain/planner/ObstacleInflation';
import { locatorMapService } from '../features/locator/services/locatorMapService';
import { useLocatorStore } from '../features/locator/stores/locatorStore';
import { beginMapLoad, loadImageMap, loadJsonMap, loadLocatorSource, replaceLegacyPlanningGrid } from '../features/map/mapSourceLoader';
import { useAppStore } from '../stores/appStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const json = (cellData = [0, -1]) => JSON.stringify({
  width: 2, height: 1, resolution: 0.1, origin: { x: -1, y: 2, yaw: 0.1 }, cellData,
});
const jsonFile = (text = json()) => Object.assign(new File([], 'map.json'), { text: async () => text });
const downloaded = (name: string, occupancyValue = 100) => {
  const origin = { x: 1, y: 2, yaw: 0.2 };
  const pngBytes = new Uint8Array([4, 5, 6]);
  return {
    occupancy: {
      metadata: { name, mapId: name, width: 2, height: 1, resolution: 0.05,
        origin, occupiedThreshold: 0.65, freeThreshold: 0.196, negate: false },
      data: [occupancyValue, -1],
    },
    raster: { mapName: name, pngBytes, imageUrl: `blob:${name}/${occupancyValue}`, origin,
      pixelWidth: 2, pixelHeight: 1, widthMeters: 0.1, heightMeters: 0.11,
      pixelsPerMeter: 20, metersPerPixel: 0.05 },
    image: new Blob([pngBytes], { type: 'image/png' }),
    info: { name, fingerprint: '7722289214529635123', level: 0, loaded: true, type: 0, warnings: [] },
    instance: { host: 'locator.example', port: 18082, https: true, rpcEndpoint: '/' },
  };
};

const revokeObjectURL = vi.fn();
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revokeObjectURL; });
  revokeObjectURL.mockClear();
  useAppStore.setState({ grid: undefined, inflatedGrid: undefined, sourceMap: undefined, planningMap: undefined });
  useLocatorStore.setState({ loadedMap: undefined, mapInfo: undefined, downloading: false, selectedMapName: '' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('map source initialization', () => {
  it('loads grid JSON into the existing planner grid and preserves inflation and route invalidation', async () => {
    const { routeRevision, plannerOptions } = useAppStore.getState();
    await loadJsonMap(jsonFile());
    const { sourceMap, planningMap, grid, inflatedGrid, routeRevision: loadedRevision } = useAppStore.getState();
    expect(sourceMap?.sourceIdentity.source).toEqual({ kind: 'import' });
    expect(sourceMap?.rawOccupancyGrid.data).toEqual([0, -1]);
    expect(grid).toBe(planningMap?.effectiveOccupancyGrid);
    expect(grid?.data).toEqual(sourceMap?.rawOccupancyGrid.data);
    const { planningSafetyMarginM, localizationMarginM } = plannerOptions.passageSafety;
    expect(inflatedGrid).toEqual(ObstacleInflation.byRadius(grid!, planningSafetyMarginM + localizationMarginM));
    expect(loadedRevision).toBe(routeRevision + 1);
  });

  it('loads the repository PGM and YAML fixture with its existing geometry and classification', async () => {
    const [pgm, yaml] = await Promise.all([
      readFile('examples/sample-map.pgm'), readFile('examples/sample-map.yaml', 'utf8'),
    ]);
    const file = Object.assign(new File([new Uint8Array(pgm)], 'sample-map.pgm'), {
      arrayBuffer: async () => Uint8Array.from(pgm).buffer,
    });
    await loadImageMap(file, yaml);
    const { sourceMap, grid } = useAppStore.getState();
    expect(grid?.metadata).toMatchObject({ mapId: 'sample-map', width: 20, height: 16,
      resolution: 0.1, origin: { x: -1, y: -0.8, yaw: 0 } });
    expect(grid?.data).toHaveLength(320);
    expect(grid?.data[0]).toBe(100);
    expect(grid?.data).toContain(0);
    expect(grid?.data).toEqual(sourceMap?.rawOccupancyGrid.data);
    expect(sourceMap?.originalRaster?.image).toBe(file);
  });

  it('keeps the source snapshot through existing click edits and replaces it on same-name reload', async () => {
    const activate = vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    vi.spyOn(locatorMapService, 'downloadSource')
      .mockResolvedValueOnce(downloaded('Map-A')).mockResolvedValueOnce(downloaded('Map-A', 0));
    const grid = (await loadLocatorSource('Map-A'))!;
    const original = useAppStore.getState().sourceMap!;
    replaceLegacyPlanningGrid({ ...grid, data: [50, -1] });
    expect(useAppStore.getState().planningMap?.revision).toBe(1);
    expect(useAppStore.getState().sourceMap).toBe(original);
    expect(original.rawOccupancyGrid.data).toEqual([100, -1]);
    expect(useAppStore.getState().grid?.data).toEqual([50, -1]);

    await loadLocatorSource('Map-A');
    const { sourceMap, planningMap, grid: fresh } = useAppStore.getState();
    expect(sameSourceMap(original.sourceIdentity, sourceMap!.sourceIdentity)).toBe(false);
    expect(planningMap?.revision).toBe(0);
    expect(fresh?.data).toEqual(sourceMap?.rawOccupancyGrid.data);
    expect(fresh?.data).toEqual([0, -1]);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('drops an older Locator response while a later selection is still downloading', async () => {
    const older = deferred<ReturnType<typeof downloaded>>();
    const newer = deferred<ReturnType<typeof downloaded>>();
    vi.spyOn(locatorMapService, 'downloadSource').mockImplementation((name) =>
      name === 'Older' ? older.promise : newer.promise);
    const activate = vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    const first = loadLocatorSource('Older');
    const second = loadLocatorSource('Newer');
    older.resolve(downloaded('Older'));
    expect(await first).toBeUndefined();
    expect(useLocatorStore.getState().downloading).toBe(true);
    expect(useLocatorStore.getState().selectedMapName).toBe('Newer');
    expect(useAppStore.getState().grid).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:Older/100');
    newer.resolve(downloaded('Newer', 0));
    expect((await second)?.data).toEqual([0, -1]);
    expect(useLocatorStore.getState().loadedMap?.mapName).toBe('Newer');
    expect(useLocatorStore.getState().downloading).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('keeps the current planning revision on startup only when the full source identity agrees', async () => {
    const activate = vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    const first = downloaded('Map-A');
    const duplicate = downloaded('Map-A');
    duplicate.raster.imageUrl = 'blob:duplicate';
    vi.spyOn(locatorMapService, 'downloadSource').mockResolvedValueOnce(first)
      .mockResolvedValueOnce(duplicate).mockResolvedValueOnce(downloaded('Map-A', 0));
    const grid = (await loadLocatorSource('Map-A'))!;
    replaceLegacyPlanningGrid({ ...grid, data: [50, -1] });
    const revision = useAppStore.getState().routeRevision;
    expect(await loadLocatorSource('Map-A', { skipUnchanged: true })).toBeUndefined();
    expect(useAppStore.getState().routeRevision).toBe(revision);
    expect(useAppStore.getState().grid?.data).toEqual([50, -1]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:duplicate');
    expect((await loadLocatorSource('Map-A', { skipUnchanged: true }))?.data).toEqual([0, -1]);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('allows a newer import to win over an older load already hashing occupancy', async () => {
    const digest = deferred<ArrayBuffer>();
    vi.spyOn(webcrypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    vi.spyOn(locatorMapService, 'downloadSource').mockResolvedValue(downloaded('Older'));
    const activate = vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    const first = loadLocatorSource('Older');
    await Promise.resolve();
    expect(webcrypto.subtle.digest).toHaveBeenCalledTimes(1);
    await loadJsonMap(jsonFile(json([5, 6])));
    digest.resolve(new ArrayBuffer(32));
    expect(await first).toBeUndefined();
    expect(useAppStore.getState().sourceMap?.sourceIdentity.source.kind).toBe('import');
    expect(useAppStore.getState().grid?.data).toEqual([5, 6]);
    expect(activate).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:Older/100');
  });

  it('drops an older local file read and skips a superseded deferred Locator request', async () => {
    const read = deferred<string>();
    const first = loadJsonMap(Object.assign(jsonFile(), { text: () => read.promise }));
    const reserved = beginMapLoad();
    await loadJsonMap(jsonFile(json([7, 8])));
    const download = vi.spyOn(locatorMapService, 'downloadSource');
    expect(await loadLocatorSource('Stale', { version: reserved })).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    read.resolve(json());
    await first;
    expect(useAppStore.getState().grid?.data).toEqual([7, 8]);
  });

  it('does not commit a cancelled startup download', async () => {
    const controller = new AbortController();
    const response = deferred<ReturnType<typeof downloaded>>();
    vi.spyOn(locatorMapService, 'downloadSource').mockReturnValue(response.promise);
    const load = loadLocatorSource('Startup', { signal: controller.signal });
    controller.abort();
    response.resolve(downloaded('Startup'));
    expect(await load).toBeUndefined();
    expect(useAppStore.getState().sourceMap).toBeUndefined();
    expect(useLocatorStore.getState().downloading).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:Startup/100');
  });
});
