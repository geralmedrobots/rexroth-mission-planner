import type { MqttSettings, OrderSettings, PlannerOptions, RobotFootprint } from './types';

export const DEFAULT_MAP_ID = 'sample-warehouse';
export const DEFAULT_ROBOT_WIDTH_M = 0.60;
export const DEFAULT_ROBOT_LENGTH_M = 0.83;
export const normalizeMissionMaximumSpeed = (value: number): number =>
  Math.max(0,Number.isFinite(value)?value:0);
export const clampStateStaleTimeoutMs = (value: number): number =>
  Math.min(60_000,Math.max(2_000,Number.isFinite(value)?value:10_000));
export const defaultMqttSettings: MqttSettings = {
  host: '192.168.1.111', port: 1883, transport: 'tcp', websocketPath: '/mqtt',
  username: '', password: '', tls: false, rejectUnauthorized: true, keepalive: 30,
  connectTimeoutMs: 10_000, qos: 1, subscriptionQos: 1,
  automaticConnection: true,
  topics: {
    order: 'uagv/v2/bosch/0001/order',
    instantActions: 'uagv/v2/bosch/0001/instantActions',
    state: 'uagv/v2/bosch/0001/state',
    visualization: 'uagv/v2/bosch/0001/visualization',
    connection: 'uagv/v2/bosch/0001/connection',
  },
};
export const defaultOrderSettings: OrderSettings = {
  manufacturer: 'bosch', serialNumber: '0001', version: '2.0.0',
  // This is the single application mission-speed configuration default.
  missionMaximumSpeedMps:0.05,
  allowedDeviationXy: 0.2, allowedDeviationTheta: 0.35,
  rotationAllowed: true, startTolerance: 0.5, commandTimeoutMs: 5_000,
  stateStaleTimeoutMs: 10_000,
  initialPathPointDistance: 0.03, firstNodePositionConsistency: 0.05,
  firstNodeAngularConsistency: 5*Math.PI/180, acceptanceTimeoutMs: 5_000,
  pauseResumeEnabled: false,
};
export const defaultFootprint: RobotFootprint = {
  length: DEFAULT_ROBOT_LENGTH_M, width: DEFAULT_ROBOT_WIDTH_M,
  height: 0.27, centerOffsetX: 0, centerOffsetY: 0,
  safetyMargin: 0.08,
  inflationRadius: Math.hypot(DEFAULT_ROBOT_LENGTH_M,DEFAULT_ROBOT_WIDTH_M)/2+0.08,
  minimumTurningRadius: 0, differentialDrive: true, allowReverse: false, allowTurnOnSpot: true,
  kinematicCentreConfirmed:false,source:'application-fallback',frame:'VEHICLE',
  polygon:[
    {x:-DEFAULT_ROBOT_LENGTH_M/2,y:DEFAULT_ROBOT_WIDTH_M/2},
    {x:DEFAULT_ROBOT_LENGTH_M/2,y:DEFAULT_ROBOT_WIDTH_M/2},
    {x:DEFAULT_ROBOT_LENGTH_M/2,y:-DEFAULT_ROBOT_WIDTH_M/2},
    {x:-DEFAULT_ROBOT_LENGTH_M/2,y:-DEFAULT_ROBOT_WIDTH_M/2},
  ],
  forwardAllowed:true,backwardAllowed:false,turnOnSpotAllowed:true,
};
export const defaultPlannerOptions: PlannerOptions = {
  policy:'reliable',
  reliableBaselineMode:true,
  diagonalMovement: true, heuristic: 'octile', distanceWeight: 1, proximityWeight: 2,
  turnPenalty: 0.15, reversePenalty: 2, maxPlanningTimeMs: 3_000, correctionRadiusCells: 4,
  rejectGoalObstacleDepthCells: 2, simplificationTolerance: 0.08, waypointSpacing: 0.40,
  minimumWaypointDistance: 0.20, maximumWaypointDistance: 0.60,
  finalOrientationEnforcement: true, collisionSampleInterval: 0.03, cornerSmoothing: true,
  corridor:{
    enableBoschRokitCorridorExtension:true,
    obstacleSafetyMarginM:0.15,
    localizationMarginM:0.05,
    minCorridorWidthM:0.10,
    maxCorridorWidthM:1.00,
    corridorSampleSpacingM:0.10,
    unknownCellsBlocked:true,
    corridorRefPoint:'KINEMATICCENTER',
  },
  passageSafety:{
    enableWaypointDensification:true,
    preferredWaypointSpacingM:0.40,
    maximumWaypointSpacingM:0.60,
    minimumWaypointSpacingM:0.20,
    enableDoorwayDetection:true,
    enableDoorAlignment:true,
    minimumDoorConfidence:0.80,
    doorAlignmentDistanceBeforeM:0.50,
    doorAlignmentDistanceAfterM:0.35,
    minimumDoorApproachStraightLengthM:0.50,
    maximumDoorApproachAngleDeg:15,
    maximumHeadingErrorInsideDoorDeg:5,
    minimumPassageWidthM:0.86,
    maximumPassageWidthM:1.80,
    wallClearancePreferredM:0.30,
    wallClearanceMinimumM:0.10,
    wallProximityWeight:2,
    narrowPassageWeight:1.5,
    headingChangeWeight:0.15,
    turnLocationWeight:1,
    reverseRiskWeight:2,
    planningSafetyMarginM:0.05,
    localizationMarginM:0.05,
    enableTurnFeasibilityChecking:true,
    rotationCollisionSampleDeg:5,
    maximumHeadingChangePerNodeDeg:45,
    maximumHeadingChangeNearDoorDeg:20,
    doorProtectionDistanceM:1.0,
  },
};
