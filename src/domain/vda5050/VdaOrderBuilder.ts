import { normalizeAngle } from '../geometry/angles';
import type {
  OccupancyGrid, OrderSettings, PathPoint, PlannerOptions, RobotFootprint, RobotPose,
  VdaEdge, VdaNode, VdaOrder, Waypoint,
} from '../types';
import { defaultPlannerOptions } from '../defaults';
import { EdgeCorridorPlanner, type CorridorDiagnostic } from '../planner/EdgeCorridorPlanner';
import { PathCollisionValidator } from '../planner/PathCollisionValidator';
import { LogService } from '../../services/LogService';
import { CostModel } from '../planning/CostModel';
import { createPlanningConfigurationSnapshot, type PlanningConfigurationSnapshot } from '../planning/PlanningConfigurationSnapshot';
import type { MotionPlan } from '../motion/planningModel';
import { buildLegacyMotionPlan } from '../motion/LegacyMotionPlanBuilder';

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
  private static readonly directionSwitchPenaltyMultiplier = 0.5;
  private static readonly maxGridSnapshotCells = 4096;

  private static serializeGridData(grid: OccupancyGrid): string {
    const source = grid.data;
    const length = source.length;
    if (!length) return '';
    if (length <= VdaOrderBuilder.maxGridSnapshotCells) return source.join(',');
    const stride = Math.max(1, Math.floor(length / VdaOrderBuilder.maxGridSnapshotCells));
    const sampled: number[] = [];
    for (let i = 0; i < length; i += stride) sampled.push(source[i] ?? 0);
    return `sampled(stride=${stride};count=${sampled.length})=${sampled.join(',')}`;
  }

  private evaluateSegmentOrientation(
    from: PathPoint,
    to: PathPoint,
    previousTheta: number,
    previousDirection: 'FORWARD' | 'REVERSE' | undefined,
    plannerOptions: PlannerOptions,
    grid?: OccupancyGrid,
    footprint?: RobotFootprint,
  ): {
    selectedDirection: 'FORWARD' | 'REVERSE';
    selectedTheta: number;
    forwardCandidate: {
      theta: number;
      rotationRequired: number;
      travelDirection: 'FORWARD';
      feasible: boolean;
      cost: { travel: number; rotation: number; reversePenalty: number; obstacle: number; turn: number; total: number; };
    };
    reverseCandidate: {
      theta: number;
      rotationRequired: number;
      travelDirection: 'REVERSE';
      feasible: boolean;
      cost: { travel: number; rotation: number; reversePenalty: number; obstacle: number; turn: number; total: number; };
    };
  } {
    const pathBearing = normalizeAngle(Math.atan2(to.y - from.y, to.x - from.x));
    const forwardTheta = normalizeAngle(pathBearing);
    const reverseTheta = normalizeAngle(pathBearing + Math.PI);
    const forwardRotation = Math.abs(normalizeAngle(forwardTheta - previousTheta));
    const reverseRotation = Math.abs(normalizeAngle(reverseTheta - previousTheta));
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const travelCost = CostModel.distance(distance, plannerOptions.distanceWeight);
    const rotationWeight = plannerOptions.passageSafety.headingChangeWeight;
    const reversePenalty = plannerOptions.passageSafety.reverseRiskWeight;
    const directionSwitchPenalty = CostModel.directionSwitchPenalty(plannerOptions);
    const collisionValidator = new PathCollisionValidator();
    const candidateObstacleCost = (candidateTheta: number, candidateDirection: 'FORWARD' | 'REVERSE'): number => {
      if (!grid || !footprint) return 0;
      const pointFree = collisionValidator.pointIsFree(grid, { ...from, theta: candidateTheta }, footprint);
      const rotationFree = collisionValidator.rotationIsFree(
        grid,
        { x: from.x, y: from.y },
        previousTheta,
        candidateTheta,
        footprint,
        plannerOptions.passageSafety.rotationCollisionSampleDeg * Math.PI / 180,
      );
      if (!pointFree || !rotationFree) return Number.POSITIVE_INFINITY;
      const turnPenalty = previousDirection && previousDirection !== candidateDirection
        ? (plannerOptions.turnPenalty ?? plannerOptions.passageSafety.headingChangeWeight) : 0;
      return turnPenalty;
    };
    const forwardCostBase = {
      travel: travelCost,
      rotation: rotationWeight * forwardRotation,
      reversePenalty: 0,
      obstacle: 0,
      turn: previousDirection && previousDirection !== 'FORWARD'
        ? directionSwitchPenalty
        : 0,
    };
    const reverseCostBase = {
      travel: travelCost,
      rotation: rotationWeight * reverseRotation,
      reversePenalty,
      obstacle: 0,
      turn: previousDirection && previousDirection !== 'REVERSE'
        ? directionSwitchPenalty
        : 0,
    };
    const forwardFeasible = candidateObstacleCost(forwardTheta, 'FORWARD') !== Number.POSITIVE_INFINITY;
    const reverseFeasible = candidateObstacleCost(reverseTheta, 'REVERSE') !== Number.POSITIVE_INFINITY;
    const forwardObstacleCost = forwardFeasible ? candidateObstacleCost(forwardTheta, 'FORWARD') : Number.POSITIVE_INFINITY;
    const reverseObstacleCost = reverseFeasible ? candidateObstacleCost(reverseTheta, 'REVERSE') : Number.POSITIVE_INFINITY;
    const forwardCandidate = {
      theta: forwardTheta,
      rotationRequired: forwardRotation,
      travelDirection: 'FORWARD' as const,
      feasible: forwardFeasible,
      cost: {
        travel: forwardCostBase.travel,
        rotation: forwardCostBase.rotation,
        reversePenalty: forwardCostBase.reversePenalty,
        obstacle: forwardObstacleCost,
        turn: forwardCostBase.turn,
        total: forwardCostBase.travel + forwardCostBase.rotation + forwardCostBase.turn + forwardObstacleCost,
      },
    };
    const reverseCandidate = {
      theta: reverseTheta,
      rotationRequired: reverseRotation,
      travelDirection: 'REVERSE' as const,
      feasible: reverseFeasible,
      cost: {
        travel: reverseCostBase.travel,
        rotation: reverseCostBase.rotation,
        reversePenalty: reverseCostBase.reversePenalty,
        obstacle: reverseObstacleCost,
        turn: reverseCostBase.turn,
        total: reverseCostBase.travel + reverseCostBase.rotation + reverseCostBase.reversePenalty + reverseCostBase.turn + reverseObstacleCost,
      },
    };
    const chosen = [forwardCandidate, reverseCandidate]
      .filter((candidate) => candidate.feasible)
      .sort((left, right) => left.cost.total - right.cost.total)[0];
    const selectedDirection = chosen?.travelDirection ?? 'FORWARD';
    const selectedTheta = chosen?.theta ?? forwardTheta;
    return { selectedDirection, selectedTheta, forwardCandidate, reverseCandidate };
  }

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
    if (context.corridorPlanning) {
      const { grid } = context.corridorPlanning;
      const unknownCellHandling = plannerOptions.corridor.unknownCellsBlocked
        ? 'treated-as-occupied'
        : 'allowed-as-free';
      const gridSnapshot = `plannerGrid mapId=${grid.metadata.mapId} name=${grid.metadata.name} ` +
        `resolution=${grid.metadata.resolution} origin=(${grid.metadata.origin.x},${grid.metadata.origin.y},${grid.metadata.origin.yaw}) ` +
        `width=${grid.metadata.width} height=${grid.metadata.height} occupiedThreshold=${grid.metadata.occupiedThreshold} ` +
        `unknownCellHandling=${unknownCellHandling} data=${VdaOrderBuilder.serializeGridData(grid)}`;
      LogService.write('planner', 'info', gridSnapshot);
    }
    const usefulPath = removeInitialDuplicatePoints(
      context.robotPose,
      path,
      settings.initialPathPointDistance,
    );
    const route: PathPoint[] = [
      { x: context.robotPose.x, y: context.robotPose.y, theta: normalizeAngle(context.robotPose.theta) },
      ...usefulPath,
    ];
    if (route.length < 2) throw new Error('A VDA route requires the real start and at least one useful waypoint.');
    const motionPlan = context.motionPlan ?? buildLegacyMotionPlan(
      route, context.robotPose.theta, plannerOptions, context.corridorPlanning?.grid,
      context.corridorPlanning?.footprint, context.finalGoalTheta,
    );

    let previousTheta = normalizeAngle(context.robotPose.theta);
    let previousDirection: 'FORWARD' | 'REVERSE' | undefined;

    const nodes: VdaNode[] = route.map((point, index) => {
      const waypoint = point as Partial<Waypoint>;
      const next = route[index + 1];
      const previous = route[index - 1];
      let theta: number;
      let chosenDirection: 'FORWARD' | 'REVERSE' | undefined;
      if (index === 0) {
        theta = normalizeAngle(context.robotPose.theta);
      } else if (motionPlan.states[index]) {
        // MotionPlan is authoritative: orientation and direction were decided upstream.
        const decided = motionPlan.states[index]!;
        theta = normalizeAngle(decided.theta);
        chosenDirection = decided.direction;
      } else if (point.orientationLocked || point.passageId) {
        theta = normalizeAngle(point.theta);
      } else if (next) {
        const segment = this.evaluateSegmentOrientation(
          point,
          next,
          previousTheta,
          previousDirection,
          plannerOptions,
          context.corridorPlanning?.grid,
          context.corridorPlanning?.footprint,
        );
        chosenDirection = segment.selectedDirection;
        theta = segment.selectedTheta;
        const pathBearing = normalizeAngle(Math.atan2(next.y - point.y, next.x - point.x));
        const formatCost = (value: number): string => Number.isFinite(value) ? value.toFixed(6) : 'inf';
        const orderDebugMessage = `orderDebug segmentIndex=${index} pathBearing=${pathBearing.toFixed(6)} previousTheta=${previousTheta.toFixed(6)} ` +
          `weights={distanceWeight:${plannerOptions.distanceWeight.toFixed(6)},headingChangeWeight:${plannerOptions.passageSafety.headingChangeWeight.toFixed(6)},` +
          `reverseRiskWeight:${plannerOptions.passageSafety.reverseRiskWeight.toFixed(6)},turnPenalty:${(plannerOptions.turnPenalty ?? plannerOptions.passageSafety.headingChangeWeight).toFixed(6)},` +
          `directionSwitchPenaltyMultiplier:${VdaOrderBuilder.directionSwitchPenaltyMultiplier.toFixed(6)},directionSwitchPenalty:${(VdaOrderBuilder.directionSwitchPenaltyMultiplier * plannerOptions.passageSafety.reverseRiskWeight).toFixed(6)}} ` +
          `selectedDirection=${segment.selectedDirection} selectedTheta=${segment.selectedTheta.toFixed(6)} ` +
          `forwardCostTerms={travel:${formatCost(segment.forwardCandidate.cost.travel)},rotation:${formatCost(segment.forwardCandidate.cost.rotation)},` +
          `reversePenalty:${formatCost(segment.forwardCandidate.cost.reversePenalty)},obstacle:${formatCost(segment.forwardCandidate.cost.obstacle)},` +
          `turn:${formatCost(segment.forwardCandidate.cost.turn)},total:${formatCost(segment.forwardCandidate.cost.total)}} ` +
          `reverseCostTerms={travel:${formatCost(segment.reverseCandidate.cost.travel)},rotation:${formatCost(segment.reverseCandidate.cost.rotation)},` +
          `reversePenalty:${formatCost(segment.reverseCandidate.cost.reversePenalty)},obstacle:${formatCost(segment.reverseCandidate.cost.obstacle)},` +
          `turn:${formatCost(segment.reverseCandidate.cost.turn)},total:${formatCost(segment.reverseCandidate.cost.total)}} ` +
          `forwardTheta=${segment.forwardCandidate.theta.toFixed(6)} reverseTheta=${segment.reverseCandidate.theta.toFixed(6)} ` +
          `forwardFeasible=${segment.forwardCandidate.feasible} reverseFeasible=${segment.reverseCandidate.feasible}`;
        LogService.write('planner', 'info', orderDebugMessage);
      } else if (context.finalGoalTheta !== undefined) {
        theta = normalizeAngle(context.finalGoalTheta);
      } else if (previous) {
        theta = normalizeAngle(Math.atan2(point.y - previous.y, point.x - previous.x));
      } else {
        throw new Error('Cannot determine final node orientation.');
      }
      if (index > 0 && !point.orientationLocked && !point.passageId && next) {
        previousTheta = normalizeAngle(theta);
        previousDirection = chosenDirection;
      }
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
      const corridorResult=context.corridorPlanning
        ?corridorPlanner.calculate(
          node.nodePosition,nodes[index+1]!.nodePosition,
          context.corridorPlanning.grid,context.corridorPlanning.footprint,
          context.corridorPlanning.plannerOptions.corridor,
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
        rotationAllowed: index === 0 ? true :
          (route[index]?.passageId||route[index+1]?.passageId)
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
