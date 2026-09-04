import type { OccupancyGrid } from '../../domain/types';

export interface LocatorConnectionSettings {
  host: string;
  port: number;
  https: boolean;
  rpcEndpoint: string;
  requestTimeoutMs: number;
  imagePixelsPerMeter: number;
  occupiedThreshold: number;
  freeThreshold: number;
  caCertificatePem: string;
  insecureDevelopmentMode: boolean;
  automaticConnection: boolean;
  automaticLogin: boolean;
}

export interface LocatorOrigin { x: number; y: number; yaw: number }
export interface LocatorRasterMap {
  mapName: string;
  pngBytes: Uint8Array;
  imageUrl: string;
  pixelWidth: number;
  pixelHeight: number;
  widthMeters: number;
  heightMeters: number;
  pixelsPerMeter: number;
  metersPerPixel: number;
  origin: LocatorOrigin;
}
export interface ServerMapSummary { name: string }
export interface ServerMapInfo {
  name: string;
  level: number;
  loaded: boolean;
  type: number;
  fingerprint: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  sentAt?: unknown;
  receivedAt?: unknown;
  warnings: unknown[];
}
export interface LocatorPoint { x: number; y: number; reflector: boolean }
export interface LocatorPointCloudMap {
  mapName: string;
  points: LocatorPoint[];
  originalPointCount: number;
}
export interface LocatorTestResult {
  componentVersion: string;
  componentType: number;
  modules: Array<{ name: string; majorVersion: number; minorVersion: number }>;
  serverMapModule?: { name: string; majorVersion: number; minorVersion: number };
}
export interface LoadedLocatorMap { raster: LocatorRasterMap; occupancy: OccupancyGrid }

export interface LocatorMapProvider {
  connect(): Promise<void>;
  login(username: string, password: string): Promise<string>;
  listMaps(): Promise<ServerMapSummary[]>;
  getMapInfo(name: string): Promise<ServerMapInfo>;
  getMapImageWithResolution(name: string, pixelsPerMeter: number): Promise<LocatorRasterMap>;
  getMapPointCloud?(name: string, maxNonReflectorPoints?: number): Promise<LocatorPointCloudMap>;
  logout(): Promise<void>;
}
