import { CoordinateTransformer } from '../../../domain/geometry/CoordinateTransformer';
import { FootprintModel } from '../../../domain/geometry/FootprintModel';
import { PathCollisionValidator } from '../../../domain/planner/PathCollisionValidator';
import { PoseCollisionChecker } from '../../../domain/planner/PoseCollisionChecker';
import { isOccupiedValue } from '../../../domain/planner/ObstacleInflation';
import { createPlanningConfigurationSnapshot } from '../../../domain/planning/PlanningConfigurationSnapshot';
import { PlanningCoordinator, type PlanningInputs } from '../../planning/PlanningCoordinator';
import type { GridCell, OccupancyGrid, PathPoint, PlannerResult, RobotFootprint } from '../../../domain/types';

export type ObstacleClass = 'occupied' | 'unknown' | 'inflated' | 'free' | 'outside';
export interface CollisionEvidence {
  source: 'planner-stage' | 'endpoint-replay' | 'rejected-path-replay' | 'selected-footprint';
  reason: string;
  cell?: GridCell;
  obstacle: ObstacleClass;
  polygon?: Array<{ x: number; y: number }>;
  pose?: PathPoint;
}
export function classifyObstacle(grid: OccupancyGrid, cell?: GridCell, inflated?: OccupancyGrid): ObstacleClass {
  if (!cell || cell.row < 0 || cell.column < 0 || cell.row >= grid.metadata.height || cell.column >= grid.metadata.width) return 'outside';
  const i = cell.row * grid.metadata.width + cell.column;
  const value = grid.data[i] ?? -1;
  if (value < 0) return 'unknown';
  if (value >= grid.metadata.occupiedThreshold) return 'occupied';
  if (inflated && isOccupiedValue(inflated.data[i] ?? -1, inflated.metadata.occupiedThreshold)) return 'inflated';
  return 'free';
}

export function effectiveDiagnosticFootprint(inputs: Pick<PlanningInputs, 'plannerOptions' | 'footprint' | 'orderSettings'>): RobotFootprint {
  const configuration = createPlanningConfigurationSnapshot(inputs);
  return { ...(structuredClone(configuration.footprint) as RobotFootprint),
    safetyMargin: configuration.normalized.motionState.footprint.effectiveSafetyMarginM };
}

interface RayHit { distance: number; cell: GridCell; point: { x: number; y: number }; obstacle: ObstacleClass }
/** Exact cell-edge traversal for measurement only. Does not alter planner sampling. */
function boundaryRay(grid: OccupancyGrid, origin: { x: number; y: number }, direction: { x: number; y: number }): RayHit | undefined {
  const m = grid.metadata; const c = Math.cos(m.origin.yaw); const s = Math.sin(m.origin.yaw);
  const dx = origin.x - m.origin.x; const dy = origin.y - m.origin.y;
  const x = c * dx + s * dy; const y = -s * dx + c * dy;
  const vx = c * direction.x + s * direction.y; const vy = -s * direction.x + c * direction.y;
  let column = Math.floor(x / m.resolution); let bottom = Math.floor(y / m.resolution); let distance = 0;
  const sx = Math.sign(vx); const sy = Math.sign(vy);
  const txStep = Math.abs(vx) > 1e-12 ? m.resolution / Math.abs(vx) : Infinity;
  const tyStep = Math.abs(vy) > 1e-12 ? m.resolution / Math.abs(vy) : Infinity;
  let tx = Math.abs(vx) > 1e-12 ? ((column + (sx > 0 ? 1 : 0)) * m.resolution - x) / vx : Infinity;
  let ty = Math.abs(vy) > 1e-12 ? ((bottom + (sy > 0 ? 1 : 0)) * m.resolution - y) / vy : Infinity;
  for (let steps = 0; steps <= m.width + m.height; steps++) {
    const cell = { row: m.height - 1 - bottom, column };
    const obstacle = classifyObstacle(grid, cell);
    if (obstacle === 'outside') return undefined; // The image edge is not evidence of a wall.
    if (obstacle !== 'free') return { distance, cell, obstacle,
      point: { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance } };
    const next = Math.min(tx, ty);
    if (tx <= next) { column += sx; tx += txStep; }
    if (ty <= next) { bottom += sy; ty += tyStep; }
    distance = next;
  }
  return undefined;
}

export function measureDoorway(grid: OccupancyGrid, a: PathPoint, b: PathPoint, footprint: RobotFootprint) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < grid.metadata.resolution / 10) return undefined;
  const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  const transform = new CoordinateTransformer(grid.metadata);
  let narrowest: { widthM: number; centre: { x: number; y: number }; left: RayHit; right: RayHit } | undefined;
  const count = Math.ceil(length / (grid.metadata.resolution / 2));
  let blockedCentreSamples = 0;
  for (let i = 0; i <= count; i++) {
    const centre = { x: a.x + (b.x - a.x) * i / count, y: a.y + (b.y - a.y) * i / count };
    if (classifyObstacle(grid, transform.worldToGrid(centre.x, centre.y) ?? undefined) !== 'free') { blockedCentreSamples++; continue; }
    const left = boundaryRay(grid, centre, normal);
    const right = boundaryRay(grid, centre, { x: -normal.x, y: -normal.y });
    if (!left || !right) continue;
    const widthM = left.distance + right.distance;
    if (!narrowest || widthM < narrowest.widthM) narrowest = { widthM, centre, left, right };
  }
  if (!narrowest) return undefined;
  const polygon = FootprintModel.from({ ...footprint, safetyMargin: 0 }).polygonAt(a);
  const projections = polygon.map(p => p.x * normal.x + p.y * normal.y);
  const projectedWidthM = Math.max(...projections) - Math.min(...projections);
  return { ...narrowest, projectedWidthM, remainingWidthM: narrowest.widthM - projectedWidthM - 2 * footprint.safetyMargin,
    blockedCentreSamples, resolutionM: grid.metadata.resolution };
}

export function inspectDiagnosticPose(grid: OccupancyGrid, pose: PathPoint, footprint: RobotFootprint): CollisionEvidence {
  const inspection = new PoseCollisionChecker().inspectPose(grid, pose, footprint);
  return { source: 'selected-footprint', reason: inspection.collision ? 'Full footprint collision' : 'Full footprint is free',
    cell: inspection.collisionCell, obstacle: inspection.collision ? classifyObstacle(grid, inspection.collisionCell) : 'free',
    polygon: inspection.footprintPolygon, pose };
}

/** Only evidence with exact poses/cells is used. Search state keys are not
 * reconstructed: refined motion-state keys do not retain exact world poses. */
export function rejectionEvidence(grid: OccupancyGrid, result: PlannerResult, inputs: PlanningInputs): CollisionEvidence[] {
  const footprint = effectiveDiagnosticFootprint(inputs);
  const evidence: CollisionEvidence[] = [];
  for (const stage of result.diagnostics?.stages ?? []) {
    if (stage.success || !stage.collisionCell) continue;
    evidence.push({ source: 'planner-stage', reason: stage.reason ?? stage.code ?? stage.stage,
      cell: stage.collisionCell, obstacle: classifyObstacle(grid, stage.collisionCell), polygon: stage.footprintPolygon });
  }
  if (!result.success && ['START_NOT_FREE', 'GOAL_NOT_FREE'].includes(result.diagnostics?.physicalFailureCode ?? '')) {
    const pose = result.diagnostics?.physicalFailureCode === 'START_NOT_FREE' ? inputs.start : inputs.goal;
    const inspected = inspectDiagnosticPose(grid, pose, footprint);
    if (inspected.obstacle !== 'free') evidence.push({ ...inspected, source: 'endpoint-replay', reason: result.error ?? inspected.reason });
  }
  const rejected = result.rejectedEnhancementPath;
  if (inputs.plannerMode !== 'motion-state' && rejected && rejected.length >= 2) {
    const collision = new PathCollisionValidator().findFirstDetailedCollision(grid, rejected, footprint, inputs.plannerOptions.collisionSampleInterval);
    if (collision) evidence.push({ source: 'rejected-path-replay', reason: 'First full-footprint collision replayed on rejected enhancement path',
      cell: collision.collisionCell, obstacle: classifyObstacle(grid, collision.collisionCell), polygon: collision.footprintPolygon, pose: collision.pose });
  }
  return evidence;
}

export function precisePlannerOutcome(result: PlannerResult): string {
  const failed = [...(result.diagnostics?.stages ?? [])].reverse().find(stage => !stage.success);
  const code = result.diagnostics?.physicalFailureCode ?? failed?.code;
  if (result.success) return 'Planner succeeded with the captured settings.';
  const detail = `${code ?? 'PLANNING_FAILED'}: ${result.error ?? failed?.reason ?? 'Planner returned no explanation.'}`;
  return /timeout|time limit|time budget/i.test(`${code} ${result.error}`)
    ? `${detail} Search exhausted its time budget; a specific blocking cell or physical impossibility is not established.` : detail;
}

/** Same request preparation as the application, without observers, recording,
 * route commits, mission state, MQTT or order publication. */
export function prepareClearanceRequest(inputs: PlanningInputs) {
  if (inputs.plannerMode === 'manual') throw new Error('Manual mode has no search planner. Select an automatic planner in the main settings first.');
  return new PlanningCoordinator().prepareRequests({ ...inputs, waypoints: [] })[0]!;
}
