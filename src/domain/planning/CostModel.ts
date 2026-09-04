import type { PlannerOptions } from '../types';

export interface CostTerms { distance: number; wallProximity: number; narrowPassage: number; headingChange: number; turnLocation: number; reverseRisk: number; total: number }
export const CostModel = {
  distance(distanceM: number, weight: number): number { return distanceM * weight; },
  rotation(angleRad: number, weight: number): number { return weight * angleRad; },
  wallProximity(clearanceM: number, options: PlannerOptions): number {
    const preferred = options.passageSafety.wallClearancePreferredM;
    return options.policy === 'reliable' || options.reliableBaselineMode ? 0 : options.passageSafety.wallProximityWeight * Math.max(0, preferred - clearanceM) ** 2 / Math.max(preferred, 0.01);
  },
  narrowPassage(clearanceM: number, footprintWidthM: number, safetyMarginM: number, options: PlannerOptions): number {
    const width = clearanceM * 2; const required = footprintWidthM + 2 * safetyMarginM;
    return options.policy === 'reliable' || options.reliableBaselineMode || width >= options.passageSafety.maximumPassageWidthM ? 0 : options.passageSafety.narrowPassageWeight / Math.max(0.05, width - required + 0.05);
  },
  headingChange(angleRad: number, options: PlannerOptions): number { return options.passageSafety.headingChangeWeight * angleRad; },
  turnLocation(angleRad: number, clearanceM: number, options: PlannerOptions, minimumClearanceM = 0.000001): number { return options.passageSafety.turnLocationWeight * angleRad / Math.max(clearanceM, minimumClearanceM); },
  reverseRisk(reverse: boolean, options: PlannerOptions): number { return reverse ? options.passageSafety.reverseRiskWeight : 0; },
  directionSwitchPenalty(options: PlannerOptions): number { return 0.5 * options.passageSafety.reverseRiskWeight; },
  directionSwitch(previous: string | undefined, next: string, options: PlannerOptions): number { return previous && previous !== next ? CostModel.directionSwitchPenalty(options) : 0; },
  astarTerms(distanceM: number, clearanceM: number, headingChangeRad: number | undefined, reverse: boolean, isTurn: boolean, footprintWidthM: number, safetyMarginM: number, options: PlannerOptions): CostTerms {
    const distance = CostModel.distance(distanceM, options.distanceWeight);
    const wallProximity = CostModel.wallProximity(clearanceM, options);
    const narrowPassage = CostModel.narrowPassage(clearanceM, footprintWidthM, safetyMarginM, options);
    const headingChange = !isTurn || headingChangeRad === undefined ? 0 : CostModel.headingChange(headingChangeRad, options);
    const turnLocation = !isTurn || headingChangeRad === undefined ? 0 : CostModel.turnLocation(headingChangeRad, clearanceM, options);
    const reverseRisk = !isTurn && headingChangeRad === undefined ? 0 : CostModel.reverseRisk(reverse, options);
    return { distance, wallProximity, narrowPassage, headingChange, turnLocation, reverseRisk, total: distance + wallProximity + narrowPassage + headingChange + turnLocation + reverseRisk };
  },
};
