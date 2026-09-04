import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { normalizeAngle } from '../geometry/angles';
import type {
  GridCell, OccupancyGrid, PathPoint, PlannerDiagnostics, PlannerOptions,
  PlannerResult, PlannerStageDiagnostic, PlannerStageName, RobotFootprint,
} from '../types';
import { AStarPlanner } from './AStarPlanner';
import { buildClearanceField } from './ClearanceField';
import { FreeSpaceAnalyzer } from './FreeSpaceAnalyzer';
import { isOccupiedValue } from './ObstacleInflation';
import { PathCollisionValidator } from './PathCollisionValidator';
import { PathSimplifier } from './PathSimplifier';
import { RouteSafetyProcessor } from './RouteSafetyProcessor';

export interface PlannerRequest {
  grid: OccupancyGrid;
  collisionGrid?: OccupancyGrid;
  start: GridCell;
  goal: GridCell;
  options: PlannerOptions;
  footprint: RobotFootprint;
  goalTheta?: number;
  startTheta?:number;
  exactStartPose?:PathPoint;
}

const emptyDiagnostics=():PlannerDiagnostics=>({
  detectedPassages:[],routePassageCount:0,insertedNodeCount:0,
  rejectedTurnLocations:[],relocatedTurnNodes:0,minimumRouteClearanceM:0,
  largestHeadingChangeDeg:0,stages:[],warnings:[],finalPathSource:'baseline',
  rawPathStatus:'RAW_PATH_FAILED',baselineStatus:'BASELINE_PATH_FAILED',
  doorAlignmentStatus:'NOT_RUN',turnValidationStatus:'NOT_RUN',
});

const stage=(
  name:PlannerStageName,
  inputPointCount:number,
  outputPointCount:number,
  success:boolean,
  patch:Partial<PlannerStageDiagnostic>={},
):PlannerStageDiagnostic=>({
  stage:name,inputPointCount,outputPointCount,success,
  severity:success?'info':'error',...patch,
});

const mapIsValid=(grid:OccupancyGrid):string|undefined=>{
  const metadata=grid.metadata;
  if(!Number.isInteger(metadata.width)||!Number.isInteger(metadata.height)||
    metadata.width<=0||metadata.height<=0)return 'Map dimensions are invalid.';
  if(!Number.isFinite(metadata.resolution)||metadata.resolution<=0)
    return 'Map resolution is invalid.';
  if(grid.data.length!==metadata.width*metadata.height)
    return 'Occupancy data length does not match map dimensions.';
  return undefined;
};

const cellReason=(grid:OccupancyGrid,cell:GridCell):string|undefined=>{
  const {width,height,occupiedThreshold}=grid.metadata;
  if(cell.row<0||cell.column<0||cell.row>=height||cell.column>=width)
    return 'Cell is outside the map.';
  if(isOccupiedValue(grid.data[cell.row*width+cell.column]??100,occupiedThreshold))
    return 'Cell is occupied or unknown.';
  return undefined;
};

const orient=(path:PathPoint[],startTheta:number,goalTheta?:number):PathPoint[]=>
  path.map((point,index)=>{
    if(index===0)return {...point,theta:normalizeAngle(startTheta)};
    if(index===path.length-1){
      const previous=path[index-1];
      const finalDirection=previous
        ?Math.atan2(point.y-previous.y,point.x-previous.x):startTheta;
      return {...point,theta:normalizeAngle(goalTheta??finalDirection)};
    }
    const next=path[index+1]!;
    return {...point,theta:normalizeAngle(
      Math.atan2(next.y-point.y,next.x-point.x)),
    orientationLocked:false,passageId:undefined,kind:'normal'};
  });

const planningFootprint=(
  footprint:RobotFootprint,
  options:PlannerOptions,
):RobotFootprint=>({
  ...footprint,
  safetyMargin:Math.max(
    footprint.safetyMargin,
    options.passageSafety.planningSafetyMarginM+
      options.passageSafety.localizationMarginM),
});

const addCollisionContext=(
  diagnostic:PlannerStageDiagnostic,
  grid:OccupancyGrid,
  path:PathPoint[],
  footprint:RobotFootprint,
  interval:number,
  clearance:Float32Array,
):PlannerStageDiagnostic=>{
  const collision=new PathCollisionValidator().findFirstDetailedCollision(
    grid,path,footprint,interval);
  if(!collision)return diagnostic;
  const transform=new CoordinateTransformer(grid.metadata);
  const gridCell=transform.worldToGrid(collision.pose.x,collision.pose.y)??undefined;
  return {
    ...diagnostic,rejectedSegmentIndex:collision.segmentIndex,
    world:collision.pose,grid:gridCell,collisionCell:collision.collisionCell,
    clearanceM:gridCell
      ?clearance[gridCell.row*grid.metadata.width+gridCell.column]:undefined,
    requiredClearanceM:footprint.safetyMargin,
    footprintPolygon:collision.footprintPolygon,
    safetyMarginM:footprint.safetyMargin,
  };
};

export const planSynchronously = (request: PlannerRequest): PlannerResult => {
  const started=performance.now();
  const grid=request.collisionGrid??request.grid;
  const diagnostics=emptyDiagnostics();
  const failure=(reason:string,rawPath:PathPoint[]=[],simplifiedPath:PathPoint[]=[],
    baselinePath:PathPoint[]=[]):PlannerResult=>({
    success:false,error:reason,rawPath,simplifiedPath,baselinePath,
    finalPath:baselinePath,diagnostics,
    statistics:{
      visitedCells:0,durationMs:performance.now()-started,
      rawPointCount:rawPath.length,simplifiedPointCount:simplifiedPath.length,
      finalPointCount:baselinePath.length,
    },
  });

  const mapError=mapIsValid(grid);
  diagnostics.stages.push(stage('map-validation',0,0,!mapError,{
    code:mapError?'MAP_INVALID':'MAP_VALID',reason:mapError,
  }));
  if(mapError)return failure(mapError);

  const transform=new CoordinateTransformer(grid.metadata);
  const footprint=planningFootprint(request.footprint,request.options);
  const clearance=buildClearanceField(grid);
  const startError=cellReason(grid,request.start);
  const startWorld=transform.gridToWorld(request.start.row,request.start.column);
  const startPose=request.exactStartPose??{
    ...startWorld,theta:request.startTheta??startWorld.theta,
  };
  const startInspection=new PathCollisionValidator().inspectPose(
    grid,startPose,footprint);
  const startFailure=startError??(startInspection.collision
    ?'The complete configured footprint collides at the start pose.':undefined);
  diagnostics.stages.push(stage('start-cell-validation',0,0,!startFailure,{
    code:startFailure?'START_INVALID':'START_VALID',reason:startFailure,
    world:startPose,grid:request.start,
    clearanceM:clearance[request.start.row*grid.metadata.width+request.start.column],
    requiredClearanceM:footprint.safetyMargin,
    footprintPolygon:startInspection.footprintPolygon,
    safetyMarginM:footprint.safetyMargin,
    collisionCell:startInspection.collisionCell,
  }));
  if(startFailure){
    diagnostics.physicalFailureCode='START_NOT_FREE';
    diagnostics.recommendedOperatorAction=
      'Relocalize in known free space or correct the map/vehicle footprint configuration.';
    return failure(startFailure);
  }

  const goalError=cellReason(grid,request.goal);
  const goalWorld=transform.gridToWorld(request.goal.row,request.goal.column);
  const goalPose={...goalWorld,theta:request.goalTheta??startPose.theta};
  const goalInspection=request.goalTheta===undefined
    ?{collision:false,footprintPolygon:[] as Array<{x:number;y:number}>}
    :new PathCollisionValidator().inspectPose(grid,goalPose,footprint);
  const goalFailure=goalError??(goalInspection.collision
    ?'The complete configured footprint collides at the goal pose.':undefined);
  diagnostics.stages.push(stage('goal-cell-validation',0,0,!goalFailure,{
    code:goalFailure?'GOAL_INVALID':'GOAL_VALID',reason:goalFailure,
    world:goalPose,grid:request.goal,
    clearanceM:clearance[request.goal.row*grid.metadata.width+request.goal.column],
    requiredClearanceM:footprint.safetyMargin,
    footprintPolygon:goalInspection.footprintPolygon,
    safetyMarginM:footprint.safetyMargin,
    collisionCell:goalInspection.collisionCell,
  }));
  if(goalFailure){
    diagnostics.physicalFailureCode='GOAL_NOT_FREE';
    diagnostics.recommendedOperatorAction=
      'Select a goal whose complete configured vehicle footprint fits in known free space.';
    return failure(goalFailure);
  }

  const freeSpace=new FreeSpaceAnalyzer().analyze(
    grid,request.start,request.goal,footprint,request.options.collisionSampleInterval);
  diagnostics.freeSpace=freeSpace.diagnostic;
  diagnostics.stages.push(stage(
    'free-space-model',0,freeSpace.diagnostic.visitedFootprintCells,
    !freeSpace.failureCode,{
      code:freeSpace.failureCode??'CONNECTED_FREE_SPACE',
      reason:freeSpace.reason,
      clearanceM:freeSpace.diagnostic.widestClearanceM,
      requiredClearanceM:freeSpace.diagnostic.requiredHalfWidthM,
    }));
  if(freeSpace.failureCode){
    diagnostics.physicalFailureCode=freeSpace.failureCode;
    diagnostics.recommendedOperatorAction=freeSpace.recommendedOperatorAction;
    return failure(freeSpace.reason??'NO_PHYSICALLY_VALID_ROUTE');
  }

  const rawResult=new AStarPlanner().plan(
    grid,request.start,request.goal,request.options,footprint,request.startTheta);
  diagnostics.rawPathStatus=rawResult.success?'RAW_PATH_FOUND':'RAW_PATH_FAILED';
  diagnostics.stages.push(stage('raw-a-star',0,rawResult.rawPath.length,
    rawResult.success,{
      code:diagnostics.rawPathStatus,reason:rawResult.error,
    }));
  if(!rawResult.success)return {
    ...rawResult,diagnostics:{
      ...diagnostics,physicalFailureCode:'RAW_ASTAR_FAILED',
      recommendedOperatorAction:
        'Review planning timeout and the explored-cell layer; do not reduce the vehicle footprint.',
    },baselinePath:[],finalPath:[],
  };

  let rawPath=rawResult.rawPath;
  if(request.exactStartPose&&rawPath.length){
    const exactCandidate=[request.exactStartPose,...rawPath.slice(1)];
    const exactCollision=new PathCollisionValidator().findFirstDetailedCollision(
      grid,exactCandidate,footprint,request.options.collisionSampleInterval);
    if(exactCollision){
      const failed=addCollisionContext(stage(
        'start-cell-validation',rawPath.length,0,false,{
          code:'FIRST_NODE_UNREACHABLE',
          reason:'The exact current pose cannot safely reach the planned grid route.',
        }),grid,exactCandidate,footprint,request.options.collisionSampleInterval,
      clearance);
      diagnostics.stages.push(failed);
      return failure(failed.reason!,rawPath);
    }
    rawPath=exactCandidate;
  }

  const rawPrevious=rawPath.at(-2)??rawPath[0]!;
  const rawLast=rawPath.at(-1)!;
  const requestedOrPathGoalTheta=request.goalTheta??Math.atan2(
    rawLast.y-rawPrevious.y,rawLast.x-rawPrevious.x);
  const simplified=new PathSimplifier().simplifyDetailed(
    grid,rawPath,footprint,request.options,requestedOrPathGoalTheta);
  diagnostics.stages.push(stage('path-simplification',rawPath.length,
    simplified.simplifiedPath.length,true,{code:'SIMPLIFIED_PATH_VALID'}));

  const densifier=new PathSimplifier();
  const baselineGeometry=request.options.passageSafety.enableWaypointDensification
    ?densifier.enforceSpacing(
      simplified.simplifiedPath,
      request.options.passageSafety.minimumWaypointSpacingM,
      request.options.passageSafety.maximumWaypointSpacingM)
    :[...simplified.simplifiedPath];
  diagnostics.stages.push(stage('waypoint-densification',
    simplified.simplifiedPath.length,baselineGeometry.length,true,{
      code:request.options.passageSafety.enableWaypointDensification
        ?'WAYPOINTS_DENSIFIED':'DENSIFICATION_DISABLED',
    }));
  const baseline=orient(
    baselineGeometry,request.startTheta??rawPath[0]!.theta,request.goalTheta);
  diagnostics.stages.push(stage(
    'orientation-generation',baselineGeometry.length,baseline.length,true,{
      code:'BASELINE_ORIENTATION_GENERATED',
    }));
  const baselineCollision=new PathCollisionValidator().findFirstDetailedCollision(
    grid,baseline,footprint,request.options.collisionSampleInterval);
  if(baselineCollision){
    const rawBaseline=orient(
      request.options.passageSafety.enableWaypointDensification
        ?densifier.enforceSpacing(
          rawPath,request.options.passageSafety.minimumWaypointSpacingM,
          request.options.passageSafety.maximumWaypointSpacingM)
        :rawPath,
      request.startTheta??rawPath[0]!.theta,request.goalTheta);
    if(!new PathCollisionValidator().pathIsFree(
      grid,rawBaseline,footprint,request.options.collisionSampleInterval)){
      const failed=addCollisionContext(stage(
        'footprint-collision-validation',baseline.length,0,false,{
          code:'BASELINE_FOOTPRINT_COLLISION',
          reason:'Baseline path intersects occupied, unknown, or out-of-map space.',
        }),grid,baseline,footprint,request.options.collisionSampleInterval,clearance);
      diagnostics.stages.push(failed);
      return failure(failed.reason!,rawPath,simplified.simplifiedPath);
    }
    baseline.splice(0,baseline.length,...rawBaseline);
    diagnostics.warnings.push('SIMPLIFICATION_REVERTED','SMOOTHING_REJECTED');
    diagnostics.stages.push(stage(
      'path-simplification',simplified.simplifiedPath.length,baseline.length,true,{
        severity:'warning',code:'SMOOTHING_REJECTED',
        reason:'The simplified geometry collided, so the collision-free raw geometry was restored.',
      }));
  }
  diagnostics.baselineStatus='BASELINE_PATH_VALID';
  diagnostics.stages.push(stage(
    'footprint-collision-validation',baseline.length,baseline.length,true,{
      code:'BASELINE_PATH_VALID',requiredClearanceM:footprint.safetyMargin,
      safetyMarginM:footprint.safetyMargin,
    }));

  let selected=[...baseline];
  const effectiveGoalTheta=request.goalTheta??baseline.at(-1)!.theta;
  let rejectedEnhancementPath:PathPoint[]|undefined;
  const reliablePolicy=request.options.policy==='reliable'||
    request.options.reliableBaselineMode;
  if(reliablePolicy){
    diagnostics.warnings.push('BASELINE_PATH_USED');
    diagnostics.stages.push(stage('doorway-detection',baseline.length,
      baseline.length,true,{severity:'info',code:'BASELINE_MODE_DISABLED_ENHANCEMENTS'}));
    diagnostics.stages.push(stage('doorway-alignment',baseline.length,
      baseline.length,true,{severity:'info',code:'BASELINE_MODE_DISABLED_ENHANCEMENTS'}));
    diagnostics.stages.push(stage('turn-feasibility',baseline.length,
      baseline.length,true,{severity:'info',code:'BASELINE_MODE_DISABLED_ENHANCEMENTS'}));
  }else{
    if(request.options.passageSafety.enableDoorwayDetection&&
      request.options.passageSafety.enableDoorAlignment){
      const doorProcessor=new RouteSafetyProcessor();
      try{
        const doorOptions={
          ...request.options,
          passageSafety:{
            ...request.options.passageSafety,
            enableTurnFeasibilityChecking:false,
          },
        };
        const doorResult=doorProcessor.process(
          grid,selected,request.footprint,doorOptions,
          request.startTheta??rawPath[0]!.theta,effectiveGoalTheta);
        diagnostics.detectedPassages=doorResult.diagnostics.detectedPassages;
        diagnostics.stages.push(stage('doorway-detection',selected.length,
          doorResult.diagnostics.detectedPassages.length,true,{
            code:doorResult.diagnostics.detectedPassages.length
              ?'CONFIRMED_DOORS_FOUND':'NO_CONFIRMED_DOOR',
          }));
        if(doorResult.diagnostics.routePassageCount>0){
          selected=doorResult.path;
          diagnostics.doorAlignmentStatus='APPLIED';
          diagnostics.finalPathSource='door-aligned';
          diagnostics.stages.push(stage(
            'doorway-alignment',baseline.length,selected.length,true,{
              code:'DOOR_ALIGNMENT_APPLIED',
            }));
        }else{
          diagnostics.doorAlignmentStatus='ADVANCED_ALIGNMENT_SKIPPED';
          diagnostics.warnings.push('DOOR_ALIGNMENT_SKIPPED');
          diagnostics.stages.push(stage(
            'doorway-alignment',baseline.length,baseline.length,true,{
              severity:'warning',code:'DOOR_ALIGNMENT_SKIPPED',
              reason:'No confirmed doorway met the confidence and geometry requirements.',
            }));
        }
      }catch(error){
        rejectedEnhancementPath=doorProcessor.lastCandidatePath;
        diagnostics.doorAlignmentStatus='ADVANCED_ALIGNMENT_SKIPPED';
        diagnostics.warnings.push('DOOR_ALIGNMENT_SKIPPED','BASELINE_PATH_USED');
        diagnostics.stages.push(addCollisionContext(stage(
          'doorway-alignment',baseline.length,baseline.length,true,{
            severity:'warning',code:'DOOR_ALIGNMENT_SKIPPED',
            reason:error instanceof Error?error.message:String(error),
          }),grid,rejectedEnhancementPath,footprint,
        request.options.collisionSampleInterval,clearance));
        selected=[...baseline];
      }
    }else{
      diagnostics.stages.push(stage('doorway-detection',baseline.length,
        baseline.length,true,{severity:'info',code:'DOORWAY_DETECTION_DISABLED'}));
      diagnostics.stages.push(stage('doorway-alignment',baseline.length,
        baseline.length,true,{severity:'info',code:'DOOR_ALIGNMENT_DISABLED'}));
    }

    if(request.options.passageSafety.enableTurnFeasibilityChecking){
      const turnProcessor=new RouteSafetyProcessor();
      try{
        const turnOptions={
          ...request.options,
          passageSafety:{
            ...request.options.passageSafety,
            enableDoorwayDetection:false,enableDoorAlignment:false,
          },
        };
        const beforeTurn=[...selected];
        const turnResult=turnProcessor.process(
          grid,selected,request.footprint,turnOptions,
          request.startTheta??rawPath[0]!.theta,effectiveGoalTheta);
        selected=turnResult.path;
        diagnostics.rejectedTurnLocations=turnResult.diagnostics.rejectedTurnLocations;
        diagnostics.relocatedTurnNodes=turnResult.diagnostics.relocatedTurnNodes;
        diagnostics.turnValidationStatus='APPLIED';
        diagnostics.finalPathSource='turn-enhanced';
        diagnostics.stages.push(stage(
          'turn-feasibility',beforeTurn.length,selected.length,true,{
            code:'TURN_ENHANCEMENT_APPLIED',
          }));
      }catch(error){
        rejectedEnhancementPath=turnProcessor.lastCandidatePath;
        diagnostics.turnValidationStatus='TURN_RELOCATION_SKIPPED';
        diagnostics.warnings.push('TURN_RELOCATION_SKIPPED','SMOOTHING_REJECTED',
          'BASELINE_PATH_USED');
        diagnostics.stages.push(addCollisionContext(stage(
          'turn-feasibility',selected.length,selected.length,true,{
            severity:'warning',code:'TURN_RELOCATION_SKIPPED',
            reason:error instanceof Error?error.message:String(error),
          }),grid,rejectedEnhancementPath,footprint,
        request.options.collisionSampleInterval,clearance));
        selected=diagnostics.finalPathSource==='door-aligned'?selected:[...baseline];
      }
    }else{
      diagnostics.stages.push(stage('turn-feasibility',selected.length,
        selected.length,true,{severity:'info',code:'TURN_ENHANCEMENT_DISABLED'}));
    }
  }

  const selectedCollision=new PathCollisionValidator().findFirstDetailedCollision(
    grid,selected,footprint,request.options.collisionSampleInterval);
  if(selectedCollision){
    rejectedEnhancementPath=selected;
    selected=[...baseline];
    diagnostics.finalPathSource='baseline';
    diagnostics.warnings.push('BASELINE_PATH_USED','SMOOTHING_REJECTED');
    diagnostics.stages.push(addCollisionContext(stage(
      'footprint-collision-validation',rejectedEnhancementPath.length,
      baseline.length,true,{
        severity:'warning',code:'SMOOTHING_REJECTED',
        reason:'The optional enhanced route collided; the valid baseline was restored.',
      }),grid,rejectedEnhancementPath,footprint,
    request.options.collisionSampleInterval,clearance));
  }
  diagnostics.minimumRouteClearanceM=selected.reduce((minimum,point)=>{
    const cell=transform.worldToGrid(point.x,point.y);
    if(!cell)return 0;
    return Math.min(minimum,
      clearance[cell.row*grid.metadata.width+cell.column]??0);
  },Number.POSITIVE_INFINITY);
  if(!Number.isFinite(diagnostics.minimumRouteClearanceM))
    diagnostics.minimumRouteClearanceM=0;
  diagnostics.largestHeadingChangeDeg=selected.slice(1).reduce((largest,point,index)=>{
    const delta=Math.abs(normalizeAngle(point.theta-selected[index]!.theta))*180/Math.PI;
    return Math.max(largest,delta);
  },0);
  diagnostics.rawPathStatus='RAW_PATH_FOUND';
  diagnostics.baselineStatus='BASELINE_PATH_VALID';
  if(diagnostics.finalPathSource==='baseline'&&
    !diagnostics.warnings.includes('BASELINE_PATH_USED'))
    diagnostics.warnings.push('BASELINE_PATH_USED');
  return {
    ...rawResult,success:true,error:undefined,rawPath,
    simplifiedPath:simplified.simplifiedPath,baselinePath:baseline,
    rejectedEnhancementPath,finalPath:selected,diagnostics,
    statistics:{
      ...rawResult.statistics,
      durationMs:performance.now()-started,
      rawPointCount:rawPath.length,
      simplifiedPointCount:simplified.simplifiedPath.length,
      finalPointCount:selected.length,
    },
  };
};

export class PlannerService {
  public plan(request: PlannerRequest): Promise<PlannerResult> {
    const worker = new Worker(
      new URL('../../workers/planner.worker.ts', import.meta.url),{type:'module'});
    return new Promise((resolve,reject) => {
      worker.onmessage = (event: MessageEvent<PlannerResult>) => {
        resolve(event.data);worker.terminate();
      };
      worker.onerror = (event) => {
        reject(new Error(event.message));worker.terminate();
      };
      worker.postMessage(request);
    });
  }
}
