import { Download, Refresh } from '@mui/icons-material';
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper,
  Select, Stack, Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeMapId } from '../../../domain/robot/ActiveMapResolver';
import type { OccupancyGrid } from '../../../domain/types';
import { LogService } from '../../../services/LogService';
import { useAppStore } from '../../../stores/appStore';
import { findExactServerMap } from '../mapSelection';
import { locatorMapService } from '../services/locatorMapService';
import { useLocatorStore } from '../stores/locatorStore';

const mismatchText =
  'The active ROKIT Navigator mapId does not match any map available on the configured ROKIT Locator Server.';
const noMqttMapText =
  'No active mapId was received from MQTT. Select a Locator map and confirm it manually.';

export function LocatorMapSelector({ onMapLoaded }: { onMapLoaded: (grid: OccupancyGrid) => void }) {
  const store=useLocatorStore();
  const app=useAppStore();
  const [confirmOpen,setConfirmOpen]=useState(false);
  const attemptedActiveMap=useRef('');
  const moduleReady=Boolean(store.testResult?.serverMapModule);
  const mqttMapId=normalizeMapId(app.lastKnownValidNavigatorMapId);
  const selectedMapName=normalizeMapId(store.selectedMapName);
  const loadedMapName=normalizeMapId(store.loadedMap?.mapName);
  const selectedMapIsLoaded=Boolean(
    selectedMapName&&loadedMapName&&selectedMapName===loadedMapName);

  const listMaps=useCallback(async()=>{
    if(store.sessionState!=='logged-in')throw new Error('Login to the Locator Server first.');
    if(!moduleReady)throw new Error('Test the RPC connection and verify the ServerMap module first.');
    const maps=await locatorMapService.listMaps();
    store.set({maps,error:undefined});
    LogService.write('system','info',`serverMapList returned ${maps.length} map(s).`);
    return maps;
  },[moduleReady,store]);

  const load=useCallback(async(name:string)=>{
    if(!name)throw new Error('Select a Locator map first.');
    const resolution=store.settings.imagePixelsPerMeter;
    if(!(resolution>0))throw new Error('Image resolution must be greater than zero.');
    store.set({downloading:true,error:undefined,selectedMapName:name});
    try{
      const info=await locatorMapService.getMapInfo(name);
      const raster=await locatorMapService.getMapImageWithResolution(name,resolution);
      const loaded=await locatorMapService.toOccupancy(raster,store.settings);
      store.set({loadedMap:raster,mapInfo:info,lastDownloadTime:new Date().toISOString()});
      onMapLoaded(loaded.occupancy);
      LogService.write('planner','info',
        `Loaded Locator map "${name}" (${raster.pixelWidth}×${raster.pixelHeight}, origin ${raster.origin.x}/${raster.origin.y}/${raster.origin.yaw}).`);
    }catch(error){
      store.set({error:String(error)});
      LogService.write('system','error',`Locator map download failed: ${String(error)}`);
    }finally{store.set({downloading:false});}
  },[onMapLoaded,store]);

  const loadActive=useCallback(async()=>{
    const active=normalizeMapId(useAppStore.getState().lastKnownValidNavigatorMapId);
    if(!active)throw new Error(noMqttMapText);
    const maps=store.maps.length?store.maps:await listMaps();
    const exact=findExactServerMap(maps,active);
    if(!exact){
      store.set({error:mismatchText});
      LogService.write('system','error',mismatchText);
      return;
    }
    await load(exact.name);
  },[listMaps,load,store]);

  useEffect(()=>{
    if(!mqttMapId||store.sessionState!=='logged-in'||!moduleReady||
        attemptedActiveMap.current===mqttMapId)return;
    attemptedActiveMap.current=mqttMapId;
    void loadActive().catch((error)=>{
      store.set({error:String(error)});
      LogService.write('system','error',String(error));
    });
  },[loadActive,moduleReady,mqttMapId,store]);

  const selectMap=(name:string):void=>{
    const binding=app.confirmedMapBinding;
    if(binding&&normalizeMapId(binding.locatorMapName)!==normalizeMapId(name)){
      app.clearConfirmedMapBinding();
      LogService.write('system','warning',
        'Confirmed map binding cleared because the selected Locator map changed.');
    }
    store.set({selectedMapName:name});
  };

  const confirmBinding=():void=>{
    if(!selectedMapName||!selectedMapIsLoaded||mqttMapId)return;
    app.confirmMapBinding(
      selectedMapName,app.orderSettings.manufacturer,app.orderSettings.serialNumber);
    LogService.write('system','warning',
      `[map]\nuser-confirmed Locator map binding\nvalue=${selectedMapName}\nrobot=${app.orderSettings.manufacturer}/${app.orderSettings.serialNumber}`);
    setConfirmOpen(false);
  };

  return <Paper variant="outlined" sx={{p:1.5}}>
    <Typography variant="subtitle2">Server Maps</Typography>
    <Stack gap={1} mt={1}>
      <Select size="small" displayEmpty value={store.selectedMapName}
        onChange={(event)=>selectMap(event.target.value)}>
        <MenuItem value=""><em>Select Locator map</em></MenuItem>
        {store.maps.map((map)=><MenuItem key={map.name} value={map.name}>{map.name}</MenuItem>)}
      </Select>
      {store.error===mismatchText&&<Alert severity="error">{mismatchText}</Alert>}
      <Stack direction="row" gap={1} flexWrap="wrap">
        <Button disabled={!moduleReady||store.sessionState!=='logged-in'}
          onClick={()=>void listMaps().catch((error)=>store.set({error:String(error)}))}>
          List Maps
        </Button>
        <Button disabled={!moduleReady||store.sessionState!=='logged-in'} startIcon={<Download/>}
          onClick={()=>void loadActive().catch((error)=>{
            store.set({error:String(error)});LogService.write('system','error',String(error));
          })}>Load Active Map</Button>
        <Button startIcon={<Download/>}
          disabled={!moduleReady||store.sessionState!=='logged-in'||!store.selectedMapName||store.downloading}
          onClick={()=>void load(store.selectedMapName)}>Load Selected</Button>
        <Button startIcon={<Refresh/>} disabled={!store.loadedMap||store.downloading}
          onClick={()=>store.loadedMap&&void load(store.loadedMap.mapName)}>Reload Map</Button>
        <Button variant="outlined" color="warning"
          disabled={!selectedMapName||!store.loadedMap||!selectedMapIsLoaded||Boolean(mqttMapId)}
          onClick={()=>setConfirmOpen(true)}>Use Selected Map as Navigator Map ID</Button>
        <Button color="warning" disabled={!app.confirmedMapBinding&&!app.mapBindingMismatchWarning}
          onClick={()=>app.clearConfirmedMapBinding()}>Clear Map Binding</Button>
      </Stack>
      {!mqttMapId&&<Alert severity="info">{noMqttMapText}</Alert>}
      <Stack spacing={.25}>
        <Typography variant="caption">MQTT state mapId: {app.stateMapId??'<empty>'}</Typography>
        <Typography variant="caption">MQTT visualization mapId: {app.visualizationMapId??'<empty>'}</Typography>
        <Typography variant="caption">Loaded Locator map: {loadedMapName??'<none>'}</Typography>
        <Typography variant="caption">Resolved Navigator mapId: {app.activeNavigatorMapId??'<none>'}</Typography>
        <Typography variant="caption">Map ID source: {app.activeNavigatorMapSource}</Typography>
      </Stack>
      {app.activeNavigatorMapSource==='manual-confirmed'&&<Alert severity="warning">
        Navigator mapId is not being received through MQTT. A user-confirmed map binding is active.
      </Alert>}
      {app.mapBindingMismatchWarning&&<Alert severity="warning">{app.mapBindingMismatchWarning}</Alert>}
      {store.downloading&&<Alert severity="info">Downloading and decoding the real Locator PNG map…</Alert>}
    </Stack>
    <Dialog open={confirmOpen} onClose={()=>setConfirmOpen(false)} maxWidth="sm" fullWidth>
      <DialogTitle>Confirm Navigator map binding</DialogTitle>
      <DialogContent>
        <Typography sx={{whiteSpace:'pre-line'}}>
          {'ROKIT Navigator has not provided agvPosition.mapId through MQTT.\n\n'}
          Selected Locator map:{'\n'}{selectedMapName}{'\n\n'}
          Use this exact map name as the mapId in generated VDA 5050 orders for robot{' '}
          {app.orderSettings.manufacturer} / {app.orderSettings.serialNumber}?
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={()=>setConfirmOpen(false)}>Cancel</Button>
        <Button variant="contained" color="warning" onClick={confirmBinding}>
          Confirm Map Binding
        </Button>
      </DialogActions>
    </Dialog>
  </Paper>;
}
