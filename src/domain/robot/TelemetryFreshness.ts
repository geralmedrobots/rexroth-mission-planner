import type { MqttReceiveMetadata } from '../types';

export const getLocalMessageAgeMs = (
  lastReceiveTime: number | null,
  now: number = Date.now(),
): number => lastReceiveTime === null
  ? Number.POSITIVE_INFINITY
  : Math.max(0, now - lastReceiveTime);

export const isLocalMessageFresh = (
  lastReceiveTime: number | null,
  staleTimeoutMs: number,
  now: number = Date.now(),
): boolean => getLocalMessageAgeMs(lastReceiveTime, now) <= staleTimeoutMs;

export const recordStateReceive = (
  metadata: MqttReceiveMetadata,
  payloadTimestamp: string | null,
  receivedAt: number = Date.now(),
): MqttReceiveMetadata => ({
  ...metadata,lastStateReceiveTime:receivedAt,statePayloadTimestamp:payloadTimestamp,
});

export const recordVisualizationReceive = (
  metadata: MqttReceiveMetadata,
  payloadTimestamp: string | null,
  receivedAt: number = Date.now(),
): MqttReceiveMetadata => ({
  ...metadata,lastVisualizationReceiveTime:receivedAt,visualizationPayloadTimestamp:payloadTimestamp,
});
