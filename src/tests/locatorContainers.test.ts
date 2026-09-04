import { describe, expect, it } from 'vitest';
import { decodePngContainer } from '../features/locator/services/pngContainerDecoder';
import { decodePointCloudMap } from '../features/locator/services/pointCloudMapConverter';

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

describe('Bosch Container decoding', () => {
  it('validates PNG signature and reads IHDR dimensions', () => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(bytes.buffer).setUint32(16, 640, false);
    new DataView(bytes.buffer).setUint32(20, 480, false);
    expect(decodePngContainer({
      contentEncoding: 'base64',
      contentMediaType: 'image/png',
      content: base64(bytes),
    })).toMatchObject({ pixelWidth: 640, pixelHeight: 480 });
  });

  it('rejects an invalid PNG', () => {
    expect(() => decodePngContainer({
      contentEncoding: 'base64',
      contentMediaType: 'image/png',
      content: base64(new Uint8Array(24)),
    })).toThrow(/PNG signature/);
  });

  it('decodes little-endian PointCloud2D and preserves all reflector points', () => {
    const bytes = new Uint8Array(4 * 8);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < 4; index += 1) {
      view.setFloat32(index * 8, index + 0.25, true);
      view.setFloat32(index * 8 + 4, -index, true);
    }
    const result = decodePointCloudMap('real-map', {
      contentEncoding: 'base64',
      contentMediaType: 'application/PointCloud2D',
      content: base64(bytes),
    }, 4, [{ fromIndex: 1, toIndex: 2 }], 1);
    expect(result.points.filter((point) => point.reflector)).toHaveLength(2);
    expect(result.points).toHaveLength(3);
    expect(result.points[1]?.x).toBeCloseTo(1.25);
  });
});
