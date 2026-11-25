import { afterEach, describe, expect, it, vi } from 'vitest';
import recorded from '../../artifacts/map-diagnostics/live-report.json';
import { ServerMapApi } from '../features/locator/api/serverMapApi';
import { findExactServerMap } from '../features/locator/mapSelection';
import type { LocatorRpcClient } from '../features/locator/api/locatorRpcClient';
import { LocatorMapService } from '../features/locator/services/locatorMapService';
import { LocatorSessionService } from '../features/locator/services/locatorSessionService';
import { defaultLocatorSettings } from '../features/locator/stores/locatorStore';

afterEach(() => vi.unstubAllGlobals());

describe('Locator official map API bindings', () => {
  it('uses the documented serverMapGetImageWithResolution field names', async () => {
    const post = vi.fn().mockResolvedValue({
      responseCode: 0,
      MAPimageOrigin: { x: -1, y: -2, a: 0.2 },
      width: 10,
      height: 8,
      image: { contentEncoding: 'base64', contentMediaType: 'image/png', content: 'iVBORw==' },
    });
    const api = new ServerMapApi({ post } as unknown as LocatorRpcClient);
    await api.getImageWithResolution('Map-A', 20);
    expect(post).toHaveBeenCalledWith(
      '/locator/map/serverMapGetImageWithResolution',
      { serverMapName: 'Map-A', resolution: 20 },
    );
  });

  it('matches Navigator mapId exactly and never by case or substring', () => {
    const maps = [{ name: 'Map-A' }, { name: 'Map-A-copy' }];
    expect(findExactServerMap(maps, 'Map-A')?.name).toBe('Map-A');
    expect(findExactServerMap(maps, 'map-a')).toBeUndefined();
    expect(findExactServerMap(maps, 'Map')).toBeUndefined();
  });

  it('rejects an unsafe browser number and accepts the same wire fingerprint as a string', async () => {
    const info = { responseCode: 0, type: 0, level: 0, loaded: true };
    const post = vi.fn().mockResolvedValueOnce({ ...info, fingerprint: Number('7722289214529635123') })
      .mockResolvedValueOnce({ ...info, fingerprint: '7722289214529635123' });
    const api = new ServerMapApi({ post } as unknown as LocatorRpcClient);
    await expect(api.getInfo('Map-A')).rejects.toThrow();
    expect((await api.getInfo('Map-A')).fingerprint).toBe('7722289214529635123');
  });
});

describe('Locator source downloads', () => {
  function setupDownload(afterFingerprint = '7722289214529635123') {
    const [width, height] = recorded.imagePixels as [number, number];
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(bytes.buffer);
    header.setUint32(16, width);
    header.setUint32(20, height);
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height, close }));
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    rgba.set([0, 0, 0, 255, 128, 128, 128, 255]);
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn(), getImageData: () => ({ data: rgba }) }; }
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = () => 'blob:pending';
      static revokeObjectURL = revokeObjectURL;
    });
    const info = { responseCode: 0, type: 0, level: 0, loaded: true };
    const post = vi.fn().mockResolvedValueOnce({ ...info, fingerprint: '7722289214529635123' })
      .mockResolvedValueOnce({ responseCode: 0, MAPimageOrigin: recorded.origin,
        width: recorded.imageMeters[0], height: recorded.imageMeters[1],
        image: { contentEncoding: 'base64', contentMediaType: 'image/png', content: btoa(String.fromCharCode(...bytes)) },
      })
      .mockResolvedValueOnce({ ...info, fingerprint: afterFingerprint });
    const configure = vi.fn().mockResolvedValue({ configured: true });
    const sessions = new LocatorSessionService({ post, configure } as unknown as LocatorRpcClient);
    return { service: new LocatorMapService(sessions), sessions, post, close, revokeObjectURL };
  }

  it('uses decoded dimensions, preserves Bosch extents and applies the existing thresholds', async () => {
    const { service, sessions, post, close, revokeObjectURL } = setupDownload();
    await sessions.connect({ ...defaultLocatorSettings, host: ' Locator.Example ' });
    const { occupancy, raster, image, info, instance } = await service.downloadSource(recorded.mapName, defaultLocatorSettings);
    expect(post.mock.calls.map(([path]) => path)).toEqual([
      '/locator/map/serverMapGetInfo', '/locator/map/serverMapGetImageWithResolution', '/locator/map/serverMapGetInfo',
    ]);
    expect(info.fingerprint).toBe('7722289214529635123');
    expect(instance?.host).toBe('locator.example');
    expect(occupancy.metadata).toMatchObject({ width: 482, height: 503, resolution: 0.05, mapId: recorded.mapName });
    expect(occupancy.data).toHaveLength(242_446);
    expect(occupancy.data.slice(0, 3)).toEqual([100, -1, 0]);
    expect(raster.heightMeters).toBe(recorded.imageMeters[1]);
    expect(raster.origin).toEqual({ x: recorded.origin.x, y: recorded.origin.y, yaw: recorded.origin.a });
    expect(image.type).toBe('image/png');
    expect(close).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('discards the pending raster when the source revision changes during download', async () => {
    const { service, revokeObjectURL } = setupDownload('7722289214529635124');
    await expect(service.downloadSource(recorded.mapName, defaultLocatorSettings)).rejects.toThrow(/changed/);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:pending');
  });
});
