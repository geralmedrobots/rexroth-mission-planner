import type { DiagnosticSink } from '../diagnostics/DiagnosticEvent';
import { createDiagnosticEvent } from '../diagnostics/DiagnosticEvent';
import type { VdaOrder } from '../../domain/types';

export type MissionLifecycle = 'idle' | 'prepared' | 'published' | 'completed' | 'cancelled';
export interface MissionState { readonly missionId?: string; readonly orderId?: string; readonly lifecycle: MissionLifecycle; readonly generation: number }

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
    this.state = { ...this.state, orderId: order.orderId, lifecycle: 'prepared' };
    this.diagnostics?.emit(createDiagnosticEvent({ sessionId, missionId: this.state.missionId, orderId: order.orderId, stage: 'vda', severity: 'info', eventType: 'vda.order.built', message: 'VDA order built.' }));
    return this.state;
  }
  public invalidatePendingOrder(): MissionState { this.state = { ...this.state, orderId: undefined, generation: ++this.generation }; return this.state; }
  public markPublished(): MissionState { this.state = { ...this.state, lifecycle: 'published' }; return this.state; }
  public complete(): MissionState { this.state = { ...this.state, lifecycle: 'completed' }; return this.state; }
  public cancel(): MissionState { this.state = { ...this.state, lifecycle: 'cancelled' }; return this.state; }
}
