import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import mqtt from 'mqtt';
import { registerDelivery } from './deliveryService';
import {
  defaultMqttSettings as m,
  defaultOrderSettings as o,
  defaultPlannerOptions,
  defaultFootprint,
} from '../src/domain/defaults';
import { names, type DeliveryView } from '../src/features/pharmacy/model';
import type { VdaOrder } from '../src/domain/types';
vi.mock('mqtt', () => ({ default: { connect: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());
it('uses independent broker feedback, durable intents and revision-checked confirmations through the bridge API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-test-'));
  const orders: VdaOrder[] = [];
  const socket = Object.assign(new EventEmitter(), {
    connected: true,
    subscribe: vi.fn(),
    end: vi.fn(),
    publish: vi.fn((_topic: string, payload: string) => orders.push(JSON.parse(payload))),
  });
  vi.mocked(mqtt.connect).mockReturnValue(socket as unknown as ReturnType<typeof mqtt.connect>);
  function server() {
    let get!: (req: Request, res: Response) => void, post!: typeof get;
    const app = {
      get: (_s: string, fn: typeof get) => {
        get = fn;
      },
      post: (_s: string, fn: typeof get) => {
        post = fn;
      },
    };
    const service = registerDelivery(app as unknown as Express, dir);
    function api(op?: string, body: unknown = {}) {
      let result!: DeliveryView & { error?: string };
      const res = {
        set: () => res,
        status: () => res,
        json: (r: typeof result) => {
          result = r;
        },
      };
      (op ? post : get)(
        { params: { operation: op }, body, is: () => true } as unknown as Request,
        res as unknown as Response,
      );
      return result;
    }
    return { api, service };
  }
  const points = names.map((displayName, i) => ({
    id: 'point-' + i,
    displayName,
    enabled: true,
    mapId: i < 4 ? 'p' : 'u',
    x: 2 + (i % 4),
    y: 3,
    theta: 0,
  }));
  const setup = {
    points,
    mqttSettings: { ...m, password: 'fixture-only-secret' },
    orderSettings: o,
    footprint: defaultFootprint,
    plannerOptions: defaultPlannerOptions,
    nodeLimit: 500,
    plannerMode: 'automatic',
  };
  let live = server(),
    now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const deliver = (topic: string, data: unknown, retain = false) =>
    socket.emit('message', topic, Buffer.from(JSON.stringify(data)), { retain });
  const identity = {
    manufacturer: o.manufacturer,
    serialNumber: o.serialNumber,
    version: o.version,
  };
  const state = (i: number, extra: object = {}, retained = false) => {
    now += 10;
    deliver(
      m.topics.state,
      {
        ...identity,
        timestamp: new Date(now).toISOString(),
        agvPosition: { ...points[i], positionInitialized: true },
        driving: false,
        paused: false,
        operatingMode: 'AUTOMATIC',
        nodeStates: [],
        edgeStates: [],
        errors: [],
        safetyState: { eStop: 'NONE', fieldViolation: false },
        orderUpdateId: 0,
        ...extra,
      },
      retained,
    );
  };
  try {
    for (const mapId of ['p', 'u'])
      expect(
        live.api('map', {
          locatorMapName: mapId,
          grid: {
            metadata: {
              mapId,
              name: mapId,
              width: 80,
              height: 60,
              resolution: 0.1,
              origin: { x: 0, y: 0, yaw: 0 },
              occupiedThreshold: 0.65,
              freeThreshold: 0.19,
              negate: false,
            },
            data: Array(4800).fill(0),
          },
        }).error,
      ).toBeUndefined();
    const prepared = live.api('prepare', setup).prepared;
    expect(prepared).toBeTruthy();
    deliver(m.topics.connection, {
      ...identity,
      headerId: 1,
      timestamp: new Date(now).toISOString(),
      connectionState: 'ONLINE',
    });
    state(0, {}, true);
    expect(live.api('start', { prepared, points }).error).toMatch(/offline|stale/);
    state(0);
    state(0, { timestamp: 'invalid' });
    expect(live.api('start', { prepared, points }).error).toMatch(/offline|stale/);
    state(0);
    expect(live.api('start', { prepared, points }).run?.phase).toBe('VALIDATING_ROUTE');
    expect(live.api('manual-order').error).toMatch(/owns/);
    state(0);
    state(0);
    expect(orders).toHaveLength(1);
    const order = orders[0]!,
      last = order.nodes.at(-1)!;
    state(1, {
      orderId: order.orderId,
      lastNodeId: last.nodeId,
      lastNodeSequenceId: last.sequenceId,
    });
    const pending = live.api().run!;
    expect(pending.phase).toBe('WAITING_FOR_MEDICINE_LOADING');
    expect(live.api().run).toEqual(pending);
    expect(readFileSync(join(dir, 'setup.json'), 'utf8')).not.toContain('fixture-only-secret');
    expect(
      live.api('waypoints', { id: pending.id, revision: 0, points: points.slice(1) }).run?.phase,
    ).toBe('RECOVERY_REQUIRED');
    live.service.close();
    live = server();
    expect(live.api().run?.phase).toBe('RECOVERY_REQUIRED');
    expect(live.api('confirm', { id: pending.id, revision: pending.revision }).error).toMatch(
      /Obsolete/,
    );
    expect(orders).toHaveLength(1);
  } finally {
    live.service.close();
  }
});
