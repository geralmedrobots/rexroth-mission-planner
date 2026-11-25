import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { buildMotionStateClearanceField } from '../planner/ClearanceField';
import { isOccupiedValue } from '../planner/ObstacleInflation';
import type { GridCell, OccupancyGrid, PathPoint, RobotFootprint } from '../types';
import { CostModel } from './CostModel';
import { motionPlannerFootprintHash, motionPlannerGridRevision } from './MotionPlannerCalibration';
import type { EffectiveMotionStateConfiguration } from './MotionStateConfiguration';

interface QueueItem { index: number; cost: number }

class MinHeap {
  private readonly items: QueueItem[] = [];
  public push(item: QueueItem): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent]!.cost <= item.cost) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = item;
  }
  public pop(): QueueItem | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || !this.items.length) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.items.length) break;
      const right = left + 1;
      const child = right < this.items.length && this.items[right]!.cost <
        this.items[left]!.cost ? right : left;
      if (this.items[child]!.cost >= last.cost) break;
      this.items[index] = this.items[child]!;
      index = child;
    }
    this.items[index] = last;
    return first;
  }
  public get size(): number { return this.items.length; }
}

const MOVES = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2], [1, 1, Math.SQRT2],
] as const;


export const MOTION_STATE_GUIDE_POLICY = Object.freeze({ targetResolutionM: .20, budgetMs: 150 });

interface StaticGuideData {
  coarse: OccupancyGrid;
  factor: number;
  clearance: Float32Array;
  coarseClearance: Float32Array;
  costPerM: Float64Array;
  goalFields: Map<number, Float64Array>;
}

export interface MotionStateGuideResult {
  points: PathPoint[];
  /** Original-map cells, including exact request cells for corridor construction. */
  cells: GridCell[];
  /** Always the original-resolution physical clearance field. */
  clearance: Float32Array;
  coarseGrid: OccupancyGrid;
  durationMs: number;
  preprocessingMs: number;
  searchMs: number;
  heuristicMs: number;
  expandedCells: number;
  heuristicExpandedCells: number;
  resolutionM: number;
  lengthM: number;
  cacheHit: boolean;
  heuristicCacheHit: boolean;
  status: 'found' | 'coarse-disconnected' | 'budget-exhausted';
  /** Advisory only: conservative coarsening is NOT an admissible SE(2) bound. */
  distanceToGoal: (cell: GridCell) => number;
}

/** Conservative coarse advisory A*, backed by goal-independent static data. */
export class MotionStateGuide {
  private static readonly cache = new Map<string, StaticGuideData>();

  public build(grid: OccupancyGrid, start: GridCell, goal: GridCell,
    footprint: RobotFootprint, configuration: EffectiveMotionStateConfiguration,
    policy: { targetResolutionM: number; budgetMs: number } = MOTION_STATE_GUIDE_POLICY,
  ): MotionStateGuideResult {
    const started = performance.now();
    const deadline = started + policy.budgetMs;
    const factor = Math.max(1, Math.ceil(policy.targetResolutionM / grid.metadata.resolution - 1e-9));
    // Goal is deliberately absent: a new destination must reuse static preprocessing.
    const key = [motionPlannerGridRevision(grid), motionPlannerFootprintHash(footprint),
      factor, JSON.stringify(configuration.clearance), JSON.stringify(configuration.weights),
      JSON.stringify(configuration.footprint), configuration.passage.maximumWidthM].join('|');
    let data = MotionStateGuide.cache.get(key);
    const cacheHit = data !== undefined;
    if (!data) {
      data = this.preprocess(grid, factor, configuration);
      MotionStateGuide.cache.set(key, data);
      if (MotionStateGuide.cache.size > 2)
        MotionStateGuide.cache.delete(MotionStateGuide.cache.keys().next().value!);
    }
    const preprocessingMs = performance.now() - started;
    const sourceCell = this.coarseCell(grid, data, start);
    const targetCell = this.coarseCell(grid, data, goal);
    const width = data.coarse.metadata.width;
    const sourceIndex = sourceCell.row * width + sourceCell.column;
    const targetIndex = targetCell.row * width + targetCell.column;
    const searchStarted = performance.now();
    const search = this.astar(data, sourceIndex, targetIndex, configuration, deadline);
    const searchMs = performance.now() - searchStarted;
    const heuristicStarted = performance.now();
    let field = data.goalFields.get(targetIndex);
    const heuristicCacheHit = field !== undefined;
    let heuristicExpandedCells = 0;
    if (!field && search.path.length && performance.now() < deadline) {
      const result = this.goalField(data, targetIndex, configuration, deadline);
      heuristicExpandedCells = result.expanded;
      // Never cache a partially settled field as a complete goal field.
      if (result.complete) {
        field = result.field;
        data.goalFields.set(targetIndex, field);
        if (data.goalFields.size > 2) data.goalFields.delete(data.goalFields.keys().next().value!);
      }
    }
    const heuristicMs = performance.now() - heuristicStarted;
    const coarseTransform = new CoordinateTransformer(data.coarse.metadata);
    const transform = new CoordinateTransformer(grid.metadata);
    const points = search.path.map((index) => coarseTransform.gridToWorld(
      Math.floor(index / width), index % width));
    const cells = points.flatMap((point) => {
      const cell = transform.worldToGrid(point.x, point.y);
      return cell ? [cell] : [];
    });
    if (cells.length) { cells.unshift(start); cells.push(goal); }
    const lengthM = points.slice(1).reduce((total, point, index) => total +
      Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0);
    const staticData = data;
    return { points, cells, clearance: data.clearance, coarseGrid: data.coarse,
      durationMs: performance.now() - started, preprocessingMs, searchMs, heuristicMs,
      expandedCells: search.expanded, heuristicExpandedCells,
      resolutionM: data.coarse.metadata.resolution, lengthM, cacheHit, heuristicCacheHit,
      status: search.path.length ? 'found' : search.timedOut ? 'budget-exhausted' : 'coarse-disconnected',
      distanceToGoal: (cell) => {
        const coarse = this.coarseCell(grid, staticData, cell);
        const value = field?.[coarse.row * width + coarse.column];
        return value ?? Infinity;
      },
    };
  }

  public corridorMask(grid: OccupancyGrid, cells: readonly GridCell[], widthM: number): Uint8Array {
    const mask = new Uint8Array(grid.metadata.width * grid.metadata.height);
    const radius = Math.max(1, Math.ceil(widthM / grid.metadata.resolution));
    const radiusSquared = radius * radius;
    // Fill around every cell crossed by coarse segments, not just coarse centres.
    const mark = (cell: GridCell): void => {
      for (let dr = -radius; dr <= radius; dr += 1) {
        const row = cell.row + dr;
        if (row < 0 || row >= grid.metadata.height) continue;
        const horizontal = Math.floor(Math.sqrt(radiusSquared - dr * dr));
        mask.fill(1, row * grid.metadata.width + Math.max(0, cell.column - horizontal),
          row * grid.metadata.width + Math.min(grid.metadata.width - 1, cell.column + horizontal) + 1);
      }
    };
    cells.forEach((cell, index) => {
      const previous = cells[index - 1] ?? cell;
      const steps = Math.max(1, Math.max(Math.abs(previous.row - cell.row),
        Math.abs(previous.column - cell.column)));
      for (let sample = 1; sample <= steps; sample += 1) mark({
        row: Math.round(previous.row + (cell.row - previous.row) * sample / steps),
        column: Math.round(previous.column + (cell.column - previous.column) * sample / steps),
      });
    });
    return mask;
  }

  private coarseCell(grid: OccupancyGrid, data: StaticGuideData, cell: GridCell): GridCell {
    return { column: Math.floor(cell.column / data.factor),
      row: data.coarse.metadata.height - 1 - Math.floor((grid.metadata.height - 1 - cell.row) / data.factor) };
  }

  private preprocess(grid: OccupancyGrid, factor: number,
    configuration: EffectiveMotionStateConfiguration): StaticGuideData {
    const clearance = buildMotionStateClearanceField(grid);
    const width = Math.ceil(grid.metadata.width / factor);
    const height = Math.ceil(grid.metadata.height / factor);
    const coarse: OccupancyGrid = { metadata: { ...grid.metadata, width, height,
      resolution: grid.metadata.resolution * factor },
    data: Array(width * height).fill(0) };
    const coarseClearance = new Float32Array(width * height).fill(Infinity);
    const costPerM = new Float64Array(width * height);
    // Anchor blocks at the original map origin (bottom left), including rotated
    // origins and dimensions not divisible by factor. Padded cells are blocked.
    for (let row = 0; row < height; row += 1) for (let col = 0; col < width; col += 1) {
      const index = row * width + col;
      for (let dy = 0; dy < factor; dy += 1) for (let dx = 0; dx < factor; dx += 1) {
        const fineRow = grid.metadata.height - 1 - ((height - 1 - row) * factor + dy);
        const fineColumn = col * factor + dx;
        if (fineRow < 0 || fineColumn >= grid.metadata.width) {
          coarse.data[index] = -1; coarseClearance[index] = 0; continue;
        }
        const fineIndex = fineRow * grid.metadata.width + fineColumn;
        const value = grid.data[fineIndex] ?? -1;
        if (isOccupiedValue(value, grid.metadata.occupiedThreshold))
          coarse.data[index] = value < 0 ? -1 : grid.metadata.occupiedThreshold;
        coarseClearance[index] = Math.min(coarseClearance[index]!, clearance[fineIndex]!);
      }
      const distance = coarseClearance[index]!;
      costPerM[index] = configuration.weights.translationCostPerM +
        CostModel.motionStateWallProximity(distance, configuration.clearance.preferredM,
          1, configuration.weights.wallClearanceCost) +
        CostModel.motionStateNarrowPassage(distance, configuration.footprint.widthM,
          configuration.footprint.effectiveSafetyMarginM, configuration.passage.maximumWidthM,
          1, configuration.weights.narrowPassageCost);
    }
    return { coarse, factor, clearance, coarseClearance, costPerM, goalFields: new Map() };
  }

  private passable(data: StaticGuideData, index: number,
    configuration: EffectiveMotionStateConfiguration): boolean {
    return !isOccupiedValue(data.coarse.data[index] ?? -1, data.coarse.metadata.occupiedThreshold) &&
      data.coarseClearance[index]! + 1e-9 >= configuration.clearance.hardMinimumM;
  }

  private neighbours(data: StaticGuideData, index: number,
    configuration: EffectiveMotionStateConfiguration): Array<[number, number]> {
    const { width, height, resolution } = data.coarse.metadata;
    const row = Math.floor(index / width); const column = index % width;
    const result: Array<[number, number]> = [];
    for (const [dr, dc, scale] of MOVES) {
      const r = row + dr; const c = column + dc;
      if (r < 0 || c < 0 || r >= height || c >= width) continue;
      const next = r * width + c;
      if (!this.passable(data, next, configuration)) continue;
      if (dr && dc && (!this.passable(data, row * width + c, configuration) ||
        !this.passable(data, r * width + column, configuration))) continue;
      result.push([next, scale * resolution]);
    }
    return result;
  }

  private astar(data: StaticGuideData, start: number, goal: number,
    configuration: EffectiveMotionStateConfiguration, deadline: number):
    { path: number[]; expanded: number; timedOut: boolean } {
    const empty = { path: [], expanded: 0, timedOut: performance.now() >= deadline };
    if (empty.timedOut || !this.passable(data, start, configuration) ||
      !this.passable(data, goal, configuration)) return empty;
    const { width, resolution } = data.coarse.metadata;
    const h = (index: number): number => Math.hypot(
      Math.floor(index / width) - Math.floor(goal / width), index % width - goal % width) *
      resolution * configuration.weights.translationCostPerM;
    const costs = new Float64Array(data.coarse.data.length).fill(Infinity);
    const parent = new Int32Array(costs.length).fill(-1);
    const open = new MinHeap();
    costs[start] = 0; open.push({ index: start, cost: h(start) });
    let expanded = 0;
    while (open.size) {
      if (expanded % 128 === 0 && performance.now() >= deadline)
        return { path: [], expanded, timedOut: true };
      const node = open.pop()!;
      if (node.cost > costs[node.index]! + h(node.index) + 1e-9) continue;
      expanded += 1;
      if (node.index === goal) {
        const path: number[] = [];
        for (let i = goal; i !== -1; i = parent[i]!) path.push(i);
        return { path: path.reverse(), expanded, timedOut: false };
      }
      for (const [next, length] of this.neighbours(data, node.index, configuration)) {
        const cost = costs[node.index]! + length * data.costPerM[next]!;
        if (cost + 1e-9 >= costs[next]!) continue;
        costs[next] = cost; parent[next] = node.index;
        open.push({ index: next, cost: cost + h(next) });
      }
    }
    return { path: [], expanded, timedOut: false };
  }

  private goalField(data: StaticGuideData, goal: number,
    configuration: EffectiveMotionStateConfiguration, deadline: number):
    { field: Float64Array; expanded: number; complete: boolean } {
    const field = new Float64Array(data.coarse.data.length).fill(Infinity);
    const open = new MinHeap(); field[goal] = 0; open.push({ index: goal, cost: 0 });
    let expanded = 0;
    while (open.size) {
      if (expanded % 128 === 0 && performance.now() >= deadline) return { field, expanded, complete: false };
      const current = open.pop()!;
      if (current.cost !== field[current.index]) continue;
      expanded += 1;
      for (const [next, length] of this.neighbours(data, current.index, configuration)) {
        // Reuse the clearance-aware guide metric to bias the SE(2) frontier
        // toward open corridors; physical transition costs remain authoritative.
        const cost = current.cost + length * data.costPerM[current.index]! /
          Math.max(configuration.weights.translationCostPerM, 1e-12);
        if (cost + 1e-9 >= field[next]!) continue;
        field[next] = cost; open.push({ index: next, cost });
      }
    }
    return { field, expanded, complete: true };
  }
}
