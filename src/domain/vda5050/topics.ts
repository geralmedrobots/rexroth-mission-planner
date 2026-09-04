import type { MqttTopics } from '../types';
export interface TopicIdentity { interfaceName:string; topicVersion:string; manufacturer:string; serialNumber:string }
export const buildTopics=(identity:TopicIdentity):MqttTopics=>{
  const prefix=[identity.interfaceName,identity.topicVersion,identity.manufacturer,identity.serialNumber].map((x)=>x.replace(/^\/|\/$/g,'')).join('/');
  return {order:`${prefix}/order`,instantActions:`${prefix}/instantActions`,state:`${prefix}/state`,
    visualization:`${prefix}/visualization`,connection:`${prefix}/connection`};
};
