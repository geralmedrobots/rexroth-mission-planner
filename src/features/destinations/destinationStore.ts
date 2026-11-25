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
  /** Older quick destinations always stored an explicit heading. */
  thetaExplicit?:boolean;
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
export function waypointNameError(items:SavedDestination[],mapId:string,name:string,id?:string) {
  if(!name.trim())return 'Enter a waypoint name.';
  if(items.some(item=>item.mapId===mapId&&item.id!==id&&
    item.displayName.trim().toLowerCase()===name.trim().toLowerCase()))return 'This map already has a waypoint with that name.';
}
export const useDestinationStore=create<DestinationState>()(persist((set,get)=>({
  destinations:[],
  add:(value)=>{
    const error=waypointNameError(get().destinations,value.mapId,value.displayName);
    if(error)throw new Error(error);
    const destination={...value,displayName:value.displayName.trim(),id:crypto.randomUUID()};
    set((state)=>({destinations:[...state.destinations,destination]}));
    return destination;
  },
  remove:(id)=>set((state)=>({destinations:state.destinations.filter((item)=>item.id!==id)})),
  update:(id,patch)=>{
    const items=get().destinations;
    const current=items.find(item=>item.id===id);
    if(!current)throw new Error('This waypoint no longer exists.');
    const value={...current,...patch,id,mapId:current.mapId};
    const error=waypointNameError(items,value.mapId,value.displayName,id);
    if(error)throw new Error(error);
    set({destinations:items.map(item=>item.id===id?{...value,displayName:value.displayName.trim()}:item)});
  },
}),{name:'med-robots-destinations'}));
