import type { IRouter } from 'express';
import mqtt, { type MqttClient } from 'mqtt';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DeliveryEngine } from './deliveryEngine';
import { bindLocations, mapSchema, type Config } from './deliveryPlanning';
import { terminal, type DeliveryRun, type DeliveryView } from '../src/features/pharmacy/model';
import {
  defaultOrderSettings,
  defaultFootprint,
  defaultPlannerOptions,
  defaultMqttSettings,
} from '../src/domain/defaults';
import { parseSettingsFile } from '../src/features/settings/settingsFile';
import { vdaConnectionSchema, vdaStateSchema } from '../src/schemas/vdaSchemas';
import { payloadMatchesRobotIdentity } from '../src/domain/robot/ActiveMapResolver';
import { InstantActionBuilder } from '../src/domain/vda5050/InstantActionBuilder';
import type { MqttSettings, OccupancyGrid } from '../src/domain/types';

type Setup = Omit<Config, 'maps'> & { broker: Omit<MqttSettings, 'password'> };
interface Journal {
  run?: DeliveryRun;
  archive: DeliveryRun[];
}
export function registerDelivery(
  app: IRouter,
  dir = resolve(process.env.MISSION_DATA_DIR ?? 'data/pharmacy-delivery'),
) {
  const read = <T>(key: string, fallback: T): T =>
    existsSync(join(dir, key)) ? (JSON.parse(readFileSync(join(dir, key), 'utf8')) as T) : fallback;
  function write(key: string, value: unknown) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, key),
      tmp = path + '.' + randomUUID() + '.tmp';
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    if (process.platform !== 'win32') {
      const d = openSync(dir, 'r');
      try {
        fsyncSync(d);
      } finally {
        closeSync(d);
      }
    }
  }
  let maps = read<Record<string, OccupancyGrid>>('maps.json', {}),
    setup = read<Setup | undefined>('setup.json', undefined);
  let journal = read<Journal>('runs.json', { archive: [] });
  let engine: DeliveryEngine | undefined,
    client: MqttClient | undefined,
    prepared: string | undefined,
    problem: string | undefined;
  let lastManualOrder = 0;
  const active = () => !!engine?.run && !terminal(engine.run);
  function send(topic: string, payload: unknown) {
    if (!client?.connected || !engine?.online) throw Error('Robot broker unavailable.');
    const owner = engine,
      id = owner.run?.id;
    client.publish(
      topic,
      JSON.stringify(payload),
      { qos: setup!.broker.qos, retain: false },
      (error) => {
        if (error && owner === engine && owner.run?.id === id)
          owner.suspend('MQTT handoff uncertain: ' + error.message);
      },
    );
  }
  function create(restored?: DeliveryRun) {
    if (!setup) throw Error('Missing mission configuration.');
    const c = { ...setup, maps };
    engine = new DeliveryEngine(
      c,
      {
        now: Date.now,
        save: (r) => {
          const archive =
            journal.run && journal.run.id !== r.id
              ? [journal.run, ...journal.archive]
              : journal.archive;
          const next = { run: r, archive };
          write('runs.json', next);
          journal = next;
        },
        send: (o) => send(c.broker.topics.order, o),
        cancel: (id) => {
          const action = new InstantActionBuilder().build('cancelOrder', c.orderSettings);
          action.actions[0]!.actionId = id;
          send(c.broker.topics.instantActions, action);
        },
      },
      restored,
    );
  }
  if (journal.run && !terminal(journal.run)) create(journal.run);
  function connect(password: string) {
    const old = client;
    client = undefined;
    old?.end(true);
    const owner = engine!,
      c = setup!,
      m = c.broker;
    owner.disconnect();
    problem = undefined;
    const protocol = m.transport === 'tcp' ? (m.tls ? 'mqtts' : 'mqtt') : m.tls ? 'wss' : 'ws';
    const socket = mqtt.connect(
      `${protocol}://${m.host}:${m.port}${m.transport === 'ws' ? m.websocketPath : ''}`,
      {
        username: m.username || undefined,
        password: password || undefined,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 0,
        queueQoSZero: false,
        rejectUnauthorized: m.rejectUnauthorized,
        connectTimeout: m.connectTimeoutMs,
        keepalive: m.keepalive,
      },
    );
    client = socket;
    socket.on('connect', () => {
      if (client === socket)
        socket.subscribe(
          [m.topics.connection, m.topics.state],
          { qos: m.subscriptionQos },
          (err) => {
            if (err && client === socket) {
              problem = err.message;
              owner.disconnect();
            }
          },
        );
    });
    socket.on('close', () => {
      if (client === socket) owner.disconnect();
    });
    socket.on('error', (err) => {
      if (client === socket) {
        problem = err.message;
        owner.disconnect();
      }
    });
    socket.on('message', (topic, bytes, packet) => {
      if (client !== socket || !socket.connected) return;
      try {
        const raw: unknown = JSON.parse(bytes.toString());
        if (topic === m.topics.connection) {
          const data = vdaConnectionSchema.parse(raw);
          if (!payloadMatchesRobotIdentity(data, c.orderSettings)) return;
          if (data.connectionState === 'ONLINE') owner.online = true;
          else owner.disconnect();
        } else if (topic === m.topics.state && owner.online && !packet.retain) {
          const state = vdaStateSchema.parse(raw);
          if (!payloadMatchesRobotIdentity(state, c.orderSettings)) return;
          const source = Date.parse(state.timestamp ?? ''),
            now = Date.now();
          if (
            !Number.isFinite(source) ||
            source > now ||
            now - source > c.orderSettings.stateStaleTimeoutMs
          ) {
            owner.frame = undefined;
            owner.suspend('State timestamp is stale or inconsistent with the bridge clock.');
            return;
          }
          owner.feedback({ state, source, received: now });
          problem = undefined;
        }
      } catch (e) {
        problem = String(e);
        owner.frame = undefined;
        owner.suspend('Invalid Navigator feedback or journal failure. Review required.');
      }
    });
  }
  const timer = setInterval(() => engine?.tick(), 300);
  timer.unref();
  const view = (): DeliveryView => {
    const f = engine?.frame,
      fresh = !!f && Date.now() - f.source <= (setup?.orderSettings.stateStaleTimeoutMs ?? 0);
    let readiness: string | undefined;
    if (prepared && engine) {
      try {
        engine.preflight();
      } catch (e) {
        readiness = e instanceof Error ? e.message : String(e);
      }
    }
    return {
      readiness,
      speed: setup?.orderSettings.missionMaximumSpeedMps,
      run: journal.run,
      archive: journal.archive,
      maps: Object.keys(maps),
      prepared,
      connected: !!client?.connected && !!engine?.online,
      floor: fresh ? f?.state.agvPosition?.mapId : undefined,
      localisation:
        fresh && f?.state.agvPosition?.positionInitialized
          ? 'Fresh initialized state pose'
          : 'Fresh initialized pose unavailable',
      problem,
    };
  };
  app.get('/api/delivery', (_req, res) => res.set('Cache-Control', 'no-store').json(view()));
  app.post('/api/delivery/:operation', (req, res) => {
    try {
      if (!req.is('application/json')) throw Error('A JSON operator request is required.');
      const b = req.body,
        op = req.params.operation;
      if (op === 'manual-order') {
        if (active()) throw Error('The delivery mission owns order dispatch.');
        lastManualOrder = Date.now();
        prepared = undefined;
        res.json({ permitted: true });
        return;
      } else if (op === 'map') {
        if (active()) throw Error('Active mission maps are frozen.');
        const grid = mapSchema.parse(b.grid);
        if (grid.metadata.mapId !== b.locatorMapName)
          throw Error('Register a matching Locator raster.');
        const next = { ...maps, [grid.metadata.mapId]: grid };
        write('maps.json', next);
        maps = next;
        prepared = undefined;
      } else if (op === 'prepare') {
        if (active()) throw Error('Review the active mission first.');
        const defaults = {
          mqttSettings: defaultMqttSettings,
          plannerOptions: defaultPlannerOptions,
          footprint: defaultFootprint,
          orderSettings: defaultOrderSettings,
        };
        for (const k of Object.keys(defaults))
          if (!b[k]) throw Error('Incomplete operator configuration.');
        const settings = { ...defaults, ...parseSettingsFile(JSON.stringify(b), defaults) };
        const broker = settings.mqttSettings;
        if (
          !broker.host ||
          Object.values(broker.topics).some((t) => !t || /[+#]/.test(t)) ||
          new Set(Object.values(broker.topics)).size !== 5
        )
          throw Error('Invalid robot topic configuration.');
        const config = bindLocations(b.points, {
          ...settings,
          maps,
          nodeLimit: z.number().int().positive().parse(b.nodeLimit),
          plannerMode: z
            .enum(['manual', 'automatic', 'hybrid', 'motion-state'])
            .parse(b.plannerMode),
        });
        const minQuality =
          process.env.DELIVERY_MIN_LOCALIZATION_SCORE === undefined
            ? undefined
            : z.coerce.number().min(0).max(1).parse(process.env.DELIVERY_MIN_LOCALIZATION_SCORE);
        const next: Setup = {
          minQuality,
          points: config.points,
          footprint: config.footprint,
          plannerOptions: config.plannerOptions,
          orderSettings: config.orderSettings,
          plannerMode: config.plannerMode,
          nodeLimit: config.nodeLimit,
          broker: { ...broker },
        };
        write('setup.json', next);
        setup = next;
        create();
        prepared = randomUUID();
        connect(String(b.mqttSettings.password ?? ''));
      } else if (op === 'start') {
        if (!prepared || b.prepared !== prepared || !engine || active())
          throw Error('Repeat preflight before authorizing.');
        if (
          lastManualOrder &&
          (!engine.frame ||
            engine.frame.source <=
              lastManualOrder + engine.config.orderSettings.acceptanceTimeoutMs)
        )
          throw Error('Await fresh robot feedback after the previous manual handoff.');
        const bound = bindLocations(b.points, engine.config);
        if (JSON.stringify(bound.points) !== JSON.stringify(engine.config.points))
          throw Error('Waypoint configuration changed. Repeat preflight.');
        engine.start();
        prepared = undefined;
      } else {
        if (!engine) throw Error('No recoverable mission in this session.');
        // Waypoint observations may arrive after a state transition. They can
        // suspend this same run, but cannot authorize a step or an order.
        engine.guard(b.id, op === 'waypoints' ? (engine.run?.revision ?? -1) : b.revision);
        if (op === 'confirm') engine.confirm(b.id, b.revision);
        else if (op === 'cancel') engine.cancel(b.id, b.revision);
        else if (op === 'review') {
          const bound = bindLocations(b.points, engine.config);
          if (JSON.stringify(bound.points) !== JSON.stringify(engine.config.points))
            throw Error('Restore the authorized waypoint configuration or end this run.');
          engine.review(b.id, b.revision);
        } else if (op === 'waypoints') {
          try {
            const bound = bindLocations(b.points, engine.config);
            if (JSON.stringify(bound.points) !== JSON.stringify(engine.config.points))
              throw Error('Waypoint binding changed.');
          } catch {
            engine.suspend('A required saved waypoint changed or is missing. Review required.');
          }
        } else if (op === 'end') engine.endReviewed(b.id, b.revision);
        else if (op === 'reconnect' && engine.run?.phase === 'RECOVERY_REQUIRED')
          connect(String(b.password ?? ''));
        else throw Error('Unsupported mission operation.');
      }
      res.json(view());
    } catch (e) {
      res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  return {
    active,
    orderTopic: () => setup?.broker.topics.order,
    close: () => {
      clearInterval(timer);
      client?.end(true);
    },
  };
}
