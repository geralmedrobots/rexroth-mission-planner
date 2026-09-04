import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import { ObstacleInflation } from '../../domain/planner/ObstacleInflation';
import { PathCollisionValidator } from '../../domain/planner/PathCollisionValidator';
import type { GridCell, OccupancyGrid, RobotFootprint, RobotPose } from '../../domain/types';
import type {
  GlobalReplanningSettings, TemporaryMapResult, TemporaryObstacleObservation,
} from './types';

interface WorldPoint {x:number;y:number}
const isRecord=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
const point=(value:unknown):WorldPoint|null=>{
  if(!isRecord(value)||!Number.isFinite(value.x)||!Number.isFinite(value.y))return null;
  return {x:value.x as number,y:value.y as number};
};
const sourceFromPath=(path:string):TemporaryObstacleObservation['source']=>{
  const normalized=path.toLowerCase();
  if(normalized.includes('laser1'))return 'Laser1';
  if(normalized.includes('laser2'))return 'Laser2';
  if(normalized.includes('environment'))return 'EnvironmentModel';
  if(normalized.includes('polygon'))return 'ObstaclePolygon';
  return 'ObstacleMessage';
};
const isObstacleBranch=(path:string):boolean=>
  /(laser1|laser2|environment.?model|obstacle|polygon)/i.test(path);

/**
 * Structural adapter for geometry carried by the already subscribed Navigator
 * state/visualization payloads. It assigns no undocumented semantic meaning to
 * unrelated arrays and records every accepted JSON path for diagnostics.
 */
export const extractTemporaryObstacleObservations=(
  payloads:unknown[],
  receivedAtMs:number,
  activeMapId?:string,
):TemporaryObstacleObservation[]=>{
  const observations:TemporaryObstacleObservation[]=[];
  const visit=(value:unknown,path:string,depth:number,mapId?:string):void=>{
    if(depth>10)return;
    const localMapId=isRecord(value)&&typeof value.mapId==='string'?value.mapId:mapId;
    if(Array.isArray(value)){
      const points=value.map(point);
      if(isObstacleBranch(path)&&points.length>0&&points.every((item)=>item!==null)){
        observations.push({
          id:crypto.randomUUID(),source:sourceFromPath(path),sourcePath:path,
          mapId:localMapId??activeMapId,points:points as WorldPoint[],receivedAtMs,
        });
        return;
      }
      value.forEach((item,index)=>visit(item,`${path}[${index}]`,depth+1,localMapId));
      return;
    }
    if(isRecord(value))Object.entries(value).forEach(([key,item])=>
      visit(item,`${path}.${key}`,depth+1,localMapId));
  };
  payloads.forEach((payload,index)=>visit(payload,`$[${index}]`,0,activeMapId));
  return observations;
};

export const isReplanningSensorObservation=(
  observation:TemporaryObstacleObservation,
):boolean=>observation.source==='Laser1'||observation.source==='Laser2'||
  observation.source==='EnvironmentModel';

const clusterPoints=(points:WorldPoint[],distance:number):WorldPoint[][]=>{
  if(!points.length)return [];
  const cellSize=Math.max(distance,0.001);
  const buckets=new Map<string,number[]>();
  const key=(x:number,y:number):string=>`${Math.floor(x/cellSize)}:${Math.floor(y/cellSize)}`;
  points.forEach((item,index)=>{
    const bucket=key(item.x,item.y);buckets.set(bucket,[...(buckets.get(bucket)??[]),index]);
  });
  const visited=new Uint8Array(points.length);const clusters:WorldPoint[][]=[];
  points.forEach((start,startIndex)=>{
    if(visited[startIndex])return;
    const queue=[startIndex];visited[startIndex]=1;const cluster:WorldPoint[]=[];
    while(queue.length){
      const index=queue.pop()!;const current=points[index]!;cluster.push(current);
      const bx=Math.floor(current.x/cellSize);const by=Math.floor(current.y/cellSize);
      for(let dx=-1;dx<=1;dx+=1)for(let dy=-1;dy<=1;dy+=1)
        for(const candidateIndex of buckets.get(`${bx+dx}:${by+dy}`)??[]){
          if(visited[candidateIndex])continue;
          const candidate=points[candidateIndex]!;
          if(Math.hypot(candidate.x-current.x,candidate.y-current.y)<=distance){
            visited[candidateIndex]=1;queue.push(candidateIndex);
          }
        }
    }
    clusters.push(cluster);
  });
  return clusters;
};

const extent=(points:WorldPoint[]):number=>{
  const xs=points.map((item)=>item.x);const ys=points.map((item)=>item.y);
  return Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
};

const minimumPointDistance=(a:WorldPoint[],b:WorldPoint[]):number=>{
  let minimum=Number.POSITIVE_INFINITY;
  for(const left of a)for(const right of b)
    minimum=Math.min(minimum,Math.hypot(left.x-right.x,left.y-right.y));
  return minimum;
};

const mergeNearbyObservations=(
  observations:TemporaryObstacleObservation[],
  distance:number,
):TemporaryObstacleObservation[]=>{
  const merged=[...observations.map((observation)=>({...observation,points:[...observation.points]}))];
  let changed=true;
  while(changed){
    changed=false;
    outer:for(let left=0;left<merged.length;left+=1)for(let right=left+1;right<merged.length;right+=1){
      const a=merged[left]!;const b=merged[right]!;
      if(minimumPointDistance(a.points,b.points)>distance)continue;
      merged[left]={
        ...a,id:`${a.id}+${b.id}`,
        source:a.source===b.source?a.source:'ObstacleMessage',
        sourcePath:`${a.sourcePath} | ${b.sourcePath}`,
        points:[...a.points,...b.points],
      };
      merged.splice(right,1);changed=true;break outer;
    }
  }
  return merged;
};

const cross=(origin:WorldPoint,a:WorldPoint,b:WorldPoint):number=>
  (a.x-origin.x)*(b.y-origin.y)-(a.y-origin.y)*(b.x-origin.x);
const convexHull=(points:WorldPoint[]):WorldPoint[]=>{
  const sorted=[...points].sort((a,b)=>a.x-b.x||a.y-b.y);
  if(sorted.length<=2)return sorted;
  const lower:WorldPoint[]=[];const upper:WorldPoint[]=[];
  for(const item of sorted){
    while(lower.length>=2&&cross(lower.at(-2)!,lower.at(-1)!,item)<=0)lower.pop();
    lower.push(item);
  }
  for(const item of [...sorted].reverse()){
    while(upper.length>=2&&cross(upper.at(-2)!,upper.at(-1)!,item)<=0)upper.pop();
    upper.push(item);
  }
  return [...lower.slice(0,-1),...upper.slice(0,-1)];
};

const pointInPolygon=(pointValue:WorldPoint,polygon:WorldPoint[]):boolean=>{
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i]!;const b=polygon[j]!;
    if(((a.y>pointValue.y)!==(b.y>pointValue.y))&&
      pointValue.x<(b.x-a.x)*(pointValue.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
};

export class TemporaryObstacleMap {
  public build(
    original:OccupancyGrid,
    observations:TemporaryObstacleObservation[],
    footprint:RobotFootprint,
    settings:GlobalReplanningSettings,
    activeMapId:string,
    nowMs=Date.now(),
    robotPose?:RobotPose,
  ):TemporaryMapResult{
    if(original.metadata.resolution<=0)throw new Error('Temporary map requires a positive resolution.');
    const data=original.data.map((value)=>
      value<0&&!settings.unknownCellsBlocked?0:value);
    const grid:OccupancyGrid={metadata:{...original.metadata},data};
    const baseGrid:OccupancyGrid={metadata:grid.metadata,data:[...data]};
    const fresh=observations.filter((observation)=>
      nowMs-observation.receivedAtMs<=settings.temporaryObstacleTtlMs&&
      (!observation.mapId||observation.mapId===activeMapId));
    const accepted:TemporaryObstacleObservation[]=[];
    const transformer=new CoordinateTransformer(grid.metadata);
    const temporaryIndices=new Set<number>();
    const inferredIndices=new Set<number>();
    const clusterObservations:TemporaryObstacleObservation[]=[];
    for(const observation of fresh){
      const clusters=observation.source==='ObstaclePolygon'||
        observation.source==='BlockedRouteInference'
        ?[observation.points]
        :clusterPoints(observation.points,settings.obstacleMergeDistanceM);
      for(const [clusterIndex,cluster] of clusters.entries()){
        clusterObservations.push({
          ...observation,id:`${observation.id}-${clusterIndex}`,points:cluster,
        });
      }
    }
    for(const normalized of mergeNearbyObservations(
      clusterObservations,settings.obstacleMergeDistanceM)){
        if(extent(normalized.points)<settings.minimumObstacleSizeM)continue;
        accepted.push(normalized);
        this.rasterize(grid,transformer,normalized.points,
          normalized.source==='BlockedRouteInference'?inferredIndices:temporaryIndices);
    }
    if(robotPose){
      this.subtractRobotFootprint(
        grid,transformer,inferredIndices,robotPose,footprint);
      this.subtractRobotFootprint(
        grid,transformer,temporaryIndices,robotPose,footprint);
    }
    for(const index of inferredIndices)temporaryIndices.add(index);
    for(const index of temporaryIndices)grid.data[index]=100;
    const robotRadiusM=Math.max(...(footprint.polygon?.length
      ?footprint.polygon.map((point)=>Math.hypot(point.x,point.y))
      :[Math.hypot(footprint.length,footprint.width)/2]));
    // Vehicle size is handled by polygon collision checks. This raster expands
    // temporary obstacles by the configured extra margin only.
    const totalInflationM=settings.inflationDistanceM;
    const baseInflatedGrid=ObstacleInflation.byRadius(baseGrid,totalInflationM);
    const inflatedGrid=ObstacleInflation.byRadius(grid,totalInflationM);
    const inflatedObstacleCells:GridCell[]=[];
    inflatedGrid.data.forEach((value,index)=>{
      if(value>=grid.metadata.occupiedThreshold&&
        (baseInflatedGrid.data[index]??100)<grid.metadata.occupiedThreshold)
        inflatedObstacleCells.push({
          row:Math.floor(index/grid.metadata.width),column:index%grid.metadata.width,
        });
    });
    if(robotPose){
      const inflatedIndices=new Set(inflatedObstacleCells.map((cell)=>
        cell.row*grid.metadata.width+cell.column));
      const beforeSelfMask=[...inflatedIndices];
      this.subtractRobotFootprint(
        grid,transformer,inflatedIndices,robotPose,footprint);
      for(const index of beforeSelfMask)
        if(!inflatedIndices.has(index))
          inflatedGrid.data[index]=baseInflatedGrid.data[index]??0;
      inflatedObstacleCells.splice(0,inflatedObstacleCells.length,
        ...[...inflatedIndices].map((index)=>({
          row:Math.floor(index/grid.metadata.width),
          column:index%grid.metadata.width,
        })));
    }
    for(const cell of inflatedObstacleCells)
      grid.data[cell.row*grid.metadata.width+cell.column]=100;
    return {
      grid,inflatedGrid,
      obstacleCells:[...temporaryIndices].map((index)=>({
        row:Math.floor(index/grid.metadata.width),column:index%grid.metadata.width,
      })),
      inflatedObstacleCells,
      acceptedObservations:accepted,
      ignoredObservationCount:Math.max(0,observations.length-
        fresh.filter((observation)=>accepted.some((item)=>
          item.sourcePath.includes(observation.sourcePath))).length),
      robotRadiusM,totalInflationM,
    };
  }

  private subtractRobotFootprint(
    grid:OccupancyGrid,
    transformer:CoordinateTransformer,
    indices:Set<number>,
    pose:RobotPose,
    footprint:RobotFootprint,
  ):void{
    const maskPolygon=new PathCollisionValidator().footprintPolygonAt(
      pose,{...footprint,
        safetyMargin:footprint.safetyMargin+grid.metadata.resolution/2+1e-6});
    for(const index of [...indices]){
      const row=Math.floor(index/grid.metadata.width);const column=index%grid.metadata.width;
      const world=transformer.gridToWorld(row,column);
      if(pointInPolygon(world,maskPolygon))indices.delete(index);
    }
  }

  private rasterize(
    grid:OccupancyGrid,
    transformer:CoordinateTransformer,
    points:WorldPoint[],
    output:Set<number>,
  ):void{
    const mark=(world:WorldPoint):void=>{
      const cell=transformer.worldToGrid(world.x,world.y);
      if(cell)output.add(cell.row*grid.metadata.width+cell.column);
    };
    points.forEach(mark);
    const hull=convexHull(points);
    if(hull.length<3){
      if(hull.length===2){
        const distance=Math.hypot(hull[1]!.x-hull[0]!.x,hull[1]!.y-hull[0]!.y);
        const samples=Math.max(1,Math.ceil(distance/(grid.metadata.resolution/2)));
        for(let index=0;index<=samples;index+=1){
          const t=index/samples;mark({
            x:hull[0]!.x+(hull[1]!.x-hull[0]!.x)*t,
            y:hull[0]!.y+(hull[1]!.y-hull[0]!.y)*t,
          });
        }
      }
      return;
    }
    const unboundedCells=hull.map((item)=>{
      const dx=item.x-grid.metadata.origin.x;const dy=item.y-grid.metadata.origin.y;
      const c=Math.cos(-grid.metadata.origin.yaw);const s=Math.sin(-grid.metadata.origin.yaw);
      const localX=c*dx-s*dy;const localY=s*dx+c*dy;
      const column=Math.floor(localX/grid.metadata.resolution);
      const row=grid.metadata.height-1-Math.floor(localY/grid.metadata.resolution);
      return {row,column};
    });
    const minRow=Math.max(0,Math.min(...unboundedCells.map((item)=>item.row))-1);
    const maxRow=Math.min(grid.metadata.height-1,
      Math.max(...unboundedCells.map((item)=>item.row))+1);
    const minColumn=Math.max(0,
      Math.min(...unboundedCells.map((item)=>item.column))-1);
    const maxColumn=Math.min(grid.metadata.width-1,
      Math.max(...unboundedCells.map((item)=>item.column))+1);
    if(minRow>maxRow||minColumn>maxColumn)return;
    for(let row=minRow;row<=maxRow;row+=1)for(let column=minColumn;column<=maxColumn;column+=1){
      const world=transformer.gridToWorld(row,column);
      if(pointInPolygon(world,hull))output.add(row*grid.metadata.width+column);
    }
  }
}
