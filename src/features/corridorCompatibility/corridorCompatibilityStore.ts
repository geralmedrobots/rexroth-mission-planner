import { create } from 'zustand';
import type { PathPoint, VdaError, VdaOrder, VdaState, VdaVisualization } from '../../domain/types';
import {
  initialBypassDetectorState, updateBypassDetector, type BypassDetectorState,
  findNavigatorPathCandidates,
} from './BypassDetector';
import type {
  CorridorCompatibilityLog, CorridorCompatibilityLogSource, CorridorCompatibilityResult,
  CorridorCompatibilitySettings, CorridorTestVariant, ExactMqttPayloadCapture,
} from './types';

export const defaultCorridorCompatibilitySettings:CorridorCompatibilitySettings={
  bypassDetectionThresholdM:0.15,
  requiredDeviationMessages:3,
  requiredRejoinMessages:2,
  visualizationStaleTimeoutMs:10_000,
  acceptanceTimeoutMs:5_000,
};

interface CompatibilitySession {
  baseOrder?:VdaOrder;
  activeOrder?:VdaOrder;
  activeVariant?:CorridorTestVariant;
  activePayload?:ExactMqttPayloadCapture;
  bypassState:BypassDetectorState;
}

interface CorridorCompatibilityState extends CompatibilitySession {
  settings:CorridorCompatibilitySettings;
  exactPayload?:ExactMqttPayloadCapture;
  results:CorridorCompatibilityResult[];
  logs:CorridorCompatibilityLog[];
  setSettings:(patch:Partial<CorridorCompatibilitySettings>)=>void;
  addLog:(source:CorridorCompatibilityLogSource,level:CorridorCompatibilityLog['level'],
    message:string,context?:Record<string,unknown>)=>void;
  prepare:(baseOrder:VdaOrder,order:VdaOrder,variant:CorridorTestVariant,
    payload:ExactMqttPayloadCapture)=>void;
  markSent:()=>void;
  markPublishFailure:(message:string)=>void;
  receiveState:(state:VdaState,receivedAtMs:number,stateAgeMs:number,
    visualizationAgeMs:number)=>void;
  receiveVisualization:(visualization:VdaVisualization,raw:unknown,receivedAtMs:number)=>void;
  evaluateTimeout:(nowMs:number)=>void;
  resetSession:()=>void;
  clearResults:()=>void;
}

const refsOrder=(error:VdaError,orderId:string):boolean=>
  (error.errorReferences??[]).some((reference)=>
    reference.referenceKey.toLowerCase().endsWith('orderid')&&reference.referenceValue===orderId);

const hasCorridorKey=(value:unknown,depth=0):boolean=>{
  if(depth>10||value===null||typeof value!=='object')return false;
  if(Array.isArray(value))return value.some((item)=>hasCorridorKey(item,depth+1));
  const record=value as Record<string,unknown>;
  return Object.hasOwn(record,'corridor')||
    Object.values(record).some((item)=>hasCorridorKey(item,depth+1));
};

const addLogToState=(
  state:CorridorCompatibilityState,
  source:CorridorCompatibilityLogSource,
  level:CorridorCompatibilityLog['level'],
  message:string,
  context?:Record<string,unknown>,
):CorridorCompatibilityLog[]=>[
  ...state.logs.slice(-999),{
    id:crypto.randomUUID(),timestamp:new Date().toISOString(),source,level,message,
    orderId:state.activeOrder?.orderId,variant:state.activeVariant,context,
  },
];

const createLog=(
  state:CorridorCompatibilityState,
  source:CorridorCompatibilityLogSource,
  level:CorridorCompatibilityLog['level'],
  message:string,
  context?:Record<string,unknown>,
):CorridorCompatibilityLog=>({
  id:crypto.randomUUID(),timestamp:new Date().toISOString(),source,level,message,
  orderId:state.activeOrder?.orderId,variant:state.activeVariant,context,
});

const updateActiveResult=(
  state:CorridorCompatibilityState,
  update:(result:CorridorCompatibilityResult)=>CorridorCompatibilityResult,
):CorridorCompatibilityResult[]=>state.results.map((result)=>
  result.orderId===state.activeOrder?.orderId?update(result):result);

export const useCorridorCompatibilityStore=create<CorridorCompatibilityState>((set)=>({
  settings:defaultCorridorCompatibilitySettings,
  bypassState:initialBypassDetectorState(),results:[],logs:[],
  setSettings:(patch)=>set((state)=>({settings:{...state.settings,...patch}})),
  addLog:(source,level,message,context)=>set((state)=>({
    logs:addLogToState(state,source,level,message,context),
  })),
  prepare:(baseOrder,order,variant,payload)=>set((state)=>({
    baseOrder:state.baseOrder??structuredClone(baseOrder),
    activeOrder:order,activeVariant:variant,activePayload:payload,exactPayload:payload,
    bypassState:initialBypassDetectorState(),
    logs:addLogToState({...state,activeOrder:order,activeVariant:variant},
      'OrderBuilder','info','Controlled corridor compatibility Order prepared.',{
        headerId:order.headerId,protocolVersion:order.version,nodeCount:order.nodes.length,
        edgeCount:order.edges.length,
      }),
  })),
  markSent:()=>set((state)=>{
    const payload=state.activePayload;const order=state.activeOrder;const variant=state.activeVariant;
    if(!payload||!order||!variant)return {};
    const result:CorridorCompatibilityResult={
      id:crypto.randomUUID(),variant,orderId:order.orderId,headerId:order.headerId,
      status:'SENT',sentAt:new Date().toISOString(),corridorSent:payload.corridorCount>0,
      corridorCount:payload.corridorCount,navigatorCorridorEchoObserved:false,
      navigatorPathChanged:false,bypassDetected:false,
      maximumLateralDeviationM:0,navigatorErrors:[],navigatorPathCandidates:[],
      navigatorPoseTrace:[],
    };
    return {
      results:[...state.results.filter((item)=>item.orderId!==order.orderId),result],
      logs:addLogToState(state,'MqttPublisher','info','Exact serialized payload sent.',{
        topic:payload.topic,corridorFieldsPresent:payload.corridorExistsInRawPayload,
        corridorCount:payload.corridorCount,payloadBytes:payload.payloadBytes,
      }),
    };
  }),
  markPublishFailure:(message)=>set((state)=>({
    logs:addLogToState(state,'MqttPublisher','error',message),
    results:updateActiveResult(state,(result)=>({...result,status:'UNKNOWN',error:message})),
  })),
  receiveState:(stateMessage,receivedAtMs,stateAgeMs,visualizationAgeMs)=>set((state)=>{
    if(!state.activeOrder||!state.activeVariant)return {};
    const order=state.activeOrder;
    const relatedErrors=(stateMessage.errors??[]).filter((error)=>refsOrder(error,order.orderId));
    const accepted=stateMessage.orderId===order.orderId;
    const finalSequence=order.nodes.at(-1)?.sequenceId??Number.POSITIVE_INFINITY;
    const completed=accepted&&(stateMessage.lastNodeSequenceId??-1)>=finalSequence&&!stateMessage.driving;
    const activeResult=state.results.find((result)=>result.orderId===order.orderId);
    const stoppedAfterMotion=accepted&&activeResult?.status==='ACTIVE'&&!stateMessage.driving&&
      !stateMessage.paused&&!completed;
    const status=relatedErrors.length?'REJECTED':completed?'COMPLETED':
      stoppedAfterMotion?'BLOCKED':accepted&&stateMessage.driving?'ACTIVE':
        accepted?'ACCEPTED':undefined;
    const nowIso=new Date(receivedAtMs).toISOString();
    return {
      results:updateActiveResult(state,(result)=>({
        ...result,
        ...(status?{status}:{}),
        ...(accepted&&!result.acceptedAt?{acceptedAt:nowIso}:{}),
        ...(completed?{completedAt:nowIso}:{}),
        navigatorErrors:relatedErrors,
        navigatorCorridorEchoObserved:
          result.navigatorCorridorEchoObserved||hasCorridorKey(stateMessage),
        error:relatedErrors.map((error)=>error.errorDescription??error.errorType).join(' | ')||result.error,
        lastState:{
          orderId:stateMessage.orderId,lastNodeId:stateMessage.lastNodeId,
          lastNodeSequenceId:stateMessage.lastNodeSequenceId,driving:stateMessage.driving,
          paused:stateMessage.paused,operatingMode:stateMessage.operatingMode,
        },
        lastStateAgeMs:stateAgeMs,lastVisualizationAgeMs:visualizationAgeMs,
      })),
      logs:addLogToState(state,relatedErrors.length?'NavigatorErrors':'NavigatorState',
        relatedErrors.length?'error':'debug',
        relatedErrors.length?'Navigator reported errors referencing this test Order.':
          accepted?'Navigator state contains the test orderId.':'State received; test orderId not active.',{
          stateOrderId:stateMessage.orderId??'',lastNodeId:stateMessage.lastNodeId??'',
          driving:stateMessage.driving??false,paused:stateMessage.paused??false,
          operatingMode:stateMessage.operatingMode??'',stateAgeMs,visualizationAgeMs,
          currentErrors:stateMessage.errors??[],correlatedErrors:relatedErrors,
        }),
    };
  }),
  receiveVisualization:(visualization,raw,receivedAtMs)=>set((state)=>{
    const order=state.activeOrder;
    const currentResult=state.results.find((result)=>result.orderId===order?.orderId);
    const pose=visualization.agvPosition;
    if(!order||!currentResult?.acceptedAt||!pose)return {};
    const point:PathPoint={x:pose.x,y:pose.y,theta:pose.theta};
    const bypassState=updateBypassDetector(
      state.bypassState,point,order,receivedAtMs,Date.now(),{
        thresholdM:state.settings.bypassDetectionThresholdM,
        requiredDeviationMessages:state.settings.requiredDeviationMessages,
        requiredRejoinMessages:state.settings.requiredRejoinMessages,
        visualizationStaleTimeoutMs:state.settings.visualizationStaleTimeoutMs,
      });
    const candidates=findNavigatorPathCandidates(raw);
    const changed=bypassState.deviationObserved;
    const navigatorLog=createLog(state,'NavigatorVisualization','debug',
      'Navigator-provided visualization received for the accepted test Order.',{
        receivedAt:new Date(receivedAtMs).toISOString(),x:point.x,y:point.y,theta:point.theta,
        discoveredGeometryPaths:candidates.map((candidate)=>candidate.jsonPath),
      });
    const detectorLog=createLog(state,'BypassDetector','debug',
      bypassState.bypassDetected?'Persistent lateral deviation and route rejoin detected.':
        'Navigator visualization compared with the original Order path.',{
        maximumLateralDeviationM:bypassState.maximumLateralDeviationM,
        thresholdM:state.settings.bypassDetectionThresholdM,
        deviationMessages:bypassState.consecutiveDeviationMessages,
        rejoinMessages:bypassState.consecutiveRejoinMessages,
        bypassDetected:bypassState.bypassDetected,
        discoveredGeometryPaths:candidates.map((candidate)=>candidate.jsonPath),
      });
    return {
      bypassState,
      results:updateActiveResult(state,(result)=>({
        ...result,status:bypassState.bypassDetected?'BYPASS_GENERATED':result.status,
        navigatorCorridorEchoObserved:
          result.navigatorCorridorEchoObserved||hasCorridorKey(raw),
        navigatorPathChanged:changed,bypassDetected:bypassState.bypassDetected,
        maximumLateralDeviationM:bypassState.maximumLateralDeviationM,
        firstDeviationTimestamp:bypassState.firstDeviationTimestamp,
        bypassDurationMs:bypassState.bypassDurationMs,rejoinPoint:bypassState.rejoinPoint,
        navigatorPathCandidates:candidates,
        navigatorPoseTrace:[...result.navigatorPoseTrace.slice(-999),point],
        lastVisualizationAgeMs:0,
      })),
      logs:[...state.logs.slice(-998),navigatorLog,detectorLog],
    };
  }),
  evaluateTimeout:(nowMs)=>set((state)=>{
    const active=state.results.find((result)=>result.orderId===state.activeOrder?.orderId);
    if(!active||active.status!=='SENT'||nowMs-Date.parse(active.sentAt)<=state.settings.acceptanceTimeoutMs)
      return {};
    return {
      results:updateActiveResult(state,(result)=>({...result,status:'UNKNOWN',
        error:`No correlated acceptance or rejection within ${state.settings.acceptanceTimeoutMs} ms.`})),
      logs:addLogToState(state,'NavigatorState','warning','Compatibility test acceptance timed out.'),
    };
  }),
  resetSession:()=>set({
    baseOrder:undefined,activeOrder:undefined,activeVariant:undefined,activePayload:undefined,
    bypassState:initialBypassDetectorState(),
  }),
  clearResults:()=>set({results:[],logs:[],exactPayload:undefined}),
}));
