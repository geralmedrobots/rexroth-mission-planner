import { z } from 'zod';
import type { SourceMapIdentity } from './MapSnapshots';

const pointSchema = z.strictObject({ x: z.number(), y: z.number() }).readonly();

/** A point in the Locator MAP frame, in metres. */
export type MapPoint = z.infer<typeof pointSchema>;

const areaSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('circle'),
      center: pointSchema,
      radiusM: z.number().positive(),
    }),
    z.strictObject({
      kind: z.literal('stroke'),
      points: z.array(pointSchema).min(1).readonly(),
      radiusM: z.number().positive(),
    }),
    z.strictObject({
      kind: z.literal('rectangle'),
      vertices: z.tuple([pointSchema, pointSchema, pointSchema, pointSchema]).readonly(),
    }),
    z.strictObject({
      kind: z.literal('polygon'),
      vertices: z.array(pointSchema).min(3).readonly(),
    }),
  ])
  .readonly();

/** Vertices follow the shape perimeter in either winding direction, with no repeated closing vertex. */
export type CorrectionArea = z.infer<typeof areaSchema>;

const fields = { id: z.string().regex(/\S/), createdAt: z.iso.datetime({ offset: true }) };
const correctionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ ...fields, kind: z.literal('erase'), area: areaSchema }),
    z.strictObject({ ...fields, kind: z.literal('force_free'), area: areaSchema }),
    z.strictObject({ ...fields, kind: z.literal('force_occupied'), area: areaSchema }),
    z.strictObject({ ...fields, kind: z.literal('restore'), area: areaSchema }),
    z.strictObject({
      ...fields,
      kind: z.literal('wall'),
      from: pointSchema,
      to: pointSchema,
      thicknessM: z.number().positive(),
    }),
  ])
  .readonly();

export type MapCorrection = z.infer<typeof correctionSchema>;

export interface MapCorrectionCollection {
  readonly sourceIdentity: SourceMapIdentity;
  /** Array order is application order. Timestamps and IDs are retained for attribution. */
  readonly corrections: readonly MapCorrection[];
}

/** Internal structural check. The rasterizer verifies source identity and geometry. */
export const mapCorrectionCollectionInputSchema = z.strictObject({
  sourceIdentity: z.unknown(),
  corrections: z.array(correctionSchema).readonly(),
});
