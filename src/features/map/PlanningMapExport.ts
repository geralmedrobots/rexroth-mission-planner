import { sameSourceMap } from '../../domain/map/MapSnapshots';
import { useAppStore } from '../../stores/appStore';
import { mapCorrectionPersistence } from './MapCorrectionPersistence';
import { referenceMapPersistence } from './ReferenceMapPersistence';
import { configuredReferenceBinding } from './referenceMapBinding';

export async function portableDigest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Export the persisted reference and its saved revisions as a portable JSON file. */
export async function exportPlanningMap(): Promise<{ filename: string; file: Blob }> {
  const source = useAppStore.getState().sourceMap;
  if (!source || source.sourceIdentity.source.kind !== 'locator') {
    throw new Error('Load a persistent Locator reference map before exporting.');
  }
  const name = source.sourceIdentity.metadata.mapId;
  const record = await referenceMapPersistence.load(configuredReferenceBinding(name));
  if (!record || !sameSourceMap(source.sourceIdentity, record.source.sourceIdentity)) {
    throw new Error('The active source does not match the persisted reference.');
  }
  const revisions = await mapCorrectionPersistence.listRevisions(record.source);
  const raster = record.source.originalRaster!;
  const bytes = new Uint8Array(await raster.image.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const exportedAt = new Date().toISOString();
  const payload = {
    format: 'med-robots-planning-map', schemaVersion: 1, exportedAt,
    reference: { ...record, source: { ...record.source,
      originalRaster: { ...raster, image: btoa(binary) } } },
    activeRevision: revisions[revisions.length - 1]!.revision,
    revisions,
  };
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const content = JSON.stringify(payload);
  return {
    filename: `${safeName}_corrected_${exportedAt.slice(0, 10)}.mrmap`,
    file: new Blob([JSON.stringify({content, sha256: await portableDigest(content)})], { type: 'application/json' }),
  };
}
