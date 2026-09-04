import type { RecoveryTelemetry } from './types';

const record=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);

const drivingMode=(value:unknown):number|null=>{
  if(typeof value==='number'&&Number.isInteger(value)&&value>=0)return value;
  if(typeof value!=='string')return null;
  const normalized=value.trim().toLowerCase();
  if(!/^(0x[0-9a-f]+|\d+)$/.test(normalized))return null;
  const parsed=Number.parseInt(normalized,normalized.startsWith('0x')?16:10);
  return Number.isFinite(parsed)?parsed:null;
};

export const decodeAvailableDrivingModes=(value:unknown):number[]=>{
  if(Array.isArray(value))
    return [...new Set(value.map(drivingMode).filter((mode):mode is number=>mode!==null))];
  const bitmask=drivingMode(value);
  if(bitmask===null)return [];
  return [0x01,0x02,0x04].filter((mode)=>(bitmask&mode)===mode);
};

const findValue=(payload:unknown,key:string,depth=0):unknown=>{
  if(depth>12)return undefined;
  if(Array.isArray(payload)){
    for(const item of payload){
      const found=findValue(item,key,depth+1);
      if(found!==undefined)return found;
    }
    return undefined;
  }
  if(!record(payload))return undefined;
  if(Object.hasOwn(payload,key))return payload[key];
  for(const value of Object.values(payload)){
    const found=findValue(value,key,depth+1);
    if(found!==undefined)return found;
  }
  return undefined;
};

export const parseRecoveryTelemetry=(...payloads:unknown[]):RecoveryTelemetry=>{
  const requestRaw=payloads.map((payload)=>findValue(payload,'requestDrivingMode'))
    .find((value)=>value!==undefined);
  const availableRaw=payloads.map((payload)=>findValue(payload,'availableDrivingModes'))
    .find((value)=>value!==undefined);
  const motionCommandRaw=payloads.map((payload)=>findValue(payload,'motionCommand'))
    .find(record);
  const vxRaw=motionCommandRaw?.v_x;
  return {
    requestDrivingMode:drivingMode(requestRaw),
    availableDrivingModes:decodeAvailableDrivingModes(availableRaw),
    commandedVx:typeof vxRaw==='number'&&Number.isFinite(vxRaw)?vxRaw:null,
    commandedYawRate:
      typeof motionCommandRaw?.yaw_rate==='number'&&Number.isFinite(motionCommandRaw.yaw_rate)
        ?motionCommandRaw.yaw_rate:null,
    provider:'mqtt-raw',connectionState:'connected',receivedAtMs:Date.now(),
  };
};

export const supportsBackwardDriving=(telemetry:RecoveryTelemetry):boolean=>
  telemetry.availableDrivingModes.includes(0x02);

export const confirmsBackwardMotion=(telemetry:RecoveryTelemetry):boolean=>
  telemetry.requestDrivingMode===0x02&&telemetry.commandedVx!==null&&telemetry.commandedVx<0;

export const requestsTurnOnSpot=(telemetry:RecoveryTelemetry):boolean=>
  telemetry.requestDrivingMode===0x04;
