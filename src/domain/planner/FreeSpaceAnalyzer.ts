import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import type {
  FreeSpaceDiagnostic, GridCell, OccupancyGrid, PlannerFailureCode, RobotFootprint,
} from '../types';
import { buildClearanceField } from './ClearanceField';
import { isOccupiedValue } from './ObstacleInflation';
import { PathCollisionValidator } from './PathCollisionValidator';

export interface FreeSpaceAnalysis {
  diagnostic:FreeSpaceDiagnostic;
  failureCode?:PlannerFailureCode;
  reason?:string;
  recommendedOperatorAction?:string;
}

const moves=[
  [-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1],
] as const;

export class FreeSpaceAnalyzer {
  public analyze(
    grid:OccupancyGrid,
    start:GridCell,
    goal:GridCell,
    footprint:RobotFootprint,
    sampleIntervalM:number,
  ):FreeSpaceAnalysis{
    const point=this.flood(grid,start,goal,false);
    const unknownFree=this.flood(grid,start,goal,true);
    const footprintFlood=this.footprintFlood(
      grid,start,goal,footprint,sampleIntervalM);
    const widestClearanceM=this.widestClearance(grid,start,goal);
    const requiredHalfWidthM=footprint.width/2+footprint.safetyMargin;
    const diagnostic:FreeSpaceDiagnostic={
      startRegion:1,goalRegion:point.connected?1:2,
      pointRobotConnected:point.connected,
      footprintConnected:footprintFlood.connected,
      unknownFreeConnected:unknownFree.connected,
      widestClearanceM,requiredHalfWidthM,
      visitedPointCells:point.visited,
      visitedFootprintCells:footprintFlood.visited,
    };
    if(!point.connected){
      if(unknownFree.connected)return {
        diagnostic,failureCode:'UNKNOWN_SPACE_BLOCKED',
        reason:'Start and goal connect only when unknown cells are treated as free.',
        recommendedOperatorAction:
          'Improve Locator map coverage or select a destination connected through known free space.',
      };
      return {
        diagnostic,failureCode:'START_GOAL_DISCONNECTED',
        reason:'Start and goal are in disconnected known free-space regions.',
        recommendedOperatorAction:
          'Select a destination in the current connected region or correct the static map.',
      };
    }
    if(!footprintFlood.connected){
      if(widestClearanceM+grid.metadata.resolution/2<requiredHalfWidthM)return {
        diagnostic,failureCode:'PASSAGE_TOO_NARROW',
        reason:`The widest connected point route provides approximately ${
          (widestClearanceM*2).toFixed(3)} m clearance width; the configured `+
          `vehicle requires at least ${(requiredHalfWidthM*2).toFixed(3)} m.`,
        recommendedOperatorAction:
          'Use a physically wider passage; do not reduce the configured Bosch footprint.',
      };
      return {
        diagnostic,failureCode:'VEHICLE_FOOTPRINT_COLLISION',
        reason:'Point-robot connectivity exists, but no route fits the complete vehicle footprint.',
        recommendedOperatorAction:
          'Inspect the footprint overlay, vehicle-frame origin, and constrained corners.',
      };
    }
    return {diagnostic};
  }

  private flood(
    grid:OccupancyGrid,
    start:GridCell,
    goal:GridCell,
    unknownFree:boolean,
  ):{connected:boolean;visited:number}{
    const {width,height,occupiedThreshold}=grid.metadata;
    const free=(cell:GridCell):boolean=>{
      if(cell.row<0||cell.column<0||cell.row>=height||cell.column>=width)return false;
      const value=grid.data[cell.row*width+cell.column]??100;
      return unknownFree?value<occupiedThreshold:
        !isOccupiedValue(value,occupiedThreshold);
    };
    if(!free(start)||!free(goal))return {connected:false,visited:0};
    const queue=[start];let head=0;const seen=new Set<number>([
      start.row*width+start.column,
    ]);
    while(head<queue.length){
      const current=queue[head++]!;
      if(current.row===goal.row&&current.column===goal.column)
        return {connected:true,visited:seen.size};
      for(const [dr,dc] of moves){
        const next={row:current.row+dr,column:current.column+dc};
        if(!free(next))continue;
        if(dr!==0&&dc!==0&&
          (!free({row:current.row,column:next.column})||
            !free({row:next.row,column:current.column})))continue;
        const index=next.row*width+next.column;
        if(seen.has(index))continue;
        seen.add(index);queue.push(next);
      }
    }
    return {connected:false,visited:seen.size};
  }

  private footprintFlood(
    grid:OccupancyGrid,
    start:GridCell,
    goal:GridCell,
    footprint:RobotFootprint,
    interval:number,
  ):{connected:boolean;visited:number}{
    const {width,height}=grid.metadata;
    const transform=new CoordinateTransformer(grid.metadata);
    const collision=new PathCollisionValidator();
    const queue=[start];let head=0;const seen=new Set<number>([
      start.row*width+start.column,
    ]);
    while(head<queue.length){
      const current=queue[head++]!;
      if(current.row===goal.row&&current.column===goal.column)
        return {connected:true,visited:seen.size};
      const from=transform.gridToWorld(current.row,current.column);
      for(const [dr,dc] of moves){
        const next={row:current.row+dr,column:current.column+dc};
        if(next.row<0||next.column<0||next.row>=height||next.column>=width)continue;
        const index=next.row*width+next.column;
        if(seen.has(index))continue;
        const to=transform.gridToWorld(next.row,next.column);
        const heading=Math.atan2(to.y-from.y,to.x-from.x);
        if(!collision.segmentIsFree(
          grid,{...from,theta:heading},{...to,theta:heading},footprint,interval))continue;
        seen.add(index);queue.push(next);
      }
    }
    return {connected:false,visited:seen.size};
  }

  private widestClearance(
    grid:OccupancyGrid,
    start:GridCell,
    goal:GridCell,
  ):number{
    const {width,height}=grid.metadata;
    const clearance=buildClearanceField(grid);
    const capacity=new Float32Array(width*height).fill(-1);
    const open:Array<{index:number;capacity:number}>=[];
    const startIndex=start.row*width+start.column;
    capacity[startIndex]=clearance[startIndex]??0;
    open.push({index:startIndex,capacity:capacity[startIndex]!});
    while(open.length){
      open.sort((a,b)=>b.capacity-a.capacity);
      const current=open.shift()!;
      if(current.capacity<capacity[current.index]!)continue;
      const row=Math.floor(current.index/width);const column=current.index%width;
      if(row===goal.row&&column===goal.column)return current.capacity;
      for(const [dr,dc] of moves){
        const next={row:row+dr,column:column+dc};
        if(next.row<0||next.column<0||next.row>=height||next.column>=width)continue;
        const index=next.row*width+next.column;
        if(isOccupiedValue(grid.data[index]??100,grid.metadata.occupiedThreshold))continue;
        const nextCapacity=Math.min(current.capacity,clearance[index]??0);
        if(nextCapacity<=capacity[index]!)continue;
        capacity[index]=nextCapacity;open.push({index,capacity:nextCapacity});
      }
    }
    return 0;
  }
}
