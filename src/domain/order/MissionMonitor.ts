import type { VdaError, VdaOrder, VdaState } from '../types';
import { deduplicateRokitErrors } from '../robot/RokitErrors';

export type MissionStatus =
  | 'Ready' | 'Publishing' | 'Awaiting acceptance' | 'Accepted' | 'Driving'
  | 'Paused' | 'Completed' | 'Rejected' | 'Timed out' | 'Cancelled';

export interface MissionProgress {
  accepted: boolean;
  completedNodes: Set<string>;
  activeEdgeId?: string;
  progressPercent: number;
  distanceToNextNode?: number;
  status: MissionStatus;
  activeOrderId?: string;
  rejectionErrors: VdaError[];
}

export interface MissionMonitorOptions {
  publishedAtMs?: number;
  nowMs?: number;
  acceptanceTimeoutMs?: number;
  publishing?: boolean;
}

const errorReferencesOrder = (error: VdaError, orderId: string): boolean =>
  (error.errorReferences ?? []).some((reference) =>
    reference.referenceKey.toLowerCase().endsWith('orderid') && reference.referenceValue === orderId);

export class MissionMonitor {
  public calculate(
    order: VdaOrder | undefined,
    state: VdaState | undefined,
    options: MissionMonitorOptions = {},
  ): MissionProgress {
    const empty = (status: MissionStatus): MissionProgress => ({
      accepted: false,
      completedNodes: new Set(),
      progressPercent: 0,
      status,
      rejectionErrors: [],
    });
    if (options.publishing) return empty('Publishing');
    if (!order) return empty('Ready');
    const errors = state?.errors ?? [];
    const rejectionErrors = deduplicateRokitErrors(errors.filter((error) => errorReferencesOrder(error, order.orderId)));
    if (rejectionErrors.length) return { ...empty('Rejected'), rejectionErrors };
    const accepted = state?.orderId === order.orderId;
    if (!accepted) {
      const elapsed = options.publishedAtMs === undefined ? 0 :
        (options.nowMs ?? Date.now()) - options.publishedAtMs;
      const timedOut = options.publishedAtMs !== undefined &&
        elapsed > (options.acceptanceTimeoutMs ?? 5_000);
      return empty(timedOut ? 'Timed out' : 'Awaiting acceptance');
    }
    const pending = new Set((state?.nodeStates ?? []).flatMap((item) => {
      const nodeId = (item as { nodeId?: unknown }).nodeId;
      return typeof nodeId === 'string' ? [nodeId] : [];
    }));
    const completedNodes = new Set(order.nodes.filter((node) =>
      !pending.has(node.nodeId) && node.sequenceId <= (state?.lastNodeSequenceId ?? -1),
    ).map((node) => node.nodeId));
    const edgeState = state?.edgeStates?.[0] as { edgeId?: unknown } | undefined;
    const activeEdgeId = typeof edgeState?.edgeId === 'string' ? edgeState.edgeId : undefined;
    const finalSequence = order.nodes[order.nodes.length - 1]?.sequenceId ?? Number.POSITIVE_INFINITY;
    const complete = (state?.lastNodeSequenceId ?? -1) >= finalSequence && !state?.driving;
    const progressPercent = complete ? 100 : Math.round((completedNodes.size / order.nodes.length) * 100);
    const next = order.nodes.find((node) => pending.has(node.nodeId));
    const distanceToNextNode = next && state?.agvPosition
      ? Math.hypot(next.nodePosition.x - state.agvPosition.x, next.nodePosition.y - state.agvPosition.y)
      : undefined;
    const status: MissionStatus = complete ? 'Completed' :
      state?.paused ? 'Paused' : state?.driving ? 'Driving' : 'Accepted';
    return {
      accepted: true,
      completedNodes,
      activeEdgeId,
      progressPercent,
      distanceToNextNode,
      status,
      activeOrderId: state?.orderId,
      rejectionErrors,
    };
  }
}
