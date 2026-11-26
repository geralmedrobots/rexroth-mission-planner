import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Dialog,DialogActions,DialogTitle,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {SavedDestination} from '../destinations/destinationStore';
import {betweenStops,inFlight,missionStorageIssue,newMission,resolveStop,savedStop,useMissionLibrary,type MissionRun,type MissionTemplate} from './missionLibrary';
import type {MissionPreview} from './missionPreview';
interface Props {
  draft:MissionTemplate;mapId?:string;points:SavedDestination[];index:number;continuing:boolean;busy:boolean;
  preview?:MissionPreview;message:string;blockers:string[];robot:string;pose:boolean;speed:number;replanning:string;
  onEdit:(t:MissionTemplate)=>void;onMap:()=>void;onValidate:()=>void;onExecute:()=>void;onClose:()=>void;
  onContinue:(run:MissionRun)=>void;onCancel:(id:string)=>void;canCancel?:string;
}
export function MissionsPanel(p:Props){
  const [tab,setTab]=useState<'Editor'|'Library'|'History'>('Editor');
  const [search,setSearch]=useState('');
  const [deleting,setDeleting]=useState<string>();
  const [notice,setNotice]=useState('');
  const lib=useMissionLibrary();
  const latestOrder=lib.history[0]?.orderId;
  const lastOrder=useRef(latestOrder);
  useEffect(()=>{
    if(latestOrder&&latestOrder!==lastOrder.current)setTab('History');
    lastOrder.current=latestOrder;
  },[latestOrder]);
  const t=p.draft;
  const edit=(patch:Partial<MissionTemplate>)=>{p.onEdit({...t,...patch});setNotice('');};
  const load=(value:MissionTemplate)=>{p.onEdit(structuredClone(value));setTab('Editor');setNotice('');};
  const currentRun=lib.history.find(r=>!r.ended);
  const sameMap=t.mapId===p.mapId;
  const move=(from:number,to:number)=>{
    const stops=[...t.stops];stops.splice(to,0,stops.splice(from,1)[0]!);edit({stops});
  };
  const renderRun=(r:MissionRun)=><section className="mr-mission-entry" key={r.id}>
    <Typography variant="subtitle1">{r.template.name}</Typography>
    <Typography variant="body2">{r.status} · {r.completed}/{r.template.stops.length} destinations completed</Typography>
    <Typography variant="body2">Current destination · {r.ended||r.status===betweenStops?'—':r.template.stops[r.index]?.label}</Typography>
    {inFlight(r)&&r.status!=='Outcome unknown'&&<Typography variant="caption">Current order progress · {r.progress}%</Typography>}
    <ol>{r.template.stops.map((s,i)=><li key={s.id}>{s.label} · {i<r.completed?'Completed':i===r.index&&!r.ended&&r.status!==betweenStops?'Current':'Remaining'}</li>)}</ol>
    <Typography variant="caption" display="block">First handoff {r.started?new Date(r.started).toLocaleString():'unconfirmed'}</Typography>
    {r.drivingObserved&&<Typography variant="caption" display="block">Driving first observed {new Date(r.drivingObserved).toLocaleString()}</Typography>}
    {r.ended&&<Typography variant="caption" display="block">{r.status==='Completed'?'Completion observed':'Tracking ended'} {new Date(r.ended).toLocaleString()} {r.started?`· ${Math.round((r.ended-r.started)/1000)} s`:''}</Typography>}
    {!r.ended&&<Typography variant="caption" display="block">{p.robot} · Replanning {p.replanning}</Typography>}
    {r.cancelReason&&<Typography variant="body2">{r.cancelReason}</Typography>}
    {r.errors.map(e=><Alert severity="warning" key={e}>{e}</Alert>)}
    {r.status===betweenStops&&<Button onClick={()=>{p.onContinue(r);setTab('Editor');setNotice('');}}>Prepare next destination</Button>}
    {(r.status==='Outcome unknown'||r.status==='Timed out'||r.status===betweenStops)&&<details><summary>End local tracking</summary>
      <Typography variant="body2">Verify the order in Navigator. Ending tracking sends no robot command.</Typography>
      <Button onClick={()=>lib.record({...r,status:'Tracking ended by operator',ended:Date.now()})}>Confirm end tracking</Button></details>}
    {inFlight(r)&&p.canCancel===r.orderId&&!r.cancelActionId&&<Button color="error" onClick={()=>p.onCancel(r.orderId)}>Cancel active order</Button>}
  </section>;
  return <Stack className="mr-missions" gap={1.25} aria-label="Mission management">
    <Stack direction="row" alignItems="center" justifyContent="space-between"><Typography variant="h2">Missions</Typography><Button onClick={p.onClose}>Quick mission</Button></Stack>
    <Stack direction="row" gap={.5}>{(['Editor','Library','History'] as const).map(v=><Button size="small" key={v} aria-pressed={tab===v}
      variant={tab===v?'contained':'text'} onClick={()=>{setTab(v);setNotice('');}}>{v}</Button>)}</Stack>
    {tab==='Library'&&<>
      <TextField size="small" label="Search missions" value={search} onChange={e=>setSearch(e.target.value)}/>
      <Button disabled={!p.mapId} onClick={()=>load(newMission(p.mapId!))}>New mission</Button>
      {lib.templates.filter(m=>m.mapId===p.mapId&&m.name.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name)).map(m=>
        <section key={m.id} className="mr-mission-entry"><strong>{m.name}</strong><Typography variant="body2">{m.description}</Typography>
          <Typography variant="caption">{m.stops.length} destinations · {m.mapId}</Typography>
          <Stack direction="row"><Button onClick={()=>load(m)}>Load / edit</Button><Button onClick={()=>lib.duplicate(m)}>Duplicate</Button><Button color="error" onClick={()=>setDeleting(m.id)}>Delete</Button></Stack></section>)}
      {!lib.templates.some(m=>m.mapId===p.mapId&&m.name.toLowerCase().includes(search.toLowerCase()))&&<Typography>No matching templates on this map.</Typography>}
    </>}
    {tab==='History'&&(lib.history.length?lib.history.map(renderRun):<Typography>No mission handoffs recorded.</Typography>)}
    {tab==='Editor'&&<>
      <TextField size="small" label="Mission name" disabled={p.continuing} value={t.name} onChange={e=>edit({name:e.target.value})}/>
      <TextField size="small" label="Description (optional)" disabled={p.continuing} value={t.description} onChange={e=>edit({description:e.target.value})}/>
      {!sameMap&&<Alert severity="warning">Load the template’s map, or create a mission for the current map in Library.</Alert>}
      <Typography variant="overline">Destinations · {t.mapId||'No map loaded'}</Typography>
      <ol className="mr-stop-list">{t.stops.map((stop,i)=>{
        let label=stop.label,warning='';
        try{const resolved=resolveStop(stop,t.mapId,p.points);label=resolved.stop.label;if(resolved.moved)warning='Position changed since saved.';}
        catch(e){warning=String(e);}
        return <li key={stop.id}><strong>{label}</strong>{i<p.index?' · Completed':''}
          {warning&&<Typography variant="body2" color="warning.dark">{warning}</Typography>}
          {!p.continuing&&<Stack direction="row"><Button size="small" disabled={!i} aria-label={`Move destination ${i+1} up`} onClick={()=>move(i,i-1)}>↑</Button>
          <Button size="small" disabled={i===t.stops.length-1} aria-label={`Move destination ${i+1} down`} onClick={()=>move(i,i+1)}>↓</Button>
          <Button size="small" aria-label={`Remove destination ${i+1}`} onClick={()=>edit({stops:t.stops.filter(s=>s.id!==stop.id)})}>Remove</Button></Stack>}</li>;
      })}</ol>
      {!p.continuing&&<><TextField select size="small" label="Saved waypoint" value="" disabled={!sameMap} onChange={e=>{
        const point=p.points.find(x=>x.id===e.target.value);if(point)edit({stops:[...t.stops,savedStop(point)]});
      }}>{p.points.filter(s=>s.mapId===t.mapId&&s.enabled).map(s=><MenuItem key={s.id} value={s.id}>{s.displayName}</MenuItem>)}</TextField>
      <Stack direction="row"><Button disabled={!sameMap||!p.mapId} onClick={p.onMap}>Add from map</Button>
      <Button disabled={!t.name.trim()||!t.stops.length||!t.mapId} onClick={()=>{lib.save(t);setNotice(missionStorageIssue()?'Template kept in this session.':'Template saved.');}}>Save template</Button></Stack></>}
      <Typography variant="overline">Validation</Typography>
      <Typography variant="body2">{p.robot} · {p.pose?'Pose available':'Pose unavailable'}</Typography>
      <Button variant="outlined" disabled={p.busy||!t.stops.length||!sameMap} onClick={p.onValidate}>{p.busy?'Validating…':'Validate mission'}</Button>
      <Typography role="status" variant="body2">{p.preview?'Preview validated':p.message||'Validation required'}</Typography>
      {p.preview&&<><Typography>{p.preview.distance.toFixed(2)} m · {p.speed>0?Math.ceil(p.preview.distance/p.speed)+' s at maximum speed':'Travel time unavailable'}</Typography>
        {p.preview.warnings.map((w,i)=><Alert key={i} severity="warning">{w}</Alert>)}
        <Typography variant="caption">{p.preview.legs.length} remaining route segments in blue on the map. Authorize each destination separately. Timed waits are unavailable.</Typography></>}
      {p.blockers.map(b=><Typography key={b} variant="body2" color="warning.dark">{b}</Typography>)}
      <Button variant="contained" disabled={!p.preview||p.busy||!!p.blockers.length} onClick={p.onExecute}>Authorize destination {p.index+1}</Button>
      {currentRun&&<><Typography variant="overline">Execution · {p.replanning}</Typography>{renderRun(currentRun)}</>}
    </>}
    {missionStorageIssue()&&<Alert severity="warning">{missionStorageIssue()}</Alert>}
    {notice&&<Typography role="status">{notice}</Typography>}
    <Dialog open={!!deleting} onClose={()=>setDeleting(undefined)}><DialogTitle>Delete this mission template?</DialogTitle><DialogActions><Button onClick={()=>setDeleting(undefined)}>Keep</Button>
      <Button color="error" onClick={()=>{if(deleting)lib.remove(deleting);setDeleting(undefined);}}>Delete template</Button></DialogActions></Dialog>
  </Stack>;
}
