import type { RobotFootprint } from '../types';
import { createPlanningConfigurationSnapshot,
  type PlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';
import type { MotionPlannerConfigurationVariant } from './MotionPlannerReplay';

type SweepPatch = {
  distanceWeight?: number;
  headingChangeWeight?: number;
  reverseRiskWeight?: number;
  motionStateDirectionSwitchWeight?: number;
  wallProximityWeight?: number;
  wallClearancePreferredM?: number;
  motionStateTerminalOrientationWeight?: number;
};

const variant = (name: string, baseline: PlanningConfigurationSnapshot,
  footprint: RobotFootprint, patch: SweepPatch): MotionPlannerConfigurationVariant => {
  const { distanceWeight, ...passagePatch } = patch;
  return { name, configuration: createPlanningConfigurationSnapshot({
    plannerOptions: {
      ...structuredClone(baseline.planner),
      ...(distanceWeight === undefined ? {} : { distanceWeight }),
      passageSafety: { ...structuredClone(baseline.planner.passageSafety), ...passagePatch },
    },
    footprint: structuredClone(footprint), orderSettings: structuredClone(baseline.order),
  }) };
};

const oneParameterSweep = (prefix: string, field: keyof SweepPatch,
  values: readonly number[], baseline: PlanningConfigurationSnapshot,
  footprint: RobotFootprint): MotionPlannerConfigurationVariant[] => values.map((value) =>
  variant(`${prefix}=${value}`, baseline, footprint, { [field]: value }));

/** Each group varies one physical term at a time from the same immutable baseline. */
export const createMotionPlannerCalibrationSweeps = (
  baseline: PlanningConfigurationSnapshot,
  footprint: RobotFootprint,
) => ({
  reverseCostPerM: oneParameterSweep('reverseCostPerM', 'reverseRiskWeight',
    [.5, 1, 1.5, 2, 3, 4], baseline, footprint),
  rotationCostPerRad: oneParameterSweep('rotationCostPerRad', 'headingChangeWeight',
    [.1, .15, .25, .4, .6], baseline, footprint),
  clearanceCostPerM: oneParameterSweep('wallClearanceCostPerM', 'wallProximityWeight',
    [0, 2, 4, 8, 12], baseline, footprint),
  preferredClearanceM: oneParameterSweep('preferredClearanceM',
    'wallClearancePreferredM', [.3, .4, .5, .6, .8], baseline, footprint),
  directionSwitchCost: oneParameterSweep('directionSwitchCost',
    'motionStateDirectionSwitchWeight', [0, .25, .5, 1, 1.2, 1.5, 2], baseline,
    footprint),
  terminalOrientationCostPerRad: oneParameterSweep('terminalOrientationCostPerRad',
    'motionStateTerminalOrientationWeight', [0, .15, .3, .6], baseline, footprint),
});
