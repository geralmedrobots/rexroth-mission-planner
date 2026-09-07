import type { RobotFootprint } from '../types';
import { createPlanningConfigurationSnapshot,
  type PlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';

export type MotionPlannerCalibrationProfileName =
  'BALANCED' | 'FORWARD_PREFERRED' | 'CLEARANCE_PREFERRED';

export interface MotionPlannerCalibrationProfile {
  readonly name: MotionPlannerCalibrationProfileName;
  readonly description: string;
  readonly tradeoffs: string;
  readonly values: {
    readonly translationCostPerM: number;
    readonly rotationCostPerRad: number;
    readonly reverseCostPerM: number;
    readonly directionSwitchCost: number;
    readonly wallClearanceCostPerM: number;
    readonly preferredClearanceM: number;
    readonly hardMinimumClearanceM: number;
    readonly narrowPassageCostPerM: number;
    readonly turnLocationCost: number;
    readonly terminalOrientationCostPerRad: number;
  };
}

/**
 * Development/calibration candidates only. Production defaults are intentionally
 * not selected or changed by this module.
 */
export const MOTION_PLANNER_CALIBRATION_PROFILES:
Readonly<Record<MotionPlannerCalibrationProfileName, MotionPlannerCalibrationProfile>> = {
  BALANCED: {
    name: 'BALANCED',
    description: 'Moderately prices reverse and clearance without strongly dominating distance.',
    tradeoffs: 'May retain short reverse manoeuvres and accepts modest detours for clearance.',
    values: {
      translationCostPerM: 1, rotationCostPerRad: .25, reverseCostPerM: .5,
      directionSwitchCost: 1.2, wallClearanceCostPerM: 3,
      preferredClearanceM: .35, hardMinimumClearanceM: .1,
      narrowPassageCostPerM: 1.5, turnLocationCost: 1,
      terminalOrientationCostPerRad: .15,
    },
  },
  FORWARD_PREFERRED: {
    name: 'FORWARD_PREFERRED',
    description: 'Makes sustained reverse travel more expensive than a modest safe rotation.',
    tradeoffs: 'Can add rotation and forward distance where a short reverse manoeuvre is valid.',
    values: {
      translationCostPerM: 1, rotationCostPerRad: .25, reverseCostPerM: 3,
      directionSwitchCost: 1, wallClearanceCostPerM: 3,
      preferredClearanceM: .35, hardMinimumClearanceM: .1,
      narrowPassageCostPerM: 1.5, turnLocationCost: 1,
      terminalOrientationCostPerRad: .15,
    },
  },
  CLEARANCE_PREFERRED: {
    name: 'CLEARANCE_PREFERRED',
    description: 'Pays more distance to avoid sustained operation inside preferred clearance.',
    tradeoffs: 'Produces longer routes in open alternatives and can search more states.',
    values: {
      translationCostPerM: 1, rotationCostPerRad: .25, reverseCostPerM: 1.5,
      directionSwitchCost: 1.5, wallClearanceCostPerM: 8,
      preferredClearanceM: .8, hardMinimumClearanceM: .1,
      narrowPassageCostPerM: 1.5, turnLocationCost: 1,
      terminalOrientationCostPerRad: .15,
    },
  },
} as const;

export const applyMotionPlannerCalibrationProfile = (
  baseline: PlanningConfigurationSnapshot,
  footprint: RobotFootprint,
  profile: MotionPlannerCalibrationProfile,
): PlanningConfigurationSnapshot => {
  const values = profile.values;
  return createPlanningConfigurationSnapshot({
    plannerOptions: {
      ...structuredClone(baseline.planner),
      distanceWeight: values.translationCostPerM,
      passageSafety: {
        ...structuredClone(baseline.planner.passageSafety),
        headingChangeWeight: values.rotationCostPerRad,
        reverseRiskWeight: values.reverseCostPerM,
        motionStateDirectionSwitchWeight: values.directionSwitchCost,
        wallProximityWeight: values.wallClearanceCostPerM,
        wallClearancePreferredM: values.preferredClearanceM,
        wallClearanceMinimumM: values.hardMinimumClearanceM,
        narrowPassageWeight: values.narrowPassageCostPerM,
        turnLocationWeight: values.turnLocationCost,
        motionStateTerminalOrientationWeight: values.terminalOrientationCostPerRad,
      },
    },
    footprint: structuredClone(footprint),
    orderSettings: structuredClone(baseline.order),
  });
};
