import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { FootprintModel } from '../geometry/FootprintModel';
import type { OccupancyGrid, PathPoint, RobotFootprint } from '../types';
import { isOccupiedValue } from './ObstacleInflation';

export interface PoseCollisionDiagnostic {
  collision: boolean;
  collisionCell?: { row: number; column: number };
  footprintPolygon: Array<{ x: number; y: number }>;
}

/** Checks one complete robot pose against the occupancy grid. */
export class PoseCollisionChecker {
  public pointIsFree(grid: OccupancyGrid, point: PathPoint, footprint: RobotFootprint): boolean {
    return !this.inspectPose(grid, point, footprint).collision;
  }

  public inspectPose(grid: OccupancyGrid, point: PathPoint,
    footprint: RobotFootprint): PoseCollisionDiagnostic {
    const transform = new CoordinateTransformer(grid.metadata);
    const model = FootprintModel.from(footprint);
    const corners = model.polygonAt(point);
    if (corners.some((corner) => transform.worldToGrid(corner.x, corner.y) === null))
      return { collision: true, footprintPolygon: corners };
    const cells = corners.map((corner) => this.unboundedWorldToGrid(grid, corner.x, corner.y));
    const minRow = Math.max(0, Math.floor(Math.min(...cells.map((cell) => cell.row))));
    const maxRow = Math.min(grid.metadata.height - 1,
      Math.ceil(Math.max(...cells.map((cell) => cell.row))));
    const minColumn = Math.max(0, Math.floor(Math.min(...cells.map((cell) => cell.column))));
    const maxColumn = Math.min(grid.metadata.width - 1,
      Math.ceil(Math.max(...cells.map((cell) => cell.column))));
    for (let row = minRow; row <= maxRow; row += 1) for (let column = minColumn;
      column <= maxColumn; column += 1) {
      const index = row * grid.metadata.width + column;
      if (!isOccupiedValue(grid.data[index] ?? 100, grid.metadata.occupiedThreshold)) continue;
      const cellCentre = transform.gridToWorld(row, column);
      if (this.polygonsIntersect(corners, this.cellCorners(grid, cellCentre.x, cellCentre.y)))
        return { collision: true, collisionCell: { row, column }, footprintPolygon: corners };
    }
    return { collision: false, footprintPolygon: corners };
  }

  private unboundedWorldToGrid(grid: OccupancyGrid, x: number, y: number): { row: number; column: number } {
    const dx = x - grid.metadata.origin.x; const dy = y - grid.metadata.origin.y;
    const c = Math.cos(-grid.metadata.origin.yaw); const s = Math.sin(-grid.metadata.origin.yaw);
    return { column: (c * dx - s * dy) / grid.metadata.resolution - 0.5,
      row: grid.metadata.height - 0.5 - (s * dx + c * dy) / grid.metadata.resolution };
  }

  private cellCorners(grid: OccupancyGrid, x: number, y: number): Array<{ x: number; y: number }> {
    const half = grid.metadata.resolution / 2;
    const c = Math.cos(grid.metadata.origin.yaw); const s = Math.sin(grid.metadata.origin.yaw);
    return [[-half, -half], [half, -half], [half, half], [-half, half]].map(([lx, ly]) => ({
      x: x + c * lx! - s * ly!, y: y + s * lx! + c * ly!,
    }));
  }

  private polygonsIntersect(left: Array<{ x: number; y: number }>, right: Array<{ x: number; y: number }>): boolean {
    for (let a = 0; a < left.length; a += 1) for (let b = 0; b < right.length; b += 1)
      if (this.segmentsIntersect(left[a]!, left[(a + 1) % left.length]!,
        right[b]!, right[(b + 1) % right.length]!)) return true;
    return this.pointInPolygon(left[0]!, right) || this.pointInPolygon(right[0]!, left);
  }

  private segmentsIntersect(a: { x: number; y: number }, b: { x: number; y: number },
    c: { x: number; y: number }, d: { x: number; y: number }): boolean {
    const cross = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }): number =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const on = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }): boolean =>
      Math.abs(cross(p, q, r)) < 1e-10 && r.x >= Math.min(p.x, q.x) - 1e-10 &&
      r.x <= Math.max(p.x, q.x) + 1e-10 && r.y >= Math.min(p.y, q.y) - 1e-10 &&
      r.y <= Math.max(p.y, q.y) + 1e-10;
    const abC = cross(a, b, c); const abD = cross(a, b, d);
    const cdA = cross(c, d, a); const cdB = cross(c, d, b);
    return abC * abD < 0 && cdA * cdB < 0 || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
  }

  private pointInPolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>): boolean {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length;
      previous = index, index += 1) {
      const a = polygon[index]!; const b = polygon[previous]!;
      if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
}
