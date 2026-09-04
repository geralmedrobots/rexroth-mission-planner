import { LocatorRpcClient } from '../api/locatorRpcClient';
import { SessionApi } from '../api/sessionApi';
import type { LocatorConnectionSettings, LocatorTestResult } from '../types';

export class LocatorSessionService {
  public readonly rpc: LocatorRpcClient;
  private readonly api: SessionApi;

  public constructor(rpc = new LocatorRpcClient()) {
    this.rpc = rpc;
    this.api = new SessionApi(rpc);
  }
  public async connect(settings: LocatorConnectionSettings): Promise<void> {
    await this.rpc.configure(settings);
  }
  public test(): Promise<LocatorTestResult> { return this.api.test(); }
  public login(username: string, password: string): Promise<string> { return this.api.login(username, password); }
  public automaticLogin(): Promise<void> { return this.api.automaticLogin(); }
  public forgetCredentials(): Promise<void> { return this.api.forgetCredentials(); }
  public logout(): Promise<void> { return this.api.logout(); }
}

export const locatorSessionService = new LocatorSessionService();
