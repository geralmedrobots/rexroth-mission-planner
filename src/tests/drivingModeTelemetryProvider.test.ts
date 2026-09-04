import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CtrlXDataLayerTelemetryProvider, MqttRawDrivingModeTelemetryProvider,
  UnavailableDrivingModeTelemetryProvider,
} from '../features/recovery/DrivingModeTelemetryProvider';
import type { CtrlXDataLayerSettings } from '../features/recovery/types';
import { useRecoveryStore } from '../features/recovery/recoveryStore';

const settings:CtrlXDataLayerSettings={
  host:'192.168.1.10',port:443,https:true,
  endpointTemplate:'/configured/read?node={path}',
  authenticationMode:'basic',username:'operator',password:'secret',bearerToken:'',
  requestDrivingModePath:'configured/request-mode',
  commandedVxPath:'configured/command-vx',
  commandedYawRatePath:'configured/command-yaw-rate',
  availableDrivingModesPath:'configured/available-modes',
  pollingIntervalMs:100,staleTimeoutMs:1_000,requestTimeoutMs:2_000,
  rejectUnauthorized:true,caCertificatePem:'',
};

afterEach(()=>vi.restoreAllMocks());

describe('driving-mode telemetry providers',()=>{
  it('reads normalized Motion Command and Motion Feedback through the ctrlX proxy',async()=>{
    const requests:unknown[]=[];
    vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
      requests.push(JSON.parse(String(init?.body)) as unknown);
      const data=requests.length===1?{configured:true}:{
        requestDrivingMode:2,commandedVx:-.05,commandedYawRate:0,
        availableDrivingModes:7,
      };
      return new Response(JSON.stringify({ok:true,data}),{status:200});
    }));
    const provider=new CtrlXDataLayerTelemetryProvider(settings);
    await provider.connect();
    const sample=await provider.read();
    expect(sample).toMatchObject({
      provider:'ctrlx',connectionState:'connected',requestDrivingMode:2,
      commandedVx:-.05,commandedYawRate:0,availableDrivingModes:[1,2,4],
    });
    expect(requests[0]).toMatchObject({
      host:'192.168.1.10',endpointTemplate:'/configured/read?node={path}',
      paths:{
        requestDrivingMode:'configured/request-mode',
        commandedVx:'configured/command-vx',
        commandedYawRate:'configured/command-yaw-rate',
        availableDrivingModes:'configured/available-modes',
      },
    });
  });

  it('does not connect ctrlX without explicitly configured paths',async()=>{
    const provider=new CtrlXDataLayerTelemetryProvider({
      ...settings,requestDrivingModePath:'',
    });
    await expect(provider.connect()).rejects.toThrow(
      'requestDrivingMode path');
  });

  it('uses MQTT only when the explicit raw-payload provider is selected',async()=>{
    const provider=new MqttRawDrivingModeTelemetryProvider(()=>({
      values:[{
        requestDrivingMode:2,motionCommand:{v_x:-.05,yaw_rate:0},
        availableDrivingModes:7,
      }],
      receivedAtMs:1234,
    }));
    await provider.connect();
    expect(await provider.read()).toMatchObject({
      provider:'mqtt-raw',receivedAtMs:1234,requestDrivingMode:2,
      commandedVx:-.05,commandedYawRate:0,availableDrivingModes:[1,2,4],
    });
  });

  it('fails safely when telemetry is disabled',async()=>{
    const provider=new UnavailableDrivingModeTelemetryProvider();
    await expect(provider.connect()).rejects.toThrow(
      'Backward driving mode confirmation is unavailable from the configured telemetry provider.');
  });

  it('does not persist ctrlX passwords or bearer tokens',()=>{
    localStorage.clear();
    const store=useRecoveryStore.getState();
    store.updateSettings({
      telemetry:{
        source:'ctrlx',
        ctrlx:{...settings,password:'do-not-store',bearerToken:'do-not-store-token'},
      },
    });
    const persisted=JSON.parse(
      localStorage.getItem('med-robots-blocked-recovery')??'{}') as {
        state?:{settings?:{telemetry?:{ctrlx?:{
          password?:string;bearerToken?:string;
        }}}};
      };
    expect(persisted.state?.settings?.telemetry?.ctrlx?.password).toBe('');
    expect(persisted.state?.settings?.telemetry?.ctrlx?.bearerToken).toBe('');
  });
});
