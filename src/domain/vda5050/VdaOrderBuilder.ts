import { normalizeAngle } from '../geometry/angles';
import type {
  OccupancyGrid, OrderSettings, PathPoint, PlannerOptions, RobotFootprint, RobotPose,
  VdaEdge, VdaNode, VdaOrder, Waypoint,
} from '../types';
import { defaultPlannerOptions } from '../defaults';
import { EdgeCorridorPlanner, type CorridorDiagnostic } from '../planner/EdgeCorridorPlanner';
import { createPlanningConfigurationSnapshot, type PlanningConfigurationSnapshot } from '../planning/PlanningConfigurationSnapshot';
import type { MotionPlan } from '../motion/planningModel';
import { buildLegacyMotionPlan } from '../motion/LegacyMotionPlanBuilder';
import { LogService } from '../../services/LogService';
import { MotionPlanValidator, type MotionPlanValidationResult } from '../planner/MotionPlanValidator';

let headerId = 0;
const uniqueId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
/** Allocates from the same monotonic sequence used by normal and compatibility Orders. */
export const allocateVdaHeaderId=():number=>headerId++;

export interface OrderBuildContext {
  robotPose: RobotPose;
  activeMapId: string;
  /** Undefined means use the final segment direction. */
  finalGoalTheta?: number;
  /** Already-decided motion states. When present, this builder only serializes them. */
  motionPlan?: MotionPlan;
  onMotionPlanValidation?: (result: MotionPlanValidationResult) => void;
  planningConfiguration?: PlanningConfigurationSnapshot;
  corridorPlanning?:{
    grid:OccupancyGrid;
    footprint:RobotFootprint;
    plannerOptions:PlannerOptions;
    onDiagnostic?:(diagnostic:CorridorDiagnostic)=>void;
  };
}

export const removeInitialDuplicatePoints = (
  robotPose: Pick<RobotPose, 'x' | 'y'>,
  path: PathPoint[],
  minimumDistance: number,
): PathPoint[] => {
  if (!Number.isFinite(minimumDistance) || minimumDistance < 0) {
    throw new Error('Initial path-point distance must be a finite non-negative number.');
  }
  let firstUseful = 0;
  while (firstUseful < path.length &&
    Math.hypot(path[firstUseful]!.x - robotPose.x, path[firstUseful]!.y - robotPose.y) <= minimumDistance) {
    firstUseful += 1;
  }
  const useful = path.slice(firstUseful);
  if (!useful.length) {
    throw new Error('The planned route contains no waypoint beyond the current robot pose.');
  }
  return useful;
};

/** Builds an independent VDA 5050 Order whose Node 0 is always the exact live robot pose. */
export class VdaOrderBuilder {
  public build(
    path: PathPoint[],
    context: OrderBuildContext,
    settings: OrderSettings,
    orderId = uniqueId('auto-order'),
  ): VdaOrder {
    if (!context.activeMapId.trim()) throw new Error('The active Navigator mapId is required.');
    if (![context.robotPose.x, context.robotPose.y, context.robotPose.theta].every(Number.isFinite)) {
      throw new Error('A complete finite current robot pose is required.');
    }
    const snapshot = context.planningConfiguration ?? createPlanningConfigurationSnapshot({
      plannerOptions: context.corridorPlanning?.plannerOptions ?? defaultPlannerOptions,
      orderSettings: settings,
      footprint: context.corridorPlanning?.footprint,
    });
    const plannerOptions = snapshot.planner;
    let route: PathPoint[];
    let motionPlan: MotionPlan;
    if (context.motionPlan) {
      motionPlan = context.motionPlan;
      route = motionPlan.states.map((state) => ({ x: state.x, y: state.y, theta: state.theta }));
      if (motionPlan.metadata.source === 'motion-state-planner' && !context.corridorPlanning)
        throw new Error('Motion-state MotionPlan validation requires the planning grid and footprint.');
      if (motionPlan.metadata.source === 'motion-state-planner') {
        const first = motionPlan.states[0];
        if (!first || Math.hypot(first.x - context.robotPose.x, first.y - context.robotPose.y) > settings.firstNodePositionConsistency ||
          Math.abs(normalizeAngle(first.theta - context.robotPose.theta)) > settings.firstNodeAngularConsistency)
          throw new Error('The live robot pose no longer matches the validated MotionPlan start state. Replan before order generation.');
      }
    } else {
      const usefulPath = removeInitialDuplicatePoints(context.robotPose, path,
        settings.initialPathPointDistance);
      route = [
        { x: context.robotPose.x, y: context.robotPose.y,
          theta: normalizeAngle(context.robotPose.theta) },
        ...usefulPath,
      ];
      motionPlan = buildLegacyMotionPlan(
        route, context.robotPose.theta, plannerOptions, context.corridorPlanning?.grid,
        context.corridorPlanning?.footprint, context.finalGoalTheta,
      );
    }
    if (route.length < 2) throw new Error('A VDA route requires the real start and at least one motion transition.');
    const outputRoute = route;
    if (context.motionPlan && context.corridorPlanning) {
      const validationFootprint = structuredClone(context.corridorPlanning.footprint);
      validationFootprint.safetyMargin = Math.max(validationFootprint.safetyMargin,
        snapshot.normalized.footprint.planningSafetyMarginM +
        snapshot.normalized.footprint.localizationMarginM);
      const checked = new MotionPlanValidator().validate(
        motionPlan, context.corridorPlanning.grid, validationFootprint,
        snapshot.normalized.motionState.sampling.translationCollisionIntervalM,
        snapshot.normalized.motionState.sampling.rotationCollisionIntervalRad,
        snapshot.normalized.motionState.permissions.reverse,
        context.finalGoalTheta,
      );
      context.onMotionPlanValidation?.(checked);
      if (!checked.valid) throw new Error(`MotionPlan validation failed: ${checked.errors.join(' ')}`);
    }

    const nodes: VdaNode[] = outputRoute.map((point, index) => {
      const waypoint = point as Partial<Waypoint>;
      const decided = motionPlan.states[index];
      if (!decided) throw new Error('MotionPlan state cardinality does not match its route.');
      // Serialization only: body orientation and direction were decided by the
      // motion-state planner or the isolated legacy compatibility builder.
      const theta = normalizeAngle(decided.theta);
      return {
        nodeId: uniqueId(`node-${index}`),
        sequenceId: index * 2,
        released: true,
        nodePosition: {
          x: index === 0 ? context.robotPose.x : point.x,
          y: index === 0 ? context.robotPose.y : point.y,
          theta,
          allowedDeviationXy: index === 0 ? settings.allowedDeviationXy :
            waypoint.deviationXy ?? settings.allowedDeviationXy,
          allowedDeviationTheta: index === 0 ? settings.allowedDeviationTheta :
            waypoint.deviationTheta ?? settings.allowedDeviationTheta,
          mapId: context.activeMapId,
        },
        actions: [],
      };
    });
    const corridorPlanner=new EdgeCorridorPlanner();
    const edges: VdaEdge[] = nodes.slice(0, -1).map((node, index) => {
      const edgeId=uniqueId(`edge-${index}`);
      const motionAction=context.motionPlan?.actions[index];
      const corridorResult=context.corridorPlanning&&
        motionAction?.type!=='ROTATE_IN_PLACE'&&motionAction?.type!=='ROTATE'&&
        motionAction?.type!=='DIRECTION_CHANGE'
        ?corridorPlanner.calculate(
          node.nodePosition,nodes[index+1]!.nodePosition,
          context.corridorPlanning.grid,context.corridorPlanning.footprint,
          context.corridorPlanning.plannerOptions.corridor,
          motionAction?.from.theta,
        ):undefined;
      if(corridorResult)context.corridorPlanning?.onDiagnostic?.({
        ...corridorResult.diagnostic,edgeId,
      });
      return {
        edgeId,
        sequenceId: index * 2 + 1,
        released: true,
        startNodeId: node.nodeId,
        endNodeId: nodes[index + 1]!.nodeId,
        maxSpeed: settings.missionMaximumSpeedMps,
        rotationAllowed: motionAction?.type==='ROTATE_IN_PLACE'||motionAction?.type==='ROTATE'
          ?true:index === 0 ? true :
            (outputRoute[index]?.passageId||outputRoute[index+1]?.passageId)
            ?false:settings.rotationAllowed,
        ...(corridorResult?.corridor?{corridor:corridorResult.corridor}:{}),
        actions: [],
      };
    });
    nodes.forEach((node, index) => {
      LogService.write('planner','info',
        `VDA node ${index}: x=${node.nodePosition.x.toFixed(3)} y=${node.nodePosition.y.toFixed(3)} ` +
        `theta=${node.nodePosition.theta.toFixed(3)} rad (${(node.nodePosition.theta * 180 / Math.PI).toFixed(1)}°) ` +
        `mapId=${node.nodePosition.mapId} allowedDeviationXY=${node.nodePosition.allowedDeviationXy.toFixed(3)} ` +
        `allowedDeviationTheta=${node.nodePosition.allowedDeviationTheta.toFixed(3)}`);
    });
    return {
      headerId: allocateVdaHeaderId(),
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      manufacturer: settings.manufacturer,
      serialNumber: settings.serialNumber,
      orderId,
      orderUpdateId: 0,
      nodes,
      edges,
    };
  }
}
