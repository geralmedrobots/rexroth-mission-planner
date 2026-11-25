import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createMotionPlannerCalibrationBenchmarks } from '../domain/planning/MotionPlannerBenchmarks';
import type { PlanningInputs } from '../features/planning/PlanningCoordinator';
import type { PlannerResult, VdaOrder } from '../domain/types';

const state = vi.hoisted(() => ({ routeRevision: 7, set: vi.fn() }));
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => state } }));
const input = () => {
  const scenario = createMotionPlannerCalibrationBenchmarks()[0]!;
  return { scenario, inputs: { grid: scenario.grid, footprint: scenario.footprint,
    start: { ...scenario.startPose, mapId: scenario.grid.metadata.mapId, positionInitialized: true },
    goal: { ...scenario.goalPose, mapId: scenario.grid.metadata.mapId, positionInitialized: true }, plannerMode: 'motion-state', waypoints: [],
    plannerOptions: scenario.configuration.planner, routeRevision: 7, sessionId: 'test' } as PlanningInputs };
};
const result = (success: boolean): PlannerResult => ({ success, error: success ? undefined : 'Search failed',
  rawPath: [], simplifiedPath: [], finalPath: [], statistics: { durationMs: 1, visitedCells: 1,
    rawPointCount: 0, simplifiedPointCount: 0, finalPointCount: 0 } });
const order = { orderId: 'bound-order', orderUpdateId: 0, nodes: [], edges: [] } as unknown as VdaOrder;

describe('automatic recording lifecycle and save recovery', () => {
  beforeEach(() => { vi.resetModules(); state.set.mockClear(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ path: 'artifacts/stage5b/missions/saved.json' }),
  })); });
  afterEach(() => vi.unstubAllGlobals());
  it('waits for the bound order, ignores unrelated completion and writes only once', async () => {
    const { stage5BRecording } = await import('../services/Stage5BRecordingService');
    const { scenario, inputs } = input();
    stage5BRecording.start(inputs, scenario.configuration).result(result(true));
    stage5BRecording.order(order, 7, true);
    stage5BRecording.observe('different-order', 'success');
    expect(fetch).not.toHaveBeenCalled();
    stage5BRecording.observe(order.orderId, 'success', 'Completed', { orderId: order.orderId,
      lastNodeId: 'goal', lastNodeSequenceId: 2, errors: [], agvPosition: scenario.goalPose as never });
    stage5BRecording.observe(order.orderId, 'success');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(payload.recording.outcome).toBe('success');
    expect(payload.recording.execution).toEqual(expect.objectContaining({ status: 'success',
      orderId: order.orderId, lastNodeId: 'goal', lastNodeSequenceId: 2, navigatorErrors: [] }));
    expect(payload.recording.orders[0].order).toEqual(order);
    expect(payload.grid.data).toEqual(scenario.grid.data);
  });
  it('finalizes planner failures and retries exactly the retained artifact after save failure', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Bridge offline'));
    const { stage5BRecording } = await import('../services/Stage5BRecordingService');
    const { scenario, inputs } = input();
    stage5BRecording.start(inputs, scenario.configuration).result(result(false));
    await vi.waitFor(() => expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
      stage5BRecordingStatus: expect.stringContaining('save failed'),
    })));
    stage5BRecording.retry();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls[0]![1]!.body).toBe(vi.mocked(fetch).mock.calls[1]![1]!.body);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).capture.result.success).toBe(false);
  });
  it('finalizes cancellation only after the matching cancel action finishes', async () => {
    const { stage5BRecording } = await import('../services/Stage5BRecordingService');
    const { scenario, inputs } = input();
    stage5BRecording.start(inputs, scenario.configuration).result(result(true));
    stage5BRecording.order(order, 7, true);
    stage5BRecording.cancelRequested('cancel-1', order.orderId);
    stage5BRecording.observeActions({ actionStates: [{ actionId: 'cancel-1', actionStatus: 'RUNNING' }] });
    stage5BRecording.observeActions({ actionStates: [{ actionId: 'other', actionStatus: 'FINISHED' }] });
    expect(fetch).not.toHaveBeenCalled();
    stage5BRecording.observeActions({ actionStates: [{ actionId: 'cancel-1', actionStatus: 'FINISHED' }] });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).recording.outcome).toBe('cancelled');
  });
  it('cancels a discarded preview but keeps a published mission bound across route changes', async () => {
    const { stage5BRecording } = await import('../services/Stage5BRecordingService');
    const { scenario, inputs } = input();
    stage5BRecording.start(inputs, scenario.configuration).result(result(true));
    stage5BRecording.routeChanged(8);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).recording.outcome).toBe('cancelled');
    stage5BRecording.start(inputs, scenario.configuration).result(result(true));
    stage5BRecording.order(order, 7, true);
    stage5BRecording.routeChanged(8);
    expect(fetch).toHaveBeenCalledTimes(1);
    stage5BRecording.observe(order.orderId, 'failed', 'Rejected');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
