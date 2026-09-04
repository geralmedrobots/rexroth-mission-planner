/// <reference lib="webworker" />
import { planSynchronously, type PlannerRequest } from '../domain/planner/PlannerService';
import { plannerDiagnostics } from './plannerDiagnostics';
self.onmessage = (event: MessageEvent<PlannerRequest>): void => {
  const result = planSynchronously(event.data);
  self.postMessage({ ...result, diagnosticEvents: plannerDiagnostics(event.data, result) });
};
