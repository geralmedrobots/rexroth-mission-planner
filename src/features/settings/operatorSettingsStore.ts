import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OperatorSettings {
  directDispatchMode:boolean;
  dispatchCountdownSeconds:number;
  previewBeforeDispatch:boolean;
  autoClearCompletedMission:boolean;
  maximumVdaNodeCount:number;
  destinationValidationRadius:number;
  compactMode:boolean;
  animationLevel:'full'|'reduced'|'none';
  mapContrast:number;
  reduceMotion:boolean;
  language:'en'|'pt';
}
const defaults:OperatorSettings={
  directDispatchMode:false,dispatchCountdownSeconds:3,previewBeforeDispatch:true,
  autoClearCompletedMission:false,maximumVdaNodeCount:120,destinationValidationRadius:.2,
  compactMode:false,animationLevel:'full',mapContrast:1,reduceMotion:false,language:'en',
};
interface OperatorSettingsState {
  settings:OperatorSettings;
  update:(patch:Partial<OperatorSettings>)=>void;
  reset:()=>void;
}
export const useOperatorSettingsStore=create<OperatorSettingsState>()(persist((set)=>({
  settings:defaults,
  update:(patch)=>set((state)=>({settings:{...state.settings,...patch}})),
  reset:()=>set({settings:defaults}),
}),{
  name:'med-robots-operator-settings',
  merge:(persisted,current)=>{
    const saved=persisted as Partial<OperatorSettingsState>;
    return {...current,...saved,settings:{...defaults,...saved.settings}};
  },
}));
