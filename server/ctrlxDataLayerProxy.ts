import type { Express, Request, Response } from 'express';
import http from 'node:http';
import https from 'node:https';

type AuthenticationMode='none'|'basic'|'bearer';
interface CtrlXConfiguration {
  host:string;
  port:number;
  https:boolean;
  endpointTemplate:string;
  timeoutMs:number;
  rejectUnauthorized:boolean;
  caCertificatePem?:string;
  authentication:{
    mode:AuthenticationMode;
    username?:string;
    password?:string;
    bearerToken?:string;
  };
  paths:{
    requestDrivingMode:string;
    commandedVx:string;
    commandedYawRate:string;
    availableDrivingModes:string;
  };
}

const requiredPathKeys=[
  'requestDrivingMode','commandedVx','commandedYawRate','availableDrivingModes',
] as const;

const scalar=(value:unknown):string|number|boolean|null=>{
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value;
  if(value===null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw new Error(
    'ctrlX response must be a scalar or an object containing a scalar "value".');
  const record=value as Record<string,unknown>;
  if('value' in record)return scalar(record.value);
  if(typeof record.data==='object'&&record.data!==null&&!Array.isArray(record.data)&&
    'value' in (record.data as Record<string,unknown>))
    return scalar((record.data as Record<string,unknown>).value);
  throw new Error('ctrlX response does not contain a supported scalar value.');
};

class CtrlXDataLayerProxy {
  private configuration?:CtrlXConfiguration;

  public configure(value:unknown):{configured:true}{
    const input=value as Partial<CtrlXConfiguration>;
    if(!input.host?.trim())throw new Error('ctrlX DataLayer host is required.');
    if(!Number.isInteger(input.port)||Number(input.port)<1||Number(input.port)>65535)
      throw new Error('ctrlX DataLayer port must be between 1 and 65535.');
    if(!input.endpointTemplate?.startsWith('/')||
      !input.endpointTemplate.includes('{path}'))
      throw new Error(
        'ctrlX endpoint must begin with "/" and contain the configurable {path} placeholder.');
    if(!Number.isFinite(input.timeoutMs)||Number(input.timeoutMs)<100)
      throw new Error('ctrlX request timeout must be at least 100 ms.');
    if(!input.paths)throw new Error('ctrlX DataLayer paths are required.');
    for(const key of requiredPathKeys)
      if(typeof input.paths[key]!=='string'||!input.paths[key].trim())
        throw new Error(`ctrlX DataLayer path "${key}" is required.`);
    const authentication=input.authentication;
    if(!authentication)throw new Error('ctrlX authentication configuration is required.');
    const mode=authentication?.mode;
    if(mode!=='none'&&mode!=='basic'&&mode!=='bearer')
      throw new Error('Unsupported ctrlX authentication mode.');
    if(mode==='basic'&&(!authentication.username||!authentication.password))
      throw new Error('ctrlX basic authentication requires username and password.');
    if(mode==='bearer'&&!authentication.bearerToken)
      throw new Error('ctrlX bearer authentication requires a token.');
    this.configuration={
      host:input.host.trim(),port:Number(input.port),https:Boolean(input.https),
      endpointTemplate:input.endpointTemplate,timeoutMs:Number(input.timeoutMs),
      rejectUnauthorized:input.rejectUnauthorized!==false,
      caCertificatePem:input.caCertificatePem?.trim()||undefined,
      authentication:{
        mode,username:authentication.username,
        password:authentication.password,bearerToken:authentication.bearerToken,
      },
      paths:{
        requestDrivingMode:input.paths.requestDrivingMode.trim(),
        commandedVx:input.paths.commandedVx.trim(),
        commandedYawRate:input.paths.commandedYawRate.trim(),
        availableDrivingModes:input.paths.availableDrivingModes.trim(),
      },
    };
    return {configured:true};
  }

  public async read():Promise<Record<typeof requiredPathKeys[number],string|number|boolean|null>>{
    const configuration=this.configuration;
    if(!configuration)throw new Error('Configure the ctrlX DataLayer provider first.');
    const entries=await Promise.all(requiredPathKeys.map(async(key)=>
      [key,await this.readNode(configuration,configuration.paths[key])] as const));
    return Object.fromEntries(entries) as Record<
      typeof requiredPathKeys[number],string|number|boolean|null>;
  }

  private readNode(
    configuration:CtrlXConfiguration,
    nodePath:string,
  ):Promise<string|number|boolean|null>{
    const path=configuration.endpointTemplate.replaceAll(
      '{path}',encodeURIComponent(nodePath));
    const transport=configuration.https?https:http;
    const headers:Record<string,string>={accept:'application/json'};
    if(configuration.authentication.mode==='basic'){
      const credentials=Buffer.from(
        `${configuration.authentication.username}:${configuration.authentication.password}`)
        .toString('base64');
      headers.authorization=`Basic ${credentials}`;
    }else if(configuration.authentication.mode==='bearer'){
      headers.authorization=`Bearer ${configuration.authentication.bearerToken}`;
    }
    return new Promise((resolve,reject)=>{
      const request=transport.request({
        hostname:configuration.host,port:configuration.port,path,method:'GET',
        timeout:configuration.timeoutMs,headers,
        ...(configuration.https?{
          rejectUnauthorized:configuration.rejectUnauthorized,
          ca:configuration.caCertificatePem,
        }:{}),
      },(response)=>{
        const chunks:Buffer[]=[];
        response.on('data',(chunk:Buffer)=>chunks.push(chunk));
        response.on('end',()=>{
          if(!response.statusCode||response.statusCode<200||response.statusCode>=300){
            reject(new Error(`ctrlX DataLayer HTTP status ${response.statusCode??'unknown'}.`));
            return;
          }
          const text=Buffer.concat(chunks).toString('utf8').trim();
          try{
            resolve(scalar(JSON.parse(text) as unknown));
          }catch(error){
            const numeric=Number(text);
            if(text&&Number.isFinite(numeric)){resolve(numeric);return;}
            reject(new Error(
              `Malformed ctrlX DataLayer value response: ${
                error instanceof Error?error.message:String(error)}`));
          }
        });
      });
      request.on('timeout',()=>{
        request.destroy();reject(new Error(
          `ctrlX DataLayer request timed out after ${configuration.timeoutMs} ms.`));
      });
      request.on('error',(error)=>reject(new Error(`ctrlX DataLayer request failed: ${error.message}`)));
      request.end();
    });
  }
}

const proxy=new CtrlXDataLayerProxy();
const handle=(operation:(request:Request)=>Promise<unknown>|unknown)=>
  async(request:Request,response:Response):Promise<void>=>{
    try{response.json({ok:true,data:await operation(request)});}
    catch(error){
      response.status(400).json({
        ok:false,error:error instanceof Error?error.message:String(error),
      });
    }
  };

/** Local application proxy. The external ctrlX endpoint and node paths are always operator supplied. */
export const registerCtrlXDataLayerProxy=(app:Express):void=>{
  app.post('/ctrlx/configure',handle((request)=>proxy.configure(request.body)));
  app.post('/ctrlx/read',handle(()=>proxy.read()));
};
