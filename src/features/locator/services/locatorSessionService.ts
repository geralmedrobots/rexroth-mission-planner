import type { LocatorInstanceIdentity } from '../../../domain/map/MapSnapshots';
import { LocatorRpcClient } from '../api/locatorRpcClient';
import { SessionApi } from '../api/sessionApi';
import type { LocatorConnectionSettings, LocatorTestResult } from '../types';

export class LocatorSessionService {
  public readonly rpc: LocatorRpcClient;
  private readonly api: SessionApi;
  private instance?: LocatorInstanceIdentity;

  public constructor(rpc = new LocatorRpcClient()) {
    this.rpc = rpc;
    this.api = new SessionApi(rpc);
  }
  public async connect(settings: LocatorConnectionSettings): Promise<void> {
    const { host, port, https, rpcEndpoint } = settings;
    await this.rpc.configure(settings);
    this.instance = Object.freeze({ host: host.trim().toLowerCase(), port, https, rpcEndpoint: rpcEndpoint.trim() });
  }
  public get configuredInstance(): LocatorInstanceIdentity | undefined { return this.instance; }
  public test(): Promise<LocatorTestResult> { return this.api.test(); }
  public login(username: string, password: string): Promise<string> { return this.api.login(username, password); }
  public automaticLogin(): Promise<void> { return this.api.automaticLogin(); }
  public forgetCredentials(): Promise<void> { return this.api.forgetCredentials(); }
  public logout(): Promise<void> { return this.api.logout(); }
}

export const locatorSessionService = new LocatorSessionService();
