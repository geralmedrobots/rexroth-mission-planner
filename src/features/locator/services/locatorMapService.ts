import type { MapMetadata, OccupancyGrid } from '../../../domain/types';
import { pixelsToOccupancy } from '../../../domain/map/MapImporter';
import { ServerMapApi } from '../api/serverMapApi';
import type {
  LocatorConnectionSettings, LocatorMapProvider, LocatorPointCloudMap, LocatorRasterMap,
  LoadedLocatorMap, ServerMapInfo, ServerMapSummary,
} from '../types';
import { decodePngContainer } from './pngContainerDecoder';
import { decodePointCloudMap } from './pointCloudMapConverter';
import { locatorSessionService, type LocatorSessionService } from './locatorSessionService';
import { diagnosticPointCloudResponseSchema } from '../schemas/serverMapSchemas';

const MAX_IMAGE_DIMENSION = 20_000;

const pngToGrayscale = async (image: Blob): Promise<{ width: number; height: number; pixels: Uint8Array }> => {
  const bitmap = await createImageBitmap(image);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas image decoder unavailable.');
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const pixels = new Uint8Array(bitmap.width * bitmap.height);
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4;
    pixels[index] = Math.round(0.299 * rgba[offset]! + 0.587 * rgba[offset + 1]! + 0.114 * rgba[offset + 2]!);
  }
  bitmap.close();
  return { width: canvas.width, height: canvas.height, pixels };
};

export class LocatorMapService implements LocatorMapProvider {
  private readonly maps: ServerMapApi;
  private settings?: LocatorConnectionSettings;
  private currentObjectUrl?: string;

  public constructor(private readonly sessions: LocatorSessionService = locatorSessionService) {
    this.maps = new ServerMapApi(sessions.rpc);
  }
  public async connect(settings?: LocatorConnectionSettings): Promise<void> {
    if (settings) this.settings = settings;
    if (!this.settings) throw new Error('Locator connection settings are missing.');
    await this.sessions.connect(this.settings);
  }
  public login(username: string, password: string): Promise<string> { return this.sessions.login(username, password); }
  public async listMaps(): Promise<ServerMapSummary[]> {
    return (await this.maps.list()).serverMapNames.map((name) => ({ name }));
  }
  public async getMapInfo(name: string): Promise<ServerMapInfo> {
    const response = await this.maps.getInfo(name);
    return {
      name,
      level: response.level,
      loaded: response.loaded,
      type: response.type,
      fingerprint: String(response.fingerprint),
      createdAt: response.createdAt,
      updatedAt: response.updatedAt,
      sentAt: response.sentAt,
      receivedAt: response.receivedAt,
      warnings: response.warnings,
    };
  }
  public async getMapImageWithResolution(name: string, pixelsPerMeter: number): Promise<LocatorRasterMap> {
    const { raster } = await this.downloadRaster(name, pixelsPerMeter);
    this.activateRaster(raster);
    return raster;
  }
  private async downloadRaster(name: string, pixelsPerMeter: number) {
    if (!Number.isFinite(pixelsPerMeter) || pixelsPerMeter <= 0) throw new Error('Image resolution must be greater than zero.');
    const response = await this.maps.getImageWithResolution(name, pixelsPerMeter);
    return this.createRaster(name, response, pixelsPerMeter);
  }
  public async downloadSource(name: string, settings: LocatorConnectionSettings) {
    const instance = this.sessions.configuredInstance;
    const before = await this.getMapInfo(name);
    const { raster, image } = await this.downloadRaster(name, settings.imagePixelsPerMeter);
    try {
      const loaded = await this.toOccupancy(raster, settings, image);
      const info = await this.getMapInfo(name);
      if (instance !== this.sessions.configuredInstance || before.fingerprint !== info.fingerprint) {
        throw new Error('Locator source changed during map download. Reload the map.');
      }
      return { ...loaded, image, info, instance };
    } catch (error) {
      URL.revokeObjectURL(raster.imageUrl);
      throw error;
    }
  }
  /** The caller owns pending URLs until activation. */
  public activateRaster(raster: LocatorRasterMap): void {
    if (this.currentObjectUrl !== raster.imageUrl) this.dispose();
    this.currentObjectUrl = raster.imageUrl;
  }
  /** Optional documented serverMapGetImage binding with server-side aspect-ratio preservation. */
  public async getMapImage(name: string, maxPixelWidth: number, maxPixelHeight: number, level: number): Promise<LocatorRasterMap> {
    if (!Number.isInteger(maxPixelWidth) || !Number.isInteger(maxPixelHeight) ||
        maxPixelWidth < 1 || maxPixelHeight < 1 ||
        maxPixelWidth > MAX_IMAGE_DIMENSION || maxPixelHeight > MAX_IMAGE_DIMENSION) {
      throw new Error('Maximum image width and height must be integers from 1 through 20000.');
    }
    const response = await this.maps.getImage(name, maxPixelWidth, maxPixelHeight, level);
    if (!(response.width > 0) || !(response.height > 0)) throw new Error('Locator returned invalid map dimensions.');
    const decoded = decodePngContainer(response.image);
    const pixelsPerMeter = decoded.pixelWidth / response.width;
    const { raster } = this.createRaster(name, response, pixelsPerMeter);
    this.activateRaster(raster);
    return raster;
  }
  /** Optional documented thumbnail method. Thumbnails are list previews, never planner maps. */
  public async getMapThumbnail(name: string, mapLevel: number): Promise<{ pngBytes: Uint8Array; imageUrl: string }> {
    const response = await this.maps.getThumbnail(name, mapLevel);
    const decoded = decodePngContainer(response.image);
    return {
      pngBytes: decoded.bytes,
      imageUrl: URL.createObjectURL(new Blob([new Uint8Array(decoded.bytes)], { type: 'image/png' })),
    };
  }
  private createRaster(
    name: string,
    response: Awaited<ReturnType<ServerMapApi['getImageWithResolution']>>,
    pixelsPerMeter: number,
  ): { raster: LocatorRasterMap; image: Blob } {
    const decoded = decodePngContainer(response.image);
    if (decoded.pixelWidth > MAX_IMAGE_DIMENSION || decoded.pixelHeight > MAX_IMAGE_DIMENSION) {
      throw new Error(`Locator image ${decoded.pixelWidth}×${decoded.pixelHeight} exceeds the 20000-pixel limit.`);
    }
    if (!(response.width > 0) || !(response.height > 0)) throw new Error('Locator returned invalid map dimensions.');
    const image = new Blob([new Uint8Array(decoded.bytes)], { type: 'image/png' });
    const imageUrl = URL.createObjectURL(image);
    return {
      image,
      raster: {
        mapName: name,
        pngBytes: decoded.bytes,
        imageUrl,
        pixelWidth: decoded.pixelWidth,
        pixelHeight: decoded.pixelHeight,
        widthMeters: response.width,
        heightMeters: response.height,
        pixelsPerMeter,
        metersPerPixel: 1 / pixelsPerMeter,
        origin: { x: response.MAPimageOrigin.x, y: response.MAPimageOrigin.y, yaw: response.MAPimageOrigin.a },
      },
    };
  }
  public async getMapPointCloud(name: string, maxNonReflectorPoints?: number): Promise<LocatorPointCloudMap> {
    const response = await this.maps.getPointCloud(name);
    return decodePointCloudMap(name, response.pointCloud, response.pointCloudSize, response.reflectors, maxNonReflectorPoints);
  }
  /** Read-only diagnostic snapshot. ServerMap 9 verified against Locator 2.0.8.
   * Keep the original response/container as well as every decoded point. */
  public async getDiagnosticPointCloud(raster: LocatorRasterMap, grid: OccupancyGrid, expectedFingerprint: string) {
    const compatibility = await this.sessions.test();
    if (compatibility.componentType !== 2 || compatibility.serverMapModule?.majorVersion !== 9) {
      throw new Error(`Diagnostic point-cloud format is verified for Locator Server / ServerMap 9 only; received ${compatibility.componentVersion}, ServerMap ${compatibility.serverMapModule?.majorVersion ?? 'missing'}.`);
    }
    if (grid.metadata.mapId !== raster.mapName) throw new Error('Loaded PNG and grid map IDs differ.');
    const before = await this.getMapInfo(raster.mapName);
    if (before.fingerprint !== expectedFingerprint) throw new Error('Server map changed since PNG download. Reload the PNG map first.');
    const raw = diagnosticPointCloudResponseSchema.parse(await this.sessions.rpc.post<unknown>(
      '/locator/map/serverMapGetMap', { serverMapName: raster.mapName },
    ));
    const cloud = decodePointCloudMap(raster.mapName, raw.pointCloud, raw.pointCloudSize, raw.reflectors);
    if (cloud.points.length !== raw.pointCloudSize) throw new Error('Incomplete diagnostic point cloud.');
    const after = await this.getMapInfo(raster.mapName);
    if (after.fingerprint !== before.fingerprint) throw new Error('Server map changed during diagnostic download. Reload and retry.');
    return { cloud, raw, compatibility, info: after };
  }
  public async toOccupancy(
    raster: LocatorRasterMap, settings: LocatorConnectionSettings,
    image = new Blob([new Uint8Array(raster.pngBytes)], { type: 'image/png' }),
  ): Promise<LoadedLocatorMap> {
    const grayscale = await pngToGrayscale(image);
    if (grayscale.width !== raster.pixelWidth || grayscale.height !== raster.pixelHeight) {
      throw new Error('Decoded map image dimensions changed unexpectedly.');
    }
    const metadata: MapMetadata = {
      name: raster.mapName,
      mapId: raster.mapName,
      width: raster.pixelWidth,
      height: raster.pixelHeight,
      resolution: raster.metersPerPixel,
      origin: raster.origin,
      occupiedThreshold: settings.occupiedThreshold,
      freeThreshold: settings.freeThreshold,
      negate: false,
    };
    const occupancy: OccupancyGrid = { metadata, data: pixelsToOccupancy(grayscale.pixels, metadata) };
    return { raster, occupancy };
  }
  public logout(): Promise<void> { return this.sessions.logout(); }
  public dispose(): void {
    if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl);
    this.currentObjectUrl = undefined;
  }
}

export const locatorMapService = new LocatorMapService();
