import { z } from 'zod';
import { containerSchema } from './containerSchemas';
import { responseCodeSchema } from './sessionSchemas';

export const pose2DSchema = z.object({ x: z.number(), y: z.number(), a: z.number() }).strict();
export const serverMapListResponseSchema = z.object({
  responseCode: responseCodeSchema,
  serverMapNames: z.array(z.string()),
}).passthrough();
export const serverMapInfoResponseSchema = z.object({
  responseCode: responseCodeSchema,
  level: z.number().int(),
  loaded: z.boolean(),
  type: z.number().int(),
  fingerprint: z.union([z.number(), z.string()]),
  createdAt: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
  sentAt: z.unknown().optional(),
  receivedAt: z.unknown().optional(),
  initialMapLaserTypes: z.unknown().optional(),
  currentMapLaserTypes: z.unknown().optional(),
  warnings: z.array(z.unknown()).default([]),
}).passthrough();
export const serverMapImageResponseSchema = z.object({
  responseCode: responseCodeSchema,
  MAPimageOrigin: pose2DSchema,
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  image: containerSchema,
}).passthrough();
export const pointClusterSchema = z.object({
  prototype: pose2DSchema,
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
}).passthrough();
export const serverMapPointCloudResponseSchema = z.object({
  responseCode: responseCodeSchema,
  pointCloud: containerSchema,
  pointCloudSize: z.number().int().nonnegative(),
  reflectors: z.array(pointClusterSchema).default([]),
  zones: z.array(z.unknown()).default([]),
}).passthrough();

/** No fallback fields: fail visibly if the live ServerMap 9 contract changes. */
export const diagnosticPointCloudResponseSchema = z.object({
  responseCode: z.literal(0),
  pointCloud: containerSchema,
  pointCloudSize: z.number().int().nonnegative(),
  reflectors: z.array(pointClusterSchema),
  zones: z.array(z.unknown()),
}).passthrough();
