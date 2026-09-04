import type { VdaOrder, VdaState } from '../types';

export interface OutgoingEdgeSpeedDiagnostic {
  orderId:string;
  edgeIndex:number;
  edgeId:string;
  sequenceId:number;
  maxSpeed:number|null;
}

export interface SpeedCycleDiagnostic {
  timestamp:string;
  orderId:string|null;
  edgeId:string|null;
  edgeMaxSpeed:number|null;
  commandVelocityX:number|null;
  velocityX:number|null;
  allowedMaxLinearSpeed:number|null;
  allowedMaxAngularSpeed:number|null;
  activeMonitoringCase:number|null;
  activeProtectionFieldIds:number[]|null;
  driving:boolean|null;
}

export type EffectiveSpeedLimiter=
  |'None'
  |'Application Order Generation'
  |'PLC Motion Feedback'
  |'Bosch Navigator'
  |'Motor Controller / PLC Scaling'
  |'Robot stationary'
  |'Insufficient telemetry';

export interface SpeedLimitAnalysis {
  missionMaximumSpeedMps:number;
  edgeMaxSpeed:number|null;
  allowedMaxLinearSpeed:number|null;
  commandVelocityX:number|null;
  velocityX:number|null;
  effectiveLimitingComponent:EffectiveSpeedLimiter;
}

const record=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);

const finite=(value:unknown):number|null=>
  typeof value==='number'&&Number.isFinite(value)?value:null;

const findExact=(value:unknown,key:string,depth=0):unknown=>{
  if(depth>12)return undefined;
  if(Array.isArray(value)){
    for(const item of value){
      const found=findExact(item,key,depth+1);
      if(found!==undefined)return found;
    }
    return undefined;
  }
  if(!record(value))return undefined;
  if(Object.hasOwn(value,key))return value[key];
  for(const nested of Object.values(value)){
    const found=findExact(nested,key,depth+1);
    if(found!==undefined)return found;
  }
  return undefined;
};

export const inspectOutgoingOrderEdgeSpeeds=(payload:string):
OutgoingEdgeSpeedDiagnostic[]=>{
  let parsed:unknown;
  try{parsed=JSON.parse(payload);}
  catch{return [];}
  if(!record(parsed)||typeof parsed.orderId!=='string'||!Array.isArray(parsed.edges))
    return [];
  return parsed.edges.map((candidate,index)=>{
    const edge=record(candidate)?candidate:{};
    return {
      orderId:parsed.orderId as string,
      edgeIndex:index,
      edgeId:typeof edge.edgeId==='string'?edge.edgeId:'<missing>',
      sequenceId:typeof edge.sequenceId==='number'?edge.sequenceId:-1,
      maxSpeed:finite(edge.maxSpeed),
    };
  });
};

const activeEdge=(state:VdaState,order:VdaOrder|undefined)=>{
  if(!order||order.orderId!==state.orderId)return undefined;
  return order.edges.find((edge)=>
    edge.sequenceId===(state.lastNodeSequenceId??0)+1)
    ??order.edges.find((edge)=>edge.sequenceId>(state.lastNodeSequenceId??-1));
};

/**
 * Uses only documented names when those values are present in an observed
 * payload. Standard VDA state supplies velocity.vx but does not supply the
 * ClientMotion command or feedback limits.
 */
export const buildSpeedCycleDiagnostic=(
  state:VdaState,
  rawPayload:unknown,
  order?:VdaOrder,
):SpeedCycleDiagnostic=>{
  const edge=activeEdge(state,order);
  const motionCommand=findExact(rawPayload,'motionCommand');
  const commandVelocityX=record(motionCommand)
    ?finite(motionCommand.v_x):null;
  const protectionFields=findExact(rawPayload,'activeProtectionFieldIds');
  return {
    timestamp:state.timestamp??new Date().toISOString(),
    orderId:state.orderId?.trim()||null,
    edgeId:edge?.edgeId??null,
    edgeMaxSpeed:finite(edge?.maxSpeed),
    commandVelocityX,
    velocityX:finite(state.velocity?.vx),
    allowedMaxLinearSpeed:finite(findExact(rawPayload,'allowedMaxLinearSpeed')),
    allowedMaxAngularSpeed:finite(findExact(rawPayload,'allowedMaxAngularSpeed')),
    activeMonitoringCase:finite(findExact(rawPayload,'activeMonitoringCase')),
    activeProtectionFieldIds:Array.isArray(protectionFields)&&
      protectionFields.every((value)=>Number.isInteger(value))
      ?protectionFields as number[]:null,
    driving:typeof state.driving==='boolean'?state.driving:null,
  };
};

const materiallyLower=(value:number,target:number):boolean=>
  value<target-Math.max(0.01,Math.abs(target)*0.05);

export const analyzeSpeedLimits=(
  missionMaximumSpeedMps:number,
  cycle:SpeedCycleDiagnostic|undefined,
):SpeedLimitAnalysis=>{
  const edge=cycle?.edgeMaxSpeed??null;
  const allowed=cycle?.allowedMaxLinearSpeed??null;
  const command=cycle?.commandVelocityX??null;
  const velocity=cycle?.velocityX??null;
  let effectiveLimitingComponent:EffectiveSpeedLimiter='Insufficient telemetry';
  if(cycle?.driving===false)effectiveLimitingComponent='Robot stationary';
  else if(edge!==null&&materiallyLower(Math.abs(edge),missionMaximumSpeedMps))
    effectiveLimitingComponent='Application Order Generation';
  else if(allowed!==null&&materiallyLower(Math.abs(allowed),missionMaximumSpeedMps))
    effectiveLimitingComponent='PLC Motion Feedback';
  else if(command!==null&&materiallyLower(
    Math.abs(command),Math.min(missionMaximumSpeedMps,
      edge===null?missionMaximumSpeedMps:Math.abs(edge),
      allowed===null?missionMaximumSpeedMps:Math.abs(allowed))))
    effectiveLimitingComponent='Bosch Navigator';
  else if(command!==null&&velocity!==null&&
    materiallyLower(Math.abs(velocity),Math.abs(command)))
    effectiveLimitingComponent='Motor Controller / PLC Scaling';
  else if(edge!==null&&allowed!==null&&command!==null&&velocity!==null)
    effectiveLimitingComponent='None';
  return {
    missionMaximumSpeedMps,edgeMaxSpeed:edge,
    allowedMaxLinearSpeed:allowed,commandVelocityX:command,velocityX:velocity,
    effectiveLimitingComponent,
  };
};

export const formatSpeedCycleDiagnostic=(value:SpeedCycleDiagnostic):string=>
  `[speed-cycle] commandVelocityX=${value.commandVelocityX??'<unavailable>'} `+
  `velocityX=${value.velocityX??'<unavailable>'} `+
  `allowedMaxLinearSpeed=${value.allowedMaxLinearSpeed??'<unavailable>'} `+
  `allowedMaxAngularSpeed=${value.allowedMaxAngularSpeed??'<unavailable>'} `+
  `edge.maxSpeed=${value.edgeMaxSpeed??'<unavailable>'} `+
  `orderId=${value.orderId??'<none>'} edgeId=${value.edgeId??'<none>'} `+
  `activeMonitoringCase=${value.activeMonitoringCase??'<unavailable>'} `+
  `activeProtectionFieldIds=${
    value.activeProtectionFieldIds?.join(',')??'<unavailable>'}`;
