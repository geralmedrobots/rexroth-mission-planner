import {
  serverMapImageResponseSchema,
  serverMapInfoResponseSchema,
  serverMapListResponseSchema,
  serverMapPointCloudResponseSchema,
} from '../schemas/serverMapSchemas';
import type { LocatorRpcClient } from './locatorRpcClient';

const callPath = (method: string): string => `/locator/map/${method}`;

export class ServerMapApi {
  public constructor(private readonly rpc: LocatorRpcClient) {}

  public async list() {
    return serverMapListResponseSchema.parse(await this.rpc.post<unknown>(callPath('serverMapList')));
  }
  public async getInfo(serverMapName: string) {
    return serverMapInfoResponseSchema.parse(await this.rpc.post<unknown>(
      callPath('serverMapGetInfo'), { serverMapName },
    ));
  }
  public async getImageWithResolution(serverMapName: string, resolution: number) {
    return serverMapImageResponseSchema.parse(await this.rpc.post<unknown>(
      callPath('serverMapGetImageWithResolution'), { serverMapName, resolution },
    ));
  }
  public async getImage(serverMapName: string, width: number, height: number, level: number) {
    return serverMapImageResponseSchema.parse(await this.rpc.post<unknown>(
      callPath('serverMapGetImage'), { serverMapName, width, height, level },
    ));
  }
  public async getPointCloud(serverMapName: string) {
    return serverMapPointCloudResponseSchema.parse(await this.rpc.post<unknown>(
      callPath('serverMapGetMap'), { serverMapName },
    ));
  }
  public async getThumbnail(serverMapName: string, mapLevel: number) {
    return serverMapImageResponseSchema.parse(await this.rpc.post<unknown>(
      callPath('serverMapGetMapThumbnail'), { serverMapName, mapLevel },
    ));
  }
}
