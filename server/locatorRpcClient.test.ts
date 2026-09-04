// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LocatorRpcClient } from './locatorRpcClient';

describe('LocatorRpcClient JSON-RPC transport', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()));

  it('uses params.query and monotonically increasing request IDs', async () => {
    const requests: Array<Record<string, unknown>> = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        requests.push(body);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { response: { responseCode: 0, accepted: true } },
        }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address unavailable.');
    const client = new LocatorRpcClient({
      host: '127.0.0.1',
      port: address.port,
      https: false,
      endpoint: '/',
      timeoutMs: 1000,
    });
    await client.call('aboutBuildVersion', {});
    await client.call('serverMapGetInfo', { sessionId: 'session', serverMapName: 'Map-A' });
    expect(requests[0]).toEqual({
      jsonrpc: '2.0', method: 'aboutBuildVersion', params: { query: {} }, id: 1,
    });
    expect(requests[1]).toEqual({
      jsonrpc: '2.0',
      method: 'serverMapGetInfo',
      params: { query: { sessionId: 'session', serverMapName: 'Map-A' } },
      id: 2,
    });
  });
});
