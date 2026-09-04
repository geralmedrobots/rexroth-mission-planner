import type {
  OccupancyGrid, RobotFootprint, RobotPose, VdaOrder,
} from '../../domain/types';
import type { TemporaryObstacleObservation } from '../replanning/types';

export type RecoveryState =
  | 'IDLE'
  | 'BLOCKED_CONFIRMED'
  | 'CHECK_TURN_SPACE'
  | 'CHECK_REVERSE_SPACE'
  | 'BUILD_REVERSE_ORDER'
  | 'SEND_REVERSE_ORDER'
  | 'WAIT_REVERSE_ACCEPTANCE'
  | 'REVERSING'
  | 'REVERSE_COMPLETED'
  | 'GLOBAL_REPLAN'
  | 'FAILED';

export interface RecoverySettings {
  enabled:boolean;
  blockedTimeoutMs:number;
  reverseDistanceM:number;
  maximumReverseDistanceM:number;
  rearSafetyMarginM:number;
  requireRearLaserData:boolean;
  retryCount:number;
  telemetry:DrivingModeTelemetrySettings;
}

export type DrivingModeTelemetrySource='ctrlx'|'mqtt-raw'|'disabled';
export type TelemetryConnectionState='disconnected'|'connecting'|'connected'|'error'|'disabled';

export interface CtrlXDataLayerSettings {
  host:string;
  port:number;
  https:boolean;
  endpointTemplate:string;
  authenticationMode:'none'|'basic'|'bearer';
  username:string;
  password:string;
  bearerToken:string;
  requestDrivingModePath:string;
  commandedVxPath:string;
  commandedYawRatePath:string;
  availableDrivingModesPath:string;
  pollingIntervalMs:number;
  staleTimeoutMs:number;
  requestTimeoutMs:number;
  rejectUnauthorized:boolean;
  caCertificatePem:string;
}

export interface DrivingModeTelemetrySettings {
  source:DrivingModeTelemetrySource;
  ctrlx:CtrlXDataLayerSettings;
}

export interface RecoveryTelemetry {
  requestDrivingMode:number|null;
  availableDrivingModes:number[];
  commandedVx:number|null;
  commandedYawRate:number|null;
  provider:DrivingModeTelemetrySource;
  connectionState:TelemetryConnectionState;
  receivedAtMs:number|null;
  error?:string;
}

export interface DrivingModeTelemetryProvider {
  readonly source:DrivingModeTelemetrySource;
  connect():Promise<void>;
  read():Promise<RecoveryTelemetry>;
  disconnect():Promise<void>;
  getConnectionState():TelemetryConnectionState;
}

export interface ReverseCorridorResult {
  safe:boolean;
  distanceM:number;
  target?:RobotPose;
  reason:string;
}

export interface RecoveryGeometryInput {
  grid:OccupancyGrid;
  pose:RobotPose;
  footprint:RobotFootprint;
  observations:TemporaryObstacleObservation[];
  settings:RecoverySettings;
  sampleIntervalM:number;
}

export interface RecoveryRuntime {
  state:RecoveryState;
  reason?:string;
  forwardBlocked:boolean;
  turnSpaceAvailable?:boolean;
  reverseSpaceAvailable?:boolean;
  reverseDistanceSelectedM?:number;
  rearObstacleCount:number;
  recoveryOrderId?:string;
  requestedDrivingMode?:number|null;
  availableDrivingModes?:number[];
  commandedVx?:number|null;
  commandedYawRate?:number|null;
  telemetryProvider?:DrivingModeTelemetrySource;
  telemetryConnectionState?:TelemetryConnectionState;
  telemetryLastUpdateAtMs?:number|null;
  telemetryAgeMs?:number;
  backwardConfirmationState?:'unavailable'|'waiting'|'confirmed'|'forward'|'turn-on-spot';
  recoveryResult?:string;
  globalReplanResult?:string;
  reversePath:RobotPose[];
  recoveryOrder?:VdaOrder;
  lastError?:string;
}

export interface RecoveryLog {
  id:string;
  timestamp:string;
  level:'debug'|'info'|'warning'|'error';
  message:string;
  context?:Record<string,unknown>;
}
