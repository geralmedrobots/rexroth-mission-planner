import type { BoschContainer } from '../schemas/containerSchemas';
import { decodeBase64Container } from './pngContainerDecoder';
import type { LocatorPointCloudMap } from '../types';

interface Cluster { fromIndex: number; toIndex: number }

export const decodePointCloudMap = (
  mapName: string,
  container: BoschContainer,
  pointCloudSize: number,
  reflectors: Cluster[],
  maxNonReflectorPoints?: number,
): LocatorPointCloudMap => {
  const bytes = decodeBase64Container(container, 'application/PointCloud2D');
  if (bytes.byteLength !== pointCloudSize * 8) {
    throw new Error(`Point cloud byte length ${bytes.byteLength} does not match 8 × ${pointCloudSize}.`);
  }
  const reflectorIndices = new Set<number>();
  for (const cluster of reflectors) {
    if (cluster.fromIndex > cluster.toIndex || cluster.toIndex >= pointCloudSize) {
      throw new Error('Reflector PointCluster index range is invalid.');
    }
    for (let index = cluster.fromIndex; index <= cluster.toIndex; index += 1) reflectorIndices.add(index);
  }
  const nonReflectorCount = pointCloudSize - reflectorIndices.size;
  const limit = maxNonReflectorPoints === undefined ? nonReflectorCount : Math.max(0, Math.floor(maxNonReflectorPoints));
  const stride = limit > 0 ? Math.max(1, Math.ceil(nonReflectorCount / limit)) : Number.POSITIVE_INFINITY;
  let seenNonReflectors = 0;
  let includedNonReflectors = 0;
  const points: LocatorPointCloudMap['points'] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < pointCloudSize; index += 1) {
    const reflector = reflectorIndices.has(index);
    const include = reflector || (seenNonReflectors++ % stride === 0 && includedNonReflectors < limit);
    if (include) {
      points.push({
        x: view.getFloat32(index * 8, true),
        y: view.getFloat32(index * 8 + 4, true),
        reflector,
      });
      if (!reflector) includedNonReflectors += 1;
    }
  }
  return { mapName, points, originalPointCount: pointCloudSize };
};
