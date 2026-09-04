import { describe, expect, it } from 'vitest';
import { LocatorCoordinateTransformer } from '../features/locator/services/locatorCoordinateTransformer';

const map = (yaw = 0) => ({
  origin: { x: -5, y: -3, yaw },
  pixelHeight: 200,
  pixelsPerMeter: 20,
  metersPerPixel: 0.05,
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
