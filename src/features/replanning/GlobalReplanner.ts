import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import { PlannerService } from '../../domain/planner/PlannerService';
import { PathCollisionValidator } from '../../domain/planner/PathCollisionValidator';
import type {
  GridCell, OccupancyGrid, OrderSettings, PathPoint, PlannerOptions, RobotFootprint, RobotPose,
  VdaOrder,
} from '../../domain/types';
import { VdaOrderBuilder } from '../../domain/vda5050/VdaOrderBuilder';
import { TemporaryObstacleMap } from './TemporaryObstacleMap';
import {
  projectStartPoseToFreeCell, StartProjectionError,
} from './StartPoseProjector';
import type {
  GlobalReplanResult, GlobalReplanningSettings, StartProjectionDiagnostic,
  TemporaryMapResult, TemporaryObstacleObservation,
} from './types';

export class GlobalPlanningError extends Error {
  public constructor(
    message:string,
    public readonly startProjection:StartProjectionDiagnostic,
    public readonly exploredCells:GridCell[],
    public readonly temporaryMap:TemporaryMapResult,
  ){
    super(message);this.name='GlobalPlanningError';
  }
}

export const pathLengthM=(path:Array<Pick<PathPoint,'x'|'y'>>):number=>
  path.slice(1).reduce((total,item,index)=>{
    const previous=path[index]!;
    return total+Math.hypot(item.x-previous.x,item.y-previous.y);
  },0);

export const ABSOLUTE_MINIMUM_ROUTE_CHANGE_M=0.01;

const pointToSegmentDistance=(point:Pick<PathPoint,'x'|'y'>,
  start:Pick<PathPoint,'x'|'y'>,end:Pick<PathPoint,'x'|'y'>):number=>{
  const dx=end.x-start.x;const dy=end.y-start.y;
  const lengthSquared=dx*dx+dy*dy;
  if(lengthSquared<=Number.EPSILON)return Math.hypot(point.x-start.x,point.y-start.y);
  const projection=Math.max(0,Math.min(1,
    ((point.x-start.x)*dx+(point.y-start.y)*dy)/lengthSquared));
  return Math.hypot(
    point.x-(start.x+projection*dx),
    point.y-(start.y+projection*dy),
  );
};

/** Maximum lateral separation of a candidate route from the previous route. */
export const maximumPathDeviationM=(
  candidate:Array<Pick<PathPoint,'x'|'y'>>,
  reference:Array<Pick<PathPoint,'x'|'y'>>,
):number=>{
  if(candidate.length===0||reference.length===0)return Number.POSITIVE_INFINITY;
  if(reference.length===1)return Math.max(...candidate.map((point)=>
    Math.hypot(point.x-reference[0]!.x,point.y-reference[0]!.y)));
  return Math.max(...candidate.map((point)=>Math.min(
    ...reference.slice(1).map((end,index)=>
      pointToSegmentDistance(point,reference[index]!,end)),
  )));
};

export interface GlobalReplanRequest {
  originalMap:OccupancyGrid;
  observations:TemporaryObstacleObservation[];
  robotPose:RobotPose;
  activeMapId:string;
  activeOrder:VdaOrder;
  footprint:RobotFootprint;
  plannerOptions:PlannerOptions;
  orderSettings:OrderSettings;
  replanningSettings:GlobalReplanningSettings;
  nowMs?:number;
}

export class GlobalReplanner {
  public constructor(private readonly planner=new PlannerService()){}

  public async calculate(request:GlobalReplanRequest):Promise<GlobalReplanResult>{
    const goal=request.activeOrder.nodes.at(-1)?.nodePosition;
    if(!goal)throw new Error('The active Order has no final goal node.');
    if(goal.mapId!==request.activeMapId)
      throw new Error('The active Order goal does not match the active Navigator mapId.');
    const temporaryMap=new TemporaryObstacleMap().build(
      request.originalMap,request.observations,request.footprint,
      request.replanningSettings,request.activeMapId,request.nowMs,request.robotPose,
    );
    const transform=new CoordinateTransformer(request.originalMap.metadata);
    const goalCell=transform.worldToGrid(goal.x,goal.y);
    if(!goalCell)throw new Error('The original goal is outside the active map.');
    const projection=projectStartPoseToFreeCell(
      temporaryMap.grid,request.robotPose,
      request.replanningSettings.enableStartPoseProjection,goalCell,{
        ...request.footprint,
        safetyMargin:Math.max(
          request.footprint.safetyMargin,
          request.plannerOptions.passageSafety.wallClearanceMinimumM,
          request.plannerOptions.passageSafety.planningSafetyMarginM+
          request.plannerOptions.passageSafety.localizationMarginM),
      },
      request.replanningSettings.maximumStartProjectionDistanceM,
    );
    if(!projection.cell)throw new StartProjectionError(projection.diagnostic,temporaryMap);
    const options:PlannerOptions={
      ...request.plannerOptions,
      maxPlanningTimeMs:request.replanningSettings.maximumPlanningTimeMs,
      correctionRadiusCells:0,
    };
    const result=await this.planner.plan({
      grid:temporaryMap.grid,collisionGrid:temporaryMap.grid,
      start:projection.cell,goal:goalCell,options,
      footprint:request.footprint,startTheta:request.robotPose.theta,goalTheta:goal.theta,
    });
    if(!result.success||result.finalPath.length<2)
      throw new GlobalPlanningError(
        result.error??'No alternative route found.',
        projection.diagnostic,result.exploredCells??[],temporaryMap,
      );
    const plannerFinalPath=result.finalPath.map((point)=>({...point}));
    plannerFinalPath[plannerFinalPath.length-1]={
      x:goal.x,y:goal.y,theta:goal.theta,
    };
    const collision=new PathCollisionValidator();
    if(!collision.pathIsFree(
      temporaryMap.grid,plannerFinalPath,{
        ...request.footprint,
        safetyMargin:Math.max(
          request.footprint.safetyMargin,
          options.passageSafety.wallClearanceMinimumM,
          options.passageSafety.planningSafetyMarginM+
            options.passageSafety.localizationMarginM),
      },options.collisionSampleInterval))
      throw new Error('The exact original goal cannot be rejoined safely.');
    const usefulPlannerPath=plannerFinalPath.slice(1);
    if(!usefulPlannerPath.length)throw new Error('No useful waypoint remains after start projection.');
    const realStart:PathPoint={
      x:request.robotPose.x,y:request.robotPose.y,theta:request.robotPose.theta,
    };
    const directRoute:PathPoint[]=[realStart,...usefulPlannerPath];
    const projectedRoute:PathPoint[]=[realStart,...plannerFinalPath];
    const planningFootprint={
      ...request.footprint,
      safetyMargin:Math.max(
        request.footprint.safetyMargin,
        options.passageSafety.wallClearanceMinimumM,
        options.passageSafety.planningSafetyMarginM+
          options.passageSafety.localizationMarginM),
    };
    const directIsFree=collision.pathIsFree(
      temporaryMap.grid,directRoute,planningFootprint,options.collisionSampleInterval);
    const projectedIsFree=!directIsFree&&collision.pathIsFree(
      temporaryMap.grid,projectedRoute,planningFootprint,options.collisionSampleInterval);
    if(!directIsFree&&!projectedIsFree){
      const diagnostic=collision.findFirstCollision(
        temporaryMap.grid,projectedRoute,planningFootprint,
        options.collisionSampleInterval);
      throw new Error(
        `No collision-free connection exists from the live robot pose to the projected route${
          diagnostic?` (segment ${diagnostic.segmentIndex})`:''}.`,
      );
    }
    const finalPath=directIsFree?directRoute:projectedRoute;
    const startProjection={
      ...projection.diagnostic,
      usedProjectedStartWaypoint:!directIsFree,
    };
    const originalPath=request.activeOrder.nodes.map((node)=>node.nodePosition);
    // Node 0 is the live pose and can already be laterally displaced by the
    // Navigator. It must not, by itself, make an unchanged future route look new.
    const routeDeviation=maximumPathDeviationM(finalPath.slice(1),originalPath);
    if(routeDeviation<=ABSOLUTE_MINIMUM_ROUTE_CHANGE_M)
      throw new Error(
        `Recalculated path is unchanged (${routeDeviation.toFixed(3)} m lateral deviation).`,
      );
    if(request.replanningSettings.minimumRouteChangeM>0&&
      routeDeviation<request.replanningSettings.minimumRouteChangeM)
      throw new Error(
        `Calculated route changes by only ${routeDeviation.toFixed(3)} m; `+
        `at least ${request.replanningSettings.minimumRouteChangeM.toFixed(3)} m is required.`,
      );
    const corridorDiagnostics:unknown[]=[];
    const order=new VdaOrderBuilder().build(finalPath,{
      robotPose:request.robotPose,activeMapId:request.activeMapId,finalGoalTheta:goal.theta,
      corridorPlanning:{
        grid:temporaryMap.grid,footprint:request.footprint,plannerOptions:options,
        onDiagnostic:(diagnostic)=>corridorDiagnostics.push(diagnostic),
      },
    },request.orderSettings);
    return {
      order,temporaryMap,rawPath:result.rawPath,simplifiedPath:result.simplifiedPath,
      finalPath,planningTimeMs:result.statistics.durationMs,
      originalPathLengthM:pathLengthM(originalPath),
      newPathLengthM:pathLengthM(finalPath),
      maximumRouteDeviationM:routeDeviation,
      startProjection,
      exploredCells:result.exploredCells??[],
    };
  }
}
