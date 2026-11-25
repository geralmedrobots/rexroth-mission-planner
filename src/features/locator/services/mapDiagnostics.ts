import type { OccupancyGrid } from '../../../domain/types';
import { CoordinateTransformer } from '../../../domain/geometry/CoordinateTransformer';
import type { LocatorPointCloudMap, LocatorRasterMap } from '../types';
import { LocatorCoordinateTransformer } from './locatorCoordinateTransformer';

/** Diagnostic evidence only: no writes to the source map or points. */
export function compareMapLayers(raster: LocatorRasterMap, grid: OccupancyGrid, cloud: LocatorPointCloudMap) {
  const m = grid.metadata;
  if (cloud.mapName !== raster.mapName || m.mapId !== raster.mapName ||
      m.width !== raster.pixelWidth || m.height !== raster.pixelHeight ||
      grid.data.length !== m.width * m.height ||
      m.resolution !== raster.metersPerPixel || m.origin.x !== raster.origin.x ||
      m.origin.y !== raster.origin.y || m.origin.yaw !== raster.origin.yaw) {
    throw new Error('PNG, occupancy grid and point cloud must describe the same map geometry.');
  }
  const imageTransform = new LocatorCoordinateTransformer(raster);
  const gridTransform = new CoordinateTransformer(m);
  const hits = new Uint32Array(m.width * m.height);
  const pixels = new Float64Array(cloud.points.length * 2);
  let outside = 0;
  let invalid = 0;
  let pointsOutsideOccupied = 0;
  cloud.points.forEach((point, index) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      invalid++;
      pixels[index * 2] = NaN;
      pixels[index * 2 + 1] = NaN;
      return;
    }
    const pixel = imageTransform.worldToImagePixel(point.x, point.y);
    pixels[index * 2] = pixel.pixelX;
    pixels[index * 2 + 1] = pixel.pixelY;
    // Use the planner's established half-open cell convention, including points
    // exactly on a horizontal cell boundary. floor(imageY) is wrong there.
    const cell = gridTransform.worldToGrid(point.x, point.y);
    if (!cell) { outside++; return; }
    const i = cell.row * m.width + cell.column;
    hits[i] = hits[i]! + 1;
    if ((grid.data[i] ?? -1) < m.occupiedThreshold) pointsOutsideOccupied++;
  });
  const occupied: number[] = [];
  const unsupported: number[] = [];
  grid.data.forEach((value, i) => {
    if (value < m.occupiedThreshold) return;
    occupied.push(i);
    if (hits[i] === 0) unsupported.push(i);
  });
  return { pixels, hits, occupied, unsupported, outside, invalid, pointsOutsideOccupied,
    extentDeltaX: raster.widthMeters - raster.pixelWidth * raster.metersPerPixel,
    extentDeltaY: raster.heightMeters - raster.pixelHeight * raster.metersPerPixel };
}
