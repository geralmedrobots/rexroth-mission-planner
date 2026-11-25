import type { AppState } from '../../stores/appStore';
import { isCurrentRouteOrder } from '../planning/RouteRevisionGuard';

type RouteStatus = {
  label: string;
  tone: 'primary' | 'success' | 'warning' | 'error';
  ready: boolean;
};

export function getRouteStatus(
  state: AppState, blocked: boolean, planningFailed: boolean, alreadySent: boolean,
): RouteStatus {
  if (state.planning) return { label: 'Calculating route', tone: 'primary', ready: false };
  if (state.validation?.valid === false) {
    const failed = state.validation.errors.some(issue =>
      issue.code === 'generation.builder' || issue.code === 'validation.exception');
    return { label: failed ? 'Validation failed' : 'Route invalid', tone: 'error', ready: false };
  }
  const order = state.generatedOrder;
  if (order && isCurrentRouteOrder(state, order, state.routeRevision) && state.validation?.valid) {
    if (alreadySent) return { label: 'Route valid · order submitted', tone: 'primary', ready: false };
    if (blocked) return { label: 'Route valid · dispatch blocked', tone: 'warning', ready: false };
    return { label: 'Ready to start', tone: 'success', ready: true };
  }
  if (planningFailed || state.plannerResult?.success === false) {
    return { label: 'Route calculation failed', tone: 'error', ready: false };
  }
  if (state.goal) return { label: 'Validation pending', tone: 'primary', ready: false };
  return { label: 'Selecting destination', tone: 'primary', ready: false };
}
