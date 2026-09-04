import type { LocatorConnectionSettings } from '../types';

interface ProxyEnvelope<T> { ok: boolean; data?: T; error?: string; kind?: string; code?: number | string }

/** Typed browser client for the local security proxy, never the Bosch server directly. */
export class LocatorRpcClient {
  public constructor(private readonly baseUrl = 'http://127.0.0.1:8787') {}

  public configure(settings: LocatorConnectionSettings): Promise<{ configured: true; insecureDevelopmentMode: boolean }> {
    return this.post('/locator/configure', {
      host: settings.host,
      port: settings.port,
      https: settings.https,
      endpoint: settings.rpcEndpoint,
      timeoutMs: settings.requestTimeoutMs,
      caCertificatePem: settings.caCertificatePem || undefined,
      insecureDevelopmentMode: settings.insecureDevelopmentMode,
    });
  }

  public post<T>(path: string, body: unknown = {}): Promise<T> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (response) => {
      let envelope: ProxyEnvelope<T>;
      try {
        envelope = await response.json() as ProxyEnvelope<T>;
      } catch {
        throw new Error(`Local Locator proxy returned malformed JSON (HTTP ${response.status}).`);
      }
      if (!response.ok || !envelope.ok || envelope.data === undefined) {
        throw new Error(envelope.error ?? `Local Locator proxy failed with HTTP ${response.status}.`);
      }
      return envelope.data;
    });
  }
}
