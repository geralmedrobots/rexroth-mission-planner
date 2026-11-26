import { describe, it, expect, vi } from 'vitest';
import { DeliveryEngine } from './deliveryEngine';
import { bindLocations, planLeg, type Frame } from './deliveryPlanning';
import { names, steps, type DeliveryRun, type BoundPoint } from '../src/features/pharmacy/model';
import {
  defaultFootprint,
  defaultPlannerOptions,
  defaultOrderSettings,
} from '../src/domain/defaults';
import type { OccupancyGrid, VdaState, VdaOrder } from '../src/domain/types';
import { VdaOrderBuilder } from '../src/domain/vda5050/VdaOrderBuilder';

function settings() {
  const grid = (id: string): OccupancyGrid => ({
    metadata: {
      mapId: id,
      name: id,
      width: 100,
      height: 60,
      resolution: 0.1,
      origin: { x: 0, y: 0, yaw: 0 },
      occupiedThreshold: 0.65,
      freeThreshold: 0.19,
      negate: false,
    },
    data: Array(6000).fill(0),
  });
  const points = names.map((n, i) => ({
    displayName: n,
    id: 'waypoint-' + i,
    mapId: i < 4 ? 'pharmacy' : 'urgencies',
    x: 2 + (i % 4) * 1.4,
    y: 3,
    theta: 0,
    enabled: true,
  }));
  const base = {
    maps: { pharmacy: grid('pharmacy'), urgencies: grid('urgencies') },
    footprint: defaultFootprint,
    plannerOptions: defaultPlannerOptions,
    orderSettings: defaultOrderSettings,
    plannerMode: 'automatic' as const,
    nodeLimit: 1000,
  };
  return { points, base };
}
function fixture() {
  const { points, base } = settings(),
    config = bindLocations(points, base);
  let now = 10000;
  const orders: VdaOrder[] = [],
    saved: DeliveryRun[] = [];
  const send = vi.fn((o: VdaOrder) => {
    expect(saved.at(-1)?.order?.id).toBe(o.orderId);
    orders.push(o);
  });
  const plan = vi.fn((c: typeof config, f: Frame, target: BoundPoint) =>
    new VdaOrderBuilder().build(
      [f.state.agvPosition!, target],
      { robotPose: f.state.agvPosition!, activeMapId: target.mapId, finalGoalTheta: target.theta },
      c.orderSettings,
    ),
  );
  const ports = {
    now: () => now,
    save: (r: DeliveryRun) => saved.push(structuredClone(r)),
    send,
    cancel: vi.fn(),
    plan,
    validate: vi.fn(),
  };
  let engine = new DeliveryEngine(config, ports);
  engine.online = true;
  let state: VdaState = {
    operatingMode: 'AUTOMATIC',
    driving: false,
    paused: false,
    errors: [],
    nodeStates: [],
    edgeStates: [],
    orderId: '',
    orderUpdateId: 0,
    safetyState: { eStop: 'NONE', fieldViolation: false },
    agvPosition: { ...points[0]!, positionInitialized: true },
  };
  function feedback(patch: Partial<VdaState> = {}) {
    now += 10;
    state = { ...state, ...patch };
    engine.feedback({ state, source: now, received: now });
  }
  function confirm() {
    const r = engine.run!;
    engine.confirm(r.id, r.revision);
  }
  function arrive() {
    feedback();
    feedback();
    const order = orders.at(-1)!,
      last = order.nodes.at(-1)!;
    feedback({
      orderId: order.orderId,
      lastNodeId: last.nodeId,
      lastNodeSequenceId: last.sequenceId,
      agvPosition: {
        ...last.nodePosition,
        theta: last.nodePosition.theta!,
        positionInitialized: true,
      },
    });
  }
  feedback();
  engine.start();
  return {
    get engine() {
      return engine;
    },
    orders,
    ports,
    config,
    feedback,
    arrive,
    confirm,
    get state() {
      return state;
    },
    now: () => now,
    restart: () => {
      engine = new DeliveryEngine(config, ports, saved.at(-1));
      engine.online = true;
      feedback();
    },
    timeout: () => {
      now += config.orderSettings.stateStaleTimeoutMs + 1;
      engine.tick();
    },
  };
}
describe('authoritative delivery sequence', () => {
  it('executes outbound and return in order, requiring all six checkpoints and two localisations', () => {
    const f = fixture(),
      checkpoints: string[] = [];
    for (let i = 0; i < 40 && f.engine.run!.phase !== 'COMPLETED'; i++) {
      const r = f.engine.run!,
        step = steps[r.index]!;
      if (step.kind === 'navigate') {
        f.arrive();
        continue;
      }
      if (step.kind === 'confirm' || step.kind === 'transition') {
        const before = f.orders.length;
        f.feedback();
        expect(f.orders).toHaveLength(before);
        checkpoints.push(step.prompt);
        f.confirm();
        if (step.kind === 'transition') {
          f.feedback();
          expect(f.engine.run!.phase).toBe('VERIFYING_LOCALISATION');
          const expected = f.config.points[step.destination!];
          f.feedback({ agvPosition: { ...expected, positionInitialized: true } });
        }
      } else f.feedback();
    }
    expect(f.engine.run).toMatchObject({
      phase: 'COMPLETED',
      lastVerified: names[0],
      charging: undefined,
    });
    expect(checkpoints).toEqual(steps.flatMap((s) => ('prompt' in s ? [s.prompt] : [])));
    const legs = steps.filter((s) => s.kind === 'navigate');
    expect(f.orders).toHaveLength(9);
    f.orders.forEach((o, i) => {
      const target = f.config.points[legs[i]!.at];
      expect(o.nodes.at(-1)?.nodePosition).toMatchObject({ x: target.x, mapId: target.mapId });
      expect(new Set(o.nodes.map((n) => n.nodePosition.mapId)).size).toBe(1);
    });
  });
  it('localisation before floor confirmation never releases the elevator exit', () => {
    const f = fixture();
    f.arrive();
    f.confirm();
    f.arrive();
    f.confirm();
    f.arrive();
    f.feedback({ agvPosition: { ...f.config.points[names[4]], positionInitialized: true } });
    expect(f.engine.run!.phase).toBe('WAITING_FOR_FLOOR_TRANSITION');
    expect(f.orders).toHaveLength(3);
    f.confirm();
    f.feedback();
    expect(f.engine.run!.phase).toBe('VALIDATING_ROUTE');
  });
  it('refresh reads the same pending checkpoint and duplicate / stale confirmation is rejected', () => {
    const f = fixture();
    f.arrive();
    const snapshot = JSON.parse(JSON.stringify(f.engine.run)) as DeliveryRun;
    f.feedback();
    expect(f.engine.run!.revision).toBe(snapshot.revision);
    f.engine.confirm(snapshot.id, snapshot.revision);
    expect(() => f.engine.confirm(snapshot.id, snapshot.revision)).toThrow(/Obsolete/);
  });
  it('restart preserves an unconfirmed checkpoint and demands review before displaying it again', () => {
    const f = fixture();
    f.arrive();
    f.restart();
    expect(f.engine.run!.phase).toBe('RECOVERY_REQUIRED');
    const r = f.engine.run!;
    f.engine.review(r.id, r.revision);
    expect(f.engine.run!.phase).toBe('WAITING_FOR_MEDICINE_LOADING');
    expect(f.orders).toHaveLength(1);
  });
  it('journals an order before sending, ignores duplicate feedback and never republishes on restart', () => {
    const f = fixture();
    f.feedback();
    f.feedback();
    f.feedback();
    expect(f.orders).toHaveLength(1);
    f.restart();
    f.feedback();
    const r = f.engine.run!;
    expect(() => f.engine.review(r.id, r.revision)).toThrow(/completed order/);
    expect(f.orders).toHaveLength(1);
  });
  it.each([
    'disconnect',
    'stale pose',
    'wrong map',
    'uninitialised pose',
    'e-stop',
    'field violation',
    'robot fault',
    'wrong arrival',
  ])('suspends on %s', (reason) => {
    const f = fixture(),
      pose = f.state.agvPosition!;
    if (reason === 'disconnect') {
      f.engine.disconnect();
      f.engine.online = true;
      f.feedback();
    }
    if (reason === 'stale pose') f.timeout();
    if (reason === 'wrong map') f.feedback({ agvPosition: { ...pose, mapId: 'urgencies' } });
    if (reason === 'uninitialised pose')
      f.feedback({ agvPosition: { ...pose, positionInitialized: false } });
    if (reason === 'e-stop')
      f.feedback({ safetyState: { eStop: 'MANUAL', fieldViolation: false } });
    if (reason === 'field violation')
      f.feedback({ safetyState: { eStop: 'NONE', fieldViolation: true } });
    if (reason === 'robot fault')
      f.feedback({ errors: [{ errorType: 'fault', errorLevel: 'FATAL' }] });
    if (reason === 'wrong arrival') {
      f.feedback();
      f.feedback();
      const o = f.orders[0]!,
        last = o.nodes.at(-1)!;
      f.feedback({
        orderId: o.orderId,
        lastNodeId: last.nodeId,
        lastNodeSequenceId: last.sequenceId,
      });
    }
    expect(f.engine.run!.phase).toBe('RECOVERY_REQUIRED');
  });
  it('requires the commissioned score when available and cannot release an invalid floor pose after confirmation', () => {
    const f = fixture();
    f.arrive();
    f.confirm();
    f.arrive();
    f.confirm();
    f.arrive();
    f.confirm();
    f.config.minQuality = 0.8;
    f.feedback({
      agvPosition: {
        ...f.config.points[names[4]],
        positionInitialized: true,
        ...{ localizationScore: 0.6 },
      },
    });
    expect(f.engine.run!.phase).toBe('RECOVERY_REQUIRED');
    expect(f.orders).toHaveLength(3);
  });
  it('rejects failed route validation before handing any order to MQTT', () => {
    const f = fixture();
    f.ports.validate.mockImplementation(() => {
      throw Error('Invalid segment');
    });
    f.feedback();
    f.feedback();
    expect(f.orders).toHaveLength(0);
    expect(f.engine.run!.reason).toMatch(/Invalid segment/);
  });
  it('rejects stale arrival evidence, requires matching cancellation feedback and a stationary robot', () => {
    const f = fixture();
    f.feedback();
    f.feedback();
    const o = f.orders[0]!,
      last = o.nodes.at(-1)!;
    f.engine.feedback({
      source: f.now() - 20,
      received: f.now(),
      state: {
        ...f.state,
        orderId: o.orderId,
        lastNodeSequenceId: last.sequenceId,
        lastNodeId: last.nodeId,
      },
    });
    expect(f.engine.run!.phase).toBe('NAVIGATING');
    f.feedback({ orderId: o.orderId, driving: true, edgeStates: [{}] });
    const r = f.engine.run!;
    f.engine.cancel(r.id, r.revision);
    const cancelId = f.engine.run!.cancelId;
    expect(f.ports.cancel).toHaveBeenCalledWith(cancelId);
    f.feedback({ actionStates: [{ actionId: cancelId, actionStatus: 'FINISHED' }] });
    expect(f.engine.run!.phase).toBe('CANCELLING');
    f.feedback({ driving: false, edgeStates: [] });
    expect(f.engine.run!.phase).toBe('CANCELLED');
  });
  it.each(['missing', 'invalid', 'same floor', 'duplicate', 'missing heading'])(
    'rejects %s waypoint configuration',
    (reason) => {
      const { points, base } = settings();
      if (reason === 'missing') points.pop();
      if (reason === 'invalid') points[1]!.x = -1;
      if (reason === 'same floor') points.forEach((p) => (p.mapId = 'pharmacy'));
      if (reason === 'duplicate') points.push(points[0]!);
      if (reason === 'missing heading') Object.assign(points[0]!, { thetaExplicit: false });
      expect(() => bindLocations(points, base)).toThrow();
    },
  );
  it('passes a real same-floor leg through planner, VDA builder and live dispatch validator', () => {
    const f = fixture();
    const order = planLeg(f.config, f.engine.frame!, f.config.points[names[1]], f.now());
    expect(order.nodes.at(-1)?.nodePosition.mapId).toBe('pharmacy');
    expect(() => planLeg(f.config, f.engine.frame!, f.config.points[names[4]], f.now())).toThrow(
      /Cross-floor/,
    );
  });
});
