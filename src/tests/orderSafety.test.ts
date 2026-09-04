import { describe, expect, it, vi } from 'vitest';
import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../domain/defaults';
import { normalizeAngle } from '../domain/geometry/angles';
import { MissionMonitor } from '../domain/order/MissionMonitor';
import {
  appendErrorHistory, deduplicateRokitErrors, newlyRaisedRokitErrors,
} from '../domain/robot/RokitErrors';
import { selectCurrentRobotPose } from '../domain/robot/RobotPoseSelector';
import type { OccupancyGrid, RobotPose, VdaError } from '../domain/types';
import { InstantActionBuilder, isInstantActionSupported } from '../domain/vda5050/InstantActionBuilder';
import { getOrderGenerationIssues } from '../domain/vda5050/OrderGenerationGuard';
import { removeInitialDuplicatePoints, VdaOrderBuilder } from '../domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator, type OrderValidationContext } from '../domain/vda5050/VdaOrderValidator';

const robotPose: RobotPose = {
  x: 2.685, y: 1.489, theta: -1.330, mapId: 'active-map', positionInitialized: true,
};
const path = [
  { x: 2.686, y: 1.490, theta: -0.785 },
  { x: 3.000, y: 1.174, theta: -0.785 },
  { x: 3.600, y: 0.900, theta: 0.2 },
];
const grid: OccupancyGrid = {
  metadata: {
    name: 'active-map', mapId: 'active-map', width: 100, height: 100, resolution: 0.1,
    origin: { x: 0, y: 0, yaw: 0 }, occupiedThreshold: 65, freeThreshold: 20, negate: false,
  },
  data: new Array(10_000).fill(0),
};
const footprint = { ...defaultFootprint, length: 0.01, width: 0.01, safetyMargin: 0, inflationRadius: 0 };
const readyContext = (pose = robotPose): OrderValidationContext => ({
  mqttConnected: true,
  stateReceived: true,
  connectionReceived: true,
  connectionOnline: true,
  operatingMode: 'AUTOMATIC',
  stateAgeMs: 10,
  visualizationAgeMs: 5,
  positionInitialized: true,
  poseSource: 'state',
  activeMapId: 'active-map',
  locatorMapName: 'active-map',
  currentPose: pose,
  grid,
  footprint,
  settings: defaultOrderSettings,
});
const build = () => new VdaOrderBuilder().build(
  path,
  { robotPose, activeMapId: 'active-map' },
  defaultOrderSettings,
);

describe('exact live-pose VDA start', () => {
  it('regresses the confirmed non-trivially-reachable failure', () => {
    const order = build();
    expect(order.nodes[0]?.nodePosition).toMatchObject({ x: 2.685, y: 1.489, theta: -1.330 });
    expect(order.nodes[0]?.nodePosition.theta).not.toBeCloseTo(-0.785);
    expect(Math.abs(normalizeAngle(order.nodes[0]!.nodePosition.theta - robotPose.theta))).toBeCloseTo(0, 12);
    expect(new VdaOrderValidator().validate(order, readyContext()).valid).toBe(true);
  });

  it('uses active Navigator mapId for Node 0', () => {
    const poseWithStaleMap = { ...robotPose, mapId: 'stale-pose-map' };
    const order = new VdaOrderBuilder().build(path,
      { robotPose: poseWithStaleMap, activeMapId: 'active-map' }, defaultOrderSettings);
    expect(order.nodes[0]?.nodePosition.mapId).toBe('active-map');
  });

  it('removes the initial duplicate planner point and makes the useful point Node 2', () => {
    const useful = removeInitialDuplicatePoints(robotPose, path, 0.03);
    expect(useful[0]).toBe(path[1]);
    expect(build().nodes[1]?.nodePosition).toMatchObject({ x: 3.000, y: 1.174 });
  });

  it('creates the first edge from Node 0 with sequence 1 and rotation allowed', () => {
    const order = new VdaOrderBuilder().build(
      path,
      { robotPose, activeMapId: 'active-map' },
      { ...defaultOrderSettings, rotationAllowed: false },
    );
    expect(order.edges[0]).toMatchObject({
      sequenceId: 1, startNodeId: order.nodes[0]?.nodeId, endNodeId: order.nodes[1]?.nodeId,
      rotationAllowed: true,
    });
  });

  it('alternates all node and edge sequences and normalizes every theta', () => {
    const order = build();
    expect(order.nodes.map((node) => node.sequenceId)).toEqual([0, 2, 4]);
    expect(order.edges.map((edge) => edge.sequenceId)).toEqual([1, 3]);
    expect(order.nodes.every((node) => node.nodePosition.theta >= -Math.PI && node.nodePosition.theta <= Math.PI)).toBe(true);
  });

  it('normalizes angular wraparound near PI and -PI', () => {
    expect(Math.abs(normalizeAngle((-Math.PI + 0.0002) - (Math.PI - 0.0002)))).toBeCloseTo(0.0004, 8);
    const wrappedPose = { ...robotPose, theta: Math.PI - 0.0002 };
    const order = new VdaOrderBuilder().build(path,
      { robotPose: wrappedPose, activeMapId: 'active-map' }, defaultOrderSettings);
    order.nodes[0]!.nodePosition.theta = -Math.PI + 0.0002;
    const startErrors = new VdaOrderValidator().validate(order, readyContext(wrappedPose)).errors
      .filter((issue) => issue.code.startsWith('start.angular'));
    expect(startErrors).toEqual([]);
  });

  it('keeps a forward heading when the next waypoint is ahead', () => {
    const ahead = [{ x: 5, y: 5, theta: 0 }, { x: 6, y: 5, theta: 0 }];
    const order = new VdaOrderBuilder().build(ahead,
      { robotPose: { x: 5, y: 5, theta: 0, mapId: 'active-map', positionInitialized: true }, activeMapId: 'active-map' },
      defaultOrderSettings);
    expect(order.nodes[1]?.nodePosition.theta).toBeCloseTo(0, 12);
  });

  it('chooses a reverse heading when reverse risk is low and the waypoint is behind', () => {
    const behind = [{ x: 5, y: 5, theta: 0 }, { x: 4.5, y: 5, theta: 0 }, { x: 4, y: 5, theta: 0 }];
    const plannerOptions = {
      ...defaultPlannerOptions,
      passageSafety: {
        ...defaultPlannerOptions.passageSafety,
        reverseRiskWeight: 0,
      },
    };
    const order = new VdaOrderBuilder().build(behind,
      {
        robotPose: { x: 5, y: 5, theta: 0, mapId: 'active-map', positionInitialized: true },
        activeMapId: 'active-map',
        corridorPlanning: {
          grid,
          footprint: defaultFootprint,
          plannerOptions,
        },
      },
      defaultOrderSettings,
    );
    expect(order.nodes[1]?.nodePosition.theta).toBeCloseTo(0, 12);
  });

  it('preserves an explicit final goal theta when required', () => {
    const finalGoalTheta = 0.7;
    const order = new VdaOrderBuilder().build(
      [{ x: 5, y: 5, theta: 0 }, { x: 5.5, y: 5.5, theta: 0.2 }],
      {
        robotPose: { x: 5, y: 5, theta: 0, mapId: 'active-map', positionInitialized: true },
        activeMapId: 'active-map',
        finalGoalTheta,
      },
      defaultOrderSettings,
    );
    expect(order.nodes[1]?.nodePosition.theta).toBeCloseTo(finalGoalTheta, 12);
  });

  it('rejects first-node position inconsistency', () => {
    const order = build();
    order.nodes[0]!.nodePosition.x += 0.051;
    const codes = new VdaOrderValidator().validate(order, readyContext()).errors.map((issue) => issue.code);
    expect(codes).toContain('start.positionConsistency');
  });

  it('rejects first-node position outside allowedDeviationXy', () => {
    const order = build();
    order.nodes[0]!.nodePosition.x += 0.201;
    const codes = new VdaOrderValidator().validate(order, readyContext()).errors.map((issue) => issue.code);
    expect(codes).toContain('start.positionDeviation');
  });

  it('rejects first-node angular inconsistency using wrapped distance', () => {
    const order = build();
    order.nodes[0]!.nodePosition.theta = normalizeAngle(
      order.nodes[0]!.nodePosition.theta + 6*Math.PI/180);
    const codes = new VdaOrderValidator().validate(order, readyContext()).errors.map((issue) => issue.code);
    expect(codes).toContain('start.angularConsistency');
  });

  it('rejects first-node angle outside allowedDeviationTheta', () => {
    const order = build();
    order.nodes[0]!.nodePosition.theta = normalizeAngle(order.nodes[0]!.nodePosition.theta + 0.351);
    const codes = new VdaOrderValidator().validate(order, readyContext()).errors.map((issue) => issue.code);
    expect(codes).toContain('start.angularDeviation');
  });

  it('gives every independent order a new orderId and headerId', () => {
    const first = build();
    const second = build();
    expect(second.orderId).not.toBe(first.orderId);
    expect(second.headerId).not.toBe(first.headerId);
    expect(second.orderUpdateId).toBe(0);
  });
});

describe('live pose readiness and source', () => {
  const prerequisites = {
    mqttConnected: true, connectionOnline: true, operatingMode: 'AUTOMATIC', stateAgeMs: 10,
    maximumStateAgeMs: 5000, positionInitialized: true,
    pose: { pose: robotPose, source: 'state' as const, receivedAtMs: 100 },
    activeMapId: 'active-map', loadedLocatorMapName: 'active-map',
  };

  it('keeps a valid state mapId when visualization mapId is empty', () => {
    const selected = selectCurrentRobotPose({
      state: { agvPosition: robotPose },
      visualization: {
        headerId: 1, timestamp: new Date().toISOString(), version: '2.0.0',
        manufacturer: 'bosch', serialNumber: '0001',
        agvPosition: { ...robotPose, x: 2.7, mapId: '' },
      },
      lastStateReceiveTime: 100,
      lastVisualizationReceiveTime: 200,
    });
    expect(selected?.source).toBe('visualization');
    expect(selected?.pose.mapId).toBe('active-map');
  });

  it('prevents generation with stale state', () => {
    expect(getOrderGenerationIssues({ ...prerequisites, stateAgeMs: 5001 })
      .map((issue) => issue.code)).toContain('generation.stateStale');
  });

  it('prevents generation when positionInitialized is false', () => {
    expect(getOrderGenerationIssues({ ...prerequisites, positionInitialized: false })
      .map((issue) => issue.code)).toContain('generation.positionInitialized');
  });
});

describe('ROKIT errors, instant actions, and mission acceptance', () => {
  const error: VdaError = {
    errorType: 'OrderError',
    errorLevel: 'WARNING',
    errorDescription: 'First Node of the Order is not trivially reachable',
    errorReferences: [{ referenceKey: 'node.sequenceId', referenceValue: '0' }],
  };

  it('deduplicates repeated current ROKIT errors', () => {
    expect(deduplicateRokitErrors([error, { ...error }])).toHaveLength(1);
    expect(newlyRaisedRokitErrors([error],[{...error}])).toHaveLength(0);
    expect(newlyRaisedRokitErrors([],[error,{...error}])).toHaveLength(1);
  });

  it('keeps bounded history separate from current validation', () => {
    const history = appendErrorHistory([], [error, error], new Date().toISOString(), 'old-order');
    expect(history).toHaveLength(1);
    expect(new VdaOrderValidator().validate(build(), readyContext()).valid).toBe(true);
  });

  it('does not build unsupported stopPause', () => {
    const publish = vi.fn();
    expect(isInstantActionSupported('stopPause')).toBe(false);
    expect(() => {
      const message = new InstantActionBuilder().build('stopPause', defaultOrderSettings);
      publish(message);
    }).toThrow(/not supported/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not build an unconfirmed stateRequest action', () => {
    expect(isInstantActionSupported('stateRequest')).toBe(false);
    expect(() => new InstantActionBuilder().build('stateRequest', defaultOrderSettings))
      .toThrow(/not supported/);
  });

  it('detects acceptance when state.orderId matches', () => {
    const order = build();
    const mission = new MissionMonitor().calculate(order, {
      orderId: order.orderId, driving: false, paused: false, lastNodeSequenceId: 0,
      nodeStates: order.nodes.slice(1).map((node) => ({ nodeId: node.nodeId })),
    }, { publishedAtMs: 100, nowMs: 200, acceptanceTimeoutMs: 5000 });
    expect(mission.accepted).toBe(true);
    expect(mission.status).toBe('Accepted');
  });

  it('times out acceptance instead of waiting indefinitely', () => {
    expect(new MissionMonitor().calculate(build(), { orderId: '' },
      { publishedAtMs: 0, nowMs: 5001, acceptanceTimeoutMs: 5000 }).status).toBe('Timed out');
  });

  it('reports exact Navigator rejection for the published order', () => {
    const order = build();
    const rejection = { ...error, errorReferences: [
      { referenceKey: 'orderId', referenceValue: order.orderId },
      { referenceKey: 'node.sequenceId', referenceValue: '0' },
    ] };
    const mission = new MissionMonitor().calculate(order, { orderId: '', errors: [rejection] });
    expect(mission.status).toBe('Rejected');
    expect(mission.rejectionErrors[0]?.errorDescription).toBe(error.errorDescription);
  });
});
