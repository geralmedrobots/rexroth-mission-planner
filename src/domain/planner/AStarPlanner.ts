import type {
  GridCell, OccupancyGrid, PlannerOptions, PlannerResult, RobotFootprint,
} from '../types';
import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { isOccupiedValue } from './ObstacleInflation';
import { buildClearanceField } from './ClearanceField';
import { PathCollisionValidator } from './PathCollisionValidator';
import { normalizeAngle } from '../geometry/angles';
import { LogService } from '../../services/LogService';
import { CostModel } from '../planning/CostModel';

interface HeapNode { index: number; f: number }
class MinHeap {
  private values: HeapNode[] = [];
  public push(value: HeapNode): void {
    this.values.push(value); let i = this.values.length - 1;
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.values[p]!.f <= value.f) break;
      this.values[i] = this.values[p]!; i = p;
    }
    this.values[i] = value;
  }
  public pop(): HeapNode | undefined {
    const root = this.values[0]; const end = this.values.pop();
    if (!root || !end || this.values.length === 0) return root;
    let i = 0;
    while (true) {
      const l = i * 2 + 1; const r = l + 1;
      if (l >= this.values.length) break;
      const child = r < this.values.length && this.values[r]!.f < this.values[l]!.f ? r : l;
      if (this.values[child]!.f >= end.f) break;
      this.values[i] = this.values[child]!; i = child;
    }
    this.values[i] = end; return root;
  }
  public get size(): number { return this.values.length; }
}

const same = (a: GridCell, b: GridCell): boolean => a.row === b.row && a.column === b.column;
const moveLabel = (dr: number, dc: number): string => {
  if (dr === -1 && dc === 0) return 'N';
  if (dr === 1 && dc === 0) return 'S';
  if (dr === 0 && dc === -1) return 'W';
  if (dr === 0 && dc === 1) return 'E';
  if (dr === -1 && dc === -1) return 'NW';
  if (dr === -1 && dc === 1) return 'NE';
  if (dr === 1 && dc === -1) return 'SW';
  if (dr === 1 && dc === 1) return 'SE';
  return `${dr},${dc}`;
};
const movementDecision = (reverseLike: boolean, turnCost: number, reverseRiskCost: number): string => {
  if (reverseLike && reverseRiskCost > 0) return 'reverse';
  if (turnCost > 0.01) return 'rotate';
  return 'forward';
};

export class AStarPlanner {
  public plan(
    grid: OccupancyGrid,
    startInput: GridCell,
    goalInput: GridCell,
    options: PlannerOptions,
    footprint?:RobotFootprint,
    startTheta?:number,
  ): PlannerResult {
    const started = performance.now();
    const exploredCells:GridCell[]=[];
    const empty = (error: string): PlannerResult => ({
      success: false, error, rawPath: [], simplifiedPath: [], finalPath: [],
      exploredCells,
      statistics: { visitedCells: 0, durationMs: performance.now() - started, rawPointCount: 0, simplifiedPointCount: 0, finalPointCount: 0 },
    });
    const start = this.correctCell(grid, startInput, options.correctionRadiusCells);
    if (!start) return empty('Start pose is inside an obstacle and no nearby free cell exists.');
    const goal = this.correctCell(grid, goalInput, options.rejectGoalObstacleDepthCells);
    if (!goal) return empty('Goal is inside an obstacle or too far from reachable free space.');
    const reverseAllowed = Boolean(footprint?.allowReverse || footprint?.backwardAllowed);
    const noValidPathReason = reverseAllowed
      ? 'No collision-free path exists with the current footprint, clearance margins, and reverse-motion constraints.'
      : 'No collision-free path exists with the current footprint under forward-only motion constraints. Enable reverse motion or increase free-space clearance.';
    const { width, height, occupiedThreshold } = grid.metadata;
    const count = width * height; const g = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
    const came = new Int32Array(count).fill(-1); const direction = new Int8Array(count).fill(-1);
    const closed = new Uint8Array(count); const clearance = buildClearanceField(grid);
    const collision=new PathCollisionValidator();
    const transform=new CoordinateTransformer(grid.metadata);
    if(footprint){
      const startWorld=transform.gridToWorld(start.row,start.column);
      if(!collision.pointIsFree(grid,{
        ...startWorld,theta:startTheta??startWorld.theta,
      },footprint))return empty(
        'The complete robot footprint does not fit at the planning start pose.');
    }
    const idx = (cell: GridCell): number => cell.row * width + cell.column;
    const startIndex = idx(start); const goalIndex = idx(goal); g[startIndex] = 0;
    const open = new MinHeap(); open.push({
      index:startIndex,
      f:this.heuristic(start,goal,options,grid.metadata.resolution),
    });
    const moves = options.diagonalMovement
      ? [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]] as const
      : [[-1,0],[1,0],[0,-1],[0,1]] as const;
    let visited = 0;
    while (open.size > 0) {
      if (performance.now() - started > options.maxPlanningTimeMs) return empty('Planning timed out.');
      const current = open.pop()!; if (closed[current.index]) continue;
      closed[current.index] = 1; visited += 1;
      exploredCells.push({
        row:Math.floor(current.index/width),column:current.index%width,
      });
      if (current.index === goalIndex) {
        const cells = this.reconstruct(came, current.index, width);
        const transform = new CoordinateTransformer(grid.metadata);
        const rawPath = cells.map((cell, i) => {
          const world = transform.gridToWorld(cell.row, cell.column);
          const next = cells[Math.min(i + 1, cells.length - 1)]!;
          const nextWorld = transform.gridToWorld(next.row, next.column);
          return { ...world, theta: Math.atan2(nextWorld.y - world.y, nextWorld.x - world.x), ...cell };
        });
        return {
          success: true, rawPath, simplifiedPath: rawPath, finalPath: rawPath,
          correctedStart: same(start, startInput) ? undefined : start,
          correctedGoal: same(goal, goalInput) ? undefined : goal,
          exploredCells,
          statistics: { visitedCells: visited, durationMs: performance.now() - started, rawPointCount: rawPath.length, simplifiedPointCount: rawPath.length, finalPointCount: rawPath.length },
        };
      }
      const row = Math.floor(current.index / width); const col = current.index % width;
      const currentWorld = transform.gridToWorld(row, col);
      const previousDirection = direction[current.index]!;
      const previousMove = previousDirection >= 0 ? moves[previousDirection]! : null;
      const previousWorld = previousMove !== null
        ? transform.gridToWorld(row - previousMove[0], col - previousMove[1])
        : undefined;
      const currentHeading = previousMove !== null && previousWorld
        ? Math.atan2(currentWorld.y - previousWorld.y, currentWorld.x - previousWorld.x)
        : (startTheta ?? 0);
      for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
        const [dr, dc] = moves[moveIndex]!; const nr = row + dr; const nc = col + dc;
        if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
        const nextIndex = nr * width + nc;
        if (closed[nextIndex] || isOccupiedValue(grid.data[nextIndex] ?? 100, occupiedThreshold)) continue;
        if (dr !== 0 && dc !== 0) {
          const sideA = row * width + nc; const sideB = nr * width + col;
          if (isOccupiedValue(grid.data[sideA] ?? 100, occupiedThreshold) ||
              isOccupiedValue(grid.data[sideB] ?? 100, occupiedThreshold)) continue;
        }
        const currentWorld=transform.gridToWorld(row,col);
        const nextWorld=transform.gridToWorld(nr,nc);
        const moveHeading=Math.atan2(nextWorld.y-currentWorld.y,nextWorld.x-currentWorld.x);
        const reverseLike = Math.abs(normalizeAngle(moveHeading - currentHeading)) > Math.PI / 2;
        if (!reverseAllowed && reverseLike) continue;
        if(footprint&&!collision.pointIsFree(
          grid,{...nextWorld,theta:moveHeading},footprint))continue;
        const distanceCost = CostModel.distance(Math.hypot(dr, dc) * grid.metadata.resolution, options.distanceWeight);
        const cellClearance=clearance[nextIndex]!;
        const reliable=options.policy==='reliable'||options.reliableBaselineMode;
        const proximityCost = reliable ? 0 : CostModel.wallProximity(cellClearance, options);
        const narrowCost = reliable ? 0 : CostModel.narrowPassage(cellClearance, footprint?.width ?? 0,
          footprint?.safetyMargin ?? options.passageSafety.wallClearanceMinimumM, options);
        let turnCost=0;
        let reverseRiskCost=0;
        if(!reliable && previousMove !== null && previousDirection !== moveIndex){
          const previousHeading = Math.atan2(currentWorld.y - previousWorld!.y, currentWorld.x - previousWorld!.x);
          const headingChange = Math.abs(normalizeAngle(moveHeading - previousHeading));
          turnCost = CostModel.headingChange(headingChange, options) +
            CostModel.turnLocation(headingChange, cellClearance, options, grid.metadata.resolution);
          if (reverseLike || headingChange > Math.PI/2)
            reverseRiskCost = CostModel.reverseRisk(true, options);
        } else if (!reliable && previousMove === null && startTheta !== undefined) {
          const headingChange = Math.abs(normalizeAngle(moveHeading - startTheta));
          turnCost = CostModel.headingChange(headingChange, options);
          if (reverseLike || headingChange > Math.PI / 2)
            reverseRiskCost = CostModel.reverseRisk(true, options);
        }
        const tentative = g[current.index]! + distanceCost + proximityCost+
          narrowCost+turnCost+reverseRiskCost;
        const decision = movementDecision(reverseLike, turnCost, reverseRiskCost);
        LogService.write('planner','info',
          `A* candidate: from (${row},${col}) -> (${nr},${nc}) move=${moveLabel(dr,dc)} decision=${decision} ` +
          `distance=${distanceCost.toFixed(4)} proximity=${proximityCost.toFixed(4)} narrow=${narrowCost.toFixed(4)} ` +
          `turn=${turnCost.toFixed(4)} reverseRisk=${reverseRiskCost.toFixed(4)} total=${tentative.toFixed(4)} ` +
          `reverseLike=${reverseLike} clearance=${cellClearance.toFixed(4)} headingChange=${Math.abs(normalizeAngle(moveHeading-currentHeading)).toFixed(4)}`);
        if (tentative >= g[nextIndex]!) continue;
        came[nextIndex] = current.index; direction[nextIndex] = moveIndex; g[nextIndex] = tentative;
        open.push({
          index:nextIndex,
          f:tentative+this.heuristic(
            {row:nr,column:nc},goal,options,grid.metadata.resolution),
        });
      }
    }
    const result = empty(noValidPathReason);
    result.statistics.visitedCells = visited;
    return result;
  }

  private heuristic(
    a:GridCell,
    b:GridCell,
    options:PlannerOptions,
    resolution:number,
  ):number{
    const dx = Math.abs(a.column - b.column); const dy = Math.abs(a.row - b.row);
    const cells=options.heuristic === 'euclidean' ? Math.hypot(dx, dy) :
      Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    return cells*options.distanceWeight*resolution;
  }
  private correctCell(grid: OccupancyGrid, input: GridCell, radius: number): GridCell | null {
    const { width, height, occupiedThreshold } = grid.metadata;
    const free = (cell: GridCell): boolean => cell.row >= 0 && cell.column >= 0 && cell.row < height && cell.column < width &&
      !isOccupiedValue(grid.data[cell.row * width + cell.column] ?? 100, occupiedThreshold);
    if (free(input)) return input;
    for (let distance = 1; distance <= radius; distance += 1) {
      const candidates: GridCell[] = [];
      for (let dr = -distance; dr <= distance; dr += 1) {
        for (let dc = -distance; dc <= distance; dc += 1) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) === distance) candidates.push({ row: input.row + dr, column: input.column + dc });
        }
      }
      candidates.sort((a, b) => Math.hypot(a.row-input.row,a.column-input.column)-Math.hypot(b.row-input.row,b.column-input.column));
      const found = candidates.find(free); if (found) return found;
    }
    return null;
  }
  private reconstruct(came: Int32Array, goal: number, width: number): GridCell[] {
    const path: GridCell[] = []; let current = goal;
    while (current >= 0) { path.push({ row: Math.floor(current / width), column: current % width }); current = came[current]!; }
    return path.reverse();
  }
}
