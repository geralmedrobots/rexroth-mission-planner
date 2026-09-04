import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import type { OccupancyGrid, RobotFootprint, RobotPose } from '../../domain/types';
import type {
  GlobalReplanningSettings, ObstacleIngestionDiagnostic,
  TemporaryObstacleObservation,
} from './types';

interface Point2 {x:number;y:number}
interface ExtractedPointSet {
  source:Extract<TemporaryObstacleObservation['source'],
    'Laser1'|'Laser2'|'EnvironmentModel'>;
  path:string;
  frame?:string;
  points:unknown[];
}

const isRecord=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
const finite=(value:unknown):value is number=>
  typeof value==='number'&&Number.isFinite(value);
const pointFromUnknown=(value:unknown):Point2|null=>{
  if(Array.isArray(value)&&value.length>=2&&finite(value[0])&&finite(value[1]))
    return {x:value[0],y:value[1]};
  if(!isRecord(value))return null;
  if(finite(value.x)&&finite(value.y))return {x:value.x,y:value.y};
  for(const key of ['point','position','coordinates']){
    const nested:unknown=value[key];
    if(nested!==value){
      const parsed=pointFromUnknown(nested);
      if(parsed)return parsed;
    }
  }
  return null;
};
const sourceFromPath=(path:string):ExtractedPointSet['source']|null=>{
  const normalized=path.toLowerCase().replaceAll(/[_\s-]/g,'');
  if(/laser2|lidar2|scan2/.test(normalized))return 'Laser2';
  if(/laser1|lidar1|scan1/.test(normalized))return 'Laser1';
  if(/laser|lidar|laserscan/.test(normalized))return 'Laser1';
  if(/environmentmodel|environmentobstacle/.test(normalized))return 'EnvironmentModel';
  return null;
};
const frameFromRecord=(value:Record<string,unknown>,previous?:string):string|undefined=>{
  for(const key of ['frameId','frame_id','referenceFrame','coordinateSystem','frame']){
    if(typeof value[key]==='string'&&value[key].trim())return value[key].trim();
  }
  return previous;
};

const extractPointSets=(payload:unknown):ExtractedPointSet[]=>{
  const output:ExtractedPointSet[]=[];
  const visit=(value:unknown,path:string,depth:number,frame?:string):void=>{
    if(depth>12)return;
    if(Array.isArray(value)){
      const source=sourceFromPath(path);
      if(source&&value.length>=2&&value.length%2===0&&value.every(finite)){
        const pairs:unknown[]=[];
        for(let index=0;index<value.length;index+=2)
          pairs.push([value[index],value[index+1]]);
        output.push({source,path,frame,points:pairs});
        return;
      }
      if(source&&value.length>0&&value.some((item)=>pointFromUnknown(item)!==null)){
        output.push({source,path,frame,points:value});
        return;
      }
      value.forEach((item,index)=>visit(item,`${path}[${index}]`,depth+1,frame));
      return;
    }
    if(!isRecord(value))return;
    const localFrame=frameFromRecord(value,frame);
    Object.entries(value).forEach(([key,item])=>
      visit(item,`${path}.${key}`,depth+1,localFrame));
  };
  visit(payload,'$',0);
  return output;
};

const localToMap=(point:Point2,pose:RobotPose):Point2=>{
  const cosine=Math.cos(pose.theta);const sine=Math.sin(pose.theta);
  return {
    x:pose.x+cosine*point.x-sine*point.y,
    y:pose.y+sine*point.x+cosine*point.y,
  };
};
const mapFrame=(frame?:string):boolean=>Boolean(frame&&/(^|[/_])map($|[/_])/i.test(frame));
const localFrame=(frame?:string):boolean=>Boolean(
  frame&&/(base|robot|vehicle|agv|laser|lidar|sensor|local)/i.test(frame));

const clusterPoints=(points:Point2[],maximumDistanceM:number):Point2[][]=>{
  const remaining=new Set(points.map((_,index)=>index));const clusters:Point2[][]=[];
  while(remaining.size){
    const first=remaining.values().next().value as number;
    remaining.delete(first);const queue=[first];const cluster:Point2[]=[];
    while(queue.length){
      const index=queue.pop()!;const current=points[index]!;cluster.push(current);
      for(const candidate of [...remaining]){
        const value=points[candidate]!;
        if(Math.hypot(value.x-current.x,value.y-current.y)<=maximumDistanceM){
          remaining.delete(candidate);queue.push(candidate);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
};

export interface ObstaclePayloadInput {
  payload:unknown;
  sourceTopic:string;
  payloadKind:'state'|'visualization';
  receivedAtMs:number;
  robotPose:RobotPose;
  activeMapId:string;
  grid:OccupancyGrid;
  clusterDistanceM:number;
}

export const ingestObstaclePayload=(input:ObstaclePayloadInput):{
  observations:TemporaryObstacleObservation[];
  diagnostic:ObstacleIngestionDiagnostic;
}=>{
  const sets=extractPointSets(input.payload);
  const transformer=new CoordinateTransformer(input.grid.metadata);
  const transformedBySource=new Map<ExtractedPointSet['source'],Point2[]>();
  let rawPointCount=0;let rejectedPointCount=0;
  const sourcePaths=new Set<string>();const frameModes=new Set<string>();
  for(const set of sets){
    sourcePaths.add(set.path);
    const explicitMap=mapFrame(set.frame);
    const explicitLocal=localFrame(set.frame);
    for(const raw of set.points){
      rawPointCount+=1;
      const parsed=pointFromUnknown(raw);
      if(!parsed){rejectedPointCount+=1;continue;}
      let transformed:Point2;let mode:string;
      if(explicitMap){
        transformed=parsed;mode=`map:${set.frame}`;
      }else if(explicitLocal){
        transformed=localToMap(parsed,input.robotPose);mode=`robot-local:${set.frame}`;
      }else if(set.source==='Laser1'||set.source==='Laser2'){
        transformed=localToMap(parsed,input.robotPose);mode='robot-local:laser-default';
      }else{
        const directCell=transformer.worldToGrid(parsed.x,parsed.y);
        const local=localToMap(parsed,input.robotPose);
        const localCell=transformer.worldToGrid(local.x,local.y);
        if(!directCell&&localCell){
          transformed=local;mode='robot-local:bounds-inferred';
        }else{
          transformed=parsed;mode='map:default';
        }
      }
      frameModes.add(mode);
      if(!transformer.worldToGrid(transformed.x,transformed.y)){
        rejectedPointCount+=1;continue;
      }
      transformedBySource.set(set.source,[
        ...(transformedBySource.get(set.source)??[]),transformed,
      ]);
    }
  }
  const observations:TemporaryObstacleObservation[]=[];let obstacleClusterCount=0;
  for(const [source,points] of transformedBySource){
    const clusters=clusterPoints(points,Math.max(input.clusterDistanceM,0.001));
    obstacleClusterCount+=clusters.length;
    clusters.forEach((cluster,index)=>observations.push({
      id:crypto.randomUUID(),source,
      sourcePath:`${input.payloadKind}:${source}:cluster-${index}`,
      mapId:input.activeMapId,points:cluster,receivedAtMs:input.receivedAtMs,
    }));
  }
  const transformedPointCount=[...transformedBySource.values()]
    .reduce((sum,points)=>sum+points.length,0);
  return {
    observations,
    diagnostic:{
      sourceTopic:input.sourceTopic,payloadKind:input.payloadKind,
      rawPointCount,transformedPointCount,rejectedPointCount,
      obstacleClusterCount,insertedOccupiedCells:0,inflatedCells:0,
      sourcePaths:[...sourcePaths],frameModes:[...frameModes],
      dataAgeMs:Math.max(0,Date.now()-input.receivedAtMs),
    },
  };
};

/** Testing fallback used only when no usable live sensor point is available. */
export const createBlockedRouteInference=(input:{
  robotPose:RobotPose;
  footprint:RobotFootprint;
  settings:GlobalReplanningSettings;
  activeMapId:string;
  mapResolutionM:number;
  receivedAtMs?:number;
}):TemporaryObstacleObservation=>{
  const length=Math.max(input.settings.minimumObstacleSizeM,
    input.settings.inferredObstacleLengthM);
  const width=Math.max(input.settings.minimumObstacleSizeM,
    input.settings.inferredObstacleWidthM);
  const robotRadius=Math.hypot(input.footprint.length,input.footprint.width)/2;
  const obstacleRadius=Math.hypot(length,width)/2;
  const centreDistance=Math.max(
    input.settings.inferredObstacleDistanceM,
    robotRadius+obstacleRadius+input.mapResolutionM,
  );
  const forward={x:Math.cos(input.robotPose.theta),y:Math.sin(input.robotPose.theta)};
  const left={x:-forward.y,y:forward.x};
  const centre={
    x:input.robotPose.x+forward.x*centreDistance,
    y:input.robotPose.y+forward.y*centreDistance,
  };
  const corner=(longitudinal:number,lateral:number):Point2=>({
    x:centre.x+forward.x*longitudinal+left.x*lateral,
    y:centre.y+forward.y*longitudinal+left.y*lateral,
  });
  return {
    id:crypto.randomUUID(),source:'BlockedRouteInference',
    sourcePath:'$fallback.blockedRouteInference',mapId:input.activeMapId,
    receivedAtMs:input.receivedAtMs??Date.now(),
    points:[
      corner(-length/2,-width/2),corner(length/2,-width/2),
      corner(length/2,width/2),corner(-length/2,width/2),
    ],
  };
};
