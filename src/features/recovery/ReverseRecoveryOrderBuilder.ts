import type { OrderSettings, RobotPose, VdaOrder } from '../../domain/types';
import { allocateVdaHeaderId } from '../../domain/vda5050/VdaOrderBuilder';

export class ReverseRecoveryOrderBuilder {
  public build(input:{
    currentPose:RobotPose;
    reverseDistanceM:number;
    activeMapId:string;
    orderSettings:OrderSettings;
  }):VdaOrder{
    const {currentPose,reverseDistanceM,activeMapId,orderSettings}=input;
    const missionMaximumSpeedMps=orderSettings.missionMaximumSpeedMps;
    if(![currentPose.x,currentPose.y,currentPose.theta,reverseDistanceM,
      missionMaximumSpeedMps]
      .every(Number.isFinite))
      throw new Error('Reverse recovery requires finite pose, distance and speed values.');
    if(reverseDistanceM<=0||missionMaximumSpeedMps<=0)
      throw new Error('Reverse recovery distance and speed must be positive.');
    if(reverseDistanceM>1)
      throw new Error('Reverse recovery distance must not exceed 1.0 m.');
    if(!activeMapId.trim())throw new Error('Reverse recovery requires an active mapId.');
    if(currentPose.theta<-Math.PI||currentPose.theta>Math.PI)
      throw new Error('Current recovery yaw must already be normalized to [-PI, PI].');
    // Preserve the live yaw byte-for-byte. Deriving it from the reverse edge would request rotation.
    const yaw=currentPose.theta;
    const firstNodeId=`recovery-node-0-${crypto.randomUUID()}`;
    const secondNodeId=`recovery-node-1-${crypto.randomUUID()}`;
    return {
      headerId:allocateVdaHeaderId(),timestamp:new Date().toISOString(),
      version:'2.0.0',manufacturer:orderSettings.manufacturer,
      serialNumber:orderSettings.serialNumber,
      orderId:`reverse-recovery-${crypto.randomUUID()}`,orderUpdateId:0,
      nodes:[
        {
          nodeId:firstNodeId,sequenceId:0,released:true,
          nodePosition:{
            x:currentPose.x,y:currentPose.y,theta:yaw,
            allowedDeviationXy:orderSettings.allowedDeviationXy,
            allowedDeviationTheta:orderSettings.allowedDeviationTheta,mapId:activeMapId,
          },
          actions:[],
        },
        {
          nodeId:secondNodeId,sequenceId:2,released:true,
          nodePosition:{
            x:currentPose.x-Math.cos(yaw)*reverseDistanceM,
            y:currentPose.y-Math.sin(yaw)*reverseDistanceM,theta:yaw,
            allowedDeviationXy:orderSettings.allowedDeviationXy,
            allowedDeviationTheta:orderSettings.allowedDeviationTheta,mapId:activeMapId,
          },
          actions:[],
        },
      ],
      edges:[{
        edgeId:`recovery-edge-0-${crypto.randomUUID()}`,sequenceId:1,released:true,
        startNodeId:firstNodeId,endNodeId:secondNodeId,
        maxSpeed:missionMaximumSpeedMps,
        rotationAllowed:false,actions:[],
      }],
    };
  }
}
