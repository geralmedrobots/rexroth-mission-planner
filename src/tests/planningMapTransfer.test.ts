import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceMapSnapshot } from '../domain/map/MapSnapshots';
import { useAppStore } from '../stores/appStore';
import { useLocatorStore } from '../features/locator/stores/locatorStore';
import { configuredReferenceBinding } from '../features/map/referenceMapBinding';
import { referenceMapPersistence } from '../features/map/ReferenceMapPersistence';
import { mapCorrectionPersistence } from '../features/map/MapCorrectionPersistence';
import { exportPlanningMap } from '../features/map/PlanningMapExport';
import { confirmPlanningMapImport, preparePlanningMapImport } from '../features/map/PlanningMapImport';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', {locks:{request:(_key:string, run:()=>unknown) => run()}});
  vi.stubGlobal('URL', class extends URL {static createObjectURL = () => 'blob:test'; static revokeObjectURL = () => {}});
  localStorage.clear();
  useAppStore.setState({sourceMap:undefined, planningMap:undefined, grid:undefined,
    referenceUpdatePending:false, referenceReviewRequired:false, state:undefined, sentOrder:undefined});
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

async function exportFixture() {
  const binding = configuredReferenceBinding('floor');
  const bytes = new Uint8Array(24);
  bytes.set([137,80,78,71,13,10,26,10]);
  new DataView(bytes.buffer).setUint32(16,2);
  new DataView(bytes.buffer).setUint32(20,1);
  const metadata = {name:'floor',mapId:'floor',width:2,height:1,resolution:1,
    origin:{x:0,y:0,yaw:0},occupiedThreshold:.65,freeThreshold:.196,negate:false};
  const source = await createSourceMapSnapshot({metadata,data:[100,-1]},
    {kind:'locator',instance:binding.instance,fingerprint:'12345678901234567890'},
    {image:new Blob([bytes],{type:'image/png'}),pixelWidth:2,pixelHeight:1,reportedWidthM:2,reportedHeightM:1});
  const record = {schemaVersion:1 as const,createdAt:new Date().toISOString(),source,reviewRequired:false,
    info:{name:'floor',level:0,loaded:true,type:0,fingerprint:'12345678901234567890',warnings:[]}};
  await referenceMapPersistence.save(binding,record,undefined,()=>{});
  useAppStore.setState({sourceMap:source});
  const kinds = ['erase','force_free','force_occupied','restore'] as const;
  const corrections = kinds.map((kind,index)=>({id:kind,kind,createdAt:'2026-01-01T00:00:00Z',
    area:{kind:'circle' as const,center:{x:index % 2 + .5,y:.5},radiusM:.2}}));
  await mapCorrectionPersistence.saveCorrections(source,{sourceIdentity:source.sourceIdentity,corrections});
  await mapCorrectionPersistence.saveCorrections(source,{sourceIdentity:source.sourceIdentity,corrections:[
    ...corrections,{id:'wall',kind:'wall',createdAt:'2026-01-01T00:00:00Z',
      from:{x:0,y:.5},to:{x:1,y:.5},thicknessM:.1},
  ]});
  return {source, file:(await exportPlanningMap()).file, binding};
}

describe('portable planning maps',()=>{
  it('restores all operations and revisions in an empty profile',async()=>{
    const {source,file,binding} = await exportFixture();
    const original = [...source.rawOccupancyGrid.data];
    localStorage.clear();
    vi.stubGlobal('indexedDB',new IDBFactory());
    useAppStore.setState({sourceMap:undefined,planningMap:undefined,grid:undefined});
    const candidate = await preparePlanningMapImport(file);
    expect(candidate.revision).toBe(2);
    await confirmPlanningMapImport(candidate);
    const restored = await referenceMapPersistence.load(binding);
    expect(restored?.source.rawOccupancyGrid.data).toEqual(original);
    expect(restored?.reviewRequired).toBe(true);
    expect((await mapCorrectionPersistence.listRevisions(restored!.source))[2]?.corrections.map(c=>c.kind))
      .toEqual(['erase','force_free','force_occupied','restore','wall']);
    expect(useAppStore.getState().grid?.data).toEqual(candidate.grid.data);
    expect(source.rawOccupancyGrid.data).toEqual(original);
  });

  it('rejects corruption, existing references and active missions',async()=>{
    const {file} = await exportFixture();
    const data = JSON.parse(await file.text());
    data.content += ' ';
    await expect(preparePlanningMapImport(new Blob([JSON.stringify(data)]))).rejects.toThrow(/checksum/);
    const candidate = await preparePlanningMapImport(file);
    await expect(confirmPlanningMapImport(candidate)).rejects.toThrow(/already exists/);
    useAppStore.setState({state:{orderId:'active',driving:true}});
    await expect(confirmPlanningMapImport(candidate)).rejects.toThrow(/mission/);
    expect(useLocatorStore.getState().settings.host).toBeTruthy();
  });

  it('removes staged correction history if reference storage fails',async()=>{
    const {file,binding,source} = await exportFixture();
    localStorage.clear();
    vi.stubGlobal('indexedDB',new IDBFactory());
    useAppStore.setState({sourceMap:undefined,planningMap:undefined,grid:undefined});
    const candidate = await preparePlanningMapImport(file);
    vi.spyOn(referenceMapPersistence,'save').mockRejectedValueOnce(new Error('storage failed'));
    await expect(confirmPlanningMapImport(candidate)).rejects.toThrow(/storage failed/);
    expect((await mapCorrectionPersistence.listRevisions(source))).toHaveLength(1);
    expect(await referenceMapPersistence.load(binding)).toBeUndefined();
    expect(useAppStore.getState().grid).toBeUndefined();
  });
});
