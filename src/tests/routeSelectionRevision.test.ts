import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import type { OccupancyGrid, PlannerResult, RobotPose, ValidationResult, VdaOrder } from '../domain/types';
import { PlanningCoordinator, type PlanningInputs } from '../features/planning/PlanningCoordinator';
import { isCurrentRouteOrder, RoutePreparationGuard } from '../features/planning/RouteRevisionGuard';
import { useAppStore } from '../stores/appStore';

const grid:OccupancyGrid={metadata:{name:'route-revision',mapId:'map',width:8,height:2,
  resolution:1,origin:{x:0,y:0,yaw:0},occupiedThreshold:.65,freeThreshold:.2,negate:false},
data:Array(16).fill(0)};
const pose=(x:number):RobotPose=>({x,y:.5,theta:0,mapId:'map',positionInitialized:true});
const result=(goal:RobotPose):PlannerResult=>({success:true,rawPath:[pose(.5),goal],
  simplifiedPath:[pose(.5),goal],finalPath:[pose(.5),goal],statistics:{visitedCells:2,
    durationMs:1,rawPointCount:2,simplifiedPointCount:2,finalPointCount:2}});
const configuration=()=>createPlanningConfigurationSnapshot({plannerOptions:defaultPlannerOptions,
  footprint:defaultFootprint,orderSettings:defaultOrderSettings});
const order=(id:string):VdaOrder=>({orderId:id,nodes:[],edges:[]} as unknown as VdaOrder);
const validation:ValidationResult={valid:true,errors:[],warnings:[]};
const inputs=(goal:RobotPose,routeRevision:number):PlanningInputs=>({grid,start:pose(.5),goal,
  waypoints:[],plannerMode:'automatic',plannerOptions:structuredClone(defaultPlannerOptions),
  footprint:structuredClone(defaultFootprint),orderSettings:structuredClone(defaultOrderSettings),
  sessionId:'route-revision',routeRevision});

describe('selected route revision',()=>{
  beforeEach(()=>useAppStore.setState({routeRevision:0,plannedRouteRevision:undefined,
    generatedOrderRouteRevision:undefined,planningConfiguration:undefined,goal:undefined,
    rawPath:[],finalPath:[],plannerResult:undefined,generatedOrder:undefined,validation:undefined,
    corridorDiagnostics:[],planning:false}));

  it('rejects path A when path B is selected while A is still planning',async()=>{
    const completions:Array<(value:PlannerResult)=>void>=[];
    const planner={plan:vi.fn(()=>new Promise<PlannerResult>((resolve)=>completions.push(resolve)))};
    const coordinator=new PlanningCoordinator({planner});
    const store=useAppStore.getState();
    store.set({goal:pose(4.5)});const revisionA=useAppStore.getState().routeRevision;
    const pendingA=coordinator.plan(inputs(pose(4.5),revisionA));

    store.set({goal:pose(6.5)});const revisionB=useAppStore.getState().routeRevision;
    const pendingB=coordinator.plan(inputs(pose(6.5),revisionB));
    completions[0]!(result(pose(4.5)));
    await expect(pendingA).resolves.toBeUndefined();
    expect(store.commitPlannedRoute(revisionA,{start:pose(.5),rawPath:result(pose(4.5)).rawPath,
      finalPath:result(pose(4.5)).finalPath,plannerResult:result(pose(4.5)),
      planningConfiguration:configuration()})).toBe(false);

    completions[1]!(result(pose(6.5)));
    const plannedB=await pendingB;
    expect(plannedB?.routeRevision).toBe(revisionB);
    expect(store.commitPlannedRoute(revisionB,{start:pose(.5),rawPath:plannedB!.rawPath,
      finalPath:plannedB!.finalPath,plannerResult:plannedB!,
      planningConfiguration:plannedB!.planningConfiguration})).toBe(true);
    expect(useAppStore.getState().finalPath.at(-1)?.x).toBe(6.5);
  });

  it('atomically removes completed A artifacts and makes its Order permanently unpublishable',()=>{
    const store=useAppStore.getState();
    store.set({goal:pose(4.5)});const revisionA=useAppStore.getState().routeRevision;
    expect(store.commitPlannedRoute(revisionA,{start:pose(.5),rawPath:result(pose(4.5)).rawPath,
      finalPath:result(pose(4.5)).finalPath,plannerResult:result(pose(4.5)),
      planningConfiguration:configuration()})).toBe(true);
    const orderA=order('A');
    expect(store.commitGeneratedOrder(revisionA,orderA,validation,[])).toBe(true);
    expect(isCurrentRouteOrder(useAppStore.getState(),orderA,revisionA)).toBe(true);

    store.set({goal:pose(6.5)});
    const changed=useAppStore.getState();
    expect(changed.finalPath).toEqual([]);
    expect(changed.plannerResult).toBeUndefined();
    expect(changed.planningConfiguration).toBeUndefined();
    expect(changed.generatedOrder).toBeUndefined();
    expect(isCurrentRouteOrder(changed,orderA,revisionA)).toBe(false);
    expect(store.commitGeneratedOrder(revisionA,orderA,validation,[])).toBe(false);
  });

  it('commits a successful current plan and always clears calculating state',()=>{
    const store=useAppStore.getState();
    store.set({goal:pose(4.5)});
    const revision=useAppStore.getState().routeRevision;
    expect(store.beginPlanning(revision)).toBe(true);
    expect(useAppStore.getState().planning).toBe(true);
    expect(store.commitPlannedRoute(revision,{start:pose(.5),rawPath:result(pose(4.5)).rawPath,
      finalPath:result(pose(4.5)).finalPath,plannerResult:result(pose(4.5)),
      planningConfiguration:configuration()})).toBe(true);
    store.finishPlanning(revision);
    expect(useAppStore.getState().planning).toBe(false);
    expect(useAppStore.getState().finalPath.at(-1)?.x).toBe(4.5);
  });

  it('rejects a stale plan while still clearing its calculating state',()=>{
    const store=useAppStore.getState();
    store.set({goal:pose(4.5)});const staleRevision=useAppStore.getState().routeRevision;
    expect(store.beginPlanning(staleRevision)).toBe(true);
    store.set({goal:pose(6.5)});
    expect(store.commitPlannedRoute(staleRevision,{start:pose(.5),
      rawPath:result(pose(4.5)).rawPath,finalPath:result(pose(4.5)).finalPath,
      plannerResult:result(pose(4.5)),planningConfiguration:configuration()})).toBe(false);
    store.finishPlanning(staleRevision);
    expect(useAppStore.getState().planning).toBe(false);
    expect(useAppStore.getState().finalPath).toEqual([]);
  });

  it('does not change routeRevision for normal telemetry pose refreshes during planning',()=>{
    const store=useAppStore.getState();
    store.set({goal:pose(4.5)});const revision=useAppStore.getState().routeRevision;
    expect(store.beginPlanning(revision)).toBe(true);
    store.updateTelemetryStart(pose(.6));
    store.set({mqttConnected:true});
    expect(useAppStore.getState().routeRevision).toBe(revision);
    expect(useAppStore.getState().planning).toBe(true);
    store.finishPlanning(revision);
  });

  it('keeps rapid selection completions isolated and cannot leave the latest UI phase calculating',()=>{
    const guard=new RoutePreparationGuard();
    let phase='Selecting destination';
    const first=guard.begin();phase='Calculating route';
    const second=guard.begin();phase='Calculating route';
    if(guard.isCurrent(first))phase='Selection changed';
    expect(phase).toBe('Calculating route');
    if(guard.isCurrent(second))phase='Ready to start';
    expect(phase).toBe('Ready to start');
  });
});
