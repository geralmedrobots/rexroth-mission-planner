import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticEvent, OperationalLogDiagnosticSink } from '../features/diagnostics/DiagnosticEvent';
import { MissionController } from '../features/mission/MissionController';
import { PlanningCoordinator, type PlanningInputs } from '../features/planning/PlanningCoordinator';
import { plannerDiagnostics } from '../workers/plannerDiagnostics';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
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
});

const coordinatorRequest = () => ({ grid, collisionGrid: grid, start: { row: 0, column: 0 }, goal: { row: 0, column: 6 }, options: defaultPlannerOptions, footprint: defaultFootprint, diagnosticContext: undefined });
