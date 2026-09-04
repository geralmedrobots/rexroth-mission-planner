import { z } from 'zod';

const finite = z.number().finite();
export const robotPoseSchema = z.object({
  x: finite, y: finite, theta: finite, mapId: z.string(), positionInitialized: z.boolean().default(false),
}).passthrough();
export const vdaStateSchema = z.object({
  headerId: z.number().optional(), timestamp: z.string().optional(), version: z.string().optional(),
  manufacturer: z.string().optional(), serialNumber: z.string().optional(), orderId: z.string().optional(),
  orderUpdateId: z.number().optional(), lastNodeId: z.string().optional(), lastNodeSequenceId: z.number().optional(),
  driving: z.boolean().optional(), paused: z.boolean().optional(), operatingMode: z.string().optional(),
  agvPosition: robotPoseSchema.optional(),
  velocity: z.object({ vx: finite.optional(), vy: finite.optional(), omega: finite.optional() }).passthrough().optional(),
  batteryState: z.object({ batteryCharge: finite.optional(), charging: z.boolean().optional() }).passthrough().optional(),
  safetyState: z.object({ eStop: z.string().optional(), fieldViolation: z.boolean().optional() }).passthrough().optional(),
  newBaseRequest: z.boolean().optional(), nodeStates: z.array(z.unknown()).optional(),
  edgeStates: z.array(z.unknown()).optional(), actionStates: z.array(z.unknown()).optional(),
  errors: z.array(z.object({
    errorType: z.string(), errorLevel: z.string(), errorDescription: z.string().optional(),
    errorReferences: z.array(z.object({ referenceKey: z.string(), referenceValue: z.string() })).optional(),
  }).passthrough()).optional(), information: z.array(z.unknown()).optional(),
}).passthrough();
export const vdaVisualizationSchema = z.object({
  headerId: z.number(), timestamp: z.string(), version: z.literal('2.0.0'), manufacturer: z.string(), serialNumber: z.string(),
  agvPosition: robotPoseSchema.optional(),
  velocity: z.object({ vx: finite.optional(), vy: finite.optional(), omega: finite.optional() }).passthrough().optional(),
}).passthrough();
export const vdaConnectionSchema = z.object({
  headerId: z.number(), timestamp: z.string(), version: z.literal('2.0.0'), manufacturer: z.string(),
  serialNumber: z.string(), connectionState: z.string(),
}).passthrough();
