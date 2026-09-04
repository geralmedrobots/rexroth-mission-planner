import { describe, expect, it } from 'vitest';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import type {
  OccupancyGrid, OrderSettings, RobotFootprint, RobotPose,
} from '../domain/types';
import { defaultFootprint, defaultOrderSettings } from '../domain/defaults';
import { RecoveryManager } from '../features/recovery/RecoveryManager';
import {
  findSafeReverseCorridor, isConstantYawReversePathFree, isTurnOnSpotSafe,
} from '../features/recovery/RecoveryGeometry';
import { ReverseRecoveryOrderBuilder } from '../features/recovery/ReverseRecoveryOrderBuilder';
import { defaultRecoverySettings } from '../features/recovery/recoveryStore';
import { getRearLaserStatus } from '../features/recovery/RecoverySafety';
import {
  confirmsBackwardMotion, parseRecoveryTelemetry, requestsTurnOnSpot,
  supportsBackwardDriving,
} from '../features/recovery/RecoveryTelemetry';
import type { RecoveryGeometryInput } from '../features/recovery/types';

const grid=():OccupancyGrid=>({
  metadata:{
    name:'test',mapId:'test',width:120,height:120,resolution:.05,
    origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:25,negate:false,
  },
  data:Array<number>(120*120).fill(0),
});
const pose:RobotPose={
  x:3,y:3,theta:0,mapId:'test',positionInitialized:true,
};
const footprint:RobotFootprint={...defaultFootprint,allowTurnOnSpot:true};
const input=(map=grid()):RecoveryGeometryInput=>({
  grid:map,pose,footprint,observations:[],settings:{...defaultRecoverySettings},
  sampleIntervalM:.025,
});
const occupy=(map:OccupancyGrid,x:number,y:number):void=>{
  const transformer=new CoordinateTransformer(map.metadata);
  const cell=transformer.worldToGrid(x,y);
  if(!cell)throw new Error('Test point is outside grid.');
  map.data[transformer.index(cell)]=100;
};

describe('blocked robot recovery geometry',()=>{
  it('finds a clear reverse corridor and preserves the robot yaw',()=>{
    const result=findSafeReverseCorridor(input());
    expect(result.safe).toBe(true);
    expect(result.distanceM).toBeGreaterThanOrEqual(.5);
    expect(result.distanceM).toBeLessThanOrEqual(1);
    expect(result.target?.x).toBeCloseTo(pose.x-result.distanceM,8);
    expect(result.target?.y).toBeCloseTo(pose.y,8);
    expect(result.target?.theta).toBe(pose.theta);
  });

  it('rejects an occupied reverse corridor',()=>{
    const map=grid();
    for(let y=2.4;y<=3.6;y+=.025)occupy(map,2.65,y);
    expect(isConstantYawReversePathFree(input(map),.5)).toBe(false);
    expect(findSafeReverseCorridor(input(map)).safe).toBe(false);
  });

  it('reports insufficient turn space beside an obstacle',()=>{
    const map=grid();
    for(let x=2.9;x<=3.1;x+=.025)
      for(let y=3.5;y<=3.75;y+=.025)occupy(map,x,y);
    expect(isTurnOnSpotSafe(input(map))).toBe(false);
  });

  it('reports turn space in a clear occupancy grid',()=>{
    expect(isTurnOnSpotSafe(input())).toBe(true);
  });
});

describe('reverse recovery Order',()=>{
  it('uses exact current pose for Node 0 and a same-yaw node behind it',()=>{
    const orderSettings={
      ...defaultOrderSettings,missionMaximumSpeedMps:.37,
    } satisfies OrderSettings;
    const order=new ReverseRecoveryOrderBuilder().build({
      currentPose:{...pose,theta:-1.33},reverseDistanceM:.6,
      activeMapId:'test',orderSettings,
    });
    expect(order.version).toBe('2.0.0');
    expect(order.orderUpdateId).toBe(0);
    expect(order.nodes[0]?.sequenceId).toBe(0);
    expect(order.nodes[0]?.nodePosition).toMatchObject({
      x:pose.x,y:pose.y,theta:-1.33,mapId:'test',
    });
    expect(order.nodes[1]?.sequenceId).toBe(2);
    expect(order.nodes[1]?.nodePosition.theta).toBeCloseTo(-1.33,10);
    expect(order.nodes[1]?.nodePosition.x).toBeCloseTo(
      pose.x-Math.cos(-1.33)*.6,10);
    expect(order.nodes[1]?.nodePosition.y).toBeCloseTo(
      pose.y-Math.sin(-1.33)*.6,10);
    expect(order.edges[0]).toMatchObject({
      sequenceId:1,released:true,maxSpeed:.37,rotationAllowed:false,actions:[],
    });
    expect(order.edges[0]?.startNodeId).toBe(order.nodes[0]?.nodeId);
    expect(order.edges[0]?.endNodeId).toBe(order.nodes[1]?.nodeId);
  });

  it('creates new independent identifiers',()=>{
    const build=()=>new ReverseRecoveryOrderBuilder().build({
      currentPose:pose,reverseDistanceM:.5,
      activeMapId:'test',orderSettings:defaultOrderSettings,
    });
    const first=build();const second=build();
    expect(first.orderId).not.toBe(second.orderId);
    expect(first.headerId).not.toBe(second.headerId);
    expect(first.nodes[0]?.nodeId).not.toBe(second.nodes[0]?.nodeId);
  });
});

describe('Navigator recovery telemetry and rear safety',()=>{
  it('recognizes backward mode and negative commanded velocity',()=>{
    const telemetry=parseRecoveryTelemetry({
      availableDrivingModes:['0x02','0x04'],
      requestDrivingMode:'0x02',motionCommand:{v_x:-.05},
    });
    expect(supportsBackwardDriving(telemetry)).toBe(true);
    expect(confirmsBackwardMotion(telemetry)).toBe(true);
    expect(requestsTurnOnSpot(telemetry)).toBe(false);
  });

  it('decodes availableDrivingModes=7 as the Forward, Backward and Turn bitmask',()=>{
    const telemetry=parseRecoveryTelemetry({
      availableDrivingModes:7,requestDrivingMode:2,motionCommand:{v_x:-.05},
    });
    expect(telemetry.availableDrivingModes).toEqual([1,2,4]);
    expect(supportsBackwardDriving(telemetry)).toBe(true);
    expect(confirmsBackwardMotion(telemetry)).toBe(true);
  });

  it('detects an unexpected turn-on-spot request',()=>{
    expect(requestsTurnOnSpot(parseRecoveryTelemetry({
      availableDrivingModes:[2,4],requestDrivingMode:4,motionCommand:{v_x:0},
    }))).toBe(true);
  });

  it('rejects stale rear laser data',()=>{
    const status=getRearLaserStatus([{
      id:'rear',source:'Laser2',sourcePath:'test',receivedAtMs:1_000,
      points:[{x:0,y:0}],
    }],5_000,7_000);
    expect(status.count).toBe(1);
    expect(status.fresh).toBe(false);
  });
});

describe('RecoveryManager integration states',()=>{
  it('models successful reverse followed by global replanning',()=>{
    const manager=new RecoveryManager();
    [
      'BLOCKED_CONFIRMED','CHECK_TURN_SPACE','CHECK_REVERSE_SPACE',
      'BUILD_REVERSE_ORDER','SEND_REVERSE_ORDER','WAIT_REVERSE_ACCEPTANCE',
      'REVERSING','REVERSE_COMPLETED','GLOBAL_REPLAN','IDLE',
    ].forEach((state)=>manager.transition(state as Parameters<typeof manager.transition>[0]));
    expect(manager.state).toBe('IDLE');
  });

  it('moves a failed reverse to a safe FAILED state',()=>{
    const manager=new RecoveryManager();
    manager.transition('BLOCKED_CONFIRMED');
    manager.transition('CHECK_TURN_SPACE');
    manager.transition('CHECK_REVERSE_SPACE');
    manager.transition('FAILED');
    expect(manager.snapshot({recoveryResult:'failed'})).toMatchObject({
      state:'FAILED',recoveryResult:'failed',
    });
  });
});
