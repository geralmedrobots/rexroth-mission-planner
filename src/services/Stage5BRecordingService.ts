import { Stage5BRecorder, type MissionExecutionEvidence, type RecordedScenario, type RecordingOutcome } from '../domain/planning/Stage5BRecorder';
import type { PlanningInputs } from '../features/planning/PlanningCoordinator';
import type { PlanningConfigurationSnapshot } from '../domain/planning/PlanningConfigurationSnapshot';
import type { VdaOrder, VdaState } from '../domain/types';
import { useAppStore } from '../stores/appStore';
import { version } from '../../package.json';

const entries = new Map<string, { recorder: Stage5BRecorder; revision?: number; published?: boolean; finalized?: RecordedScenario; saving?: boolean }>();
const orderRecordings = new Map<string, string>();
const cancelOrders = new Map<string, string>();
const status = (message: string) => useAppStore.getState().set({ stage5BRecordingStatus: message,
  stage5BPendingCount: entries.size });

async function save(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry?.finalized || entry.saving) return;
  entry.saving = true;
  try {
    const response = await fetch(`http://${location.hostname || '127.0.0.1'}:8787/api/stage5b/missions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry.finalized),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as { path?: string; error?: string };
    if (!response.ok || !result.path) throw new Error(result.error ?? `HTTP ${response.status}`);
    entries.delete(id);
    for (const [orderId, recordingId] of orderRecordings) if (recordingId === id) orderRecordings.delete(orderId);
    status(`Stage 5B artifact saved: ${result.path}`);
  } catch (error) { status(`Stage 5B save failed (retained in memory; retry before closing): ${String(error)}`); }
  finally { entry.saving = false; }
}

function finalize(id: string, outcome: RecordingOutcome, reason?: string, evidence?: MissionExecutionEvidence): void {
  const entry = entries.get(id);
  if (!entry || entry.finalized) return;
  try { entry.finalized = entry.recorder.finalize(outcome, reason, evidence); void save(id); }
  catch (error) { status(`Stage 5B finalization failed: ${String(error)}`); }
}

export const stage5BRecording = {
  start(inputs: PlanningInputs, configuration: PlanningConfigurationSnapshot) {
    try {
      for (const [oldId, entry] of entries) if (!entry.published && !entry.finalized)
        finalize(oldId, 'cancelled', 'Unpublished planning run superseded by a new request');
      const id = crypto.randomUUID();
      const recorder = new Stage5BRecorder({ grid: inputs.grid, footprint: inputs.footprint,
        startPose: inputs.start, goalPose: inputs.goal,
        goalTheta: inputs.goalThetaExplicit ? inputs.goal.theta : undefined,
        configuration, selectedProfile: 'CUSTOM' }, {
        missionId: inputs.missionId ?? id, provenance: 'real-run', appVersion: version,
        gitCommit: import.meta.env.VITE_APP_GIT_COMMIT || undefined,
      });
      entries.set(id, { recorder, revision: inputs.routeRevision });
      status('Stage 5B recording active: planning inputs captured');
      return { result: (result: import('../domain/types').PlannerResult) => {
        try {
          recorder.recordResult(result);
          if (!result.success) finalize(id, 'failed', result.error ?? 'Planner returned failure');
        } catch (error) { status(`Stage 5B result capture failed: ${String(error)}`); }
      }, stop: (reason: string) => finalize(id, reason.startsWith('Planning exception:') ? 'failed' : 'cancelled', reason) };
    } catch (error) { status(`Stage 5B recording failed to start: ${String(error)}`); throw error; }
  },
  order(order: VdaOrder, revision: number | undefined, published = false) {
    try {
      if (revision === undefined) return;
      const bound = orderRecordings.get(order.orderId);
      const match = bound ? [bound, entries.get(bound)] as const : [...entries].reverse().find(([, item]) => item.revision === revision && !item.finalized);
      if (!match?.[1]) return;
      match[1].recorder.recordOrder(order, published);
      if (published) match[1].published = true;
      orderRecordings.set(order.orderId, match[0]);
    } catch (error) { status(`Stage 5B order capture failed: ${String(error)}`); }
  },
  observe(orderId: string | undefined, outcome: RecordingOutcome, reason?: string, state?: VdaState) {
    const id = orderId && orderRecordings.get(orderId);
    if (id) finalize(id, outcome, reason, executionEvidence(orderId, state));
  },
  cancelRequested(actionId: string, orderId: string | undefined) {
    if (orderId && orderRecordings.has(orderId)) cancelOrders.set(actionId, orderId);
  },
  observeActions(state?: VdaState) {
    for (const value of state?.actionStates ?? []) {
      if (!value || typeof value !== 'object') continue;
      const action = value as { actionId?: string; actionStatus?: string };
      const orderId = action.actionId && cancelOrders.get(action.actionId);
      if (orderId && action.actionStatus === 'FINISHED') {
        const id = orderRecordings.get(orderId);
        if (id) finalize(id, 'cancelled', `Navigator acknowledged cancel action ${action.actionId}`,
          executionEvidence(orderId, state));
        cancelOrders.delete(action.actionId!);
      }
    }
  },
  finalizePending(outcome: RecordingOutcome, state?: VdaState) {
    const revision = useAppStore.getState().routeRevision;
    for (const [id, entry] of entries) if (!entry.finalized && entry.revision === revision)
      finalize(id, outcome, 'Operator finalized recording for current route',
        executionEvidence(undefined, state));
  },
  routeChanged(revision: number) {
    for (const [id, entry] of entries) if (!entry.published && !entry.finalized && entry.revision !== revision)
      finalize(id, 'cancelled', 'Unpublished route selection cleared or replaced');
  },
  retry() { for (const id of entries.keys()) void save(id); },
};

function executionEvidence(orderId: string | undefined, state: VdaState | undefined): MissionExecutionEvidence {
  return {
    ...(orderId ? { orderId } : {}),
    ...(state?.lastNodeId ? { lastNodeId: state.lastNodeId } : {}),
    ...(state?.lastNodeSequenceId !== undefined ? { lastNodeSequenceId: state.lastNodeSequenceId } : {}),
    ...(state?.errors ? { navigatorErrors: state.errors } : {}),
    ...(state?.agvPosition ? { finalPose: state.agvPosition } : {}),
  };
}
