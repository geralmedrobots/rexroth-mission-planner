import { defaultFootprint, defaultOrderSettings, defaultPlannerOptions } from '../defaults';
import type { OrderSettings, PlannerOptions, RobotFootprint } from '../types';
import { createEffectiveMotionStateConfiguration,
  type EffectiveMotionStateConfiguration } from './MotionStateConfiguration';

type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/**
 * The normalized inputs used by one planning/order-generation attempt.
 *
 * Legacy mapping (kept deliberately explicit while old settings remain public):
 * - plannerOptions.passageSafety.* remains the source for wall, passage, heading,
 *   turn-location, reverse, doorway and rotation-sampling fields.
 * - plannerOptions.corridor.* remains the source for unknown-cell and corridor fields.
 * - footprint.forwardAllowed/backwardAllowed/turnOnSpotAllowed are normalized to
 *   the corresponding kinematic permissions, falling back to allowReverse and
 *   allowTurnOnSpot when the legacy aliases are absent.
 * - plannerOptions.waypointSpacing is retained as the legacy planner value;
 *   passageSafety.preferred/minimum/maximumWaypointSpacingM are the normalized
 *   densification values.
 * - OrderSettings is snapshotted as the VDA serialization and order-runtime group.
 */
export interface PlanningConfigurationSnapshot {
  readonly planner: DeepReadonly<PlannerOptions>;
  readonly footprint: DeepReadonly<RobotFootprint>;
  readonly order: DeepReadonly<OrderSettings>;
  readonly normalized: {
    readonly map: { readonly unknownCellsBlocked: boolean };
    readonly permissions: { readonly forwardAllowed: boolean; readonly reverseAllowed: boolean; readonly turnOnSpotAllowed: boolean };
    readonly footprint: { readonly safetyMarginM: number; readonly planningSafetyMarginM: number; readonly localizationMarginM: number };
    readonly sampling: { readonly collisionIntervalM: number; readonly rotationStepDeg: number };
    readonly waypointSpacingM: { readonly preferred: number; readonly minimum: number; readonly maximum: number };
    readonly wall: { readonly preferredClearanceM: number; readonly minimumClearanceM: number; readonly proximityWeight: number };
    readonly passage: { readonly minimumWidthM: number; readonly maximumWidthM: number; readonly narrowWeight: number };
    readonly weights: { readonly distance: number; readonly headingChange: number; readonly turnLocation: number; readonly reverseRisk: number; readonly directionSwitch: number };
    readonly finalOrientation: { readonly enforced: boolean };
    readonly corridor: DeepReadonly<PlannerOptions['corridor']>;
    /** The only configuration consumed by motion-state search and post-processing. */
    readonly motionState: DeepReadonly<EffectiveMotionStateConfiguration>;
  };
}

const finite = (name: string, value: number): number => {
  if (!Number.isFinite(value)) throw new Error(`Planning configuration field ${name} must be finite.`);
  return value;
};

const clone = <T>(value: T): T => structuredClone(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
};

export interface PlanningConfigurationInput {
  plannerOptions?: Omit<Partial<PlannerOptions>, 'passageSafety' | 'corridor'> & { passageSafety?: Partial<PlannerOptions['passageSafety']>; corridor?: Partial<PlannerOptions['corridor']> };
  footprint?: Partial<RobotFootprint>;
  orderSettings?: Partial<OrderSettings>;
}

export const createPlanningConfigurationSnapshot = (input: PlanningConfigurationInput = {}): PlanningConfigurationSnapshot => {
  const plannerOptions: PlannerOptions = {
    ...clone(defaultPlannerOptions), ...input.plannerOptions,
    passageSafety: { ...defaultPlannerOptions.passageSafety, ...input.plannerOptions?.passageSafety },
    corridor: { ...defaultPlannerOptions.corridor, ...input.plannerOptions?.corridor },
  };
  const footprint: RobotFootprint = { ...clone(defaultFootprint), ...input.footprint };
  const order: OrderSettings = { ...defaultOrderSettings, ...input.orderSettings };
  for (const [name, value] of Object.entries({
    distanceWeight: plannerOptions.distanceWeight, collisionSampleInterval: plannerOptions.collisionSampleInterval,
    motionStateDirectionSwitchWeight: plannerOptions.passageSafety.motionStateDirectionSwitchWeight,
    motionStateTerminalOrientationWeight: plannerOptions.passageSafety.motionStateTerminalOrientationWeight,
    safetyMargin: footprint.safetyMargin, planningSafetyMarginM: plannerOptions.passageSafety.planningSafetyMarginM,
    localizationMarginM: plannerOptions.passageSafety.localizationMarginM,
  })) finite(name, value);
  const reverseAllowed = footprint.backwardAllowed ?? footprint.allowReverse;
  const forwardAllowed = footprint.forwardAllowed ?? true;
  const turnOnSpotAllowed = footprint.turnOnSpotAllowed ?? footprint.allowTurnOnSpot;
  return freeze({ planner: plannerOptions, footprint, order, normalized: {
    map: { unknownCellsBlocked: plannerOptions.corridor.unknownCellsBlocked },
    permissions: { forwardAllowed, reverseAllowed, turnOnSpotAllowed },
    footprint: { safetyMarginM: footprint.safetyMargin, planningSafetyMarginM: plannerOptions.passageSafety.planningSafetyMarginM, localizationMarginM: plannerOptions.passageSafety.localizationMarginM },
    sampling: { collisionIntervalM: plannerOptions.collisionSampleInterval, rotationStepDeg: plannerOptions.passageSafety.rotationCollisionSampleDeg },
    waypointSpacingM: { preferred: plannerOptions.passageSafety.preferredWaypointSpacingM, minimum: plannerOptions.passageSafety.minimumWaypointSpacingM, maximum: plannerOptions.passageSafety.maximumWaypointSpacingM },
    wall: { preferredClearanceM: plannerOptions.passageSafety.wallClearancePreferredM, minimumClearanceM: plannerOptions.passageSafety.wallClearanceMinimumM, proximityWeight: plannerOptions.passageSafety.wallProximityWeight },
    passage: { minimumWidthM: plannerOptions.passageSafety.minimumPassageWidthM, maximumWidthM: plannerOptions.passageSafety.maximumPassageWidthM, narrowWeight: plannerOptions.passageSafety.narrowPassageWeight },
    weights: { distance: plannerOptions.distanceWeight, headingChange: plannerOptions.passageSafety.headingChangeWeight, turnLocation: plannerOptions.passageSafety.turnLocationWeight, reverseRisk: plannerOptions.passageSafety.reverseRiskWeight, directionSwitch: plannerOptions.passageSafety.motionStateDirectionSwitchWeight },
    finalOrientation: { enforced: plannerOptions.finalOrientationEnforcement }, corridor: plannerOptions.corridor,
    motionState: createEffectiveMotionStateConfiguration(plannerOptions, footprint),
  } });
};
