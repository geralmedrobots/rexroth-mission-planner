import {useEffect,useRef,useState} from 'react';
import {useAppStore,type AppState} from '../../stores/appStore';
import {useDestinationStore} from '../destinations/destinationStore';
import {useOperatorSettingsStore} from '../settings/operatorSettingsStore';
import {useLocatorStore} from '../locator/stores/locatorStore';
import {betweenStops,newMission,useMissionLibrary,type MissionRun,type MissionTemplate} from './missionLibrary';
import {previewMission,type MissionPreview} from './missionPreview';
import type {OrderValidationContext} from '../../domain/vda5050/VdaOrderValidator';
import type {RobotPose} from '../../domain/types';

type LiveContext={validation:OrderValidationContext;poseSnapshot?:{pose:RobotPose}|null};
export function useMissionWorkspace(liveContext:(app:AppState)=>LiveContext){
  const [open,setOpen]=useState(false);
  const [draft,setDraft]=useState(()=>newMission(''));
  const [pick,setPick]=useState(false);
  const [runId,setRunId]=useState<string>();
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [result,setResult]=useState<{preview:MissionPreview;current:()=>boolean}>();
  const version=useRef(0);
  // A reconnect must also invalidate a pending request whose inputs later look identical.
  const connectionEpoch=useRef(0);
  useEffect(()=>useAppStore.subscribe((a,b)=>{
    if(a.mqttConnected!==b.mqttConnected||a.connection?.connectionState!==b.connection?.connectionState||
      a.state?.operatingMode!==b.state?.operatingMode||a.state?.safetyState?.eStop!==b.state?.safetyState?.eStop||
      a.state?.safetyState?.fieldViolation!==b.state?.safetyState?.fieldViolation)connectionEpoch.current++;
  }),[]);
  const library=useMissionLibrary();
  const points=useDestinationStore(s=>s.destinations);
  const run=library.history.find(r=>r.id===runId);
  const index=run?.completed??0;
  const reset=()=>{version.current++;setResult(undefined);setBusy(false);setMessage('');setPick(false);};
  const edit=(t:MissionTemplate)=>{reset();setRunId(undefined);setDraft(t);};
  const show=()=>{if(!draft.mapId)edit(newMission(useAppStore.getState().grid?.metadata.mapId??''));setOpen(true);};
  const close=()=>{reset();setOpen(false);};
  const release=()=>{reset();setRunId(undefined);};
  const resume=(r:MissionRun)=>{reset();setDraft(r.template);setRunId(r.id);};
  const blocked=()=>{
    const history=useMissionLibrary.getState().history;
    if(runId&&!history.some(r=>r.id===runId&&r.status===betweenStops&&r.completed===index&&!r.ended))return 'This run is no longer waiting for this destination.';
    if(history.some(r=>!r.ended&&r.id!==runId))return 'Finish or reconcile the recorded mission before starting another.';
  };
  const validate=async()=>{
    reset();const token=version.current;setBusy(true);
    const app=useAppStore.getState(),ctx=liveContext(app),pose=ctx.poseSnapshot?.pose;
    const map=useLocatorStore.getState().loadedMap;
    const limit=useOperatorSettingsStore.getState().settings.maximumVdaNodeCount;
    const epoch=connectionEpoch.current;
    const current=()=>{
      const a=useAppStore.getState(),c=liveContext(a),position=c.poseSnapshot?.pose;
      return epoch===connectionEpoch.current&&token===version.current&&a.grid===app.grid&&a.inflatedGrid===app.inflatedGrid&&a.plannerMode===app.plannerMode&&
        a.plannerOptions===app.plannerOptions&&a.orderSettings===app.orderSettings&&a.footprint===app.footprint&&a.mqttSettings===app.mqttSettings&&
        a.mqttConnected===app.mqttConnected&&useLocatorStore.getState().loadedMap===map&&c.validation.activeMapId===ctx.validation.activeMapId&&
        position?.x===pose?.x&&position?.y===pose?.y&&position?.theta===pose?.theta&&position?.mapId===pose?.mapId&&
        useDestinationStore.getState().destinations===points&&useOperatorSettingsStore.getState().settings.maximumVdaNodeCount===limit;
    };
    try{
      const preview=await previewMission({template:draft,index,app,points,pose,context:ctx.validation,limit,sessionId:draft.id});
      if(current())setResult({preview,current});else if(token===version.current)setMessage('Mission inputs changed. Validate again.');
    }catch(e){if(token===version.current)setMessage(e instanceof Error?e.message:String(e));}
    finally{if(token===version.current)setBusy(false);}
  };
  const valid=result?.current()??false;
  useEffect(()=>{if(result&&!valid){version.current++;setResult(undefined);setMessage('Mission inputs changed. Validate again.');}},[valid,result]);
  return {open,show,close,release,draft,edit,run,index,resume,points,pick,setPick,busy,message,setMessage,validate,blocked,reset,
    preview:valid?result?.preview:undefined,isCurrent:()=>Boolean(result?.current())};
}
