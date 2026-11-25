import { describe, expect, it, vi } from 'vitest';
import { compareMapLayers } from '../features/locator/services/mapDiagnostics';
import { LocatorCoordinateTransformer } from '../features/locator/services/locatorCoordinateTransformer';
import { LocatorMapService } from '../features/locator/services/locatorMapService';
import { diagnosticPointCloudResponseSchema } from '../features/locator/schemas/serverMapSchemas';
import { decodePointCloudMap } from '../features/locator/services/pointCloudMapConverter';
import type { LocatorSessionService } from '../features/locator/services/locatorSessionService';
import type { LocatorRasterMap } from '../features/locator/types';
import type { OccupancyGrid } from '../domain/types';

const raster: LocatorRasterMap = {
  mapName: 'map', pngBytes: new Uint8Array(), imageUrl: 'blob:test',
  pixelWidth: 4, pixelHeight: 4, widthMeters: 2, heightMeters: 2,
  pixelsPerMeter: 2, metersPerPixel: 0.5, origin: { x: -2, y: -3, yaw: Math.PI / 2 },
};
const grid: OccupancyGrid = { metadata: {
  name: 'map', mapId: 'map', width: 4, height: 4, resolution: 0.5, origin: raster.origin,
  occupiedThreshold: 0.65, freeThreshold: 0.196, negate: false,
}, data: [100, 100, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
const container = { contentEncoding: 'base64' as const, contentMediaType: 'application/PointCloud2D', content: 'AACAPwAAAEA=' };
const response = { responseCode: 0, pointCloud: container, pointCloudSize: 1, reflectors: [], zones: [] };
const version = { componentType: 2, componentVersion: '2.0.8', serverMapModule: { name: 'ServerMap', majorVersion: 9, minorVersion: 0 }, modules: [] };

describe('diagnostic map correspondence', () => {
  it('aligns rotated, negative origins and preserves duplicate points and source data', () => {
    const t = new LocatorCoordinateTransformer(raster);
    const p = { ...t.imagePixelToWorld(0.5, 0.5), reflector: false };
    const free = { ...t.imagePixelToWorld(2.5, 0.5), reflector: true };
    const cloud = { mapName: 'map', points: [p, { ...p }, free], originalPointCount: 3 };
    const source = structuredClone({ grid, cloud });
    const result = compareMapLayers(raster, grid, cloud);
    expect(result.hits[0]).toBe(2);
    expect(result.unsupported).toEqual([1]);
    expect(result.pointsOutsideOccupied).toBe(1);
    expect(result.pixels[0]).toBeCloseTo(0.5);
    expect(result.pixels[1]).toBeCloseTo(0.5);
    expect({ grid, cloud }).toEqual(source);
  });
  it('uses the existing grid convention on exact Y boundaries, not floor(imageY)', () => {
    const axisRaster = { ...raster, origin: { x: 0, y: 0, yaw: 0 } };
    const axisGrid = { ...grid, metadata: { ...grid.metadata, origin: axisRaster.origin } };
    const cloud = { mapName: 'map', originalPointCount: 3, points: [
      { x: 0.25, y: 1.5, reflector: false }, // image y=1; grid row=0
      { x: 0.25, y: 0, reflector: false }, // bottom boundary is inside row=3
      { x: 0.25, y: 2, reflector: false }, // top boundary is outside
    ] };
    const result = compareMapLayers(axisRaster, axisGrid, cloud);
    expect(result.hits[0]).toBe(1);
    expect(result.hits[12]).toBe(1);
    expect(result.outside).toBe(1);
  });
  it('reports nonfinite and outside points without dropping them from the source', () => {
    const cloud = { mapName: 'map', originalPointCount: 2, points: [
      { x: NaN, y: 1, reflector: false }, { x: 100, y: 100, reflector: false },
    ] };
    const result = compareMapLayers(raster, grid, cloud);
    expect(result.invalid).toBe(1); expect(result.outside).toBe(1);
    expect(result.pixels).toHaveLength(4); expect(cloud.points).toHaveLength(2);
  });
  it('rejects mismatched source geometry', () => {
    expect(() => compareMapLayers(raster, { ...grid, metadata: { ...grid.metadata, resolution: 0.1 } },
      { mapName: 'map', originalPointCount: 0, points: [] })).toThrow(/geometry/);
  });
});

function serviceFixture() {
  const post = vi.fn(async (path: string) => path.endsWith('serverMapGetMap') ? response : {
    responseCode: 0, level: 0, loaded: true, type: 0, fingerprint: 'revision',
  });
  const test = vi.fn().mockResolvedValue(version);
  return { post, test, service: new LocatorMapService({ rpc: { post }, test } as unknown as LocatorSessionService) };
}
describe('installed ServerMap 9 diagnostic contract', () => {
  it('retains every point, duplicate, order and reflector without a sampling limit', () => {
    const bytes = new Uint8Array(5000 * 8);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 5000; i++) {
      view.setFloat32(i * 8, i % 10, true);
      view.setFloat32(i * 8 + 4, -i, true);
    }
    const cloud = decodePointCloudMap('map', { ...container, content: btoa(String.fromCharCode(...bytes)) },
      5000, [{ fromIndex: 30, toIndex: 40 }]);
    expect(cloud.points).toHaveLength(5000);
    cloud.points.forEach((p, i) => expect(p).toEqual({ x: i % 10, y: -i, reflector: i >= 30 && i <= 40 }));
  });
  it('validates the complete live response shape and preserves its original container', async () => {
    const { service, post } = serviceFixture();
    const result = await service.getDiagnosticPointCloud(raster, grid, 'revision');
    expect(result.cloud.points).toEqual([{ x: 1, y: 2, reflector: false }]);
    expect(result.cloud.points).toHaveLength(result.cloud.originalPointCount);
    expect(result.raw.pointCloud).toEqual(container);
    expect(post).toHaveBeenCalledWith('/locator/map/serverMapGetMap', { serverMapName: 'map' });
    expect(post).toHaveBeenCalledTimes(3);
  });
  it('does not guess the format for an unverified major module version', async () => {
    const { service, test, post } = serviceFixture();
    test.mockResolvedValue({ ...version, serverMapModule: { ...version.serverMapModule, majorVersion: 10 } });
    await expect(service.getDiagnosticPointCloud(raster, grid, 'revision')).rejects.toThrow(/verified/);
    expect(post).not.toHaveBeenCalled();
  });
  it('rejects a stale PNG before requesting points', async () => {
    const { service, post } = serviceFixture();
    await expect(service.getDiagnosticPointCloud(raster, grid, 'old')).rejects.toThrow(/changed since/);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('rejects a map revision changing during download', async () => {
    const { service, post } = serviceFixture();
    post.mockResolvedValueOnce({ responseCode: 0, level: 0, loaded: true, type: 0, fingerprint: 'revision' })
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ responseCode: 0, level: 0, loaded: true, type: 0, fingerprint: 'changed' });
    await expect(service.getDiagnosticPointCloud(raster, grid, 'revision')).rejects.toThrow(/during/);
  });
  it('fails closed for changed fields or truncated binary data', async () => {
    expect(diagnosticPointCloudResponseSchema.safeParse({ ...response, reflectors: undefined }).success).toBe(false);
    const { service, post } = serviceFixture();
    post.mockResolvedValueOnce({ responseCode: 0, level: 0, loaded: true, type: 0, fingerprint: 'revision' })
      .mockResolvedValueOnce({ ...response, pointCloudSize: 2 });
    await expect(service.getDiagnosticPointCloud(raster, grid, 'revision')).rejects.toThrow(/byte length/);
  });
});
