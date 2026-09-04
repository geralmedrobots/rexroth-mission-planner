import type {
  GridCell, OccupancyGrid, PathPoint, RobotPose, VdaOrder, VdaState,
} from '../../domain/types';

export interface GlobalReplanningSettings {
  enabled:boolean;
  localBypassWaitTimeMs:number;
  blockedTimeoutMs:number;
  stoppedSpeedThresholdMps:number;
  minimumGoalDistanceM:number;
  minimumObstacleSizeM:number;
  obstacleMergeDistanceM:number;
  inflationDistanceM:number;
  unknownCellsBlocked:boolean;
  maximumPlanningTimeMs:number;
  maximumPlanningAttempts:number;
  retryDelayMs:number;
  maximumRetries:number;
  temporaryObstacleTtlMs:number;
  minimumRouteChangeM:number;
  enableStartPoseProjection:boolean;
  maximumStartProjectionDistanceM:number;
  enableBlockedRouteInferenceFallback:boolean;
  inferredObstacleDistanceM:number;
  inferredObstacleLengthM:number;
  inferredObstacleWidthM:number;
  postReplacementGraceMs:number;
}

export type GlobalReplanningStatus=
  |'IDLE'|'DISABLED'|'MONITORING'|'BLOCKED'|'PLANNING'
  |'ALTERNATIVE_VALIDATED'|'CANCEL_SENT'|'WAITING_CANCEL_ACTION'
  |'WAITING_OLD_ORDER_CLEAR'|'REVALIDATING'|'PUBLISHING_REPLACEMENT'
  |'WAITING_NEW_ORDER_ACCEPTANCE'|'COMPLETED'|'ACTIVE'|'FAILED'
  |'WAITING_FOR_OBSTACLE_DATA'|'NO_MEANINGFUL_ALTERNATIVE';

export interface TemporaryObstacleObservation {
  id:string;
  source:'Laser1'|'Laser2'|'EnvironmentModel'|'ObstacleMessage'|'ObstaclePolygon'
    |'BlockedRouteInference';
  sourcePath:string;
  mapId?:string;
  points:Array<{x:number;y:number}>;
  receivedAtMs:number;
}

export interface TemporaryMapResult {
  grid:OccupancyGrid;
  inflatedGrid:OccupancyGrid;
  obstacleCells:GridCell[];
  inflatedObstacleCells:GridCell[];
  acceptedObservations:TemporaryObstacleObservation[];
  ignoredObservationCount:number;
  robotRadiusM:number;
  totalInflationM:number;
}

export interface BlockedRouteSnapshot {
  nowMs:number;
  state?:VdaState;
  activeOrder?:VdaOrder;
  robotPose?:RobotPose;
  stateFresh:boolean;
  visualizationFresh:boolean;
  visualizationPose?:RobotPose;
  visualizationReceivedAtMs?:number;
}

export interface BlockedRouteDecision {
  blocked:boolean;
  candidate:boolean;
  blockedDurationMs:number;
  distanceToGoalM?:number;
  speedMps?:number;
  reason:string;
  waitingForBypass:boolean;
}

export interface GlobalReplanningLog {
  id:string;
  timestamp:string;
  source:'BlockedRouteDetector'|'GlobalPlanner'|'TemporaryMap'|'PathOptimizer'
    |'OrderGenerator'|'OrderPublisher';
  level:'debug'|'info'|'warning'|'error';
  message:string;
  context?:Record<string,unknown>;
}

export interface GlobalReplanningRuntime {
  status:GlobalReplanningStatus;
  reason?:string;
  blockedSinceMs?:number;
  blockedDurationMs:number;
  attempt:number;
  retryCount:number;
  nextRetryAtMs?:number;
  originalPath:PathPoint[];
  blockedPath:PathPoint[];
  newPath:PathPoint[];
  temporaryObstacleCells:GridCell[];
  temporaryObstacleCount:number;
  originalPathLengthM?:number;
  newPathLengthM?:number;
  planningTimeMs?:number;
  maximumRouteDeviationM?:number;
  startProjection?:StartProjectionDiagnostic;
  exploredCells:GridCell[];
  inflatedTemporaryObstacleCells:GridCell[];
  obstacleIngestionDiagnostics:ObstacleIngestionDiagnostic[];
  replacementOrder?:VdaOrder;
  lastError?:string;
  lastCompletedAt?:string;
}

export interface GlobalReplanResult {
  order:VdaOrder;
  temporaryMap:TemporaryMapResult;
  rawPath:PathPoint[];
  simplifiedPath:PathPoint[];
  finalPath:PathPoint[];
  planningTimeMs:number;
  originalPathLengthM:number;
  newPathLengthM:number;
  maximumRouteDeviationM:number;
  startProjection:StartProjectionDiagnostic;
  exploredCells:GridCell[];
}

export interface StartProjectionDiagnostic {
  originalPose:{x:number;y:number};
  originalCell:GridCell;
  projectedPose?:{x:number;y:number};
  projectedCell?:GridCell;
  projectionDistanceM?:number;
  searchRadiusM?:number;
  usedProjectedStartWaypoint?:boolean;
  goalConnected?:boolean;
  success:boolean;
  failureReason?:string;
}

export interface ObstacleIngestionDiagnostic {
  sourceTopic:string;
  payloadKind:'state'|'visualization';
  rawPointCount:number;
  transformedPointCount:number;
  rejectedPointCount:number;
  obstacleClusterCount:number;
  insertedOccupiedCells:number;
  inflatedCells:number;
  sourcePaths:string[];
  frameModes:string[];
  dataAgeMs:number;
}
