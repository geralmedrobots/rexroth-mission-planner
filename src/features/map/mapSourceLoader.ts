import { imageFileToPixels, metadataFromRosYaml, parseOccupancyJson, pixelsToOccupancy } from '../../domain/map/MapImporter';
import { applyCorrections } from '../../domain/map/MapCorrectionRasterizer';
import {
  createPlanningMapSnapshot, createSourceMapSnapshot, sameSourceMap,
  type PlanningMapSnapshot, type SourceMapRaster, type SourceMapSnapshot,
} from '../../domain/map/MapSnapshots';
import { ObstacleInflation } from '../../domain/planner/ObstacleInflation';
import type { OccupancyGrid } from '../../domain/types';
import { LogService } from '../../services/LogService';
import { useAppStore } from '../../stores/appStore';
import { locatorMapService } from '../locator/services/locatorMapService';
import { useLocatorStore } from '../locator/stores/locatorStore';
import { mapCorrectionPersistence } from './MapCorrectionPersistence';

let loadVersion = 0;

export function mapLoadCheckpoint(): number { return loadVersion; }
export function isLatestMapLoad(version: number): boolean { return version === loadVersion; }

/** Reserve a load before its first await, or invalidate pending work on selection change. */
export function beginMapLoad(): number {
  const version = ++loadVersion;
  const locator = useLocatorStore.getState();
  if (locator.downloading) locator.set({ downloading: false });
  return version;
}

function commitPlanningMap(planningMap: PlanningMapSnapshot, sourceMap: SourceMapSnapshot): OccupancyGrid {
  const app = useAppStore.getState();
  const grid = planningMap.effectiveOccupancyGrid;
  const { planningSafetyMarginM, localizationMarginM } = app.plannerOptions.passageSafety;
  const inflatedGrid = ObstacleInflation.byRadius(grid, planningSafetyMarginM + localizationMarginM);
  app.set({ sourceMap, planningMap, grid, inflatedGrid });
  const { name, width, height, resolution } = grid.metadata;
  LogService.write('planner', 'info', `Loaded ${name}: ${width}×${height} at ${resolution} m/cell`);
  return grid;
}

async function activateSource(
  source: SourceMapSnapshot, isCurrent: () => boolean, mode: 'reload' | 'startup' | 'editor' = 'reload',
  onCommit?: () => void,
): Promise<OccupancyGrid | undefined> {
  let planning: PlanningMapSnapshot;
  try {
    const { revision, collection } = await mapCorrectionPersistence.loadCorrections(source);
    if (!isCurrent()) return;
    const active = useAppStore.getState().planningMap;
    if (active?.savedRevision === revision && sameSourceMap(active.sourceIdentity, source.sourceIdentity)) {
      if (mode === 'startup') return;
      if (mode === 'editor' && active.revision === revision) return active.effectiveOccupancyGrid;
    }
    planning = { sourceIdentity: source.sourceIdentity, revision, savedRevision: revision,
      effectiveOccupancyGrid: applyCorrections(source, collection) };
  } catch (error) {
    if (!isCurrent()) return;
    planning = createPlanningMapSnapshot(source);
    LogService.write('planner', 'error',
      'Using original map ' + source.sourceIdentity.metadata.name + '. Saved corrections could not be activated: ' + String(error));
  }
  if (!isCurrent()) return;
  const grid = commitPlanningMap(planning, source);
  onCommit?.();
  return grid;
}

let activationVersion = 0;

/** Call after saving, restoring or resetting the editor's source snapshot.
 * Returns undefined if the source or request is obsolete. A read failure logs a diagnostic and activates the original grid.
 */
export async function activateSavedPlanningMap(source: SourceMapSnapshot): Promise<OccupancyGrid | undefined> {
  if (useAppStore.getState().sourceMap !== source) return;
  const selection = mapLoadCheckpoint();
  const request = ++activationVersion;
  return activateSource(source, () => isLatestMapLoad(selection) &&
    request === activationVersion && useAppStore.getState().sourceMap === source, 'editor');
}

/** Keeps the existing single-cell click modes on the effective grid. */
export function replaceLegacyPlanningGrid(grid: OccupancyGrid): void {
  const { sourceMap, planningMap } = useAppStore.getState();
  if (!sourceMap || !planningMap) return;
  commitPlanningMap({
    sourceIdentity: sourceMap.sourceIdentity,
    revision: planningMap.revision + 1,
    savedRevision: planningMap.savedRevision,
    effectiveOccupancyGrid: grid,
  }, sourceMap);
}

export interface LocatorLoadOptions {
  version?: number;
  signal?: AbortSignal;
  isSelectionCurrent?: () => boolean;
  skipUnchanged?: boolean;
}

export async function loadLocatorSource(name: string, {
  version = beginMapLoad(), signal, isSelectionCurrent = () => true, skipUnchanged = false,
}: LocatorLoadOptions = {}): Promise<OccupancyGrid | undefined> {
  const isCurrent = () => isLatestMapLoad(version) && !signal?.aborted && isSelectionCurrent();
  if (!isCurrent()) return;
  if (!name) throw new Error('Select a Locator map first.');
  const locator = useLocatorStore.getState();
  locator.set({ downloading: true, error: undefined, selectedMapName: name });
  let pendingUrl: string | undefined;
  try {
    const { occupancy, raster, image, info, instance } = await locatorMapService.downloadSource(name, locator.settings);
    pendingUrl = raster.imageUrl;
    if (!isCurrent()) return;
    const sourceMap = await createSourceMapSnapshot(occupancy,
      { kind: 'locator', fingerprint: info.fingerprint, instance }, {
        image,
        pixelWidth: raster.pixelWidth,
        pixelHeight: raster.pixelHeight,
        reportedWidthM: raster.widthMeters,
        reportedHeightM: raster.heightMeters,
      });
    if (!isCurrent()) return;
    return await activateSource(sourceMap, isCurrent, skipUnchanged ? 'startup' : 'reload', () => {
      locatorMapService.activateRaster(raster);
      pendingUrl = undefined;
      locator.set({ loadedMap: raster, mapInfo: info, lastDownloadTime: new Date().toISOString() });
    });
  } catch (error) {
    if (isCurrent()) throw error;
  } finally {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    if (isLatestMapLoad(version)) locator.set({ downloading: false });
  }
}

async function loadImportedSource(read: () => Promise<{ grid: OccupancyGrid; raster?: SourceMapRaster }>) {
  const version = beginMapLoad();
  try {
    const { grid, raster } = await read();
    if (!isLatestMapLoad(version)) return;
    const sourceMap = await createSourceMapSnapshot(grid, { kind: 'import' }, raster);
    if (isLatestMapLoad(version)) await activateSource(sourceMap, () => isLatestMapLoad(version));
  } catch (error) {
    if (isLatestMapLoad(version)) throw error;
  }
}

export function loadJsonMap(file: File): Promise<void> {
  return loadImportedSource(async () => ({ grid: parseOccupancyJson(await file.text()) }));
}

export function loadImageMap(file: File, yaml?: string): Promise<void> {
  return loadImportedSource(async () => {
    const { width, height, pixels } = await imageFileToPixels(file);
    const mapId = file.name.replace(/\.[^.]+$/, '');
    const metadata = yaml ? metadataFromRosYaml(yaml, width, height, mapId) : {
      name: file.name, mapId, width, height, resolution: 0.05,
      origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 0.65, freeThreshold: 0.196, negate: false,
    };
    return {
      grid: { metadata, data: pixelsToOccupancy(pixels, metadata) },
      raster: { image: file, pixelWidth: width, pixelHeight: height },
    };
  });
}
