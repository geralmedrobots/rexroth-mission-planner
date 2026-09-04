import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticEvent, OperationalLogDiagnosticSink } from '../features/diagnostics/DiagnosticEvent';
import { MissionController } from '../features/mission/MissionController';
import { PlanningCoordinator, type PlanningInputs } from '../features/planning/PlanningCoordinator';
import { plannerDiagnostics } from '../workers/plannerDiagnostics';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { LogService } from '../services/LogService';
import type { OccupancyGrid, PlannerResult, RobotPose, VdaOrder } from '../domain/types';

const grid: OccupancyGrid = { metadata: { name: 'test', mapId: 'map', width: 8, height: 2, resolution: 1, origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 0.65, freeThreshold: 0.2, negate: false }, data: Array(16).fill(0) };
const pose = (x: number): RobotPose => ({ x, y: 0.5, theta: 0, mapId: 'map', positionInitialized: true });
const inputs = (): PlanningInputs => ({ grid, start: pose(0.5), goal: pose(6.5), waypoints: [], plannerMode: 'automatic', plannerOptions: structuredClone(defaultPlannerOptions), footprint: structuredClone(defaultFootprint), orderSettings: structuredClone(defaultOrderSettings), sessionId: 'session' });
const result = (success = true): PlannerResult => ({ success, rawPath: [pose(0.5), pose(6.5)], simplifiedPath: [pose(0.5), pose(6.5)], finalPath: [pose(0.5), pose(6.5)], statistics: { visitedCells: 2, durationMs: 1, rawPointCount: 2, simplifiedPointCount: 2, finalPointCount: 2 } });

describe('Stage 3G–3H controllers and diagnostics', () => {
  it('prepares requests from an immutable configuration snapshot', () => {
    const planner = { plan: vi.fn(async () => result()) };
    const coordinator = new PlanningCoordinator({ planner });
    const source = inputs();
    const requests = coordinator.prepareRequests(source);
    expect(Object.isFrozen(requests[0]!.planningConfiguration)).toBe(true);
    source.plannerOptions.passageSafety.wallProximityWeight = 999;
    expect(requests[0]!.options.passageSafety.wallProximityWeight).not.toBe(999);
  });

  it('invalidates a stale asynchronous plan', async () => {
    let resolve!: (value: PlannerResult) => void;
    const planner = { plan: vi.fn(() => new Promise<PlannerResult>((r) => { resolve = r; })) };
    const coordinator = new PlanningCoordinator({ planner });
    const pending = coordinator.plan(inputs()); coordinator.invalidate(); resolve(result());
    await expect(pending).resolves.toBeUndefined();
  });

  it('captures one immutable configuration for the complete async operation', async () => {
    let resolve!: (value: PlannerResult) => void;
    const planner = { plan: vi.fn(() => new Promise<PlannerResult>((r) => { resolve = r; })) };
    const coordinator = new PlanningCoordinator({ planner });
    const source = inputs();
    const pending = coordinator.plan(source);
    source.plannerOptions.passageSafety.wallProximityWeight = 777;
    resolve(result());
    const planned = await pending;
    expect(planned?.planningConfiguration.planner.passageSafety.wallProximityWeight).not.toBe(777);
    expect(planner.plan).toHaveBeenCalledTimes(1);
  });

  it('forwards worker diagnostics to the application sink', async () => {
    const diagnostics = vi.fn();
    const coordinator = new PlanningCoordinator({
      diagnostics: { emit: diagnostics },
      planner: { plan: vi.fn(async () => ({ ...result(), diagnosticEvents: [createDiagnosticEvent({
        sessionId: 'session', stage: 'planner', eventType: 'planner.completed', severity: 'info', message: 'done',
      })] })) },
    });
    await coordinator.plan(inputs());
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'planner.completed' }));
  });

  it('transports bounded worker diagnostics with correlation IDs', () => {
    const events = plannerDiagnostics({ ...coordinatorRequest(), diagnosticContext: { sessionId: 's', planningRequestId: 's:planning:1' } }, result());
    expect(events.map((event) => event.eventType)).toEqual(['planner.started', 'planner.completed', 'planner.cost']);
    expect(events.every((event) => event.planningRequestId === 's:planning:1')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('data');
  });

  it('adapts structured diagnostics to the existing operational log', () => {
    const write = vi.fn();
    new OperationalLogDiagnosticSink(write).emit(createDiagnosticEvent({ sessionId: 's', stage: 'vda', severity: 'error', eventType: 'vda.order.validated', message: 'invalid' }));
    expect(write).toHaveBeenCalledWith('validation', 'error', '[vda.order.validated] invalid');
  });

  it('invalidates pending orders when mission inputs change', () => {
    const mission = new MissionController();
    mission.createMission('s', 'm');
    mission.prepareOrder('s', { orderId: 'o', nodes: [], edges: [] } as unknown as VdaOrder);
    expect(mission.invalidatePendingOrder().orderId).toBeUndefined();
  });

  it('coordinates validation, publication, and Navigator lifecycle transitions', () => {
    const diagnostics = vi.fn();
    const mission = new MissionController({ emit: diagnostics });
    mission.createMission('s', 'm');
    mission.prepareOrder('s', { orderId: 'o', nodes: [], edges: [] } as unknown as VdaOrder);
    mission.markValidated('s', true);
    mission.markPublished('s');
    mission.observeNavigator('s', 'accepted');
    mission.observeNavigator('s', 'driving', { progressPercent: 50 });
    mission.observeNavigator('s', 'completed');
    expect(mission.snapshot.lifecycle).toBe('completed');
    expect(diagnostics.mock.calls.map(([event]) => event.eventType)).toEqual(expect.arrayContaining([
      'mission.configuration.snapshot', 'vda.order.built', 'vda.order.validated', 'vda.order.published',
      'navigator.order.accepted', 'navigator.execution.progress',
    ]));
  });

  it('does not dump OccupancyGrid cell data into ordinary Operational Log output', () => {
    const entries: string[] = [];
    const unsubscribe = LogService.subscribe((entry) => entries.push(entry.message));
    const largeGrid: OccupancyGrid = { ...grid, metadata: { ...grid.metadata, width: 100, height: 100 }, data: Array(10_000).fill(0) };
    new VdaOrderBuilder().build([pose(0.5), pose(6.5)], {
      robotPose: pose(0.5), activeMapId: 'map',
      corridorPlanning: { grid: largeGrid, footprint: defaultFootprint, plannerOptions: defaultPlannerOptions },
    }, defaultOrderSettings);
    unsubscribe();
    expect(entries.some((message) => message.includes('plannerGrid'))).toBe(false);
    expect(entries.some((message) => message.includes('data=0,0,0'))).toBe(false);
  });
});

const coordinatorRequest = () => ({ grid, collisionGrid: grid, start: { row: 0, column: 0 }, goal: { row: 0, column: 6 }, options: defaultPlannerOptions, footprint: defaultFootprint, diagnosticContext: undefined });
