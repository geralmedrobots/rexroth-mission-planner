import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocatorMapDiagnostics } from '../features/locator/components/LocatorMapDiagnostics';
import { useAppStore } from '../stores/appStore';
import { useLocatorStore } from '../features/locator/stores/locatorStore';
import { locatorMapService } from '../features/locator/services/locatorMapService';

const originalApp = useAppStore.getState();
const originalLocator = useLocatorStore.getState();
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(), fillRect: vi.fn(), save: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    drawImage: vi.fn(), strokeRect: vi.fn(), restore: vi.fn(), fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  useAppStore.setState(originalApp); useLocatorStore.setState(originalLocator);
});

it('opens a read-only comparison, toggles layers independently, zooms, pans and inspects cells', async () => {
  const origin = { x: -2, y: -3, yaw: 0 };
  const raster = { mapName: 'diagnostic-test', pngBytes: new Uint8Array(), imageUrl: 'blob:test',
    pixelWidth: 4, pixelHeight: 4, widthMeters: 2, heightMeters: 2,
    pixelsPerMeter: 2, metersPerPixel: 0.5, origin };
  const grid = { metadata: { name: raster.mapName, mapId: raster.mapName,
    width: 4, height: 4, resolution: 0.5, origin, occupiedThreshold: 0.65,
    freeThreshold: 0.196, negate: false }, data: [100, ...Array<number>(15).fill(0)] };
  const info = { name: raster.mapName, fingerprint: 'test-revision', level: 0, type: 0, loaded: true, warnings: [] };
  useAppStore.setState({ grid });
  useLocatorStore.setState({ loadedMap: raster, mapInfo: info });
  const download = vi.spyOn(locatorMapService, 'getDiagnosticPointCloud').mockResolvedValue({
    cloud: { mapName: raster.mapName, originalPointCount: 2, points: [
      { x: -1.75, y: -1.25, reflector: false }, { x: -1.75, y: -1.25, reflector: true },
    ] },
    raw: { responseCode: 0, pointCloudSize: 2, reflectors: [], zones: [],
      pointCloud: { contentEncoding: 'base64', contentMediaType: 'application/PointCloud2D', content: 'original' } },
    compatibility: { componentType: 2, componentVersion: '2.0.8', modules: [],
      serverMapModule: { name: 'ServerMap', majorVersion: 9, minorVersion: 0 } }, info,
  });
  render(<LocatorMapDiagnostics/>);
  fireEvent.click(screen.getByRole('button', { name: 'Compare map layers' }));
  await screen.findByText(/2 original points \(no downsampling\)/);
  expect(download).toHaveBeenCalledWith(raster, grid, 'test-revision');
  const png = screen.getByRole('checkbox', { name: 'Original Bosch PNG' });
  const points = screen.getByRole('checkbox', { name: 'All Bosch points (green)' });
  const cells = screen.getByRole('checkbox', { name: 'Occupied cells (red)' });
  fireEvent.click(png); expect(png).not.toBeChecked(); expect(points).toBeChecked(); expect(cells).toBeChecked();
  fireEvent.click(points); expect(points).not.toBeChecked(); expect(cells).toBeChecked();
  fireEvent.click(cells); expect(cells).not.toBeChecked();
  const canvas = screen.getByLabelText('Diagnostic PNG, point cloud and occupancy overlay');
  // Fit is 150 px/image pixel with a horizontal offset of 200, from the
  // viewer's deterministic initial 1000x600 size in this jsdom test.
  fireEvent.pointerDown(canvas, { clientX: 275, clientY: 75, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: 275, clientY: 75, pointerId: 1 });
  expect(screen.getByText(/row 0, column 0; occupancy 100; original points in cell 2/)).toBeInTheDocument();
  fireEvent.wheel(canvas, { clientX: 275, clientY: 75, deltaY: -500 });
  fireEvent.pointerDown(canvas, { clientX: 275, clientY: 75, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 375, clientY: 175, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: 375, clientY: 175, pointerId: 1 });
  fireEvent.pointerDown(canvas, { clientX: 375, clientY: 175, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: 375, clientY: 175, pointerId: 1 });
  await waitFor(() => expect(screen.getByText(/MAP \(-1.7500, -1.2500\)/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Fit map' }));
  expect(useAppStore.getState().grid).toBe(grid);
  expect(grid.data).toEqual([100, ...Array<number>(15).fill(0)]);
});
