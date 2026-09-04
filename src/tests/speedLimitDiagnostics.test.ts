import { describe, expect, it } from 'vitest';
import {
  analyzeSpeedLimits, buildSpeedCycleDiagnostic, inspectOutgoingOrderEdgeSpeeds,
} from '../domain/robot/SpeedLimitDiagnostics';
import type { VdaOrder, VdaState } from '../domain/types';

const order:VdaOrder={
  headerId:1,timestamp:'2026-07-30T00:00:00.000Z',version:'2.0.0',
  manufacturer:'bosch',serialNumber:'0001',orderId:'speed-order',
  orderUpdateId:0,
  nodes:[
    {nodeId:'n0',sequenceId:0,released:true,nodePosition:{
      x:0,y:0,theta:0,allowedDeviationXy:.1,allowedDeviationTheta:.1,mapId:'m',
    },actions:[]},
    {nodeId:'n1',sequenceId:2,released:true,nodePosition:{
      x:1,y:0,theta:0,allowedDeviationXy:.1,allowedDeviationTheta:.1,mapId:'m',
    },actions:[]},
  ],
  edges:[{
    edgeId:'e0',sequenceId:1,released:true,startNodeId:'n0',endNodeId:'n1',
    maxSpeed:.73,rotationAllowed:true,actions:[],
  }],
};

describe('speed-limit diagnostics',()=>{
  it('reports the exact serialized maxSpeed of every outgoing edge',()=>{
    const result=inspectOutgoingOrderEdgeSpeeds(JSON.stringify(order));
    expect(result).toEqual([{
      orderId:'speed-order',edgeIndex:0,edgeId:'e0',sequenceId:1,maxSpeed:.73,
    }]);
  });

  it('correlates command, feedback, PLC limits, and the active edge without guessing',()=>{
    const state:VdaState={
      orderId:'speed-order',lastNodeSequenceId:0,
      velocity:{vx:.141,vy:0,omega:.01},
    };
    const raw={
      motionCommand:{v_x:.15,yaw_rate:.02},
      motionFeedback:{
        allowedMaxLinearSpeed:.15,allowedMaxAngularSpeed:.4,
        activeMonitoringCase:3,activeProtectionFieldIds:[2,7],
      },
    };
    expect(buildSpeedCycleDiagnostic(state,raw,order)).toMatchObject({
      edgeMaxSpeed:.73,commandVelocityX:.15,velocityX:.141,
      allowedMaxLinearSpeed:.15,allowedMaxAngularSpeed:.4,
      activeMonitoringCase:3,activeProtectionFieldIds:[2,7],
    });
  });

  it('marks ClientMotion values unavailable when a standard VDA state omits them',()=>{
    const result=buildSpeedCycleDiagnostic({
      orderId:'speed-order',lastNodeSequenceId:0,
      velocity:{vx:.12,vy:0,omega:0},
    },{velocity:{vx:.12}},order);
    expect(result.commandVelocityX).toBeNull();
    expect(result.allowedMaxLinearSpeed).toBeNull();
    expect(result.allowedMaxAngularSpeed).toBeNull();
    expect(result.velocityX).toBe(.12);
    expect(result.edgeMaxSpeed).toBe(.73);
  });

  it.each([
    [{edgeMaxSpeed:.15,allowedMaxLinearSpeed:.25,commandVelocityX:.15,
      velocityX:.14},'Application Order Generation'],
    [{edgeMaxSpeed:.25,allowedMaxLinearSpeed:.15,commandVelocityX:.15,
      velocityX:.14},'PLC Motion Feedback'],
    [{edgeMaxSpeed:.25,allowedMaxLinearSpeed:.25,commandVelocityX:.15,
      velocityX:.14},'Bosch Navigator'],
    [{edgeMaxSpeed:.25,allowedMaxLinearSpeed:.25,commandVelocityX:.25,
      velocityX:.14},'Motor Controller / PLC Scaling'],
    [{edgeMaxSpeed:.25,allowedMaxLinearSpeed:.25,commandVelocityX:.25,
      velocityX:.24},'None'],
  ] as const)('identifies the effective limiter %#',(patch,expected)=>{
    const cycle={
      timestamp:'2026-07-30T00:00:00Z',orderId:'speed-order',edgeId:'e0',
      allowedMaxAngularSpeed:.5,activeMonitoringCase:null,
      activeProtectionFieldIds:null,driving:true,...patch,
    };
    expect(analyzeSpeedLimits(.25,cycle).effectiveLimitingComponent)
      .toBe(expected);
  });
});
