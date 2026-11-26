import {
  createSourceMapSnapshot, sameSourceMap, type LocatorInstanceIdentity,
  type SourceMapIdentity, type SourceMapSnapshot,
} from '../../domain/map/MapSnapshots';
import type { ServerMapInfo } from '../locator/types';

export interface ReferenceMapBinding {
  readonly mapName: string;
  readonly instance: LocatorInstanceIdentity;
}

export interface StoredReferenceMap {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly source: SourceMapSnapshot;
  readonly info: ServerMapInfo;
  readonly reviewRequired: boolean;
}

export const bindingKey = ({mapName, instance}: ReferenceMapBinding): string => JSON.stringify([
  mapName, instance.host.trim().toLowerCase(), instance.port, instance.https, instance.rpcEndpoint.trim(),
]);

export function validateReference(binding: ReferenceMapBinding, record: StoredReferenceMap): void {
  const { source, info } = record;
  const identity = source?.sourceIdentity;
  const provenance = identity?.source;
  if (record.schemaVersion !== 1 || !Number.isFinite(Date.parse(record.createdAt)) ||
      typeof record.reviewRequired !== 'boolean' || !info || !Number.isInteger(info.level) ||
      provenance?.kind !== 'locator' || !provenance.instance || typeof provenance.fingerprint !== 'string' ||
      provenance.fingerprint !== info.fingerprint || info.name !== binding.mapName ||
      identity.metadata.name !== info.name ||
      bindingKey({mapName: identity.metadata.mapId, instance: provenance.instance}) !== bindingKey(binding))
    throw new Error('Invalid reference map record or Locator binding.');

  const {metadata, data} = source.rawOccupancyGrid;
  const {width, height, resolution, origin, freeThreshold, occupiedThreshold} = metadata;
  const raster = source.originalRaster;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Array.isArray(data) || data.length !== width * height || !data.every(n => n === -1 || n === 0 || n === 100) ||
      ![resolution, origin.x, origin.y, origin.yaw, freeThreshold, occupiedThreshold].every(Number.isFinite) ||
      resolution <= 0 || freeThreshold < 0 || occupiedThreshold > 1 || freeThreshold >= occupiedThreshold ||
      !raster || raster.pixelWidth !== width || raster.pixelHeight !== height ||
      ![raster.reportedWidthM, raster.reportedHeightM].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) ||
      !raster.image?.size || typeof raster.image.arrayBuffer !== 'function')
    throw new Error('Invalid reference map geometry, occupancy or raster.');
}

function historyKey(binding: ReferenceMapBinding, identity: SourceMapIdentity): string[] {
  if (identity.source.kind !== 'locator') throw new Error('Expected a Locator reference.');
  return [bindingKey(binding), identity.source.fingerprint, identity.occupancyDigest];
}

/** Active snapshot and archive are written together. Object URLs never enter storage. */
export class ReferenceMapPersistence {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) throw new Error('IndexedDB reference map storage is unavailable.');
      const request = indexedDB.open('med-robots-reference-maps', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('active');
        request.result.createObjectStore('history');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async load(binding: ReferenceMapBinding, archivedIdentity?: SourceMapIdentity): Promise<StoredReferenceMap | undefined> {
    const db = await this.open();
    try {
      const record = await new Promise<StoredReferenceMap | undefined>((resolve, reject) => {
        const table = archivedIdentity ? 'history' : 'active';
        const store = db.transaction(table).objectStore(table);
        if (archivedIdentity) {
          const prefix = historyKey(binding, archivedIdentity);
          // A repeated identity can have distinct PNGs or reported physical extents.
          const range = IDBKeyRange.bound(prefix, [...prefix, []]);
          const cursor = store.openCursor(range, 'prev');
          cursor.onsuccess = () => resolve(cursor.result?.value);
          cursor.onerror = () => reject(cursor.error);
        } else {
          const request = store.get(bindingKey(binding));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }
      });
      if (record === undefined) return;
      validateReference(binding, record);
      const raw = record.source.rawOccupancyGrid;
      const identity = record.source.sourceIdentity;
      const source = await createSourceMapSnapshot({metadata: raw.metadata, data: Array.from(raw.data)},
        identity.source, record.source.originalRaster);
      if (!sameSourceMap(source.sourceIdentity, identity) || (archivedIdentity && !sameSourceMap(identity, archivedIdentity)))
        throw new Error('Reference map integrity check failed.');
      return {...record, source};
    } finally { db.close(); }
  }

  async save(binding: ReferenceMapBinding, record: StoredReferenceMap, expected: StoredReferenceMap | undefined,
    checkCurrent: () => void): Promise<void> {
    validateReference(binding, record);
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['active', 'history'], 'readwrite');
        const active = tx.objectStore('active');
        const key = bindingKey(binding);
        const request = active.get(key);
        let cause: unknown;
        request.onsuccess = () => {
          try {
            checkCurrent();
            const previous = request.result as StoredReferenceMap | undefined;
            if (expected ? !previous || previous.createdAt !== expected.createdAt ||
                previous.reviewRequired !== expected.reviewRequired ||
                !sameSourceMap(expected.source.sourceIdentity, previous.source.sourceIdentity) : previous !== undefined)
              throw new Error('Reference changed before save. Reload and review the current reference.');
            if (previous && (previous.createdAt !== record.createdAt ||
                !sameSourceMap(previous.source.sourceIdentity, record.source.sourceIdentity)))
              tx.objectStore('history').put(previous, [...historyKey(binding, previous.source.sourceIdentity), previous.createdAt]);
            active.put(record, key).onsuccess = () => {
              try { checkCurrent(); }
              catch (error) { cause = error; tx.abort(); }
            };
          } catch (error) { cause = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(cause ?? tx.error ?? new Error('Reference map write aborted.'));
      });
    } finally { db.close(); }
  }
}

export const referenceMapPersistence = new ReferenceMapPersistence();
