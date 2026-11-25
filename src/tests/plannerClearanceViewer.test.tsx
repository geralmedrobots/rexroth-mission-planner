import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlannerClearanceDiagnostics, type ClearanceOverlay } from '../features/locator/components/PlannerClearanceDiagnostics';
import { DiagnosticPlannerRunner } from '../features/locator/services/diagnosticPlannerRunner';
import { useAppStore } from '../stores/appStore';
import { defaultFootprint, defaultPlannerOptions } from '../domain/defaults';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { planSynchronously } from '../domain/planner/PlannerService';
import type { OccupancyGrid, PlannerResult } from '../domain/types';

const original = useAppStore.getState();
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(original); });
function setup() {
  const grid: OccupancyGrid = { metadata: { name: 'door', mapId: 'door', width: 30, height: 20, resolution: .1,
    origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: .65, freeThreshold: .196, negate: false }, data: Array<number>(600).fill(0) };
  grid.data[10 * 30 + 7] = -1;
  const footprint = { ...defaultFootprint, length: .3, width: .4, safetyMargin: .05, inflationRadius: .91 };
  const plannerOptions = { ...structuredClone(defaultPlannerOptions),
    passageSafety: { ...defaultPlannerOptions.passageSafety, planningSafetyMarginM: .02, localizationMarginM: .03 } };
  useAppStore.setState({ grid, footprint, plannerOptions, plannerMode: 'automatic', goalThetaExplicit: false });
  const capturedStore = useAppStore.getState();
  const pickRef = { current: undefined as ((point: { x: number; y: number }) => void) | undefined };
  const onOverlay = vi.fn<(value: ClearanceOverlay | undefined) => void>();
  const transform = new CoordinateTransformer(grid.metadata);
  render(<PlannerClearanceDiagnostics grid={grid} pickRef={pickRef} onOverlay={onOverlay}/>);
  act(() => pickRef.current?.(transform.gridToWorld(10, 6)));
  act(() => pickRef.current?.(transform.gridToWorld(10, 24)));
  return { grid, pickRef, onOverlay, capturedStore, footprint, plannerOptions };
}

it('runs the existing planner on local doorway selections and shows the exact unknown-cell rejection without store writes', async () => {
  const plan = vi.spyOn(DiagnosticPlannerRunner.prototype, 'plan').mockImplementation(async request => planSynchronously(request));
  const { grid, onOverlay, capturedStore } = setup();
  expect(screen.getByText(/configured inflation radius 0.910 m/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Run diagnostic planner' }));
  await screen.findByText(/START_NOT_FREE:/);
  expect(screen.getAllByText(/unknown row 10, column 7/).length).toBeGreaterThan(0);
  const request = plan.mock.calls[0]![0];
  expect(request.collisionGrid).toEqual(grid);
  expect(request.footprint.inflationRadius).toBe(.91);
  expect(request.options.passageSafety.planningSafetyMarginM).toBe(.02);
  expect(onOverlay.mock.calls.at(-1)?.[0]?.evidence.some(item => item.obstacle === 'unknown')).toBe(true);
  fireEvent.change(screen.getByLabelText('Footprint heading °'), { target: { value: '90' } });
  expect(useAppStore.getState()).toBe(capturedStore);
});

it('cancels and discards an outdated worker result when saved settings change', async () => {
  let complete: ((result: PlannerResult) => void) | undefined;
  vi.spyOn(DiagnosticPlannerRunner.prototype, 'plan').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const cancel = vi.spyOn(DiagnosticPlannerRunner.prototype, 'cancel');
  const { plannerOptions } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Run diagnostic planner' }));
  expect(screen.getByText(/Running the existing planner/)).toBeInTheDocument();
  act(() => useAppStore.setState({ plannerOptions: { ...plannerOptions, maxPlanningTimeMs: 42 } }));
  await act(async () => complete?.({ success: false, error: 'STALE_RESULT', rawPath: [], simplifiedPath: [], finalPath: [],
    statistics: { durationMs: 1, visitedCells: 0, rawPointCount: 0, simplifiedPointCount: 0, finalPointCount: 0 } }));
  expect(screen.queryByText(/STALE_RESULT/)).not.toBeInTheDocument();
  expect(cancel).toHaveBeenCalled();
});

it('uses the operational worker entry point and terminates only the diagnostic worker on cancellation', async () => {
  const terminate = vi.fn(); const postMessage = vi.fn();
  const worker = vi.fn(function (url: URL) { void url; return { terminate, postMessage }; });
  vi.stubGlobal('Worker', worker);
  const { grid, footprint, plannerOptions } = setup();
  const runner = new DiagnosticPlannerRunner();
  const pending = runner.plan({ grid, footprint, options: plannerOptions, start: { row: 10, column: 6 }, goal: { row: 10, column: 24 } });
  expect(new URL(String(worker.mock.calls[0]?.[0])).pathname).toMatch(/workers\/planner.worker.ts$/);
  expect(postMessage).toHaveBeenCalledTimes(1);
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  runner.cancel(); await rejected;
  expect(terminate).toHaveBeenCalledTimes(1);
});
