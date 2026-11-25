import { describe, expect, it, vi } from 'vitest';
import { alignedReverseRequest } from './fixtures/reverseChoiceAudit';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import { normalizeAngle } from '../domain/geometry/angles';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import { VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { defaultOrderSettings } from '../domain/defaults';
import { outgoingMotionDiagnostics } from '../domain/vda5050/MotionExecutionDiagnostics';
import { MqttService } from '../services/MqttService';
import { buildSpeedCycleDiagnostic, formatSpeedCycleDiagnostic } from '../domain/robot/SpeedLimitDiagnostics';
import { vdaStateSchema } from '../schemas/vdaSchemas';
import { LogService } from '../services/LogService';

function reverseOrder(theta: number, reverse = true) {
  const request = alignedReverseRequest(.01, .01, false);
  request.exactStartPose = { x: 3, y: 2, theta };
  const sign = reverse ? -1 : 1;
  request.exactGoalPose = { x: 3 + sign * Math.cos(theta), y: 2 + sign * Math.sin(theta), theta };
  request.goal = new CoordinateTransformer(request.grid.metadata)
    .worldToGrid(request.exactGoalPose.x, request.exactGoalPose.y)!;
  const result = new MotionStatePlanner().plan(request);
  expect(result.success).toBe(true);
  const order = new VdaOrderBuilder().build(result.finalPath, {
    robotPose: { ...request.exactStartPose, mapId: request.grid.metadata.mapId, positionInitialized: true },
    activeMapId: request.grid.metadata.mapId, motionPlan: result.motionPlan,
    corridorPlanning: { grid: request.grid, footprint: request.footprint, plannerOptions: request.options },
  }, defaultOrderSettings, 'reverse-execution-test');
  return { result, order };
}

describe('MotionPlan to VDA execution intent', () => {
  it.each([0, -140 * Math.PI / 180])('encodes reverse without a body reorientation at theta %s', (theta) => {
    const logs: string[] = [];
    const stop = LogService.subscribe((entry) => logs.push(entry.message));
    let built: ReturnType<typeof reverseOrder>;
    try { built = reverseOrder(theta); } finally { stop(); }
    const { result, order } = built;
    expect(result.motionPlan!.actions.map((a) => a.type)).toEqual(['DIRECTION_CHANGE', 'TRANSLATE_REVERSE']);
    const wire = JSON.parse(JSON.stringify(order)) as typeof order;
    expect(wire.nodes).toHaveLength(3);
    expect(wire.nodes.every((node) => Math.abs(normalizeAngle(node.nodePosition.theta - theta)) < 1e-7)).toBe(true);
    // The coincident edge is not a protocol gear-change command.
    expect(wire.edges[0]!.actions).toEqual([]);
    expect(wire.edges[0]!.orientation).toBeUndefined();
    const edge = wire.edges[1]!;
    expect(edge.orientation).toBe(Math.PI);
    const from = wire.nodes[1]!.nodePosition, to = wire.nodes[2]!.nodePosition;
    const bearing = Math.atan2(to.y - from.y, to.x - from.x);
    // Independent protocol interpretation: body = tangent + edge orientation.
    expect(Math.abs(normalizeAngle(bearing + edge.orientation! - theta))).toBeLessThan(1e-7);
    expect(Math.cos(edge.orientation!)).toBe(-1);
    expect(edge.maxSpeed).toBe(defaultOrderSettings.missionMaximumSpeedMps);
    expect(edge.maxSpeed).toBeGreaterThan(0);
    expect(outgoingMotionDiagnostics(JSON.stringify(order))[1]!.encodedMotionSign).toBe(-1);
    expect(logs.some((log) => log.includes('"reverseIntentExplicitlyEncoded":true'))).toBe(true);
  });

  it('explicitly encodes forward and leaves rotation actions unchanged', () => {
    const { order } = reverseOrder(0, false);
    expect(order.edges).toHaveLength(1);
    expect(order.edges[0]!.orientation).toBe(0);
  });

  it('preserves orientation in the actual MQTT client payload', async () => {
    const { order } = reverseOrder(0);
    const publish = vi.fn((_topic, _payload, _options, callback) => callback());
    const service = new MqttService();
    Object.assign(service, { settings: { topics: { order: 'test/order' } },
      mqttClient: { connected: true, publish } });
    const payload = JSON.stringify(order);
    await service.publish('test/order', payload, 1, false);
    expect(publish.mock.calls[0]![1]).toBe(payload);
    expect(JSON.parse(publish.mock.calls[0]![1]).edges[1].orientation).toBe(Math.PI);
  });

  it('preserves orientation in the TCP bridge envelope', async () => {
    const { order } = reverseOrder(-140 * Math.PI / 180);
    const send = vi.fn();
    const service = new MqttService();
    Object.assign(service, { settings: { topics: { order: 'test/order' } },
      bridge: { readyState: WebSocket.OPEN, send } });
    const payload = JSON.stringify(order);
    await service.publish('test/order', payload);
    expect(JSON.parse(send.mock.calls[0]![0]).payload).toBe(payload);
  });

  it('preserves negative measured and command velocities without inventing missing PLC feedback', () => {
    const state = vdaStateSchema.parse({ velocity: { vx: -.2, vy: 0, omega: 0 } });
    const diagnostic = buildSpeedCycleDiagnostic(state, { motionCommand: { v_x: -.25 } });
    expect(diagnostic.velocityX).toBe(-.2);
    expect(diagnostic.commandVelocityX).toBe(-.25);
    expect(formatSpeedCycleDiagnostic(diagnostic)).toContain('commandLongitudinalSign=-1');
    expect(formatSpeedCycleDiagnostic(diagnostic)).toContain('observedLongitudinalSign=-1');
    expect(buildSpeedCycleDiagnostic(state, {}).commandVelocityX).toBeNull();
  });
});
