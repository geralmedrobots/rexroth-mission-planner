import { aboutBuildVersionSchema, aboutModulesListSchema, basicResponseSchema, sessionLoginResponseSchema } from '../schemas/sessionSchemas';
import type { LocatorTestResult } from '../types';
import type { LocatorRpcClient } from './locatorRpcClient';

export class SessionApi {
  public constructor(private readonly rpc: LocatorRpcClient) {}

  public async test(): Promise<LocatorTestResult> {
    const result = await this.rpc.post<{ build: unknown; modules: unknown }>('/locator/test');
    const build = aboutBuildVersionSchema.parse(result.build);
    const modules = aboutModulesListSchema.parse(result.modules).modules;
    const serverMapModule = modules.find((module) => module.name.toLowerCase() === 'servermap');
    return {
      componentVersion: `${build.majorVersion}.${build.minorVersion}.${build.patchVersion}`,
      componentType: build.componentType,
      modules,
      serverMapModule,
    };
  }

  public async login(username: string, password: string): Promise<string> {
    const response = sessionLoginResponseSchema.parse(
      await this.rpc.post<unknown>('/locator/login', { username, password }),
    );
    return response.sessionId;
  }

  public async automaticLogin(): Promise<void> {
    const response=await this.rpc.post<{authenticated:boolean}>('/locator/auto-login');
    if(!response.authenticated)throw new Error('Locator automatic login was not acknowledged.');
  }

  public async forgetCredentials(): Promise<void> {
    const response=await this.rpc.post<{forgotten:boolean}>('/locator/forget-credentials');
    if(!response.forgotten)throw new Error('Locator credential reset was not acknowledged.');
  }

  public async logout(): Promise<void> {
    basicResponseSchema.parse(await this.rpc.post<unknown>('/locator/logout'));
  }
}
