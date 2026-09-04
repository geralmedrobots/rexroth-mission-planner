import { beforeEach, describe, expect, it } from 'vitest';
import { defaultOrderSettings } from '../domain/defaults';
import { resolveActiveNavigatorMapId } from '../domain/robot/ActiveMapResolver';
import type { ConfirmedMapBinding, RobotPose } from '../domain/types';
import { getOrderGenerationIssues, type OrderGenerationPrerequisites } from '../domain/vda5050/OrderGenerationGuard';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { useAppStore } from '../stores/appStore';

const identity={manufacturer:'bosch',serialNumber:'0001'};
const locatorMapName='SendBox_2026-07-23_11-35-45_built_001';
const binding:ConfirmedMapBinding={
  ...identity,locatorMapName,confirmedAt:'2026-07-23T15:00:00.000Z',
};
const resolve=(patch:Partial<Parameters<typeof resolveActiveNavigatorMapId>[0]>={})=>
  resolveActiveNavigatorMapId({
    stateMapId:null,visualizationMapId:null,lastKnownValidMapId:null,
    confirmedBinding:null,...identity,...patch,
  });
const robotPose:RobotPose={
  x:2.685,y:1.489,theta:-1.33,mapId:locatorMapName,positionInitialized:true,
};
const prerequisites=(patch:Partial<OrderGenerationPrerequisites>={}):OrderGenerationPrerequisites=>({
  mqttConnected:true,connectionOnline:true,operatingMode:'AUTOMATIC',stateAgeMs:100,
  maximumStateAgeMs:10_000,positionInitialized:true,
  pose:{pose:robotPose,source:'visualization',receivedAtMs:1_000,mapIdSource:'manual-confirmed'},
  activeMapId:locatorMapName,activeMapSource:'manual-confirmed',
  stateMapId:null,visualizationMapId:null,lastKnownValidNavigatorMapId:null,
  confirmedMapBinding:binding,loadedLocatorMapName:locatorMapName,...patch,
});

describe('confirmed Navigator map binding resolution',()=>{
  it('gives state mapId highest priority',()=>{
    expect(resolve({
      stateMapId:'state-map',visualizationMapId:'visual-map',lastKnownValidMapId:'known',
      confirmedBinding:binding,
    })).toEqual({mapId:'state-map',source:'state'});
  });
  it('uses visualization when state mapId is empty',()=>{
    expect(resolve({stateMapId:' ',visualizationMapId:'visual-map',confirmedBinding:binding}))
      .toEqual({mapId:'visual-map',source:'visualization'});
  });
  it('uses last-known MQTT mapId before a binding',()=>{
    expect(resolve({lastKnownValidMapId:'known-map',confirmedBinding:binding}))
      .toEqual({mapId:'known-map',source:'last-known'});
  });
  it('uses a confirmed binding only when MQTT sources are absent',()=>{
    expect(resolve({confirmedBinding:binding}))
      .toEqual({mapId:locatorMapName,source:'manual-confirmed'});
  });
  it('does not infer mapId from a loaded Locator map alone',()=>{
    expect(resolve()).toEqual({mapId:null,source:'none'});
  });
  it('scopes bindings to manufacturer and serial number',()=>{
    expect(resolve({confirmedBinding:{...binding,serialNumber:'0002'}}))
      .toEqual({mapId:null,source:'none'});
    expect(resolve({confirmedBinding:{...binding,manufacturer:'other'}}))
      .toEqual({mapId:null,source:'none'});
  });
  it('valid MQTT mapId overrides a manual binding',()=>{
    expect(resolve({stateMapId:'mqtt-map',confirmedBinding:binding}))
      .toEqual({mapId:'mqtt-map',source:'state'});
  });
});

describe('confirmed binding lifecycle',()=>{
  beforeEach(()=>{
    const store=useAppStore.getState();
    store.setRobotIdentity('temporary','robot');
    store.setRobotIdentity(identity.manufacturer,identity.serialNumber);
    store.clearConfirmedMapBinding();
  });
  it('requires the explicit confirmation action',()=>{
    expect(useAppStore.getState().confirmedMapBinding).toBeNull();
    useAppStore.getState().confirmMapBinding(
      locatorMapName,identity.manufacturer,identity.serialNumber);
    expect(useAppStore.getState().confirmedMapBinding).toMatchObject({
      ...identity,locatorMapName,
    });
  });
  it('clears and warns when a different MQTT mapId arrives',()=>{
    const store=useAppStore.getState();
    store.confirmMapBinding(locatorMapName,identity.manufacturer,identity.serialNumber);
    store.recordNavigatorMapId('different-mqtt-map','state',identity.manufacturer,identity.serialNumber);
    expect(useAppStore.getState().confirmedMapBinding).toBeNull();
    expect(useAppStore.getState().mapBindingMismatchWarning).toContain('different-mqtt-map');
  });
  it('returns generation.mapId again after clearing the binding',()=>{
    const store=useAppStore.getState();
    store.confirmMapBinding(locatorMapName,identity.manufacturer,identity.serialNumber);
    store.clearConfirmedMapBinding();
    const codes=getOrderGenerationIssues(prerequisites({
      activeMapId:null,activeMapSource:'none',confirmedMapBinding:null,
    })).map((issue)=>issue.code);
    expect(codes).toContain('generation.mapId');
  });
});

describe('order generation with a confirmed binding',()=>{
  it('uses the resolved mapId for every generated VDA node',()=>{
    const resolved=resolve({confirmedBinding:binding});
    const order=new VdaOrderBuilder().build([
      {x:2.685,y:1.489,theta:-1.33},{x:3,y:1.2,theta:-.7},
    ],{robotPose,activeMapId:resolved.mapId!},defaultOrderSettings);
    expect(order.nodes.every((node)=>node.nodePosition.mapId===locatorMapName)).toBe(true);
  });
  it('emits a warning without blocking generation',()=>{
    const issues=getOrderGenerationIssues(prerequisites());
    expect(issues.filter((issue)=>issue.severity==='error')).toEqual([]);
    expect(issues.filter((issue)=>issue.code==='generation.mapIdManualBinding'))
      .toEqual([expect.objectContaining({severity:'warning'})]);
  });
});
