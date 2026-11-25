import { useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useDestinationStore, waypointNameError, type SavedDestination, type DestinationCategory } from './destinationStore';
import type { OccupancyGrid } from '../../domain/types';
import { waypointPositionError, type WaypointDraft } from './waypointPosition';

export function WaypointEditor({draft,grid,inflated,onClose}:{draft:WaypointDraft;grid?:OccupancyGrid;inflated?:OccupancyGrid;onClose:()=>void}) {
  const store=useDestinationStore();
  const [name,setName]=useState(draft.item?.displayName??'');
  const [description,setDescription]=useState(draft.item?.description??'');
  const [heading,setHeading]=useState(draft.theta===undefined?'':String(draft.theta));
  const [category,setCategory]=useState<DestinationCategory>(draft.item?.category??'other');
  const [failure,setFailure]=useState('');
  const error=waypointNameError(store.destinations,draft.mapId,name,draft.item?.id)||
    waypointPositionError({...draft,theta:Number(heading)},grid,inflated);
  const save=()=>{
    if(error)return;
    const value={mapId:draft.mapId,displayName:name.trim(),description:description.trim(),category,
      icon:category,enabled:draft.item?.enabled??true,x:draft.x,y:draft.y,theta:Number(heading),thetaExplicit:Boolean(heading.trim())};
    try{if(draft.item)store.update(draft.item.id,value);else store.add(value);onClose();}
    catch(e){setFailure(String(e));}
  };
  return <Dialog open onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="waypoint-editor-title">
    <DialogTitle id="waypoint-editor-title">{draft.item?'Edit waypoint':'Create waypoint'}</DialogTitle>
    <DialogContent><Stack gap={2} pt={1}>
      <Typography variant="body2">{draft.mapId} · X {draft.x.toFixed(3)} m · Y {draft.y.toFixed(3)} m</Typography>
      <TextField autoFocus required label="Waypoint name" value={name} onChange={e=>setName(e.target.value)}/>
      <TextField label="Description (optional)" multiline value={description} onChange={e=>setDescription(e.target.value)}/>
      <TextField label="Orientation (rad, optional)" value={heading} onChange={e=>setHeading(e.target.value)}/>
      <TextField select label="Category" value={category} onChange={e=>setCategory(e.target.value as DestinationCategory)}>
        {['pharmacy','laboratory','reception','ward','charging','delivery','home','other'].map(c=><MenuItem key={c} value={c}>{c}</MenuItem>)}
      </TextField>
      {(failure||(name&&error))&&<Alert severity="error">{failure||error}</Alert>}
    </Stack></DialogContent>
    <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" disabled={Boolean(error)} onClick={save}>Save waypoint</Button></DialogActions>
  </Dialog>;
}

interface PanelProps {
  mapId?:string;onClose:()=>void;onCreate:()=>void;onEdit:(point:SavedDestination)=>void;
  onReposition:(point:SavedDestination)=>void;onFocus:(point:SavedDestination)=>void;
  onDestination:(point:SavedDestination)=>void;
}
export function WaypointsPanel({mapId,onClose,onCreate,onEdit,onReposition,onFocus,onDestination}:PanelProps) {
  const {destinations,remove}=useDestinationStore();
  const [search,setSearch]=useState('');const [reverse,setReverse]=useState(false);
  const [deleting,setDeleting]=useState<string>();
  const items=destinations.filter(item=>item.mapId===mapId&&item.displayName.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a,b)=>a.displayName.localeCompare(b.displayName)*(reverse?-1:1));
  return <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="waypoints-title">
    <DialogTitle id="waypoints-title">Waypoints</DialogTitle><DialogContent>
      <Stack direction="row" gap={1} mt={1} mb={2}><TextField fullWidth size="small" label="Search waypoints" value={search} onChange={e=>setSearch(e.target.value)}/>
        <Button aria-label="Reverse alphabetical sort" onClick={()=>setReverse(!reverse)}>{reverse?'Z–A':'A–Z'}</Button></Stack>
      {!items.length&&<Typography color="text.secondary">{!mapId?'Load a planning map to manage its waypoints.':search?'No matching waypoints.':'No waypoints saved on this map.'}</Typography>}
      {items.map(point=><Box className="mr-waypoint-row" key={point.id}>
        <Button onClick={()=>onFocus(point)}>{point.displayName}</Button>
        <Typography variant="body2">{point.description}</Typography>
        <Typography variant="caption">{point.x.toFixed(3)}, {point.y.toFixed(3)} m</Typography>
        <Stack direction="row" flexWrap="wrap" gap={.5}>
          <Button disabled={!point.enabled} onClick={()=>onDestination(point)}>Use as destination</Button>
          <Button onClick={()=>onEdit(point)}>Edit</Button><Button onClick={()=>onReposition(point)}>Reposition</Button>
          {deleting===point.id?<><Button color="error" onClick={()=>{remove(point.id);setDeleting(undefined);}}>Confirm delete</Button><Button onClick={()=>setDeleting(undefined)}>Keep</Button></>:
            <Button color="error" onClick={()=>setDeleting(point.id)}>Delete</Button>}
        </Stack></Box>)}
    </DialogContent><DialogActions><Button onClick={onClose}>Close</Button><Button disabled={!mapId} variant="contained" onClick={onCreate}>Create Waypoint</Button></DialogActions>
  </Dialog>;
}
