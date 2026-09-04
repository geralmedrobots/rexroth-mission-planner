import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultPlannerOptions } from '../domain/defaults';
import { planSynchronously } from '../domain/planner/PlannerService';
import type { OccupancyGrid } from '../domain/types';

const grid=():OccupancyGrid=>({
  metadata:{
    name:'reachability',mapId:'reachability',width:70,height:50,resolution:.1,
    origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false,
  },
  data:new Array(3500).fill(0),
});
const robot={
  ...defaultFootprint,source:'application-fallback' as const,
  length:.6,width:.6,safetyMargin:0,inflationRadius:0,
};
const plan=(map:OccupancyGrid)=>planSynchronously({
  grid:map,start:{row:25,column:8},goal:{row:25,column:61},
  footprint:robot,startTheta:0,
  options:{
    ...defaultPlannerOptions,policy:'reliable',
    passageSafety:{
      ...defaultPlannerOptions.passageSafety,
      planningSafetyMarginM:0,localizationMarginM:0,
    },
  },
});

describe('physical free-space failure classification',()=>{
  it('reports when only unknown space connects start and goal',()=>{
    const map=grid();
    for(let row=0;row<map.metadata.height;row+=1)
      map.data[row*map.metadata.width+35]=-1;
    const result=plan(map);
    expect(result.success).toBe(false);
    expect(result.diagnostics?.physicalFailureCode).toBe('UNKNOWN_SPACE_BLOCKED');
    expect(result.diagnostics?.freeSpace?.unknownFreeConnected).toBe(true);
  });

  it('reports disconnected known free-space regions',()=>{
    const map=grid();
    for(let row=0;row<map.metadata.height;row+=1)
      map.data[row*map.metadata.width+35]=100;
    const result=plan(map);
    expect(result.success).toBe(false);
    expect(result.diagnostics?.physicalFailureCode).toBe(
      'START_GOAL_DISCONNECTED');
    expect(result.diagnostics?.recommendedOperatorAction).toMatch(
      /connected region|static map/i);
  });

  it('distinguishes a point-robot opening that is too narrow for the vehicle',()=>{
    const map=grid();
    for(let row=0;row<map.metadata.height;row+=1)
      if(row<23||row>27)map.data[row*map.metadata.width+35]=100;
    const result=plan(map);
    expect(result.success).toBe(false);
    expect([
      'PASSAGE_TOO_NARROW','VEHICLE_FOOTPRINT_COLLISION',
    ]).toContain(result.diagnostics?.physicalFailureCode);
    expect(result.diagnostics?.freeSpace?.pointRobotConnected).toBe(true);
    expect(result.diagnostics?.freeSpace?.footprintConnected).toBe(false);
  });
});
