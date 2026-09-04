import { describe, expect, it } from 'vitest';
import { defaultFootprint, defaultPlannerOptions } from '../domain/defaults';
import { AStarPlanner } from '../domain/planner/AStarPlanner';
import { ObstacleInflation } from '../domain/planner/ObstacleInflation';
import { PathCollisionValidator } from '../domain/planner/PathCollisionValidator';
import { PathSimplifier } from '../domain/planner/PathSimplifier';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import type { OccupancyGrid, RobotFootprint } from '../domain/types';

const grid=(width=20,height=20):OccupancyGrid=>({metadata:{name:'test',mapId:'map',width,height,resolution:.1,
  origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false},data:new Array(width*height).fill(0)});
const tiny:RobotFootprint={...defaultFootprint,length:.01,width:.01,safetyMargin:0,inflationRadius:0};
describe('grid planner',()=>{
  it('inflates occupied cells',()=>{const g=grid();g.data[10*20+10]=100;const inflated=ObstacleInflation.circular(g,{...tiny,inflationRadius:.21});
    expect(inflated.data[10*20+12]).toBe(100);expect(inflated.data[10*20+14]).toBe(0);});
  it('prevents diagonal corner cutting',()=>{const g=grid(3,3);g.data[1]=100;g.data[3]=100;
    expect(new AStarPlanner().plan(g,{row:0,column:0},{row:1,column:1},defaultPlannerOptions).success).toBe(false);});
  it('routes around a wall with a gap',()=>{const g=grid();for(let r=0;r<19;r+=1)g.data[r*20+10]=100;
    const result=new AStarPlanner().plan(g,{row:2,column:2},{row:2,column:17},defaultPlannerOptions);
    expect(result.success).toBe(true);expect(result.rawPath.some((p)=>p.row===19)).toBe(true);});
  it('reports no path',()=>{const g=grid();for(let r=0;r<20;r+=1)g.data[r*20+10]=100;
    expect(new AStarPlanner().plan(g,{row:2,column:2},{row:2,column:17},defaultPlannerOptions).error).toMatch(/No collision-free/);});
  it('rejects a start pose whose footprint does not fit',()=>{const g=grid();
    [9,10,11].forEach((row)=>{[9,10,11].forEach((column)=>{if(row===10&&column===10)return;g.data[row*20+column]=100;});});
    const result = new AStarPlanner().plan(g,{row:10,column:10},{row:10,column:15},defaultPlannerOptions,defaultFootprint,0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/complete robot footprint does not fit at the planning start pose/i);
  });
  it('corrects a start slightly inside an obstacle',()=>{const g=grid();g.data[2*20+2]=100;
    const result=new AStarPlanner().plan(g,{row:2,column:2},{row:10,column:10},defaultPlannerOptions);
    expect(result.success).toBe(true);expect(result.correctedStart).toBeDefined();});
  it('rejects a goal deeply inside obstacles',()=>{const g=grid();for(let r=5;r<=11;r+=1)for(let c=5;c<=11;c+=1)g.data[r*20+c]=100;
    const result=new AStarPlanner().plan(g,{row:1,column:1},{row:8,column:8},defaultPlannerOptions);
    expect(result.success).toBe(false);expect(result.error).toMatch(/Goal/);});
  it('simplifies a visible straight path',()=>{const g=grid();const path=Array.from({length:10},(_,i)=>({x:.1+i*.1,y:.5,theta:0}));
    expect(new PathSimplifier().lineOfSight(g,path,tiny,.02)).toHaveLength(2);});
  it('reduces hundreds of raw cells to practical collision-checked VDA points',()=>{
    const g=grid(400,20);const path=Array.from({length:302},(_,i)=>({x:.5+i*.01,y:1,theta:0}));
    const result=new PathSimplifier().simplifyDetailed(g,path,tiny,defaultPlannerOptions,0);
    expect(result.simplifiedPath).toHaveLength(2);
    expect(result.finalPath.length).toBeLessThan(10);
    expect(new PathCollisionValidator().pathIsFree(g,result.finalPath,tiny,.02)).toBe(true);
  });
  it('does not simplify a route through inflated obstacle cells',()=>{
    const original=grid(30,30);const inflated={...original,data:[...original.data]};inflated.data[10*30+15]=100;
    const transform=new CoordinateTransformer(original.metadata);
    const path=[
      transform.gridToWorld(10,5),transform.gridToWorld(5,15),transform.gridToWorld(10,25),
    ];
    expect(new PathSimplifier().lineOfSight(original,path,tiny,.02,inflated)).toHaveLength(3);
  });
  it('validates path collision using footprint samples',()=>{const g=grid();g.data[10*20+10]=100;
    const validator=new PathCollisionValidator();expect(validator.pathIsFree(g,[{x:.2,y:1,theta:0},{x:1.8,y:1,theta:0}],tiny,.02)).toBe(false);});
});
