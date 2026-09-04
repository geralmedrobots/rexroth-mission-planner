import { normalizeAngle } from '../geometry/angles';
import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import type {
  DetectedPassage, OccupancyGrid, PathPoint, PlannerOptions, RobotFootprint,
} from '../types';
import { isOccupiedValue } from './ObstacleInflation';
import { PathCollisionValidator } from './PathCollisionValidator';

interface RayHit {point:{x:number;y:number};distanceM:number}

export class PassageDetector {
  private readonly collision=new PathCollisionValidator();

  public detect(
    grid:OccupancyGrid,
    path:PathPoint[],
    footprint:RobotFootprint,
    options:PlannerOptions,
  ):DetectedPassage[]{
    if(!options.passageSafety.enableDoorwayDetection||path.length<2)return [];
    const sampled=this.samplePath(path,Math.max(grid.metadata.resolution,0.10));
    const candidates:Array<DetectedPassage&{pathIndex:number}>=[];
    const maximum=options.passageSafety.maximumPassageWidthM;
    const required=Math.max(
      options.passageSafety.minimumPassageWidthM,
      footprint.width+2*footprint.safetyMargin,
    );
    sampled.forEach((point,pathIndex)=>{
      const next=sampled[Math.min(pathIndex+1,sampled.length-1)]!;
      const previous=sampled[Math.max(0,pathIndex-1)]!;
      const heading=Math.atan2(next.y-previous.y,next.x-previous.x);
      if(!Number.isFinite(heading))return;
      const normal={x:-Math.sin(heading),y:Math.cos(heading)};
      const left=this.raycast(grid,point,normal,maximum/2+grid.metadata.resolution*2);
      const right=this.raycast(grid,point,{x:-normal.x,y:-normal.y},
        maximum/2+grid.metadata.resolution*2);
      if(!left||!right)return;
      const width=left.distanceM+right.distanceM;
      if(width<required||width>maximum)return;
      const axisHeading=normalizeAngle(heading);
      const margin=footprint.safetyMargin;
      const usableWidth=width-footprint.width-2*margin;
      const centre={
        x:(left.point.x+right.point.x)/2,
        y:(left.point.y+right.point.y)/2,
      };
      const entryDistance=Math.max(
        options.passageSafety.doorAlignmentDistanceBeforeM,
        options.passageSafety.minimumDoorApproachStraightLengthM);
      const exitDistance=options.passageSafety.doorAlignmentDistanceAfterM;
      const entry={x:centre.x-Math.cos(axisHeading)*entryDistance,
        y:centre.y-Math.sin(axisHeading)*entryDistance,theta:axisHeading};
      const exit={x:centre.x+Math.cos(axisHeading)*exitDistance,
        y:centre.y+Math.sin(axisHeading)*exitDistance,theta:axisHeading};
      const alignedFootprint={...footprint};
      if(!this.collision.pointIsFree(grid,{...centre,theta:axisHeading},alignedFootprint))
        return;
      const confidence=Math.max(0,Math.min(1,
        0.55+0.45*(1-Math.abs(left.distanceM-right.distanceM)/Math.max(width,0.001))));
      candidates.push({
        id:`passage-${pathIndex}`,
        centre:{...centre,theta:axisHeading},
        axisHeading,
        normalHeading:normalizeAngle(axisHeading+Math.PI/2),
        widthM:width,
        usableWidthM:usableWidth,
        entry,
        exit,
        boundaryA:{...left.point,theta:0},
        boundaryB:{...right.point,theta:0},
        confidence,
        rotationInsideSafe:this.collision.rotationIsFree(
          grid,centre,axisHeading,axisHeading+Math.PI/2,footprint,
          options.passageSafety.rotationCollisionSampleDeg*Math.PI/180),
        pathIndex,
      });
    });
    const groups:Array<typeof candidates>=[];
    for(const candidate of candidates){
      const group=groups.at(-1);
      const previous=group?.at(-1);
      if(!group||!previous||candidate.pathIndex-previous.pathIndex>2||
        Math.abs(normalizeAngle(candidate.axisHeading-previous.axisHeading))>15*Math.PI/180)
        groups.push([candidate]);
      else group.push(candidate);
    }
    return groups.filter((group)=>group.length>=2).map((group)=>{
      const narrowest=[...group].sort((a,b)=>a.widthM-b.widthM)[0]!;
      return {
        id:`passage-${crypto.randomUUID()}`,
        centre:narrowest.centre,axisHeading:narrowest.axisHeading,
        normalHeading:narrowest.normalHeading,widthM:narrowest.widthM,
        usableWidthM:narrowest.usableWidthM,entry:narrowest.entry,exit:narrowest.exit,
        boundaryA:narrowest.boundaryA,boundaryB:narrowest.boundaryB,
        confidence:narrowest.confidence,rotationInsideSafe:narrowest.rotationInsideSafe,
      };
    }).filter((passage)=>
      passage.confidence>=options.passageSafety.minimumDoorConfidence);
  }

  private samplePath(path:PathPoint[],spacing:number):PathPoint[]{
    const result=[path[0]!];
    for(let index=1;index<path.length;index+=1){
      const start=path[index-1]!;
      const end=path[index]!;
      const distance=Math.hypot(end.x-start.x,end.y-start.y);
      const count=Math.max(1,Math.ceil(distance/spacing));
      for(let sample=1;sample<=count;sample+=1){
        const ratio=sample/count;
        result.push({
          x:start.x+(end.x-start.x)*ratio,
          y:start.y+(end.y-start.y)*ratio,
          theta:Math.atan2(end.y-start.y,end.x-start.x),
        });
      }
    }
    return result;
  }

  private raycast(
    grid:OccupancyGrid,
    origin:Pick<PathPoint,'x'|'y'>,
    direction:{x:number;y:number},
    maximum:number,
  ):RayHit|null{
    const transform=new CoordinateTransformer(grid.metadata);
    const step=Math.max(grid.metadata.resolution/2,0.01);
    for(let distance=step;distance<=maximum;distance+=step){
      const point={x:origin.x+direction.x*distance,y:origin.y+direction.y*distance};
      const cell=transform.worldToGrid(point.x,point.y);
      if(!cell)return null;
      if(isOccupiedValue(grid.data[transform.index(cell)]??100,
        grid.metadata.occupiedThreshold))return {point,distanceM:distance};
    }
    return null;
  }
}
