import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import type {
  BoschRokitCorridor, BoschRokitCorridorSettings, OccupancyGrid, PathPoint, RobotFootprint,
} from '../types';
import { TranslationSweepChecker } from './TranslationSweepChecker';

export interface CorridorDiagnostic {
  edgeId?:string;
  edgeLengthM:number;
  sampleCount:number;
  leftClearanceM?:number;
  rightClearanceM?:number;
  robotWidthM:number;
  robotHalfWidthM:number;
  safetyMarginM:number;
  localizationMarginM:number;
  finalLeftCorridorM?:number;
  finalRightCorridorM?:number;
  corridorAdded:boolean;
  reason?:string;
}

export interface EdgeCorridorResult {
  corridor:null|BoschRokitCorridor;
  diagnostic:CorridorDiagnostic;
}

const round3=(value:number):number=>Math.round(value*1_000)/1_000;
const finiteNonNegative=(value:number):boolean=>Number.isFinite(value)&&value>=0;

/**
 * Measures the most restrictive lateral free space along an edge.
 * Unknown occupancy values are negative in the application's occupancy grid.
 */
export class EdgeCorridorPlanner {
  public calculate(
    start:PathPoint,
    end:PathPoint,
    grid:OccupancyGrid,
    footprint:RobotFootprint,
    settings:BoschRokitCorridorSettings,
    bodyTheta?:number,
  ):EdgeCorridorResult{
    const edgeLengthM=Math.hypot(end.x-start.x,end.y-start.y);
    const reserve=footprint.width/2+settings.obstacleSafetyMarginM+settings.localizationMarginM;
    const base:CorridorDiagnostic={
      edgeLengthM,sampleCount:0,robotWidthM:footprint.width,robotHalfWidthM:footprint.width/2,
      safetyMarginM:settings.obstacleSafetyMarginM,
      localizationMarginM:settings.localizationMarginM,corridorAdded:false,
    };
    const omit=(reason:string,extra:Partial<CorridorDiagnostic>={}):EdgeCorridorResult=>({
      corridor:null,diagnostic:{...base,...extra,reason},
    });
    if(!settings.enableBoschRokitCorridorExtension)return omit('Bosch ROKIT corridor extension is disabled.');
    if(!finiteNonNegative(footprint.width)||footprint.width===0)return omit('Robot width is invalid.');
    if(!Number.isFinite(grid.metadata.resolution)||grid.metadata.resolution<=0)
      return omit('Occupancy-grid resolution is invalid.');
    if(!Number.isFinite(edgeLengthM)||edgeLengthM<=1e-6)return omit('Edge length is zero or invalid.');
    if(![
      settings.obstacleSafetyMarginM,settings.localizationMarginM,settings.minCorridorWidthM,
      settings.maxCorridorWidthM,settings.corridorSampleSpacingM,
    ].every(finiteNonNegative)||settings.maxCorridorWidthM<=0||settings.corridorSampleSpacingM<=0)
      return omit('Corridor settings contain invalid values.');
    if(!grid.metadata.mapId.trim())return omit('Occupancy-grid mapId is unresolved.');
    const edgeTheta=Math.atan2(end.y-start.y,end.x-start.x);
    const centerlineFootprint:RobotFootprint={...footprint,safetyMargin:0};
    const collisionGrid=settings.unknownCellsBlocked?grid:{
      ...grid,data:grid.data.map((value)=>value<0?0:value),
    };
    if(!new TranslationSweepChecker().segmentIsFreeAtHeading(
      collisionGrid,start,end,centerlineFootprint,
      Math.min(settings.corridorSampleSpacingM,grid.metadata.resolution/2),bodyTheta??edgeTheta,
    ))return omit('Edge or robot footprint intersects occupied/unknown space.');

    const sampleCount=Math.max(2,Math.ceil(edgeLengthM/settings.corridorSampleSpacingM)+1);
    const leftNormal={x:-Math.sin(edgeTheta),y:Math.cos(edgeTheta)};
    const rightNormal={x:-leftNormal.x,y:-leftNormal.y};
    let minLeft=Number.POSITIVE_INFINITY;let minRight=Number.POSITIVE_INFINITY;
    for(let index=0;index<sampleCount;index+=1){
      const t=index/(sampleCount-1);
      const point={x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t};
      minLeft=Math.min(minLeft,this.rayClearance(point,leftNormal,grid,reserve+settings.maxCorridorWidthM,
        settings.unknownCellsBlocked));
      minRight=Math.min(minRight,this.rayClearance(point,rightNormal,grid,reserve+settings.maxCorridorWidthM,
        settings.unknownCellsBlocked));
    }
    const rawLeft=Math.max(0,minLeft);const rawRight=Math.max(0,minRight);
    const availableLeft=Math.max(0,rawLeft-reserve);
    const availableRight=Math.max(0,rawRight-reserve);
    const leftWidth=availableLeft>=settings.minCorridorWidthM
      ?Math.min(availableLeft,settings.maxCorridorWidthM):0;
    const rightWidth=availableRight>=settings.minCorridorWidthM
      ?Math.min(availableRight,settings.maxCorridorWidthM):0;
    const measured={
      sampleCount,leftClearanceM:round3(rawLeft),rightClearanceM:round3(rawRight),
      finalLeftCorridorM:round3(leftWidth),finalRightCorridorM:round3(rightWidth),
    };
    if(rawLeft+1e-9<reserve||rawRight+1e-9<reserve)
      return omit('Edge passes too close to a wall for the configured robot and margins.',measured);
    if(leftWidth===0&&rightWidth===0)
      return omit('Available lateral deviation is below the configured minimum.',measured);
    const corridor:BoschRokitCorridor={
      leftWidth:round3(leftWidth),rightWidth:round3(rightWidth),
      corridorRefPoint:settings.corridorRefPoint,
    };
    return {corridor,diagnostic:{...base,...measured,corridorAdded:true}};
  }

  private rayClearance(
    origin:{x:number;y:number},
    normal:{x:number;y:number},
    grid:OccupancyGrid,
    maximum:number,
    unknownCellsBlocked:boolean,
  ):number{
    const transform=new CoordinateTransformer(grid.metadata);
    const step=Math.max(grid.metadata.resolution/3,0.005);
    let lastFree=0;
    for(let distance=step;distance<=maximum+step/2;distance+=step){
      const cell=transform.worldToGrid(origin.x+normal.x*distance,origin.y+normal.y*distance);
      if(!cell)return lastFree;
      const value=grid.data[transform.index(cell)]??-1;
      const blocked=value>=grid.metadata.occupiedThreshold||(unknownCellsBlocked&&value<0);
      if(blocked)return lastFree;
      lastFree=Math.min(distance,maximum);
    }
    return Math.min(lastFree,maximum);
  }
}
