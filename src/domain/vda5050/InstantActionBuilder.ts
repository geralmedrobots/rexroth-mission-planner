import type { OrderSettings, VdaInstantAction, VdaInstantActionMessage } from '../types';

let instantHeader = 0;
const supported = new Set<VdaInstantAction>(['cancelOrder','factsheetRequest']);
export const isInstantActionSupported = (action: VdaInstantAction): boolean => supported.has(action);

export class InstantActionBuilder {
  public build(actionType: VdaInstantAction, settings: OrderSettings): VdaInstantActionMessage {
    if (!supported.has(actionType)) throw new Error(`${actionType} is not supported for VDA 5050 2.0.0.`);
    return {
      headerId: instantHeader++, timestamp: new Date().toISOString(), version: '2.0.0',
      manufacturer: settings.manufacturer, serialNumber: settings.serialNumber,
      actions: [{ actionType, actionId: crypto.randomUUID(), blockingType: 'NONE' }],
    };
  }
}
