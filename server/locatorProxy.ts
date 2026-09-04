import type { Express, Request, Response } from 'express';
import { LocatorRpcClient, LocatorRpcError, type LocatorConnectionConfig } from './locatorRpcClient.js';

type ApiResponse = Record<string, unknown>;
interface SessionLoginResponse extends ApiResponse { sessionId: string }

const allowedMapMethods = new Set([
  'serverMapList',
  'serverMapGetInfo',
  'serverMapGetImageWithResolution',
  'serverMapGetImage',
  'serverMapGetMap',
  'serverMapGetMapThumbnail',
]);
const mapNameFrom = (query: Record<string, unknown>): string => {
  if (typeof query.serverMapName !== 'string' || !query.serverMapName) throw new Error('serverMapName is required.');
  return query.serverMapName;
};
const integerFrom = (query: Record<string, unknown>, key: string): number => {
  const value = query[key];
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be a safe integer.`);
  return Number(value);
};
const officialMapQuery = (method: string, query: Record<string, unknown>): Record<string, unknown> => {
  if (method === 'serverMapList') return {};
  const serverMapName = mapNameFrom(query);
  if (method === 'serverMapGetInfo' || method === 'serverMapGetMap') return { serverMapName };
  if (method === 'serverMapGetImageWithResolution') {
    const resolution = query.resolution;
    if (typeof resolution !== 'number' || !Number.isFinite(resolution) || resolution <= 0) {
      throw new Error('resolution must be a finite number greater than zero.');
    }
    return { serverMapName, resolution };
  }
  if (method === 'serverMapGetImage') {
    const width = integerFrom(query, 'width');
    const height = integerFrom(query, 'height');
    const level = integerFrom(query, 'level');
    if (width < 1 || width > 20_000 || height < 1 || height > 20_000) {
      throw new Error('width and height must be from 1 through 20000 pixels.');
    }
    return { serverMapName, width, height, level };
  }
  if (method === 'serverMapGetMapThumbnail') {
    return { serverMapName, mapLevel: integerFrom(query, 'mapLevel') };
  }
  throw new Error(`Unsupported Locator map method: ${method}`);
};

class LocatorProxy {
  private client?: LocatorRpcClient;
  private sessionId?: string;
  private sessionRefreshedAt = 0;
  private automaticCredentialsForgotten = false;

  public configure(value: unknown): { configured: true; insecureDevelopmentMode: boolean } {
    const input = value as Partial<LocatorConnectionConfig>;
    if (!input.host?.trim()) throw new Error('Locator host is required.');
    if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) {
      throw new Error('Locator RPC port must be between 1 and 65535.');
    }
    if (!input.endpoint?.startsWith('/')) throw new Error('Locator RPC endpoint must begin with "/".');
    if (!Number.isFinite(input.timeoutMs) || Number(input.timeoutMs) < 100) throw new Error('Request timeout is invalid.');
    const config: LocatorConnectionConfig = {
      host: input.host.trim(),
      port: Number(input.port),
      https: Boolean(input.https),
      endpoint: input.endpoint,
      timeoutMs: Number(input.timeoutMs),
      caCertificatePem: input.caCertificatePem?.trim() || undefined,
      insecureDevelopmentMode: Boolean(input.insecureDevelopmentMode),
    };
    this.client = new LocatorRpcClient(config);
    this.sessionId = undefined;
    this.sessionRefreshedAt = 0;
    return { configured: true, insecureDevelopmentMode: Boolean(config.insecureDevelopmentMode) };
  }

  public async test(): Promise<{ build: ApiResponse; modules: ApiResponse }> {
    const client = this.requireClient();
    const [build, modules] = await Promise.all([
      client.call<ApiResponse>('aboutBuildVersion', {}),
      client.call<ApiResponse>('aboutModulesList', {}),
    ]);
    return { build, modules };
  }

  public async login(username: unknown, password: unknown): Promise<SessionLoginResponse> {
    if (typeof username !== 'string' || typeof password !== 'string') throw new Error('Username and password must be strings.');
    const result = await this.requireClient().call<SessionLoginResponse>('sessionLogin', {
      userName: username,
      password,
      timeout: { valid: true, time: 600, resolution: 1 },
    });
    if (!result.sessionId) throw new Error('sessionLogin succeeded without a sessionId.');
    this.sessionId = result.sessionId;
    this.sessionRefreshedAt = Date.now();
    return result;
  }

  public async automaticLogin(): Promise<{ authenticated: true }> {
    if(this.automaticCredentialsForgotten)
      throw new Error('Saved Locator credentials were forgotten for this application session.');
    // The development bridge may already be running when an operator creates
    // the local .env file. Reload missing variables for this request without
    // returning them to the renderer or writing them to logs.
    try { process.loadEnvFile?.(); } catch (error) {
      const code=(error as NodeJS.ErrnoException).code;
      if(code!=='ENOENT')throw new Error(`Locator environment configuration could not be loaded (${code??'unknown error'}).`);
    }
    if(process.env.ROKIT_LOCATOR_AUTO_LOGIN?.toLowerCase()==='false')
      throw new Error('Automatic Locator login is disabled by server configuration.');
    const username=process.env.ROKIT_LOCATOR_USERNAME;
    const password=process.env.ROKIT_LOCATOR_PASSWORD;
    if(!username||!password||password==='change_me')
      throw new Error('Automatic Locator credentials are not configured in the local service environment.');
    await this.login(username,password);
    return {authenticated:true};
  }

  public forgetAutomaticCredentials(): {forgotten:true} {
    this.automaticCredentialsForgotten=true;
    this.sessionId=undefined;
    this.sessionRefreshedAt=0;
    return {forgotten:true};
  }

  public async logout(): Promise<ApiResponse> {
    const sessionId = this.requireSession();
    try {
      return await this.requireClient().call<ApiResponse>('sessionLogout', { sessionId });
    } finally {
      this.sessionId = undefined;
      this.sessionRefreshedAt = 0;
    }
  }

  public async mapCall(method: string, query: Record<string, unknown>): Promise<ApiResponse> {
    if (!allowedMapMethods.has(method)) throw new Error(`Unsupported Locator map method: ${method}`);
    await this.refreshIfNeeded();
    const sessionId = this.requireSession();
    return this.requireClient().call<ApiResponse>(method, { sessionId, ...officialMapQuery(method, query) });
  }

  private async refreshIfNeeded(): Promise<void> {
    if (this.sessionId && Date.now() - this.sessionRefreshedAt > 480_000) {
      await this.requireClient().call<ApiResponse>('sessionRefresh', { sessionId: this.sessionId });
      this.sessionRefreshedAt = Date.now();
    }
  }

  private requireClient(): LocatorRpcClient {
    if (!this.client) throw new Error('Configure the Locator RPC connection first.');
    return this.client;
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error('Login to the Locator Server first.');
    return this.sessionId;
  }
}

const proxy = new LocatorProxy();
const handle = (operation: (request: Request) => Promise<unknown> | unknown) =>
  async (request: Request, response: Response): Promise<void> => {
    try {
      response.json({ ok: true, data: await operation(request) });
    } catch (error) {
      const rpcError = error instanceof LocatorRpcError ? error : undefined;
      response.status(rpcError?.kind === 'bosch' ? 422 : 400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        kind: rpcError?.kind ?? 'validation',
        code: rpcError?.code,
      });
    }
  };

/** Registers loopback-only proxy routes. These are local app routes, not Bosch API routes. */
export const registerLocatorProxy = (app: Express): void => {
  app.post('/locator/configure', handle((request) => proxy.configure(request.body)));
  app.post('/locator/test', handle(() => proxy.test()));
  app.post('/locator/login', handle((request) => proxy.login(request.body?.username, request.body?.password)));
  app.post('/locator/auto-login', handle(() => proxy.automaticLogin()));
  app.post('/locator/forget-credentials', handle(() => proxy.forgetAutomaticCredentials()));
  app.post('/locator/logout', handle(() => proxy.logout()));
  app.post('/locator/map/:method', handle((request) => {
    const method = request.params.method;
    if (typeof method !== 'string') throw new Error('Locator map method is invalid.');
    return proxy.mapCall(method, request.body ?? {});
  }));
};
