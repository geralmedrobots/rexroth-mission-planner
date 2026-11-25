import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Dialog, DialogContent, DialogTitle, FormControlLabel, Stack, Typography } from '@mui/material';
import { useAppStore } from '../../../stores/appStore';
import { useLocatorStore } from '../stores/locatorStore';
import { locatorMapService } from '../services/locatorMapService';
import { compareMapLayers } from '../services/mapDiagnostics';
import { LocatorCoordinateTransformer } from '../services/locatorCoordinateTransformer';
import type { OccupancyGrid } from '../../../domain/types';
import type { LocatorRasterMap } from '../types';
import { PlannerClearanceDiagnostics, type ClearanceOverlay } from './PlannerClearanceDiagnostics';
import { drawClearanceOverlay } from './drawClearanceOverlay';

type Snapshot = Awaited<ReturnType<typeof locatorMapService.getDiagnosticPointCloud>>;

export function LocatorMapDiagnostics() {
  const raster = useLocatorStore(s => s.loadedMap);
  const info = useLocatorStore(s => s.mapInfo);
  const grid = useAppStore(s => s.grid);
  if (!raster || !grid || !info || grid.metadata.mapId !== raster.mapName) return null;
  return <DiagnosticViewer key={`${raster.imageUrl}:${info.fingerprint}`} raster={raster} grid={grid} fingerprint={info.fingerprint}/>;
}

function DiagnosticViewer({ raster, grid, fingerprint }: { raster: LocatorRasterMap; grid: OccupancyGrid; fingerprint: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [layers, setLayers] = useState({ png: true, points: true, cells: true, differences: true });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ width: 1000, height: 600 });
  const [image, setImage] = useState<HTMLImageElement>();
  const [inspection, setInspection] = useState<{ x: number; y: number }>();
  const [clearanceMode, setClearanceMode] = useState(false);
  const [clearanceOverlay, setClearanceOverlay] = useState<ClearanceOverlay>();
  const clearancePick = useRef<((point: { x: number; y: number }) => void) | undefined>(undefined);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  // The grid is never modified. A replacement invalidates any comparison.
  useEffect(() => { generation.current++; setSnapshot(undefined); setBusy(false); }, [grid]);
  const checked = useMemo(() => {
    try { return { comparison: snapshot ? compareMapLayers(raster, grid, snapshot.cloud) : undefined, error: '' }; }
    catch (e) { return { comparison: undefined, error: String(e) }; }
  }, [raster, grid, snapshot]);
  const comparison = checked.comparison;
  const transform = useMemo(() => new LocatorCoordinateTransformer(raster), [raster]);
  const base = Math.min(size.width / raster.pixelWidth, size.height / raster.pixelHeight);
  const scale = base * view.zoom;
  const ox = (size.width - raster.pixelWidth * scale) / 2 + view.x;
  const oy = (size.height - raster.pixelHeight * scale) / 2 + view.y;

  async function load() {
    const request = ++generation.current;
    setOpen(true); setBusy(true); setError(''); setSnapshot(undefined);
    try {
      const result = await locatorMapService.getDiagnosticPointCloud(raster, grid, fingerprint);
      if (request === generation.current) setSnapshot(result);
    } catch (e) { if (request === generation.current) setError(String(e)); }
    finally { if (request === generation.current) setBusy(false); }
  }
  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.onerror = () => setError('Unable to decode the existing Bosch PNG. Reload the map.');
    img.src = raster.imageUrl;
    return () => { img.onload = null; img.onerror = null; };
  }, [raster]);
  useEffect(() => {
    if (!open || !canvas.current) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    const element = canvas.current;
    if (!open || !element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const dx = event.clientX - rect.left - size.width / 2;
      const dy = event.clientY - rect.top - size.height / 2;
      setView(v => {
        const zoom = Math.max(0.25, Math.min(100, v.zoom * Math.exp(-event.deltaY * 0.001)));
        const ratio = zoom / v.zoom;
        return { zoom, x: dx - (dx - v.x) * ratio, y: dy - (dy - v.y) * ratio };
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [open, size]);
  useEffect(() => {
    const element = canvas.current;
    if (!open || !element) return;
    const dpr = window.devicePixelRatio || 1;
    element.width = Math.round(size.width * dpr); element.height = Math.round(size.height * dpr);
    const ctx = element.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#20252b'; ctx.fillRect(0, 0, size.width, size.height);
    ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = false;
    if (layers.png && image) ctx.drawImage(image, 0, 0, raster.pixelWidth, raster.pixelHeight);
    if (comparison) {
      if (layers.cells) {
        ctx.fillStyle = 'rgba(255,0,0,0.42)';
        for (const i of comparison.occupied) ctx.fillRect(i % raster.pixelWidth, Math.floor(i / raster.pixelWidth), 1, 1);
      }
      if (layers.differences) {
        ctx.strokeStyle = '#ffca28'; ctx.lineWidth = 1.5 / scale;
        for (const i of comparison.unsupported) ctx.strokeRect(i % raster.pixelWidth, Math.floor(i / raster.pixelWidth), 1, 1);
      }
      if (layers.points) {
        ctx.fillStyle = '#00ff62';
        const radius = 0.8 / scale;
        // Every original finite point is drawn at its continuous coordinate.
        // Nonfinite entries remain in the snapshot and are reported below.
        for (let i = 0; i < comparison.pixels.length; i += 2) {
          const x = comparison.pixels[i]!; const y = comparison.pixels[i + 1]!;
          if (Number.isFinite(x) && Number.isFinite(y)) ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
        }
      }
    }
    if (clearanceMode && clearanceOverlay) drawClearanceOverlay(ctx, grid, transform, clearanceOverlay, scale);
    ctx.strokeStyle = '#9ba6b3'; ctx.lineWidth = 1 / scale; ctx.strokeRect(0, 0, raster.pixelWidth, raster.pixelHeight);
    if (inspection) {
      ctx.strokeStyle = '#00d9ff'; ctx.lineWidth = 2 / scale;
      ctx.strokeRect(Math.floor(inspection.x), Math.floor(inspection.y), 1, 1);
    }
    ctx.restore();
    const barPixels = 100;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(20, size.height - 28, barPixels, 2);
    ctx.font = '12px sans-serif'; ctx.fillText(`${(barPixels / scale * raster.metersPerPixel).toFixed(3)} m`, 20, size.height - 35);
  }, [open, size, image, comparison, raster, layers, scale, ox, oy, inspection, clearanceMode, clearanceOverlay, grid, transform]);

  const column = inspection ? Math.floor(inspection.x) : -1;
  const row = inspection ? Math.floor(inspection.y) : -1;
  const inBounds = column >= 0 && row >= 0 && column < raster.pixelWidth && row < raster.pixelHeight;
  const cellIndex = row * raster.pixelWidth + column;
  const world = inspection ? transform.imagePixelToWorld(inspection.x, inspection.y) : undefined;
  return <>
    <Button size="small" onClick={() => void load()} disabled={busy}>Compare map layers</Button>
    <Dialog fullScreen open={open} onClose={() => setOpen(false)}>
      <DialogTitle>Locator map diagnostics — {raster.mapName}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
          {(['png', 'points', 'cells', 'differences'] as const).map(key => <FormControlLabel key={key}
            control={<Checkbox checked={layers[key]} onChange={(_, checked) => setLayers(v => ({ ...v, [key]: checked }))}/>}
            label={{ png: 'Original Bosch PNG', points: 'All Bosch points (green)', cells: 'Occupied cells (red)', differences: 'Cells without points (yellow outline)' }[key]}/>)}
          <Button onClick={() => setView(v => ({ ...v, zoom: Math.min(100, v.zoom * 1.5) }))}>Zoom +</Button>
          <Button onClick={() => setView(v => ({ ...v, zoom: Math.max(0.25, v.zoom / 1.5) }))}>Zoom −</Button>
          <Button onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>Fit map</Button>
          <Button disabled={busy} onClick={() => void load()}>Reload points</Button>
          <Button onClick={() => setOpen(false)}>Close</Button>
          <FormControlLabel control={<Checkbox checked={clearanceMode} onChange={(_, value) => setClearanceMode(value)}/>} label="Planner Clearance Diagnostics"/>
        </Stack>
        {busy && <Alert severity="info">Checking installed API version and downloading the complete point cloud…</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        {checked.error && <Alert severity="error">{checked.error}</Alert>}
        {comparison && Math.max(Math.abs(comparison.extentDeltaX), Math.abs(comparison.extentDeltaY)) > raster.metersPerPixel / 2 &&
          <Alert severity="warning">Bosch physical extents differ from decoded PNG dimensions × resolution. Layers use the existing origin/resolution transform without stretching the PNG. Inspect the extent deltas below.</Alert>}
        {snapshot && snapshot.info.warnings.length > 0 && <Alert severity="warning">Bosch map warnings: {JSON.stringify(snapshot.info.warnings)}</Alert>}
        <Typography variant="body2">{snapshot ? `Locator ${snapshot.compatibility.componentVersion}; ServerMap ${snapshot.compatibility.serverMapModule?.majorVersion}.${snapshot.compatibility.serverMapModule?.minorVersion}; ${snapshot.cloud.originalPointCount.toLocaleString()} original points (no downsampling); ` : ''}
          {comparison ? `${comparison.occupied.length.toLocaleString()} occupied cells; ${comparison.unsupported.length.toLocaleString()} cells without points; ${comparison.pointsOutsideOccupied.toLocaleString()} in-map points outside occupied cells; ${comparison.outside} outside image; ${comparison.invalid} nonfinite points.` : ''}
        </Typography>
        {snapshot && <Typography variant="caption">Map created: {JSON.stringify(snapshot.info.createdAt) ?? 'N/A'}; updated: {JSON.stringify(snapshot.info.updatedAt) ?? 'N/A'}; received: {JSON.stringify(snapshot.info.receivedAt) ?? 'N/A'}.</Typography>}
        <Typography variant="caption">{raster.pixelWidth} × {raster.pixelHeight} pixels; {raster.widthMeters} × {raster.heightMeters} m; {raster.metersPerPixel} m/cell; origin ({raster.origin.x}, {raster.origin.y}), yaw {raster.origin.yaw} rad; fingerprint {fingerprint}; thresholds occupied ≥ {grid.metadata.occupiedThreshold}, free ≤ {grid.metadata.freeThreshold}.
          {comparison && ` Extent minus pixel-count × resolution: Δx=${comparison.extentDeltaX.toFixed(6)} m, Δy=${comparison.extentDeltaY.toFixed(6)} m.`}
        </Typography>
        <Typography variant="caption">Yellow means no original point falls inside that exact occupied cell; it is evidence to inspect, not proof of a mapping error. Point comparison applies no tolerance, filtering or inflation. Scroll to zoom at the cursor, drag to pan, click to inspect.</Typography>
        {open && clearanceMode && <PlannerClearanceDiagnostics grid={grid} pickRef={clearancePick} onOverlay={setClearanceOverlay}/>}
        <canvas ref={canvas} aria-label="Diagnostic PNG, point cloud and occupancy overlay"
          style={{ width: '100%', flex: '1 1 auto', minHeight: 300, touchAction: 'none', cursor: 'crosshair' }}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, panX: view.x, panY: view.y }; }}
          onPointerMove={event => { const start = drag.current; if (start) setView(v => ({ ...v, x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y })); }}
          onPointerCancel={() => { drag.current = undefined; }}
          onPointerUp={event => {
            const start = drag.current; drag.current = undefined;
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) {
              const rect = event.currentTarget.getBoundingClientRect();
              const pixel = { x: (event.clientX - rect.left - ox) / scale, y: (event.clientY - rect.top - oy) / scale };
              setInspection(pixel);
              if (clearanceMode && pixel.x >= 0 && pixel.y >= 0 && pixel.x < raster.pixelWidth && pixel.y < raster.pixelHeight)
                clearancePick.current?.(transform.imagePixelToWorld(pixel.x, pixel.y));
            }
          }}/>
        <Typography variant="body2" fontFamily="monospace">{world && inspection
          ? `MAP (${world.x.toFixed(4)}, ${world.y.toFixed(4)}) m; image (${inspection.x.toFixed(3)}, ${inspection.y.toFixed(3)}); ${inBounds ? `row ${row}, column ${column}; occupancy ${grid.data[cellIndex]}; original points in cell ${comparison?.hits[cellIndex] ?? 'not loaded'}` : 'outside image'}`
          : 'Click a doorway cell to inspect map coordinates, occupancy and original point count.'}</Typography>
      </DialogContent>
    </Dialog>
  </>;
}
