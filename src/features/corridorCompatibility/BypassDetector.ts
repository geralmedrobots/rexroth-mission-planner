import type { PathPoint, VdaOrder } from '../../domain/types';
import type { NavigatorPathCandidate } from './types';

export interface BypassDetectorOptions {
  thresholdM:number;
  requiredDeviationMessages:number;
  requiredRejoinMessages:number;
  visualizationStaleTimeoutMs:number;
}

export interface BypassDetectorState {
  maximumLateralDeviationM:number;
  consecutiveDeviationMessages:number;
  consecutiveRejoinMessages:number;
  deviationObserved:boolean;
  firstDeviationTimestamp?:string;
  bypassDetected:boolean;
  bypassDurationMs?:number;
  rejoinPoint?:PathPoint;
}

export const initialBypassDetectorState=():BypassDetectorState=>({
  maximumLateralDeviationM:0,consecutiveDeviationMessages:0,consecutiveRejoinMessages:0,
  deviationObserved:false,bypassDetected:false,
});

const segmentDistance=(point:PathPoint,start:PathPoint,end:PathPoint):number=>{
  const dx=end.x-start.x;const dy=end.y-start.y;
  const lengthSquared=dx*dx+dy*dy;
  if(lengthSquared===0)return Math.hypot(point.x-start.x,point.y-start.y);
  const t=Math.max(0,Math.min(1,
    ((point.x-start.x)*dx+(point.y-start.y)*dy)/lengthSquared));
  return Math.hypot(point.x-(start.x+t*dx),point.y-(start.y+t*dy));
};

export const lateralDistanceToOrderPath=(point:PathPoint,order:VdaOrder):number=>{
  if(order.nodes.length<2)return Number.POSITIVE_INFINITY;
  let minimum=Number.POSITIVE_INFINITY;
  for(let index=0;index<order.nodes.length-1;index+=1){
    const start=order.nodes[index]!.nodePosition;
    const end=order.nodes[index+1]!.nodePosition;
    minimum=Math.min(minimum,segmentDistance(point,start,end));
  }
  return minimum;
};

export const updateBypassDetector=(
  previous:BypassDetectorState,
  point:PathPoint,
  order:VdaOrder,
  receivedAtMs:number,
  nowMs:number,
  options:BypassDetectorOptions,
):BypassDetectorState=>{
  if(nowMs-receivedAtMs>options.visualizationStaleTimeoutMs)return previous;
  const distance=lateralDistanceToOrderPath(point,order);
  if(!Number.isFinite(distance))return previous;
  const timestamp=new Date(receivedAtMs).toISOString();
  if(distance>options.thresholdM){
    const count=previous.consecutiveDeviationMessages+1;
    const observed=previous.deviationObserved||count>=options.requiredDeviationMessages;
    return {
      ...previous,maximumLateralDeviationM:Math.max(previous.maximumLateralDeviationM,distance),
      consecutiveDeviationMessages:count,consecutiveRejoinMessages:0,
      deviationObserved:observed,
      firstDeviationTimestamp:previous.firstDeviationTimestamp??timestamp,
    };
  }
  if(!previous.deviationObserved)return {
    ...previous,maximumLateralDeviationM:Math.max(previous.maximumLateralDeviationM,distance),
    consecutiveDeviationMessages:0,
  };
  const rejoinCount=previous.consecutiveRejoinMessages+1;
  const bypassDetected=previous.bypassDetected||rejoinCount>=options.requiredRejoinMessages;
  const firstDeviationMs=previous.firstDeviationTimestamp
    ?Date.parse(previous.firstDeviationTimestamp):receivedAtMs;
  return {
    ...previous,maximumLateralDeviationM:Math.max(previous.maximumLateralDeviationM,distance),
    consecutiveDeviationMessages:0,consecutiveRejoinMessages:rejoinCount,bypassDetected,
    ...(bypassDetected?{
      bypassDurationMs:Math.max(0,receivedAtMs-firstDeviationMs),
      rejoinPoint:{...point},
    }:{}),
  };
};

const isRecord=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);

const pointFromUnknown=(value:unknown):PathPoint|null=>{
  if(!isRecord(value)||!Number.isFinite(value.x)||!Number.isFinite(value.y))return null;
  return {
    x:value.x as number,y:value.y as number,
    theta:Number.isFinite(value.theta)?value.theta as number:0,
  };
};

/** Discovers geometry arrays without assuming an undocumented Bosch field name. */
export const findNavigatorPathCandidates=(raw:unknown):NavigatorPathCandidate[]=>{
  const found:NavigatorPathCandidate[]=[];
  const visit=(value:unknown,path:string,depth:number):void=>{
    if(depth>8)return;
    if(Array.isArray(value)){
      const points=value.map(pointFromUnknown);
      if(points.length>=2&&points.every((point)=>point!==null))
        found.push({jsonPath:path,points:points as PathPoint[]});
      value.forEach((item,index)=>visit(item,`${path}[${index}]`,depth+1));
      return;
    }
    if(isRecord(value))
      Object.entries(value).forEach(([key,item])=>visit(item,`${path}.${key}`,depth+1));
  };
  visit(raw,'$',0);
  return found;
};

