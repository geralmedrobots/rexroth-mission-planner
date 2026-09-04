import type { GridCell, MapMetadata, Pose2D } from '../types';
import { normalizeAngle } from './angles';

export class CoordinateTransformer {
  public constructor(private readonly map: MapMetadata) {}

  public worldToGrid(x: number, y: number): GridCell | null {
    const dx = x - this.map.origin.x;
    const dy = y - this.map.origin.y;
    const c = Math.cos(-this.map.origin.yaw);
    const s = Math.sin(-this.map.origin.yaw);
    const localX = c * dx - s * dy;
    const localY = s * dx + c * dy;
    const column = Math.floor(localX / this.map.resolution);
    const rowFromBottom = Math.floor(localY / this.map.resolution);
    const row = this.map.height - 1 - rowFromBottom;
    return this.inBounds({ row, column }) ? { row, column } : null;
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
