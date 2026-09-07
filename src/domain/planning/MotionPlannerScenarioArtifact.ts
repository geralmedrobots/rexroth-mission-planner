import type { OccupancyGrid, PathPoint, RobotFootprint } from '../types';
import { motionPlannerGridRevision, motionPlannerFootprintHash,
  type MotionPlannerCalibrationSnapshot } from './MotionPlannerCalibration';
import type { MotionPlannerCalibrationProfileName } from './MotionPlannerCalibrationProfiles';
import { replayMotionPlannerScenario, type MotionPlannerReplayResult } from './MotionPlannerReplay';
import type { PlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';

/** Full-grid debug artifact. It is never included in routine diagnostic events. */
export interface MotionPlannerScenarioArtifact {
  readonly schemaVersion: 'motion-planner-scenario-v1';
  readonly mapRevision: string;
  readonly footprintGeometryHash: string;
  readonly selectedProfile: MotionPlannerCalibrationProfileName | 'PRODUCTION_BASELINE' | 'CUSTOM';
  readonly grid: OccupancyGrid;
  readonly footprint: RobotFootprint;
  readonly startPose: PathPoint;
  readonly goalPose: PathPoint;
  readonly goalTheta?: number;
  readonly configuration: PlanningConfigurationSnapshot;
  readonly originalCalibration?: MotionPlannerCalibrationSnapshot;
}

export interface MotionPlannerScenarioArtifactInput {
  grid: OccupancyGrid;
  footprint: RobotFootprint;
  startPose: PathPoint;
  goalPose: PathPoint;
  goalTheta?: number;
  configuration: PlanningConfigurationSnapshot;
  selectedProfile?: MotionPlannerScenarioArtifact['selectedProfile'];
  originalCalibration?: MotionPlannerCalibrationSnapshot;
}

export const createMotionPlannerScenarioArtifact = (
  input: MotionPlannerScenarioArtifactInput,
): MotionPlannerScenarioArtifact => structuredClone({
  schemaVersion: 'motion-planner-scenario-v1',
  mapRevision: motionPlannerGridRevision(input.grid),
  footprintGeometryHash: motionPlannerFootprintHash(input.footprint),
  selectedProfile: input.selectedProfile ?? 'PRODUCTION_BASELINE',
  grid: input.grid, footprint: input.footprint,
  startPose: input.startPose, goalPose: input.goalPose,
  ...(input.goalTheta === undefined ? {} : { goalTheta: input.goalTheta }),
  configuration: input.configuration,
  ...(input.originalCalibration ? { originalCalibration: input.originalCalibration } : {}),
});

export const replayMotionPlannerScenarioArtifact = (
  artifact: MotionPlannerScenarioArtifact,
): MotionPlannerReplayResult => {
  if (motionPlannerGridRevision(artifact.grid) !== artifact.mapRevision) {
    throw new Error('Calibration artifact grid does not match its captured revision.');
  }
  if (motionPlannerFootprintHash(artifact.footprint) !== artifact.footprintGeometryHash) {
    throw new Error('Calibration artifact footprint does not match its captured hash.');
  }
  return replayMotionPlannerScenario({
    grid: artifact.grid, footprint: artifact.footprint,
    startPose: artifact.startPose, goalPose: artifact.goalPose,
    goalTheta: artifact.goalTheta, configuration: artifact.configuration,
    profileName: artifact.selectedProfile,
  });
};

export const serializeMotionPlannerScenarioArtifact = (
  artifact: MotionPlannerScenarioArtifact,
): string => JSON.stringify(artifact, null, 2);

export const parseMotionPlannerScenarioArtifact = (
  text: string,
): MotionPlannerScenarioArtifact => {
  const parsed = JSON.parse(text) as MotionPlannerScenarioArtifact;
  if (parsed.schemaVersion !== 'motion-planner-scenario-v1') {
    throw new Error('Unsupported motion-planner scenario artifact schema.');
  }
  return parsed;
};
