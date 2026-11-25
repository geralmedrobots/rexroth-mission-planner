import { useEffect, useRef } from 'react';
import type { OccupancyGrid } from '../../domain/types';
import { normalizeMapId } from '../../domain/robot/ActiveMapResolver';
import { LogService } from '../../services/LogService';
import { mqttService } from '../../services/MqttService';
import { useAppStore } from '../../stores/appStore';
import { locatorMapService } from '../locator/services/locatorMapService';
import { locatorSessionService } from '../locator/services/locatorSessionService';
import { useLocatorStore } from '../locator/stores/locatorStore';
import { startupConnectionManager } from './StartupConnectionManager';
import { useStartupStore } from './startupStore';
import type { StartupOperation } from './types';

const waitFor=async(
  condition:()=>boolean,timeoutMs:number,signal:AbortSignal,message:string,
):Promise<void>=>{
  const started=Date.now();
  while(!condition()){
    if(signal.aborted)throw new DOMException('Startup cancelled.','AbortError');
    if(Date.now()-started>timeoutMs)throw new Error(message);
    await new Promise((resolve)=>setTimeout(resolve,250));
  }
};

export function useStartupConnections(onGridLoaded:(grid:OccupancyGrid)=>void):void {
  const retryToken=useStartupStore((state)=>state.retryToken);
  const callbackRef=useRef(onGridLoaded);callbackRef.current=onGridLoaded;
  useEffect(()=>{
    const operations:StartupOperation[]=[
      {phase:'LOADING_CONFIGURATION',message:'Loading saved application configuration…',run:async()=>{}},
      {phase:'CONNECTING_MQTT',message:'Connecting to the robot message broker…',retries:2,run:async()=>{
        const app=useAppStore.getState();
        if(!app.mqttSettings.automaticConnection)throw new Error('Automatic MQTT connection is disabled.');
        mqttService.connect(app.mqttSettings);
      }},
      {phase:'CONNECTING_LOCATOR',message:'Connecting to ROKIT Locator…',retries:2,optional:true,run:async(signal)=>{
        const locator=useLocatorStore.getState();
        if(!locator.settings.automaticConnection)throw new Error('Automatic Locator connection is disabled.');
        locator.set({connectionState:'testing',error:undefined});
        try{
          await locatorSessionService.connect(locator.settings);
          if(signal.aborted)return;
          const testResult=await locatorSessionService.test();
          if(signal.aborted)return;
          if(!testResult.serverMapModule)throw new Error('ROKIT Locator ServerMap module is unavailable.');
          locator.set({connectionState:'ready',testResult});
          LogService.write('system','info','ROKIT Locator connected.');
        }catch(error){
          if(!signal.aborted)locator.set({
            connectionState:'error',testResult:undefined,
            error:error instanceof Error?error.message:String(error),
          });
          throw error;
        }
      }},
      {phase:'AUTHENTICATING_LOCATOR',message:'Authenticating the secure Locator session…',retries:2,optional:true,run:async()=>{
        const locator=useLocatorStore.getState();
        if(!locator.settings.automaticLogin)throw new Error('Automatic Locator login is disabled.');
        locator.set({sessionState:'logging-in',error:undefined});
        try{
          await locatorSessionService.automaticLogin();
          locator.set({sessionState:'logged-in'});
          LogService.write('system','info','ROKIT Locator automatic sessionLogin succeeded.');
        }catch(error){
          locator.set({sessionState:'logged-out',error:error instanceof Error?error.message:String(error)});
          throw error;
        }
      }},
      {phase:'LOADING_MAPS',message:'Reading Locator server maps…',retries:1,optional:true,run:async()=>{
        const maps=await locatorMapService.listMaps();
        useLocatorStore.getState().set({maps});
        LogService.write('system','info',`Locator returned ${maps.length} available map(s).`);
      }},
      {phase:'RESOLVING_MAP',message:'Resolving the active navigation map…',optional:true,run:async(signal)=>{
        await waitFor(()=>{
          const app=useAppStore.getState();
          const binding=app.confirmedMapBinding;
          return Boolean(normalizeMapId(app.activeNavigatorMapId)||
            (binding&&binding.manufacturer===app.orderSettings.manufacturer&&
              binding.serialNumber===app.orderSettings.serialNumber&&normalizeMapId(binding.locatorMapName)));
        },8_000,signal,'Navigator mapId is unavailable. Confirm a Locator map binding in advanced settings.');
      }},
      {phase:'LOADING_MAP',message:'Loading the matching hospital navigation map…',optional:true,run:async()=>{
        const app=useAppStore.getState();const locator=useLocatorStore.getState();
        const binding=app.confirmedMapBinding;
        const mapId=normalizeMapId(app.activeNavigatorMapId)||
          (binding&&binding.manufacturer===app.orderSettings.manufacturer&&
            binding.serialNumber===app.orderSettings.serialNumber?normalizeMapId(binding.locatorMapName):null);
        if(!mapId)throw new Error('No resolved navigation map is available.');
        const match=locator.maps.find((map)=>normalizeMapId(map.name)===mapId);
        if(!match)throw new Error(`Resolved map "${mapId}" is not available on ROKIT Locator.`);
        if(locator.loadedMap?.mapName===match.name)return;
        locator.set({downloading:true,selectedMapName:match.name,error:undefined});
        try{
          const [info,raster]=await Promise.all([
            locatorMapService.getMapInfo(match.name),
            locatorMapService.getMapImageWithResolution(match.name,locator.settings.imagePixelsPerMeter),
          ]);
          const loaded=await locatorMapService.toOccupancy(raster,locator.settings);
          locator.set({loadedMap:raster,mapInfo:info,lastDownloadTime:new Date().toISOString()});
          callbackRef.current(loaded.occupancy);
          LogService.write('planner','info','Map loaded successfully.');
        }finally{locator.set({downloading:false});}
      }},
      {phase:'WAITING_FOR_ROBOT',message:'Waiting for fresh localization and robot state…',optional:true,run:async(signal)=>{
        await waitFor(()=>{
          const app=useAppStore.getState();
          const received=app.mqttReceiveMetadata.lastStateReceiveTime;
          return app.mqttConnected&&app.connection?.connectionState?.toUpperCase()==='ONLINE'&&
            received!==null&&Date.now()-received<=app.orderSettings.stateStaleTimeoutMs&&
            app.state?.agvPosition?.positionInitialized===true;
        },15_000,signal,'Robot state or localization is not ready.');
      }},
    ];
    void startupConnectionManager.start(operations,useStartupStore.getState().setSnapshot);
    return()=>startupConnectionManager.cancel();
  },[retryToken]);
}
