import {
  AltRoute, Autorenew, BugReport, ChevronLeft, ChevronRight, Cloud,
  Delete, Download, ExpandLess, ExpandMore, Map,
  Pause, PlayArrow, Refresh, Save, Settings, StopCircle,
  Upload, Place, ListAlt, MonitorHeart, Subject, AddLocationAlt, Sensors,
} from '@mui/icons-material';
import {
  Alert, AppBar, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, Drawer, FormControlLabel, IconButton, List, ListItemButton, ListItemIcon,
  ListItemText, MenuItem, Paper, Select, Snackbar, Stack, Switch, Tab, Tabs, TextField,
  Toolbar, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { MedRobotsLogo } from './app/MedRobotsLogo';
import { StatusPill } from './app/StatusPill';
import { MapCanvas, type ClickMode } from './components/MapCanvas';
import { CoordinateTransformer } from './domain/geometry/CoordinateTransformer';
import { normalizeAngle, radiansToDegrees } from './domain/geometry/angles';
import {
  normalizeMissionMaximumSpeed, clampStateStaleTimeoutMs,
} from './domain/defaults';
import { imageFileToPixels, metadataFromRosYaml, parseOccupancyJson, pixelsToOccupancy } from './domain/map/MapImporter';
import { ObstacleInflation } from './domain/planner/ObstacleInflation';
import { PathCollisionValidator } from './domain/planner/PathCollisionValidator';
import { MissionMonitor } from './domain/order/MissionMonitor';
import { selectCurrentRobotPose } from './domain/robot/RobotPoseSelector';
import { parseBoschVehicleConfiguration } from './domain/robot/BoschVehicleConfiguration';
import { analyzeSpeedLimits } from './domain/robot/SpeedLimitDiagnostics';
import { compareMapIds, resolveActiveNavigatorMap } from './domain/robot/ActiveMapResolver';
import { getLocalMessageAgeMs, isLocalMessageFresh } from './domain/robot/TelemetryFreshness';
import type {
  OccupancyGrid, PathPoint, PlannerOptions, PlannerResult, RobotFootprint, RobotPose,
  ValidationResult, VdaInstantAction, VdaOrder, Waypoint,
} from './domain/types';
import { DeliveryConsole } from './features/pharmacy/DeliveryConsole';
import { MissionsPanel } from './features/mission/MissionsPanel';
import { useMissionWorkspace } from './features/mission/useMissionWorkspace';
import { newMission, observeRun, inFlight, useMissionLibrary, type MissionRun } from './features/mission/missionLibrary';
import { QuickDestinations } from './features/destinations/QuickDestinations';
import { WaypointEditor, WaypointsPanel } from './features/destinations/WaypointsPanel';
import { waypointPositionError, type WaypointDraft } from './features/destinations/waypointPosition';
import type { SavedDestination } from './features/destinations/destinationStore';
import { sanitizeDiagnostics } from './features/diagnostics/sanitize';
import { CorridorCompatibilityPanel } from './features/corridorCompatibility/CorridorCompatibilityPanel';
import {
  createCorridorTestOrder, serializeCorridorTestOrder,
} from './features/corridorCompatibility/CorridorCompatibilityService';
import {
  getCompatibilitySpecificDispatchIssues,
} from './features/corridorCompatibility/CompatibilityDispatchGate';
import {
  useCorridorCompatibilityStore,
} from './features/corridorCompatibility/corridorCompatibilityStore';
import type { CorridorTestVariant } from './features/corridorCompatibility/types';
import { getActiveNavigatorOrderId, getDispatchIssues } from './features/mission/dispatchGate';
import { validateDestination } from './features/mission/destinationValidation';
import { getRouteStatus } from './features/mission/routeStatus';
import { useOperatorSettingsStore } from './features/settings/operatorSettingsStore';
import { parseSettingsFile } from './features/settings/settingsFile';
import { StartupOverlay } from './features/startup/StartupOverlay';
import { useStartupConnections } from './features/startup/useStartupConnections';
import { InstantActionBuilder, isInstantActionSupported } from './domain/vda5050/InstantActionBuilder';
import { getOrderGenerationIssues, type OrderGenerationPrerequisites } from './domain/vda5050/OrderGenerationGuard';
import { VdaOrderBuilder } from './domain/vda5050/VdaOrderBuilder';
import { BoschRokitCorridorValidator } from './domain/vda5050/BoschRokitCorridorValidator';
import { getFirstNodeDiagnostics, type OrderValidationContext, VdaOrderValidator } from './domain/vda5050/VdaOrderValidator';
import { LocatorConnectionPanel } from './features/locator/components/LocatorConnectionPanel';
import { LocatorMapSelector } from './features/locator/components/LocatorMapSelector';
import { LocatorMapStatus } from './features/locator/components/LocatorMapStatus';
import { locatorSessionService } from './features/locator/services/locatorSessionService';
import { useLocatorStore } from './features/locator/stores/locatorStore';
import { useMqtt } from './hooks/useMqtt';
import { GlobalReplanningPanel } from './features/replanning/GlobalReplanningPanel';
import { useGlobalReplanning } from './features/replanning/useGlobalReplanning';
import { useGlobalReplanningStore } from './features/replanning/globalReplanningStore';
import { LogService } from './services/LogService';
import { createDiagnosticEvent, OperationalLogDiagnosticSink } from './features/diagnostics/DiagnosticEvent';
import { mqttService } from './services/MqttService';
import { useAppStore, type AppState } from './stores/appStore';
import { PlanningCoordinator } from './features/planning/PlanningCoordinator';
import { isCurrentRouteOrder, RoutePreparationGuard } from './features/planning/RouteRevisionGuard';
import { createPlanningConfigurationSnapshot } from './domain/planning/PlanningConfigurationSnapshot';
import { validateMotionPlannerScenarioArtifact } from './domain/planning/MotionPlannerScenarioArtifact';
import { buildLegacyMotionPlan } from './domain/motion/LegacyMotionPlanBuilder';
import { MissionController } from './features/mission/MissionController';
import { stage5BRecording } from './services/Stage5BRecordingService';

const navExpandedWidth=184; const navCollapsedWidth=56; const rightWidth=328;
const safety='This application is not a safety function. Vehicle safety must be provided by certified safety hardware and the machine safety system.';
const publishWarning='Test only in a controlled area. Use a low maximum speed. Ensure emergency stop, drive enable, safety PLC, motor timeout, and braking are operational.';
const operationalDiagnosticSink = new OperationalLogDiagnosticSink((category, level, message) =>
  LogService.write(category, level, message));
const appSessionId = crypto.randomUUID();
const planningCoordinator = new PlanningCoordinator({ diagnostics: operationalDiagnosticSink,
  onRecordingStart: (inputs, configuration) => stage5BRecording.start(inputs, configuration),
  onScenarioCaptured: artifact => useAppStore.getState().set({lastPlanningScenario:artifact}),
});
const missionController = new MissionController(operationalDiagnosticSink);
interface ConfirmationState {
  title:string;
  message:string;
  confirmLabel:string;
  destructive?:boolean;
}
type Notice = {severity:'success'|'warning'|'error'|'info';message:string};

function routeContext(app: AppState, loadedMapName: string | undefined, now: number) {
  const receive = app.mqttReceiveMetadata;
  const timeout = app.orderSettings.stateStaleTimeoutMs;
  const stateAge = getLocalMessageAgeMs(receive.lastStateReceiveTime, now);
  const visualizationAge = getLocalMessageAgeMs(receive.lastVisualizationReceiveTime, now);
  const stateFresh = isLocalMessageFresh(receive.lastStateReceiveTime, timeout, now);
  const visualizationFresh = isLocalMessageFresh(receive.lastVisualizationReceiveTime, timeout, now);
  const connectionOnline = app.connection?.connectionState?.toUpperCase() === 'ONLINE';
  const activeMapResolution = resolveActiveNavigatorMap({
    stateMapId: stateFresh ? app.stateMapId : null,
    visualizationMapId: visualizationFresh ? app.visualizationMapId : null,
    lastKnownValidMapId: app.lastKnownValidNavigatorMapId,
    confirmedBinding: app.confirmedMapBinding,
    manufacturer: app.orderSettings.manufacturer, serialNumber: app.orderSettings.serialNumber,
  });
  const poseSnapshot = selectCurrentRobotPose({
    state: app.state, visualization: app.visualization,
    lastStateReceiveTime: receive.lastStateReceiveTime ?? undefined,
    lastVisualizationReceiveTime: receive.lastVisualizationReceiveTime ?? undefined,
    stateFresh, visualizationFresh, activeMapResolution,
  });
  const navigatorMapId = activeMapResolution.mapId;
  const validation: OrderValidationContext = {
    mqttConnected: app.mqttConnected, stateReceived: receive.lastStateReceiveTime !== null,
    connectionReceived: Boolean(app.lastConnectionReceiveTime), connectionOnline,
    operatingMode: app.state?.operatingMode, stateAgeMs: stateAge, visualizationAgeMs: visualizationAge,
    positionInitialized: app.state?.agvPosition?.positionInitialized === true, poseSource: poseSnapshot?.source,
    activeMapId: navigatorMapId, currentPose: poseSnapshot?.pose, grid: app.grid, footprint: app.footprint,
    settings: app.orderSettings, locatorMapName: loadedMapName,
    mapIdSource: activeMapResolution.source, lastStateReceiveTime: receive.lastStateReceiveTime,
    corridorSettings: app.plannerOptions.corridor,
  };
  const prerequisites: OrderGenerationPrerequisites = {
    mqttConnected: app.mqttConnected, connectionOnline, operatingMode: app.state?.operatingMode,
    stateAgeMs: stateAge, maximumStateAgeMs: timeout, lastStateReceiveTime: receive.lastStateReceiveTime,
    positionInitialized: validation.positionInitialized, pose: poseSnapshot,
    activeMapId: navigatorMapId, activeMapSource: activeMapResolution.source,
    stateMapId: app.stateMapId, visualizationMapId: app.visualizationMapId,
    lastKnownValidNavigatorMapId: app.lastKnownValidNavigatorMapId,
    confirmedMapBinding: app.confirmedMapBinding, loadedLocatorMapName: loadedMapName,
  };
  return {
    activeMapResolution, navigatorMapId, poseSnapshot, stateAge, visualizationAge,
    stateFresh, visualizationFresh, connectionOnline, validation, prerequisites,
    mapComparison: compareMapIds(loadedMapName, navigatorMapId),
  };
}

const getLiveRouteContext = (app: AppState) =>
  routeContext(app, useLocatorStore.getState().loadedMap?.mapName, Date.now());
const downloadJson=(name:string,value:unknown):void=>{
  const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  link.download=name;link.click();URL.revokeObjectURL(link.href);
};
const syncPlannerWeights=(plannerOptions: PlannerOptions): PlannerOptions=>({
  ...plannerOptions,
  proximityWeight: plannerOptions.passageSafety.wallProximityWeight,
  turnPenalty: plannerOptions.passageSafety.headingChangeWeight,
  reversePenalty: plannerOptions.passageSafety.reverseRiskWeight,
  passageSafety: {
    ...plannerOptions.passageSafety,
    wallProximityWeight: plannerOptions.passageSafety.wallProximityWeight,
    headingChangeWeight: plannerOptions.passageSafety.headingChangeWeight,
    turnLocationWeight: plannerOptions.passageSafety.turnLocationWeight,
    reverseRiskWeight: plannerOptions.passageSafety.reverseRiskWeight,
  },
});
const Field=({label,value}:{label:string;value:unknown})=><Box sx={{display:'flex',justifyContent:'space-between',gap:2}}>
  <Typography color="text.secondary" variant="caption">{label}</Typography><Typography variant="caption" sx={{fontFamily:'monospace',textAlign:'right'}}>{value===undefined?'—':String(value)}</Typography>
</Box>;
const EffectiveMotionStateConfigurationPanel=({plannerOptions,footprint}:{
  plannerOptions:PlannerOptions;footprint:RobotFootprint;
})=>{
  const effective=createPlanningConfigurationSnapshot({plannerOptions,footprint})
    .normalized.motionState;
  return <Paper variant="outlined" sx={{p:1,mt:1}}>
    <Box component="details">
      <Typography component="summary" variant="overline" sx={{cursor:'pointer'}}>
        Effective Motion-State Configuration
      </Typography>
      <Box mt={.5}>
        <Field label="Translation" value={`${effective.weights.translationCostPerM} cost/m`}/>
        <Field label="Rotation" value={`${effective.weights.rotationCostPerRad} cost/rad`}/>
        <Field label="Reverse" value={`${effective.weights.reverseCostPerM} cost/m`}/>
        <Field label="Direction preference" value={`${effective.weights.directionSwitchCost} cost/non-preferred manoeuvre`}/>
        <Field label="Wall clearance" value={effective.weights.wallClearanceCost}/>
        <Field label="Preferred / hard clearance" value={`${effective.clearance.preferredM} / ${effective.clearance.hardMinimumM} m`}/>
        <Field label="Narrow passage" value={effective.weights.narrowPassageCost}/>
        <Field label="Turn location" value={effective.weights.turnLocationCost}/>
        <Field label="Terminal orientation" value={`${effective.weights.terminalOrientationCostPerRad} cost/rad`}/>
        <Field label="Translation / rotation sampling" value={`${effective.sampling.translationCollisionIntervalM} m / ${effective.sampling.rotationCollisionIntervalDeg} deg`}/>
        <Field label="Heading lattice" value={`${effective.lattice.headingBinCount} bins (${effective.lattice.headingStepDeg} deg)`}/>
        <Field label="Translation step" value="active grid resolution"/>
        <Field label="Forward / reverse / rotate" value={`${effective.permissions.forward} / ${effective.permissions.reverse} / ${effective.permissions.rotateInPlace}`}/>
      </Box>
    </Box>
  </Paper>;
};

export default function App(){
  useMqtt();
  useGlobalReplanning();
  const store=useAppStore(); const [mode,setMode]=useState<ClickMode>('goal'); const [bottom,setBottom]=useState(0);
  const speedLimitAnalysis=analyzeSpeedLimits(
    store.orderSettings.missionMaximumSpeedMps,store.speedCycleDiagnostic);
  const [settingsOpen,setSettingsOpen]=useState(false); const [locatorOpen,setLocatorOpen]=useState(false); const [yamlText,setYamlText]=useState<string>();
  const tablet=useMediaQuery('(max-width:1100px)');
  const [navCollapsed,setNavCollapsed]=useState(false);
  const [missionPanelOpen,setMissionPanelOpen]=useState(false);
  const [corridorCompatibilityOpen,setCorridorCompatibilityOpen]=useState(false);
  const [globalReplanningOpen,setGlobalReplanningOpen]=useState(false);
  const [advancedMissionOpen,setAdvancedMissionOpen]=useState(false);
  const [diagnosticsOpen,setDiagnosticsOpen]=useState(false);
  const [diagnosticSearch,setDiagnosticSearch]=useState('');
  const [diagnosticSeverity,setDiagnosticSeverity]=useState<'all'|'info'|'warning'|'error'>('all');
  const [pauseLogScroll,setPauseLogScroll]=useState(false);
  const [toast,setToast]=useState<Notice>();
  const [confirmation,setConfirmation]=useState<ConfirmationState>();
  const confirmationResolver=useRef<((confirmed:boolean)=>void)|null>(null);
  const lastLivePoseResolutionDiagnostic=useRef<string|undefined>(undefined);
  const [planningFailure,setPlanningFailure]=useState<{revision:number;message:string}>();
  const [dispatchCountdown,setDispatchCountdown]=useState<{revision:number;orderId:string;seconds:number}>();
  const dispatchToken=useRef(0);
  const routePreparationGuard=useRef(new RoutePreparationGuard());
  const replanningConfirmation=useRef(false);
  const [replanningPending,setReplanningPending]=useState(false);
  const [yamlName,setYamlName]=useState<string>();
  const [yamlLoading,setYamlLoading]=useState(false);
  const [mapImporting,setMapImporting]=useState(false);
  const mapImportToken=useRef(0);
  const yamlImportToken=useRef(0);
  const logViewport=useRef<HTMLDivElement>(null);
  const [waypointsOpen,setWaypointsOpen]=useState(false);
  const [systemsOpen,setSystemsOpen]=useState(false);
  const [draft,setDraft]=useState<WaypointDraft>();
  const [placement,setPlacement]=useState<{mapId:string;item?:SavedDestination}>();
  const [focusedPoint,setFocusedPoint]=useState<SavedDestination>();
  const [deliveryOpen,setDeliveryOpen]=useState(false);
  const workspace=useMissionWorkspace(getLiveRouteContext);
  const operatorSettings=useOperatorSettingsStore((state)=>state.settings);
  const globalReplanning=useGlobalReplanningStore();
  const locator=useLocatorStore();
  const evaluateCompatibilityTimeout=useCorridorCompatibilityStore(
    (state)=>state.evaluateTimeout);
  const setLocator=useLocatorStore((state)=>state.set);
  const setActiveMapResolution=useAppStore((state)=>state.setActiveMapResolution);
  const imageInput=useRef<HTMLInputElement>(null); const jsonInput=useRef<HTMLInputElement>(null); const yamlInput=useRef<HTMLInputElement>(null);
  const [now,setNow]=useState(Date.now());
  const drawerWidth=navCollapsed?navCollapsedWidth:navExpandedWidth;
  useEffect(()=>{document.title='Med Robots Navigation Control';},[]);
  useEffect(()=>{
    const listener=(event:Event):void=>{
      const detail=(event as CustomEvent<{
        severity:'success'|'warning'|'error';message:string;
      }>).detail;
      if(detail)setToast(detail);
    };
    window.addEventListener('global-replanning-notification',listener);
    return()=>window.removeEventListener('global-replanning-notification',listener);
  },[]);
  const requestConfirmation=(options:ConfirmationState):Promise<boolean>=>{
    if(confirmationResolver.current)return Promise.resolve(false);
    setConfirmation(options);
    return new Promise((resolve)=>{confirmationResolver.current=resolve;});
  };
  const closeConfirmation=(confirmed:boolean):void=>{
    const resolve=confirmationResolver.current;
    confirmationResolver.current=null;setConfirmation(undefined);resolve?.(confirmed);
  };
  useEffect(()=>()=>confirmationResolver.current?.(false),[]);
  const changeReplanningEnabled=async(enabled:boolean):Promise<void>=>{
    if(replanningConfirmation.current||useGlobalReplanningStore.getState().settings.enabled===enabled)return;
    if(enabled){
      replanningConfirmation.current=true;
      setReplanningPending(true);
      try{
        if(!await requestConfirmation({
          title:'Enable automatic global replanning?',
          message:'When a blocked route is confirmed, the application may cancel the active Order and publish a new independently planned Order without another prompt.\n\n'+safety,
          confirmLabel:'Enable Automatic Replanning',
        }))return;
      }finally{
        replanningConfirmation.current=false;
        setReplanningPending(false);
      }
    }
    const replanning=useGlobalReplanningStore.getState();
    replanning.updateSettings({enabled});
    replanning.resetRuntime();
    setToast({severity:'info',message:enabled
      ?'Automatic replanning enabled for eligible active missions.'
      :'Automatic replanning disabled.'});
  };
  useEffect(()=>{if(tablet)setNavCollapsed(true);},[tablet]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>evaluateCompatibilityTimeout(now),[evaluateCompatibilityTimeout,now]);
  const receiveMetadata=store.mqttReceiveMetadata;
  const {
    stateAge, visualizationAge, stateFresh, visualizationFresh, connectionOnline,
    activeMapResolution, poseSnapshot, navigatorMapId, mapComparison:locatorComparison,
    validation:currentValidationContext,
  }=routeContext(store,locator.loadedMap?.mapName,now);
  const stale=!stateFresh;
  const displayedState=store.mqttConnected&&stateFresh?store.state:undefined;
  const activeMapId=navigatorMapId??'—';
  const locatorMismatch=Boolean(navigatorMapId&&locator.loadedMap&&!locatorComparison.matches);
  useEffect(()=>{
    const pose=poseSnapshot?.pose;
    const message=[
      '[live-pose-resolution-check]',
      `poseSnapshot=${pose?'present':'missing'}`,
      `source=${poseSnapshot?.source??'<none>'}`,
      `mapIdSource=${poseSnapshot?.mapIdSource??'<none>'}`,
      `activeMap=${navigatorMapId??'<none>'}`,
      `activeMapSource=${activeMapResolution.source}`,
      `loadedLocatorMap=${locator.loadedMap?.mapName??'<none>'}`,
      `confirmedBinding=${store.confirmedMapBinding?.locatorMapName??'<none>'}`,
      `stateMapId=${store.stateMapId??'<empty>'}`,
      `visualizationMapId=${store.visualizationMapId??'<empty>'}`,
      `world=${pose?`(${pose.x.toFixed(3)},${pose.y.toFixed(3)},theta=${pose.theta.toFixed(3)})`:'<none>'}`,
      `positionInitialized=${pose?.positionInitialized??false}`,
    ].join('\n');
    if(message===lastLivePoseResolutionDiagnostic.current)return;
    lastLivePoseResolutionDiagnostic.current=message;
    LogService.write('system','info',message);
  },[
    activeMapResolution.source,locator.loadedMap?.mapName,navigatorMapId,poseSnapshot,
    store.confirmedMapBinding?.locatorMapName,store.stateMapId,store.visualizationMapId,
  ]);
  const mission=new MissionMonitor().calculate(store.sentOrder,store.state,{
    publishedAtMs:store.sentOrderPublishedAtMs,nowMs:now,acceptanceTimeoutMs:store.orderSettings.acceptanceTimeoutMs,
    publishing:store.publishingOrder,
  });
  const firstNodeDiagnostics=getFirstNodeDiagnostics(store.generatedOrder,currentValidationContext);
  const firstNodeStatus=stale?'Stale robot state':
    store.state?.agvPosition?.positionInitialized!==true?'Position not initialized':
      locatorMismatch?'Map mismatch':
        !store.generatedOrder?'Not generated':
          (firstNodeDiagnostics.positionDifference??Infinity)<=store.orderSettings.firstNodePositionConsistency&&
          (firstNodeDiagnostics.angularDifference??Infinity)<=store.orderSettings.firstNodeAngularConsistency?'Valid':'Invalid';
  useEffect(()=>{
    setActiveMapResolution({mapId:navigatorMapId,source:activeMapResolution.source});
    setLocator({activeNavigatorMapId:navigatorMapId??''});
  },[setActiveMapResolution,setLocator,navigatorMapId,activeMapResolution.source]);

  const loadGrid=(grid:OccupancyGrid):void=>{
    if(!workspace.draft.mapId)workspace.edit(newMission(grid.metadata.mapId));
    workspace.setPick(false);setPlacement(undefined);setDraft(undefined);setFocusedPoint(undefined);
    mapImportToken.current+=1;
    setMapImporting(false);
    const inflated=ObstacleInflation.byRadius(grid,
      store.plannerOptions.passageSafety.planningSafetyMarginM+
      store.plannerOptions.passageSafety.localizationMarginM);
    store.set({grid,inflatedGrid:inflated,rawPath:[],finalPath:[],generatedOrder:undefined,validation:undefined});
    LogService.write('planner','info',`Loaded ${grid.metadata.name}: ${grid.metadata.width}×${grid.metadata.height} at ${grid.metadata.resolution} m/cell`);
  };
  useStartupConnections(loadGrid);
  const setCell=(cell:{row:number;column:number}):void=>{
    if(!store.grid)return; const transform=new CoordinateTransformer(store.grid.metadata);const pose=transform.gridToWorld(cell.row,cell.column);
    if(workspace.pick){
      if(workspace.draft.mapId!==store.grid.metadata.mapId){workspace.setPick(false);return;}
      const check=waypointPositionError({...pose,mapId:workspace.draft.mapId},store.grid,store.inflatedGrid);
      if(check){setToast({severity:'warning',message:check});return;}
      workspace.edit({...workspace.draft,stops:[...workspace.draft.stops,{id:crypto.randomUUID(),x:pose.x,y:pose.y,
        label:`Map point (${pose.x.toFixed(2)}, ${pose.y.toFixed(2)})`}]});return;
    }
    if(placement){
      if(placement.mapId!==store.grid.metadata.mapId){setPlacement(undefined);return;}
      const next={...pose,mapId:placement.mapId,item:placement.item,theta:placement.item?.thetaExplicit===false?undefined:placement.item?.theta};
      const error=waypointPositionError(next,store.grid,store.inflatedGrid);
      if(error){setToast({severity:'warning',message:error});return;}
      setPlacement(undefined);setDraft(next);return;
    }
    if(workspace.open)return;
    if(mode==='goal'){prepareDestinationCell(cell);return;}
    else if(mode==='start')store.set({start:{...pose,mapId:store.grid.metadata.mapId,positionInitialized:true},selectedCell:cell});
    else if(mode==='waypoint'){
      const waypoint:Waypoint={...pose,id:crypto.randomUUID(),deviationXy:store.orderSettings.allowedDeviationXy,
        deviationTheta:store.orderSettings.allowedDeviationTheta,orientationLocked:false};
      store.set({waypoints:[...store.waypoints,waypoint]});
    }else if(mode==='obstacle'||mode==='erase'){
      const data=[...store.grid.data];data[cell.row*store.grid.metadata.width+cell.column]=mode==='obstacle'?100:0;
      loadGrid({...store.grid,data});
    }else store.set({selectedCell:cell});
  };
  const calculatePath=async(startOverride?:RobotPose,goalOverride?:RobotPose):Promise<{
    path:PathPoint[];revision:number;
  }|undefined>=>{
    const selected=useAppStore.getState();
    const routeStart=startOverride??selected.start;
    const routeGoal=goalOverride??selected.goal;
    if(!selected.grid||!routeStart||!routeGoal)return;
    const revision=selected.invalidateRoute();
    dispatchToken.current+=1;
    setDispatchCountdown(undefined);
    if(!selected.beginPlanning(revision))return;
    try{
      if(selected.plannerMode==='manual'){
        const finalPath:PathPoint[]=[routeStart,...selected.waypoints,routeGoal];
        const valid=new PathCollisionValidator().pathIsFree(selected.grid,finalPath,selected.footprint,selected.plannerOptions.collisionSampleInterval);
        const plannerResult:PlannerResult={success:valid,error:valid?undefined:'Manual path intersects obstacles.',
          rawPath:finalPath,simplifiedPath:finalPath,finalPath,statistics:{visitedCells:0,durationMs:0,rawPointCount:finalPath.length,
            simplifiedPointCount:finalPath.length,finalPointCount:finalPath.length}};
        const accepted=selected.commitPlannedRoute(revision,{start:routeStart,rawPath:finalPath,finalPath,
          plannerResult,planningConfiguration:planningCoordinator.createSnapshot(selected)});
        if(accepted&&!valid)setToast({severity:'error',message:plannerResult.error!});
        return accepted&&valid?{path:finalPath,revision}:undefined;
      }
      const result=await planningCoordinator.plan({
        grid:structuredClone(selected.grid), start:structuredClone(routeStart), goal:structuredClone(routeGoal),
        waypoints:structuredClone(selected.waypoints), plannerMode:selected.plannerMode,
        plannerOptions:structuredClone(selected.plannerOptions), footprint:structuredClone(selected.footprint),
        orderSettings:structuredClone(selected.orderSettings), goalThetaExplicit:selected.goalThetaExplicit,
        sessionId:appSessionId, missionId:missionController.snapshot.missionId,routeRevision:revision,
      });
      if(!result||result.routeRevision!==revision){
        return undefined;
      }
      const fallback=result.success ? result.finalPath : (result.baselinePath?.length ? result.baselinePath : result.finalPath);
      const accepted=selected.commitPlannedRoute(revision,{start:routeStart,rawPath:result.rawPath,
        finalPath:fallback,plannerResult:{...result,finalPath:fallback},
        planningConfiguration:result.planningConfiguration});
      if(!accepted)return undefined;
      if(!result.success){
        const failedStage=[...(result.diagnostics?.stages??[])].reverse().find((item)=>!item.success);
        const message=failedStage?.reason??result.error??'No valid route was found.';
        LogService.write('planner','error',message);
        setToast({severity:'error',message});
        return undefined;
      }
      LogService.write('planner','info',`Path planned: ${result.rawPath.length} raw cells → ${result.simplifiedPath.length} geometry points → ${result.finalPath.length} final points in ${result.statistics.durationMs.toFixed(1)} ms`);
      return {path:result.finalPath,revision};
    }catch(error){
      if(useAppStore.getState().routeRevision===revision){
        const message=error instanceof Error?error.message:String(error);
        setPlanningFailure({revision,message});
        setToast({severity:'error',message:`Route calculation failed: ${message}`});
        LogService.write('planner','error',message);
      }
      return undefined;
    }finally{
      selected.finishPlanning(revision);
    }
  };
  const plan=async():Promise<void>=>{
    routePreparationGuard.current.cancel();
    await calculatePath();
  };
  const appendOrderStages=(stages:NonNullable<PlannerResult['diagnostics']>['stages']):void=>{
    const live=useAppStore.getState();
    const currentDiagnostics=live.plannerResult?.diagnostics;
    if(!live.plannerResult||!currentDiagnostics)return;
    live.set({plannerResult:{
      ...live.plannerResult,
      diagnostics:{
        ...currentDiagnostics,
        stages:[
          ...currentDiagnostics.stages.filter((stage)=>
            stage.stage!=='corridor-generation'&&stage.stage!=='vda-order-validation'),
          ...stages,
        ],
      },
    }});
  };
  const buildOrder=(pathOverride?:PathPoint[],finalGoalTheta?:number,
    expectedRevision?:number):VdaOrder|undefined=>{
    const live=useAppStore.getState();
    const revision=expectedRevision??live.routeRevision;
    if(revision!==live.routeRevision||live.plannedRouteRevision!==revision)return undefined;
    const path=pathOverride??live.finalPath;
    const context=getLiveRouteContext(live);
    const readiness=getOrderGenerationIssues(context.prerequisites);
    const readinessErrors=readiness.filter((issue)=>issue.severity==='error');
    const readinessWarnings=readiness.filter((issue)=>issue.severity==='warning');
    if(readinessErrors.length){
      appendOrderStages([{
        stage:'vda-order-validation',inputPointCount:path.length,outputPointCount:0,
        success:false,severity:'error',code:readinessErrors[0]?.code??'ORDER_NOT_READY',
        reason:readinessErrors[0]?.message??'Order prerequisites are not satisfied.',
      }]);
      live.set({generatedOrder:undefined,generatedOrderRouteRevision:undefined,
        validation:{valid:false,errors:readinessErrors,warnings:readinessWarnings,context:{
        stateAgeMs:context.stateAge,stateStaleTimeoutMs:live.orderSettings.stateStaleTimeoutMs,
        activeNavigatorMapId:context.navigatorMapId,mapIdSource:context.activeMapResolution.source,
        loadedLocatorMap:context.validation.locatorMapName??null,
      }}});
      readiness.forEach((issue)=>LogService.write('validation',issue.severity==='error'?'error':'warning',issue.message));return undefined;
    }
    if(!live.grid||!context.poseSnapshot||path.length<1)return undefined;
    try{
      const corridorDiagnostics:import('./domain/planner/EdgeCorridorPlanner').CorridorDiagnostic[]=[];
      const order=new VdaOrderBuilder().build(path,{
        robotPose:context.poseSnapshot.pose,activeMapId:context.navigatorMapId!,
        finalGoalTheta:finalGoalTheta??(live.goalThetaExplicit?live.goal?.theta:undefined),
        planningConfiguration:live.planningConfiguration,
        motionPlan: live.plannerResult?.motionPlan,
        onMotionPlanValidation:(result)=>operationalDiagnosticSink.emit(createDiagnosticEvent({
          sessionId:appSessionId,missionId:missionController.snapshot.missionId,
          stage:'motionplan',severity:result.valid?'info':'error',
          eventType:result.valid?'motionplan.validation.passed':'motionplan.validation.failed',
          message:result.valid?'MotionPlan publish validation passed.':'MotionPlan publish validation failed.',
          payload:{issues:result.issues},
        })),
        corridorPlanning:{
          grid:live.grid,footprint:live.footprint,plannerOptions:live.plannerOptions,
          onDiagnostic:(diagnostic)=>corridorDiagnostics.push(diagnostic),
        },
      },live.orderSettings);
      const validation=new VdaOrderValidator().validate(order,context.validation);
      const maximumNodeCount=useOperatorSettingsStore.getState().settings.maximumVdaNodeCount;
      if(order.nodes.length>maximumNodeCount){
        validation.errors.push({code:'nodes.maximum',
          message:`Order contains ${order.nodes.length} nodes; configured maximum is ${maximumNodeCount}.`,
          severity:'error'});
        validation.valid=false;
      }
      const failedCorridor=live.plannerOptions.corridor.enableBoschRokitCorridorExtension
        ?corridorDiagnostics.find((diagnostic)=>!diagnostic.corridorAdded&&diagnostic.reason)
        :undefined;
      appendOrderStages([
        {
          stage:'corridor-generation',inputPointCount:path.length,
          outputPointCount:order.edges.length,success:true,
          severity:failedCorridor?'warning':'info',
          code:failedCorridor?'CORRIDOR_PARTIAL':'CORRIDOR_GENERATED',
          reason:failedCorridor?.reason??`${order.edges.filter((edge)=>edge.corridor).length} of ${order.edges.length} edges have a bypass corridor.`,
        },
        {
          stage:'vda-order-validation',inputPointCount:path.length,
          outputPointCount:order.nodes.length,success:validation.valid,
          severity:validation.valid?'info':'error',
          code:validation.valid?'ORDER_READY':validation.errors[0]?.code??'ORDER_INVALID',
          reason:validation.valid?'VDA Order structure and dispatch context are valid.':
            validation.errors[0]?.message??'VDA Order validation failed.',
        },
      ]);
      // Building a preview must never forget an Order that may still be active
      // in Navigator. sentOrder is changed only after a successful publish.
      if(!live.commitGeneratedOrder(revision,order,validation,corridorDiagnostics))return undefined;
      missionController.prepareOrder(appSessionId,order);
      stage5BRecording.order(order,revision);
      missionController.markValidated(appSessionId,validation.valid,order.orderId);
      LogService.write('planner','info',
        `Corridor planning: ${order.edges.filter((edge)=>edge.corridor).length}/${order.edges.length} edges allow local bypass.`);
      LogService.write('validation',validation.valid?'info':'error',validation.valid?'Order is valid.':`${validation.errors.length} validation errors.`);
      return order;
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      appendOrderStages([
        {stage:'corridor-generation',inputPointCount:path.length,outputPointCount:0,
          success:false,severity:'error',code:'CORRIDOR_GENERATION_FAILED',reason:message},
        {stage:'vda-order-validation',inputPointCount:path.length,outputPointCount:0,
          success:false,severity:'error',code:'ORDER_BUILD_FAILED',reason:message},
      ]);
      if(useAppStore.getState().routeRevision===revision)live.set({generatedOrder:undefined,
        generatedOrderRouteRevision:undefined,
        validation:{valid:false,errors:[{code:'generation.builder',message,severity:'error'}],warnings:[]}});
      LogService.write('validation','error',message);
      return undefined;
    }
  };
  const generate=():void=>{ buildOrder(); };
  const useBaselinePath=():void=>{
    const live=useAppStore.getState();
    const baseline=live.plannerResult?.baselinePath;
    const currentDiagnostics=live.plannerResult?.diagnostics;
    const planningConfiguration=live.planningConfiguration;
    if(!baseline?.length||!live.plannerResult||!currentDiagnostics||
      !planningConfiguration||!live.start||!live.grid)return;
    const diagnostics={
      ...currentDiagnostics,
      finalPathSource:'baseline' as const,
      warnings:Array.from(new Set([
        ...currentDiagnostics.warnings,'BASELINE_PATH_USED',
      ])),
    };
    const selectedBaseline=baseline.map((point)=>({...point}));
    const selectedMotionPlan=buildLegacyMotionPlan(selectedBaseline,live.start.theta,
      planningConfiguration.planner,live.grid,live.footprint,
      live.goalThetaExplicit?live.goal?.theta:undefined);
    planningCoordinator.invalidate();
    const revision=live.invalidateRoute();
    live.commitPlannedRoute(revision,{
      start:live.start,rawPath:selectedBaseline,finalPath:selectedBaseline,
      planningConfiguration,
      plannerResult:{
        ...live.plannerResult,
        success:true,
        error:undefined,
        rawPath:selectedBaseline,simplifiedPath:selectedBaseline,finalPath:selectedBaseline,
        // The previous MotionPlan describes the enhanced route. Rebuild one
        // for the selected baseline so publish-time swept validation remains
        // mandatory for exactly the geometry shown in the UI.
        motionPlan:selectedMotionPlan,
        diagnostics,
        statistics:{...live.plannerResult.statistics,finalPointCount:baseline.length},
      },
    });
    LogService.write('planner','warning','BASELINE_PATH_USED: operator selected the last collision-free baseline path.');
  };
  const rebuildFromCurrentPose=async():Promise<void>=>{
    const live=useAppStore.getState();
    const context=getLiveRouteContext(live);
    const readiness=getOrderGenerationIssues(context.prerequisites);
    const readinessErrors=readiness.filter((issue)=>issue.severity==='error');
    const readinessWarnings=readiness.filter((issue)=>issue.severity==='warning');
    if(readinessErrors.length){live.set({validation:{valid:false,errors:readinessErrors,warnings:readinessWarnings,context:{
      stateAgeMs:context.stateAge,stateStaleTimeoutMs:live.orderSettings.stateStaleTimeoutMs,
      activeNavigatorMapId:context.navigatorMapId,mapIdSource:context.activeMapResolution.source,
      loadedLocatorMap:context.validation.locatorMapName??null,
    }}});setToast({severity:'error',message:readinessErrors[0]!.message});return;}
    if(!context.poseSnapshot||!live.goal)return;
    routePreparationGuard.current.cancel();
    const result=await calculatePath(context.poseSnapshot.pose);
    if(result)buildOrder(result.path,undefined,result.revision);
  };
  const publish=async(orderOverride?:VdaOrder,skipConfirmation=false,
    expectedRevision?:number,namedRun?:MissionRun):Promise<void>=>{
    const live=useAppStore.getState();
    const order=orderOverride??live.generatedOrder;
    if(!order)return;
    const revision=expectedRevision??live.generatedOrderRouteRevision;
    if(!isCurrentRouteOrder(live,order,revision)){
      setToast({severity:'warning',message:'The selected route changed. Generate and validate the current route before publishing.'});
      return;
    }
    if(live.publishingOrder){
      setToast({severity:'warning',message:'An Order publication is already in progress.'});
      return;
    }
    if(live.sentOrder?.orderId===order.orderId){
      setToast({severity:'warning',
        message:`Order ${order.orderId} has already been published and will not be sent again.`});
      return;
    }
    const activeNavigatorOrderId=getActiveNavigatorOrderId(live.state);
    if(activeNavigatorOrderId===order.orderId){
      setToast({severity:'warning',
        message:`Order ${order.orderId} is already active in Navigator and will not be sent again.`});
      return;
    }
    const activeDifferentOrder=Boolean(activeNavigatorOrderId&&activeNavigatorOrderId!==order.orderId);
    const context=getLiveRouteContext(live);
    let currentValidation:ValidationResult;
    try{
      currentValidation=new VdaOrderValidator().validate(order,context.validation);
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      live.set({validation:{valid:false,warnings:[],errors:[{code:'validation.exception',severity:'error',message}]}});
      setToast({severity:'error',message:`Order validation failed: ${message}`});
      LogService.write('validation','error',message);
      return;
    }
    const dispatchIssues=getDispatchIssues({
      mqttConnected:live.mqttConnected,robotOnline:context.connectionOnline,stateFresh:context.stateFresh,
      poseValid:Boolean(context.poseSnapshot),mapMatches:context.mapComparison.matches,
      validation:currentValidation,state:live.state,
      hasActiveDifferentOrder:activeDifferentOrder,
    });
    if(dispatchIssues.length){
      currentValidation.valid=false;currentValidation.errors.push(...dispatchIssues);
    }
    if(!currentValidation.valid){
      live.set({validation:currentValidation});
      LogService.write('validation','error','Publishing blocked because live validation no longer passes.');
      setToast({severity:'error',message:dispatchIssues[0]?.message??'Order validation failed.'});
      return;
    }
    if(!skipConfirmation){
      const confirmed=await requestConfirmation({
        title:'Start mission?',
        message:`${publishWarning}\n\nTopic: ${live.mqttSettings.topics.order}\nOrder: ${order.orderId}\nMaximum speed: ${live.orderSettings.missionMaximumSpeedMps} m/s`,
        confirmLabel:'Send Mission',
      });
      if(!confirmed)return;
      if(useAppStore.getState().mqttSettings!==live.mqttSettings){
        setToast({severity:'warning',message:'MQTT settings changed. Review the mission and confirm again.'});
        return;
      }
      await publish(order,true,revision);
      return;
    }
    const current=live;
    current.set({publishingOrder:true});
    try{await mqttService.publish(current.mqttSettings.topics.order,JSON.stringify(order),current.mqttSettings.qos,false);
      const handedAt=Date.now();
      const last=order.nodes[order.nodes.length-1]!.nodePosition;
      const quick={id:order.orderId,mapId:last.mapId,description:'',name:'Quick mission',
        stops:[{id:order.orderId,x:last.x,y:last.y,label:`Destination (${last.x.toFixed(2)}, ${last.y.toFixed(2)})`}]};
      current.set({sentOrder:order,sentOrderPublishedAtMs:handedAt,publishingOrder:false});
      useMissionLibrary.getState().record(namedRun?{...namedRun,started:namedRun.index===0?handedAt:namedRun.started}:
        {id:order.orderId,template:quick,orderId:order.orderId,started:handedAt,index:0,completed:0,status:'Awaiting acceptance',progress:0,errors:[]});
      stage5BRecording.order(order,revision,true);
      missionController.markPublished(appSessionId);
      setToast({severity:'info',message:'Order handed to MQTT. Waiting for Navigator acceptance.'});
      LogService.write('mqtt','info',`Published Order ${order.orderId}; awaiting Navigator acceptance.`);
     }catch(error){current.set({publishingOrder:false});
      if(namedRun)useMissionLibrary.getState().record({...namedRun,started:namedRun.index===0?undefined:namedRun.started,status:'Outcome unknown',errors:[...namedRun.errors,`MQTT handoff failed: ${String(error)}. Verify the outcome before retrying.`]});
      stage5BRecording.observe(order.orderId,'failed',`Order publication failed: ${String(error)}`,
        context.poseSnapshot?.pose ? { agvPosition: context.poseSnapshot.pose } : undefined);
      setToast({severity:'error',message:`Unable to dispatch the mission: ${String(error)}`});LogService.write('mqtt','error',String(error));}
  };
  const beginDirectDispatch=async(order:VdaOrder,revision:number):Promise<void>=>{
    const token=++dispatchToken.current;
    try{
      for(let remaining=useOperatorSettingsStore.getState().settings.dispatchCountdownSeconds;remaining>0;remaining-=1){
        if(token!==dispatchToken.current)return;
        const live=useAppStore.getState();
        if(!isCurrentRouteOrder(live,order,revision)||!live.validation?.valid)return;
        if(!live.mqttConnected||!isLocalMessageFresh(
          live.mqttReceiveMetadata.lastStateReceiveTime,live.orderSettings.stateStaleTimeoutMs)){
          setToast({severity:'warning',message:'Automatic dispatch cancelled because robot data is not ready.'});return;
        }
        setDispatchCountdown({revision,orderId:order.orderId,seconds:remaining});
        await new Promise((resolve)=>setTimeout(resolve,1_000));
      }
      if(token===dispatchToken.current&&isCurrentRouteOrder(useAppStore.getState(),order,revision)){
        await publish(order,true,revision);
      }
    }finally{
      if(token===dispatchToken.current)setDispatchCountdown(undefined);
    }
  };
  const prepareDestination=async(goal:RobotPose,explicitTheta=false,allowDirectDispatch=true):Promise<void>=>{
    const live=useAppStore.getState();const grid=live.grid;
    const context=getLiveRouteContext(live);
    if(!grid||!context.poseSnapshot){setToast({severity:'error',message:'A loaded map and fresh robot pose are required.'});return;}
    const collisionGrid=live.inflatedGrid??grid;
    const destination=validateDestination(goal,context.navigatorMapId,grid,collisionGrid);
    if(!destination.valid||!destination.cell){
      setToast({severity:'error',message:destination.message??'Destination is not navigable.'});return;
    }
    const preparationToken=routePreparationGuard.current.begin();
    const cell=destination.cell;
    live.set({goal,goalThetaExplicit:explicitTheta,selectedCell:cell,rawPath:[],finalPath:[],
      generatedOrder:undefined,validation:undefined});
    missionController.createMission(appSessionId,crypto.randomUUID());
    const planned=await calculatePath(context.poseSnapshot.pose,goal);
    if(!planned||!routePreparationGuard.current.isCurrent(preparationToken))return;
    const {path,revision}=planned;
    if(useAppStore.getState().routeRevision!==revision)return;
    const order=buildOrder(path,explicitTheta?goal.theta:undefined,revision);
    const result=useAppStore.getState().validation;
    if(!order||!result?.valid){
      const reason=result?.errors[0]?.message??
        'Generated Order did not pass validation.';
      setToast({severity:'error',message:reason});
      return;
    }
    setToast({severity:'success',message:'Route calculated and order validated.'});
    if(allowDirectDispatch&&useOperatorSettingsStore.getState().settings.directDispatchMode)void beginDirectDispatch(order,revision);
  };
  const prepareDestinationCell=(cell:{row:number;column:number}):void=>{
    const live=useAppStore.getState();if(!live.grid)return;
    const point=new CoordinateTransformer(live.grid.metadata).gridToWorld(cell.row,cell.column);
    void prepareDestination({...point,theta:live.goal?.theta??poseSnapshot?.pose.theta??0,
      mapId:navigatorMapId??'',positionInitialized:true},false);
  };
  const clearDestination=async():Promise<void>=>{
    const live=useAppStore.getState();
    if((live.sentOrder||live.generatedOrder)&&!await requestConfirmation({
      title:'Clear destination?',
      message:'Clear the active destination and route preview?',
      confirmLabel:'Clear Destination',destructive:true,
    }))return;
    if(useAppStore.getState().routeRevision!==live.routeRevision){
      setToast({severity:'warning',message:'The route changed. Confirm Clear Destination again to clear the current route.'});
      return;
    }
    dispatchToken.current+=1;routePreparationGuard.current.cancel();
    setDispatchCountdown(undefined);
    live.set({goal:undefined,rawPath:[],finalPath:[],generatedOrder:undefined,validation:undefined,
      plannerResult:undefined,selectedCell:undefined});
  };
  const handleWorkspaceKey=(event:KeyboardEvent):void=>{
    if(event.key!=='Escape'||event.defaultPrevented||event.target instanceof HTMLElement&&
      event.target.closest('input,textarea,select,[contenteditable],[role="combobox"],[role="dialog"],[role="menu"],[role="listbox"]'))return;
    if(confirmationResolver.current||settingsOpen||locatorOpen||corridorCompatibilityOpen||
      globalReplanningOpen||draft||waypointsOpen||systemsOpen||!event.currentTarget.contains(event.target as Node))return;
    if(workspace.open){workspace.setPick(false);return;}
    if(placement){setPlacement(undefined);return;}
    if(useAppStore.getState().goal)void clearDestination();
  };
  useEffect(()=>{
    if(!store.mqttConnected||stale||!operatorSettings.directDispatchMode){
      dispatchToken.current+=1;
      setDispatchCountdown(undefined);
    }
  },[store.mqttConnected,stale,operatorSettings.directDispatchMode]);
  useEffect(()=>{
    const navigatorLifecycle = mission.status==='Accepted'?'accepted':mission.status==='Rejected'||mission.status==='Timed out'?'rejected':mission.status==='Driving'?'driving':mission.status==='Completed'?'completed':mission.status==='Cancelled'?'cancelled':undefined;
    if(navigatorLifecycle) missionController.observeNavigator(appSessionId,navigatorLifecycle,{progressPercent:mission.progressPercent});
  },[mission.status,mission.progressPercent]);
  useEffect(()=>{
    const outcome = mission.status==='Completed' ? 'success' : mission.status==='Cancelled' ? 'cancelled'
      : mission.status==='Rejected'||mission.status==='Timed out' ? 'failed' : undefined;
    stage5BRecording.observeActions(store.state);
    if(outcome) stage5BRecording.observe(store.sentOrder?.orderId,outcome,mission.status,store.state);
  },[mission.status,store.sentOrder?.orderId,store.state]);
  useEffect(()=>{ stage5BRecording.routeChanged(store.routeRevision); },[store.routeRevision]);
  useEffect(()=>{
    if(!operatorSettings.autoClearCompletedMission||mission.status!=='Completed'||!displayedState)return;
    const current=useAppStore.getState();
    if(current.goal&&current.generatedOrder&&current.sentOrder?.orderId===current.generatedOrder.orderId&&
      isCurrentRouteOrder(current,current.generatedOrder,current.routeRevision)){
      current.set({goal:undefined,selectedCell:undefined});
    }
  },[operatorSettings.autoClearCompletedMission,mission.status,displayedState,store.generatedOrder,store.sentOrder]);
  const instant=async(action:VdaInstantAction,expectedOrder?:string):Promise<void>=>{
    if(!isInstantActionSupported(action)){LogService.write('mqtt','warning',`${action} is disabled because the current ROKIT configuration rejected its blocking type.`);return;}
    if(!useAppStore.getState().mqttConnected){
      setToast({severity:'error',message:'MQTT is disconnected. The action was not sent.'});return;
    }
    const cancelTarget=useAppStore.getState().sentOrder?.orderId;
    const matchesTarget=()=>{
      const app=useAppStore.getState(),active=getActiveNavigatorOrderId(app.state);
      return !expectedOrder||(app.sentOrder?.orderId===expectedOrder&&(!active||active===expectedOrder));
    };
    if(!matchesTarget()){setToast({severity:'warning',message:'Navigator is tracking a different order. Review the active mission.'});return;}
    if(!await requestConfirmation({
      title:action==='cancelOrder'?'Cancel active mission?':'Send instant action?',
      message:action==='cancelOrder'
        ?'Send cancelOrder to ROKIT Navigator? The active robot mission will be cancelled.'
        :`Publish ${action} to ${store.mqttSettings.topics.instantActions}?`,
      confirmLabel:action==='cancelOrder'?'Cancel Mission':'Send Action',destructive:action==='cancelOrder',
    }))return;
    const live=useAppStore.getState();
    if(!live.mqttConnected){
      setToast({severity:'error',message:'MQTT disconnected before the action could be sent.'});return;
    }
    if(action==='cancelOrder'&&(live.sentOrder?.orderId!==cancelTarget||!matchesTarget())){setToast({severity:'warning',message:'Submitted order changed. Review cancellation again.'});return;}
    const message=new InstantActionBuilder().build(action,live.orderSettings);
    try{await mqttService.publish(live.mqttSettings.topics.instantActions,JSON.stringify(message),live.mqttSettings.qos,false);
      if(action==='cancelOrder'){
        const lib=useMissionLibrary.getState();
        const tracked=lib.history.find(r=>!r.ended&&r.orderId===cancelTarget);
        if(tracked)lib.record({...tracked,cancelActionId:message.actions[0]!.actionId,cancelReason:'Operator requested cancellation.',status:'Cancellation requested'});
      }
      if(action==='cancelOrder')stage5BRecording.cancelRequested(message.actions[0]!.actionId,live.sentOrder?.orderId);
      setToast({severity:'info',message:'Action handed to MQTT. Check Navigator state for the outcome.'});
      LogService.write('mqtt','warning',`Published ${action} (${message.actions[0]!.actionId})`);
    }catch(error){
      if(action==='cancelOrder'){
        const lib=useMissionLibrary.getState(),tracked=lib.history.find(r=>!r.ended&&r.orderId===cancelTarget);
        if(tracked)lib.record({...tracked,errors:[...new Set([...tracked.errors,`Cancellation handoff failed: ${String(error)}`])]});
      }
      setToast({severity:'error',message:`Unable to send the action: ${String(error)}`});
      LogService.write('mqtt','error',String(error));
    }
  };
  const importMap=async(event:ChangeEvent<HTMLInputElement>,format:'yaml'|'image'|'json'):Promise<void>=>{
    const file=event.target.files?.[0];
    event.target.value='';
    if(!file)return;
    const counter=format==='yaml'?yamlImportToken:mapImportToken;
    const token=++counter.current;
    if(format==='yaml')setYamlLoading(true);
    else setMapImporting(true);
    try{
      if(format==='yaml'){
        const source=await file.text();
        if(counter.current!==token)return;
        metadataFromRosYaml(source,1,1,file.name);
        setYamlText(source);
        setYamlName(file.name);
        setToast({severity:'success',message:`${file.name} is ready for the next image import.`});
        return;
      }
      let grid:OccupancyGrid;
      if(format==='json'){
        const source=await file.text();
        grid=parseOccupancyJson(source);
        if(!JSON.parse(source).metadata?.mapId){
          grid={...grid,metadata:{...grid.metadata,mapId:file.name,name:file.name}};
        }
      }
      else{
        const image=await imageFileToPixels(file);
        const mapId=file.name.replace(/\.[^.]+$/,'');
        const metadata=yamlText?metadataFromRosYaml(yamlText,image.width,image.height,mapId)
          :{name:file.name,mapId,width:image.width,height:image.height,resolution:0.05,
            origin:{x:0,y:0,yaw:0},occupiedThreshold:0.65,freeThreshold:0.196,negate:false};
        grid={metadata,data:pixelsToOccupancy(image.pixels,metadata)};
      }
      if(counter.current!==token)return;
      loadGrid(grid);
      if(format==='image'){setYamlText(undefined);setYamlName(undefined);}
      setToast({severity:'success',message:`Loaded ${grid.metadata.name}.`});
    }catch(error){
      if(counter.current!==token)return;
      const message=`Map import failed: ${String(error)}`;
      setToast({severity:'error',message});
      LogService.write('planner','error',message);
    }finally{
      if(counter.current===token){
        if(format==='yaml')setYamlLoading(false);
        else setMapImporting(false);
      }
    }
  };
  const routeDistance=store.finalPath.slice(1).reduce((distance,point,index)=>{
    const previous=store.finalPath[index]!;
    return distance+Math.hypot(point.x-previous.x,point.y-previous.y);
  },0);
  const estimatedDurationSeconds=store.orderSettings.missionMaximumSpeedMps>0
    ?routeDistance/store.orderSettings.missionMaximumSpeedMps:0;
  const corridorEdges=store.generatedOrder?.edges.filter((edge)=>edge.corridor)??[];
  const corridorLeftWidths=corridorEdges.map((edge)=>edge.corridor!.leftWidth);
  const corridorRightWidths=corridorEdges.map((edge)=>edge.corridor!.rightWidth);
  const corridorSummary={
    withCorridor:corridorEdges.length,
    withoutCorridor:(store.generatedOrder?.edges.length??0)-corridorEdges.length,
    minimumLeft:corridorLeftWidths.length?Math.min(...corridorLeftWidths):undefined,
    maximumLeft:corridorLeftWidths.length?Math.max(...corridorLeftWidths):undefined,
    minimumRight:corridorRightWidths.length?Math.min(...corridorRightWidths):undefined,
    maximumRight:corridorRightWidths.length?Math.max(...corridorRightWidths):undefined,
  };
  const dispatchIssues=getDispatchIssues({
    mqttConnected:store.mqttConnected,robotOnline:connectionOnline,stateFresh,
    poseValid:Boolean(poseSnapshot),mapMatches:Boolean(locator.loadedMap&&locatorComparison.matches),
    validation:store.validation,state:store.state,
    hasActiveDifferentOrder:Boolean(getActiveNavigatorOrderId(store.state)&&store.generatedOrder&&
      getActiveNavigatorOrderId(store.state)!==store.generatedOrder.orderId),
  });
  const compatibilityDispatchBlockedReason=store.publishingOrder?'An Order publication is already in progress.':!store.generatedOrder
    ?'Generate and validate a route first.'
    :[...dispatchIssues,...getCompatibilitySpecificDispatchIssues(store.state)][0]?.message;
  const activeNavigatorOrderId=getActiveNavigatorOrderId(store.state);
  const orderAlreadySent=Boolean(store.generatedOrder&&(store.sentOrder?.orderId===store.generatedOrder.orderId||
    activeNavigatorOrderId===store.generatedOrder.orderId));
  const currentPlanningFailure=planningFailure?.revision===store.routeRevision?planningFailure:undefined;
  const orderMapMismatch=Boolean(store.generatedOrder&&navigatorMapId&&!compareMapIds(
    store.generatedOrder.nodes[0]?.nodePosition?.mapId,navigatorMapId).matches);
  const routeStatus=getRouteStatus(store,dispatchIssues.length>0||firstNodeStatus!=='Valid'||orderMapMismatch,
    Boolean(currentPlanningFailure),orderAlreadySent);
  const countdown=dispatchCountdown?.revision===store.routeRevision&&
    dispatchCountdown.orderId===store.generatedOrder?.orderId&&store.validation?.valid
    ?dispatchCountdown.seconds:undefined;
  const missionBlockers=()=>{
    const app=useAppStore.getState(),ctx=getLiveRouteContext(app);
    const issues=getDispatchIssues({mqttConnected:app.mqttConnected,robotOnline:ctx.connectionOnline,stateFresh:ctx.stateFresh,
      poseValid:!!ctx.poseSnapshot,mapMatches:ctx.mapComparison.matches,state:app.state,hasActiveDifferentOrder:!!getActiveNavigatorOrderId(app.state),
      validation:{valid:true,errors:[],warnings:[]}}).map(e=>e.message);
    for(const issue of getOrderGenerationIssues(ctx.prerequisites)){
      if(issue.severity==='error'&&!issues.includes(issue.message))issues.push(issue.message);
    }
    const tracked=workspace.blocked();if(tracked)issues.push(tracked);
    if(app.publishingOrder)issues.push('An order handoff is in progress.');
    if(app.grid&&app.grid.metadata.mapId!==ctx.navigatorMapId)issues.push('Planning and Navigator map IDs must match.');
    return issues;
  };
  const executeDestination=async()=>{
    const preview=workspace.preview;
    if(!preview||!workspace.isCurrent()||missionBlockers().length)return;
    const app=useAppStore.getState(),stop=preview.stops[0]!,leg=preview.legs[0]!;
    if(!await requestConfirmation({title:'Start mission?',confirmLabel:'Send Mission',
      message:`${preview.template.name} · destination ${preview.index+1} of ${preview.template.stops.length}: ${stop.stop.label}\n${publishWarning}\nTopic: ${app.mqttSettings.topics.order}\nMaximum speed: ${app.orderSettings.missionMaximumSpeedMps} m/s`}))return;
    if(!workspace.isCurrent()||missionBlockers().length){workspace.reset();workspace.setMessage('Mission or robot state changed. Validate again.');return;}
    dispatchToken.current++;setDispatchCountdown(undefined);routePreparationGuard.current.cancel();
    app.set({goal:stop.pose,goalThetaExplicit:stop.stop.theta!==undefined,waypoints:[]});
    const revision=useAppStore.getState().routeRevision;
    app.commitPlannedRoute(revision,{start:preview.start,rawPath:leg.rawPath,finalPath:leg.finalPath,
      plannerResult:leg,planningConfiguration:leg.planningConfiguration});
    missionController.createMission(appSessionId,crypto.randomUUID());
    const order=buildOrder(leg.finalPath,stop.stop.theta,revision);
    if(!order||!useAppStore.getState().validation?.valid){workspace.reset();workspace.setMessage('Current order failed validation. Review diagnostics.');app.invalidateRoute();return;}
    const previous=workspace.run;
    const template={...preview.template,stops:[...preview.template.stops.slice(0,preview.index),...preview.stops.map(s=>s.stop)]};
    const run:MissionRun={id:previous?.id??crypto.randomUUID(),template,index:preview.index,completed:preview.index,
      orderId:order.orderId,started:previous?.started,drivingObserved:previous?.drivingObserved,status:'Awaiting acceptance',progress:0,errors:previous?.errors??[]};
    await publish(order,true,revision,run);
    if(useAppStore.getState().sentOrder?.orderId!==order.orderId&&useAppStore.getState().routeRevision===revision)app.invalidateRoute();
    workspace.release();
  };
  useEffect(()=>{
    const lib=useMissionLibrary.getState();
    for(const r of lib.history){
      if(!inFlight(r)||r.status==='Outcome unknown'||r.status==='Timed out')continue;
      let next=r;
      if(!store.mqttConnected||!stateFresh||!connectionOnline||store.sentOrder?.orderId!==r.orderId){
        next={...r,status:'Outcome unknown',errors:[...r.errors,'Lost live tracking of this order. Verify its outcome in Navigator.']};
      }else if(!store.publishingOrder){
        next=observeRun(r,mission,store.state?.actionStates??[],now);
      }
      if(next!==r)lib.record(next);
    }
  },[store.mqttConnected,stateFresh,connectionOnline,store.sentOrder,store.publishingOrder,store.state,mission,now]);
  const recalculateReason=!store.grid?'Load a map to recalculate.':
    !store.start?'Select a planning start or connect to the robot.':
      !store.goal?'Select a destination to recalculate.':undefined;
  const robotConnectionLabel=!store.mqttConnected?'Robot disconnected':
    !store.connection?'Robot status unavailable':connectionOnline&&stale?'Robot state unavailable':
      connectionOnline?'Robot online':'Robot offline';
  useEffect(()=>{
    if(diagnosticsOpen&&bottom===0&&!pauseLogScroll&&logViewport.current){
      logViewport.current.scrollTop=logViewport.current.scrollHeight;
    }
  },[diagnosticsOpen,bottom,pauseLogScroll,store.logs,diagnosticSearch,diagnosticSeverity]);
  const runCorridorCompatibilityTest=async(variant:CorridorTestVariant):Promise<void>=>{
    const live=useAppStore.getState();
    if(live.publishingOrder)return;
    const liveCompatibility=useCorridorCompatibilityStore.getState();
    const baseOrder=liveCompatibility.baseOrder??live.generatedOrder;
    if(!baseOrder){
      setToast({severity:'error',message:'Generate and validate a route before starting a compatibility test.'});
      return;
    }
    const order=createCorridorTestOrder(baseOrder,variant);
    const validator=new VdaOrderValidator();
    const context=getLiveRouteContext(live).validation;
    const baseValidation=validator.validateBase(order,context);
    const extensionValidation=new BoschRokitCorridorValidator().validate(order,{
      settings:live.plannerOptions.corridor,grid:live.grid,
    });
    const currentValidation=validator.validate(order,context);
    const activeOrderId=getActiveNavigatorOrderId(live.state);
    const activeDifferentOrder=Boolean(activeOrderId&&activeOrderId!==order.orderId);
    const safetyIssues=[
      ...getDispatchIssues({
        mqttConnected:live.mqttConnected,robotOnline:connectionOnline,stateFresh,
        poseValid:Boolean(poseSnapshot),mapMatches:Boolean(locator.loadedMap&&locatorComparison.matches),
        validation:currentValidation,state:live.state,
        hasActiveDifferentOrder:activeDifferentOrder,
      }),
      ...getCompatibilitySpecificDispatchIssues(live.state),
    ];
    if(safetyIssues.length){
      currentValidation.valid=false;
      currentValidation.errors.push(...safetyIssues);
      setToast({severity:'error',message:safetyIssues[0]!.message});
      return;
    }
    const corridorCount=order.edges.filter((edge)=>edge.corridor).length;
    if(!await requestConfirmation({
      title:`Run ${variant} compatibility test?`,
      message:`${publishWarning}\n\nVariant: ${variant}\nTopic: ${live.mqttSettings.topics.order}\n`+
        `Order: ${order.orderId}\nCorridors: ${corridorCount}/${order.edges.length}\n`+
        'This sends one controlled motion Order. It will not be published automatically.',
      confirmLabel:'Send Test Order',
    }))return;
    const current=useAppStore.getState();
    if(current.routeRevision!==live.routeRevision||current.publishingOrder||
      current.mqttSettings!==live.mqttSettings){
      setToast({severity:'warning',message:'The route or connection settings changed. Confirm the compatibility test again.'});
      return;
    }
    const payload=serializeCorridorTestOrder(
      order,variant,live.mqttSettings.topics.order,new Date().toISOString(),{
        baseVda20ValidationPassed:baseValidation.valid,
        boschCorridorExtensionValidationPassed:extensionValidation.valid,
      });
    liveCompatibility.prepare(baseOrder,order,variant,payload);
    liveCompatibility.addLog('CorridorExtension','info','Corridor variant finalized.',{
      corridorCount:payload.corridorCount,edgeCorridors:payload.edgeCorridors,
      corridorRefPoints:payload.corridorRefPoints,
    });
    liveCompatibility.addLog('OrderValidator',currentValidation.valid?'info':'error',
      'Base VDA 2.0 and Bosch corridor-extension validation completed.',{
        valid:currentValidation.valid,baseVda20Validation:baseValidation,
        boschCorridorExtensionValidation:extensionValidation,
      });
    liveCompatibility.markSent();
    live.set({publishingOrder:true});
    try{
      await mqttService.publish(
        live.mqttSettings.topics.order,payload.rawJson,live.mqttSettings.qos,false);
       live.set({publishingOrder:false,sentOrder:order,sentOrderPublishedAtMs:Date.now()});
       missionController.markPublished(appSessionId);
      setToast({severity:'success',message:'Compatibility test Order sent; monitoring Navigator evidence.'});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      liveCompatibility.markPublishFailure(message);
      live.set({publishingOrder:false});
      setToast({severity:'error',message:'Compatibility test publication failed.'});
    }
  };
  const planningMapId=store.grid?.metadata.mapId;
  const startPlacement=(item?:SavedDestination)=>{
    if(!planningMapId)return;
    workspace.setPick(false);setWaypointsOpen(false);setPlacement({mapId:planningMapId,item});
  };
  const selectSavedDestination=(point:SavedDestination):void=>{
    const error=waypointPositionError(point,store.grid,store.inflatedGrid);
    setWaypointsOpen(false);
    if(error){setToast({severity:'error',message:error});return;}
    setFocusedPoint({...point});
    if(point.mapId!==navigatorMapId||!poseSnapshot){
      store.set({goal:{x:point.x,y:point.y,theta:point.theta,mapId:point.mapId,positionInitialized:true},goalThetaExplicit:point.thetaExplicit!==false});
      setToast({severity:'info',message:'Destination selected. A matching Navigator map and fresh robot pose are required for route preparation.'});
      return;
    }
    void prepareDestination({...point,positionInitialized:true},point.thetaExplicit!==false,false);
  };
  const diagnostics={
    mqtt:{
      connected:store.mqttConnected,robotOnline:connectionOnline,
      configuredStateTopic:store.mqttSettings.topics.state,
      configuredVisualizationTopic:store.mqttSettings.topics.visualization,
    },
    state:{
      lastReceiveTime:receiveMetadata.lastStateReceiveTime===null?null:
        new Date(receiveMetadata.lastStateReceiveTime).toISOString(),
      payloadTimestamp:receiveMetadata.statePayloadTimestamp,localAgeMs:stateAge,
      staleThresholdMs:store.orderSettings.stateStaleTimeoutMs,fresh:stateFresh,
    },
    visualization:{
      lastReceiveTime:receiveMetadata.lastVisualizationReceiveTime===null?null:
        new Date(receiveMetadata.lastVisualizationReceiveTime).toISOString(),
      payloadTimestamp:receiveMetadata.visualizationPayloadTimestamp,
      localAgeMs:visualizationAge,fresh:visualizationFresh,
    },
    map:{
      stateMapId:store.state?.agvPosition?.mapId??null,
      visualizationMapId:store.visualization?.agvPosition?.mapId??null,
      lastKnownValidNavigatorMapId:store.lastKnownValidNavigatorMapId,
      confirmedLocatorBinding:store.confirmedMapBinding,
      activeResolvedNavigatorMapId:navigatorMapId,mapIdSource:activeMapResolution.source,
      loadedLocatorMap:locator.loadedMap?.mapName??null,mapsMatch:locatorComparison.matches,
      robotManufacturer:store.orderSettings.manufacturer,
      robotSerialNumber:store.orderSettings.serialNumber,
      bindingMismatchWarning:store.mapBindingMismatchWarning,
    },
    pose:{
      x:poseSnapshot?.pose.x??null,y:poseSnapshot?.pose.y??null,theta:poseSnapshot?.pose.theta??null,
      source:poseSnapshot?.source??null,mapIdSource:poseSnapshot?.mapIdSource??null,
      positionInitialized:store.state?.agvPosition?.positionInitialized??false,
    },
    planner:store.plannerResult?.statistics??null,
    corridor:{
      protocolBase:'VDA 5050 2.0',
      rokitExtension:'corridor definition from VDA 5050 2.1',
      settings:store.plannerOptions.corridor,summary:corridorSummary,
      edges:store.corridorDiagnostics,
    },
    validation:store.validation??null,
    mission:{...mission,completedNodes:[...mission.completedNodes]},
  };
  const nav=[
    ['Planner',<AltRoute/>],['Missions',<ListAlt/>],['Map',<Map/>],['Waypoints',<Place/>],['Order',<ListAlt/>],
    ['Robot State',<MonitorHeart/>],['MQTT',<Cloud/>],['Global Replanning',<Autorenew/>],
    ['Logs',<Subject/>],['Diagnostics',<BugReport/>],['Settings',<Settings/>],
  ] as const;
  const activeNav=settingsOpen?'Settings':locatorOpen?'Map':waypointsOpen?'Waypoints':globalReplanningOpen?'Global Replanning':
    diagnosticsOpen?({0:'Logs',5:'Order',7:'MQTT'}[bottom]??'Diagnostics'):advancedMissionOpen?'Robot State':workspace.open?'Missions':'Planner';
  return <Box className="mr-app-shell" onKeyDown={handleWorkspaceKey}
    data-compact={operatorSettings.compactMode} data-reduce-motion={operatorSettings.reduceMotion} sx={{
    bgcolor:'background.default','--mr-nav-width':`${drawerWidth}px`,'--mr-mission-width':`${rightWidth}px`,
    '--mr-map-contrast':Number.isFinite(operatorSettings.mapContrast)
      ?Math.min(2,Math.max(.5,operatorSettings.mapContrast)):1,
  }}>
    <StartupOverlay/>
    <DeliveryConsole open={deliveryOpen} onClose={()=>setDeliveryOpen(false)}/>
    <AppBar position="static" elevation={0} sx={{
      background:'#fff',color:'text.primary',
      borderBottom:'1px solid',borderColor:'divider'}}>
      <Toolbar sx={{gap:1.2,minHeight:'56px!important',px:2,py:.5,flexWrap:'wrap'}}>
        <MedRobotsLogo compact={tablet}/>
        <Box sx={{mr:1,minWidth:0}}>
          <Typography variant="h3" noWrap>Mission Planner</Typography>
          {!tablet&&<Typography variant="caption" color="text.secondary">PharmaRobot navigation control</Typography>}
        </Box>
        <Box sx={{flex:1}}/>
        <Button color={store.mqttConnected&&locator.sessionState==='logged-in'?'inherit':'warning'} startIcon={<Sensors/>} onClick={()=>setSystemsOpen(true)} aria-label="System connections">
          {robotConnectionLabel}{locator.connectionState==='error'?' ? Locator error':''}
        </Button>
        <StatusPill label={`E-stop ${displayedState?.safetyState?.eStop??'unknown'}`}
          tone={displayedState?.safetyState?.eStop==='NONE'?'connected':'error'}/>
        <StatusPill label={displayedState?`${store.currentRokitErrors.length} errors`:'Errors unavailable'}
          tone={displayedState&&store.currentRokitErrors.length?'error':'inactive'}/>
        {tablet&&<Tooltip title="Mission panel"><IconButton color="primary" aria-label="Mission panel"
          aria-expanded={missionPanelOpen} onClick={()=>setMissionPanelOpen(value=>!value)}><AltRoute/></IconButton></Tooltip>}
        <Tooltip title="Settings"><IconButton color="inherit" onClick={()=>setSettingsOpen(true)}><Settings/></IconButton></Tooltip>
      </Toolbar>
      <Alert severity="error" icon={<StopCircle/>} sx={{py:0,minHeight:30,borderRadius:0,fontWeight:700,
        '& .MuiAlert-message':{py:.25}}}>{safety}</Alert>
    </AppBar>
    <Box className={`mr-workspace${!tablet||missionPanelOpen?' mr-workspace-mission':''}`}>
    <Drawer variant="permanent" className="mr-workspace-nav" PaperProps={{component:'nav','aria-label':'Workspace navigation'}} sx={{
      '& .MuiDrawer-paper':{position:'static',height:'100%',width:'100%',boxSizing:'border-box',
        bgcolor:'rgba(255,255,255,.98)',borderRight:'1px solid',borderColor:'divider'}}}>
      <Box sx={{display:'flex',justifyContent:navCollapsed?'center':'flex-end',p:.5}}>
        <IconButton size="small" aria-label={navCollapsed?'Expand navigation':'Collapse navigation'}
          onClick={()=>setNavCollapsed((value)=>!value)}>
          {navCollapsed?<ChevronRight/>:<ChevronLeft/>}
        </IconButton>
      </Box>
      <List dense>{nav.map(([label,icon],index)=><Box key={label}>
        {(index===0||index===6)&&<Typography className="mr-nav-section" variant="overline">{navCollapsed?(index===0?'Ops':'Eng'):(index===0?'Operations':'Engineering')}</Typography>}
        <Tooltip key={label} title={navCollapsed?label:''} placement="right"><ListItemButton aria-label={label} selected={label===activeNav} onClick={()=>{
        if(label==='Settings')setSettingsOpen(true);if(label==='Map')setLocatorOpen(true);
        if(label==='Global Replanning')setGlobalReplanningOpen(true);
        if(label==='Missions'){dispatchToken.current++;setDispatchCountdown(undefined);routePreparationGuard.current.cancel();setPlacement(undefined);setMissionPanelOpen(true);workspace.show();}
        if(label==='Robot State'){workspace.close();setMissionPanelOpen(true);setAdvancedMissionOpen(true);}
        if(label==='Planner'){workspace.close();setDiagnosticsOpen(false);setAdvancedMissionOpen(false);document.getElementById('planner-workspace')?.focus();}
        if(label==='Waypoints')setWaypointsOpen(true);
        const tab={MQTT:7,Order:5,Logs:0,Diagnostics:bottom}[label as 'MQTT'|'Order'|'Logs'|'Diagnostics'];
        if(tab!==undefined){setBottom(tab);setDiagnosticsOpen(true);}
      }} sx={{mx:.75,my:.25,borderRadius:2,minHeight:34,justifyContent:navCollapsed?'center':'initial'}}>
        <ListItemIcon sx={{minWidth:navCollapsed?0:32,justifyContent:'center'}}>{icon}</ListItemIcon>
        {!navCollapsed&&<ListItemText primary={label}/>}
      </ListItemButton></Tooltip></Box>)}</List><Divider/>
      {!navCollapsed&&<Box sx={{p:1.5}}><details className="mr-map-tools"><summary>Map setup</summary>
        <Alert severity="info" sx={{my:1}}>{!store.grid?'Load a map to get started.':
          !poseSnapshot?'A fresh robot pose is required to prepare a mission.':
            'Click a free point on the map to calculate and validate a mission.'}</Alert>
        <Typography variant="overline">Advanced click mode</Typography>
        <Select fullWidth size="small" value={mode} inputProps={{'aria-label':'Advanced click mode'}}
          onChange={(e)=>setMode(e.target.value as ClickMode)}>
          {['goal','start','waypoint','obstacle','erase','inspect'].map((m)=><MenuItem value={m} key={m}>{m}</MenuItem>)}
        </Select>
        <Stack gap={1} mt={2}>
          <Button size="small" variant="contained" startIcon={<Map/>} onClick={()=>setLocatorOpen(true)}>Locator Server</Button>
          {!locator.loadedMap&&<Alert severity="info" sx={{fontSize:11}}>No Locator map loaded</Alert>}
          <Button size="small" startIcon={<Upload/>} disabled={yamlLoading||mapImporting} onClick={()=>yamlInput.current?.click()}>
            {yamlLoading?'Reading YAML…':'Import YAML'}</Button>
          {yamlName&&<><Typography variant="caption">Staged metadata: {yamlName}</Typography>
            <Button size="small" onClick={()=>{setYamlText(undefined);setYamlName(undefined);}}
              disabled={yamlLoading||mapImporting}>Clear staged YAML</Button></>}
          <Button size="small" startIcon={<Upload/>} disabled={yamlLoading||mapImporting} onClick={()=>imageInput.current?.click()}>Import image/PGM</Button>
          <Button size="small" startIcon={<Upload/>} disabled={mapImporting} onClick={()=>jsonInput.current?.click()}>Import grid JSON</Button>
          <input hidden aria-label="YAML file" ref={yamlInput} type="file" accept=".yaml,.yml" onChange={e=>void importMap(e,'yaml')}/>
          <input hidden aria-label="Map image file" ref={imageInput} type="file" accept=".pgm,.png,.jpg,.jpeg" onChange={e=>void importMap(e,'image')}/>
          <input hidden aria-label="Grid JSON file" ref={jsonInput} type="file" accept=".json" onChange={e=>void importMap(e,'json')}/>
        </Stack></details>
      </Box>}
    </Drawer>
    <Box component="main" id="planner-workspace" tabIndex={-1} className="mr-workspace-map">
      <Paper role="group" aria-label="Map controls" className="mr-glass" square sx={{
        display:'flex',flexWrap:'wrap',alignItems:'center',px:1.5,py:.5,gap:1,borderRadius:0}}>
        <Typography variant="subtitle2" sx={{mr:.5}}>{store.grid?.metadata.mapId??'Planning map'}</Typography>
        <Select size="small" value={store.plannerMode} inputProps={{'aria-label':'Planner mode'}}
          onChange={(e)=>store.set({plannerMode:e.target.value as typeof store.plannerMode})}>
          <MenuItem value="automatic">Automatic</MenuItem><MenuItem value="manual">Manual</MenuItem><MenuItem value="hybrid">Hybrid</MenuItem><MenuItem value="motion-state">Motion state (experimental)</MenuItem>
        </Select>
        <Box className="mr-map-tool-slot" aria-label="Map editing tools">
          <Button size="small" variant="outlined" startIcon={<AddLocationAlt/>} disabled={!planningMapId} onClick={()=>startPlacement()}>Create Waypoint</Button>
        </Box>
        {!workspace.open&&<><Tooltip title={recalculateReason??'Calculate a route preview'}><span>
          <Button variant="outlined" startIcon={<AltRoute/>} disabled={store.planning||Boolean(recalculateReason)}
            onClick={()=>void plan()}>{store.planning?'Planning…':'Recalculate'}</Button>
        </span></Tooltip>
        <Button startIcon={<Refresh/>} onClick={()=>{
          planningCoordinator.invalidate();store.invalidateRoute();
        }}>Clear path</Button></>}
        <Box sx={{flex:1}}/><Typography variant="caption">{store.grid?`${store.grid.metadata.width}×${store.grid.metadata.height} · ${store.grid.metadata.resolution} m/cell`:'No map loaded'}</Typography>
      </Paper>
      {(locator.downloading||mapImporting)&&<Alert severity="info" role="status">
        {locator.downloading?'Loading Locator map…':'Importing map…'}
      </Alert>}
      {placement&&<Alert severity="info" action={<Button onClick={()=>setPlacement(undefined)}>Cancel</Button>}>
        Select a free position for {placement.item?.displayName??'the new waypoint'}.
      </Alert>}
      {workspace.pick&&<Alert severity="info" action={<Button onClick={()=>workspace.setPick(false)}>Cancel</Button>}>Select a free cell for the next mission destination.</Alert>}
      <MapCanvas missionIndex={workspace.open?workspace.index:undefined} missionPreview={workspace.open?workspace.preview?.legs:undefined} focusedPoint={focusedPoint} mode={mode} onCell={setCell} liveRobotPose={poseSnapshot?.pose}/>
    </Box>
    <Box component="aside" aria-label="Mission panel" className="mr-workspace-mission-panel"
      hidden={tablet&&!missionPanelOpen}
      sx={{p:1.5,bgcolor:'rgba(255,255,255,.98)',borderLeft:'1px solid',borderColor:'divider'}}>
      {workspace.open?<MissionsPanel onDelivery={()=>setDeliveryOpen(true)} draft={workspace.draft} mapId={store.grid?.metadata.mapId} points={workspace.points}
        index={workspace.index} continuing={!!workspace.run} busy={workspace.busy} preview={workspace.preview}
        message={workspace.message} blockers={missionBlockers()} robot={robotConnectionLabel} pose={!!poseSnapshot}
        speed={store.orderSettings.missionMaximumSpeedMps} replanning={globalReplanning.runtime.status} onEdit={workspace.edit}
        onMap={()=>{setPlacement(undefined);workspace.setPick(true);}} onClose={workspace.close}
        onContinue={workspace.resume} onValidate={()=>void workspace.validate()} onExecute={()=>void executeDestination()}
        canCancel={store.mqttConnected&&(!activeNavigatorOrderId||activeNavigatorOrderId===store.sentOrder?.orderId)?store.sentOrder?.orderId:undefined} onCancel={id=>void instant('cancelOrder',id)}/>:<>
      <Paper component="section" aria-label="Route preview" className="mr-glass mr-route-ready" sx={{p:1.5,mb:1.5}}>
        <Stack alignItems="flex-start" gap={.5}>
          <Box><Typography variant="overline">Mission control</Typography>
            <Typography variant="h2" aria-live="polite">{routeStatus.label}</Typography></Box>
          <StatusPill label={!displayedState?'Telemetry unavailable':
            displayedState.driving?'Driving':displayedState.paused?'Paused':'Idle'}
            tone={displayedState?.driving?'connected':displayedState?.paused?'warning':'inactive'}/>
        </Stack>
        <Divider sx={{my:1.2}}/>
        <Field label="Destination" value={store.goal?`${store.goal.x.toFixed(2)}, ${store.goal.y.toFixed(2)} m`:'Select on map'}/>
        {store.sentOrder&&<Field label="Submitted mission" value={mission.status}/>}
        <Field label="Route distance" value={routeDistance?`${routeDistance.toFixed(2)} m`:'—'}/>
        <Field label="Time at maximum speed" value={estimatedDurationSeconds?`${Math.ceil(estimatedDurationSeconds)} s`:'—'}/>
        <details className="mr-mission-details"><summary>Route and telemetry details</summary>
        <Field label="Order" value={store.generatedOrder?.orderId??'—'}/>
        <Field label="Battery" value={displayedState?.batteryState?.batteryCharge===undefined?'—':`${displayedState.batteryState.batteryCharge}%`}/>
        <Field label="Current speed" value={displayedState?.velocity&&
          (displayedState.velocity.vx!==undefined||displayedState.velocity.vy!==undefined)
          ?`${Math.hypot(displayedState.velocity.vx??0,displayedState.velocity.vy??0).toFixed(2)} m/s`:'Unavailable'}/>
        <Field label="Emergency state" value={displayedState?.safetyState?.eStop??'unknown'}/>
        {store.generatedOrder&&<Paper variant="outlined" sx={{p:1,mt:1}}>
          <Typography variant="overline">Obstacle bypass corridor</Typography>
          <Field label="Edges with corridor" value={corridorSummary.withCorridor}/>
          <Field label="Edges without corridor" value={corridorSummary.withoutCorridor}/>
          <Field label="Left width min / max" value={corridorSummary.minimumLeft===undefined?'N/A':
            `${corridorSummary.minimumLeft.toFixed(3)} / ${corridorSummary.maximumLeft!.toFixed(3)} m`}/>
          <Field label="Right width min / max" value={corridorSummary.minimumRight===undefined?'N/A':
            `${corridorSummary.minimumRight.toFixed(3)} / ${corridorSummary.maximumRight!.toFixed(3)} m`}/>
        </Paper>}
        <Alert severity={store.stage5BRecordingStatus?.includes('failed')?'warning':'info'} sx={{mt:1}}>
          {store.stage5BRecordingStatus??'Stage 5B: automatic recording for motion-state runs.'}
          {' '}Pending recordings: {store.stage5BPendingCount??0}
        </Alert>
        </details>
        {store.generatedOrder&&store.plannerOptions.corridor.enableBoschRokitCorridorExtension&&
          corridorSummary.withCorridor===0&&<Alert severity="warning" sx={{mt:1}}>
            Corridor generation is enabled in Mission Planner. The generated Order contains no bypass corridor information.
          </Alert>}
        {store.generatedOrder&&corridorSummary.withCorridor>0&&corridorSummary.withoutCorridor>0&&
          <Alert severity="warning" sx={{mt:1}}>Bypass is permitted only on some route segments.</Alert>}
        {countdown!==undefined&&<Alert severity="warning" sx={{mt:1}}>
          Direct dispatch in {countdown}s. <Button size="small" onClick={()=>{
            dispatchToken.current+=1;setDispatchCountdown(undefined);
          }}>Cancel</Button>
        </Alert>}
        {routeStatus.tone==='error'&&<Alert severity="error" sx={{mt:1}}>
          {currentPlanningFailure?.message??store.validation?.errors[0]?.message??store.plannerResult?.error??routeStatus.label}
        </Alert>}
        {store.validation?.valid&&!routeStatus.ready&&!orderAlreadySent&&<Alert severity="warning" sx={{mt:1}}>
          {dispatchIssues[0]?.message??(orderMapMismatch?'Order map differs from the active Navigator map.':firstNodeStatus)}
        </Alert>}
        <Button fullWidth size="large" variant="contained" color="success" startIcon={<PlayArrow/>}
          disabled={!routeStatus.ready||countdown!==undefined||store.publishingOrder}
          onClick={()=>void publish() } sx={{mt:1.5,minHeight:52}}>
          {activeNavigatorOrderId&&store.generatedOrder&&activeNavigatorOrderId!==store.generatedOrder.orderId
            ?'Cancel Active Mission First':store.publishingOrder?'Publishing…':'Start Mission'}
        </Button>
        <Stack direction="row" gap={1} mt={1}>
          <Button fullWidth variant="outlined" disabled={!store.goal&&!store.finalPath.length}
            onClick={()=>void clearDestination()}>Clear Destination</Button>
          <Button fullWidth color="error" variant="text"
            disabled={!store.mqttConnected||(!store.sentOrder&&!activeNavigatorOrderId)}
            onClick={()=>void instant('cancelOrder')}>Cancel Mission</Button>
        </Stack>
      </Paper>
      <QuickDestinations onManage={()=>setWaypointsOpen(true)} mapId={planningMapId??null} currentGoal={store.goal?.mapId===planningMapId?store.goal:undefined}
        onSelect={selectSavedDestination} onSaveGoal={()=>{if(store.goal&&planningMapId)setDraft({...store.goal,mapId:planningMapId,theta:store.goalThetaExplicit?store.goal.theta:undefined});}}/>
      <Button sx={{mt:1.5}} endIcon={advancedMissionOpen?<ExpandLess/>:<ExpandMore/>}
        onClick={()=>setAdvancedMissionOpen((value)=>!value)}>Advanced mission data</Button>
      <Box sx={{display:advancedMissionOpen?'block':'none'}}>
      <Typography variant="overline" sx={{mt:1.5}}>Robot state</Typography>
      <Paper variant="outlined" sx={{p:1.2,mb:1}}>
        <Field label="Operating mode" value={store.state?.operatingMode}/><Field label="Driving" value={store.state?.driving}/>
        <Field label="Paused" value={store.state?.paused}/><Field label="Order ID" value={store.state?.orderId}/>
        <Field label="Last node" value={store.state?.lastNodeId}/><Field label="Battery" value={store.state?.batteryState?.batteryCharge}/>
        <Field label="Position initialized" value={store.state?.agvPosition?.positionInitialized}/><Field label="State age" value={Number.isFinite(stateAge)?`${(stateAge/1000).toFixed(1)} s`:'—'}/>
        {stale&&<Alert severity="error" sx={{mt:1}}>State is stale. Publishing is disabled.</Alert>}
      </Paper>
      <Typography variant="overline">Current / goal pose</Typography>
      <Paper variant="outlined" sx={{p:1.2,mb:1}}>
        <Field label="Planning start x / y" value={store.start?`${store.start.x.toFixed(3)} / ${store.start.y.toFixed(3)}`:undefined}/>
        <Field label="Planning start θ" value={store.start?`${store.start.theta.toFixed(3)} rad / ${radiansToDegrees(store.start.theta).toFixed(1)}°`:undefined}/>
        <Field label="Goal x / y" value={store.goal?`${store.goal.x.toFixed(3)} / ${store.goal.y.toFixed(3)}`:undefined}/>
        <TextField fullWidth size="small" label="Goal theta (rad)" type="number" disabled={!store.goal} value={store.goal?.theta??''}
          onChange={(e)=>store.goal&&store.set({goal:{...store.goal,theta:normalizeAngle(Number(e.target.value))},goalThetaExplicit:true})} sx={{mt:1}}/>
      </Paper>
      <Typography variant="overline">Planner / order</Typography>
      <Paper variant="outlined" sx={{p:1.2,mb:1}}>
        <Field label="Raw planner cells" value={store.plannerResult?.statistics.rawPointCount}/>
        <Field label="Simplified geometry points" value={store.plannerResult?.statistics.simplifiedPointCount}/>
        <Field label="Final VDA nodes" value={store.generatedOrder?.nodes.length??store.plannerResult?.statistics.finalPointCount}/>
        <Field label="Visited cells" value={store.plannerResult?.statistics.visitedCells}/><Field label="Duration" value={store.plannerResult?`${store.plannerResult.statistics.durationMs.toFixed(1)} ms`:undefined}/>
        <Field label="Detected doors" value={store.plannerResult?.diagnostics?.detectedPassages.length}/>
        <Field label="Route passages" value={store.plannerResult?.diagnostics?.routePassageCount}/>
        <Field label="Nodes inserted" value={store.plannerResult?.diagnostics?.insertedNodeCount}/>
        <Field label="Rejected turn locations" value={store.plannerResult?.diagnostics?.rejectedTurnLocations.length}/>
        <Field label="Relocated turn nodes" value={store.plannerResult?.diagnostics?.relocatedTurnNodes}/>
        <Field label="Minimum route clearance" value={store.plannerResult?.diagnostics
          ?`${store.plannerResult.diagnostics.minimumRouteClearanceM.toFixed(3)} m`:undefined}/>
        <Field label="Largest heading change" value={store.plannerResult?.diagnostics
          ?`${store.plannerResult.diagnostics.largestHeadingChangeDeg.toFixed(1)}°`:undefined}/>
        <Divider sx={{my:1}}/>
        <Field label="Raw A* result" value={store.plannerResult?.diagnostics?.rawPathStatus}/>
        <Field label="Baseline result" value={store.plannerResult?.diagnostics?.baselineStatus}/>
        <Field label="Door alignment result"
          value={store.plannerResult?.diagnostics?.doorAlignmentStatus}/>
        <Field label="Turn validation result"
          value={store.plannerResult?.diagnostics?.turnValidationStatus}/>
        <Field label="Final selected path source"
          value={store.plannerResult?.diagnostics?.finalPathSource}/>
        <Field label="Physical result"
          value={store.plannerResult?.diagnostics?.physicalFailureCode??
            (store.plannerResult?.success?'PHYSICALLY_VALID_ROUTE':undefined)}/>
        <Field label="Free-space connectivity" value={store.plannerResult?.diagnostics?.freeSpace
          ?`${store.plannerResult.diagnostics.freeSpace.pointRobotConnected?'point connected':'point disconnected'}; ${
            store.plannerResult.diagnostics.freeSpace.footprintConnected
              ?'footprint connected':'footprint disconnected'}`
          :undefined}/>
        <Field label="Widest / required half-clearance"
          value={store.plannerResult?.diagnostics?.freeSpace
            ?`${store.plannerResult.diagnostics.freeSpace.widestClearanceM.toFixed(3)} / ${
              store.plannerResult.diagnostics.freeSpace.requiredHalfWidthM.toFixed(3)} m`
            :undefined}/>
        <Field label="Recommended action"
          value={store.plannerResult?.diagnostics?.recommendedOperatorAction}/>
        <Field label="Exact rejection reason" value={[...(store.plannerResult?.diagnostics?.stages??[])]
          .reverse().find((stage)=>stage.severity!=='info')?.reason}/>
        <Stack direction="row" gap={.5} flexWrap="wrap" sx={{my:1}}>
          <Chip size="small" color={store.plannerResult?.rawPath.length?'success':'default'}
            label={!store.plannerResult?'No route calculated':store.plannerResult.rawPath.length?'RAW_PATH_FOUND':'RAW_PATH_FAILED'}/>
          {Boolean(store.plannerResult?.baselinePath?.length)&&
            <Chip size="small" color="success" label="BASELINE_PATH_VALID"/>}
          {store.plannerResult?.diagnostics?.warnings.some((warning)=>
            warning==='DOOR_ALIGNMENT_SKIPPED'||warning==='TURN_RELOCATION_SKIPPED')&&
            <Chip size="small" color="warning" label="ADVANCED_ALIGNMENT_SKIPPED"/>}
          {store.validation?.valid&&<Chip size="small" color="success" label="ORDER_READY"/>}
        </Stack>
        <Button size="small" variant="outlined"
          disabled={!store.plannerResult?.baselinePath?.length}
          onClick={useBaselinePath}>Use valid baseline route</Button>
        {store.plannerResult?.diagnostics?.stages.map((stage,index)=>
          <Alert key={`${stage.stage}-${index}`}
            severity={stage.severity==='error'?'error':stage.severity==='warning'?'warning':'info'}
            sx={{mt:.5,py:0}}>
            {stage.stage}: {stage.code} — {stage.inputPointCount} → {stage.outputPointCount}.
            {' '}{stage.reason}
            {stage.world&&` World ${stage.world.x.toFixed(3)}, ${stage.world.y.toFixed(3)}.`}
            {stage.grid&&` Grid ${stage.grid.column}, ${stage.grid.row}.`}
            {stage.clearanceM!==undefined&&` Clearance ${stage.clearanceM.toFixed(3)} m; required ${(stage.requiredClearanceM??0).toFixed(3)} m.`}
          </Alert>)}
        <Field label="Live obstacle count" value={globalReplanning.runtime.temporaryObstacleCount}/>
        <Field label="Temporary blocked cells"
          value={globalReplanning.runtime.temporaryObstacleCells.length}/>
        <Field label="Route-replanning reason" value={globalReplanning.runtime.reason}/>
        <TextField size="small" fullWidth label="Maximum speed (m/s)" type="number"
          inputProps={{min:0.001,step:0.01}}
          value={store.orderSettings.missionMaximumSpeedMps}
          onChange={(e)=>store.set({orderSettings:{...store.orderSettings,
            missionMaximumSpeedMps:normalizeMissionMaximumSpeed(
              Number(e.target.value))}})} sx={{mt:1}}/>
        <Typography variant="overline" sx={{display:'block',mt:1}}>
          Speed Limit Analysis
        </Typography>
        <Paper variant="outlined" sx={{p:1}}>
          <Field label="Mission maximum speed"
            value={`${speedLimitAnalysis.missionMaximumSpeedMps} m/s`}/>
          <Field label="edge.maxSpeed"
            value={speedLimitAnalysis.edgeMaxSpeed===null?'<unavailable>':
              `${speedLimitAnalysis.edgeMaxSpeed} m/s`}/>
          <Field label="allowedMaxLinearSpeed"
            value={speedLimitAnalysis.allowedMaxLinearSpeed===null?'<unavailable>':
              `${speedLimitAnalysis.allowedMaxLinearSpeed} m/s`}/>
          <Field label="commandVelocityX"
            value={speedLimitAnalysis.commandVelocityX===null?'<unavailable>':
              `${speedLimitAnalysis.commandVelocityX} m/s`}/>
          <Field label="velocityX"
            value={speedLimitAnalysis.velocityX===null?'<unavailable>':
              `${speedLimitAnalysis.velocityX} m/s`}/>
          <Field label="Effective limiting component"
            value={speedLimitAnalysis.effectiveLimitingComponent}/>
        </Paper>
        {store.plannerMode==='motion-state'
          ?<EffectiveMotionStateConfigurationPanel plannerOptions={store.plannerOptions}
            footprint={store.footprint}/>
          :<><FormControlLabel control={<Switch size="small" checked={store.plannerOptions.diagonalMovement}
          onChange={(e)=>store.set({plannerOptions:{...store.plannerOptions,diagonalMovement:e.target.checked}})}/>} label="Diagonal movement"/>
        <Stack direction="row" gap={.5}>
          <TextField size="small" label="Wall cost" type="number" value={store.plannerOptions.passageSafety.wallProximityWeight}
            onChange={(e)=>store.set({plannerOptions:syncPlannerWeights({
              ...store.plannerOptions,
              proximityWeight:Number(e.target.value),
              passageSafety:{...store.plannerOptions.passageSafety,wallProximityWeight:Number(e.target.value)},
            })})}/>
          <TextField size="small" label="Turn cost" type="number" value={store.plannerOptions.passageSafety.headingChangeWeight}
            onChange={(e)=>store.set({plannerOptions:syncPlannerWeights({
              ...store.plannerOptions,
              turnPenalty:Number(e.target.value),
              passageSafety:{...store.plannerOptions.passageSafety,headingChangeWeight:Number(e.target.value)},
            })})}/>
        </Stack></>}
        <Stack direction="row" gap={.5} mt={.5}>
          <TextField size="small" label="Max plan ms" type="number" value={store.plannerOptions.maxPlanningTimeMs}
            onChange={(e)=>store.set({plannerOptions:{...store.plannerOptions,maxPlanningTimeMs:Number(e.target.value)}})}/>
          {store.plannerMode!=='motion-state'&&<TextField size="small" label="Max segment m" type="number" value={store.plannerOptions.maximumWaypointDistance}
            onChange={(e)=>store.set({plannerOptions:{...store.plannerOptions,maximumWaypointDistance:Number(e.target.value)}})}/>}
        </Stack>
         <Button fullWidth sx={{mt:1}} variant="outlined" onClick={generate} disabled={store.finalPath.length<2||store.planning}>Generate & validate VDA order</Button>
         <Button fullWidth sx={{mt:.5}} variant="outlined" color="warning" disabled={!store.goal||store.planning} onClick={()=>void rebuildFromCurrentPose()}>
           Rebuild Order From Current Pose
         </Button>
         <Button fullWidth sx={{mt:.5}} variant="outlined" startIcon={<BugReport/>}
           onClick={()=>setCorridorCompatibilityOpen(true)}>
           ROKIT Corridor Compatibility Test
         </Button>
        <Stack direction="row" gap={.5} mt={.5}>
          <Button size="small" disabled={!store.generatedOrder} onClick={()=>store.generatedOrder&&downloadJson('vda-order.json',store.generatedOrder)}>Export order</Button>
          <Button size="small" disabled={store.finalPath.length<2} onClick={()=>downloadJson('planner-path.json',store.finalPath)}>Export path</Button>
        </Stack>
        <Button size="small" fullWidth sx={{mt:.5}}
          disabled={!store.lastPlanningScenario}
          onClick={()=>{
            try {
              const artifact=useAppStore.getState().lastPlanningScenario;
              if(!artifact)return;
              downloadJson(`motion-scenario-${Date.now()}.json`,validateMotionPlannerScenarioArtifact(artifact));
            }catch(error){setToast({severity:'error',message:`Scenario export failed: ${String(error)}`});}
          }}>Export last motion-state run (success or failure, includes map)</Button>
        <Typography variant="caption">Finalize the current route recording (does not control the robot):</Typography>
        <Stack direction="row" gap={.5}>
          <Button size="small" disabled={!store.stage5BPendingCount} onClick={()=>stage5BRecording.finalizePending('success',store.state)}>Finalize success</Button>
          <Button size="small" disabled={!store.stage5BPendingCount} onClick={()=>stage5BRecording.finalizePending('failed',store.state)}>Finalize failed</Button>
          <Button size="small" disabled={!store.stage5BPendingCount} onClick={()=>stage5BRecording.finalizePending('cancelled',store.state)}>Finalize cancelled</Button>
          <Button size="small" disabled={!store.stage5BPendingCount} onClick={()=>stage5BRecording.retry()}>Retry save</Button>
        </Stack>
        {store.lastPlanningScenario&&<Typography variant="caption">
          Captured {store.lastPlanningScenario.capture?.capturedAt??'run'} — {store.lastPlanningScenario.capture?.result.success?'success':'failure'}.
          Later selections and telemetry do not alter this export.
        </Typography>}
      </Paper>
      <Typography variant="overline">First node check</Typography>
      <Paper variant="outlined" sx={{p:1.2,mb:1}}>
        <Field label="Robot x / y" value={firstNodeDiagnostics.robotPose
          ?`${firstNodeDiagnostics.robotPose.x.toFixed(4)} / ${firstNodeDiagnostics.robotPose.y.toFixed(4)}`:undefined}/>
        <Field label="Robot θ" value={firstNodeDiagnostics.robotPose
          ?`${firstNodeDiagnostics.robotPose.theta.toFixed(4)} rad / ${radiansToDegrees(firstNodeDiagnostics.robotPose.theta).toFixed(2)}°`:undefined}/>
        <Field label="Node 0 x / y" value={firstNodeDiagnostics.node0
          ?`${firstNodeDiagnostics.node0.x.toFixed(4)} / ${firstNodeDiagnostics.node0.y.toFixed(4)}`:undefined}/>
        <Field label="Node 0 θ" value={firstNodeDiagnostics.node0
          ?`${firstNodeDiagnostics.node0.theta.toFixed(4)} rad / ${radiansToDegrees(firstNodeDiagnostics.node0.theta).toFixed(2)}°`:undefined}/>
        <Field label="Difference XY" value={firstNodeDiagnostics.positionDifference?.toFixed(6)}/>
        <Field label="Difference θ" value={firstNodeDiagnostics.angularDifference===undefined?undefined:
          `${firstNodeDiagnostics.angularDifference.toFixed(6)} rad / ${firstNodeDiagnostics.angularDifferenceDegrees?.toFixed(3)}°`}/>
        <Field label="Allowed XY / θ" value={firstNodeDiagnostics.allowedDeviationXy===undefined?undefined:
          `${firstNodeDiagnostics.allowedDeviationXy} m / ${firstNodeDiagnostics.allowedDeviationTheta} rad`}/>
        <Field label="State / visualization age" value={`${Number.isFinite(stateAge)?stateAge.toFixed(0):'N/A'} / ${Number.isFinite(visualizationAge)?visualizationAge.toFixed(0):'N/A'} ms`}/>
        <Field label="Pose source / mapId" value={`${poseSnapshot?.source??'N/A'} / ${navigatorMapId??'N/A'}`}/>
        <Field label="MapId source" value={activeMapResolution.source}/>
        <Chip size="small" sx={{mt:1}} color={firstNodeStatus==='Valid'?'success':firstNodeStatus==='Not generated'?'default':'error'} label={firstNodeStatus}/>
      </Paper>
      {store.validation&&<Alert severity={store.validation.valid?'success':'error'} sx={{mb:1}}>
        {store.validation.valid
          ?`Order valid${store.validation.warnings.length?` with ${store.validation.warnings.length} warning(s)`:''}`
          :store.validation.errors[0]?.message??'Order validation failed.'}
      </Alert>}
      {activeMapResolution.source==='manual-confirmed'&&<Alert severity="warning" sx={{mb:1}}>
        Navigator mapId is not being received through MQTT. A user-confirmed map binding is active.
      </Alert>}
      {store.mapBindingMismatchWarning&&<Alert severity="warning" sx={{mb:1}}>
        {store.mapBindingMismatchWarning}
      </Alert>}
      {locatorMismatch&&<Alert severity="error" sx={{mb:1}}>
        Loaded Locator map: {locatorComparison.locator}<br/>
        Active Navigator mapId: {locatorComparison.navigator}<br/>
        Navigator mapId source: {activeMapResolution.source}
      </Alert>}
      <Stack direction="row" flexWrap="wrap" gap={.7} mt={1}>
        <Button disabled startIcon={<Pause/>}>Pause</Button>
        <Button disabled startIcon={<PlayArrow/>}>Resume</Button>
        <Tooltip title="State request action is not confirmed for the current ROKIT configuration.">
          <span><Button disabled>State request</Button></span>
        </Tooltip>
      </Stack>
      <Alert severity="warning" sx={{mt:1}}>Pause action disabled because the current ROKIT configuration rejected the generated stopPause blocking type.</Alert>
      <Alert severity="info" sx={{mt:1}}>State request action is not confirmed for the current ROKIT configuration.</Alert>
      {(store.plannerMode==='manual'||store.plannerMode==='hybrid')&&<Box mt={1}><Typography variant="overline">Waypoint editor</Typography>
        {store.waypoints.map((w,i)=><Paper key={w.id} variant="outlined" sx={{p:.7,mb:.5}}>
          <Stack direction="row" alignItems="center" gap={.5}><Typography variant="caption">{i+1}</Typography>
            <TextField size="small" label="x" type="number" value={w.x} onChange={(e)=>{const a=[...store.waypoints];a[i]={...w,x:Number(e.target.value)};store.set({waypoints:a});}}/>
            <TextField size="small" label="y" type="number" value={w.y} onChange={(e)=>{const a=[...store.waypoints];a[i]={...w,y:Number(e.target.value)};store.set({waypoints:a});}}/>
            <IconButton size="small" aria-label={`Delete waypoint ${i+1}`} onClick={()=>store.set({waypoints:store.waypoints.filter((x)=>x.id!==w.id)})}><Delete/></IconButton></Stack>
          <Stack direction="row" alignItems="center" gap={.5} mt={.5}>
            <TextField size="small" label="θ rad" type="number" value={w.theta} onChange={(e)=>{const a=[...store.waypoints];a[i]={...w,theta:normalizeAngle(Number(e.target.value))};store.set({waypoints:a});}}/>
            <TextField size="small" label="dev m" type="number" value={w.deviationXy} onChange={(e)=>{const a=[...store.waypoints];a[i]={...w,deviationXy:Number(e.target.value)};store.set({waypoints:a});}}/>
            <FormControlLabel control={<Switch size="small" checked={w.orientationLocked} onChange={(e)=>{const a=[...store.waypoints];a[i]={...w,orientationLocked:e.target.checked};store.set({waypoints:a});}}/>} label="Lock"/>
            <Button aria-label={`Move waypoint ${i+1} up`} disabled={i===0} onClick={()=>{const a=[...store.waypoints];[a[i-1],a[i]]=[a[i]!,a[i-1]!];store.set({waypoints:a});}}>↑</Button>
            <Button aria-label={`Move waypoint ${i+1} down`} disabled={i===store.waypoints.length-1} onClick={()=>{const a=[...store.waypoints];[a[i],a[i+1]]=[a[i+1]!,a[i]!];store.set({waypoints:a});}}>↓</Button>
          </Stack>
        </Paper>)}
      </Box>}
      </Box>
      {(store.sentOrder||store.publishingOrder)&&<Paper variant="outlined" sx={{p:1,mt:1}}><Typography variant="overline">Submitted mission</Typography>
        <Field label="Status" value={mission.status}/><Field label="Progress" value={`${mission.progressPercent}%`}/>
        <Field label="Active order" value={mission.activeOrderId}/><Field label="Distance to next" value={mission.distanceToNextNode?.toFixed(2)}/>
        {mission.rejectionErrors.map((error)=><Alert severity="error" key={`${error.errorType}-${error.errorDescription}`}>{error.errorDescription??error.errorType}</Alert>)}</Paper>}
      <Paper variant="outlined" sx={{p:1,mt:1}}>
        <Typography variant="overline">Global replanning</Typography>
        <Field label="Enabled" value={globalReplanning.settings.enabled}/>
        <Field label="Status" value={globalReplanning.runtime.status}/>
        <Field label="Blocked duration" value={`${(globalReplanning.runtime.blockedDurationMs/1000).toFixed(1)} s`}/>
        <Field label="Reason" value={globalReplanning.runtime.reason}/>
        <Button size="small" startIcon={<Autorenew/>}
          onClick={()=>setGlobalReplanningOpen(true)}>Open replanning</Button>
      </Paper>
    </>}
    </Box>
    </Box>
    <Paper className="mr-glass mr-diagnostics-dock" square sx={{
      borderTop:'1px solid',borderColor:'divider',
      height:diagnosticsOpen?'min(310px, 38dvh)':48,
    }}>
      <Stack direction="row" alignItems="center" sx={{height:48,px:1}}>
        <IconButton aria-label={diagnosticsOpen?'Collapse diagnostics':'Expand diagnostics'}
          aria-expanded={diagnosticsOpen} onClick={()=>setDiagnosticsOpen((value)=>!value)}>
          {diagnosticsOpen?<ExpandMore/>:<ExpandLess/>}
        </IconButton>
        <Typography variant="overline" sx={{mr:1}}>Diagnostics</Typography>
        {diagnosticsOpen&&<Tabs value={bottom} onChange={(_,value:number)=>setBottom(value)} variant="scrollable"
          sx={{minHeight:44,flex:1,'& .MuiTab-root':{minHeight:44,fontSize:11}}}>
          {['Operational Log','Validation','ROKIT Errors','MQTT State','MQTT Visualization',
            'Generated Order','Locator','Network','Raw JSON'].map((label)=><Tab key={label} label={label}/>)}
        </Tabs>}
        <IconButton aria-label="Download diagnostics bundle" onClick={()=>downloadJson('med-robots-diagnostics.json',
          sanitizeDiagnostics({logs:store.logs,diagnostics}))}><Save/></IconButton>
        <Button size="small" startIcon={<Download/>} onClick={async () => {
          const selected = bottom === 0
            ? store.logs.filter((entry)=>
              (diagnosticSeverity==='all'||entry.level===diagnosticSeverity)&&
              (!diagnosticSearch||entry.message.toLowerCase().includes(diagnosticSearch.toLowerCase())))
            : bottom === 1
              ? store.validation ?? {}
              : bottom === 2
                ? {
                    currentRokitErrors: store.currentRokitErrors,
                    currentOrderId: store.state?.orderId ?? '',
                    errorHistory: store.errorHistory,
                  }
                : bottom === 3
                  ? (store.rawStatePayload ?? store.state ?? {})
                  : bottom === 4
                    ? (store.rawVisualizationPayload ?? store.visualization ?? {})
                    : bottom === 5
                      ? {
                          protocolBase: 'VDA 5050 2.0',
                          rokitExtension: 'corridor definition from VDA 5050 2.1',
                          mapIdSource: activeMapResolution.source,
                          resolvedNavigatorMapId: navigatorMapId,
                          corridorSummary,
                          corridorDiagnostics: store.corridorDiagnostics,
                          order: store.generatedOrder ?? null,
                        }
                      : bottom === 6
                        ? {
                            connectionState: locator.connectionState,
                            sessionState: locator.sessionState,
                            maps: locator.maps,
                            selectedMap: locator.selectedMapName,
                            loadedMap: locator.loadedMap?.mapName,
                            lastDownloadTime: locator.lastDownloadTime,
                            error: locator.error,
                          }
                        : bottom === 7
                          ? {
                              mqtt: {
                                connected: store.mqttConnected,
                                host: store.mqttSettings.host,
                                port: store.mqttSettings.port,
                                topics: store.mqttSettings.topics,
                                stateAge,
                                visualizationAge,
                              },
                              locator: {
                                host: locator.settings.host,
                                port: locator.settings.port,
                                https: locator.settings.https,
                              },
                            }
                          : sanitizeDiagnostics(diagnostics);
          try{
            await navigator.clipboard.writeText(JSON.stringify(sanitizeDiagnostics(selected), null, 2));
            setToast({severity:'success',message:'Diagnostics copied.'});
          }catch{
            setToast({severity:'error',message:'Could not copy diagnostics. Use Download diagnostics bundle instead.'});
          }
        }}>Copy</Button>
      </Stack>
      {diagnosticsOpen&&<><Divider/>
        {bottom===0&&<Stack direction="row" gap={1} px={1.5} py={.7} flexWrap="wrap">
          <TextField size="small" placeholder="Search diagnostics" value={diagnosticSearch}
            onChange={(event)=>setDiagnosticSearch(event.target.value)} sx={{width:260}}/>
          <Select size="small" value={diagnosticSeverity}
            onChange={(event)=>setDiagnosticSeverity(event.target.value as typeof diagnosticSeverity)}>
            <MenuItem value="all">All severities</MenuItem><MenuItem value="info">Info</MenuItem>
            <MenuItem value="warning">Warning</MenuItem><MenuItem value="error">Error</MenuItem>
          </Select>
          <FormControlLabel control={<Switch size="small" checked={pauseLogScroll}
            onChange={(event)=>setPauseLogScroll(event.target.checked)}/>} label="Pause auto-scroll"/>
          <Button onClick={()=>store.set({logs:[]})} disabled={!store.logs.length}>Clear operational log</Button>
        </Stack>}
        <Box ref={logViewport} sx={{flex:1,minHeight:48,overflow:'auto',px:1.5,pb:1.5,fontFamily:'monospace',fontSize:12,whiteSpace:'pre-wrap'}}>
          {bottom===0&&store.logs.filter((entry)=>
            (diagnosticSeverity==='all'||entry.level===diagnosticSeverity)&&
            (!diagnosticSearch||entry.message.toLowerCase().includes(diagnosticSearch.toLowerCase())))
            .map((entry)=><Box key={entry.id} sx={{py:.25,color:entry.level==='error'?'error.main':
              entry.level==='warning'?'warning.main':'text.secondary'}}>
              {entry.timestamp} [{entry.category}] {entry.message}</Box>)}
          {bottom===1&&JSON.stringify(store.validation??{},null,2)}
          {bottom===2&&<><Button size="small" onClick={store.clearErrorHistory}>Clear error history</Button>{JSON.stringify({
            currentRokitErrors:store.currentRokitErrors,currentOrderId:store.state?.orderId??'',errorHistory:store.errorHistory,
          },null,2)}</>}
          {bottom===3&&JSON.stringify(store.rawStatePayload??store.state??{},null,2)}
          {bottom===4&&JSON.stringify(
            store.rawVisualizationPayload??store.visualization??{},null,2)}
          {bottom===5&&JSON.stringify({
            protocolBase:'VDA 5050 2.0',
            rokitExtension:'corridor definition from VDA 5050 2.1',
            mapIdSource:activeMapResolution.source,resolvedNavigatorMapId:navigatorMapId,
            corridorSummary,corridorDiagnostics:store.corridorDiagnostics,
            order:store.generatedOrder??null,
          },null,2)}
          {bottom===6&&JSON.stringify({connectionState:locator.connectionState,sessionState:locator.sessionState,
            maps:locator.maps,selectedMap:locator.selectedMapName,loadedMap:locator.loadedMap?.mapName,
            lastDownloadTime:locator.lastDownloadTime,error:locator.error},null,2)}
          {bottom===7&&JSON.stringify({mqtt:{connected:store.mqttConnected,host:store.mqttSettings.host,
            port:store.mqttSettings.port,topics:store.mqttSettings.topics,stateAge,visualizationAge},
            locator:{host:locator.settings.host,port:locator.settings.port,https:locator.settings.https}},null,2)}
          {bottom===8&&JSON.stringify(sanitizeDiagnostics(diagnostics),null,2)}
        </Box>
      </>}
    </Paper>
    <Dialog open={systemsOpen} onClose={()=>setSystemsOpen(false)} aria-labelledby="systems-title">
      <DialogTitle id="systems-title">System connections</DialogTitle><DialogContent><Stack gap={1} alignItems="flex-start">
        <StatusPill label={store.mqttConnected?'MQTT connected':'MQTT disconnected'} tone={store.mqttConnected?'connected':'error'} pulse={store.mqttConnected}/>
        <StatusPill label={`Locator ${locator.sessionState==='logged-in'?'Connected':locator.connectionState}`}
          tone={locator.sessionState==='logged-in'?'connected':locator.connectionState==='error'?'error':'warning'}/>
        <StatusPill label={robotConnectionLabel}
          tone={store.mqttConnected&&connectionOnline&&!stale?'connected':'error'}/>
        <StatusPill label={activeMapId==='—'?'No active map':activeMapId} tone={navigatorMapId?'info':'warning'}/>
          <StatusPill label={displayedState?.operatingMode??'Unknown mode'}
            tone={displayedState?.operatingMode==='AUTOMATIC'?'connected':'warning'}/>
      </Stack></DialogContent><DialogActions><Button onClick={()=>setSystemsOpen(false)}>Close</Button></DialogActions>
    </Dialog>
    {waypointsOpen&&<WaypointsPanel mapId={planningMapId} onClose={()=>setWaypointsOpen(false)} onCreate={()=>startPlacement()}
      onReposition={startPlacement} onFocus={point=>{setFocusedPoint({...point});setWaypointsOpen(false);}}
      onDestination={selectSavedDestination} onEdit={point=>{setWaypointsOpen(false);setDraft({...point,item:point,theta:point.thetaExplicit===false?undefined:point.theta});}}/>}
    {draft&&<WaypointEditor draft={draft} grid={store.grid} inflated={store.inflatedGrid} onClose={()=>setDraft(undefined)}/>}
    <Dialog open={locatorOpen} onClose={()=>setLocatorOpen(false)} fullWidth maxWidth="md">
      <DialogTitle>ROKIT Locator Server Map</DialogTitle>
      <DialogContent><Stack gap={2} mt={1}>
        <LocatorConnectionPanel/>
        <LocatorMapSelector onMapLoaded={loadGrid}/>
        <LocatorMapStatus/>
      </Stack></DialogContent>
      <DialogActions><Button onClick={()=>setLocatorOpen(false)}>Close</Button></DialogActions>
    </Dialog>
    <SettingsDialog open={settingsOpen} onClose={()=>setSettingsOpen(false)} notify={setToast}
      onReplanningEnabledChange={changeReplanningEnabled} replanningPending={replanningPending}/>
    <CorridorCompatibilityPanel open={corridorCompatibilityOpen}
      onClose={()=>setCorridorCompatibilityOpen(false)}
      onRun={runCorridorCompatibilityTest}
      dispatchBlockedReason={compatibilityDispatchBlockedReason}/>
    <GlobalReplanningPanel open={globalReplanningOpen}
      onClose={()=>setGlobalReplanningOpen(false)}
      onEnableChange={changeReplanningEnabled} enablePending={replanningPending}/>
    <Dialog open={Boolean(confirmation)} onClose={()=>closeConfirmation(false)}
      fullWidth maxWidth="xs" aria-labelledby="confirmation-title">
      <DialogTitle id="confirmation-title">{confirmation?.title}</DialogTitle>
      <DialogContent>
        <Alert severity={confirmation?.destructive?'warning':'info'} sx={{whiteSpace:'pre-line'}}>
          {confirmation?.message}
        </Alert>
      </DialogContent>
      <DialogActions>
        <Button onClick={()=>closeConfirmation(false)}>Back</Button>
        <Button variant="contained" color={confirmation?.destructive?'error':'primary'}
          onClick={()=>closeConfirmation(true)}>{confirmation?.confirmLabel}</Button>
      </DialogActions>
    </Dialog>
    <Snackbar key={toast?.message} open={Boolean(toast)} autoHideDuration={4500}
      onClose={(_,reason)=>{if(reason!=='clickaway')setToast(undefined);}}
      anchorOrigin={{vertical:'top',horizontal:'center'}}>
      <Alert severity={toast?.severity??'info'} variant="filled" onClose={()=>setToast(undefined)}>
        {toast?.message}
      </Alert>
    </Snackbar>
  </Box>;
}

function SettingsDialog({open,onClose,notify,onReplanningEnabledChange,replanningPending}:{
  open:boolean;onClose:()=>void;notify:(notice:Notice)=>void;
  onReplanningEnabledChange:(enabled:boolean)=>Promise<void>;replanningPending:boolean;
}){
  const store=useAppStore();const mqtt=store.mqttSettings;const order=store.orderSettings;const fp=store.footprint;
  const locator=useLocatorStore();const operator=useOperatorSettingsStore();
  const replanning=useGlobalReplanningStore();
  const importInput=useRef<HTMLInputElement>(null);
  const vehicleConfigInput=useRef<HTMLInputElement>(null);
  const [importing,setImporting]=useState(false);
  const connect=():void=>mqttService.connect(store.mqttSettings);
  const updateIdentity=(patch:Partial<Pick<typeof order,'manufacturer'|'serialNumber'>>):void=>{
    const next={...order,...patch};
    store.setRobotIdentity(next.manufacturer,next.serialNumber);
    store.set({orderSettings:next});
  };
  const updateCorridor=(patch:Partial<typeof store.plannerOptions.corridor>):void=>
    store.set({plannerOptions:{...store.plannerOptions,
      corridor:{...store.plannerOptions.corridor,...patch}}});
  const updatePassage=(patch:Partial<typeof store.plannerOptions.passageSafety>):void=>
    store.set({plannerOptions:{...store.plannerOptions,
      passageSafety:{...store.plannerOptions.passageSafety,...patch}}});
  const showReverseControls = Boolean(fp.allowReverse || fp.backwardAllowed);
  const exportSettings=():void=>downloadJson('rokit-planner-settings.json',{mqttSettings:{...mqtt,password:''},orderSettings:order,footprint:fp,plannerOptions:store.plannerOptions});
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg"><DialogTitle>Med Robots Navigation Settings</DialogTitle>
    <DialogContent><Stack gap={2} mt={1}>
      <Typography variant="h2">Connection</Typography>
      <Paper variant="outlined" sx={{p:1.5}}><Stack gap={1.2}>
      <FormControlLabel control={<Switch checked={mqtt.automaticConnection}
        onChange={(event)=>store.set({mqttSettings:{...mqtt,automaticConnection:event.target.checked}})}/>}
        label="Connect MQTT automatically"/>
      <Stack direction="row" gap={1}><TextField fullWidth label="Broker host" value={mqtt.host} onChange={(e)=>store.set({mqttSettings:{...mqtt,host:e.target.value}})}/>
        <TextField label="Port" type="number" value={mqtt.port} onChange={(e)=>store.set({mqttSettings:{...mqtt,port:Number(e.target.value)}})}/>
        <Select value={mqtt.transport} onChange={(e)=>store.set({mqttSettings:{...mqtt,transport:e.target.value as 'tcp'|'ws'}})}><MenuItem value="tcp">TCP bridge</MenuItem><MenuItem value="ws">WebSocket</MenuItem></Select></Stack>
      <Stack direction="row" gap={1}><TextField fullWidth label="Username" value={mqtt.username} onChange={(e)=>store.set({mqttSettings:{...mqtt,username:e.target.value}})}/>
        <TextField fullWidth label="Password (not persisted)" type="password" value={mqtt.password} onChange={(e)=>store.set({mqttSettings:{...mqtt,password:e.target.value}})}/>
        <FormControlLabel control={<Switch checked={mqtt.tls} onChange={(e)=>store.set({mqttSettings:{...mqtt,tls:e.target.checked}})}/>} label="TLS"/></Stack>
      <Divider/>
      <FormControlLabel control={<Switch checked={locator.settings.automaticConnection}
        onChange={(event)=>locator.updateSettings({automaticConnection:event.target.checked})}/>}
        label="Connect ROKIT Locator automatically"/>
      <FormControlLabel control={<Switch checked={locator.settings.automaticLogin}
        onChange={(event)=>locator.updateSettings({automaticLogin:event.target.checked})}/>}
        label="Automatic Locator login using the local secure environment"/>
      <Stack direction="row" gap={1}>
        <TextField label="Locator host" value={locator.settings.host}
          onChange={(event)=>locator.updateSettings({host:event.target.value})}/>
        <TextField label="RPC port" type="number" value={locator.settings.port}
          onChange={(event)=>locator.updateSettings({port:Number(event.target.value)})}/>
        <TextField label="RPC endpoint" value={locator.settings.rpcEndpoint}
          onChange={(event)=>locator.updateSettings({rpcEndpoint:event.target.value})}/>
        <FormControlLabel control={<Switch checked={locator.settings.https}
          onChange={(event)=>locator.updateSettings({https:event.target.checked})}/>} label="HTTPS"/>
      </Stack>
      <Button color="warning" onClick={()=>void locatorSessionService.forgetCredentials()
        .then(()=>{
          locator.set({sessionState:'logged-out',sessionId:undefined});
          notify({severity:'success',message:'Saved Locator credentials cleared.'});
        })
        .catch((error)=>{
          notify({severity:'error',message:`Could not clear Locator credentials: ${String(error)}`});
          LogService.write('system','error',String(error));
        })}>
        Forget saved Locator credentials
      </Button>
      </Stack></Paper>
      <Typography variant="h2">Navigation</Typography>
      {store.plannerMode==='motion-state'&&
        <EffectiveMotionStateConfigurationPanel plannerOptions={store.plannerOptions}
          footprint={store.footprint}/>}
      <Paper variant="outlined" sx={{p:1.5}}><Stack direction="row" gap={1} flexWrap="wrap">
        {store.plannerMode!=='motion-state'&&<>
        <TextField label="Wall cost" type="number" value={store.plannerOptions.passageSafety.wallProximityWeight}
          onChange={(event)=>store.set({plannerOptions:syncPlannerWeights({
            ...store.plannerOptions,
            proximityWeight:Number(event.target.value),
            passageSafety:{...store.plannerOptions.passageSafety,wallProximityWeight:Number(event.target.value)},
          })})}/>
        <TextField label="Turn cost" type="number" value={store.plannerOptions.passageSafety.headingChangeWeight}
          onChange={(event)=>store.set({plannerOptions:syncPlannerWeights({
            ...store.plannerOptions,
            turnPenalty:Number(event.target.value),
            passageSafety:{...store.plannerOptions.passageSafety,headingChangeWeight:Number(event.target.value)},
          })})}/>
        </>}
        <TextField label="Maximum planning time ms" type="number" value={store.plannerOptions.maxPlanningTimeMs}
          onChange={(event)=>store.set({plannerOptions:{...store.plannerOptions,maxPlanningTimeMs:Number(event.target.value)}})}/>
        {store.plannerMode!=='motion-state'&&<TextField label="Maximum segment length m" type="number" value={store.plannerOptions.maximumWaypointDistance}
          onChange={(event)=>store.set({plannerOptions:{...store.plannerOptions,maximumWaypointDistance:Number(event.target.value)}})}/>
        }
        <TextField label="Maximum VDA node count" type="number" value={operator.settings.maximumVdaNodeCount}
          onChange={(event)=>{
            const count=Number(event.target.value);
            if(!Number.isInteger(count)||count<2||count===operator.settings.maximumVdaNodeCount)return;
            operator.update({maximumVdaNodeCount:count});
            store.invalidateRoute();
          }}/>
        <TextField label="Destination validation radius m" type="number" value={operator.settings.destinationValidationRadius}
          disabled helperText="Radius adjustment is unavailable. The planner checks the selected cell."/>
        {store.plannerMode!=='motion-state'&&<FormControlLabel control={<Switch checked={store.plannerOptions.diagonalMovement}
          onChange={(event)=>store.set({plannerOptions:{...store.plannerOptions,diagonalMovement:event.target.checked}})}/>}
          label="Diagonal movement"/>}
      </Stack></Paper>
      <Typography variant="h2">Passage Alignment and Turn Safety</Typography>
      <Paper variant="outlined" sx={{p:1.5}}><Stack gap={1.2}>
        <Select value={store.plannerOptions.policy} onChange={(event)=>{
          const policy=event.target.value as 'reliable'|'balanced'|'advanced';
          store.set({plannerOptions:{
            ...store.plannerOptions,policy,reliableBaselineMode:policy==='reliable',
          }});
        }}>
          <MenuItem value="reliable">Reliable</MenuItem>
          <MenuItem value="balanced">Balanced</MenuItem>
          <MenuItem value="advanced">Advanced</MenuItem>
        </Select>
        <Alert severity="info">
          Reliable keeps the mandatory footprint-validated baseline. Balanced adds
          transactional clearance, door and turn enhancements. Advanced also enables
          the diagnostics needed for temporary-obstacle global replanning; replanning
          remains separately armed by the operator.
        </Alert>
        <Stack direction="row" gap={2} flexWrap="wrap">
          <FormControlLabel control={<Switch
            checked={store.plannerOptions.reliableBaselineMode}
            onChange={(event)=>store.set({plannerOptions:{
              ...store.plannerOptions,
              policy:event.target.checked?'reliable':'balanced',
              reliableBaselineMode:event.target.checked,
            }})}/>}
            label="Reliable baseline mode"/>
          <FormControlLabel control={<Switch
            checked={store.plannerOptions.passageSafety.enableWaypointDensification}
            onChange={(event)=>updatePassage({
              enableWaypointDensification:event.target.checked})}/>}
            label="Enable waypoint densification"/>
          <FormControlLabel control={<Switch
            checked={store.plannerOptions.passageSafety.enableDoorwayDetection}
            onChange={(event)=>updatePassage({enableDoorwayDetection:event.target.checked})}/>}
            label="Enable doorway detection"/>
          <FormControlLabel control={<Switch
            checked={store.plannerOptions.passageSafety.enableDoorAlignment}
            onChange={(event)=>updatePassage({enableDoorAlignment:event.target.checked})}/>}
            label="Enable optional door alignment"/>
          <FormControlLabel control={<Switch
            checked={store.plannerOptions.passageSafety.enableTurnFeasibilityChecking}
            onChange={(event)=>updatePassage({
              enableTurnFeasibilityChecking:event.target.checked})}/>}
            label="Enable optional turn-feasibility enhancement"/>
          <FormControlLabel control={<Switch checked={replanning.settings.enabled} disabled={replanningPending}
            onChange={(event)=>void onReplanningEnabledChange(event.target.checked)}/>}
            label="Enable automatic replanning"/>
        </Stack>
        <Stack direction="row" gap={1} flexWrap="wrap">
          {([
            ['Preferred waypoint spacing m','preferredWaypointSpacingM'],
            ['Maximum waypoint spacing m','maximumWaypointSpacingM'],
            ['Door alignment before m','doorAlignmentDistanceBeforeM'],
            ['Door alignment after m','doorAlignmentDistanceAfterM'],
            ['Minimum door confidence','minimumDoorConfidence'],
            ['Maximum door approach angle °','maximumDoorApproachAngleDeg'],
            ['Maximum heading change per node °','maximumHeadingChangePerNodeDeg'],
            ['Maximum heading change near doors °','maximumHeadingChangeNearDoorDeg'],
            ['Rotation collision sample °','rotationCollisionSampleDeg'],
            ['Minimum passage width m','minimumPassageWidthM'],
            ['Preferred wall clearance m','wallClearancePreferredM'],
            ['Minimum wall clearance m','wallClearanceMinimumM'],
            ['Planning safety margin m','planningSafetyMarginM'],
            ['Localization margin m','localizationMarginM'],
            ['Wall proximity weight','wallProximityWeight'],
            ['Narrow passage weight','narrowPassageWeight'],
            ['Heading change weight','headingChangeWeight'],
            ['Turn location weight','turnLocationWeight'],
            ...(showReverseControls ? [['Reverse risk weight','reverseRiskWeight']] as const : []),
          ] as const).map(([label,key])=><TextField key={key} label={label} type="number"
            value={store.plannerOptions.passageSafety[key]}
            onChange={(event)=>updatePassage({[key]:Number(event.target.value)})}/>) }
        </Stack>
        <Alert severity="info">
          Collision checks use the complete configured footprint. Static-map inflation is
          visual only for this planner and is not added a second time to the footprint.
        </Alert>
      </Stack></Paper>
      <Typography variant="h2">Robot footprint</Typography>
      <Paper variant="outlined" sx={{p:1.5}}><Stack gap={1.2}>
        <FormControlLabel control={<Switch checked={Boolean(fp.allowReverse || fp.backwardAllowed)}
          onChange={(event)=>{ const allowed = event.target.checked; store.set({footprint:{...fp,allowReverse:allowed,backwardAllowed:allowed}}); }}/>} 
          label="Allow reverse motion"/>
        {showReverseControls&&<>
          <TextField label="Reverse risk weight" type="number" value={store.plannerOptions.passageSafety.reverseRiskWeight}
            onChange={(event)=>updatePassage({reverseRiskWeight:Number(event.target.value)})}/>
        </>}
      </Stack></Paper>
      <Typography variant="h2">Obstacle Bypass Corridor</Typography>
      <Paper variant="outlined" sx={{p:1.5}}><Stack gap={1.2}>
        <Alert severity="info">
          Protocol base: VDA 5050 2.0<br/>
          ROKIT extension: corridor definition from VDA 5050 2.1
        </Alert>
        <FormControlLabel control={<Switch
          checked={store.plannerOptions.corridor.enableBoschRokitCorridorExtension}
          onChange={(event)=>updateCorridor({enableBoschRokitCorridorExtension:event.target.checked})}/>}
          label="Enable Bosch ROKIT corridor extension"/>
        <Stack direction="row" gap={1} flexWrap="wrap">
          <TextField label="Robot width m" type="number" value={fp.width}
            disabled={fp.source==='bosch-client-motion'}
            onChange={(event)=>{const footprint={...fp,width:Number(event.target.value)};
              store.set({footprint,inflatedGrid:store.grid?ObstacleInflation.byRadius(
                store.grid,store.plannerOptions.passageSafety.planningSafetyMarginM+
                store.plannerOptions.passageSafety.localizationMarginM):undefined});}}/>
          <TextField label="Robot length m" type="number" value={fp.length}
            disabled={fp.source==='bosch-client-motion'}
            onChange={(event)=>{const footprint={...fp,length:Number(event.target.value)};
              store.set({footprint,inflatedGrid:store.grid?ObstacleInflation.byRadius(
                store.grid,store.plannerOptions.passageSafety.planningSafetyMarginM+
                store.plannerOptions.passageSafety.localizationMarginM):undefined});}}/>
          <TextField label="Safety margin m" type="number"
            value={store.plannerOptions.corridor.obstacleSafetyMarginM}
            onChange={(event)=>updateCorridor({obstacleSafetyMarginM:Number(event.target.value)})}/>
          <TextField label="Localization margin m" type="number"
            value={store.plannerOptions.corridor.localizationMarginM}
            onChange={(event)=>updateCorridor({localizationMarginM:Number(event.target.value)})}/>
          <TextField label="Minimum corridor width m" type="number"
            value={store.plannerOptions.corridor.minCorridorWidthM}
            onChange={(event)=>updateCorridor({minCorridorWidthM:Number(event.target.value)})}/>
          <TextField label="Maximum corridor width m" type="number"
            value={store.plannerOptions.corridor.maxCorridorWidthM}
            onChange={(event)=>updateCorridor({maxCorridorWidthM:Number(event.target.value)})}/>
          <TextField label="Sample spacing m" type="number"
            value={store.plannerOptions.corridor.corridorSampleSpacingM}
            onChange={(event)=>updateCorridor({corridorSampleSpacingM:Number(event.target.value)})}/>
          <Select value={store.plannerOptions.corridor.corridorRefPoint}
            onChange={(event)=>updateCorridor({
              corridorRefPoint:event.target.value as 'KINEMATICCENTER'|'CONTOUR',
            })}>
            <MenuItem value="KINEMATICCENTER">Kinematic center</MenuItem>
            <MenuItem value="CONTOUR">Vehicle contour</MenuItem>
          </Select>
        </Stack>
        <FormControlLabel control={<Switch checked={store.plannerOptions.corridor.unknownCellsBlocked}
          onChange={(event)=>updateCorridor({unknownCellsBlocked:event.target.checked})}/>}
          label="Treat unknown cells as blocked"/>
      </Stack></Paper>
      <Typography variant="h2">Mission</Typography>
      <Typography variant="overline">VDA identity and limits</Typography>
      <Stack direction="row" gap={1}><TextField label="Manufacturer" value={order.manufacturer} onChange={(e)=>updateIdentity({manufacturer:e.target.value})}/>
        <TextField label="Serial number" value={order.serialNumber} onChange={(e)=>updateIdentity({serialNumber:e.target.value})}/>
        <TextField label="Command timeout ms" type="number" value={order.commandTimeoutMs} onChange={(e)=>store.set({orderSettings:{...order,commandTimeoutMs:Number(e.target.value)}})}/></Stack>
      <Stack direction="row" gap={1}>
        <TextField label="State stale timeout ms" type="number" inputProps={{min:2000,max:60000}}
          value={order.stateStaleTimeoutMs}
          onChange={(e)=>store.set({orderSettings:{...order,stateStaleTimeoutMs:
            clampStateStaleTimeoutMs(Number(e.target.value))}})}/>
        <TextField label="Initial duplicate threshold m" type="number" value={order.initialPathPointDistance}
          onChange={(e)=>store.set({orderSettings:{...order,initialPathPointDistance:Number(e.target.value)}})}/>
        <TextField label="Acceptance timeout ms" type="number" value={order.acceptanceTimeoutMs}
          onChange={(e)=>store.set({orderSettings:{...order,acceptanceTimeoutMs:Number(e.target.value)}})}/>
        <TextField label="Node 0 position limit m" type="number" value={order.firstNodePositionConsistency}
          onChange={(e)=>store.set({orderSettings:{...order,firstNodePositionConsistency:Number(e.target.value)}})}/>
        <TextField label="Node 0 angular limit rad" type="number" value={order.firstNodeAngularConsistency}
          onChange={(e)=>store.set({orderSettings:{...order,firstNodeAngularConsistency:Number(e.target.value)}})}/>
      </Stack>
      <Typography variant="overline">Robot footprint</Typography>
      <Alert severity={fp.source==='bosch-client-motion'?'success':'warning'}>
        Geometry source: {fp.source==='bosch-client-motion'
          ?`ClientMotion.vehicle.footprint (${fp.polygon?.length??0} VEHICLE-frame vertices)`
          :'application fallback rectangle — import the installed Bosch ClientMotion configuration'}
      </Alert>
      <Stack direction="row" gap={1} flexWrap="wrap">{([
        'length','width','height','centerOffsetX','centerOffsetY','safetyMargin',
        'inflationRadius',
      ] as const).map((key)=><TextField key={key} label={key} type="number" value={fp[key]}
        disabled={fp.source==='bosch-client-motion'&&key!=='height'}
        onChange={(e)=>{const footprint={...fp,[key]:Number(e.target.value)};store.set({
          footprint,inflatedGrid:store.grid?ObstacleInflation.byRadius(
            store.grid,store.plannerOptions.passageSafety.planningSafetyMarginM+
            store.plannerOptions.passageSafety.localizationMarginM):undefined,
        });}}/>)}</Stack>
      <Stack direction="row" gap={2} flexWrap="wrap">
        <FormControlLabel control={<Switch checked={fp.kinematicCentreConfirmed===true}
          onChange={(event)=>store.set({footprint:{
            ...fp,kinematicCentreConfirmed:event.target.checked}})}/>}
          label="Kinematic centre confirmed at configured footprint offset"/>
        <FormControlLabel control={<Switch checked={operator.settings.previewBeforeDispatch}
          disabled/>} label="Preview before dispatch (fixed by the dispatch mode)"/>
        <FormControlLabel control={<Switch checked={operator.settings.directDispatchMode}
          onChange={(event)=>operator.update({directDispatchMode:event.target.checked})}/>} label="Direct Dispatch Mode"/>
        <TextField label="Dispatch countdown seconds" type="number" value={operator.settings.dispatchCountdownSeconds}
          onChange={(event)=>operator.update({dispatchCountdownSeconds:Math.min(10,Math.max(1,Number(event.target.value)))})}/>
        <FormControlLabel control={<Switch checked={operator.settings.autoClearCompletedMission}
          onChange={(event)=>operator.update({autoClearCompletedMission:event.target.checked})}/>} label="Auto-clear completed mission"/>
      </Stack>
      <Typography variant="h2">Appearance</Typography>
      <Stack direction="row" gap={2} flexWrap="wrap">
        <FormControlLabel control={<Switch checked={operator.settings.compactMode}
          onChange={(event)=>operator.update({compactMode:event.target.checked})}/>} label="Compact mode"/>
        <FormControlLabel control={<Switch checked={operator.settings.reduceMotion}
          onChange={(event)=>operator.update({reduceMotion:event.target.checked})}/>} label="Reduce motion"/>
        <TextField label="Map contrast" type="number" inputProps={{min:.5,max:2,step:.1}}
          value={operator.settings.mapContrast} onChange={(event)=>{
            const contrast=Number(event.target.value);
            if(contrast>=.5&&contrast<=2)operator.update({mapContrast:contrast});
          }}/>
        <Select value="en" inputProps={{'aria-label':'Interface language'}}>
          <MenuItem value="en">English</MenuItem><MenuItem value="pt" disabled>Português (unavailable)</MenuItem>
        </Select>
      </Stack>
      <Typography variant="h2">Advanced</Typography>
      <Typography variant="overline">Raw MQTT topics</Typography>
      {Object.entries(mqtt.topics).map(([key,value])=><TextField key={key} fullWidth size="small" label={key} value={value}
        onChange={(e)=>store.set({mqttSettings:{...mqtt,topics:{...mqtt.topics,[key]:e.target.value}}})}/>)}
      <Alert severity="warning">{publishWarning}</Alert>
    </Stack></DialogContent><DialogActions>
      <input hidden ref={vehicleConfigInput} type="file" accept=".json" onChange={(event)=>{
        const file=event.target.files?.[0];if(!file)return;
        setImporting(true);
        void file.text().then((text)=>{
          const result=parseBoschVehicleConfiguration(JSON.parse(text),store.footprint);
          store.set({footprint:result.footprint,
            inflatedGrid:store.grid?ObstacleInflation.byRadius(
              store.grid,store.plannerOptions.passageSafety.planningSafetyMarginM+
              store.plannerOptions.passageSafety.localizationMarginM):undefined});
          LogService.write('system','info',
            `Loaded authoritative Bosch footprint: ${result.diagnostic.footprintVertexCount} `+
            `vertices, ${result.diagnostic.kinematicsType}.`);
          result.diagnostic.warnings.forEach((warning)=>
            LogService.write('system','warning',warning));
          notify({severity:'success',message:'Bosch ClientMotion footprint imported.'});
        }).catch((error)=>{
          const message=`Bosch ClientMotion configuration import failed: ${String(error)}`;
          LogService.write('system','error',message);
          notify({severity:'error',message});
        }).finally(()=>setImporting(false));
        event.target.value='';
      }}/>
      <input hidden aria-label="Settings JSON file" ref={importInput} type="file" accept=".json" onChange={(event)=>{
        const file=event.target.files?.[0];
        event.target.value='';
        if(!file)return;
        setImporting(true);
        void file.text().then(text=>{
          const current=useAppStore.getState();
          const patch=parseSettingsFile(text,current);
          current.resetRobotSession();
          current.set(patch);
          notify({severity:'success',message:'Planner settings imported.'});
        }).catch(error=>{
          const message=`Settings import failed: ${String(error)}`;
          LogService.write('system','error',message);
          notify({severity:'error',message});
        }).finally(()=>setImporting(false));
      }}/><Button disabled={importing} onClick={store.resetSettings}>Restore planner defaults</Button>
      <Button disabled={importing} onClick={()=>vehicleConfigInput.current?.click()}>
        Import Bosch ClientMotion
      </Button>
      <Button disabled={importing} onClick={()=>importInput.current?.click()}>{importing?'Importing…':'Import settings'}</Button>
      <Button onClick={exportSettings}>Export planner settings</Button>
      <Button color="error" onClick={()=>{mqttService.disconnect();store.resetRobotSession();}}>Disconnect & reset</Button><Button variant="contained" onClick={connect}>Connect</Button><Button onClick={onClose}>Close</Button></DialogActions>
  </Dialog>;
}
