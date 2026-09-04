import type { BoschRokitCorridor, VdaOrder } from '../../domain/types';
import { allocateVdaHeaderId } from '../../domain/vda5050/VdaOrderBuilder';
import type {
  CorridorCompatibilityResult, CorridorTestVariant, ExactMqttPayloadCapture,
} from './types';

const cloneOrder=(order:VdaOrder):VdaOrder=>structuredClone(order);

const fixedCorridor=(
  variant:Exclude<CorridorTestVariant,'baseline'|'current-corridor'>,
  referencePoint:BoschRokitCorridor['corridorRefPoint'],
):BoschRokitCorridor=>{
  if(variant==='narrow-corridor')
    return {leftWidth:0.2,rightWidth:0.2,corridorRefPoint:referencePoint};
  if(variant==='wide-corridor')
    return {leftWidth:1,rightWidth:1,corridorRefPoint:referencePoint};
  return {leftWidth:0.1,rightWidth:1,corridorRefPoint:referencePoint};
};

/**
 * Creates a controlled compatibility variant. Node/edge identifiers and geometry
 * are retained so corridor content is the only route-model difference.
 */
export const createCorridorTestOrder=(
  baseOrder:VdaOrder,
  variant:CorridorTestVariant,
):VdaOrder=>{
  const order=cloneOrder(baseOrder);
  order.headerId=allocateVdaHeaderId();
  order.timestamp=new Date().toISOString();
  order.orderId=`corridor-test-${variant}-${crypto.randomUUID()}`;
  order.orderUpdateId=0;
  order.version='2.0.0';
  const referencePoint=baseOrder.edges.find((edge)=>edge.corridor)?.corridor?.corridorRefPoint
    ??'KINEMATICCENTER';
  order.edges.forEach((edge,index)=>{
    if(variant==='baseline'){
      delete edge.corridor;
      return;
    }
    if(variant==='current-corridor'){
      const source=baseOrder.edges[index]?.corridor;
      if(source)edge.corridor={...source};
      else delete edge.corridor;
      return;
    }
    edge.corridor=fixedCorridor(variant,referencePoint);
  });
  return order;
};

export const serializeCorridorTestOrder=(
  order:VdaOrder,
  variant:CorridorTestVariant,
  topic:string,
  timestamp=new Date().toISOString(),
  validationEvidence?:{
    baseVda20ValidationPassed:boolean;
    boschCorridorExtensionValidationPassed:boolean;
  },
):ExactMqttPayloadCapture=>{
  const before=order.edges.some((edge)=>edge.corridor!==undefined);
  const rawJson=JSON.stringify(order);
  const parsedJson=JSON.parse(rawJson) as VdaOrder;
  const edgeCorridors=parsedJson.edges.flatMap((edge)=>
    edge.corridor?[{edgeId:edge.edgeId,corridor:edge.corridor}]:[]);
  return {
    timestamp,topic,rawJson,parsedJson,orderId:order.orderId,headerId:order.headerId,variant,
    corridorCount:edgeCorridors.length,edgeCorridors,
    payloadBytes:new TextEncoder().encode(rawJson).byteLength,
    corridorExistsBeforeSerialization:before,
    corridorExistsAfterSerialization:parsedJson.edges.some((edge)=>edge.corridor!==undefined),
    corridorExistsInRawPayload:rawJson.includes('"corridor"'),
    corridorRefPoints:[...new Set(edgeCorridors.map(({corridor})=>corridor.corridorRefPoint))],
    ...validationEvidence,
    corridorCountAfterValidation:edgeCorridors.length,
  };
};

export interface CorridorCompatibilityReport {
  fieldName:'corridor';
  referencePointFieldName:'corridorRefPoint';
  enumValues:readonly ['KINEMATICCENTER','CONTOUR'];
  definedIn:string;
  sourceKind:'isolated-manual-adapter';
  officialVdaSchemaReference:string;
  installedBoschSchemaConfirmation:'Not officially confirmed in the current repository.';
}

export const getCorridorCompatibilityReport=():CorridorCompatibilityReport=>({
  fieldName:'corridor',
  referencePointFieldName:'corridorRefPoint',
  enumValues:['KINEMATICCENTER','CONTOUR'],
  definedIn:'src/domain/types.ts',
  sourceKind:'isolated-manual-adapter',
  officialVdaSchemaReference:
    'https://github.com/VDA5050/VDA5050/blob/2.1.0/json_schemas/order.schema',
  installedBoschSchemaConfirmation:'Not officially confirmed in the current repository.',
});

export type CorridorCompatibilityConclusion='used'|'rejected'|'inconclusive';

export const getCorridorCompatibilityConclusion=(
  results:CorridorCompatibilityResult[],
):CorridorCompatibilityConclusion=>{
  const baseline=results.find((result)=>result.variant==='baseline');
  const corridorRuns=results.filter((result)=>result.corridorSent);
  if(baseline&&!baseline.bypassDetected&&corridorRuns.some((result)=>result.bypassDetected))
    return 'used';
  if(corridorRuns.some((result)=>result.status==='REJECTED'&&
    result.navigatorErrors.some((error)=>
      `${error.errorType} ${error.errorDescription??''}`.toLowerCase().includes('corridor'))))
    return 'rejected';
  return 'inconclusive';
};
