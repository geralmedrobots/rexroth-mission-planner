import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultFootprint, defaultOrderSettings, defaultPlannerOptions,
} from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { PathSimplifier } from '../domain/planner/PathSimplifier';
import { planSynchronously } from '../domain/planner/PlannerService';
import {
  RouteSafetyError, RouteSafetyProcessor,
} from '../domain/planner/RouteSafetyProcessor';
import type { OccupancyGrid, PlannerOptions, RobotFootprint } from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';

const grid=(width=80,height=60):OccupancyGrid=>({
  metadata:{
    name:'baseline',mapId:'baseline',width,height,resolution:.1,
    origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false,
  },
  data:new Array(width*height).fill(0),
});

const compactRobot:RobotFootprint={
  ...defaultFootprint,length:.2,width:.2,safetyMargin:0,inflationRadius:0,
};

const options=(patch:Partial<PlannerOptions>={}):PlannerOptions=>({
  ...defaultPlannerOptions,
  ...patch,
  passageSafety:{
    ...defaultPlannerOptions.passageSafety,
    ...patch.passageSafety,
  },
});

const request=(map:OccupancyGrid,plannerOptions:PlannerOptions=defaultPlannerOptions)=>({
  grid:map,start:{row:30,column:10},goal:{row:30,column:65},
  options:plannerOptions,footprint:compactRobot,startTheta:.23,
});

afterEach(()=>vi.restoreAllMocks());

describe('reliable baseline planning',()=>{
  it('keeps a densified collision-free baseline and exposes every pipeline stage',()=>{
    const result=planSynchronously(request(grid()));
    expect(result.success).toBe(true);
    expect(result.diagnostics?.rawPathStatus).toBe('RAW_PATH_FOUND');
    expect(result.diagnostics?.baselineStatus).toBe('BASELINE_PATH_VALID');
    expect(result.diagnostics?.finalPathSource).toBe('baseline');
    expect(result.baselinePath).toEqual(result.finalPath);
    expect(result.finalPath[0]?.theta).toBeCloseTo(.23);
    result.finalPath.slice(1).forEach((point,index)=>{
      const previous=result.finalPath[index]!;
      expect(Math.hypot(point.x-previous.x,point.y-previous.y))
        .toBeLessThanOrEqual(.6+1e-9);
    });
    const stages=new Set(result.diagnostics?.stages.map((item)=>item.stage));
    [
      'map-validation','start-cell-validation','goal-cell-validation','raw-a-star',
      'path-simplification','waypoint-densification','doorway-detection',
      'doorway-alignment','orientation-generation','turn-feasibility',
      'footprint-collision-validation',
    ].forEach((name)=>expect(stages.has(name as never)).toBe(true));
  });

  it('retains the baseline when optional doorway alignment throws',()=>{
    vi.spyOn(RouteSafetyProcessor.prototype,'process').mockImplementation(()=>{
      throw new RouteSafetyError('Injected doorway candidate collision.');
    });
    const advanced=options({
      policy:'balanced',
      reliableBaselineMode:false,
      passageSafety:{
        ...defaultPlannerOptions.passageSafety,
        enableDoorwayDetection:true,enableDoorAlignment:true,
        enableTurnFeasibilityChecking:false,
      },
    });
    const result=planSynchronously(request(grid(),advanced));
    expect(result.success).toBe(true);
    expect(result.finalPath).toEqual(result.baselinePath);
    expect(result.diagnostics?.doorAlignmentStatus)
      .toBe('ADVANCED_ALIGNMENT_SKIPPED');
    expect(result.diagnostics?.warnings).toContain('DOOR_ALIGNMENT_SKIPPED');
  });

  it('retains the baseline when optional turn relocation throws',()=>{
    vi.spyOn(RouteSafetyProcessor.prototype,'process').mockImplementation(()=>{
      throw new RouteSafetyError('Injected unsafe swept rotation.');
    });
    const advanced=options({
      policy:'balanced',
      reliableBaselineMode:false,
      passageSafety:{
        ...defaultPlannerOptions.passageSafety,
        enableDoorwayDetection:false,enableDoorAlignment:false,
        enableTurnFeasibilityChecking:true,
      },
    });
    const result=planSynchronously(request(grid(),advanced));
    expect(result.success).toBe(true);
    expect(result.finalPath).toEqual(result.baselinePath);
    expect(result.diagnostics?.turnValidationStatus)
      .toBe('TURN_RELOCATION_SKIPPED');
    expect(result.diagnostics?.warnings).toContain('TURN_RELOCATION_SKIPPED');
  });

  it('reverts a colliding simplification to the raw A* geometry',()=>{
    const map=grid();
    for(let row=10;row<50;row+=1)map.data[row*map.metadata.width+38]=100;
    const transform=new CoordinateTransformer(map.metadata);
    vi.spyOn(PathSimplifier.prototype,'simplifyDetailed').mockReturnValue({
      simplifiedPath:[
        transform.gridToWorld(30,10),transform.gridToWorld(30,65),
      ],
      finalPath:[],
    });
    const result=planSynchronously(request(map));
    expect(result.success).toBe(true);
    expect(result.diagnostics?.warnings).toContain('SMOOTHING_REJECTED');
    expect(result.finalPath.some((point)=>point.row===50)).toBe(true);
  });

  it('reports a genuine raw A* failure without inventing a fallback',()=>{
    const map=grid();
    for(let row=0;row<map.metadata.height;row+=1)
      map.data[row*map.metadata.width+38]=100;
    const result=planSynchronously(request(map));
    expect(result.success).toBe(false);
    expect(result.baselinePath).toEqual([]);
    expect(result.diagnostics?.rawPathStatus).toBe('RAW_PATH_FAILED');
    expect(result.diagnostics?.physicalFailureCode).toBe('START_GOAL_DISCONNECTED');
    expect(result.diagnostics?.stages.find(
      (item)=>item.stage==='free-space-model')?.success).toBe(false);
  });

  it('reports the exact start footprint collision cell',()=>{
    const map=grid();
    map.data[30*map.metadata.width+12]=100;
    const result=planSynchronously({
      ...request(map),footprint:{...compactRobot,length:.5,width:.5},
    });
    const failure=result.diagnostics?.stages.find(
      (item)=>item.stage==='start-cell-validation');
    expect(result.success).toBe(false);
    expect(failure?.code).toBe('START_INVALID');
    expect(failure?.collisionCell).toEqual({row:30,column:12});
    expect(failure?.footprintPolygon?.length).toBeGreaterThanOrEqual(4);
  });

  it('builds a valid VDA Order directly from a selected fallback path',()=>{
    const result=planSynchronously(request(grid()));
    const first=result.finalPath[0]!;
    const order=new VdaOrderBuilder().build(result.baselinePath!,{
      robotPose:{...first,mapId:'baseline',positionInitialized:true},
      activeMapId:'baseline',
    },defaultOrderSettings,'baseline-fallback');
    expect(order.nodes).toHaveLength(result.baselinePath!.length);
    expect(order.edges).toHaveLength(order.nodes.length-1);
    expect(order.nodes.every((node)=>node.nodePosition.mapId==='baseline')).toBe(true);
  });
});
