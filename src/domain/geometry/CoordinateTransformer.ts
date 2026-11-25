import type { GridCell, MapMetadata, Pose2D } from '../types';
import { normalizeAngle } from './angles';

export class CoordinateTransformer {
  public constructor(private readonly map: MapMetadata) {}

  public worldToGrid(x: number, y: number): GridCell | null {
    const position = this.worldToGridPosition(x, y);
    const column = Math.floor(position.column);
    const row = this.map.height - 1 - Math.floor(position.rowFromBottom);
    return this.inBounds({ row, column }) ? { row, column } : null;
  }

  /** Continuous coordinates in cell units, measured right and up from the map origin. */
  public worldToGridPosition(x: number, y: number): { column: number; rowFromBottom: number } {
    const dx = x - this.map.origin.x;
    const dy = y - this.map.origin.y;
    const c = Math.cos(-this.map.origin.yaw);
    const s = Math.sin(-this.map.origin.yaw);
    const localX = c * dx - s * dy;
    const localY = s * dx + c * dy;
    return { column: localX / this.map.resolution, rowFromBottom: localY / this.map.resolution };
  }

  public gridToWorld(row: number, column: number): Pose2D {
    const localX = (column + 0.5) * this.map.resolution;
    const localY = (this.map.height - row - 0.5) * this.map.resolution;
    const c = Math.cos(this.map.origin.yaw);
    const s = Math.sin(this.map.origin.yaw);
    return {
      x: this.map.origin.x + c * localX - s * localY,
      y: this.map.origin.y + s * localX + c * localY,
      theta: normalizeAngle(this.map.origin.yaw),
    };
  }

  public inBounds(cell: GridCell): boolean {
    return cell.row >= 0 && cell.column >= 0 && cell.row < this.map.height && cell.column < this.map.width;
  }

  public index(cell: GridCell): number { return cell.row * this.map.width + cell.column; }
}
