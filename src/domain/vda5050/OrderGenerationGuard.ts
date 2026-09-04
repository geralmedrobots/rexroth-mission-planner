import type {
  ConfirmedMapBinding, NavigatorMapIdSource, RobotPoseSnapshot, ValidationIssue,
} from '../types';
import { compareMapIds, normalizeMapId } from '../robot/ActiveMapResolver';

export interface OrderGenerationPrerequisites {
  mqttConnected: boolean;
  connectionOnline: boolean;
  operatingMode?: string;
  stateAgeMs: number;
  maximumStateAgeMs: number;
  lastStateReceiveTime?: number | null;
  positionInitialized: boolean;
  pose?: RobotPoseSnapshot;
  activeMapId: string | null;
  activeMapSource?: NavigatorMapIdSource;
  stateMapId?: string | null;
  visualizationMapId?: string | null;
  lastKnownValidNavigatorMapId?: string | null;
  confirmedMapBinding?: ConfirmedMapBinding | null;
  loadedLocatorMapName?: string;
}

export const getOrderGenerationIssues = (context: OrderGenerationPrerequisites): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const add = (condition: boolean, code: string, message: string, details?: Record<string, unknown>): void => {
    if (!condition) issues.push({ code, message, severity: 'error', details });
  };
  add(context.mqttConnected, 'generation.mqtt', 'MQTT is not connected.');
  add(context.connectionOnline, 'generation.connection', 'ROKIT connection state is not ONLINE.');
  add(context.operatingMode?.toUpperCase() === 'AUTOMATIC', 'generation.mode', 'ROKIT operatingMode must be AUTOMATIC.');
  add(Number.isFinite(context.stateAgeMs) && context.stateAgeMs <= context.maximumStateAgeMs,
    'generation.stateStale',
    `Robot state is stale: age ${Number.isFinite(context.stateAgeMs) ? Math.max(0, Math.round(context.stateAgeMs)) : 'unavailable'} ms, limit ${context.maximumStateAgeMs} ms.`,
    {
      stateAgeMs: context.stateAgeMs,
      stateStaleTimeoutMs: context.maximumStateAgeMs,
      lastStateReceiveTime: context.lastStateReceiveTime == null
        ? null : new Date(context.lastStateReceiveTime).toISOString(),
    });
  add(context.positionInitialized, 'generation.positionInitialized', 'Robot position is not initialized.');
  add(Boolean(context.pose && [context.pose.pose.x, context.pose.pose.y, context.pose.pose.theta].every(Number.isFinite)),
    'generation.pose', 'A complete finite current robot pose is required.');
  const activeMapId = normalizeMapId(context.activeMapId);
  if (!activeMapId) {
    issues.push({
      code:'generation.mapId',
      message:'The active Navigator mapId is empty. State mapId and visualization mapId were both empty.',
      severity:'error',
      details:{
        stateMapId:context.stateMapId??null,
        visualizationMapId:context.visualizationMapId??null,
        lastKnownValidNavigatorMapId:context.lastKnownValidNavigatorMapId??null,
        mapIdSource:context.activeMapSource??'none',
      },
    });
  } else if (!normalizeMapId(context.loadedLocatorMapName)) {
    issues.push({
      code:'generation.locatorMapMissing',message:'No Locator map is loaded.',severity:'error',
      details:{activeNavigatorMapId:activeMapId,mapIdSource:context.activeMapSource??'none'},
    });
  } else {
    const comparison=compareMapIds(context.loadedLocatorMapName,activeMapId);
    if(!comparison.matches) issues.push({
      code:'generation.locatorMapMismatch',
      message:`Loaded Locator map "${comparison.locator}" does not match active Navigator mapId "${comparison.navigator}".`,
      severity:'error',
      details:{loadedLocatorMap:comparison.locator,activeNavigatorMapId:comparison.navigator,
        mapIdSource:context.activeMapSource??'none'},
    });
  }
  if(activeMapId&&context.activeMapSource==='manual-confirmed')issues.push({
    code:'generation.mapIdManualBinding',
    message:'The Navigator did not provide mapId through MQTT. The user-confirmed Locator map binding is being used.',
    severity:'warning',
    details:{confirmedMapBinding:context.confirmedMapBinding??null,activeNavigatorMapId:activeMapId},
  });
  return issues;
};

export const assertOrderGenerationReady = (context: OrderGenerationPrerequisites): void => {
  const issues = getOrderGenerationIssues(context);
  const errors=issues.filter((issue)=>issue.severity==='error');
  if (errors.length) throw new Error(errors.map((issue) => issue.message).join(' '));
};
