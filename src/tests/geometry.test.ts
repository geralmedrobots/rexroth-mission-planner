import { describe, expect, it } from 'vitest';
import { degreesToRadians, normalizeAngle, radiansToDegrees } from '../domain/geometry/angles';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import type { MapMetadata } from '../domain/types';

const metadata:MapMetadata={name:'test',mapId:'map',width:20,height:10,resolution:.5,origin:{x:-2,y:3,yaw:0},
  occupiedThreshold:.65,freeThreshold:.2,negate:false};
describe('geometry helpers',()=>{
  it('converts degree and radians',()=>{expect(degreesToRadians(180)).toBeCloseTo(Math.PI);expect(radiansToDegrees(Math.PI/2)).toBeCloseTo(90);});
  it('normalizes angles',()=>{expect(normalizeAngle(3*Math.PI)).toBeCloseTo(Math.PI);expect(normalizeAngle(-3*Math.PI)).toBeCloseTo(-Math.PI);});
  it('round-trips world and grid coordinates',()=>{
    const t=new CoordinateTransformer(metadata);const world=t.gridToWorld(4,7);expect(t.worldToGrid(world.x,world.y)).toEqual({row:4,column:7});
  });
  it('inverts the image Y axis',()=>{
    const t=new CoordinateTransformer(metadata);expect(t.gridToWorld(0,0).y).toBeGreaterThan(t.gridToWorld(9,0).y);
  });
  it('accounts for rotated origins',()=>{
    const m={...metadata,origin:{x:1,y:2,yaw:Math.PI/2}};const t=new CoordinateTransformer(m);
    const world=t.gridToWorld(5,5);expect(t.worldToGrid(world.x,world.y)).toEqual({row:5,column:5});
  });
});
