import type { OccupancyGrid, PathPoint, RobotFootprint } from '../types';
import { PoseCollisionChecker } from './PoseCollisionChecker';

/** Checks a swept in-place angular transition using the legacy shortest delta. */
export class RotationSweepChecker {
  public constructor(private readonly pose = new PoseCollisionChecker()) {}

  public rotationIsFree(grid: OccupancyGrid, point: Pick<PathPoint, 'x' | 'y'>,
    fromTheta: number, toTheta: number, footprint: RobotFootprint, sampleStepRad: number): boolean {
    const delta = ((toTheta - fromTheta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    if (Math.abs(delta) < 1e-9) return this.pose.pointIsFree(grid, { ...point, theta: fromTheta }, footprint);
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(sampleStepRad, Math.PI / 180)));
    for (let index = 0; index <= steps; index += 1)
      if (!this.pose.pointIsFree(grid, { ...point, theta: fromTheta + delta * index / steps }, footprint)) return false;
    return true;
  }
}
