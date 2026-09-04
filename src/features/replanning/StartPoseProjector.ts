import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import { isOccupiedValue } from '../../domain/planner/ObstacleInflation';
import type {
  GridCell, OccupancyGrid, RobotFootprint, RobotPose,
} from '../../domain/types';
import { PathCollisionValidator } from '../../domain/planner/PathCollisionValidator';
import type { StartProjectionDiagnostic, TemporaryMapResult } from './types';

export const START_PROJECTION_RADII_M=[0.2,0.4,0.6,1.0] as const;

export interface StartProjectionResult {
  cell:GridCell|null;
  diagnostic:StartProjectionDiagnostic;
}

const isFree=(grid:OccupancyGrid,cell:GridCell):boolean=>{
  const {width,height,occupiedThreshold}=grid.metadata;
  return cell.row>=0&&cell.column>=0&&cell.row<height&&cell.column<width&&
    !isOccupiedValue(
      grid.data[cell.row*width+cell.column]??100,
      occupiedThreshold,
    );
};

/**
 * Projects the planning start only. The returned grid-cell centre must never be
 * used as the live robot pose or as VDA Node 0.
 */
export const projectStartPoseToFreeCell=(
  grid:OccupancyGrid,
  robotPose:RobotPose,
  enabled=true,
  goalCell?:GridCell,
  footprint?:RobotFootprint,
  maximumProjectionDistanceM=1.0,
):StartProjectionResult=>{
  const transform=new CoordinateTransformer(grid.metadata);
  const originalCell=transform.worldToGrid(robotPose.x,robotPose.y);
  if(!originalCell)return {
    cell:null,
    diagnostic:{
      originalPose:{x:robotPose.x,y:robotPose.y},
      originalCell:{row:-1,column:-1},
      success:false,
      failureReason:'Original robot pose is outside the active map.',
    },
  };
  const baseDiagnostic={
    originalPose:{x:robotPose.x,y:robotPose.y},
    originalCell,
  };
  const reachable=goalCell&&isFree(grid,goalCell)
    ?reachableFreeCells(grid,goalCell)
    :undefined;
  const collision=new PathCollisionValidator();
  const usable=(cell:GridCell):boolean=>{
    if(!isFree(grid,cell)||reachable&&
      !reachable.has(cell.row*grid.metadata.width+cell.column))return false;
    if(!footprint)return true;
    const world=transform.gridToWorld(cell.row,cell.column);
    const heading=Math.atan2(world.y-robotPose.y,world.x-robotPose.x);
    return collision.pointIsFree(grid,{...world,theta:robotPose.theta},footprint)&&
      collision.segmentIsFree(grid,{
        x:robotPose.x,y:robotPose.y,theta:heading,
      },{...world,theta:heading},footprint,
      Math.min(grid.metadata.resolution/3,0.03));
  };
  if(usable(originalCell)){
    const projectedPose=transform.gridToWorld(originalCell.row,originalCell.column);
    return {
      cell:originalCell,
      diagnostic:{
        ...baseDiagnostic,projectedCell:originalCell,projectedPose,
        projectionDistanceM:Math.hypot(
          projectedPose.x-robotPose.x,projectedPose.y-robotPose.y),
        searchRadiusM:0,goalConnected:reachable?.has(
          originalCell.row*grid.metadata.width+originalCell.column)??true,success:true,
      },
    };
  }
  if(!enabled)return {
    cell:null,
    diagnostic:{
      ...baseDiagnostic,success:false,
      failureReason:'Start pose projection is disabled and the start cell is occupied.',
    },
  };
  const {resolution,width,height}=grid.metadata;
  const configuredMaximum=Math.max(0,maximumProjectionDistanceM);
  const radii=[...START_PROJECTION_RADII_M.filter(
    (radius)=>radius<configuredMaximum),configuredMaximum]
    .filter((radius,index,array)=>radius>0&&array.indexOf(radius)===index);
  for(const radiusM of radii){
    const radiusCells=Math.ceil(radiusM/resolution);
    const candidates:GridCell[]=[];
    for(let row=Math.max(0,originalCell.row-radiusCells);
      row<=Math.min(height-1,originalCell.row+radiusCells);row+=1)
      for(let column=Math.max(0,originalCell.column-radiusCells);
        column<=Math.min(width-1,originalCell.column+radiusCells);column+=1){
        const candidate={row,column};
        const world=transform.gridToWorld(row,column);
        if(Math.hypot(world.x-robotPose.x,world.y-robotPose.y)<=radiusM&&
          usable(candidate))candidates.push(candidate);
      }
    candidates.sort((left,right)=>{
      const a=transform.gridToWorld(left.row,left.column);
      const b=transform.gridToWorld(right.row,right.column);
      return Math.hypot(a.x-robotPose.x,a.y-robotPose.y)-
        Math.hypot(b.x-robotPose.x,b.y-robotPose.y);
    });
    const projectedCell=candidates[0];
    if(projectedCell){
      const projectedPose=transform.gridToWorld(projectedCell.row,projectedCell.column);
      return {
        cell:projectedCell,
        diagnostic:{
          ...baseDiagnostic,projectedCell,projectedPose,
          projectionDistanceM:Math.hypot(
            projectedPose.x-robotPose.x,projectedPose.y-robotPose.y),
          searchRadiusM:radiusM,goalConnected:true,success:true,
        },
      };
    }
  }
  return {
    cell:null,
    diagnostic:{
      ...baseDiagnostic,success:false,
      failureReason:`No safely connected free cell was found within the ${
        configuredMaximum.toFixed(2)} m projection radius.`,
    },
  };
};

const reachableFreeCells=(grid:OccupancyGrid,start:GridCell):Set<number>=>{
  const {width,height}=grid.metadata;
  const output=new Set<number>();const queue=[start];let head=0;
  output.add(start.row*width+start.column);
  while(head<queue.length){
    const current=queue[head++]!;
    for(const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]] as const){
      const cell={row:current.row+dr,column:current.column+dc};
      if(cell.row<0||cell.column<0||cell.row>=height||cell.column>=width||
        !isFree(grid,cell))continue;
      const index=cell.row*width+cell.column;
      if(output.has(index))continue;
      output.add(index);queue.push(cell);
    }
  }
  return output;
};

export class StartProjectionError extends Error {
  public constructor(
    public readonly diagnostic:StartProjectionDiagnostic,
    public readonly temporaryMap?:TemporaryMapResult,
  ){
    super('No reachable free start cell.');
    this.name='StartProjectionError';
  }
}
