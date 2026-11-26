import { z } from 'zod';
import { applyCorrections, validateMapCorrectionCollection } from '../../domain/map/MapCorrectionRasterizer';
import { createSourceMapSnapshot, sameSourceMap } from '../../domain/map/MapSnapshots';
import type { OccupancyGrid } from '../../domain/types';
import { useAppStore } from '../../stores/appStore';
import { useLocatorStore } from '../locator/stores/locatorStore';
import { mapCorrectionPersistence, type SavedMapRevision } from './MapCorrectionPersistence';
import { activateReference, isLatestMapLoad, mapLoadCheckpoint } from './mapSourceLoader';
import { portableDigest } from './PlanningMapExport';
import { bindingKey, referenceMapPersistence, validateReference, type StoredReferenceMap } from './ReferenceMapPersistence';
import { assertNoActiveMission, configuredReferenceBinding } from './referenceMapBinding';

const envelopeSchema = z.strictObject({content:z.string(), sha256:z.string().regex(/^[0-9a-f]{64}$/)});
const payloadSchema = z.object({
  format:z.literal('med-robots-planning-map'), schemaVersion:z.literal(1),
  exportedAt:z.iso.datetime({offset:true}), activeRevision:z.number().int().nonnegative(),
  reference:z.object({
    schemaVersion:z.literal(1), createdAt:z.iso.datetime({offset:true}), reviewRequired:z.boolean(),
    info:z.unknown(), source:z.object({
      sourceIdentity:z.unknown(), rawOccupancyGrid:z.unknown(),
      originalRaster:z.object({image:z.string(), pixelWidth:z.number(), pixelHeight:z.number(),
        reportedWidthM:z.number(), reportedHeightM:z.number()}),
    }),
  }),
  revisions:z.array(z.object({revision:z.number().int().nonnegative(), createdAt:z.string().nullable(),
    corrections:z.array(z.unknown())})).min(1),
});

export interface PlanningMapImportCandidate {
  readonly sourceName: string;
  readonly revision: number;
  readonly grid: OccupancyGrid;
}

let pending: {candidate:PlanningMapImportCandidate; record:StoredReferenceMap;
  revisions:readonly SavedMapRevision[]; version:number} | undefined;

/** Read and validate a portable map without changing application state. */
export async function preparePlanningMapImport(file: Blob): Promise<PlanningMapImportCandidate> {
  pending = undefined;
  const version = mapLoadCheckpoint();
  const envelope = envelopeSchema.parse(JSON.parse(await file.text()));
  if (await portableDigest(envelope.content) !== envelope.sha256) throw new Error('Map file checksum mismatch.');
  const payload = payloadSchema.parse(JSON.parse(envelope.content));
  const raw = payload.reference.source.rawOccupancyGrid as StoredReferenceMap['source']['rawOccupancyGrid'];
  const identity = payload.reference.source.sourceIdentity as StoredReferenceMap['source']['sourceIdentity'];
  const raster = payload.reference.source.originalRaster;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raster.image))
    throw new Error('Invalid PNG encoding.');
  const binary = atob(raster.image);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const signature = [137,80,78,71,13,10,26,10];
  if (bytes.length < 24 || signature.some((byte,index) => bytes[index] !== byte) ||
      new DataView(bytes.buffer).getUint32(16) !== raster.pixelWidth ||
      new DataView(bytes.buffer).getUint32(20) !== raster.pixelHeight)
    throw new Error('Invalid PNG dimensions or signature.');
  const image = new Blob([bytes], {type:'image/png'});
  const source = await createSourceMapSnapshot({metadata:raw.metadata, data:Array.from(raw.data)},
    identity.source, {...raster, image});
  if (!sameSourceMap(source.sourceIdentity, identity)) throw new Error('Map source identity mismatch.');
  // A portable file cannot establish that another installation uses the same MAP frame.
  const record = {...payload.reference, source, reviewRequired:true} as StoredReferenceMap;
  const binding = configuredReferenceBinding(source.sourceIdentity.metadata.mapId);
  validateReference(binding, record);
  if (payload.activeRevision !== payload.revisions.length - 1) throw new Error('Invalid active revision.');
  const revisions:SavedMapRevision[] = payload.revisions.map((entry,index) => {
    if (entry.revision !== index || (index === 0 ? entry.createdAt !== null || entry.corrections.length !== 0 :
      !entry.createdAt || !Number.isFinite(Date.parse(entry.createdAt))))
      throw new Error('Invalid correction revision history.');
    const collection = validateMapCorrectionCollection(source, {sourceIdentity:identity, corrections:entry.corrections});
    return {...entry, corrections:collection.corrections};
  });
  const grid = applyCorrections(source, {sourceIdentity:identity, corrections:revisions.at(-1)!.corrections});
  if (!isLatestMapLoad(version)) throw new Error('Map selection changed while preparing import.');
  const candidate = Object.freeze({sourceName:binding.mapName, revision:payload.activeRevision, grid});
  pending = {candidate, record, revisions, version};
  return candidate;
}

/** Imports into an empty binding. Existing references and correction histories are preserved. */
export async function confirmPlanningMapImport(candidate: PlanningMapImportCandidate): Promise<void> {
  const prepared = pending;
  if (!prepared || prepared.candidate !== candidate) throw new Error('Import candidate is stale.');
  const {record, revisions, version} = prepared;
  const binding = configuredReferenceBinding(candidate.sourceName);
  const app = useAppStore.getState();
  if (app.referenceUpdatePending) throw new Error('Reference update already in progress.');
  const check = () => {
    if (!isLatestMapLoad(version) || bindingKey(binding) !== bindingKey(configuredReferenceBinding(candidate.sourceName)))
      throw new Error('Map selection or Locator settings changed.');
    assertNoActiveMission();
  };
  check();
  app.set({referenceUpdatePending:true});
  try {
    if (await referenceMapPersistence.load(binding)) throw new Error('A reference map already exists for this binding.');
    check();
    const grid = applyCorrections(record.source, {sourceIdentity:record.source.sourceIdentity,
      corrections:revisions.at(-1)!.corrections});
    await activateReference(record, () => {check(); return true;}, false,
      () => mapCorrectionPersistence.importRevisions(record.source, revisions,
        () => referenceMapPersistence.save(binding, record, undefined, check)), true,
      {sourceIdentity:record.source.sourceIdentity, revision:candidate.revision,
        savedRevision:candidate.revision, effectiveOccupancyGrid:grid});
    useLocatorStore.getState().set({selectedMapName:binding.mapName});
    pending = undefined;
  } finally { app.set({referenceUpdatePending:false}); }
}
