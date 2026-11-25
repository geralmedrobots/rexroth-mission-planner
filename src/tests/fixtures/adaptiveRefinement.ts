import { defaultFootprint, defaultPlannerOptions } from '../../domain/defaults';
import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import type { PlannerRequest } from '../../domain/planner/PlannerService';
import type { OccupancyGrid } from '../../domain/types';

export function openRefinementFixture(distanceM = 2): PlannerRequest {
  const request = refinementFixture();
  request.grid.metadata.width = Math.ceil((distanceM + 3) / request.grid.metadata.resolution);
  request.grid.data = Array(request.grid.metadata.width * request.grid.metadata.height).fill(0);
  request.exactGoalPose = { x: 1 + distanceM, y: 1.2, theta: 0 };
  request.goalTheta = 0;
  request.goal = new CoordinateTransformer(request.grid.metadata).worldToGrid(1 + distanceM, 1.2)!;
  return request;
}

export function refinementFixture(corridorWidth = .4, length = .4,
  robotWidth = .22, startOffset = 0, resolution = .1): PlannerRequest {
  const size = Math.round(4 / resolution);
  const grid: OccupancyGrid = {
    metadata: { name: 'adaptive-turn', mapId: 'adaptive-turn', width: size, height: size,
      resolution, origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 65,
      freeThreshold: 25, negate: false }, data: Array(size * size).fill(100),
  };
  const transform = new CoordinateTransformer(grid.metadata);
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    const { x, y } = transform.gridToWorld(row, column);
    if ((x > .5 && x < 3 && y > 1 && y < 1 + corridorWidth) ||
      (x > 3 - corridorWidth && x < 3 && y > 1 && y < 3.5))
      grid.data[row * size + column] = 0;
  }
  const start = { x: 1 + startOffset, y: 1 + corridorWidth / 2, theta: 0 };
  const goal = { x: 3 - corridorWidth / 2, y: 3, theta: Math.PI / 2 };
  return { grid, start: transform.worldToGrid(start.x, start.y)!,
    goal: transform.worldToGrid(goal.x, goal.y)!, exactStartPose: start,
    exactGoalPose: goal, startTheta: start.theta, goalTheta: goal.theta,
    plannerStrategy: 'motion-state',
    footprint: { ...structuredClone(defaultFootprint), length, width: robotWidth,
      centerOffsetX: 0, centerOffsetY: 0, safetyMargin: 0, inflationRadius: 0,
      polygon: undefined, backwardAllowed: false, allowReverse: false },
    options: { ...structuredClone(defaultPlannerOptions), maxPlanningTimeMs: 2000,
      passageSafety: { ...structuredClone(defaultPlannerOptions.passageSafety),
        planningSafetyMarginM: 0, localizationMarginM: 0, wallClearanceMinimumM: .1,
        wallProximityWeight: 0, narrowPassageWeight: 0, turnLocationWeight: 0 } },
  };
}
