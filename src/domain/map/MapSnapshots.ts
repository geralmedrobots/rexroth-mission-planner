import type { MapMetadata, OccupancyGrid } from '../types';

export type SourceMapMetadata = Readonly<Omit<MapMetadata, 'origin'>> & {
  readonly origin: Readonly<MapMetadata['origin']>;
};

export interface LocatorInstanceIdentity {
  readonly host: string;
  readonly port: number;
  readonly https: boolean;
  readonly rpcEndpoint: string;
}

export type MapSource = { readonly kind: 'import' } | {
  readonly kind: 'locator';
  readonly instance?: LocatorInstanceIdentity;
  readonly fingerprint: string;
};

export interface SourceMapIdentity {
  readonly source: MapSource;
  readonly metadata: SourceMapMetadata;
  readonly occupancyDigest: `sha256:${string}`;
}

export interface SourceMapRaster {
  readonly image: Blob;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly reportedWidthM?: number;
  readonly reportedHeightM?: number;
}

export interface SourceMapSnapshot {
  readonly sourceIdentity: SourceMapIdentity;
  readonly rawOccupancyGrid: {
    readonly metadata: SourceMapMetadata;
    readonly data: readonly number[];
  };
  readonly originalRaster?: SourceMapRaster;
}

/** Starts at the saved correction revision or zero, and can advance through legacy edits. */
export type PlanningMapRevision = number;

export interface PlanningMapSnapshot {
  readonly sourceIdentity: SourceMapIdentity;
  readonly revision: PlanningMapRevision;
  /** Persisted base revision, retained across legacy single-cell edits. */
  readonly savedRevision?: number;
  readonly effectiveOccupancyGrid: OccupancyGrid;
}

function occupancyParameters(metadata: SourceMapMetadata) {
  const { width, height, resolution, origin, occupiedThreshold, freeThreshold, negate } = metadata;
  return [width, height, resolution, origin.x, origin.y, origin.yaw, occupiedThreshold, freeThreshold, negate] as const;
}

async function digestOccupancy({ metadata, data }: SourceMapSnapshot['rawOccupancyGrid']): Promise<SourceMapIdentity['occupancyDigest']> {
  // Versioned header followed by IEEE-754 cells in row-major order, independent of host byte order.
  const header = new TextEncoder().encode(`${JSON.stringify(['med-robots-occupancy-v1', ...occupancyParameters(metadata)])}\n`);
  const bytes = new Uint8Array(header.length + data.length * 8);
  bytes.set(header);
  const cells = new DataView(bytes.buffer, header.length);
  for (let index = 0; index < data.length; index += 1) {
    cells.setFloat64(index * 8, data[index]!, false);
  }
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export async function createSourceMapSnapshot(
  grid: OccupancyGrid, source: MapSource, originalRaster?: SourceMapRaster,
): Promise<SourceMapSnapshot> {
  const metadata = Object.freeze({ ...grid.metadata, origin: Object.freeze({ ...grid.metadata.origin }) });
  const rawOccupancyGrid = Object.freeze({ metadata, data: Object.freeze([...grid.data]) });
  const provenance = source.kind === 'locator'
    ? Object.freeze({ ...source, instance: source.instance && Object.freeze({ ...source.instance }) })
    : Object.freeze({ ...source });
  const raster = originalRaster && Object.freeze({ ...originalRaster });
  const occupancyDigest = await digestOccupancy(rawOccupancyGrid);
  return Object.freeze({
    sourceIdentity: Object.freeze({ source: provenance, metadata, occupancyDigest }),
    rawOccupancyGrid,
    originalRaster: raster,
  });
}

export function sameSourceMap(a: SourceMapIdentity, candidate: unknown): boolean {
  const b = candidate as Partial<SourceMapIdentity> | null | undefined;
  if (!b?.metadata?.origin || !b.source || a.metadata.mapId !== b.metadata.mapId ||
      a.metadata.name !== b.metadata.name || a.occupancyDigest !== b.occupancyDigest ||
      a.source.kind !== b.source.kind) return false;
  const candidateParameters = occupancyParameters(b.metadata);
  if (!occupancyParameters(a.metadata).every((value, index) => value === candidateParameters[index])) return false;
  if (a.source.kind !== 'locator' || b.source.kind !== 'locator') return true;
  if (a.source.fingerprint !== b.source.fingerprint) return false;
  const left = a.source.instance;
  const right = b.source.instance;
  if (!left || !right) return left === right;
  return left.host === right.host && left.port === right.port &&
    left.https === right.https && left.rpcEndpoint === right.rpcEndpoint;
}

export function createPlanningMapSnapshot(source: SourceMapSnapshot): PlanningMapSnapshot {
  const { metadata, data } = source.rawOccupancyGrid;
  return {
    sourceIdentity: source.sourceIdentity,
    revision: 0,
    effectiveOccupancyGrid: { metadata: { ...metadata, origin: { ...metadata.origin } }, data: [...data] },
  };
}
