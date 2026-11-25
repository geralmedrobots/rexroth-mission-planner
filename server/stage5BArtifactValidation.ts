import { z } from 'zod';

const finite = z.number().finite();
const pose = z.object({ x: finite, y: finite, theta: finite }).passthrough();
const footprint = z.object({
  length: finite.positive(), width: finite.positive(), height: finite.nonnegative(),
  centerOffsetX: finite, centerOffsetY: finite, safetyMargin: finite.nonnegative(),
  inflationRadius: finite.nonnegative(), minimumTurningRadius: finite.nonnegative(),
  differentialDrive: z.boolean(), allowReverse: z.boolean(), allowTurnOnSpot: z.boolean(),
}).passthrough();

const finalizedRecordingSchema = z.object({
  schemaVersion: z.literal('motion-planner-scenario-v1'),
  mapRevision: z.string().min(1), footprintGeometryHash: z.string().min(1),
  selectedProfile: z.string().min(1),
  grid: z.object({
    metadata: z.object({
      width: finite.int().positive(), height: finite.int().positive(), resolution: finite.positive(),
      origin: z.object({ x: finite, y: finite, yaw: finite }), mapId: z.string(), name: z.string(),
      occupiedThreshold: finite, freeThreshold: finite, negate: z.boolean(),
    }).passthrough(),
    data: z.array(finite),
  }).passthrough(),
  footprint,
  startPose: pose, goalPose: pose, goalTheta: finite.optional(),
  configuration: z.object({
    planner: z.object({ passageSafety: z.object({ wallClearanceMinimumM: finite.nonnegative() }).passthrough() }).passthrough(),
    footprint, order: z.object({}).passthrough(),
    normalized: z.object({ motionState: z.object({}).passthrough() }).passthrough(),
  }).passthrough(),
  recording: z.object({
    recorderVersion: z.literal('stage5b-recorder-v1'), recordingId: z.string().uuid(),
    missionId: z.string().min(1), provenance: z.enum(['real-run', 'synthetic']),
    startedAt: z.iso.datetime({ offset: true }), completedAt: z.iso.datetime({ offset: true }),
    outcome: z.enum(['success', 'failed', 'cancelled']), appVersion: z.string().min(1),
    execution: z.object({
      status: z.enum(['success', 'failed', 'cancelled']),
      completedAt: z.iso.datetime({ offset: true }), startedAt: z.iso.datetime({ offset: true }).optional(),
      durationMs: finite.nonnegative().optional(), orderId: z.string().optional(),
      lastNodeId: z.string().optional(), lastNodeSequenceId: finite.optional(),
      navigatorErrors: z.array(z.unknown()).optional(), finalPose: pose.optional(),
    }).passthrough(),
    orders: z.array(z.object({
      order: z.object({ orderId: z.string().min(1), nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }).passthrough(),
      generatedAt: z.iso.datetime({ offset: true }), publishedAt: z.iso.datetime({ offset: true }).optional(),
    })),
  }).passthrough(),
}).passthrough();

const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const gridRevision = (grid: z.infer<typeof finalizedRecordingSchema>['grid']): string => {
  let hash = 0x811c9dc5;
  const metadata = JSON.stringify(grid.metadata);
  for (let index = 0; index < metadata.length; index += 1) {
    hash ^= metadata.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  for (const value of grid.data) {
    hash ^= (value + 256) & 0xffff;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

/** Server-side storage-boundary validation. The replay loader validates again when collected. */
export function validateFinalizedStage5BArtifact(value: unknown): z.infer<typeof finalizedRecordingSchema> {
  finalizedRecordingSchema.parse(value);
  // Integrity hashes are defined over the recorder's original JSON key order.
  // Zod reconstructs object keys in schema order, so validate that shape but
  // calculate and persist the exact received object.
  const artifact = value as z.infer<typeof finalizedRecordingSchema>;
  if (artifact.grid.data.length !== artifact.grid.metadata.width * artifact.grid.metadata.height)
    throw new Error('Artifact grid dimensions do not match cell count.');
  if (artifact.recording.execution.status !== artifact.recording.outcome ||
      artifact.recording.execution.completedAt !== artifact.recording.completedAt)
    throw new Error('Artifact execution outcome does not match finalized recording metadata.');
  if (gridRevision(artifact.grid) !== artifact.mapRevision)
    throw new Error('Artifact grid integrity mismatch.');
  const footprintHash = fnv1a(JSON.stringify({
    length: artifact.footprint.length, width: artifact.footprint.width,
    centerOffsetX: artifact.footprint.centerOffsetX, centerOffsetY: artifact.footprint.centerOffsetY,
    safetyMargin: artifact.footprint.safetyMargin, polygon: artifact.footprint.polygon ?? null,
  }));
  if (footprintHash !== artifact.footprintGeometryHash)
    throw new Error('Artifact footprint integrity mismatch.');
  return artifact;
}
