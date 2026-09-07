import type { DiagnosticEvent } from '../features/diagnostics/DiagnosticEvent';
import { createDiagnosticEvent } from '../features/diagnostics/DiagnosticEvent';
import type { PlannerRequest } from '../domain/planner/PlannerService';
import type { PlannerResult } from '../domain/types';

export const plannerDiagnostics = (request: PlannerRequest, result: PlannerResult): DiagnosticEvent[] => {
  const context = request.diagnosticContext;
  if (!context) return [];
  const base = { ...context, stage: 'planner' as const };
  const events: DiagnosticEvent[] = [createDiagnosticEvent({
    ...base, severity: 'info', eventType: 'planner.started', message: 'Planner started.',
  }), createDiagnosticEvent({
    ...base, severity: 'info', eventType: 'planner.completed',
    message: result.success ? 'Planner completed.' : result.error ?? 'Planner failed.',
    payload: { success: result.success, rawPointCount: result.rawPath.length, finalPointCount: result.finalPath.length },
  })];
  const motionEvents = result.motionPlannerEvents ?? (result.motionPlan?.diagnostics?.events as Array<Record<string, unknown>> | undefined) ?? [];
  motionEvents.forEach((item) => {
    const eventType = typeof item.eventType === 'string' ? item.eventType : 'motionplanner.summary';
    const payload = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'eventType'));
    const stage = eventType.startsWith('collision.') ? 'collision' as const :
      eventType.startsWith('motionplan.') ? 'motionplan' as const : 'planner' as const;
    const severity = eventType.endsWith('failed') ? 'error' as const :
      eventType.endsWith('rejected') ? 'warning' as const : 'info' as const;
    events.push(createDiagnosticEvent({ ...base, stage, severity, eventType,
      message: eventType, payload }));
  });
  if (result.success) events.push(createDiagnosticEvent({
    ...base, severity: 'info', eventType: 'planner.cost', message: 'Planner cost calculated.',
    payload: { durationMs: result.statistics.durationMs, visitedCells: result.statistics.visitedCells },
  }));
  return events;
};
