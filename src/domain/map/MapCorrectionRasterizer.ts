import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import type { OccupancyGrid } from '../types';
import { createPlanningMapSnapshot, sameSourceMap, type SourceMapSnapshot } from './MapSnapshots';
import {
  mapCorrectionCollectionInputSchema,
  type MapCorrection,
  type MapCorrectionCollection,
} from './MapCorrections';
import { prepareCorrectionShape, visitCorrectionCells } from './MapCorrectionGeometry';

function prepare(source: SourceMapSnapshot, input: unknown) {
  const { metadata, data } = source.rawOccupancyGrid;
  const { width, height, resolution, origin } = metadata;
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    width * height !== data.length ||
    ![resolution, origin.x, origin.y, origin.yaw].every(Number.isFinite) ||
    resolution <= 0
  ) {
    throw new Error('Invalid source grid dimensions or geometry.');
  }
  const { sourceIdentity, corrections } = mapCorrectionCollectionInputSchema.parse(input);
  if (!sameSourceMap(source.sourceIdentity, sourceIdentity))
    throw new Error('Correction source identity mismatch.');
  const ids = new Set<string>();
  const transform = new CoordinateTransformer(metadata);
  const operations = corrections.map((correction) => {
    if (ids.has(correction.id)) throw new Error('Duplicate correction ID: ' + correction.id);
    ids.add(correction.id);
    const shape = prepareCorrectionShape(correction, transform, resolution);
    const intersection = correction.kind === 'wall' || correction.kind === 'force_occupied';
    const visit = (callback: (index: number) => void) =>
      visitCorrectionCells(
        shape,
        intersection ? 'intersection' : 'centre',
        width,
        height,
        callback,
      );
    return { correction, visit };
  });
  return { operations, collection: { sourceIdentity: source.sourceIdentity, corrections } };
}

export function validateMapCorrectionCollection(
  source: SourceMapSnapshot,
  input: unknown,
): MapCorrectionCollection {
  return prepare(source, input).collection;
}

function valueAfter(kind: MapCorrection['kind'], original: number): number {
  switch (kind) {
    case 'erase':
      return original < 0 ? original : 0;
    case 'restore':
      return original;
    case 'force_free':
      return 0;
    case 'wall':
    case 'force_occupied':
      return 100;
  }
}

function replay(
  source: SourceMapSnapshot,
  operations: ReturnType<typeof prepare>['operations'],
): OccupancyGrid {
  const grid = createPlanningMapSnapshot(source).effectiveOccupancyGrid;
  for (const { correction, visit } of operations) {
    visit((index) => {
      grid.data[index] = valueAfter(correction.kind, source.rawOccupancyGrid.data[index]!);
    });
  }
  return grid;
}

export function applyCorrections(
  source: SourceMapSnapshot,
  collection: MapCorrectionCollection,
): OccupancyGrid {
  return replay(source, prepare(source, collection).operations);
}

export interface CorrectionPreviewCell {
  readonly index: number;
  readonly sourceValue: number;
  readonly previousValue: number;
  readonly resultValue: number;
}

export interface CorrectionPreview {
  readonly correctionId: string;
  readonly kind: MapCorrection['kind'];
  /** Unique row-major indices, including covered cells whose value already agrees. */
  readonly cells: readonly CorrectionPreviewCell[];
}

export function previewMapCorrection(
  source: SourceMapSnapshot,
  collection: MapCorrectionCollection,
  proposed: MapCorrection,
): CorrectionPreview {
  const { operations } = prepare(source, {
    ...collection,
    corrections: [...collection.corrections, proposed],
  });
  const last = operations.pop()!;
  const grid = replay(source, operations);
  const indices = new Set<number>();
  last.visit((index) => indices.add(index));
  const cells = [...indices]
    .sort((a, b) => a - b)
    .map((index) => {
      const sourceValue = source.rawOccupancyGrid.data[index]!;
      return {
        index,
        sourceValue,
        previousValue: grid.data[index]!,
        resultValue: valueAfter(last.correction.kind, sourceValue),
      };
    });
  return { correctionId: proposed.id, kind: proposed.kind, cells };
}
