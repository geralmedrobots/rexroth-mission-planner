import http from 'node:http';
import https from 'node:https';

export interface LocatorConnectionConfig {
  host: string;
  port: number;
  https: boolean;
  endpoint: string;
  timeoutMs: number;
  caCertificatePem?: string;
  insecureDevelopmentMode?: boolean;
}

interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  id: number;
  result?: { response?: unknown };
  error?: { code: number; message: string; data?: unknown };
}

export class LocatorRpcError extends Error {
  public constructor(
    message: string,
    public readonly kind: 'network' | 'timeout' | 'tls' | 'protocol' | 'bosch',
    public readonly code?: number | string,
  ) {
    super(message);
    this.name = 'LocatorRpcError';
  }
}

const commonResponseCodes: Record<string, string> = {
  '1': 'WARNING',
  '2': 'INTERNAL_ERROR',
  '3': 'UNKNOWN_ERROR',
  '4': 'SESSION_INVALID',
  '5': 'SESSION_EXPIRED',
  '6': 'NOT_AUTHORIZED',
  '7': 'NOT_IN_REQUIRED_STATE',
  '8': 'FEATURE_NOT_LICENSED',
  '9': 'INVALID_MESSAGE_CONTENT',
  '10': 'ENTITY_ALREADY_EXISTS',
  '11': 'ENTITY_NOT_FOUND',
  '12': 'FILE_ACCESS_FAILED',
  '13': 'SENSOR_NOT_AVAILABLE',
  '14': 'ENTITY_IN_USE',
};

const describeBoschResponseCode = (code: number | string): string => {
  const normalized = String(code);
  const common = commonResponseCodes[normalized];
  if (common) return `${common} (${normalized})`;
  try {
    const integer = BigInt(normalized);
    const module = Number(integer >> 48n);
    return `0x${integer.toString(16).padStart(16, '0')} (module 0x${module.toString(16).padStart(4, '0')})`;
  } catch {
    return normalized;
  }
};

/** Node-only Bosch JSON-RPC transport. TLS relaxation is scoped to this client. */
export class LocatorRpcClient {
  private nextRequestId = 1;

  public constructor(private readonly config: LocatorConnectionConfig) {}

  public async call<T>(method: string, query: Record<string, unknown>): Promise<T> {
    const id = this.nextRequestId++;
    const body = JSON.stringify({ jsonrpc: '2.0', method, params: { query }, id });
    const envelope = await this.request(body);
    if (envelope.id !== id || envelope.jsonrpc !== '2.0') {
      throw new LocatorRpcError('Malformed JSON-RPC response: mismatched id or version.', 'protocol');
    }
    if (envelope.error) {
      throw new LocatorRpcError(
        `JSON-RPC ${envelope.error.code}: ${envelope.error.message}`,
        'protocol',
        envelope.error.code,
      );
    }
    if (!envelope.result || !('response' in envelope.result)) {
      throw new LocatorRpcError('Malformed JSON-RPC response: result.response is missing.', 'protocol');
    }
    const response = envelope.result.response as T & { responseCode?: number | string };
    if (!response || typeof response !== 'object' || !('responseCode' in response) || response.responseCode === undefined) {
      throw new LocatorRpcError('Malformed Bosch response: responseCode is missing.', 'protocol');
    }
    const responseCode = response.responseCode;
    if (String(responseCode) !== '0') {
      throw new LocatorRpcError(`Bosch API responseCode ${describeBoschResponseCode(responseCode)}.`, 'bosch', responseCode);
    }
    return response;
  }

  private request(body: string): Promise<JsonRpcEnvelope> {
    const endpoint = this.config.endpoint.trim();
    if (!endpoint.startsWith('/')) {
      return Promise.reject(new LocatorRpcError('RPC endpoint must begin with "/".', 'protocol'));
    }
    const transport = this.config.https ? https : http;
    const options: https.RequestOptions = {
      hostname: this.config.host,
      port: this.config.port,
      path: endpoint,
      method: 'POST',
      timeout: this.config.timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    };
    if (this.config.https) {
      options.ca = this.config.caCertificatePem || undefined;
      options.rejectUnauthorized = !this.config.insecureDevelopmentMode;
    }
    return new Promise((resolve, reject) => {
      const request = transport.request(options, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new LocatorRpcError(`Locator HTTP status ${response.statusCode ?? 'unknown'}.`, 'network'));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcEnvelope;
            resolve(parsed);
          } catch (error) {
            reject(new LocatorRpcError(`Malformed JSON-RPC response: ${String(error)}`, 'protocol'));
          }
        });
      });
      request.on('timeout', () => {
        request.destroy();
        reject(new LocatorRpcError(`Locator request timed out after ${this.config.timeoutMs} ms.`, 'timeout'));
      });
      request.on('error', (error: NodeJS.ErrnoException) => {
        const tls = ['CERT_', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']
          .some((value) => error.code?.includes(value));
        reject(new LocatorRpcError(error.message, tls ? 'tls' : 'network', error.code));
      });
      request.end(body);
    });
  }
}
