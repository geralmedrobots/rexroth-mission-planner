import type {
  BoschRokitCorridorSettings, OccupancyGrid, ValidationIssue, ValidationResult, VdaOrder,
} from '../types';

export interface BoschCorridorValidationContext {
  settings:BoschRokitCorridorSettings;
  grid?:OccupancyGrid;
}

/**
 * Validates only the Bosch ROKIT corridor extension. Base VDA 5050 2.0
 * validation remains independent in VdaOrderValidator.validateBase().
 */
export class BoschRokitCorridorValidator {
  public validate(order:VdaOrder,context:BoschCorridorValidationContext):ValidationResult{
    const errors:ValidationIssue[]=[];const warnings:ValidationIssue[]=[];
    if(!context.settings.enableBoschRokitCorridorExtension)
      return {valid:true,errors,warnings,context:{enabled:false}};
    const settingNumbers=[
      context.settings.obstacleSafetyMarginM,context.settings.localizationMarginM,
      context.settings.minCorridorWidthM,context.settings.maxCorridorWidthM,
      context.settings.corridorSampleSpacingM,
    ];
    if(!settingNumbers.every((value)=>Number.isFinite(value)&&value>=0)||
      context.settings.maxCorridorWidthM<=0||context.settings.corridorSampleSpacingM<=0||
      context.settings.minCorridorWidthM>context.settings.maxCorridorWidthM){
      errors.push({code:'corridor.invalid',
        message:'Bosch ROKIT corridor settings contain invalid limits or sampling values.',
        path:'plannerOptions.corridor',severity:'error'});
    }
    if(context.settings.corridorRefPoint!=='KINEMATICCENTER'&&
      context.settings.corridorRefPoint!=='CONTOUR'){
      errors.push({code:'corridor.referencePoint',
        message:'Configured corridor reference point is invalid.',path:'plannerOptions.corridor.corridorRefPoint',
        severity:'error'});
    }
    if(!context.grid){
      warnings.push({code:'corridor.mapDataUnavailable',
        message:'Corridor generation is enabled but occupancy-map data is unavailable.',severity:'warning'});
    }
    let corridorCount=0;
    order.edges.forEach((edge,index)=>{
      const corridor=edge.corridor;if(!corridor)return;
      corridorCount+=1;
      const path=`edges[${index}].corridor`;
      if(!Number.isFinite(corridor.leftWidth)||!Number.isFinite(corridor.rightWidth)||
        corridor.leftWidth<0||corridor.rightWidth<0){
        errors.push({code:'corridor.invalid',message:`Edge ${index} corridor widths must be finite and non-negative.`,
          path,severity:'error'});
      }
      if(corridor.leftWidth>context.settings.maxCorridorWidthM||
        corridor.rightWidth>context.settings.maxCorridorWidthM){
        errors.push({code:'corridor.exceedsMaximum',
          message:`Edge ${index} corridor exceeds ${context.settings.maxCorridorWidthM} m.`,
          path,severity:'error'});
      }
      if(corridor.leftWidth<context.settings.minCorridorWidthM&&
        corridor.rightWidth<context.settings.minCorridorWidthM){
        warnings.push({code:'corridor.tooNarrow',
          message:`Edge ${index} corridor is below the configured useful width.`,path,severity:'warning'});
      }
      if(corridor.corridorRefPoint!=='KINEMATICCENTER'&&corridor.corridorRefPoint!=='CONTOUR'){
        errors.push({code:'corridor.referencePoint',
          message:`Edge ${index} corridorRefPoint is not supported by the VDA 5050 2.1 corridor definition.`,
          path,severity:'error'});
      }
      const start=order.nodes[index]?.nodePosition;const end=order.nodes[index+1]?.nodePosition;
      const length=start&&end?Math.hypot(end.x-start.x,end.y-start.y):0;
      if(!Number.isFinite(length)||length<=1e-6){
        errors.push({code:'corridor.invalid',message:`Edge ${index} has zero or invalid length.`,
          path,severity:'error'});
      }
      if(!start?.mapId||start.mapId!==end?.mapId){
        errors.push({code:'corridor.invalid',message:`Edge ${index} corridor has invalid map references.`,
          path,severity:'error'});
      }
    });
    if(order.edges.length>0&&corridorCount===0){
      warnings.push({code:'corridor.missing',
        message:'Obstacle avoidance is enabled in ROKIT Navigator, but the generated Order contains no bypass corridor information.',
        severity:'warning'});
    }else if(corridorCount<order.edges.length){
      warnings.push({code:'corridor.missing',
        message:'Bypass is permitted only on some route segments.',severity:'warning',
        details:{edgesWithCorridor:corridorCount,edgesWithoutCorridor:order.edges.length-corridorCount}});
    }
    return {valid:errors.length===0,errors,warnings,context:{
      enabled:true,protocolBase:'VDA 5050 2.0',
      rokitExtension:'corridor definition from VDA 5050 2.1',
      edgesWithCorridor:corridorCount,edgesWithoutCorridor:order.edges.length-corridorCount,
    }};
  }
}
