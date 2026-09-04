import type { RobotFootprint } from '../types';

export interface BoschVehicleConfigurationDiagnostic {
  source:'ClientMotion';
  footprintVertexCount:number;
  footprintClosedByApplication:boolean;
  frame:'VEHICLE';
  kinematicsType:string;
  warnings:string[];
}

export interface BoschVehicleConfigurationResult {
  footprint:RobotFootprint;
  diagnostic:BoschVehicleConfigurationDiagnostic;
}

type RecordValue=Record<string,unknown>;
const record=(value:unknown):value is RecordValue=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
const unwrap=(value:unknown):unknown=>{
  if(record(value)&&'value' in value)return unwrap(value.value);
  if(record(value)&&record(value.data)&&'value' in value.data)return unwrap(value.data.value);
  return value;
};
const pathValue=(root:unknown,path:string):unknown=>{
  if(record(root)&&path in root)return unwrap(root[path]);
  return path.split('.').reduce<unknown>((value,key)=>
    record(value)?value[key]:undefined,root);
};
const finite=(value:unknown):number|undefined=>{
  const unwrapped=unwrap(value);
  const parsed=typeof unwrapped==='string'&&unwrapped.trim()
    ?Number(unwrapped):unwrapped;
  return typeof parsed==='number'&&Number.isFinite(parsed)?parsed:undefined;
};
const bool=(value:unknown):boolean|undefined=>{
  const unwrapped=unwrap(value);
  if(typeof unwrapped==='boolean')return unwrapped;
  if(unwrapped==='true'||unwrapped===1)return true;
  if(unwrapped==='false'||unwrapped===0)return false;
  return undefined;
};
const samePoint=(a:{x:number;y:number},b:{x:number;y:number}):boolean=>
  Math.hypot(a.x-b.x,a.y-b.y)<1e-9;
const orientation=(a:{x:number;y:number},b:{x:number;y:number},
  c:{x:number;y:number}):number=>
  (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const segmentsIntersect=(a:{x:number;y:number},b:{x:number;y:number},
  c:{x:number;y:number},d:{x:number;y:number}):boolean=>{
  const abC=orientation(a,b,c);const abD=orientation(a,b,d);
  const cdA=orientation(c,d,a);const cdB=orientation(c,d,b);
  return abC*abD<0&&cdA*cdB<0;
};

export const validateBoschFootprintPolygon=(
  values:unknown,
):{points:Array<{x:number;y:number}>;closedByApplication:boolean}=>{
  const raw=unwrap(values);
  if(!Array.isArray(raw)||raw.length<6||raw.length%2!==0||
    raw.some((value)=>finite(value)===undefined))
    throw new Error(
      'ClientMotion.vehicle.footprint must be an even array of at least three finite x/y pairs.');
  let points:Array<{x:number;y:number}>=[];
  for(let index=0;index<raw.length;index+=2)
    points.push({x:finite(raw[index])!,y:finite(raw[index+1])!});
  if(points.some((point)=>Math.abs(point.x)>100||Math.abs(point.y)>100))
    throw new Error(
      'ClientMotion.vehicle.footprint exceeds the documented ±100 m configuration range.');
  const closed=samePoint(points[0]!,points.at(-1)!);
  if(closed)points=points.slice(0,-1);
  if(points.length<3)throw new Error('The Bosch footprint polygon has fewer than three vertices.');
  const unique=new Set(points.map((point)=>`${point.x}:${point.y}`));
  if(unique.size!==points.length)
    throw new Error('The Bosch footprint polygon contains duplicate vertices.');
  for(let left=0;left<points.length;left+=1){
    const leftNext=(left+1)%points.length;
    for(let right=left+1;right<points.length;right+=1){
      const rightNext=(right+1)%points.length;
      if(left===right||leftNext===right||rightNext===left)continue;
      if(segmentsIntersect(points[left]!,points[leftNext]!,
        points[right]!,points[rightNext]!))
        throw new Error('The Bosch footprint polygon self-intersects.');
    }
  }
  const area=Math.abs(points.reduce((sum,point,index)=>{
    const next=points[(index+1)%points.length]!;
    return sum+point.x*next.y-next.x*point.y;
  },0))/2;
  if(area<1e-6)throw new Error('The Bosch footprint polygon has zero physical area.');
  return {points,closedByApplication:!closed};
};

/**
 * Parses only documented ClientMotion configuration names. The caller must
 * supply an exported configuration object or values read from installed,
 * explicitly configured ctrlX DataLayer nodes.
 */
export const parseBoschVehicleConfiguration=(
  input:unknown,
  previous:RobotFootprint,
):BoschVehicleConfigurationResult=>{
  const clientMotion=pathValue(input,'ClientMotion')??input;
  const vehicle=pathValue(clientMotion,'vehicle')??clientMotion;
  const polygonValue=pathValue(vehicle,'footprint')??
    pathValue(input,'ClientMotion.vehicle.footprint');
  const polygon=validateBoschFootprintPolygon(polygonValue);
  const kinematics=String(unwrap(
    pathValue(vehicle,'kinematicsType')??
    pathValue(input,'ClientMotion.vehicle.kinematicsType'))??'').trim();
  if(!kinematics)throw new Error('ClientMotion.vehicle.kinematicsType is missing.');
  const forwardAllowed=bool(pathValue(vehicle,'drivingModes.forwardAllowed')??
    pathValue(input,'ClientMotion.vehicle.drivingModes.forwardAllowed'));
  const backwardAllowed=bool(pathValue(vehicle,'drivingModes.backwardAllowed')??
    pathValue(input,'ClientMotion.vehicle.drivingModes.backwardAllowed'));
  const turnOnSpotAllowed=bool(pathValue(vehicle,'drivingModes.turnOnSpotAllowed')??
    pathValue(input,'ClientMotion.vehicle.drivingModes.turnOnSpotAllowed'));
  if(forwardAllowed===undefined||backwardAllowed===undefined||
    turnOnSpotAllowed===undefined)
    throw new Error('ClientMotion vehicle driving-mode permissions are incomplete.');
  const xs=polygon.points.map((point)=>point.x);
  const ys=polygon.points.map((point)=>point.y);
  const wheels:Array<{x:number;y:number;yawDeg:number}>=[];
  for(let index=1;index<=4;index+=1){
    const base=`wheel${index}.vehicleTransformWheel`;
    const x=finite(pathValue(vehicle,`${base}.x`)??pathValue(
      input,`ClientMotion.vehicle.${base}.x`));
    const y=finite(pathValue(vehicle,`${base}.y`)??pathValue(
      input,`ClientMotion.vehicle.${base}.y`));
    const yawDeg=finite(pathValue(vehicle,`${base}.yaw`)??pathValue(
      input,`ClientMotion.vehicle.${base}.yaw`));
    if(x!==undefined&&y!==undefined&&yawDeg!==undefined)
      wheels.push({x,y,yawDeg});
  }
  const warnings:string[]=[];
  if(wheels.length===0)warnings.push(
    'No complete ClientMotion wheel transforms were present in the supplied snapshot.');
  const centreOffsetX=(Math.max(...xs)+Math.min(...xs))/2;
  const centreOffsetY=(Math.max(...ys)+Math.min(...ys))/2;
  if(Math.hypot(centreOffsetX,centreOffsetY)>1e-6)warnings.push(
    'The configured VEHICLE-frame footprint is not geometrically centred; its configured offset is preserved.');
  const differentialDrive=kinematics.toUpperCase()==='DIFFERENTIAL_DRIVE';
  return {
    footprint:{
      ...previous,
      polygon:polygon.points,
      length:Math.max(...xs)-Math.min(...xs),
      width:Math.max(...ys)-Math.min(...ys),
      centerOffsetX:centreOffsetX,
      centerOffsetY:centreOffsetY,
      source:'bosch-client-motion',frame:'VEHICLE',
      // The polygon is already expressed in VEHICLE. Its geometric centre is
      // not assumed to be the configured kinematic centre.
      kinematicCentreConfirmed:false,differentialDrive,
      allowReverse:backwardAllowed,allowTurnOnSpot:turnOnSpotAllowed,
      forwardAllowed,backwardAllowed,turnOnSpotAllowed,
      maxForwardVelocity:finite(pathValue(vehicle,
        'generalConstraints.maxForwardVelocity')??pathValue(input,
        'ClientMotion.vehicle.generalConstraints.maxForwardVelocity')),
      maxReverseVelocity:finite(pathValue(vehicle,
        'generalConstraints.maxReverseVelocity')??pathValue(input,
        'ClientMotion.vehicle.generalConstraints.maxReverseVelocity')),
      maxAngularVelocity:finite(pathValue(vehicle,
        'generalConstraints.maxAbsoluteAngularVelocity')??pathValue(input,
        'ClientMotion.vehicle.generalConstraints.maxAbsoluteAngularVelocity')),
      wheelTransforms:wheels,
    },
    diagnostic:{
      source:'ClientMotion',footprintVertexCount:polygon.points.length,
      footprintClosedByApplication:polygon.closedByApplication,
      frame:'VEHICLE',kinematicsType:kinematics,warnings,
    },
  };
};
