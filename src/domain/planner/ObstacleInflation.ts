import type { OccupancyGrid, RobotFootprint } from '../types';

export const isOccupiedValue = (value: number, occupiedThreshold: number): boolean =>
  value < 0 || value >= occupiedThreshold;

export class ObstacleInflation {
  public static circular(grid: OccupancyGrid, footprint: RobotFootprint): OccupancyGrid {
    const radius = Math.max(
      footprint.inflationRadius,
      Math.hypot(footprint.length / 2, footprint.width / 2) + footprint.safetyMargin,
    );
    return this.byRadius(grid,radius);
  }

  /** Diagnostic/planning-margin expansion without adding the vehicle size. */
  public static byRadius(grid:OccupancyGrid,radiusM:number):OccupancyGrid{
    const radius=Math.max(0,radiusM);
    const cells = Math.ceil(radius / grid.metadata.resolution);
    const output = [...grid.data];
    for (let row = 0; row < grid.metadata.height; row += 1) {
      for (let col = 0; col < grid.metadata.width; col += 1) {
        const value = grid.data[row * grid.metadata.width + col] ?? 100;
        if (!isOccupiedValue(value, grid.metadata.occupiedThreshold)) continue;
        for (let dr = -cells; dr <= cells; dr += 1) {
          for (let dc = -cells; dc <= cells; dc += 1) {
            if (Math.hypot(dr, dc) * grid.metadata.resolution > radius) continue;
            const r = row + dr; const c = col + dc;
            if (r >= 0 && c >= 0 && r < grid.metadata.height && c < grid.metadata.width) {
              output[r * grid.metadata.width + c] = 100;
            }
          }
        }
      }
    }
    return { metadata: grid.metadata, data: output };
  }

  public static proximityDistance(grid: OccupancyGrid): Float32Array {
    const { width, height, occupiedThreshold } = grid.metadata;
    const distance = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
    const queue: number[] = [];
    grid.data.forEach((value, index) => {
      if (isOccupiedValue(value, occupiedThreshold)) { distance[index] = 0; queue.push(index); }
    });
    let head = 0;
    while (head < queue.length) {
      const index = queue[head++]!;
      const row = Math.floor(index / width); const col = index % width;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const r = row + dr; const c = col + dc;
        if (r < 0 || c < 0 || r >= height || c >= width) continue;
        const next = r * width + c;
        if (distance[next]! > distance[index]! + 1) {
          distance[next] = distance[index]! + 1; queue.push(next);
        }
      }
    }
    return distance;
  }
}
