import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DestinationCategory=
  | 'pharmacy'|'laboratory'|'reception'|'ward'|'charging'|'delivery'|'home'|'other';
export interface SavedDestination {
  id:string;
  displayName:string;
  mapId:string;
  x:number;
  y:number;
  theta:number;
  category:DestinationCategory;
  icon:string;
  enabled:boolean;
  description?:string;
}
interface DestinationState {
  destinations:SavedDestination[];
  add:(destination:Omit<SavedDestination,'id'>)=>SavedDestination;
  remove:(id:string)=>void;
  update:(id:string,patch:Partial<SavedDestination>)=>void;
}
export const useDestinationStore=create<DestinationState>()(persist((set)=>({
  destinations:[],
  add:(value)=>{
    const destination={...value,id:crypto.randomUUID()};
    set((state)=>({destinations:[...state.destinations,destination]}));
    return destination;
  },
  remove:(id)=>set((state)=>({destinations:state.destinations.filter((item)=>item.id!==id)})),
  update:(id,patch)=>set((state)=>({destinations:state.destinations.map((item)=>
    item.id===id?{...item,...patch}:item)})),
}),{name:'med-robots-destinations'}));
