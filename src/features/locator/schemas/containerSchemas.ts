import { z } from 'zod';

export const containerSchema = z.object({
  contentEncoding: z.literal('base64'),
  contentMediaType: z.string().min(1),
  content: z.string().min(1),
}).strict();

export type BoschContainer = z.infer<typeof containerSchema>;
