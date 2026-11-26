import {afterEach,describe,expect,it,vi} from 'vitest';
import {betweenStops,missionStorageIssue,newMission,observeRun,useMissionLibrary,type MissionRun} from '../features/mission/missionLibrary';
import type {MissionProgress} from '../domain/order/MissionMonitor';

const run=():MissionRun=>({id:'delivery',template:{...newMission('floor'),name:'Delivery',
  stops:[{id:'a',label:'Ward',x:1,y:2},{id:'b',label:'Lab',x:3,y:4}]},index:0,completed:0,progress:0,
  orderId:'order',started:100,status:'Accepted',errors:[]});
const progress=(status:MissionProgress['status']):MissionProgress=>({status,accepted:true,completedNodes:new Set(),progressPercent:0,rejectionErrors:[]});
afterEach(()=>{useMissionLibrary.setState({templates:[],history:[]});localStorage.clear();});
describe('mission tracking evidence',()=>{
  it('records first observed driving time, with no completion time for an intermediate stop',()=>{
    const driving=observeRun(run(),progress('Driving'),[],200);
    expect(driving.drivingObserved).toBe(200);
    expect(observeRun(driving,progress('Completed'),[],300)).toMatchObject({status:betweenStops,completed:1,ended:undefined});
  });
  it('correlates cancellation to the submitted action and distinguishes failure from completion',()=>{
    const submitted={...run(),cancelActionId:'cancel-1',cancelReason:'Operator requested cancellation.'};
    expect(observeRun(submitted,progress('Accepted'),[{actionId:'other',actionStatus:'FINISHED'}],400).status).toBe('Cancellation requested');
    expect(observeRun(submitted,progress('Accepted'),[{actionId:'cancel-1',actionStatus:'FINISHED'}],400)).toMatchObject({status:'Cancelled',completed:0,ended:400});
    expect(observeRun(submitted,progress('Completed'),[],400).status).toBe('Outcome unknown');
    expect(observeRun(submitted,progress('Accepted'),[{actionId:'cancel-1',actionStatus:'FAILED'}],400).status).toBe('Outcome unknown');
  });
  it('keeps rejection evidence and does not treat acceptance timeout as a completion',()=>{
    const event={...progress('Rejected'),rejectionErrors:[{errorType:'orderError',errorLevel:'FATAL',errorDescription:'Unreachable'}]};
    expect(observeRun(run(),event,[],300)).toMatchObject({status:'Rejected',errors:['Unreachable'],completed:0});
    expect(observeRun(run(),progress('Timed out'),[],300)).toMatchObject({status:'Timed out',ended:undefined,completed:0});
  });
  it('keeps handoff evidence in memory if profile storage is full',()=>{
    const failure=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota');});
    try{
      const active=run();
      useMissionLibrary.getState().record(active);
      expect(useMissionLibrary.getState().history[0]?.orderId).toBe(active.orderId);
      expect(missionStorageIssue()).toMatch(/only in this session/);
    }finally{failure.mockRestore();}
  });
  it('restores templates and terminal history and never resumes an interrupted run on restart',async()=>{
    const active=run(),lib=useMissionLibrary.getState();
    lib.save(active.template);lib.record(active);lib.record({...active,id:'past',ended:500,status:'Completed'});
    const snapshot=localStorage.getItem('med-robots-missions-v1')!;
    useMissionLibrary.setState({templates:[],history:[]});
    localStorage.setItem('med-robots-missions-v1',snapshot);
    await useMissionLibrary.persist.rehydrate();
    const restored=useMissionLibrary.getState();
    expect(restored.templates[0]?.mapId).toBe('floor');
    expect(restored.history.find(r=>r.id==='delivery')?.status).toBe('Outcome unknown');
    expect(restored.history.find(r=>r.id==='past')?.ended).toBe(500);
  });
});
