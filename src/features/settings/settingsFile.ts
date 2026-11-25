import { z } from 'zod';
import {
  clampStateStaleTimeoutMs, defaultFootprint, defaultMqttSettings, defaultOrderSettings,
  defaultPlannerOptions, normalizeMissionMaximumSpeed,
} from '../../domain/defaults';
import type { AppState } from '../../stores/appStore';

type Settings = Pick<AppState, 'mqttSettings' | 'orderSettings' | 'footprint' | 'plannerOptions'>;

function fields(defaults: object, overrides: z.ZodRawShape = {}) {
  const fields: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'number') fields[key]=z.number().nonnegative();
    else if (typeof value === 'boolean') fields[key]=z.boolean();
    else if (typeof value === 'string') fields[key]=z.string();
  }
  return z.object({...fields,...overrides}).partial();
}

const xy = z.object({x:z.number(),y:z.number()});
const schema=z.object({
  mqttSettings:fields(defaultMqttSettings,{
    port:z.number().int().min(1).max(65535), transport:z.enum(['tcp','ws']),
    qos:z.union([z.literal(0),z.literal(1),z.literal(2)]),
    subscriptionQos:z.union([z.literal(0),z.literal(1),z.literal(2)]),
    topics:fields(defaultMqttSettings.topics),
  }),
  orderSettings:fields(defaultOrderSettings,{
    version:z.literal('2.0.0'), maxSpeed:z.number(), testMaximumSpeed:z.number(),
    missionMaximumSpeedMps:z.number(),
  }),
  footprint:fields(defaultFootprint,{
    length:z.number().positive(),width:z.number().positive(),centerOffsetX:z.number(),centerOffsetY:z.number(),
    source:z.enum(['bosch-client-motion','application-fallback']),frame:z.literal('VEHICLE'),
    polygon:z.array(xy).min(3),wheelTransforms:z.array(xy.extend({yawDeg:z.number()})),
    maxForwardVelocity:z.number().nonnegative(),maxReverseVelocity:z.number().nonnegative(),
    maxAngularVelocity:z.number().nonnegative(),
  }),
  plannerOptions:fields(defaultPlannerOptions,{
    policy:z.enum(['reliable','balanced','advanced']),heuristic:z.enum(['euclidean','octile']),
    maxPlanningTimeMs:z.number().positive(),collisionSampleInterval:z.number().positive(),
    corridor:fields(defaultPlannerOptions.corridor,{
      corridorRefPoint:z.enum(['KINEMATICCENTER','CONTOUR']),corridorSampleSpacingM:z.number().positive(),
    }),
    passageSafety:fields(defaultPlannerOptions.passageSafety,{rotationCollisionSampleDeg:z.number().positive()}),
  }),
}).partial();

export function parseSettingsFile(text:string, current:Settings):Partial<Settings> {
  const checked=schema.safeParse(JSON.parse(text));
  if(!checked.success){
    const issue=checked.error.issues[0]!;
    throw new Error(`${issue.path.join('.') || 'Settings file'} — ${issue.message}`);
  }
  const {mqttSettings,orderSettings,footprint,plannerOptions}=checked.data as Partial<{
    mqttSettings:Partial<Settings['mqttSettings']>;
    orderSettings:Partial<Settings['orderSettings']>&{maxSpeed?:number;testMaximumSpeed?:number};
    footprint:Partial<Settings['footprint']>;
    plannerOptions:Omit<Partial<Settings['plannerOptions']>,'corridor'|'passageSafety'>&{
      corridor?:Partial<Settings['plannerOptions']['corridor']>;
      passageSafety?:Partial<Settings['plannerOptions']['passageSafety']>;
    };
  }>;
  if(!Object.values(checked.data).some(section=>Object.keys(section).length)){
    throw new Error('No recognized settings were found.');
  }
  const patch:Partial<Settings>={};
  if(mqttSettings)patch.mqttSettings={...current.mqttSettings,...mqttSettings,password:'',
    topics:{...current.mqttSettings.topics,...mqttSettings.topics}};
  if(orderSettings){
    const {maxSpeed,testMaximumSpeed,...order}=orderSettings;
    void testMaximumSpeed;
    patch.orderSettings={...current.orderSettings,...order,
      missionMaximumSpeedMps:normalizeMissionMaximumSpeed(order.missionMaximumSpeedMps??maxSpeed??current.orderSettings.missionMaximumSpeedMps),
      stateStaleTimeoutMs:clampStateStaleTimeoutMs(order.stateStaleTimeoutMs??current.orderSettings.stateStaleTimeoutMs)};
  }
  if(footprint){
    if(footprint.source==='bosch-client-motion'&&current.footprint.source!==footprint.source&&!footprint.polygon){
      throw new Error('An imported Bosch footprint requires polygon geometry.');
    }
    patch.footprint={...current.footprint,...footprint};
  }
  if(plannerOptions)patch.plannerOptions={...current.plannerOptions,...plannerOptions,
    corridor:{...current.plannerOptions.corridor,...plannerOptions.corridor},
    passageSafety:{...current.plannerOptions.passageSafety,...plannerOptions.passageSafety}};
  return patch;
}
