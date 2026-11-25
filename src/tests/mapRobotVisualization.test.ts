import { describe, expect, it } from 'vitest';
import {
  analyzeLiveRobotMapConversion,
  formatLivePoseMapCheck,
  getLiveRobotVisualization,
} from '../components/mapRobotVisualization';
import type { OccupancyGrid, RobotPose } from '../domain/types';

const grid:OccupancyGrid = {
  metadata: {
    name: 'test-map',
    mapId: 'test-map',
    width: 10,
    height: 10,
    resolution: 0.5,
    origin: { x: 0, y: 0, yaw: 0 },
    occupiedThreshold: 65,
    freeThreshold: 25,
    negate: false,
  },
  data: Array.from({ length: 100 }, () => 0),
};

const livePose:RobotPose = {
  x: 1.25,
  y: 1.25,
  theta: 0,
  mapId: 'test-map',
  positionInitialized: false,
};

describe('live robot map visualization', () => {
  it('marks a valid live pose as visible even when localization is not initialized', () => {
    expect(getLiveRobotVisualization(grid, livePose)).toEqual({
      status: 'visible',
      label: 'Robot pose live',
      cell: { row: 7, column: 2 },
    });
  });

  it('shows an explicit diagnostic when the live pose is missing', () => {
    expect(getLiveRobotVisualization(grid, undefined)).toEqual({
      status: 'unavailable',
      label: 'Pose unavailable',
    });
  });

  it('shows an explicit diagnostic when the live pose is outside the loaded map', () => {
    expect(getLiveRobotVisualization(grid, { ...livePose, x: 99 })).toEqual({
      status: 'outside-map',
      label: 'Robot pose outside loaded map',
    });
  });

  it('reports raw grid coordinates and world bounds for an out-of-map live pose', () => {
    const diagnostic = analyzeLiveRobotMapConversion(grid, { ...livePose, x: 99 });

    expect(diagnostic).toMatchObject({
      status: 'outside-map',
      rawCell: { row: 7, column: 198 },
      inBounds: false,
      worldBounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 },
    });
    expect(formatLivePoseMapCheck(diagnostic)).toContain('[live-pose-map-check]');
    expect(formatLivePoseMapCheck(diagnostic)).toContain('worldBounds=x[0.000,5.000] y[0.000,5.000]');
  });

  it('uses only the live pose, so a planning start is not required to show the robot', () => {
    const planningStart:RobotPose | undefined = undefined;

    expect(planningStart).toBeUndefined();
    expect(getLiveRobotVisualization(grid, livePose).status).toBe('visible');
  });
});
