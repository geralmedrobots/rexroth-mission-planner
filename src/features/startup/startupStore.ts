import { create } from 'zustand';
import type { StartupSnapshot } from './types';

interface StartupState extends StartupSnapshot {
  dismissed:boolean;
  retryToken:number;
  setSnapshot:(snapshot:StartupSnapshot)=>void;
  dismiss:()=>void;
  retry:()=>void;
}
export const useStartupStore=create<StartupState>((set)=>({
  phase:'INITIALIZING',message:'Preparing navigation control…',retryAttempt:0,running:false,
  dismissed:false,retryToken:0,
  setSnapshot:(snapshot)=>set(snapshot),
  dismiss:()=>set({dismissed:true}),
  retry:()=>set((state)=>({retryToken:state.retryToken+1,dismissed:false})),
}));
