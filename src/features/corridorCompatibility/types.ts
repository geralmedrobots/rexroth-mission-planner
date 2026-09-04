import type { BoschRokitCorridor, PathPoint, VdaError, VdaOrder, VdaState } from '../../domain/types';

export type CorridorTestVariant =
  | 'baseline'
  | 'current-corridor'
  | 'narrow-corridor'
  | 'wide-corridor'
  | 'asymmetric-corridor';

export type CorridorCompatibilityStatus =
  | 'SENT'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'ACTIVE'
  | 'BLOCKED'
  | 'BYPASS_GENERATED'
  | 'COMPLETED'
  | 'UNKNOWN';

export type CorridorCompatibilityLogSource =
  | 'OrderBuilder'
  | 'CorridorExtension'
  | 'OrderValidator'
  | 'MqttPublisher'
  | 'NavigatorState'
  | 'NavigatorVisualization'
  | 'NavigatorErrors'
  | 'BypassDetector';

export interface CorridorCompatibilityLog {
  id:string;
  timestamp:string;
  source:CorridorCompatibilityLogSource;
  level:'debug'|'info'|'warning'|'error';
  orderId?:string;
  variant?:CorridorTestVariant;
  message:string;
  context?:Record<string,unknown>;
}

export interface EdgeCorridorCapture {
  edgeId:string;
  corridor:BoschRokitCorridor;
}

export interface ExactMqttPayloadCapture {
  timestamp:string;
  topic:string;
  rawJson:string;
  parsedJson:VdaOrder;
  orderId:string;
  headerId:number;
  variant:CorridorTestVariant;
  corridorCount:number;
  edgeCorridors:EdgeCorridorCapture[];
  payloadBytes:number;
  corridorExistsBeforeSerialization:boolean;
  corridorExistsAfterSerialization:boolean;
  corridorExistsInRawPayload:boolean;
  corridorRefPoints:string[];
  baseVda20ValidationPassed?:boolean;
  boschCorridorExtensionValidationPassed?:boolean;
  corridorCountAfterValidation?:number;
}

export interface NavigatorPathCandidate {
  jsonPath:string;
  points:PathPoint[];
}

export interface CorridorCompatibilityResult {
  id:string;
  variant:CorridorTestVariant;
  orderId:string;
  headerId:number;
  status:CorridorCompatibilityStatus;
  sentAt:string;
  acceptedAt?:string;
  completedAt?:string;
  corridorSent:boolean;
  corridorCount:number;
  navigatorCorridorEchoObserved:boolean;
  navigatorPathChanged:boolean;
  bypassDetected:boolean;
  maximumLateralDeviationM:number;
  firstDeviationTimestamp?:string;
  bypassDurationMs?:number;
  rejoinPoint?:PathPoint;
  error?:string;
  navigatorErrors:VdaError[];
  lastState?:Pick<VdaState,
    'orderId'|'lastNodeId'|'lastNodeSequenceId'|'driving'|'paused'|'operatingMode'>;
  lastStateAgeMs?:number;
  lastVisualizationAgeMs?:number;
  navigatorPathCandidates:NavigatorPathCandidate[];
  navigatorPoseTrace:PathPoint[];
}

export interface CorridorCompatibilitySettings {
  bypassDetectionThresholdM:number;
  requiredDeviationMessages:number;
  requiredRejoinMessages:number;
  visualizationStaleTimeoutMs:number;
  acceptanceTimeoutMs:number;
}

export const corridorVariantLabels:Record<CorridorTestVariant,string>={
  baseline:'Baseline — no corridor',
  'current-corridor':'Current calculated corridor',
  'narrow-corridor':'Fixed narrow — 0.2 / 0.2 m',
  'wide-corridor':'Fixed wide — 1.0 / 1.0 m',
  'asymmetric-corridor':'Asymmetric — 0.1 / 1.0 m',
};
