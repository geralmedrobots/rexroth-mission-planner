import { useEffect } from 'react';
import { mqttService } from '../services/MqttService';
import { LogService } from '../services/LogService';
import {
  buildSpeedCycleDiagnostic, formatSpeedCycleDiagnostic,
} from '../domain/robot/SpeedLimitDiagnostics';
import { useAppStore } from '../stores/appStore';
import { vdaConnectionSchema, vdaStateSchema, vdaVisualizationSchema } from '../schemas/vdaSchemas';
import { selectCurrentRobotPose } from '../domain/robot/RobotPoseSelector';
import {
  normalizeMapId, payloadMatchesRobotIdentity, resolveActiveNavigatorMap,
} from '../domain/robot/ActiveMapResolver';
import { recordStateReceive, recordVisualizationReceive } from '../domain/robot/TelemetryFreshness';
import { useCorridorCompatibilityStore } from '../features/corridorCompatibility/corridorCompatibilityStore';

export const useMqtt = ():void => {
  const set=useAppStore((s)=>s.set); const settings=useAppStore((s)=>s.mqttSettings);
  useEffect(()=>LogService.subscribe((entry)=>useAppStore.getState().addLog(entry)),[]);
  useEffect(()=>mqttService.subscribe((event)=>{
    if(event.type==='status'){set({mqttConnected:event.connected});LogService.write('mqtt',event.connected?'info':'warning',event.message);return;}
    if(event.type==='publish'){LogService.write('mqtt',event.success?'info':'error',`${event.topic}: ${event.message}`);return;}
    LogService.write('mqtt','info',`RX ${event.topic}`);
    try{
      const raw:unknown=JSON.parse(event.payload);
      if(event.topic===settings.topics.state){
        const parsed=vdaStateSchema.safeParse(raw);
        if(parsed.success){
          const state=parsed.data;
          const receivedAtMs=Date.now(); const receivedAt=new Date(receivedAtMs).toISOString();
          const current=useAppStore.getState();
          const identity=current.orderSettings;
          if(!payloadMatchesRobotIdentity(state,identity)){
            LogService.write('mqtt','warning',
              `[state] ignored identity mismatch payload=${state.manufacturer??'<missing>'}/${state.serialNumber??'<missing>'}/${state.version??'<missing>'} configured=${identity.manufacturer}/${identity.serialNumber}/${identity.version}`);
            return;
          }
          current.recordNavigatorMapId(state.agvPosition?.mapId,'state',identity.manufacturer,identity.serialNumber);
          const afterMap=useAppStore.getState();
          if(afterMap.mapBindingMismatchWarning&&current.confirmedMapBinding)
            LogService.write('system','warning',`[map]\n${afterMap.mapBindingMismatchWarning}`);
          const mapId=normalizeMapId(state.agvPosition?.mapId);
          if(mapId) LogService.write('system','info',`[map]\nactive Navigator mapId updated\nsource=state\nvalue=${mapId}`);
          else LogService.write('system','info',`[map]\nignored empty state mapId\npreserved=${afterMap.lastKnownValidNavigatorMapId??'<empty>'}`);
          const metadata=recordStateReceive(
            afterMap.mqttReceiveMetadata,state.timestamp??null,receivedAtMs);
          const stateFresh=true;
          const visualizationFresh=metadata.lastVisualizationReceiveTime !== null
            && receivedAtMs-metadata.lastVisualizationReceiveTime<=afterMap.orderSettings.stateStaleTimeoutMs;
          const mapResolution=resolveActiveNavigatorMap({
            stateMapId:afterMap.stateMapId,
            visualizationMapId:visualizationFresh?afterMap.visualizationMapId:null,
            lastKnownValidMapId:afterMap.lastKnownValidNavigatorMapId,
            confirmedBinding:afterMap.confirmedMapBinding,
            manufacturer:identity.manufacturer,serialNumber:identity.serialNumber,
          });
          afterMap.setActiveMapResolution(mapResolution);
          const snapshot=selectCurrentRobotPose({
            state,visualization:afterMap.visualization,lastStateReceiveTime:receivedAtMs,
            lastVisualizationReceiveTime:metadata.lastVisualizationReceiveTime??undefined,
            stateFresh,visualizationFresh,activeMapResolution:mapResolution,
          });
           afterMap.receiveRokitErrors(state.errors??[],receivedAt,state.orderId??'');
           set({state,rawStatePayload:raw,stateReceivedAt:receivedAt,
             mqttReceiveMetadata:metadata});
           afterMap.updateTelemetryStart(snapshot?.pose??afterMap.start);
           useCorridorCompatibilityStore.getState().receiveState(
             state,receivedAtMs,0,
             metadata.lastVisualizationReceiveTime===null?Number.POSITIVE_INFINITY:
               receivedAtMs-metadata.lastVisualizationReceiveTime,
           );
          LogService.write('mqtt','info',
            `[state]\nreceivedAt=${receivedAt}\npayloadTimestamp=${state.timestamp??'<empty>'}\nageMs=0\nmapId=${state.agvPosition?.mapId??'<empty>'}\npositionInitialized=${state.agvPosition?.positionInitialized??false}\nx=${state.agvPosition?.x??'<missing>'}\ny=${state.agvPosition?.y??'<missing>'}\ntheta=${state.agvPosition?.theta??'<missing>'}`);
          const speedStore=useAppStore.getState();
          const speedDiagnostic=buildSpeedCycleDiagnostic(
            state,raw,speedStore.sentOrder??speedStore.generatedOrder);
          speedStore.set({speedCycleDiagnostic:speedDiagnostic});
          LogService.write('mqtt','info',formatSpeedCycleDiagnostic(
            speedDiagnostic));
        }else LogService.write('mqtt','error',`Invalid state: ${parsed.error.message}`);
      }else if(event.topic===settings.topics.visualization){
        const parsed=vdaVisualizationSchema.safeParse(raw);
        if(parsed.success){
          const visualization=parsed.data;
          const receivedAtMs=Date.now(); const receivedAt=new Date(receivedAtMs).toISOString();
          const current=useAppStore.getState();
          const identity=current.orderSettings;
          if(!payloadMatchesRobotIdentity(visualization,identity)){
            LogService.write('mqtt','warning',
              `[visualization] ignored identity mismatch payload=${visualization.manufacturer}/${visualization.serialNumber}/${visualization.version} configured=${identity.manufacturer}/${identity.serialNumber}/${identity.version}`);
            return;
          }
          current.recordNavigatorMapId(visualization.agvPosition?.mapId,'visualization',identity.manufacturer,identity.serialNumber);
          const afterMap=useAppStore.getState();
          if(afterMap.mapBindingMismatchWarning&&current.confirmedMapBinding)
            LogService.write('system','warning',`[map]\n${afterMap.mapBindingMismatchWarning}`);
          const mapId=normalizeMapId(visualization.agvPosition?.mapId);
          if(mapId) LogService.write('system','info',`[map]\nactive Navigator mapId candidate updated\nsource=visualization\nvalue=${mapId}`);
          else LogService.write('system','info',`[map]\nignored empty visualization mapId\npreserved=${afterMap.lastKnownValidNavigatorMapId??'<empty>'}`);
          const metadata=recordVisualizationReceive(
            afterMap.mqttReceiveMetadata,visualization.timestamp??null,receivedAtMs);
          const stateFresh=metadata.lastStateReceiveTime !== null
            && receivedAtMs-metadata.lastStateReceiveTime<=afterMap.orderSettings.stateStaleTimeoutMs;
          const mapResolution=resolveActiveNavigatorMap({
            stateMapId:stateFresh?afterMap.stateMapId:null,
            visualizationMapId:afterMap.visualizationMapId,
            lastKnownValidMapId:afterMap.lastKnownValidNavigatorMapId,
            confirmedBinding:afterMap.confirmedMapBinding,
            manufacturer:identity.manufacturer,serialNumber:identity.serialNumber,
          });
          afterMap.setActiveMapResolution(mapResolution);
          const snapshot=selectCurrentRobotPose({
            state:afterMap.state,visualization,lastStateReceiveTime:metadata.lastStateReceiveTime??undefined,
            lastVisualizationReceiveTime:receivedAtMs,stateFresh,visualizationFresh:true,
            activeMapResolution:mapResolution,
          });
           set({visualization,rawVisualizationPayload:raw,visualizationReceivedAt:receivedAt,
             mqttReceiveMetadata:metadata});
           afterMap.updateTelemetryStart(snapshot?.pose??afterMap.start);
           useCorridorCompatibilityStore.getState().receiveVisualization(
             visualization,raw,receivedAtMs);
          LogService.write('mqtt','info',
            `[visualization]\nreceivedAt=${receivedAt}\npayloadTimestamp=${visualization.timestamp}\nageMs=0\nmapId=${visualization.agvPosition?.mapId??'<empty>'}\npositionInitialized=${visualization.agvPosition?.positionInitialized??false}\nx=${visualization.agvPosition?.x??'<missing>'}\ny=${visualization.agvPosition?.y??'<missing>'}\ntheta=${visualization.agvPosition?.theta??'<missing>'}`);
          const speedStore=useAppStore.getState();
          if(speedStore.state){
            const speedDiagnostic=buildSpeedCycleDiagnostic(
              {...speedStore.state,velocity:visualization.velocity},
              raw,speedStore.sentOrder??speedStore.generatedOrder);
            speedStore.set({speedCycleDiagnostic:speedDiagnostic});
            LogService.write('mqtt','info',
              formatSpeedCycleDiagnostic(speedDiagnostic));
          }
        }
        else LogService.write('mqtt','error',`Invalid visualization: ${parsed.error.message}`);
      }else if(event.topic===settings.topics.connection){
        const parsed=vdaConnectionSchema.safeParse(raw);
        if(parsed.success){
          const current=useAppStore.getState();
          if(!payloadMatchesRobotIdentity(parsed.data,current.orderSettings)){
            LogService.write('mqtt','warning','[connection] ignored identity mismatch');
            return;
          }
          const receivedAtMs=Date.now();
          set({connection:parsed.data,connectionReceivedAt:new Date(receivedAtMs).toISOString(),
            lastConnectionReceiveTime:receivedAtMs});
        }
        else LogService.write('mqtt','error',`Invalid connection: ${parsed.error.message}`);
      }
    }catch(error){LogService.write('mqtt','error',`Malformed JSON on ${event.topic}: ${String(error)}`);}
  }),[set,settings.topics]);
};
