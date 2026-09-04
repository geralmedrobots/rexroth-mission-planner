import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  GlobalReplanningLog, GlobalReplanningRuntime, GlobalReplanningSettings,
} from './types';

export const defaultGlobalReplanningSettings:GlobalReplanningSettings={
  enabled:false,
  localBypassWaitTimeMs:3_000,
  blockedTimeoutMs:5_000,
  stoppedSpeedThresholdMps:0.02,
  minimumGoalDistanceM:0.5,
  minimumObstacleSizeM:0.2,
  obstacleMergeDistanceM:0.2,
  inflationDistanceM:0.15,
  unknownCellsBlocked:true,
  maximumPlanningTimeMs:3_000,
  maximumPlanningAttempts:3,
  retryDelayMs:1_000,
  maximumRetries:3,
  temporaryObstacleTtlMs:10_000,
  minimumRouteChangeM:0.50,
  enableStartPoseProjection:true,
  maximumStartProjectionDistanceM:1.0,
  enableBlockedRouteInferenceFallback:false,
  inferredObstacleDistanceM:1,
  inferredObstacleLengthM:0.4,
  inferredObstacleWidthM:0.4,
  postReplacementGraceMs:10_000,
};

const initialRuntime:GlobalReplanningRuntime={
  status:'DISABLED',blockedDurationMs:0,attempt:0,retryCount:0,
  originalPath:[],blockedPath:[],newPath:[],temporaryObstacleCells:[],
  temporaryObstacleCount:0,exploredCells:[],inflatedTemporaryObstacleCells:[],
  obstacleIngestionDiagnostics:[],
};

interface GlobalReplanningState {
  settings:GlobalReplanningSettings;
  runtime:GlobalReplanningRuntime;
  logs:GlobalReplanningLog[];
  updateSettings:(patch:Partial<GlobalReplanningSettings>)=>void;
  setRuntime:(patch:Partial<GlobalReplanningRuntime>)=>void;
  log:(source:GlobalReplanningLog['source'],level:GlobalReplanningLog['level'],
    message:string,context?:Record<string,unknown>)=>void;
  clearLogs:()=>void;
  resetRuntime:()=>void;
}

export const useGlobalReplanningStore=create<GlobalReplanningState>()(persist((set)=>({
  settings:defaultGlobalReplanningSettings,runtime:initialRuntime,logs:[],
  updateSettings:(patch)=>set((state)=>({settings:{...state.settings,...patch}})),
  setRuntime:(patch)=>set((state)=>({runtime:{...state.runtime,...patch}})),
  log:(source,level,message,context)=>set((state)=>({
    logs:[...state.logs.slice(-999),{
      id:crypto.randomUUID(),timestamp:new Date().toISOString(),source,level,message,context,
    }],
  })),
  clearLogs:()=>set({logs:[]}),
  resetRuntime:()=>set((state)=>({runtime:{
    ...initialRuntime,status:state.settings.enabled?'MONITORING':'DISABLED',
  }})),
}),{
  name:'med-robots-global-replanning',
  partialize:(state)=>({settings:state.settings}),
  merge:(persisted,current)=>{
    const saved=persisted as Partial<GlobalReplanningState>;
    return {...current,settings:{...defaultGlobalReplanningSettings,...saved.settings}};
  },
}));
