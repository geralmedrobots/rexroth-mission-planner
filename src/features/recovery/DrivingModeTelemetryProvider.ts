import type {
  CtrlXDataLayerSettings, DrivingModeTelemetryProvider, RecoveryTelemetry,
  TelemetryConnectionState,
} from './types';
import {
  decodeAvailableDrivingModes, parseRecoveryTelemetry,
} from './RecoveryTelemetry';

interface ProxyEnvelope {
  ok:boolean;
  data?:{
    requestDrivingMode:unknown;
    commandedVx:unknown;
    commandedYawRate:unknown;
    availableDrivingModes:unknown;
  };
  error?:string;
}

const finiteNumber=(value:unknown):number|null=>{
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value==='string'&&value.trim()){
    const parsed=Number(value);
    return Number.isFinite(parsed)?parsed:null;
  }
  return null;
};

const mode=(value:unknown):number|null=>{
  if(typeof value==='number'&&Number.isInteger(value))return value;
  if(typeof value!=='string')return null;
  const normalized=value.trim().toLowerCase();
  if(!/^(0x[0-9a-f]+|\d+)$/.test(normalized))return null;
  const parsed=Number.parseInt(normalized,normalized.startsWith('0x')?16:10);
  return Number.isFinite(parsed)?parsed:null;
};

const localServiceUrl=(path:string):string=>`http://127.0.0.1:8787${path}`;

export class CtrlXDataLayerTelemetryProvider implements DrivingModeTelemetryProvider {
  public readonly source='ctrlx' as const;
  private state:TelemetryConnectionState='disconnected';

  public constructor(private readonly settings:CtrlXDataLayerSettings){}

  public async connect():Promise<void>{
    this.state='connecting';
    try{
      this.validateSettings();
      await this.post('/ctrlx/configure',{
        host:this.settings.host,port:this.settings.port,https:this.settings.https,
        endpointTemplate:this.settings.endpointTemplate,
        timeoutMs:this.settings.requestTimeoutMs,
        rejectUnauthorized:this.settings.rejectUnauthorized,
        caCertificatePem:this.settings.caCertificatePem||undefined,
        authentication:{
          mode:this.settings.authenticationMode,
          username:this.settings.username||undefined,
          password:this.settings.password||undefined,
          bearerToken:this.settings.bearerToken||undefined,
        },
        paths:{
          requestDrivingMode:this.settings.requestDrivingModePath,
          commandedVx:this.settings.commandedVxPath,
          commandedYawRate:this.settings.commandedYawRatePath,
          availableDrivingModes:this.settings.availableDrivingModesPath,
        },
      });
      this.state='connected';
    }catch(error){
      this.state='error';throw error;
    }
  }

  public async read():Promise<RecoveryTelemetry>{
    if(this.state!=='connected')throw new Error(
      'Backward driving mode confirmation is unavailable from the configured telemetry provider.');
    try{
      const response=await this.post('/ctrlx/read',{});
      const data=response.data;
      if(!data)throw new Error('ctrlX DataLayer read returned no values.');
      const requestDrivingMode=mode(data.requestDrivingMode);
      const commandedVx=finiteNumber(data.commandedVx);
      const commandedYawRate=finiteNumber(data.commandedYawRate);
      const availableDrivingModes=decodeAvailableDrivingModes(data.availableDrivingModes);
      if(requestDrivingMode===null||commandedVx===null||commandedYawRate===null||
        availableDrivingModes.length===0)
        throw new Error('ctrlX DataLayer returned incomplete driving-mode telemetry.');
      return {
        requestDrivingMode,commandedVx,commandedYawRate,availableDrivingModes,
        provider:this.source,connectionState:'connected',receivedAtMs:Date.now(),
      };
    }catch(error){
      this.state='error';
      throw error;
    }
  }

  public async disconnect():Promise<void>{this.state='disconnected';}
  public getConnectionState():TelemetryConnectionState{return this.state;}

  private validateSettings():void{
    const missing=[
      ['host',this.settings.host],
      ['endpoint template',this.settings.endpointTemplate],
      ['requestDrivingMode path',this.settings.requestDrivingModePath],
      ['motionCommand.v_x path',this.settings.commandedVxPath],
      ['motionCommand.yaw_rate path',this.settings.commandedYawRatePath],
      ['availableDrivingModes path',this.settings.availableDrivingModesPath],
    ].filter((entry)=>!entry[1]?.trim()).map((entry)=>entry[0]);
    if(missing.length)throw new Error(
      `ctrlX DataLayer configuration is incomplete: ${missing.join(', ')}.`);
    if(!this.settings.endpointTemplate.includes('{path}'))
      throw new Error('ctrlX endpoint template must contain {path}.');
  }

  private async post(path:string,body:unknown):Promise<ProxyEnvelope>{
    const response=await fetch(localServiceUrl(path),{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    });
    const envelope=await response.json() as ProxyEnvelope;
    if(!response.ok||!envelope.ok)throw new Error(
      envelope.error??`ctrlX local proxy HTTP ${response.status}.`);
    return envelope;
  }
}

export class MqttRawDrivingModeTelemetryProvider implements DrivingModeTelemetryProvider {
  public readonly source='mqtt-raw' as const;
  private state:TelemetryConnectionState='disconnected';
  public constructor(private readonly payloads:()=>{
    values:unknown[];
    receivedAtMs:number|null;
  }){}
  public async connect():Promise<void>{this.state='connected';}
  public async read():Promise<RecoveryTelemetry>{
    const payload=this.payloads();
    const sample={
      ...parseRecoveryTelemetry(...payload.values),
      receivedAtMs:payload.receivedAtMs,
    };
    if(sample.requestDrivingMode===null||sample.commandedVx===null||
      sample.availableDrivingModes.length===0)
      throw new Error(
        'Backward driving mode confirmation is unavailable from the configured telemetry provider.');
    return sample;
  }
  public async disconnect():Promise<void>{this.state='disconnected';}
  public getConnectionState():TelemetryConnectionState{return this.state;}
}

export class UnavailableDrivingModeTelemetryProvider implements DrivingModeTelemetryProvider {
  public readonly source='disabled' as const;
  public async connect():Promise<void>{throw new Error(
    'Backward driving mode confirmation is unavailable from the configured telemetry provider.');}
  public async read():Promise<RecoveryTelemetry>{throw new Error(
    'Backward driving mode confirmation is unavailable from the configured telemetry provider.');}
  public async disconnect():Promise<void>{return Promise.resolve();}
  public getConnectionState():TelemetryConnectionState{return 'disabled';}
}

export const createDrivingModeTelemetryProvider=(input:{
  settings:CtrlXDataLayerSettings;
  source:'ctrlx'|'mqtt-raw'|'disabled';
  mqttPayloads:()=>{values:unknown[];receivedAtMs:number|null};
}):DrivingModeTelemetryProvider=>{
  if(input.source==='ctrlx')return new CtrlXDataLayerTelemetryProvider(input.settings);
  if(input.source==='mqtt-raw')
    return new MqttRawDrivingModeTelemetryProvider(input.mqttPayloads);
  return new UnavailableDrivingModeTelemetryProvider();
};
