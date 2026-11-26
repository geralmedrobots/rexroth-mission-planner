import {create} from 'zustand';
import {createJSONStorage,persist} from 'zustand/middleware';
import type {SavedDestination} from '../destinations/destinationStore';
import type {RobotPose} from '../../domain/types';
import type {MissionProgress} from '../../domain/order/MissionMonitor';

export interface MissionStop {id:string;waypointId?:string;label:string;x:number;y:number;theta?:number}
export interface MissionTemplate {id:string;mapId:string;name:string;description:string;stops:MissionStop[]}
export const newMission=(mapId:string):MissionTemplate=>({id:crypto.randomUUID(),mapId,name:'',description:'',stops:[]});
export function savedStop(p:SavedDestination):MissionStop {
  return {id:crypto.randomUUID(),waypointId:p.id,label:p.displayName,x:p.x,y:p.y,theta:p.thetaExplicit===false?undefined:p.theta};
}
export function resolveStop(stop:MissionStop,mapId:string,points:SavedDestination[]) {
  const p=stop.waypointId?points.find(item=>item.id===stop.waypointId):undefined;
  if(stop.waypointId&&(!p||p.mapId!==mapId||!p.enabled))throw Error(`${stop.label}: saved waypoint is missing, disabled or on another map.`);
  const resolved=p?{...stop,label:p.displayName,x:p.x,y:p.y,theta:p.thetaExplicit===false?undefined:p.theta}:stop;
  const pose:RobotPose={x:resolved.x,y:resolved.y,theta:resolved.theta??0,mapId,positionInitialized:true};
  return {stop:resolved,pose,moved:resolved.x!==stop.x||resolved.y!==stop.y||resolved.theta!==stop.theta};
}
export interface MissionRun {
  id:string;template:MissionTemplate;index:number;orderId:string;started?:number;drivingObserved?:number;ended?:number;completed:number;
  status:string;errors:string[];cancelActionId?:string;cancelReason?:string;progress:number;
}
export const betweenStops='Awaiting next authorization';
export const inFlight=(run:MissionRun)=>!run.ended&&run.status!==betweenStops;
interface Library {
  templates:MissionTemplate[];history:MissionRun[];
  save:(t:MissionTemplate)=>void;remove:(id:string)=>void;duplicate:(t:MissionTemplate)=>void;
  record:(run:MissionRun)=>void;
}
let persistenceIssue:string|undefined;
export const missionStorageIssue=()=>persistenceIssue;
const storage=createJSONStorage(()=>({
  getItem:(key:string)=>localStorage.getItem(key),
  removeItem:(key:string)=>localStorage.removeItem(key),
  setItem:(key:string,value:string)=>{
    try{localStorage.setItem(key,value);persistenceIssue=undefined;}
    catch{persistenceIssue='Local storage is unavailable. Mission changes and history are available only in this session.';}
  },
}));
export const useMissionLibrary=create<Library>()(persist(set=>({
  templates:[],history:[],
  save:t=>{
    if(!t.name.trim()||!t.mapId||!t.stops.length)throw Error('A name, planning map and at least one destination are required.');
    set(state=>({templates:[...state.templates.filter(x=>x.id!==t.id),structuredClone({...t,name:t.name.trim()})]}));
  },
  remove:id=>set(state=>({templates:state.templates.filter(x=>x.id!==id)})),
  duplicate:t=>set(state=>({templates:[...state.templates,structuredClone({...t,id:crypto.randomUUID(),name:t.name+' (copy)'})]})),
  record:run=>set(state=>({history:[run,...state.history.filter(x=>x.id!==run.id)]})),
}),{name:'med-robots-missions-v1',storage,partialize:s=>({templates:s.templates,history:s.history}),
  merge:(persisted,current)=>{
    const saved=persisted as Partial<Library>;
    return {...current,templates:saved.templates??[],history:(saved.history??[]).map(r=>r.ended||r.status==='Outcome unknown'?r:
      {...r,status:'Outcome unknown',errors:[...r.errors,'Application session ended. Verify the outcome with Navigator.']})};
  },
}));
export function observeRun(run:MissionRun,progress:MissionProgress,cancelState:unknown[],time:number):MissionRun {
  if(run.ended||run.status===betweenStops||run.status==='Outcome unknown')return run;
  const cancelled=run.cancelActionId&&cancelState.some(a=>{
    const item=a as {actionId?:string;actionStatus?:string}|null;
    return item?.actionId===run.cancelActionId&&item?.actionStatus==='FINISHED';
  });
  if(run.cancelActionId&&cancelState.some(a=>{
    const item=a as {actionId?:string;actionStatus?:string}|null;
    return item?.actionId===run.cancelActionId&&item?.actionStatus==='FAILED';
  }))return {...run,status:'Outcome unknown',errors:[...run.errors,'Navigator reported that the cancellation action failed.']};
  if(cancelled)return {...run,status:'Cancelled',ended:time};
  if(run.cancelActionId&&progress.status==='Completed')return {...run,status:'Outcome unknown',errors:[...run.errors,'Order reached its final node while cancellation was pending. Verify the outcome.']};
  if(progress.status==='Completed'){
    const completed=run.index+1;
    return {...run,completed,progress:100,status:completed===run.template.stops.length?'Completed':betweenStops,
      ended:completed===run.template.stops.length?time:undefined};
  }
  if(progress.status==='Rejected'||progress.status==='Timed out')return {...run,status:progress.status,
    ended:progress.status==='Rejected'?time:undefined,
    errors:[...new Set([...run.errors,...(progress.rejectionErrors.length?progress.rejectionErrors.map(e=>e.errorDescription??e.errorType):['Navigator acceptance timed out. Verify the order before retrying.'])])]};
  const status=run.cancelActionId?'Cancellation requested':progress.status;
  const drivingObserved=run.drivingObserved??(progress.status==='Driving'?time:undefined);
  return status===run.status&&run.progress===progress.progressPercent&&drivingObserved===run.drivingObserved?run:{...run,status,drivingObserved,progress:progress.progressPercent};
}
