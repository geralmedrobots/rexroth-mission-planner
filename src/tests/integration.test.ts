import { describe, expect, it, vi } from 'vitest';
import { defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { planSynchronously } from '../domain/planner/PlannerService';
import type { OccupancyGrid, RobotFootprint } from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator } from '../domain/vda5050/VdaOrderValidator';
import { MissionMonitor } from '../domain/order/MissionMonitor';
import { mqttService } from '../services/MqttService';
import { removeInitialDuplicatePoints } from '../domain/vda5050/VdaOrderBuilder';

describe('map → plan → VDA integration',()=>{
  it('routes, starts at live pose, publishes, and detects Navigator acceptance',async()=>{
    const width=40,height=30;const grid:OccupancyGrid={metadata:{name:'sample',mapId:'sample',width,height,resolution:.1,
      origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false},data:new Array(width*height).fill(0)};
    for(let r=0;r<25;r+=1)grid.data[r*width+20]=100;
    const footprint:RobotFootprint={length:.05,width:.05,height:.1,centerOffsetX:0,centerOffsetY:0,safetyMargin:0,inflationRadius:0,
      minimumTurningRadius:0,differentialDrive:true,allowReverse:false,allowTurnOnSpot:true};
    const result=planSynchronously({grid,start:{row:4,column:4},goal:{row:4,column:35},options:defaultPlannerOptions,footprint,goalTheta:0});
    expect(result.success).toBe(true);expect(result.rawPath.some((p)=>p.row===25)).toBe(true);
    const start=new CoordinateTransformer(grid.metadata).gridToWorld(4,4);
    const robotPose={...start,mapId:'sample',positionInitialized:true};
    const order=new VdaOrderBuilder().build(result.finalPath,{robotPose,activeMapId:'sample'},defaultOrderSettings,'integration-order');
    const validation=new VdaOrderValidator().validate(order,{mqttConnected:true,stateReceived:true,connectionReceived:true,activeMapId:'sample',
      currentPose:robotPose,grid,footprint,settings:defaultOrderSettings,connectionOnline:true,operatingMode:'AUTOMATIC',
      stateAgeMs:0,visualizationAgeMs:0,positionInitialized:true,poseSource:'state',locatorMapName:'sample'});
    const firstUseful=removeInitialDuplicatePoints(robotPose,result.finalPath,defaultOrderSettings.initialPathPointDistance)[0]!;
    expect(order.nodes[0]?.nodePosition).toMatchObject({x:robotPose.x,y:robotPose.y,theta:robotPose.theta,mapId:'sample'});
    expect(order.nodes[1]?.nodePosition).toMatchObject({x:firstUseful.x,y:firstUseful.y});
    expect(validation.errors).toEqual([]);expect(order.edges).toHaveLength(order.nodes.length-1);
    const publish=vi.spyOn(mqttService,'publish').mockResolvedValueOnce();
    await mqttService.publish('uagv/v2/bosch/0001/order',JSON.stringify(order),1,false);
    expect(publish).toHaveBeenCalledOnce();
    const accepted=new MissionMonitor().calculate(order,{orderId:order.orderId,lastNodeSequenceId:0,
      nodeStates:order.nodes.slice(1).map((node)=>({nodeId:node.nodeId}))});
    expect(accepted.status).toBe('Accepted');expect(accepted.accepted).toBe(true);
    publish.mockRestore();
  });

  it('changes mission status to Rejected with the exact Navigator error',()=>{
    const robot={x:2.685,y:1.489,theta:-1.330,mapId:'sample',positionInitialized:true};
    const order=new VdaOrderBuilder().build([{...robot},{x:3,y:1.2,theta:-.785}],
      {robotPose:robot,activeMapId:'sample'},defaultOrderSettings);
    const description='First Node of the Order is not trivially reachable';
    const mission=new MissionMonitor().calculate(order,{orderId:'',errors:[{
      errorType:'OrderError',errorLevel:'WARNING',errorDescription:description,
      errorReferences:[{referenceKey:'orderId',referenceValue:order.orderId},{referenceKey:'node.sequenceId',referenceValue:'0'}],
    }]});
    expect(mission.status).toBe('Rejected');
    expect(mission.rejectionErrors[0]?.errorDescription).toBe(description);
  });
});
