import { describe, expect, it, vi } from 'vitest';
import type { OccupancyGrid, RobotPose } from '../domain/types';
import { sanitizeDiagnostics } from '../features/diagnostics/sanitize';
import { validateDestination } from '../features/mission/destinationValidation';
import { getActiveNavigatorOrderId, getDispatchIssues } from '../features/mission/dispatchGate';
import { StartupConnectionManager } from '../features/startup/StartupConnectionManager';
import type { StartupSnapshot } from '../features/startup/types';

const grid:OccupancyGrid={
  metadata:{name:'ward',mapId:'ward',width:4,height:4,resolution:1,
    origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false},
  data:[0,0,0,0,0,100,0,0,0,0,0,0,0,0,0,0],
};
const goal=(x:number,y:number):RobotPose=>({
  x,y,theta:0,mapId:'ward',positionInitialized:true,
});

describe('operator destination workflow',()=>{
  it('accepts a free map click and rejects occupied, out-of-bounds, and wrong-map goals',()=>{
    expect(validateDestination(goal(.5,.5),'ward',grid).valid).toBe(true);
    expect(validateDestination(goal(1.5,2.5),'ward',grid).valid).toBe(false);
    expect(validateDestination(goal(20,20),'ward',grid).message).toContain('outside');
    expect(validateDestination({...goal(.5,.5),mapId:'other'},'ward',grid).message).toContain('different map');
  });

  it('prevents dispatch when an operational safety prerequisite fails',()=>{
    const issues=getDispatchIssues({
      mqttConnected:false,robotOnline:true,stateFresh:true,poseValid:true,mapMatches:true,
      state:{operatingMode:'AUTOMATIC',safetyState:{eStop:'NONE',fieldViolation:false}},
      validation:{valid:true,errors:[],warnings:[]},hasActiveDifferentOrder:false,
    });
    expect(issues.map((issue)=>issue.code)).toContain('dispatch.mqtt');
  });

  it('requires the previous Order to be cancelled and cleared before dispatch',()=>{
    const issues=getDispatchIssues({
      mqttConnected:true,robotOnline:true,stateFresh:true,poseValid:true,mapMatches:true,
      state:{operatingMode:'AUTOMATIC',safetyState:{eStop:'NONE',fieldViolation:false}},
      validation:{valid:true,errors:[],warnings:[]},hasActiveDifferentOrder:true,
    });
    const issue=issues.find((candidate)=>candidate.code==='dispatch.activeOrder');
    expect(issue?.message).toContain('wait until Navigator clears it');
  });

  it('does not treat a retained completed orderId as an active mission',()=>{
    expect(getActiveNavigatorOrderId({
      orderId:'completed-order',driving:false,paused:false,nodeStates:[],edgeStates:[],
    })).toBeNull();
  });

  it('detects a different order only while route execution is active',()=>{
    expect(getActiveNavigatorOrderId({
      orderId:'active-order',driving:false,paused:false,
      nodeStates:[{nodeId:'node-2'}],edgeStates:[],
    })).toBe('active-order');
    expect(getActiveNavigatorOrderId({
      orderId:'active-order',driving:true,paused:false,nodeStates:[],edgeStates:[],
    })).toBe('active-order');
  });
});

describe('secure diagnostics',()=>{
  it('redacts credentials and session identifiers recursively',()=>{
    const sanitized=sanitizeDiagnostics({
      password:'secret',nested:{sessionId:'abc',message:'token=hidden'},username:'admin',
    });
    expect(sanitized).toEqual({
      password:'[REDACTED]',nested:{sessionId:'[REDACTED]',message:'token=[REDACTED]'},username:'admin',
    });
  });
});

describe('startup connection state machine',()=>{
  it('reports ordered phases and reaches READY',async()=>{
    const snapshots:StartupSnapshot[]=[];
    const manager=new StartupConnectionManager();
    await manager.start([
      {phase:'LOADING_CONFIGURATION',message:'config',run:async()=>undefined},
      {phase:'CONNECTING_MQTT',message:'mqtt',run:async()=>undefined},
    ],(snapshot)=>snapshots.push(snapshot));
    expect(snapshots.map((snapshot)=>snapshot.phase)).toEqual([
      'INITIALIZING','LOADING_CONFIGURATION','CONNECTING_MQTT','READY',
    ]);
  });

  it('retries a failed connection and succeeds without parallel calls',async()=>{
    vi.useFakeTimers();
    let calls=0;
    const run=vi.fn(async()=>{
      calls+=1;
      if(calls===1)throw new Error('temporary network failure');
    });
    const manager=new StartupConnectionManager();
    const pending=manager.start([
      {phase:'CONNECTING_LOCATOR',message:'locator',run,retries:1},
    ],()=>undefined);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(run).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('enters DEGRADED when an optional service remains unavailable',async()=>{
    const snapshots:StartupSnapshot[]=[];
    await new StartupConnectionManager().start([
      {phase:'AUTHENTICATING_LOCATOR',message:'login',optional:true,
        run:async()=>{throw new Error('authentication failed');}},
    ],(snapshot)=>snapshots.push(snapshot));
    expect(snapshots.at(-1)?.phase).toBe('DEGRADED');
    expect(snapshots.at(-1)?.error).toContain('AUTHENTICATING LOCATOR: authentication failed');
  });
});
