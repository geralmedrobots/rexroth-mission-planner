import { describe, expect, it } from 'vitest';
import recorded from '../../artifacts/map-diagnostics/live-report.json';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import type { MapMetadata } from '../domain/types';
import { LocatorCoordinateTransformer } from '../features/locator/services/locatorCoordinateTransformer';

const map = (yaw = 0) => ({
  origin: { x: -5, y: -3, yaw },
  pixelHeight: 200,
  pixelsPerMeter: 20,
  metersPerPixel: 0.05,
});

const [width, height] = recorded.imagePixels as [number, number];
const metadata: MapMetadata = {
  name: recorded.mapName, mapId: recorded.mapName, width, height, resolution: recorded.resolution,
  origin: { x: recorded.origin.x, y: recorded.origin.y, yaw: recorded.origin.a },
  occupiedThreshold: 0.65, freeThreshold: 0.196, negate: false,
};
const imageTransform = (mapMetadata: MapMetadata) => new LocatorCoordinateTransformer({
  origin: mapMetadata.origin, pixelHeight: mapMetadata.height,
  pixelsPerMeter: 1 / mapMetadata.resolution, metersPerPixel: mapMetadata.resolution,
});

describe('Locator MAP frame and planning grid alignment', () => {
  it.each([recorded.origin.a, -0.72])('maps image cell centres and grid cells to the same MAP position at yaw %s', (yaw) => {
    const geometry = { ...metadata, origin: { ...metadata.origin, yaw } };
    const grid = new CoordinateTransformer(geometry);
    const image = imageTransform(geometry);
    for (const cell of [{ row: 0, column: 0 }, { row: 230, column: 119 }, { row: height - 1, column: width - 1 }]) {
      const world = grid.gridToWorld(cell.row, cell.column);
      const centre = image.imagePixelToWorld(cell.column + 0.5, cell.row + 0.5);
      expect(world.x).toBeCloseTo(centre.x, 10);
      expect(world.y).toBeCloseTo(centre.y, 10);
      expect(world.theta).toBeCloseTo(yaw, 10);
      expect(grid.worldToGrid(centre.x, centre.y)).toEqual(cell);
      const pixel = image.worldToImagePixel(world.x, world.y);
      expect(pixel.pixelX).toBeCloseTo(cell.column + 0.5, 10);
      expect(pixel.pixelY).toBeCloseTo(cell.row + 0.5, 10);
    }
  });

  it('retains half-open local cell boundaries and continuous inverted image Y', () => {
    // Exactly representable half-metre steps isolate the boundary convention from floating-point rounding.
    const geometry = { ...metadata, width: 4, height: 3, resolution: 0.5, origin: { x: -2, y: 3, yaw: 0 } };
    const grid = new CoordinateTransformer(geometry);
    const image = imageTransform(geometry);
    const boundary = image.imagePixelToWorld(1, 1);
    expect(image.worldToImagePixel(boundary.x, boundary.y)).toEqual({ pixelX: 1, pixelY: 1 });
    expect(grid.worldToGrid(boundary.x, boundary.y)).toEqual({ row: 0, column: 1 });
    expect(grid.worldToGrid(boundary.x - 0.001, boundary.y - 0.001)).toEqual({ row: 1, column: 0 });
    expect(grid.worldToGrid(-2, 3)).toEqual({ row: 2, column: 0 });
    expect(grid.worldToGrid(-2, 4.5)).toBeNull();
    expect(grid.worldToGrid(0, 3)).toBeNull();
  });

  it('keeps the recorded 482×503 scale when the reported physical height extends past the image', () => {
    const grid = new CoordinateTransformer(metadata);
    const image = imageTransform(metadata);
    expect(width * height).toBe(242_446);
    const origin = image.imagePixelToWorld(0, height);
    expect(origin).toEqual({ x: recorded.origin.x, y: recorded.origin.y });
    const top = image.imagePixelToWorld(0, 0);
    expect(top.y - origin.y).toBeCloseTo(25.15, 10);
    const reportedTop = origin.y + recorded.imageMeters[1]!;
    const beyond = image.worldToImagePixel(origin.x, reportedTop);
    expect(beyond.pixelY).toBeLessThan(-1);
    expect(grid.worldToGrid(origin.x, reportedTop)).toBeNull();
  });

  it('leaves continuous pixels outside the raster while rejecting exterior cells on a rotated map', () => {
    const geometry = { ...metadata, origin: { ...metadata.origin, yaw: 0.61 } };
    const grid = new CoordinateTransformer(geometry);
    const image = imageTransform(geometry);
    for (const [pixelX, pixelY] of [[-0.1, 40], [width + 0.1, 40], [20, -0.1], [20, height + 0.1]] as const) {
      const { x, y } = image.imagePixelToWorld(pixelX, pixelY);
      expect(grid.worldToGrid(x, y)).toBeNull();
      expect(image.worldToImagePixel(x, y).pixelX).toBeCloseTo(pixelX, 10);
      expect(image.worldToImagePixel(x, y).pixelY).toBeCloseTo(pixelY, 10);
    }
  });
});

describe('Locator image coordinate transforms', () => {
  it('transforms zero-yaw and negative MAP coordinates', () => {
    const transform = new LocatorCoordinateTransformer(map());
    expect(transform.worldToImagePixel(-4, -1)).toEqual({ pixelX: 20, pixelY: 160 });
  });

  it('inverts the browser image Y axis', () => {
    const transform = new LocatorCoordinateTransformer(map());
    expect(transform.worldToImagePixel(-5, -3).pixelY).toBe(200);
    expect(transform.worldToImagePixel(-5, -2).pixelY).toBe(180);
  });

  it('accounts for a rotated origin', () => {
    const transform = new LocatorCoordinateTransformer(map(Math.PI / 2));
    const pixel = transform.worldToImagePixel(-5, -2);
    expect(pixel.pixelX).toBeCloseTo(20);
    expect(pixel.pixelY).toBeCloseTo(200);
  });

  it('round-trips pixels through a rotated, negative origin', () => {
    const transform = new LocatorCoordinateTransformer(map(-0.72));
    const source = { x: -1.234, y: 2.345 };
    const pixel = transform.worldToImagePixel(source.x, source.y);
    const result = transform.imagePixelToWorld(pixel.pixelX, pixel.pixelY);
    expect(result.x).toBeCloseTo(source.x, 10);
    expect(result.y).toBeCloseTo(source.y, 10);
  });
});
