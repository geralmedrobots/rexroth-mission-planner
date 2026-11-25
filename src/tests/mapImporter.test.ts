import { describe, expect, it } from 'vitest';
import { pixelsToOccupancy } from '../domain/map/MapImporter';
import type { MapMetadata } from '../domain/types';

const metadata: MapMetadata = {
  name: 'test', mapId: 'map', width: 3, height: 1, resolution: 0.05,
  origin: { x: 0, y: 0, yaw: 0 },
  occupiedThreshold: 0.65, freeThreshold: 0.196, negate: false,
};

describe('pixelsToOccupancy', () => {
  it('maps black, gray and white to a number array preserving unknown cells', () => {
    const occupancy = pixelsToOccupancy(new Uint8Array([0, 128, 255]), metadata);

    expect(Array.isArray(occupancy)).toBe(true);
    expect(occupancy).toEqual([100, -1, 0]);
  });

  it('preserves unknown cells when occupancy polarity is negated', () => {
    const occupancy = pixelsToOccupancy(new Uint8Array([0, 128, 255]),
      { ...metadata, negate: true });

    expect(occupancy).toEqual([0, -1, 100]);
  });
});
