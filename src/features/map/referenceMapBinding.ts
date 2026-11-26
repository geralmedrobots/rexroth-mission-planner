import { MissionMonitor } from '../../domain/order/MissionMonitor';
import { normalizeMapId } from '../../domain/robot/ActiveMapResolver';
import { isLocalMessageFresh } from '../../domain/robot/TelemetryFreshness';
import { useAppStore } from '../../stores/appStore';
import { useLocatorStore } from '../locator/stores/locatorStore';
import { getActiveNavigatorOrderId } from '../mission/dispatchGate';
import { bindingKey, type ReferenceMapBinding } from './ReferenceMapPersistence';

export function configuredReferenceBinding(mapName: string): ReferenceMapBinding {
  const {host, port, https, rpcEndpoint} = useLocatorStore.getState().settings;
  return {mapName, instance: {host: host.trim().toLowerCase(), port, https, rpcEndpoint: rpcEndpoint.trim()}};
}

/** Checked immediately before any outgoing order, including a delayed confirmation. */
export function referenceDispatchIssue(): string | undefined {
  const app = useAppStore.getState();
  if (app.referenceUpdatePending) return 'Reference map update is in progress.';
  if (app.referenceReviewRequired) return 'Review the reference map coordinate alignment before dispatch.';
  const identity = app.sourceMap?.sourceIdentity;
  if (identity?.source.kind !== 'locator') return;
  const {mapId} = identity.metadata;
  if (normalizeMapId(mapId) !== app.activeNavigatorMapId ||
      (app.lastKnownValidNavigatorMapId && app.lastKnownValidNavigatorMapId !== normalizeMapId(mapId)))
    return 'The reference map does not match the current Navigator map binding.';
  const instance = identity.source.instance;
  if (!instance || bindingKey({mapName: mapId, instance}) !== bindingKey(configuredReferenceBinding(mapId)))
    return 'The configured Locator installation differs from the reference map.';
}

export function assertNoActiveMission(): void {
  const app = useAppStore.getState();
  const {status} = new MissionMonitor().calculate(app.sentOrder, app.state, {
    publishing: app.publishingOrder, publishedAtMs: app.sentOrderPublishedAtMs,
    acceptanceTimeoutMs: app.orderSettings.acceptanceTimeoutMs,
  });
  if (getActiveNavigatorOrderId(app.state) || app.state?.driving || app.state?.paused ||
      ['Publishing', 'Awaiting acceptance', 'Accepted', 'Driving', 'Paused'].includes(status))
    throw new Error('Cannot replace the reference map during an active or pending mission.');
}

export function assertNavigatorIdle(mapName: string): void {
  const app = useAppStore.getState();
  if (app.activeNavigatorMapId !== normalizeMapId(mapName) ||
      (app.lastKnownValidNavigatorMapId && app.lastKnownValidNavigatorMapId !== normalizeMapId(mapName)))
    throw new Error('Navigator map binding changed or is unresolved.');
  if (!app.mqttConnected || app.connection?.connectionState?.toUpperCase() !== 'ONLINE' || !app.state ||
      !isLocalMessageFresh(app.mqttReceiveMetadata.lastStateReceiveTime, app.orderSettings.stateStaleTimeoutMs))
    throw new Error('Fresh online Navigator state is required to confirm an idle robot.');
  assertNoActiveMission();
}
