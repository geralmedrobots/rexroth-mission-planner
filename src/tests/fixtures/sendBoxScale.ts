import { defaultFootprint, defaultPlannerOptions } from '../../domain/defaults';
import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import type { PlannerRequest } from '../../domain/planner/PlannerService';
import type { OccupancyGrid } from '../../domain/types';

/** Reproducible warehouse approximation, NOT a captured SendBox occupancy map. */
export const sendBoxScaleRequest = (kind: 'open' | 'clutter' | 'detour' = 'clutter'): PlannerRequest => {
  const width = 898; const height = 865;
  const grid: OccupancyGrid = { metadata: { name: `sendbox-scale-${kind}`,
    mapId: `sendbox-scale-${kind}`, width, height, resolution: .05,
    origin: { x: -20, y: -20, yaw: 0 }, occupiedThreshold: 65,
    freeThreshold: 25, negate: false }, data: Array(width * height).fill(0) };
  const block = (r0: number, r1: number, c0: number, c1: number, value = 100): void => {
    for (let row = r0; row <= r1; row += 1)
      grid.data.fill(value, row * width + c0, row * width + c1 + 1);
  };
  block(0, 3, 0, width - 1, -1); block(height - 4, height - 1, 0, width - 1, -1);
  block(0, height - 1, 0, 3, -1); block(0, height - 1, width - 4, width - 1, -1);
  for (let row = 40; row < 820; row += 70) for (let column = 40; column < 850; column += 65) {
    if (row >= 320 && row <= 530 && column >= 330 && column <= 525) continue;
    block(row, row + 35, column, column + 12);
  }
  if (kind === 'clutter') {
    block(410, 435, 437, 445);
    block(380, 400, 418, 422);
    block(438, 466, 477, 481);
  }
  if (kind === 'detour') block(375, 465, 437, 440);
  const transform = new CoordinateTransformer(grid.metadata);
  const start = { row: 450, column: 410 }; const goal = { row: 390, column: 470 };
  return { grid, start, goal, exactStartPose: { ...transform.gridToWorld(start.row, start.column), theta: 0 },
    exactGoalPose: { ...transform.gridToWorld(goal.row, goal.column), theta: 0 },
    startTheta: 0, goalTheta: 0, footprint: structuredClone(defaultFootprint),
    options: structuredClone(defaultPlannerOptions), plannerStrategy: 'motion-state' };
};
