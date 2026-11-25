import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultFootprint, defaultMqttSettings, defaultOrderSettings, defaultPlannerOptions,
} from '../domain/defaults';
import { planSynchronously, type PlannerRequest, type PlannerService } from '../domain/planner/PlannerService';
import { PathCollisionValidator } from '../domain/planner/PathCollisionValidator';
import type {
  OccupancyGrid, RobotPose, VdaOrder, VdaState,
} from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { BlockedRouteDetector } from '../features/replanning/BlockedRouteDetector';
import {
  GlobalReplanner, maximumPathDeviationM,
} from '../features/replanning/GlobalReplanner';
import {
  createBlockedRouteInference, ingestObstaclePayload,
} from '../features/replanning/ObstacleIngestion';
import {
  extractTemporaryObstacleObservations, isReplanningSensorObservation, TemporaryObstacleMap,
} from '../features/replanning/TemporaryObstacleMap';
import {
  projectStartPoseToFreeCell, StartProjectionError,
} from '../features/replanning/StartPoseProjector';
import {
  defaultGlobalReplanningSettings, useGlobalReplanningStore,
} from '../features/replanning/globalReplanningStore';
import {
  cancelActiveOrder, isPostReplacementGraceActive, publishReplacement,
} from '../features/replanning/useGlobalReplanning';
import type {
  GlobalReplanResult, TemporaryObstacleObservation,
} from '../features/replanning/types';
import { mqttService } from '../services/MqttService';
import { useAppStore } from '../stores/appStore';

const makeGrid=():OccupancyGrid=>({
  metadata:{name:'map-a',mapId:'map-a',width:60,height:40,resolution:.1,
    origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false},
  data:new Array(60*40).fill(0),
});
const pose:RobotPose={x:.5,y:2,theta:0,mapId:'map-a',positionInitialized:true};
const makeOrder=():VdaOrder=>new VdaOrderBuilder().build([
  pose,{x:5,y:2,theta:0},
],{robotPose:pose,activeMapId:'map-a'},defaultOrderSettings);
const safeState=(order:VdaOrder):VdaState=>({
  orderId:order.orderId,lastNodeSequenceId:0,driving:true,paused:false,
  operatingMode:'AUTOMATIC',
  agvPosition:pose,velocity:{vx:0,vy:0,omega:0},
  safetyState:{eStop:'NONE',fieldViolation:false},errors:[],nodeStates:[{nodeId:'goal'}],
});

describe('BlockedRouteDetector',()=>{
  it('requires every safety and motion condition for the complete timeout',()=>{
    const order=makeOrder();const detector=new BlockedRouteDetector();
    const settings={...defaultGlobalReplanningSettings,enabled:true,blockedTimeoutMs:5_000};
    const first=detector.update({
      nowMs:1_000,state:safeState(order),activeOrder:order,robotPose:pose,
      stateFresh:true,visualizationFresh:true,visualizationPose:pose,
      visualizationReceivedAtMs:1_000,
    },settings);
    expect(first.candidate).toBe(true);expect(first.blocked).toBe(false);
    const blocked=detector.update({
      nowMs:6_000,state:safeState(order),activeOrder:order,robotPose:pose,
      stateFresh:true,visualizationFresh:true,visualizationPose:pose,
      visualizationReceivedAtMs:1_000,
    },settings);
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockedDurationMs).toBe(5_000);
  });

  it('resets when paused, moving, close to goal, or e-stop is active',()=>{
    const order=makeOrder();const settings={...defaultGlobalReplanningSettings,enabled:true};
    const cases:VdaState[]=[
      {...safeState(order),paused:true},
      {...safeState(order),velocity:{vx:.03,vy:0,omega:0}},
      {...safeState(order),safetyState:{eStop:'MANUAL',fieldViolation:false}},
    ];
    for(const state of cases){
      const decision=new BlockedRouteDetector().update({
        nowMs:1_000,state,activeOrder:order,robotPose:pose,
        stateFresh:true,visualizationFresh:true,visualizationPose:pose,
        visualizationReceivedAtMs:1_000,
      },settings);
      expect(decision.candidate).toBe(false);
    }
    const nearGoal={...pose,x:4.8};
    expect(new BlockedRouteDetector().update({
      nowMs:1_000,state:safeState(order),activeOrder:order,robotPose:nearGoal,
      stateFresh:true,visualizationFresh:true,visualizationPose:nearGoal,
      visualizationReceivedAtMs:1_000,
    },settings).candidate).toBe(false);
  });

  it('waits when visualization proves Navigator is still moving or bypassing',()=>{
    const order=makeOrder();const detector=new BlockedRouteDetector();
    const settings={...defaultGlobalReplanningSettings,enabled:true};
    detector.update({nowMs:1_000,state:safeState(order),activeOrder:order,robotPose:pose,
      stateFresh:true,visualizationFresh:true,visualizationPose:pose,
      visualizationReceivedAtMs:1_000},settings);
    const moved={...pose,x:.6};
    const decision=detector.update({
      nowMs:2_000,state:safeState(order),activeOrder:order,robotPose:moved,
      stateFresh:true,visualizationFresh:true,visualizationPose:moved,
      visualizationReceivedAtMs:2_000,
    },settings);
    expect(decision.waitingForBypass).toBe(true);
    expect(decision.blocked).toBe(false);
  });
});

describe('temporary obstacle layer',()=>{
  const polygon=(x:number):TemporaryObstacleObservation=>({
    id:`obstacle-${x}`,source:'ObstaclePolygon',sourcePath:'$.obstaclePolygons[0]',
    mapId:'map-a',receivedAtMs:10_000,points:[
      {x,y:1.8},{x:x+.3,y:1.8},{x:x+.3,y:2.2},{x,y:2.2},
    ],
  });
  const settings={...defaultGlobalReplanningSettings,enabled:true,
    minimumObstacleSizeM:.2,inflationDistanceM:.1};
  const smallFootprint={...defaultFootprint,length:.2,width:.2,safetyMargin:0,
    inflationRadius:0};

  it('inserts and inflates temporary geometry without modifying the original map',()=>{
    const original=makeGrid();const before=[...original.data];
    const result=new TemporaryObstacleMap().build(
      original,[polygon(2)],smallFootprint,settings,'map-a',10_000);
    expect(original.data).toEqual(before);
    expect(result.obstacleCells.length).toBeGreaterThan(0);
    expect(result.inflatedGrid.data.filter((value)=>value===100).length)
      .toBeGreaterThan(result.obstacleCells.length);
    expect(result.totalInflationM).toBeCloseTo(.1);
  });

  it('filters tiny detections and stale or wrong-map observations',()=>{
    const tiny:{x:number;y:number}[]=[{x:1,y:1},{x:1.05,y:1.05}];
    const observations:TemporaryObstacleObservation[]=[
      {id:'tiny',source:'Laser1',sourcePath:'$.Laser1.points',mapId:'map-a',
        receivedAtMs:10_000,points:tiny},
      {...polygon(2),receivedAtMs:0},
      {...polygon(3),mapId:'other'},
    ];
    const result=new TemporaryObstacleMap().build(
      makeGrid(),observations,smallFootprint,settings,'map-a',20_001);
    expect(result.acceptedObservations).toHaveLength(0);
    expect(result.obstacleCells).toHaveLength(0);
  });

  it('moves and removes temporary obstacles as observations change',()=>{
    const builder=new TemporaryObstacleMap();const grid=makeGrid();
    const first=builder.build(grid,[polygon(2)],smallFootprint,settings,'map-a',10_000);
    const moved=builder.build(grid,[polygon(3)],smallFootprint,settings,'map-a',10_000);
    const gone=builder.build(grid,[],smallFootprint,settings,'map-a',20_000);
    expect(first.obstacleCells).not.toEqual(moved.obstacleCells);
    expect(gone.obstacleCells).toHaveLength(0);
    expect(gone.grid.data).toEqual(grid.data);
  });

  it('extracts only obstacle-related geometry and records its raw JSON path',()=>{
    const observations=extractTemporaryObstacleObservations([{
      agvPosition:{x:1,y:2},
      Laser1:{mapId:'map-a',points:[{x:2,y:2},{x:2.2,y:2},{x:2.3,y:2}]},
      unrelated:[{x:8,y:8},{x:9,y:9}],
    }],10_000,'map-a');
    expect(observations).toHaveLength(1);
    expect(observations[0]?.source).toBe('Laser1');
    expect(observations[0]?.sourcePath).toContain('Laser1.points');
  });

  it('uses only Laser1, Laser2, and Environment Model observations for replanning',()=>{
    expect(isReplanningSensorObservation({
      id:'laser',source:'Laser1',sourcePath:'$.Laser1',points:[],receivedAtMs:1,
    })).toBe(true);
    expect(isReplanningSensorObservation({
      id:'environment',source:'EnvironmentModel',
      sourcePath:'$.environmentModel',points:[],receivedAtMs:1,
    })).toBe(true);
    expect(isReplanningSensorObservation({
      id:'generic',source:'ObstacleMessage',
      sourcePath:'$.obstacle',points:[],receivedAtMs:1,
    })).toBe(false);
  });
});

describe('raw obstacle ingestion',()=>{
  it('parses array and object laser points and transforms the local laser frame to MAP',()=>{
    const result=ingestObstaclePayload({
      payload:{laser1:{frameId:'base_link',points:[[1,0],{x:1.1,y:0},['bad',0]]}},
      sourceTopic:'uagv/v2/bosch/0001/visualization',payloadKind:'visualization',
      receivedAtMs:10_000,
      robotPose:{...pose,theta:Math.PI/2},activeMapId:'map-a',grid:makeGrid(),
      clusterDistanceM:.2,
    });
    expect(result.diagnostic.rawPointCount).toBe(3);
    expect(result.diagnostic.transformedPointCount).toBe(2);
    expect(result.diagnostic.rejectedPointCount).toBe(1);
    expect(result.diagnostic.obstacleClusterCount).toBe(1);
    expect(result.observations[0]?.source).toBe('Laser1');
    expect(result.observations[0]?.points[0]?.x).toBeCloseTo(pose.x);
    expect(result.observations[0]?.points[0]?.y).toBeCloseTo(pose.y+1);
  });

  it('preserves Environment Model points explicitly identified as MAP coordinates',()=>{
    const result=ingestObstaclePayload({
      payload:{environmentModel:{frame:'MAP',obstaclePoints:[
        {position:{x:2,y:1}},{coordinates:[2.1,1]},
      ]}},
      sourceTopic:'uagv/v2/bosch/0001/state',payloadKind:'state',
      receivedAtMs:10_000,robotPose:pose,activeMapId:'map-a',grid:makeGrid(),
      clusterDistanceM:.2,
    });
    expect(result.diagnostic.transformedPointCount).toBe(2);
    expect(result.diagnostic.frameModes).toContain('map:MAP');
    expect(result.observations[0]?.points[0]).toMatchObject({x:2,y:1});
  });

  it('places the fallback in front of the heading and outside the robot footprint',()=>{
    const settings={...defaultGlobalReplanningSettings,
      inferredObstacleDistanceM:1,inferredObstacleLengthM:.4,inferredObstacleWidthM:.4};
    const fallback=createBlockedRouteInference({
      robotPose:pose,footprint:defaultFootprint,settings,
      activeMapId:'map-a',mapResolutionM:.1,receivedAtMs:10_000,
    });
    expect(fallback.source).toBe('BlockedRouteInference');
    expect(Math.min(...fallback.points.map((point)=>point.x)))
      .toBeGreaterThan(pose.x+defaultFootprint.length/2);
    const temporary=new TemporaryObstacleMap().build(
      makeGrid(),[fallback],defaultFootprint,settings,'map-a',10_000,pose);
    expect(temporary.obstacleCells.length).toBeGreaterThan(0);
    expect(temporary.inflatedObstacleCells.length)
      .toBeGreaterThan(temporary.obstacleCells.length);
  });
});

describe('planning start projection',()=>{
  it('projects an occupied robot cell to the closest free cell without changing the robot pose',()=>{
    const grid=makeGrid();const original={...pose};
    const cell={row:19,column:5};
    grid.data[cell.row*grid.metadata.width+cell.column]=100;
    const result=projectStartPoseToFreeCell(grid,pose,true);
    expect(result.diagnostic.success).toBe(true);
    expect(result.cell).not.toEqual(cell);
    expect(result.diagnostic.projectionDistanceM).toBeLessThanOrEqual(.2);
    expect(pose).toEqual(original);
  });

  it('uses the staged search up to one metre',()=>{
    const grid=makeGrid();grid.data.fill(100);
    grid.data[19*grid.metadata.width+10]=0;
    const result=projectStartPoseToFreeCell(grid,pose,true);
    expect(result.diagnostic.success).toBe(true);
    expect(result.diagnostic.searchRadiusM).toBeGreaterThanOrEqual(.4);
    expect(result.diagnostic.projectionDistanceM).toBeLessThanOrEqual(1);
  });

  it('reports a stable failure when no reachable free start exists',()=>{
    const grid=makeGrid();grid.data.fill(100);
    const result=projectStartPoseToFreeCell(grid,pose,true);
    expect(result.cell).toBeNull();
    expect(result.diagnostic.failureReason).toContain('1.00 m');
    expect(new StartProjectionError(result.diagnostic).message)
      .toBe('No reachable free start cell.');
  });
});

describe('A* global replanning and order regeneration',()=>{
  const synchronousPlanner={
    plan:(request:PlannerRequest)=>Promise.resolve(planSynchronously(request)),
  } as PlannerService;
  const observation:TemporaryObstacleObservation={
    id:'box',source:'ObstaclePolygon',sourcePath:'$.obstaclePolygons[0]',
    mapId:'map-a',receivedAtMs:10_000,points:[
      {x:2.4,y:1.7},{x:2.8,y:1.7},{x:2.8,y:2.3},{x:2.4,y:2.3},
    ],
  };
  const tiny={...defaultFootprint,length:.2,width:.2,safetyMargin:0,inflationRadius:.1};
  const settings={...defaultGlobalReplanningSettings,enabled:true,
    inflationDistanceM:.1,minimumObstacleSizeM:.2,maximumPlanningTimeMs:1_000};

  it('routes around a temporary obstacle and generates a new independent Order',async()=>{
    const active=makeOrder();
    const started=performance.now();
    const result=await new GlobalReplanner(synchronousPlanner).calculate({
      originalMap:makeGrid(),observations:[observation],robotPose:pose,
      activeMapId:'map-a',activeOrder:active,footprint:tiny,
      plannerOptions:{...defaultPlannerOptions,maximumWaypointDistance:.5},
      orderSettings:defaultOrderSettings,replanningSettings:settings,nowMs:10_000,
    });
    const measured=performance.now()-started;
    expect(result.order.orderId).not.toBe(active.orderId);
    expect(result.order.headerId).not.toBe(active.headerId);
    expect(result.order.orderUpdateId).toBe(0);
    expect(result.order.version).toBe('2.0.0');
    expect(result.order.nodes.at(-1)?.nodePosition).toMatchObject(
      active.nodes.at(-1)!.nodePosition);
    expect(result.order.nodes.every((node)=>node.nodePosition.mapId==='map-a')).toBe(true);
    expect(result.order.edges.every((edge)=>
      edge.maxSpeed===defaultOrderSettings.missionMaximumSpeedMps)).toBe(true);
    expect(result.finalPath.some((point)=>Math.abs(point.y-2)>.25)).toBe(true);
    expect(result.maximumRouteDeviationM).toBeGreaterThanOrEqual(
      settings.minimumRouteChangeM);
    expect(result.planningTimeMs).toBeLessThan(200);
    expect(measured).toBeLessThan(200);
  });

  it('uses a projected A* start while preserving the real pose in VDA Node 0',async()=>{
    const active=makeOrder();
    const nearRobot:TemporaryObstacleObservation={
      id:'near-robot',source:'EnvironmentModel',
      sourcePath:'$.environmentModel.obstacles',mapId:'map-a',receivedAtMs:10_000,
      points:[
        {x:.7,y:1.8},{x:1,y:1.8},{x:1,y:2.2},{x:.7,y:2.2},
      ],
    };
    const result=await new GlobalReplanner(synchronousPlanner).calculate({
      originalMap:makeGrid(),observations:[nearRobot],robotPose:pose,
      activeMapId:'map-a',activeOrder:active,footprint:tiny,
      plannerOptions:{...defaultPlannerOptions,passageSafety:{
        ...defaultPlannerOptions.passageSafety,
        planningSafetyMarginM:0,localizationMarginM:0,wallClearanceMinimumM:0,
      }},orderSettings:defaultOrderSettings,
      replanningSettings:{
        ...settings,obstacleMergeDistanceM:.5,minimumRouteChangeM:.3,
      },nowMs:10_000,
    });
    expect(result.startProjection.success).toBe(true);
    expect(result.startProjection.projectionDistanceM).toBeGreaterThan(0);
    expect(result.order.nodes[0]?.nodePosition).toMatchObject({
      x:pose.x,y:pose.y,theta:pose.theta,mapId:pose.mapId,
    });
    expect(new PathCollisionValidator().pathIsFree(
      result.temporaryMap.grid,
      result.order.nodes.map((node)=>node.nodePosition),tiny,.03,
    )).toBe(true);
    expect(result.exploredCells.length).toBeGreaterThan(0);
  });

  it('produces unique IDs for repeated replanning',async()=>{
    const request={
      originalMap:makeGrid(),observations:[observation],robotPose:pose,
      activeMapId:'map-a',activeOrder:makeOrder(),footprint:tiny,
      plannerOptions:defaultPlannerOptions,orderSettings:defaultOrderSettings,
      replanningSettings:settings,nowMs:10_000,
    };
    const planner=new GlobalReplanner(synchronousPlanner);
    const first=await planner.calculate(request);const second=await planner.calculate(request);
    expect(first.order.orderId).not.toBe(second.order.orderId);
    expect(first.order.nodes[0]?.nodeId).not.toBe(second.order.nodes[0]?.nodeId);
  });

  it('does not generate another Order when the replacement route is unchanged',async()=>{
    const planner=new GlobalReplanner(synchronousPlanner);
    const request={
      originalMap:makeGrid(),observations:[observation],robotPose:pose,
      activeMapId:'map-a',activeOrder:makeOrder(),footprint:tiny,
      plannerOptions:defaultPlannerOptions,orderSettings:defaultOrderSettings,
      replanningSettings:{...settings,minimumRouteChangeM:0},nowMs:10_000,
    };
    const first=await planner.calculate(request);
    await expect(planner.calculate({...request,activeOrder:first.order}))
      .rejects.toThrow(/unchanged|route changes by only/);
  });

  it('reports no path for a complete temporary barrier and recovers after it disappears',async()=>{
    const barrier:TemporaryObstacleObservation={
      id:'barrier',source:'ObstaclePolygon',sourcePath:'$.obstaclePolygons[0]',
      mapId:'map-a',receivedAtMs:10_000,points:[
        {x:2.8,y:0},{x:3.2,y:0},{x:3.2,y:4},{x:2.8,y:4},
      ],
    };
    const request={
      originalMap:makeGrid(),observations:[barrier],robotPose:pose,
      activeMapId:'map-a',activeOrder:makeOrder(),footprint:tiny,
      plannerOptions:defaultPlannerOptions,orderSettings:defaultOrderSettings,
      replanningSettings:settings,nowMs:10_000,
    };
    const planner=new GlobalReplanner(synchronousPlanner);
    await expect(planner.calculate(request)).rejects.toThrow(
      /No collision-free|alternative|reachable free start/);
    const recovered=await planner.calculate({
      ...request,observations:[],
      replanningSettings:{...settings,minimumRouteChangeM:0},
    });
    expect(recovered.order.nodes.at(-1)?.nodePosition.x).toBe(5);
  });

  it('rejects a recalculated route that is effectively the same as the blocked route',async()=>{
    const request={
      originalMap:makeGrid(),observations:[],robotPose:pose,
      activeMapId:'map-a',activeOrder:makeOrder(),footprint:tiny,
      plannerOptions:defaultPlannerOptions,orderSettings:defaultOrderSettings,
      replanningSettings:settings,nowMs:10_000,
    };
    await expect(new GlobalReplanner(synchronousPlanner).calculate(request))
      .rejects.toThrow(/route changes by only/);
  });

  it('measures lateral route change independently of waypoint spacing',()=>{
    expect(maximumPathDeviationM(
      [{x:0,y:0},{x:1,y:.4},{x:2,y:0}],
      [{x:0,y:0},{x:2,y:0}],
    )).toBeCloseTo(.4);
  });
});

describe('automatic MQTT Order transition',()=>{
  beforeEach(()=>{
    vi.restoreAllMocks();
    useGlobalReplanningStore.getState().resetRuntime();
  });

  it('holds blocked detection during the post-replacement grace period',()=>{
    const completedAt='2026-07-27T16:00:00.000Z';
    expect(isPostReplacementGraceActive(
      completedAt,10_000,Date.parse(completedAt)+9_999)).toBe(true);
    expect(isPostReplacementGraceActive(
      completedAt,10_000,Date.parse(completedAt)+10_000)).toBe(false);
  });

  it.each([false,true])('publishes cancelOrder before the replacement and waits for acceptance (map changes in flight: %s)',async(mapChanges)=>{
    const oldOrder=makeOrder();const newOrder=makeOrder();
    const now=Date.now();const state=safeState(oldOrder);
    useAppStore.setState({
      mqttConnected:true,mqttSettings:defaultMqttSettings,
      orderSettings:defaultOrderSettings,connection:{
        headerId:1,timestamp:new Date().toISOString(),version:'2.0.0',
        manufacturer:'bosch',serialNumber:'0001',connectionState:'ONLINE',
      },
      state,start:pose,activeNavigatorMapId:'map-a',
      mqttReceiveMetadata:{
        lastStateReceiveTime:now,lastVisualizationReceiveTime:now,
        statePayloadTimestamp:null,visualizationPayloadTimestamp:null,
      },
    });
    const publish=vi.spyOn(mqttService,'publish').mockImplementation(
      async(topic,payload)=>{
        if(topic===defaultMqttSettings.topics.instantActions){
          const actionId=(JSON.parse(payload) as {
            actions:Array<{actionId:string}>;
          }).actions[0]!.actionId;
          useAppStore.setState({state:{
            ...state,orderId:'',driving:false,nodeStates:[],
            actionStates:[{actionId,actionStatus:'FINISHED'}],
          }});
        }
        if(topic===defaultMqttSettings.topics.order){
          if(mapChanges)useAppStore.getState().set({grid:makeGrid()});
          useAppStore.setState({state:{...state,orderId:newOrder.orderId,driving:false,nodeStates:[]}});
        }
      });
    const signal=new AbortController().signal;
    await cancelActiveOrder(oldOrder,signal);
    const temporary=new TemporaryObstacleMap().build(
      makeGrid(),[],defaultFootprint,
      defaultGlobalReplanningSettings,'map-a',now);
    const result:GlobalReplanResult={
      order:newOrder,temporaryMap:temporary,
      rawPath:newOrder.nodes.map((node)=>node.nodePosition),
      simplifiedPath:newOrder.nodes.map((node)=>node.nodePosition),
      finalPath:newOrder.nodes.map((node)=>node.nodePosition),
      planningTimeMs:10,originalPathLengthM:4.5,newPathLengthM:4.5,
      maximumRouteDeviationM:.5,
      startProjection:{
        originalPose:{x:pose.x,y:pose.y},originalCell:{row:19,column:5},
        projectedPose:{x:pose.x,y:pose.y},projectedCell:{row:19,column:5},
        projectionDistanceM:0,searchRadiusM:0,success:true,
      },
      exploredCells:[],
    };
    await publishReplacement(result,signal);
    expect(publish.mock.calls[0]?.[0]).toBe(defaultMqttSettings.topics.instantActions);
    expect(JSON.parse(publish.mock.calls[0]![1]).actions[0].actionType).toBe('cancelOrder');
    expect(publish.mock.calls[1]?.[0]).toBe(defaultMqttSettings.topics.order);
    expect(JSON.parse(publish.mock.calls[1]![1]).orderId).toBe(newOrder.orderId);
    expect(useAppStore.getState().sentOrder?.orderId).toBe(newOrder.orderId);
    if(mapChanges){
      expect(useAppStore.getState().generatedOrder).toBeUndefined();
      expect(useAppStore.getState().finalPath).toEqual([]);
    }else expect(useAppStore.getState().generatedOrder?.orderId).toBe(newOrder.orderId);
  });

  it('rejects a failed cancel action even when Navigator has cleared the old Order',async()=>{
    const oldOrder=makeOrder();const state=safeState(oldOrder);const now=Date.now();
    useAppStore.setState({
      mqttConnected:true,mqttSettings:defaultMqttSettings,
      orderSettings:{...defaultOrderSettings,commandTimeoutMs:500},
      state,start:pose,activeNavigatorMapId:'map-a',
      mqttReceiveMetadata:{
        lastStateReceiveTime:now,lastVisualizationReceiveTime:now,
        statePayloadTimestamp:null,visualizationPayloadTimestamp:null,
      },
    });
    vi.spyOn(mqttService,'publish').mockImplementation(async(_topic,payload)=>{
      const actionId=(JSON.parse(payload) as {actions:Array<{actionId:string}>})
        .actions[0]!.actionId;
      useAppStore.setState({state:{
        ...state,orderId:'',driving:false,nodeStates:[],
        actionStates:[{actionId,actionStatus:'FAILED'}],
      }});
    });
    await expect(cancelActiveOrder(oldOrder,new AbortController().signal))
      .rejects.toThrow(/rejected cancelOrder/);
  });
});
