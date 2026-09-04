import YAML from 'yaml';
import type { MapMetadata, OccupancyGrid } from '../types';

interface RosYaml {
  image?: string; resolution?: number; origin?: [number, number, number];
  occupied_thresh?: number; free_thresh?: number; negate?: number;
}

export const parsePgm = (buffer: ArrayBuffer): { width: number; height: number; pixels: Uint8Array } => {
  const bytes = new Uint8Array(buffer); let cursor = 0;
  const token = (): string => {
    while (cursor < bytes.length) {
      if (bytes[cursor] === 35) while (cursor < bytes.length && bytes[cursor] !== 10) cursor += 1;
      if ((bytes[cursor] ?? 0) > 32) break; cursor += 1;
    }
    const start = cursor; while (cursor < bytes.length && (bytes[cursor] ?? 0) > 32) cursor += 1;
    return new TextDecoder().decode(bytes.slice(start, cursor));
  };
  const magic = token(); const width = Number(token()); const height = Number(token()); const max = Number(token());
  if (!['P2', 'P5'].includes(magic) || !width || !height || !max) throw new Error('Unsupported or malformed PGM file.');
  const pixels = new Uint8Array(width * height);
  if (magic === 'P2') for (let i = 0; i < pixels.length; i += 1) pixels[i] = Math.round((Number(token()) / max) * 255);
  else {
    while (cursor < bytes.length && (bytes[cursor] ?? 0) <= 32) cursor += 1;
    pixels.set(bytes.slice(cursor, cursor + pixels.length).map((value) => Math.round((value / max) * 255)));
  }
  return { width, height, pixels };
};

export const pixelsToOccupancy = (
  pixels: Uint8Array, metadata: MapMetadata,
): number[] => pixels.map((pixel) => {
  const normalized = metadata.negate ? pixel / 255 : (255 - pixel) / 255;
  if (normalized >= metadata.occupiedThreshold) return 100;
  if (normalized <= metadata.freeThreshold) return 0;
  return -1;
}) as unknown as number[];

export const metadataFromRosYaml = (text: string, width: number, height: number, fallbackMapId: string): MapMetadata => {
  const yaml = YAML.parse(text) as RosYaml;
  if (!yaml.resolution || !yaml.origin || yaml.origin.length !== 3) throw new Error('YAML requires resolution and origin [x, y, yaw].');
  return {
    name: yaml.image ?? fallbackMapId, mapId: fallbackMapId, width, height,
    resolution: yaml.resolution, origin: { x: yaml.origin[0], y: yaml.origin[1], yaw: yaml.origin[2] },
    occupiedThreshold: yaml.occupied_thresh ?? 0.65, freeThreshold: yaml.free_thresh ?? 0.196,
    negate: Boolean(yaml.negate),
  };
};

export const parseOccupancyJson = (text: string): OccupancyGrid => {
  const raw = JSON.parse(text) as Partial<OccupancyGrid> & {
    width?: number; height?: number; resolution?: number; origin?: { x?: number; y?: number; yaw?: number }; cellData?: number[];
  };
  if (raw.metadata && Array.isArray(raw.data)) {
    if (raw.data.length !== raw.metadata.width * raw.metadata.height) throw new Error('Occupancy data length does not match dimensions.');
    return raw as OccupancyGrid;
  }
  if (!raw.width || !raw.height || !raw.resolution || !raw.origin || !Array.isArray(raw.cellData)) throw new Error('JSON occupancy grid is missing dimensions, resolution, origin, or cellData.');
  if (raw.cellData.length !== raw.width * raw.height) throw new Error('cellData length does not match dimensions.');
  return {
    metadata: {
      name: 'Imported JSON map', mapId: 'imported-map', width: raw.width, height: raw.height,
      resolution: raw.resolution, origin: { x: raw.origin.x ?? 0, y: raw.origin.y ?? 0, yaw: raw.origin.yaw ?? 0 },
      occupiedThreshold: 0.65, freeThreshold: 0.196, negate: false,
    },
    data: raw.cellData,
  };
};

export const imageFileToPixels = async (file: File): Promise<{ width: number; height: number; pixels: Uint8Array }> => {
  if (file.name.toLowerCase().endsWith('.pgm')) return parsePgm(await file.arrayBuffer());
  const bitmap = await createImageBitmap(file); const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas image decoder unavailable.');
  context.drawImage(bitmap, 0, 0); const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const pixels = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0; i < pixels.length; i += 1) {
    const offset = i * 4; pixels[i] = Math.round(0.299 * rgba[offset]! + 0.587 * rgba[offset + 1]! + 0.114 * rgba[offset + 2]!);
  }
  return { width: bitmap.width, height: bitmap.height, pixels };
};
