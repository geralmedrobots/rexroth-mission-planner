import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROBOT_LENGTH_M, DEFAULT_ROBOT_WIDTH_M, defaultFootprint,
  defaultOrderSettings, defaultPlannerOptions,
} from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { EdgeCorridorPlanner } from '../domain/planner/EdgeCorridorPlanner';
import type {
  BoschRokitCorridorSettings, OccupancyGrid, PathPoint, RobotFootprint, RobotPose,
} from '../domain/types';
import { BoschRokitCorridorValidator } from '../domain/vda5050/BoschRokitCorridorValidator';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator, type OrderValidationContext } from '../domain/vda5050/VdaOrderValidator';
import { mqttService } from '../services/MqttService';
import { getDispatchIssues } from '../features/mission/dispatchGate';

const makeGrid=(resolution=.1):OccupancyGrid=>({
  metadata:{name:'test-map',mapId:'test-map',width:60,height:40,resolution,
    origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false},
  data:new Array(60*40).fill(0),
});
const occupyWorld=(grid:OccupancyGrid,x:number,y:number,value=100):void=>{
  const cell=new CoordinateTransformer(grid.metadata).worldToGrid(x,y);
  if(cell)grid.data[cell.row*grid.metadata.width+cell.column]=value;
};
const horizontalWall=(grid:OccupancyGrid,y:number,value=100):void=>{
  for(let x=.5;x<=4.5;x+=.05)occupyWorld(grid,x,y,value);
};
const footprint:RobotFootprint={...defaultFootprint,length:.2,width:.2,safetyMargin:0,
  inflationRadius:0};
const corridorSettings=(patch:Partial<BoschRokitCorridorSettings>={}):BoschRokitCorridorSettings=>({
  ...defaultPlannerOptions.corridor,obstacleSafetyMarginM:.1,localizationMarginM:0,
  minCorridorWidthM:.05,maxCorridorWidthM:1,corridorSampleSpacingM:.1,...patch,
});
const start:PathPoint={x:1,y:2,theta:0};
const end:PathPoint={x:4,y:2,theta:0};
const calculate=(grid:OccupancyGrid,settings=corridorSettings(),robot=footprint)=>
  new EdgeCorridorPlanner().calculate(start,end,grid,robot,settings);

describe('Bosch ROKIT edge corridor geometry',()=>{
  it('uses the configured real robot dimensions and reports the half width',()=>{
    expect(defaultFootprint.width).toBe(DEFAULT_ROBOT_WIDTH_M);
    expect(defaultFootprint.length).toBe(DEFAULT_ROBOT_LENGTH_M);
    const result=new EdgeCorridorPlanner().calculate(
      start,end,makeGrid(),defaultFootprint,defaultPlannerOptions.corridor);
    expect(result.diagnostic.robotWidthM).toBe(.60);
    expect(result.diagnostic.robotHalfWidthM).toBe(.30);
    expect(result.diagnostic.safetyMarginM).toBe(.15);
    expect(result.diagnostic.localizationMarginM).toBe(.05);
  });

  it('creates a clamped two-sided corridor in a wide open area',()=>{
    const result=calculate(makeGrid());
    expect(result.corridor).toEqual({
      leftWidth:1,rightWidth:1,corridorRefPoint:'KINEMATICCENTER',
    });
    expect(result.diagnostic.sampleCount).toBeGreaterThan(2);
  });

  it('reduces the left side near a wall while preserving right clearance',()=>{
    const grid=makeGrid();horizontalWall(grid,2.6);
    const result=calculate(grid);
    expect(result.corridor).not.toBeNull();
    expect(result.corridor!.leftWidth).toBeLessThan(result.corridor!.rightWidth);
  });

  it('reduces the right side near a wall',()=>{
    const grid=makeGrid();horizontalWall(grid,1.4);
    const result=calculate(grid);
    expect(result.corridor).not.toBeNull();
    expect(result.corridor!.rightWidth).toBeLessThan(result.corridor!.leftWidth);
  });

  it('omits a corridor in a passage too narrow for the configured margins',()=>{
    const grid=makeGrid();horizontalWall(grid,2.2);horizontalWall(grid,1.8);
    expect(calculate(grid).corridor).toBeNull();
  });

  it('treats unknown cells as blocked only when configured',()=>{
    const grid=makeGrid();horizontalWall(grid,2.6,-1);
    const blocked=calculate(grid,corridorSettings({unknownCellsBlocked:true}));
    const free=calculate(grid,corridorSettings({unknownCellsBlocked:false}));
    expect(blocked.diagnostic.leftClearanceM).toBeLessThan(free.diagnostic.leftClearanceM!);
  });

  it('stops ray casting safely at a map boundary',()=>{
    const grid=makeGrid();
    const result=new EdgeCorridorPlanner().calculate(
      {x:1,y:.25,theta:0},{x:4,y:.25,theta:0},grid,footprint,corridorSettings());
    expect(result.diagnostic.rightClearanceM).toBeLessThan(.3);
    expect(result.corridor?.leftWidth).toBeGreaterThan(0);
  });

  it('supports diagonal edges',()=>{
    const result=new EdgeCorridorPlanner().calculate(
      {x:1,y:1,theta:Math.PI/4},{x:3,y:3,theta:Math.PI/4},
      makeGrid(),footprint,corridorSettings());
    expect(result.corridor).not.toBeNull();
  });

  it('rejects zero length, invalid resolution, and oversized footprint cases',()=>{
    const planner=new EdgeCorridorPlanner();const grid=makeGrid();
    expect(planner.calculate(start,start,grid,footprint,corridorSettings()).corridor).toBeNull();
    expect(calculate(makeGrid(0)).corridor).toBeNull();
    horizontalWall(grid,2.4);horizontalWall(grid,1.6);
    expect(calculate(grid,corridorSettings(),{...footprint,width:1}).corridor).toBeNull();
  });

  it('never exceeds the configured maximum width',()=>{
    const result=calculate(makeGrid(),corridorSettings({maxCorridorWidthM:.35}));
    expect(result.corridor?.leftWidth).toBe(.35);
    expect(result.corridor?.rightWidth).toBe(.35);
  });
});

describe('VDA 2.0 plus Bosch VDA 2.1 corridor extension',()=>{
  const robotPose:RobotPose={x:1,y:2,theta:-1.33,mapId:'test-map',positionInitialized:true};
  const path:PathPoint[]=[robotPose,{x:2,y:2,theta:0},{x:4,y:2,theta:0}];
  const build=(enabled=true)=>{
    const plannerOptions={...defaultPlannerOptions,corridor:corridorSettings({
      enableBoschRokitCorridorExtension:enabled,
    })};
    return new VdaOrderBuilder().build(path,{
      robotPose,activeMapId:'test-map',
      corridorPlanning:{grid:makeGrid(),footprint,plannerOptions},
    },defaultOrderSettings);
  };
  const validationContext=(grid=makeGrid()):OrderValidationContext=>({
    mqttConnected:true,stateReceived:true,connectionReceived:true,activeMapId:'test-map',
    currentPose:robotPose,grid,footprint,settings:defaultOrderSettings,
    connectionOnline:true,operatingMode:'AUTOMATIC',stateAgeMs:0,visualizationAgeMs:0,
    positionInitialized:true,poseSource:'state',locatorMapName:'test-map',
    corridorSettings:corridorSettings(),
  });

  afterEach(()=>vi.restoreAllMocks());

  it('keeps version 2.0.0, serializes corridor, and requires no trajectory',()=>{
    const order=build();
    expect(order.version).toBe('2.0.0');
    expect(order.edges[0]?.corridor).toBeDefined();
    expect(order.edges[0]).not.toHaveProperty('trajectory');
    expect(JSON.parse(JSON.stringify(order)).edges[0].corridor.corridorRefPoint)
      .toBe('KINEMATICCENTER');
  });

  it('omits corridor and preserves original order behavior when disabled',()=>{
    const order=build(false);
    expect(order.edges.every((edge)=>edge.corridor===undefined)).toBe(true);
    expect(order.nodes).toHaveLength(3);
    expect(order.edges).toHaveLength(2);
  });

  it('runs strict base validation independently from extension validation',()=>{
    const order=build();
    order.edges[0]!.corridor={leftWidth:Number.NaN,rightWidth:.2,
      corridorRefPoint:'KINEMATICCENTER'};
    const validator=new VdaOrderValidator();
    expect(validator.validateBase(order,validationContext()).valid).toBe(true);
    expect(new BoschRokitCorridorValidator().validate(order,{
      settings:corridorSettings(),grid:makeGrid(),
    }).valid).toBe(false);
    expect(validator.validate(order,validationContext()).errors.map((issue)=>issue.code))
      .toContain('corridor.invalid');
    const validation=validator.validate(order,validationContext());
    expect(getDispatchIssues({
      mqttConnected:true,robotOnline:true,stateFresh:true,poseValid:true,mapMatches:true,
      state:{operatingMode:'AUTOMATIC',safetyState:{eStop:'NONE',fieldViolation:false}},
      validation,hasActiveDifferentOrder:false,
    }).map((issue)=>issue.code)).toContain('dispatch.validation');
  });

  it('retains corridor in the exact MQTT publication payload',async()=>{
    const order=build();const publish=vi.spyOn(mqttService,'publish').mockResolvedValueOnce();
    await mqttService.publish('uagv/v2/bosch/0001/order',JSON.stringify(order),1,false);
    const payload=publish.mock.calls[0]?.[1]??'{}';
    expect(JSON.parse(payload).version).toBe('2.0.0');
    expect(JSON.parse(payload).edges[0].corridor).toEqual(order.edges[0]?.corridor);
  });

  it('preserves live robot yaw and orients intermediate nodes along the outgoing edge',()=>{
    const order=build();
    expect(order.nodes[0]?.nodePosition.theta).toBe(-1.33);
    expect(order.nodes[1]?.nodePosition.theta).toBeCloseTo(0);
  });
});
