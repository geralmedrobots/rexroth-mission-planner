import type { DiagnosticSink } from '../diagnostics/DiagnosticEvent';
import { createDiagnosticEvent } from '../diagnostics/DiagnosticEvent';
import type { VdaOrder } from '../../domain/types';

export type MissionLifecycle = 'idle' | 'prepared' | 'validated' | 'published' | 'accepted' | 'rejected' | 'driving' | 'completed' | 'cancelled';
export interface MissionState { readonly missionId?: string; readonly orderId?: string; readonly order?: VdaOrder; readonly validated?: boolean; readonly lifecycle: MissionLifecycle; readonly generation: number }

/** Owns mission/order lifecycle facts; transport and UI remain injectable. */
export class MissionController {
  private generation = 0;
  private state: MissionState = { lifecycle: 'idle', generation: 0 };
  public constructor(private readonly diagnostics?: DiagnosticSink) {}
  public get snapshot(): MissionState { return this.state; }
  public createMission(sessionId: string, missionId: string): MissionState {
    this.state = { missionId, lifecycle: 'idle', generation: ++this.generation };
    this.diagnostics?.emit(createDiagnosticEvent({ sessionId, missionId, stage: 'mission', severity: 'info', eventType: 'mission.configuration.snapshot', message: 'Mission configuration snapshot created.' }));
    return this.state;
  }
  public prepareOrder(sessionId: string, order: VdaOrder): MissionState {
    this.state = { ...this.state, orderId: order.orderId, order, validated: false, lifecycle: 'prepared' };
    this.diagnostics?.emit(createDiagnosticEvent({ sessionId, missionId: this.state.missionId, orderId: order.orderId, stage: 'vda', severity: 'info', eventType: 'vda.order.built', message: 'VDA order built.' }));
    return this.state;
  }
  public markValidated(sessionId: string, valid: boolean, orderId = this.state.orderId): MissionState {
    if (!valid) this.state = { ...this.state, validated: false, lifecycle: 'prepared' };
    else this.state = { ...this.state, validated: true, lifecycle: 'validated', orderId };
    this.diagnostics?.emit(createDiagnosticEvent({ sessionId, missionId: this.state.missionId, orderId, stage: 'vda', severity: valid ? 'info' : 'error', eventType: 'vda.order.validated', message: valid ? 'VDA order validated.' : 'VDA order validation failed.', payload: { valid } }));
    return this.state;
  }
  public invalidatePendingOrder(): MissionState { this.state = { ...this.state, orderId: undefined, order: undefined, validated: false, generation: ++this.generation }; return this.state; }
  public markPublished(sessionId?: string): MissionState {
    this.state = { ...this.state, lifecycle: 'published' };
    if (sessionId) this.diagnostics?.emit(createDiagnosticEvent({ sessionId, missionId: this.state.missionId, orderId: this.state.orderId, stage: 'vda', severity: 'info', eventType: 'vda.order.published', message: 'VDA order published.' }));
    return this.state;
  }
  public observeNavigator(sessionId: string, status: 'accepted' | 'rejected' | 'driving' | 'completed' | 'cancelled', payload?: Record<string, unknown>): MissionState {
    const lifecycle = status;
    this.state = { ...this.state, lifecycle };
    const eventType = status === 'accepted' ? 'navigator.order.accepted' : status === 'rejected' ? 'navigator.order.rejected' : status === 'driving' ? 'navigator.execution.progress' : undefined;
    if (eventType) this.diagnostics?.emit(createDiagnosticEvent({ sessionId, missionId: this.state.missionId, orderId: this.state.orderId, stage: 'navigator', severity: status === 'rejected' ? 'error' : 'info', eventType, message: `Navigator order ${status}.`, payload }));
    return this.state;
  }
  public complete(): MissionState { this.state = { ...this.state, lifecycle: 'completed' }; return this.state; }
  public cancel(): MissionState { this.state = { ...this.state, lifecycle: 'cancelled' }; return this.state; }
}
