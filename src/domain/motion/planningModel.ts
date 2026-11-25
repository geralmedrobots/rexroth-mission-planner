import type { Pose2D } from '../types';

export type MotionDirection = 'FORWARD' | 'REVERSE';

export interface MotionState extends Pose2D {
  direction: MotionDirection;
  /** Discrete heading identity used by MotionStatePlanner. */
  thetaBin?: number;
  row?: number;
  column?: number;
  /** Cost history for the pending manoeuvre; independent of physical direction. */
  directionPreferenceContext?: { heading: number; direction: MotionDirection; translating: boolean };
}

export type MotionActionType =
  | 'ROTATE' | 'ROTATE_IN_PLACE'
  | 'TRANSLATE_FORWARD'
  | 'TRANSLATE_REVERSE'
  | 'DIRECTION_CHANGE';

export interface MotionAction {
  type: MotionActionType;
  from: MotionState;
  to: MotionState;
  distanceM?: number;
  rotationRad?: number;
  metadata?: Record<string, unknown>;
  costComponents?: MotionCostComponents;
}

export interface MotionCostComponents {
  distance: number;
  rotation: number;
  reverse: number;
  /** Compatibility key: once-per-manoeuvre non-preferred direction cost. */
  directionSwitch: number;
  wallClearance: number;
  narrowPassage: number;
  turnLocation: number;
  terminalOrientation: number;
  total: number;
}

export interface MotionPlanMetadata {
  source?: string;
  cost?: number;
  mapId?: string;
  plannerVersion?: string;
  [key: string]: unknown;
}

export interface MotionPlan {
  states: MotionState[];
  actions: MotionAction[];
  metadata: MotionPlanMetadata;
  diagnostics?: Record<string, unknown>;
}
