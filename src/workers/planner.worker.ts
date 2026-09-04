/// <reference lib="webworker" />
import { planSynchronously, type PlannerRequest } from '../domain/planner/PlannerService';
self.onmessage = (event: MessageEvent<PlannerRequest>): void => self.postMessage(planSynchronously(event.data));
