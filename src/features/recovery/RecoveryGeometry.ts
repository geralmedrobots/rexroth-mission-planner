import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import { isOccupiedValue } from '../../domain/planner/ObstacleInflation';
import type { PathPoint, RobotFootprint } from '../../domain/types';
import type { RecoveryGeometryInput, ReverseCorridorResult } from './types';

const withRearMargin=(footprint:RobotFootprint,margin:number):RobotFootprint=>({
  ...footprint,safetyMargin:footprint.safetyMargin+Math.max(0,margin),
});

const footprintPoseIsFree=(
  input:RecoveryGeometryInput,
  point:PathPoint,
  footprint:RobotFootprint,
):boolean=>{
  const transform=new CoordinateTransformer(input.grid.metadata);
  const halfLength=footprint.length/2+footprint.safetyMargin;
  const halfWidth=footprint.width/2+footprint.safetyMargin;
  const longitudinalSamples=Math.max(
    1,Math.ceil((halfLength*2)/(input.grid.metadata.resolution/2)));
  const lateralSamples=Math.max(
    1,Math.ceil((halfWidth*2)/(input.grid.metadata.resolution/2)));
  const cosine=Math.cos(point.theta);const sine=Math.sin(point.theta);
  const centreX=point.x+cosine*footprint.centerOffsetX-sine*footprint.centerOffsetY;
  const centreY=point.y+sine*footprint.centerOffsetX+cosine*footprint.centerOffsetY;
  for(let longitudinalIndex=0;longitudinalIndex<=longitudinalSamples;longitudinalIndex+=1){
    const localX=-halfLength+2*halfLength*longitudinalIndex/longitudinalSamples;
    for(let lateralIndex=0;lateralIndex<=lateralSamples;lateralIndex+=1){
      const localY=-halfWidth+2*halfWidth*lateralIndex/lateralSamples;
      const cell=transform.worldToGrid(
        centreX+cosine*localX-sine*localY,
        centreY+sine*localX+cosine*localY);
      if(!cell)return false;
      const value=input.grid.data[transform.index(cell)]??100;
      if(isOccupiedValue(value,input.grid.metadata.occupiedThreshold))return false;
    }
  }
  return true;
};

export const isTurnOnSpotSafe=(input:RecoveryGeometryInput):boolean=>{
  if(!input.footprint.allowTurnOnSpot)return false;
  const footprint=withRearMargin(input.footprint,input.settings.rearSafetyMarginM);
  const steps=36;
  for(let index=0;index<steps;index+=1){
    const theta=input.pose.theta+(Math.PI*2*index)/steps;
    if(!footprintPoseIsFree(input,{...input.pose,theta},footprint))return false;
  }
  return true;
};

export const isConstantYawReversePathFree=(
  input:RecoveryGeometryInput,
  distanceM:number,
):boolean=>{
  const footprint=withRearMargin(input.footprint,input.settings.rearSafetyMarginM);
  const steps=Math.max(1,Math.ceil(distanceM/Math.max(
    input.sampleIntervalM,input.grid.metadata.resolution/3)));
  for(let index=0;index<=steps;index+=1){
    const distance=distanceM*index/steps;
    const point:PathPoint={
      x:input.pose.x-Math.cos(input.pose.theta)*distance,
      y:input.pose.y-Math.sin(input.pose.theta)*distance,
      theta:input.pose.theta,
    };
    if(!footprintPoseIsFree(input,point,footprint))return false;
  }
  return true;
};

export const findSafeReverseCorridor=(input:RecoveryGeometryInput):ReverseCorridorResult=>{
  const minimum=Math.max(0.05,input.settings.reverseDistanceM);
  const maximum=Math.max(minimum,input.settings.maximumReverseDistanceM);
  let selected=0;
  const step=Math.max(input.grid.metadata.resolution,input.sampleIntervalM,0.02);
  for(let distance=minimum;distance<=maximum+1e-9;distance+=step){
    if(!isConstantYawReversePathFree(input,Math.min(distance,maximum)))break;
    selected=Math.min(distance,maximum);
  }
  if(selected<minimum-1e-9)return {
    safe:false,distanceM:0,reason:'No collision-free backward recovery corridor is available.',
  };
  return {
    safe:true,distanceM:selected,reason:'Backward recovery corridor is collision-free.',
    target:{
      x:input.pose.x-Math.cos(input.pose.theta)*selected,
      y:input.pose.y-Math.sin(input.pose.theta)*selected,
      theta:input.pose.theta,mapId:input.pose.mapId,positionInitialized:true,
    },
  };
};
