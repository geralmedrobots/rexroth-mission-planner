import type { PathPoint, PlannerResult, VdaError, VdaOrder } from '../types';
import { createMotionPlannerScenarioArtifact, serializeMotionPlannerScenarioArtifact,
  type MotionPlannerScenarioArtifact, type MotionPlannerScenarioArtifactInput } from './MotionPlannerScenarioArtifact';

export type RecordingOutcome = 'success' | 'failed' | 'cancelled';
export type Stage5BRecordingLifecycle = 'INPUT_CAPTURED' | 'PLANNED' | 'EXECUTING' |
  'SUCCESS' | 'FAILED' | 'CANCELLED' | 'FINALIZED';
export interface MissionExecutionEvidence {
  orderId?: string;
  lastNodeId?: string;
  lastNodeSequenceId?: number;
  navigatorErrors?: VdaError[];
  finalPose?: PathPoint;
}
export interface MissionExecutionResult extends MissionExecutionEvidence {
  status: RecordingOutcome;
  completedAt: string;
  startedAt?: string;
  durationMs?: number;
}
export interface MissionRecording {
  recordingId: string;
  recorderVersion: 'stage5b-recorder-v1';
  missionId: string;
  provenance: 'real-run' | 'synthetic';
  startedAt: string;
  completedAt?: string;
  outcome?: RecordingOutcome;
  reason?: string;
  finalPose?: PathPoint;
  execution?: MissionExecutionResult;
  appVersion: string;
  gitCommit?: string;
  orders: { order: VdaOrder; generatedAt: string; publishedAt?: string }[];
}
export type RecordedScenario = MotionPlannerScenarioArtifact & { recording: MissionRecording };

/** One immutable input snapshot per planning run; execution never changes replay inputs. */
export class Stage5BRecorder {
  private artifact: RecordedScenario;
  private lifecycle: Stage5BRecordingLifecycle = 'INPUT_CAPTURED';
  constructor(input: MotionPlannerScenarioArtifactInput, identity: Pick<MissionRecording,
    'missionId' | 'provenance' | 'appVersion'> & { gitCommit?: string }, now = new Date().toISOString()) {
    this.artifact = { ...createMotionPlannerScenarioArtifact(input), recording: {
      ...identity, recordingId: crypto.randomUUID(), recorderVersion: 'stage5b-recorder-v1', startedAt: now, orders: [],
    } };
  }
  get state(): Stage5BRecordingLifecycle { return this.lifecycle; }
  recordResult(result: PlannerResult): void {
    if (this.artifact.recording.outcome) return;
    this.artifact = { ...this.artifact, originalCalibration: structuredClone(result.motionPlannerCalibration),
      capture: { plannerMode: 'motion-state', waypoints: [], waypointsUsed: false,
        capturedAt: this.artifact.recording.startedAt, result: structuredClone(result) } };
    this.lifecycle = 'PLANNED';
  }
  recordOrder(order: VdaOrder, published = false): void {
    if (this.artifact.recording.outcome) return;
    const orders = this.artifact.recording.orders;
    let entry = orders.find(item => item.order.orderId === order.orderId && item.order.orderUpdateId === order.orderUpdateId);
    if (!entry) { entry = { order: structuredClone(order), generatedAt: new Date().toISOString() }; orders.push(entry); }
    if (published) {
      entry.order = structuredClone(order); entry.publishedAt = new Date().toISOString();
      this.lifecycle = 'EXECUTING';
    }
  }
  finalize(outcome: RecordingOutcome, reason?: string, evidence: MissionExecutionEvidence = {}): RecordedScenario {
    if (!this.artifact.recording.outcome) {
      this.lifecycle = outcome === 'success' ? 'SUCCESS' : outcome === 'failed' ? 'FAILED' : 'CANCELLED';
      const completedAt = new Date().toISOString();
      const published = [...this.artifact.recording.orders].reverse().find(item => item.publishedAt &&
        (!evidence.orderId || item.order.orderId === evidence.orderId));
      const durationMs = published?.publishedAt
        ? Date.parse(completedAt) - Date.parse(published.publishedAt) : undefined;
      const execution: MissionExecutionResult = {
        status: outcome, completedAt,
        ...(published?.publishedAt ? { startedAt: published.publishedAt } : {}),
        ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
        ...(evidence.orderId ? { orderId: evidence.orderId } : {}),
        ...(evidence.lastNodeId ? { lastNodeId: evidence.lastNodeId } : {}),
        ...(evidence.lastNodeSequenceId !== undefined ? { lastNodeSequenceId: evidence.lastNodeSequenceId } : {}),
        ...(evidence.navigatorErrors ? { navigatorErrors: structuredClone(evidence.navigatorErrors) } : {}),
        ...(evidence.finalPose ? { finalPose: structuredClone(evidence.finalPose) } : {}),
      };
      Object.assign(this.artifact.recording, {
        outcome, reason, finalPose: evidence.finalPose && structuredClone(evidence.finalPose), completedAt, execution,
      });
    }
    // Validate the exact JSON representation that the replay loader receives.
    const finalized = JSON.parse(serializeMotionPlannerScenarioArtifact(this.artifact)) as RecordedScenario;
    this.lifecycle = 'FINALIZED';
    return finalized;
  }
}
