export type StartupPhase =
  | 'INITIALIZING' | 'LOADING_CONFIGURATION' | 'CONNECTING_MQTT'
  | 'CONNECTING_LOCATOR' | 'AUTHENTICATING_LOCATOR' | 'LOADING_MAPS'
  | 'RESOLVING_MAP' | 'LOADING_MAP' | 'WAITING_FOR_ROBOT'
  | 'READY' | 'DEGRADED' | 'ERROR';

export interface StartupSnapshot {
  phase:StartupPhase;
  message:string;
  retryAttempt:number;
  running:boolean;
  error?:string;
}

export interface StartupOperation {
  phase:StartupPhase;
  message:string;
  run:(signal:AbortSignal)=>Promise<void>;
  retries?:number;
  optional?:boolean;
}
