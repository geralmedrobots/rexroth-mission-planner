import type { VdaError } from '../../domain/types';
import type {
  BlockedRouteDecision, BlockedRouteSnapshot, GlobalReplanningSettings,
} from './types';

const finiteMotionFeedback=(snapshot:BlockedRouteSnapshot):boolean=>{
  const velocity=snapshot.state?.velocity;
  return Boolean(velocity&&[velocity.vx,velocity.vy,velocity.omega].every(Number.isFinite));
};

const referencesOrder=(error:VdaError,orderId:string):boolean=>
  (error.errorReferences??[]).some((reference)=>
    reference.referenceKey.toLowerCase().endsWith('orderid')&&reference.referenceValue===orderId);

export class BlockedRouteDetector {
  private candidateSinceMs:number|null=null;
  private lastVisualizationPose?:{x:number;y:number;receivedAtMs:number};
  private lastVisualizationMotionAtMs:number|null=null;

  public reset():void{
    this.candidateSinceMs=null;
    this.lastVisualizationPose=undefined;
    this.lastVisualizationMotionAtMs=null;
  }

  public update(
    snapshot:BlockedRouteSnapshot,
    settings:GlobalReplanningSettings,
  ):BlockedRouteDecision{
    const state=snapshot.state;
    const order=snapshot.activeOrder;
    const goal=order?.nodes.at(-1)?.nodePosition;
    const pose=snapshot.robotPose;
    const velocity=state?.velocity;
    const speed=velocity&&Number.isFinite(velocity.vx)&&Number.isFinite(velocity.vy)
      ?Math.hypot(velocity.vx??0,velocity.vy??0):undefined;
    const distance=goal&&pose?Math.hypot(goal.x-pose.x,goal.y-pose.y):undefined;
    this.updateVisualizationMotion(snapshot,settings);
    const waitingForBypass=this.lastVisualizationMotionAtMs!==null&&
      snapshot.nowMs-this.lastVisualizationMotionAtMs<settings.localBypassWaitTimeMs;
    const finalSequence=order?.nodes.at(-1)?.sequenceId??Number.POSITIVE_INFINITY;
    const active=Boolean(order&&state?.orderId===order.orderId&&
      (state.lastNodeSequenceId??-1)<finalSequence);
    const rejected=Boolean(order&&(state?.errors??[]).some((error)=>
      referencesOrder(error,order.orderId)&&
      `${error.errorType} ${error.errorLevel}`.toLowerCase().includes('order')));
    const checks:Array<[boolean,string]>=[
      [settings.enabled,'Automatic global replanning is disabled.'],
      [snapshot.stateFresh,'Navigator state is stale.'],
      [snapshot.visualizationFresh,'Navigator visualization is stale.'],
      [state?.operatingMode?.toUpperCase()==='AUTOMATIC','Navigator is not in AUTOMATIC mode.'],
      [active,'No active incomplete Order is being monitored.'],
      [speed!==undefined&&speed<settings.stoppedSpeedThresholdMps,
        'Robot speed is above the stopped threshold.'],
      [distance!==undefined&&distance>settings.minimumGoalDistanceM,
        'Robot is already close to the goal.'],
      [state?.paused!==true,'Robot is paused.'],
      [state?.safetyState?.eStop==='NONE','Emergency stop is active or unknown.'],
      [state?.agvPosition?.positionInitialized===true&&pose?.positionInitialized===true,
        'Localization is not initialized.'],
      [Boolean(pose&&[pose.x,pose.y,pose.theta].every(Number.isFinite)),
        'Localized robot pose is invalid.'],
      [finiteMotionFeedback(snapshot),'Motion Feedback is missing or invalid.'],
      [!rejected,'The active Order has a correlated Order error.'],
      [!waitingForBypass,'Navigator visualization indicates continued motion or bypass activity.'],
    ];
    const failed=checks.find(([passed])=>!passed);
    if(failed){
      this.candidateSinceMs=null;
      return {blocked:false,candidate:false,blockedDurationMs:0,distanceToGoalM:distance,
        speedMps:speed,reason:failed[1],waitingForBypass};
    }
    this.candidateSinceMs??=snapshot.nowMs;
    const blockedDurationMs=Math.max(0,snapshot.nowMs-this.candidateSinceMs);
    return {
      blocked:blockedDurationMs>=settings.blockedTimeoutMs,candidate:true,
      blockedDurationMs,distanceToGoalM:distance,speedMps:speed,
      reason:blockedDurationMs>=settings.blockedTimeoutMs
        ?'Robot remained stopped with an active Order beyond the configured timeout.'
        :'Waiting to confirm that the route remains blocked.',
      waitingForBypass:false,
    };
  }

  private updateVisualizationMotion(
    snapshot:BlockedRouteSnapshot,
    settings:GlobalReplanningSettings,
  ):void{
    const pose=snapshot.visualizationPose;
    const receivedAtMs=snapshot.visualizationReceivedAtMs;
    if(!pose||receivedAtMs===undefined||
      this.lastVisualizationPose?.receivedAtMs===receivedAtMs)return;
    const previous=this.lastVisualizationPose;
    if(previous){
      const elapsedSeconds=(receivedAtMs-previous.receivedAtMs)/1_000;
      if(elapsedSeconds>0){
        const speed=Math.hypot(pose.x-previous.x,pose.y-previous.y)/elapsedSeconds;
        if(speed>=settings.stoppedSpeedThresholdMps)
          this.lastVisualizationMotionAtMs=snapshot.nowMs;
      }
    }
    this.lastVisualizationPose={x:pose.x,y:pose.y,receivedAtMs};
  }
}
