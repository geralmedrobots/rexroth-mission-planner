import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import mqtt, { type MqttClient } from 'mqtt';
import { WebSocketServer, type WebSocket } from 'ws';
import { registerLocatorProxy } from './locatorProxy.js';
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
registerCtrlXDataLayerProxy(app);

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
        client.publish(message.topic,message.payload,{qos:message.qos??1,retain:message.retain??false},(error)=>
          send(socket,{type:'publish',topic:message.topic!,success:!error,message:error?.message??'Publish acknowledged'}));
      }
    } catch(error){send(socket,{type:'status',connected:false,message:`Malformed bridge command: ${String(error)}`});}
  });
  socket.on('close',()=>client?.end(true));
});
const port=Number(process.env.ROKIT_BRIDGE_PORT??8787);
const host=process.env.ROKIT_BRIDGE_HOST??'127.0.0.1';
server.listen(port,host,()=>console.log(`ROKIT application listening on http://${host}:${port}`));
