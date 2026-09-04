import { describe, expect, it, vi } from 'vitest';
import { ServerMapApi } from '../features/locator/api/serverMapApi';
import { findExactServerMap } from '../features/locator/mapSelection';
import type { LocatorRpcClient } from '../features/locator/api/locatorRpcClient';

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
});
