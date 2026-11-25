import { z } from 'zod';
import type { MapCorrection, MapCorrectionCollection } from '../../domain/map/MapCorrections';
import { validateMapCorrectionCollection } from '../../domain/map/MapCorrectionRasterizer';
import {
  sameSourceMap,
  type SourceMapIdentity,
  type SourceMapSnapshot,
} from '../../domain/map/MapSnapshots';

export interface SavedMapRevision {
  readonly revision: number;
  /** Revision zero represents the original map and has no save timestamp. */
  readonly createdAt: string | null;
  readonly corrections: readonly MapCorrection[];
}

interface SavedPlanningMap {
  schemaVersion: 1;
  sourceIdentity: SourceMapIdentity;
  activeRevision: number;
  revisions: SavedMapRevision[];
}

const original: SavedMapRevision = Object.freeze({
  revision: 0,
  createdAt: null,
  corrections: Object.freeze([]),
});
const savedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceIdentity: z.unknown(),
  activeRevision: z.number().int().positive(),
  revisions: z
    .array(
      z.strictObject({
        revision: z.number().int().positive(),
        createdAt: z.iso.datetime({ offset: true }),
        corrections: z.array(z.unknown()),
      }),
    )
    .min(1),
});

async function storageKey(identity: SourceMapIdentity) {
  const { source, metadata, occupancyDigest } = identity;
  const instance = source.kind === 'locator' ? source.instance : undefined;
  // Sprint 1's digest already covers every geometry and classification parameter.
  const fields = [
    metadata.mapId,
    metadata.name,
    occupancyDigest,
    source.kind,
    source.kind === 'locator' ? source.fingerprint : null,
    instance?.host,
    instance?.port,
    instance?.https,
    instance?.rpcEndpoint,
  ];
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(fields)),
  );
  return (
    'med-robots-planning-map-' +
    Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('')
  );
}

export class MapCorrectionPersistence {
  private read(source: SourceMapSnapshot, key: string): SavedPlanningMap {
    const sourceIdentity = source.sourceIdentity;
    const text = localStorage.getItem(key);
    if (text === null)
      return { schemaVersion: 1, sourceIdentity, activeRevision: 0, revisions: [] };
    try {
      const data = savedSchema.parse(JSON.parse(text));
      if (!sameSourceMap(sourceIdentity, data.sourceIdentity))
        throw new Error('Source identity mismatch.');
      if (data.activeRevision !== data.revisions.length)
        throw new Error('Invalid active revision.');
      const revisions = data.revisions.map((entry, index) => {
        if (entry.revision !== index + 1) throw new Error('Invalid revision sequence.');
        const { corrections } = validateMapCorrectionCollection(source, {
          sourceIdentity,
          corrections: entry.corrections,
        });
        return { ...entry, corrections };
      });
      return { schemaVersion: 1, sourceIdentity, activeRevision: data.activeRevision, revisions };
    } catch (cause) {
      throw new Error('Invalid saved map history at ' + key + ': ' + String(cause), { cause });
    }
  }

  async loadCorrections(source: SourceMapSnapshot) {
    const saved = this.read(source, await storageKey(source.sourceIdentity));
    const active = saved.revisions.at(-1) ?? original;
    return {
      revision: active.revision,
      createdAt: active.createdAt,
      collection: { sourceIdentity: source.sourceIdentity, corrections: active.corrections },
    };
  }

  async listRevisions(source: SourceMapSnapshot): Promise<readonly SavedMapRevision[]> {
    return [original, ...this.read(source, await storageKey(source.sourceIdentity)).revisions];
  }

  private async append(
    source: SourceMapSnapshot,
    select: (saved: SavedPlanningMap) => readonly MapCorrection[],
    skipUnchanged: boolean,
  ): Promise<SavedMapRevision> {
    const key = await storageKey(source.sourceIdentity);
    if (!navigator.locks) throw new Error('Saving map revisions requires browser Web Locks.');
    return navigator.locks.request(key, () => {
      const saved = this.read(source, key);
      const corrections = select(saved);
      const previous = saved.revisions.at(-1) ?? original;
      if (skipUnchanged && JSON.stringify(previous.corrections) === JSON.stringify(corrections))
        return previous;
      const revision = {
        revision: previous.revision + 1,
        createdAt: new Date().toISOString(),
        corrections,
      };
      saved.revisions.push(revision);
      saved.activeRevision = revision.revision;
      localStorage.setItem(key, JSON.stringify(saved));
      return revision;
    });
  }

  async saveCorrections(source: SourceMapSnapshot, collection: MapCorrectionCollection) {
    const { corrections } = validateMapCorrectionCollection(source, collection);
    return this.append(source, () => corrections, true);
  }

  restoreRevision(source: SourceMapSnapshot, revision: number) {
    return this.append(
      source,
      (saved) => {
        if (!Number.isSafeInteger(revision) || revision < 0 || revision > saved.activeRevision)
          throw new Error('Unknown map revision: ' + revision);
        return revision === 0 ? original.corrections : saved.revisions[revision - 1]!.corrections;
      },
      false,
    );
  }

  resetCorrections(source: SourceMapSnapshot) {
    return this.restoreRevision(source, 0);
  }
}

export const mapCorrectionPersistence = new MapCorrectionPersistence();
