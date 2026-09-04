import type { LocatorRasterMap } from '../types';

/** Continuous MAP-coordinate ↔ browser image-pixel transform. */
export class LocatorCoordinateTransformer {
  public constructor(private readonly map: Pick<LocatorRasterMap, 'origin' | 'pixelHeight' | 'pixelsPerMeter' | 'metersPerPixel'>) {}

  public worldToImagePixel(xMap: number, yMap: number): { pixelX: number; pixelY: number } {
    const dx = xMap - this.map.origin.x;
    const dy = yMap - this.map.origin.y;
    const cosine = Math.cos(this.map.origin.yaw);
    const sine = Math.sin(this.map.origin.yaw);
    const localX = cosine * dx + sine * dy;
    const localY = -sine * dx + cosine * dy;
    return {
      pixelX: localX * this.map.pixelsPerMeter,
      pixelY: this.map.pixelHeight - localY * this.map.pixelsPerMeter,
    };
  }

  public imagePixelToWorld(pixelX: number, pixelY: number): { x: number; y: number } {
    const localX = pixelX * this.map.metersPerPixel;
    const localY = (this.map.pixelHeight - pixelY) * this.map.metersPerPixel;
    const cosine = Math.cos(this.map.origin.yaw);
    const sine = Math.sin(this.map.origin.yaw);
    return {
      x: this.map.origin.x + cosine * localX - sine * localY,
      y: this.map.origin.y + sine * localX + cosine * localY,
    };
  }
}

export const worldToImagePixel = (
  map: ConstructorParameters<typeof LocatorCoordinateTransformer>[0], xMap: number, yMap: number,
) => new LocatorCoordinateTransformer(map).worldToImagePixel(xMap, yMap);
export const imagePixelToWorld = (
  map: ConstructorParameters<typeof LocatorCoordinateTransformer>[0], pixelX: number, pixelY: number,
) => new LocatorCoordinateTransformer(map).imagePixelToWorld(pixelX, pixelY);
