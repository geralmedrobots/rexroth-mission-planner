import type { OccupancyGrid, PathPoint, PlannerOptions, RobotFootprint } from '../types';
import { normalizeAngle } from '../geometry/angles';
import { PathCollisionValidator } from './PathCollisionValidator';

export class PathSimplifier {
  private readonly collision = new PathCollisionValidator();

  public simplify(grid: OccupancyGrid, raw: PathPoint[], footprint: RobotFootprint, options: PlannerOptions, goalTheta: number): PathPoint[] {
    return this.simplifyDetailed(grid, raw, footprint, options, goalTheta).finalPath;
  }

  public simplifyDetailed(
    grid: OccupancyGrid,
    raw: PathPoint[],
    footprint: RobotFootprint,
    options: PlannerOptions,
    goalTheta: number,
    inflatedGrid: OccupancyGrid = grid,
  ): { simplifiedPath: PathPoint[]; finalPath: PathPoint[] } {
    if (raw.length < 2) return { simplifiedPath: raw, finalPath: raw };
    const lineOfSight = this.lineOfSight(grid, raw, footprint, options.collisionSampleInterval, inflatedGrid);
    const douglas = this.douglasPeucker(lineOfSight, options.simplificationTolerance);
    const safeGeometry = this.pathIsFree(grid, inflatedGrid, douglas, footprint, options)
      ? douglas : this.pathIsFree(grid, inflatedGrid, lineOfSight, footprint, options) ? lineOfSight : raw;
    const spaced = this.enforceSpacing(safeGeometry, options.minimumWaypointDistance, options.maximumWaypointDistance);
    const oriented = this.orient(spaced, goalTheta, options.finalOrientationEnforcement);
    if (this.pathIsFree(grid, inflatedGrid, oriented, footprint, options)) {
      return { simplifiedPath: safeGeometry, finalPath: oriented };
    }
    const safeOriented = this.orient(safeGeometry, goalTheta, options.finalOrientationEnforcement);
    if (this.pathIsFree(grid, inflatedGrid, safeOriented, footprint, options)) {
      return { simplifiedPath: safeGeometry, finalPath: safeOriented };
    }
    const rawOriented = this.orient(raw, goalTheta, options.finalOrientationEnforcement);
    return { simplifiedPath: raw, finalPath: rawOriented };
  }

  public lineOfSight(
    grid: OccupancyGrid,
    path: PathPoint[],
    footprint: RobotFootprint,
    interval: number,
    inflatedGrid: OccupancyGrid = grid,
  ): PathPoint[] {
    const output = [path[0]!]; let anchor = 0;
    while (anchor < path.length - 1) {
      let candidate = path.length - 1;
      while (candidate > anchor + 1 && !this.segmentIsFree(
        grid, inflatedGrid, path[anchor]!, path[candidate]!, footprint, interval,
      )) candidate -= 1;
      output.push(path[candidate]!); anchor = candidate;
    }
    return output;
  }

  public douglasPeucker(points: PathPoint[], tolerance: number): PathPoint[] {
    if (points.length <= 2) return points;
    const first = points[0]!; const last = points[points.length - 1]!;
    let maxDistance = 0; let split = 0;
    for (let i = 1; i < points.length - 1; i += 1) {
      const distance = this.perpendicularDistance(points[i]!, first, last);
      if (distance > maxDistance) { maxDistance = distance; split = i; }
    }
    if (maxDistance <= tolerance) return [first, last];
    return [...this.douglasPeucker(points.slice(0, split + 1), tolerance).slice(0, -1),
      ...this.douglasPeucker(points.slice(split), tolerance)];
  }

  public enforceSpacing(points: PathPoint[], minimum: number, maximum: number): PathPoint[] {
    if (points.length <= 1) return points;
    const filtered = [points[0]!];
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index]!;
      const previous=points[index-1]!;
      const next=points[index+1]!;
      const incoming=Math.atan2(point.y-previous.y,point.x-previous.x);
      const outgoing=Math.atan2(next.y-point.y,next.x-point.x);
      const headingChange=Math.abs(normalizeAngle(outgoing-incoming));
      const important=Boolean(point.passageId||point.orientationLocked||
        point.kind&&point.kind!=='normal')||headingChange>1e-3;
      if(important||Math.hypot(
        point.x-filtered[filtered.length-1]!.x,
        point.y-filtered[filtered.length-1]!.y,
      )>=minimum){
        filtered.push(point);
      }
    }
    filtered.push(points[points.length - 1]!);
    const result = [filtered[0]!];
    for (let i = 1; i < filtered.length; i += 1) {
      const from = result[result.length - 1]!; const to = filtered[i]!;
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const segments = Math.max(1, Math.ceil(distance / maximum));
      for (let j = 1; j <= segments; j += 1) {
        const t = j / segments; const candidate = { ...to, x: from.x + (to.x-from.x)*t, y: from.y + (to.y-from.y)*t };
        if (j === segments || Math.hypot(candidate.x-result[result.length-1]!.x,candidate.y-result[result.length-1]!.y) >= minimum) result.push(candidate);
      }
    }
    return result;
  }
  private orient(points: PathPoint[], goalTheta: number, enforceGoalTheta: boolean): PathPoint[] {
    return points.map((point, index) => {
      const next = points[index + 1];
      const previous = points[index - 1];
      const theta = next
        ? Math.atan2(next.y - point.y, next.x - point.x)
        : enforceGoalTheta ? goalTheta
          : previous ? Math.atan2(point.y - previous.y, point.x - previous.x) : point.theta;
      return { ...point, theta: normalizeAngle(theta) };
    });
  }
  private pathIsFree(
    grid: OccupancyGrid,
    inflatedGrid: OccupancyGrid,
    path: PathPoint[],
    footprint: RobotFootprint,
    options: PlannerOptions,
  ): boolean {
    return this.collision.pathIsFree(grid, path, footprint, options.collisionSampleInterval)&&
      (inflatedGrid===grid||this.collision.pathIsFree(
        inflatedGrid,path,this.pointFootprint(footprint),options.collisionSampleInterval));
  }
  private segmentIsFree(
    grid: OccupancyGrid,
    inflatedGrid: OccupancyGrid,
    start: PathPoint,
    end: PathPoint,
    footprint: RobotFootprint,
    interval: number,
  ): boolean {
    return this.collision.segmentIsFree(grid,start,end,footprint,interval)&&
      (inflatedGrid===grid||this.collision.segmentIsFree(
        inflatedGrid,start,end,this.pointFootprint(footprint),interval));
  }
  private pointFootprint(footprint:RobotFootprint):RobotFootprint{
    return {
      ...footprint,length:0,width:0,safetyMargin:0,
      centerOffsetX:0,centerOffsetY:0,inflationRadius:0,
    };
  }
  private perpendicularDistance(p: PathPoint, a: PathPoint, b: PathPoint): number {
    const length = Math.hypot(b.x-a.x,b.y-a.y); if (length === 0) return Math.hypot(p.x-a.x,p.y-a.y);
    return Math.abs((b.y-a.y)*p.x-(b.x-a.x)*p.y+b.x*a.y-b.y*a.x)/length;
  }
}
