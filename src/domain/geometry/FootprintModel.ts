import type { PathPoint, RobotFootprint } from '../types';

export type FootprintPoint = { x: number; y: number };

/** The single geometry representation used by collision checking. */
export class FootprintModel {
  public readonly footprint: RobotFootprint;

  public constructor(footprint: RobotFootprint) {
    this.footprint = footprint;
  }

  public static from(footprint: RobotFootprint): FootprintModel {
    return new FootprintModel(footprint);
  }

  /** Returns the configured Bosch polygon, or the legacy rectangle fallback. */
  public localPolygon(): FootprintPoint[] {
    const { footprint } = this;
    if (footprint.source === 'bosch-client-motion' && footprint.polygon?.length)
      return footprint.polygon.map((point) => ({ ...point }));
    return [
      { x: footprint.centerOffsetX - footprint.length / 2,
        y: footprint.centerOffsetY + footprint.width / 2 },
      { x: footprint.centerOffsetX + footprint.length / 2,
        y: footprint.centerOffsetY + footprint.width / 2 },
      { x: footprint.centerOffsetX + footprint.length / 2,
        y: footprint.centerOffsetY - footprint.width / 2 },
      { x: footprint.centerOffsetX - footprint.length / 2,
        y: footprint.centerOffsetY - footprint.width / 2 },
    ];
  }

  /** Applies the existing safety-margin expansion to the authoritative polygon. */
  public expandedLocalPolygon(): FootprintPoint[] {
    const base = this.localPolygon();
    const margin = Math.max(0, this.footprint.safetyMargin);
    if (margin <= 1e-9) return base;
    const samples: FootprintPoint[] = [];
    for (const vertex of base) for (let index = 0; index < 16; index += 1) {
      const angle = index * Math.PI * 2 / 16;
      samples.push({ x: vertex.x + Math.cos(angle) * margin,
        y: vertex.y + Math.sin(angle) * margin });
    }
    return this.convexHull(samples);
  }

  public polygonAt(point: Pick<PathPoint, 'x' | 'y' | 'theta'>): FootprintPoint[] {
    const c = Math.cos(point.theta); const s = Math.sin(point.theta);
    return this.expandedLocalPolygon().map(({ x, y }) => ({
      x: point.x + c * x - s * y, y: point.y + s * x + c * y,
    }));
  }

  private convexHull(points: FootprintPoint[]): FootprintPoint[] {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o: FootprintPoint, a: FootprintPoint, b: FootprintPoint): number =>
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: FootprintPoint[] = []; const upper: FootprintPoint[] = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0)
        lower.pop();
      lower.push(point);
    }
    for (const point of [...sorted].reverse()) {
      while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0)
        upper.pop();
      upper.push(point);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
  }
}
