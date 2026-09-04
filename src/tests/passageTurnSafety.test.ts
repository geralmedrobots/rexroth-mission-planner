import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { normalizeAngle } from '../domain/geometry/angles';
import { PassageDetector } from '../domain/planner/PassageDetector';
import { PathCollisionValidator } from '../domain/planner/PathCollisionValidator';
import {
  RouteSafetyError, RouteSafetyProcessor,
} from '../domain/planner/RouteSafetyProcessor';
import type {
  OccupancyGrid, PathPoint, PlannerOptions, RobotFootprint,
} from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { defaultOrderSettings } from '../domain/defaults';

const makeGrid=(width=120,height=100,resolution=.05):OccupancyGrid=>({
  metadata:{
    name:'safety-map',mapId:'safety-map',width,height,resolution,
    origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false,
  },
  data:new Array(width*height).fill(0),
});

const occupyWorld=(grid:OccupancyGrid,minX:number,maxX:number,minY:number,maxY:number):void=>{
  const transform=new CoordinateTransformer(grid.metadata);
  for(let row=0;row<grid.metadata.height;row+=1)
    for(let column=0;column<grid.metadata.width;column+=1){
      const point=transform.gridToWorld(row,column);
      if(point.x>=minX&&point.x<=maxX&&point.y>=minY&&point.y<=maxY)
        grid.data[row*grid.metadata.width+column]=100;
    }
};

const robot:RobotFootprint={
  ...defaultFootprint,length:.83,width:.60,safetyMargin:0,inflationRadius:0,
};

const options=(patch:Partial<PlannerOptions['passageSafety']>={}):PlannerOptions=>({
  ...defaultPlannerOptions,
  passageSafety:{
    ...defaultPlannerOptions.passageSafety,
    planningSafetyMarginM:.08,localizationMarginM:.05,
    ...patch,
  },
});

const doorMap=(gapWidth=1.05):OccupancyGrid=>{
  const grid=makeGrid();
  const centreY=2.5;
  occupyWorld(grid,2.4,2.8,0,centreY-gapWidth/2);
  occupyWorld(grid,2.4,2.8,centreY+gapWidth/2,5);
  return grid;
};

describe('passage alignment and turn safety',()=>{
  it('densifies a straight route without duplicates or over-length edges',()=>{
    const result=new RouteSafetyProcessor().process(
      makeGrid(),[{x:1,y:2.5,theta:0},{x:4,y:2.5,theta:0}],
      robot,options({enableDoorwayDetection:false,enableDoorAlignment:false}),0,0);
    expect(result.path.length).toBeGreaterThanOrEqual(8);
    result.path.slice(1).forEach((point,index)=>{
      const previous=result.path[index]!;
      const distance=Math.hypot(point.x-previous.x,point.y-previous.y);
      expect(distance).toBeGreaterThan(.001);
      expect(distance).toBeLessThanOrEqual(.6+1e-9);
      expect(point.theta).toBeCloseTo(0);
    });
  });

  it('detects opposing doorway boundaries and reports usable width',()=>{
    const grid=doorMap();
    const passages=new PassageDetector().detect(
      grid,[{x:1,y:2.5,theta:0},{x:4,y:2.5,theta:0}],{
        ...robot,safetyMargin:.13,
      },options());
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0]!.widthM).toBeGreaterThan(.9);
    expect(passages[0]!.usableWidthM).toBeGreaterThan(0);
    expect(passages[0]!.confidence).toBeGreaterThan(.5);
  });

  it('rejects a passage that is narrower than the complete robot plus margins',()=>{
    const passages=new PassageDetector().detect(
      doorMap(.75),[{x:1,y:2.5,theta:0},{x:4,y:2.5,theta:0}],{
        ...robot,safetyMargin:.13,
      },options());
    expect(passages).toHaveLength(0);
  });

  it('adds aligned pre, centre, and exit poses through a valid doorway',()=>{
    const result=new RouteSafetyProcessor().process(
      doorMap(),[{x:1,y:2.5,theta:0},{x:4,y:2.5,theta:0}],
      robot,options(),0,0);
    const passagePoints=result.path.filter((point)=>point.passageId);
    expect(passagePoints.some((point)=>point.kind==='door-alignment')).toBe(true);
    expect(passagePoints.some((point)=>point.kind==='door-centre')).toBe(true);
    expect(passagePoints.some((point)=>point.kind==='door-exit')).toBe(true);
    passagePoints.forEach((point)=>
      expect(Math.abs(normalizeAngle(point.theta))).toBeLessThan(1e-6));
  });

  it('preserves live yaw at node zero and an explicit final yaw',()=>{
    const result=new RouteSafetyProcessor().process(
      makeGrid(),[{x:1,y:2.5,theta:0},{x:3,y:2.5,theta:0}],
      robot,options({enableDoorwayDetection:false,enableDoorAlignment:false}),
      .17,-.42);
    expect(result.path[0]!.theta).toBeCloseTo(.17);
    expect(result.path.at(-1)!.theta).toBeCloseTo(-.42);
  });

  it('checks occupied cells intersecting the footprint interior, not only its centre',()=>{
    const grid=makeGrid();
    occupyWorld(grid,2.18,2.23,2.48,2.53);
    const collision=new PathCollisionValidator();
    expect(collision.pointIsFree(grid,{x:2,y:2.5,theta:0},robot)).toBe(false);
  });

  it('blocks unknown cells under the complete footprint',()=>{
    const grid=makeGrid();
    const cell=new CoordinateTransformer(grid.metadata).worldToGrid(2.2,2.5)!;
    grid.data[cell.row*grid.metadata.width+cell.column]=-1;
    expect(new PathCollisionValidator().pointIsFree(
      grid,{x:2,y:2.5,theta:0},robot)).toBe(false);
  });

  it('samples the complete swept footprint during rotation',()=>{
    const grid=makeGrid();
    occupyWorld(grid,2.36,2.40,2.36,2.40);
    const collision=new PathCollisionValidator();
    expect(collision.pointIsFree(grid,{x:2,y:2,theta:0},robot)).toBe(true);
    expect(collision.pointIsFree(grid,{x:2,y:2,theta:Math.PI/2},robot)).toBe(true);
    expect(collision.rotationIsFree(
      grid,{x:2,y:2},0,Math.PI/2,robot,5*Math.PI/180)).toBe(false);
  });

  it('rounds a large open-area heading change into progressive nodes',()=>{
    const result=new RouteSafetyProcessor().process(
      makeGrid(),[
        {x:1,y:1,theta:0},{x:3,y:1,theta:0},{x:3,y:3,theta:Math.PI/2},
      ],robot,options({enableDoorwayDetection:false,enableDoorAlignment:false}),0,
      Math.PI/2);
    expect(result.path.some((point)=>point.kind==='turn-transition')).toBe(true);
    expect(result.diagnostics.largestHeadingChangeDeg).toBeLessThanOrEqual(47);
  });

  it('rejects an unsafe corner when neither a swept turn nor a forward curve fits',()=>{
    const grid=makeGrid();
    occupyWorld(grid,2.7,3.5,.4,.72);
    occupyWorld(grid,3.28,3.6,.7,1.5);
    expect(()=>new RouteSafetyProcessor().process(
      grid,[
        {x:1,y:1,theta:0},{x:3,y:1,theta:0},{x:3,y:2,theta:Math.PI/2},
      ],robot,options({enableDoorwayDetection:false,enableDoorAlignment:false}),0,
      Math.PI/2)).toThrow(RouteSafetyError);
  });

  it('keeps legacy long segments when all new geometry features are disabled',()=>{
    const disabled=options({
      enableWaypointDensification:false,enableDoorwayDetection:false,
      enableDoorAlignment:false,enableTurnFeasibilityChecking:false,
    });
    const result=new RouteSafetyProcessor().process(
      makeGrid(),[{x:1,y:2.5,theta:0},{x:4,y:2.5,theta:0}],
      robot,disabled,0,0);
    expect(result.path).toHaveLength(2);
  });

  it('keeps passage theta in VDA nodes and disallows rotation on passage edges',()=>{
    const path:PathPoint[]=[
      {x:1,y:2.5,theta:.1},
      {x:2,y:2.5,theta:0,kind:'door-alignment',passageId:'door',
        orientationLocked:true},
      {x:2.5,y:2.5,theta:0,kind:'door-centre',passageId:'door',
        orientationLocked:true},
      {x:3,y:2.5,theta:0},
    ];
    const pose={x:1,y:2.5,theta:.1,mapId:'safety-map',positionInitialized:true};
    const order=new VdaOrderBuilder().build(path,{
      robotPose:pose,activeMapId:'safety-map',
    },defaultOrderSettings);
    expect(order.nodes[1]!.nodePosition.theta).toBe(0);
    expect(order.edges[1]!.rotationAllowed).toBe(false);
  });
});
