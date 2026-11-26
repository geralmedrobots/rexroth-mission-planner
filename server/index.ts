import cors from 'cors';
import { registerDelivery } from './deliveryService.js';
import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer as createOwnershipLock } from 'node:net';
import mqtt, { type MqttClient } from 'mqtt';
import { WebSocketServer, type WebSocket } from 'ws';
import { registerLocatorProxy } from './locatorProxy.js';
import { registerStage5BRecording } from './stage5BRecording.js';
import { registerCtrlXDataLayerProxy } from './ctrlxDataLayerProxy.js';

try { process.loadEnvFile?.(); } catch (error) {
  const code=(error as NodeJS.ErrnoException).code;
  if(code!=='ENOENT')throw error;
}
const app = express();
app.use(cors({
  origin: (origin, callback) => {
    const localOrigin = !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    callback(localOrigin ? null : new Error('The local bridge accepts only loopback application origins.'), localOrigin);
  },
}));
app.use(express.json({limit:'50mb'}));
app.get('/health',(_request,response)=>response.json({ok:true,service:'ROKIT MQTT and Locator bridge'}));
registerLocatorProxy(app);
registerStage5BRecording(app);
registerCtrlXDataLayerProxy(app);
const deliveryRouter=express.Router();
app.use(deliveryRouter);
let delivery:ReturnType<typeof registerDelivery>;

// In production the bridge also serves the compiled Vite application, so a
// single published Docker port is enough for the complete web application.
const webRoot = resolve(process.cwd(), 'dist');
if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.get(/.*/, (_request, response) => response.sendFile(resolve(webRoot, 'index.html')));
}
const server = createServer(app); const wss = new WebSocketServer({server,path:'/bridge'});
const send = (socket:WebSocket,value:unknown):void => { if(socket.readyState===socket.OPEN) socket.send(JSON.stringify(value)); };
wss.on('connection',(socket)=>{
  let client:MqttClient|undefined;
  socket.on('message',(raw)=>{
    try {
      const message = JSON.parse(raw.toString()) as {
        type:string; settings?:{
          host:string;port:number;tls:boolean;username:string;password:string;keepalive:number;
          connectTimeoutMs:number;rejectUnauthorized:boolean;subscriptionQos:0|1|2;
          topics:{state:string;visualization:string;connection:string};
        };topic?:string;payload?:string;qos?:0|1|2;retain?:boolean;
      };
      if(message.type==='connect'&&message.settings){
        const s=message.settings; const protocol=s.tls?'mqtts':'mqtt';
        client?.end(true); client=mqtt.connect(`${protocol}://${s.host}:${s.port}`,{
          protocolVersion:4,username:s.username||undefined,password:s.password||undefined,
          keepalive:s.keepalive,connectTimeout:s.connectTimeoutMs,reconnectPeriod:2000,
          rejectUnauthorized:s.rejectUnauthorized,
        });
        client.on('connect',()=>{
          send(socket,{type:'status',connected:true,message:'MQTT TCP connected'});
          client!.subscribe([s.topics.state,s.topics.visualization,s.topics.connection],{qos:s.subscriptionQos});
        });
        client.on('message',(topic,payload)=>send(socket,{type:'message',topic,payload:payload.toString('utf8'),receivedAt:new Date().toISOString()}));
        client.on('reconnect',()=>send(socket,{type:'status',connected:false,message:'MQTT reconnecting'}));
        client.on('close',()=>send(socket,{type:'status',connected:false,message:'MQTT disconnected'}));
        client.on('error',(error)=>send(socket,{type:'status',connected:false,message:error.message}));
      } else if(message.type==='publish'&&client?.connected&&message.topic&&message.payload!==undefined){
        if(delivery.active()&&(message.topic===delivery.orderTopic()||message.topic.endsWith('/order'))){
          send(socket,{type:'publish',topic:message.topic,success:false,message:'The pharmacy mission owns order dispatch.'});return;
        }
        client.publish(message.topic,message.payload,{qos:message.qos??1,retain:message.retain??false},(error)=>
          send(socket,{type:'publish',topic:message.topic!,success:!error,message:error?.message??'Publish acknowledged'}));
      }
    } catch(error){send(socket,{type:'status',connected:false,message:`Malformed bridge command: ${String(error)}`});}
  });
  socket.on('close',()=>client?.end(true));
});
const port=Number(process.env.ROKIT_BRIDGE_PORT??8787);
const host=process.env.ROKIT_BRIDGE_HOST??'127.0.0.1';
// The OS releases this owner endpoint when its process exits. Never run two
// schedulers against one journal, even if their HTTP ports differ.
const deliveryDir=resolve(process.env.MISSION_DATA_DIR??'data/pharmacy-delivery');
const key='medrobots-delivery-'+createHash('sha256').update(process.platform==='win32'?deliveryDir.toLowerCase():deliveryDir).digest('hex').slice(0,32);
const lockPath=process.platform==='win32'?'\\\\.\\pipe\\'+key:process.platform==='linux'?'\0'+key:join(tmpdir(),key+'.sock');
const owner=createOwnershipLock(socket=>socket.end());
owner.listen(lockPath,()=>server.listen(port,host,()=>{
  delivery=registerDelivery(deliveryRouter,deliveryDir);
  console.log(`ROKIT application listening on http://${host}:${port}`);
}));
