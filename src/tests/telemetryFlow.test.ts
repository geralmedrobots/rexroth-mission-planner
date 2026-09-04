import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMqttSettings, defaultOrderSettings } from '../domain/defaults';
import {
  compareMapIds, normalizeMapId, payloadMatchesRobotIdentity, resolveActiveNavigatorMap,
} from '../domain/robot/ActiveMapResolver';
import { selectCurrentRobotPose } from '../domain/robot/RobotPoseSelector';
import {
  getLocalMessageAgeMs, isLocalMessageFresh, recordStateReceive, recordVisualizationReceive,
} from '../domain/robot/TelemetryFreshness';
import type { RobotPose, VdaState, VdaVisualization } from '../domain/types';
import { getOrderGenerationIssues, type OrderGenerationPrerequisites } from '../domain/vda5050/OrderGenerationGuard';
import { useAppStore } from '../stores/appStore';

const mapId='SendBox_2026-07-23_11-35-45_built_001';
const identity={manufacturer:'bosch',serialNumber:'0001'};
const robotPose:RobotPose={x:2.685,y:1.489,theta:-1.330,mapId,positionInitialized:true};
const state:VdaState={
  timestamp:'1999-01-01T00:00:00.000Z',version:'2.0.0',manufacturer:'bosch',serialNumber:'0001',
  operatingMode:'AUTOMATIC',agvPosition:robotPose,
};
const visualization:VdaVisualization={
  headerId:2,timestamp:'2099-01-01T00:00:00.000Z',version:'2.0.0',manufacturer:'bosch',serialNumber:'0001',
  agvPosition:{...robotPose,x:2.686,y:1.490,theta:-1.331,mapId:''},
};
const ready=(patch:Partial<OrderGenerationPrerequisites>={}):OrderGenerationPrerequisites=>({
  mqttConnected:true,connectionOnline:true,operatingMode:'AUTOMATIC',stateAgeMs:100,
  maximumStateAgeMs:defaultOrderSettings.stateStaleTimeoutMs,lastStateReceiveTime:10_000,
  positionInitialized:true,pose:{pose:robotPose,source:'state',receivedAtMs:10_000},
  activeMapId:mapId,activeMapSource:'state',stateMapId:mapId,visualizationMapId:null,
  lastKnownValidNavigatorMapId:mapId,loadedLocatorMapName:mapId,...patch,
});

describe('local MQTT receive freshness',()=>{
  it('uses the configured Bosch v2 identity topics',()=>{
    expect(defaultMqttSettings.topics).toMatchObject({
      state:'uagv/v2/bosch/0001/state',
      visualization:'uagv/v2/bosch/0001/visualization',
      connection:'uagv/v2/bosch/0001/connection',
    });
  });
  it('uses local receive time to update age',()=>{
    expect(getLocalMessageAgeMs(20_000,20_125)).toBe(125);
    expect(isLocalMessageFresh(20_000,10_000,20_125)).toBe(true);
  });
  it('records state and visualization local receive times separately',()=>{
    const empty={
      lastStateReceiveTime:null,lastVisualizationReceiveTime:null,
      statePayloadTimestamp:null,visualizationPayloadTimestamp:null,
    };
    const afterState=recordStateReceive(empty,'1999-01-01T00:00:00.000Z',12_000);
    const afterVisualization=recordVisualizationReceive(afterState,'2099-01-01T00:00:00.000Z',12_100);
    expect(afterVisualization).toEqual({
      lastStateReceiveTime:12_000,lastVisualizationReceiveTime:12_100,
      statePayloadTimestamp:'1999-01-01T00:00:00.000Z',
      visualizationPayloadTimestamp:'2099-01-01T00:00:00.000Z',
    });
  });
  it('does not use the remote payload timestamp as freshness input',()=>{
    expect(state.timestamp).toBe('1999-01-01T00:00:00.000Z');
    expect(getLocalMessageAgeMs(50_000,50_010)).toBe(10);
  });
  it('defaults the stale threshold to ten seconds',()=>{
    expect(defaultOrderSettings.stateStaleTimeoutMs).toBe(10_000);
  });
  it('allows fresh state and rejects stale state',()=>{
    expect(getOrderGenerationIssues(ready()).some((issue)=>issue.code==='generation.stateStale')).toBe(false);
    const issue=getOrderGenerationIssues(ready({stateAgeMs:10_001}))
      .find((candidate)=>candidate.code==='generation.stateStale');
    expect(issue?.details).toMatchObject({stateAgeMs:10_001,stateStaleTimeoutMs:10_000});
  });
});

describe('Navigator map resolution',()=>{
  it('normalizes non-empty IDs and rejects empty values',()=>{
    expect(normalizeMapId(`  ${mapId} `)).toBe(mapId);
    expect(normalizeMapId(' \t ')).toBeNull();
    expect(normalizeMapId(undefined)).toBeNull();
  });
  it('gives a fresh state map priority over visualization',()=>{
    expect(resolveActiveNavigatorMap({
      stateMapId:mapId,visualizationMapId:'other',lastKnownValidMapId:'older',
      confirmedBinding:null,...identity,
    })).toEqual({mapId,source:'state'});
  });
  it('allows a fresh visualization map when state has none or is stale',()=>{
    expect(resolveActiveNavigatorMap({
      stateMapId:null,visualizationMapId:'visual-map',lastKnownValidMapId:null,
      confirmedBinding:null,...identity,
    })).toEqual({mapId:'visual-map',source:'visualization'});
  });
  it('uses last-known and then an explicit manual fallback',()=>{
    expect(resolveActiveNavigatorMap({
      stateMapId:null,visualizationMapId:null,lastKnownValidMapId:mapId,
      confirmedBinding:{...identity,locatorMapName:'manual',confirmedAt:new Date().toISOString()},
      ...identity,
    })).toEqual({mapId,source:'last-known'});
    expect(resolveActiveNavigatorMap({
      stateMapId:null,visualizationMapId:null,lastKnownValidMapId:null,
      confirmedBinding:{...identity,locatorMapName:'manual',confirmedAt:new Date().toISOString()},
      ...identity,
    })).toEqual({mapId:'manual',source:'manual-confirmed'});
  });
  it('compares Locator and Navigator map names exactly after trimming',()=>{
    expect(compareMapIds(` ${mapId} `,mapId).matches).toBe(true);
    expect(compareMapIds(mapId,'other').matches).toBe(false);
  });
  it('returns only the primary map error when Navigator mapId is empty',()=>{
    const codes=getOrderGenerationIssues(ready({
      activeMapId:null,stateMapId:null,visualizationMapId:null,lastKnownValidNavigatorMapId:null,
    })).map((issue)=>issue.code);
    expect(codes).toContain('generation.mapId');
    expect(codes).not.toContain('generation.locatorMapMismatch');
    expect(codes).not.toContain('generation.locatorMapMissing');
  });
  it('reports detailed Locator mismatch only after an active map exists',()=>{
    const mismatch=getOrderGenerationIssues(ready({loadedLocatorMapName:'other'}))
      .find((issue)=>issue.code==='generation.locatorMapMismatch');
    expect(mismatch?.message).toContain(`"${mapId}"`);
    expect(mismatch?.details).toMatchObject({loadedLocatorMap:'other',activeNavigatorMapId:mapId});
  });
});

describe('pose and identity safety',()=>{
  it('uses fresh visualization pose with the authoritative state mapId',()=>{
    const active=resolveActiveNavigatorMap({
      stateMapId:mapId,visualizationMapId:null,lastKnownValidMapId:mapId,
      confirmedBinding:null,...identity,
    });
    const selected=selectCurrentRobotPose({
      state,visualization,lastStateReceiveTime:100,lastVisualizationReceiveTime:200,
      stateFresh:true,visualizationFresh:true,activeMapResolution:active,
    });
    expect(selected).toMatchObject({
      source:'visualization',mapIdSource:'state',
      pose:{x:2.686,y:1.490,theta:-1.331,mapId},
    });
  });
  it('does not select stale visualization over a fresh state pose',()=>{
    expect(selectCurrentRobotPose({
      state,visualization,lastStateReceiveTime:200,lastVisualizationReceiveTime:300,
      stateFresh:true,visualizationFresh:false,
      activeMapResolution:{mapId,source:'state'},
    })?.source).toBe('state');
  });
  it('blocks generation for a non-finite pose',()=>{
    const codes=getOrderGenerationIssues(ready({
      pose:{pose:{...robotPose,x:Number.NaN},source:'state',receivedAtMs:1},
    })).map((issue)=>issue.code);
    expect(codes).toContain('generation.pose');
  });
  it('rejects mismatched manufacturer, serial number, or version',()=>{
    const identity={manufacturer:'bosch',serialNumber:'0001',version:'2.0.0'};
    expect(payloadMatchesRobotIdentity(state,identity)).toBe(true);
    expect(payloadMatchesRobotIdentity({...state,manufacturer:'other'},identity)).toBe(false);
    expect(payloadMatchesRobotIdentity({...state,serialNumber:'0002'},identity)).toBe(false);
    expect(payloadMatchesRobotIdentity({...state,version:'1.1.0'},identity)).toBe(false);
  });
});

describe('map cache state transitions',()=>{
  beforeEach(()=>{
    const store=useAppStore.getState();
    store.resetRobotSession();
    store.setRobotIdentity('temporary','identity');
    store.setRobotIdentity('bosch','0001');
  });
  it('stores a valid state mapId and ignores a following empty state mapId',()=>{
    const store=useAppStore.getState();
    store.recordNavigatorMapId(mapId,'state','bosch','0001');
    store.recordNavigatorMapId('  ','state','bosch','0001');
    expect(useAppStore.getState()).toMatchObject({
      stateMapId:null,lastKnownValidNavigatorMapId:mapId,lastKnownValidNavigatorMapSource:'state',
    });
  });
  it('does not let empty visualization erase the valid cached state map',()=>{
    const store=useAppStore.getState();
    store.recordNavigatorMapId(mapId,'state','bosch','0001');
    store.recordNavigatorMapId('','visualization','bosch','0001');
    expect(useAppStore.getState().lastKnownValidNavigatorMapId).toBe(mapId);
  });
  it('clears cached identity-bound map state when robot identity changes',()=>{
    const store=useAppStore.getState();
    store.recordNavigatorMapId(mapId,'state','bosch','0001');
    store.setRobotIdentity('bosch','0002');
    expect(useAppStore.getState().lastKnownValidNavigatorMapId).toBeNull();
  });
  it('preserves last valid map through MQTT reconnect status changes',()=>{
    const store=useAppStore.getState();
    store.recordNavigatorMapId(mapId,'state','bosch','0001');
    store.set({mqttConnected:false});
    store.set({mqttConnected:true});
    expect(useAppStore.getState().lastKnownValidNavigatorMapId).toBe(mapId);
  });
});

describe('empty-visualization regression',()=>{
  it('keeps the SendBox map match while using the smoother visualization pose',()=>{
    const active=resolveActiveNavigatorMap({
      stateMapId:state.agvPosition?.mapId??null,
      visualizationMapId:visualization.agvPosition?.mapId??null,
      lastKnownValidMapId:mapId,confirmedBinding:null,...identity,
    });
    const pose=selectCurrentRobotPose({
      state,visualization,lastStateReceiveTime:100,lastVisualizationReceiveTime:200,
      stateFresh:true,visualizationFresh:true,activeMapResolution:active,
    });
    const codes=getOrderGenerationIssues(ready({pose,activeMapId:active.mapId,activeMapSource:active.source}))
      .map((issue)=>issue.code);
    expect(active).toEqual({mapId,source:'state'});
    expect(pose?.source).toBe('visualization');
    expect(pose?.pose.mapId).toBe(mapId);
    expect(compareMapIds(mapId,active.mapId).matches).toBe(true);
    expect(codes).not.toContain('generation.mapId');
    expect(codes).not.toContain('generation.locatorMapMismatch');
  });
});
