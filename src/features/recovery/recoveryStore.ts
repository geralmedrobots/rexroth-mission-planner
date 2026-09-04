import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RecoveryLog, RecoveryRuntime, RecoverySettings } from './types';

export const defaultRecoverySettings:RecoverySettings={
  enabled:false,
  blockedTimeoutMs:5_000,
  reverseDistanceM:0.6,
  maximumReverseDistanceM:1,
  rearSafetyMarginM:0.15,
  requireRearLaserData:true,
  retryCount:2,
  telemetry:{
    source:'ctrlx',
    ctrlx:{
      host:'',port:443,https:true,endpointTemplate:'',
      authenticationMode:'none',username:'',password:'',bearerToken:'',
      requestDrivingModePath:'',commandedVxPath:'',commandedYawRatePath:'',
      availableDrivingModesPath:'',pollingIntervalMs:100,staleTimeoutMs:1_000,
      requestTimeoutMs:2_000,rejectUnauthorized:true,caCertificatePem:'',
    },
  },
};

const initialRuntime:RecoveryRuntime={
  state:'IDLE',forwardBlocked:false,rearObstacleCount:0,reversePath:[],
};

interface RecoveryStore {
  settings:RecoverySettings;
  runtime:RecoveryRuntime;
  logs:RecoveryLog[];
  updateSettings:(patch:Partial<RecoverySettings>)=>void;
  setRuntime:(patch:Partial<RecoveryRuntime>)=>void;
  log:(level:RecoveryLog['level'],message:string,context?:Record<string,unknown>)=>void;
  resetRuntime:()=>void;
  clearLogs:()=>void;
}

export const useRecoveryStore=create<RecoveryStore>()(persist((set)=>({
  settings:defaultRecoverySettings,runtime:initialRuntime,logs:[],
  updateSettings:(patch)=>set((state)=>({settings:{...state.settings,...patch}})),
  setRuntime:(patch)=>set((state)=>({runtime:{...state.runtime,...patch}})),
  log:(level,message,context)=>set((state)=>({
    logs:[...state.logs.slice(-499),{
      id:crypto.randomUUID(),timestamp:new Date().toISOString(),level,message,context,
    }],
  })),
  resetRuntime:()=>set({runtime:initialRuntime}),
  clearLogs:()=>set({logs:[]}),
}),{
  name:'med-robots-blocked-recovery',
  version:2,
  migrate:(persisted,version)=>{
    if(version>=2)return persisted;
    const saved=persisted as Partial<RecoveryStore>;
    return {
      ...saved,
      settings:{...defaultRecoverySettings,...saved.settings,reverseDistanceM:0.6},
    };
  },
  partialize:(state)=>({settings:{
    ...state.settings,
    telemetry:{
      ...state.settings.telemetry,
      ctrlx:{
        ...state.settings.telemetry.ctrlx,password:'',bearerToken:'',
      },
    },
  }}),
  merge:(persisted,current)=>{
    const saved=persisted as Partial<RecoveryStore>;
    return {...current,settings:{
      ...defaultRecoverySettings,...saved.settings,
      telemetry:{
        ...defaultRecoverySettings.telemetry,...saved.settings?.telemetry,
        ctrlx:{
          ...defaultRecoverySettings.telemetry.ctrlx,
          ...saved.settings?.telemetry?.ctrlx,password:'',bearerToken:'',
        },
      },
    }};
  },
}));
