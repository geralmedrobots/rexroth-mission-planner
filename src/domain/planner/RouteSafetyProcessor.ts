import { normalizeAngle } from '../geometry/angles';
import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import type {
  DetectedPassage, OccupancyGrid, PathPoint, PlannerDiagnostics, PlannerOptions,
  RobotFootprint,
} from '../types';
import { buildClearanceField } from './ClearanceField';
import { PassageDetector } from './PassageDetector';
import { PathCollisionValidator } from './PathCollisionValidator';

export class RouteSafetyError extends Error {
  public constructor(message:string){super(message);this.name='RouteSafetyError';}
}

export class RouteSafetyProcessor {
  private readonly collision=new PathCollisionValidator();
  public lastCandidatePath:PathPoint[]=[];

  public process(
    grid:OccupancyGrid,
    path:PathPoint[],
    footprint:RobotFootprint,
    options:PlannerOptions,
    startTheta:number,
    goalTheta:number,
  ):{path:PathPoint[];diagnostics:PlannerDiagnostics}{
    if(path.length<2)throw new RouteSafetyError('A safe route requires at least two points.');
    this.lastCandidatePath=[...path];
    const planningFootprint=this.planningFootprint(footprint,options);
    const clearance=buildClearanceField(grid);
    const passages=new PassageDetector().detect(grid,path,planningFootprint,options);
    let route=options.passageSafety.enableDoorAlignment
      ?this.insertPassageAlignment(grid,path,passages,planningFootprint,options):[...path];
    const beforeDensification=route.length;
    if(options.passageSafety.enableWaypointDensification)
      route=this.densify(route,options.passageSafety.preferredWaypointSpacingM,
        options.passageSafety.maximumWaypointSpacingM,
        options.passageSafety.minimumWaypointSpacingM);
    route=this.orient(route,startTheta,goalTheta);
    this.lastCandidatePath=[...route];
    route=this.ensureFirstReachable(grid,route,planningFootprint,options,startTheta);
    const turnResult=options.passageSafety.enableTurnFeasibilityChecking
      ?this.validateTurns(grid,route,planningFootprint,options):{
        route,rejected:[] as PathPoint[],relocated:0,
      };
    route=this.orient(turnResult.route,startTheta,goalTheta);
    this.validateRoute(grid,route,planningFootprint,options);
    const transformer=new CoordinateTransformer(grid.metadata);
    let minimumClearance=Number.POSITIVE_INFINITY;
    route.forEach((point)=>{
      const cell=transformer.worldToGrid(point.x,point.y);
      if(cell)minimumClearance=Math.min(minimumClearance,
        clearance[cell.row*grid.metadata.width+cell.column]!);
    });
    let largest=0;
    for(let index=1;index<route.length-1;index+=1){
      const incoming=Math.atan2(route[index]!.y-route[index-1]!.y,
        route[index]!.x-route[index-1]!.x);
      const outgoing=Math.atan2(route[index+1]!.y-route[index]!.y,
        route[index+1]!.x-route[index]!.x);
      largest=Math.max(largest,Math.abs(normalizeAngle(outgoing-incoming))*180/Math.PI);
    }
    return {
      path:route,
      diagnostics:{
        detectedPassages:passages,
        routePassageCount:new Set(route.flatMap((point)=>point.passageId?[point.passageId]:[])).size,
        insertedNodeCount:Math.max(0,route.length-beforeDensification),
        rejectedTurnLocations:turnResult.rejected,
        relocatedTurnNodes:turnResult.relocated,
        minimumRouteClearanceM:Number.isFinite(minimumClearance)?minimumClearance:0,
        largestHeadingChangeDeg:largest,
        stages:[],
        warnings:[],
        finalPathSource:turnResult.relocated||turnResult.rejected.length
          ?'turn-enhanced':passages.length?'door-aligned':'baseline',
        rawPathStatus:'RAW_PATH_FOUND',
        baselineStatus:'BASELINE_PATH_VALID',
        doorAlignmentStatus:passages.length?'APPLIED':'NOT_RUN',
        turnValidationStatus:options.passageSafety.enableTurnFeasibilityChecking
          ?'APPLIED':'NOT_RUN',
      },
    };
  }

  private insertPassageAlignment(
    grid:OccupancyGrid,
    path:PathPoint[],
    passages:DetectedPassage[],
    footprint:RobotFootprint,
    options:PlannerOptions,
  ):PathPoint[]{
    const insertions=passages.map((passage)=>{
      let best={segment:0,distance:Number.POSITIVE_INFINITY};
      for(let index=0;index<path.length-1;index+=1){
        const distance=this.pointToSegmentDistance(passage.centre,path[index]!,path[index+1]!);
        if(distance<best.distance)best={segment:index,distance};
      }
      const segmentHeading=Math.atan2(
        path[best.segment+1]!.y-path[best.segment]!.y,
        path[best.segment+1]!.x-path[best.segment]!.x);
      const axis=Math.cos(normalizeAngle(passage.axisHeading-segmentHeading))>=0
        ?passage.axisHeading:normalizeAngle(passage.axisHeading+Math.PI);
      const centre={...passage.centre,theta:axis,kind:'door-centre' as const,
        passageId:passage.id,orientationLocked:true};
      const beforeDistance=Math.max(
        options.passageSafety.doorAlignmentDistanceBeforeM,
        options.passageSafety.minimumDoorApproachStraightLengthM);
      const pre={x:centre.x-Math.cos(axis)*beforeDistance,
        y:centre.y-Math.sin(axis)*beforeDistance,
        theta:axis,kind:'door-alignment' as const,passageId:passage.id,
        orientationLocked:true};
      const exit={x:centre.x+Math.cos(axis)*options.passageSafety.doorAlignmentDistanceAfterM,
        y:centre.y+Math.sin(axis)*options.passageSafety.doorAlignmentDistanceAfterM,
        theta:axis,kind:'door-exit' as const,passageId:passage.id,
        orientationLocked:true};
      return {...best,points:[pre,centre,exit]};
    }).sort((a,b)=>b.segment-a.segment);
    const output=[...path];
    for(const insertion of insertions){
      const from=output[insertion.segment]!;
      const to=output[insertion.segment+1]!;
      const candidate=[from,...insertion.points,to];
      if(candidate.slice(1).every((point,index)=>this.collision.segmentIsFree(
        grid,candidate[index]!,point,footprint,options.collisionSampleInterval)))
        output.splice(insertion.segment+1,0,...insertion.points);
    }
    return this.removeDuplicates(output,0.001);
  }

  private densify(path:PathPoint[],preferred:number,maximum:number,minimum:number):PathPoint[]{
    const spacing=Math.min(Math.max(preferred,minimum),maximum);
    const result=[path[0]!];
    for(let index=1;index<path.length;index+=1){
      const start=result.at(-1)!;
      const end=path[index]!;
      const distance=Math.hypot(end.x-start.x,end.y-start.y);
      if(distance<0.001)continue;
      const segments=Math.max(1,Math.ceil(distance/Math.min(spacing,maximum)));
      const insideSamePassage=Boolean(
        start.passageId&&start.passageId===end.passageId);
      for(let sample=1;sample<=segments;sample+=1){
        const ratio=sample/segments;
        const inserted:PathPoint={
          ...end,
          x:start.x+(end.x-start.x)*ratio,
          y:start.y+(end.y-start.y)*ratio,
          kind:sample===segments?end.kind:'normal',
          passageId:insideSamePassage||sample===segments?end.passageId:undefined,
          orientationLocked:insideSamePassage||
            Boolean(end.orientationLocked&&sample===segments),
          theta:insideSamePassage||sample===segments?end.theta:
            Math.atan2(end.y-start.y,end.x-start.x),
        };
        if(Math.hypot(inserted.x-result.at(-1)!.x,inserted.y-result.at(-1)!.y)>=
          Math.min(minimum,maximum)/2||sample===segments)result.push(inserted);
      }
    }
    return this.removeDuplicates(result,0.001);
  }

  private orient(path:PathPoint[],startTheta:number,goalTheta:number):PathPoint[]{
    return path.map((point,index)=>{
      if(index===0)return {...point,theta:normalizeAngle(startTheta)};
      if(index===path.length-1)return {...point,theta:normalizeAngle(goalTheta)};
      if(point.orientationLocked)return {...point,theta:normalizeAngle(point.theta)};
      const next=path[index+1]!;
      return {...point,theta:normalizeAngle(Math.atan2(next.y-point.y,next.x-point.x))};
    });
  }

  private validateTurns(
    grid:OccupancyGrid,
    route:PathPoint[],
    footprint:RobotFootprint,
    options:PlannerOptions,
  ):{route:PathPoint[];rejected:PathPoint[];relocated:number}{
    let output=[...route];
    const rejected:PathPoint[]=[];
    let relocated=0;
    for(let index=1;index<output.length-1;index+=1){
      const previous=output[index-1]!;
      const point=output[index]!;
      const next=output[index+1]!;
      const incoming=Math.atan2(point.y-previous.y,point.x-previous.x);
      const outgoing=Math.atan2(next.y-point.y,next.x-point.x);
      const change=Math.abs(normalizeAngle(outgoing-incoming));
      const nearDoor=this.distanceToPassagePoint(output,index) <=
        options.passageSafety.doorProtectionDistanceM;
      const limit=(nearDoor?Math.min(
        options.passageSafety.maximumHeadingChangeNearDoorDeg,
        options.passageSafety.maximumDoorApproachAngleDeg):
        options.passageSafety.maximumHeadingChangePerNodeDeg)*Math.PI/180;
      const rotationSafe=this.collision.rotationIsFree(
        grid,point,incoming,outgoing,footprint,
        options.passageSafety.rotationCollisionSampleDeg*Math.PI/180);
      const rounded=change>limit||!rotationSafe
        ?this.roundCorner(grid,previous,point,next,footprint,limit):null;
      if(rounded){
        output.splice(index-1,3,...rounded);
        index=Math.max(0,index-2);
        continue;
      }
      if(change<=limit&&rotationSafe)continue;
      rejected.push(point);
      const moved=this.relocateTurn(grid,output,index,footprint,options);
      if(moved){
        output=moved;
        relocated+=1;
        index=0;
        continue;
      }
      throw new RouteSafetyError(
        `No collision-free forward transition exists for the ${(
          change*180/Math.PI).toFixed(1)}° turn near (${point.x.toFixed(2)}, `+
        `${point.y.toFixed(2)}); swept rotation safe=${rotationSafe}, `+
        `door-protected=${nearDoor}.`,
      );
    }
    const final=output.at(-1)!;
    const beforeFinal=output.at(-2)!;
    const finalIncoming=Math.atan2(
      final.y-beforeFinal.y,final.x-beforeFinal.x);
    if(Math.abs(normalizeAngle(final.theta-finalIncoming))>Math.PI/180&&
      !this.collision.rotationIsFree(
        grid,final,finalIncoming,final.theta,footprint,
        options.passageSafety.rotationCollisionSampleDeg*Math.PI/180))
      throw new RouteSafetyError(
        'The requested final orientation requires an unsafe rotation at the goal.',
      );
    return {route:this.removeDuplicates(output,0.001),rejected,relocated};
  }

  private roundCorner(
    grid:OccupancyGrid,
    previous:PathPoint,
    corner:PathPoint,
    next:PathPoint,
    footprint:RobotFootprint,
    limit:number,
  ):PathPoint[]|null{
    if(corner.passageId)return null;
    const incomingLength=Math.hypot(corner.x-previous.x,corner.y-previous.y);
    const outgoingLength=Math.hypot(next.x-corner.x,next.y-corner.y);
    const trim=Math.min(0.30,incomingLength*0.35,outgoingLength*0.35);
    if(trim<0.05)return null;
    const before={...corner,
      x:corner.x+(previous.x-corner.x)*trim/incomingLength,
      y:corner.y+(previous.y-corner.y)*trim/incomingLength,
      kind:'turn-transition' as const};
    const after={...corner,
      x:corner.x+(next.x-corner.x)*trim/outgoingLength,
      y:corner.y+(next.y-corner.y)*trim/outgoingLength,
      kind:'turn-transition' as const};
    const incoming=Math.atan2(corner.y-previous.y,corner.x-previous.x);
    const outgoing=Math.atan2(next.y-corner.y,next.x-corner.x);
    const count=Math.max(2,Math.ceil(Math.abs(normalizeAngle(outgoing-incoming))/
      Math.max(limit,1*Math.PI/180)));
    const curve:PathPoint[]=[previous];
    for(let sample=0;sample<=count;sample+=1){
      const t=sample/count;
      const inverse=1-t;
      curve.push({
        x:inverse*inverse*before.x+2*inverse*t*corner.x+t*t*after.x,
        y:inverse*inverse*before.y+2*inverse*t*corner.y+t*t*after.y,
        theta:0,kind:'turn-transition',
      });
    }
    curve.push(next);
    const oriented=this.orient(curve,incoming,outgoing);
    return oriented.slice(1).every((point,index)=>this.collision.segmentIsFree(
      grid,oriented[index]!,point,footprint,Math.min(grid.metadata.resolution/3,0.02)))
      ?oriented:null;
  }

  private relocateTurn(
    grid:OccupancyGrid,
    route:PathPoint[],
    turnIndex:number,
    footprint:RobotFootprint,
    options:PlannerOptions,
  ):PathPoint[]|null{
    const turn=route[turnIndex]!;
    const target=turn.passageId?turn:route[turnIndex+1]!;
    for(let candidateIndex=turnIndex-1;candidateIndex>=1;candidateIndex-=1){
      const candidate=route[candidateIndex]!;
      if(route.slice(candidateIndex+1,turnIndex).some((point)=>point.passageId))break;
      const incoming=Math.atan2(candidate.y-route[candidateIndex-1]!.y,
        candidate.x-route[candidateIndex-1]!.x);
      const outgoing=Math.atan2(target.y-candidate.y,target.x-candidate.x);
      if(!this.collision.rotationIsFree(grid,candidate,incoming,outgoing,footprint,
        options.passageSafety.rotationCollisionSampleDeg*Math.PI/180))continue;
      if(!this.collision.segmentIsFree(grid,candidate,target,footprint,
        options.collisionSampleInterval))continue;
      return [
        ...route.slice(0,candidateIndex+1),
        ...this.densify([candidate,target],
          options.passageSafety.preferredWaypointSpacingM,
          options.passageSafety.maximumWaypointSpacingM,
          options.passageSafety.minimumWaypointSpacingM).slice(1),
        ...route.slice(turn.passageId?turnIndex+1:turnIndex+2),
      ];
    }
    return null;
  }

  private validateRoute(
    grid:OccupancyGrid,
    route:PathPoint[],
    footprint:RobotFootprint,
    options:PlannerOptions,
  ):void{
    if(route.some((point)=>![point.x,point.y,point.theta].every(Number.isFinite)))
      throw new RouteSafetyError('The oriented route contains NaN or Infinity.');
    for(let index=1;index<route.length;index+=1){
      const distance=Math.hypot(route[index]!.x-route[index-1]!.x,
        route[index]!.y-route[index-1]!.y);
      if(distance<0.001)throw new RouteSafetyError('The route contains a zero-length edge.');
      if(options.passageSafety.enableWaypointDensification&&
        distance>options.passageSafety.maximumWaypointSpacingM+1e-6)
        throw new RouteSafetyError('The route contains an over-length waypoint segment.');
      if(!this.collision.segmentIsFree(grid,route[index-1]!,route[index]!,footprint,
        options.collisionSampleInterval))
        throw new RouteSafetyError('The complete footprint intersects blocked map space.');
      if(route[index-1]!.passageId&&
        route[index-1]!.passageId===route[index]!.passageId){
        const segmentHeading=Math.atan2(
          route[index]!.y-route[index-1]!.y,
          route[index]!.x-route[index-1]!.x);
        const headingError=Math.abs(normalizeAngle(
          segmentHeading-route[index]!.theta))*180/Math.PI;
        if(headingError>options.passageSafety.maximumHeadingErrorInsideDoorDeg)
          throw new RouteSafetyError(
            `Passage heading error ${headingError.toFixed(1)}° exceeds the configured limit.`,
          );
      }
    }
  }

  private planningFootprint(
    footprint:RobotFootprint,
    options:PlannerOptions,
  ):RobotFootprint{
    return {
      ...footprint,
      safetyMargin:Math.max(
        footprint.safetyMargin,
        options.passageSafety.planningSafetyMarginM+
          options.passageSafety.localizationMarginM),
    };
  }

  private ensureFirstReachable(
    grid:OccupancyGrid,
    route:PathPoint[],
    footprint:RobotFootprint,
    options:PlannerOptions,
    startTheta:number,
  ):PathPoint[]{
    if(route.length<2||!options.passageSafety.enableTurnFeasibilityChecking)return route;
    const first=route[0]!;
    const heading=Math.atan2(route[1]!.y-first.y,route[1]!.x-first.x);
    const change=Math.abs(normalizeAngle(heading-startTheta));
    const limit=options.passageSafety.maximumHeadingChangePerNodeDeg*Math.PI/180;
    if(change<=limit||this.collision.rotationIsFree(
      grid,first,startTheta,heading,footprint,
      options.passageSafety.rotationCollisionSampleDeg*Math.PI/180))return route;
    const advanceDistance=Math.min(0.25,
      Math.hypot(route[1]!.x-first.x,route[1]!.y-first.y)/2);
    const advance:PathPoint={
      x:first.x+Math.cos(startTheta)*advanceDistance,
      y:first.y+Math.sin(startTheta)*advanceDistance,
      theta:startTheta,kind:'turn-transition',
    };
    if(advanceDistance>=0.05&&
      this.collision.segmentIsFree(grid,first,advance,footprint,
        options.collisionSampleInterval)&&
      this.collision.segmentIsFree(grid,advance,route[1]!,footprint,
        options.collisionSampleInterval))
      return [first,advance,...route.slice(1)];
    throw new RouteSafetyError(
      'The first route segment is not reachable from the current yaw without an unsafe rotation.',
    );
  }

  private distanceToPassagePoint(path:PathPoint[],index:number):number{
    const point=path[index]!;
    let minimum=point.passageId?0:Number.POSITIVE_INFINITY;
    path.forEach((candidate)=>{
      if(candidate.passageId)minimum=Math.min(minimum,
        Math.hypot(candidate.x-point.x,candidate.y-point.y));
    });
    return minimum;
  }

  private removeDuplicates(path:PathPoint[],epsilon:number):PathPoint[]{
    return path.filter((point,index)=>index===0||
      Math.hypot(point.x-path[index-1]!.x,point.y-path[index-1]!.y)>epsilon);
  }

  private pointToSegmentDistance(
    point:Pick<PathPoint,'x'|'y'>,
    start:Pick<PathPoint,'x'|'y'>,
    end:Pick<PathPoint,'x'|'y'>,
  ):number{
    const dx=end.x-start.x;
    const dy=end.y-start.y;
    const length=dx*dx+dy*dy;
    if(length===0)return Math.hypot(point.x-start.x,point.y-start.y);
    const ratio=Math.max(0,Math.min(1,
      ((point.x-start.x)*dx+(point.y-start.y)*dy)/length));
    return Math.hypot(point.x-start.x-ratio*dx,point.y-start.y-ratio*dy);
  }
}
