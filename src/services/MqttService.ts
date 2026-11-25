import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import type { MqttSettings } from '../domain/types';
import { inspectOutgoingOrderEdgeSpeeds } from '../domain/robot/SpeedLimitDiagnostics';
import { LogService } from './LogService';
import { outgoingMotionDiagnostics } from '../domain/vda5050/MotionExecutionDiagnostics';

export type MqttEvent =
  | { type: 'status'; connected: boolean; message: string }
  | { type: 'message'; topic: string; payload: string; receivedAt: string }
  | { type: 'publish'; topic: string; success: boolean; message: string };
type Listener = (event: MqttEvent) => void;

export class MqttService {
  private mqttClient?: MqttClient;
  private bridge?: WebSocket;
  private listeners = new Set<Listener>();
  private settings?: MqttSettings;
  public subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: MqttEvent): void { this.listeners.forEach((listener) => listener(event)); }

  public connect(settings: MqttSettings): void {
    this.disconnect(); this.settings = settings;
    if (settings.transport === 'tcp') { this.connectBridge(settings); return; }
    const protocol = settings.tls ? 'wss' : 'ws';
    const url = `${protocol}://${settings.host}:${settings.port}${settings.websocketPath}`;
    const options: IClientOptions = {
      username: settings.username || undefined, password: settings.password || undefined,
      keepalive: settings.keepalive, connectTimeout: settings.connectTimeoutMs, reconnectPeriod: 2_000,
      rejectUnauthorized: settings.rejectUnauthorized, protocolVersion: 4, clean: true,
    };
    const client = mqtt.connect(url, options); this.mqttClient = client;
    client.on('connect', () => { this.emit({ type:'status',connected:true,message:'MQTT WebSocket connected' }); this.subscribeTopics(client, settings); });
    client.on('reconnect', () => this.emit({ type:'status',connected:false,message:'MQTT reconnecting' }));
    client.on('close', () => this.emit({ type:'status',connected:false,message:'MQTT disconnected' }));
    client.on('error', (error) => this.emit({ type:'status',connected:false,message:error.message }));
    client.on('message', (topic,payload) => this.emit({ type:'message',topic,payload:payload.toString('utf8'),receivedAt:new Date().toISOString() }));
  }

  public disconnect(): void {
    this.mqttClient?.end(true); this.mqttClient = undefined;
    this.bridge?.close(); this.bridge = undefined;
    this.emit({ type:'status',connected:false,message:'Disconnected' });
  }

  public publish(topic: string, payload: string, qos: 0|1|2 = 1, retain = false): Promise<void> {
    if(topic===this.settings?.topics.order){
      for (const diagnostic of outgoingMotionDiagnostics(payload))
        LogService.write('mqtt', 'info', `[order-motion] ${JSON.stringify(diagnostic)}`);
      const edges=inspectOutgoingOrderEdgeSpeeds(payload);
      if(!edges.length)LogService.write(
        'mqtt','warning','[order-speed] outgoing Order has no readable edges.');
      for(const edge of edges)LogService.write(
        'mqtt',edge.maxSpeed===null?'error':'info',
        `[order-speed] orderId=${edge.orderId} edge[${edge.edgeIndex}] `+
        `edgeId=${edge.edgeId} sequenceId=${edge.sequenceId} `+
        `edge.maxSpeed=${edge.maxSpeed??'<invalid>'}`);
    }
    if (this.mqttClient?.connected) return new Promise((resolve,reject) => {
      this.mqttClient!.publish(topic,payload,{qos,retain},(error) => {
        this.emit({type:'publish',topic,success:!error,message:error?.message ?? 'Publish acknowledged'});
        if (error) reject(error); else resolve();
      });
    });
    if (this.bridge?.readyState === WebSocket.OPEN) {
      this.bridge.send(JSON.stringify({type:'publish',topic,payload,qos,retain})); return Promise.resolve();
    }
    return Promise.reject(new Error('MQTT is not connected.'));
  }

  private connectBridge(settings: MqttSettings): void {
    const bridgeUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8787/bridge`;
    const socket = new WebSocket(bridgeUrl); this.bridge = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({type:'connect',settings})));
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as MqttEvent;
        this.emit(message);
      } catch (error) { LogService.write('mqtt','error',`Malformed bridge message: ${String(error)}`); }
    });
    socket.addEventListener('close', () => this.emit({type:'status',connected:false,message:'Local MQTT bridge disconnected'}));
    socket.addEventListener('error', () => this.emit({type:'status',connected:false,message:'Cannot connect to local MQTT bridge on port 8787'}));
  }
  private subscribeTopics(client: MqttClient, settings: MqttSettings): void {
    client.subscribe([settings.topics.state,settings.topics.visualization,settings.topics.connection],
      {qos:settings.subscriptionQos}, (error) => {
        LogService.write('mqtt',error?'error':'info',error?.message ?? 'Subscribed to state, visualization, and connection');
      });
  }
}
export const mqttService = new MqttService();
