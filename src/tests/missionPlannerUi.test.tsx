import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { betweenStops, newMission, savedStop, useMissionLibrary } from '../features/mission/missionLibrary';
import { MapCanvas } from '../components/MapCanvas';
import { createPlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import type { OccupancyGrid, PlannerResult, RobotPose, VdaState } from '../domain/types';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator } from '../domain/vda5050/VdaOrderValidator';
import { useDestinationStore } from '../features/destinations/destinationStore';
import { waypointPositionError } from '../features/destinations/waypointPosition';
import { useLocatorStore } from '../features/locator/stores/locatorStore';
import { PlanningCoordinator, type CoordinatedPlanningResult, type PlanningInputs } from '../features/planning/PlanningCoordinator';
import { useGlobalReplanningStore } from '../features/replanning/globalReplanningStore';
import { useOperatorSettingsStore } from '../features/settings/operatorSettingsStore';
import { useStartupStore } from '../features/startup/startupStore';
import { mqttService } from '../services/MqttService';
import { useAppStore } from '../stores/appStore';

vi.mock('../features/startup/useStartupConnections', () => ({ useStartupConnections: vi.fn() }));
vi.mock('../features/replanning/useGlobalReplanning', () => ({ useGlobalReplanning: vi.fn() }));
vi.mock('../hooks/useMqtt', () => ({ useMqtt: vi.fn() }));
configure({getElementError:message=>new Error(message??'Element unavailable')});

const appDefaults=useAppStore.getInitialState();
const grid:OccupancyGrid={
  metadata:{name:'Fixture',mapId:'fixture',width:40,height:40,resolution:.1,origin:{x:0,y:0,yaw:0},
    occupiedThreshold:.65,freeThreshold:.196,negate:false},
  data:new Array<number>(1600).fill(0),
};
const start:RobotPose={x:1.05,y:2.05,theta:0,mapId:'fixture',positionInitialized:true};
const goal:RobotPose={...start,x:2.05};
const configuration=createPlanningConfigurationSnapshot(appDefaults);
const planFixture:PlannerResult={success:true,rawPath:[start,goal],simplifiedPath:[start,goal],
  finalPath:[start,goal],statistics:{visitedCells:2,durationMs:1,rawPointCount:2,simplifiedPointCount:2,finalPointCount:2}};
const valid={valid:true,errors:[],warnings:[]};

function seedTelemetry() {
  useAppStore.setState({
    grid,start,goal,mqttConnected:true,activeNavigatorMapId:'fixture',stateMapId:'fixture',
    lastKnownValidNavigatorMapId:'fixture',lastConnectionReceiveTime:Date.now(),
    connection:{connectionState:'ONLINE'} as ReturnType<typeof useAppStore.getState>['connection'],
    mqttReceiveMetadata:{...appDefaults.mqttReceiveMetadata,lastStateReceiveTime:Date.now()},
    state:{agvPosition:start,operatingMode:'AUTOMATIC',safetyState:{eStop:'NONE',fieldViolation:false},
      driving:false,paused:false} as VdaState,
  });
  useLocatorStore.setState({
    loadedMap:{mapName:'fixture'} as ReturnType<typeof useLocatorStore.getState>['loadedMap'],
  });
}

function seedValidatedRoute() {
  seedTelemetry();
  const current=useAppStore.getState();
  const order=new VdaOrderBuilder().build([start,goal],{robotPose:start,activeMapId:'fixture'},current.orderSettings);
  current.commitPlannedRoute(current.routeRevision,{
    start,rawPath:[start,goal],finalPath:[start,goal],plannerResult:planFixture,planningConfiguration:configuration,
  });
  current.commitGeneratedOrder(current.routeRevision,order,valid,[]);
  return order;
}

function viewport(tablet:boolean) {
  vi.stubGlobal('matchMedia',vi.fn(()=>({
    matches:tablet,addEventListener:vi.fn(),removeEventListener:vi.fn(),
  })));
}

const button=(name:string)=>screen.getByRole('button',{name});

beforeEach(()=>{
  localStorage.clear();
  useMissionLibrary.setState({templates:[],history:[]});
  useDestinationStore.setState({destinations:[]});
  useAppStore.setState(appDefaults,true);
  useLocatorStore.setState(useLocatorStore.getInitialState(),true);
  useGlobalReplanningStore.setState(useGlobalReplanningStore.getInitialState(),true);
  useOperatorSettingsStore.setState(useOperatorSettingsStore.getInitialState(),true);
  useStartupStore.setState({...useStartupStore.getInitialState(),dismissed:true},true);
  viewport(false);
  vi.spyOn(mqttService,'publish').mockResolvedValue();
});

afterEach(()=>{
  cleanup();
  Reflect.deleteProperty(navigator,'clipboard');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('structured missions',()=>{
  function loadMission(wardX=2.95) {
    seedTelemetry();
    useAppStore.setState({plannerMode:'manual',orderSettings:{...appDefaults.orderSettings,stateStaleTimeoutMs:60000}});
    const point=useDestinationStore.getState().add({displayName:'Pharmacy',mapId:'fixture',x:2.05,y:2.05,theta:0,
      enabled:true,icon:'pharmacy',category:'pharmacy'});
    const template={...newMission('fixture'),name:'Ward delivery',stops:[savedStop(point),{id:'ward',label:'Ward',x:wardX,y:2.05}]};
    useMissionLibrary.getState().save(template);
    render(<App/>);fireEvent.click(button('Missions'));fireEvent.click(button('Library'));fireEvent.click(button('Load / edit'));
    return {point,template};
  }
  async function validate() {
    fireEvent.click(button('Validate mission'));
    await waitFor(()=>expect(screen.getByText('Preview validated')).toBeVisible());
  }
  it('invalidates a prepared mission and its pending authorization on a moved or deleted waypoint',async()=>{
    const {point}=loadMission();await validate();
    fireEvent.click(button('Authorize destination 1'));
    act(()=>useDestinationStore.getState().update(point.id,{x:2.15}));
    fireEvent.click(button('Send Mission'));
    expect(mqttService.publish).not.toHaveBeenCalled();
    await waitFor(()=>expect(button('Authorize destination 1')).toBeDisabled());
    await validate();
    act(()=>useDestinationStore.getState().remove(point.id));
    fireEvent.click(button('Validate mission'));
    expect(await screen.findByText(/Destination 1 .*missing/)).toBeVisible();
    expect(button('Authorize destination 1')).toBeDisabled();
  },15000);
  it('blocks the whole mission if a later destination is unreachable and identifies its ordinal',async()=>{
    loadMission(6.95);
    const wall={metadata:{...grid.metadata,width:100},data:Array.from({length:4000},(_,i)=>i%100===50?100:0)};
    act(()=>useAppStore.setState({grid:wall}));
    fireEvent.click(button('Validate mission'));
    expect(await screen.findByText(/Leg 2 to Ward/)).toBeVisible();
    expect(button('Authorize destination 1')).toBeDisabled();
    expect(mqttService.publish).not.toHaveBeenCalled();
  });
  it('sends each stop only after independent live validation and confirmation, then records completion',async()=>{
    loadMission();await validate();fireEvent.click(button('Authorize destination 1'));fireEvent.click(button('Send Mission'));
    await waitFor(()=>expect(mqttService.publish).toHaveBeenCalledTimes(1));
    const arrive=()=>{
      const app=useAppStore.getState(),order=app.sentOrder!,node=order.nodes.at(-1)!;
      act(()=>useAppStore.setState({mqttReceiveMetadata:{...app.mqttReceiveMetadata,lastStateReceiveTime:Date.now()},
        state:{...app.state,orderId:order.orderId,lastNodeSequenceId:node.sequenceId,driving:false,nodeStates:[],edgeStates:[],
          agvPosition:{...start,...node.nodePosition,theta:node.nodePosition.theta??0}}}));
    };
    arrive();
    await waitFor(()=>expect(useMissionLibrary.getState().history[0]?.status).toBe(betweenStops));
    expect(mqttService.publish).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole('button',{name:'Prepare next destination'}));expect(button('Authorize destination 2')).toBeDisabled();
    await validate();fireEvent.click(button('Authorize destination 2'));fireEvent.click(button('Send Mission'));
    await waitFor(()=>expect(mqttService.publish).toHaveBeenCalledTimes(2));
    arrive();
    await waitFor(()=>expect(useMissionLibrary.getState().history[0]).toMatchObject({status:'Completed',completed:2,ended:expect.any(Number)}));
    expect(useMissionLibrary.getState().history).toHaveLength(1);
  },20000);
  it('records an operator cancellation only after matching Navigator action evidence',async()=>{
    loadMission();await validate();fireEvent.click(button('Authorize destination 1'));fireEvent.click(button('Send Mission'));
    fireEvent.click(await screen.findByRole('button',{name:'Cancel active order'}));
    fireEvent.click(button('Cancel Mission'));
    await waitFor(()=>expect(mqttService.publish).toHaveBeenCalledTimes(2));
    const recorded=useMissionLibrary.getState().history[0]!;
    expect(recorded.cancelActionId).toBeTruthy();expect(recorded.ended).toBeUndefined();
    act(()=>{const app=useAppStore.getState();useAppStore.setState({state:{...app.state,orderId:recorded.orderId,
      actionStates:[{actionId:recorded.cancelActionId,actionStatus:'FINISHED'}]}});});
    await waitFor(()=>expect(useMissionLibrary.getState().history[0]?.status).toBe('Cancelled'));
    expect(screen.queryByRole('button',{name:'Prepare next destination'})).toBeNull();
  },15000);
  it('does not cancel a different Navigator order that appears while confirmation is open',async()=>{
    loadMission();await validate();fireEvent.click(button('Authorize destination 1'));fireEvent.click(button('Send Mission'));
    fireEvent.click(await screen.findByRole('button',{name:'Cancel active order'}));
    act(()=>{const app=useAppStore.getState();useAppStore.setState({state:{...app.state,orderId:'another-order',driving:true}});});
    fireEvent.click(button('Cancel Mission'));
    expect(await screen.findByText('Submitted order changed. Review cancellation again.')).toBeVisible();
    expect(mqttService.publish).toHaveBeenCalledTimes(1);
  },15000);
  it('adds saved destinations by ID and suppresses quick dispatch during mission map picking',()=>{
    const {point}=loadMission();
    useOperatorSettingsStore.getState().update({directDispatchMode:true});
    fireEvent.mouseDown(screen.getByRole('combobox',{name:'Saved waypoint'}));
    fireEvent.click(screen.getByRole('option',{name:'Pharmacy'}));
    fireEvent.click(button('Save template'));
    expect(useMissionLibrary.getState().templates[0]?.stops.at(-1)?.waypointId).toBe(point.id);
    const original=useAppStore.getState().goal;
    const rect={x:0,y:0,left:0,top:0,width:400,height:400,right:400,bottom:400,toJSON:()=>({})};
    vi.spyOn(HTMLCanvasElement.prototype,'getBoundingClientRect').mockReturnValue(rect);
    fireEvent.click(screen.getByLabelText('Planning map'),{clientX:215,clientY:205});
    fireEvent.click(button('Add from map'));fireEvent.click(screen.getByLabelText('Planning map'),{clientX:225,clientY:205});
    expect(screen.getByText(/Map point \(2\.25/)).toBeVisible();
    expect(useAppStore.getState().goal).toBe(original);expect(mqttService.publish).not.toHaveBeenCalled();
  });
  it('keeps an interrupted handoff unresolved after reconnect and never advances automatically',async()=>{
    loadMission();await validate();fireEvent.click(button('Authorize destination 1'));fireEvent.click(button('Send Mission'));
    await waitFor(()=>expect(mqttService.publish).toHaveBeenCalledTimes(1));
    act(()=>useAppStore.setState({mqttConnected:false}));
    act(()=>useAppStore.setState({mqttConnected:true}));
    expect(useMissionLibrary.getState().history[0]?.status).toBe('Outcome unknown');
    expect(screen.queryByRole('button',{name:'Prepare next destination'})).toBeNull();
    expect(mqttService.publish).toHaveBeenCalledTimes(1);
  },15000);
  it('edits, reorders, searches, duplicates and deletes without executing or losing saved originals',async()=>{
    const {template}=loadMission();
    fireEvent.click(button('Move destination 2 up'));fireEvent.click(button('Remove destination 2'));
    fireEvent.change(screen.getByLabelText('Mission name'),{target:{value:'Ward supply'}});
    fireEvent.change(screen.getByLabelText('Description (optional)'),{target:{value:'Night shift'}});
    fireEvent.click(button('Save template'));
    expect(useMissionLibrary.getState().templates[0]).toMatchObject({id:template.id,name:'Ward supply',description:'Night shift',stops:[{id:'ward'}]});
    fireEvent.click(button('Library'));fireEvent.click(button('Duplicate'));
    fireEvent.change(screen.getByLabelText('Search missions'),{target:{value:'(copy)'}});
    fireEvent.click(button('Delete'));fireEvent.click(button('Keep'));
    expect(useMissionLibrary.getState().templates).toHaveLength(2);
    fireEvent.click(await screen.findByRole('button',{name:'Delete'}));fireEvent.click(button('Delete template'));
    expect(useMissionLibrary.getState().templates).toHaveLength(1);
    await act(async()=>{await useMissionLibrary.persist.rehydrate();});
    expect(useMissionLibrary.getState().templates[0]?.id).toBe(template.id);
    expect(mqttService.publish).not.toHaveBeenCalled();
  },15000);
});

describe('named waypoints',()=>{
  const pharmacy={displayName:'Pharmacy',mapId:'fixture',x:2.05,y:2.05,theta:0,category:'pharmacy' as const,enabled:true,icon:'pharmacy'};
  it('persists the existing quick destination schema and enforces map-local names on add and rename',async()=>{
    const store=useDestinationStore.getState();
    const p=store.add(pharmacy);
    expect(()=>store.add({...pharmacy,displayName:'  PHARMACY '})).toThrow(/already/);
    const ward=store.add({...pharmacy,displayName:'Ward'});
    expect(()=>store.update(ward.id,{displayName:'pharmacy'})).toThrow(/already/);
    store.add({...pharmacy,mapId:'other'});
    store.update(p.id,{description:'East wing',x:2.55,thetaExplicit:false});
    await useDestinationStore.persist.rehydrate();
    expect(useDestinationStore.getState().destinations.find(item=>item.id===p.id)).toMatchObject({description:'East wing',x:2.55,thetaExplicit:false});
    expect(useDestinationStore.getState().destinations).toHaveLength(3);
  });
  it('checks current occupancy, clearance, world bounds, heading and map before saving',()=>{
    const blocked={...grid,data:grid.data.map(()=>100)};
    expect(waypointPositionError(pharmacy,grid)).toBeUndefined();
    expect(waypointPositionError(pharmacy,grid,blocked)).toMatch(/occupied/);
    expect(waypointPositionError({...pharmacy,x:-2},grid)).toMatch(/outside/);
    expect(waypointPositionError({...pharmacy,theta:NaN},grid)).toMatch(/finite/);
    expect(waypointPositionError({...pharmacy,mapId:'other'},grid)).toMatch(/matching/);
  });
  it('creates, finds, renames, repositions, selects and deletes a saved waypoint without publication',async()=>{
    useAppStore.setState({grid});
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,width:400,height:400,right:400,bottom:400,toJSON:()=>({})});
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
    render(<App/>);
    const map=screen.getByLabelText('Planning map');
    fireEvent.click(button('Create Waypoint'));fireEvent.click(map,{clientX:205,clientY:205});
    fireEvent.change(screen.getByLabelText(/Waypoint name/),{target:{value:'Ward A'}});
    fireEvent.change(screen.getByLabelText('Description (optional)'),{target:{value:'East wing'}});
    fireEvent.click(button('Save waypoint'));
    expect(useAppStore.getState().goal).toBeUndefined();
    fireEvent.click(button('Waypoints'));
    fireEvent.change(screen.getByLabelText('Search waypoints'),{target:{value:'unknown'}});
    expect(screen.getByText('No matching waypoints.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Search waypoints'),{target:{value:'ward'}});
    fireEvent.click(button('Edit'));fireEvent.change(screen.getByLabelText(/Waypoint name/),{target:{value:'Ward B'}});
    fireEvent.click(button('Save waypoint'));fireEvent.click(button('Waypoints'));fireEvent.click(button('Reposition'));
    fireEvent.click(map,{clientX:255,clientY:205});fireEvent.click(button('Save waypoint'));
    expect(useDestinationStore.getState().destinations[0]?.x).toBeCloseTo(2.55);
    expect(useDestinationStore.getState().destinations[0]).toMatchObject({displayName:'Ward B',thetaExplicit:false});
    fireEvent.click(button('Waypoints'));fireEvent.click(button('Use as destination'));
    expect(useAppStore.getState().goal?.x).toBeCloseTo(2.55);
    expect(button('Start Mission')).toBeDisabled();
    fireEvent.click(button('Waypoints'));fireEvent.click(button('Delete'));fireEvent.click(button('Confirm delete'));
    expect(useDestinationStore.getState().destinations).toHaveLength(0);
    expect(mqttService.publish).not.toHaveBeenCalled();
  },15000);
  it('centers a named point at the current zoom and toggles the named marker layer',()=>{
    useAppStore.setState({grid});
    const point=useDestinationStore.getState().add(pharmacy);
    const other=useDestinationStore.getState().add({...pharmacy,mapId:'other',displayName:'Other map'});
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,width:400,height:400,right:400,bottom:400,toJSON:()=>({})});
    const ctx={save:vi.fn(),restore:vi.fn(),scale:vi.fn(),translate:vi.fn(),rotate:vi.fn(),fillRect:vi.fn(),
      beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fill:vi.fn(),arc:vi.fn(),strokeText:vi.fn(),fillText:vi.fn()};
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const onCell=vi.fn();
    const view=render(<MapCanvas mode="inspect" onCell={onCell}/>);
    expect(ctx.fillText).toHaveBeenCalledWith(point.displayName,9,-5);
    expect(ctx.fillText).not.toHaveBeenCalledWith(other.displayName,9,-5);
    fireEvent.click(screen.getByText('Map layers'));
    ctx.fillText.mockClear();fireEvent.click(screen.getByRole('switch',{name:'Waypoint markers'}));
    expect(ctx.fillText).not.toHaveBeenCalledWith(point.displayName,9,-5);
    fireEvent.click(button('Zoom in'));fireEvent.click(button('Rotate view'));
    expect(useAppStore.getState().viewRotation).toBeCloseTo(Math.PI/2);
    view.rerender(<MapCanvas mode="inspect" onCell={onCell} focusedPoint={point}/>);
    fireEvent.click(screen.getByLabelText('Planning map'),{clientX:200,clientY:200});
    expect(onCell).toHaveBeenCalledWith({column:20,row:19});
    expect(screen.getByText('120%')).toBeVisible();
  });
  it('requires explicit execution for a prepared quick destination even with direct dispatch enabled',async()=>{
    seedTelemetry();
    useDestinationStore.getState().add(pharmacy);
    useOperatorSettingsStore.getState().update({directDispatchMode:true});
    vi.spyOn(PlanningCoordinator.prototype,'plan').mockImplementation(async input=>({...planFixture,planningConfiguration:configuration,routeRevision:input.routeRevision}));
    vi.spyOn(VdaOrderValidator.prototype,'validate').mockReturnValue(valid);
    render(<App/>);
    fireEvent.click(button('Pharmacy'));
    await waitFor(()=>expect(button('Start Mission')).toBeEnabled());
    expect(screen.queryByText(/Direct dispatch in/)).toBeNull();
    expect(mqttService.publish).not.toHaveBeenCalled();
  });
});

describe('workspace and feedback',()=>{
  it('keeps map controls outside the mission panel and opens navigation targets',()=>{
    viewport(true);
    render(<App/>);
    const map=screen.getByRole('main');
    expect(screen.queryByRole('complementary',{name:'Mission panel'})).toBeNull();
    fireEvent.click(button('Mission panel'));
    expect(screen.getByRole('complementary',{name:'Mission panel'})).toBeVisible();
    expect(within(map).getByRole('group',{name:'Map controls'})).toBeVisible();
    expect(within(map).getByRole('group',{name:'Map layers'})).toBeVisible();
    fireEvent.click(button('MQTT'));
    expect(screen.getByRole('tab',{name:'Network'})).toHaveAttribute('aria-selected','true');
    fireEvent.click(button('Order'));
    expect(screen.getByRole('tab',{name:'Generated Order'})).toHaveAttribute('aria-selected','true');
    fireEvent.click(button('Logs'));
    expect(screen.getByRole('tab',{name:'Operational Log'})).toHaveAttribute('aria-selected','true');
    fireEvent.click(button('Robot State'));
    expect(screen.getByText('Planning start x / y')).toBeVisible();
    fireEvent.click(button('Planner'));
    expect(map).toHaveFocus();
    expect(within(map).getByRole('button',{name:'Fit map'})).toBeVisible();
  });

  it('keeps zoom, drag and waypoint hit testing working, and clears stale pointer coordinates',()=>{
    useAppStore.setState({grid});
    const onCell=vi.fn();
    const hostRect={x:0,y:0,left:0,top:0,width:400,height:400,right:400,bottom:400,toJSON:()=>({})};
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(hostRect);
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
    render(<MapCanvas mode="waypoint" onCell={onCell}/>);
    const canvas=screen.getByLabelText('Planning map');
    fireEvent.click(canvas,{clientX:205,clientY:205});
    expect(onCell).toHaveBeenLastCalledWith({column:20,row:20});
    fireEvent.contextMenu(canvas,{clientX:205,clientY:205});
    expect(screen.getByText('Grid 20, 20')).toBeVisible();
    expect(screen.getByText(/World 2\.050/)).toBeVisible();
    fireEvent.mouseLeave(canvas);
    expect(screen.getByText('World —')).toBeVisible();
    fireEvent.mouseDown(canvas,{clientX:200,clientY:200});
    fireEvent.mouseMove(canvas,{clientX:220,clientY:200});
    fireEvent.mouseUp(canvas);
    fireEvent.click(canvas,{clientX:220,clientY:200});
    expect(onCell).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(canvas,{clientX:205,clientY:205});
    fireEvent.mouseUp(canvas);
    fireEvent.click(canvas,{clientX:205,clientY:205});
    expect(onCell).toHaveBeenLastCalledWith({column:18,row:20});
    fireEvent.wheel(canvas,{deltaY:-1});
    expect(screen.getByText('115%')).toBeVisible();
    for(let i=0;i<15;i++)fireEvent.click(button('Zoom in'));
    expect(screen.getByText('800%')).toBeVisible();
    fireEvent.click(button('Fit map'));
    expect(screen.getByText('100%')).toBeVisible();
  });

  it('draws VDA node markers from the generated order even when the path differs',()=>{
    seedValidatedRoute();
    useAppStore.setState({finalPath:[]});
    const rect={x:0,y:0,left:0,top:0,width:400,height:400,right:400,bottom:400,toJSON:()=>({})};
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(rect);
    const context={
      save:vi.fn(),restore:vi.fn(),scale:vi.fn(),translate:vi.fn(),rotate:vi.fn(),fillRect:vi.fn(),
      beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fill:vi.fn(),
      arc:vi.fn(),fillText:vi.fn(),closePath:vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    render(<MapCanvas mode="goal" onCell={vi.fn()}/>);
    fireEvent.click(screen.getByText('Map layers'));
    fireEvent.click(screen.getByRole('switch',{name:'VDA nodes'}));
    expect(context.fillText).toHaveBeenCalledWith('0',expect.any(Number),expect.any(Number));
    expect(context.fillText).toHaveBeenCalledWith('1',expect.any(Number),expect.any(Number));
  });

  it('reports offline telemetry honestly and disables actions with missing prerequisites',()=>{
    useAppStore.setState({goal});
    render(<App/>);
    expect(screen.getByText('Robot disconnected')).toBeVisible();
    expect(screen.getByText('Telemetry unavailable')).toBeVisible();
    fireEvent.click(screen.getByText('Route and telemetry details'));
    expect(screen.getByText('Unavailable',{exact:true})).toBeVisible();
    expect(button('Recalculate')).toBeDisabled();
    expect(button('Save point')).toBeDisabled();
    expect(button('Cancel Mission')).toBeDisabled();
    fireEvent.click(button('Advanced mission data'));
    expect(button('Retry save')).toBeDisabled();
    expect(button('Finalize success')).toBeDisabled();
    expect(mqttService.publish).not.toHaveBeenCalled();
  });

  it('scopes Escape to the active modal or workspace instead of clearing the route behind Settings',async()=>{
    seedValidatedRoute();
    render(<App/>);
    fireEvent.click(screen.getAllByRole('button',{name:'Settings'})[0]!);
    const settings=screen.getByRole('dialog');
    fireEvent.keyDown(settings,{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAppStore.getState().goal).toEqual(goal);
    fireEvent.keyDown(screen.getByRole('main'),{key:'Escape'});
    expect(screen.getByText('Clear destination?')).toBeVisible();
    fireEvent.click(button('Back'));
    expect(useAppStore.getState().goal).toEqual(goal);
  });

  it('filters and follows only operational logs and reports clipboard failures',async()=>{
    Object.defineProperty(navigator,'clipboard',{configurable:true,
      value:{writeText:vi.fn().mockRejectedValue(new Error('denied'))}});
    render(<App/>);
    fireEvent.click(button('Logs'));
    const search=screen.getByPlaceholderText('Search diagnostics');
    expect(search).toBeVisible();
    const first={id:'1',timestamp:'time',category:'system',level:'info',message:'first line'} as const;
    act(()=>useAppStore.getState().addLog(first));
    const viewport=screen.getByText(/first line/).parentElement!;
    Object.defineProperty(viewport,'scrollHeight',{value:280,configurable:true});
    act(()=>useAppStore.getState().addLog({...first,id:'2',message:'second line'}));
    expect(viewport.scrollTop).toBe(280);
    fireEvent.click(screen.getByRole('switch',{name:'Pause auto-scroll'}));
    viewport.scrollTop=10;
    act(()=>useAppStore.getState().addLog({...first,id:'3',message:'third line'}));
    expect(viewport.scrollTop).toBe(10);
    fireEvent.click(screen.getByRole('tab',{name:'Validation'}));
    expect(screen.queryByPlaceholderText('Search diagnostics')).toBeNull();
    expect(screen.queryByRole('button',{name:'Clear operational log'})).toBeNull();
    fireEvent.click(button('Copy'));
    expect(await screen.findByText(/Could not copy diagnostics/)).toBeVisible();
  });

  it('shows staged YAML, permits clearing it, and reports invalid map files',async()=>{
    render(<App/>);
    fireEvent.click(screen.getByText('Map setup'));
    const yaml=screen.getByLabelText('YAML file');
    fireEvent.change(yaml,{target:{files:[{name:'map.yaml',text:async()=> 'resolution: 0.05\norigin: [0, 0, 0]'}]}});
    expect(await screen.findByText('Staged metadata: map.yaml')).toBeVisible();
    fireEvent.click(button('Clear staged YAML'));
    expect(screen.queryByText('Staged metadata: map.yaml')).toBeNull();
    fireEvent.change(screen.getByLabelText('Grid JSON file'),{target:{files:[{name:'bad.json',text:async()=> '{}'}]}});
    expect(await screen.findByText(/Map import failed/)).toBeVisible();
    expect(useAppStore.getState().grid).toBeUndefined();
  });

  it('shows applied appearance preferences and labels unavailable preferences',()=>{
    render(<App/>);
    fireEvent.click(screen.getAllByRole('button',{name:'Settings'})[0]!);
    const settings=within(screen.getByRole('dialog'));
    fireEvent.click(settings.getByText('Compact mode',{exact:true}));
    fireEvent.click(settings.getByText('Reduce motion',{exact:true}));
    fireEvent.change(settings.getByRole('spinbutton',{name:'Map contrast'}),{target:{value:'1.5'}});
    const shell=document.querySelector('.mr-app-shell')!;
    expect(shell).toHaveAttribute('data-compact','true');
    expect(shell).toHaveAttribute('data-reduce-motion','true');
    expect(useOperatorSettingsStore.getState().settings.mapContrast).toBe(1.5);
    expect(settings.getByRole('switch',{name:/Preview before dispatch/})).toBeDisabled();
    expect(settings.getByRole('spinbutton',{name:'Destination validation radius m'})).toBeDisabled();
  },20_000);

  it('reports malformed settings imports without resetting the current robot session',async()=>{
    seedTelemetry();
    render(<App/>);
    fireEvent.click(screen.getAllByRole('button',{name:'Settings'})[0]!);
    const input=screen.getByLabelText('Settings JSON file');
    fireEvent.change(input,{target:{files:[{name:'invalid.json',text:async()=> '{"mqttSettings":{"port":"invalid"}}'}]}});
    expect(await screen.findByText(/Settings import failed.*mqttSettings.port/)).toBeVisible();
    expect(useAppStore.getState().state?.agvPosition).toEqual(start);
    expect(useAppStore.getState().mqttSettings.port).toBe(appDefaults.mqttSettings.port);
  });
});

describe('route revisions and operator authorization',()=>{
  it('moves from ready to pending when order parameters or the Navigator map change',()=>{
    seedValidatedRoute();
    render(<App/>);
    expect(button('Start Mission')).toBeEnabled();
    expect(screen.getByRole('heading',{name:'Ready to start'})).toBeVisible();
    act(()=>{
      const live=useAppStore.getState();
      live.set({orderSettings:{...live.orderSettings,missionMaximumSpeedMps:.08}});
    });
    expect(useAppStore.getState().validation).toBeUndefined();
    expect(screen.getByRole('heading',{name:'Validation pending'})).toBeVisible();
    expect(button('Start Mission')).toBeDisabled();
    act(()=>{
      const order=seedValidatedRoute();
      useAppStore.getState().setActiveMapResolution({mapId:'other-map',source:'state'});
      expect(useAppStore.getState().generatedOrder).not.toBe(order);
    });
    expect(useAppStore.getState().validation).toBeUndefined();
    expect(button('Start Mission')).toBeDisabled();
  });

  it('ignores an earlier planner rejection after input changes and a newer calculation begins',async()=>{
    seedTelemetry();
    const results:Array<{input:PlanningInputs;resolve:(value:CoordinatedPlanningResult)=>void;reject:(error:Error)=>void}>=[];
    vi.spyOn(PlanningCoordinator.prototype,'plan').mockImplementation(input=>new Promise((resolve,reject)=>{
      results.push({input,resolve,reject});
    }));
    render(<App/>);
    fireEvent.click(button('Recalculate'));
    expect(screen.getByRole('heading',{name:'Calculating route'})).toBeVisible();
    act(()=>useAppStore.getState().set({goal:{...goal,x:2.25}}));
    fireEvent.click(button('Recalculate'));
    await act(async()=>results[0]!.reject(new Error('obsolete planner request')));
    expect(screen.queryByText(/obsolete planner request/)).toBeNull();
    expect(screen.getByRole('heading',{name:'Calculating route'})).toBeVisible();
    await act(async()=>{
      const next=results[1]!;
      next.resolve({...planFixture,finalPath:[start,next.input.goal],planningConfiguration:configuration,
        routeRevision:next.input.routeRevision});
    });
    expect(useAppStore.getState().finalPath.at(-1)?.x).toBe(2.25);
    expect(screen.getByRole('heading',{name:'Validation pending'})).toBeVisible();
    expect(mqttService.publish).not.toHaveBeenCalled();
  });

  it('distinguishes current rejection from a validator exception',()=>{
    seedValidatedRoute();
    useAppStore.getState().set({validation:{valid:false,warnings:[],errors:[
      {code:'example',severity:'error',message:'Invalid route fixture'},
    ]}});
    render(<App/>);
    expect(screen.getByRole('heading',{name:'Route invalid'})).toBeVisible();
    const preview=within(screen.getByRole('region',{name:'Route preview'}));
    expect(preview.getByText('Invalid route fixture')).toBeVisible();
    act(()=>useAppStore.getState().set({validation:valid}));
    vi.spyOn(VdaOrderValidator.prototype,'validate').mockImplementation(()=>{
      throw new Error('Validation service failed');
    });
    fireEvent.click(button('Start Mission'));
    expect(screen.getByRole('heading',{name:'Validation failed'})).toBeVisible();
    expect(preview.getByText('Validation service failed')).toBeVisible();
    expect(button('Start Mission')).toBeDisabled();
    expect(mqttService.publish).not.toHaveBeenCalled();
  });

  it('rechecks live validation after confirmation and does not publish a stale order',async()=>{
    seedValidatedRoute();
    render(<App/>);
    fireEvent.click(button('Start Mission'));
    expect(screen.getByText('Start mission?')).toBeVisible();
    act(()=>useAppStore.getState().set({goal:{...goal,x:2.35}}));
    fireEvent.click(button('Send Mission'));
    expect(await screen.findByText(/selected route changed/)).toBeVisible();
    expect(mqttService.publish).not.toHaveBeenCalled();
    await waitFor(()=>expect(button('Start Mission')).toBeDisabled());
  });

  it('preserves a newer route when a clear confirmation was opened for the previous revision',async()=>{
    seedValidatedRoute();
    render(<App/>);
    fireEvent.click(button('Clear Destination'));
    const next={...goal,x:2.35};
    act(()=>useAppStore.getState().set({goal:next}));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Clear Destination'}));
    expect(await screen.findByText(/Confirm Clear Destination again/)).toBeVisible();
    expect(useAppStore.getState().goal).toEqual(next);
  });

  it('reports when an instant-action publish fails',async()=>{
    const order=seedValidatedRoute();
    useAppStore.getState().set({sentOrder:order});
    vi.mocked(mqttService.publish).mockRejectedValueOnce(new Error('Fixture bridge disconnected'));
    render(<App/>);
    fireEvent.click(button('Cancel Mission'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Cancel Mission'}));
    expect(await screen.findByText(/Unable to send the action.*Fixture bridge disconnected/)).toBeVisible();
  });

  it('removes an invalidated direct-dispatch countdown without ever publishing',async()=>{
    seedTelemetry();
    useOperatorSettingsStore.getState().update({directDispatchMode:true,dispatchCountdownSeconds:1});
    vi.spyOn(PlanningCoordinator.prototype,'plan').mockImplementation(async input=>({
      ...planFixture,finalPath:[start,input.goal],planningConfiguration:configuration,routeRevision:input.routeRevision,
    }));
    vi.spyOn(VdaOrderValidator.prototype,'validate').mockReturnValue(valid);
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
    const rect={x:0,y:0,left:0,top:0,width:400,height:400,right:400,bottom:400,toJSON:()=>({})};
    vi.spyOn(HTMLCanvasElement.prototype,'getBoundingClientRect').mockReturnValue(rect);
    render(<App/>);
    fireEvent.click(screen.getByLabelText('Planning map'),{clientX:205,clientY:195});
    expect(await screen.findByText(/Direct dispatch in/)).toBeVisible();
    fireEvent.click(button('Clear path'));
    expect(screen.queryByText(/Direct dispatch in/)).toBeNull();
    expect(button('Start Mission')).toBeDisabled();
    await act(async()=>new Promise(resolve=>setTimeout(resolve,1050)));
    expect(mqttService.publish).not.toHaveBeenCalled();
  });

  it('clears only a completed route belonging to the submitted order',()=>{
    const order=seedValidatedRoute();
    useOperatorSettingsStore.getState().update({autoClearCompletedMission:true});
    render(<App/>);
    act(()=>{
      const current=useAppStore.getState();
      current.set({sentOrder:order,state:{...current.state!,orderId:order.orderId,
        lastNodeSequenceId:order.nodes.at(-1)!.sequenceId}});
    });
    expect(useAppStore.getState().goal).toBeUndefined();
    expect(useAppStore.getState().sentOrder).toEqual(order);
  });

  it('requires a single replanning confirmation in Settings and leaves it off on Back',async()=>{
    render(<App/>);
    fireEvent.click(screen.getAllByRole('button',{name:'Settings'})[0]!);
    const settingsSwitch=screen.getByLabelText('Enable automatic replanning');
    fireEvent.click(settingsSwitch);
    fireEvent.click(settingsSwitch);
    expect(screen.getAllByText('Enable automatic global replanning?')).toHaveLength(1);
    expect(useGlobalReplanningStore.getState().settings.enabled).toBe(false);
    fireEvent.click(screen.getByText('Back',{exact:true}));
    await waitFor(()=>expect(settingsSwitch).toBeEnabled());
    expect(settingsSwitch).not.toBeChecked();
    expect(useGlobalReplanningStore.getState().settings.enabled).toBe(false);
    expect(mqttService.publish).not.toHaveBeenCalled();
  },20_000);

  it('confirms and reports arming from the dedicated panel and disarms without another prompt',async()=>{
    render(<App/>);
    fireEvent.click(button('Global Replanning'));
    const replanSwitch=within(screen.getByRole('dialog')).getByRole('switch',{name:'Enable automatic replanning'});
    fireEvent.click(replanSwitch);
    fireEvent.click(button('Enable Automatic Replanning'));
    expect(await screen.findByText(/Automatic replanning enabled/)).toBeVisible();
    expect(useGlobalReplanningStore.getState().runtime.status).toBe('MONITORING');
    expect(replanSwitch).toBeEnabled();
    expect(replanSwitch).toBeChecked();
    fireEvent.click(replanSwitch);
    expect(useGlobalReplanningStore.getState().settings.enabled).toBe(false);
    expect(await screen.findByText('Automatic replanning disabled.')).toBeVisible();
    expect(useGlobalReplanningStore.getState().runtime.status).toBe('DISABLED');
    await waitFor(()=>expect(screen.queryByText('Enable automatic global replanning?')).toBeNull());
    expect(mqttService.publish).not.toHaveBeenCalled();
  },20_000);
});
