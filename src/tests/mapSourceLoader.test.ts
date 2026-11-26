import { readFile } from 'node:fs/promises';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { configuredReferenceBinding, referenceDispatchIssue } from '../features/map/referenceMapBinding';
import { prepareSourceMapUpdate, confirmSourceMapUpdate } from '../features/map/sourceMapUpdate';
import { loadStartupReference } from '../features/startup/useStartupConnections';
import { MqttService } from '../services/MqttService';
import { ReferenceMapPersistence, referenceMapPersistence } from '../features/map/ReferenceMapPersistence';
import { mapCorrectionPersistence } from '../features/map/MapCorrectionPersistence';
import { defaultFootprint, defaultPlannerOptions, defaultOrderSettings } from '../domain/defaults';
import { planSynchronously } from '../domain/planner/PlannerService';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator } from '../domain/vda5050/VdaOrderValidator';
import { LogService } from '../services/LogService';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sameSourceMap } from '../domain/map/MapSnapshots';
import { ObstacleInflation } from '../domain/planner/ObstacleInflation';
import { locatorMapService } from '../features/locator/services/locatorMapService';
import { useLocatorStore } from '../features/locator/stores/locatorStore';
import { activateSavedPlanningMap, beginMapLoad, loadImageMap, loadJsonMap, loadLocatorSource, replaceLegacyPlanningGrid } from '../features/map/mapSourceLoader';
import { useAppStore } from '../stores/appStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const json = (cellData = [0, -1]) => JSON.stringify({
  width: 2, height: 1, resolution: 0.1, origin: { x: -1, y: 2, yaw: 0.1 }, cellData,
});
const jsonFile = (text = json()) => Object.assign(new File([], 'map.json'), { text: async () => text });
const downloaded = (name: string, occupancyValue = 100) => {
  const origin = { x: 1, y: 2, yaw: 0.2 };
  const pngBytes = new Uint8Array([4, 5, 6]);
  return {
    occupancy: {
      metadata: { name, mapId: name, width: 2, height: 1, resolution: 0.05,
        origin, occupiedThreshold: 0.65, freeThreshold: 0.196, negate: false },
      data: [occupancyValue, -1],
    },
    raster: { mapName: name, pngBytes, imageUrl: `blob:${name}/${occupancyValue}`, origin,
      pixelWidth: 2, pixelHeight: 1, widthMeters: 0.1, heightMeters: 0.11,
      pixelsPerMeter: 20, metersPerPixel: 0.05 },
    image: new Blob([pngBytes], { type: 'image/png' }),
    info: { name, fingerprint: '7722289214529635123', level: 0, loaded: true, type: 0, warnings: [] },
    instance: { host: 'locator.example', port: 18082, https: true, rpcEndpoint: '/' },
  };
};

const revokeObjectURL = vi.fn();
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('URL', class extends URL {
    static revokeObjectURL = revokeObjectURL;
    static createObjectURL = () => 'blob:cached-reference';
  });
  revokeObjectURL.mockClear();
  localStorage.clear();
  useLocatorStore.getState().updateSettings(downloaded('fixture').instance);
  useAppStore.setState({ grid: undefined, inflatedGrid: undefined, sourceMap: undefined, planningMap: undefined,
    referenceUpdatePending:false, referenceReviewRequired:false, activeNavigatorMapId:null,
    lastKnownValidNavigatorMapId:null, state:undefined, sentOrder:undefined, publishingOrder:false });
  useLocatorStore.setState({ loadedMap: undefined, mapInfo: undefined, downloading: false, selectedMapName: '' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('map source initialization', () => {
  it('loads grid JSON into the existing planner grid and preserves inflation and route invalidation', async () => {
    const { routeRevision, plannerOptions } = useAppStore.getState();
    await loadJsonMap(jsonFile());
    const { sourceMap, planningMap, grid, inflatedGrid, routeRevision: loadedRevision } = useAppStore.getState();
    expect(sourceMap?.sourceIdentity.source).toEqual({ kind: 'import' });
    expect(sourceMap?.rawOccupancyGrid.data).toEqual([0, -1]);
    expect(grid).toBe(planningMap?.effectiveOccupancyGrid);
    expect(grid?.data).toEqual(sourceMap?.rawOccupancyGrid.data);
    const { planningSafetyMarginM, localizationMarginM } = plannerOptions.passageSafety;
    expect(inflatedGrid).toEqual(ObstacleInflation.byRadius(grid!, planningSafetyMarginM + localizationMarginM));
    expect(loadedRevision).toBe(routeRevision + 1);
  });

  it('loads the repository PGM and YAML fixture with its existing geometry and classification', async () => {
    const [pgm, yaml] = await Promise.all([
      readFile('examples/sample-map.pgm'), readFile('examples/sample-map.yaml', 'utf8'),
    ]);
    const file = Object.assign(new File([new Uint8Array(pgm)], 'sample-map.pgm'), {
      arrayBuffer: async () => Uint8Array.from(pgm).buffer,
    });
    await loadImageMap(file, yaml);
    const { sourceMap, grid } = useAppStore.getState();
    expect(grid?.metadata).toMatchObject({ mapId: 'sample-map', width: 20, height: 16,
      resolution: 0.1, origin: { x: -1, y: -0.8, yaw: 0 } });
    expect(grid?.data).toHaveLength(320);
    expect(grid?.data[0]).toBe(100);
    expect(grid?.data).toContain(0);
    expect(grid?.data).toEqual(sourceMap?.rawOccupancyGrid.data);
    expect(sourceMap?.originalRaster?.image).toBe(file);
  });

  it('keeps the source snapshot through existing click edits and restores the fixed reference on same-name reload', async () => {
    const activate = vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    vi.spyOn(locatorMapService, 'downloadSource')
      .mockResolvedValueOnce(downloaded('Map-A')).mockResolvedValueOnce(downloaded('Map-A', 0));
    const grid = (await loadLocatorSource('Map-A'))!;
    const original = useAppStore.getState().sourceMap!;
    replaceLegacyPlanningGrid({ ...grid, data: [50, -1] });
    expect(useAppStore.getState().planningMap?.revision).toBe(1);
    expect(useAppStore.getState().sourceMap).toBe(original);
    expect(original.rawOccupancyGrid.data).toEqual([100, -1]);
    expect(useAppStore.getState().grid?.data).toEqual([50, -1]);

    await loadLocatorSource('Map-A');
    const { sourceMap, planningMap, grid: fresh } = useAppStore.getState();
    expect(sameSourceMap(original.sourceIdentity, sourceMap!.sourceIdentity)).toBe(true);
    expect(planningMap?.revision).toBe(0);
    expect(fresh?.data).toEqual(sourceMap?.rawOccupancyGrid.data);
    expect(fresh?.data).toEqual([100, -1]);
    expect(locatorMapService.downloadSource).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('drops an older Locator response while a later selection is still downloading', async () => {
    const older = deferred<ReturnType<typeof downloaded>>();
    const newer = deferred<ReturnType<typeof downloaded>>();
    vi.spyOn(locatorMapService, 'downloadSource').mockImplementation((name) =>
      name === 'Older' ? older.promise : newer.promise);
    const activate = vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    const first = loadLocatorSource('Older');
    await vi.waitFor(()=>expect(locatorMapService.downloadSource).toHaveBeenCalledTimes(1));
    const second = loadLocatorSource('Newer');
    older.resolve(downloaded('Older'));
    expect(await first).toBeUndefined();
    expect(useLocatorStore.getState().downloading).toBe(true);
    expect(useLocatorStore.getState().selectedMapName).toBe('Newer');
    expect(useAppStore.getState().grid).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:Older/100');
    newer.resolve(downloaded('Newer', 0));
    expect((await second)?.data).toEqual([0, -1]);
    expect(useLocatorStore.getState().loadedMap?.mapName).toBe('Newer');
    expect(useLocatorStore.getState().downloading).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('keeps the current planning revision on startup only when the full source identity agrees', async () => {
    const activate = vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    const first = downloaded('Map-A');
    const duplicate = downloaded('Map-A');
    duplicate.raster.imageUrl = 'blob:duplicate';
    vi.spyOn(locatorMapService, 'downloadSource').mockResolvedValueOnce(first)
      .mockResolvedValueOnce(duplicate).mockResolvedValueOnce(downloaded('Map-A', 0));
    const grid = (await loadLocatorSource('Map-A'))!;
    replaceLegacyPlanningGrid({ ...grid, data: [50, -1] });
    const revision = useAppStore.getState().routeRevision;
    expect(await loadLocatorSource('Map-A', { skipUnchanged: true })).toBeUndefined();
    expect(useAppStore.getState().routeRevision).toBe(revision);
    expect(useAppStore.getState().grid?.data).toEqual([50, -1]);
    expect(await loadLocatorSource('Map-A', { skipUnchanged: true })).toBeUndefined();
    expect(locatorMapService.downloadSource).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('allows a newer import to win over an older load already hashing occupancy', async () => {
    const digest = deferred<ArrayBuffer>();
    vi.spyOn(webcrypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    vi.spyOn(locatorMapService, 'downloadSource').mockResolvedValue(downloaded('Older'));
    const activate = vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    const first = loadLocatorSource('Older');
    await vi.waitFor(()=>expect(webcrypto.subtle.digest).toHaveBeenCalledTimes(1));
    await loadJsonMap(jsonFile(json([5, 6])));
    digest.resolve(new ArrayBuffer(32));
    expect(await first).toBeUndefined();
    expect(useAppStore.getState().sourceMap?.sourceIdentity.source.kind).toBe('import');
    expect(useAppStore.getState().grid?.data).toEqual([5, 6]);
    expect(activate).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:Older/100');
  });

  it('drops an older local file read and skips a superseded deferred Locator request', async () => {
    const read = deferred<string>();
    const first = loadJsonMap(Object.assign(jsonFile(), { text: () => read.promise }));
    const reserved = beginMapLoad();
    await loadJsonMap(jsonFile(json([7, 8])));
    const download = vi.spyOn(locatorMapService, 'downloadSource');
    expect(await loadLocatorSource('Stale', { version: reserved })).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    read.resolve(json());
    await first;
    expect(useAppStore.getState().grid?.data).toEqual([7, 8]);
  });

  it('does not commit a cancelled startup download', async () => {
    const controller = new AbortController();
    const response = deferred<ReturnType<typeof downloaded>>();
    vi.spyOn(locatorMapService, 'downloadSource').mockReturnValue(response.promise);
    const load = loadLocatorSource('Startup', { signal: controller.signal });
    await vi.waitFor(()=>expect(locatorMapService.downloadSource).toHaveBeenCalledTimes(1));
    controller.abort();
    response.resolve(downloaded('Startup'));
    expect(await load).toBeUndefined();
    expect(useAppStore.getState().sourceMap).toBeUndefined();
    expect(useLocatorStore.getState().downloading).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:Startup/100');
  });
});

describe('saved planning map activation', () => {
  it('activates a new saved revision on startup recheck and manual Locator reload', async () => {
    vi.stubGlobal('navigator', { locks: { request: (_key: string, run: () => unknown) => run() } });
    vi.spyOn(locatorMapService, 'downloadSource').mockImplementation(async () => downloaded('Saved-Locator'));
    vi.spyOn(locatorMapService, 'activateRaster').mockImplementation(() => {});
    await loadLocatorSource('Saved-Locator', {skipUnchanged:true});
    const source = useAppStore.getState().sourceMap!;
    const {x,y} = new CoordinateTransformer(source.rawOccupancyGrid.metadata).gridToWorld(0,1);
    await mapCorrectionPersistence.saveCorrections(source, {sourceIdentity:source.sourceIdentity, corrections:[{
      id:'verified-cell',createdAt:'2026-11-25T12:00:00Z',kind:'force_free',
      area:{kind:'circle',center:{x,y},radiusM:.01},
    }]});
    expect((await loadLocatorSource('Saved-Locator', {skipUnchanged:true}))?.data).toEqual([100,0]);
    expect(useAppStore.getState().planningMap?.savedRevision).toBe(1);
    expect(await loadLocatorSource('Saved-Locator', {skipUnchanged:true})).toBeUndefined();
    expect((await loadLocatorSource('Saved-Locator'))?.data).toEqual([100,0]);
    expect(useAppStore.getState().sourceMap?.rawOccupancyGrid.data).toEqual([100,-1]);
  });

  it('plans, builds and validates against saved corrections after reload, then invalidates unsent routes on reset', async () => {
    vi.stubGlobal('navigator', { locks: { request: (_key: string, run: () => unknown) => run() } });
    const width = 40, height = 30;
    const cells = Array.from({length: width * height}, (_, i) => i % width === 20 ? -1 : 0);
    const file = jsonFile(JSON.stringify({width, height, origin: {x:0,y:0,yaw:0}, resolution:.1, cellData:cells}));
    await loadJsonMap(file);
    const original = useAppStore.getState().sourceMap!;
    const footprint = {...defaultFootprint, width:.05, length:.05, safetyMargin:0, inflationRadius:0};
    const plan = () => planSynchronously({grid:useAppStore.getState().grid!, start:{row:14,column:5},
      goal:{row:14,column:34}, options:defaultPlannerOptions, footprint, goalTheta:0});
    expect(plan().success).toBe(false);
    await mapCorrectionPersistence.saveCorrections(original, {sourceIdentity:original.sourceIdentity, corrections:[{
      id:'verified-passage',createdAt:'2026-11-25T12:00:00Z',kind:'force_free',
      area:{kind:'circle',center:{x:2.05,y:1.55},radiusM:.7},
    }]});
    expect(plan().success).toBe(false);
    await loadJsonMap(file);
    const active=useAppStore.getState();
    expect(active.planningMap?.savedRevision).toBe(1);
    const planned=plan();
    expect(planned.success).toBe(true);
    const mapId=active.grid!.metadata.mapId;
    const robotPose={...new CoordinateTransformer(active.grid!.metadata).gridToWorld(14,5),mapId,positionInitialized:true};
    const order=new VdaOrderBuilder().build(planned.finalPath,{robotPose,activeMapId:mapId,
      corridorPlanning:{grid:active.grid!,footprint,plannerOptions:defaultPlannerOptions}},defaultOrderSettings);
    const validation=new VdaOrderValidator().validate(order,{mqttConnected:true,stateReceived:true,connectionReceived:true,
      activeMapId:mapId,currentPose:robotPose,grid:active.grid!,footprint,settings:defaultOrderSettings,connectionOnline:true,
      operatingMode:'AUTOMATIC',stateAgeMs:0,visualizationAgeMs:0,positionInitialized:true,poseSource:'state',locatorMapName:mapId});
    expect(validation.errors).toEqual([]);
    expect(await activateSavedPlanningMap(active.sourceMap!)).toBe(active.grid);
    expect(useAppStore.getState().routeRevision).toBe(active.routeRevision);
    active.set({finalPath:planned.finalPath,plannedRouteRevision:active.routeRevision,generatedOrder:order,
      generatedOrderRouteRevision:active.routeRevision,sentOrder:order});
    await mapCorrectionPersistence.resetCorrections(active.sourceMap!);
    const observed:number[]=[];
    const unsubscribe=useAppStore.subscribe((state,old)=>{
      if(state.grid!==old.grid){
        expect(state.grid).toBe(state.planningMap?.effectiveOccupancyGrid);
        expect(state.inflatedGrid).toEqual(ObstacleInflation.byRadius(state.grid!,
          state.plannerOptions.passageSafety.planningSafetyMarginM+state.plannerOptions.passageSafety.localizationMarginM));
        expect(state.generatedOrder).toBeUndefined();
        expect(state.finalPath).toEqual([]);
        observed.push(state.routeRevision);
      }
    });
    try { await activateSavedPlanningMap(active.sourceMap!); } finally { unsubscribe(); }
    expect(observed).toEqual([active.routeRevision+1]);
    expect(plan().success).toBe(false);
    expect(useAppStore.getState().sentOrder).toBe(order);
    expect(original.rawOccupancyGrid.data).toEqual(cells);
    await mapCorrectionPersistence.restoreRevision(active.sourceMap!,1);
    await activateSavedPlanningMap(active.sourceMap!);
    expect(plan().success).toBe(true);
    expect(useAppStore.getState().planningMap?.savedRevision).toBe(3);
  });

  it('uses the original grid and reports unreadable saved history on Locator load',async()=>{
    vi.spyOn(mapCorrectionPersistence,'loadCorrections').mockRejectedValue(new Error('damaged history'));
    vi.spyOn(locatorMapService,'downloadSource').mockResolvedValue(downloaded('Map-A'));
    vi.spyOn(locatorMapService,'activateRaster').mockImplementation(()=>{});
    const log=vi.spyOn(LogService,'write');
    const grid=await loadLocatorSource('Map-A');
    expect(grid?.data).toEqual([100,-1]);
    expect(useAppStore.getState().planningMap?.revision).toBe(0);
    expect(log).toHaveBeenCalledWith('planner','error',expect.stringContaining('damaged history'));
  });

  it('discards a pending editor activation when a new source is selected',async()=>{
    await loadJsonMap(jsonFile());
    const old=useAppStore.getState().sourceMap!;
    const pending=deferred<Awaited<ReturnType<typeof mapCorrectionPersistence.loadCorrections>>>();
    vi.spyOn(mapCorrectionPersistence,'loadCorrections').mockReturnValueOnce(pending.promise);
    const activation=activateSavedPlanningMap(old);
    await loadJsonMap(jsonFile(json([5,6])));
    pending.resolve({collection:{sourceIdentity:old.sourceIdentity,corrections:[]},revision:4,createdAt:null});
    expect(await activation).toBeUndefined();
    expect(await activateSavedPlanningMap(old)).toBeUndefined();
    expect(useAppStore.getState().grid?.data).toEqual([5,6]);
  });
});


function idleNavigator(mapName: string) {
  const app = useAppStore.getState();
  app.set({
    activeNavigatorMapId:mapName, mqttConnected:true, state:{driving:false},
    connection:{connectionState:'ONLINE', headerId:0, manufacturer:'test', serialNumber:'1', version:'2.0.0', timestamp:''},
    mqttReceiveMetadata:{...app.mqttReceiveMetadata, lastStateReceiveTime:Date.now()},
  });
}

describe('persistent Locator reference lifecycle', () => {
  const name = 'Floor A';
  const backend = () => vi.spyOn(locatorMapService, 'downloadSource').mockImplementation(async n => downloaded(n));
  async function saveEdits() {
    vi.stubGlobal('navigator', {locks:{request:(_key:string, run:()=>unknown)=>run()}});
    const source = useAppStore.getState().sourceMap!;
    const transform = new CoordinateTransformer(source.sourceIdentity.metadata);
    const edits = (['erase','force_free','force_occupied'] as const).map((kind,index) => {
      const {x,y} = transform.gridToWorld(0,index);
      return {id:kind, kind, createdAt:'2026-11-26T10:00:00Z',
        area:{kind:'circle' as const, center:{x,y}, radiusM:.001}};
    });
    await mapCorrectionPersistence.saveCorrections(source, {sourceIdentity:source.sourceIdentity, corrections:edits});
    return source;
  }

  it('rebuilds the PNG, geometry, and all three occupancy edits offline after restart', async () => {
    const latest = downloaded(name);
    latest.raster.pixelWidth = latest.occupancy.metadata.width = 3;
    latest.occupancy.data = [100,-1,0];
    const download = backend().mockResolvedValueOnce(latest);
    await loadLocatorSource(name);
    const original = await saveEdits();
    const persisted = await new ReferenceMapPersistence().load(configuredReferenceBinding(name));
    expect(persisted?.info).toEqual(latest.info);
    expect(persisted?.source.sourceIdentity).toEqual(original.sourceIdentity);
    expect(persisted?.source.rawOccupancyGrid).toEqual(original.rawOccupancyGrid);
    useAppStore.setState({sourceMap:undefined, planningMap:undefined, grid:undefined, mqttConnected:false});
    useLocatorStore.setState({loadedMap:undefined, maps:[], mapInfo:undefined});
    expect((await loadStartupReference(new AbortController().signal))?.data).toEqual([0,0,100]);
    expect(useLocatorStore.getState().loadedMap).toMatchObject({...latest.raster, imageUrl:'blob:cached-reference'});
    const app = useAppStore.getState();
    expect(app.sourceMap?.rawOccupancyGrid.data).toEqual([100,-1,0]);
    expect(app.planningMap?.savedRevision).toBe(1);
    expect(referenceDispatchIssue()).toMatch(/Navigator map binding/);
    app.set({state:{orderId:'running',paused:true}});
    await loadLocatorSource(name,{skipUnchanged:true});
    expect(useAppStore.getState().routeRevision).toBe(app.routeRevision);
    expect(useAppStore.getState().state?.orderId).toBe('running');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('separates floors and Locator installations and rejects a different endpoint on download', async () => {
    const download = backend();
    await loadLocatorSource(name);
    await loadLocatorSource('Floor B');
    expect((await loadLocatorSource(name,{referenceOnly:true}))?.metadata.mapId).toBe(name);
    idleNavigator('Floor B');
    expect(referenceDispatchIssue()).toMatch(/binding/);
    idleNavigator(name);
    useLocatorStore.getState().updateSettings({port:443});
    expect(referenceDispatchIssue()).toMatch(/installation/);
    await expect(loadLocatorSource(name,{referenceOnly:true})).rejects.toThrow(/No saved reference/);
    await expect(loadLocatorSource(name)).rejects.toThrow(/binding/);
    expect(download).toHaveBeenCalledTimes(3);
    expect(await referenceMapPersistence.load(configuredReferenceBinding(name))).toBeUndefined();
  });

  it('keeps the current reference, saved edits and route on confirmation of identical content', async () => {
    backend();
    await loadLocatorSource(name);
    const original = await saveEdits();
    await activateSavedPlanningMap(original);
    idleNavigator(name);
    const before = useAppStore.getState();
    const candidate = await prepareSourceMapUpdate();
    expect(candidate).toMatchObject({correctionsCompatible:true,geometryChanges:[]});
    await confirmSourceMapUpdate(candidate);
    expect(useAppStore.getState().grid).toBe(before.grid);
    expect(useAppStore.getState().routeRevision).toBe(before.routeRevision);
    expect((await mapCorrectionPersistence.listRevisions(original)).length).toBe(2);
  });

  it('archives the previous reference and its edits even when only the fingerprint changes', async () => {
    const download = backend();
    await loadLocatorSource(name);
    const original = await saveEdits();
    await activateSavedPlanningMap(original);
    const revision = useAppStore.getState().routeRevision;
    const next = downloaded(name);
    next.info.fingerprint = '7722289214529635124';
    download.mockResolvedValueOnce(next);
    idleNavigator(name);
    const candidate = await prepareSourceMapUpdate();
    expect(candidate).toMatchObject({correctionsCompatible:false, geometryChanges:[]});
    expect(useAppStore.getState().grid?.data).toEqual([0,0]);
    expect(useAppStore.getState().routeRevision).toBe(revision);
    await confirmSourceMapUpdate(candidate);
    expect(useAppStore.getState().grid?.data).toEqual([100,-1]);
    expect(useAppStore.getState().routeRevision).toBe(revision+1);
    expect(useAppStore.getState().planningMap?.savedRevision).toBe(0);
    const archive = await new ReferenceMapPersistence().load(configuredReferenceBinding(name), original.sourceIdentity);
    expect(archive?.source.sourceIdentity).toEqual(original.sourceIdentity);
    expect((await mapCorrectionPersistence.loadCorrections(archive!.source)).revision).toBe(1);
    await expect(confirmSourceMapUpdate(candidate)).rejects.toThrow(/superseded/);
  });

  it('persists detected coordinate discrepancies through reload and requires alignment review', async () => {
    const download = backend();
    await loadLocatorSource(name);
    const next = downloaded(name);
    next.occupancy.metadata.origin.yaw += .2;
    next.info.level = 1;
    download.mockResolvedValue(next);
    idleNavigator(name);
    const candidate = await prepareSourceMapUpdate();
    expect(candidate.geometryChanges).toEqual([
      {field:'yaw',before:.2,after:.4},{field:'level',before:0,after:1},
    ]);
    expect(candidate.requiresAlignmentReview).toBe(true);
    expect(referenceDispatchIssue()).toMatch(/alignment/);
    const service = new MqttService(), send = vi.fn();
    Object.assign(service, {settings:{topics:{order:'test/order'}}, bridge:{readyState:WebSocket.OPEN, send}});
    await expect(service.publish('test/order','{}')).rejects.toThrow(/alignment/);
    expect(send).not.toHaveBeenCalled();
    await expect(confirmSourceMapUpdate(candidate)).rejects.toThrow(/alignment/);
    useAppStore.setState({referenceReviewRequired:false});
    await loadLocatorSource(name,{referenceOnly:true});
    expect(referenceDispatchIssue()).toMatch(/alignment/);
    await confirmSourceMapUpdate(await prepareSourceMapUpdate(),{coordinateAlignmentVerified:true});
    expect(referenceDispatchIssue()).toBeUndefined();
    expect(useAppStore.getState().grid?.metadata.origin.yaw).toBe(next.occupancy.metadata.origin.yaw);
  });

  it('blocks update confirmation for a different floor, offline robot, pending publication and active mission', async () => {
    const download = backend();
    await loadLocatorSource(name);
    const original = useAppStore.getState().sourceMap;
    download.mockResolvedValue(downloaded(name,0));
    const candidate = await prepareSourceMapUpdate();
    idleNavigator('Floor B');
    await expect(confirmSourceMapUpdate(candidate)).rejects.toThrow(/binding/);
    idleNavigator(name);
    useAppStore.setState({mqttConnected:false});
    await expect(confirmSourceMapUpdate(candidate)).rejects.toThrow(/Fresh online/);
    idleNavigator(name);
    useAppStore.setState({publishingOrder:true});
    await expect(confirmSourceMapUpdate(candidate)).rejects.toThrow(/mission/);
    useAppStore.setState({publishingOrder:false, state:{orderId:'in progress', edgeStates:[{}]}});
    await expect(confirmSourceMapUpdate(candidate)).rejects.toThrow(/mission/);
    expect(useAppStore.getState().sourceMap).toBe(original);
    expect((await referenceMapPersistence.load(configuredReferenceBinding(name)))?.source.sourceIdentity)
      .toEqual(original?.sourceIdentity);
  });

  it('keeps the old reference if a write fails or a new selection supersedes preparation', async () => {
    const download = backend();
    await loadLocatorSource(name);
    const original = useAppStore.getState().sourceMap;
    download.mockResolvedValueOnce(downloaded(name,0));
    idleNavigator(name);
    const candidate = await prepareSourceMapUpdate();
    vi.spyOn(referenceMapPersistence,'save').mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(confirmSourceMapUpdate(candidate)).rejects.toThrow(/quota/);
    expect(useAppStore.getState().sourceMap).toBe(original);
    expect((await referenceMapPersistence.load(configuredReferenceBinding(name)))?.source.sourceIdentity)
      .toEqual(original?.sourceIdentity);
    const response = deferred<ReturnType<typeof downloaded>>();
    download.mockReturnValueOnce(response.promise);
    const waiting = prepareSourceMapUpdate();
    await vi.waitFor(()=>expect(download).toHaveBeenCalledTimes(3));
    await loadLocatorSource('Floor B');
    response.resolve(downloaded(name,0));
    await expect(waiting).rejects.toThrow(/selection changed/);
    expect(useAppStore.getState().sourceMap?.sourceIdentity.metadata.mapId).toBe('Floor B');
  });

  it('aborts the storage transaction if Navigator starts a mission before the update commits', async () => {
    const download = backend();
    await loadLocatorSource(name);
    const original = useAppStore.getState().sourceMap!;
    idleNavigator(name);
    download.mockResolvedValueOnce(downloaded(name,0));
    const candidate = await prepareSourceMapUpdate();
    const save = referenceMapPersistence.save.bind(referenceMapPersistence);
    vi.spyOn(referenceMapPersistence, 'save').mockImplementationOnce((binding, record, expected, check) => {
      useAppStore.setState({state:{orderId:'external order',driving:true}});
      return save(binding, record, expected, check);
    });
    await expect(confirmSourceMapUpdate(candidate)).rejects.toThrow(/mission/);
    expect(useAppStore.getState().sourceMap).toBe(original);
    expect((await referenceMapPersistence.load(configuredReferenceBinding(name)))?.source.sourceIdentity)
      .toEqual(original.sourceIdentity);
    expect(useAppStore.getState().referenceUpdatePending).toBe(false);
  });

  it('reports corrupt reference data without overwriting it with a new download', async () => {
    const download = backend();
    await loadLocatorSource(name);
    await new Promise<void>((resolve,reject)=>{
      const open = indexedDB.open('med-robots-reference-maps');
      open.onsuccess = () => {
        const tx = open.result.transaction('active','readwrite');
        const cursor = tx.objectStore('active').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result!;
          const record = row.value;
          record.source.rawOccupancyGrid.data[0] = 0;
          row.update(record);
        };
        tx.oncomplete = () => {open.result.close(); resolve();};
        tx.onabort = () => reject(tx.error);
      };
    });
    await expect(loadLocatorSource(name)).rejects.toThrow(/integrity/);
    expect(useLocatorStore.getState().error).toMatch(/integrity/);
    expect(download).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().sourceMap?.rawOccupancyGrid.data).toEqual([100,-1]);
  });
});
