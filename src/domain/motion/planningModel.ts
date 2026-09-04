import type { Pose2D } from '../types';

export type MotionDirection = 'FORWARD' | 'REVERSE';

export interface MotionState extends Pose2D {
  direction: MotionDirection;
}

export type MotionActionType =
  | 'ROTATE'
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
}
