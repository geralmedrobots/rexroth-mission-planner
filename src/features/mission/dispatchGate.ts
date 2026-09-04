import type { ValidationIssue, ValidationResult, VdaState } from '../../domain/types';

export interface DispatchGateInput {
  mqttConnected:boolean;
  robotOnline:boolean;
  stateFresh:boolean;
  poseValid:boolean;
  mapMatches:boolean;
  validation?:ValidationResult;
  state?:VdaState;
  hasActiveDifferentOrder:boolean;
}

/**
 * Navigator may keep the last accepted orderId in state after completion.
 * A non-empty orderId alone therefore is not evidence of an active mission.
 */
export const getActiveNavigatorOrderId=(state:VdaState|undefined):string|null=>{
  const orderId=state?.orderId?.trim();
  if(!orderId)return null;
  const hasPendingRoute=(state?.nodeStates?.length??0)>0||(state?.edgeStates?.length??0)>0;
  return state?.driving===true||state?.paused===true||hasPendingRoute?orderId:null;
};

export const getDispatchIssues=(input:DispatchGateInput):ValidationIssue[]=>{
  const issues:ValidationIssue[]=[];
  const add=(condition:boolean,code:string,message:string):void=>{
    if(!condition)issues.push({code,message,severity:'error'});
  };
  add(input.mqttConnected,'dispatch.mqtt','MQTT is disconnected.');
  add(input.robotOnline,'dispatch.robotOffline','Robot is offline.');
  add(input.stateFresh,'dispatch.stateStale','Robot state is stale.');
  add(input.poseValid,'dispatch.pose','A fresh localized robot pose is required.');
  add(input.mapMatches,'dispatch.map','Locator map does not match the resolved Navigator mapId.');
  add(input.state?.operatingMode?.toUpperCase()==='AUTOMATIC','dispatch.mode','Navigator must be in AUTOMATIC mode.');
  add(input.state?.safetyState?.eStop==='NONE','dispatch.estop','Order cannot be sent while emergency stop is active.');
  add(input.state?.safetyState?.fieldViolation!==true,'dispatch.fieldViolation','Safety field violation is active.');
  add(input.validation?.valid===true,'dispatch.validation','The generated order is not valid.');
  add(!input.hasActiveDifferentOrder,'dispatch.activeOrder',
    'Cancel the active Order and wait until Navigator clears it before sending another Order.');
  return issues;
};
