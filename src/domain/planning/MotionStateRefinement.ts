import { FootprintModel } from '../geometry/FootprintModel';
import type { RobotFootprint } from '../types';
import type { EffectiveMotionStateConfiguration } from './MotionStateConfiguration';

export type RefinementMode = 'normal' | 'medium' | 'tight';
export const LONG_TRANSLATION_PRIMITIVES_M = [.5, .25] as const;

/** Search resolution only. ClearanceField measures centre-to-obstacle distance,
 * so subtract the full expanded rotation envelope before comparing the existing
 * clearance preferences. This is advisory, never a collision certificate. */
export class MotionStateRefinement {
  public readonly mediumClearanceM: number;
  public readonly tightClearanceM: number;
  public readonly positionResolutionM: number;

  public constructor(footprint: RobotFootprint,
    configuration: EffectiveMotionStateConfiguration, resolutionM: number) {
    const radius = Math.max(...FootprintModel.from(footprint).expandedLocalPolygon()
      .map(({ x, y }) => Math.hypot(x, y)));
    this.tightClearanceM = radius + configuration.clearance.hardMinimumM;
    this.mediumClearanceM = radius + Math.max(configuration.clearance.hardMinimumM,
      configuration.clearance.preferredM);
    // Two positional bins per shortest step preserve nearby turning positions.
    this.positionResolutionM = Math.min(resolutionM, .05) / 2;
  }

  public mode(clearanceM: number): RefinementMode {
    if (clearanceM <= this.tightClearanceM + 1e-9) return 'tight';
    if (clearanceM <= this.mediumClearanceM + 1e-9) return 'medium';
    return 'normal';
  }

  public distances(mode: RefinementMode, resolutionM: number): number[] {
    return [...new Set([...LONG_TRANSLATION_PRIMITIVES_M,
      ...(resolutionM > .5 ? [resolutionM] : []),
      ...(mode !== 'normal' ? [.1] : []),
      ...(mode === 'tight' ? [.05, Math.min(resolutionM, .05)] : []),
    ])];
  }
}
