import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import type { GridCell, MapMetadata, OccupancyGrid, RobotPose } from '../domain/types';

export type LiveRobotVisualization =
  | { status: 'unavailable'; label: 'Pose unavailable'; cell?: undefined }
  | { status: 'outside-map'; label: 'Robot pose outside loaded map'; cell?: undefined }
  | { status: 'visible'; label: 'Robot pose live'; cell: GridCell };

export interface LiveRobotMapDiagnostic {
  status: 'unavailable' | 'invalid-map-metadata' | 'outside-map' | 'visible';
  pose?: RobotPose;
  map?: {
    name: string;
    mapId: string;
    width: number;
    height: number;
    resolution: number;
    origin: { x: number; y: number; yaw: number };
  };
  rawCell?: GridCell;
  cell?: GridCell;
  inBounds: boolean;
  worldBounds?: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    corners: Array<{ x: number; y: number }>;
  };
}

const finite = (value: number): boolean => Number.isFinite(value);

const metadataValid = (metadata: MapMetadata | undefined): metadata is MapMetadata =>
  Boolean(metadata && Number.isInteger(metadata.width) && metadata.width > 0 &&
    Number.isInteger(metadata.height) && metadata.height > 0 &&
    finite(metadata.resolution) && metadata.resolution > 0 &&
    finite(metadata.origin.x) && finite(metadata.origin.y) && finite(metadata.origin.yaw));

const calculateRawCell = (metadata: MapMetadata, x: number, y: number): GridCell => {
  const dx = x - metadata.origin.x;
  const dy = y - metadata.origin.y;
  const c = Math.cos(-metadata.origin.yaw);
  const s = Math.sin(-metadata.origin.yaw);
  const localX = c * dx - s * dy;
  const localY = s * dx + c * dy;
  const column = Math.floor(localX / metadata.resolution);
  const rowFromBottom = Math.floor(localY / metadata.resolution);
  return { row: metadata.height - 1 - rowFromBottom, column };
};

const calculateWorldBounds = (metadata: MapMetadata): LiveRobotMapDiagnostic['worldBounds'] => {
  const widthM = metadata.width * metadata.resolution;
  const heightM = metadata.height * metadata.resolution;
  const c = Math.cos(metadata.origin.yaw);
  const s = Math.sin(metadata.origin.yaw);
  const toWorld = (x: number, y: number): { x: number; y: number } => ({
    x: metadata.origin.x + c * x - s * y,
    y: metadata.origin.y + s * x + c * y,
  });
  const corners = [toWorld(0, 0), toWorld(widthM, 0), toWorld(widthM, heightM), toWorld(0, heightM)];
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
    corners,
  };
};

export const analyzeLiveRobotMapConversion = (
  grid: OccupancyGrid | undefined,
  pose: RobotPose | undefined,
): LiveRobotMapDiagnostic => {
  if (!pose) return { status: 'unavailable', inBounds: false };
  const metadata = grid?.metadata;
  if (!metadataValid(metadata)) return { status: 'invalid-map-metadata', pose, inBounds: false };
  const rawCell = calculateRawCell(metadata, pose.x, pose.y);
  const cell = new CoordinateTransformer(metadata).worldToGrid(pose.x, pose.y) ?? undefined;
  return {
    status: cell ? 'visible' : 'outside-map',
    pose,
    map: {
      name: metadata.name,
      mapId: metadata.mapId,
      width: metadata.width,
      height: metadata.height,
      resolution: metadata.resolution,
      origin: metadata.origin,
    },
    rawCell,
    cell,
    inBounds: Boolean(cell),
    worldBounds: cell ? undefined : calculateWorldBounds(metadata),
  };
};

export const getLiveRobotVisualization = (
  grid: OccupancyGrid | undefined,
  pose: RobotPose | undefined,
): LiveRobotVisualization => {
  const diagnostic = analyzeLiveRobotMapConversion(grid, pose);
  if (diagnostic.status === 'visible' && diagnostic.cell) {
    return { status: 'visible', label: 'Robot pose live', cell: diagnostic.cell };
  }
  if (diagnostic.status === 'outside-map') {
    return { status: 'outside-map', label: 'Robot pose outside loaded map' };
  }
  return { status: 'unavailable', label: 'Pose unavailable' };
};

const formatNumber = (value: number | undefined): string =>
  value === undefined || !Number.isFinite(value) ? 'n/a' : value.toFixed(3);

const formatCell = (cell: GridCell | undefined): string =>
  cell ? `(${cell.column},${cell.row})` : '(n/a,n/a)';

export const formatLivePoseMapCheck = (diagnostic: LiveRobotMapDiagnostic): string => {
  const lines = [
    '[live-pose-map-check]',
    `world=(${formatNumber(diagnostic.pose?.x)},${formatNumber(diagnostic.pose?.y)},theta=${formatNumber(diagnostic.pose?.theta)})`,
    `passedPose=${diagnostic.pose ? 'present' : 'missing'}`,
    `map=${diagnostic.map?.mapId ?? diagnostic.map?.name ?? '<missing>'}`,
    `origin=(${formatNumber(diagnostic.map?.origin.x)},${formatNumber(diagnostic.map?.origin.y)},theta=${formatNumber(diagnostic.map?.origin.yaw)})`,
    `resolution=${diagnostic.map?.resolution ?? '<missing>'}`,
    `size=${diagnostic.map ? `${diagnostic.map.width}x${diagnostic.map.height}` : '<missing>'}`,
    `grid=${formatCell(diagnostic.cell ?? diagnostic.rawCell)}`,
    `worldToGrid=${formatCell(diagnostic.cell)}`,
    `inBounds=${diagnostic.inBounds}`,
    `status=${diagnostic.status}`,
  ];
  if (diagnostic.worldBounds) {
    lines.push(
      `worldBounds=x[${formatNumber(diagnostic.worldBounds.minX)},${formatNumber(diagnostic.worldBounds.maxX)}] ` +
      `y[${formatNumber(diagnostic.worldBounds.minY)},${formatNumber(diagnostic.worldBounds.maxY)}]`,
    );
  }
  return lines.join('\n');
};
