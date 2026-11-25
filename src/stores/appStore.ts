import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AppLog, GridCell, MqttSettings, OccupancyGrid, OrderSettings, PathPoint, PlannerMode,
  PlannerOptions, PlannerResult, RobotFootprint, RobotPose, ValidationResult, VdaConnection,
  VdaError, VdaOrder, VdaState, VdaVisualization, Waypoint, RokitErrorHistoryEntry,
  MqttReceiveMetadata, ActiveMapResolution, ActiveMapSource, ConfirmedMapBinding,
} from '../domain/types';
import {
  clampStateStaleTimeoutMs, defaultFootprint, defaultMqttSettings, defaultOrderSettings,
  defaultPlannerOptions,
} from '../domain/defaults';
import {
  appendErrorHistory, deduplicateRokitErrors, newlyRaisedRokitErrors,
} from '../domain/robot/RokitErrors';
import { normalizeMapId } from '../domain/robot/ActiveMapResolver';
import type { CorridorDiagnostic } from '../domain/planner/EdgeCorridorPlanner';
import type { SpeedCycleDiagnostic } from '../domain/robot/SpeedLimitDiagnostics';
import type { PlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';

export interface PlannedRouteCommit {
  start: RobotPose;
  rawPath: PathPoint[];
  finalPath: PathPoint[];
  plannerResult: PlannerResult;
  planningConfiguration: PlanningConfigurationSnapshot;
}

export interface AppState {
  stage5BRecordingStatus?: string;
  stage5BPendingCount?: number;
  lastPlanningScenario?: import('../domain/planning/MotionPlannerScenarioArtifact').MotionPlannerScenarioArtifact;
  mqttSettings: MqttSettings; orderSettings: OrderSettings; footprint: RobotFootprint;
  plannerOptions: PlannerOptions; plannerMode: PlannerMode; mqttConnected: boolean;
  connection?: VdaConnection; state?: VdaState; visualization?: VdaVisualization;
  rawStatePayload?:unknown; rawVisualizationPayload?:unknown;
  stateReceivedAt?: string; visualizationReceivedAt?: string; connectionReceivedAt?: string;
  lastConnectionReceiveTime?: number;
  mqttReceiveMetadata: MqttReceiveMetadata;
  stateMapId: string | null; visualizationMapId: string | null;
  lastKnownValidNavigatorMapId: string | null;
  lastKnownValidNavigatorMapSource: Extract<ActiveMapSource, 'state' | 'visualization'> | null;
  activeNavigatorMapId: string | null; activeNavigatorMapSource: ActiveMapSource;
  confirmedMapBinding: ConfirmedMapBinding | null;
  mapBindingMismatchWarning: string | null;
  navigatorIdentityKey: string;
  grid?: OccupancyGrid; inflatedGrid?: OccupancyGrid; start?: RobotPose; goal?: RobotPose;
  goalThetaExplicit: boolean;
  rawPath: PathPoint[]; finalPath: PathPoint[]; waypoints: Waypoint[]; plannerResult?: PlannerResult;
  /** Revision of the route inputs. All derived route data must match this value. */
  routeRevision: number; plannedRouteRevision?: number; generatedOrderRouteRevision?: number;
  planningConfiguration?: PlanningConfigurationSnapshot;
  generatedOrder?: VdaOrder; sentOrder?: VdaOrder; sentOrderPublishedAtMs?: number;
  corridorDiagnostics:CorridorDiagnostic[];
  publishingOrder: boolean;
  validation?: ValidationResult; logs: AppLog[];
  speedCycleDiagnostic?:SpeedCycleDiagnostic;
  currentRokitErrors: VdaError[]; errorHistory: RokitErrorHistoryEntry[];
  selectedCell?: GridCell; planning: boolean; viewRotation: number; showGrid: boolean; showInflation: boolean;
  set: (patch: Partial<AppState>) => void; addLog: (entry: AppLog) => void;
  /** Refreshes the live planning origin without changing destination identity. */
  updateTelemetryStart: (pose: RobotPose | undefined) => void;
  beginPlanning: (revision: number) => boolean;
  finishPlanning: (revision: number) => void;
  invalidateRoute: () => number;
  commitPlannedRoute: (revision: number, route: PlannedRouteCommit) => boolean;
  commitGeneratedOrder: (
    revision: number, order: VdaOrder, validation: ValidationResult,
    corridorDiagnostics: CorridorDiagnostic[],
  ) => boolean;
  receiveRokitErrors: (errors: VdaError[], receivedAt: string, orderId: string) => void;
  recordNavigatorMapId: (
    value: unknown, source: 'state' | 'visualization', manufacturer: string, serialNumber: string,
  ) => void;
  setActiveMapResolution: (resolution: ActiveMapResolution) => void;
  confirmMapBinding: (locatorMapName: string, manufacturer: string, serialNumber: string) => void;
  clearConfirmedMapBinding: () => void;
  setRobotIdentity: (manufacturer: string, serialNumber: string) => void;
  clearErrorHistory: () => void; resetRobotSession: () => void; resetSettings: () => void;
}
const persistedDefaults = {
  mqttSettings: defaultMqttSettings, orderSettings: defaultOrderSettings, footprint: defaultFootprint,
  plannerOptions: defaultPlannerOptions, plannerMode: 'automatic' as PlannerMode,
};
const routeInputKeys: ReadonlySet<keyof AppState> = new Set([
  'grid','inflatedGrid','start','goal','goalThetaExplicit','waypoints',
  'plannerMode','plannerOptions','footprint',
]);

export const useAppStore = create<AppState>()(persist((set, get) => ({
  ...persistedDefaults, mqttConnected:false, rawPath:[],finalPath:[],waypoints:[],logs:[],
  currentRokitErrors:[],errorHistory:[],goalThetaExplicit:false,publishingOrder:false,
  corridorDiagnostics:[],routeRevision:0,
  mqttReceiveMetadata: {
    lastStateReceiveTime: null, lastVisualizationReceiveTime: null,
    statePayloadTimestamp: null, visualizationPayloadTimestamp: null,
  },
  stateMapId:null,visualizationMapId:null,lastKnownValidNavigatorMapId:null,
  lastKnownValidNavigatorMapSource:null,activeNavigatorMapId:null,activeNavigatorMapSource:'none',
  confirmedMapBinding:null,mapBindingMismatchWarning:null,
  navigatorIdentityKey:`${defaultOrderSettings.manufacturer}::${defaultOrderSettings.serialNumber}`,
  planning:false,viewRotation:0,showGrid:true,showInflation:true,
  set: (patch) => set((state) => {
    const routeInputChanged=Object.keys(patch).some((key) => {
      const typed=key as keyof AppState;
      return routeInputKeys.has(typed)&&patch[typed]!==state[typed];
    });
    if(!routeInputChanged)return patch;
    return {
      ...patch,routeRevision:state.routeRevision+1,plannedRouteRevision:undefined,
      generatedOrderRouteRevision:undefined,planningConfiguration:undefined,
      rawPath:[],finalPath:[],plannerResult:undefined,generatedOrder:undefined,
      validation:undefined,corridorDiagnostics:[],planning:false,
    };
  }),
  updateTelemetryStart: (pose) => set({start:pose}),
  beginPlanning: (revision) => {
    if(get().routeRevision!==revision)return false;
    set({planning:true});
    return true;
  },
  finishPlanning: (revision) => set((state) =>
    state.routeRevision===revision&&state.planning?{planning:false}:{}),
  invalidateRoute: () => {
    const revision=get().routeRevision+1;
    set({routeRevision:revision,plannedRouteRevision:undefined,
      generatedOrderRouteRevision:undefined,planningConfiguration:undefined,
      rawPath:[],finalPath:[],plannerResult:undefined,generatedOrder:undefined,
      validation:undefined,corridorDiagnostics:[],planning:false});
    return revision;
  },
  commitPlannedRoute: (revision, route) => {
    if(get().routeRevision!==revision)return false;
    set({
      ...route,plannedRouteRevision:revision,generatedOrderRouteRevision:undefined,
      generatedOrder:undefined,validation:undefined,corridorDiagnostics:[],planning:false,
    });
    return true;
  },
  commitGeneratedOrder: (revision, order, validation, corridorDiagnostics) => {
    const state=get();
    if(state.routeRevision!==revision||state.plannedRouteRevision!==revision)return false;
    set({generatedOrder:order,generatedOrderRouteRevision:revision,validation,corridorDiagnostics});
    return true;
  },
  addLog: (entry) => set((state) => ({logs:[...state.logs.slice(-999),entry]})),
  receiveRokitErrors: (errors, receivedAt, orderId) => set((state) => {
    const currentRokitErrors=deduplicateRokitErrors(errors);
    return {
      currentRokitErrors,
      // Navigator repeats active warnings in every state message. Record the
      // transition into an error, not every telemetry sample containing it.
      errorHistory:appendErrorHistory(
        state.errorHistory,
        newlyRaisedRokitErrors(state.currentRokitErrors,currentRokitErrors),
        receivedAt,orderId),
    };
  }),
  recordNavigatorMapId: (value, source, manufacturer, serialNumber) => set((state) => {
    const mapId = normalizeMapId(value);
    const identityKey = `${manufacturer}::${serialNumber}`;
    const identityChanged = state.navigatorIdentityKey !== identityKey;
    const bindingMapId=normalizeMapId(state.confirmedMapBinding?.locatorMapName);
    const bindingConflict=Boolean(mapId&&bindingMapId&&mapId!==bindingMapId);
    const base = identityChanged ? {
      stateMapId: null, visualizationMapId: null, lastKnownValidNavigatorMapId: null,
      lastKnownValidNavigatorMapSource: null, activeNavigatorMapId: null,
      activeNavigatorMapSource: 'none' as const, confirmedMapBinding: null,
      mapBindingMismatchWarning:null,
    } : {};
    return {
      ...base,
      navigatorIdentityKey: identityKey,
      ...(source === 'state' ? { stateMapId: mapId } : { visualizationMapId: mapId }),
      ...(mapId ? {
        lastKnownValidNavigatorMapId: mapId,
        lastKnownValidNavigatorMapSource: source,
      } : {}),
      ...(bindingConflict ? {
        confirmedMapBinding:null,
        mapBindingMismatchWarning:
          `MQTT mapId "${mapId}" differs from the previous confirmed Locator binding "${bindingMapId}". The manual binding was cleared.`,
      } : {}),
    };
  }),
  setActiveMapResolution: (resolution) => set({
    activeNavigatorMapId: resolution.mapId, activeNavigatorMapSource: resolution.source,
  }),
  confirmMapBinding: (locatorMapName,manufacturer,serialNumber) => set(() => {
    const normalized=normalizeMapId(locatorMapName);
    if(!normalized)throw new Error('A non-empty Locator map name is required.');
    return {
      confirmedMapBinding:{
        manufacturer,serialNumber,locatorMapName:normalized,confirmedAt:new Date().toISOString(),
      },
      mapBindingMismatchWarning:null,
    };
  }),
  clearConfirmedMapBinding: () => set({
    confirmedMapBinding:null,mapBindingMismatchWarning:null,
  }),
  setRobotIdentity: (manufacturer, serialNumber) => set((state) => {
    const navigatorIdentityKey=`${manufacturer}::${serialNumber}`;
    if(navigatorIdentityKey===state.navigatorIdentityKey)return {};
    return {
      navigatorIdentityKey,stateMapId:null,visualizationMapId:null,
      lastKnownValidNavigatorMapId:null,lastKnownValidNavigatorMapSource:null,
      activeNavigatorMapId:null,activeNavigatorMapSource:'none' as const,
      confirmedMapBinding:null,mapBindingMismatchWarning:null,
      state:undefined,visualization:undefined,start:undefined,
      routeRevision:state.routeRevision+1,plannedRouteRevision:undefined,
      generatedOrderRouteRevision:undefined,planningConfiguration:undefined,
      rawPath:[],finalPath:[],plannerResult:undefined,generatedOrder:undefined,
      validation:undefined,corridorDiagnostics:[],planning:false,
      rawStatePayload:undefined,rawVisualizationPayload:undefined,
      speedCycleDiagnostic:undefined,
      stateReceivedAt:undefined,visualizationReceivedAt:undefined,mqttReceiveMetadata:{
        lastStateReceiveTime:null,lastVisualizationReceiveTime:null,
        statePayloadTimestamp:null,visualizationPayloadTimestamp:null,
      },
    };
  }),
  clearErrorHistory: () => set({errorHistory:[]}),
  resetRobotSession: () => set((state) => ({
    connection:undefined,state:undefined,visualization:undefined,stateReceivedAt:undefined,
    rawStatePayload:undefined,rawVisualizationPayload:undefined,
    speedCycleDiagnostic:undefined,
    visualizationReceivedAt:undefined,connectionReceivedAt:undefined,lastConnectionReceiveTime:undefined,
    mqttReceiveMetadata: {
      lastStateReceiveTime:null,lastVisualizationReceiveTime:null,
      statePayloadTimestamp:null,visualizationPayloadTimestamp:null,
    },
    stateMapId:null,visualizationMapId:null,lastKnownValidNavigatorMapId:null,
    lastKnownValidNavigatorMapSource:null,activeNavigatorMapId:null,activeNavigatorMapSource:'none',
    currentRokitErrors:[],start:undefined,
    routeRevision:state.routeRevision+1,plannedRouteRevision:undefined,
    generatedOrderRouteRevision:undefined,planningConfiguration:undefined,
    rawPath:[],finalPath:[],plannerResult:undefined,generatedOrder:undefined,
    validation:undefined,corridorDiagnostics:[],planning:false,
  })),
  resetSettings: () => set((state) => ({
    ...persistedDefaults,
    navigatorIdentityKey:`${defaultOrderSettings.manufacturer}::${defaultOrderSettings.serialNumber}`,
    state:undefined,visualization:undefined,start:undefined,
    rawStatePayload:undefined,rawVisualizationPayload:undefined,
    stateMapId:null,visualizationMapId:null,
    lastKnownValidNavigatorMapId:null,lastKnownValidNavigatorMapSource:null,
    activeNavigatorMapId:null,activeNavigatorMapSource:'none',confirmedMapBinding:null,
    mapBindingMismatchWarning:null,
    routeRevision:state.routeRevision+1,plannedRouteRevision:undefined,
    generatedOrderRouteRevision:undefined,planningConfiguration:undefined,
    rawPath:[],finalPath:[],plannerResult:undefined,generatedOrder:undefined,
    validation:undefined,corridorDiagnostics:[],planning:false,
    mqttReceiveMetadata:{lastStateReceiveTime:null,lastVisualizationReceiveTime:null,
      statePayloadTimestamp:null,visualizationPayloadTimestamp:null},
  })),
}), {
  name:'rokit-path-planner',
  version:5,
  migrate:(persisted,version)=>{
    const saved=persisted as Partial<AppState>&{
      orderSettings?:Partial<AppState['orderSettings']>&{
        maxSpeed?:number;testMaximumSpeed?:number;
      };
    };
    const legacyMissionSpeed=saved.orderSettings?.maxSpeed;
    const migratedOrderSettings=saved.orderSettings?{
      ...saved.orderSettings,
      missionMaximumSpeedMps:Number.isFinite(legacyMissionSpeed)
        ?legacyMissionSpeed:defaultOrderSettings.missionMaximumSpeedMps,
      maxSpeed:undefined,testMaximumSpeed:undefined,
    }:undefined;
    if(version>=3)return {
      ...saved,
      orderSettings:migratedOrderSettings,
    };
    const legacyDefaultFootprint=version<2||
      (saved.footprint?.width===0.75&&saved.footprint?.length===0.86);
    if(!legacyDefaultFootprint)return persisted;
    return {
      ...saved,
      orderSettings:migratedOrderSettings,
      footprint:{
        ...defaultFootprint,...saved.footprint,
        width:defaultFootprint.width,
        length:defaultFootprint.length,
        safetyMargin:defaultFootprint.safetyMargin,
        inflationRadius:defaultFootprint.inflationRadius,
        kinematicCentreConfirmed:false,
      },
    };
  },
  partialize: (state) => ({
    mqttSettings:{...state.mqttSettings,password:''}, orderSettings:state.orderSettings,
    footprint:state.footprint,plannerOptions:state.plannerOptions,plannerMode:state.plannerMode,
    goal:state.goal,viewRotation:state.viewRotation,
    showGrid:state.showGrid,showInflation:state.showInflation,
    confirmedMapBinding:state.confirmedMapBinding,
    mapMetadata:state.grid?.metadata,
  }),
  merge: (persisted, current) => {
    const saved = persisted as Partial<AppState>;
    const orderSettings={
      ...defaultOrderSettings,...saved.orderSettings,
      stateStaleTimeoutMs:clampStateStaleTimeoutMs(
        saved.orderSettings?.stateStaleTimeoutMs??defaultOrderSettings.stateStaleTimeoutMs),
    };
    const binding=saved.confirmedMapBinding;
    const validBinding=binding&&binding.manufacturer===orderSettings.manufacturer&&
      binding.serialNumber===orderSettings.serialNumber?binding:null;
    return {
      ...current,
      ...saved,
      mqttSettings: { ...defaultMqttSettings, ...saved.mqttSettings, password: '' },
      orderSettings,confirmedMapBinding:validBinding,
      footprint: { ...defaultFootprint, ...saved.footprint },
      plannerOptions: {
        ...defaultPlannerOptions,...saved.plannerOptions,
        policy:saved.plannerOptions?.policy??
          (saved.plannerOptions?.reliableBaselineMode===false?'balanced':'reliable'),
        reliableBaselineMode:(saved.plannerOptions?.policy??
          (saved.plannerOptions?.reliableBaselineMode===false?'balanced':'reliable'))==='reliable',
        corridor:{...defaultPlannerOptions.corridor,...saved.plannerOptions?.corridor},
        passageSafety:{
          ...defaultPlannerOptions.passageSafety,
          ...saved.plannerOptions?.passageSafety,
        },
      },
      // Plans and Orders are derived from live map/pose/configuration inputs.
      // Never revive a previously persisted route without planning it again.
      rawPath:[],finalPath:[],plannerResult:undefined,planningConfiguration:undefined,
      plannedRouteRevision:undefined,generatedOrder:undefined,
      generatedOrderRouteRevision:undefined,validation:undefined,corridorDiagnostics:[],
    };
  },
}));
