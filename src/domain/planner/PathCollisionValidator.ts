import type { OccupancyGrid, PathPoint, RobotFootprint } from '../types';
import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { isOccupiedValue } from './ObstacleInflation';

export interface PathCollisionDiagnostic {
  segmentIndex:number;
  start:{x:number;y:number};
  end:{x:number;y:number};
}
export interface PoseCollisionDiagnostic {
  collision:boolean;
  collisionCell?:{row:number;column:number};
  footprintPolygon:Array<{x:number;y:number}>;
}
export interface DetailedPathCollisionDiagnostic extends PathCollisionDiagnostic {
  pose:PathPoint;
  collisionCell?:{row:number;column:number};
  footprintPolygon:Array<{x:number;y:number}>;
}

export class PathCollisionValidator {
  public pointIsFree(grid: OccupancyGrid, point: PathPoint, footprint: RobotFootprint): boolean {
    return !this.inspectPose(grid,point,footprint).collision;
  }

  public inspectPose(
    grid:OccupancyGrid,
    point:PathPoint,
    footprint:RobotFootprint,
  ):PoseCollisionDiagnostic{
    const transform = new CoordinateTransformer(grid.metadata);
    const corners=this.footprintPolygonAt(point,footprint);
    if(corners.some((corner)=>transform.worldToGrid(corner.x,corner.y)===null))
      return {collision:true,footprintPolygon:corners};
    const cells=corners.map((corner)=>this.unboundedWorldToGrid(grid,corner.x,corner.y));
    const minRow=Math.max(0,Math.floor(Math.min(...cells.map((cell)=>cell.row))));
    const maxRow=Math.min(grid.metadata.height-1,
      Math.ceil(Math.max(...cells.map((cell)=>cell.row))));
    const minColumn=Math.max(0,
      Math.floor(Math.min(...cells.map((cell)=>cell.column))));
    const maxColumn=Math.min(grid.metadata.width-1,
      Math.ceil(Math.max(...cells.map((cell)=>cell.column))));
    for(let row=minRow;row<=maxRow;row+=1)for(let column=minColumn;column<=maxColumn;column+=1){
      const index=row*grid.metadata.width+column;
      if(!isOccupiedValue(grid.data[index]??100,grid.metadata.occupiedThreshold))continue;
      const cellCentre=transform.gridToWorld(row,column);
      if(this.polygonsIntersect(corners,this.cellCorners(grid,cellCentre.x,cellCentre.y)))
        return {
          collision:true,collisionCell:{row,column},footprintPolygon:corners,
        };
    }
    return {collision:false,footprintPolygon:corners};
  }

  public footprintPolygonAt(
    point:Pick<PathPoint,'x'|'y'|'theta'>,
    footprint:RobotFootprint,
  ):Array<{x:number;y:number}>{
    const c = Math.cos(point.theta); const s = Math.sin(point.theta);
    return this.expandedLocalPolygon(footprint).map(({x,y})=>({
      x:point.x+c*x-s*y,
      y:point.y+s*x+c*y,
    }));
  }

  public segmentIsFree(grid: OccupancyGrid, a: PathPoint, b: PathPoint, footprint: RobotFootprint, interval: number): boolean {
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(interval, grid.metadata.resolution / 3)));
    const theta = Math.atan2(b.y - a.y, b.x - a.x);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      if (!this.pointIsFree(grid, { x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t, theta }, footprint)) return false;
    }
    return true;
  }

  public pathIsFree(grid: OccupancyGrid, path: PathPoint[], footprint: RobotFootprint, interval: number): boolean {
    return path.length >= 2 && path.slice(1).every((point, index) =>
      this.segmentIsFree(grid, path[index]!, point, footprint, interval));
  }

  public findFirstCollision(
    grid:OccupancyGrid,
    path:PathPoint[],
    footprint:RobotFootprint,
    interval:number,
  ):PathCollisionDiagnostic|null{
    for(let segmentIndex=0;segmentIndex<path.length-1;segmentIndex+=1){
      const start=path[segmentIndex]!;const end=path[segmentIndex+1]!;
      if(!this.segmentIsFree(grid,start,end,footprint,interval))return {
        segmentIndex,start:{x:start.x,y:start.y},end:{x:end.x,y:end.y},
      };
    }
    return null;
  }

  public findFirstDetailedCollision(
    grid:OccupancyGrid,
    path:PathPoint[],
    footprint:RobotFootprint,
    interval:number,
  ):DetailedPathCollisionDiagnostic|null{
    for(let segmentIndex=0;segmentIndex<path.length-1;segmentIndex+=1){
      const start=path[segmentIndex]!;
      const end=path[segmentIndex+1]!;
      const distance=Math.hypot(end.x-start.x,end.y-start.y);
      const steps=Math.max(1,Math.ceil(
        distance/Math.max(interval,grid.metadata.resolution/3)));
      const theta=Math.atan2(end.y-start.y,end.x-start.x);
      for(let sample=0;sample<=steps;sample+=1){
        const ratio=sample/steps;
        const pose={
          x:start.x+(end.x-start.x)*ratio,
          y:start.y+(end.y-start.y)*ratio,
          theta,
        };
        const inspected=this.inspectPose(grid,pose,footprint);
        if(inspected.collision)return {
          segmentIndex,start:{x:start.x,y:start.y},end:{x:end.x,y:end.y},
          pose,collisionCell:inspected.collisionCell,
          footprintPolygon:inspected.footprintPolygon,
        };
      }
    }
    return null;
  }

  public rotationIsFree(
    grid:OccupancyGrid,
    point:Pick<PathPoint,'x'|'y'>,
    fromTheta:number,
    toTheta:number,
    footprint:RobotFootprint,
    sampleStepRad:number,
  ):boolean{
    const delta=((toTheta-fromTheta+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI;
    if(Math.abs(delta)<1e-9)return this.pointIsFree(
      grid,{...point,theta:fromTheta},footprint);
    const steps=Math.max(1,Math.ceil(Math.abs(delta)/Math.max(sampleStepRad,Math.PI/180)));
    for(let index=0;index<=steps;index+=1)
      if(!this.pointIsFree(grid,{
        ...point,theta:fromTheta+delta*index/steps,
      },footprint))return false;
    return true;
  }

  private unboundedWorldToGrid(grid:OccupancyGrid,x:number,y:number):{row:number;column:number}{
    const dx=x-grid.metadata.origin.x;
    const dy=y-grid.metadata.origin.y;
    const c=Math.cos(-grid.metadata.origin.yaw);
    const s=Math.sin(-grid.metadata.origin.yaw);
    const localX=c*dx-s*dy;
    const localY=s*dx+c*dy;
    return {
      column:localX/grid.metadata.resolution-0.5,
      row:grid.metadata.height-0.5-localY/grid.metadata.resolution,
    };
  }

  private cellCorners(grid:OccupancyGrid,x:number,y:number):Array<{x:number;y:number}>{
    const half=grid.metadata.resolution/2;
    const c=Math.cos(grid.metadata.origin.yaw);
    const s=Math.sin(grid.metadata.origin.yaw);
    return [[-half,-half],[half,-half],[half,half],[-half,half]].map(([lx,ly])=>({
      x:x+c*lx!-s*ly!,
      y:y+s*lx!+c*ly!,
    }));
  }

  private polygonsIntersect(
    left:Array<{x:number;y:number}>,
    right:Array<{x:number;y:number}>,
  ):boolean{
    for(let a=0;a<left.length;a+=1)for(let b=0;b<right.length;b+=1)
      if(this.segmentsIntersect(
        left[a]!,left[(a+1)%left.length]!,
        right[b]!,right[(b+1)%right.length]!))return true;
    return this.pointInPolygon(left[0]!,right)||this.pointInPolygon(right[0]!,left);
  }

  private expandedLocalPolygon(footprint:RobotFootprint):Array<{x:number;y:number}>{
    const base=footprint.source==='bosch-client-motion'&&footprint.polygon?.length
      ?footprint.polygon.map((point)=>({...point}))
      :[
        {x:footprint.centerOffsetX-footprint.length/2,
          y:footprint.centerOffsetY+footprint.width/2},
        {x:footprint.centerOffsetX+footprint.length/2,
          y:footprint.centerOffsetY+footprint.width/2},
        {x:footprint.centerOffsetX+footprint.length/2,
          y:footprint.centerOffsetY-footprint.width/2},
        {x:footprint.centerOffsetX-footprint.length/2,
          y:footprint.centerOffsetY-footprint.width/2},
      ];
    const margin=Math.max(0,footprint.safetyMargin);
    if(margin<=1e-9)return base;
    const samples:Array<{x:number;y:number}>=[];
    for(const vertex of base)for(let index=0;index<16;index+=1){
      const angle=index*Math.PI*2/16;
      samples.push({
        x:vertex.x+Math.cos(angle)*margin,
        y:vertex.y+Math.sin(angle)*margin,
      });
    }
    return this.convexHull(samples);
  }

  private convexHull(points:Array<{x:number;y:number}>):Array<{x:number;y:number}>{
    const sorted=[...points].sort((a,b)=>a.x-b.x||a.y-b.y);
    const cross=(o:{x:number;y:number},a:{x:number;y:number},
      b:{x:number;y:number}):number=>
      (a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
    const lower:Array<{x:number;y:number}>=[];const upper:Array<{x:number;y:number}>=[];
    for(const point of sorted){
      while(lower.length>=2&&cross(lower.at(-2)!,lower.at(-1)!,point)<=0)lower.pop();
      lower.push(point);
    }
    for(const point of [...sorted].reverse()){
      while(upper.length>=2&&cross(upper.at(-2)!,upper.at(-1)!,point)<=0)upper.pop();
      upper.push(point);
    }
    return [...lower.slice(0,-1),...upper.slice(0,-1)];
  }

  private segmentsIntersect(
    a:{x:number;y:number},b:{x:number;y:number},
    c:{x:number;y:number},d:{x:number;y:number},
  ):boolean{
    const cross=(p:{x:number;y:number},q:{x:number;y:number},
      r:{x:number;y:number}):number=>
      (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
    const on=(p:{x:number;y:number},q:{x:number;y:number},
      r:{x:number;y:number}):boolean=>
      Math.abs(cross(p,q,r))<1e-10&&
      r.x>=Math.min(p.x,q.x)-1e-10&&r.x<=Math.max(p.x,q.x)+1e-10&&
      r.y>=Math.min(p.y,q.y)-1e-10&&r.y<=Math.max(p.y,q.y)+1e-10;
    const abC=cross(a,b,c);const abD=cross(a,b,d);
    const cdA=cross(c,d,a);const cdB=cross(c,d,b);
    return abC*abD<0&&cdA*cdB<0||
      on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);
  }

  private pointInPolygon(
    point:{x:number;y:number},
    polygon:Array<{x:number;y:number}>,
  ):boolean{
    let inside=false;
    for(let index=0,previous=polygon.length-1;index<polygon.length;
      previous=index,index+=1){
      const a=polygon[index]!;const b=polygon[previous]!;
      if((a.y>point.y)!==(b.y>point.y)&&
        point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
    }
    return inside;
  }
}
