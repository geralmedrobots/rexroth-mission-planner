import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VdaOrder, VdaState, VdaVisualization } from '../domain/types';
import {
  createCorridorTestOrder, getCorridorCompatibilityReport, serializeCorridorTestOrder,
  getCorridorCompatibilityConclusion,
} from '../features/corridorCompatibility/CorridorCompatibilityService';
import {
  initialBypassDetectorState, lateralDistanceToOrderPath, updateBypassDetector,
} from '../features/corridorCompatibility/BypassDetector';
import {
  getCompatibilitySpecificDispatchIssues,
} from '../features/corridorCompatibility/CompatibilityDispatchGate';
import {
  defaultCorridorCompatibilitySettings, useCorridorCompatibilityStore,
} from '../features/corridorCompatibility/corridorCompatibilityStore';
import { mqttService } from '../services/MqttService';

const baseOrder=():VdaOrder=>({
  headerId:10,timestamp:'2026-07-27T10:00:00.000Z',version:'2.0.0',
  manufacturer:'bosch',serialNumber:'0001',orderId:'base-order',orderUpdateId:0,
  nodes:[
    {nodeId:'node-0',sequenceId:0,released:true,nodePosition:{
      x:0,y:0,theta:0,allowedDeviationXy:.2,allowedDeviationTheta:.35,mapId:'map-a',
    },actions:[]},
    {nodeId:'node-1',sequenceId:2,released:true,nodePosition:{
      x:2,y:0,theta:0,allowedDeviationXy:.2,allowedDeviationTheta:.35,mapId:'map-a',
    },actions:[]},
  ],
  edges:[{edgeId:'edge-0',sequenceId:1,released:true,startNodeId:'node-0',
    endNodeId:'node-1',maxSpeed:.05,rotationAllowed:true,corridor:{
      leftWidth:.45,rightWidth:.3,corridorRefPoint:'KINEMATICCENTER',
    },actions:[]}],
});
const withoutCorridor=(order:VdaOrder)=>order.edges.map((edge)=>({
  edgeId:edge.edgeId,sequenceId:edge.sequenceId,released:edge.released,
  startNodeId:edge.startNodeId,endNodeId:edge.endNodeId,maxSpeed:edge.maxSpeed,
  rotationAllowed:edge.rotationAllowed,actions:edge.actions,
}));

describe('ROKIT corridor compatibility variants and wire payload',()=>{
  it('keeps the route model and changes only controlled envelope fields',()=>{
    const source=baseOrder();
    const baseline=createCorridorTestOrder(source,'baseline');
    const current=createCorridorTestOrder(source,'current-corridor');
    const narrow=createCorridorTestOrder(source,'narrow-corridor');
    const wide=createCorridorTestOrder(source,'wide-corridor');
    const asymmetric=createCorridorTestOrder(source,'asymmetric-corridor');
    for(const order of [baseline,current,narrow,wide,asymmetric]){
      expect(order.version).toBe('2.0.0');
      expect(order.orderUpdateId).toBe(0);
      expect(order.nodes).toEqual(source.nodes);
      expect(withoutCorridor(order)).toEqual(withoutCorridor(source));
      expect(order.orderId).not.toBe(source.orderId);
      expect(order).not.toHaveProperty('trajectory');
    }
    expect(baseline.edges[0]).not.toHaveProperty('corridor');
    expect(current.edges[0]?.corridor).toEqual(source.edges[0]?.corridor);
    expect(narrow.edges[0]?.corridor).toMatchObject({leftWidth:.2,rightWidth:.2});
    expect(wide.edges[0]?.corridor).toMatchObject({leftWidth:1,rightWidth:1});
    expect(asymmetric.edges[0]?.corridor).toMatchObject({leftWidth:.1,rightWidth:1});
  });

  it('uses a unique orderId and monotonically incremented headerId per test',()=>{
    const first=createCorridorTestOrder(baseOrder(),'baseline');
    const second=createCorridorTestOrder(baseOrder(),'wide-corridor');
    expect(first.orderId).not.toBe(second.orderId);
    expect(second.headerId).toBe(first.headerId+1);
  });

  it('captures the exact serialized MQTT payload and corridor evidence',async()=>{
    const order=createCorridorTestOrder(baseOrder(),'wide-corridor');
    const capture=serializeCorridorTestOrder(order,'wide-corridor',
      'uagv/v2/bosch/0001/order','2026-07-27T10:01:00.000Z');
    expect(capture.rawJson).toBe(JSON.stringify(order));
    expect(capture.corridorExistsBeforeSerialization).toBe(true);
    expect(capture.corridorExistsAfterSerialization).toBe(true);
    expect(capture.corridorExistsInRawPayload).toBe(true);
    expect(capture.corridorRefPoints).toEqual(['KINEMATICCENTER']);
    expect(capture.payloadBytes).toBe(new TextEncoder().encode(capture.rawJson).byteLength);
    const publish=vi.spyOn(mqttService,'publish').mockResolvedValueOnce();
    await mqttService.publish(capture.topic,capture.rawJson,1,false);
    expect(publish).toHaveBeenCalledWith(capture.topic,capture.rawJson,1,false);
    expect(JSON.parse(publish.mock.calls[0]![1]).edges[0].corridor)
      .toEqual({leftWidth:1,rightWidth:1,corridorRefPoint:'KINEMATICCENTER'});
  });

  it('reports the local schema evidence without claiming a Bosch schema',()=>{
    const report=getCorridorCompatibilityReport();
    expect(report.referencePointFieldName).toBe('corridorRefPoint');
    expect(report.enumValues).toContain('KINEMATICCENTER');
    expect(report.installedBoschSchemaConfirmation)
      .toBe('Not officially confirmed in the current repository.');
  });

  it('does not claim compatibility without comparative evidence',()=>{
    expect(getCorridorCompatibilityConclusion([])).toBe('inconclusive');
  });
});

describe('Navigator response correlation',()=>{
  beforeEach(()=>{
    useCorridorCompatibilityStore.getState().resetSession();
    useCorridorCompatibilityStore.getState().clearResults();
    useCorridorCompatibilityStore.getState().setSettings(defaultCorridorCompatibilitySettings);
  });

  const prepareSent=()=>{
    const source=baseOrder();
    const order=createCorridorTestOrder(source,'wide-corridor');
    const capture=serializeCorridorTestOrder(order,'wide-corridor','uagv/v2/bosch/0001/order');
    const store=useCorridorCompatibilityStore.getState();
    store.prepare(source,order,'wide-corridor',capture);store.markSent();
    return order;
  };

  it('accepts only a state carrying the exact sent orderId',()=>{
    const order=prepareSent();const store=useCorridorCompatibilityStore.getState();
    store.receiveState({orderId:'other',driving:false},Date.now(),0,0);
    expect(useCorridorCompatibilityStore.getState().results[0]?.status).toBe('SENT');
    store.receiveState({orderId:order.orderId,driving:false,lastNodeSequenceId:0},
      Date.now(),0,0);
    const result=useCorridorCompatibilityStore.getState().results[0]!;
    expect(result.status).toBe('ACCEPTED');
    expect(result.headerId).toBe(order.headerId);
    expect(result.acceptedAt).toBeDefined();
  });

  it('correlates an exact Navigator rejection by orderId reference',()=>{
    const order=prepareSent();
    useCorridorCompatibilityStore.getState().receiveState({orderId:'',errors:[{
      errorType:'OrderError',errorLevel:'FATAL',
      errorDescription:'First Node of the Order is not trivially reachable',
      errorReferences:[{referenceKey:'order.orderId',referenceValue:order.orderId}],
    }]},Date.now(),0,0);
    const result=useCorridorCompatibilityStore.getState().results[0]!;
    expect(result.status).toBe('REJECTED');
    expect(result.error).toBe('First Node of the Order is not trivially reachable');
  });

  it('does not correlate an error referencing another order',()=>{
    prepareSent();
    useCorridorCompatibilityStore.getState().receiveState({errors:[{
      errorType:'OrderError',errorLevel:'FATAL',
      errorReferences:[{referenceKey:'orderId',referenceValue:'another-order'}],
    }]},Date.now(),0,0);
    expect(useCorridorCompatibilityStore.getState().results[0]?.status).toBe('SENT');
  });
});

describe('conservative Navigator bypass detection',()=>{
  const options={thresholdM:.15,requiredDeviationMessages:3,requiredRejoinMessages:2,
    visualizationStaleTimeoutMs:10_000};
  it('calculates lateral distance and rejects movement along the global path as a bypass',()=>{
    const order=baseOrder();let state=initialBypassDetectorState();const now=Date.now();
    expect(lateralDistanceToOrderPath({x:1,y:.1,theta:0},order)).toBeCloseTo(.1);
    for(let index=0;index<8;index+=1)
      state=updateBypassDetector(state,{x:index/5,y:.05,theta:0},order,now+index,now+index,options);
    expect(state.bypassDetected).toBe(false);
    expect(state.deviationObserved).toBe(false);
  });

  it('requires persistent deviation followed by a persistent rejoin',()=>{
    const order=baseOrder();let state=initialBypassDetectorState();const now=Date.now();
    for(let index=0;index<3;index+=1)
      state=updateBypassDetector(state,{x:.5+index*.2,y:.3,theta:0},order,now+index,now+index,options);
    expect(state.deviationObserved).toBe(true);
    expect(state.bypassDetected).toBe(false);
    state=updateBypassDetector(state,{x:1.2,y:.02,theta:0},order,now+4,now+4,options);
    expect(state.bypassDetected).toBe(false);
    state=updateBypassDetector(state,{x:1.4,y:.01,theta:0},order,now+5,now+5,options);
    expect(state.bypassDetected).toBe(true);
    expect(state.rejoinPoint?.x).toBe(1.4);
  });

  it('ignores stale visualization samples',()=>{
    const previous=initialBypassDetectorState();
    const result=updateBypassDetector(previous,{x:1,y:1,theta:0},baseOrder(),
      1_000,20_000,options);
    expect(result).toEqual(previous);
  });
});

describe('compatibility dispatch safety',()=>{
  it('requires finite velocity Motion Feedback',()=>{
    const invalid:VdaState={velocity:{vx:0,omega:0}};
    expect(getCompatibilitySpecificDispatchIssues(invalid)[0]?.code)
      .toBe('compatibility.motionFeedback');
    expect(getCompatibilitySpecificDispatchIssues({
      velocity:{vx:0,vy:0,omega:0},
    })).toEqual([]);
  });

  it('updates a test to BYPASS_GENERATED only after acceptance and rejoin evidence',()=>{
    useCorridorCompatibilityStore.getState().resetSession();
    useCorridorCompatibilityStore.getState().clearResults();
    const source=baseOrder();const order=createCorridorTestOrder(source,'wide-corridor');
    const capture=serializeCorridorTestOrder(order,'wide-corridor','uagv/v2/bosch/0001/order');
    const store=useCorridorCompatibilityStore.getState();
    store.prepare(source,order,'wide-corridor',capture);store.markSent();
    store.receiveState({orderId:order.orderId,driving:true},Date.now(),0,0);
    const visualization=(x:number,y:number):VdaVisualization=>({
      headerId:1,timestamp:new Date().toISOString(),version:'2.0.0',
      manufacturer:'bosch',serialNumber:'0001',
      agvPosition:{x,y,theta:0,mapId:'map-a',positionInitialized:true},
    });
    for(const [x,y] of [[.5,.3],[.7,.3],[.9,.3],[1.1,.01],[1.3,.01]] as const)
      useCorridorCompatibilityStore.getState().receiveVisualization(
        visualization(x,y),visualization(x,y),Date.now());
    expect(useCorridorCompatibilityStore.getState().results[0]?.status)
      .toBe('BYPASS_GENERATED');
  });
});
