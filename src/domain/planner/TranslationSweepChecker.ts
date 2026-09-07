import type { OccupancyGrid, PathPoint, RobotFootprint } from '../types';
import { PoseCollisionChecker, type PoseCollisionDiagnostic } from './PoseCollisionChecker';

export interface PathCollisionDiagnostic {
  segmentIndex: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
}
export interface DetailedPathCollisionDiagnostic extends PathCollisionDiagnostic {
  pose: PathPoint;
  collisionCell?: { row: number; column: number };
  footprintPolygon: Array<{ x: number; y: number }>;
}

/** Checks sampled XY translation, preserving the legacy segment heading rule. */
export class TranslationSweepChecker {
  public constructor(private readonly pose = new PoseCollisionChecker()) {}

  public segmentIsFree(grid: OccupancyGrid, a: PathPoint, b: PathPoint,
    footprint: RobotFootprint, interval: number): boolean {
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(interval, grid.metadata.resolution / 3)));
    const theta = Math.atan2(b.y - a.y, b.x - a.x);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      if (!this.pose.pointIsFree(grid, { x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t, theta }, footprint)) return false;
    }
    return true;
  }

  /** Motion-state variant: translation direction is physical motion, while
   * body orientation remains the explicit state heading. */
  public segmentIsFreeAtHeading(grid: OccupancyGrid, a: PathPoint, b: PathPoint,
    footprint: RobotFootprint, interval: number, bodyTheta: number): boolean {
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(interval, grid.metadata.resolution / 3)));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      if (!this.pose.pointIsFree(grid, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, theta: bodyTheta }, footprint)) return false;
    }
    return true;
  }

  public pathIsFree(grid: OccupancyGrid, path: PathPoint[], footprint: RobotFootprint, interval: number): boolean {
    return path.length >= 2 && path.slice(1).every((point, index) =>
      this.segmentIsFree(grid, path[index]!, point, footprint, interval));
  }

  public findFirstCollision(grid: OccupancyGrid, path: PathPoint[], footprint: RobotFootprint,
    interval: number): PathCollisionDiagnostic | null {
    for (let segmentIndex = 0; segmentIndex < path.length - 1; segmentIndex += 1) {
      const start = path[segmentIndex]!; const end = path[segmentIndex + 1]!;
      if (!this.segmentIsFree(grid, start, end, footprint, interval))
        return { segmentIndex, start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
    }
    return null;
  }

  public findFirstDetailedCollision(grid: OccupancyGrid, path: PathPoint[], footprint: RobotFootprint,
    interval: number): DetailedPathCollisionDiagnostic | null {
    for (let segmentIndex = 0; segmentIndex < path.length - 1; segmentIndex += 1) {
      const start = path[segmentIndex]!; const end = path[segmentIndex + 1]!;
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      const steps = Math.max(1, Math.ceil(distance / Math.max(interval, grid.metadata.resolution / 3)));
      const theta = Math.atan2(end.y - start.y, end.x - start.x);
      for (let sample = 0; sample <= steps; sample += 1) {
        const ratio = sample / steps;
        const pose: PathPoint = { x: start.x + (end.x - start.x) * ratio,
          y: start.y + (end.y - start.y) * ratio, theta };
        const inspected: PoseCollisionDiagnostic = this.pose.inspectPose(grid, pose, footprint);
        if (inspected.collision) return { segmentIndex,
          start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y }, pose,
          collisionCell: inspected.collisionCell, footprintPolygon: inspected.footprintPolygon };
      }
    }
    return null;
  }
}
