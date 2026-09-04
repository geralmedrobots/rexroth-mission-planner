import { FootprintModel } from '../geometry/FootprintModel';
import type { OccupancyGrid, PathPoint, RobotFootprint } from '../types';
import { PoseCollisionChecker, type PoseCollisionDiagnostic } from './PoseCollisionChecker';
import {
  TranslationSweepChecker, type DetailedPathCollisionDiagnostic, type PathCollisionDiagnostic,
} from './TranslationSweepChecker';
import { RotationSweepChecker } from './RotationSweepChecker';

export type { DetailedPathCollisionDiagnostic, PathCollisionDiagnostic, PoseCollisionDiagnostic };

/** Compatibility facade for the pre-Stage-3 collision API. */
export class PathCollisionValidator {
  private readonly poseChecker = new PoseCollisionChecker();
  private readonly translationChecker = new TranslationSweepChecker(this.poseChecker);
  private readonly rotationChecker = new RotationSweepChecker(this.poseChecker);

  public pointIsFree(grid: OccupancyGrid, point: PathPoint, footprint: RobotFootprint): boolean {
    return this.poseChecker.pointIsFree(grid, point, footprint);
  }
  public inspectPose(grid: OccupancyGrid, point: PathPoint, footprint: RobotFootprint): PoseCollisionDiagnostic {
    return this.poseChecker.inspectPose(grid, point, footprint);
  }
  public footprintPolygonAt(point: Pick<PathPoint, 'x' | 'y' | 'theta'>,
    footprint: RobotFootprint): Array<{ x: number; y: number }> {
    return FootprintModel.from(footprint).polygonAt(point);
  }
  public segmentIsFree(grid: OccupancyGrid, a: PathPoint, b: PathPoint,
    footprint: RobotFootprint, interval: number): boolean {
    return this.translationChecker.segmentIsFree(grid, a, b, footprint, interval);
  }
  public pathIsFree(grid: OccupancyGrid, path: PathPoint[], footprint: RobotFootprint,
    interval: number): boolean {
    return this.translationChecker.pathIsFree(grid, path, footprint, interval);
  }
  public findFirstCollision(grid: OccupancyGrid, path: PathPoint[], footprint: RobotFootprint,
    interval: number): PathCollisionDiagnostic | null {
    return this.translationChecker.findFirstCollision(grid, path, footprint, interval);
  }
  public findFirstDetailedCollision(grid: OccupancyGrid, path: PathPoint[], footprint: RobotFootprint,
    interval: number): DetailedPathCollisionDiagnostic | null {
    return this.translationChecker.findFirstDetailedCollision(grid, path, footprint, interval);
  }
  public rotationIsFree(grid: OccupancyGrid, point: Pick<PathPoint, 'x' | 'y'>,
    fromTheta: number, toTheta: number, footprint: RobotFootprint, sampleStepRad: number): boolean {
    return this.rotationChecker.rotationIsFree(grid, point, fromTheta, toTheta, footprint, sampleStepRad);
  }
}
