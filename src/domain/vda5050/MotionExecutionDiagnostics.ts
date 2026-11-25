import { normalizeAngle } from '../geometry/angles';
import type { MotionAction } from '../motion/planningModel';
import type { VdaEdge, VdaOrder } from '../types';

export function motionEdgeDiagnostic(action: MotionAction, edge: VdaEdge, orderId: string) {
  const moving = action.type === 'TRANSLATE_FORWARD' || action.type === 'TRANSLATE_REVERSE';
  const bearing = moving ? Math.atan2(action.to.y - action.from.y, action.to.x - action.from.x) : null;
  const expectedSign = !moving ? 0 : action.type === 'TRANSLATE_REVERSE' ? -1 : 1;
  return { orderId, edgeId: edge.edgeId, sequenceId: edge.sequenceId,
    motionPlanActionType: action.type, motionPlanDirection: action.to.direction,
    startPose: action.from, endPose: action.to, bodyThetaRad: action.from.theta,
    edgeWorldBearingRad: bearing,
    bodyMinusBearingRad: bearing === null ? null : normalizeAngle(action.from.theta - bearing),
    expectedLongitudinalSign: expectedSign, fieldsWrittenIntoEdge: edge,
    fieldsWrittenIntoTrajectory: null,
    reverseIntentExplicitlyEncoded: expectedSign === -1 && edge.orientation === Math.PI,
    protocolInterpretation: moving ? edge.orientation === Math.PI ? 'TANGENTIAL_REVERSE' :
      edge.orientation === 0 ? 'TANGENTIAL_FORWARD' : 'UNSPECIFIED' :
      action.type === 'DIRECTION_CHANGE' ? 'COINCIDENT_NODES_NO_PROTOCOL_DIRECTION_CHANGE_ACTION' : 'NODE_ORIENTATION_CHANGE',
    navigatorInterpretation: 'UNOBSERVED', wheelCommand: 'UNOBSERVED' };
}

/** Runs against the actual JSON about to be published, including non-builder callers. */
export function outgoingMotionDiagnostics(payload: string): Array<Record<string, unknown>> {
  try {
    const order = JSON.parse(payload) as VdaOrder;
    if (!Array.isArray(order.nodes) || !Array.isArray(order.edges)) return [];
    return order.edges.map((edge) => {
      const from = order.nodes.find((n) => n.nodeId === edge.startNodeId)?.nodePosition;
      const to = order.nodes.find((n) => n.nodeId === edge.endNodeId)?.nodePosition;
      const moving = from && to && Math.hypot(to.x - from.x, to.y - from.y) > 1e-7;
      return { orderId: order.orderId, edgeId: edge.edgeId, sequenceId: edge.sequenceId,
        from, to, edge, worldBearingRad: moving ? Math.atan2(to!.y - from!.y, to!.x - from!.x) : null,
        encodedMotionSign: !moving ? 0 : edge.orientation === Math.PI ? -1 : edge.orientation === 0 ? 1 : null,
        navigatorInterpretation: 'UNOBSERVED' };
    });
  } catch { return []; }
}
