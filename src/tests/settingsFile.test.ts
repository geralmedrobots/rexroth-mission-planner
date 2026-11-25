import { describe, expect, it } from 'vitest';
import settingsExample from '../../examples/settings.example.json';
import { defaultFootprint, defaultMqttSettings, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { parseSettingsFile } from '../features/settings/settingsFile';

const current={
  mqttSettings:defaultMqttSettings,orderSettings:defaultOrderSettings,
  footprint:defaultFootprint,plannerOptions:defaultPlannerOptions,
};

describe('operator settings import',()=>{
  it('round-trips current settings and reads the bundled legacy example',()=>{
    expect(parseSettingsFile(JSON.stringify(current),current)).toEqual(current);
    expect(parseSettingsFile(JSON.stringify(settingsExample),current)).toMatchObject({
      mqttSettings:defaultMqttSettings,orderSettings:defaultOrderSettings,
    });
  });

  it('merges nested partial settings, strips credentials and unrelated store keys, and normalizes legacy speed',()=>{
    const result=parseSettingsFile(JSON.stringify({
      mqttSettings:{password:'discard',topics:{state:'fixture/state'}},
      orderSettings:{maxSpeed:.2,stateStaleTimeoutMs:100},
      plannerOptions:{corridor:{minCorridorWidthM:.15}},
      routeRevision:55,set:null,validation:{valid:true},
    }),current);
    expect(Object.keys(result)).toEqual(['mqttSettings','orderSettings','plannerOptions']);
    expect(result.mqttSettings?.topics).toEqual({...defaultMqttSettings.topics,state:'fixture/state'});
    expect(result.mqttSettings?.password).toBe('');
    expect(result.orderSettings).toEqual({...defaultOrderSettings,missionMaximumSpeedMps:.2,stateStaleTimeoutMs:2000});
    expect(result.plannerOptions?.corridor).toEqual({...defaultPlannerOptions.corridor,minCorridorWidthM:.15});
  });

  it.each([
    ['{"state":{}','JSON'],
    ['{"mqttSettings":{"port":"1883"}}','mqttSettings.port'],
    ['{"plannerOptions":{"corridor":null}}','plannerOptions.corridor'],
    ['{"plannerOptions":{"maxPlanningTimeMs":-1}}','plannerOptions.maxPlanningTimeMs'],
    ['{"footprint":{"source":"bosch-client-motion"}}','polygon geometry'],
    ['{"set":null}','No recognized settings'],
  ])('rejects incompatible settings %s',(text,reason)=>{
    expect(()=>parseSettingsFile(text,current)).toThrow(reason);
  });
});
