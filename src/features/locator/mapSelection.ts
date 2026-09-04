import type { ServerMapSummary } from './types';
import { normalizeMapId } from '../../domain/robot/ActiveMapResolver';

export const findExactServerMap = (
  maps: ServerMapSummary[], activeNavigatorMapId: string,
): ServerMapSummary | undefined => {
  const active=normalizeMapId(activeNavigatorMapId);
  return active===null?undefined:maps.find((map)=>normalizeMapId(map.name)===active);
};
