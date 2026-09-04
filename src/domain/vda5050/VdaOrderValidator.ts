import type {
  OccupancyGrid, OrderSettings, RobotFootprint, RobotPose, ValidationIssue,
  ValidationResult, VdaOrder, PoseSource,
} from '../types';
import type { BoschRokitCorridorSettings } from '../types';
import { PathCollisionValidator } from '../planner/PathCollisionValidator';
import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { normalizeAngle, radiansToDegrees } from '../geometry/angles';
import { compareMapIds, normalizeMapId } from '../robot/ActiveMapResolver';
import { BoschRokitCorridorValidator } from './BoschRokitCorridorValidator';

export interface OrderValidationContext {
  mqttConnected: boolean; stateReceived: boolean; connectionReceived: boolean; activeMapId: string | null;
  currentPose?: RobotPose; grid?: OccupancyGrid; footprint: RobotFootprint; settings: OrderSettings;
  connectionOnline: boolean; operatingMode?: string; stateAgeMs: number; visualizationAgeMs: number;
  positionInitialized: boolean; poseSource?: PoseSource; locatorMapName?: string;
  mapIdSource?: string; lastStateReceiveTime?: number | null;
  corridorSettings?:BoschRokitCorridorSettings;
}

export interface FirstNodeDiagnostics {
  robotPose?: RobotPose;
  node0?: VdaOrder['nodes'][number]['nodePosition'];
  positionDifference?: number;
  angularDifference?: number;
  angularDifferenceDegrees?: number;
  allowedDeviationXy?: number;
  allowedDeviationTheta?: number;
  stateAgeMs: number;
  visualizationAgeMs: number;
  poseSource?: PoseSource;
  activeMapId: string | null;
}

export const getFirstNodeDiagnostics = (
  order: VdaOrder | undefined,
  context: Pick<OrderValidationContext,
    'currentPose' | 'stateAgeMs' | 'visualizationAgeMs' | 'poseSource' | 'activeMapId'>,
): FirstNodeDiagnostics => {
  const node0 = order?.nodes[0]?.nodePosition;
  const robotPose = context.currentPose;
  const positionDifference = node0 && robotPose
    ? Math.hypot(node0.x - robotPose.x, node0.y - robotPose.y) : undefined;
  const angularDifference = node0 && robotPose
    ? Math.abs(normalizeAngle(node0.theta - robotPose.theta)) : undefined;
  return {
    robotPose,
    node0,
    positionDifference,
    angularDifference,
    angularDifferenceDegrees: angularDifference === undefined ? undefined : radiansToDegrees(angularDifference),
    allowedDeviationXy: node0?.allowedDeviationXy,
    allowedDeviationTheta: node0?.allowedDeviationTheta,
    stateAgeMs: context.stateAgeMs,
    visualizationAgeMs: context.visualizationAgeMs,
    poseSource: context.poseSource,
    activeMapId: context.activeMapId,
  };
};

export class VdaOrderValidator {
  public validate(order: VdaOrder, context: OrderValidationContext): ValidationResult {
    const base=this.validateBase(order,context);
    if(!context.corridorSettings)return base;
    const extension=new BoschRokitCorridorValidator().validate(order,{
      settings:context.corridorSettings,grid:context.grid,
    });
    return {
      valid:base.valid&&extension.valid,
      errors:[...base.errors,...extension.errors],
      warnings:[...base.warnings,...extension.warnings],
      context:{...base.context,
        protocolBase:'VDA 5050 2.0',
        rokitExtension:'corridor definition from VDA 5050 2.1',
        boschCorridorValidation:extension.context,
      },
    };
  }

  public validateBase(order: VdaOrder, context: OrderValidationContext): ValidationResult {
    const errors: ValidationIssue[] = []; const warnings: ValidationIssue[] = [];
    const add = (
      condition: boolean, code: string, message: string, path?: string,
      details?: Record<string, unknown>,
    ): void => {
      if (!condition) errors.push({ code, message, path, severity: 'error', details });
    };
    add(context.mqttConnected, 'mqtt.disconnected', 'MQTT is not connected.');
    add(context.stateReceived, 'state.missing', 'No state message has been received.');
    add(context.connectionReceived, 'connection.missing', 'No connection message has been received.');
    add(context.connectionOnline, 'connection.offline', 'ROKIT connection state must be ONLINE.');
    add(context.operatingMode?.toUpperCase() === 'AUTOMATIC', 'state.mode', 'ROKIT operatingMode must be AUTOMATIC.');
    add(Number.isFinite(context.stateAgeMs) && context.stateAgeMs <= context.settings.stateStaleTimeoutMs,
      'state.stale',
      `Robot state is stale: age ${Number.isFinite(context.stateAgeMs) ? Math.max(0,Math.round(context.stateAgeMs)) : 'unavailable'} ms, limit ${context.settings.stateStaleTimeoutMs} ms.`,
      undefined,{stateAgeMs:context.stateAgeMs,stateStaleTimeoutMs:context.settings.stateStaleTimeoutMs,
        lastStateReceiveTime:context.lastStateReceiveTime == null?null:new Date(context.lastStateReceiveTime).toISOString()});
    add(context.positionInitialized, 'state.positionInitialized', 'Robot position is not initialized.');
    add(Boolean(context.currentPose && [context.currentPose.x, context.currentPose.y, context.currentPose.theta].every(Number.isFinite)),
      'state.pose', 'A complete finite current robot pose is required.');
    const activeMapId=normalizeMapId(context.activeMapId);
    if(!activeMapId) errors.push({code:'map.idMissing',message:'The active Navigator mapId is empty.',severity:'error'});
    else if(!normalizeMapId(context.locatorMapName)) {
      errors.push({code:'map.locatorMissing',message:'No Locator map is loaded.',severity:'error'});
    } else if(!compareMapIds(context.locatorMapName,activeMapId).matches) {
      errors.push({code:'map.locatorMismatch',
        message:`Loaded Locator map "${normalizeMapId(context.locatorMapName)}" does not match active Navigator mapId "${activeMapId}".`,
        severity:'error'});
    }
    add(order.version === '2.0.0', 'version.invalid', 'Order version must be 2.0.0.', 'version');
    add(order.manufacturer === context.settings.manufacturer, 'manufacturer.mismatch', 'Manufacturer does not match topic settings.', 'manufacturer');
    add(order.serialNumber === context.settings.serialNumber, 'serial.mismatch', 'Serial number does not match topic settings.', 'serialNumber');
    add(order.orderId.trim().length > 0, 'orderId.empty', 'orderId must not be empty.', 'orderId');
    add(Number.isFinite(Date.parse(order.timestamp)) && order.timestamp.endsWith('Z'), 'timestamp.invalid', 'timestamp must be valid ISO 8601 UTC.', 'timestamp');
    add(order.nodes.length >= 2, 'nodes.minimum', 'Path must contain at least two nodes.', 'nodes');
    add(order.edges.length === Math.max(0, order.nodes.length - 1), 'edges.count', 'Edge count must equal node count minus one.', 'edges');
    const nodeIds = new Set(order.nodes.map((node) => node.nodeId));
    const edgeIds = new Set(order.edges.map((edge) => edge.edgeId));
    add(nodeIds.size === order.nodes.length, 'nodes.duplicate', 'Node IDs must be unique.', 'nodes');
    add(edgeIds.size === order.edges.length, 'edges.duplicate', 'Edge IDs must be unique.', 'edges');
    const sequences = [...order.nodes.map((n) => n.sequenceId), ...order.edges.map((e) => e.sequenceId)].sort((a,b)=>a-b);
    add(sequences.every((value, index) => value === index), 'sequence.invalid', 'Sequence IDs must be unique, ordered, and alternate node/edge.');
    order.nodes.forEach((node, index) => {
      const pos = node.nodePosition;
      add(node.sequenceId === index * 2, 'node.sequence', `Node ${index} must have sequenceId ${index * 2}.`);
      add([pos.x,pos.y,pos.theta].every(Number.isFinite), 'node.coordinate', `Node ${index} coordinates must be finite.`);
      add(pos.theta >= -Math.PI && pos.theta <= Math.PI, 'node.theta', `Node ${index} theta is outside [-π, π].`);
      add(pos.mapId.length > 0 && pos.mapId === activeMapId, 'node.mapId', `Node ${index} mapId does not match the active map.`);
      add(Array.isArray(node.actions), 'node.actions', `Node ${index} actions must be an array.`);
    });
    order.edges.forEach((edge, index) => {
      const start = order.nodes[index]; const end = order.nodes[index + 1];
      add(edge.sequenceId === index * 2 + 1, 'edge.sequence', `Edge ${index} has an invalid sequenceId.`);
      add(Boolean(start && end && edge.startNodeId === start.nodeId && edge.endNodeId === end.nodeId), 'edge.reference', `Edge ${index} does not reference adjacent nodes.`);
      add(nodeIds.has(edge.startNodeId) && nodeIds.has(edge.endNodeId), 'edge.missingNode', `Edge ${index} references an unknown node.`);
      add(edge.maxSpeed > 0, 'edge.speed',
        `Edge ${index} maxSpeed must be positive.`);
      add(Math.abs(edge.maxSpeed-context.settings.missionMaximumSpeedMps)<1e-9,
        'edge.missionSpeed',
        `Edge ${index} maxSpeed ${edge.maxSpeed} m/s does not match `+
        `MissionMaximumSpeedMps ${context.settings.missionMaximumSpeedMps} m/s.`);
      const configuredVehicleLimit=context.footprint.maxForwardVelocity;
      if(configuredVehicleLimit!==undefined)add(
        edge.maxSpeed<=configuredVehicleLimit,
        'edge.vehicleSpeed',
        `Edge ${index} maxSpeed exceeds the imported ClientMotion `+
        `maxForwardVelocity ${configuredVehicleLimit} m/s.`);
      add(Array.isArray(edge.actions), 'edge.actions', `Edge ${index} actions must be an array.`);
    });
    if (context.currentPose && order.nodes[0]) {
      const diagnostics = getFirstNodeDiagnostics(order, context);
      const positionDifference = diagnostics.positionDifference ?? Number.POSITIVE_INFINITY;
      const angularDifference = diagnostics.angularDifference ?? Number.POSITIVE_INFINITY;
      const start = order.nodes[0].nodePosition;
      add(positionDifference <= start.allowedDeviationXy, 'start.positionDeviation',
        `Node 0 position differs from the robot pose by ${positionDifference.toFixed(6)} m.`);
      add(angularDifference <= start.allowedDeviationTheta, 'start.angularDeviation',
        `Node 0 orientation differs from the robot pose by ${angularDifference.toFixed(6)} rad.`);
      add(positionDifference <= context.settings.firstNodePositionConsistency, 'start.positionConsistency',
        `Node 0 must match the live robot position within ${context.settings.firstNodePositionConsistency} m.`);
      add(angularDifference <= context.settings.firstNodeAngularConsistency, 'start.angularConsistency',
        `Node 0 must match the live robot orientation within ${context.settings.firstNodeAngularConsistency} rad.`);
    }
    if (context.grid && order.nodes.length > 0) {
      const transformer = new CoordinateTransformer(context.grid.metadata);
      for (const [index, node] of order.nodes.entries()) add(transformer.worldToGrid(node.nodePosition.x,node.nodePosition.y) !== null, 'node.bounds', `Node ${index} is outside map bounds.`);
      const path = order.nodes.map((node) => node.nodePosition);
      const collision=new PathCollisionValidator().findFirstCollision(
        context.grid,path,context.footprint,0.03);
      if(collision)errors.push({
        code:'path.collision',
        message:`Final path segment ${collision.segmentIndex} intersects an obstacle or map boundary.`,
        severity:'error',
        details:{
          ...collision,
          startNodeId:order.nodes[collision.segmentIndex]?.nodeId,
          endNodeId:order.nodes[collision.segmentIndex+1]?.nodeId,
        },
      });
    }
    if(context.mapIdSource==='manual-confirmed')warnings.push({
      code:'generation.mapIdManualBinding',
      message:'The Navigator did not provide mapId through MQTT. The user-confirmed Locator map binding is being used.',
      severity:'warning',
    });
    return { valid: errors.length === 0, errors, warnings, context:{
      stateAgeMs:context.stateAgeMs,stateStaleTimeoutMs:context.settings.stateStaleTimeoutMs,
      lastStateReceiveTime:context.lastStateReceiveTime??null,activeNavigatorMapId:activeMapId,
      mapIdSource:context.mapIdSource??'none',loadedLocatorMap:normalizeMapId(context.locatorMapName),
    } };
  }
}
