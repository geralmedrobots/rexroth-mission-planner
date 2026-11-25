import {
  AccountCircle, AltRoute, Autorenew, BugReport, ChevronLeft, ChevronRight, Cloud,
  Delete, Download, EditRoad, ExpandLess, ExpandMore, GridOn, Map,
  Pause, PlayArrow, Refresh, RotateRight, Save, Settings, StopCircle,
  Timeline, Upload,
} from '@mui/icons-material';
import {
  Alert, AppBar, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, Drawer, FormControlLabel, IconButton, List, ListItemButton, ListItemIcon,
  ListItemText, MenuItem, Paper, Select, Snackbar, Stack, Switch, Tab, Tabs, TextField,
  Toolbar, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
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
  VdaInstantAction, VdaOrder, Waypoint,
} from './domain/types';
import { QuickDestinations } from './features/destinations/QuickDestinations';
import type { DestinationCategory, SavedDestination } from './features/destinations/destinationStore';
import { useDestinationStore } from './features/destinations/destinationStore';
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
import { useOperatorSettingsStore } from './features/settings/operatorSettingsStore';
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
import { useAppStore } from './stores/appStore';
import { PlanningCoordinator } from './features/planning/PlanningCoordinator';
import { isCurrentRouteOrder, RoutePreparationGuard } from './features/planning/RouteRevisionGuard';
import { createPlanningConfigurationSnapshot } from './domain/planning/PlanningConfigurationSnapshot';
import { validateMotionPlannerScenarioArtifact } from './domain/planning/MotionPlannerScenarioArtifact';
import { buildLegacyMotionPlan } from './domain/motion/LegacyMotionPlanBuilder';
import { MissionController } from './features/mission/MissionController';
import { stage5BRecording } from './services/Stage5BRecordingService';

const navExpandedWidth=224; const navCollapsedWidth=76; const rightWidth=360;
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
  const [toast,setToast]=useState<{severity:'success'|'warning'|'error'|'info';message:string}>();
  const [confirmation,setConfirmation]=useState<ConfirmationState>();
  const confirmationResolver=useRef<((confirmed:boolean)=>void)|null>(null);
  const lastLivePoseResolutionDiagnostic=useRef<string|undefined>(undefined);
  const [routePhase,setRoutePhase]=useState('Selecting destination');
  const [dispatchCountdown,setDispatchCountdown]=useState<number|null>(null);
  const dispatchToken=useRef(0);
  const routePreparationGuard=useRef(new RoutePreparationGuard());
  const [saveDestinationOpen,setSaveDestinationOpen]=useState(false);
  const [destinationName,setDestinationName]=useState('');
  const [destinationCategory,setDestinationCategory]=useState<DestinationCategory>('other');
  const operatorSettings=useOperatorSettingsStore((state)=>state.settings);
  const addDestination=useDestinationStore((state)=>state.add);
  const globalReplanning=useGlobalReplanningStore();
  const locator=useLocatorStore();
  const evaluateCompatibilityTimeout=useCorridorCompatibilityStore(
    (state)=>state.evaluateTimeout);
  const setLocator=useLocatorStore((state)=>state.set);
  const setActiveMapResolution=useAppStore((state)=>state.setActiveMapResolution);
  const imageInput=useRef<HTMLInputElement>(null); const jsonInput=useRef<HTMLInputElement>(null); const yamlInput=useRef<HTMLInputElement>(null);
  const [now,setNow]=useState(Date.now());
  const drawerWidth=navCollapsed?navCollapsedWidth:navExpandedWidth;
  const diagnosticsHeight=diagnosticsOpen?310:48;
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
    confirmationResolver.current?.(false);
    setConfirmation(options);
    return new Promise((resolve)=>{confirmationResolver.current=resolve;});
  };
  const closeConfirmation=(confirmed:boolean):void=>{
    const resolve=confirmationResolver.current;
    confirmationResolver.current=null;setConfirmation(undefined);resolve?.(confirmed);
  };
  useEffect(()=>()=>confirmationResolver.current?.(false),[]);
  useEffect(()=>{if(tablet)setNavCollapsed(true);},[tablet]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>evaluateCompatibilityTimeout(now),[evaluateCompatibilityTimeout,now]);
  const receiveMetadata=store.mqttReceiveMetadata;
  const stateAge=getLocalMessageAgeMs(receiveMetadata.lastStateReceiveTime,now);
  const visualizationAge=getLocalMessageAgeMs(receiveMetadata.lastVisualizationReceiveTime,now);
  const stateFresh=isLocalMessageFresh(
    receiveMetadata.lastStateReceiveTime,store.orderSettings.stateStaleTimeoutMs,now);
  const visualizationFresh=isLocalMessageFresh(
    receiveMetadata.lastVisualizationReceiveTime,store.orderSettings.stateStaleTimeoutMs,now);
  const stale=!stateFresh;
  const connectionOnline=store.connection?.connectionState?.toUpperCase()==='ONLINE';
  const activeMapResolution=resolveActiveNavigatorMap({
    stateMapId:stateFresh?store.stateMapId:null,
    visualizationMapId:visualizationFresh?store.visualizationMapId:null,
    lastKnownValidMapId:store.lastKnownValidNavigatorMapId,
    confirmedBinding:store.confirmedMapBinding,
    manufacturer:store.orderSettings.manufacturer,
    serialNumber:store.orderSettings.serialNumber,
  });
  const poseSnapshot=selectCurrentRobotPose({
    state:store.state,visualization:store.visualization,
    lastStateReceiveTime:receiveMetadata.lastStateReceiveTime??undefined,
    lastVisualizationReceiveTime:receiveMetadata.lastVisualizationReceiveTime??undefined,
    stateFresh,visualizationFresh,activeMapResolution,
  });
  const navigatorMapId=activeMapResolution.mapId;
  const activeMapId=navigatorMapId??'—';
  const locatorComparison=compareMapIds(locator.loadedMap?.mapName,navigatorMapId);
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
  const generationPrerequisites=():OrderGenerationPrerequisites=>({
    mqttConnected:store.mqttConnected,connectionOnline,operatingMode:store.state?.operatingMode,
    stateAgeMs:stateAge,maximumStateAgeMs:store.orderSettings.stateStaleTimeoutMs,
    lastStateReceiveTime:receiveMetadata.lastStateReceiveTime,
    positionInitialized:store.state?.agvPosition?.positionInitialized===true,
    pose:poseSnapshot,activeMapId:navigatorMapId,activeMapSource:activeMapResolution.source,
    stateMapId:store.stateMapId,visualizationMapId:store.visualizationMapId,
    lastKnownValidNavigatorMapId:store.lastKnownValidNavigatorMapId,
    confirmedMapBinding:store.confirmedMapBinding,
    loadedLocatorMapName:locator.loadedMap?.mapName,
  });
  const validationContext=():OrderValidationContext=>({
    mqttConnected:store.mqttConnected,stateReceived:receiveMetadata.lastStateReceiveTime!==null,
    connectionReceived:Boolean(store.lastConnectionReceiveTime),connectionOnline,
    operatingMode:store.state?.operatingMode,stateAgeMs:stateAge,visualizationAgeMs:visualizationAge,
    positionInitialized:store.state?.agvPosition?.positionInitialized===true,poseSource:poseSnapshot?.source,
    activeMapId:navigatorMapId,currentPose:poseSnapshot?.pose,grid:store.grid,footprint:store.footprint,
    settings:store.orderSettings,locatorMapName:locator.loadedMap?.mapName,
    mapIdSource:activeMapResolution.source,lastStateReceiveTime:receiveMetadata.lastStateReceiveTime,
    corridorSettings:store.plannerOptions.corridor,
  });
  const firstNodeDiagnostics=getFirstNodeDiagnostics(store.generatedOrder,validationContext());
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
    const inflated=ObstacleInflation.byRadius(grid,
      store.plannerOptions.passageSafety.planningSafetyMarginM+
      store.plannerOptions.passageSafety.localizationMarginM);
    store.set({grid,inflatedGrid:inflated,rawPath:[],finalPath:[],generatedOrder:undefined,validation:undefined});
    LogService.write('planner','info',`Loaded ${grid.metadata.name}: ${grid.metadata.width}×${grid.metadata.height} at ${grid.metadata.resolution} m/cell`);
  };
  useStartupConnections(loadGrid);
  const setCell=(cell:{row:number;column:number}):void=>{
    if(!store.grid)return; const transform=new CoordinateTransformer(store.grid.metadata);const pose=transform.gridToWorld(cell.row,cell.column);
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
  const calculatePath=async(startOverride?:RobotPose,goalOverride?:RobotPose):Promise<PathPoint[]|undefined>=>{
    const selected=useAppStore.getState();
    const revision=selected.routeRevision;
    const routeStart=startOverride??selected.start;
    const routeGoal=goalOverride??selected.goal;
    if(!selected.grid||!routeStart||!routeGoal){LogService.write('planner','error','Load a map and set start and goal first.');return;}
    if(selected.plannerMode==='manual'){
      const finalPath:PathPoint[]=[routeStart,...selected.waypoints,routeGoal];
      const valid=new PathCollisionValidator().pathIsFree(selected.grid,finalPath,selected.footprint,selected.plannerOptions.collisionSampleInterval);
      const plannerResult:PlannerResult={success:valid,error:valid?undefined:'Manual path intersects obstacles.',
        rawPath:finalPath,simplifiedPath:finalPath,finalPath,statistics:{visitedCells:0,durationMs:0,rawPointCount:finalPath.length,
          simplifiedPointCount:finalPath.length,finalPointCount:finalPath.length}};
      const accepted=selected.commitPlannedRoute(revision,{start:routeStart,rawPath:finalPath,finalPath,
        plannerResult,planningConfiguration:planningCoordinator.createSnapshot(selected)});
      return accepted&&valid?finalPath:undefined;
    }
    if(!selected.beginPlanning(revision))return undefined;
    selected.set({rawPath:[],finalPath:[],plannerResult:undefined,
      plannedRouteRevision:undefined,generatedOrder:undefined,generatedOrderRouteRevision:undefined,
      validation:undefined,corridorDiagnostics:[],planningConfiguration:undefined});
    try{
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
        LogService.write('planner','error',failedStage?.reason??result.error??'RAW_PATH_FAILED');
        return undefined;
      }
      LogService.write('planner','info',`Path planned: ${result.rawPath.length} raw cells → ${result.simplifiedPath.length} geometry points → ${result.finalPath.length} final points in ${result.statistics.durationMs.toFixed(1)} ms`);
      return result.finalPath;
    }catch(error){
      LogService.write('planner','error',String(error));return undefined;
    }finally{
      selected.finishPlanning(revision);
    }
  };
  const plan=async():Promise<void>=>{await calculatePath();};
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
    const readiness=getOrderGenerationIssues(generationPrerequisites());
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
        stateAgeMs:stateAge,stateStaleTimeoutMs:live.orderSettings.stateStaleTimeoutMs,
        activeNavigatorMapId:navigatorMapId,mapIdSource:activeMapResolution.source,
        loadedLocatorMap:locator.loadedMap?.mapName??null,
      }}});
      readiness.forEach((issue)=>LogService.write('validation',issue.severity==='error'?'error':'warning',issue.message));return undefined;
    }
    if(!live.grid||!poseSnapshot||path.length<1)return undefined;
    try{
      const corridorDiagnostics:import('./domain/planner/EdgeCorridorPlanner').CorridorDiagnostic[]=[];
      const order=new VdaOrderBuilder().build(path,{
        robotPose:poseSnapshot.pose,activeMapId:navigatorMapId!,
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
      const validation=new VdaOrderValidator().validate(order,validationContext());
      if(order.nodes.length>operatorSettings.maximumVdaNodeCount){
        validation.errors.push({code:'nodes.maximum',
          message:`Order contains ${order.nodes.length} nodes; configured maximum is ${operatorSettings.maximumVdaNodeCount}.`,
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
  const corridorSettingsSignature=JSON.stringify(store.plannerOptions.corridor);
  useEffect(()=>{
    if(!store.sentOrder&&store.finalPath.length>=1&&store.grid&&poseSnapshot&&navigatorMapId)
      buildOrder(store.finalPath);
    // Rebuild the unsent Order whenever geometry, corridor policy, or the
    // single MissionMaximumSpeedMps source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[corridorSettingsSignature,store.footprint.width,store.footprint.length,
    store.footprint.safetyMargin,store.orderSettings.missionMaximumSpeedMps]);
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
    const readiness=getOrderGenerationIssues(generationPrerequisites());
    const readinessErrors=readiness.filter((issue)=>issue.severity==='error');
    const readinessWarnings=readiness.filter((issue)=>issue.severity==='warning');
    if(readinessErrors.length){store.set({validation:{valid:false,errors:readinessErrors,warnings:readinessWarnings,context:{
      stateAgeMs:stateAge,stateStaleTimeoutMs:store.orderSettings.stateStaleTimeoutMs,
      activeNavigatorMapId:navigatorMapId,mapIdSource:activeMapResolution.source,
      loadedLocatorMap:locator.loadedMap?.mapName??null,
    }}});return;}
    if(!poseSnapshot)return;
    const path=await calculatePath(poseSnapshot.pose);
    if(path)buildOrder(path);
  };
  const publish=async(orderOverride?:VdaOrder,skipConfirmation=false,
    expectedRevision?:number):Promise<void>=>{
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
    const currentValidation=new VdaOrderValidator().validate(order,validationContext());
    const dispatchIssues=getDispatchIssues({
      mqttConnected:live.mqttConnected,robotOnline:connectionOnline,stateFresh,
      poseValid:Boolean(poseSnapshot),mapMatches:Boolean(locator.loadedMap&&locatorComparison.matches),
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
    if(!skipConfirmation&&!await requestConfirmation({
      title:'Start mission?',
      message:`${publishWarning}\n\nTopic: ${live.mqttSettings.topics.order}\nOrder: ${order.orderId}\nMaximum speed: ${live.orderSettings.missionMaximumSpeedMps} m/s`,
      confirmLabel:'Send Mission',
    }))return;
    const current=useAppStore.getState();
    if(!isCurrentRouteOrder(current,order,revision)){
      setToast({severity:'warning',message:'Publication cancelled because the selected route changed.'});
      return;
    }
    setRoutePhase('Dispatching');current.set({publishingOrder:true});
    try{await mqttService.publish(current.mqttSettings.topics.order,JSON.stringify(order),current.mqttSettings.qos,false);
      current.set({sentOrder:order,sentOrderPublishedAtMs:Date.now(),publishingOrder:false});
      stage5BRecording.order(order,revision,true);
      missionController.markPublished(appSessionId);
      setRoutePhase('Dispatching');setToast({severity:'success',message:'Order sent. Waiting for Navigator acceptance.'});
      LogService.write('mqtt','info',`Published Order ${order.orderId}; awaiting Navigator acceptance.`);
    }catch(error){current.set({publishingOrder:false});
      stage5BRecording.observe(order.orderId,'failed',`Order publication failed: ${String(error)}`,
        poseSnapshot?.pose ? { agvPosition: poseSnapshot.pose } : undefined);
      setRoutePhase('Failed');setToast({severity:'error',message:'Unable to dispatch the mission.'});LogService.write('mqtt','error',String(error));}
  };
  const beginDirectDispatch=async(order:VdaOrder,revision:number):Promise<void>=>{
    const token=++dispatchToken.current;
    for(let remaining=operatorSettings.dispatchCountdownSeconds;remaining>0;remaining-=1){
      if(token!==dispatchToken.current)return;
      const live=useAppStore.getState();
      if(!isCurrentRouteOrder(live,order,revision))return;
      if(!live.mqttConnected||!isLocalMessageFresh(
        live.mqttReceiveMetadata.lastStateReceiveTime,live.orderSettings.stateStaleTimeoutMs)){
        setDispatchCountdown(null);setToast({severity:'warning',message:'Automatic dispatch cancelled because robot data is not ready.'});return;
      }
      setDispatchCountdown(remaining);
      await new Promise((resolve)=>setTimeout(resolve,1_000));
    }
    if(token===dispatchToken.current){setDispatchCountdown(null);await publish(order,true,revision);}
  };
  const prepareDestination=async(goal:RobotPose,explicitTheta=false):Promise<void>=>{
    dispatchToken.current+=1;setDispatchCountdown(null);
    const preparationToken=routePreparationGuard.current.begin();
    const setCurrentRoutePhase=(phase:string):void=>{
      if(routePreparationGuard.current.isCurrent(preparationToken))setRoutePhase(phase);
    };
    const live=useAppStore.getState();const grid=live.grid;
    if(!grid||!poseSnapshot){setCurrentRoutePhase('Failed: ROUTE_NOT_READY');setToast({severity:'error',message:'A loaded map and fresh robot pose are required.'});return;}
    const collisionGrid=live.inflatedGrid??grid;
    const destination=validateDestination(goal,navigatorMapId,grid,collisionGrid);
    if(!destination.valid||!destination.cell){
      setCurrentRoutePhase('Failed: INVALID_DESTINATION');
      setToast({severity:'error',message:destination.message??'Destination is not navigable.'});return;
    }
    const cell=destination.cell;
    live.set({goal,goalThetaExplicit:explicitTheta,selectedCell:cell,rawPath:[],finalPath:[],
      generatedOrder:undefined,validation:undefined});
    const revision=useAppStore.getState().routeRevision;
    missionController.createMission(appSessionId,crypto.randomUUID());
    setCurrentRoutePhase('Validating destination');
    setCurrentRoutePhase('Calculating route');
    const path=await calculatePath(poseSnapshot.pose,goal);
    if(!routePreparationGuard.current.isCurrent(preparationToken))return;
    if(useAppStore.getState().routeRevision!==revision){
      setCurrentRoutePhase('Selection changed');
      return;
    }
    if(!path){
      const planner=useAppStore.getState().plannerResult;
      const rejected=[...(planner?.diagnostics?.stages??[])].reverse()
        .find((item)=>item.severity!=='info');
      const code=planner?.diagnostics?.physicalFailureCode??
        rejected?.code??'NO_PHYSICALLY_VALID_ROUTE';
      const reason=rejected?.reason??planner?.error??
        'No route satisfies the configured map, vehicle footprint, and margins.';
      setCurrentRoutePhase(`Failed: ${code}`);
      setToast({severity:'error',message:`${code}: ${reason}`});
      return;
    }
    setCurrentRoutePhase('Simplifying route');
    setCurrentRoutePhase('Generating order');
    const order=buildOrder(path,explicitTheta?goal.theta:undefined,revision);
    const result=useAppStore.getState().validation;
    if(!order||!result?.valid){
      const reason=result?.errors[0]?.message??
        'Generated Order did not pass validation.';
      setCurrentRoutePhase('Failed: ORDER_VALIDATION_FAILED');
      setToast({severity:'error',message:`ORDER_VALIDATION_FAILED: ${reason}`});
      return;
    }
    setCurrentRoutePhase('Ready to start');setToast({severity:'success',message:'Route calculated. Order validated and ready.'});
    if(operatorSettings.directDispatchMode)void beginDirectDispatch(order,revision);
  };
  const prepareDestinationCell=(cell:{row:number;column:number}):void=>{
    const live=useAppStore.getState();if(!live.grid)return;
    const point=new CoordinateTransformer(live.grid.metadata).gridToWorld(cell.row,cell.column);
    void prepareDestination({...point,theta:live.goal?.theta??poseSnapshot?.pose.theta??0,
      mapId:navigatorMapId??'',positionInitialized:true},false);
  };
  const clearDestination=async(confirm=true):Promise<void>=>{
    const live=useAppStore.getState();
    if(confirm&&(live.sentOrder||live.generatedOrder)&&!await requestConfirmation({
      title:'Clear destination?',
      message:'Clear the active destination and route preview?',
      confirmLabel:'Clear Destination',destructive:true,
    }))return;
    dispatchToken.current+=1;routePreparationGuard.current.cancel();
    setDispatchCountdown(null);setRoutePhase('Selecting destination');
    live.set({goal:undefined,rawPath:[],finalPath:[],generatedOrder:undefined,validation:undefined,
      plannerResult:undefined,selectedCell:undefined});
  };
  useEffect(()=>{
    const onKey=(event:KeyboardEvent):void=>{
      if(event.key!=='Escape')return;
      dispatchToken.current+=1;routePreparationGuard.current.cancel();
      setDispatchCountdown(null);setRoutePhase('Selecting destination');
      useAppStore.getState().set({goal:undefined,rawPath:[],finalPath:[],generatedOrder:undefined,
        validation:undefined,plannerResult:undefined,selectedCell:undefined});
    };
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
  },[]);
  useEffect(()=>{
    if(!store.mqttConnected||stale){dispatchToken.current+=1;setDispatchCountdown(null);}
  },[store.mqttConnected,stale]);
  useEffect(()=>{
    const navigatorLifecycle = mission.status==='Accepted'?'accepted':mission.status==='Rejected'||mission.status==='Timed out'?'rejected':mission.status==='Driving'?'driving':mission.status==='Completed'?'completed':mission.status==='Cancelled'?'cancelled':undefined;
    if(navigatorLifecycle) missionController.observeNavigator(appSessionId,navigatorLifecycle,{progressPercent:mission.progressPercent});
    if(mission.status==='Accepted')setRoutePhase('Accepted by Navigator');
    else if(mission.status==='Driving')setRoutePhase('Driving');
    else if(mission.status==='Completed')setRoutePhase('Arrived');
    else if(mission.status==='Rejected'||mission.status==='Timed out')setRoutePhase('Failed');
    else if(mission.status==='Cancelled')setRoutePhase('Cancelled');
  },[mission.status,mission.progressPercent]);
  useEffect(()=>{
    const outcome = mission.status==='Completed' ? 'success' : mission.status==='Cancelled' ? 'cancelled'
      : mission.status==='Rejected'||mission.status==='Timed out' ? 'failed' : undefined;
    stage5BRecording.observeActions(store.state);
    if(outcome) stage5BRecording.observe(store.sentOrder?.orderId,outcome,mission.status,store.state);
  },[mission.status,store.sentOrder?.orderId,store.state]);
  useEffect(()=>{ stage5BRecording.routeChanged(store.routeRevision); },[store.routeRevision]);
  const instant=async(action:VdaInstantAction):Promise<void>=>{
    if(!isInstantActionSupported(action)){LogService.write('mqtt','warning',`${action} is disabled because the current ROKIT configuration rejected its blocking type.`);return;}
    if(!store.mqttConnected)return;
    if(!await requestConfirmation({
      title:action==='cancelOrder'?'Cancel active mission?':'Send instant action?',
      message:action==='cancelOrder'
        ?'Send cancelOrder to ROKIT Navigator? The active robot mission will be cancelled.'
        :`Publish ${action} to ${store.mqttSettings.topics.instantActions}?`,
      confirmLabel:action==='cancelOrder'?'Cancel Mission':'Send Action',destructive:action==='cancelOrder',
    }))return;
    const message=new InstantActionBuilder().build(action,store.orderSettings);
    try{await mqttService.publish(store.mqttSettings.topics.instantActions,JSON.stringify(message),store.mqttSettings.qos,false);
      if(action==='cancelOrder')stage5BRecording.cancelRequested(message.actions[0]!.actionId,store.sentOrder?.orderId);
      LogService.write('mqtt','warning',`Published ${action} (${message.actions[0]!.actionId})`);
    }catch(error){LogService.write('mqtt','error',String(error));}
  };
  const importImage=async(file:File):Promise<void>=>{
    try{const image=await imageFileToPixels(file);const metadata=yamlText
      ?metadataFromRosYaml(yamlText,image.width,image.height,file.name.replace(/\.[^.]+$/,''))
      :{name:file.name,mapId:file.name.replace(/\.[^.]+$/,''),width:image.width,height:image.height,resolution:0.05,
        origin:{x:0,y:0,yaw:0},occupiedThreshold:0.65,freeThreshold:0.196,negate:false};
      loadGrid({metadata,data:pixelsToOccupancy(image.pixels,metadata)});
    }catch(error){LogService.write('planner','error',`Map import failed: ${String(error)}`);}
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
  const compatibilityDispatchBlockedReason=!store.generatedOrder
    ?'Generate and validate a route first.'
    :[...dispatchIssues,...getCompatibilitySpecificDispatchIssues(store.state)][0]?.message;
  const activeNavigatorOrderId=getActiveNavigatorOrderId(store.state);
  const runCorridorCompatibilityTest=async(variant:CorridorTestVariant):Promise<void>=>{
    const live=useAppStore.getState();
    const liveCompatibility=useCorridorCompatibilityStore.getState();
    const baseOrder=liveCompatibility.baseOrder??live.generatedOrder;
    if(!baseOrder){
      setToast({severity:'error',message:'Generate and validate a route before starting a compatibility test.'});
      return;
    }
    const order=createCorridorTestOrder(baseOrder,variant);
    const validator=new VdaOrderValidator();
    const context=validationContext();
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
      live.set({validation:currentValidation});
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
  const saveCurrentDestination=():void=>{
    if(!store.goal||!navigatorMapId||!destinationName.trim())return;
    addDestination({
      displayName:destinationName.trim(),mapId:navigatorMapId,x:store.goal.x,y:store.goal.y,
      theta:store.goal.theta,category:destinationCategory,icon:destinationCategory,enabled:true,
    });
    setSaveDestinationOpen(false);setDestinationName('');
    setToast({severity:'success',message:'Destination saved for this map.'});
  };
  const selectSavedDestination=(destination:SavedDestination):void=>{
    void prepareDestination({...destination,mapId:destination.mapId,positionInitialized:true},true);
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
  const nav=['MQTT','Map','Planner','Order','Robot State','Global Replanning',
    'Logs','Diagnostics','Settings'];
  return <Box sx={{display:'flex',height:'100vh',bgcolor:'background.default',overflow:'hidden'}}>
    <StartupOverlay/>
    <AppBar position="fixed" elevation={0} sx={{zIndex:(t)=>t.zIndex.drawer+1,
      background:'linear-gradient(100deg,#ffffff,#faf4f5)',color:'text.primary',
      borderBottom:'2px solid',borderColor:'primary.main',backdropFilter:'blur(18px)'}}>
      <Toolbar sx={{gap:1.2,minHeight:'64px!important',px:2}}>
        <MedRobotsLogo compact={tablet}/>
        <Box sx={{mr:1,minWidth:tablet?0:225}}>
          <Typography variant="h3" noWrap>Med Robots Navigation Control</Typography>
          {!tablet&&<Typography variant="caption" color="text.secondary">PharmaRobot Autonomous Navigation</Typography>}
        </Box>
        <StatusPill label={store.mqttConnected?'Connected':'Disconnected'} tone={store.mqttConnected?'connected':'error'} pulse={store.mqttConnected}/>
        <StatusPill label={`Locator ${locator.sessionState==='logged-in'?'Connected':locator.connectionState}`}
          tone={locator.sessionState==='logged-in'?'connected':locator.connectionState==='error'?'error':'warning'}/>
        <StatusPill label={connectionOnline?'Robot online':'Robot offline'} tone={connectionOnline?'connected':'error'}/>
        {!tablet&&<><StatusPill label={activeMapId==='—'?'No active map':activeMapId} tone={navigatorMapId?'info':'warning'}/>
          <StatusPill label={store.state?.operatingMode??'Unknown mode'}
            tone={store.state?.operatingMode==='AUTOMATIC'?'connected':'warning'}/></>}
        <StatusPill label={`E-stop ${store.state?.safetyState?.eStop??'unknown'}`}
          tone={store.state?.safetyState?.eStop==='NONE'?'connected':'error'}/>
        <StatusPill label={`${store.currentRokitErrors.length} errors`}
          tone={store.currentRokitErrors.length?'error':'inactive'}/>
        <Box sx={{flex:1}}/>
        {tablet&&<Tooltip title="Mission panel"><IconButton color="primary" onClick={()=>setMissionPanelOpen(true)}><AltRoute/></IconButton></Tooltip>}
        <Tooltip title="Med Robots operator session"><IconButton color="inherit"><AccountCircle/></IconButton></Tooltip>
        <Tooltip title="Settings"><IconButton color="inherit" onClick={()=>setSettingsOpen(true)}><Settings/></IconButton></Tooltip>
      </Toolbar>
      <Alert severity="error" icon={<StopCircle/>} sx={{py:0,minHeight:30,borderRadius:0,fontWeight:700,
        '& .MuiAlert-message':{py:.25}}}>{safety}</Alert>
    </AppBar>
    <Drawer variant="permanent" sx={{width:drawerWidth,flexShrink:0,transition:'width .22s ease',
      '& .MuiDrawer-paper':{width:drawerWidth,mt:'94px',mb:`${diagnosticsHeight}px`,boxSizing:'border-box',
        bgcolor:'rgba(255,255,255,.98)',borderRight:'1px solid',borderColor:'divider',transition:'width .22s ease'}}}>
      <Box sx={{display:'flex',justifyContent:navCollapsed?'center':'flex-end',p:.5}}>
        <IconButton size="small" onClick={()=>setNavCollapsed((value)=>!value)}>
          {navCollapsed?<ChevronRight/>:<ChevronLeft/>}
        </IconButton>
      </Box>
      <List dense>{nav.map((label,index)=><Tooltip key={label} title={navCollapsed?label:''} placement="right"><ListItemButton selected={label==='Planner'} onClick={()=>{
        if(label==='Settings')setSettingsOpen(true);if(label==='Map')setLocatorOpen(true);
        if(label==='Global Replanning')setGlobalReplanningOpen(true);
        if(label==='Diagnostics')setDiagnosticsOpen(true);
      }} sx={{mx:.75,my:.25,borderRadius:2,minHeight:44,justifyContent:navCollapsed?'center':'initial'}}>
        <ListItemIcon sx={{minWidth:navCollapsed?0:44,justifyContent:'center'}}>{[
          <Cloud/>,<Map/>,<AltRoute/>,<Timeline/>,<BugReport/>,<Autorenew/>,
          <EditRoad/>,<BugReport/>,<Settings/>][index]}</ListItemIcon>
        {!navCollapsed&&<ListItemText primary={label}/>}
      </ListItemButton></Tooltip>)}</List><Divider/>
      {!navCollapsed&&<Box sx={{p:1.5}}><Typography variant="overline">Operator workflow</Typography>
        <Alert severity="info" sx={{my:1}}>Click a free point on the map to calculate and validate a mission automatically.</Alert>
        <Typography variant="overline">Advanced click mode</Typography>
        <Select fullWidth size="small" value={mode} onChange={(e)=>setMode(e.target.value as ClickMode)}>
          {['goal','start','waypoint','obstacle','erase','inspect'].map((m)=><MenuItem value={m} key={m}>{m}</MenuItem>)}
        </Select>
        <Stack gap={1} mt={2}>
          <Button size="small" variant="contained" startIcon={<Map/>} onClick={()=>setLocatorOpen(true)}>Locator Server</Button>
          {!locator.loadedMap&&<Alert severity="info" sx={{fontSize:11}}>No Locator map loaded</Alert>}
          <Button size="small" startIcon={<Upload/>} onClick={()=>yamlInput.current?.click()}>Import YAML</Button>
          <Button size="small" startIcon={<Upload/>} onClick={()=>imageInput.current?.click()}>Import image/PGM</Button>
          <Button size="small" startIcon={<Upload/>} onClick={()=>jsonInput.current?.click()}>Import grid JSON</Button>
          <input hidden ref={yamlInput} type="file" accept=".yaml,.yml" onChange={(e)=>{const f=e.target.files?.[0];if(f)void f.text().then(setYamlText);}}/>
          <input hidden ref={imageInput} type="file" accept=".pgm,.png,.jpg,.jpeg" onChange={(e)=>{const f=e.target.files?.[0];if(f)void importImage(f);}}/>
          <input hidden ref={jsonInput} type="file" accept=".json" onChange={(e)=>{const f=e.target.files?.[0];if(f)void f.text().then((t)=>loadGrid(parseOccupancyJson(t))).catch((err)=>LogService.write('planner','error',String(err)));}}/>
        </Stack>
      </Box>}
    </Drawer>
    <Box component="main" sx={{ml:`${drawerWidth}px`,mr:tablet?0:`${rightWidth}px`,mt:'94px',
      mb:`${diagnosticsHeight}px`,flex:1,position:'relative',transition:'margin .22s ease'}}>
      <Paper className="mr-glass" square sx={{height:54,display:'flex',alignItems:'center',px:1.5,gap:1,borderRadius:0}}>
        <Select size="small" value={store.plannerMode} onChange={(e)=>store.set({plannerMode:e.target.value as typeof store.plannerMode})}>
          <MenuItem value="automatic">Automatic</MenuItem><MenuItem value="manual">Manual</MenuItem><MenuItem value="hybrid">Hybrid</MenuItem><MenuItem value="motion-state">Motion state (experimental)</MenuItem>
        </Select>
        <Chip color={routePhase==='Ready to start'?'success':
          routePhase.startsWith('Failed')?'error':'primary'} label={routePhase}/>
        <Button variant="outlined" startIcon={<AltRoute/>} disabled={store.planning} onClick={()=>void plan()}>{store.planning?'Planning…':'Recalculate'}</Button>
        <Button startIcon={<Refresh/>} onClick={()=>{
          planningCoordinator.invalidate();store.invalidateRoute();
        }}>Clear path</Button>
        <Tooltip title="Grid"><IconButton color={store.showGrid?'primary':'default'} onClick={()=>store.set({showGrid:!store.showGrid})}><GridOn/></IconButton></Tooltip>
        <Tooltip title="Inflated obstacles"><IconButton color={store.showInflation?'warning':'default'} onClick={()=>store.set({showInflation:!store.showInflation})}><BugReport/></IconButton></Tooltip>
        <Tooltip title="Rotate view"><IconButton onClick={()=>store.set({viewRotation:normalizeAngle(store.viewRotation+Math.PI/2)})}><RotateRight/></IconButton></Tooltip>
        <Box sx={{flex:1}}/><Typography variant="caption">{store.grid?`${store.grid.metadata.width}×${store.grid.metadata.height} · ${store.grid.metadata.resolution} m/cell`:'No map loaded'}</Typography>
      </Paper>
      <MapCanvas mode={mode} onCell={setCell} liveRobotPose={poseSnapshot?.pose}/>
      {locator.downloading&&<Box className="mr-map-loading" sx={{position:'absolute',inset:'54px 0 0',
        display:'grid',placeItems:'center',bgcolor:'rgba(255,255,255,.82)',zIndex:4}}>
        <Typography variant="h2">Loading hospital map…</Typography>
      </Box>}
    </Box>
    <Drawer anchor="right" variant={tablet?'temporary':'permanent'} open={!tablet||missionPanelOpen}
      onClose={()=>setMissionPanelOpen(false)}
      sx={{width:rightWidth,'& .MuiDrawer-paper':{width:rightWidth,mt:tablet?0:'94px',
        mb:tablet?0:`${diagnosticsHeight}px`,p:1.5,overflowY:'auto',
        bgcolor:'rgba(255,255,255,.98)',borderLeft:'1px solid',borderColor:'divider'}}}>
      <Paper className="mr-glass mr-route-ready" sx={{p:1.5,mb:1.5}}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box><Typography variant="overline">Mission control</Typography>
            <Typography variant="h2">{routePhase}</Typography></Box>
          <StatusPill label={store.state?.driving?'Driving':store.state?.paused?'Paused':'Idle'}
            tone={store.state?.driving?'connected':store.state?.paused?'warning':'inactive'}/>
        </Stack>
        <Alert severity={store.stage5BRecordingStatus?.includes('failed')?'warning':'info'} sx={{mt:1}}>
          {store.stage5BRecordingStatus??'Stage 5B: automatic recording for motion-state runs.'}
          {' '}Pending recordings: {store.stage5BPendingCount??0}
        </Alert>
        <Divider sx={{my:1.2}}/>
        <Field label="Destination" value={store.goal?`${store.goal.x.toFixed(2)}, ${store.goal.y.toFixed(2)} m`:'Select on map'}/>
        <Field label="Route distance" value={routeDistance?`${routeDistance.toFixed(2)} m`:'—'}/>
        <Field label="Estimated duration" value={estimatedDurationSeconds?`${Math.ceil(estimatedDurationSeconds)} s`:'—'}/>
        <Field label="Order" value={store.generatedOrder?.orderId??'—'}/>
        <Field label="Battery" value={store.state?.batteryState?.batteryCharge===undefined?'—':`${store.state.batteryState.batteryCharge}%`}/>
        <Field label="Current speed" value={`${Math.hypot(store.state?.velocity?.vx??0,store.state?.velocity?.vy??0).toFixed(2)} m/s`}/>
        <Field label="Emergency state" value={store.state?.safetyState?.eStop??'unknown'}/>
        {store.generatedOrder&&<Paper variant="outlined" sx={{p:1,mt:1}}>
          <Typography variant="overline">Obstacle bypass corridor</Typography>
          <Field label="Edges with corridor" value={corridorSummary.withCorridor}/>
          <Field label="Edges without corridor" value={corridorSummary.withoutCorridor}/>
          <Field label="Left width min / max" value={corridorSummary.minimumLeft===undefined?'N/A':
            `${corridorSummary.minimumLeft.toFixed(3)} / ${corridorSummary.maximumLeft!.toFixed(3)} m`}/>
          <Field label="Right width min / max" value={corridorSummary.minimumRight===undefined?'N/A':
            `${corridorSummary.minimumRight.toFixed(3)} / ${corridorSummary.maximumRight!.toFixed(3)} m`}/>
        </Paper>}
        {store.generatedOrder&&store.plannerOptions.corridor.enableBoschRokitCorridorExtension&&
          corridorSummary.withCorridor===0&&<Alert severity="warning" sx={{mt:1}}>
            Obstacle avoidance is enabled in ROKIT Navigator, but the generated Order contains no bypass corridor information.
          </Alert>}
        {store.generatedOrder&&corridorSummary.withCorridor>0&&corridorSummary.withoutCorridor>0&&
          <Alert severity="warning" sx={{mt:1}}>Bypass is permitted only on some route segments.</Alert>}
        {dispatchCountdown!==null&&<Alert severity="warning" sx={{mt:1}}>
          Direct dispatch in {dispatchCountdown}s. <Button size="small" onClick={()=>{
            dispatchToken.current+=1;setDispatchCountdown(null);setRoutePhase('Ready to start');
          }}>Cancel</Button>
        </Alert>}
        {dispatchIssues.length>0&&store.generatedOrder&&<Alert severity="warning" sx={{mt:1}}>{dispatchIssues[0]?.message}</Alert>}
        <Button fullWidth size="large" variant="contained" color="success" startIcon={<PlayArrow/>}
          disabled={!store.generatedOrder||dispatchIssues.length>0||dispatchCountdown!==null||
            store.publishingOrder||store.sentOrder?.orderId===store.generatedOrder?.orderId||
            activeNavigatorOrderId===store.generatedOrder?.orderId}
          onClick={()=>void publish() } sx={{mt:1.5,minHeight:52}}>
          {activeNavigatorOrderId&&store.generatedOrder&&activeNavigatorOrderId!==store.generatedOrder.orderId
            ?'Cancel Active Mission First':store.publishingOrder?'Publishing…':'Start Mission'}
        </Button>
        <Stack direction="row" gap={1} mt={1}>
          <Button fullWidth variant="outlined" onClick={()=>void clearDestination()}>Clear Destination</Button>
          <Button fullWidth color="error" variant="outlined"
            disabled={!store.sentOrder&&!activeNavigatorOrderId}
            onClick={()=>void instant('cancelOrder')}>Cancel Mission</Button>
        </Stack>
      </Paper>
      <QuickDestinations mapId={navigatorMapId} currentGoal={store.goal}
        onSelect={selectSavedDestination} onSaveGoal={()=>setSaveDestinationOpen(true)}/>
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
        <Field label="Robot x / y" value={store.start?`${store.start.x.toFixed(3)} / ${store.start.y.toFixed(3)}`:undefined}/>
        <Field label="Robot θ" value={store.start?`${store.start.theta.toFixed(3)} rad / ${radiansToDegrees(store.start.theta).toFixed(1)}°`:undefined}/>
        <Field label="Goal x / y" value={store.goal?`${store.goal.x.toFixed(3)} / ${store.goal.y.toFixed(3)}`:undefined}/>
        <TextField fullWidth size="small" label="Goal theta (rad)" type="number" value={store.goal?.theta??0}
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
            label={store.plannerResult?.rawPath.length?'RAW_PATH_FOUND':'RAW_PATH_FAILED'}/>
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
         <Button fullWidth sx={{mt:1}} variant="outlined" onClick={generate} disabled={store.finalPath.length<2}>Generate & validate VDA order</Button>
         <Button fullWidth sx={{mt:.5}} variant="outlined" color="warning" onClick={()=>void rebuildFromCurrentPose()}>
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
          <Button size="small" onClick={()=>stage5BRecording.finalizePending('success',store.state)}>Finalize success</Button>
          <Button size="small" onClick={()=>stage5BRecording.finalizePending('failed',store.state)}>Finalize failed</Button>
          <Button size="small" onClick={()=>stage5BRecording.finalizePending('cancelled',store.state)}>Finalize cancelled</Button>
          <Button size="small" onClick={()=>stage5BRecording.retry()}>Retry save</Button>
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
          :`${store.validation.errors.length} errors`}
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
            <IconButton size="small" onClick={()=>store.set({waypoints:store.waypoints.filter((x)=>x.id!==w.id)})}><Delete/></IconButton></Stack>
          <Stack direction="row" alignItems="center" gap={.5} mt={.5}>
            <TextField size="small" label="θ rad" type="number" value={w.theta} onChange={(e)=>{const a=[...store.waypoints];a[i]={...w,theta:normalizeAngle(Number(e.target.value))};store.set({waypoints:a});}}/>
            <TextField size="small" label="dev m" type="number" value={w.deviationXy} onChange={(e)=>{const a=[...store.waypoints];a[i]={...w,deviationXy:Number(e.target.value)};store.set({waypoints:a});}}/>
            <FormControlLabel control={<Switch size="small" checked={w.orientationLocked} onChange={(e)=>{const a=[...store.waypoints];a[i]={...w,orientationLocked:e.target.checked};store.set({waypoints:a});}}/>} label="Lock"/>
            <Button disabled={i===0} onClick={()=>{const a=[...store.waypoints];[a[i-1],a[i]]=[a[i]!,a[i-1]!];store.set({waypoints:a});}}>↑</Button>
            <Button disabled={i===store.waypoints.length-1} onClick={()=>{const a=[...store.waypoints];[a[i],a[i+1]]=[a[i+1]!,a[i]!];store.set({waypoints:a});}}>↓</Button>
          </Stack>
        </Paper>)}
      </Box>}
      </Box>
      {store.sentOrder&&<Paper variant="outlined" sx={{p:1,mt:1}}><Typography variant="overline">Mission</Typography>
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
    </Drawer>
    <Paper className="mr-glass" square sx={{position:'fixed',bottom:0,left:drawerWidth,right:0,
      height:diagnosticsHeight,zIndex:1201,borderTop:'1px solid',borderColor:'divider',
      transition:'height .22s ease,left .22s ease'}}>
      <Stack direction="row" alignItems="center" sx={{height:48,px:1}}>
        <IconButton onClick={()=>setDiagnosticsOpen((value)=>!value)}>
          {diagnosticsOpen?<ExpandMore/>:<ExpandLess/>}
        </IconButton>
        <Typography variant="overline" sx={{mr:1}}>Diagnostics</Typography>
        {diagnosticsOpen&&<Tabs value={bottom} onChange={(_,value:number)=>setBottom(value)} variant="scrollable"
          sx={{minHeight:44,flex:1,'& .MuiTab-root':{minHeight:44,fontSize:11}}}>
          {['Operational Log','Validation','ROKIT Errors','MQTT State','MQTT Visualization',
            'Generated Order','Locator','Network','Raw JSON'].map((label)=><Tab key={label} label={label}/>)}
        </Tabs>}
        <IconButton onClick={()=>downloadJson('med-robots-diagnostics.json',
          sanitizeDiagnostics({logs:store.logs,diagnostics}))}><Save/></IconButton>
        <Button size="small" startIcon={<Download/>} onClick={() => {
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
          void navigator.clipboard.writeText(JSON.stringify(sanitizeDiagnostics(selected), null, 2));
        }}>Copy</Button>
      </Stack>
      {diagnosticsOpen&&<><Divider/>
        <Stack direction="row" gap={1} px={1.5} py={.7}>
          <TextField size="small" placeholder="Search diagnostics" value={diagnosticSearch}
            onChange={(event)=>setDiagnosticSearch(event.target.value)} sx={{width:260}}/>
          <Select size="small" value={diagnosticSeverity}
            onChange={(event)=>setDiagnosticSeverity(event.target.value as typeof diagnosticSeverity)}>
            <MenuItem value="all">All severities</MenuItem><MenuItem value="info">Info</MenuItem>
            <MenuItem value="warning">Warning</MenuItem><MenuItem value="error">Error</MenuItem>
          </Select>
          <FormControlLabel control={<Switch size="small" checked={pauseLogScroll}
            onChange={(event)=>setPauseLogScroll(event.target.checked)}/>} label="Pause auto-scroll"/>
          <Button onClick={()=>store.set({logs:[]})}>Clear view</Button>
        </Stack>
        <Box sx={{height:205,overflow:'auto',px:1.5,pb:1.5,fontFamily:'monospace',fontSize:12,whiteSpace:'pre-wrap'}}>
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
    <Dialog open={saveDestinationOpen} onClose={()=>setSaveDestinationOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>Save hospital destination</DialogTitle>
      <DialogContent><Stack gap={2} mt={1}>
        <TextField autoFocus label="Display name" value={destinationName}
          onChange={(event)=>setDestinationName(event.target.value)}/>
        <Select value={destinationCategory}
          onChange={(event)=>setDestinationCategory(event.target.value as DestinationCategory)}>
          {['pharmacy','laboratory','reception','ward','charging','delivery','home','other']
            .map((category)=><MenuItem key={category} value={category}>{category}</MenuItem>)}
        </Select>
        <Alert severity="info">This destination is stored only for map {navigatorMapId??'N/A'}.</Alert>
      </Stack></DialogContent>
      <DialogActions><Button onClick={()=>setSaveDestinationOpen(false)}>Cancel</Button>
        <Button variant="contained" disabled={!destinationName.trim()||!store.goal}
          onClick={saveCurrentDestination}>Save destination</Button></DialogActions>
    </Dialog>
    <Dialog open={locatorOpen} onClose={()=>setLocatorOpen(false)} fullWidth maxWidth="md">
      <DialogTitle>ROKIT Locator Server Map</DialogTitle>
      <DialogContent><Stack gap={2} mt={1}>
        <LocatorConnectionPanel/>
        <LocatorMapSelector onMapLoaded={loadGrid}/>
        <LocatorMapStatus/>
      </Stack></DialogContent>
      <DialogActions><Button onClick={()=>setLocatorOpen(false)}>Close</Button></DialogActions>
    </Dialog>
    <SettingsDialog open={settingsOpen} onClose={()=>setSettingsOpen(false)}/>
    <CorridorCompatibilityPanel open={corridorCompatibilityOpen}
      onClose={()=>setCorridorCompatibilityOpen(false)}
      onRun={runCorridorCompatibilityTest}
      dispatchBlockedReason={compatibilityDispatchBlockedReason}/>
    <GlobalReplanningPanel open={globalReplanningOpen}
      onClose={()=>setGlobalReplanningOpen(false)}
      onEnableChange={async(enabled)=>{
        if(!enabled){
          globalReplanning.updateSettings({enabled:false});
          globalReplanning.resetRuntime();
          return;
        }
        const confirmed=await requestConfirmation({
          title:'Enable automatic global replanning?',
          message:'When a blocked route is confirmed, the application may cancel the active Order and publish a new independently planned Order without another prompt.\n\n'+safety,
          confirmLabel:'Enable Automatic Replanning',
        });
        if(confirmed){
          globalReplanning.updateSettings({enabled:true});
          globalReplanning.resetRuntime();
        }
      }}/>
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
    <Snackbar open={Boolean(toast)} autoHideDuration={4500} onClose={()=>setToast(undefined)}
      anchorOrigin={{vertical:'top',horizontal:'center'}}>
      <Alert severity={toast?.severity??'info'} variant="filled" onClose={()=>setToast(undefined)}>
        {toast?.message}
      </Alert>
    </Snackbar>
  </Box>;
}

function SettingsDialog({open,onClose}:{open:boolean;onClose:()=>void}){
  const store=useAppStore();const mqtt=store.mqttSettings;const order=store.orderSettings;const fp=store.footprint;
  const locator=useLocatorStore();const operator=useOperatorSettingsStore();
  const replanning=useGlobalReplanningStore();
  const importInput=useRef<HTMLInputElement>(null);
  const vehicleConfigInput=useRef<HTMLInputElement>(null);
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
        .then(()=>locator.set({sessionState:'logged-out'}))
        .catch((error)=>LogService.write('system','error',String(error)))}>
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
          onChange={(event)=>operator.update({maximumVdaNodeCount:Math.max(2,Number(event.target.value))})}/>
        <TextField label="Destination validation radius m" type="number" value={operator.settings.destinationValidationRadius}
          onChange={(event)=>operator.update({destinationValidationRadius:Number(event.target.value)})}/>
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
          <FormControlLabel control={<Switch checked={replanning.settings.enabled}
            onChange={(event)=>replanning.updateSettings({enabled:event.target.checked})}/>}
            label="Enable optional live-obstacle replanning"/>
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
            onChange={(event)=>{const footprint={...fp,width:Number(event.target.value)};
              store.set({footprint,inflatedGrid:store.grid?ObstacleInflation.byRadius(
                store.grid,store.plannerOptions.passageSafety.planningSafetyMarginM+
                store.plannerOptions.passageSafety.localizationMarginM):undefined});}}/>
          <TextField label="Robot length m" type="number" value={fp.length}
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
          onChange={(event)=>operator.update({previewBeforeDispatch:event.target.checked})}/>} label="Preview before dispatch"/>
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
          value={operator.settings.mapContrast} onChange={(event)=>operator.update({mapContrast:Number(event.target.value)})}/>
        <Select value={operator.settings.language} onChange={(event)=>operator.update({language:event.target.value as 'en'|'pt'})}>
          <MenuItem value="en">English</MenuItem><MenuItem value="pt">Português</MenuItem>
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
        }).catch((error)=>LogService.write('system','error',
          `Bosch ClientMotion configuration import failed: ${String(error)}`));
        event.target.value='';
      }}/>
      <input hidden ref={importInput} type="file" accept=".json" onChange={(e)=>{
      const file=e.target.files?.[0];if(!file)return;void file.text().then((text)=>{
        const value=JSON.parse(text) as {
          mqttSettings?:typeof mqtt;
          orderSettings?:Partial<typeof order>&{maxSpeed?:number;testMaximumSpeed?:number};
          footprint?:typeof fp;plannerOptions?:typeof store.plannerOptions;
        };
        const importedOrder=value.orderSettings;
        const legacyMaxSpeed=importedOrder?.maxSpeed;
        const currentOrderSettings={...importedOrder};
        delete currentOrderSettings.maxSpeed;
        delete currentOrderSettings.testMaximumSpeed;
        store.resetRobotSession();
        store.set({...value,
          mqttSettings:value.mqttSettings?{...mqtt,...value.mqttSettings,password:''}:mqtt,
          orderSettings:importedOrder?{...order,...currentOrderSettings,
            missionMaximumSpeedMps:normalizeMissionMaximumSpeed(
              importedOrder.missionMaximumSpeedMps??legacyMaxSpeed??
              order.missionMaximumSpeedMps),
            stateStaleTimeoutMs:clampStateStaleTimeoutMs(
              importedOrder.stateStaleTimeoutMs??order.stateStaleTimeoutMs)}:order});
      }).catch((error)=>LogService.write('system','error',`Settings import failed: ${String(error)}`));
    }}/><Button onClick={store.resetSettings}>Restore defaults</Button>
      <Button onClick={()=>vehicleConfigInput.current?.click()}>
        Import Bosch ClientMotion
      </Button>
      <Button onClick={()=>importInput.current?.click()}>Import settings</Button>
      <Button onClick={exportSettings}>Export</Button>
      <Button color="error" onClick={()=>{mqttService.disconnect();store.resetRobotSession();}}>Disconnect & reset</Button><Button variant="contained" onClick={connect}>Connect</Button><Button onClick={onClose}>Close</Button></DialogActions>
  </Dialog>;
}
