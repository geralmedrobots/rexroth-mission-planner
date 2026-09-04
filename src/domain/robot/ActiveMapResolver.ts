import type { ConfirmedMapBinding, NavigatorMapIdSource } from '../types';

export const normalizeMapId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

export const compareMapIds = (
  locatorMapName: string | null | undefined,
  navigatorMapId: string | null | undefined,
): { matches: boolean; locator: string | null; navigator: string | null } => {
  const locator = normalizeMapId(locatorMapName);
  const navigator = normalizeMapId(navigatorMapId);
  return { matches: locator !== null && navigator !== null && locator === navigator, locator, navigator };
};

export interface ActiveMapIdResolverInput {
  stateMapId: string | null;
  visualizationMapId: string | null;
  lastKnownValidMapId: string | null;
  confirmedBinding: ConfirmedMapBinding | null;
  manufacturer: string;
  serialNumber: string;
}

/** Resolves an active map without ever treating an unconfirmed Locator map as authoritative. */
export const resolveActiveNavigatorMapId = (
  input: ActiveMapIdResolverInput,
): { mapId: string | null; source: NavigatorMapIdSource } => {
  const stateMapId = normalizeMapId(input.stateMapId);
  if (stateMapId) return { mapId: stateMapId, source: 'state' };
  const visualizationMapId = normalizeMapId(input.visualizationMapId);
  if (visualizationMapId) return { mapId: visualizationMapId, source: 'visualization' };
  const lastKnown = normalizeMapId(input.lastKnownValidMapId);
  if (lastKnown) return { mapId: lastKnown, source: 'last-known' };
  const binding=input.confirmedBinding;
  const boundMap=normalizeMapId(binding?.locatorMapName);
  if(binding&&boundMap&&binding.manufacturer===input.manufacturer&&
      binding.serialNumber===input.serialNumber) {
    return {mapId:boundMap,source:'manual-confirmed'};
  }
  return { mapId: null, source: 'none' };
};

export const resolveActiveNavigatorMap = resolveActiveNavigatorMapId;

export const payloadMatchesRobotIdentity = (
  payload: { manufacturer?: string; serialNumber?: string; version?: string },
  configured: { manufacturer: string; serialNumber: string; version: string },
): boolean => payload.manufacturer === configured.manufacturer
  && payload.serialNumber === configured.serialNumber
  && payload.version === configured.version;
