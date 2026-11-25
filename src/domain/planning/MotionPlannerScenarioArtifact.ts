import type { OccupancyGrid, PathPoint, RobotFootprint, PlannerResult, Waypoint, PlannerMode } from '../types';
import { z } from 'zod';
import { createPlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';
import { motionPlannerGridRevision, motionPlannerFootprintHash,
  type MotionPlannerCalibrationSnapshot } from './MotionPlannerCalibration';
import type { MotionPlannerCalibrationProfileName } from './MotionPlannerCalibrationProfiles';
import { replayMotionPlannerScenario, type MotionPlannerReplayResult } from './MotionPlannerReplay';
import type { PlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';

/** Full-grid debug artifact. It is never included in routine diagnostic events. */
export interface MotionPlannerScenarioArtifact {
  readonly recording?: import('./Stage5BRecorder').MissionRecording;
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
  readonly capture?: { plannerMode: PlannerMode; waypoints: readonly Waypoint[];
    waypointsUsed: boolean; capturedAt: string; result: PlannerResult };
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
  capture?: MotionPlannerScenarioArtifact['capture'];
}

export const createMotionPlannerScenarioArtifact = (
  input: MotionPlannerScenarioArtifactInput,
): MotionPlannerScenarioArtifact => validateMotionPlannerScenarioArtifact(structuredClone({
  schemaVersion: 'motion-planner-scenario-v1',
  mapRevision: motionPlannerGridRevision(input.grid),
  footprintGeometryHash: motionPlannerFootprintHash(input.footprint),
  selectedProfile: input.selectedProfile ?? 'PRODUCTION_BASELINE',
  grid: input.grid, footprint: input.footprint,
  startPose: input.startPose, goalPose: input.goalPose,
  ...(input.goalTheta === undefined ? {} : { goalTheta: input.goalTheta }),
  configuration: input.configuration,
  ...(input.originalCalibration ? { originalCalibration: input.originalCalibration } : {}),
  ...(input.capture ? { capture: input.capture } : {}),
}));

export const replayMotionPlannerScenarioArtifact = (
  artifact: MotionPlannerScenarioArtifact,
): MotionPlannerReplayResult => {
  validateMotionPlannerScenarioArtifact(artifact);
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
): string => JSON.stringify(validateMotionPlannerScenarioArtifact(artifact), null, 2);

export const parseMotionPlannerScenarioArtifact = (
  text: string,
): MotionPlannerScenarioArtifact => {
  return validateMotionPlannerScenarioArtifact(JSON.parse(text));
};

const number = z.number().finite();
const pose = z.object({ x: number, y: number, theta: number }).passthrough();
const schema = z.object({
  recording: z.object({ recorderVersion: z.literal('stage5b-recorder-v1'),
    recordingId: z.string().uuid().optional(),
    missionId: z.string().min(1), provenance: z.enum(['real-run', 'synthetic']),
    startedAt: z.iso.datetime({ offset: true }), completedAt: z.iso.datetime({ offset: true }).optional(),
    outcome: z.enum(['success', 'failed', 'cancelled']).optional(), reason: z.string().optional(),
    finalPose: pose.optional(), appVersion: z.string(), gitCommit: z.string().optional(),
    execution: z.object({ status: z.enum(['success', 'failed', 'cancelled']),
      completedAt: z.iso.datetime({ offset: true }), startedAt: z.iso.datetime({ offset: true }).optional(), durationMs: number.nonnegative().optional(),
      orderId: z.string().optional(), lastNodeId: z.string().optional(), lastNodeSequenceId: number.optional(),
      navigatorErrors: z.array(z.unknown()).optional(), finalPose: pose.optional() }).passthrough().optional(),
    orders: z.array(z.object({ order: z.object({ orderId: z.string(), nodes: z.array(z.unknown()),
      edges: z.array(z.unknown()) }).passthrough(), generatedAt: z.iso.datetime({ offset: true }), publishedAt: z.iso.datetime({ offset: true }).optional() })),
  }).optional(),
  schemaVersion: z.literal('motion-planner-scenario-v1'), mapRevision: z.string(),
  footprintGeometryHash: z.string(), selectedProfile: z.enum(['PRODUCTION_BASELINE', 'CUSTOM',
    'BALANCED', 'FORWARD_PREFERRED', 'CLEARANCE_PREFERRED']),
  grid: z.object({ metadata: z.object({ width: number.int().positive(), height: number.int().positive(),
    resolution: number.positive(), origin: z.object({ x: number, y: number, yaw: number }),
    mapId: z.string(), name: z.string(), occupiedThreshold: number, freeThreshold: number,
    negate: z.boolean() }).passthrough(), data: z.array(number) }).passthrough(),
  footprint: z.object({ length: number.nonnegative(), width: number.nonnegative(), safetyMargin: number.nonnegative() }).passthrough(),
  startPose: pose, goalPose: pose, goalTheta: number.optional(),
  configuration: z.object({ planner: z.object({ passageSafety: z.object({
    wallClearanceMinimumM: number.nonnegative() }).passthrough() }).passthrough(),
    footprint: z.object({}).passthrough(), order: z.object({}).passthrough(),
    normalized: z.object({ motionState: z.object({}).passthrough() }).passthrough() }).passthrough(),
  capture: z.object({ plannerMode: z.enum(['automatic', 'manual', 'hybrid', 'motion-state']),
    waypoints: z.array(pose), waypointsUsed: z.boolean(), capturedAt: z.string(),
    result: z.object({ success: z.boolean(), error: z.string().optional(),
      rawPath: z.array(pose), simplifiedPath: z.array(pose), finalPath: z.array(pose),
      statistics: z.object({ durationMs: number, visitedCells: number }).passthrough() }).passthrough() }).passthrough().optional(),
}).passthrough();

export function validateMotionPlannerScenarioArtifact(value: unknown): MotionPlannerScenarioArtifact {
  schema.parse(value);
  const artifact = value as MotionPlannerScenarioArtifact;
  if (artifact.grid.data.length !== artifact.grid.metadata.width * artifact.grid.metadata.height)
    throw new Error('Artifact grid dimensions do not match cell count.');
  if (motionPlannerGridRevision(artifact.grid) !== artifact.mapRevision ||
    motionPlannerFootprintHash(artifact.footprint) !== artifact.footprintGeometryHash)
    throw new Error('Artifact integrity mismatch.');
  if (artifact.recording?.execution && (artifact.recording.execution.status !== artifact.recording.outcome ||
      artifact.recording.execution.completedAt !== artifact.recording.completedAt))
    throw new Error('Artifact execution outcome does not match finalized recording metadata.');
  const normalized = createPlanningConfigurationSnapshot({ plannerOptions: artifact.configuration.planner,
    footprint: artifact.footprint, orderSettings: artifact.configuration.order });
  if (JSON.stringify(normalized.normalized.motionState) !== JSON.stringify(artifact.configuration.normalized.motionState))
    throw new Error('Artifact effective configuration does not match captured planner/footprint settings.');
  return artifact;
}
