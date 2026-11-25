export interface Pose2D { x: number; y: number; theta: number }
export interface RobotPose extends Pose2D { mapId: string; positionInitialized: boolean }
export interface GridCell { row: number; column: number }
export interface MapOrigin { x: number; y: number; yaw: number }
export interface MapMetadata {
  name: string; mapId: string; width: number; height: number; resolution: number;
  origin: MapOrigin; occupiedThreshold: number; freeThreshold: number; negate: boolean;
}
export interface OccupancyGrid { metadata: MapMetadata; data: number[] }
export type PathPointKind =
  | 'normal' | 'door-alignment' | 'door-centre' | 'door-exit' | 'turn-transition';
export interface PathPoint extends Pose2D {
  row?: number;
  column?: number;
  kind?: PathPointKind;
  passageId?: string;
  orientationLocked?: boolean;
}
export interface Waypoint extends PathPoint {
  id: string; deviationXy: number; deviationTheta: number; orientationLocked: boolean;
}
export interface RobotFootprint {
  length: number; width: number; height: number; centerOffsetX: number; centerOffsetY: number;
  safetyMargin: number; inflationRadius: number; minimumTurningRadius: number;
  differentialDrive: boolean; allowReverse: boolean; allowTurnOnSpot: boolean;
  kinematicCentreConfirmed?: boolean;
  polygon?: Array<{x:number;y:number}>;
  source?: 'bosch-client-motion'|'application-fallback';
  frame?: 'VEHICLE';
  forwardAllowed?:boolean;
  backwardAllowed?:boolean;
  turnOnSpotAllowed?:boolean;
  maxForwardVelocity?:number;
  maxReverseVelocity?:number;
  maxAngularVelocity?:number;
  wheelTransforms?:Array<{x:number;y:number;yawDeg:number}>;
}
export type PlannerPolicy='reliable'|'balanced'|'advanced';
/**
 * Bosch ROKIT Navigator compatibility extension for a VDA 5050 2.0 Order.
 * Field names and enum values follow the VDA 5050 2.1 corridor definition.
 * Source: https://github.com/VDA5050/VDA5050/blob/2.1.0/json_schemas/order.schema
 */
export interface BoschRokitCorridor {
  leftWidth: number;
  rightWidth: number;
  corridorRefPoint: 'KINEMATICCENTER' | 'CONTOUR';
}
export interface BoschRokitCorridorSettings {
  enableBoschRokitCorridorExtension: boolean;
  obstacleSafetyMarginM: number;
  localizationMarginM: number;
  minCorridorWidthM: number;
  maxCorridorWidthM: number;
  corridorSampleSpacingM: number;
  unknownCellsBlocked: boolean;
  corridorRefPoint: BoschRokitCorridor['corridorRefPoint'];
}
export interface PassageSafetySettings {
  enableWaypointDensification: boolean;
  preferredWaypointSpacingM: number;
  maximumWaypointSpacingM: number;
  minimumWaypointSpacingM: number;
  enableDoorwayDetection: boolean;
  enableDoorAlignment: boolean;
  minimumDoorConfidence: number;
  doorAlignmentDistanceBeforeM: number;
  doorAlignmentDistanceAfterM: number;
  minimumDoorApproachStraightLengthM: number;
  maximumDoorApproachAngleDeg: number;
  maximumHeadingErrorInsideDoorDeg: number;
  minimumPassageWidthM: number;
  maximumPassageWidthM: number;
  wallClearancePreferredM: number;
  wallClearanceMinimumM: number;
  wallProximityWeight: number;
  narrowPassageWeight: number;
  headingChangeWeight: number;
  turnLocationWeight: number;
  reverseRiskWeight: number;
  /** Motion-state-only cost; separated from reverseRiskWeight in Stage 4B. */
  motionStateDirectionSwitchWeight: number;
  /** Motion-state-only terminal rotation cost; separated from headingChangeWeight. */
  motionStateTerminalOrientationWeight: number;
  planningSafetyMarginM: number;
  localizationMarginM: number;
  enableTurnFeasibilityChecking: boolean;
  rotationCollisionSampleDeg: number;
  maximumHeadingChangePerNodeDeg: number;
  maximumHeadingChangeNearDoorDeg: number;
  doorProtectionDistanceM: number;
}
export interface PlannerOptions {
  policy:PlannerPolicy;
  reliableBaselineMode: boolean;
  diagonalMovement: boolean; heuristic: 'euclidean' | 'octile'; distanceWeight: number;
  proximityWeight: number; turnPenalty: number; reversePenalty: number; maxPlanningTimeMs: number;
  correctionRadiusCells: number; rejectGoalObstacleDepthCells: number;
  simplificationTolerance: number; waypointSpacing: number; minimumWaypointDistance: number;
  maximumWaypointDistance: number; finalOrientationEnforcement: boolean;
  collisionSampleInterval: number; cornerSmoothing: boolean;
  corridor: BoschRokitCorridorSettings;
  passageSafety: PassageSafetySettings;
}
export interface DetectedPassage {
  id: string;
  centre: Pose2D;
  axisHeading: number;
  normalHeading: number;
  widthM: number;
  usableWidthM: number;
  entry: Pose2D;
  exit: Pose2D;
  boundaryA: Pose2D;
  boundaryB: Pose2D;
  confidence: number;
  rotationInsideSafe: boolean;
}
export interface PlannerDiagnostics {
  detectedPassages: DetectedPassage[];
  routePassageCount: number;
  insertedNodeCount: number;
  rejectedTurnLocations: Pose2D[];
  relocatedTurnNodes: number;
  minimumRouteClearanceM: number;
  /** Sampled from the collision-checking OccupancyGrid for motion-state plans. */
  averageRouteClearanceM?: number;
  largestHeadingChangeDeg: number;
  stages: PlannerStageDiagnostic[];
  warnings: string[];
  finalPathSource: 'baseline' | 'door-aligned' | 'turn-enhanced' | 'motion-state';
  rawPathStatus: 'RAW_PATH_FOUND' | 'RAW_PATH_FAILED';
  baselineStatus: 'BASELINE_PATH_VALID' | 'BASELINE_PATH_FAILED';
  doorAlignmentStatus: 'NOT_RUN' | 'APPLIED' | 'ADVANCED_ALIGNMENT_SKIPPED';
  turnValidationStatus: 'NOT_RUN' | 'APPLIED' | 'TURN_RELOCATION_SKIPPED';
  physicalFailureCode?:PlannerFailureCode;
  recommendedOperatorAction?:string;
  freeSpace?:FreeSpaceDiagnostic;
}
export type PlannerFailureCode=
  |'RAW_ASTAR_FAILED'|'START_NOT_FREE'|'GOAL_NOT_FREE'
  |'START_GOAL_DISCONNECTED'|'PASSAGE_TOO_NARROW'
  |'VEHICLE_FOOTPRINT_COLLISION'|'FOOTPRINT_COLLISION'
  |'UNKNOWN_SPACE_BLOCKED'|'NO_SAFE_START_PROJECTION'
  |'NO_SAFE_MANOEUVRE_SPACE'|'NO_CONNECTED_FREE_SPACE_ROUTE'
  |'NO_PHYSICALLY_VALID_ROUTE'|'MOTION_STATE_SEARCH_TIMEOUT'|'ORDER_VALIDATION_FAILED'
  |'ORDER_TRANSITION_FAILED';
export interface FreeSpaceDiagnostic {
  startRegion?:number;
  goalRegion?:number;
  pointRobotConnected:boolean;
  footprintConnected:boolean;
  unknownFreeConnected:boolean;
  widestClearanceM:number;
  requiredHalfWidthM:number;
  visitedPointCells:number;
  visitedFootprintCells:number;
}
export type PlannerStageName =
  | 'map-validation' | 'start-cell-validation' | 'goal-cell-validation'
  | 'free-space-model'
  | 'raw-a-star' | 'path-simplification' | 'waypoint-densification'
  | 'doorway-detection' | 'doorway-alignment' | 'orientation-generation'
  | 'turn-feasibility' | 'footprint-collision-validation'
  | 'corridor-generation' | 'vda-order-validation'
  | 'motion-state-search' | 'motionplan-optimisation' | 'motionplan-validation';
export interface PlannerStageDiagnostic {
  stage: PlannerStageName;
  inputPointCount: number;
  outputPointCount: number;
  success: boolean;
  severity: 'info' | 'warning' | 'error';
  code?: string;
  reason?: string;
  rejectedPointIndex?: number;
  rejectedSegmentIndex?: number;
  world?: {x:number;y:number;theta?:number};
  grid?: GridCell;
  clearanceM?: number;
  requiredClearanceM?: number;
  footprintPolygon?: Array<{x:number;y:number}>;
  safetyMarginM?: number;
  collisionCell?: GridCell;
}
export interface PlannerStatistics {
  visitedCells: number; durationMs: number; rawPointCount: number; simplifiedPointCount: number;
  finalPointCount: number;
}
export interface PlannerResult {
  success: boolean; error?: string; rawPath: PathPoint[]; simplifiedPath: PathPoint[];
  finalPath: PathPoint[]; correctedStart?: GridCell; correctedGoal?: GridCell;
  exploredCells?: GridCell[];
  diagnostics?: PlannerDiagnostics;
  baselinePath?: PathPoint[];
  rejectedEnhancementPath?: PathPoint[];
  statistics: PlannerStatistics;
  /** Bounded operational diagnostics transported from a worker with the result. */
  diagnosticEvents?: import('../features/diagnostics/DiagnosticEvent').DiagnosticEvent[];
  motionPlan?: import('./motion/planningModel').MotionPlan;
  motionPlannerEvents?: Array<Record<string, unknown>>;
  motionPlannerCalibration?: import('./planning/MotionPlannerCalibration').MotionPlannerCalibrationSnapshot;
}
export interface VdaHeader {
  headerId: number; timestamp: string; version: '2.0.0'; manufacturer: string; serialNumber: string;
}
export interface VdaNodePosition extends Pose2D {
  allowedDeviationXy: number; allowedDeviationTheta: number; mapId: string;
}
export interface VdaAction {
  actionType: string; actionId: string; blockingType: 'NONE' | 'SOFT' | 'HARD';
  actionParameters?: Array<{ key: string; value: string | number | boolean | unknown[] }>;
}
export interface VdaNode {
  nodeId: string; sequenceId: number; released: boolean; nodePosition: VdaNodePosition;
  actions: VdaAction[];
}
export interface VdaEdge {
  edgeId: string; sequenceId: number; released: boolean; startNodeId: string; endNodeId: string;
  /** VDA 5050 tangential body orientation: 0 forward, pi reverse. */
  orientation?: number;
  maxSpeed: number; rotationAllowed: boolean; corridor?: BoschRokitCorridor; actions: VdaAction[];
}
export interface VdaOrder extends VdaHeader {
  orderId: string; orderUpdateId: number; nodes: VdaNode[]; edges: VdaEdge[];
}
export interface VdaInstantActionMessage extends VdaHeader { actions: VdaAction[] }
export type VdaInstantAction = 'cancelOrder' | 'factsheetRequest' | 'stateRequest' | 'startPause' | 'stopPause';
export interface VdaErrorReference { referenceKey: string; referenceValue: string }
export interface VdaError {
  errorType: string; errorLevel: string; errorDescription?: string; errorReferences?: VdaErrorReference[];
}
export interface VdaState {
  headerId?: number; timestamp?: string; version?: string; manufacturer?: string; serialNumber?: string;
  orderId?: string; orderUpdateId?: number; lastNodeId?: string; lastNodeSequenceId?: number;
  driving?: boolean; paused?: boolean; operatingMode?: string; agvPosition?: RobotPose;
  velocity?: { vx?: number; vy?: number; omega?: number };
  batteryState?: { batteryCharge?: number; charging?: boolean };
  safetyState?: { eStop?: string; fieldViolation?: boolean }; newBaseRequest?: boolean;
  nodeStates?: unknown[]; edgeStates?: unknown[]; actionStates?: unknown[];
  errors?: VdaError[]; information?: unknown[];
}
export interface VdaVisualization extends VdaHeader {
  agvPosition?: RobotPose; velocity?: { vx?: number; vy?: number; omega?: number };
}
export interface VdaConnection extends VdaHeader { connectionState: string }
export interface ValidationIssue {
  code: string; message: string; path?: string; severity: 'error' | 'warning';
  details?: Record<string, unknown>;
}
export interface ValidationResult {
  valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[];
  context?: Record<string, unknown>;
}
export interface MqttTopics {
  order: string; instantActions: string; state: string; visualization: string; connection: string;
}
export interface MqttSettings {
  host: string; port: number; transport: 'tcp' | 'ws'; websocketPath: string; username: string;
  password: string; tls: boolean; rejectUnauthorized: boolean; keepalive: number;
  connectTimeoutMs: number; qos: 0 | 1 | 2; subscriptionQos: 0 | 1 | 2; topics: MqttTopics;
  automaticConnection: boolean;
}
export interface OrderSettings {
  manufacturer: string; serialNumber: string; version: '2.0.0';
  missionMaximumSpeedMps:number;
  allowedDeviationXy: number; allowedDeviationTheta: number;
  rotationAllowed: boolean; startTolerance: number; commandTimeoutMs: number;
  stateStaleTimeoutMs: number;
  initialPathPointDistance: number; firstNodePositionConsistency: number;
  firstNodeAngularConsistency: number; acceptanceTimeoutMs: number;
  pauseResumeEnabled: boolean;
}
export type PlannerMode = 'automatic' | 'manual' | 'hybrid' | 'motion-state';
export interface AppLog { id: string; timestamp: string; category: 'mqtt' | 'planner' | 'validation' | 'system'; level: 'info' | 'warning' | 'error'; message: string }
export type PoseSource = 'state' | 'visualization';
export type NavigatorMapIdSource =
  | 'state' | 'visualization' | 'last-known' | 'manual-confirmed' | 'none';
export type ActiveMapSource = NavigatorMapIdSource;
export interface ConfirmedMapBinding {
  manufacturer: string;
  serialNumber: string;
  locatorMapName: string;
  confirmedAt: string;
}
export interface MqttReceiveMetadata {
  lastStateReceiveTime: number | null;
  lastVisualizationReceiveTime: number | null;
  statePayloadTimestamp: string | null;
  visualizationPayloadTimestamp: string | null;
}
export interface ActiveMapResolution {
  mapId: string | null;
  source: ActiveMapSource;
}
export interface RobotPoseSnapshot {
  pose: RobotPose;
  source: PoseSource;
  mapIdSource?: Exclude<ActiveMapSource, 'none'>;
  receivedAtMs: number;
}
export interface RokitErrorHistoryEntry {
  key: string;
  error: VdaError;
  receivedAt: string;
  orderId: string;
}
