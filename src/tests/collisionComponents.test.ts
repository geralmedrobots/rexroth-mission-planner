import { describe, expect, it } from 'vitest';
import { defaultFootprint } from '../domain/defaults';
import { FootprintModel } from '../domain/geometry/FootprintModel';
import { PoseCollisionChecker } from '../domain/planner/PoseCollisionChecker';
import { PathCollisionValidator } from '../domain/planner/PathCollisionValidator';
import { RotationSweepChecker } from '../domain/planner/RotationSweepChecker';
import { TranslationSweepChecker } from '../domain/planner/TranslationSweepChecker';
import type { OccupancyGrid, RobotFootprint } from '../domain/types';

const grid = (): OccupancyGrid => ({
  metadata: { name: 'components', mapId: 'components', width: 40, height: 40,
    resolution: .1, origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 65,
    freeThreshold: 20, negate: false }, data: new Array(1600).fill(0),
});
const footprint: RobotFootprint = { ...defaultFootprint, length: .2, width: .2,
  safetyMargin: 0, inflationRadius: 0 };

describe('Stage 3 collision components', () => {
  it('uses a Bosch polygon as the footprint model source', () => {
    const polygon = [{ x: -.4, y: .1 }, { x: .4, y: .1 }, { x: .1, y: -.1 }];
    const model = FootprintModel.from({ ...footprint, source: 'bosch-client-motion', polygon });
    expect(model.localPolygon()).toEqual(polygon);
    expect(model.polygonAt({ x: 2, y: 2, theta: 0 })).toEqual(polygon.map(({ x, y }) => ({ x: x + 2, y: y + 2 })));
  });

  it('keeps pose, translation, and rotation checks independently callable', () => {
    const map = grid();
    const pose = { x: 1, y: 1, theta: 0 };
    const poseChecker = new PoseCollisionChecker();
    const translation = new TranslationSweepChecker(poseChecker);
    const rotation = new RotationSweepChecker(poseChecker);
    expect(poseChecker.pointIsFree(map, pose, footprint)).toBe(true);
    expect(translation.segmentIsFree(map, pose, { x: 2, y: 1, theta: 0 }, footprint, .03)).toBe(true);
    expect(rotation.rotationIsFree(map, pose, 0, Math.PI / 2, footprint, Math.PI / 18)).toBe(true);
  });

  it('preserves the compatibility validator results through the extracted services', () => {
    const map = grid();
    map.data[20 * map.metadata.width + 20] = 100;
    const path = [{ x: 1, y: 2, theta: 0 }, { x: 3, y: 2, theta: 0 }];
    const pose = new PoseCollisionChecker();
    const translation = new TranslationSweepChecker(pose);
    const rotation = new RotationSweepChecker(pose);
    const legacy = new PathCollisionValidator();
    expect(legacy.inspectPose(map, path[0]!, footprint)).toEqual(pose.inspectPose(map, path[0]!, footprint));
    expect(legacy.pathIsFree(map, path, footprint, .03)).toBe(translation.pathIsFree(map, path, footprint, .03));
    expect(legacy.rotationIsFree(map, { x: 1, y: 2 }, 0, Math.PI / 2, footprint, .1))
      .toBe(rotation.rotationIsFree(map, { x: 1, y: 2 }, 0, Math.PI / 2, footprint, .1));
  });
});
