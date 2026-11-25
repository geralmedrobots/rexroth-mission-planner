import type { OccupancyGrid } from '../../../domain/types';
import type { ClearanceOverlay } from './PlannerClearanceDiagnostics';
import type { LocatorCoordinateTransformer } from '../services/locatorCoordinateTransformer';
import { isOccupiedValue } from '../../../domain/planner/ObstacleInflation';

/** Drawn inside the diagnostic viewer's image-space zoom/pan transform. */
export function drawClearanceOverlay(ctx: CanvasRenderingContext2D, grid: OccupancyGrid,
  transform: LocatorCoordinateTransformer, overlay: ClearanceOverlay, scale: number) {
  const width = grid.metadata.width;
  const cell = (row: number, column: number, color: string) => {
    ctx.fillStyle = color; ctx.fillRect(column, row, 1, 1);
  };
  grid.data.forEach((value, i) => {
    if (value < 0 && overlay.showUnknown) cell(Math.floor(i / width), i % width, 'rgba(140,140,140,.65)');
    else if (overlay.showInflation && !isOccupiedValue(value, grid.metadata.occupiedThreshold) &&
        isOccupiedValue(overlay.inflated.data[i] ?? -1, overlay.inflated.metadata.occupiedThreshold))
      cell(Math.floor(i / width), i % width, 'rgba(255,152,0,.55)');
  });
  for (const i of overlay.hardMinimumCells) cell(Math.floor(i / width), i % width, 'rgba(40,110,255,.5)');
  const line = (points: Array<{ x: number; y: number }>, color: string, close = false) => {
    if (!points.length) return;
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2 / scale;
    points.forEach((point, i) => {
      const p = transform.worldToImagePixel(point.x, point.y);
      if (i === 0) ctx.moveTo(p.pixelX, p.pixelY); else ctx.lineTo(p.pixelX, p.pixelY);
    });
    if (close) ctx.closePath(); ctx.stroke();
  };
  line(overlay.path, '#39a9ff');
  if (overlay.start && overlay.goal) line([overlay.start, overlay.goal], '#8cbbff');
  for (const [point, label] of [[overlay.start, 'A'], [overlay.goal, 'B']] as const) {
    if (!point) continue;
    const p = transform.worldToImagePixel(point.x, point.y);
    ctx.fillStyle = '#8cbbff'; ctx.fillRect(p.pixelX - 3 / scale, p.pixelY - 3 / scale, 6 / scale, 6 / scale);
    ctx.font = `${14 / scale}px sans-serif`; ctx.fillText(label, p.pixelX + 5 / scale, p.pixelY - 5 / scale);
  }
  if (overlay.doorway) {
    const { left, right } = overlay.doorway;
    line([left.point, right.point], overlay.belowPassageSetting ? '#bb66ff' : '#ffe36b');
    for (const hit of [left, right]) {
      ctx.strokeStyle = overlay.belowPassageSetting ? '#bb66ff' : '#ffe36b'; ctx.lineWidth = 3 / scale;
      ctx.strokeRect(hit.cell.column, hit.cell.row, 1, 1);
    }
  }
  line(overlay.physicalPolygon ?? [], '#ffffff', true);
  line(overlay.selected?.polygon ?? [], overlay.selected?.obstacle === 'free' ? '#00d9ff' : '#ff3fe2', true);
  if (overlay.selected?.pose) {
    const p = overlay.selected.pose;
    line([p, { x: p.x + .3 * Math.cos(p.theta), y: p.y + .3 * Math.sin(p.theta) }], '#ffffff');
  }
  const selected = overlay.selected?.obstacle !== 'free' && overlay.selected ? [overlay.selected] : [];
  for (const evidence of [...overlay.evidence, ...selected]) {
    if (evidence.cell) {
      cell(evidence.cell.row, evidence.cell.column,
        evidence.obstacle === 'unknown' ? 'rgba(150,150,150,.95)' : evidence.obstacle === 'inflated' ? '#ff9800' : '#ff1717');
      ctx.strokeStyle = '#ff3fe2'; ctx.lineWidth = 3 / scale;
      ctx.strokeRect(evidence.cell.column, evidence.cell.row, 1, 1);
    }
    line(evidence.polygon ?? [], '#ff3fe2', true);
  }
}
