import { useEffect, useRef } from 'react';
import { normalizeAngle } from '../../domain/geometry/angles';
import { PathCollisionValidator } from '../../domain/planner/PathCollisionValidator';
import { getLocalMessageAgeMs, isLocalMessageFresh } from '../../domain/robot/TelemetryFreshness';
import { selectCurrentRobotPose } from '../../domain/robot/RobotPoseSelector';
import type { VdaError, VdaOrder, VdaState } from '../../domain/types';
import { InstantActionBuilder } from '../../domain/vda5050/InstantActionBuilder';
import { VdaOrderBuilder } from '../../domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator, type OrderValidationContext } from '../../domain/vda5050/VdaOrderValidator';
import { mqttService } from '../../services/MqttService';
import { useAppStore } from '../../stores/appStore';
import { useLocatorStore } from '../locator/stores/locatorStore';
import { getActiveNavigatorOrderId } from '../mission/dispatchGate';
import { runRecoveryCycle } from '../recovery/RecoveryOrchestrator';
import { useRecoveryStore } from '../recovery/recoveryStore';
import { BlockedRouteDetector } from './BlockedRouteDetector';
import { GlobalPlanningError, GlobalReplanner } from './GlobalReplanner';
import { ingestObstaclePayload } from './ObstacleIngestion';
import { TemporaryObstacleMap } from './TemporaryObstacleMap';
import { StartProjectionError } from './StartPoseProjector';
import { useGlobalReplanningStore } from './globalReplanningStore';
import type {
  GlobalReplanResult, ObstacleIngestionDiagnostic, TemporaryMapResult,
} from './types';

const delay=(milliseconds:number,signal:AbortSignal):Promise<void>=>new Promise((resolve,reject)=>{
  const timer=setTimeout(resolve,milliseconds);
  signal.addEventListener('abort',()=>{
    clearTimeout(timer);reject(new DOMException('Replanning cancelled.','AbortError'));
  },{once:true});
});

export const isPostReplacementGraceActive=(
  lastCompletedAt:string|undefined,
  graceMs:number,
  nowMs=Date.now(),
):boolean=>{
  if(!lastCompletedAt||graceMs<=0)return false;
  const completedAtMs=Date.parse(lastCompletedAt);
  return Number.isFinite(completedAtMs)&&nowMs-completedAtMs<graceMs;
};

const errorReferencesOrder=(error:VdaError,orderId:string):boolean=>
  (error.errorReferences??[]).some((reference)=>
    reference.referenceKey.toLowerCase().endsWith('orderid')&&reference.referenceValue===orderId);

const actionStatus=(state:VdaState|undefined,actionId:string):string|undefined=>{
  const action=(state?.actionStates??[]).find((item)=>{
    if(typeof item!=='object'||item===null)return false;
    return (item as {actionId?:unknown}).actionId===actionId;
  }) as {actionStatus?:unknown}|undefined;
  return typeof action?.actionStatus==='string'?action.actionStatus.toUpperCase():undefined;
};

const notify=(severity:'success'|'warning'|'error',message:string):void=>{
  window.dispatchEvent(new CustomEvent('global-replanning-notification',{
    detail:{severity,message},
  }));
};

const aggregateObstacleDiagnostic=(
  diagnostics:ObstacleIngestionDiagnostic[],
  temporaryMap:TemporaryMapResult,
):ObstacleIngestionDiagnostic=>({
  sourceTopic:'temporary-map aggregate',payloadKind:'visualization',
  rawPointCount:diagnostics.reduce((sum,item)=>sum+item.rawPointCount,0),
  transformedPointCount:diagnostics.reduce((sum,item)=>sum+item.transformedPointCount,0),
  rejectedPointCount:diagnostics.reduce((sum,item)=>sum+item.rejectedPointCount,0),
  obstacleClusterCount:temporaryMap.acceptedObservations.length,
  insertedOccupiedCells:temporaryMap.obstacleCells.length,
  inflatedCells:temporaryMap.inflatedObstacleCells.length,
  sourcePaths:diagnostics.flatMap((item)=>item.sourcePaths),
  frameModes:[...new Set(diagnostics.flatMap((item)=>item.frameModes))],
  dataAgeMs:diagnostics.length?Math.max(...diagnostics.map((item)=>item.dataAgeMs)):0,
});

export const useGlobalReplanning=():void=>{
  const detector=useRef(new BlockedRouteDetector());
  const running=useRef(false);

  useEffect(()=>{
    const controller=new AbortController();
    const interval=setInterval(()=>{
      const app=useAppStore.getState();
      const replanning=useGlobalReplanningStore.getState();
      const settings=replanning.settings;
      if(!settings.enabled){
        detector.current.reset();
        if(replanning.runtime.status!=='DISABLED')
          replanning.setRuntime({status:'DISABLED',blockedDurationMs:0});
        return;
      }
      const nowMs=Date.now();
      if(['ACTIVE','COMPLETED'].includes(replanning.runtime.status)&&
        isPostReplacementGraceActive(
        replanning.runtime.lastCompletedAt,settings.postReplacementGraceMs,nowMs)){
        detector.current.reset();
        replanning.setRuntime({
          status:'COMPLETED',blockedDurationMs:0,
          reason:'Waiting for Navigator to start the accepted replacement Order.',
        });
        return;
      }
      const stateFresh=isLocalMessageFresh(
        app.mqttReceiveMetadata.lastStateReceiveTime,
        app.orderSettings.stateStaleTimeoutMs,nowMs);
      const visualizationFresh=isLocalMessageFresh(
        app.mqttReceiveMetadata.lastVisualizationReceiveTime,
        app.orderSettings.stateStaleTimeoutMs,nowMs);
      const poseSnapshot=selectCurrentRobotPose({
        state:app.state,visualization:app.visualization,
        lastStateReceiveTime:app.mqttReceiveMetadata.lastStateReceiveTime??undefined,
        lastVisualizationReceiveTime:app.mqttReceiveMetadata.lastVisualizationReceiveTime??undefined,
        stateFresh,visualizationFresh,
        activeMapResolution:{
          mapId:app.activeNavigatorMapId,source:app.activeNavigatorMapSource,
        },
      });
      if(replanning.runtime.status==='WAITING_FOR_OBSTACLE_DATA'){
        if(!app.grid||!poseSnapshot?.pose||!app.activeNavigatorMapId)return;
        const obstacleDataAvailable=[
          ingestObstaclePayload({
            payload:app.rawStatePayload??app.state,
            sourceTopic:app.mqttSettings.topics.state,payloadKind:'state',
            receivedAtMs:app.mqttReceiveMetadata.lastStateReceiveTime??nowMs,
            robotPose:poseSnapshot.pose,activeMapId:app.activeNavigatorMapId,
            grid:app.grid,clusterDistanceM:settings.obstacleMergeDistanceM,
          }),
          ingestObstaclePayload({
            payload:app.rawVisualizationPayload??app.visualization,
            sourceTopic:app.mqttSettings.topics.visualization,
            payloadKind:'visualization',
            receivedAtMs:app.mqttReceiveMetadata.lastVisualizationReceiveTime??nowMs,
            robotPose:poseSnapshot.pose,activeMapId:app.activeNavigatorMapId,
            grid:app.grid,clusterDistanceM:settings.obstacleMergeDistanceM,
          }),
        ].some((ingestion)=>ingestion.observations.length>0);
        // WAITING is stable. Do not restart the same failed cycle every 250 ms;
        // resume automatically only when a supported coordinate source appears.
        if(!obstacleDataAvailable)return;
        replanning.setRuntime({
          status:'BLOCKED',
          reason:'Supported obstacle coordinates became available; retrying global replanning.',
        });
        replanning.log('TemporaryMap','info',
          'Supported obstacle coordinates became available; resuming global replanning.');
      }
      const recoverySettings=useRecoveryStore.getState().settings;
      const detectorSettings=recoverySettings.enabled
        ?{...settings,blockedTimeoutMs:recoverySettings.blockedTimeoutMs}:settings;
      const decision=detector.current.update({
        nowMs,state:app.state,activeOrder:app.sentOrder,robotPose:poseSnapshot?.pose,
        stateFresh,visualizationFresh,visualizationPose:app.visualization?.agvPosition,
        visualizationReceivedAtMs:
          app.mqttReceiveMetadata.lastVisualizationReceiveTime??undefined,
      },detectorSettings);
      if(!running.current&&!['FAILED','WAITING_FOR_OBSTACLE_DATA',
        'NO_MEANINGFUL_ALTERNATIVE'].includes(replanning.runtime.status))
        replanning.setRuntime({
          status:decision.blocked?'BLOCKED':'MONITORING',
          reason:decision.reason,blockedDurationMs:decision.blockedDurationMs,
          blockedSinceMs:decision.candidate?nowMs-decision.blockedDurationMs:undefined,
        });
      if(decision.blocked&&!running.current&&
        nowMs>=(replanning.runtime.nextRetryAtMs??0)&&
        replanning.runtime.retryCount<settings.maximumRetries){
        running.current=true;
        const originalOrder=app.sentOrder;
        const operation=recoverySettings.enabled&&originalOrder
          ?runRecoveryCycle({
            originalOrder,signal:controller.signal,
            runGlobalReplan:async(order,signal)=>{
              await runReplanningCycle(
                signal,detector.current,{originalOrder:order,skipBlockedRecheck:true});
              const resultStatus=useGlobalReplanningStore.getState().runtime.status;
              if(resultStatus!=='COMPLETED'&&resultStatus!=='ACTIVE')
                throw new Error(
                  `Global replanning after recovery ended in state ${resultStatus}.`);
            },
          })
          :runReplanningCycle(controller.signal,detector.current);
        void operation
          .catch((error)=>{
            if((error as {name?:unknown}).name!=='AbortError'){
              const message=error instanceof Error?error.message:String(error);
              useGlobalReplanningStore.getState().setRuntime({
                status:'FAILED',lastError:message,reason:message,
              });
            }
          })
          .finally(()=>{running.current=false;});
      }
    },250);
    return()=>{clearInterval(interval);controller.abort();};
  },[]);
};

const runReplanningCycle=async(
  signal:AbortSignal,
  detector:BlockedRouteDetector,
  options?:{originalOrder?:VdaOrder;skipBlockedRecheck?:boolean},
):Promise<void>=>{
  const replanning=useGlobalReplanningStore.getState();
  const settings=replanning.settings;
  const appAtBlock=useAppStore.getState();
  const activeOrder=options?.originalOrder??appAtBlock.sentOrder;
  const pose=appAtBlock.start;
  const mapId=appAtBlock.activeNavigatorMapId;
  if(!activeOrder||!pose||!mapId||!appAtBlock.grid){
    replanning.setRuntime({status:'FAILED',lastError:'Replanning prerequisites disappeared.'});
    return;
  }
  const originalPath=activeOrder.nodes.map((node)=>node.nodePosition);
  const remaining=activeOrder.nodes.filter((node)=>
    node.sequenceId>(appAtBlock.state?.lastNodeSequenceId??-1)).map((node)=>node.nodePosition);
  replanning.setRuntime({
    status:'PLANNING',reason:'Confirmed blocked route.',originalPath,
    blockedPath:[pose,...remaining],newPath:[],attempt:0,lastError:undefined,
  });
  replanning.log('BlockedRouteDetector','warning','Robot blocked.',{
    blockedDurationMs:replanning.runtime.blockedDurationMs,
    speedMps:appAtBlock.state?.velocity?Math.hypot(
      appAtBlock.state.velocity.vx??0,appAtBlock.state.velocity.vy??0):undefined,
    activeOrderId:activeOrder.orderId,
  });
  let result:GlobalReplanResult|undefined;
  let plannedGrid = appAtBlock.grid;
  let lastError='No alternative route found.';
  let acceptedIngestionDiagnostics:ObstacleIngestionDiagnostic[]=[];
  for(let attempt=1;attempt<=settings.maximumPlanningAttempts;attempt+=1){
    if(signal.aborted)return;
    const live=useAppStore.getState();
    const livePose=live.start;
    if(!live.grid||!livePose||!live.activeNavigatorMapId)break;
    replanning.setRuntime({status:'PLANNING',attempt});
    const ingestions=[
      ingestObstaclePayload({
        payload:live.rawStatePayload??live.state,
        sourceTopic:live.mqttSettings.topics.state,payloadKind:'state',
        receivedAtMs:live.mqttReceiveMetadata.lastStateReceiveTime??Date.now(),
        robotPose:livePose,activeMapId:live.activeNavigatorMapId,grid:live.grid,
        clusterDistanceM:settings.obstacleMergeDistanceM,
      }),
      ingestObstaclePayload({
        payload:live.rawVisualizationPayload??live.visualization,
        sourceTopic:live.mqttSettings.topics.visualization,payloadKind:'visualization',
        receivedAtMs:live.mqttReceiveMetadata.lastVisualizationReceiveTime??Date.now(),
        robotPose:livePose,activeMapId:live.activeNavigatorMapId,grid:live.grid,
        clusterDistanceM:settings.obstacleMergeDistanceM,
      }),
    ];
    const sensorObservations=ingestions.flatMap((item)=>item.observations);
    const observations=[...sensorObservations];
    const ingestionDiagnostics=ingestions.map((item)=>item.diagnostic);
    replanning.setRuntime({obstacleIngestionDiagnostics:ingestionDiagnostics});
    ingestionDiagnostics.forEach((diagnostic)=>replanning.log(
      'TemporaryMap',diagnostic.rejectedPointCount?'warning':'debug',
      `Obstacle ingestion ${diagnostic.payloadKind}: `+
      `${diagnostic.rawPointCount} raw, ${diagnostic.transformedPointCount} transformed, `+
      `${diagnostic.rejectedPointCount} rejected, `+
      `${diagnostic.obstacleClusterCount} clusters.`,{...diagnostic},
    ));
    replanning.log('TemporaryMap','info',
      `Temporary obstacles: ${sensorObservations.length} sensor, `+
      `0 inferred, `+
      `${observations.length} total.`,{
        attempt,sensorObservationCount:sensorObservations.length,
        inferredObservationCount:0,
        observationCount:observations.length,
        sources:observations.map((observation)=>({
        source:observation.source,path:observation.sourcePath,points:observation.points.length,
      })),
    });
    if(observations.length===0){
      lastError='WAITING_FOR_OBSTACLE_DATA';
      replanning.setRuntime({
        status:'WAITING_FOR_OBSTACLE_DATA',
        reason:'WAITING_FOR_OBSTACLE_DATA',
        temporaryObstacleCount:0,
      });
      replanning.log('TemporaryMap','warning',
        'WAITING_FOR_OBSTACLE_DATA: no supported live obstacle coordinates are available.');
      break;
    }
    try{
      plannedGrid = live.grid;
      result=await new GlobalReplanner().calculate({
        originalMap:live.grid,observations,robotPose:livePose,
        activeMapId:live.activeNavigatorMapId,activeOrder,
        footprint:live.footprint,plannerOptions:live.plannerOptions,
        orderSettings:live.orderSettings,replanningSettings:settings,
      });
      const mapDiagnostic=aggregateObstacleDiagnostic(
        ingestionDiagnostics,result.temporaryMap);
      ingestionDiagnostics.push(mapDiagnostic);
      acceptedIngestionDiagnostics=ingestionDiagnostics;
      replanning.log('TemporaryMap','info',
        `Temporary grid: ${mapDiagnostic.insertedOccupiedCells} occupied cells, `+
        `${mapDiagnostic.inflatedCells} inflated cells.`,{...mapDiagnostic});
      replanning.log('GlobalPlanner','info',
        result.startProjection.success
          ?`Planning start projection succeeded at ${result.startProjection
            .projectionDistanceM?.toFixed(3)??'0.000'} m.`
          :'Planning start projection was not required.',{
          ...result.startProjection,
        });
      replanning.log('GlobalPlanner',result.planningTimeMs<=200?'info':'warning',
        `Alternative A* route calculated; maximum lateral change `+
        `${result.maximumRouteDeviationM.toFixed(3)} m.`,{
          attempt,planningTimeMs:result.planningTimeMs,
          targetPlanningTimeMs:200,obstacleCount:result.temporaryMap.acceptedObservations.length,
          originalPathLengthM:result.originalPathLengthM,newPathLengthM:result.newPathLengthM,
          maximumRouteDeviationM:result.maximumRouteDeviationM,
          rawPointCount:result.rawPath.length,simplifiedPointCount:result.simplifiedPath.length,
          finalPointCount:result.finalPath.length,
        });
      replanning.log('PathOptimizer','info','Alternative path simplified and collision checked.',{
        rawPointCount:result.rawPath.length,simplifiedPointCount:result.simplifiedPath.length,
        finalPointCount:result.finalPath.length,
      });
      break;
    }catch(error){
      lastError=error instanceof Error?error.message:String(error);
      if(error instanceof StartProjectionError){
        const mapDiagnostic=error.temporaryMap
          ?aggregateObstacleDiagnostic(ingestionDiagnostics,error.temporaryMap):undefined;
        replanning.setRuntime({
          startProjection:error.diagnostic,exploredCells:[],
          temporaryObstacleCells:error.temporaryMap?.obstacleCells??[],
          inflatedTemporaryObstacleCells:error.temporaryMap?.inflatedObstacleCells??[],
          obstacleIngestionDiagnostics:mapDiagnostic
            ?[...ingestionDiagnostics,mapDiagnostic]:ingestionDiagnostics,
        });
        replanning.log('GlobalPlanner','error','No reachable free start cell.',{
          ...error.diagnostic,
        });
        if(mapDiagnostic)replanning.log('TemporaryMap','info',
          `Temporary grid: ${mapDiagnostic.insertedOccupiedCells} occupied cells, `+
          `${mapDiagnostic.inflatedCells} inflated cells.`,{...mapDiagnostic});
      }else if(error instanceof GlobalPlanningError){
        const mapDiagnostic=aggregateObstacleDiagnostic(
          ingestionDiagnostics,error.temporaryMap);
        replanning.setRuntime({
          startProjection:error.startProjection,exploredCells:error.exploredCells,
          temporaryObstacleCells:error.temporaryMap.obstacleCells,
          inflatedTemporaryObstacleCells:error.temporaryMap.inflatedObstacleCells,
          obstacleIngestionDiagnostics:[...ingestionDiagnostics,mapDiagnostic],
        });
        replanning.log('TemporaryMap','info',
          `Temporary grid: ${mapDiagnostic.insertedOccupiedCells} occupied cells, `+
          `${mapDiagnostic.inflatedCells} inflated cells.`,{...mapDiagnostic});
      }
      replanning.log('GlobalPlanner','warning','Replanning attempt failed.',{attempt,error:lastError});
      if(attempt<settings.maximumPlanningAttempts)await delay(settings.retryDelayMs,signal);
    }
  }
  if(!result){
    if(lastError==='WAITING_FOR_OBSTACLE_DATA'){
      notify('warning','WAITING_FOR_OBSTACLE_DATA: the active Order was not cancelled.');
      return;
    }
    const noMeaningful=/unchanged|changes by only/i.test(lastError);
    replanning.setRuntime({
      status:noMeaningful?'NO_MEANINGFUL_ALTERNATIVE':'FAILED',
      retryCount:settings.maximumRetries,nextRetryAtMs:undefined,
      lastError:noMeaningful?'NO_MEANINGFUL_ALTERNATIVE':'No alternative route found.',
      reason:noMeaningful?'NO_MEANINGFUL_ALTERNATIVE':'No alternative route found.',
    });
    replanning.log('GlobalPlanner','error','No alternative route found.',{
      attempts:settings.maximumPlanningAttempts,lastError,
    });
    notify(noMeaningful?'warning':'error',noMeaningful
      ?'NO_MEANINGFUL_ALTERNATIVE: the active Order was not cancelled.'
      :'No alternative route found. The robot remains stopped.');
    return;
  }
  const assertCurrentGrid = () => {
    if (useAppStore.getState().grid !== plannedGrid) throw new Error('Planning map changed during global replanning.');
  };
  if (useAppStore.getState().grid !== plannedGrid) {
    replanning.setRuntime({status:'FAILED',replacementOrder:undefined,lastError:'Planning map changed during global replanning.'});
    return;
  }
  replanning.setRuntime({
    status:'PLANNING',newPath:result.finalPath,
    temporaryObstacleCells:result.temporaryMap.obstacleCells,
    inflatedTemporaryObstacleCells:result.temporaryMap.inflatedObstacleCells,
    temporaryObstacleCount:result.temporaryMap.acceptedObservations.length,
    originalPathLengthM:result.originalPathLengthM,newPathLengthM:result.newPathLengthM,
    planningTimeMs:result.planningTimeMs,replacementOrder:result.order,
    maximumRouteDeviationM:result.maximumRouteDeviationM,
    startProjection:result.startProjection,exploredCells:result.exploredCells,
    obstacleIngestionDiagnostics:acceptedIngestionDiagnostics,
  });
  const current=useAppStore.getState();
  if(!current.start||!current.activeNavigatorMapId){
    replanning.setRuntime({status:'FAILED',lastError:'Current pose or mapId disappeared.'});
    return;
  }
  const liveFinalPath=[
    {x:current.start.x,y:current.start.y,theta:current.start.theta},
    ...result.finalPath.slice(1),
  ];
  const liveCollision=new PathCollisionValidator().findFirstCollision(
    result.temporaryMap.grid,liveFinalPath,{
      ...current.footprint,
      safetyMargin:Math.max(
        current.footprint.safetyMargin,
        current.plannerOptions.passageSafety.wallClearanceMinimumM,
        current.plannerOptions.passageSafety.planningSafetyMarginM+
          current.plannerOptions.passageSafety.localizationMarginM),
    },
    current.plannerOptions.collisionSampleInterval);
  if(liveCollision){
    const message=`Live-pose route segment ${liveCollision.segmentIndex} `+
      'intersects an obstacle or map boundary.';
    replanning.setRuntime({status:'FAILED',lastError:message,reason:message});
    replanning.log('PathOptimizer','error',message,{...liveCollision});
    notify('error','The replacement route is no longer collision-free from the live pose.');
    return;
  }
  result.finalPath=liveFinalPath;
  result.order=new VdaOrderBuilder().build(result.finalPath,{
    robotPose:current.start,activeMapId:current.activeNavigatorMapId,
    finalGoalTheta:activeOrder.nodes.at(-1)?.nodePosition.theta,
    corridorPlanning:{
      grid:result.temporaryMap.grid,footprint:current.footprint,
      plannerOptions:current.plannerOptions,
    },
  },current.orderSettings);
  replanning.setRuntime({replacementOrder:result.order});
  const validationContext:OrderValidationContext={
    mqttConnected:current.mqttConnected,
    stateReceived:current.mqttReceiveMetadata.lastStateReceiveTime!==null,
    connectionReceived:Boolean(current.lastConnectionReceiveTime),
    activeMapId:current.activeNavigatorMapId,currentPose:current.start,
    grid:result.temporaryMap.grid,footprint:current.footprint,settings:current.orderSettings,
    connectionOnline:current.connection?.connectionState?.toUpperCase()==='ONLINE',
    operatingMode:current.state?.operatingMode,
    stateAgeMs:getLocalMessageAgeMs(current.mqttReceiveMetadata.lastStateReceiveTime),
    visualizationAgeMs:getLocalMessageAgeMs(
      current.mqttReceiveMetadata.lastVisualizationReceiveTime),
    positionInitialized:current.state?.agvPosition?.positionInitialized===true,
    poseSource:'visualization',locatorMapName:useLocatorStore.getState().loadedMap?.mapName,
    mapIdSource:current.activeNavigatorMapSource,
    lastStateReceiveTime:current.mqttReceiveMetadata.lastStateReceiveTime,
    corridorSettings:current.plannerOptions.corridor,
  };
  const validation=new VdaOrderValidator().validate(result.order,validationContext);
  if(!validation.valid){
    replanning.setRuntime({status:'FAILED',lastError:'Generated replacement Order is invalid.'});
    replanning.log('OrderGenerator','error','Replacement Order validation failed.',{
      errors:validation.errors,warnings:validation.warnings,
    });
    notify('error','Automatic replanning produced an invalid Order. The robot remains stopped.');
    return;
  }
  replanning.setRuntime({status:'ALTERNATIVE_VALIDATED'});
  current.set({validation});
  replanning.log('OrderGenerator','info','New independent VDA Order generated.',{
    orderId:result.order.orderId,headerId:result.order.headerId,
    orderUpdateId:result.order.orderUpdateId,nodeCount:result.order.nodes.length,
    edgeCount:result.order.edges.length,corridorCount:result.order.edges.filter(
      (edge)=>edge.corridor).length,mapId,
  });
  const stillBlocked=options?.skipBlockedRecheck
    ?undefined:detector.update(buildDetectorSnapshot(),settings);
  if(stillBlocked&&!stillBlocked.blocked){
    replanning.setRuntime({status:'MONITORING',reason:'Robot motion resumed before transition.'});
    replanning.log('BlockedRouteDetector','info','Automatic transition cancelled because motion resumed.');
    return;
  }
  try{
    const activeNavigatorOrderId=getActiveNavigatorOrderId(useAppStore.getState().state);
    if(activeNavigatorOrderId!==null){
      const currentSent=useAppStore.getState().sentOrder;
      const orderToCancel=currentSent?.orderId===activeNavigatorOrderId
        ?currentSent:activeOrder.orderId===activeNavigatorOrderId?activeOrder:undefined;
      if(!orderToCancel)throw new Error(
        `Cannot safely identify active Order "${activeNavigatorOrderId}" for cancellation.`);
      let cancelled=false;let cancellationError='';
      for(let retry=1;retry<=settings.maximumRetries&&!cancelled;retry+=1){
        assertCurrentGrid();
        try{
          replanning.setRuntime({retryCount:retry-1});
          await cancelActiveOrder(orderToCancel,signal);cancelled=true;
        }catch(error){
          cancellationError=error instanceof Error?error.message:String(error);
          replanning.log('OrderPublisher','warning','cancelOrder attempt failed.',{
            retry,maximumRetries:settings.maximumRetries,error:cancellationError,
          });
          if(retry<settings.maximumRetries)await delay(settings.retryDelayMs,signal);
        }
      }
      if(!cancelled)throw new Error(cancellationError||'Unable to clear the active Order.');
    }
    assertCurrentGrid();
    await publishReplacement(result,signal);
    detector.reset();
    replanning.setRuntime({
      status:'COMPLETED',retryCount:0,nextRetryAtMs:undefined,
      lastCompletedAt:new Date().toISOString(),
      reason:'Replacement Order accepted by Navigator.',
    });
    notify('success','A new global route was accepted by ROKIT Navigator.');
  }catch(error){
    if(signal.aborted)return;
    const message=error instanceof Error?error.message:String(error);
    replanning.setRuntime({
      status:'FAILED',retryCount:settings.maximumRetries,
      nextRetryAtMs:undefined,lastError:message,reason:message,replacementOrder:undefined,
    });
    replanning.log('OrderPublisher','error','Automatic Order transition failed.',{
      error:message,retryCount:settings.maximumRetries,
    });
    notify('error',`${message} The robot remains stopped.`);
  }
};

const buildDetectorSnapshot=()=>{
  const app=useAppStore.getState();const nowMs=Date.now();
  const stateFresh=isLocalMessageFresh(
    app.mqttReceiveMetadata.lastStateReceiveTime,app.orderSettings.stateStaleTimeoutMs,nowMs);
  const visualizationFresh=isLocalMessageFresh(
    app.mqttReceiveMetadata.lastVisualizationReceiveTime,
    app.orderSettings.stateStaleTimeoutMs,nowMs);
  return {
    nowMs,state:app.state,activeOrder:app.sentOrder,robotPose:app.start,
    stateFresh,visualizationFresh,visualizationPose:app.visualization?.agvPosition,
    visualizationReceivedAtMs:app.mqttReceiveMetadata.lastVisualizationReceiveTime??undefined,
  };
};

export const cancelActiveOrder=async(order:VdaOrder,signal:AbortSignal):Promise<void>=>{
  const app=useAppStore.getState();const replanning=useGlobalReplanningStore.getState();
  const cancelMessage=new InstantActionBuilder().build('cancelOrder',app.orderSettings);
  const actionId=cancelMessage.actions[0]!.actionId;
  await mqttService.publish(
    app.mqttSettings.topics.instantActions,JSON.stringify(cancelMessage),app.mqttSettings.qos,false);
  replanning.log('OrderPublisher','warning','cancelOrder published before global replacement.',{
    oldOrderId:order.orderId,actionId,
  });
  replanning.setRuntime({status:'CANCEL_SENT'});
  const deadline=Date.now()+app.orderSettings.commandTimeoutMs;
  let finished=false;
  while(Date.now()<deadline){
    if(signal.aborted)throw new DOMException('Replanning cancelled.','AbortError');
    const state=useAppStore.getState().state;
    const status=actionStatus(state,actionId);
    finished=finished||status==='FINISHED';
    replanning.setRuntime({status:finished
      ?'WAITING_OLD_ORDER_CLEAR':'WAITING_CANCEL_ACTION'});
    if(finished&&getActiveNavigatorOrderId(state)!==order.orderId)return;
    if(status==='FAILED')throw new Error('Navigator rejected cancelOrder while the old Order remained active.');
    await delay(100,signal);
  }
  throw new Error(
    `Navigator did not confirm cancelOrder FINISHED and clear the previous Order `+
    `(FINISHED=${finished}).`,
  );
};

export const publishReplacement=async(
  result:GlobalReplanResult,
  signal:AbortSignal,
):Promise<void>=>{
  const app=useAppStore.getState();const replanning=useGlobalReplanningStore.getState();
  replanning.setRuntime({status:'REVALIDATING'});
  if(signal.aborted)throw new DOMException('Replanning cancelled.','AbortError');
  const stateFresh=isLocalMessageFresh(
    app.mqttReceiveMetadata.lastStateReceiveTime,app.orderSettings.stateStaleTimeoutMs);
  const node0=result.order.nodes[0]?.nodePosition;const pose=app.start;
  const node0Matches=Boolean(node0&&pose&&
    Math.hypot(node0.x-pose.x,node0.y-pose.y)<=app.orderSettings.firstNodePositionConsistency&&
    Math.abs(normalizeAngle(node0.theta-pose.theta))<=app.orderSettings.firstNodeAngularConsistency);
  const safetyFailures:string[]=[];
  if(!app.mqttConnected)safetyFailures.push('MQTT disconnected');
  if(!stateFresh)safetyFailures.push('state stale');
  if(app.connection?.connectionState?.toUpperCase()!=='ONLINE')
    safetyFailures.push('robot connection not ONLINE');
  if(app.state?.operatingMode?.toUpperCase()!=='AUTOMATIC')
    safetyFailures.push('operating mode not AUTOMATIC');
  if(app.state?.safetyState?.eStop!=='NONE')safetyFailures.push('emergency stop active');
  if(app.state?.safetyState?.fieldViolation===true)safetyFailures.push('field violation active');
  if(app.state?.agvPosition?.positionInitialized!==true)
    safetyFailures.push('localization invalid');
  const velocity=app.state?.velocity;
  if(!velocity||![velocity.vx,velocity.vy,velocity.omega].every(Number.isFinite))
    safetyFailures.push('Motion Feedback invalid');
  if(app.activeNavigatorMapId!==node0?.mapId)safetyFailures.push('mapId changed');
  if(!node0Matches)safetyFailures.push('Node 0 no longer matches live pose');
  const remainingOrderId=getActiveNavigatorOrderId(app.state);
  if(remainingOrderId!==null)safetyFailures.push(`active Order remains: ${remainingOrderId}`);
  if(safetyFailures.length)
    throw new Error(
      `Live safety conditions changed before replacement Order publication: ${
        safetyFailures.join('; ')}.`,
    );
  if(app.grid&&pose&&app.activeNavigatorMapId){
    const latestObservations=[
      ...result.temporaryMap.acceptedObservations,
      ...ingestObstaclePayload({
        payload:app.rawStatePayload??app.state,
        sourceTopic:app.mqttSettings.topics.state,payloadKind:'state',
        receivedAtMs:app.mqttReceiveMetadata.lastStateReceiveTime??Date.now(),
        robotPose:pose,activeMapId:app.activeNavigatorMapId,grid:app.grid,
        clusterDistanceM:replanning.settings.obstacleMergeDistanceM,
      }).observations,
      ...ingestObstaclePayload({
        payload:app.rawVisualizationPayload??app.visualization,
        sourceTopic:app.mqttSettings.topics.visualization,payloadKind:'visualization',
        receivedAtMs:app.mqttReceiveMetadata.lastVisualizationReceiveTime??Date.now(),
        robotPose:pose,activeMapId:app.activeNavigatorMapId,grid:app.grid,
        clusterDistanceM:replanning.settings.obstacleMergeDistanceM,
      }).observations,
    ];
    if(latestObservations.length){
      const revalidatedMap=new TemporaryObstacleMap().build(
        app.grid,latestObservations,app.footprint,replanning.settings,
        app.activeNavigatorMapId,Date.now(),pose);
      const planningFootprint={
        ...app.footprint,
        safetyMargin:Math.max(
          app.footprint.safetyMargin,
          app.plannerOptions.passageSafety.wallClearanceMinimumM,
          app.plannerOptions.passageSafety.planningSafetyMarginM+
            app.plannerOptions.passageSafety.localizationMarginM),
      };
      if(!new PathCollisionValidator().pathIsFree(
        revalidatedMap.grid,result.finalPath,planningFootprint,
        app.plannerOptions.collisionSampleInterval))
        throw new Error(
          'Live obstacles changed after cancellation; the replacement route is no longer free.',
        );
      result.temporaryMap=revalidatedMap;
    }
  }
  replanning.setRuntime({status:'PUBLISHING_REPLACEMENT'});
  const payload=JSON.stringify(result.order);
  await mqttService.publish(app.mqttSettings.topics.order,payload,app.mqttSettings.qos,false);
  // The replacement geometry supersedes the original planned route. Give it
  // a fresh route identity so the UI cannot pair it with the old MotionPlan.
  const sent = { sentOrder:result.order,sentOrderPublishedAtMs:Date.now() };
  if (useAppStore.getState().grid === app.grid) {
    const replacementRevision=app.invalidateRoute();
    app.set({
      ...sent,generatedOrder:result.order,rawPath:result.rawPath,finalPath:result.finalPath,
      plannedRouteRevision:replacementRevision,generatedOrderRouteRevision:replacementRevision,
    });
  } else app.set(sent);
  replanning.log('OrderPublisher','info','Replacement Order published.',{
    topic:app.mqttSettings.topics.order,orderId:result.order.orderId,
    headerId:result.order.headerId,payloadBytes:new TextEncoder().encode(payload).byteLength,
  });
  replanning.setRuntime({status:'WAITING_NEW_ORDER_ACCEPTANCE'});
  const deadline=Date.now()+app.orderSettings.acceptanceTimeoutMs;
  while(Date.now()<deadline){
    if(signal.aborted)throw new DOMException('Replanning cancelled.','AbortError');
    const state=useAppStore.getState().state;
    if((state?.errors??[]).some((error)=>errorReferencesOrder(error,result.order.orderId)))
      throw new Error((state?.errors??[]).find(
        (error)=>errorReferencesOrder(error,result.order.orderId))?.errorDescription
        ??'Navigator rejected the replacement Order.');
    if(state?.orderId===result.order.orderId){
      replanning.log('OrderPublisher','info','Replacement Order accepted by Navigator.',{
        orderId:result.order.orderId,
      });
      return;
    }
    await delay(100,signal);
  }
  throw new Error('Replacement Order acceptance timed out.');
};
