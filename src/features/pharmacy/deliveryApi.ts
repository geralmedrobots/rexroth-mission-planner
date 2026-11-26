import type { DeliveryView } from './model';
export async function deliveryRequest(operation?: string, body?: unknown): Promise<DeliveryView> {
  const root = `${location.protocol === 'https:' ? 'https' : 'http'}://${location.hostname || '127.0.0.1'}:8787/api/delivery`;
  const response = await fetch(operation ? root + '/' + operation : root, {
    method: operation ? 'POST' : 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(6000),
    ...(operation
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }
      : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error ?? 'Delivery service unavailable.');
  return data as DeliveryView;
}
