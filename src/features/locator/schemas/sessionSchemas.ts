import { z } from 'zod';

export const responseCodeSchema = z.union([z.number(), z.string()]);
export const sessionLoginResponseSchema = z.object({
  responseCode: responseCodeSchema,
  sessionId: z.string().min(1),
}).passthrough();
export const basicResponseSchema = z.object({ responseCode: responseCodeSchema }).passthrough();
export const aboutBuildVersionSchema = z.object({
  responseCode: responseCodeSchema,
  componentType: z.number().int(),
  majorVersion: z.number().int().nonnegative(),
  minorVersion: z.number().int().nonnegative(),
  patchVersion: z.number().int().nonnegative(),
}).passthrough();
export const aboutModulesListSchema = z.object({
  responseCode: responseCodeSchema,
  modules: z.array(z.object({
    name: z.string(),
    majorVersion: z.number().int().nonnegative(),
    minorVersion: z.number().int().nonnegative(),
  }).passthrough()),
}).passthrough();
