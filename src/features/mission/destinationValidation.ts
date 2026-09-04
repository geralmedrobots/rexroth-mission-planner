import type { GridCell, OccupancyGrid, RobotPose } from '../../domain/types';
import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';

export interface DestinationValidation {
  valid:boolean;
  cell?:GridCell;
  message?:string;
}

export const validateDestination=(
  goal:RobotPose,
  navigationMapId:string|null,
  grid:OccupancyGrid,
  collisionGrid:OccupancyGrid=grid,
):DestinationValidation=>{
  if(!navigationMapId||goal.mapId!==navigationMapId){
    return {valid:false,message:'Destination belongs to a different map.'};
  }
  if(![goal.x,goal.y,goal.theta].every(Number.isFinite)){
    return {valid:false,message:'Destination coordinates must be finite.'};
  }
  const cell=new CoordinateTransformer(grid.metadata).worldToGrid(goal.x,goal.y);
  if(!cell)return {valid:false,message:'Destination is outside the navigation map.'};
  const index=cell.row*grid.metadata.width+cell.column;
  if((collisionGrid.data[index]??100)!==0){
    return {valid:false,message:'Destination is occupied or too close to an obstacle.'};
  }
  return {valid:true,cell};
};
