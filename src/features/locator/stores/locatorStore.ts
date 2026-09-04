import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  LocatorConnectionSettings, LocatorRasterMap, LocatorTestResult, ServerMapInfo, ServerMapSummary,
} from '../types';

export const defaultLocatorSettings: LocatorConnectionSettings = {
  host: '192.168.1.104',
  port: 18082,
  https: false,
  rpcEndpoint: '/',
  requestTimeoutMs: 15_000,
  imagePixelsPerMeter: 20,
  occupiedThreshold: 0.65,
  freeThreshold: 0.196,
  caCertificatePem: '',
  insecureDevelopmentMode: false,
  automaticConnection: true,
  automaticLogin: true,
};

interface LocatorState {
  settings: LocatorConnectionSettings;
  connectionState: 'not-configured' | 'testing' | 'ready' | 'error';
  sessionState: 'logged-out' | 'logging-in' | 'logged-in';
  sessionId?: string;
  testResult?: LocatorTestResult;
  maps: ServerMapSummary[];
  selectedMapName: string;
  activeNavigatorMapId: string;
  loadedMap?: LocatorRasterMap;
  mapInfo?: ServerMapInfo;
  lastDownloadTime?: string;
  error?: string;
  downloading: boolean;
  set: (patch: Partial<LocatorState>) => void;
  updateSettings: (patch: Partial<LocatorConnectionSettings>) => void;
  reset: () => void;
}

const transientDefaults = {
  connectionState: 'not-configured' as const,
  sessionState: 'logged-out' as const,
  maps: [] as ServerMapSummary[],
  selectedMapName: '',
  activeNavigatorMapId: '',
  downloading: false,
};

export const useLocatorStore = create<LocatorState>()(persist((set) => ({
  settings: defaultLocatorSettings,
  ...transientDefaults,
  set: (patch) => set(patch),
  updateSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
  reset: () => set({ settings: defaultLocatorSettings, ...transientDefaults }),
}), {
  name: 'rokit-locator-settings',
  partialize: (state) => ({
    settings: { ...state.settings, caCertificatePem: '', insecureDevelopmentMode: false },
    selectedMapName: state.selectedMapName,
  }),
  merge:(persisted,current)=>{
    const saved=persisted as Partial<LocatorState>;
    return {
      ...current,...saved,
      settings:{...defaultLocatorSettings,...saved.settings,caCertificatePem:''},
    };
  },
}));
