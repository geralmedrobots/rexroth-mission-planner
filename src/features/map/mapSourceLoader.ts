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
import { bindingKey, referenceMapPersistence, validateReference, type ReferenceMapBinding, type StoredReferenceMap } from './ReferenceMapPersistence';
import { assertNoActiveMission, configuredReferenceBinding } from './referenceMapBinding';

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

function commitPlanningMap(planningMap: PlanningMapSnapshot, sourceMap: SourceMapSnapshot,
  referenceReviewRequired = useAppStore.getState().referenceReviewRequired): OccupancyGrid {
  const app = useAppStore.getState();
  const grid = planningMap.effectiveOccupancyGrid;
  const { planningSafetyMarginM, localizationMarginM } = app.plannerOptions.passageSafety;
  const inflatedGrid = ObstacleInflation.byRadius(grid, planningSafetyMarginM + localizationMarginM);
  app.set({ sourceMap, planningMap, grid, inflatedGrid, referenceReviewRequired });
  const { name, width, height, resolution } = grid.metadata;
  LogService.write('planner', 'info', `Loaded ${name}: ${width}×${height} at ${resolution} m/cell`);
  return grid;
}

async function planFromSource(
  source: SourceMapSnapshot, isCurrent: () => boolean, mode: 'reload' | 'startup' | 'editor' | 'update' = 'reload',
): Promise<PlanningMapSnapshot | undefined> {
  let planning: PlanningMapSnapshot;
  try {
    const { revision, collection } = await mapCorrectionPersistence.loadCorrections(source);
    if (!isCurrent()) return;
    const active = useAppStore.getState().planningMap;
    if (active?.savedRevision === revision && sameSourceMap(active.sourceIdentity, source.sourceIdentity)) {
      if (mode === 'startup') return;
      if (mode === 'editor' && active.revision === revision) return active;
    }
    planning = { sourceIdentity: source.sourceIdentity, revision, savedRevision: revision,
      effectiveOccupancyGrid: applyCorrections(source, collection) };
  } catch (error) {
    if (!isCurrent()) return;
    if (mode === 'update') throw error;
    planning = createPlanningMapSnapshot(source);
    LogService.write('planner', 'error',
      'Using original map ' + source.sourceIdentity.metadata.name + '. Saved corrections could not be activated: ' + String(error));
  }
  if (!isCurrent()) return;
  return planning;
}

async function activateSource(source: SourceMapSnapshot, isCurrent: () => boolean, mode: 'reload' | 'editor' = 'reload') {
  const planning = await planFromSource(source, isCurrent, mode);
  if (!planning || !isCurrent()) return;
  if (planning === useAppStore.getState().planningMap) return planning.effectiveOccupancyGrid;
  return commitPlanningMap(planning, source);
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
  /** Offline inspection may open an existing reference without authorizing a download. */
  referenceOnly?: boolean;
}

export async function downloadReference(binding: ReferenceMapBinding): Promise<StoredReferenceMap> {
  const {mapName} = binding;
  const {occupancy, raster, image, info, instance} =
    await locatorMapService.downloadSource(mapName, useLocatorStore.getState().settings);
  try {
    const source = await createSourceMapSnapshot(occupancy, {kind:'locator', fingerprint:info.fingerprint, instance}, {
      image, pixelWidth:raster.pixelWidth, pixelHeight:raster.pixelHeight,
      reportedWidthM:raster.widthMeters, reportedHeightM:raster.heightMeters,
    });
    const record: StoredReferenceMap = {schemaVersion:1, createdAt:new Date().toISOString(), source, info, reviewRequired:false};
    validateReference(binding, record);
    return record;
  } finally { URL.revokeObjectURL(raster.imageUrl); }
}

/** Prepare all fallible reads before replacing the persisted reference or publishing the grid. */
export async function activateReference(record: StoredReferenceMap, isCurrent: () => boolean,
  skipUnchanged: boolean, persist?: () => Promise<void>, explicitUpdate = false): Promise<OccupancyGrid | undefined> {
  const {source, info, reviewRequired} = record;
  const active = useAppStore.getState().planningMap;
  const mode = persist || !useLocatorStore.getState().loadedMap ? 'reload' : skipUnchanged ? 'startup' : 'editor';
  const planning = await planFromSource(source, isCurrent, explicitUpdate ? 'update' : mode);
  if (!isCurrent()) return;
  if (!planning || planning === active) {
    useAppStore.getState().set({referenceReviewRequired:reviewRequired});
    return planning?.effectiveOccupancyGrid;
  }
  const original = source.originalRaster!;
  const {resolution, origin} = source.rawOccupancyGrid.metadata;
  const pngBytes = new Uint8Array(await original.image.arrayBuffer());
  if (!isCurrent()) return;
  const imageUrl = URL.createObjectURL(original.image);
  try {
    const raster = {
      mapName:info.name, pngBytes, imageUrl, pixelWidth:original.pixelWidth, pixelHeight:original.pixelHeight,
      widthMeters:original.reportedWidthM!, heightMeters:original.reportedHeightM!,
      pixelsPerMeter:1/resolution, metersPerPixel:resolution, origin:{...origin},
    };
    if (persist) await persist();
    if (!isCurrent()) { URL.revokeObjectURL(imageUrl); return; }
    const grid = commitPlanningMap(planning, source, reviewRequired);
    locatorMapService.activateRaster(raster);
    useLocatorStore.getState().set({loadedMap:raster, mapInfo:info, lastDownloadTime:record.createdAt});
    return grid;
  } catch (error) { URL.revokeObjectURL(imageUrl); throw error; }
}

export async function loadLocatorSource(name: string, {
  version = beginMapLoad(), signal, isSelectionCurrent = () => true, skipUnchanged = false, referenceOnly = false,
}: LocatorLoadOptions = {}): Promise<OccupancyGrid | undefined> {
  const binding = configuredReferenceBinding(name);
  const isCurrent = () => isLatestMapLoad(version) && !signal?.aborted && isSelectionCurrent() &&
    bindingKey(binding) === bindingKey(configuredReferenceBinding(name));
  if (!isCurrent()) return;
  if (!name) throw new Error('Select a Locator map first.');
  const locator = useLocatorStore.getState();
  locator.set({ downloading: true, error: undefined, selectedMapName: name });
  try {
    const existing = await referenceMapPersistence.load(binding);
    if (!isCurrent()) return;
    const checkLoad = (record: StoredReferenceMap) => {
      if (!isCurrent()) return false;
      const current = useAppStore.getState().sourceMap;
      if (current && !sameSourceMap(current.sourceIdentity, record.source.sourceIdentity)) assertNoActiveMission();
      return true;
    };
    if (existing) return await activateReference(existing, () => checkLoad(existing), skipUnchanged);
    if (referenceOnly) throw new Error('No saved reference for this map and Locator installation.');
    const first = await downloadReference(binding);
    if (!isCurrent()) return;
    return await activateReference(first, () => checkLoad(first), false, () => referenceMapPersistence.save(binding, first, undefined, () => {
      if (!checkLoad(first)) throw new Error('Map selection changed during initial download.');
    }));
  } catch (error) {
    if (isCurrent()) {
      locator.set({error:String(error)});
      throw error;
    }
  } finally {
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
