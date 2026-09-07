import type { PlannerOptions, RobotFootprint } from '../types';

export const MOTION_STATE_HEADING_BINS = 16;
export const MOTION_STATE_HEADING_STEP_RAD = 2 * Math.PI / MOTION_STATE_HEADING_BINS;

export interface EffectiveMotionStateConfiguration {
  readonly schemaVersion: 'stage-5a';
  readonly weights: {
    readonly translationCostPerM: number;
    readonly rotationCostPerRad: number;
    readonly reverseCostPerM: number;
    readonly directionSwitchCost: number;
    readonly wallClearanceCost: number;
    readonly narrowPassageCost: number;
    readonly turnLocationCost: number;
    readonly terminalOrientationCostPerRad: number;
  };
  readonly clearance: {
    readonly preferredM: number;
    readonly hardMinimumM: number;
  };
  readonly passage: {
    readonly maximumWidthM: number;
  };
  readonly sampling: {
    readonly translationCollisionIntervalM: number;
    readonly rotationCollisionIntervalDeg: number;
    readonly rotationCollisionIntervalRad: number;
  };
  readonly lattice: {
    readonly headingBinCount: number;
    readonly headingStepRad: number;
    readonly headingStepDeg: number;
    readonly translationStepSource: 'GRID_RESOLUTION';
  };
  readonly permissions: {
    readonly forward: boolean;
    readonly reverse: boolean;
    readonly rotateInPlace: boolean;
  };
  readonly footprint: {
    readonly lengthM: number;
    readonly widthM: number;
    readonly centerOffsetXM: number;
    readonly centerOffsetYM: number;
    readonly configuredSafetyMarginM: number;
    readonly planningSafetyMarginM: number;
    readonly localizationMarginM: number;
    readonly effectiveSafetyMarginM: number;
  };
  readonly unknownCellsBlocked: true;
  readonly maximumPlanningTimeMs: number;
}

export interface MotionStateParameterDefinition {
  key: string;
  source: string;
  defaultValue: number | string;
  ui: string;
  normalizedField: string;
  consumer: string;
  units: string;
  classification: 'hard-feasibility' | 'soft-preference' | 'search-discretisation' |
    'permission' | 'execution-bound';
}

/** Auditable mapping from compatibility settings to the authoritative schema. */
export const MOTION_STATE_PARAMETER_SCHEMA: readonly MotionStateParameterDefinition[] = [
  { key: 'translationWeight', source: 'plannerOptions.distanceWeight', defaultValue: 1,
    ui: 'Legacy planner settings (hidden as a motion-state control)',
    normalizedField: 'weights.translationCostPerM', consumer: 'CostModel.distance / heuristic',
    units: 'cost/m', classification: 'soft-preference' },
  { key: 'rotationWeight', source: 'passageSafety.headingChangeWeight', defaultValue: .15,
    ui: 'Heading change weight (legacy mapping)', normalizedField: 'weights.rotationCostPerRad',
    consumer: 'CostModel.rotation', units: 'cost/rad', classification: 'soft-preference' },
  { key: 'reverseWeight', source: 'passageSafety.reverseRiskWeight', defaultValue: 2,
    ui: 'Reverse risk weight (legacy mapping)', normalizedField: 'weights.reverseCostPerM',
    consumer: 'CostModel.motionStateReverseRisk', units: 'cost/m', classification: 'soft-preference' },
  { key: 'directionSwitchWeight', source: 'passageSafety.motionStateDirectionSwitchWeight', defaultValue: 1,
    ui: 'Effective configuration only', normalizedField: 'weights.directionSwitchCost',
    consumer: 'CostModel.motionStateDirectionSwitch', units: 'cost/switch', classification: 'soft-preference' },
  { key: 'wallWeight', source: 'passageSafety.wallProximityWeight', defaultValue: 2,
    ui: 'Wall proximity weight (legacy mapping)', normalizedField: 'weights.wallClearanceCost',
    consumer: 'CostModel.motionStateWallProximity', units: 'cost/m', classification: 'soft-preference' },
  { key: 'preferredClearance', source: 'passageSafety.wallClearancePreferredM', defaultValue: .3,
    ui: 'Preferred wall clearance m', normalizedField: 'clearance.preferredM',
    consumer: 'CostModel.motionStateWallProximity', units: 'm', classification: 'soft-preference' },
  { key: 'hardMinimumClearance', source: 'passageSafety.wallClearanceMinimumM', defaultValue: .1,
    ui: 'Minimum wall clearance m', normalizedField: 'clearance.hardMinimumM',
    consumer: 'MotionStatePlanner / MotionPlanOptimiser', units: 'm', classification: 'hard-feasibility' },
  { key: 'narrowPassageWeight', source: 'passageSafety.narrowPassageWeight', defaultValue: 1.5,
    ui: 'Narrow passage weight', normalizedField: 'weights.narrowPassageCost',
    consumer: 'CostModel.motionStateNarrowPassage', units: 'cost/m', classification: 'soft-preference' },
  { key: 'turnLocationWeight', source: 'passageSafety.turnLocationWeight', defaultValue: 1,
    ui: 'Turn location weight', normalizedField: 'weights.turnLocationCost',
    consumer: 'CostModel.motionStateTurnLocation', units: 'cost*m/rad', classification: 'soft-preference' },
  { key: 'terminalOrientationWeight', source: 'passageSafety.motionStateTerminalOrientationWeight', defaultValue: .15,
    ui: 'Effective configuration only', normalizedField: 'weights.terminalOrientationCostPerRad',
    consumer: 'CostModel.rotation', units: 'cost/rad', classification: 'soft-preference' },
  { key: 'translationCollisionInterval', source: 'plannerOptions.collisionSampleInterval', defaultValue: .03,
    ui: 'Advanced planner collision sampling', normalizedField: 'sampling.translationCollisionIntervalM',
    consumer: 'TranslationSweepChecker / metrics / optimiser / validator', units: 'm', classification: 'hard-feasibility' },
  { key: 'rotationCollisionInterval', source: 'passageSafety.rotationCollisionSampleDeg', defaultValue: 5,
    ui: 'Rotation collision sample deg', normalizedField: 'sampling.rotationCollisionIntervalDeg',
    consumer: 'RotationSweepChecker / optimiser / validator', units: 'deg', classification: 'hard-feasibility' },
  { key: 'headingBins', source: 'compile-time constant', defaultValue: 16,
    ui: 'Read-only', normalizedField: 'lattice.headingBinCount',
    consumer: 'MotionStatePlanner', units: 'bins', classification: 'search-discretisation' },
  { key: 'translationStep', source: 'OccupancyGrid.metadata.resolution', defaultValue: 'map resolution',
    ui: 'Read-only map metadata', normalizedField: 'lattice.translationStepSource',
    consumer: 'MotionStatePlanner', units: 'm', classification: 'search-discretisation' },
  { key: 'forwardPermission', source: 'footprint.forwardAllowed', defaultValue: 'true',
    ui: 'Robot motion configuration', normalizedField: 'permissions.forward',
    consumer: 'MotionStatePlanner', units: 'boolean', classification: 'permission' },
  { key: 'reversePermission', source: 'footprint.backwardAllowed ?? allowReverse', defaultValue: 'false',
    ui: 'Allow reverse motion', normalizedField: 'permissions.reverse',
    consumer: 'MotionStatePlanner / optimiser / validator', units: 'boolean', classification: 'permission' },
  { key: 'rotatePermission', source: 'footprint.turnOnSpotAllowed ?? allowTurnOnSpot', defaultValue: 'true',
    ui: 'Robot motion configuration', normalizedField: 'permissions.rotateInPlace',
    consumer: 'MotionStatePlanner', units: 'boolean', classification: 'permission' },
  { key: 'effectiveSafetyMargin', source: 'max(footprint.safetyMargin, planningSafetyMargin + localizationMargin)', defaultValue: .1,
    ui: 'Planning and localization margins', normalizedField: 'footprint.effectiveSafetyMarginM',
    consumer: 'PoseCollisionChecker / sweep checkers / narrow-passage cost', units: 'm', classification: 'hard-feasibility' },
  { key: 'maximumPassageWidth', source: 'passageSafety.maximumPassageWidthM', defaultValue: 1.8,
    ui: 'Passage settings', normalizedField: 'passage.maximumWidthM',
    consumer: 'CostModel.motionStateNarrowPassage', units: 'm', classification: 'soft-preference' },
  { key: 'maximumPlanningTime', source: 'plannerOptions.maxPlanningTimeMs', defaultValue: 3000,
    ui: 'Maximum planning time ms', normalizedField: 'maximumPlanningTimeMs',
    consumer: 'MotionStatePlanner', units: 'ms', classification: 'execution-bound' },
  { key: 'unknownCellsBlocked', source: 'motion-state invariant', defaultValue: 'true',
    ui: 'Read-only', normalizedField: 'unknownCellsBlocked',
    consumer: 'PoseCollisionChecker / clearance field', units: 'boolean', classification: 'hard-feasibility' },
] as const;

export const createEffectiveMotionStateConfiguration = (
  planner: PlannerOptions,
  footprint: RobotFootprint,
): EffectiveMotionStateConfiguration => {
  const rotationDeg = planner.passageSafety.rotationCollisionSampleDeg;
  return {
    schemaVersion: 'stage-5a',
    weights: {
      translationCostPerM: planner.distanceWeight,
      rotationCostPerRad: planner.passageSafety.headingChangeWeight,
      reverseCostPerM: planner.passageSafety.reverseRiskWeight,
      directionSwitchCost: planner.passageSafety.motionStateDirectionSwitchWeight,
      wallClearanceCost: planner.passageSafety.wallProximityWeight,
      narrowPassageCost: planner.passageSafety.narrowPassageWeight,
      turnLocationCost: planner.passageSafety.turnLocationWeight,
      terminalOrientationCostPerRad:
        planner.passageSafety.motionStateTerminalOrientationWeight,
    },
    clearance: {
      preferredM: planner.passageSafety.wallClearancePreferredM,
      hardMinimumM: planner.passageSafety.wallClearanceMinimumM,
    },
    passage: { maximumWidthM: planner.passageSafety.maximumPassageWidthM },
    sampling: {
      translationCollisionIntervalM: planner.collisionSampleInterval,
      rotationCollisionIntervalDeg: rotationDeg,
      rotationCollisionIntervalRad: rotationDeg * Math.PI / 180,
    },
    lattice: {
      headingBinCount: MOTION_STATE_HEADING_BINS,
      headingStepRad: MOTION_STATE_HEADING_STEP_RAD,
      headingStepDeg: 360 / MOTION_STATE_HEADING_BINS,
      translationStepSource: 'GRID_RESOLUTION',
    },
    permissions: {
      forward: footprint.forwardAllowed ?? true,
      reverse: footprint.backwardAllowed ?? footprint.allowReverse,
      rotateInPlace: footprint.turnOnSpotAllowed ?? footprint.allowTurnOnSpot,
    },
    footprint: {
      lengthM: footprint.length,
      widthM: footprint.width,
      centerOffsetXM: footprint.centerOffsetX,
      centerOffsetYM: footprint.centerOffsetY,
      configuredSafetyMarginM: footprint.safetyMargin,
      planningSafetyMarginM: planner.passageSafety.planningSafetyMarginM,
      localizationMarginM: planner.passageSafety.localizationMarginM,
      effectiveSafetyMarginM: Math.max(footprint.safetyMargin,
        planner.passageSafety.planningSafetyMarginM +
        planner.passageSafety.localizationMarginM),
    },
    unknownCellsBlocked: true,
    maximumPlanningTimeMs: planner.maxPlanningTimeMs,
  };
};
