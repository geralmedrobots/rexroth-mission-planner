import type { AppLog } from '../../domain/types';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export type DiagnosticStage =
  | 'mission' | 'map' | 'costmap' | 'planner' | 'collision' | 'motionplan'
  | 'vda' | 'navigator' | 'replanning' | 'recovery';

export interface DiagnosticEvent {
  sessionId: string;
  missionId?: string;
  planningRequestId?: string;
  candidateId?: string;
  orderId?: string;
  timestamp: string;
  stage: DiagnosticStage;
  severity: DiagnosticSeverity;
  eventType: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface DiagnosticSink {
  emit(event: DiagnosticEvent): void;
}

export const createDiagnosticEvent = (
  input: Omit<DiagnosticEvent, 'timestamp'> & { timestamp?: string },
): DiagnosticEvent => ({
  ...input,
  timestamp: input.timestamp ?? new Date().toISOString(),
});

/** Stable, bounded correlation IDs for one application session. */
export const planningRequestId = (sessionId: string, sequence: number): string =>
  `${sessionId}:planning:${sequence}`;

const categoryFor = (stage: DiagnosticStage): AppLog['category'] => {
  if (stage === 'vda' || stage === 'motionplan') return 'validation';
  if (stage === 'navigator') return 'mqtt';
  return stage === 'planner' || stage === 'collision' || stage === 'costmap' ? 'planner' : 'system';
};

/** Compatibility boundary: the renderer can keep consuming AppLog entries. */
export class OperationalLogDiagnosticSink implements DiagnosticSink {
  public constructor(private readonly write: (category: AppLog['category'], level: AppLog['level'], message: string) => void) {}

  public emit(event: DiagnosticEvent): void {
    const payload = event.payload && Object.keys(event.payload).length
      ? ` ${JSON.stringify(event.payload)}` : '';
    this.write(categoryFor(event.stage), event.severity, `[${event.eventType}] ${event.message}${payload}`);
  }
}

export class CompositeDiagnosticSink implements DiagnosticSink {
  public constructor(private readonly sinks: readonly DiagnosticSink[]) {}
  public emit(event: DiagnosticEvent): void { this.sinks.forEach((sink) => sink.emit(event)); }
}
