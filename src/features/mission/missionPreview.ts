import {PlanningCoordinator, type CoordinatedPlanningResult} from '../planning/PlanningCoordinator';
import {PathCollisionValidator} from '../../domain/planner/PathCollisionValidator';
import {VdaOrderBuilder} from '../../domain/vda5050/VdaOrderBuilder';
import {VdaOrderValidator,type OrderValidationContext} from '../../domain/vda5050/VdaOrderValidator';
import {validateDestination} from './destinationValidation';
import type {AppState} from '../../stores/appStore';
import type {SavedDestination} from '../destinations/destinationStore';
import {resolveStop,type MissionTemplate} from './missionLibrary';
import type {RobotPose} from '../../domain/types';

interface Inputs {
  template:MissionTemplate;index:number;app:AppState;points:SavedDestination[];pose?:RobotPose;
  context:OrderValidationContext;limit:number;sessionId:string;
}
export async function previewMission({template,index,app,points,pose,context,limit,sessionId}:Inputs){
  const grid=app.grid;
  if(!grid||template.mapId!==grid.metadata.mapId)throw Error('Load the mission’s planning map.');
  if(!template.name.trim()||!template.stops.length||!template.stops[index])throw Error('Enter a name and add a destination.');
  const stops=template.stops.slice(index).map((stop,i)=>{
    try{
      const resolved=resolveStop(stop,template.mapId,points);
      const check=validateDestination(resolved.pose,template.mapId,grid,app.inflatedGrid??grid);
      if(!check.valid)throw Error(check.message);
      return resolved;
    }catch(e){throw Error(`Destination ${index+i+1} (${stop.label}): ${e instanceof Error?e.message:e}`);}
  });
  if(!pose||pose.mapId!==template.mapId)throw Error('A fresh robot pose on the mission map is required to preview the route.');
  const planner=new PlanningCoordinator();
  const legs:CoordinatedPlanningResult[]=[];
  let start=pose,distance=0;
  const warnings:string[]=[];
  for(const [i,{stop,pose:goal,moved}] of stops.entries()){
    try{
      if(moved)warnings.push(`${stop.label} moved. This preview uses its current position.`);
      let result:CoordinatedPlanningResult|undefined;
      if(app.plannerMode==='manual'){
        const path=[start,goal];
        if(!new PathCollisionValidator().pathIsFree(grid,path,app.footprint,app.plannerOptions.collisionSampleInterval))throw Error('Manual segment intersects an obstacle.');
        result={success:true,rawPath:path,simplifiedPath:path,finalPath:path,planningConfiguration:planner.createSnapshot(app),
          statistics:{visitedCells:0,durationMs:0,rawPointCount:2,simplifiedPointCount:2,finalPointCount:2}};
      }else{
        result=await planner.plan({grid,start,goal,waypoints:[],plannerMode:app.plannerMode,plannerOptions:app.plannerOptions,
          footprint:app.footprint,orderSettings:app.orderSettings,goalThetaExplicit:stop.theta!==undefined,sessionId});
      }
      if(!result?.success||result.finalPath.length<2)throw Error(result?.error??'No valid route.');
      const order=new VdaOrderBuilder().build(result.finalPath,{robotPose:start,activeMapId:template.mapId,finalGoalTheta:stop.theta,
        planningConfiguration:result.planningConfiguration,motionPlan:result.motionPlan,corridorPlanning:{grid,footprint:app.footprint,plannerOptions:app.plannerOptions}},app.orderSettings);
      if(order.nodes.length>limit)throw Error(`Order exceeds the configured limit of ${limit} nodes.`);
      // Downstream legs use the projected arrival pose for preview only.
      // Every leg must pass validation with real telemetry at its own authorization.
      {
        const validation=new VdaOrderValidator().validate(order,i===0?context:{...context,currentPose:start});
        if(!validation.valid)throw Error(validation.errors.map(e=>e.message).join(' '));
        warnings.push(...validation.warnings.map(w=>w.message));
      }
      const path=result.finalPath;
      for(let n=1;n<path.length;n++)distance+=Math.hypot(path[n]!.x-path[n-1]!.x,path[n]!.y-path[n-1]!.y);
      legs.push(result);
      start={...goal,theta:order.nodes[order.nodes.length-1]!.nodePosition.theta??goal.theta};
    }catch(e){throw Error(`Leg ${index+i+1} to ${stop.label}: ${e instanceof Error?e.message:e}`);}
  }
  return {legs,stops,distance,warnings,template,index,start:pose};
}
export type MissionPreview=Awaited<ReturnType<typeof previewMission>>;
