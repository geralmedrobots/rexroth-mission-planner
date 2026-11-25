import type { OccupancyGrid } from '../../domain/types';
import type { SavedDestination } from './destinationStore';
import { validateDestination } from '../mission/destinationValidation';

export interface WaypointDraft {mapId:string;x:number;y:number;item?:SavedDestination;theta?:number}
export function waypointPositionError(draft:WaypointDraft,grid?:OccupancyGrid,inflated?:OccupancyGrid) {
  if(!grid||grid.metadata.mapId!==draft.mapId)return 'Load the matching planning map.';
  const goal={...draft,theta:draft.theta??0,positionInitialized:true};
  return validateDestination(goal,grid.metadata.mapId,grid,inflated??grid).message;
}
