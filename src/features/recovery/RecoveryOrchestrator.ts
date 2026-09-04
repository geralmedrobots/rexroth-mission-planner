import { getLocalMessageAgeMs, isLocalMessageFresh } from '../../domain/robot/TelemetryFreshness';
import type { VdaOrder, VdaState } from '../../domain/types';
import { InstantActionBuilder } from '../../domain/vda5050/InstantActionBuilder';
import { mqttService } from '../../services/MqttService';
import { useAppStore } from '../../stores/appStore';
import { getActiveNavigatorOrderId } from '../mission/dispatchGate';
import { ingestObstaclePayload } from '../replanning/ObstacleIngestion';
import { useGlobalReplanningStore } from '../replanning/globalReplanningStore';
import { TemporaryObstacleMap } from '../replanning/TemporaryObstacleMap';
import type { TemporaryObstacleObservation } from '../replanning/types';
import { RecoveryManager } from './RecoveryManager';
import { createDrivingModeTelemetryProvider } from './DrivingModeTelemetryProvider';
import { findSafeReverseCorridor, isConstantYawReversePathFree, isTurnOnSpotSafe } from './RecoveryGeometry';
import { ReverseRecoveryOrderBuilder } from './ReverseRecoveryOrderBuilder';
import { useRecoveryStore } from './recoveryStore';
import { getRearLaserStatus } from './RecoverySafety';
import {
  confirmsBackwardMotion, requestsTurnOnSpot, supportsBackwardDriving,
} from './RecoveryTelemetry';
import type {
  DrivingModeTelemetryProvider, RecoveryTelemetry,
} from './types';

const wait=(milliseconds:number,signal:AbortSignal):Promise<void>=>new Promise((resolve,reject)=>{
  const timer=setTimeout(resolve,milliseconds);
  signal.addEventListener('abort',()=>{
    clearTimeout(timer);reject(new DOMException('Recovery cancelled.','AbortError'));
  },{once:true});
});

const actionStatus=(state:VdaState|undefined,actionId:string):string|undefined=>{
  const value=(state?.actionStates??[]).find((candidate)=>
    typeof candidate==='object'&&candidate!==null&&
    (candidate as {actionId?:unknown}).actionId===actionId) as
    {actionStatus?:unknown}|undefined;
  return typeof value?.actionStatus==='string'?value.actionStatus.toUpperCase():undefined;
};

const collectObservations=():TemporaryObstacleObservation[]=>{
  const app=useAppStore.getState();
  if(!app.grid||!app.start||!app.activeNavigatorMapId)return [];
  const settings=useGlobalReplanningStore.getState().settings;
  return [
    ingestObstaclePayload({
      payload:app.rawStatePayload??app.state,sourceTopic:app.mqttSettings.topics.state,
      payloadKind:'state',
      receivedAtMs:app.mqttReceiveMetadata.lastStateReceiveTime??0,
      robotPose:app.start,activeMapId:app.activeNavigatorMapId,grid:app.grid,
      clusterDistanceM:settings.obstacleMergeDistanceM,
    }),
    ingestObstaclePayload({
      payload:app.rawVisualizationPayload??app.visualization,
      sourceTopic:app.mqttSettings.topics.visualization,payloadKind:'visualization',
      receivedAtMs:app.mqttReceiveMetadata.lastVisualizationReceiveTime??0,
      robotPose:app.start,activeMapId:app.activeNavigatorMapId,grid:app.grid,
      clusterDistanceM:settings.obstacleMergeDistanceM,
    }),
  ].flatMap((result)=>result.observations);
};

const assertLiveSafety=():void=>{
  const app=useAppStore.getState();
  const failures:string[]=[];
  if(!app.mqttConnected)failures.push('MQTT disconnected');
  if(app.connection?.connectionState?.toUpperCase()!=='ONLINE')failures.push('robot offline');
  if(!isLocalMessageFresh(
    app.mqttReceiveMetadata.lastStateReceiveTime,app.orderSettings.stateStaleTimeoutMs))
    failures.push('state stale');
  if(app.state?.operatingMode?.toUpperCase()!=='AUTOMATIC')failures.push('mode not AUTOMATIC');
  if(app.state?.safetyState?.eStop!=='NONE')failures.push('emergency stop active or unknown');
  if(app.state?.safetyState?.fieldViolation===true)failures.push('field violation active');
  if(app.state?.agvPosition?.positionInitialized!==true||app.start?.positionInitialized!==true)
    failures.push('localization invalid');
  const velocity=app.state?.velocity;
  if(!velocity||![velocity.vx,velocity.vy,velocity.omega].every(Number.isFinite))
    failures.push('motion feedback invalid');
  if(!app.start||![app.start.x,app.start.y,app.start.theta].every(Number.isFinite))
    failures.push('pose invalid');
  if(!app.activeNavigatorMapId)failures.push('mapId missing');
  if(failures.length)throw new Error(`Recovery safety gate failed: ${failures.join('; ')}.`);
};

const assertFreshTelemetry=(
  telemetry:RecoveryTelemetry,
  staleTimeoutMs:number,
):void=>{
  if(telemetry.receivedAtMs===null||Date.now()-telemetry.receivedAtMs>staleTimeoutMs)
    throw new Error(
      'Backward driving mode confirmation is unavailable from the configured telemetry provider.');
};

export const cancelOrderAndWaitFinished=async(
  order:VdaOrder,signal:AbortSignal,
):Promise<void>=>{
  const app=useAppStore.getState();
  const cancel=new InstantActionBuilder().build('cancelOrder',app.orderSettings);
  const actionId=cancel.actions[0]!.actionId;
  await mqttService.publish(
    app.mqttSettings.topics.instantActions,JSON.stringify(cancel),app.mqttSettings.qos,false);
  useRecoveryStore.getState().log('warning','cancelOrder published for recovery transition.',{
    orderId:order.orderId,actionId,
  });
  let finished=false;let cleared=false;
  const deadline=Date.now()+app.orderSettings.commandTimeoutMs;
  while(Date.now()<deadline){
    if(signal.aborted)throw new DOMException('Recovery cancelled.','AbortError');
    const state=useAppStore.getState().state;
    const status=actionStatus(state,actionId);
    finished=finished||status==='FINISHED';
    cleared=cleared||getActiveNavigatorOrderId(state)!==order.orderId;
    if(status==='FAILED')throw new Error('Navigator rejected cancelOrder during recovery.');
    if(finished&&cleared)return;
    await wait(100,signal);
  }
  throw new Error(
    `cancelOrder was not fully confirmed (action FINISHED=${finished}, old order cleared=${cleared}).`,
  );
};

const cancelOrderWithRetries=async(order:VdaOrder,signal:AbortSignal):Promise<void>=>{
  const maximumAttempts=useRecoveryStore.getState().settings.retryCount+1;
  let lastError='cancelOrder failed.';
  for(let attempt=1;attempt<=maximumAttempts;attempt+=1){
    try{
      await cancelOrderAndWaitFinished(order,signal);
      return;
    }catch(error){
      lastError=error instanceof Error?error.message:String(error);
      useRecoveryStore.getState().log('warning','Recovery cancellation attempt failed.',{
        attempt,maximumAttempts,error:lastError,
      });
      if(attempt<maximumAttempts)await wait(500,signal);
    }
  }
  throw new Error(lastError);
};

const waitForRecoveryAcceptance=async(order:VdaOrder,signal:AbortSignal):Promise<void>=>{
  const app=useAppStore.getState();
  const deadline=Date.now()+app.orderSettings.acceptanceTimeoutMs;
  while(Date.now()<deadline){
    if(signal.aborted)throw new DOMException('Recovery cancelled.','AbortError');
    const state=useAppStore.getState().state;
    const rejection=(state?.errors??[]).find((error)=>
      (error.errorReferences??[]).some((reference)=>
        reference.referenceValue===order.orderId));
    if(rejection)throw new Error(rejection.errorDescription??'Navigator rejected recovery Order.');
    if(state?.orderId===order.orderId)return;
    await wait(100,signal);
  }
  throw new Error('Reverse recovery Order acceptance timed out.');
};

export interface RecoveryCycleInput {
  originalOrder:VdaOrder;
  signal:AbortSignal;
  runGlobalReplan:(originalOrder:VdaOrder,signal:AbortSignal)=>Promise<void>;
}

export const runRecoveryCycle=async(input:RecoveryCycleInput):Promise<void>=>{
  const store=useRecoveryStore.getState();
  const manager=new RecoveryManager();
  let recoveryOrderToStop:VdaOrder|undefined;
  let telemetryProvider:DrivingModeTelemetryProvider|undefined;
  const update=(next:Parameters<RecoveryManager['transition']>[0],
    patch:Parameters<typeof store.setRuntime>[0]={}):void=>{
    manager.transition(next);useRecoveryStore.getState().setRuntime({state:next,...patch});
  };
  try{
    assertLiveSafety();
    const app=useAppStore.getState();
    if(!app.grid||!app.start||!app.activeNavigatorMapId)
      throw new Error('Recovery map, pose or mapId is unavailable.');
    manager.transition('BLOCKED_CONFIRMED');
    store.setRuntime({
      state:'BLOCKED_CONFIRMED',forwardBlocked:true,reason:'Blocked route confirmed.',
      lastError:undefined,recoveryResult:undefined,globalReplanResult:undefined,
    });
    store.log('warning','Forward route blockage confirmed.',{
      orderId:input.originalOrder.orderId,stateAgeMs:getLocalMessageAgeMs(
        app.mqttReceiveMetadata.lastStateReceiveTime),
    });

    const observations=collectObservations();
    const rear=getRearLaserStatus(
      observations,app.orderSettings.stateStaleTimeoutMs);
    store.setRuntime({rearObstacleCount:rear.count});
    if(store.settings.requireRearLaserData&&!rear.fresh)
      throw new Error('Laser 2/rear obstacle data is missing or stale.');

    const replanningSettings=useGlobalReplanningStore.getState().settings;
    const temporaryMap=new TemporaryObstacleMap().build(
      app.grid,observations,app.footprint,replanningSettings,
      app.activeNavigatorMapId,Date.now(),app.start);
    const geometry={
      grid:temporaryMap.grid,pose:app.start,footprint:app.footprint,observations,
      // The dedicated recovery Order uses exactly the configured recovery distance.
      settings:{
        ...store.settings,
        maximumReverseDistanceM:store.settings.reverseDistanceM,
      },
      sampleIntervalM:app.plannerOptions.collisionSampleInterval,
    };
    update('CHECK_TURN_SPACE');
    const turnSafe=isTurnOnSpotSafe(geometry);
    store.setRuntime({turnSpaceAvailable:turnSafe});
    store.log('info','Turn-on-spot geometry checked.',{
      turnSpaceAvailable:turnSafe,rearObstacleCount:rear.count,
    });
    if(turnSafe){
      update('GLOBAL_REPLAN',{reason:'Turn space is available; reverse recovery is unnecessary.'});
      await input.runGlobalReplan(input.originalOrder,input.signal);
      update('IDLE',{globalReplanResult:'completed',recoveryResult:'not required'});
      return;
    }

    update('CHECK_REVERSE_SPACE');
    telemetryProvider=createDrivingModeTelemetryProvider({
      source:store.settings.telemetry.source,
      settings:store.settings.telemetry.ctrlx,
      mqttPayloads:()=>{
        const current=useAppStore.getState();
        return {
          values:[current.rawStatePayload,current.rawVisualizationPayload],
          receivedAtMs:Math.max(
            current.mqttReceiveMetadata.lastStateReceiveTime??0,
            current.mqttReceiveMetadata.lastVisualizationReceiveTime??0,
          )||null,
        };
      },
    });
    store.setRuntime({
      telemetryProvider:telemetryProvider.source,
      telemetryConnectionState:'connecting',
      backwardConfirmationState:'waiting',
    });
    let telemetry:RecoveryTelemetry;
    try{
      await telemetryProvider.connect();
      telemetry=await telemetryProvider.read();
    }catch(error){
      store.setRuntime({
        telemetryConnectionState:telemetryProvider.getConnectionState(),
        backwardConfirmationState:'unavailable',
      });
      store.log('error','Driving-mode telemetry provider is unavailable.',{
        provider:telemetryProvider.source,
        error:error instanceof Error?error.message:String(error),
      });
      throw new Error(
        'Backward driving mode confirmation is unavailable from the configured telemetry provider.');
    }
    assertFreshTelemetry(telemetry,store.settings.telemetry.ctrlx.staleTimeoutMs);
    store.setRuntime({
      telemetryProvider:telemetry.provider,
      telemetryConnectionState:telemetry.connectionState,
      telemetryLastUpdateAtMs:telemetry.receivedAtMs,
      telemetryAgeMs:telemetry.receivedAtMs===null
        ?Number.POSITIVE_INFINITY:Date.now()-telemetry.receivedAtMs,
      requestedDrivingMode:telemetry.requestDrivingMode,
      commandedVx:telemetry.commandedVx,
      commandedYawRate:telemetry.commandedYawRate,
    });
    store.log('info','Driving-mode telemetry provider connected.',{
      provider:telemetry.provider,connectionState:telemetry.connectionState,
      availableDrivingModes:telemetry.availableDrivingModes,
      requestDrivingMode:telemetry.requestDrivingMode,
      commandedVx:telemetry.commandedVx,commandedYawRate:telemetry.commandedYawRate,
    });
    if(!supportsBackwardDriving(telemetry))
      throw new Error('Backward driving mode 0x02 is not listed in availableDrivingModes.');

    const corridor=findSafeReverseCorridor(geometry);
    store.setRuntime({
      reverseSpaceAvailable:corridor.safe,
      reverseDistanceSelectedM:corridor.safe?corridor.distanceM:undefined,
    });
    store.log(corridor.safe?'info':'error','Backward recovery corridor checked.',{
      reverseSpaceAvailable:corridor.safe,reverseDistanceM:corridor.distanceM,
      rearObstacleCount:rear.count,reason:corridor.reason,
    });
    if(!corridor.safe||!corridor.target)throw new Error(corridor.reason);

    update('BUILD_REVERSE_ORDER');
    const recoveryOrder=new ReverseRecoveryOrderBuilder().build({
      currentPose:app.start,reverseDistanceM:corridor.distanceM,
      activeMapId:app.activeNavigatorMapId,orderSettings:app.orderSettings,
    });
    store.setRuntime({
      recoveryOrder,recoveryOrderId:recoveryOrder.orderId,
      reversePath:[app.start,corridor.target],
    });
    store.log('info','Recovery Order generated.',{
      recoveryOrderId:recoveryOrder.orderId,
      currentPose:{x:app.start.x,y:app.start.y,theta:app.start.theta},
      currentHeadingRad:app.start.theta,
      recoveryNode:{
        x:recoveryOrder.nodes[1]!.nodePosition.x,
        y:recoveryOrder.nodes[1]!.nodePosition.y,
        theta:recoveryOrder.nodes[1]!.nodePosition.theta,
      },
      recoveryDistanceM:corridor.distanceM,
      node0Theta:recoveryOrder.nodes[0]!.nodePosition.theta,
      node1Theta:recoveryOrder.nodes[1]!.nodePosition.theta,
      thetaPreserved:
        recoveryOrder.nodes[0]!.nodePosition.theta===
        recoveryOrder.nodes[1]!.nodePosition.theta,
      generatedEdge:recoveryOrder.edges[0],
      rotationAllowed:recoveryOrder.edges[0]!.rotationAllowed,
      maxSpeedMps:app.orderSettings.missionMaximumSpeedMps,
    });

    update('SEND_REVERSE_ORDER');
    await cancelOrderWithRetries(input.originalOrder,input.signal);
    assertLiveSafety();
    const live=useAppStore.getState();
    if(!live.start||!live.grid||!live.activeNavigatorMapId)
      throw new Error('Live recovery prerequisites disappeared after cancellation.');
    const liveObservations=collectObservations();
    const liveRear=getRearLaserStatus(
      liveObservations,live.orderSettings.stateStaleTimeoutMs);
    if(store.settings.requireRearLaserData&&!liveRear.fresh)
      throw new Error('Laser 2/rear obstacle data became stale before recovery publication.');
    const liveMap=new TemporaryObstacleMap().build(
      live.grid,liveObservations,live.footprint,replanningSettings,
      live.activeNavigatorMapId,Date.now(),live.start);
    if(!isConstantYawReversePathFree({
      grid:liveMap.grid,pose:live.start,footprint:live.footprint,
      observations:liveObservations,settings:store.settings,
      sampleIntervalM:live.plannerOptions.collisionSampleInterval,
    },corridor.distanceM))throw new Error(
      'Backward corridor became occupied after cancellation; recovery Order was not sent.');
    const liveOrder=new ReverseRecoveryOrderBuilder().build({
      currentPose:live.start,reverseDistanceM:corridor.distanceM,
      activeMapId:live.activeNavigatorMapId,orderSettings:live.orderSettings,
    });
    const payload=JSON.stringify(liveOrder);
    await mqttService.publish(
      live.mqttSettings.topics.order,payload,live.mqttSettings.qos,false);
    recoveryOrderToStop=liveOrder;
    live.set({
      generatedOrder:liveOrder,sentOrder:liveOrder,sentOrderPublishedAtMs:Date.now(),
      finalPath:liveOrder.nodes.map((node)=>node.nodePosition),
    });
    store.setRuntime({
      recoveryOrder:liveOrder,recoveryOrderId:liveOrder.orderId,
      reversePath:liveOrder.nodes.map((node)=>({
        ...node.nodePosition,positionInitialized:true,
      })),
    });
    store.log('warning','Reverse recovery Order published.',{
      orderId:liveOrder.orderId,topic:live.mqttSettings.topics.order,
      payloadBytes:new TextEncoder().encode(payload).byteLength,
      publishedOrder:payload,
    });

    update('WAIT_REVERSE_ACCEPTANCE');
    store.log('info','Waiting for Navigator backward-driving request.',{
      recoveryOrderId:liveOrder.orderId,
      expectedRequestDrivingMode:0x02,
      expectedMotionCommandVx:'< 0',
      telemetryProvider:telemetryProvider.source,
      node0Theta:liveOrder.nodes[0]!.nodePosition.theta,
      node1Theta:liveOrder.nodes[1]!.nodePosition.theta,
      rotationAllowed:liveOrder.edges[0]!.rotationAllowed,
    });
    await waitForRecoveryAcceptance(liveOrder,input.signal);
    store.log('info','Reverse recovery Order accepted.',{orderId:liveOrder.orderId});
    const reverseStart={...live.start};
    const motionDeadline=Date.now()+Math.min(60_000,Math.max(
      live.orderSettings.commandTimeoutMs,
      corridor.distanceM/live.orderSettings.missionMaximumSpeedMps*1_000+10_000));
    let reverseMotionConfirmed=false;
    let previousDrivingMode:number|null|undefined;
    let previousCommandedVx:number|null|undefined;
    update('REVERSING');
    while(Date.now()<motionDeadline){
      if(input.signal.aborted)throw new DOMException('Recovery cancelled.','AbortError');
      assertLiveSafety();
      const current=useAppStore.getState();
      let currentTelemetry:RecoveryTelemetry;
      try{
        currentTelemetry=await telemetryProvider.read();
        assertFreshTelemetry(
          currentTelemetry,store.settings.telemetry.ctrlx.staleTimeoutMs);
      }catch(error){
        store.log('error','Driving-mode telemetry update failed.',{
          provider:telemetryProvider.source,
          error:error instanceof Error?error.message:String(error),
        });
        throw new Error(
          'Backward driving mode confirmation is unavailable from the configured telemetry provider.');
      }
      store.setRuntime({
        telemetryProvider:currentTelemetry.provider,
        telemetryConnectionState:telemetryProvider.getConnectionState(),
        telemetryLastUpdateAtMs:currentTelemetry.receivedAtMs,
        telemetryAgeMs:currentTelemetry.receivedAtMs===null
          ?Number.POSITIVE_INFINITY:Date.now()-currentTelemetry.receivedAtMs,
        requestedDrivingMode:currentTelemetry.requestDrivingMode,
        commandedVx:currentTelemetry.commandedVx,
        commandedYawRate:currentTelemetry.commandedYawRate,
        backwardConfirmationState:confirmsBackwardMotion(currentTelemetry)
          ?'confirmed':currentTelemetry.requestDrivingMode===0x04
            ?'turn-on-spot':currentTelemetry.requestDrivingMode===0x01
              ?'forward':'waiting',
      });
      if(currentTelemetry.requestDrivingMode!==previousDrivingMode||
        currentTelemetry.commandedVx!==previousCommandedVx){
        store.log(
          currentTelemetry.requestDrivingMode===0x02&&
            (currentTelemetry.commandedVx??0)<0?'info':'warning',
          'Navigator recovery motion request updated.',{
            recoveryOrderId:liveOrder.orderId,
            requestDrivingMode:currentTelemetry.requestDrivingMode,
            expectedRequestDrivingMode:0x02,
            motionCommandVx:currentTelemetry.commandedVx,
            motionCommandYawRate:currentTelemetry.commandedYawRate,
            telemetryProvider:currentTelemetry.provider,
          });
        previousDrivingMode=currentTelemetry.requestDrivingMode;
        previousCommandedVx=currentTelemetry.commandedVx;
      }
      if(requestsTurnOnSpot(currentTelemetry)){
        await cancelOrderWithRetries(liveOrder,input.signal);
        recoveryOrderToStop=undefined;
        throw new Error('Navigator requested turn-on-spot mode 0x04; reverse recovery aborted.');
      }
      if(currentTelemetry.requestDrivingMode===0x01){
        await cancelOrderWithRetries(liveOrder,input.signal);
        recoveryOrderToStop=undefined;
        throw new Error('Navigator requested forward mode 0x01; reverse recovery aborted.');
      }
      if(!supportsBackwardDriving(currentTelemetry)){
        await cancelOrderWithRetries(liveOrder,input.signal);
        recoveryOrderToStop=undefined;
        throw new Error('Backward driving mode 0x02 became unavailable; recovery stopped.');
      }
      if(confirmsBackwardMotion(currentTelemetry))
        reverseMotionConfirmed=true;

      const currentObservations=collectObservations();
      const currentRear=getRearLaserStatus(
        currentObservations,current.orderSettings.stateStaleTimeoutMs);
      if(store.settings.requireRearLaserData&&!currentRear.fresh){
        await cancelOrderWithRetries(liveOrder,input.signal);
        recoveryOrderToStop=undefined;
        throw new Error('Laser 2 became stale during reverse recovery; recovery stopped.');
      }
      if(current.grid&&current.start&&current.activeNavigatorMapId){
        const currentMap=new TemporaryObstacleMap().build(
          current.grid,currentObservations,current.footprint,replanningSettings,
          current.activeNavigatorMapId,Date.now(),current.start);
        const remaining=Math.max(0,corridor.distanceM-Math.hypot(
          current.start.x-reverseStart.x,current.start.y-reverseStart.y));
        if(remaining>0.02&&!isConstantYawReversePathFree({
          grid:currentMap.grid,pose:current.start,footprint:current.footprint,
          observations:currentObservations,settings:store.settings,
          sampleIntervalM:current.plannerOptions.collisionSampleInterval,
        },remaining)){
          await cancelOrderWithRetries(liveOrder,input.signal);
          recoveryOrderToStop=undefined;
          throw new Error('A rear obstacle entered the recovery corridor; recovery stopped.');
        }
      }
      const distance=current.start?Math.hypot(
        current.start.x-reverseStart.x,current.start.y-reverseStart.y):0;
      if(reverseMotionConfirmed&&distance>=corridor.distanceM-0.05)break;
      await wait(
        Math.max(20,store.settings.telemetry.ctrlx.pollingIntervalMs),input.signal);
    }
    if(!reverseMotionConfirmed)
      throw new Error('Navigator never confirmed backward mode 0x02 with negative motionCommand.v_x.');
    const completedPose=useAppStore.getState().start;
    const travelled=completedPose?Math.hypot(
      completedPose.x-reverseStart.x,completedPose.y-reverseStart.y):0;
    if(travelled<corridor.distanceM-0.05)
      throw new Error('Reverse recovery did not reach the requested distance before timeout.');
    update('REVERSE_COMPLETED',{
      recoveryResult:'completed',reason:`Reversed ${travelled.toFixed(3)} m.`,
    });
    store.log('info','Reverse recovery completed.',{
      requestedDistanceM:corridor.distanceM,travelledDistanceM:travelled,
      requestedDrivingMode:0x02,
    });
    if(getActiveNavigatorOrderId(useAppStore.getState().state)===liveOrder.orderId)
      await cancelOrderWithRetries(liveOrder,input.signal);
    recoveryOrderToStop=undefined;
    update('GLOBAL_REPLAN',{reason:'Replanning globally from recovered pose.'});
    await input.runGlobalReplan(input.originalOrder,input.signal);
    update('IDLE',{globalReplanResult:'completed',reason:'Recovery and global replanning completed.'});
  }catch(error){
    if((error as {name?:unknown}).name==='AbortError')throw error;
    const message=error instanceof Error?error.message:String(error);
    if(recoveryOrderToStop&&
      getActiveNavigatorOrderId(useAppStore.getState().state)===recoveryOrderToStop.orderId){
      try{
        const app=useAppStore.getState();
        const cancel=new InstantActionBuilder().build('cancelOrder',app.orderSettings);
        await mqttService.publish(
          app.mqttSettings.topics.instantActions,JSON.stringify(cancel),
          app.mqttSettings.qos,false);
        useRecoveryStore.getState().log(
          'error','Immediate cancelOrder published after recovery safety failure.',{
            recoveryOrderId:recoveryOrderToStop.orderId,reason:message,
          });
      }catch(cancelError){
        useRecoveryStore.getState().log(
          'error','Unable to publish immediate recovery cancelOrder.',{
            recoveryOrderId:recoveryOrderToStop.orderId,
            error:cancelError instanceof Error?cancelError.message:String(cancelError),
          });
      }
    }
    if(manager.state!=='FAILED')manager.transition('FAILED');
    useRecoveryStore.getState().setRuntime({
      state:'FAILED',lastError:message,recoveryResult:'failed',reason:message,
    });
    useRecoveryStore.getState().log('error','Blocked-robot recovery failed safely.',{
      error:message,
    });
    throw error;
  }finally{
    const finalProviderState=telemetryProvider?.getConnectionState()??'disabled';
    await telemetryProvider?.disconnect();
    const currentStore=useRecoveryStore.getState();
    if(currentStore.runtime.telemetryConnectionState!=='disabled')
      currentStore.setRuntime({
        telemetryConnectionState:finalProviderState==='error'?'error':'disconnected',
      });
  }
};
