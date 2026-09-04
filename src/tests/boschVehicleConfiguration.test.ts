import { describe, expect, it } from 'vitest';
import { defaultFootprint } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { PathCollisionValidator } from '../domain/planner/PathCollisionValidator';
import {
  parseBoschVehicleConfiguration, validateBoschFootprintPolygon,
} from '../domain/robot/BoschVehicleConfiguration';
import type { OccupancyGrid } from '../domain/types';

const configuration={
  ClientMotion:{
    vehicle:{
      footprint:[
        -.415,.300,.415,.300,.415,-.300,-.415,-.300,
      ],
      kinematicsType:'DIFFERENTIAL_DRIVE',
      drivingModes:{
        forwardAllowed:true,backwardAllowed:false,turnOnSpotAllowed:true,
      },
      generalConstraints:{
        maxForwardVelocity:1.2,maxReverseVelocity:.4,
        maxAbsoluteAngularVelocity:75,
      },
      wheel1:{vehicleTransformWheel:{x:.25,y:.30,yaw:0}},
      wheel2:{vehicleTransformWheel:{x:.25,y:-.30,yaw:0}},
    },
  },
};

describe('documented Bosch ClientMotion vehicle configuration',()=>{
  it('uses ClientMotion.vehicle.footprint as the authoritative VEHICLE polygon',()=>{
    const result=parseBoschVehicleConfiguration(configuration,defaultFootprint);
    expect(result.footprint.source).toBe('bosch-client-motion');
    expect(result.footprint.frame).toBe('VEHICLE');
    expect(result.footprint.polygon).toHaveLength(4);
    expect(result.footprint.length).toBeCloseTo(.83);
    expect(result.footprint.width).toBeCloseTo(.60);
    expect(result.footprint.forwardAllowed).toBe(true);
    expect(result.footprint.backwardAllowed).toBe(false);
    expect(result.footprint.turnOnSpotAllowed).toBe(true);
    expect(result.footprint.maxForwardVelocity).toBe(1.2);
    expect(result.footprint.maxAngularVelocity).toBe(75);
    expect(result.footprint.wheelTransforms).toHaveLength(2);
    expect(result.footprint.kinematicCentreConfirmed).toBe(false);
  });

  it('safely closes an open polygon and removes an explicit closing vertex',()=>{
    expect(validateBoschFootprintPolygon([0,0,1,0,0,1]).closedByApplication)
      .toBe(true);
    const closed=validateBoschFootprintPolygon([0,0,1,0,0,1,0,0]);
    expect(closed.closedByApplication).toBe(false);
    expect(closed.points).toHaveLength(3);
  });

  it('rejects a self-intersecting footprint',()=>{
    expect(()=>validateBoschFootprintPolygon([0,0,1,1,0,1,1,0]))
      .toThrow(/self-intersects/i);
  });

  it('checks the configured polygon instead of its rectangular bounding box',()=>{
    const grid:OccupancyGrid={
      metadata:{
        name:'polygon',mapId:'polygon',width:60,height:60,resolution:.05,
        origin:{x:0,y:0,yaw:0},occupiedThreshold:65,freeThreshold:20,negate:false,
      },
      data:new Array(3600).fill(0),
    };
    const obstacle=new CoordinateTransformer(grid.metadata).worldToGrid(1.35,1.35)!;
    grid.data[obstacle.row*grid.metadata.width+obstacle.column]=100;
    const triangular={
      ...defaultFootprint,source:'bosch-client-motion' as const,
      polygon:[{x:0,y:0},{x:.4,y:0},{x:0,y:.4}],
      length:.4,width:.4,centerOffsetX:.2,centerOffsetY:.2,safetyMargin:0,
    };
    const rectangular={...triangular,source:'application-fallback' as const};
    const validator=new PathCollisionValidator();
    expect(validator.pointIsFree(grid,{x:1,y:1,theta:0},triangular)).toBe(true);
    expect(validator.pointIsFree(grid,{x:1,y:1,theta:0},rectangular)).toBe(false);
  });
});
