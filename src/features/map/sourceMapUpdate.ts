import { sameSourceMap, type SourceMapIdentity } from '../../domain/map/MapSnapshots';
import { useAppStore } from '../../stores/appStore';
import { useLocatorStore } from '../locator/stores/locatorStore';
import { activateReference, downloadReference, isLatestMapLoad, mapLoadCheckpoint } from './mapSourceLoader';
import { bindingKey, referenceMapPersistence, type StoredReferenceMap } from './ReferenceMapPersistence';
import { assertNavigatorIdle, configuredReferenceBinding } from './referenceMapBinding';

function frame(record: StoredReferenceMap) {
  const {width, height, resolution, origin} = record.source.sourceIdentity.metadata;
  const raster = record.source.originalRaster!;
  return {
    width, height, resolution, originX:origin.x, originY:origin.y, yaw:origin.yaw,
    reportedWidthM:raster.reportedWidthM!, reportedHeightM:raster.reportedHeightM!, level:record.info.level,
  };
}

export interface SourceMapUpdateCandidate {
  readonly current: SourceMapIdentity;
  readonly proposed: SourceMapIdentity;
  readonly correctionsCompatible: boolean;
  readonly requiresAlignmentReview: boolean;
  readonly geometryChanges: readonly {readonly field:keyof ReturnType<typeof frame>; readonly before:number; readonly after:number}[];
}

let preparation = 0;
let pending: {
  candidate: SourceMapUpdateCandidate;
  previous: StoredReferenceMap;
  next: StoredReferenceMap;
  checkSelection: () => void;
} | undefined;

/** Prepare without activating. Discovering a frame change inhibits subsequent order dispatch. */
export async function prepareSourceMapUpdate(): Promise<SourceMapUpdateCandidate> {
  if (useAppStore.getState().referenceUpdatePending || useLocatorStore.getState().downloading)
    throw new Error('Another reference load or update is in progress.');
  pending = undefined;
  const request = ++preparation;
  const version = mapLoadCheckpoint();
  const identity = useAppStore.getState().sourceMap?.sourceIdentity;
  if (!identity || identity.source.kind !== 'locator') throw new Error('Load a Locator reference map first.');
  const name = identity.metadata.mapId;
  const binding = configuredReferenceBinding(name);
  const checkSelection = () => {
    if (request !== preparation || !isLatestMapLoad(version) ||
        !sameSourceMap(identity, useAppStore.getState().sourceMap?.sourceIdentity) ||
        useLocatorStore.getState().selectedMapName !== name ||
        bindingKey(binding) !== bindingKey(configuredReferenceBinding(name)))
      throw new Error('Reference selection changed. Prepare a new candidate.');
  };
  checkSelection();
  let previous = await referenceMapPersistence.load(binding);
  if (!previous || !sameSourceMap(identity, previous.source.sourceIdentity)) throw new Error('Reload the active reference first.');
  checkSelection();
  const next = await downloadReference(binding);
  checkSelection();
  const before = frame(previous), after = frame(next);
  const geometryChanges = (Object.keys(before) as (keyof typeof before)[])
    .filter(field => before[field] !== after[field])
    .map(field => Object.freeze({field, before:before[field], after:after[field]}));
  if (geometryChanges.length && !previous.reviewRequired) {
    useAppStore.getState().set({referenceReviewRequired:true});
    const flagged = {...previous, reviewRequired:true};
    await referenceMapPersistence.save(binding, flagged, previous, checkSelection);
    previous = flagged;
  }
  checkSelection();
  const candidate = Object.freeze({
    current:identity, proposed:next.source.sourceIdentity, geometryChanges:Object.freeze(geometryChanges),
    correctionsCompatible:sameSourceMap(identity, next.source.sourceIdentity), requiresAlignmentReview:previous.reviewRequired,
  });
  pending = {candidate, previous, next, checkSelection};
  return candidate;
}

/** Only the latest prepared candidate can be confirmed. Verify a flagged frame against Navigator first. */
export async function confirmSourceMapUpdate(candidate: SourceMapUpdateCandidate,
  options: {coordinateAlignmentVerified?: boolean} = {}): Promise<void> {
  if (!pending || pending.candidate !== candidate) throw new Error('Unknown or superseded reference update candidate.');
  const {previous, next, checkSelection} = pending;
  const app = useAppStore.getState();
  if (app.referenceUpdatePending) throw new Error('Reference update already in progress.');
  const name = candidate.current.metadata.mapId;
  const check = () => { checkSelection(); assertNavigatorIdle(name); };
  check();
  if (candidate.requiresAlignmentReview && options.coordinateAlignmentVerified !== true)
    throw new Error('Explicit verification of Navigator coordinate alignment is required.');
  const unchanged = candidate.correctionsCompatible && !candidate.geometryChanges.length;
  app.set({referenceUpdatePending:true});
  try {
    if (!unchanged || previous.reviewRequired) {
      const replacement = unchanged ? {...previous, reviewRequired:false} : next;
      const binding = configuredReferenceBinding(name);
      await activateReference(replacement, () => { check(); return true; }, false,
        () => referenceMapPersistence.save(binding, replacement, previous, check), true);
    }
    pending = undefined;
  } finally { app.set({referenceUpdatePending:false}); }
}
