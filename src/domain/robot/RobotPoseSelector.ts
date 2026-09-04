import type {
  ActiveMapResolution, RobotPose, RobotPoseSnapshot, VdaState, VdaVisualization,
} from '../types';

const finitePose = (pose: RobotPose | undefined): pose is RobotPose =>
  Boolean(pose && Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.theta));

export interface PoseSelectionInput {
  state?: VdaState;
  visualization?: VdaVisualization;
  lastStateReceiveTime?: number;
  lastVisualizationReceiveTime?: number;
  stateFresh?: boolean;
  visualizationFresh?: boolean;
  activeMapResolution?: ActiveMapResolution;
}

/** Selects the newest fresh finite pose and applies the independently resolved Navigator mapId. */
export const selectCurrentRobotPose = (input: PoseSelectionInput): RobotPoseSnapshot | undefined => {
  const statePose = input.stateFresh !== false && finitePose(input.state?.agvPosition)
    ? input.state.agvPosition : undefined;
  const visualizationPose = input.visualizationFresh !== false && finitePose(input.visualization?.agvPosition)
    ? input.visualization.agvPosition : undefined;
  const stateTime = input.lastStateReceiveTime ?? 0;
  const visualizationTime = input.lastVisualizationReceiveTime ?? 0;
  const useVisualization = Boolean(visualizationPose && (!statePose || visualizationTime >= stateTime));
  const selected = useVisualization ? visualizationPose : statePose;
  if (!selected) return undefined;
  const activeMapId = input.activeMapResolution?.mapId
    ?? statePose?.mapId?.trim()
    ?? selected.mapId?.trim()
    ?? '';
  return {
    pose: { ...selected, mapId: activeMapId, positionInitialized: statePose?.positionInitialized ?? selected.positionInitialized },
    source: useVisualization ? 'visualization' : 'state',
    mapIdSource: input.activeMapResolution?.source === 'none' ? undefined : input.activeMapResolution?.source,
    receivedAtMs: useVisualization ? visualizationTime : stateTime,
  };
};
