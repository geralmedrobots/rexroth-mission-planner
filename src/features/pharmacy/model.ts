export const pharmacyTitle = 'Pharmacy → Urgencies → Charging Station';
export const names = [
  'Charging station',
  'Pharmacy_w8_4_medicine',
  'Pharmacy_w8_4_elevator',
  'Pharmacy_inside_elevator',
  'Urgencies_inside_elevator',
  'Urgencies_w8_4_elevator',
  'Urgencies_deliver_medicine',
] as const;
export type LocationName = (typeof names)[number];
type WaitKind =
  | 'WAITING_FOR_MEDICINE_LOADING'
  | 'WAITING_FOR_ELEVATOR_OPEN'
  | 'WAITING_FOR_FLOOR_TRANSITION'
  | 'WAITING_FOR_MEDICINE_UNLOADING';
export type Step =
  | { stage: string; kind: 'navigate' | 'localise' | 'complete'; at: string }
  | {
      stage: string;
      kind: 'confirm' | 'transition';
      at: string;
      destination?: string;
      state: WaitKind;
      prompt: string;
      yes: string;
    };
const [dock, load, lobby, cabin, upperCabin, upperLobby, ward] = names;
const open = 'Is the elevator open and safe to enter?';
export const stages = [
  'Medication collection',
  'Enter pharmacy elevator',
  'Transition to urgencies',
  'Medication delivery',
  'Return to elevator',
  'Transition to pharmacy',
  'Return to charging station',
];
export const steps: Step[] = [
  { stage: 'A', kind: 'localise', at: dock },
  { stage: 'A', kind: 'navigate', at: load },
  {
    stage: 'A',
    kind: 'confirm',
    at: load,
    state: 'WAITING_FOR_MEDICINE_LOADING',
    prompt: 'Has the medicine been placed inside the robot?',
    yes: 'Yes, medicine loaded.',
  },
  { stage: 'B', kind: 'navigate', at: lobby },
  {
    stage: 'B',
    kind: 'confirm',
    at: lobby,
    state: 'WAITING_FOR_ELEVATOR_OPEN',
    prompt: open,
    yes: 'Yes, safe to enter.',
  },
  { stage: 'B', kind: 'navigate', at: cabin },
  {
    stage: 'C',
    kind: 'transition',
    at: cabin,
    destination: upperCabin,
    state: 'WAITING_FOR_FLOOR_TRANSITION',
    prompt: 'Has the elevator reached the urgencies floor?',
    yes: 'Yes, urgencies floor reached.',
  },
  { stage: 'C', kind: 'localise', at: upperCabin },
  { stage: 'C', kind: 'navigate', at: upperLobby },
  { stage: 'D', kind: 'navigate', at: ward },
  {
    stage: 'D',
    kind: 'confirm',
    at: ward,
    state: 'WAITING_FOR_MEDICINE_UNLOADING',
    prompt: 'Has the medicine been removed from the robot?',
    yes: 'Yes, medicine removed.',
  },
  { stage: 'E', kind: 'navigate', at: upperLobby },
  {
    stage: 'E',
    kind: 'confirm',
    at: upperLobby,
    state: 'WAITING_FOR_ELEVATOR_OPEN',
    prompt: open,
    yes: 'Yes, safe to enter.',
  },
  { stage: 'E', kind: 'navigate', at: upperCabin },
  {
    stage: 'F',
    kind: 'transition',
    at: upperCabin,
    destination: cabin,
    state: 'WAITING_FOR_FLOOR_TRANSITION',
    prompt: 'Has the elevator reached the pharmacy floor?',
    yes: 'Yes, pharmacy floor reached.',
  },
  { stage: 'F', kind: 'localise', at: cabin },
  { stage: 'F', kind: 'navigate', at: lobby },
  { stage: 'G', kind: 'navigate', at: dock },
  { stage: 'G', kind: 'complete', at: dock },
];
export type Phase =
  | WaitKind
  | 'PREFLIGHT_VALIDATION'
  | 'VALIDATING_ROUTE'
  | 'NAVIGATING'
  | 'VERIFYING_ARRIVAL'
  | 'VERIFYING_LOCALISATION'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'CANCELLING'
  | 'RECOVERY_REQUIRED';
export interface BoundPoint {
  id: string;
  mapId: string;
  x: number;
  y: number;
  theta: number;
  displayName: string;
}
export interface DeliveryRun {
  id: string;
  revision: number;
  index: number;
  phase: Phase;
  started: number;
  ended?: number;
  reason?: string;
  order?: {
    id: string;
    lastNode: string;
    sequence: number;
    issued: number;
    previousId?: string;
    accepted?: boolean;
  };
  cancelId?: string;
  lastVerified?: string;
  charging?: boolean;
  events: { at: number; index: number; message: string }[];
}
export interface DeliveryView {
  run?: DeliveryRun;
  archive: DeliveryRun[];
  maps: string[];
  prepared?: string;
  speed?: number;
  connected: boolean;
  floor?: string;
  localisation: string;
  readiness?: string;
  problem?: string;
}
export const terminal = (r: DeliveryRun) => r.phase === 'COMPLETED' || r.phase === 'CANCELLED';
