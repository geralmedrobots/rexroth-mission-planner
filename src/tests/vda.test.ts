import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultOrderSettings } from '../domain/defaults';
import type { OccupancyGrid } from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator } from '../domain/vda5050/VdaOrderValidator';
import { buildTopics } from '../domain/vda5050/topics';

const path=[{x:.2,y:.2,theta:0},{x:.8,y:.2,theta:0},{x:1.2,y:.6,theta:.5}];
const grid:OccupancyGrid={metadata:{name:'map',mapId:'map',width:30,height:30,resolution:.1,origin:{x:0,y:0,yaw:0},
  occupiedThreshold:65,freeThreshold:20,negate:false},data:new Array(900).fill(0)};
const robotPose={x:.2,y:.2,theta:0,mapId:'map',positionInitialized:true};
const buildContext={robotPose,activeMapId:'map'};
const context={mqttConnected:true,stateReceived:true,connectionReceived:true,activeMapId:'map',
  currentPose:robotPose,grid,footprint:{...defaultFootprint,length:.1,width:.1,safetyMargin:0,inflationRadius:0},settings:defaultOrderSettings,
  connectionOnline:true,operatingMode:'AUTOMATIC',stateAgeMs:0,visualizationAgeMs:0,positionInitialized:true,
  poseSource:'state' as const,locatorMapName:'map'};
describe('VDA 5050 order',()=>{
  it('generates alternating sequence IDs and edge relationships',()=>{
    const order=new VdaOrderBuilder().build(path,buildContext,defaultOrderSettings,'order-test');
    expect(order.nodes.map((n)=>n.sequenceId)).toEqual([0,2,4]);expect(order.edges.map((e)=>e.sequenceId)).toEqual([1,3]);
    expect(order.edges[0]?.startNodeId).toBe(order.nodes[0]?.nodeId);expect(order.edges[0]?.endNodeId).toBe(order.nodes[1]?.nodeId);
    expect(JSON.parse(JSON.stringify(order))).toEqual(order);
  });
  it('validates a generated order',()=>{const order=new VdaOrderBuilder().build(path,buildContext,defaultOrderSettings);expect(new VdaOrderValidator().validate(order,context).valid).toBe(true);});
  it('rejects mapId and theta violations',()=>{const order=new VdaOrderBuilder().build(path,buildContext,defaultOrderSettings);
    order.nodes[1]!.nodePosition.mapId='wrong';order.nodes[2]!.nodePosition.theta=4;
    const codes=new VdaOrderValidator().validate(order,context).errors.map((e)=>e.code);
    expect(codes).toContain('node.mapId');expect(codes).toContain('node.theta');
  });
  it('requires every edge to equal MissionMaximumSpeedMps',()=>{
    const settings={...defaultOrderSettings,missionMaximumSpeedMps:1.0};
    const order=new VdaOrderBuilder().build(path,buildContext,settings);
    expect(new VdaOrderValidator().validate(order,{...context,settings}).valid).toBe(true);
    order.edges[0]!.maxSpeed=1.001;
    expect(new VdaOrderValidator().validate(order,{...context,settings}).errors
      .map((issue)=>issue.code)).toContain('edge.missionSpeed');
  });
  it('builds configurable MQTT topics',()=>expect(buildTopics({interfaceName:'uagv',topicVersion:'v2',manufacturer:'bosch',serialNumber:'0001'}).order)
    .toBe('uagv/v2/bosch/0001/order'));
});
